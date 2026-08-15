'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsPromises = require('node:fs').promises;
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const silkWasmEntry = require.resolve('silk-wasm');
delete require.cache[silkWasmEntry];
const {
    createSilentSilk,
    detectMediaInputFormat,
    estimateSilkDurationMs,
    getMediaInputArgs,
    getLosslessAudioExtractionPlan,
    isAudioMediaPath,
    isQqNativePttFile,
    isVideoMediaPath,
    makePcm16Wav
} = require('../src/voice/media');
const injectedVoiceFileSenderUi = require('../src/voice/renderer-controller');

function loadVoiceLibraryTestApi(dataDir) {
    const modulePath = path.join(__dirname, '..', 'src', 'voice-file-sender.js');
    const source = fs.readFileSync(modulePath, 'utf8').replace(
        'module.exports = {',
        `module.exports = {\n    __libraryTest: {\n        ensureLibraryDirs,\n        getLibraryVoiceDir,\n        createLibraryFolder,\n        getLibraryFolders,\n        getLibraryItems,\n        moveLibraryItem,\n        renameLibraryItem,\n        deleteLibraryItem,\n        readLibraryIndex,\n        encodeLibraryItemId,\n        importOnlineSource,\n        setNetworkFetch,\n        getOnlineSourceState,\n        runOnlineSourceAction,\n        searchOnlineSource,\n        searchOnlineSources,\n        browseOnlineCatalog,\n        downloadOnlineSourceAudio,\n        isVoiceUiHostUrl,\n        getDirectPreviewFormat\n    },`
    );
    const testModule = new Module(modulePath, module);
    testModule.filename = modulePath;
    testModule.paths = Module._nodeModulePaths(path.dirname(modulePath));
    const normalRequire = testModule.require.bind(testModule);
    testModule.require = request => {
        if (request === 'electron') {
            return {
            app: { getPath: () => dataDir },
            BrowserWindow: { getAllWindows: () => [] },
            dialog: {},
            ipcMain: { emit() {}, listeners: () => [] }
            };
        }
        if (request === './native-ipc') {
            return {
                addNativeRequestHandler() {},
                isNativeFailure: () => false,
                qqNativeInvoke: async () => null,
                unwrapNativeValue: value => value
            };
        }
        return normalRequire(request);
    };
    testModule._compile(source, modulePath);
    return testModule.exports.__libraryTest;
}

async function withVoiceLibraryTestApi(run) {
    const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'qqnt-toolbox-voice-library-'));
    const dataDir = path.join(root, 'data');
    const previousLiteLoader = global.LiteLoader;
    await fsPromises.mkdir(dataDir, { recursive: true });
    global.LiteLoader = {
        plugins: {
            qqnt_toolbox: { path: { data: dataDir } }
        }
    };
    try {
        return await run(loadVoiceLibraryTestApi(dataDir), { root, dataDir });
    } finally {
        global.LiteLoader = previousLiteLoader;
        await fsPromises.rm(root, { recursive: true, force: true });
    }
}

test('loads voice media helpers without eagerly loading silk-wasm', () => {
    assert.equal(require.cache[silkWasmEntry], undefined);
});

test('builds a silent native timing track without re-encoding the source audio', async () => {
    const silk = await createSilentSilk(254123);
    assert.ok(silk.data.subarray(0, 10).equals(Buffer.from('\x02#!SILK_V3', 'latin1')));
    assert.equal(estimateSilkDurationMs(silk.data), 254140);
    assert.equal(silk.duration, 254140);
});

test('recognizes only QQ-native PTT stream headers', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qqnt-toolbox-ptt-format-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const cases = [
        ['silk-with-prefix', Buffer.from('\x02#!SILK_V3payload', 'latin1'), true],
        ['silk-without-prefix', Buffer.from('#!SILK_V3payload', 'latin1'), true],
        ['amr', Buffer.from('#!AMR\npayload', 'latin1'), true],
        ['amr-wideband', Buffer.from('#!AMR-WB\npayload', 'latin1'), true],
        ['mp3', Buffer.from('ID3payload', 'latin1'), false],
        ['ogg-opus', Buffer.from('OggS\x00payload', 'latin1'), false]
    ];
    for (const [name, data, expected] of cases) {
        const filePath = path.join(directory, name);
        fs.writeFileSync(filePath, data);
        assert.equal(isQqNativePttFile(filePath), expected, name);
    }
});

test('detects audio bytes when QQ stores an original PTT with an image extension', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qqnt-toolbox-mislabeled-ptt-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const cases = [
        ['voice.jpg', Buffer.from('ID3\x04\x00\x00payload', 'latin1'), 'mp3'],
        ['voice.png', Buffer.from('fLaCpayload', 'latin1'), 'flac'],
        ['voice.bin', Buffer.from('OggS\x00payload', 'latin1'), 'ogg'],
        ['voice.dat', Buffer.from('RIFF\x00\x00\x00\x00WAVEpayload', 'latin1'), 'wav']
    ];
    for (const [name, data, expected] of cases) {
        const filePath = path.join(directory, name);
        fs.writeFileSync(filePath, data);
        assert.equal(detectMediaInputFormat(filePath), expected, name);
        assert.deepEqual(getMediaInputArgs(filePath), ['-f', expected, '-i', filePath]);
    }
});

test('manages imported online voice sources through the main-process API', async () => {
    const source = `
        lx.send('inited', {
            sources: {
                test: { type: 'music', actions: ['musicUrl'], qualitys: ['320k'] }
            }
        });
        lx.on('request', () => 'https://example.test/voice.mp3');
    `;
    await withVoiceLibraryTestApi(async library => {
        const imported = await library.runOnlineSourceAction({ type: 'import', input: source });
        assert.equal(imported.ok, true);
        assert.equal(imported.sources.length, 1);
        const sourceId = imported.sources[0].id;
        const state = await library.getOnlineSourceState();
        assert.equal(state.ok, true);
        assert.equal(state.sources[0].id, sourceId);
        const removed = await library.runOnlineSourceAction({ type: 'delete', id: sourceId });
        assert.equal(removed.ok, true);
        assert.deepEqual(removed.sources, []);
        const missing = await library.runOnlineSourceAction({ type: 'delete', id: sourceId });
        assert.equal(missing.ok, false);
        assert.equal(missing.reason, 'source-not-found');
        const invalid = await library.runOnlineSourceAction({
            type: 'import',
            input: "lx.on('request', () => 'https://example.test/voice.mp3'); lx.send('inited', { sources: {} });"
        });
        assert.equal(invalid.ok, false);
        assert.equal(invalid.reason, 'no-compatible-sources');
        assert.equal(invalid.message, '音源脚本未提供可用的音乐源。');
        assert.deepEqual(invalid.sources, []);
    });
});

test('imports each MusicFree manifest entry with a stable module-derived provider ID', async () => {
    const manifest = JSON.stringify({
        plugins: [
            { name: 'Display one', url: 'https://example.test/mf/tx.js', version: '1.0.0' },
            { name: 'Display two', url: 'https://example.test/mf/wy.js', version: '1.0.0' }
        ],
        yourinfo: { shouldNotBePersisted: true }
    });
    const moduleByUrl = {
        'https://example.test/mf/tx.js': `module.exports = {
            platform: 'Runtime TX', supportedQualities: ['320k'],
            async search(query) { return { isEnd: true, data: [{ id: query, title: 'TX result' }] }; },
            async getMediaSource(item) { return { url: 'https://cdn.example.test/' + item.id + '.mp3' }; }
        };`,
        'https://example.test/mf/wy.js': `module.exports = {
            platform: 'Runtime WY', supportedQualities: ['320k'],
            async search(query) { return { isEnd: true, data: [{ id: query, title: 'WY result' }] }; },
            async getMediaSource(item) { return { url: 'https://cdn.example.test/' + item.id + '.mp3' }; }
        };`
    };
    await withVoiceLibraryTestApi(async library => {
        library.setNetworkFetch(async url => {
            const source = moduleByUrl[String(url)];
            return new Response(source || '', { status: source ? 200 : 404 });
        });
        const result = await library.importOnlineSource(manifest);
        assert.equal(result.imported.length, 2);
        assert.equal(result.failed.length, 0);
        const state = await library.getOnlineSourceState();
        assert.deepEqual(
            state.sources.map(source => [source.id, Object.keys(source.sources)]).sort((a, b) => a[0].localeCompare(b[0])),
            [['musicfree_tx', ['tx']], ['musicfree_wy', ['wy']]]
        );
    });
});

test('searches an imported source through the provider contract used by the voice panel', async () => {
    const source = `
        lx.send('inited', {
            sources: {
                demo: { type: 'music', actions: ['musicUrl', 'search'], qualitys: ['320k'] }
            }
        });
        lx.on('request', ({ action, source, info }) => {
            if (action !== 'search' || source !== 'demo') throw new Error('unexpected request');
            return { list: [{ id: 'song-1', name: info.keyword, singer: 'Toolbox' }] };
        });
    `;
    await withVoiceLibraryTestApi(async library => {
        const imported = await library.runOnlineSourceAction({ type: 'import', input: source });
        assert.equal(imported.ok, true);
        const result = await library.searchOnlineSource({
            sourceId: imported.source.id,
            providerId: 'demo',
            keyword: 'online voice',
            page: 1,
            limit: 20
        });
        assert.equal(result.sourceId, imported.source.id);
        assert.equal(result.providerId, 'demo');
        assert.equal(result.keyword, 'online voice');
        assert.equal(result.results.length, 1);
        assert.equal(result.results[0].musicInfo.id, 'song-1');
        assert.equal(result.results[0].musicInfo.name, 'online voice');
    });
});

test('refreshes an online audio URL after a transient 403', async () => {
    const source = `
        let requestCount = 0;
        lx.send('inited', {
            sources: { tx: { type: 'music', actions: ['musicUrl'], qualitys: ['320k'] } }
        });
        lx.on('request', () => 'https://cdn.example.test/audio-' + (++requestCount) + '.mp3');
    `;
    await withVoiceLibraryTestApi(async library => {
        const imported = await library.runOnlineSourceAction({ type: 'import', input: source });
        const requests = [];
        library.setNetworkFetch(async (url, options = {}) => {
            requests.push({ url: String(url), headers: options.headers || {} });
            return String(url).includes('audio-1.mp3')
                ? new Response('', { status: 403 })
                : new Response(Buffer.from('ID3\x04\x00\x00audio'), {
                    status: 200,
                    headers: { 'content-type': 'audio/mpeg' }
                });
        });
        const cached = await library.downloadOnlineSourceAudio({
            sourceId: imported.source.id,
            providerId: 'tx',
            songInfo: { id: 'song-1', name: 'Retry song' },
            title: 'Retry song'
        });
        try {
            assert.equal(requests.length, 2);
            assert.match(requests[1].url, /audio-2\.mp3$/);
            assert.equal(requests[1].headers.Referer, 'https://y.qq.com/');
            assert.match(requests[1].headers['User-Agent'], /Mozilla\/5\.0/);
            assert.equal(await fsPromises.readFile(cached.path, 'utf8'), 'ID3\x04\x00\x00audio');
        } finally {
            await fsPromises.unlink(cached.path).catch(() => {});
        }
    });
});

test('aggregates online searches while retaining each result provider context', async () => {
    const source = `
        lx.send('inited', {
            sources: {
                one: { type: 'music', actions: ['musicUrl', 'search'], qualitys: ['320k'] },
                two: { type: 'music', actions: ['musicUrl', 'search'], qualitys: ['320k'] }
            }
        });
        lx.on('request', ({ action, source, info }) => {
            if (action !== 'search') throw new Error('unexpected request');
            return { list: [{ id: source + '-song', name: info.keyword + ' ' + source }] };
        });
    `;
    await withVoiceLibraryTestApi(async library => {
        const imported = await library.runOnlineSourceAction({ type: 'import', input: source });
        const result = await library.searchOnlineSources({
            keyword: 'voice',
            targets: [
                { sourceId: imported.source.id, providerId: 'one', label: 'Source one' },
                { sourceId: imported.source.id, providerId: 'two', label: 'Source two' }
            ]
        });
        assert.equal(result.failures.length, 0);
        assert.deepEqual(
            result.results.map(item => [item.toolboxProviderId, item.toolboxSourceLabel]),
            [['one', 'Source one'], ['two', 'Source two']]
        );
    });
});

test('adds provider-specific catalogue results to standard LX musicUrl-only providers', async () => {
    const source = `
        lx.send('inited', {
            sources: {
                kw: { type: 'music', actions: ['musicUrl'], qualitys: ['320k'] },
                mg: { type: 'music', actions: ['musicUrl'], qualitys: ['320k'] },
                kg: { type: 'music', actions: ['musicUrl'], qualitys: ['320k'] },
                tx: { type: 'music', actions: ['musicUrl'], qualitys: ['320k'] },
                wy: { type: 'music', actions: ['musicUrl'], qualitys: ['320k'] },
                git: { type: 'music', actions: ['musicUrl'], qualitys: ['320k'] }
            }
        });
        lx.on('request', () => 'https://example.test/audio.mp3');
    `;
    await withVoiceLibraryTestApi(async library => {
        const imported = await library.runOnlineSourceAction({ type: 'import', input: source });
        assert.deepEqual(
            Object.fromEntries(Object.entries(imported.source.sources).map(([id, info]) => [id, info.actions])),
            Object.fromEntries(['kw', 'mg', 'kg', 'tx', 'wy', 'git'].map(id => [id, ['musicUrl']]))
        );
        const saved = await library.getOnlineSourceState();
        assert.deepEqual(
            Object.fromEntries(Object.entries(saved.sources[0].sources).map(([id, info]) => [id, info.actions])),
            {
                kw: ['musicUrl', 'search'],
                mg: ['musicUrl', 'search'],
                kg: ['musicUrl', 'search'],
                tx: ['musicUrl', 'search'],
                wy: ['musicUrl', 'search'],
                git: ['musicUrl']
            }
        );
        library.setNetworkFetch(async url => {
            const requestUrl = String(url);
            if (requestUrl.includes('search.kuwo.cn')) {
                return new Response(JSON.stringify({
                    TOTAL: '1',
                    abslist: [{ MUSICRID: 'MUSIC_kw-id', NAME: 'Kuwo song', ARTIST: 'Kuwo artist', ALBUM: 'Kuwo album', DURATION: '181' }]
                }));
            }
            if (requestUrl.includes('musicapp.migu.cn')) {
                return new Response(JSON.stringify({
                    songResultData: {
                        totalCount: '1',
                        result: [{ id: 'mg-id', contentId: 'mg-content', copyrightId: 'mg-copyright', name: 'Migu song', singers: [{ name: 'Migu artist' }], albums: [{ id: 'mg-album-id', name: 'Migu album' }] }]
                    }
                }));
            }
            if (requestUrl.includes('songsearch.kugou.com')) {
                return new Response(JSON.stringify({
                    data: {
                        total: 1,
                        lists: [{ FileHash: 'kg-128', HQFileHash: 'kg-320', SQFileHash: 'kg-flac', ResFileHash: 'kg-hires', SongName: 'Kugou song', SingerName: 'Kugou artist', AlbumName: 'Kugou album', Audioid: 42, Duration: 183 }]
                    }
                }));
            }
            if (requestUrl.includes('client_search_cp')) {
                return new Response(JSON.stringify({
                    data: {
                        song: {
                            totalnum: 1,
                            list: [{
                                mid: 'song-mid',
                                name: 'Search song',
                                singer: [{ name: 'Toolbox' }],
                                album: { name: 'Search album' },
                                interval: 187
                            }]
                        }
                    }
                }));
            }
            if (requestUrl.includes('music.163.com')) {
                return new Response(JSON.stringify({
                    result: {
                        songCount: 1,
                        songs: [{ id: 163, name: 'Netease song', artists: [{ name: 'Netease artist' }], album: { name: 'Netease album' }, duration: 184000 }]
                    }
                }));
            }
            return new Response(JSON.stringify({
                songlist: [{
                    data: {
                        songmid: 'rank-mid',
                        songname: 'Rank song',
                        singer: [{ name: 'Toolbox' }],
                        albumname: 'Rank album',
                        interval: 203
                    }
                }]
            }));
        });
        const searched = {};
        for (const providerId of ['kw', 'mg', 'kg', 'tx', 'wy']) {
            searched[providerId] = await library.searchOnlineSource({
                sourceId: imported.source.id,
                providerId,
                keyword: 'search'
            });
        }
        assert.equal(searched.kw.results[0].musicInfo.songmid, 'kw-id');
        assert.equal(searched.mg.results[0].musicInfo.songmid, 'mg-id');
        assert.equal(searched.mg.results[0].musicInfo.contentId, 'mg-content');
        assert.equal(searched.kg.results[0].musicInfo.hash, 'kg-128');
        assert.equal(searched.kg.results[0].musicInfo.HQFileHash, 'kg-320');
        assert.equal(searched.kg.results[0].musicInfo._types.flac.hash, 'kg-flac');
        assert.equal(searched.tx.results[0].musicInfo.songmid, 'song-mid');
        assert.equal(searched.wy.results[0].musicInfo.songmid, '163');
        const recommended = await library.searchOnlineSource({
            sourceId: imported.source.id,
            providerId: 'tx',
            recommend: true
        });
        assert.equal(recommended.results[0].musicInfo.songmid, 'rank-mid');

        const aggregated = await library.searchOnlineSources({
            keyword: 'search',
            targets: ['kw', 'mg', 'kg', 'tx', 'wy'].map(providerId => ({
                sourceId: imported.source.id,
                providerId,
                label: providerId
            }))
        });
        assert.equal(aggregated.failures.length, 0);
        assert.deepEqual(aggregated.results.map(item => item.toolboxProviderId), ['kw', 'mg', 'kg', 'tx', 'wy']);
    });
});

test('browses QQ Music and NetEase charts and playlists through imported resolvers', async () => {
    const source = `
        lx.send('inited', {
            sources: {
                tx: { type: 'music', actions: ['musicUrl'], qualitys: ['320k'] },
                wy: { type: 'music', actions: ['musicUrl'], qualitys: ['320k'] }
            }
        });
        lx.on('request', () => 'https://example.test/audio.mp3');
    `;
    await withVoiceLibraryTestApi(async library => {
        const imported = await library.runOnlineSourceAction({ type: 'import', input: source });
        const requests = [];
        library.setNetworkFetch(async (url, options = {}) => {
            const requestUrl = String(url);
            requests.push([requestUrl, String(options.method || 'GET')]);
            if (requestUrl.includes('fcg_myqq_toplist.fcg')) {
                return new Response(JSON.stringify({
                    data: {
                        topList: [{ id: 26, topTitle: '巅峰榜·热歌', listenCount: 123000, picUrl: 'http://img.test/tx-chart.jpg' }]
                    }
                }));
            }
            if (requestUrl === 'https://music.163.com/api/toplist') {
                return new Response(JSON.stringify({
                    list: [{ id: 3778678, name: '热歌榜', updateFrequency: '每日更新', coverImgUrl: 'http://img.test/wy-chart.jpg' }]
                }));
            }
            if (requestUrl.includes('u.y.qq.com/cgi-bin/musicu.fcg')) {
                return new Response(JSON.stringify({
                    playlist: {
                        data: {
                            total: 1,
                            v_playlist: [{
                                tid: 88,
                                title: 'QQ 热门歌单',
                                song_ids: '101 102',
                                access_num: 88000,
                                creator_info: { nick: 'QQ 用户' },
                                cover_url_medium: 'http://img.test/tx-playlist.jpg'
                            }]
                        }
                    }
                }));
            }
            if (requestUrl.includes('music.163.com/api/playlist/list')) {
                return new Response(JSON.stringify({
                    total: 1,
                    playlists: [{
                        id: 99,
                        name: '网易云热门歌单',
                        playCount: 99000,
                        trackCount: 20,
                        creator: { nickname: '网易云用户' },
                        coverImgUrl: 'http://img.test/wy-playlist.jpg'
                    }]
                }));
            }
            return new Response('{}', { status: 404 });
        });
        const targets = ['tx', 'wy'].map(providerId => ({
            sourceId: imported.source.id,
            providerId,
            label: providerId
        }));
        const charts = await library.browseOnlineCatalog({ targets, mode: 'charts', limit: 10 });
        assert.equal(charts.failures.length, 0);
        assert.deepEqual(charts.items.map(item => [item.providerId, item.collectionKind, item.collectionId]), [
            ['tx', 'chart', '26'],
            ['wy', 'chart', '3778678']
        ]);
        assert.equal(charts.items[0].coverUrl, 'https://img.test/tx-chart.jpg');

        const playlists = await library.browseOnlineCatalog({ targets, mode: 'playlists', sort: 'hot', limit: 10 });
        assert.equal(playlists.failures.length, 0);
        assert.deepEqual(playlists.items.map(item => [item.providerId, item.collectionKind, item.collectionId]), [
            ['tx', 'playlist', '88'],
            ['wy', 'playlist', '99']
        ]);
        assert.deepEqual(playlists.items[0].songIds, ['101', '102']);
        assert.ok(requests.some(([url]) => url.includes('fcg_myqq_toplist.fcg')));
        assert.ok(requests.some(([url]) => url === 'https://music.163.com/api/toplist'));
        assert.ok(requests.some(([url]) => url.includes('playlist.PlayListPlazaServer')));
        assert.ok(requests.some(([url]) => url.includes('music.163.com/api/playlist/list')));
    });
});

test('loads QQ Music playlist songs in batches and fills missing NetEase track details', async () => {
    const source = `
        lx.send('inited', {
            sources: {
                tx: { type: 'music', actions: ['musicUrl'], qualitys: ['320k'] },
                wy: { type: 'music', actions: ['musicUrl'], qualitys: ['320k'] }
            }
        });
        lx.on('request', () => 'https://example.test/audio.mp3');
    `;
    await withVoiceLibraryTestApi(async library => {
        const imported = await library.runOnlineSourceAction({ type: 'import', input: source });
        let qqRequestBody = null;
        let neteaseSongDetailRequested = false;
        library.setNetworkFetch(async (url, options = {}) => {
            const requestUrl = String(url);
            if (requestUrl === 'https://u.y.qq.com/cgi-bin/musicu.fcg' && options.method === 'POST') {
                qqRequestBody = JSON.parse(options.body);
                return new Response(JSON.stringify({
                    req_0: { data: { track_info: { mid: 'qq-mid-1', name: 'QQ 歌曲一', singer: [{ name: '歌手一' }], album: { name: '专辑一' }, interval: 180 } } },
                    req_1: { data: { track_info: { mid: 'qq-mid-2', name: 'QQ 歌曲二', singer: [{ name: '歌手二' }], album: { name: '专辑二' }, interval: 200 } } }
                }));
            }
            if (requestUrl.includes('music.163.com/api/v3/playlist/detail')) {
                return new Response(JSON.stringify({
                    playlist: {
                        name: '网易云歌单详情',
                        coverImgUrl: 'http://img.test/wy-detail.jpg',
                        creator: { nickname: '创建者' },
                        tracks: [],
                        trackIds: [{ id: 301 }, { id: 302 }]
                    }
                }));
            }
            if (requestUrl.includes('music.163.com/api/song/detail')) {
                neteaseSongDetailRequested = true;
                return new Response(JSON.stringify({
                    songs: [
                        { id: 301, name: '网易云歌曲一', ar: [{ name: '歌手甲' }], al: { name: '专辑甲' }, dt: 181000 },
                        { id: 302, name: '网易云歌曲二', ar: [{ name: '歌手乙' }], al: { name: '专辑乙' }, dt: 201000 }
                    ]
                }));
            }
            return new Response('{}', { status: 404 });
        });
        const qqDetail = await library.browseOnlineCatalog({
            targets: [{ sourceId: imported.source.id, providerId: 'tx', label: 'QQ 音乐' }],
            mode: 'detail',
            collection: {
                sourceId: imported.source.id,
                providerId: 'tx',
                collectionKind: 'playlist',
                collectionId: '88',
                title: 'QQ 歌单',
                songIds: ['101', '102']
            }
        });
        assert.equal(qqDetail.failures.length, 0);
        assert.deepEqual(qqDetail.items.map(item => item.musicInfo.songmid), ['qq-mid-1', 'qq-mid-2']);
        assert.equal(qqRequestBody.req_0.param.song_id, 101);
        assert.equal(qqRequestBody.req_1.param.song_id, 102);

        const wyDetail = await library.browseOnlineCatalog({
            targets: [{ sourceId: imported.source.id, providerId: 'wy', label: '网易云音乐' }],
            mode: 'detail',
            collection: {
                sourceId: imported.source.id,
                providerId: 'wy',
                collectionKind: 'playlist',
                collectionId: '99',
                title: '网易云歌单'
            }
        });
        assert.equal(wyDetail.failures.length, 0);
        assert.equal(neteaseSongDetailRequested, true);
        assert.deepEqual(wyDetail.items.map(item => item.musicInfo.songmid), ['301', '302']);
        assert.equal(wyDetail.info.title, '网易云歌单详情');
        assert.equal(wyDetail.info.coverUrl, 'https://img.test/wy-detail.jpg');
    });
});

test('maps lossless video audio codecs to containers without re-encoding', () => {
    assert.deepEqual(getLosslessAudioExtractionPlan('aac', '.mp4'), {
        extension: '.m4a',
        format: 'ipod'
    });
    assert.deepEqual(getLosslessAudioExtractionPlan('opus', '.mkv'), {
        extension: '.ogg',
        format: 'ogg'
    });
    assert.deepEqual(getLosslessAudioExtractionPlan('flac', '.mkv'), {
        extension: '.flac',
        format: 'flac'
    });
    assert.deepEqual(getLosslessAudioExtractionPlan('unknown', '.mp4'), {
        extension: '.mka',
        format: 'matroska'
    });
});

test('distinguishes video and audio inputs for the two send strategies', () => {
    assert.equal(isVideoMediaPath('clip.mp4'), true);
    assert.equal(isVideoMediaPath('clip.webm'), true);
    assert.equal(isAudioMediaPath('voice.mp3'), true);
    assert.equal(isAudioMediaPath('clip.mp4'), false);
});

test('streams browser-decodable voice previews without converting them to WAV', async t => {
    const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'qqnt-toolbox-direct-preview-'));
    const disguisedMp3 = path.join(directory, 'voice-cache');
    const silk = path.join(directory, 'native-voice.amr');
    await fsPromises.writeFile(disguisedMp3, Buffer.from('ID3audio'));
    await fsPromises.writeFile(silk, Buffer.concat([
        Buffer.from([0x02]),
        Buffer.from('#!SILK_V3', 'latin1'),
        Buffer.from([0, 0])
    ]));
    t.after(() => fsPromises.rm(directory, { recursive: true, force: true }));
    const voice = loadVoiceLibraryTestApi(path.join(directory, 'data'));

    assert.equal(voice.getDirectPreviewFormat(disguisedMp3), 'mp3');
    assert.equal(voice.getDirectPreviewFormat(silk), '');
});

test('does not retain unused voice send waiters or delayed Silk cleanup timers', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'voice-file-sender.js'), 'utf8');

    assert.doesNotMatch(source, /createNativeEventWaiter/);
    assert.doesNotMatch(source, /setTimeout\(\(\) => \{\s*fs\.unlink\(silkPath\)/);
    assert.match(source, /await fs\.unlink\(silkPath\)\.catch/);
});

test('injects the voice UI only after a renderer reaches a chat route', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'voice-file-sender.js'), 'utf8');
    const voice = loadVoiceLibraryTestApi(path.join(os.tmpdir(), 'qqnt-toolbox-voice-route-test'));

    for (const url of [
        'file:///qq/index.html#/main/message',
        'file:///qq/index.html#/chat/123',
        'file:///qq/index.html#/forward',
        'file:///qq/index.html#/record'
    ]) {
        assert.equal(voice.isVoiceUiHostUrl(url), true, url);
    }
    for (const url of [
        '',
        'about:blank',
        'file:///qq/index.html',
        'file:///qq/index.html#/login',
        'file:///qq/index.html#/main/settings'
    ]) {
        assert.equal(voice.isVoiceUiHostUrl(url), false, url);
    }
    assert.match(source, /did-navigate-in-page/);
    assert.match(source, /if \(!state\.uiSetupInstalled\)/);
    assert.doesNotMatch(source, /setTimeout\(start, 1200\)/);
});

test('routes original mode through QQ raw media cache and keeps video extraction lossless', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'voice-file-sender.js'), 'utf8');
    const mediaSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'voice', 'media.js'), 'utf8');
    assert.match(source, /sendMode === 'original'/);
    assert.match(source, /getRichMediaFilePathForGuild/);
    assert.match(source, /elementType: 2/);
    assert.match(source, /options\.raw/);
    assert.match(mediaSource, /'-c:a',\s*'copy'/);
    assert.match(source, /if \(isVideoMediaPath\(mediaPath\)\)/);
    assert.match(source, /encodeMediaFileToSilk\(mediaPath, options\)/);
    assert.match(source, /temporary\) \{[\s\S]*?fs\.unlink\(prepared\.path\)/);
    assert.match(source, /fetch: getOnlineSourceFetch\(\)/);
    assert.match(source, /function findNativePath\(/);
    assert.match(mediaSource, /format=duration/);
});

test('defers missing library durations and virtualizes large libraries', () => {
    const senderSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'voice-file-sender.js'), 'utf8');
    const listSource = senderSource.match(/async function getLibraryItems\([\s\S]*?\n}\n\nfunction toLibraryViewItems/)[0];
    const panelSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'voice', 'library-panel.js'), 'utf8');
    const rendererSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'voice', 'renderer-controller.js'), 'utf8');

    assert.doesNotMatch(listSource, /await detectLibraryDurationSeconds/);
    assert.match(senderSource, /const LIBRARY_DURATION_CONCURRENCY = 2;/);
    assert.match(senderSource, /function createLibraryIndexLookup\(/);
    assert.match(senderSource, /function queueLibraryDurationRefresh\(/);
    assert.match(senderSource, /persistLibraryDurationUpdates/);
    assert.match(senderSource, /async function countSupportedLibraryEntries\(/);
    assert.match(listSource, /const folderItems = await Promise\.all\(/);
    assert.match(senderSource, /MEDIA_EXTENSION_SET\.has\(extension\) \|\| !extension/);
    assert.doesNotMatch(senderSource, /function countSupportedLibraryEntries[\s\S]*?fsSync\.readdirSync/);
    assert.match(panelSource, /const LIST_RENDER_OVERSCAN = 8;/);
    assert.match(panelSource, /const LIST_MIN_RENDER_COUNT = 24;/);
    assert.match(panelSource, /function getListRenderRange\(/);
    assert.match(panelSource, /function renderListWindow\(/);
    assert.match(panelSource, /qvlib-list-spacer-top/);
    assert.match(panelSource, /qvlib-list-spacer-bottom/);
    const renderListWindowSource = panelSource.match(
        /function renderListWindow\([\s\S]*?\n    \}\n\n    function cancelListWindowRender/
    )[0];
    assert.match(renderListWindowSource, /const displayItems = getDisplayItems\(\);/);
    assert.match(renderListWindowSource, /displayItems\.length - end/);
    assert.doesNotMatch(renderListWindowSource, /state\.items\.length - end/);
    assert.match(panelSource, /list\.replaceChildren\(fragment\)/);
    assert.match(panelSource, /list\.addEventListener\('scroll', handleListScroll, \{ passive: true \}\)/);
    assert.match(panelSource, /state\.listRenderFrame = requestAnimationFrame/);
    assert.match(panelSource, /function haveSameLibraryRows\(/);
    assert.match(panelSource, /function updateRenderedListMetadata\(/);
    assert.match(panelSource, /if \(state\.dragging \|\| state\.pendingLibraryFrame\)/);
    assert.match(panelSource, /schedulePendingLibraryFlush\(\);/);
    assert.doesNotMatch(panelSource, /function appendListRows|renderedItemCount/);
    assert.match(panelSource, /function updateLibraryItems\(/);
    assert.match(rendererSource, /bridge\.updateLibraryItems = payload => libraryPanel\.updateLibraryItems\?\.\(payload\);/);
});

test('renders the voice library as a direct file browser with contextual actions', () => {
    const senderSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'voice-file-sender.js'), 'utf8');
    const panelSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'voice', 'library-panel.js'), 'utf8');
    const rendererSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'voice', 'renderer-controller.js'), 'utf8');
    const styleSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'voice', 'panel-style.js'), 'utf8');
    const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');

    assert.match(panelSource, /const ICON_PATHS = Object\.freeze\(/);
    const clockFormatterSource = panelSource.match(/function formatClockTime\(seconds\) \{[\s\S]*?\n    \}/)[0];
    const formatClockTime = new Function(`${clockFormatterSource}\nreturn formatClockTime;`)();
    assert.equal(formatClockTime(3), '00:03');
    assert.equal(formatClockTime(62), '01:02');
    assert.equal(formatClockTime(3600), '60:00');
    assert.doesNotMatch(panelSource, /\$\{value\}\\u79d2|'0:00'/);
    assert.match(panelSource, /const ESTIMATED_LIST_ROW_HEIGHT = 55;/);
    assert.match(panelSource, /view: 'offline',/);
    assert.match(panelSource, /function getOfflineDisplayItems\(\) \{[\s\S]*?return state\.items;/);
    assert.match(panelSource, /function getOnlineDisplayItems\(\) \{[\s\S]*?state\.onlineSearchResults/);
    assert.match(panelSource, /function getDisplayItems\(\) \{[\s\S]*?state\.view === 'online' \? getOnlineDisplayItems\(\) : getOfflineDisplayItems\(\);/);
    const switchViewSource = panelSource.match(
        /function switchView\(nextView\) \{[\s\S]*?\n    \}\n\n    function syncViewLayout/
    )[0];
    const requestOnlineSearchSource = panelSource.match(
        /function requestOnlineSearch\(options = \{\}\) \{[\s\S]*?\n    \}\n\n    function performOnlineResultAction/
    )[0];
    const sourceChangeSource = panelSource.match(
        /sourceSelect\.addEventListener\('change', \(\) => \{[\s\S]*?\n        \}\);/
    )[0];
    assert.doesNotMatch(switchViewSource, /resetPlayer\(\)/);
    assert.doesNotMatch(requestOnlineSearchSource, /resetPlayer\(\)/);
    assert.doesNotMatch(sourceChangeSource, /resetPlayer\(\)/);
    assert.match(panelSource, /invalidateOnlineSearchRequest\('view'\);/);
    assert.match(panelSource, /isFolder \? 'openFolder' : \(isOnline \? 'previewOnline' : 'previewLibrary'\)/);
    assert.match(panelSource, /createIcon\(isFolder \? 'folder' : \(isOnline \? 'music' : 'fileAudio'\)\)/);
    assert.match(panelSource, /\$\{isFolder \? TEXT\.open : TEXT\.play\} \$\{item\.title \|\| TEXT\.item\}/);
    assert.doesNotMatch(panelSource, /isOnline \? TEXT\.sendOrSave : TEXT\.play/);
    assert.match(panelSource, /chevronLeft: '<path d="m15 18-6-6 6-6"\/>',/);
    assert.match(panelSource, /createIconButton\('chevronLeft', 'backFolder'/);
    assert.doesNotMatch(panelSource, /arrowLeft/);
    assert.doesNotMatch(panelSource, /chevronRight|qvlib-chevron/);
    assert.doesNotMatch(panelSource, /pending:\s*'\\u5f85\\u8f6c\\u6362'/);
    assert.match(panelSource, /function getItemMetaText\(item\) \{[\s\S]*?return formatDuration\(item\.duration\);[\s\S]*?\}/);
    assert.doesNotMatch(panelSource, /\[TEXT\.open,\s*'openFolder'/);
    assert.match(panelSource, /more\.setAttribute\('aria-haspopup', 'menu'\)/);
    assert.match(panelSource, /menu\.setAttribute\('role', 'menu'\)/);
    assert.match(panelSource, /item\.kind === 'ptt'[\s\S]*?\[TEXT\.send, 'sendWithMode', 'send', '', 'convert'\]/);
    assert.match(panelSource, /\[TEXT\.convertSend, 'sendWithMode', 'send', '', 'convert'\]/);
    assert.match(panelSource, /\[TEXT\.originalSend, 'sendWithMode', 'fileAudio', '', 'original'\]/);
    assert.match(panelSource, /\[TEXT\.move, 'moveLibrary', 'moveTo'/);
    assert.match(panelSource, /\[TEXT\.remove, 'deleteLibrary', 'delete'/);
    assert.match(panelSource, /function showCreateFolderDialog\(\)/);
    assert.match(panelSource, /function showMoveDialog\(item\)/);
    assert.match(panelSource, /Array\.isArray\(dialogOptions\.selectOptions\)/);
    assert.match(panelSource, /createIconButton\('folderPlus', 'createFolder'/);
    assert.match(panelSource, /type: 'createLibraryFolder', title/);
    assert.match(panelSource, /type: 'moveLibrary',[\s\S]*?targetFolder,[\s\S]*?selectedItemId: state\.selectedItemId/);
    assert.match(panelSource, /type: 'renameLibrary',[\s\S]*?selectedItemId: state\.selectedItemId/);
    assert.match(panelSource, /deleteFolderMessage/);
    assert.match(panelSource, /createIconButton\('search', 'toggleOfflineSearch'/);
    assert.match(panelSource, /createIconButton\('search', 'searchOnline', 'qvlib-online-search-button'/);
    assert.match(panelSource, /offlineSearchInput\.type = 'text';/);
    assert.match(panelSource, /onlineSearchInput\.type = 'text';/);
    assert.match(panelSource, /createIconButton\('close', 'clearOnlineSearch', 'qvlib-online-search-clear', TEXT\.clearSearch\)/);
    assert.match(panelSource, /if \(action === 'clearOnlineSearch'\) \{\s*state\.onlineQuery = '';\s*renderOnlineToolbar\(\);[\s\S]*?focus\?\.\(\);\s*return;/);
    const onlineSearchInputSource = panelSource.match(
        /onlineSearchInput\.addEventListener\('input', \(\) => \{[\s\S]*?\n        \}\);/
    )[0];
    assert.doesNotMatch(onlineSearchInputSource, /onlineSearchResults|onlineSearchContext|requestOnlineBrowse|invalidateOnlineSearchRequest/);
    assert.match(requestOnlineSearchSource, /if \(!selectedOptions\.length \|\| \(!keyword && !recommend\)\) \{\s*renderOnlineToolbar\(\);\s*if \(!keyword && !recommend\) \{\s*return;/);
    assert.match(panelSource, /function requestOnlineSearch\(options = \{\}\)/);
    assert.match(panelSource, /function previewOnlineResult\(item, options = \{\}\) \{[\s\S]*?type: 'previewOnlineAudio'/);
    assert.doesNotMatch(panelSource, /showOnlineManualDialog|openOnlineManual|onlineManualSongInfo/);
    assert.doesNotMatch(panelSource, /function showOnlineResultActionDialog\(/);
    assert.match(panelSource, /function performOnlineResultAction\(item, action, sendMode = 'convert'\)/);
    assert.match(panelSource, /setStatus\(save \? TEXT\.loading : TEXT\.sending, save \? \{ disabled: true \} : \{\}\);/);
    assert.match(panelSource, /\.\.\.\(save \? \{\} : \{ sendMode \}\)/);
    assert.match(panelSource, /\[TEXT\.saveToLibraryShort, 'saveOnlineResult', 'download'/);
    assert.match(panelSource, /actions\.append\(send, save\);/);
    assert.match(panelSource, /const expectedId = String\(state\.playerItem\?\.id \|\| ''\);/);
    assert.doesNotMatch(panelSource, /onlinePreviewItemId/);
    assert.match(senderSource, /async function createOnlineAudioPreview\(options = \{\}\)/);
    assert.match(senderSource, /action\.type === 'previewOnlineAudio'/);
    assert.match(senderSource, /action\.type === 'searchOnlineSources'/);
    assert.match(senderSource, /Promise\.allSettled\(targets\.map/);
    assert.match(panelSource, /type: 'searchOnlineSources'/);
    assert.match(panelSource, /allSourcesOption\.textContent = TEXT\.allOnlineSources/);
    assert.match(panelSource, /kw: '\\u9177\\u6211\\u97f3\\u4e50'/);
    assert.match(panelSource, /toolboxSourceId/);
    assert.match(panelSource, /requestOnlineBrowse\(\)/);
    assert.match(panelSource, /onlineSection: 'recommend'/);
    assert.match(panelSource, /onlineHistory: null/);
    assert.match(panelSource, /function renderOnlineNavigation\(\)/);
    assert.match(panelSource, /\['recommend', TEXT\.recommend\]/);
    assert.match(panelSource, /\['charts', TEXT\.charts\]/);
    assert.match(panelSource, /\['playlists', TEXT\.playlists\]/);
    assert.match(panelSource, /\[\['hot', TEXT\.hot\], \['new', TEXT\.latest\]\]/);
    assert.match(panelSource, /function requestOnlineBrowse\(options = \{\}\)/);
    assert.match(panelSource, /type: 'browseOnlineCatalog'/);
    assert.match(panelSource, /function isOnlineBrowseContextAvailable\(context\)/);
    assert.match(panelSource, /function filterAvailableOnlineBrowseItems\(items\)/);
    assert.match(panelSource, /action === 'backOnlineCollection'/);
    assert.match(panelSource, /onlineBrowseRequestId/);
    assert.match(panelSource, /setStatus\(TEXT\.contentLoading, \{ disabled: false \}\)/);
    assert.match(senderSource, /const BUILTIN_ONLINE_SEARCH_PROVIDERS = new Set\(\['kw', 'mg', 'kg', 'tx', 'wy'\]\);/);
    assert.match(senderSource, /async function searchBuiltInOnlineCatalog\(options = \{\}\)/);
    assert.match(senderSource, /actions\.push\('search'\);/);
    assert.match(panelSource, /const isStaleOnlineSearchPayload = hasOnlineSearchPayload[\s\S]*?String\(payloadSearchContext\.requestId\) !== state\.onlineSearchRequestId;/);
    assert.match(panelSource, /let shouldApplyOnlineSearchPayload = hasOnlineSearchPayload && !isStaleOnlineSearchPayload;/);
    assert.match(panelSource, /if \(shouldApplyOnlineSearchPayload\) \{[\s\S]*?state\.onlineSearchResults = [\s\S]*?state\.onlineSearchContext =/);
    assert.match(panelSource, /if \(state\.view === 'online'\) \{[\s\S]*?shouldApplyOnlineSearchPayload[\s\S]*?renderList\(true\);/);
    assert.match(panelSource, /function isOnlineSearchContextAvailable\(context\)/);
    assert.match(panelSource, /const hasItems = Object\.prototype\.hasOwnProperty\.call\(payload \|\| \{\}, 'items'\);/);
    assert.match(panelSource, /if \(hasItems\) \{[\s\S]*?state\.items = Array\.isArray\(payload\?\.items\)/);
    assert.match(panelSource, /const selectedSourceAvailable = !state\.onlineSourceKey/);
    assert.match(panelSource, /invalidateOnlineSearchRequest\('sources'\);/);
    assert.match(panelSource, /sourceSelect\.addEventListener\('change',[\s\S]*?state\.onlineSearchResults = \[\];[\s\S]*?invalidateOnlineSearchRequest\('source'\);/);
    const panelHeaderSource = panelSource.match(
        /function buildPanel\(\) \{[\s\S]*?const nav = createElement\('div', 'qvlib-nav'\);/
    )[0];
    assert.match(panelHeaderSource, /createIconButton\('cloud', 'switchOnline'/);
    assert.doesNotMatch(panelHeaderSource, /importOnlineSource|onlineAudio|onlineSourceSong|onlineSearch/);
    assert.match(panelSource, /function selectionIsAffectedBy\(item\)/);
    assert.match(panelSource, /createIconButton\('send', 'sendMenu', 'qvlib-player-send', TEXT\.send\)/);
    assert.match(panelSource, /createIconButton\('previous', 'playerPrevious', 'qvlib-player-skip', TEXT\.previous\)/);
    assert.match(panelSource, /createIconButton\('next', 'playerNext', 'qvlib-player-skip', TEXT\.next\)/);
    assert.match(panelSource, /function capturePlayerQueue\(item\)/);
    assert.match(panelSource, /function playAdjacentPlayerItem\(direction\)/);
    assert.match(panelSource, /audio\.addEventListener\('ended',[\s\S]*?playAdjacentPlayerItem\(1\)/);
    assert.match(panelSource, /previewOnlineResult\(item, \{ preserveQueue: true \}\)/);
    assert.match(panelSource, /previewLibraryItem\(item, \{ preserveQueue: true \}\)/);
    assert.match(panelSource, /function toggleItemMenu\(itemId, control, options = \{\}\) \{[\s\S]*?openMenu\?\.dataset\?\.triggerId === triggerId[\s\S]*?closeItemMenu\(true\);[\s\S]*?showItemMenu\(itemId, control, null, options\);/);
    assert.match(panelSource, /if \(action === 'itemMenu'\) \{\s*toggleItemMenu\(itemId, control\);/);
    assert.match(panelSource, /if \(action === 'sendMenu'\) \{[\s\S]*?toggleItemMenu\(item\.id, control, \{[\s\S]*?sendOnly: true/);
    assert.match(panelSource, /if \(action === 'pickMenu'\) \{\s*toggleItemMenu\('__pick__', control, \{/);
    assert.match(panelSource, /emit\(\{ type: 'sendLibrary', id: item\.id, sendMode \}\);/);
    assert.match(panelSource, /emit\(\{ type: 'pick', sendMode \}\);/);
    assert.match(panelSource, /TEXT\.converting : TEXT\.sending, \{ disabled: false \}/);
    assert.doesNotMatch(panelSource, /qvlib-send-mode|setSendMode|state\.sendMode/);
    assert.match(panelSource, /button\.disabled = !audio\?\.src;/);
    assert.match(panelSource, /action === 'sendMenu' && button\.classList\.contains\('qvlib-player-send'\)/);
    assert.match(panelSource, /button\.disabled = state\.busy \|\| !audio\?\.src \|\| !state\.playerItem;/);
    assert.doesNotMatch(panelSource, /player\.hidden = !state\.playerItem/);
    assert.doesNotMatch(panelSource, /send\.hidden = !state\.playerItem/);
    assert.match(panelSource, /track\.setAttribute\('aria-disabled', String\(duration <= 0\)\);/);
    assert.match(styleSource, /\.qvlib-player:not\(\.is-ready\) \.qvlib-track \{[\s\S]*?cursor: default;/);
    assert.doesNotMatch(rendererSource, /panelBridge\.sendMode|__voiceFileSenderSendMode|setSendMode/);
    assert.match(rendererSource, /event\.target\?\.closest\?\.\('#qqnt-toolbox-scrollbar-overlay'\)/);
    assert.match(rendererSource, /function getCompatiblePttClickRequest\(event\)/);
    assert.match(rendererSource, /if \(current\?\.id === request\.id && current\.checking\) \{[\s\S]*?return;[\s\S]*?\}/);
    assert.match(rendererSource, /const cachedPtt = bridge\.compatiblePttSources\?\.get\?\.\(request\.id\);/);
    assert.match(rendererSource, /function bindCompatiblePttSource\(playback, pttElement\)/);
    assert.match(rendererSource, /function restoreCompatiblePttSource\(id = ''\)/);
    assert.match(rendererSource, /field === 'sourcePath'[\s\S]*?nextValue = replacement\.filePath/);
    assert.match(rendererSource, /field === 'fileId'[\s\S]*?nextValue = ''/);
    assert.doesNotMatch(rendererSource, /setTimeout\(restore, 0\)/);
    assert.match(rendererSource, /if \(payload\.native\) \{[\s\S]*?replayCompatiblePttWithNativePlayer\(playback\)/);
    assert.match(rendererSource, /event\.preventDefault\(\);[\s\S]*?enqueueAction\(\{ type: 'playCompatiblePtt'/);
    assert.match(rendererSource, /button\.click\(\);/);
    assert.match(rendererSource, /enqueueAction\(\{ type: 'playCompatiblePtt', id: request\.id, ptt: request\.ptt \}\);/);
    assert.match(rendererSource, /const PTT_BUBBLE_SELECTOR = '\.ptt-element, \.ptt-message__container';/);
    assert.doesNotMatch(rendererSource, /COMPATIBLE_PTT_OVERLAY|compatible-ptt-overlay|syncCompatiblePttVisual|document\.createElement\('audio'\)|new Audio\(/);
    assert.match(rendererSource, /new AudioContextClass\(\)/);
    assert.match(rendererSource, /decodeAudioData\(await response\.arrayBuffer\(\)\)/);
    assert.match(rendererSource, /await startCompatiblePttAudio\(media\);[\s\S]*?replayCompatiblePttWithNativePlayer\(playback, pttElement\)/);
    assert.match(rendererSource, /function discardCompatiblePttPlayback\(id\)/);
    assert.match(rendererSource, /chatSignature: getCurrentPeerSignature\(\),/);
    assert.match(rendererSource, /function checkCompatiblePttLifecycle\(\)/);
    assert.match(rendererSource, /bridge\.compatiblePttLifecycleTimer = setInterval\(checkCompatiblePttLifecycle, 120\);/);
    assert.match(rendererSource, /media\.lifecycleMisses >= 2[\s\S]*?discardCompatiblePttPlayback\(id\);/);
    assert.match(rendererSource, /if \(!shouldKeepVoicePlayingAcrossChats\(\) && !isCompatiblePttPlaybackCurrent\(playback\)\) \{[\s\S]*?bridge\.compatiblePttPlayback = null;/);
    assert.match(rendererSource, /function shouldKeepVoicePlayingAcrossChats\(\)/);
    assert.match(rendererSource, /function findMountedCompatiblePttPlayback\(media\)/);
    assert.match(rendererSource, /function restoreCompatiblePttNativeState\(media, playback\)/);
    assert.match(rendererSource, /function waitForCompatiblePttNativeVisualChange\([\s\S]*?expectedSignature = ''/);
    assert.match(rendererSource, /observer\.observe\(button, \{/);
    assert.match(rendererSource, /stableSignature === candidateSignature && stableSignature !== previousSignature &&[\s\S]*?!expectedSignature \|\| stableSignature === expectedSignature/);
    assert.match(rendererSource, /function rememberCompatiblePttNativeVisualState\(media, playback, playing, previousSignature = ''\)/);
    assert.match(rendererSource, /const stateKey = playing \? 'nativePlayingSignature' : 'nativePausedSignature';/);
    assert.match(rendererSource, /function waitForCompatiblePttNativeVisualState\(media, playback, bubble, token, expectedSignature\)/);
    assert.match(rendererSource, /getCompatiblePttNativeVisualSignature\(playback\) === expectedSignature/);
    const nativeVisualSignatureSource = rendererSource.match(
        /function getCompatiblePttNativeVisualSignature\(playback\) \{[\s\S]*?\n    \}\n\n    function cancelCompatiblePttNativeRestore/
    )[0];
    assert.doesNotMatch(nativeVisualSignatureSource, /ptt-element__progress/);
    assert.match(rendererSource, /function installCompatiblePttMountObserver\(\)/);
    assert.match(rendererSource, /bridge\.compatiblePttMountObserver\.observe\(document\.documentElement/);
    assert.match(rendererSource, /bridge\.compatiblePttMountObserver\?\.disconnect\?\.\(\);/);
    assert.doesNotMatch(rendererSource, /nativeConcealedBubble|nativeConcealedVisibility|visibility', 'hidden', 'important'/);
    assert.doesNotMatch(rendererSource, /function revealCompatiblePttNativeState/);
    assert.doesNotMatch(rendererSource, /function waitForCompatiblePttNativeReady/);
    assert.match(rendererSource, /media\.nativeRestorePending = true;[\s\S]*?media\.nativeSyncing = true;/);
    const nativeRestoreSource = rendererSource.match(
        /function restoreCompatiblePttNativeState\(media, playback\) \{[\s\S]*?\n    \}\n\n    function restoreMountedCompatiblePttNativeStates/
    )[0];
    assert.match(nativeRestoreSource, /const signatureKey = media\.playing \? 'nativePlayingSignature' : 'nativePausedSignature';/);
    assert.match(nativeRestoreSource, /media\.nativeRestorePending = true;[\s\S]*?media\.nativeSyncing = true;[\s\S]*?media\.nativeRestoreAttempts = 0;/);
    assert.match(nativeRestoreSource, /if \(!desiredSignature \|\| beforeToggle !== desiredSignature\) \{[\s\S]*?replayCompatiblePttWithNativePlayer/);
    assert.match(nativeRestoreSource, /changedSignature = await waitForCompatiblePttNativeVisualChange\([\s\S]*?desiredSignature/);
    assert.match(nativeRestoreSource, /if \(!await waitForCompatiblePttNativeVisualState\([\s\S]*?desiredSignature[\s\S]*?failCompatiblePttNativeRestore/);
    assert.match(rendererSource, /media\.nativePlayingSignature = beforeToggle;[\s\S]*?rememberCompatiblePttNativeVisualState\(media, playback, false, beforeToggle\)/);
    assert.match(rendererSource, /media\.nativePausedSignature = beforeToggle;[\s\S]*?rememberCompatiblePttNativeVisualState\(media, playback, true, beforeToggle\)/);
    assert.match(rendererSource, /media\.nativeRestorePending = false;[\s\S]*?media\.nativeBubble = bubble;/);
    assert.match(rendererSource, /if \(cachedMedia\.nativeSyncing \|\| cachedMedia\.togglePending\) \{[\s\S]*?return;/);
    assert.match(rendererSource, /cachedMedia\.togglePending = true;[\s\S]*?\.finally\(\(\) => \{[\s\S]*?cachedMedia\.togglePending = false;/);
    assert.match(rendererSource, /if \(shouldKeepVoicePlayingAcrossChats\(\)\) \{[\s\S]*?restoreCompatiblePttNativeState\(media, mounted\);/);
    assert.match(rendererSource, /bridge\.setKeepPlayingAcrossChats = enabled =>/);
    assert.match(senderSource, /voiceKeepPlayingAcrossChats && isQqNativePttFile\(sourcePath\)/);
    assert.match(senderSource, /setKeepPlayingAcrossChats,/);
    assert.match(mainSource, /keepPlayingAcrossChats: false,/);
    assert.match(mainSource, /setKeepPlayingAcrossChats\?\.\(shouldKeepVoicePlayingAcrossChats\(\)\)/);
    assert.match(rendererSource, /currentSignature !== media\.chatSignature[\s\S]*?media\.nativeBubble\?\.isConnected/);
    assert.match(rendererSource, /media\.nextNativeLookupAt = now \+ 480;/);
    assert.match(rendererSource, /currentSignature !== media\.chatSignature[\s\S]*?restoreCompatiblePttSource\(id\);/);
    assert.match(rendererSource, /shouldKeepVoicePlayingAcrossChats\(\) && !isCompatiblePttPlaybackCurrent\(playback\)[\s\S]*?await startCompatiblePttAudio\(media\);/);
    assert.match(rendererSource, /document\.addEventListener\('mouseup', seekCompatiblePttAudio, true\);/);
    assert.doesNotMatch(rendererSource, /document\.addEventListener\('mousedown', seekCompatiblePttAudio, true\);/);
    const nativeSeekSource = rendererSource.match(
        /function dispatchCompatiblePttNativeSeek\(playback, ratio\) \{[\s\S]*?\n    \}\n\n    function getCompatiblePttNativeVisualSignature/
    )[0];
    assert.match(nativeSeekSource, /\['mousedown', 1\], \['mousemove', 1\], \['mouseup', 0\]/);
    assert.doesNotMatch(nativeSeekSource, /\['click', 0\]/);
    assert.match(rendererSource, /function isCompatiblePttPlaybackToggle\(event, playback\)/);
    assert.match(rendererSource, /const bubble = playback\?\.bubble\?\.isConnected/);
    assert.match(rendererSource, /target === bubble \|\| bubble\.contains\(target\)/);
    assert.match(rendererSource, /const progress = target\.closest\?\.\('\.ptt-element__progress/);
    assert.match(rendererSource, /isCompatiblePttPlaybackToggle\(event, request\)/);
    assert.match(rendererSource, /bridge\.useCompatiblePttSource = useCompatiblePttSource;/);
    assert.match(senderSource, /sendMode: normalizeVoiceSendMode\(action\.sendMode\)/);
    const sendLibraryActionSource = senderSource.match(
        /if \(action\.type === 'sendLibrary'\) \{[\s\S]*?\n    \}\n    if \(action\.type === 'sendPtt'\)/
    )[0];
    assert.match(sendLibraryActionSource, /setInjectedStatus\(browserWindow/);
    assert.doesNotMatch(sendLibraryActionSource, /refreshInjectedLibrary/);
    assert.doesNotMatch(sendLibraryActionSource, /disabled:/);
    assert.match(senderSource, /await setInjectedStatus\(browserWindow, '\\u53d1\\u9001\\u4e2d', \{ disabled: false \}\);/);
    assert.match(senderSource, /if \(action\.type === 'playCompatiblePtt'\)/);
    assert.match(senderSource, /async function waitForPttSourcePath\(ptt, options = \{\}\)/);
    assert.match(senderSource, /const expectedSize = Math\.max\(0, Math\.trunc\(Number\(ptt\?\.fileSize\) \|\| 0\)\);/);
    assert.match(senderSource, /actualSize >= expectedSize/);
    assert.match(senderSource, /pttSourceResolver\.invalidate\(\);/);
    const compatiblePlaybackSource = senderSource.match(
        /if \(action\.type === 'playCompatiblePtt'\) \{[\s\S]*?\n    \}\n    if \(action\.type === 'list'\)/
    )[0];
    assert.match(compatiblePlaybackSource, /if \(!sourcePath \|\| !actualSize \|\| \(expectedSize && actualSize < expectedSize\)\) \{[\s\S]*?native: true/);
    assert.match(compatiblePlaybackSource, /createCompatiblePttPlayback\(browserWindow, sourcePath, ptt\)/);
    assert.doesNotMatch(compatiblePlaybackSource, /encodeMediaFileToSilk\(sourcePath/);
    assert.match(compatiblePlaybackSource, /setInjectedCompatiblePttSource\(browserWindow, \{ id, native: true \}\)/);
    assert.match(senderSource, /createSilentSilk\(durationMs\)/);
    assert.match(senderSource, /voiceMediaUrlResolver\(previewPath, \{[\s\S]*?format: decodeNative \? 'wav' : detectMediaInputFormat\(sourcePath\)/);
    assert.doesNotMatch(mainSource, /saveVoiceSendMode|voiceMessage\.sendMode/);
    assert.match(panelSource, /more: '<circle cx="12" cy="5" r="1"\/>/);
    assert.match(panelSource, /selectedItem: null/);
    assert.match(panelSource, /folders: \[\]/);
    assert.match(panelSource, /state\.selectedItem\.parentPath[\s\S]*?state\.folder/);
    assert.match(panelSource, /const refreshedItem = getLibraryItem\(state\.selectedItemId\);[\s\S]*?parentPath: refreshedItem\.parentPath \?\? state\.folder/);
    assert.match(panelSource, /function isAudioPlaying\(audio\)/);
    assert.match(panelSource, /function resetPlayer\(\)/);
    assert.match(panelSource, /const expectedId = String\(state\.playerItem\?\.id \|\| ''\);[\s\S]*?String\(payload\.id \|\| ''\) !== expectedId/);
    assert.match(panelSource, /function syncPlayingRows\(\)/);
    assert.match(panelSource, /syncPlayer\(\)[\s\S]*?syncPlayingRows\(\);/);
    assert.match(panelSource, /qvlib-playing-indicator/);
    assert.match(panelSource, /const listFrame = createElement\('div', 'qvlib-list-frame'\)/);
    assert.match(panelSource, /createElement\('div', 'qvlib-list qqnt-toolbox-scrollable'\)/);
    assert.doesNotMatch(panelSource, /qvlib-scrollbar|syncScrollbar|installScrollbar/);
    assert.match(panelSource, /function handleListScroll\(\) \{[\s\S]*?closeItemMenu\(\);/);
    assert.match(panelSource, /list\.addEventListener\('scroll', handleListScroll, \{ passive: true \}\)/);
    assert.match(panelSource, /else if \(closeItemMenu\(true\)\)/);
    assert.match(panelSource, /menu\.addEventListener\('focusout'/);
    assert.match(panelSource, /row\?\.classList\.add\('is-menu-open'\)/);
    assert.match(panelSource, /hasPointerPosition \? event : null/);
    assert.match(panelSource, /function releasePointerActionFocus\(\)/);
    assert.match(panelSource, /root\.addEventListener\('pointerleave',[\s\S]*?is-pointer-outside[\s\S]*?releasePointerActionFocus\(\)/);
    assert.match(panelSource, /state\.windowBlurHandler = \(\) => \{[\s\S]*?closeItemMenu\(\);[\s\S]*?releasePointerActionFocus\(\);/);

    assert.match(styleSource, /\.qvlib-row\.is-folder \.qvlib-item-icon/);
    assert.match(styleSource, /\.qvlib-row\.is-file \.qvlib-item-icon/);
    assert.match(styleSource, /\.qvlib-row:hover \.qvlib-actions/);
    assert.match(styleSource, /\.qvlib-row:has\(\.qvlib-more:focus-visible\) \.qvlib-actions/);
    assert.doesNotMatch(styleSource, /\.qvlib-row:focus-within \.qvlib-actions/);
    assert.match(styleSource, /\.qvlib-row\.is-menu-open \.qvlib-actions/);
    assert.match(styleSource, /\.is-pointer-outside \.qvlib-row:not\(\.is-menu-open\) \.qvlib-actions/);
    assert.match(styleSource, /\.qvlib-list \{[\s\S]*?overflow-x: hidden;[\s\S]*?overflow-y: auto;[\s\S]*?overflow-anchor: none;/);
    assert.match(styleSource, /\.qvlib-list-frame \{[\s\S]*?position: relative;/);
    assert.doesNotMatch(styleSource, /\.qvlib-list::\-webkit-scrollbar|scrollbar-width:/);
    assert.doesNotMatch(styleSource, /qvlib-scrollbar-thumb|\.qvlib-scrollbar\s*\{/);
    assert.match(styleSource, /\.qvlib-list-spacer \{[\s\S]*?pointer-events: none;/);
    assert.match(styleSource, /\.qvlib-row \{[\s\S]*?margin-inline: 4px;/);
    assert.match(styleSource, /\.qvlib-row \{[\s\S]*?height: 55px;/);
    assert.match(styleSource, /\.qvlib-row \{[\s\S]*?overflow: hidden;[\s\S]*?border-radius: 6px;/);
    assert.match(styleSource, /\.qvlib-row\.is-playing \.qvlib-playing-indicator/);
    assert.match(styleSource, /\.qvlib-player-controls \{[\s\S]*?grid-template-columns: 24px 30px 24px;/);
    assert.match(panelSource, /header\.append\(heading, createFolder, offlineSearch, refresh, viewControls, closeButton\);/);
    assert.match(panelSource, /switchToOffline: '\\u672c\\u5730\\u8bed\\u97f3\\u5e93'/);
    assert.match(panelSource, /switchToOnline: '\\u5728\\u7ebf\\u97f3\\u6e90'/);
    assert.match(panelSource, /const reopening = Boolean\(state\.root\?\.isConnected\);/);
    assert.match(panelSource, /state\.root = buildPanel\(\);[\s\S]*?renderViewControls\(\);/);
    assert.match(panelSource, /if \(!reopening\) \{[\s\S]*?emit\(\{ type: 'list' \}\);/);
    assert.match(panelSource, /audio\?\.pause\?\.\(\);[\s\S]*?state\.root\.hidden = true;/);
    assert.match(panelSource, /if \(state\.root\.hidden\) \{[\s\S]*?\.qvlib-toast[\s\S]*?return;/);
    assert.match(panelSource, /audio\.src = payload\.previewUrl;[\s\S]*?if \(!state\.root\.hidden\) \{[\s\S]*?audio\.play/);
    assert.doesNotMatch(panelSource, /state\.root\?\.remove\(\);[\s\S]*?state\.view = 'offline';/);
    assert.match(styleSource, /#qqnt-toolbox-voice-library\[hidden\] \{[\s\S]*?display: none !important;/);
    assert.match(styleSource, /\.qvlib-view-controls \{[\s\S]*?flex: none;/);
    assert.match(styleSource, /\.qvlib-online-toolbar \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\) 28px minmax\(116px, 132px\);/);
    assert.match(styleSource, /\.qvlib-offline-search-field,[\s\S]*?\.qvlib-online-search-field \{[\s\S]*?position: relative;/);
    assert.match(styleSource, /\.qvlib-search-clear,[\s\S]*?\.qvlib-online-search-clear \{[\s\S]*?position: absolute;[\s\S]*?right: 3px;/);
    assert.match(panelSource, /offlineSearchInput\.addEventListener\('input',[\s\S]*?renderOfflineSearch\(\);[\s\S]*?renderList\(true\);/);
    assert.match(styleSource, /\.qvlib-online-search-field \{[\s\S]*?position: relative;/);
    assert.match(styleSource, /\.qvlib-online-search-clear \{[\s\S]*?position: absolute;[\s\S]*?right: 3px;/);
    assert.match(styleSource, /width: min\(420px, calc\(100vw - 24px\)\)/);
    assert.match(styleSource, /height: min\(480px, calc\(100vh - 24px\)\)/);
    assert.match(styleSource, /\.qvlib-list\.is-collection-grid \{[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
    assert.match(styleSource, /@media \(max-width: 390px\) \{[\s\S]*?\.qvlib-list\.is-collection-grid \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/);
    assert.doesNotMatch(styleSource, /qvlib-send-mode/);
    assert.match(styleSource, /\.qvlib-primary \{[\s\S]*?font: inherit;/);
    assert.match(styleSource, /\.qvlib-name \{[\s\S]*?line-height: 19px;/);
    assert.match(styleSource, /\.qvlib-meta \{[\s\S]*?line-height: 15px;/);
    assert.match(styleSource, /\.qvlib-shell \{[\s\S]*?transform: translate3d\(0, 0, 0\);[\s\S]*?will-change: transform;/);
    assert.match(styleSource, /@keyframes qvlib-playing-wave/);
    assert.doesNotMatch(styleSource, /\.qvlib-row\.is-selected \{/);
    assert.match(styleSource, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.qvlib-playing-bar/);
    assert.match(styleSource, /@media \(hover: none\)/);
    assert.match(styleSource, /\.qvlib-item-menu \{\s*position: absolute;/);
    assert.match(styleSource, /\.qvlib-dialog input,[\s\S]*?\.qvlib-dialog select/);
    assert.doesNotMatch(styleSource, /\.qvlib-chevron/);
    assert.match(senderSource, /id: previewItem\.id,[\s\S]*?previewUrl:/);
    assert.match(senderSource, /async function getStableAudioPreviewPath\(cacheKey, extension = '\.wav'\)/);
    assert.match(senderSource, /async function getExistingStableAudioPreview\(cacheKey\)/);
    assert.match(senderSource, /const previewKey = JSON\.stringify\(/);
    assert.match(senderSource, /previewVersion: 2,/);
    assert.match(senderSource, /await cleanupFiles\(previewDir, previewEntries, temporaryExtensions\);/);
    assert.match(senderSource, /function getDirectPreviewFormat\(filePath\)/);
    assert.match(senderSource, /const previewPath = directFormat[\s\S]*?\? sourcePath[\s\S]*?: await createAudioPreviewFile/);
    assert.match(senderSource, /previewUrl: await getPreviewMediaUrl\(previewItem\)/);
    assert.doesNotMatch(senderSource, /previewData\.toString\('base64'\)|data:audio\/wav;base64/);
    assert.match(senderSource, /async function getLibraryFolders\(\)/);
    assert.match(senderSource, /async function createLibraryFolder\(/);
    assert.match(senderSource, /async function moveLibraryItem\(/);
    assert.match(senderSource, /for \(const directoryPath of \[getPluginDataDir\(\), getLibraryDir\(\), getLibraryVoiceDir\(\)\]\)/);
    assert.match(senderSource, /itemLstat\.isSymbolicLink\(\)/);
    assert.match(senderSource, /isCaseOnlyRename/);
    assert.match(senderSource, /\.qqnt-toolbox-rename-/);
    assert.match(senderSource, /changed = isCaseOnlyRename[\s\S]*?\? false[\s\S]*?: removeIndexedItemsAtPath/);
    assert.match(senderSource, /const \[items, folders\] = await Promise\.all\(/);
    assert.match(senderSource, /getLibraryFolders\(\)/);
    assert.match(senderSource, /folders,\n\s*\.\.\.extraPayload/);
    assert.match(senderSource, /action\.type === 'createLibraryFolder'/);
    assert.match(senderSource, /action\.type === 'moveLibrary'/);
    assert.match(senderSource, /action\.type === 'renameLibrary'[\s\S]*?action\.selectedItemId[\s\S]*?selectedItem:/);
});

test('rejects unsafe voice library names and relative paths', () => {
    const senderSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'voice-file-sender.js'), 'utf8');
    const nameHelpers = senderSource.slice(
        senderSource.indexOf('function normalizeFieldText'),
        senderSource.indexOf('function normalizeLibraryRelativePath')
    );
    const pathValidatorSource = senderSource.slice(
        senderSource.indexOf('function validateLibraryRelativePath'),
        senderSource.indexOf('function getLibraryAbsolutePath')
    );
    const sanitizeLibraryEntryName = new Function(
        `${nameHelpers}\nreturn sanitizeLibraryEntryName;`
    )();
    const validateLibraryRelativePath = new Function(
        'path',
        `${pathValidatorSource}\nreturn validateLibraryRelativePath;`
    )(path);

    assert.equal(sanitizeLibraryEntryName(' normal folder '), 'normal folder');
    assert.equal(sanitizeLibraryEntryName('name.  '), 'name');
    for (const invalidName of ['', '.', '..', 'CON', 'nul.txt', 'LPT9']) {
        assert.equal(sanitizeLibraryEntryName(invalidName), '');
    }
    assert.equal(validateLibraryRelativePath('', true), '');
    assert.equal(validateLibraryRelativePath('folder/child', false), 'folder/child');
    for (const invalidPath of ['../outside', 'folder//child', '/absolute', 'C:/absolute']) {
        assert.throws(() => validateLibraryRelativePath(invalidPath, true));
    }
});

test('manages voice library folders and preserves indexed files across moves', async () => {
    await withVoiceLibraryTestApi(async library => {
        await library.ensureLibraryDirs();
        const voiceRoot = library.getLibraryVoiceDir();
        await library.createLibraryFolder('', 'Folder');
        await library.createLibraryFolder('Folder', 'Child');
        const voicePath = path.join(voiceRoot, 'sample.amr');
        await fsPromises.writeFile(voicePath, Buffer.concat([
            Buffer.from([0x02]),
            Buffer.from('#!SILK_V3', 'latin1'),
            Buffer.from([0, 0])
        ]));

        const sourceItem = (await library.getLibraryItems('')).find(item => item.kind !== 'folder');
        assert.ok(sourceItem);
        await library.moveLibraryItem(sourceItem.id, 'Folder');
        assert.equal(fs.existsSync(path.join(voiceRoot, 'Folder', 'sample.amr')), true);

        const originalOpenSync = fs.openSync;
        let syncOpenCount = 0;
        fs.openSync = (...args) => {
            syncOpenCount += 1;
            return originalOpenSync(...args);
        };
        try {
            const folder = (await library.getLibraryItems('')).find(item => item.kind === 'folder');
            assert.equal(folder.count, 2);
        } finally {
            fs.openSync = originalOpenSync;
        }
        assert.equal(syncOpenCount, 0);

        const folderId = library.encodeLibraryItemId('folder', 'Folder');
        await library.renameLibraryItem(folderId, 'folder');
        const indexed = (await library.readLibraryIndex()).items.find(item => item.id === sourceItem.id);
        assert.ok(indexed);
        assert.equal(path.basename(path.dirname(indexed.path)), 'folder');
        assert.deepEqual(await library.getLibraryFolders(), ['', 'folder', 'folder/Child']);

        await library.deleteLibraryItem(library.encodeLibraryItemId('folder', 'folder'));
        assert.equal(fs.existsSync(path.join(voiceRoot, 'folder')), false);
        assert.equal((await library.readLibraryIndex()).items.some(item => item.id === sourceItem.id), false);
    });
});

test('rejects a junction used as the managed voice library root', async t => {
    await withVoiceLibraryTestApi(async (library, { root, dataDir }) => {
        const libraryDir = path.join(dataDir, 'voice', 'library');
        const externalDir = path.join(root, 'external');
        const voiceRoot = path.join(libraryDir, 'voices');
        await fsPromises.mkdir(libraryDir, { recursive: true });
        await fsPromises.mkdir(externalDir, { recursive: true });
        try {
            await fsPromises.symlink(externalDir, voiceRoot, process.platform === 'win32' ? 'junction' : 'dir');
        } catch (error) {
            if (error?.code === 'EPERM' || error?.code === 'EACCES') {
                t.skip('Creating a directory link is not permitted in this environment.');
                return;
            }
            throw error;
        }
        await assert.rejects(() => library.ensureLibraryDirs(), /root is invalid/);
        assert.deepEqual(await fsPromises.readdir(externalDir), []);
    });
});

test('uses the built-in FFmpeg resampler without requiring optional libsoxr', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'voice', 'media.js'), 'utf8');

    assert.match(source, /`aresample=\$\{TARGET_SILK_SAMPLE_RATE\}`/);
    assert.doesNotMatch(source, /resampler=soxr|precision=28/);
});

test('estimates Silk duration from complete frames', () => {
    const makeFrame = payload => {
        const size = Buffer.alloc(2);
        size.writeUInt16LE(payload.length);
        return Buffer.concat([size, payload]);
    };
    const silk = Buffer.concat([
        Buffer.from([0x02]),
        Buffer.from('#!SILK_V3', 'latin1'),
        makeFrame(Buffer.from([1, 2])),
        makeFrame(Buffer.from([3, 4, 5]))
    ]);

    assert.equal(estimateSilkDurationMs(silk), 40);
});

test('writes a valid PCM16 WAV header', () => {
    const pcm = Buffer.from([0, 0, 1, 0]);
    const wav = makePcm16Wav(pcm, 24000, 1);

    assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF');
    assert.equal(wav.subarray(8, 12).toString('ascii'), 'WAVE');
    assert.equal(wav.readUInt32LE(24), 24000);
    assert.equal(wav.readUInt16LE(22), 1);
    assert.equal(wav.readUInt32LE(40), pcm.length);
    assert.deepEqual(wav.subarray(44), pcm);
});

function createVoiceRendererHarness() {
    const previousGlobals = {
        window: global.window,
        document: global.document,
        Element: global.Element,
        getComputedStyle: global.getComputedStyle
    };
    const listeners = new Map();
    let extension = null;
    class MockElement {
        constructor(text = '') {
            this.innerText = text;
            this.textContent = text;
        }

        matches(selector) {
            return selector === '.q-context-menu-item';
        }
    }
    const documentMock = {
        body: new MockElement(),
        documentElement: new MockElement(),
        addEventListener(name, handler) {
            const handlers = listeners.get(name) || [];
            handlers.push(handler);
            listeners.set(name, handlers);
        },
        querySelector: () => null,
        querySelectorAll: () => [],
        elementFromPoint: () => null
    };
    const windowMock = {
        __voiceFileSenderEnabled: true,
        __voiceFileSenderSaveInContextMenuEnabled: true,
        __voiceFileSenderForwardInContextMenuEnabled: true,
        __qqntToolboxMessageContextMenu: {
            registerExtension(value) {
                extension = value;
            }
        },
        addEventListener() {}
    };
    const panelFactory = () => ({
        close() {},
        contains: () => false,
        handleEscape() {},
        isOpen: () => false,
        open() {},
        playPreview() {},
        setLibrary() {},
        setStatus() {},
        updateLibraryItems() {},
        updatePlacement() {}
    });

    global.window = windowMock;
    global.document = documentMock;
    global.Element = MockElement;
    global.getComputedStyle = () => ({ display: 'block', visibility: 'visible', opacity: '1' });
    const actionPromise = injectedVoiceFileSenderUi(panelFactory, '');
    return {
        actionPromise,
        extension,
        listeners,
        MockElement,
        window: windowMock,
        restore() {
            global.window = previousGlobals.window;
            global.document = previousGlobals.document;
            global.Element = previousGlobals.Element;
            global.getComputedStyle = previousGlobals.getComputedStyle;
        }
    };
}

function createVoiceMenuRequest(record, getNativeItemsForContext) {
    const originalContext = { msgRecord: record };
    const menuContext = { menuContext: originalContext };
    const menu = { _: { ctx: menuContext } };
    Object.defineProperty(menu, 'menuContext', {
        get: () => menuContext.menuContext,
        set: value => {
            menuContext.menuContext = value;
        }
    });
    return {
        menu,
        menuContext,
        originalContext,
        request: {
            menu,
            originalContext,
            context: originalContext,
            getNativeItemsForContext
        }
    };
}

test('keeps the real voice menu and binds only native forward to a text placeholder', async () => {
    const harness = createVoiceRendererHarness();
    try {
        assert.ok(harness.extension);
        const voiceRecord = {
            msgId: 'voice-message-1',
            playbackState: 'paused',
            transcription: { text: 'converted voice text' },
            elements: [{
                elementType: 4,
                pttElement: { fileName: 'voice.amr', duration: 2 }
            }]
        };
        let speechHandled = 0;
        const speechItem = {
            type: 15,
            text: '转文字',
            icon: 'native-speech-icon',
            handler: () => speechHandled++
        };
        const collectItem = { type: 8, text: '收藏' };
        const forwardedArgs = [];
        const forwardPrototype = {
            handler(...args) {
                forwardedArgs.push({ args, thisValue: this });
            },
            when: () => true
        };
        const nativeForward = Object.assign(Object.create(forwardPrototype), {
            type: 6,
            text: '转发',
            icon: 'one_by_one_forward'
        });
        const request = createVoiceMenuRequest(voiceRecord, context => {
            assert.notEqual(context, request.originalContext);
            assert.equal(context.msgRecord.msgId, voiceRecord.msgId);
            assert.equal(context.msgRecord.elements[0].elementType, 1);
            return [nativeForward];
        });

        const prepared = harness.extension.beforeOpen(request.request);
        assert.equal(prepared, request.request);
        assert.equal(prepared.context, request.originalContext);
        const transformed = harness.extension.transformItems({
            ...prepared,
            items: [speechItem, collectItem]
        });
        assert.equal(transformed.items[0], speechItem);
        assert.equal(transformed.items[0].type, 15);
        assert.notEqual(transformed.items[1], nativeForward);
        assert.equal(Object.getPrototypeOf(transformed.items[1]), forwardPrototype);
        assert.equal(transformed.items[1].type, 6);
        assert.equal(transformed.items[2], collectItem);

        const clickHandler = harness.listeners.get('click')[0];
        clickHandler({ composedPath: () => [new harness.MockElement('转文字')] });
        transformed.items[0].handler();
        assert.equal(speechHandled, 1);
        assert.equal(request.menuContext.menuContext, request.originalContext);

        const nativeContext = { sendable: true, sourceEvent: 'source-event' };
        const nativeEvent = { type: 'click' };
        clickHandler({ composedPath: () => [new harness.MockElement('转发')] });
        transformed.items[1].handler(voiceRecord, voiceRecord.elements[0], nativeContext, nativeEvent);
        assert.equal(forwardedArgs.length, 1);
        assert.equal(forwardedArgs[0].thisValue, nativeForward);
        assert.equal(forwardedArgs[0].args[0].msgId, voiceRecord.msgId);
        assert.equal(forwardedArgs[0].args[0].elements[0].elementType, 1);
        assert.equal(forwardedArgs[0].args[1], forwardedArgs[0].args[0].elements[0]);
        assert.equal(forwardedArgs[0].args[2], nativeContext);
        assert.equal(forwardedArgs[0].args[3], nativeEvent);
        assert.equal((await harness.actionPromise).type, 'prepareNativePttForward');
    } finally {
        harness.restore();
    }
});
