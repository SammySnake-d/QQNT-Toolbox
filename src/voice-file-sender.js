const { app, BrowserWindow, dialog } = require("electron");

const fs = require('fs').promises;
const fsSync = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const {
    addNativeRequestHandler,
    isNativeFailure,
    qqNativeInvoke,
    unwrapNativeValue
} = require('./native-ipc');
const {
    VOICE_LIBRARY_PANEL_CSS,
    createVoiceLibraryPanel,
    injectedVoiceFileSenderUi
} = require('./voice/renderer-ui');
const {
    TARGET_SILK_SAMPLE_RATE,
    createSilentSilk,
    decodeSilkToPcm,
    detectMediaInputFormat,
    encodeMediaFileToSilk,
    estimateSilkDurationMs,
    extractAudioTrackWithoutReencoding,
    getMediaInputArgs,
    isAudioMediaPath,
    isQqNativePttFile,
    isVideoMediaPath,
    isSilkFile,
    makePcm16Wav,
    probeAudioStream,
    runTool
} = require('./voice/media');
const {
    createPttSourceResolver,
    sanitizePttInfo
} = require('./voice/ptt-source');
const {
    createOnlineSourceRunner,
    downloadAudioUrl,
    importOnlineSourceScript
} = require('./voice/online-source');
const { getTencentFilesRoots } = require('./qq-data-root');

const PLUGIN_SLUG = 'qqnt_toolbox';
const PLUGIN_NAME = 'QQNT Toolbox';
const VOICE_DATA_DIR_NAME = 'voice';
const AUDIO_FILE_EXTENSIONS = [
    'aac', 'ac3', 'amr', 'audio', 'eac3', 'flac', 'm4a', 'mp3', 'oga', 'ogg',
    'opus', 'silk', 'slk', 'wav', 'weba', 'webm', 'wv'
];
const VIDEO_FILE_EXTENSIONS = ['3g2', '3gp', 'asf', 'avi', 'flv', 'm2ts', 'm4v', 'mkv', 'mov', 'mp4', 'mpeg', 'mpg', 'ogv', 'ts', 'webm', 'wmv'];
const MEDIA_FILE_EXTENSIONS = uniqueStrings([...AUDIO_FILE_EXTENSIONS, ...VIDEO_FILE_EXTENSIONS]);
const MEDIA_EXTENSION_SET = new Set(MEDIA_FILE_EXTENSIONS.map(extension => `.${extension}`));
const DIRECT_PREVIEW_FORMATS_BY_EXTENSION = new Map([
    ['.aac', 'aac'],
    ['.flac', 'flac'],
    ['.m4a', 'mov'],
    ['.m4v', 'mov'],
    ['.mov', 'mov'],
    ['.mp3', 'mp3'],
    ['.mp4', 'mov'],
    ['.oga', 'ogg'],
    ['.ogg', 'ogg'],
    ['.opus', 'ogg'],
    ['.wav', 'wav'],
    ['.weba', 'webm'],
    ['.webm', 'webm']
]);
const DIRECT_PREVIEW_DETECTED_FORMATS = new Set(['aac', 'flac', 'mov', 'mp3', 'ogg', 'wav']);
const DIRECT_PREVIEW_EXTENSIONS_BY_FORMAT = Object.freeze({
    aac: '.aac',
    flac: '.flac',
    mov: '.m4a',
    mp3: '.mp3',
    ogg: '.ogg',
    wav: '.wav',
    webm: '.webm'
});
const VOICE_UI_ROUTE_MARKERS = ['#/main/message', '#/chat', '#/forward', '#/record'];
const VOICE_SEND_MODE_VALUES = new Set(['convert', 'original']);
const DEFAULT_RAW_WAVE_AMPLITUDES = [0, 18, 9, 23, 16, 17, 16, 15, 44, 17, 24, 20, 14, 15, 17];
const MUSICFREE_MANIFEST_MAX_PLUGINS = 32;
const MUSICFREE_MANIFEST_MAX_BYTES = 512 * 1024;
const MUSICFREE_MODULE_MAX_BYTES = 512 * 1024;
const ONLINE_CATALOG_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
const ONLINE_AUDIO_MAX_ATTEMPTS = 3;
const BUILTIN_ONLINE_SEARCH_PROVIDERS = new Set(['kw', 'mg', 'kg', 'tx', 'wy']);
const BUILTIN_ONLINE_RECOMMEND_PROVIDERS = new Set(['kw', 'mg', 'kg', 'tx', 'wy']);
let voiceFeatureEnabled = false;
let voiceKeepPlayingAcrossChats = false;
let voiceSaveInContextMenuEnabled = false;
let voiceForwardInContextMenuEnabled = false;
let voiceNetworkFetch = null;
let voiceMediaUrlResolver = null;
let fakeVoiceDurationSeconds = 0;
let diagnosticRecorder = null;
let voiceTempCleanupStarted = false;
const LIBRARY_DURATION_CONCURRENCY = 2;
const LIBRARY_DURATION_BATCH_SIZE = 12;
const libraryDurationRefreshes = new Map();
let libraryIndexMutationTail = Promise.resolve();

function recordDiagnostic(level, event, details = {}) {
    try {
        diagnosticRecorder?.(level, event, details);
    } catch {
    }
}

function shouldRecordVoiceAction(action) {
    return Boolean(action?.type && action.type !== 'list');
}

function getVoiceActionSummary(action) {
    return {
        actionType: String(action?.type || 'unknown'),
        itemCount: Array.isArray(action?.paths) ? action.paths.length : 0,
        hasPeer: Boolean(action?.peer),
        sendMode: normalizeVoiceSendMode(action?.sendMode)
    };
}

function getPluginTempDir() {
    return path.join(os.tmpdir(), 'QQNT-Toolbox', VOICE_DATA_DIR_NAME);
}

function getLiteLoaderPluginDataDir(slug = PLUGIN_SLUG, name = PLUGIN_NAME) {
    const plugins = globalThis.LiteLoader?.plugins || global.LiteLoader?.plugins;
    if (!plugins) {
        return '';
    }
    for (const key of [slug, name]) {
        if (plugins[key]?.path?.data) {
            return plugins[key].path.data;
        }
    }
    for (const plugin of Object.values(plugins)) {
        if (plugin?.manifest?.slug === slug || plugin?.manifest?.name === name) {
            return plugin?.path?.data || '';
        }
    }
    return '';
}

function getDefaultLiteLoaderDataDir(slug) {
    return path.resolve(__dirname, '..', '..', '..', 'data', slug);
}

function getPluginDataDir() {
    return path.join(getLiteLoaderPluginDataDir() || getDefaultLiteLoaderDataDir(PLUGIN_SLUG), VOICE_DATA_DIR_NAME);
}

function getLibraryDir() {
    return path.join(getPluginDataDir(), 'library');
}

function getLibraryVoiceDir() {
    return path.join(getLibraryDir(), 'voices');
}

function getLibraryIndexPath() {
    return path.join(getLibraryDir(), 'library.json');
}

function getOnlineSourceDir() {
    return path.join(getPluginDataDir(), 'sources');
}

function withLibraryIndexMutation(work) {
    const next = libraryIndexMutationTail.then(work, work);
    libraryIndexMutationTail = next.catch(() => {});
    return next;
}

function safeFileStem(value) {
    return String(value || 'voice')
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80) || 'voice';
}

async function makeTempSilkPath() {
    const tempDir = getPluginTempDir();
    await fs.mkdir(tempDir, { recursive: true });
    return path.join(tempDir, `${crypto.randomUUID()}.silk`);
}

async function cleanupOldVoiceTempFiles() {
    if (voiceTempCleanupStarted) {
        return;
    }
    voiceTempCleanupStarted = true;
    const tempDir = getPluginTempDir();
    let entries;
    try {
        entries = await fs.readdir(tempDir, { withFileTypes: true });
    } catch {
        return;
    }
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const temporaryExtensions = new Set([...MEDIA_EXTENSION_SET, '.silk', '.mka', '.ac3', '.eac3', '.wv']);
    const cleanupFiles = async(directory, directoryEntries, extensions) => {
        await Promise.all(directoryEntries
            .filter(entry => entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase()))
            .map(async entry => {
                const filePath = path.join(directory, entry.name);
                try {
                    if ((await fs.stat(filePath)).mtimeMs < cutoff) {
                        await fs.unlink(filePath);
                    }
                } catch {
                }
            }));
    };
    await cleanupFiles(tempDir, entries, temporaryExtensions);
    const previewDir = path.join(tempDir, 'preview');
    let previewEntries = [];
    try {
        previewEntries = await fs.readdir(previewDir, { withFileTypes: true });
    } catch {
    }
    await cleanupFiles(previewDir, previewEntries, temporaryExtensions);
}

async function getPreviewCacheDir() {
    const previewDir = path.join(getPluginTempDir(), 'preview');
    await fs.mkdir(previewDir, { recursive: true });
    return previewDir;
}

async function getStableAudioPreviewPath(cacheKey, extension = '.wav') {
    const previewDir = await getPreviewCacheDir();
    const previewId = getBufferMd5(Buffer.from(`stable-preview|${String(cacheKey || '')}`));
    const safeExtension = /^\.[a-z0-9]{1,8}$/i.test(String(extension || ''))
        ? String(extension).toLowerCase()
        : '.wav';
    return path.join(previewDir, `${previewId}${safeExtension}`);
}

async function getExistingStableAudioPreview(cacheKey) {
    const extensions = uniqueStrings(['.wav', ...DIRECT_PREVIEW_FORMATS_BY_EXTENSION.keys()]);
    for (const extension of extensions) {
        const previewPath = await getStableAudioPreviewPath(cacheKey, extension);
        try {
            const stat = await fs.stat(previewPath);
            if (!stat.isFile() || stat.size <= 44) {
                throw new Error('The cached preview is incomplete.');
            }
            const now = new Date();
            await fs.utimes(previewPath, now, now).catch(() => {});
            return previewPath;
        } catch {
            await fs.unlink(previewPath).catch(() => {});
        }
    }
    return '';
}

function getDirectPreviewFormat(filePath) {
    if (!filePath || isQqNativePttFile(filePath)) {
        return '';
    }
    const detectedFormat = detectMediaInputFormat(filePath);
    if (DIRECT_PREVIEW_DETECTED_FORMATS.has(detectedFormat)) {
        return detectedFormat;
    }
    const extension = path.extname(String(filePath)).toLowerCase();
    if (detectedFormat === 'matroska' && !['.weba', '.webm'].includes(extension)) {
        return '';
    }
    return DIRECT_PREVIEW_FORMATS_BY_EXTENSION.get(extension) || '';
}

async function movePreviewFile(sourcePath, targetPath) {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    try {
        await fs.rename(sourcePath, targetPath);
    } catch (error) {
        if (!['EXDEV', 'EACCES', 'EPERM'].includes(error?.code)) {
            throw error;
        }
        await fs.copyFile(sourcePath, targetPath);
        await fs.unlink(sourcePath).catch(() => {});
    }
}

function uniqueStrings(values) {
    return Array.from(new Set(values.filter(Boolean)));
}

function normalizeVoiceSendMode(value) {
    return VOICE_SEND_MODE_VALUES.has(String(value || '').toLowerCase())
        ? String(value).toLowerCase()
        : 'convert';
}

function getDirectoryMtimeMs(dirPath) {
    try {
        return fsSync.statSync(dirPath).mtimeMs;
    } catch {
        return 0;
    }
}

function getPttBaseActivityMs(pttBaseDir) {
    const currentMonthDir = path.join(pttBaseDir, formatPttMonth());
    return Math.max(
        getDirectoryMtimeMs(pttBaseDir),
        getDirectoryMtimeMs(currentMonthDir),
        getDirectoryMtimeMs(path.join(currentMonthDir, 'Ori'))
    );
}

function getNativePttBaseDirs() {
    const candidates = [];
    for (const root of getTencentFilesRoots({ documentsPath: app.getPath('documents') })) {
        if (!fsSync.existsSync(root)) {
            continue;
        }
        let entries = [];
        try {
            entries = fsSync.readdirSync(root, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (!entry.isDirectory()) {
                continue;
            }
            const pttBaseDir = path.join(root, entry.name, 'nt_qq', 'nt_data', 'Ptt');
            if (fsSync.existsSync(pttBaseDir)) {
                candidates.push({
                    pttBaseDir,
                    newest: getPttBaseActivityMs(pttBaseDir)
                });
            }
        }
    }
    candidates.sort((a, b) => b.newest - a.newest);
    return candidates.map(candidate => candidate.pttBaseDir);
}

const pttSourceResolver = createPttSourceResolver(getNativePttBaseDirs);

function findNativePttBaseDir() {
    return getNativePttBaseDirs()[0] || '';
}

function formatPttMonth(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    return `${year}-${month}`;
}

async function getNativePttOriDir() {
    const pttBaseDir = findNativePttBaseDir();
    if (!pttBaseDir) {
        throw new Error('QQ native Ptt cache directory was not found.');
    }
    const oriDir = path.join(pttBaseDir, formatPttMonth(), 'Ori');
    await fs.mkdir(oriDir, { recursive: true });
    return oriDir;
}

function safeJson(value) {
    return JSON.stringify(value, (key, item) => {
        if (item instanceof Map) {
            return Object.fromEntries(item);
        }
        if (Buffer.isBuffer(item)) {
            return {
                type: 'Buffer',
                length: item.length
            };
        }
        if (item instanceof Uint8Array) {
            return {
                type: 'Uint8Array',
                length: item.length
            };
        }
        return item;
    });
}

async function getFileMd5(filePath) {
    const hash = crypto.createHash('md5');
    const stream = fsSync.createReadStream(filePath);
    return await new Promise((resolve, reject) => {
        stream.on('data', chunk => hash.update(chunk));
        stream.on('error', reject);
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

function getBufferMd5(data) {
    return crypto.createHash('md5').update(Buffer.from(data)).digest('hex');
}

async function ensureLibraryDirs() {
    const trustedBasePath = path.resolve(path.dirname(getPluginDataDir()));
    await fs.mkdir(trustedBasePath, { recursive: true });
    let parentPath = trustedBasePath;
    let realParentPath = await fs.realpath(trustedBasePath);

    for (const directoryPath of [getPluginDataDir(), getLibraryDir(), getLibraryVoiceDir()]) {
        const absolutePath = path.resolve(directoryPath);
        if (normalizeComparablePath(path.dirname(absolutePath)) !== normalizeComparablePath(parentPath)) {
            throw new Error('The voice library directory structure is invalid.');
        }
        try {
            await fs.mkdir(absolutePath);
        } catch (error) {
            if (error?.code !== 'EEXIST') {
                throw error;
            }
        }
        const [itemLstat, itemStat, realPath] = await Promise.all([
            fs.lstat(absolutePath),
            fs.stat(absolutePath),
            fs.realpath(absolutePath)
        ]);
        if (itemLstat.isSymbolicLink() || !itemStat.isDirectory() ||
            !isSameOrDescendantAbsolutePath(realPath, realParentPath)) {
            throw new Error('The voice library root is invalid.');
        }
        parentPath = absolutePath;
        realParentPath = realPath;
    }

    return {
        rootPath: parentPath,
        realRootPath: realParentPath
    };
}

function normalizeStoredPath(filePath) {
    return String(filePath || '').replace(/\//g, path.sep);
}

function normalizeFieldText(value) {
    const text = String(value ?? '').trim();
    return text && text !== 'undefined' && text !== 'null' && text !== '0' ? text : '';
}

function sanitizeLibraryEntryName(value) {
    const requested = normalizeFieldText(value);
    if (!requested) {
        return '';
    }
    const name = requested
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/[. ]+$/g, '')
        .slice(0, 80);
    if (!name || name === '.' || name === '..' || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
        return '';
    }
    return name;
}

function normalizeLibraryRelativePath(relativePath = '') {
    const normalized = String(relativePath || '')
        .replace(/\\/g, '/')
        .split('/')
        .filter(part => part && part !== '.' && part !== '..')
        .join('/');
    return normalized;
}

function validateLibraryRelativePath(relativePath = '', allowRoot = true) {
    const portablePath = String(relativePath ?? '').replace(/\\/g, '/');
    if (!portablePath) {
        if (allowRoot) {
            return '';
        }
        throw new Error('The library root cannot be used as an item.');
    }
    if (portablePath.includes('\x00') || path.posix.isAbsolute(portablePath) ||
        path.win32.isAbsolute(portablePath) || /^[a-z]:/i.test(portablePath)) {
        throw new Error('The library path is invalid.');
    }
    const parts = portablePath.split('/');
    if (parts.some(part =>
        !part || part === '.' || part === '..' ||
        /[<>:"|?*\x00-\x1F]/.test(part) || /[. ]$/.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
    )) {
        throw new Error('The library path is invalid.');
    }
    return parts.join('/');
}

function getLibraryAbsolutePath(relativePath = '') {
    return path.join(getLibraryVoiceDir(), ...normalizeLibraryRelativePath(relativePath).split('/').filter(Boolean));
}

function getLibraryRelativePath(filePath) {
    const relativePath = path.relative(getLibraryVoiceDir(), normalizeStoredPath(filePath));
    if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
        return '';
    }
    return relativePath.replace(/\\/g, '/');
}

function isSameOrDescendantAbsolutePath(candidatePath, ancestorPath) {
    const candidate = normalizeComparablePath(path.resolve(candidatePath));
    const ancestor = normalizeComparablePath(path.resolve(ancestorPath));
    const ancestorPrefix = normalizeComparablePath(`${path.resolve(ancestorPath)}${path.sep}`);
    return candidate === ancestor || candidate.startsWith(ancestorPrefix);
}

async function getLibraryPathContext() {
    return await ensureLibraryDirs();
}

async function resolveExistingLibraryPath(candidatePath, options = {}) {
    const context = options.context || await getLibraryPathContext();
    const absolutePath = path.resolve(normalizeStoredPath(candidatePath));
    if (!isSameOrDescendantAbsolutePath(absolutePath, context.rootPath) ||
        (!options.allowRoot && normalizeComparablePath(absolutePath) === normalizeComparablePath(context.rootPath))) {
        throw new Error('The library path is outside the voice library.');
    }

    let itemLstat;
    let itemStat;
    let realPath;
    try {
        [itemLstat, itemStat, realPath] = await Promise.all([
            fs.lstat(absolutePath),
            fs.stat(absolutePath),
            fs.realpath(absolutePath)
        ]);
    } catch {
        throw new Error('The library item was not found.');
    }
    if (itemLstat.isSymbolicLink() || !isSameOrDescendantAbsolutePath(realPath, context.realRootPath)) {
        throw new Error('The library path points outside the voice library.');
    }
    if (options.kind === 'folder' && !itemStat.isDirectory()) {
        throw new Error('The target folder was not found.');
    }
    if (options.kind === 'file' && !itemStat.isFile()) {
        throw new Error('The source file was not found.');
    }
    return {
        ...context,
        path: absolutePath,
        realPath,
        lstat: itemLstat,
        stat: itemStat,
        relativePath: getLibraryRelativePath(absolutePath)
    };
}

async function resolveExistingLibraryRelativePath(relativePath = '', options = {}) {
    const normalizedPath = validateLibraryRelativePath(relativePath, options.allowRoot !== false);
    return await resolveExistingLibraryPath(getLibraryAbsolutePath(normalizedPath), options);
}

function encodeLibraryItemId(kind, relativePath) {
    return `${kind}:${Buffer.from(validateLibraryRelativePath(relativePath, false), 'utf8').toString('base64url')}`;
}

function decodeLibraryItemId(itemId) {
    const match = String(itemId || '').match(/^(file|folder):(.+)$/);
    if (!match) {
        return null;
    }
    try {
        const decodedPath = Buffer.from(match[2], 'base64url').toString('utf8');
        return {
            kind: match[1],
            relativePath: validateLibraryRelativePath(decodedPath, false)
        };
    } catch {
        return null;
    }
}

function getLibraryParentFolder(relativePath = '') {
    const normalized = normalizeLibraryRelativePath(relativePath);
    const parent = path.posix.dirname(normalized);
    return parent === '.' ? '' : parent;
}

async function getLibraryFolders() {
    const context = await getLibraryPathContext();
    const folders = [''];
    const visitedPaths = new Set([normalizeComparablePath(context.realRootPath)]);

    async function visit(relativeFolder, folderPath) {
        let entries = [];
        try {
            entries = await fs.readdir(folderPath, { withFileTypes: true });
        } catch {
            return;
        }
        const childFolders = entries
            .filter(entry => entry.isDirectory() && !entry.isSymbolicLink?.())
            .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
        for (const entry of childFolders) {
            const childFolder = validateLibraryRelativePath(relativeFolder ? `${relativeFolder}/${entry.name}` : entry.name, false);
            let child;
            try {
                child = await resolveExistingLibraryRelativePath(childFolder, {
                    allowRoot: false,
                    context,
                    kind: 'folder'
                });
            } catch {
                continue;
            }
            const realPathKey = normalizeComparablePath(child.realPath);
            if (visitedPaths.has(realPathKey)) {
                continue;
            }
            visitedPaths.add(realPathKey);
            folders.push(childFolder);
            await visit(childFolder, child.path);
        }
    }

    await visit('', context.rootPath);
    return folders;
}

function getLibraryFileKind(filePath) {
    if (isSilkFile(filePath)) {
        return 'ptt';
    }
    return isSupportedMediaPath(filePath) ? 'media' : '';
}

async function readLibraryIndex() {
    await ensureLibraryDirs();
    const indexPath = getLibraryIndexPath();
    try {
        const index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
        return {
            version: 1,
            items: Array.isArray(index.items) ? index.items : []
        };
    } catch {
        try {
            if (fsSync.existsSync(indexPath)) {
                await fs.copyFile(indexPath, `${indexPath}.broken-${Date.now()}.bak`);
                await fs.writeFile(indexPath, JSON.stringify({ version: 1, items: [] }, null, 2), 'utf8');
            }
        } catch {
        }
        return {
            version: 1,
            items: []
        };
    }
}

async function writeLibraryIndex(index) {
    await ensureLibraryDirs();
    const indexPath = getLibraryIndexPath();
    const temporaryPath = `${indexPath}.${process.pid}-${crypto.randomUUID()}.tmp`;
    const contents = JSON.stringify({
        version: 1,
        items: index.items || []
    }, null, 2);
    await fs.writeFile(temporaryPath, contents, 'utf8');
    try {
        await fs.rename(temporaryPath, indexPath);
    } finally {
        await fs.unlink(temporaryPath).catch(() => {});
    }
}

async function listOnlineSources() {
    const directory = getOnlineSourceDir();
    await fs.mkdir(directory, { recursive: true });
    let entries = [];
    try {
        entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
        return [];
    }
    const sources = [];
    for (const entry of entries.filter(item => item.isFile() && item.name.endsWith('.json'))) {
        try {
            const metadata = JSON.parse(await fs.readFile(path.join(directory, entry.name), 'utf8'));
            if (!metadata?.id) {
                continue;
            }
            const declaredSources = metadata.sources && typeof metadata.sources === 'object' ? metadata.sources : {};
            const projectedSources = Object.fromEntries(Object.entries(declaredSources).map(([providerId, info]) => {
                const actions = Array.isArray(info?.actions) ? info.actions.slice() : [];
                if (actions.includes('musicUrl') && BUILTIN_ONLINE_SEARCH_PROVIDERS.has(providerId) &&
                    !actions.includes('search') && !actions.includes('musicSearch')) {
                    actions.push('search');
                }
                return [providerId, { ...info, actions }];
            }));
            sources.push({
                id: String(metadata.id),
                name: String(metadata.name || metadata.id),
                description: String(metadata.description || ''),
                author: String(metadata.author || ''),
                version: String(metadata.version || ''),
                format: String(metadata.format || 'lxmusic'),
                sourceUrl: String(metadata.sourceUrl || ''),
                sources: projectedSources,
            });
        } catch {
        }
    }
    return sources.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

function getOnlineSourceId(value) {
    const id = String(value || '').trim();
    return /^[a-zA-Z0-9_-]{1,64}$/.test(id) ? id : '';
}

async function getOnlineSourceById(sourceId) {
    const id = getOnlineSourceId(sourceId);
    if (!id) {
        throw new Error('在线音源标识无效。');
    }
    const directory = getOnlineSourceDir();
    const sourcePath = path.join(directory, `${id}.js`);
    const metadataPath = path.join(directory, `${id}.json`);
    const [source, metadata] = await Promise.all([
        fs.readFile(sourcePath, 'utf8'),
        fs.readFile(metadataPath, 'utf8').then(value => JSON.parse(value))
    ]);
    return { source, metadata };
}

function getOnlineSourceFetch() {
    return typeof voiceNetworkFetch === 'function'
        ? voiceNetworkFetch
        : (typeof fetch === 'function' ? fetch : null);
}

async function importOnlineSource(input, options = {}) {
    const musicFreeManifest = await parseMusicFreeManifestInput(input);
    if (musicFreeManifest) {
        return await importMusicFreeManifest(musicFreeManifest, options);
    }
    const imported = await importOnlineSourceScript(input, {
        rootPath: getOnlineSourceDir(),
        id: options.id,
        fetch: getOnlineSourceFetch()
    });
    return {
        id: imported.id,
        name: imported.metadata?.name || imported.id,
        description: imported.metadata?.description || '',
        author: imported.metadata?.author || '',
        format: imported.format || imported.metadata?.format || 'lxmusic',
        sources: imported.metadata?.sources || {}
    };
}

function parseMusicFreeManifestText(value) {
    const text = String(value || '').replace(/^\uFEFF/, '').trim();
    if (!text || Buffer.byteLength(text, 'utf8') > MUSICFREE_MANIFEST_MAX_BYTES ||
        (!text.startsWith('{') && !text.startsWith('['))) {
        return null;
    }
    try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.plugins)) {
            return null;
        }
        const plugins = parsed.plugins.map(item => ({
            name: String(item?.name || '').trim(),
            url: String(item?.url || '').trim(),
            version: String(item?.version || '').trim()
        })).filter(item => item.name && /^https?:\/\//i.test(item.url));
        return plugins.length ? plugins.slice(0, MUSICFREE_MANIFEST_MAX_PLUGINS) : null;
    } catch {
        return null;
    }
}

async function parseMusicFreeManifestInput(input) {
    if (input && typeof input === 'object' && !Buffer.isBuffer(input)) {
        if (typeof input.source === 'string') return parseMusicFreeManifestText(input.source);
        if (input.url) return await parseMusicFreeManifestInput(String(input.url));
        if (input.path) return await parseMusicFreeManifestInput(String(input.path));
    }
    const text = String(input ?? '').trim();
    const inline = parseMusicFreeManifestText(text);
    if (inline) return inline;
    if (/^https?:\/\//i.test(text)) {
        const fetcher = getOnlineSourceFetch();
        if (typeof fetcher !== 'function') return null;
        const response = await fetcher(text, { method: 'GET' });
        if (!response?.ok && Number(response?.status) >= 400) {
            throw Object.assign(new Error(`下载 MusicFree 清单失败（${response.status}）。`), { code: 'network-error' });
        }
        return parseMusicFreeManifestText(await response.text());
    }
    if (!text || text.includes('\n') || text.includes('\r') || /[;{}]/.test(text.slice(0, 256))) {
        return null;
    }
    try {
        return parseMusicFreeManifestText(await fs.readFile(path.resolve(text), 'utf8'));
    } catch {
        return null;
    }
}

async function importMusicFreeManifest(plugins, options = {}) {
    const fetcher = getOnlineSourceFetch();
    if (typeof fetcher !== 'function') {
        throw Object.assign(new Error('网络组件不可用，无法导入 MusicFree 音源。'), { code: 'network-error' });
    }
    const rootPath = getOnlineSourceDir();
    const usedIds = new Set();
    const imported = [];
    const failed = [];
    for (let index = 0; index < Math.min(plugins.length, MUSICFREE_MANIFEST_MAX_PLUGINS); index += 1) {
        const plugin = plugins[index];
        try {
            const response = await fetcher(plugin.url, { method: 'GET' });
            if (!response?.ok && Number(response?.status) >= 400) {
                throw Object.assign(new Error(`下载失败（${response.status}）。`), { code: 'network-error' });
            }
            const source = await response.text();
            if (Buffer.byteLength(source, 'utf8') > MUSICFREE_MODULE_MAX_BYTES) {
                throw Object.assign(new Error('MusicFree 音源脚本过大。'), { code: 'script-too-large' });
            }
            const providerId = getMusicFreeManifestProviderId(plugin, index, usedIds);
            const importedSource = await importOnlineSourceScript({ source, url: plugin.url }, {
                rootPath,
                id: `musicfree_${providerId}`,
                name: plugin.name,
                metadata: { name: plugin.name, version: plugin.version, providerId },
                providerId,
                format: 'musicfree',
                fetch: fetcher
            });
            const sourceInfo = Object.values(importedSource.metadata?.sources || {})[0];
            // MusicFree catalogues can include search-only discovery modules.
            // Keep them imported so the result is visible and diagnosable, but
            // the voice panel exposes only providers that also declare musicUrl.
            imported.push({
                id: importedSource.id,
                name: importedSource.metadata?.name || plugin.name,
                description: importedSource.metadata?.description || '',
                author: importedSource.metadata?.author || '',
                format: 'musicfree',
                sources: importedSource.metadata?.sources || {}
            });
        } catch (error) {
            failed.push({ name: plugin.name, reason: String(error?.message || error) });
        }
    }
    if (!imported.length) {
        const error = Object.assign(new Error(failed[0]?.reason || 'MusicFree 清单中没有可导入的音源。'), { code: 'musicfree-import-failed' });
        error.details = { failed };
        throw error;
    }
    return {
        id: imported[0].id,
        name: `MusicFree（${imported.length} 个音源）`,
        format: 'musicfree-manifest',
        imported,
        failed,
        sources: imported.flatMap(item => Object.entries(item.sources || {}).map(([providerId, info]) => [providerId, info]))
    };
}

function getMusicFreeManifestProviderId(plugin, index, usedIds = new Set()) {
    const fallback = `source_${index + 1}`;
    let candidate = '';
    try {
        const pathname = new URL(String(plugin?.url || '')).pathname;
        candidate = safeOnlineSourceId(path.basename(pathname, path.extname(pathname)));
    } catch {
        candidate = '';
    }
    candidate = candidate || safeOnlineSourceId(plugin?.name || fallback);
    const base = candidate;
    let suffix = 2;
    while (usedIds.has(candidate)) {
        candidate = `${base}_${suffix}`;
        suffix += 1;
    }
    usedIds.add(candidate);
    return candidate;
}

function safeOnlineSourceId(value) {
    const normalized = String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
    return normalized.slice(0, 42) || 'source';
}

async function deleteOnlineSource(sourceId) {
    const id = getOnlineSourceId(sourceId);
    if (!id) {
        throw Object.assign(new Error('在线音源标识无效。'), { code: 'invalid-source-id' });
    }
    const directory = getOnlineSourceDir();
    const entries = await Promise.all([`${id}.js`, `${id}.json`].map(async name => {
        const target = path.join(directory, name);
        try {
            await fs.lstat(target);
            await fs.rm(target, { force: true });
            return true;
        } catch (error) {
            if (error?.code === 'ENOENT') {
                return false;
            }
            throw error;
        }
    }));
    if (!entries.some(Boolean)) {
        throw Object.assign(new Error('在线音源不存在或已被删除。'), { code: 'source-not-found' });
    }
    return { id };
}

function getOnlineSourceErrorMessage(error) {
    const code = String(error?.code || '');
    const messages = {
        'catalog-unavailable': String(error?.message || '在线曲库目录不可用。'),
        'invalid-script': '脚本内容无效。',
        'invalid-source-id': '在线音源标识无效。',
        'file-not-found': '找不到指定的本地脚本。',
        'network-error': '下载音源脚本失败，请检查网络后重试。',
        'response-too-large': '音源脚本过大。',
        'script-too-large': '音源脚本过大。',
        'unsafe-script': '脚本包含不允许的 API，无法导入。',
        'source-not-found': '在线音源不存在或已被删除。',
        'timeout': '音源脚本初始化超时。',
        'unsupported-source-format': '不支持此音源格式。',
        'unsupported-action': '当前音源不支持该操作。',
        'unsupported-dependency': '此 MusicFree 音源需要当前不支持的依赖。',
        'musicfree-import-failed': 'MusicFree 清单中的音源均未能导入。'
    };
    return messages[code] || String(error?.message || '在线音源操作失败。');
}

async function getOnlineSourceState() {
    try {
        return {
            ok: true,
            sources: await listOnlineSources()
        };
    } catch (error) {
        recordDiagnostic('warn', 'voice.online-source-list-failed', { error });
        return {
            ok: false,
            reason: String(error?.code || 'source-list-failed'),
            message: getOnlineSourceErrorMessage(error),
            sources: []
        };
    }
}

async function runOnlineSourceAction(request = {}) {
    const type = String(request?.type || '').trim();
    try {
        if (type === 'import') {
            const imported = await importOnlineSource(request.input, { id: request.id });
            recordDiagnostic('info', 'voice.online-source-imported', { sourceId: imported.id });
            return {
                ok: true,
                source: imported,
                sources: await listOnlineSources()
            };
        }
        if (type === 'delete') {
            const removed = await deleteOnlineSource(request.id);
            recordDiagnostic('info', 'voice.online-source-deleted', { sourceId: removed.id });
            return {
                ok: true,
                removedId: removed.id,
                sources: await listOnlineSources()
            };
        }
        return {
            ok: false,
            reason: 'unsupported-action',
            message: '不支持的在线音源操作。',
            sources: await listOnlineSources()
        };
    } catch (error) {
        recordDiagnostic('warn', 'voice.online-source-action-failed', { type, error });
        return {
            ok: false,
            reason: String(error?.code || 'online-source-action-failed'),
            message: getOnlineSourceErrorMessage(error),
            sources: await listOnlineSources().catch(() => [])
        };
    }
}

/**
 * Run the optional Toolbox search extension exposed by an imported LXMusic
 * source. Standard User API scripts only resolve audio URLs, so Toolbox also
 * provides a small catalogue layer for providers with stable public search.
 */
async function searchOnlineSource(options = {}) {
    const keyword = String(options.keyword || options.query || '').trim();
    if (!keyword && options.recommend !== true) {
        throw new Error('搜索关键词不能为空');
    }
    const loaded = await getOnlineSourceById(options.sourceId);
    const providerId = String(options.providerId || options.provider || '');
    const providerInfo = loaded.metadata?.sources?.[providerId];
    const declaredActions = Array.isArray(providerInfo?.actions) ? providerInfo.actions : [];
    const sourceProvidesSearch = declaredActions.includes('search') || declaredActions.includes('musicSearch');
    if (!sourceProvidesSearch && BUILTIN_ONLINE_SEARCH_PROVIDERS.has(providerId)) {
        return await searchBuiltInOnlineCatalog({ ...options, keyword, providerId });
    }
    const runner = createOnlineSourceRunner(loaded.source, {
        metadata: loaded.metadata,
        format: loaded.metadata?.format,
        fetch: getOnlineSourceFetch()
    });
    try {
        if (typeof runner.requestMusicSearch !== 'function') {
            throw Object.assign(new Error('当前音源不支持搜索。'), { code: 'unsupported-action' });
        }
        const result = await runner.requestMusicSearch(
            keyword,
            {
                page: options.page,
                limit: options.limit,
                sourceId: providerId
            }
        );
        const results = Array.isArray(result)
            ? result
            : (Array.isArray(result?.results) ? result.results : []);
        return {
            results,
            sourceId: String(options.sourceId || ''),
            providerId,
            keyword,
            page: Number(result?.page) || Math.max(1, Number(options.page) || 1),
            hasMore: result?.hasMore === true
        };
    } finally {
        runner.dispose();
    }
}

async function readOnlineCatalogJson(url, headers = {}, requestOptions = {}) {
    const fetcher = getOnlineSourceFetch();
    if (typeof fetcher !== 'function') {
        throw Object.assign(new Error('网络组件不可用。'), { code: 'network-error' });
    }
    const response = await fetcher(url, {
        ...requestOptions,
        method: requestOptions.method || 'GET',
        headers: { ...headers, ...(requestOptions.headers || {}) }
    });
    if (!response?.ok && Number(response?.status) >= 400) {
        throw Object.assign(new Error(`在线曲库请求失败（${response.status}）。`), { code: 'network-error' });
    }
    const declaredLength = Number(response?.headers?.get?.('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > ONLINE_CATALOG_RESPONSE_MAX_BYTES) {
        throw Object.assign(new Error('在线曲库响应过大。'), { code: 'response-too-large' });
    }
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > ONLINE_CATALOG_RESPONSE_MAX_BYTES) {
        throw Object.assign(new Error('在线曲库响应过大。'), { code: 'response-too-large' });
    }
    return JSON.parse(text);
}

function mapTencentCatalogSong(item = {}) {
    const songmid = String(item.mid || item.songmid || item.strMediaMid || '');
    const name = String(item.name || item.title || item.songname || '').trim();
    if (!songmid || !name) return null;
    const singer = (Array.isArray(item.singer) ? item.singer : [])
        .map(value => String(value?.name || value || '').trim()).filter(Boolean).join(', ');
    const album = String(item.album?.name || item.albumname || '').trim();
    const duration = Math.max(0, Number(item.interval) || 0);
    const musicInfo = {
        id: songmid,
        songmid,
        name,
        songName: name,
        singer,
        album,
        interval: duration,
        duration,
        source: 'tx'
    };
    return { title: name, name, singer, artist: singer, album, duration, musicInfo };
}

function mapNeteaseCatalogSong(item = {}) {
    const id = String(item.id || '');
    const name = String(item.name || '').trim();
    if (!id || !name) return null;
    const singer = (Array.isArray(item.artists) ? item.artists : [])
        .map(value => String(value?.name || value || '').trim()).filter(Boolean).join(', ');
    const album = String(item.album?.name || '').trim();
    const duration = Math.max(0, Number(item.duration) || 0);
    const musicInfo = {
        id,
        songmid: id,
        name,
        songName: name,
        singer,
        album,
        duration,
        source: 'wy'
    };
    return { title: name, name, singer, artist: singer, album, duration, musicInfo };
}

function mapKuwoCatalogSong(item = {}) {
    const id = String(item.MUSICRID || item.musicrid || item.id || '').replace(/^MUSIC_/i, '').trim();
    const name = String(item.NAME || item.SONGNAME || item.name || '').trim();
    if (!id || !name) return null;
    const singer = String(item.ARTIST || item.artist || '').trim();
    const album = String(item.ALBUM || item.album || '').trim();
    const duration = Math.max(0, Number(item.DURATION || item.duration) || 0);
    const musicInfo = {
        id,
        songmid: id,
        name,
        songName: name,
        singer,
        artist: singer,
        album,
        albumName: album,
        albumId: String(item.ALBUMID || item.albumId || ''),
        interval: duration,
        duration,
        source: 'kw'
    };
    return { title: name, name, singer, artist: singer, album, duration, musicInfo };
}

function mapKugouCatalogSong(item = {}) {
    const fallback = Array.isArray(item.Grp) ? item.Grp.find(value => value?.FileHash) : null;
    const hash = String(item.FileHash || item.hash || fallback?.FileHash || '').trim();
    const name = String(item.SongName || item.OriSongName || item.songname || item.name || '').trim();
    if (!hash || !name) return null;
    const singer = String(item.SingerName || item.singername || '').trim() ||
        (Array.isArray(item.Singers) ? item.Singers.map(value => value?.name).filter(Boolean).join(', ') : '');
    const album = String(item.AlbumName || item.album_name || '').trim();
    const duration = Math.max(0, Number(item.Duration || item.duration) || 0);
    const audioId = String(item.Audioid || item.MixSongID || item.ID || '').trim();
    const musicInfo = {
        id: hash,
        hash,
        songmid: audioId || hash,
        audioId,
        name,
        songName: name,
        singer,
        artist: singer,
        album,
        albumName: album,
        albumId: String(item.AlbumID || item.album_id || ''),
        interval: duration,
        duration,
        source: 'kg'
    };
    const qualityHashes = {
        '128k': hash,
        '320k': String(item.HQFileHash || item['320hash'] || '').trim(),
        flac: String(item.SQFileHash || item.sqhash || '').trim(),
        flac24bit: String(item.ResFileHash || item.hash_high || '').trim()
    };
    musicInfo.HQFileHash = qualityHashes['320k'];
    musicInfo.SQFileHash = qualityHashes.flac;
    musicInfo.ResFileHash = qualityHashes.flac24bit;
    musicInfo['320hash'] = qualityHashes['320k'];
    musicInfo.sqhash = qualityHashes.flac;
    musicInfo._types = Object.fromEntries(Object.entries(qualityHashes)
        .filter(([, value]) => value)
        .map(([quality, value]) => [quality, { hash: value }]));
    return { title: name, name, singer, artist: singer, album, duration, musicInfo };
}

function mapMiguCatalogSong(item = {}) {
    const id = String(item.id || item.songId || item.contentId || item.copyrightId || '').trim();
    const name = String(item.name || item.songName || '').trim();
    if (!id || !name) return null;
    const singer = (Array.isArray(item.singers) ? item.singers : (Array.isArray(item.singerList) ? item.singerList : []))
        .map(value => String(value?.name || value?.singerName || value || '').trim()).filter(Boolean).join(', ');
    const albumInfo = (Array.isArray(item.albums) ? item.albums[0] : null) || {};
    const album = String(albumInfo.name || item.album || item.albumName || '').trim();
    const duration = Math.max(0, Number(item.duration || item.interval) || 0);
    const musicInfo = {
        id,
        hash: id,
        songmid: id,
        songId: String(item.songId || item.id || ''),
        contentId: String(item.contentId || ''),
        copyrightId: String(item.copyrightId || ''),
        name,
        songName: name,
        singer,
        artist: singer,
        album,
        albumName: album,
        albumId: String(albumInfo.id || item.albumId || ''),
        interval: duration,
        duration,
        source: 'mg'
    };
    return { title: name, name, singer, artist: singer, album, duration, musicInfo };
}

async function searchBuiltInOnlineCatalog(options = {}) {
    const providerId = String(options.providerId || '');
    const limit = Math.max(1, Math.min(50, Number(options.limit) || 30));
    const page = Math.max(1, Number(options.page) || 1);
    let results = [];
    let hasMore = false;
    if (providerId === 'kw') {
        const keyword = options.recommend === true ? '热歌' : String(options.keyword || '');
        const query = encodeURIComponent(keyword);
        const url = `https://search.kuwo.cn/r.s?client=kt&all=${query}&pn=${page - 1}&rn=${limit}&uid=794762570&ver=kwplayer_ar_9.2.2.1&vipver=1&show_copyright_off=1&newver=1&ft=music&cluster=0&strategy=2012&encoding=utf8&rformat=json&vermerge=1&mobi=1&issubtitle=1`;
        const payload = await readOnlineCatalogJson(url, { 'User-Agent': 'Mozilla/5.0' });
        results = (Array.isArray(payload?.abslist) ? payload.abslist : [])
            .map(mapKuwoCatalogSong)
            .filter(Boolean);
        hasMore = Number(payload?.TOTAL) > page * limit;
    } else if (providerId === 'mg') {
        const keyword = options.recommend === true ? '热歌' : String(options.keyword || '');
        const query = encodeURIComponent(keyword);
        const searchSwitch = encodeURIComponent(JSON.stringify({ song: 1 }));
        const url = `https://c.musicapp.migu.cn/v1.0/content/search_all.do?text=${query}&pageNo=${page}&pageSize=${limit}&isCopyright=1&searchSwitch=${searchSwitch}`;
        const payload = await readOnlineCatalogJson(url, { 'User-Agent': 'Mozilla/5.0' });
        results = (Array.isArray(payload?.songResultData?.result) ? payload.songResultData.result : [])
            .map(mapMiguCatalogSong)
            .filter(Boolean);
        hasMore = Number(payload?.songResultData?.totalCount) > page * limit;
    } else if (providerId === 'kg') {
        const keyword = options.recommend === true ? '热歌' : String(options.keyword || '');
        const query = encodeURIComponent(keyword);
        const url = `https://songsearch.kugou.com/song_search_v2?keyword=${query}&page=${page}&pagesize=${limit}&userid=0&clientver=&platform=WebFilter&filter=2&iscorrection=1&privilege_filter=0&area_code=1`;
        const payload = await readOnlineCatalogJson(url, {
            Referer: 'https://www.kugou.com/',
            'User-Agent': 'Mozilla/5.0'
        });
        results = (Array.isArray(payload?.data?.lists) ? payload.data.lists : [])
            .map(mapKugouCatalogSong)
            .filter(Boolean);
        hasMore = Number(payload?.data?.total) > page * limit;
    } else if (providerId === 'tx') {
        if (options.recommend === true) {
            const url = `https://c.y.qq.com/v8/fcg-bin/fcg_v8_toplist_cp.fcg?topid=26&page=detail&type=top&song_num=${limit}&format=json`;
            const payload = await readOnlineCatalogJson(url, {
                Referer: 'https://y.qq.com/',
                'User-Agent': 'Mozilla/5.0'
            });
            results = (Array.isArray(payload?.songlist) ? payload.songlist : [])
                .map(value => mapTencentCatalogSong(value?.data || value))
                .filter(Boolean);
        } else {
            const query = encodeURIComponent(String(options.keyword || ''));
            const url = `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?p=${page}&n=${limit}&w=${query}&format=json&new_json=1`;
            const payload = await readOnlineCatalogJson(url, {
                Referer: 'https://y.qq.com/',
                'User-Agent': 'Mozilla/5.0'
            });
            results = (Array.isArray(payload?.data?.song?.list) ? payload.data.song.list : [])
                .map(mapTencentCatalogSong)
                .filter(Boolean);
            hasMore = Number(payload?.data?.song?.totalnum) > page * limit;
        }
    } else if (providerId === 'wy') {
        if (options.recommend === true) {
            const payload = await readOnlineCatalogJson('https://music.163.com/api/v3/playlist/detail?id=3778678&n=50', {
                Referer: 'https://music.163.com/',
                'User-Agent': 'Mozilla/5.0'
            });
            results = (Array.isArray(payload?.playlist?.tracks) ? payload.playlist.tracks : [])
                .slice(0, limit)
                .map(item => mapNeteaseCatalogSong({
                    ...item,
                    artists: item.ar,
                    album: item.al,
                    duration: item.dt
                }))
                .filter(Boolean);
        } else {
            const query = encodeURIComponent(String(options.keyword || ''));
            const offset = (page - 1) * limit;
            const url = `https://music.163.com/api/search/get/web?s=${query}&type=1&offset=${offset}&total=true&limit=${limit}`;
            const payload = await readOnlineCatalogJson(url, {
                Referer: 'https://music.163.com/',
                'User-Agent': 'Mozilla/5.0'
            });
            results = (Array.isArray(payload?.result?.songs) ? payload.result.songs : [])
                .map(mapNeteaseCatalogSong)
                .filter(Boolean);
            hasMore = Number(payload?.result?.songCount) > page * limit;
        }
    } else {
        throw Object.assign(new Error('当前音源暂不支持搜索。'), { code: 'unsupported-action' });
    }
    return {
        results,
        sourceId: String(options.sourceId || ''),
        providerId,
        keyword: String(options.keyword || ''),
        page,
        hasMore
    };
}

function normalizeOnlineCoverUrl(value) {
    const url = String(value || '').trim();
    if (!url) return '';
    return url.replace(/^http:\/\//i, 'https://');
}

function formatOnlinePlayCount(value) {
    const count = Math.max(0, Number(value) || 0);
    if (count >= 100_000_000) return `${(count / 100_000_000).toFixed(count >= 1_000_000_000 ? 0 : 1)}亿次播放`;
    if (count >= 10_000) return `${(count / 10_000).toFixed(count >= 100_000 ? 0 : 1)}万次播放`;
    return count > 0 ? `${Math.floor(count)} 次播放` : '';
}

function getTencentPlaylistCatalogUrl(sort, page, limit) {
    const request = {
        comm: { cv: 1602, ct: 20 },
        playlist: {
            method: 'get_playlist_by_tag',
            param: {
                id: 10000000,
                sin: limit * (page - 1),
                size: limit,
                order: sort === 'new' ? 2 : 5,
                cur_page: page
            },
            module: 'playlist.PlayListPlazaServer'
        }
    };
    return `https://u.y.qq.com/cgi-bin/musicu.fcg?loginUin=0&hostUin=0&format=json&inCharset=utf-8&outCharset=utf-8&notice=0&platform=wk_v15.json&needNewCode=0&data=${encodeURIComponent(JSON.stringify(request))}`;
}

async function listBuiltInOnlineCollections(options = {}) {
    const providerId = String(options.providerId || '');
    const mode = options.mode === 'playlists' ? 'playlists' : 'charts';
    const sort = options.sort === 'new' ? 'new' : 'hot';
    const page = Math.max(1, Math.floor(Number(options.page) || 1));
    const limit = Math.max(1, Math.min(30, Math.floor(Number(options.limit) || 20)));
    let items = [];
    let total = 0;
    if (mode === 'charts' && providerId === 'tx') {
        const payload = await readOnlineCatalogJson(
            'https://c.y.qq.com/v8/fcg-bin/fcg_myqq_toplist.fcg?format=json&g_tk=5381&uin=0&inCharset=utf-8&outCharset=utf-8&notice=0&platform=h5&needNewCode=1',
            { Referer: 'https://y.qq.com/', 'User-Agent': 'Mozilla/5.0' }
        );
        const list = Array.isArray(payload?.data?.topList) ? payload.data.topList : [];
        items = list.filter(item => Number(item?.id) !== 201).slice(0, limit).map(item => ({
            id: `tx-chart-${item.id}`,
            collectionId: String(item.id || ''),
            collectionKind: 'chart',
            title: String(item.topTitle || '').replace(/^巅峰榜·/, '') || '排行榜',
            subtitle: formatOnlinePlayCount(item.listenCount) || 'QQ 音乐',
            coverUrl: normalizeOnlineCoverUrl(item.picUrl),
            providerId: 'tx'
        })).filter(item => item.collectionId);
        total = list.length;
    } else if (mode === 'charts' && providerId === 'wy') {
        const payload = await readOnlineCatalogJson('https://music.163.com/api/toplist', {
            Referer: 'https://music.163.com/',
            'User-Agent': 'Mozilla/5.0'
        });
        const list = Array.isArray(payload?.list) ? payload.list : [];
        items = list.slice(0, limit).map(item => ({
            id: `wy-chart-${item.id}`,
            collectionId: String(item.id || ''),
            collectionKind: 'chart',
            title: String(item.name || '').trim() || '排行榜',
            subtitle: [String(item.updateFrequency || '').trim(), '网易云音乐'].filter(Boolean).join(' · '),
            coverUrl: normalizeOnlineCoverUrl(item.coverImgUrl),
            providerId: 'wy'
        })).filter(item => item.collectionId);
        total = list.length;
    } else if (mode === 'playlists' && providerId === 'tx') {
        const payload = await readOnlineCatalogJson(getTencentPlaylistCatalogUrl(sort, page, limit), {
            Referer: 'https://y.qq.com/',
            'User-Agent': 'Mozilla/5.0'
        });
        const data = payload?.playlist?.data || {};
        const list = Array.isArray(data.v_playlist) ? data.v_playlist : [];
        items = list.map(item => {
            const songIds = String(item.song_ids || '').split(/\s+/).filter(value => /^\d+$/.test(value)).slice(0, 60);
            return {
                id: `tx-playlist-${item.tid}`,
                collectionId: String(item.tid || ''),
                collectionKind: 'playlist',
                title: String(item.title || '').trim() || '歌单',
                subtitle: [String(item.creator_info?.nick || '').trim(), formatOnlinePlayCount(item.access_num)].filter(Boolean).join(' · '),
                coverUrl: normalizeOnlineCoverUrl(item.cover_url_medium || item.cover_url_big),
                songIds,
                total: songIds.length,
                providerId: 'tx'
            };
        }).filter(item => item.collectionId && item.songIds.length);
        total = Math.max(items.length, Number(data.total) || 0);
    } else if (mode === 'playlists' && providerId === 'wy') {
        if (sort === 'new') return { items: [], total: 0, page, hasMore: false };
        const offset = (page - 1) * limit;
        const payload = await readOnlineCatalogJson(
            `https://music.163.com/api/playlist/list?cat=${encodeURIComponent('全部')}&order=hot&offset=${offset}&total=true&limit=${limit}`,
            { Referer: 'https://music.163.com/', 'User-Agent': 'Mozilla/5.0' }
        );
        const list = Array.isArray(payload?.playlists) ? payload.playlists : [];
        items = list.map(item => ({
            id: `wy-playlist-${item.id}`,
            collectionId: String(item.id || ''),
            collectionKind: 'playlist',
            title: String(item.name || '').trim() || '歌单',
            subtitle: [String(item.creator?.nickname || '').trim(), formatOnlinePlayCount(item.playCount)].filter(Boolean).join(' · '),
            coverUrl: normalizeOnlineCoverUrl(item.coverImgUrl),
            total: Math.max(0, Number(item.trackCount) || 0),
            providerId: 'wy'
        })).filter(item => item.collectionId);
        total = Math.max(items.length, Number(payload?.total) || 0);
    } else {
        throw Object.assign(new Error('当前平台暂不支持该在线目录。'), { code: 'unsupported-action' });
    }
    return { items, total, page, hasMore: total > page * limit };
}

async function getTencentPlaylistSongs(songIds, limit) {
    const ids = (Array.isArray(songIds) ? songIds : [])
        .map(value => String(value || ''))
        .filter(value => /^\d+$/.test(value))
        .slice(0, limit);
    if (!ids.length) return [];
    const body = {
        comm: { ct: '19', cv: '1859', uin: '0' }
    };
    ids.forEach((songId, index) => {
        body[`req_${index}`] = {
            module: 'music.pf_song_detail_svr',
            method: 'get_song_detail_yqq',
            param: { song_type: 0, song_id: Number(songId) }
        };
    });
    const payload = await readOnlineCatalogJson('https://u.y.qq.com/cgi-bin/musicu.fcg', {
        Referer: 'https://y.qq.com/',
        'User-Agent': 'Mozilla/5.0'
    }, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    return ids.map((unused, index) => mapTencentCatalogSong(payload?.[`req_${index}`]?.data?.track_info || {})).filter(Boolean);
}

async function getBuiltInOnlineCollectionSongs(options = {}) {
    const providerId = String(options.providerId || '');
    const collectionKind = options.collectionKind === 'playlist' ? 'playlist' : 'chart';
    const collectionId = String(options.collectionId || '').trim();
    const limit = Math.max(1, Math.min(60, Math.floor(Number(options.limit) || 50)));
    if (!collectionId) throw Object.assign(new Error('在线目录标识无效。'), { code: 'invalid-result' });
    let results = [];
    let info = {};
    if (providerId === 'tx' && collectionKind === 'chart') {
        const payload = await readOnlineCatalogJson(
            `https://c.y.qq.com/v8/fcg-bin/fcg_v8_toplist_cp.fcg?topid=${encodeURIComponent(collectionId)}&page=detail&type=top&song_num=${limit}&format=json`,
            { Referer: 'https://y.qq.com/', 'User-Agent': 'Mozilla/5.0' }
        );
        results = (Array.isArray(payload?.songlist) ? payload.songlist : [])
            .map(value => mapTencentCatalogSong(value?.data || value)).filter(Boolean);
        info = {
            title: String(payload?.topinfo?.ListName || options.title || '排行榜'),
            coverUrl: normalizeOnlineCoverUrl(payload?.topinfo?.pic_v12 || options.coverUrl)
        };
    } else if (providerId === 'tx' && collectionKind === 'playlist') {
        results = await getTencentPlaylistSongs(options.songIds, limit);
        info = { title: String(options.title || '歌单'), coverUrl: normalizeOnlineCoverUrl(options.coverUrl) };
    } else if (providerId === 'wy') {
        const payload = await readOnlineCatalogJson(
            `https://music.163.com/api/v3/playlist/detail?id=${encodeURIComponent(collectionId)}&n=${limit}&s=8`,
            { Referer: 'https://music.163.com/', 'User-Agent': 'Mozilla/5.0' }
        );
        const playlist = payload?.playlist || {};
        let tracks = Array.isArray(playlist.tracks) ? playlist.tracks.slice(0, limit) : [];
        const trackIds = (Array.isArray(playlist.trackIds) ? playlist.trackIds : [])
            .map(item => String(item?.id || '')).filter(Boolean).slice(0, limit);
        if (trackIds.length > tracks.length) {
            const detail = await readOnlineCatalogJson(
                `https://music.163.com/api/song/detail?ids=${encodeURIComponent(JSON.stringify(trackIds))}`,
                { Referer: 'https://music.163.com/', 'User-Agent': 'Mozilla/5.0' }
            );
            if (Array.isArray(detail?.songs) && detail.songs.length) tracks = detail.songs;
        }
        results = tracks.map(item => mapNeteaseCatalogSong({
            ...item,
            artists: item.ar || item.artists,
            album: item.al || item.album,
            duration: item.dt || item.duration
        })).filter(Boolean);
        info = {
            title: String(playlist.name || options.title || (collectionKind === 'chart' ? '排行榜' : '歌单')),
            subtitle: String(playlist.creator?.nickname || ''),
            coverUrl: normalizeOnlineCoverUrl(playlist.coverImgUrl || options.coverUrl)
        };
    } else {
        throw Object.assign(new Error('当前平台暂不支持该在线目录。'), { code: 'unsupported-action' });
    }
    return { results, info };
}

async function browseOnlineCatalog(options = {}) {
    const mode = ['recommend', 'charts', 'playlists', 'detail'].includes(options.mode)
        ? options.mode
        : 'recommend';
    const sort = options.sort === 'new' ? 'new' : 'hot';
    const targets = (Array.isArray(options.targets) ? options.targets : [])
        .filter(target => ['tx', 'wy'].includes(String(target?.providerId || '')))
        .slice(0, mode === 'detail' ? 1 : 4);
    const settled = await Promise.allSettled(targets.map(async target => {
        const sourceId = String(target?.sourceId || '');
        const providerId = String(target?.providerId || '');
        const loaded = await getOnlineSourceById(sourceId);
        if (!loaded.metadata?.sources?.[providerId]?.actions?.includes('musicUrl')) {
            throw Object.assign(new Error('当前音源无法解析该平台歌曲。'), { code: 'unsupported-action' });
        }
        if (mode === 'detail') {
            const detail = await getBuiltInOnlineCollectionSongs({
                ...options.collection,
                providerId,
                limit: options.limit
            });
            return {
                items: detail.results.map(item => ({
                    ...item,
                    toolboxSourceId: sourceId,
                    toolboxProviderId: providerId,
                    toolboxSourceLabel: String(target?.label || '')
                })),
                info: detail.info
            };
        }
        if (mode === 'recommend') {
            const presets = providerId === 'tx'
                ? { hot: ['26', 'QQ 音乐热歌榜'], new: ['27', 'QQ 音乐新歌榜'] }
                : { hot: ['3778678', '网易云热歌榜'], new: ['3779629', '网易云新歌榜'] };
            const [collectionId, title] = presets[sort];
            const detail = await getBuiltInOnlineCollectionSongs({
                providerId,
                collectionKind: 'chart',
                collectionId,
                title,
                limit: options.limit
            });
            return {
                items: detail.results.map(item => ({
                    ...item,
                    toolboxSourceId: sourceId,
                    toolboxProviderId: providerId,
                    toolboxSourceLabel: String(target?.label || '')
                })),
                info: { title: sort === 'new' ? '最新音乐' : '热门音乐' }
            };
        }
        const listed = await listBuiltInOnlineCollections({
            providerId,
            mode,
            sort,
            page: options.page,
            limit: options.limit
        });
        return {
            items: listed.items.map(item => ({
                ...item,
                sourceId,
                providerId,
                sourceLabel: String(target?.label || '')
            })),
            total: listed.total,
            hasMore: listed.hasMore
        };
    }));
    const items = [];
    const failures = [];
    let info = {};
    let hasMore = false;
    settled.forEach((result, index) => {
        const target = targets[index];
        if (result.status === 'fulfilled') {
            items.push(...result.value.items);
            if (!info.title && result.value.info) info = result.value.info;
            hasMore ||= result.value.hasMore === true;
        } else {
            failures.push({
                sourceId: String(target?.sourceId || ''),
                providerId: String(target?.providerId || ''),
                message: String(result.reason?.message || '在线目录加载失败')
            });
        }
    });
    return { items, failures, info, mode, sort, hasMore };
}

async function searchOnlineSources(options = {}) {
    const targets = (Array.isArray(options.targets) ? options.targets : [])
        .filter(target => options.recommend !== true ||
            BUILTIN_ONLINE_RECOMMEND_PROVIDERS.has(String(target?.providerId || '')) ||
            !BUILTIN_ONLINE_SEARCH_PROVIDERS.has(String(target?.providerId || '')))
        .slice(0, 24);
    const perSourceLimit = Math.max(1, Math.min(30, Number(options.limit) || 20));
    const settled = await Promise.allSettled(targets.map(async target => {
        const result = await searchOnlineSource({
            sourceId: target?.sourceId,
            providerId: target?.providerId,
            keyword: options.keyword,
            recommend: options.recommend === true,
            page: options.page,
            limit: perSourceLimit
        });
        return result.results.map(item => ({
            ...item,
            toolboxSourceId: result.sourceId,
            toolboxProviderId: result.providerId,
            toolboxSourceLabel: String(target?.label || ''),
            toolboxQuality: String(options.quality || '320k')
        }));
    }));
    const results = settled.flatMap(entry => entry.status === 'fulfilled' ? entry.value : []);
    const failures = settled.flatMap((entry, index) => entry.status === 'rejected'
        ? [{
            sourceId: String(targets[index]?.sourceId || ''),
            providerId: String(targets[index]?.providerId || ''),
            message: getOnlineSourceErrorMessage(entry.reason)
        }]
        : []);
    if (!results.length && failures.length === targets.length && failures.length) {
        throw new Error(failures[0].message);
    }
    return { results, failures };
}

// QQ has returned this cache path through several layers of wrappers across
// desktop releases (for example `data.path_info.path`). Keep the extraction
// recursive so the raw-send path is independent of the response envelope.
function findNativePath(value, depth = 0, seen = new WeakSet()) {
    if (!value || depth > 8 || typeof value !== 'object' || value instanceof Uint8Array || value instanceof Map) {
        return '';
    }
    if (seen.has(value)) {
        return '';
    }
    seen.add(value);
    const pathKeys = ['path', 'filePath', 'newPath', 'file_path', 'localPath', 'path_info'];
    for (const key of pathKeys) {
        const candidate = value[key];
        if (typeof candidate === 'string' && candidate.trim()) {
            return candidate.trim();
        }
        if (candidate && typeof candidate === 'object') {
            const nested = findNativePath(candidate, depth + 1, seen);
            if (nested) {
                return nested;
            }
        }
    }
    for (const item of Object.values(value)) {
        const nested = findNativePath(item, depth + 1, seen);
        if (nested) {
            return nested;
        }
    }
    return '';
}

function getOnlineAudioHttpStatus(error) {
    const status = Number(error?.details?.status ?? error?.status ?? error?.statusCode ?? 0);
    return Number.isFinite(status) ? Math.trunc(status) : 0;
}

function isRetryableOnlineAudioError(error) {
    const status = getOnlineAudioHttpStatus(error);
    if ([403, 408, 425, 429, 500, 502, 503, 504].includes(status)) {
        return true;
    }
    return ['network-error', 'timeout'].includes(String(error?.code || ''));
}

function getOnlineAudioRequestHeaders(providerId = '') {
    const origins = {
        kw: 'https://www.kuwo.cn/',
        mg: 'https://music.migu.cn/',
        kg: 'https://www.kugou.com/',
        tx: 'https://y.qq.com/',
        wy: 'https://music.163.com/'
    };
    const referer = origins[String(providerId || '').trim().toLowerCase()] || '';
    return {
        Accept: 'audio/*,application/octet-stream;q=0.9,*/*;q=0.8',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
        ...(referer ? { Referer: referer } : {})
    };
}

async function createOnlineSourceAudioResolver(options = {}) {
    const directUrl = String(options.url || '').trim();
    if (directUrl) {
        return {
            resolve: async () => directUrl,
            dispose() {}
        };
    }
    const title = String(options.title || options.fileName || '').trim();
    const loaded = await getOnlineSourceById(options.sourceId);
    const runner = createOnlineSourceRunner(loaded.source, {
        metadata: loaded.metadata,
        format: loaded.metadata?.format,
        fetch: getOnlineSourceFetch()
    });
    return {
        resolve: async () => await runner.requestMusicUrl(
            options.songInfo || { id: title, name: title },
            options.quality || '320k',
            options.providerId || options.provider || ''
        ),
        dispose: () => runner.dispose()
    };
}

async function downloadOnlineSourceAudio(options = {}) {
    const directUrl = String(options.url || '').trim();
    const title = String(options.title || options.fileName || '').trim();
    let lastError;
    const resolver = await createOnlineSourceAudioResolver(options);
    try {
        for (let attempt = 1; attempt <= ONLINE_AUDIO_MAX_ATTEMPTS; attempt += 1) {
            try {
                const audioUrl = await resolver.resolve();
                const temporaryName = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}-${title || 'online-audio'}`;
                const cached = await downloadAudioUrl(audioUrl, {
                    rootPath: getPluginTempDir(),
                    fileName: temporaryName,
                    fetch: getOnlineSourceFetch(),
                    ...(attempt > 1
                        ? { headers: getOnlineAudioRequestHeaders(options.providerId || options.provider) }
                        : {})
                });
                return {
                    ...cached,
                    sourceUrl: audioUrl,
                    title: title || path.basename(cached.fileName, path.extname(cached.fileName)),
                    temporary: true
                };
            } catch (error) {
                lastError = error;
                if (attempt >= ONLINE_AUDIO_MAX_ATTEMPTS || !isRetryableOnlineAudioError(error)) {
                    throw error;
                }
                recordDiagnostic('warn', 'voice.online-audio-retry', {
                    attempt,
                    maxAttempts: ONLINE_AUDIO_MAX_ATTEMPTS,
                    phase: getOnlineAudioHttpStatus(error) ? 'http' : 'network',
                    status: getOnlineAudioHttpStatus(error),
                    providerId: String(options.providerId || options.provider || ''),
                    refreshedUrl: !directUrl
                });
                await new Promise(resolve => setTimeout(resolve, attempt * 250));
            }
        }
    } finally {
        resolver.dispose();
    }
    throw lastError;
}

async function createOnlineAudioPreview(options = {}) {
    const previewKey = JSON.stringify({
        previewVersion: 2,
        sourceId: String(options.sourceId || ''),
        providerId: String(options.providerId || options.provider || ''),
        quality: String(options.quality || '320k'),
        songInfo: options.songInfo && typeof options.songInfo === 'object' ? options.songInfo : {},
        url: String(options.url || '')
    });
    const existingPreviewPath = await getExistingStableAudioPreview(previewKey);
    if (existingPreviewPath) {
        return {
            id: String(options.id || ''),
            title: String(options.title || '').trim() || '在线音频',
            previewPath: existingPreviewPath,
            previewFormat: getDirectPreviewFormat(existingPreviewPath) || 'wav'
        };
    }
    const cached = await downloadOnlineSourceAudio(options);
    try {
        const directFormat = getDirectPreviewFormat(cached.path);
        const previewPath = await getStableAudioPreviewPath(
            previewKey,
            DIRECT_PREVIEW_EXTENSIONS_BY_FORMAT[directFormat] || '.wav'
        );
        if (directFormat) {
            await movePreviewFile(cached.path, previewPath);
        } else if (isSilkFile(cached.path)) {
            const sourceData = await fs.readFile(cached.path);
            const decoded = await decodeSilkToPcm(sourceData);
            await fs.writeFile(previewPath, makePcm16Wav(decoded.data, TARGET_SILK_SAMPLE_RATE, 1));
        } else {
            await runTool('ffmpeg', [
                '-v', 'error',
                '-y',
                ...getMediaInputArgs(cached.path),
                '-vn',
                '-ac', '2',
                '-ar', '48000',
                '-f', 'wav',
                previewPath
            ]);
        }
        return {
            id: String(options.id || ''),
            title: cached.title || String(options.title || '').trim() || '在线音频',
            previewPath,
            previewFormat: directFormat || 'wav'
        };
    } finally {
        if (cached.temporary) {
            await fs.unlink(cached.path).catch(() => {});
        }
    }
}

function createLibraryIndexLookup(index) {
    const itemsByPath = new Map();
    const convertedVoiceCandidates = new Map();
    for (const item of index.items || []) {
        const comparablePath = normalizeComparablePath(normalizeStoredPath(item.path));
        if (comparablePath && !itemsByPath.has(comparablePath)) {
            itemsByPath.set(comparablePath, item);
        }
        if (item.kind !== 'ptt') {
            continue;
        }
        const comparableSourcePath = normalizeComparablePath(normalizeStoredPath(item.sourcePath));
        if (!comparableSourcePath) {
            continue;
        }
        const candidates = convertedVoiceCandidates.get(comparableSourcePath) || [];
        candidates.push(item);
        convertedVoiceCandidates.set(comparableSourcePath, candidates);
    }
    return { itemsByPath, convertedVoiceCandidates };
}

function hasConvertedVoiceForSource(convertedVoiceCandidates, sourcePath) {
    const comparablePath = normalizeComparablePath(sourcePath);
    return (convertedVoiceCandidates.get(comparablePath) || []).some(item =>
        fsSync.existsSync(normalizeStoredPath(item.path))
    );
}

async function countSupportedLibraryEntries(dirPath, itemsByPath = new Map()) {
    let entries = [];
    try {
        entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch {
        return 0;
    }
    let count = 0;
    for (const entry of entries) {
        if (entry.isDirectory() && !entry.isSymbolicLink?.()) {
            count += 1;
            continue;
        }
        if (!entry.isFile()) {
            continue;
        }
        const entryPath = path.join(dirPath, entry.name);
        const indexedKind = itemsByPath.get(normalizeComparablePath(entryPath))?.kind;
        const extension = path.extname(entry.name).toLowerCase();
        if (indexedKind === 'ptt' || indexedKind === 'media' ||
            MEDIA_EXTENSION_SET.has(extension) || !extension) {
            count += 1;
        }
    }
    return count;
}

function parseFfmpegDuration(text = '') {
    const match = String(text).match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
    if (!match) {
        return 0;
    }
    const hours = Number(match[1]) || 0;
    const minutes = Number(match[2]) || 0;
    const seconds = Number(match[3]) || 0;
    const total = hours * 3600 + minutes * 60 + seconds;
    return Number.isFinite(total) && total > 0 ? Math.ceil(total) : 0;
}

async function probeMediaDurationSeconds(filePath) {
    try {
        const result = await runTool('ffmpeg', [
            '-hide_banner',
            ...getMediaInputArgs(filePath),
            '-t', '0.001',
            '-f', 'null',
            '-'
        ]);
        return parseFfmpegDuration(`${result.stdout || ''}\n${result.stderr || ''}`);
    } catch (error) {
        return parseFfmpegDuration(`${error?.stdout || ''}\n${error?.stderr || ''}`);
    }
}

async function detectLibraryDurationSeconds(filePath) {
    if (!filePath || !fsSync.existsSync(filePath)) {
        return 0;
    }
    if (isSilkFile(filePath)) {
        const data = await fs.readFile(filePath);
        return Math.max(1, Math.ceil(estimateSilkDurationMs(data) / 1000));
    }
    return await probeMediaDurationSeconds(filePath);
}

function upsertIndexedLibraryItem(index, item) {
    const comparablePath = normalizeComparablePath(normalizeStoredPath(item.path));
    const existing = (index.items || []).find(entry =>
        entry.id === item.id ||
        normalizeComparablePath(normalizeStoredPath(entry.path)) === comparablePath
    );
    if (existing) {
        Object.assign(existing, item);
        return;
    }
    index.items = index.items || [];
    index.items.unshift(item);
}

async function getLibraryItems(relativeFolder = '', missingDurationItems = []) {
    await ensureLibraryDirs();
    const folder = validateLibraryRelativePath(relativeFolder, true);
    let folderInfo;
    try {
        folderInfo = await resolveExistingLibraryRelativePath(folder, {
            allowRoot: true,
            kind: 'folder'
        });
    } catch {
        return [];
    }
    const folderPath = folderInfo.path;
    const index = await readLibraryIndex();
    const { itemsByPath, convertedVoiceCandidates } = createLibraryIndexLookup(index);
    let indexDirty = false;
    const items = [];
    let entries = [];
    try {
        entries = await fs.readdir(folderPath, { withFileTypes: true });
    } catch {
        return [];
    }
    const folderItems = await Promise.all(entries
        .filter(entry => entry.isDirectory() && !entry.isSymbolicLink?.())
        .map(async entry => {
            const entryPath = path.join(folderPath, entry.name);
            const relativePath = getLibraryRelativePath(entryPath);
            if (!relativePath) {
                return null;
            }
            return {
                id: encodeLibraryItemId('folder', relativePath),
                kind: 'folder',
                title: entry.name,
                path: entryPath,
                relativePath,
                parentPath: getLibraryParentFolder(relativePath),
                count: await countSupportedLibraryEntries(entryPath, itemsByPath),
                createdAt: ''
            };
        }));
    items.push(...folderItems.filter(Boolean));
    for (const entry of entries) {
        if (entry.isDirectory()) {
            continue;
        }
        const entryPath = path.join(folderPath, entry.name);
        const relativePath = getLibraryRelativePath(entryPath);
        if (!relativePath) {
            continue;
        }
        if (!entry.isFile()) {
            continue;
        }
        const comparablePath = normalizeComparablePath(entryPath);
        const indexed = itemsByPath.get(comparablePath) || null;
        const indexedKind = indexed?.kind === 'ptt' || indexed?.kind === 'media' ? indexed.kind : '';
        const kind = indexedKind || getLibraryFileKind(entryPath);
        if (!kind || (kind === 'media' && hasConvertedVoiceForSource(convertedVoiceCandidates, entryPath))) {
            continue;
        }
        const duration = Math.max(0, Number(indexed?.duration) || 0);
        const item = {
            ...(indexed || {}),
            id: indexed?.id || encodeLibraryItemId('file', relativePath),
            kind,
            title: indexed?.title || path.basename(entry.name, path.extname(entry.name)),
            path: entryPath,
            relativePath,
            parentPath: folder,
            originalName: indexed?.originalName || entry.name,
            duration,
            createdAt: indexed?.createdAt || ''
        };
        items.push(item);
        if (!indexed) {
            upsertIndexedLibraryItem(index, {
                ...item,
                relativePath: undefined,
                parentPath: undefined
            });
            itemsByPath.set(comparablePath, item);
            indexDirty = true;
        }
        if (duration <= 0 && Array.isArray(missingDurationItems)) {
            missingDurationItems.push({
                id: item.id,
                path: entryPath
            });
        }
    }
    if (indexDirty) {
        await writeLibraryIndex(index);
    }
    return items.sort((a, b) => {
        if (a.kind === 'folder' && b.kind !== 'folder') {
            return -1;
        }
        if (a.kind !== 'folder' && b.kind === 'folder') {
            return 1;
        }
        return String(a.title || '').localeCompare(String(b.title || ''), 'zh-Hans-CN');
    });
}

function toLibraryViewItems(items) {
    return items.map(item => {
        const relativePath = item.relativePath || getLibraryRelativePath(item.path);
        return {
            id: item.id,
            title: item.title || path.basename(item.path),
            kind: item.kind || 'ptt',
            duration: Number(item.duration) || 0,
            count: Number(item.count) || 0,
            relativePath,
            parentPath: item.parentPath ?? getLibraryParentFolder(relativePath),
            createdAt: item.createdAt || ''
        };
    });
}

async function detectMissingLibraryDurations(items) {
    const pending = Array.isArray(items) ? items : [];
    const updates = [];
    let nextIndex = 0;
    const workers = Array.from({
        length: Math.min(LIBRARY_DURATION_CONCURRENCY, pending.length)
    }, async () => {
        while (nextIndex < pending.length) {
            const item = pending[nextIndex++];
            const duration = Math.ceil(Number(await detectLibraryDurationSeconds(item?.path).catch(() => 0)) || 0);
            if (item?.id && duration > 0) {
                updates.push({
                    id: item.id,
                    path: item.path,
                    duration
                });
            }
        }
    });
    await Promise.all(workers);
    return updates;
}

async function persistLibraryDurationUpdates(updates) {
    if (!Array.isArray(updates) || updates.length === 0) {
        return [];
    }
    return await withLibraryIndexMutation(async () => {
        const index = await readLibraryIndex();
        const persisted = [];
        let indexDirty = false;
        for (const update of updates) {
            const itemId = String(update?.id || '');
            const itemPath = normalizeStoredPath(update?.path);
            const comparablePath = normalizeComparablePath(itemPath);
            const duration = Math.ceil(Number(update?.duration) || 0);
            if (!itemId || !itemPath || !comparablePath || duration <= 0 || !fsSync.existsSync(itemPath)) {
                continue;
            }
            const indexed = (index.items || []).find(item =>
                item.id === itemId &&
                normalizeComparablePath(normalizeStoredPath(item.path)) === comparablePath
            );
            if (!indexed) {
                continue;
            }
            if (Number(indexed.duration) !== duration) {
                indexed.duration = duration;
                indexDirty = true;
            }
            persisted.push({
                id: indexed.id,
                duration
            });
        }
        if (indexDirty) {
            await writeLibraryIndex(index);
        }
        return persisted;
    });
}

async function createAudioPreviewFile(sourcePath, cacheKey = '') {
    sourcePath = normalizeStoredPath(sourcePath);
    if (!sourcePath || !fsSync.existsSync(sourcePath)) {
        throw new Error(`Voice file was not found: ${sourcePath}`);
    }
    const stat = await fs.stat(sourcePath);
    const previewDir = await getPreviewCacheDir();
    const previewId = getBufferMd5(Buffer.from(`${cacheKey}|${sourcePath}`));
    const previewPath = path.join(previewDir, `${previewId}-${stat.size}-${Math.floor(stat.mtimeMs)}.wav`);
    if (!fsSync.existsSync(previewPath)) {
        if (isSilkFile(sourcePath)) {
            const sourceData = await fs.readFile(sourcePath);
            const decoded = await decodeSilkToPcm(sourceData);
            await fs.writeFile(previewPath, makePcm16Wav(decoded.data, TARGET_SILK_SAMPLE_RATE, 1));
        } else {
            await runTool('ffmpeg', [
                '-v', 'error',
                '-y',
                ...getMediaInputArgs(sourcePath),
                '-vn',
                '-ac', '2',
                '-ar', '48000',
                '-f', 'wav',
                previewPath
            ]);
        }
    }
    return previewPath;
}

async function createLibraryPreviewItem(itemId) {
    const item = await getLibraryItem(itemId);
    if (!item) {
        throw new Error(`Voice library item was not found: ${itemId}`);
    }
    const sourcePath = normalizeStoredPath(item.path);
    const directFormat = getDirectPreviewFormat(sourcePath);
    const previewPath = directFormat
        ? sourcePath
        : await createAudioPreviewFile(sourcePath, item.id);

    return {
        id: item.id,
        title: item.title || path.basename(item.path),
        kind: item.kind || 'ptt',
        duration: Number(item.duration) || 0,
        createdAt: item.createdAt || '',
        previewPath,
        previewFormat: directFormat || 'wav'
    };
}

async function waitForPttSourcePath(ptt, options = {}) {
    const attempts = Math.max(1, Math.min(24, Math.trunc(Number(options.attempts)) || 1));
    const intervalMs = Math.max(50, Math.min(1000, Math.trunc(Number(options.intervalMs)) || 250));
    const expectedSize = Math.max(0, Math.trunc(Number(ptt?.fileSize) || 0));
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        const sourcePath = resolvePttSourcePath(ptt);
        const actualSize = sourcePath
            ? Number(await fs.stat(sourcePath).then(stat => stat.size).catch(() => 0))
            : 0;
        if (sourcePath && actualSize > 0 && (!expectedSize || actualSize >= expectedSize)) {
            return sourcePath;
        }
        if (attempt + 1 < attempts) {
            await new Promise(resolve => setTimeout(resolve, intervalMs));
            pttSourceResolver.invalidate();
        }
    }
    return '';
}

function getSilkDurationSeconds(silkResult) {
    const durationMs = Number(silkResult?.duration) || estimateSilkDurationMs(silkResult?.data || Buffer.alloc(0));
    return Math.max(1, Math.ceil(durationMs / 1000));
}

async function addVoiceDataToLibrary(voiceData, metadata = {}) {
    await ensureLibraryDirs();
    const md5 = getBufferMd5(voiceData);
    const index = await readLibraryIndex();
    const existing = index.items.find(item => item.md5 === md5 && fsSync.existsSync(normalizeStoredPath(item.path)));
    if (existing) {
        return existing;
    }

    const id = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
    const title = safeFileStem(metadata.title || 'voice');
    const targetPath = await makeUniqueLibraryPath(path.join(metadata.targetDir || getLibraryVoiceDir(), `${title}.amr`));
    await fs.writeFile(targetPath, Buffer.from(voiceData));

    const item = {
        id,
        kind: 'ptt',
        title,
        path: targetPath,
        originalName: metadata.originalName || `${title}.amr`,
        sourcePath: metadata.sourcePath || '',
        sourceMd5: metadata.sourceMd5 || '',
        md5,
        duration: Number(metadata.duration) || 0,
        createdAt: new Date().toISOString()
    };
    index.items.unshift(item);
    await writeLibraryIndex(index);
    return item;
}

async function addFileToLibrary(sourcePath, metadata = {}) {
    if (!fsSync.existsSync(sourcePath)) {
        throw new Error(`File does not exist: ${sourcePath}`);
    }
    await ensureLibraryDirs();
    const md5 = await getFileMd5(sourcePath);
    const index = await readLibraryIndex();
    const existing = index.items.find(item => item.md5 === md5 && fsSync.existsSync(normalizeStoredPath(item.path)));
    if (existing) {
        return existing;
    }

    const sourceExt = path.extname(sourcePath).toLowerCase() || '.amr';
    const id = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
    const title = safeFileStem(metadata.title || path.basename(sourcePath, sourceExt));
    const targetDir = metadata.targetDir || getLibraryVoiceDir();
    const targetPath = await makeUniqueLibraryPath(path.join(targetDir, `${title}${sourceExt}`));
    await fs.copyFile(sourcePath, targetPath);

    const item = {
        id,
        kind: metadata.kind || (isSilkFile(sourcePath) ? 'ptt' : 'media'),
        title,
        path: targetPath,
        originalName: metadata.originalName || path.basename(sourcePath),
        sourcePath,
        sourceMd5: metadata.sourceMd5 || '',
        md5,
        duration: Number(metadata.duration) || 0,
        createdAt: new Date().toISOString()
    };
    index.items.unshift(item);
    await writeLibraryIndex(index);
    return item;
}

async function addMediaFileToLibrary(filePath, targetFolder = '', metadata = {}) {
    if (!fsSync.existsSync(filePath)) {
        throw new Error(`File does not exist: ${filePath}`);
    }
    const sourceExt = path.extname(filePath).toLowerCase();
    const title = safeFileStem(metadata.title || path.basename(filePath, sourceExt));
    const sourceMd5 = await getFileMd5(filePath);
    const index = await readLibraryIndex();
    const existing = index.items.find(item =>
        item.sourceMd5 === sourceMd5 &&
        item.kind === 'media' &&
        fsSync.existsSync(normalizeStoredPath(item.path))
    );
    if (existing) {
        return existing;
    }

    const target = await resolveExistingLibraryRelativePath(targetFolder, {
        allowRoot: true,
        kind: 'folder'
    });
    const duration = await detectLibraryDurationSeconds(filePath);
    return await addFileToLibrary(filePath, {
        title,
        originalName: metadata.originalName || path.basename(filePath),
        sourcePath: metadata.sourcePath ?? filePath,
        sourceMd5,
        duration,
        targetDir: target.path,
        kind: 'media'
    });
}

async function addMediaFilesToLibrary(filePaths, targetFolder = '') {
    const items = [];
    for (const filePath of filePaths.filter(filePath => isSupportedMediaPath(filePath) || isSilkFile(filePath))) {
        items.push(await addMediaFileToLibrary(filePath, targetFolder));
    }
    return items;
}

async function resolveLibraryActionItem(index, itemId, context = null) {
    const decoded = decodeLibraryItemId(itemId);
    const indexedItem = (index.items || []).find(entry => entry.id === itemId) || null;
    if (!indexedItem && !decoded) {
        throw new Error(`Voice library item was not found: ${itemId}`);
    }
    const candidatePath = indexedItem?.path || getLibraryAbsolutePath(decoded.relativePath);
    const resolved = await resolveExistingLibraryPath(candidatePath, {
        allowRoot: false,
        context: context || await getLibraryPathContext()
    });
    const isFolder = resolved.stat.isDirectory();
    if (decoded && (decoded.kind === 'folder') !== isFolder) {
        throw new Error('The library item type is invalid.');
    }
    const fileKind = isFolder ? '' : getLibraryFileKind(resolved.path);
    const kind = isFolder ? 'folder' : (indexedItem?.kind || fileKind);
    if (!isFolder && !fileKind && kind !== 'ptt' && kind !== 'media') {
        throw new Error('The library file type is unsupported.');
    }
    const item = indexedItem || {
        id: itemId,
        kind,
        path: resolved.path,
        title: isFolder ? path.basename(resolved.path) : path.basename(resolved.path, path.extname(resolved.path)),
        originalName: path.basename(resolved.path)
    };
    return {
        item,
        indexed: Boolean(indexedItem),
        decoded,
        kind,
        isFolder,
        ...resolved
    };
}

function storedPathMatchesSource(value, sourcePath, sourceIsDirectory) {
    const storedPath = normalizeStoredPath(value);
    if (!storedPath) {
        return false;
    }
    const storedComparable = normalizeComparablePath(storedPath);
    const sourceComparable = normalizeComparablePath(sourcePath);
    if (storedComparable === sourceComparable) {
        return true;
    }
    return sourceIsDirectory && storedComparable.startsWith(normalizeComparablePath(`${sourcePath}${path.sep}`));
}

function relocateStoredPath(value, sourcePath, targetPath, sourceIsDirectory) {
    if (!storedPathMatchesSource(value, sourcePath, sourceIsDirectory)) {
        return value;
    }
    return path.join(targetPath, path.relative(sourcePath, normalizeStoredPath(value)));
}

function removeIndexedItemsAtPath(index, itemId, itemPath, isFolder) {
    const previousLength = (index.items || []).length;
    index.items = (index.items || []).filter(entry =>
        entry.id !== itemId && !storedPathMatchesSource(entry.path, itemPath, isFolder)
    );
    return index.items.length !== previousLength;
}

function rewriteLibraryIndexPaths(index, sourcePath, targetPath, sourceIsDirectory) {
    let changed = false;
    for (const entry of index.items || []) {
        const nextItemPath = relocateStoredPath(entry.path, sourcePath, targetPath, sourceIsDirectory);
        if (nextItemPath !== entry.path) {
            entry.path = nextItemPath;
            changed = true;
        }
        if (entry.sourcePath) {
            const nextSourcePath = relocateStoredPath(entry.sourcePath, sourcePath, targetPath, sourceIsDirectory);
            if (nextSourcePath !== entry.sourcePath) {
                entry.sourcePath = nextSourcePath;
                changed = true;
            }
        }
    }
    return changed;
}

async function rollbackLibraryRename(currentPath, previousPath, originalError, action) {
    try {
        await fs.rename(currentPath, previousPath);
    } catch (rollbackError) {
        recordDiagnostic('error', 'voice.library-rollback-failed', {
            action,
            currentPath,
            previousPath,
            error: rollbackError
        });
        originalError.rollbackError = rollbackError;
    }
}

async function createLibraryDeletionStagePath() {
    await ensureLibraryDirs();
    const libraryPath = path.resolve(getLibraryDir());
    const realLibraryPath = await fs.realpath(libraryPath);
    const trashPath = path.join(libraryPath, '.trash');
    await fs.mkdir(trashPath, { recursive: true });
    const [trashLstat, realTrashPath] = await Promise.all([
        fs.lstat(trashPath),
        fs.realpath(trashPath)
    ]);
    if (trashLstat.isSymbolicLink() || !isSameOrDescendantAbsolutePath(realTrashPath, realLibraryPath)) {
        throw new Error('The voice library trash path is invalid.');
    }
    return path.join(trashPath, crypto.randomUUID());
}

async function deleteLibraryItem(itemId) {
    const index = await readLibraryIndex();
    const decoded = decodeLibraryItemId(itemId);
    const indexedItem = (index.items || []).find(entry => entry.id === itemId) || null;
    if (!indexedItem && !decoded) {
        return false;
    }

    const itemPath = path.resolve(normalizeStoredPath(indexedItem?.path || getLibraryAbsolutePath(decoded.relativePath)));
    if (!fsSync.existsSync(itemPath)) {
        const rootPath = path.resolve(getLibraryVoiceDir());
        const canCleanByPath = normalizeComparablePath(itemPath) !== normalizeComparablePath(rootPath) &&
            isSameOrDescendantAbsolutePath(itemPath, rootPath);
        const isFolder = decoded?.kind === 'folder' || indexedItem?.kind === 'folder';
        const changed = canCleanByPath
            ? removeIndexedItemsAtPath(index, itemId, itemPath, isFolder)
            : removeIndexedItemsAtPath(index, itemId, '', false);
        if (changed) {
            await writeLibraryIndex(index);
        }
        return true;
    }

    const context = await getLibraryPathContext();
    const resolved = await resolveLibraryActionItem(index, itemId, context);
    const stagedPath = await createLibraryDeletionStagePath();
    await fs.rename(resolved.path, stagedPath);
    const changed = removeIndexedItemsAtPath(index, itemId, resolved.path, resolved.isFolder);
    try {
        if (changed) {
            await writeLibraryIndex(index);
        }
    } catch (error) {
        await rollbackLibraryRename(stagedPath, resolved.path, error, 'delete');
        throw error;
    }
    await fs.rm(stagedPath, { recursive: resolved.isFolder, force: true }).catch(error => {
        recordDiagnostic('warn', 'voice.library-trash-cleanup-failed', {
            path: stagedPath,
            error
        });
    });
    return true;
}

async function createLibraryFolder(relativeFolder = '', title = '') {
    const folderName = sanitizeLibraryEntryName(title);
    if (!folderName) {
        throw new Error('The folder name is invalid.');
    }
    const parentFolder = validateLibraryRelativePath(relativeFolder, true);
    const parent = await resolveExistingLibraryRelativePath(parentFolder, {
        allowRoot: true,
        kind: 'folder'
    });
    const folderPath = path.join(parent.path, folderName);
    if (fsSync.existsSync(folderPath)) {
        throw new Error('A folder with the same name already exists.');
    }
    await fs.mkdir(folderPath);
    let created;
    try {
        created = await resolveExistingLibraryPath(folderPath, {
            allowRoot: false,
            context: parent,
            kind: 'folder'
        });
    } catch (error) {
        await fs.rmdir(folderPath).catch(() => {});
        throw error;
    }
    const createdFolder = created.relativePath;
    return {
        id: encodeLibraryItemId('folder', createdFolder),
        kind: 'folder',
        title: folderName,
        path: created.path,
        relativePath: createdFolder,
        parentPath: parentFolder,
        count: 0,
        createdAt: ''
    };
}

async function moveLibraryItem(itemId, targetFolder = '') {
    const index = await readLibraryIndex();
    const context = await getLibraryPathContext();
    const source = await resolveLibraryActionItem(index, itemId, context);
    const normalizedTargetFolder = validateLibraryRelativePath(targetFolder, true);
    const target = await resolveExistingLibraryRelativePath(normalizedTargetFolder, {
        allowRoot: true,
        context,
        kind: 'folder'
    });
    if (source.isFolder && (
        isSameOrDescendantAbsolutePath(target.path, source.path) ||
        isSameOrDescendantAbsolutePath(target.realPath, source.realPath)
    )) {
        throw new Error('A folder cannot be moved into itself.');
    }
    const sourceParentPath = path.dirname(source.path);
    if (normalizeComparablePath(sourceParentPath) === normalizeComparablePath(target.path) ||
        normalizeComparablePath(path.dirname(source.realPath)) === normalizeComparablePath(target.realPath)) {
        return {
            ...source.item,
            relativePath: source.relativePath,
            parentPath: normalizedTargetFolder
        };
    }

    const nextPath = path.join(target.path, path.basename(source.path));
    if (fsSync.existsSync(nextPath)) {
        throw new Error('An item with the same name already exists in the target folder.');
    }
    await fs.rename(source.path, nextPath);
    try {
        let changed = removeIndexedItemsAtPath(index, '', nextPath, source.isFolder);
        changed = rewriteLibraryIndexPaths(index, source.path, nextPath, source.isFolder) || changed;
        const movedItem = {
            ...source.item,
            id: source.isFolder ? encodeLibraryItemId('folder', getLibraryRelativePath(nextPath)) : source.item.id,
            path: nextPath,
            relativePath: getLibraryRelativePath(nextPath),
            parentPath: normalizedTargetFolder
        };
        if (!source.isFolder && !source.indexed && source.kind) {
            movedItem.createdAt = new Date().toISOString();
            movedItem.md5 = await getFileMd5(nextPath);
            index.items.unshift(movedItem);
            changed = true;
        }
        if (changed) {
            await writeLibraryIndex(index);
        }
        return movedItem;
    } catch (error) {
        await rollbackLibraryRename(nextPath, source.path, error, 'move');
        throw error;
    }
}

async function makeUniqueLibraryPath(filePath) {
    const parsed = path.parse(filePath);
    let candidate = filePath;
    let suffix = 2;
    while (fsSync.existsSync(candidate)) {
        candidate = path.join(parsed.dir, `${parsed.name}-${suffix}${parsed.ext}`);
        suffix += 1;
    }
    return candidate;
}

async function renameLibraryItem(itemId, title) {
    const nextTitle = sanitizeLibraryEntryName(title);
    if (!nextTitle) {
        throw new Error('The new name is invalid.');
    }
    const index = await readLibraryIndex();
    const context = await getLibraryPathContext();
    const source = await resolveLibraryActionItem(index, itemId, context);
    const extension = source.isFolder
        ? ''
        : (path.extname(source.path) || path.extname(source.item.originalName || '') || '.dat');
    const preferredPath = path.join(path.dirname(source.path), `${nextTitle}${extension}`);
    let nextPath = source.path;
    let fileSystemRenamed = false;
    const pathsDiffer = path.resolve(preferredPath) !== path.resolve(source.path);
    const isCaseOnlyRename = pathsDiffer &&
        normalizeComparablePath(preferredPath) === normalizeComparablePath(source.path);
    if (pathsDiffer) {
        nextPath = isCaseOnlyRename ? preferredPath : await makeUniqueLibraryPath(preferredPath);
        if (!isSameOrDescendantAbsolutePath(nextPath, context.rootPath) ||
            normalizeComparablePath(path.dirname(nextPath)) !== normalizeComparablePath(path.dirname(source.path))) {
            throw new Error('The new library path is invalid.');
        }
        if (isCaseOnlyRename) {
            const temporaryPath = await makeUniqueLibraryPath(path.join(
                path.dirname(source.path),
                `.qqnt-toolbox-rename-${crypto.randomUUID()}`
            ));
            await fs.rename(source.path, temporaryPath);
            try {
                await fs.rename(temporaryPath, nextPath);
            } catch (error) {
                await rollbackLibraryRename(temporaryPath, source.path, error, 'rename-case');
                throw error;
            }
        } else {
            await fs.rename(source.path, nextPath);
        }
        fileSystemRenamed = true;
    }

    try {
        let changed = false;
        if (fileSystemRenamed) {
            changed = isCaseOnlyRename
                ? false
                : removeIndexedItemsAtPath(index, '', nextPath, source.isFolder);
            changed = rewriteLibraryIndexPaths(index, source.path, nextPath, source.isFolder) || changed;
        }
        const renamedItem = {
            ...source.item,
            id: source.isFolder ? encodeLibraryItemId('folder', getLibraryRelativePath(nextPath)) : source.item.id,
            title: nextTitle,
            path: nextPath,
            relativePath: getLibraryRelativePath(nextPath),
            parentPath: getLibraryParentFolder(getLibraryRelativePath(nextPath))
        };
        if (source.indexed) {
            if (source.item.title !== nextTitle) {
                source.item.title = nextTitle;
                changed = true;
            }
            source.item.path = nextPath;
        } else if (!source.isFolder && source.kind) {
            renamedItem.createdAt = new Date().toISOString();
            renamedItem.md5 = await getFileMd5(nextPath);
            index.items.unshift({
                ...renamedItem,
                relativePath: undefined,
                parentPath: undefined
            });
            changed = true;
        }
        if (changed) {
            await writeLibraryIndex(index);
        }
        return renamedItem;
    } catch (error) {
        if (fileSystemRenamed) {
            await rollbackLibraryRename(nextPath, source.path, error, 'rename');
        }
        throw error;
    }
}

async function getLibraryItem(itemId) {
    return await withLibraryIndexMutation(async () => {
        const index = await readLibraryIndex();
        let resolved;
        try {
            resolved = await resolveLibraryActionItem(index, itemId);
        } catch {
            return null;
        }
        const { itemsByPath } = createLibraryIndexLookup(index);
        return {
            ...resolved.item,
            kind: resolved.kind,
            path: resolved.path,
            relativePath: resolved.relativePath,
            parentPath: getLibraryParentFolder(resolved.relativePath),
            count: resolved.isFolder
                ? await countSupportedLibraryEntries(resolved.path, itemsByPath)
                : 0
        };
    });
}

function resolvePttSourcePath(ptt) {
    return pttSourceResolver.resolve(ptt);
}

async function addPttToLibrary(ptt) {
    const sourcePath = resolvePttSourcePath(ptt);
    if (!sourcePath) {
        throw new Error('The voice file was not found in QQNT cache. Play it once, then try again.');
    }
    const duration = await detectLibraryDurationSeconds(sourcePath) || Number(ptt?.duration) || 0;
    const title = duration > 0 ? `语音 ${Math.ceil(duration)}s` : '语音消息';
    return await addFileToLibrary(sourcePath, {
        title,
        duration,
        originalName: ptt?.fileName || path.basename(sourcePath)
    });
}

function normalizeComparablePath(filePath) {
    return String(filePath || '').replace(/\//g, '\\').toLowerCase();
}

function makeSendAttributeInfos(attrId) {
    const msgAttributeInfos = new Map();
    msgAttributeInfos.set(0, {
        attrType: 0,
        attrId,
        vasMsgInfo: {
            msgNamePlateInfo: {},
            bubbleInfo: {},
            avatarPendantInfo: {},
            vasFont: {},
            iceBreakInfo: {}
        }
    });
    return msgAttributeInfos;
}

async function showMediaOpenDialog(browserWindow) {
    const result = await dialog.showOpenDialog(browserWindow || undefined, {
        title: 'Select audio or video file',
        properties: ['openFile', 'multiSelections', 'dontAddToRecent'],
        filters: [{
            name: 'Audio and Video',
            extensions: MEDIA_FILE_EXTENSIONS
        }, {
            name: 'Audio',
            extensions: AUDIO_FILE_EXTENSIONS
        }, {
            name: 'Video',
            extensions: VIDEO_FILE_EXTENSIONS
        }]
    });
    return result;
}

function isSupportedMediaPath(filePath) {
    return MEDIA_EXTENSION_SET.has(path.extname(filePath).toLowerCase());
}

const windowStates = new WeakMap();
const PTT_FORWARD_TTL_MS = 2 * 60 * 1000;

function getWindowState(browserWindow) {
    let state = windowStates.get(browserWindow);
    if (!state) {
        state = {
            nativeRequestInstalled: false,
            uiLoopRunning: false,
            uiSetupInstalled: false,
            uiStartTimer: null,
            peerUidByUin: new Map()
        };
        windowStates.set(browserWindow, state);
    }
    return state;
}

async function setInjectedStatus(browserWindow, label, options = {}) {
    if (browserWindow.isDestroyed()) {
        return;
    }
    const script = `window.__voiceFileSenderBridge?.setStatus(${JSON.stringify(label)}, ${JSON.stringify(options)});`;
    await browserWindow.webContents.executeJavaScript(script, true).catch(() => {});
}

async function setInjectedLibrary(browserWindow, folder = '', extraPayload = {}) {
    if (browserWindow.isDestroyed()) {
        return;
    }
    const normalizedFolder = validateLibraryRelativePath(folder, true);
    const missingDurationItems = [];
    const [items, folders] = await Promise.all([
        withLibraryIndexMutation(() => getLibraryItems(normalizedFolder, missingDurationItems)),
        getLibraryFolders()
    ]);
    const onlineSources = await listOnlineSources().catch(() => []);
    const payload = {
        folder: normalizedFolder,
        parent: getLibraryParentFolder(normalizedFolder),
        items: toLibraryViewItems(items),
        folders,
        ...extraPayload,
        onlineSources: extraPayload.onlineSources || onlineSources
    };
    const script = `window.__voiceFileSenderBridge?.setLibrary(${JSON.stringify(payload)});`;
    await browserWindow.webContents.executeJavaScript(script, true).catch(() => {});
    queueLibraryDurationRefresh(browserWindow, normalizedFolder, missingDurationItems);
}

async function setInjectedLibraryItemUpdates(browserWindow, payload) {
    if (browserWindow.isDestroyed()) {
        return;
    }
    const script = `window.__voiceFileSenderBridge?.updateLibraryItems?.(${JSON.stringify(payload)});`;
    await browserWindow.webContents.executeJavaScript(script, true).catch(() => {});
}

function getLibraryDurationRefreshItemKey(item) {
    const itemId = String(item?.id || '');
    const comparablePath = normalizeComparablePath(normalizeStoredPath(item?.path));
    return itemId && comparablePath ? `${itemId}\u0000${comparablePath}` : '';
}

async function runLibraryDurationRefresh(folder, refresh) {
    while (refresh.pendingItems.size > 0) {
        const batch = Array.from(refresh.pendingItems.values()).slice(0, LIBRARY_DURATION_BATCH_SIZE);
        for (const item of batch) {
            refresh.pendingItems.delete(getLibraryDurationRefreshItemKey(item));
        }
        const detected = await detectMissingLibraryDurations(batch);
        const updates = await persistLibraryDurationUpdates(detected).catch(() => []);
        if (updates.length === 0) {
            continue;
        }
        const payload = { folder, items: updates };
        const windows = Array.from(refresh.windows).filter(window => !window.isDestroyed());
        await Promise.all(windows.map(window => setInjectedLibraryItemUpdates(window, payload)));
    }
}

function queueLibraryDurationRefresh(browserWindow, folder, items) {
    if (!browserWindow || browserWindow.isDestroyed() || !Array.isArray(items) || items.length === 0) {
        return;
    }
    const normalizedFolder = validateLibraryRelativePath(folder, true);
    let refresh = libraryDurationRefreshes.get(normalizedFolder);
    if (!refresh) {
        refresh = {
            pendingItems: new Map(),
            windows: new Set(),
            task: null
        };
        libraryDurationRefreshes.set(normalizedFolder, refresh);
    }
    refresh.windows.add(browserWindow);
    for (const item of items) {
        const key = getLibraryDurationRefreshItemKey(item);
        if (key) {
            refresh.pendingItems.set(key, item);
        }
    }
    if (refresh.task || refresh.pendingItems.size === 0) {
        return;
    }
    refresh.task = runLibraryDurationRefresh(normalizedFolder, refresh)
        .catch(error => recordDiagnostic('warn', 'voice.library-duration-refresh-failed', {
            folder: normalizedFolder,
            error
        }))
        .finally(() => {
            if (libraryDurationRefreshes.get(normalizedFolder) === refresh) {
                libraryDurationRefreshes.delete(normalizedFolder);
            }
        });
}

async function setInjectedPreview(browserWindow, payload = {}) {
    if (browserWindow.isDestroyed()) {
        return;
    }
    const script = `window.__voiceFileSenderBridge?.playPreview(${JSON.stringify(payload)});`;
    await browserWindow.webContents.executeJavaScript(script, true).catch(() => {});
}

async function getPreviewMediaUrl(previewItem) {
    if (typeof voiceMediaUrlResolver !== 'function') {
        throw new Error('The voice preview media server is unavailable.');
    }
    return await voiceMediaUrlResolver(previewItem.previewPath, {
        format: previewItem.previewFormat || getDirectPreviewFormat(previewItem.previewPath) || 'wav'
    });
}

async function setInjectedCompatiblePttSource(browserWindow, payload = {}) {
    if (browserWindow.isDestroyed()) {
        return;
    }
    const script = `window.__voiceFileSenderBridge?.useCompatiblePttSource?.(${JSON.stringify(payload)});`;
    await browserWindow.webContents.executeJavaScript(script, true).catch(() => {});
}

async function createCompatiblePttPlayback(browserWindow, sourcePath, ptt) {
    const decodeNative = voiceKeepPlayingAcrossChats && isQqNativePttFile(sourcePath);
    const stream = await probeAudioStream(sourcePath).catch(() => ({}));
    const declaredDurationMs = Math.max(0, Number(ptt?.duration) || 0) * 1000;
    const durationMs = Math.max(20, Number(stream.durationMs) || declaredDurationMs || 1000);
    if (typeof voiceMediaUrlResolver !== 'function') {
        throw new Error('The original voice media server is unavailable.');
    }
    const previewPath = decodeNative
        ? await createAudioPreviewFile(sourcePath, `persistent-ptt|${ptt?.md5HexStr || sourcePath}`)
        : sourcePath;
    const [previewUrl, silentSilk] = await Promise.all([
        voiceMediaUrlResolver(previewPath, {
            format: decodeNative ? 'wav' : detectMediaInputFormat(sourcePath)
        }),
        createSilentSilk(durationMs)
    ]);
    const silkPath = await makeTempSilkPath();
    await fs.writeFile(silkPath, silentSilk.data);
    try {
        const nativeElement = await createPttElement(
            browserWindow,
            silkPath,
            durationMs / 1000,
            Array.isArray(ptt?.waveAmplitudes) && ptt.waveAmplitudes.length
                ? ptt.waveAmplitudes
                : DEFAULT_RAW_WAVE_AMPLITUDES
        );
        return {
            pttElement: nativeElement.pttElement,
            previewUrl,
            durationMs
        };
    } finally {
        await fs.unlink(silkPath).catch(() => {});
    }
}

function normalizePeerText(value) {
    const text = String(value ?? '').trim();
    return text && text !== 'undefined' && text !== 'null' && text !== '0' ? text : '';
}

function rememberNativePeerAliases(browserWindow, aliases) {
    const state = getWindowState(browserWindow);
    for (const alias of Array.isArray(aliases) ? aliases : []) {
        state.peerUidByUin.set(alias.peerUin, alias.peerUid);
    }
}

function findForwardRequestPayload(value, sourceMsgId, depth = 0, seen = new WeakSet()) {
    if (!value || depth > 8 || typeof value !== 'object' || value instanceof Uint8Array || value instanceof Map) {
        return null;
    }
    if (seen.has(value)) {
        return null;
    }
    seen.add(value);
    if (Array.isArray(value)) {
        for (const item of value) {
            const found = findForwardRequestPayload(item, sourceMsgId, depth + 1, seen);
            if (found) {
                return found;
            }
        }
        return null;
    }
    if (Array.isArray(value.msgIds) && value.msgIds.some(msgId => String(msgId) === sourceMsgId)) {
        return value;
    }
    for (const item of Object.values(value)) {
        const found = findForwardRequestPayload(item, sourceMsgId, depth + 1, seen);
        if (found) {
            return found;
        }
    }
    return null;
}

function replyToBlockedNativeRequest(event, request, result = { result: 0 }) {
    const sender = event?.sender;
    if (!sender || sender.isDestroyed?.() || !request?.callbackId) {
        return;
    }
    const peerId = Number(request.peerId) || sender.id;
    setImmediate(() => {
        if (!sender.isDestroyed?.()) {
            sender.send(`RM_IPCFROM_MAIN${peerId}`, {
                callbackId: request.callbackId,
                promiseStatue: 'full',
                promiseStatus: 'full',
                type: 'response',
                eventName: request.eventName,
                peerId
            }, result);
        }
    });
}

function handleVoiceNativeRequest(browserWindow, channel, args) {
    const state = getWindowState(browserWindow);
    const pending = state.pendingNativePttForward;
    if (!pending) {
        return false;
    }
    if (pending.expiresAt < Date.now()) {
        state.pendingNativePttForward = null;
        return false;
    }
    const command = args.find(value => value?.cmdName && value?.payload !== undefined);
    if (!command || !/forward/i.test(String(command.cmdName || ''))) {
        return false;
    }
    const payload = findForwardRequestPayload(command.payload, pending.sourceMsgId);
    if (!payload) {
        return false;
    }
    const peers = normalizeForwardTargets(payload.dstContacts);
    state.pendingNativePttForward = null;
    replyToBlockedNativeRequest(args[0], args.find(value => value?.callbackId), { result: 0 });
    if (!peers.length) {
        recordDiagnostic('warn', 'voice.forward-failed', { reason: 'target-unavailable' });
        setInjectedStatus(browserWindow, '\u8f6c\u53d1\u76ee\u6807\u8bfb\u53d6\u5931\u8d25', {
            disabled: false,
            error: true,
            resetAfterMs: 2200
        }).catch(() => {});
        return true;
    }
    recordDiagnostic('info', 'voice.forward-requested', { targetCount: peers.length });
    Promise.resolve().then(async () => {
        for (const peer of peers) {
            await sendPttInfoAsPtt(browserWindow, peer, pending.ptt);
        }
        recordDiagnostic('info', 'voice.forward-completed', { targetCount: peers.length });
    }).catch(error => {
        recordDiagnostic('error', 'voice.forward-failed', {
            targetCount: peers.length,
            error
        });
        return setInjectedStatus(browserWindow, error?.message || String(error), {
            disabled: false,
            error: true,
            resetAfterMs: 2600
        });
    });
    return true;
}

function prepareNativePttForward(browserWindow, ptt, sourceMsgId) {
    if (!voiceForwardInContextMenuEnabled) {
        return;
    }
    ptt = sanitizePttInfo(ptt);
    sourceMsgId = normalizePeerText(sourceMsgId);
    if (!ptt || !sourceMsgId) {
        throw new Error('\u65e0\u6cd5\u8bfb\u53d6\u5f85\u8f6c\u53d1\u7684\u8bed\u97f3\u6d88\u606f\u3002');
    }
    getWindowState(browserWindow).pendingNativePttForward = {
        expiresAt: Date.now() + PTT_FORWARD_TTL_MS,
        ptt,
        sourceMsgId
    };
}

function normalizeForwardTargets(dstContacts) {
    const seen = new Set();
    return (Array.isArray(dstContacts) ? dstContacts : [])
        .map(contact => ({
            chatType: Number(contact?.chatType) || 0,
            peerUid: normalizePeerText(contact?.peerUid),
            peerUin: normalizePeerText(contact?.peerUin),
            guildId: normalizePeerText(contact?.guildId)
        }))
        .filter(peer => {
            const key = `${peer.chatType}:${peer.peerUid}`;
            if (![1, 2, 100].includes(peer.chatType) || !peer.peerUid || seen.has(key)) {
                return false;
            }
            seen.add(key);
            return true;
        });
}

async function generateMsgUniqueId(browserWindow, chatType) {
    const serverTimeResult = await qqNativeInvoke(browserWindow, 'ntApi', 'nodeIKernelMSFService/getServerTime', [], true);
    const serverTime = unwrapNativeValue(serverTimeResult);
    const uniqueIdResult = await qqNativeInvoke(
        browserWindow,
        'ntApi',
        'nodeIKernelMsgService/generateMsgUniqueId',
        [chatType, serverTime],
        true
    );
    const uniqueId = unwrapNativeValue(uniqueIdResult);
    if (uniqueId === undefined || uniqueId === null || typeof uniqueId === 'object') {
        throw new Error(`QQNT returned an invalid unique id: ${safeJson(uniqueIdResult)}`);
    }
    return uniqueId;
}

async function createNativePttCacheFile(silkPath) {
    const [md5, stat, oriDir] = await Promise.all([
        getFileMd5(silkPath),
        fs.stat(silkPath),
        getNativePttOriDir()
    ]);
    const fileName = `${md5}.amr`;
    const filePath = path.join(oriDir, fileName);
    let destinationSize = -1;
    try {
        destinationSize = (await fs.stat(filePath)).size;
    } catch {
    }
    if (normalizeComparablePath(silkPath) !== normalizeComparablePath(filePath) && destinationSize !== stat.size) {
        await fs.copyFile(silkPath, filePath);
    }
    pttSourceResolver.remember(filePath);
    const result = {
        fileName,
        filePath,
        md5HexStr: md5,
        fileSize: String(stat.size)
    };
    return result;
}

async function createNativeRawPttCacheFile(browserWindow, sourcePath, preferredFileName = '') {
    const [md5, stat] = await Promise.all([
        getFileMd5(sourcePath),
        fs.stat(sourcePath)
    ]);
    // QQ's raw PTT path identifies the payload by its hash. The original
    // extension is retained in the cached bytes and does not belong in the
    // canonical pttElement fileName (matching QQ/Euphony's native shape).
    const fileName = md5;
    const pathInfo = {
        md5HexStr: md5,
        fileName,
        elementType: 2,
        elementSubType: 0,
        thumbSize: 0,
        needCreate: true,
        downloadType: 1,
        file_uuid: ''
    };
    const attempts = [
        { path_info: pathInfo },
        pathInfo
    ];
    let cachePath = '';
    let lastResult;
    for (const payload of attempts) {
        let result;
        try {
            result = await qqNativeInvoke(
                browserWindow,
                'ntApi',
                'nodeIKernelMsgService/getRichMediaFilePathForGuild',
                [payload],
                true,
                15000
            );
        } catch (error) {
            lastResult = { error: error?.message || String(error) };
            continue;
        }
        lastResult = result;
        if (isNativeFailure(result)) {
            continue;
        }
        const value = unwrapNativeValue(result);
        const directPath = typeof value === 'string'
            ? value
            : (typeof result === 'string' ? result : '');
        cachePath = normalizeStoredPath(directPath || findNativePath(value) || findNativePath(result));
        if (cachePath) {
            break;
        }
    }
    if (!cachePath) {
        throw new Error(`QQ did not provide a raw voice cache path: ${safeJson(lastResult)}`);
    }
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    if (normalizeComparablePath(sourcePath) !== normalizeComparablePath(cachePath)) {
        await fs.copyFile(sourcePath, cachePath);
    }
    return {
        fileName,
        filePath: cachePath,
        md5HexStr: md5,
        fileSize: String(stat.size),
        sourcePath
    };
}

async function createPttElement(browserWindow, sourcePath, durationSeconds, waveAmplitudes, options = {}) {
    const fileInfo = options.raw
        ? await createNativeRawPttCacheFile(browserWindow, sourcePath, options.fileName)
        : await createNativePttCacheFile(sourcePath);
    const actualDuration = Math.max(1, Math.ceil(Number(durationSeconds) || 1));
    return {
        elementType: 4,
        elementId: '',
        pttElement: {
            fileName: fileInfo.fileName,
            filePath: fileInfo.filePath,
            md5HexStr: fileInfo.md5HexStr,
            fileSize: fileInfo.fileSize,
            duration: fakeVoiceDurationSeconds || actualDuration,
            formatType: Number(options.formatType) || 1,
            voiceType: 1,
            voiceChangeType: 0,
            canConvert2Text: true,
            waveAmplitudes,
            fileUuid: '',
            fileSubId: '',
            playState: 1,
            autoConvertText: 0,
            storeID: 0,
            otherBusinessInfo: {
                aiVoiceType: 0
            }
        }
    };
}

async function sendPttElement(browserWindow, peer, pttElement, msgAttributeInfos) {
    const sendAttempts = [
        {
            name: 'array',
            payload: [
                '0',
                peer,
                [pttElement],
                msgAttributeInfos
            ]
        },
        {
            name: 'object',
            payload: [{
                msgId: '0',
                peer,
                msgElements: [pttElement],
                msgAttributeInfos
            }, null]
        }
    ];
    let lastResult;
    for (const attempt of sendAttempts) {
        const result = await qqNativeInvoke(
            browserWindow,
            'ntApi',
            'nodeIKernelMsgService/sendMsg',
            attempt.payload,
            true,
            15000
        );
        lastResult = result;
        if (!isNativeFailure(result)) {
            return {
                shape: attempt.name,
                result
            };
        }
    }
    throw new Error(`QQNT rejected sendMsg: ${safeJson(lastResult)}`);
}

function normalizeSendPeer(browserWindow, peer) {
    const chatType = Number(peer?.chatType) || 0;
    let peerUid = normalizePeerText(peer?.peerUid);
    const peerUin = normalizePeerText(peer?.peerUin);
    if (!chatType) {
        throw new Error('未找到当前聊天类型。');
    }
    if ((chatType === 1 || chatType === 100) && !peerUid.startsWith('u_')) {
        const mappedUid = getWindowState(browserWindow).peerUidByUin.get(peerUid) ||
            getWindowState(browserWindow).peerUidByUin.get(peerUin);
        if (mappedUid) {
            peerUid = mappedUid;
        }
    }
    if (!peerUid) {
        throw new Error('未找到当前聊天对象。');
    }
    if ((chatType === 1 || chatType === 100) && !peerUid.startsWith('u_')) {
        throw new Error('未取到私聊 NT UID，请切换一次会话或等待消息加载后重试。');
    }
    return {
        chatType,
        peerUid,
        guildId: normalizePeerText(peer?.guildId)
    };
}

async function prepareOriginalMediaPath(mediaPath) {
    if (isSilkFile(mediaPath)) {
        const data = await fs.readFile(mediaPath);
        return {
            path: mediaPath,
            durationMs: estimateSilkDurationMs(data),
            fileName: path.basename(mediaPath),
            temporary: false
        };
    }
    if (isVideoMediaPath(mediaPath)) {
        const extracted = await extractAudioTrackWithoutReencoding(mediaPath, {
            outputDir: getPluginTempDir()
        });
        return {
            ...extracted,
            fileName: `${path.basename(mediaPath, path.extname(mediaPath))}${extracted.extension}`,
            temporary: true
        };
    }
    const stream = await probeAudioStream(mediaPath);
    return {
        path: mediaPath,
        durationMs: stream.durationMs,
        fileName: path.basename(mediaPath),
        temporary: false
    };
}

async function sendOriginalMediaPathAsPtt(browserWindow, peer, mediaPath, options = {}) {
    const prepared = await prepareOriginalMediaPath(mediaPath);
    try {
        const durationSeconds = Number(options.durationMs) > 0
            ? Number(options.durationMs) / 1000
            : Number(prepared.durationMs) / 1000;
        const pttElement = await createPttElement(
            browserWindow,
            prepared.path,
            durationSeconds,
            DEFAULT_RAW_WAVE_AMPLITUDES,
            {
                raw: true,
                fileName: prepared.fileName
            }
        );
        const attrId = await generateMsgUniqueId(browserWindow, peer.chatType);
        return await sendPttElement(
            browserWindow,
            peer,
            pttElement,
            makeSendAttributeInfos(attrId)
        );
    } finally {
        if (prepared.temporary) {
            await fs.unlink(prepared.path).catch(() => {});
        }
    }
}

async function sendMediaPathAsPtt(browserWindow, peer, mediaPath, options = {}) {
    peer = normalizeSendPeer(browserWindow, peer);
    if (!isSupportedMediaPath(mediaPath) && !isSilkFile(mediaPath)) {
        throw new Error(`Unsupported audio or video file: ${mediaPath}`);
    }
    const sendMode = normalizeVoiceSendMode(options.sendMode);
    if (sendMode === 'original') {
        return await sendOriginalMediaPathAsPtt(browserWindow, peer, mediaPath, options);
    }
    const silkResult = await encodeMediaFileToSilk(mediaPath, options);
    const silkPath = await makeTempSilkPath();
    await fs.writeFile(silkPath, silkResult.data);
    try {
        const pttElement = await createPttElement(
            browserWindow,
            silkPath,
            silkResult.duration / 1000,
            silkResult.waveAmplitudes
        );
        const attrId = await generateMsgUniqueId(browserWindow, peer.chatType);
        const msgAttributeInfos = makeSendAttributeInfos(attrId);
        return await sendPttElement(browserWindow, peer, pttElement, msgAttributeInfos);
    } finally {
        await fs.unlink(silkPath).catch(() => {});
    }
}

async function sendSilkPathAsPtt(browserWindow, peer, silkPath, durationSeconds = 0, waveAmplitudes = []) {
    if (!silkPath || !fsSync.existsSync(silkPath)) {
        throw new Error(`Voice file was not found: ${silkPath}`);
    }
    if (isSilkFile(silkPath) && Array.isArray(waveAmplitudes) && waveAmplitudes.length) {
        peer = normalizeSendPeer(browserWindow, peer);
        const pttElement = await createPttElement(browserWindow, silkPath, durationSeconds, waveAmplitudes);
        const attrId = await generateMsgUniqueId(browserWindow, peer.chatType);
        return await sendPttElement(
            browserWindow,
            peer,
            pttElement,
            makeSendAttributeInfos(attrId)
        );
    }
    return await sendMediaPathAsPtt(browserWindow, peer, silkPath, {
        durationMs: Number(durationSeconds) > 0 ? Number(durationSeconds) * 1000 : undefined
    });
}

async function waitForInjectedAction(browserWindow) {
    const source = `window.__voiceFileSenderEnabled = ${JSON.stringify(voiceFeatureEnabled)};` +
        `window.__voiceFileSenderKeepPlayingAcrossChats = ${JSON.stringify(voiceKeepPlayingAcrossChats)};` +
        `window.__voiceFileSenderSaveInContextMenuEnabled = ${JSON.stringify(voiceSaveInContextMenuEnabled)};` +
        `window.__voiceFileSenderForwardInContextMenuEnabled = ${JSON.stringify(voiceForwardInContextMenuEnabled)};` +
        `(${injectedVoiceFileSenderUi.toString()})((${createVoiceLibraryPanel.toString()}), ${JSON.stringify(VOICE_LIBRARY_PANEL_CSS)})`;
    return await browserWindow.webContents.executeJavaScript(source, true);
}

async function sendLibraryItemAsPtt(browserWindow, peer, itemId, options = {}) {
    let item = await getLibraryItem(itemId);
    if (!item) {
        throw new Error(`Voice library item was not found: ${itemId}`);
    }
    if (item.kind === 'ptt') {
        if (options.sendMode === 'original' && item.sourcePath &&
            fsSync.existsSync(normalizeStoredPath(item.sourcePath)) &&
            isSupportedMediaPath(item.sourcePath)) {
            return await sendMediaPathAsPtt(browserWindow, peer, item.sourcePath, {
                sendMode: 'original',
                durationMs: Number(item.duration) > 0 ? Number(item.duration) * 1000 : undefined
            });
        }
        return await sendSilkPathAsPtt(browserWindow, peer, item.path, Number(item.duration) || 0);
    }
    return await sendMediaPathAsPtt(browserWindow, peer, item.path, {
        durationMs: Number(item.duration) > 0 ? Number(item.duration) * 1000 : undefined,
        sendMode: options.sendMode
    });
}

async function sendPttInfoAsPtt(browserWindow, peer, ptt) {
    const sourcePath = resolvePttSourcePath(ptt);
    if (!sourcePath) {
        throw new Error('The voice file was not found in QQNT cache. Play it once, then try again.');
    }
    return await sendSilkPathAsPtt(
        browserWindow,
        peer,
        sourcePath,
        Number(ptt?.duration) || 0,
        ptt?.waveAmplitudes
    );
}

async function refreshInjectedLibrary(browserWindow, message = '', folder = '', extraPayload = {}) {
    await setInjectedLibrary(browserWindow, folder, extraPayload);
    await setInjectedStatus(browserWindow, message, {
        disabled: false,
        resetAfterMs: message ? 1800 : undefined
    });
}

async function handleInjectedAction(browserWindow, action) {
    if (!voiceFeatureEnabled) {
        return;
    }
    if (!action?.type) {
        return;
    }
    if (action.type === 'playCompatiblePtt') {
        const ptt = sanitizePttInfo(action.ptt);
        const id = String(action.id || '');
        if (!id || !ptt) {
            return;
        }
        try {
            let sourcePath = resolvePttSourcePath(ptt);
            if (!sourcePath) {
                pttSourceResolver.invalidate();
                sourcePath = resolvePttSourcePath(ptt);
            }
            const expectedSize = Math.max(0, Math.trunc(Number(ptt.fileSize) || 0));
            const actualSize = sourcePath
                ? Number(await fs.stat(sourcePath).then(stat => stat.size).catch(() => 0))
                : 0;
            if (!sourcePath || !actualSize || (expectedSize && actualSize < expectedSize)) {
                await setInjectedCompatiblePttSource(browserWindow, { id, native: true });
                return;
            }
            if (isQqNativePttFile(sourcePath) && !voiceKeepPlayingAcrossChats) {
                await setInjectedCompatiblePttSource(browserWindow, { id, native: true });
                return;
            }
            const playback = await createCompatiblePttPlayback(browserWindow, sourcePath, ptt);
            await setInjectedCompatiblePttSource(browserWindow, { id, ...playback });
        } catch (error) {
            await setInjectedCompatiblePttSource(browserWindow, { id, error: true });
            throw error;
        }
        return;
    }
    if (action.type === 'list') {
        await refreshInjectedLibrary(browserWindow, '', action.folder || '');
        return;
    }
    if (action.type === 'savePtt') {
        if (!voiceSaveInContextMenuEnabled) {
            return;
        }
        await withLibraryIndexMutation(() => addPttToLibrary(action.ptt));
        await refreshInjectedLibrary(browserWindow, '已保存', action.folder || '');
        return;
    }
    if (action.type === 'prepareNativePttForward') {
        if (!voiceForwardInContextMenuEnabled) {
            return;
        }
        prepareNativePttForward(browserWindow, action.ptt, action.sourceMsgId);
        return;
    }
    if (action.type === 'pickSave') {
        const result = await showMediaOpenDialog(browserWindow);
        if (result.canceled) {
            await setInjectedStatus(browserWindow, '', { disabled: false });
            return;
        }
        const savedItems = await withLibraryIndexMutation(() => addMediaFilesToLibrary(result.filePaths || [], action.folder || ''));
        await refreshInjectedLibrary(browserWindow, savedItems.length ? '已添加' : '无音视频', action.folder || '');
        return;
    }
    if (action.type === 'listOnlineSources') {
        await refreshInjectedLibrary(browserWindow, '', action.folder || '', {
            onlineSources: await listOnlineSources()
        });
        return;
    }
    if (action.type === 'importOnlineSource') {
        const imported = await importOnlineSource(action.input || action.url || action.path, {
            id: action.id
        });
        await refreshInjectedLibrary(browserWindow, `已导入音源：${imported.name}`, action.folder || '', {
            onlineSources: await listOnlineSources()
        });
        return;
    }
    if (action.type === 'searchOnlineSource') {
        const requestId = String(action.requestId || '');
        const result = await searchOnlineSource({
            sourceId: action.sourceId,
            providerId: action.providerId,
            keyword: action.keyword,
            recommend: action.recommend === true,
            page: action.page,
            limit: action.limit
        });
        await setInjectedLibrary(browserWindow, action.folder || '', {
            onlineSearchResults: result.results,
            onlineSearchContext: {
                requestId,
                sourceId: result.sourceId,
                providerId: result.providerId,
                keyword: result.keyword,
                page: result.page,
                hasMore: result.hasMore,
                quality: action.quality || '320k',
                action: action.resultAction === 'save' ? 'save' : 'send'
            }
        });
        await setInjectedStatus(browserWindow,
            result.results.length ? '' : '\u672a\u627e\u5230\u5339\u914d\u7684\u6b4c\u66f2',
            { disabled: false, resetAfterMs: result.results.length ? undefined : 1800 });
        return;
    }
    if (action.type === 'searchOnlineSources') {
        const requestId = String(action.requestId || '');
        const targets = Array.isArray(action.targets) ? action.targets : [];
        const result = await searchOnlineSources({
            targets,
            keyword: action.keyword,
            recommend: action.recommend === true,
            page: action.page,
            limit: action.limit,
            quality: action.quality
        });
        await setInjectedLibrary(browserWindow, action.folder || '', {
            onlineSearchResults: result.results,
            onlineSearchContext: {
                requestId,
                targets: targets.map(target => ({
                    sourceId: String(target?.sourceId || ''),
                    providerId: String(target?.providerId || '')
                })),
                keyword: String(action.keyword || ''),
                recommend: action.recommend === true,
                quality: action.quality || '320k'
            }
        });
        const emptyMessage = result.failures.length
            ? '\u90e8\u5206\u97f3\u6e90\u641c\u7d22\u5931\u8d25'
            : '\u672a\u627e\u5230\u5339\u914d\u7684\u6b4c\u66f2';
        await setInjectedStatus(browserWindow,
            result.results.length ? '' : emptyMessage,
            { disabled: false, resetAfterMs: result.results.length ? undefined : 1800 });
        return;
    }
    if (action.type === 'browseOnlineCatalog') {
        const requestId = String(action.requestId || '');
        const targets = Array.isArray(action.targets) ? action.targets : [];
        const result = await browseOnlineCatalog({
            targets,
            mode: action.mode,
            sort: action.sort,
            collection: action.collection,
            page: action.page,
            limit: action.limit
        });
        await setInjectedLibrary(browserWindow, action.folder || '', {
            onlineBrowseItems: result.items,
            onlineBrowseContext: {
                requestId,
                mode: result.mode,
                sort: result.sort,
                targets,
                collection: action.collection || null,
                info: result.info || {},
                failures: result.failures
            }
        });
        const emptyMessage = result.failures.length
            ? '\u90e8\u5206\u5728\u7ebf\u5185\u5bb9\u52a0\u8f7d\u5931\u8d25'
            : '\u6682\u65e0\u53ef\u7528\u5185\u5bb9';
        await setInjectedStatus(browserWindow,
            result.items.length ? '' : emptyMessage,
            { disabled: false, resetAfterMs: result.items.length ? undefined : 1800 });
        return;
    }
    if (action.type === 'previewOnlineAudio') {
        const previewItem = await createOnlineAudioPreview({
            id: action.id,
            sourceId: action.sourceId,
            providerId: action.providerId,
            quality: action.quality,
            songInfo: action.songInfo,
            title: action.title
        });
        await setInjectedPreview(browserWindow, {
            id: previewItem.id,
            previewUrl: await getPreviewMediaUrl(previewItem),
            previewTitle: previewItem.title
        });
        await setInjectedStatus(browserWindow, '已加载播放', {
            disabled: false,
            resetAfterMs: 1200
        });
        return;
    }
    if (action.type === 'downloadOnlineAudio' || action.type === 'sendOnlineAudio') {
        const cached = await downloadOnlineSourceAudio({
            url: action.url,
            sourceId: action.sourceId,
            providerId: action.providerId,
            quality: action.quality,
            songInfo: action.songInfo,
            title: action.title || action.fileName
        });
        try {
            if (action.type === 'sendOnlineAudio') {
                if (!action.peer) {
                    throw new Error('未找到当前聊天对象。');
                }
                await sendMediaPathAsPtt(browserWindow, action.peer, cached.path, {
                    sendMode: normalizeVoiceSendMode(action.sendMode),
                    durationMs: Number(cached.duration) > 0 ? Number(cached.duration) * 1000 : undefined
                });
                await setInjectedStatus(browserWindow, '\u5df2\u53d1\u9001\u5728\u7ebf\u97f3\u9891', {
                    resetAfterMs: 1800
                });
            } else {
                const item = await withLibraryIndexMutation(() => addMediaFileToLibrary(cached.path, action.folder || '', {
                    title: cached.title,
                    sourcePath: '',
                    originalName: cached.fileName
                }));
                await refreshInjectedLibrary(browserWindow, '已保存在线音频', action.folder || '', {
                    selectedItem: toLibraryViewItems([item])[0]
                });
            }
        } finally {
            if (cached.temporary) {
                await fs.unlink(cached.path).catch(() => {});
            }
        }
        return;
    }
    if (action.type === 'deleteLibrary') {
        await withLibraryIndexMutation(() => deleteLibraryItem(action.id));
        await refreshInjectedLibrary(browserWindow, '已删除', action.folder || '');
        return;
    }
    if (action.type === 'createLibraryFolder') {
        await withLibraryIndexMutation(() => createLibraryFolder(action.folder || '', action.title));
        await refreshInjectedLibrary(browserWindow, '已新建文件夹', action.folder || '');
        return;
    }
    if (action.type === 'moveLibrary') {
        await withLibraryIndexMutation(() => moveLibraryItem(action.id, action.targetFolder || ''));
        const selectedItem = action.selectedItemId
            ? await getLibraryItem(action.selectedItemId)
            : null;
        await refreshInjectedLibrary(browserWindow, '已移动', action.folder || '', {
            selectedItem: selectedItem ? toLibraryViewItems([selectedItem])[0] : null
        });
        return;
    }
    if (action.type === 'renameLibrary') {
        await withLibraryIndexMutation(() => renameLibraryItem(action.id, action.title));
        const selectedItem = action.selectedItemId
            ? await getLibraryItem(action.selectedItemId)
            : null;
        await refreshInjectedLibrary(browserWindow, '已重命名', action.folder || '', {
            selectedItem: selectedItem ? toLibraryViewItems([selectedItem])[0] : null
        });
        return;
    }
    if (action.type === 'previewLibrary') {
        const previewItem = await createLibraryPreviewItem(action.id);
        await setInjectedPreview(browserWindow, {
            id: previewItem.id,
            previewUrl: await getPreviewMediaUrl(previewItem),
            previewTitle: previewItem.title || '语音'
        });
        await setInjectedStatus(browserWindow, '已加载播放', {
            disabled: false,
            resetAfterMs: 1200
        });
        return;
    }
    if (action.type === 'sendLibrary') {
        if (!action.peer) {
            throw new Error('No active chat peer was found.');
        }
        await sendLibraryItemAsPtt(browserWindow, action.peer, action.id, {
            sendMode: normalizeVoiceSendMode(action.sendMode)
        });
        await setInjectedStatus(browserWindow, '\u5df2\u53d1\u9001', {
            resetAfterMs: 1800
        });
        return;
    }
    if (action.type === 'sendPtt') {
        if (!action.peer) {
            throw new Error('No active chat peer was found.');
        }
        await sendPttInfoAsPtt(browserWindow, action.peer, action.ptt);
        await setInjectedStatus(browserWindow, '\u5df2\u53d1\u9001', {
            resetAfterMs: 1800
        });
        return;
    }

    let filePaths = [];
    if (action.type === 'drop') {
        filePaths = action.paths || [];
    } else if (action.type === 'pick') {
        const result = await showMediaOpenDialog(browserWindow);
        if (result.canceled) {
            await setInjectedStatus(browserWindow, '', { disabled: false });
            return;
        }
        filePaths = result.filePaths || [];
    } else {
        return;
    }

    filePaths = filePaths.filter(isSupportedMediaPath);
    if (filePaths.length === 0) {
        await setInjectedStatus(browserWindow, '无音视频', {
            disabled: false,
            resetAfterMs: 1600
        });
        return;
    }
    if (!action.peer) {
        throw new Error('No active chat peer was found.');
    }
    await setInjectedStatus(browserWindow, '\u53d1\u9001\u4e2d', { disabled: false });
    for (const filePath of filePaths) {
        await sendMediaPathAsPtt(browserWindow, action.peer, filePath, {
            sendMode: normalizeVoiceSendMode(action.sendMode)
        });
    }
    await setInjectedStatus(browserWindow, '\u5df2\u53d1\u9001', {
        resetAfterMs: 1800
    });
}

async function runInjectedUiLoop(browserWindow) {
    const state = getWindowState(browserWindow);
    if (!voiceFeatureEnabled || state.uiLoopRunning || !isVoiceUiHost(browserWindow)) {
        return;
    }
    state.uiLoopRunning = true;
    try {
        while (voiceFeatureEnabled && isVoiceUiHost(browserWindow)) {
            let action = null;
            try {
                action = await waitForInjectedAction(browserWindow);
                if (shouldRecordVoiceAction(action)) {
                    recordDiagnostic('info', 'voice.action-requested', getVoiceActionSummary(action));
                }
                await handleInjectedAction(browserWindow, action);
                if (shouldRecordVoiceAction(action)) {
                    recordDiagnostic('info', 'voice.action-completed', getVoiceActionSummary(action));
                }
            } catch (error) {
                recordDiagnostic('error', 'voice.action-failed', {
                    ...getVoiceActionSummary(action),
                    error
                });
                if (isVoiceUiHost(browserWindow)) {
                    await setInjectedStatus(browserWindow, error?.message || String(error), {
                        disabled: false,
                        error: true,
                        resetAfterMs: 2600
                    });
                    await new Promise(resolve => setTimeout(resolve, 1200));
                }
            }
        }
    } finally {
        state.uiLoopRunning = false;
    }
}

function isVoiceUiHostUrl(url) {
    const value = String(url || '');
    return VOICE_UI_ROUTE_MARKERS.some(route => value.includes(route));
}

function isVoiceUiHost(browserWindow, candidateUrl = '') {
    if (!browserWindow || browserWindow.isDestroyed() || browserWindow.webContents.isDestroyed?.()) {
        return false;
    }
    let url = String(candidateUrl || '');
    if (!url) {
        try {
            url = browserWindow.webContents.getURL();
        } catch {
            return false;
        }
    }
    return isVoiceUiHostUrl(url);
}

function scheduleInjectedUi(browserWindow, candidateUrl = '', delayMs = 300) {
    if (!voiceFeatureEnabled || !isVoiceUiHost(browserWindow, candidateUrl)) {
        return;
    }
    const state = getWindowState(browserWindow);
    if (!state.nativeRequestInstalled) {
        state.nativeRequestInstalled = true;
        addNativeRequestHandler(browserWindow, handleVoiceNativeRequest);
    }
    if (state.uiLoopRunning || state.uiStartTimer) {
        return;
    }
    state.uiStartTimer = setTimeout(() => {
        state.uiStartTimer = null;
        if (!voiceFeatureEnabled || !isVoiceUiHost(browserWindow)) {
            return;
        }
        runInjectedUiLoop(browserWindow).catch(() => {});
    }, delayMs);
    state.uiStartTimer.unref?.();
}

function setupBrowserWindow(browserWindow) {
    if (!voiceFeatureEnabled || !browserWindow || browserWindow.isDestroyed()) {
        return;
    }
    const state = getWindowState(browserWindow);
    if (!state.uiSetupInstalled) {
        state.uiSetupInstalled = true;
        const scheduleCurrentRoute = () => scheduleInjectedUi(browserWindow);
        const scheduleNavigatedRoute = (_event, url, isMainFrame) => {
            if (isMainFrame !== false) {
                scheduleInjectedUi(browserWindow, url);
            }
        };
        browserWindow.webContents.on('dom-ready', scheduleCurrentRoute);
        browserWindow.webContents.on('did-finish-load', scheduleCurrentRoute);
        browserWindow.webContents.on('did-navigate-in-page', scheduleNavigatedRoute);
        browserWindow.once('closed', () => {
            clearTimeout(state.uiStartTimer);
            state.uiStartTimer = null;
        });
    }
    scheduleInjectedUi(browserWindow);
}

function onBrowserWindowCreated(browserWindow) {
    setupBrowserWindow(browserWindow);
}

function setupAllWindows() {
    for (const browserWindow of BrowserWindow.getAllWindows()) {
        setupBrowserWindow(browserWindow);
    }
}

async function setInjectedEnabled(browserWindow, enabled) {
    if (!isVoiceUiHost(browserWindow)) {
        return;
    }
    const source = `window.__voiceFileSenderEnabled = ${JSON.stringify(enabled)}; window.__voiceFileSenderBridge?.setEnabled?.(${JSON.stringify(enabled)});`;
    await browserWindow.webContents.executeJavaScript(source, true).catch(() => {});
}

async function setInjectedKeepPlayingAcrossChats(browserWindow, enabled) {
    if (!isVoiceUiHost(browserWindow)) {
        return;
    }
    const source = `window.__voiceFileSenderKeepPlayingAcrossChats = ${JSON.stringify(enabled)}; window.__voiceFileSenderBridge?.setKeepPlayingAcrossChats?.(${JSON.stringify(enabled)});`;
    await browserWindow.webContents.executeJavaScript(source, true).catch(() => {});
}

async function setInjectedSaveInContextMenuEnabled(browserWindow, enabled) {
    if (!isVoiceUiHost(browserWindow)) {
        return;
    }
    const source = `window.__voiceFileSenderSaveInContextMenuEnabled = ${JSON.stringify(enabled)}; window.__voiceFileSenderBridge?.setSaveInContextMenuEnabled?.(${JSON.stringify(enabled)});`;
    await browserWindow.webContents.executeJavaScript(source, true).catch(() => {});
}

async function setInjectedForwardInContextMenuEnabled(browserWindow, enabled) {
    if (!isVoiceUiHost(browserWindow)) {
        return;
    }
    const source = `window.__voiceFileSenderForwardInContextMenuEnabled = ${JSON.stringify(enabled)}; window.__voiceFileSenderBridge?.setForwardInContextMenuEnabled?.(${JSON.stringify(enabled)});`;
    await browserWindow.webContents.executeJavaScript(source, true).catch(() => {});
}

function setEnabled(enabled) {
    voiceFeatureEnabled = enabled === true;
    for (const browserWindow of BrowserWindow.getAllWindows()) {
        setInjectedEnabled(browserWindow, voiceFeatureEnabled);
    }
    if (voiceFeatureEnabled) {
        cleanupOldVoiceTempFiles().catch(() => {});
        setTimeout(setupAllWindows, 300);
    }
}

function setKeepPlayingAcrossChats(enabled) {
    voiceKeepPlayingAcrossChats = enabled === true;
    for (const browserWindow of BrowserWindow.getAllWindows()) {
        setInjectedKeepPlayingAcrossChats(browserWindow, voiceKeepPlayingAcrossChats);
    }
}

function setSaveInContextMenuEnabled(enabled) {
    voiceSaveInContextMenuEnabled = enabled === true;
    for (const browserWindow of BrowserWindow.getAllWindows()) {
        setInjectedSaveInContextMenuEnabled(browserWindow, voiceSaveInContextMenuEnabled);
    }
}

function setForwardInContextMenuEnabled(enabled) {
    voiceForwardInContextMenuEnabled = enabled === true;
    for (const browserWindow of BrowserWindow.getAllWindows()) {
        setInjectedForwardInContextMenuEnabled(browserWindow, voiceForwardInContextMenuEnabled);
    }
}

function setNetworkFetch(fetcher) {
    voiceNetworkFetch = typeof fetcher === 'function' ? fetcher : null;
}

function setMediaUrlResolver(resolver) {
    voiceMediaUrlResolver = typeof resolver === 'function' ? resolver : null;
}

function setFakeDurationSeconds(value) {
    const seconds = Math.trunc(Number(value));
    fakeVoiceDurationSeconds = Number.isFinite(seconds) && seconds > 0
        ? Math.min(seconds, 300)
        : 0;
}

function setDiagnosticRecorder(recorder) {
    diagnosticRecorder = typeof recorder === 'function' ? recorder : null;
}

module.exports = {
    onBrowserWindowCreated,
    rememberNativePeerAliases,
    setEnabled,
    setKeepPlayingAcrossChats,
    setSaveInContextMenuEnabled,
    setForwardInContextMenuEnabled,
    setNetworkFetch,
    setMediaUrlResolver,
    setFakeDurationSeconds,
    setDiagnosticRecorder,
    getOnlineSourceState,
    runOnlineSourceAction,
    browseOnlineCatalog,
    sendPttInfoAsPtt,
    sanitizePttInfo,
    runTool
};
