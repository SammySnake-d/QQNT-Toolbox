'use strict';

/**
 * Dependency-free adapters for LXMusic, CeruMusic and QT MusicPlugin sources.
 *
 * The adapters implement the source initialisation, `musicUrl` request,
 * optional search extension, and bounded HTTP bridge useful to Toolbox.
 * Scripts are evaluated in a VM with no
 * Node globals and with conservative input/time limits.  This is a safety
 * boundary for normal user supplied source scripts, not a replacement for a
 * separate OS sandbox.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');

const DEFAULT_LIMITS = Object.freeze({
    maxScriptBytes: 512 * 1024,
    maxResponseBytes: 8 * 1024 * 1024,
    maxDownloadBytes: 128 * 1024 * 1024,
    maxUrlLength: 2048,
    maxHeaderValueLength: 8192,
    maxRequestTimeoutMs: 60_000,
    scriptTimeoutMs: 2_000,
    actionTimeoutMs: 20_000,
    maxTimers: 64,
    // Search is an optional Toolbox extension. Keep its result set bounded so
    // a source cannot accidentally (or deliberately) return an unbounded list.
    maxSearchResults: 200,
    maxSearchTextLength: 256,
    maxSearchItemBytes: 64 * 1024,
    maxSearchObjectDepth: 8,
    maxSearchObjectKeys: 128,
    maxSearchArrayItems: 128
});

const SUPPORTED_ACTIONS = new Set(['musicUrl', 'lyric', 'pic', 'search', 'musicSearch']);
const SEARCH_ACTIONS = new Set(['search', 'musicSearch']);
const SUPPORTED_QUALITIES = new Set(['128k', '320k', 'flac', 'flac24bit']);
const ONLINE_SOURCE_FORMATS = Object.freeze(['lxmusic', 'cerumusic', 'qt-music']);
const MUSICFREE_SOURCE_FORMAT = 'musicfree';
const ONLINE_SOURCE_ALL_FORMATS = Object.freeze([...ONLINE_SOURCE_FORMATS, MUSICFREE_SOURCE_FORMAT]);
const MUSICFREE_WORD_ARRAY_BYTES = new WeakMap();
const MUSICFREE_BIG_INTEGER_VALUES = new WeakMap();
const BLOCKED_SCRIPT_TOKENS = /(?:\b(?:require|process|global|Buffer|WebAssembly|import|export|eval|Function|constructor|prototype)\b|__proto__|child_process|worker_threads|node:)/;
const HEADER_FIELD_LIMITS = Object.freeze({
    name: 128,
    description: 512,
    author: 128,
    homepage: 2048,
    version: 64
});

class OnlineSourceError extends Error {
    constructor(message, code = 'online-source-error', details) {
        super(message);
        this.name = 'OnlineSourceError';
        this.code = code;
        if (details !== undefined) this.details = details;
    }
}

function mergeLimits(value = {}) {
    const result = { ...DEFAULT_LIMITS };
    for (const [key, fallback] of Object.entries(DEFAULT_LIMITS)) {
        const number = Number(value[key]);
        if (Number.isFinite(number) && number > 0) result[key] = Math.floor(number);
        else result[key] = fallback;
    }
    return result;
}

function normalizeText(value, maxLength = 2048) {
    const text = String(value ?? '').trim();
    if (!text) return '';
    return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function normalizeHttpUrl(value, options = {}) {
    const limits = mergeLimits(options.limits);
    const text = String(value ?? '').trim();
    if (!text || text.length > limits.maxUrlLength) {
        throw new OnlineSourceError('URL is empty or too long', 'invalid-url');
    }
    let parsed;
    try {
        parsed = new URL(text);
    } catch {
        throw new OnlineSourceError('Invalid URL', 'invalid-url');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new OnlineSourceError('Only HTTP and HTTPS URLs are allowed', 'invalid-url');
    }
    if (parsed.username || parsed.password) {
        throw new OnlineSourceError('Credentials in URLs are not allowed', 'invalid-url');
    }
    return parsed.href;
}

function ensureWithinRoot(rootPath, candidatePath) {
    const root = path.resolve(rootPath);
    const candidate = path.resolve(candidatePath);
    const relative = path.relative(root, candidate);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new OnlineSourceError('Path escapes the configured directory', 'unsafe-path');
    }
    return candidate;
}

function sanitizeFileName(value, fallback = 'audio') {
    let name = normalizeText(value, 180)
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
        .replace(/[. ]+$/g, '')
        .trim();
    if (!name || name === '.' || name === '..') name = fallback;
    return name.slice(0, 180);
}

function getHeader(response, name) {
    if (!response?.headers) return '';
    if (typeof response.headers.get === 'function') return String(response.headers.get(name) || '');
    const target = name.toLowerCase();
    for (const [key, value] of Object.entries(response.headers)) {
        if (key.toLowerCase() === target) return String(value ?? '');
    }
    return '';
}

function assertResponseSize(response, maxBytes) {
    const value = Number(getHeader(response, 'content-length'));
    if (Number.isFinite(value) && value > maxBytes) {
        throw new OnlineSourceError('Response is too large', 'response-too-large', { maxBytes, contentLength: value });
    }
}

async function readLimitedResponseBuffer(response, maxBytes = DEFAULT_LIMITS.maxResponseBytes) {
    const limit = Number.isFinite(Number(maxBytes)) && Number(maxBytes) > 0 ? Number(maxBytes) : DEFAULT_LIMITS.maxResponseBytes;
    assertResponseSize(response, limit);
    if (!response) throw new OnlineSourceError('Missing HTTP response', 'network-error');

    if (response.body && typeof response.body.getReader === 'function') {
        const reader = response.body.getReader();
        const chunks = [];
        let total = 0;
        try {
            while (true) {
                const item = await reader.read();
                if (item.done) break;
                const chunk = Buffer.from(item.value || []);
                total += chunk.length;
                if (total > limit) {
                    try { await reader.cancel(); } catch { /* best effort */ }
                    throw new OnlineSourceError('Response is too large', 'response-too-large', { maxBytes: limit });
                }
                chunks.push(chunk);
            }
        } finally {
            try { reader.releaseLock?.(); } catch { /* best effort */ }
        }
        return Buffer.concat(chunks, total);
    }
    if (typeof response.arrayBuffer === 'function') {
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > limit) throw new OnlineSourceError('Response is too large', 'response-too-large', { maxBytes: limit });
        return buffer;
    }
    if (typeof response.buffer === 'function') {
        const buffer = Buffer.from(await response.buffer());
        if (buffer.length > limit) throw new OnlineSourceError('Response is too large', 'response-too-large', { maxBytes: limit });
        return buffer;
    }
    if (typeof response.text === 'function') {
        const buffer = Buffer.from(await response.text(), 'utf8');
        if (buffer.length > limit) throw new OnlineSourceError('Response is too large', 'response-too-large', { maxBytes: limit });
        return buffer;
    }
    if (Buffer.isBuffer(response.body) || response.body instanceof Uint8Array) {
        const buffer = Buffer.from(response.body);
        if (buffer.length > limit) throw new OnlineSourceError('Response is too large', 'response-too-large', { maxBytes: limit });
        return buffer;
    }
    if (typeof response.body === 'string') {
        const buffer = Buffer.from(response.body, 'utf8');
        if (buffer.length > limit) throw new OnlineSourceError('Response is too large', 'response-too-large', { maxBytes: limit });
        return buffer;
    }
    throw new OnlineSourceError('Unsupported HTTP response body', 'network-error');
}

async function readLimitedResponseText(response, maxBytes) {
    const buffer = await readLimitedResponseBuffer(response, maxBytes);
    return buffer.toString('utf8');
}

async function writeAll(fileHandle, buffer) {
    let offset = 0;
    while (offset < buffer.length) {
        const { bytesWritten } = await fileHandle.write(buffer, offset, buffer.length - offset, null);
        if (!bytesWritten) {
            throw new OnlineSourceError('Unable to write downloaded audio', 'file-write-error');
        }
        offset += bytesWritten;
    }
}

async function writeLimitedResponseToFile(response, filePath, maxBytes = DEFAULT_LIMITS.maxDownloadBytes) {
    const limit = Number.isFinite(Number(maxBytes)) && Number(maxBytes) > 0
        ? Number(maxBytes)
        : DEFAULT_LIMITS.maxDownloadBytes;
    assertResponseSize(response, limit);
    if (!response) throw new OnlineSourceError('Missing HTTP response', 'network-error');

    const fileHandle = await fsp.open(filePath, 'wx');
    let reader = null;
    let total = 0;
    try {
        if (response.body && typeof response.body.getReader === 'function') {
            reader = response.body.getReader();
            while (true) {
                const item = await reader.read();
                if (item.done) break;
                const chunk = Buffer.from(item.value || []);
                total += chunk.length;
                if (total > limit) {
                    try { await reader.cancel(); } catch { /* best effort */ }
                    throw new OnlineSourceError('Response is too large', 'response-too-large', { maxBytes: limit });
                }
                await writeAll(fileHandle, chunk);
            }
            return total;
        }

        const body = await readLimitedResponseBuffer(response, limit);
        await writeAll(fileHandle, body);
        return body.length;
    } finally {
        try { reader?.releaseLock?.(); } catch { /* best effort */ }
        await fileHandle.close().catch(() => {});
    }
}

function getFetchImplementation(fetchImpl) {
    if (typeof fetchImpl === 'function') return fetchImpl;
    if (typeof globalThis.fetch === 'function') return globalThis.fetch.bind(globalThis);
    return null;
}

function requestWithNode(url, options = {}) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const transport = parsed.protocol === 'https:' ? https : http;
        const request = transport.request(parsed, {
            method: String(options.method || 'GET').toUpperCase(),
            headers: options.headers || {}
        }, response => {
            const chunks = [];
            let size = 0;
            const maxBytes = options.maxBytes || DEFAULT_LIMITS.maxResponseBytes;
            response.on('data', chunk => {
                size += chunk.length;
                if (size > maxBytes) {
                    request.destroy(new OnlineSourceError('Response is too large', 'response-too-large'));
                    return;
                }
                chunks.push(chunk);
            });
            response.on('end', () => resolve({
                status: response.statusCode || 0,
                statusCode: response.statusCode || 0,
                headers: response.headers,
                body: Buffer.concat(chunks, size)
            }));
            response.on('error', reject);
        });
        request.on('error', reject);
        if (options.signal) {
            if (options.signal.aborted) request.destroy(new Error('The request was aborted'));
            else options.signal.addEventListener('abort', () => request.destroy(new Error('The request was aborted')), { once: true });
        }
        if (options.body !== undefined) request.write(options.body);
        request.end();
    });
}

async function fetchWithLimits(url, options = {}) {
    const limits = mergeLimits(options.limits);
    const normalizedUrl = normalizeHttpUrl(url, { limits });
    const timeoutMs = Math.min(
        Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : limits.maxRequestTimeoutMs,
        limits.maxRequestTimeoutMs
    );
    if (options.signal?.aborted) throw new OnlineSourceError('Request was aborted', 'aborted');
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timedOut = false;
    let removeExternalAbortListener;
    if (controller && options.signal) {
        const onAbort = () => controller.abort();
        options.signal.addEventListener('abort', onAbort, { once: true });
        removeExternalAbortListener = () => options.signal.removeEventListener('abort', onAbort);
    }
    let timeoutHandle;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => {
            timedOut = true;
            controller?.abort();
            reject(new OnlineSourceError('Request timed out', 'timeout', { timeoutMs }));
        }, timeoutMs);
    });
    try {
        const fetchImpl = getFetchImplementation(options.fetch);
        let response;
        if (fetchImpl) {
            response = await Promise.race([fetchImpl(normalizedUrl, {
                method: options.method || 'GET',
                headers: options.headers,
                body: options.body,
                redirect: 'follow',
                signal: controller?.signal
            }), timeoutPromise]);
        } else {
            response = await Promise.race([requestWithNode(normalizedUrl, {
                method: options.method,
                headers: options.headers,
                body: options.body,
                signal: controller?.signal,
                maxBytes: options.maxBytes || limits.maxResponseBytes
            }), timeoutPromise]);
        }
        return response;
    } catch (error) {
        if (error instanceof OnlineSourceError) throw error;
        if (timedOut) throw new OnlineSourceError('Request timed out', 'timeout', { timeoutMs });
        if (options.signal?.aborted || controller?.signal.aborted) throw new OnlineSourceError('Request was aborted', 'aborted');
        throw new OnlineSourceError(error?.message || 'Network request failed', 'network-error', { cause: error });
    } finally {
        clearTimeout(timeoutHandle);
        removeExternalAbortListener?.();
    }
}

function assertOkResponse(response) {
    const status = Number(response?.status ?? response?.statusCode ?? 0);
    if (status && (status < 200 || status >= 300)) {
        throw new OnlineSourceError(`HTTP request failed (${status})`, 'http-error', { status });
    }
}

function prepareRequestBody(options, headers, limits) {
    let body = options.body;
    if (body === undefined && options.form !== undefined) {
        if (typeof options.form === 'string' || Buffer.isBuffer(options.form) || options.form instanceof Uint8Array) {
            body = options.form;
        } else if (options.form && typeof options.form === 'object') {
            body = new URLSearchParams(options.form).toString();
            if (!Object.keys(headers).some(key => key.toLowerCase() === 'content-type')) {
                headers['content-type'] = 'application/x-www-form-urlencoded';
            }
        }
    } else if (body === undefined && options.formData !== undefined) {
        body = prepareFormData(options.formData);
    }
    // A few source scripts pass a JSON object as `body`. Native fetch does not
    // serialize it, while LXMusic's needle bridge does; mirror that behavior.
    const isFormData = typeof FormData === 'function' && body instanceof FormData;
    const isBlob = typeof Blob === 'function' && body instanceof Blob;
    const isArrayBuffer = body instanceof ArrayBuffer;
    if (body && typeof body === 'object' && !Buffer.isBuffer(body) && !(body instanceof Uint8Array) && !isFormData && !isBlob && !isArrayBuffer && !(body instanceof URLSearchParams) && typeof body.getReader !== 'function') {
        body = JSON.stringify(body);
        if (!Object.keys(headers).some(key => key.toLowerCase() === 'content-type')) {
            headers['content-type'] = 'application/json';
        }
    }
    if (body !== undefined && body !== null) {
        let size = 0;
        if (typeof body === 'string') size = Buffer.byteLength(body);
        else if (Buffer.isBuffer(body) || body instanceof Uint8Array) size = body.byteLength;
        else if (body instanceof ArrayBuffer) size = body.byteLength;
        else if (isBlob) size = Number(body.size) || 0;
        else if (body instanceof URLSearchParams) size = Buffer.byteLength(body.toString());
        if (size > limits.maxResponseBytes) throw new OnlineSourceError('Request body is too large', 'request-too-large');
    }
    return body;
}

function isArrayBufferLike(value) {
    return value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}

function toBuffer(value, encoding) {
    if (Buffer.isBuffer(value)) return Buffer.from(value);
    if (typeof value === 'string') return Buffer.from(value, encoding);
    if (value == null) return Buffer.alloc(0);
    if (isArrayBufferLike(value)) {
        if (value instanceof ArrayBuffer) return Buffer.from(value);
        return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    }
    if (Array.isArray(value)) return Buffer.from(value);
    return Buffer.from(String(value), encoding);
}

function toCryptoInput(value, encoding) {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return Buffer.from(value, encoding);
    return toBuffer(value, encoding);
}

function hashInput(value) {
    if (Buffer.isBuffer(value) || isArrayBufferLike(value)) return toBuffer(value);
    return String(value);
}

function createZlibPromise(method, value) {
    return new Promise((resolve, reject) => {
        zlib[method](toBuffer(value), (error, result) => {
            if (error) reject(new Error(error.message));
            else resolve(result);
        });
    });
}

function appendFormDataValue(formData, name, inputValue) {
    let value = inputValue;
    let filename = '';
    let contentType = '';
    if (value && typeof value === 'object' && !isArrayBufferLike(value) && !Buffer.isBuffer(value) && Object.prototype.hasOwnProperty.call(value, 'value')) {
        const descriptor = value;
        value = descriptor.value;
        const descriptorOptions = descriptor.options && typeof descriptor.options === 'object' ? descriptor.options : descriptor;
        filename = normalizeText(descriptorOptions.filename || descriptorOptions.fileName, 180);
        contentType = normalizeText(descriptorOptions.contentType || descriptorOptions.content_type, 256);
    }
    if (typeof Blob === 'function' && value instanceof Blob) {
        if (filename) formData.append(name, value, filename);
        else formData.append(name, value);
        return;
    }
    if (isArrayBufferLike(value) || Buffer.isBuffer(value)) {
        if (typeof Blob !== 'function') throw new OnlineSourceError('FormData binary values are unsupported', 'unsupported-request-body');
        const blobOptions = contentType ? { type: contentType } : undefined;
        const blob = new Blob([toBuffer(value)], blobOptions);
        formData.append(name, blob, filename || `${sanitizeFileName(name, 'file')}.bin`);
        return;
    }
    formData.append(name, value == null ? '' : String(value));
}

function prepareFormData(value) {
    if (typeof FormData !== 'function') {
        throw new OnlineSourceError('FormData is unavailable in this runtime', 'unsupported-request-body');
    }
    if (value instanceof FormData) return value;
    if (!value || typeof value !== 'object') {
        throw new OnlineSourceError('formData must be an object', 'invalid-request-body');
    }
    const formData = new FormData();
    for (const [name, inputValue] of Object.entries(value)) {
        if (Array.isArray(inputValue)) {
            for (const item of inputValue) appendFormDataValue(formData, name, item);
        } else {
            appendFormDataValue(formData, name, inputValue);
        }
    }
    return formData;
}

function decodeCompressedScript(source, limits = mergeLimits()) {
    const text = String(source ?? '');
    if (!text.startsWith('gz_')) return text;
    const encoded = text.slice(3);
    if (encoded.length > limits.maxScriptBytes * 3) {
        throw new OnlineSourceError('Compressed script is too large', 'script-too-large');
    }
    try {
        const inflated = zlib.inflateSync(Buffer.from(encoded, 'base64'), { maxOutputLength: limits.maxScriptBytes });
        if (inflated.length > limits.maxScriptBytes) throw new Error('too large');
        return inflated.toString('utf8');
    } catch (error) {
        throw new OnlineSourceError('Invalid compressed script', 'invalid-script', { cause: error });
    }
}

function extractHeaderMetadata(source) {
    const match = /^\s*\/\*[\s\S]*?\*\//.exec(source);
    if (!match) return {};
    const values = {};
    const fieldPattern = /^\s?\*\s?@(name|description|author|homepage|version)\s+(.+)$/i;
    for (const line of match[0].split(/\r?\n/)) {
        const item = fieldPattern.exec(line);
        if (!item) continue;
        const key = item[1].toLowerCase();
        const limit = HEADER_FIELD_LIMITS[key];
        values[key] = normalizeText(item[2], limit);
    }
    return values;
}

function extractCallObject(source, callName, firstArgument = false) {
    const marker = new RegExp(`\\b${callName.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*\\(`, 'g');
    const match = marker.exec(source);
    if (!match) return null;
    let index = match.index + match[0].length;
    let depth = 0;
    let quote = '';
    let escaped = false;
    let lineComment = false;
    let blockComment = false;
    let argumentStart = index;
    let argumentEnd = -1;
    for (; index < source.length; index++) {
        const character = source[index];
        const next = source[index + 1];
        if (lineComment) {
            if (character === '\n') lineComment = false;
            continue;
        }
        if (blockComment) {
            if (character === '*' && next === '/') { blockComment = false; index++; }
            continue;
        }
        if (quote) {
            if (escaped) escaped = false;
            else if (character === '\\') escaped = true;
            else if (character === quote) quote = '';
            continue;
        }
        if (character === '/' && next === '/') { lineComment = true; index++; continue; }
        if (character === '/' && next === '*') { blockComment = true; index++; continue; }
        if (character === '\'' || character === '"' || character === '`') { quote = character; continue; }
        if (character === '{' || character === '[' || character === '(') { depth++; continue; }
        if (character === '}' || character === ']' || character === ')') {
            if (depth === 0) {
                argumentEnd = index;
                break;
            }
            depth--;
            continue;
        }
        if (character === ',' && depth === 0 && firstArgument) {
            argumentEnd = index;
            break;
        }
    }
    if (argumentEnd < argumentStart) return null;
    return source.slice(argumentStart, argumentEnd).trim();
}

function extractInitMetadata(source) {
    // Ensure the protocol's inited event is present before evaluating its
    // literal metadata argument.
    const initMatch = /\b(?:lx\s*\.\s*)?send\s*\(\s*(?:(['"])inited\1|(?:lx\s*\.\s*)?EVENT_NAMES\s*\.\s*inited)\s*,/i.exec(source);
    if (!initMatch) return null;
    const start = initMatch.index + initMatch[0].length;
    let index = start;
    let depth = 0;
    let quote = '';
    let escaped = false;
    for (; index < source.length; index++) {
        const character = source[index];
        if (quote) {
            if (escaped) escaped = false;
            else if (character === '\\') escaped = true;
            else if (character === quote) quote = '';
            continue;
        }
        if (character === '\'' || character === '"' || character === '`') { quote = character; continue; }
        if (character === '{' || character === '[' || character === '(') depth++;
        else if (character === '}' || character === ']' || character === ')') {
            if (depth === 0) break;
            depth--;
        } else if (character === ',' && depth === 0) break;
    }
    const objectText = source.slice(start, index).trim();
    if (!objectText) return null;
    try {
        return vm.runInNewContext(`(${objectText})`, Object.create(null), { timeout: 100 });
    } catch {
        return null;
    }
}

function normalizeSourceId(value) {
    const id = normalizeText(value, 64).toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    return id || '';
}

function normalizeMetadata(value, fallback = {}) {
    const input = value && typeof value === 'object' ? value : {};
    const result = {
        id: normalizeSourceId(input.id || fallback.id),
        name: normalizeText(input.name || fallback.name, HEADER_FIELD_LIMITS.name),
        description: normalizeText(input.description || fallback.description, HEADER_FIELD_LIMITS.description),
        author: normalizeText(input.author || fallback.author, HEADER_FIELD_LIMITS.author),
        homepage: normalizeText(input.homepage || fallback.homepage, HEADER_FIELD_LIMITS.homepage),
        version: normalizeText(input.version || fallback.version, HEADER_FIELD_LIMITS.version),
        sources: {}
    };
    const sources = input.sources && typeof input.sources === 'object' ? input.sources : {};
    for (const [rawId, rawInfo] of Object.entries(sources)) {
        const sourceId = normalizeSourceId(rawId);
        if (!sourceId || !rawInfo || typeof rawInfo !== 'object') continue;
        const declaredActions = Array.isArray(rawInfo.actions)
            ? rawInfo.actions
            : typeof rawInfo.actions === 'string'
                ? rawInfo.actions.split(/[\s,|]+/).filter(Boolean)
                : [];
        const actions = Array.from(new Set(declaredActions.filter(action => SUPPORTED_ACTIONS.has(action))));
        const qualitys = Array.from(new Set((Array.isArray(rawInfo.qualitys) ? rawInfo.qualitys : []).filter(quality => SUPPORTED_QUALITIES.has(quality))));
        if (rawInfo.type === 'music' && actions.length) {
            result.sources[sourceId] = {
                name: normalizeText(rawInfo.name, 128),
                type: 'music',
                actions,
                qualitys
            };
        }
    }
    return result;
}

function isSearchRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function searchIdentifier(value, maxLength = 128) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') {
        if (value.id !== undefined) return searchIdentifier(value.id, maxLength);
        if (value.value !== undefined) return searchIdentifier(value.value, maxLength);
        if (value.name !== undefined) return searchIdentifier(value.name, maxLength);
    }
    return normalizeText(value, maxLength);
}

function firstSearchValue(...values) {
    for (const value of values) {
        if (value === null || value === undefined) continue;
        if (typeof value === 'string' && !value.trim()) continue;
        return value;
    }
    return undefined;
}

function normalizeSearchSinger(value) {
    if (Array.isArray(value)) {
        return value
            .map(item => normalizeSearchSinger(item))
            .filter(Boolean)
            .join(', ');
    }
    if (value && typeof value === 'object') {
        return normalizeText(firstSearchValue(value.name, value.singer, value.artist, value.title), 512);
    }
    return normalizeText(value, 512);
}

function createSearchCloneState(limits) {
    return {
        limits,
        bytes: 0,
        seen: new WeakSet()
    };
}

function cloneSearchValue(value, state, depth = 0) {
    const limits = state.limits;
    if (value === null) return null;
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return undefined;
    if (typeof value === 'string') {
        const remaining = Math.max(0, limits.maxSearchItemBytes - state.bytes);
        if (!remaining) return '';
        let text = value;
        if (Buffer.byteLength(text, 'utf8') > remaining) {
            text = text.slice(0, Math.min(text.length, remaining));
            while (text && Buffer.byteLength(text, 'utf8') > remaining) {
                text = text.slice(0, -1);
            }
        }
        state.bytes += Buffer.byteLength(text, 'utf8');
        return text;
    }
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'bigint') return value.toString();
    if (depth >= limits.maxSearchObjectDepth || !value || typeof value !== 'object') return undefined;
    if (state.seen.has(value)) return undefined;
    state.seen.add(value);
    if (Array.isArray(value)) {
        const result = [];
        const count = Math.min(value.length, limits.maxSearchArrayItems);
        for (let index = 0; index < count && state.bytes < limits.maxSearchItemBytes; index++) {
            const cloned = cloneSearchValue(value[index], state, depth + 1);
            if (cloned !== undefined) result.push(cloned);
        }
        return result;
    }
    const result = {};
    const keys = Object.keys(value).slice(0, limits.maxSearchObjectKeys);
    for (const key of keys) {
        if (state.bytes >= limits.maxSearchItemBytes || key === '__proto__' || key === 'prototype' || key === 'constructor') {
            continue;
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
            continue;
        }
        const cloned = cloneSearchValue(descriptor.value, state, depth + 1);
        if (cloned !== undefined) {
            result[key] = cloned;
        }
    }
    return result;
}

function cloneSearchInfo(value, limits) {
    const cloned = cloneSearchValue(value, createSearchCloneState(limits));
    return isSearchRecord(cloned) ? cloned : {};
}

function searchContextFromRecord(value, context) {
    const result = { ...context };
    const source = firstSearchValue(
        value.sourceId,
        value.source,
        value.source_id,
        value.meta?.sourceId,
        value.meta?.source,
        value.platform,
        value.vendor
    );
    const provider = firstSearchValue(
        value.providerId,
        value.provider,
        value.provider_id,
        value.meta?.providerId,
        value.meta?.provider,
        value.providerName
    );
    if (source !== undefined) result.source = searchIdentifier(source);
    if (provider !== undefined) result.provider = searchIdentifier(provider);
    return result;
}

function looksLikeSearchItem(value) {
    if (!isSearchRecord(value)) return false;
    if (isSearchRecord(value.musicInfo) || isSearchRecord(value.music) || isSearchRecord(value.song) || isSearchRecord(value.track)) return true;
    // A response wrapper may carry a descriptive `name` alongside `list` or
    // `data`; do not mistake that metadata for an individual song.
    if (SEARCH_RESULT_CONTAINER_KEYS.some(key => Object.prototype.hasOwnProperty.call(value, key)) && !firstSearchValue(
        value.title,
        value.songName,
        value.SongName,
        value.musicName,
        value.singer,
        value.singerName,
        value.SingerName,
        value.artist,
        value.Artist,
        value.ArtistName,
        value.songId,
        value.songmid,
        value.mid,
        value.id
    )) return false;
    return Boolean(firstSearchValue(
        value.title,
        value.name,
        value.songName,
        value.SongName,
        value.musicName,
        value.music_name,
        value.singer,
        value.singerName,
        value.SingerName,
        value.artist,
        value.Artist,
        value.ArtistName,
        value.songId,
        value.songmid,
        value.mid,
        value.id
    ) !== undefined);
}

const SEARCH_RESULT_CONTAINER_KEYS = Object.freeze([
    'list',
    'items',
    'results',
    'songs',
    'tracks',
    'records',
    'songlist',
    'musicList',
    'musics',
    'data',
    'result',
    'content',
    'rows'
]);

function collectSearchItems(value, context, entries, limits, depth = 0, seen = new Set()) {
    if (entries.length >= limits.maxSearchResults || value === null || value === undefined || depth > 8) return;
    if (typeof value === 'string') {
        const text = value.trim();
        if (!text || (!text.startsWith('{') && !text.startsWith('[')) || Buffer.byteLength(text, 'utf8') > limits.maxResponseBytes) return;
        try { collectSearchItems(JSON.parse(text), context, entries, limits, depth + 1, seen); } catch { /* plain text is not a result list */ }
        return;
    }
    if (Array.isArray(value)) {
        const count = Math.min(value.length, Math.max(limits.maxSearchResults * 2, limits.maxSearchArrayItems));
        for (let index = 0; index < count; index++) {
            collectSearchItems(value[index], context, entries, limits, depth + 1, seen);
            if (entries.length >= limits.maxSearchResults) break;
        }
        return;
    }
    if (!isSearchRecord(value)) return;
    if (seen.has(value)) return;
    seen.add(value);

    const nextContext = searchContextFromRecord(value, context);
    if (looksLikeSearchItem(value)) {
        entries.push({ value, context: nextContext });
        return;
    }

    const visitedKeys = new Set();
    for (const key of SEARCH_RESULT_CONTAINER_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        visitedKeys.add(key);
        collectSearchItems(value[key], nextContext, entries, limits, depth + 1, seen);
        if (entries.length >= limits.maxSearchResults) return;
    }

    // Some source scripts return `{ kg: [...], wy: [...] }` rather than a
    // wrapper with a `list` field. Treat each unknown key as a provider hint.
    for (const key of Object.keys(value).slice(0, limits.maxSearchObjectKeys)) {
        const child = value[key];
        if (visitedKeys.has(key) || /^(?:total|allPage|page|limit|pages|count|hasMore)$/i.test(key)) continue;
        if (!Array.isArray(child) && !isSearchRecord(child)) continue;
        const childContext = { ...nextContext };
        if (!childContext.source && !childContext.provider) childContext.source = searchIdentifier(key);
        collectSearchItems(child, childContext, entries, limits, depth + 1, seen);
        if (entries.length >= limits.maxSearchResults) return;
    }
}

function normalizeSearchItem(rawValue, context = {}, limits = mergeLimits()) {
    const raw = isSearchRecord(rawValue) ? rawValue : {};
    const nested = [raw.musicInfo, raw.music, raw.song, raw.track]
        .find(value => isSearchRecord(value));
    const info = cloneSearchInfo(nested || raw, limits);
    const source = searchIdentifier(firstSearchValue(
        raw.sourceId,
        raw.source,
        raw.source_id,
        nested?.sourceId,
        nested?.source,
        nested?.source_id,
        raw.meta?.sourceId,
        raw.meta?.source,
        nested?.meta?.sourceId,
        nested?.meta?.source,
        context.source
    ));
    const provider = searchIdentifier(firstSearchValue(
        raw.providerId,
        raw.provider,
        nested?.providerId,
        nested?.provider,
        raw.meta?.providerId,
        raw.meta?.provider,
        nested?.meta?.providerId,
        nested?.meta?.provider,
        context.provider
    ));
    const title = normalizeText(firstSearchValue(
        raw.title,
        raw.name,
        raw.songName,
        raw.SongName,
        raw.musicName,
        raw.music_name,
        nested?.title,
        nested?.name,
        nested?.songName,
        nested?.SongName,
        nested?.musicName,
        nested?.music_name,
        raw.meta?.title,
        raw.meta?.name,
        nested?.meta?.title,
        nested?.meta?.name
    ), 512);
    const singer = normalizeSearchSinger(firstSearchValue(
        raw.singer,
        raw.singerName,
        raw.SingerName,
        raw.artist,
        raw.Artist,
        raw.ArtistName,
        raw.artists,
        raw.author,
        nested?.singer,
        nested?.singerName,
        nested?.SingerName,
        nested?.artist,
        nested?.Artist,
        nested?.ArtistName,
        nested?.artists,
        nested?.author,
        raw.meta?.singer,
        raw.meta?.artist,
        nested?.meta?.singer,
        nested?.meta?.artist
    ));
    const album = normalizeText(firstSearchValue(
        raw.album,
        raw.albumName,
        raw.AlbumName,
        nested?.album,
        nested?.albumName,
        nested?.AlbumName,
        raw.meta?.album,
        raw.meta?.albumName,
        nested?.meta?.album,
        nested?.meta?.albumName
    ), 512);
    const idValue = firstSearchValue(
        raw.id,
        raw.songId,
        raw.songid,
        raw.SongId,
        raw.songmid,
        raw.songMid,
        raw.mid,
        raw.musicId,
        raw.hash,
        nested?.id,
        nested?.songId,
        nested?.songid,
        nested?.SongId,
        nested?.songmid,
        nested?.songMid,
        nested?.mid,
        nested?.musicId,
        nested?.hash,
        raw.meta?.id,
        raw.meta?.songId,
        nested?.meta?.id,
        nested?.meta?.songId
    );
    const id = searchIdentifier(idValue);
    const durationValue = Number(firstSearchValue(
        raw.duration,
        raw.durationMs,
        raw.interval,
        raw.time,
        nested?.duration,
        nested?.durationMs,
        nested?.interval,
        nested?.time,
        raw.meta?.duration,
        raw.meta?.durationMs,
        nested?.meta?.duration,
        nested?.meta?.durationMs
    ));
    const duration = Number.isFinite(durationValue) && durationValue > 0
        ? Math.min(Math.floor(durationValue), 24 * 60 * 60 * 1000)
        : 0;

    if (title && info.title === undefined) info.title = title;
    if (title && info.name === undefined) info.name = title;
    if (singer && info.singer === undefined) info.singer = singer;
    if (singer && info.artist === undefined) info.artist = singer;
    if (album && info.album === undefined) info.album = album;
    if (album && info.albumName === undefined) info.albumName = album;
    if (duration && info.duration === undefined) info.duration = duration;
    if (source && info.source === undefined) info.source = source;
    if (provider && info.provider === undefined) info.provider = provider;
    if (id && info.id === undefined) info.id = id;

    const result = { musicInfo: info, title, singer };
    if (title) result.name = title;
    if (singer) result.artist = singer;
    if (album) result.album = album;
    if (duration) result.duration = duration;
    if (source) {
        result.source = source;
        result.sourceId = searchIdentifier(firstSearchValue(raw.sourceId, source));
    }
    if (provider) {
        result.provider = provider;
        result.providerId = searchIdentifier(firstSearchValue(raw.providerId, provider));
    }
    if (id) result.id = id;
    return result;
}

/**
 * Normalize the result of a Toolbox search extension. LXMusic itself does not
 * define a search action, so accepting a few common wrappers keeps imported
 * source scripts useful without imposing a new script runtime API.
 */
function normalizeSearchResults(value, options = {}) {
    const limits = mergeLimits(options.limits);
    const maxResults = Math.max(1, Math.min(
        limits.maxSearchResults,
        Number.isFinite(Number(options.maxResults)) && Number(options.maxResults) > 0
            ? Math.floor(Number(options.maxResults))
            : limits.maxSearchResults
    ));
    const workingLimits = { ...limits, maxSearchResults: maxResults };
    let input = value;
    if (typeof input === 'string') {
        const text = input.trim();
        if (!text || Buffer.byteLength(text, 'utf8') > limits.maxResponseBytes) return [];
        try { input = JSON.parse(text); } catch { return []; }
    }
    const context = {
        source: searchIdentifier(firstSearchValue(options.sourceId, options.source)),
        provider: searchIdentifier(firstSearchValue(options.providerId, options.provider))
    };
    const entries = [];
    try {
        collectSearchItems(input, context, entries, workingLimits);
    } catch {
        // A source may return an object with hostile getters. Do not let that
        // object escape the adapter or break the voice panel.
        return [];
    }
    return entries.map(entry => {
        try { return normalizeSearchItem(entry.value, entry.context, limits); } catch { return null; }
    }).filter(Boolean);
}

function validateLXMusicUserApiScript(source, options = {}) {
    const limits = mergeLimits(options.limits);
    const decoded = decodeCompressedScript(source, limits);
    if (Buffer.byteLength(decoded, 'utf8') > limits.maxScriptBytes) {
        throw new OnlineSourceError('Script is too large', 'script-too-large', { maxBytes: limits.maxScriptBytes });
    }
    if (!decoded.trim()) throw new OnlineSourceError('Script is empty', 'invalid-script');
    if (BLOCKED_SCRIPT_TOKENS.test(decoded)) {
        throw new OnlineSourceError('Script uses a blocked API', 'unsafe-script');
    }
    try {
        new vm.Script(decoded, { displayErrors: true });
    } catch (error) {
        throw new OnlineSourceError(`Invalid script: ${error.message}`, 'invalid-script', { cause: error });
    }
    const hasInitEvent = /\b(?:lx\s*\.\s*)?send\s*\(\s*(?:(['"])inited\1|(?:lx\s*\.\s*)?EVENT_NAMES\s*\.\s*inited)\s*,/i.test(decoded);
    const hasRequestEvent = /\b(?:lx\s*\.\s*)?on\s*\(\s*(?:(['"])request\1|(?:lx\s*\.\s*)?EVENT_NAMES\s*\.\s*request)\s*,/i.test(decoded);
    if (!hasInitEvent || !hasRequestEvent) {
        throw new OnlineSourceError('Script does not use the LXMusic API', 'invalid-script');
    }
    const header = extractHeaderMetadata(decoded);
    const init = extractInitMetadata(decoded);
    const metadata = normalizeMetadata({ ...header, ...(init || {}) }, options.metadata || {});
    if (!metadata.name) metadata.name = normalizeText(options.name, HEADER_FIELD_LIMITS.name);
    if (!metadata.name) metadata.name = '在线音源';
    const hash = crypto.createHash('sha256').update(decoded).digest('hex');
    return { source: decoded, metadata, hash };
}

function parseLXMusicScriptMetadata(source, options = {}) {
    try {
        return validateLXMusicUserApiScript(source, { ...options, allowUnknownSources: true }).metadata;
    } catch (error) {
        if (options.throwOnError) throw error;
        return null;
    }
}

function validateExternalPluginScript(source, format, options = {}) {
    const limits = mergeLimits(options.limits);
    const decoded = decodeCompressedScript(source, limits);
    if (Buffer.byteLength(decoded, 'utf8') > limits.maxScriptBytes) {
        throw new OnlineSourceError('Script is too large', 'script-too-large', { maxBytes: limits.maxScriptBytes });
    }
    if (!decoded.trim()) throw new OnlineSourceError('Script is empty', 'invalid-script');
    // These source formats need `module.exports` (CeruMusic) or `globalThis`
    // (QT MusicPlugin), so they cannot use LXMusic's stricter token rule.
    // Keep Node/module escape hatches unavailable in both the static check and
    // the VM context below.
    if (/(?:\b(?:require|process|Buffer|WebAssembly|import|export|eval|Function|constructor|prototype)\b|__proto__|child_process|worker_threads|node:)/.test(decoded)) {
        throw new OnlineSourceError('Script uses a blocked API', 'unsafe-script');
    }
    try {
        new vm.Script(decoded, { displayErrors: true });
    } catch (error) {
        throw new OnlineSourceError(`Invalid script: ${error.message}`, 'invalid-script', { cause: error });
    }
    if (format === 'cerumusic' && !/\bmodule\s*\.\s*exports\b/.test(decoded)) {
        throw new OnlineSourceError('Script does not use the CeruMusic plugin API', 'invalid-script');
    }
    if (format === 'qt-music' && !/\bMusicPlugin\b/.test(decoded)) {
        throw new OnlineSourceError('Script does not use the QT MusicPlugin API', 'invalid-script');
    }
    return decoded;
}

function detectOnlineSourceFormat(source, options = {}) {
    let decoded;
    try {
        decoded = decodeCompressedScript(source, mergeLimits(options.limits));
    } catch (error) {
        if (options.throwOnError) throw error;
        return '';
    }
    if (/\b(?:lx\s*\.\s*)?(?:send|on)\s*\(/.test(decoded)) {
        const hasInitEvent = /\b(?:lx\s*\.\s*)?send\s*\(\s*(?:(['"])inited\1|(?:lx\s*\.\s*)?EVENT_NAMES\s*\.\s*inited)\s*,/i.test(decoded);
        const hasRequestEvent = /\b(?:lx\s*\.\s*)?on\s*\(\s*(?:(['"])request\1|(?:lx\s*\.\s*)?EVENT_NAMES\s*\.\s*request)\s*,/i.test(decoded);
        if (hasInitEvent && hasRequestEvent) return 'lxmusic';
    }
    if (/\bmodule\s*\.\s*exports\b/.test(decoded) && /\bcerumusic\b/i.test(decoded)) return 'cerumusic';
    if (/\bMusicPlugin\b/.test(decoded) && /\b(?:customFetch|getMusicUrl)\b/.test(decoded)) return 'qt-music';
    if (/\bmodule\s*\.\s*exports\b/.test(decoded) &&
        /\b(?:getMediaSource|supportedQualities|supportedSearchType)\b/.test(decoded)) return MUSICFREE_SOURCE_FORMAT;
    return '';
}

function decodeMusicFreeModuleExport(value, sourceName, providerIdHint) {
    const exported = value && typeof value === 'object' ? value : {};
    const platform = normalizeText(exported.platform, HEADER_FIELD_LIMITS.name) ||
        normalizeText(sourceName, HEADER_FIELD_LIMITS.name) || 'MusicFree';
    const supportedQualities = Array.isArray(exported.supportedQualities)
        ? exported.supportedQualities.filter(quality => SUPPORTED_QUALITIES.has(quality))
        : [];
    const canSearch = typeof exported.search === 'function';
    const canResolve = typeof exported.getMediaSource === 'function';
    if (!canSearch && !canResolve) {
        throw new OnlineSourceError('MusicFree module does not expose search or getMediaSource', 'invalid-script');
    }
    // MusicFree's `platform` is a display label and can be localized. The
    // manifest URL, however, has a stable module name (`kg`, `tx`, `wy`, ...)
    // which must survive persistence and be accepted by a later runner.
    const providerId = normalizeSourceId(providerIdHint || exported.id || exported.platform || sourceName) || 'musicfree';
    return {
        metadata: normalizeMetadata({
            name: platform,
            author: exported.author,
            version: exported.version,
            homepage: exported.srcUrl,
            sources: {
                [providerId]: {
                    name: platform,
                    type: 'music',
                    actions: [
                        ...(canResolve ? ['musicUrl'] : []),
                        ...(canSearch ? ['search'] : [])
                    ],
                    qualitys: supportedQualities
                }
            }
        }),
        providerId,
        canSearch,
        canResolve
    };
}

function normalizeMusicFreeInput(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
    if (value instanceof ArrayBuffer) return Buffer.from(value).toString('utf8');
    return String(value);
}

function createMusicFreeWordArray(value, encoding = 'utf8') {
    const bytes = toBuffer(value, encoding);
    const wordArray = Object.create(null);
    Object.assign(wordArray, {
        sigBytes: bytes.length,
        toString(format) {
            const name = format && typeof format === 'object' ? format.name : String(format || 'hex').toLowerCase();
            if (name === 'utf8') return bytes.toString('utf8');
            if (name === 'base64') return bytes.toString('base64');
            return bytes.toString('hex');
        }
    });
    // Keep host Buffers entirely in the host closure. The VM only receives a
    // small, immutable CryptoJS-compatible value object.
    MUSICFREE_WORD_ARRAY_BYTES.set(wordArray, bytes);
    return Object.freeze(wordArray);
}

function musicFreeWordArrayBuffer(value, encoding = 'utf8') {
    const bytes = value && typeof value === 'object' ? MUSICFREE_WORD_ARRAY_BYTES.get(value) : null;
    if (Buffer.isBuffer(bytes)) {
        return Buffer.from(bytes);
    }
    return toBuffer(value, encoding);
}

function createMusicFreeCryptoJs() {
    const format = name => Object.freeze({ name });
    const utf8 = format('utf8');
    const base64 = format('base64');
    const hex = format('hex');
    const parse = encoding => value => createMusicFreeWordArray(value, encoding);
    const digest = (algorithm, value, key) => {
        const input = musicFreeWordArrayBuffer(value);
        const output = key === undefined
            ? crypto.createHash(algorithm).update(input).digest()
            : crypto.createHmac(algorithm, musicFreeWordArrayBuffer(key)).update(input).digest();
        return createMusicFreeWordArray(output);
    };
    return Object.freeze({
        MD5: value => digest('md5', value),
        HmacSHA256: (value, key) => digest('sha256', value, key),
        AES: Object.freeze({
            encrypt(value, key, options = {}) {
                const keyBytes = musicFreeWordArrayBuffer(key);
                const ivBytes = options?.iv === undefined ? null : musicFreeWordArrayBuffer(options.iv);
                if (![16, 24, 32].includes(keyBytes.length)) {
                    throw new OnlineSourceError('MusicFree AES key length is unsupported', 'unsupported-dependency', { name: 'crypto-js' });
                }
                if (ivBytes && ivBytes.length !== 16) {
                    throw new OnlineSourceError('MusicFree AES-CBC IV must be 16 bytes', 'unsupported-dependency', { name: 'crypto-js' });
                }
                const cipher = crypto.createCipheriv(`aes-${keyBytes.length * 8}-cbc`, keyBytes, ivBytes || Buffer.alloc(16));
                const encrypted = Buffer.concat([cipher.update(musicFreeWordArrayBuffer(value)), cipher.final()]);
                return Object.freeze({
                    ciphertext: createMusicFreeWordArray(encrypted),
                    toString: () => encrypted.toString('base64')
                });
            }
        }),
        enc: Object.freeze({
            Utf8: Object.freeze({ parse: parse('utf8') }),
            Base64: Object.freeze({ parse: parse('base64') }),
            Hex: Object.freeze({ parse: parse('hex') })
        }),
        mode: Object.freeze({ CBC: 'CBC' })
    });
}

function createMusicFreeBigInteger() {
    const maxBits = 16_384;
    const normalize = (value, radix = 10) => {
        const knownValue = value && typeof value === 'object' ? MUSICFREE_BIG_INTEGER_VALUES.get(value) : undefined;
        if (typeof knownValue === 'bigint') return knownValue;
        const base = Number(radix);
        if (!Number.isInteger(base) || base < 2 || base > 36) {
            throw new OnlineSourceError('MusicFree big-integer radix is unsupported', 'unsupported-dependency', { name: 'big-integer' });
        }
        const text = String(value ?? '').trim().toLowerCase();
        if (!text || text.length > 8192 || !/^-?[0-9a-z]+$/.test(text)) {
            throw new OnlineSourceError('MusicFree big-integer input is invalid', 'unsupported-dependency', { name: 'big-integer' });
        }
        let sign = 1n;
        let index = 0;
        if (text.startsWith('-')) {
            sign = -1n;
            index = 1;
        }
        let output = 0n;
        for (; index < text.length; index += 1) {
            const digit = Number.parseInt(text[index], 36);
            if (!Number.isInteger(digit) || digit >= base) {
                throw new OnlineSourceError('MusicFree big-integer input is invalid', 'unsupported-dependency', { name: 'big-integer' });
            }
            output = output * BigInt(base) + BigInt(digit);
            if (output !== 0n && output.toString(2).length > maxBits) {
                throw new OnlineSourceError('MusicFree big-integer input is too large', 'unsupported-dependency', { name: 'big-integer' });
            }
        }
        return output * sign;
    };
    const wrap = value => {
        const wrapped = Object.create(null);
        Object.assign(wrapped, {
            toString(radix = 10) {
                const base = Number(radix);
                if (!Number.isInteger(base) || base < 2 || base > 36) {
                    throw new OnlineSourceError('MusicFree big-integer radix is unsupported', 'unsupported-dependency', { name: 'big-integer' });
                }
                return value.toString(base);
            },
            modPow(exponent, modulus) {
                let base = value;
                const power = normalize(exponent);
                const mod = normalize(modulus);
                if (power < 0n || mod <= 0n) {
                    throw new OnlineSourceError('MusicFree big-integer operation is unsupported', 'unsupported-dependency', { name: 'big-integer' });
                }
                base = ((base % mod) + mod) % mod;
                let result = 1n;
                let remaining = power;
                while (remaining > 0n) {
                    if (remaining & 1n) result = (result * base) % mod;
                    remaining >>= 1n;
                    if (remaining) base = (base * base) % mod;
                }
                return wrap(result);
            }
        });
        MUSICFREE_BIG_INTEGER_VALUES.set(wrapped, value);
        return Object.freeze(wrapped);
    };
    return (value, radix) => wrap(normalize(value, radix));
}

function decodeMusicFreeEntities(value) {
    return String(value ?? '')
        .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
        .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&amp;/gi, '&');
}

function createMusicFreeCheerio() {
    const textContent = value => decodeMusicFreeEntities(String(value ?? '').replace(/<[^>]*>/g, ''));
    const emptySelection = () => Object.freeze({
        tagName: '',
        text: () => '',
        html: () => '',
        attr: () => undefined,
        children: () => emptySelection(),
        find: () => emptySelection(),
        map: () => Object.freeze({ toArray: () => [] }),
        toArray: () => []
    });
    // The voice panel only calls MusicFree's music search and URL resolver.
    // Keep Cheerio deliberately shallow: title/text decoding works, while the
    // playlist/artist HTML traversals that need a real DOM are not exposed.
    return Object.freeze({
        load(html) {
            const documentText = textContent(html);
            const select = selector => {
                const requested = String(selector ?? '');
                const idMatch = /^#([a-zA-Z0-9_-]+)$/.exec(requested);
                if (idMatch) {
                    const element = new RegExp(`<([a-z0-9]+)(?:[^>]*\\bid=["']${idMatch[1].replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}["'][^>]*)?>([\\s\\S]*?)<\\/\\1>`, 'i').exec(String(html ?? ''));
                    if (!element) return emptySelection();
                    const content = element[2];
                    return Object.freeze({
                        tagName: element[1].toLowerCase(),
                        text: () => textContent(content),
                        html: () => content,
                        attr: () => undefined,
                        children: () => emptySelection(),
                        find: () => emptySelection(),
                        map: () => Object.freeze({ toArray: () => [] }),
                        toArray: () => []
                    });
                }
                return Object.freeze({
                    tagName: '',
                    text: () => documentText,
                    html: () => String(html ?? ''),
                    attr: () => undefined,
                    children: () => emptySelection(),
                    find: () => emptySelection(),
                    map: () => Object.freeze({ toArray: () => [] }),
                    toArray: () => []
                });
            };
            return select;
        }
    });
}

function musicFreeProviderCapabilities(providerId, metadata) {
    const id = normalizeSourceId(providerId);
    const sourceInfo = metadata?.sources?.[id];
    return Object.freeze({
        providerId: id,
        searchable: Boolean(sourceInfo?.actions?.includes('search')),
        playable: Boolean(sourceInfo?.actions?.includes('musicUrl'))
    });
}

function makeMusicFreeAxiosBridge(options, state) {
    const limits = mergeLimits(options.limits);
    const send = async(requestOptions = {}) => {
        if (!state.requestsEnabled) {
            throw new OnlineSourceError('Network access is unavailable during source initialization', 'initialization-network-blocked');
        }
        const input = requestOptions && typeof requestOptions === 'object' ? requestOptions : {};
        const headers = {};
        for (const [key, value] of Object.entries(input.headers || {})) {
            const normalized = normalizeText(value, limits.maxHeaderValueLength);
            if (normalized) headers[key] = normalized;
        }
        let url = normalizeHttpUrl(input.url, { limits });
        if (input.params && typeof input.params === 'object') {
            const parsed = new URL(url);
            for (const [key, value] of Object.entries(input.params)) {
                if (value === undefined || value === null) continue;
                if (Array.isArray(value)) {
                    for (const item of value) parsed.searchParams.append(key, String(item));
                } else {
                    parsed.searchParams.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
                }
            }
            url = normalizeHttpUrl(parsed.href, { limits });
        }
        let body = input.data;
        if (body === undefined) body = input.body;
        body = prepareRequestBody({ body }, headers, limits);
        const response = await fetchWithLimits(url, {
            fetch: options.fetch,
            method: String(input.method || 'GET').toUpperCase(),
            headers,
            body,
            timeoutMs: input.timeout,
            limits,
            maxBytes: limits.maxResponseBytes
        });
        const raw = await readLimitedResponseBuffer(response, limits.maxResponseBytes);
        let data = raw.toString('utf8');
        if (input.responseType === 'arraybuffer') data = new Uint8Array(raw);
        else {
            try { data = JSON.parse(data); } catch { /* Preserve text responses. */ }
        }
        const status = Number(response.status ?? response.statusCode ?? 0);
        if (status && (status < 200 || status >= 300)) {
            const error = new OnlineSourceError(`HTTP request failed (${status})`, 'http-error', { status });
            error.response = { status, data, headers: response.headers || {} };
            throw error;
        }
        return {
            data,
            status,
            statusText: normalizeText(response.statusText, 256),
            headers: response.headers || {},
            config: input
        };
    };
    const axios = requestOptions => send(requestOptions);
    axios.get = (url, config = {}) => send({ ...config, url, method: 'GET' });
    axios.delete = (url, config = {}) => send({ ...config, url, method: 'DELETE' });
    axios.head = (url, config = {}) => send({ ...config, url, method: 'HEAD' });
    axios.post = (url, data, config = {}) => send({ ...config, url, data, method: 'POST' });
    axios.put = (url, data, config = {}) => send({ ...config, url, data, method: 'PUT' });
    axios.patch = (url, data, config = {}) => send({ ...config, url, data, method: 'PATCH' });
    axios.create = defaults => {
        const instance = requestOptions => send({ ...(defaults || {}), ...(requestOptions || {}) });
        for (const method of ['get', 'delete', 'head']) {
            instance[method] = (url, config = {}) => send({ ...(defaults || {}), ...config, url, method: method.toUpperCase() });
        }
        for (const method of ['post', 'put', 'patch']) {
            instance[method] = (url, data, config = {}) => send({ ...(defaults || {}), ...config, url, data, method: method.toUpperCase() });
        }
        return instance;
    };
    axios.isAxiosError = error => Boolean(error?.response || error?.config);
    axios.default = axios;
    return axios;
}

function createMusicFreeRequire(options, state) {
    const axios = makeMusicFreeAxiosBridge(options, state);
    const modules = Object.freeze({
        axios: axios,
        he: Object.freeze({ decode: decodeMusicFreeEntities, encode: value => String(value ?? '') }),
        qs: Object.freeze({ stringify: value => new URLSearchParams(value || {}).toString() }),
        dayjs: Object.assign(value => ({
            format: () => {
                const date = new Date(value ?? Date.now());
                const year = date.getFullYear();
                const month = String(date.getMonth() + 1).padStart(2, '0');
                const day = String(date.getDate()).padStart(2, '0');
                return `${year}-${month}-${day}`;
            }
        }), {
            unix: value => ({
                format: () => {
                    const date = new Date(Number(value) * 1000);
                    const year = date.getFullYear();
                    const month = String(date.getMonth() + 1).padStart(2, '0');
                    const day = String(date.getDate()).padStart(2, '0');
                    return `${year}-${month}-${day}`;
                }
            })
        }),
        cheerio: createMusicFreeCheerio(),
        'crypto-js': createMusicFreeCryptoJs(),
        'big-integer': createMusicFreeBigInteger()
    });
    return name => {
        const key = String(name || '');
        if (!Object.prototype.hasOwnProperty.call(modules, key)) {
            throw new OnlineSourceError(`MusicFree dependency ${key} is not allowed`, 'unsafe-script');
        }
        return modules[key];
    };
}

function createMusicFreeSourceRunner(scriptSource, options = {}) {
    const limits = mergeLimits(options.limits);
    const source = decodeCompressedScript(scriptSource, limits);
    if (Buffer.byteLength(source, 'utf8') > limits.maxScriptBytes) {
        throw new OnlineSourceError('Script is too large', 'script-too-large', { maxBytes: limits.maxScriptBytes });
    }
    if (!source.trim() || !/\bmodule\s*\.\s*exports\b/.test(source)) {
        throw new OnlineSourceError('Script does not use the MusicFree module API', 'invalid-script');
    }
    if (/(?:\b(?:process|Buffer|WebAssembly|import|export|eval|Function|constructor|prototype)\b|__proto__|child_process|worker_threads|node:)/.test(source)) {
        throw new OnlineSourceError('Script uses a blocked API', 'unsafe-script');
    }
    const state = { disposed: false, requestsEnabled: false, timers: new Set() };
    const module = { exports: {} };
    const timerSet = (callback, delay = 0, ...args) => {
        if (state.disposed || typeof callback !== 'function' || state.timers.size >= limits.maxTimers) return 0;
        const timeout = Math.max(0, Math.min(Number(delay) || 0, limits.actionTimeoutMs));
        const handle = setTimeout(() => {
            state.timers.delete(handle);
            if (!state.disposed) callback(...args);
        }, timeout);
        state.timers.add(handle);
        return handle;
    };
    const timerClear = handle => {
        state.timers.delete(handle);
        clearTimeout(handle);
    };
    const sandbox = Object.create(null);
    Object.assign(sandbox, {
        module,
        exports: module.exports,
        require: createMusicFreeRequire({ ...options, limits }, state),
        console: makeSafeConsole(options.logger),
        URL,
        URLSearchParams,
        TextEncoder: globalThis.TextEncoder,
        TextDecoder: globalThis.TextDecoder,
        JSON,
        Math,
        Date,
        Promise,
        encodeURIComponent,
        decodeURIComponent,
        setTimeout: timerSet,
        clearTimeout: timerClear,
        env: Object.freeze({ getUserVariables: () => Object.freeze({}) })
    });
    sandbox.process = undefined;
    sandbox.Buffer = undefined;
    sandbox.eval = undefined;
    sandbox.Function = undefined;
    sandbox.global = undefined;
    sandbox.globalThis = sandbox;
    const context = vm.createContext(sandbox, { name: 'qqnt-toolbox-musicfree-source' });
    try {
        new vm.Script(source, { displayErrors: true }).runInContext(context, { timeout: limits.scriptTimeoutMs });
    } catch (error) {
        throw new OnlineSourceError(`Source initialization failed: ${error.message}`, 'script-error', { cause: error });
    }
    const persistedProviderIds = options.metadata?.sources && typeof options.metadata.sources === 'object'
        ? Object.keys(options.metadata.sources).map(normalizeSourceId).filter(Boolean)
        : [];
    const preferredProviderId = normalizeSourceId(
        options.providerId || options.metadata?.providerId || persistedProviderIds[0] || options.name || options.metadata?.name
    );
    const decoded = decodeMusicFreeModuleExport(
        module.exports,
        options.name || options.metadata?.name,
        preferredProviderId
    );
    let metadata = normalizeMetadata(decoded.metadata, options.metadata || {});
    // A saved metadata record is the UI contract. Preserve its provider key
    // when a source is reopened, even when the display name differs from the
    // module's platform label.
    const persistedSources = options.metadata?.sources && typeof options.metadata.sources === 'object'
        ? options.metadata.sources
        : null;
    if (persistedSources && Object.keys(persistedSources).length) {
        const persisted = normalizeMetadata({ sources: persistedSources }).sources;
        const persistedId = preferredProviderId || Object.keys(persisted)[0];
        if (persistedId && persisted[persistedId]) {
            metadata = {
                ...metadata,
                sources: {
                    [persistedId]: {
                        ...metadata.sources[decoded.providerId],
                        ...persisted[persistedId],
                        actions: metadata.sources[decoded.providerId]?.actions || persisted[persistedId].actions,
                        qualitys: metadata.sources[decoded.providerId]?.qualitys?.length
                            ? metadata.sources[decoded.providerId].qualitys
                            : persisted[persistedId].qualitys
                    }
                }
            };
            decoded.providerId = persistedId;
        }
    }
    const withTimeout = async(work, timeoutMs = limits.actionTimeoutMs) => {
        let timer;
        try {
            return await Promise.race([
                Promise.resolve().then(work),
                new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new OnlineSourceError('Source request timed out', 'timeout', { timeoutMs })), timeoutMs);
                })
            ]);
        } finally {
            clearTimeout(timer);
        }
    };
    const getProvider = requested => {
        const id = normalizeSourceId(requested) || decoded.providerId;
        if (!metadata.sources[id]) {
            throw new OnlineSourceError('No compatible provider is available', 'unsupported-action');
        }
        return id;
    };
    const requestMusicSearch = async(query, params = {}) => {
        if (state.disposed) throw new OnlineSourceError('Source runner disposed', 'disposed');
        if (!decoded.canSearch || typeof module.exports.search !== 'function') {
            throw new OnlineSourceError('Source does not support search', 'unsupported-action');
        }
        const text = normalizeText(query, limits.maxSearchTextLength);
        if (!text) throw new OnlineSourceError('Search text is required', 'invalid-search');
        const providerId = getProvider(params.sourceId || params.providerId || params.provider);
        const page = Math.max(1, Math.min(10_000, Math.floor(Number(params.page) || 1)));
        const limit = Math.max(1, Math.min(limits.maxSearchResults, Math.floor(Number(params.limit) || 30)));
        state.requestsEnabled = true;
        let raw;
        try {
            raw = await withTimeout(() => module.exports.search(text, page, 'music'));
        } finally {
            state.requestsEnabled = false;
        }
        const entries = Array.isArray(raw?.data) ? raw.data : (Array.isArray(raw) ? raw : []);
        const results = normalizeSearchResults(entries.slice(0, limit), {
            limits,
            maxResults: limit,
            sourceId: providerId,
            providerId
        });
        return {
            results,
            page,
            hasMore: raw?.isEnd === false
        };
    };
    const requestMusicUrl = async(songInfo, quality = '320k', sourceId) => {
        if (state.disposed) throw new OnlineSourceError('Source runner disposed', 'disposed');
        if (!decoded.canResolve || typeof module.exports.getMediaSource !== 'function') {
            throw new OnlineSourceError('Source does not support musicUrl', 'unsupported-action');
        }
        getProvider(sourceId);
        const sourceInfo = metadata.sources[normalizeSourceId(sourceId) || decoded.providerId];
        const requested = normalizeText(quality, 32) || '320k';
        const supported = Array.isArray(sourceInfo?.qualitys) ? sourceInfo.qualitys : [];
        const selected = supported.includes(requested)
            ? requested
            : (supported.includes('320k') ? '320k' : supported[0] || requested);
        state.requestsEnabled = true;
        let result;
        try {
            result = await withTimeout(() => module.exports.getMediaSource(songInfo && typeof songInfo === 'object' ? songInfo : {}, selected));
        } finally {
            state.requestsEnabled = false;
        }
        const url = typeof result === 'string' ? result : result?.url;
        if (typeof url !== 'string' || url.length > limits.maxUrlLength) {
            throw new OnlineSourceError('Source returned an invalid audio URL', 'invalid-result');
        }
        return normalizeHttpUrl(url, { limits });
    };
    return {
        source,
        metadata,
        providerCapabilities: musicFreeProviderCapabilities(decoded.providerId, metadata),
        requestMusicUrl,
        requestMusicSearch,
        searchMusic: requestMusicSearch,
        waitForReady: async() => metadata,
        dispose: () => {
            state.disposed = true;
            state.requestsEnabled = false;
            for (const timer of state.timers) clearTimeout(timer);
            state.timers.clear();
        }
    };
}

function externalProviderSources(value, defaultQualities = []) {
    const result = {};
    const input = value && typeof value === 'object' ? value : {};
    const ids = Array.isArray(input) ? input : Object.keys(input);
    for (const rawId of ids) {
        const id = normalizeSourceId(rawId);
        if (!id) continue;
        const sourceInfo = !Array.isArray(input) ? input[rawId] : null;
        result[id] = {
            name: normalizeText(sourceInfo?.name, 128),
            type: 'music',
            actions: ['musicUrl'],
            qualitys: Array.isArray(sourceInfo?.qualitys)
                ? sourceInfo.qualitys
                : defaultQualities
        };
    }
    return result;
}

function normalizeExternalMetadata(info, sources, fallback = {}) {
    const parsed = typeof info === 'string' ? (() => {
        try { return JSON.parse(info); } catch { return {}; }
    })() : (info && typeof info === 'object' ? info : {});
    const metadata = normalizeMetadata({
        id: parsed.uid || parsed.id,
        name: parsed.name,
        description: parsed.description,
        author: parsed.author,
        homepage: parsed.homepage || parsed.url,
        version: parsed.version,
        sources
    }, fallback);
    if (!metadata.name) metadata.name = normalizeText(fallback.name, HEADER_FIELD_LIMITS.name) || 'Online audio source';
    return metadata;
}

function makeExternalHttpBridge(options, state) {
    const limits = mergeLimits(options.limits);
    const call = async(url, requestOptions = {}) => {
        if (!state.requestsEnabled) {
            throw new OnlineSourceError('Network access is unavailable during source initialization', 'initialization-network-blocked');
        }
        const input = requestOptions && typeof requestOptions === 'object' ? requestOptions : {};
        const headers = {};
        for (const [key, value] of Object.entries(input.headers || {})) {
            const normalized = normalizeText(value, limits.maxHeaderValueLength);
            if (normalized) headers[key] = normalized;
        }
        const body = prepareRequestBody(input, headers, limits);
        const response = await fetchWithLimits(url, {
            fetch: options.fetch,
            method: String(input.method || 'GET').toUpperCase(),
            headers,
            body,
            timeoutMs: input.timeout,
            limits,
            maxBytes: limits.maxResponseBytes
        });
        const raw = await readLimitedResponseBuffer(response, limits.maxResponseBytes);
        let responseBody = raw.toString('utf8');
        try { responseBody = JSON.parse(responseBody); } catch { /* non-JSON response */ }
        return {
            statusCode: Number(response.status ?? response.statusCode ?? 0),
            statusMessage: normalizeText(response.statusText, 256),
            headers: response.headers || {},
            body: responseBody,
            raw
        };
    };
    return {
        request: call,
        customFetch: async(url, requestOptions) => {
            const response = await call(url, requestOptions);
            return typeof response.body === 'string' ? response.body : JSON.stringify(response.body);
        }
    };
}

function createExternalSandbox(options, state, bridge) {
    const module = { exports: {} };
    const sandbox = Object.create(null);
    Object.assign(sandbox, {
        module,
        exports: module.exports,
        cerumusic: Object.freeze({
            request: bridge.request,
            NoticeCenter: () => {},
            stopRequests: () => {},
            version: '1.0.4'
        }),
        customFetch: bridge.customFetch,
        console: makeSafeConsole(options.logger),
        URL,
        URLSearchParams,
        JSON,
        Math,
        Date,
        Promise,
        setTimeout: undefined,
        clearTimeout: undefined
    });
    sandbox.require = undefined;
    sandbox.process = undefined;
    sandbox.Buffer = undefined;
    sandbox.eval = undefined;
    sandbox.Function = undefined;
    sandbox.global = undefined;
    sandbox.globalThis = sandbox;
    Object.defineProperty(sandbox, 'cerumusic', { writable: false, configurable: false });
    Object.defineProperty(sandbox, 'customFetch', { writable: false, configurable: false });
    return { sandbox, module };
}

function createExternalMusicRunner(scriptSource, format, options = {}) {
    const limits = mergeLimits(options.limits);
    const source = validateExternalPluginScript(scriptSource, format, { ...options, limits });
    const state = { disposed: false, requestsEnabled: false };
    const bridge = makeExternalHttpBridge({ ...options, limits }, state);
    const { sandbox, module } = createExternalSandbox(options, state, bridge);
    const context = vm.createContext(sandbox, { name: `qqnt-toolbox-${format}-source` });
    try {
        new vm.Script(source, { displayErrors: true }).runInContext(context, { timeout: limits.scriptTimeoutMs });
    } catch (error) {
        throw new OnlineSourceError(`Source initialization failed: ${error.message}`, 'script-error', { cause: error });
    }

    const plugin = format === 'cerumusic' ? module.exports : sandbox.MusicPlugin;
    const resolver = format === 'cerumusic' ? plugin?.musicUrl : plugin?.getMusicUrl;
    if (!plugin || typeof resolver !== 'function') {
        throw new OnlineSourceError('Source did not expose an audio URL resolver', 'invalid-script');
    }
    const sources = format === 'cerumusic'
        ? externalProviderSources(plugin.sources)
        : externalProviderSources((() => {
            const info = typeof plugin.info === 'string' ? (() => {
                try { return JSON.parse(plugin.info); } catch { return {}; }
            })() : plugin.info;
            return info?.support;
        })(), ['128k', '320k', 'flac', 'flac24bit']);
    const metadata = normalizeExternalMetadata(
        format === 'cerumusic' ? plugin.pluginInfo : plugin.info,
        sources,
        options.metadata || {}
    );
    const requestMusicUrl = async(songInfo, quality = '320k', sourceId) => {
        if (state.disposed) throw new OnlineSourceError('Source runner disposed', 'disposed');
        const sourceIdValue = normalizeSourceId(sourceId) || Object.keys(metadata.sources)[0];
        if (!sourceIdValue || !metadata.sources[sourceIdValue]) {
            throw new OnlineSourceError('No compatible provider is available', 'unsupported-action');
        }
        const requestedQuality = normalizeText(quality, 32) || '320k';
        const sourceInfo = metadata.sources[sourceIdValue];
        const selectedQuality = sourceInfo.qualitys.includes(requestedQuality)
            ? requestedQuality
            : (sourceInfo.qualitys.includes('320k') ? '320k' : sourceInfo.qualitys[0] || requestedQuality);
        const info = songInfo && typeof songInfo === 'object' ? songInfo : {};
        const externalQuality = format === 'qt-music'
            ? ({ '128k': 'standard', '320k': 'exhigh', flac: 'lossless', flac24bit: 'lossless+' }[selectedQuality] || 'standard')
            : selectedQuality;
        let result;
        state.requestsEnabled = true;
        try {
            result = format === 'cerumusic'
                ? await resolver.call(plugin, sourceIdValue, info, externalQuality)
                : await resolver.call(plugin, sourceIdValue, info.hash ?? info.songmid ?? info.id, externalQuality);
        } catch (error) {
            if (error instanceof OnlineSourceError) throw error;
            throw new OnlineSourceError(error?.message || 'Source did not resolve an audio URL', 'source-error', { cause: error });
        } finally {
            state.requestsEnabled = false;
        }
        if (typeof result !== 'string' || result.length > limits.maxUrlLength) {
            throw new OnlineSourceError('Source returned an invalid audio URL', 'invalid-result');
        }
        return normalizeHttpUrl(result, { limits });
    };
    const dispose = () => { state.disposed = true; state.requestsEnabled = false; };
    return {
        source,
        metadata,
        requestMusicUrl,
        dispose,
        waitForReady: async() => metadata
    };
}

function createCeruMusicSourceRunner(scriptSource, options = {}) {
    return createExternalMusicRunner(scriptSource, 'cerumusic', options);
}

function createQtMusicSourceRunner(scriptSource, options = {}) {
    return createExternalMusicRunner(scriptSource, 'qt-music', options);
}

function parseExternalSourceMetadata(source, format, options = {}) {
    try {
        const runner = createExternalMusicRunner(source, format, options);
        try { return runner.metadata; } finally { runner.dispose(); }
    } catch (error) {
        if (options.throwOnError) throw error;
        return null;
    }
}

function getOnlineSourceFormat(source, options = {}) {
    const requestedValue = options.format || options.metadata?.format;
    const requested = normalizeText(requestedValue, 32).toLowerCase();
    if (ONLINE_SOURCE_ALL_FORMATS.includes(requested)) return requested;
    if (requested) {
        throw new OnlineSourceError('Unsupported online source format', 'unsupported-source-format', { format: requested });
    }
    const detected = detectOnlineSourceFormat(source, options);
    if (!detected) {
        throw new OnlineSourceError('Unsupported online source format', 'unsupported-source-format');
    }
    return detected;
}

function validateOnlineSourceScript(source, options = {}) {
    const format = getOnlineSourceFormat(source, options);
    if (format === 'lxmusic') {
        return { ...validateLXMusicUserApiScript(source, options), format };
    }
    if (format === MUSICFREE_SOURCE_FORMAT) {
        const runner = createMusicFreeSourceRunner(source, options);
        try {
            return {
                source: runner.source,
                metadata: runner.metadata,
                hash: crypto.createHash('sha256').update(runner.source).digest('hex'),
                format
            };
        } finally {
            runner.dispose();
        }
    }
    const normalizedSource = validateExternalPluginScript(source, format, options);
    const runner = createExternalMusicRunner(normalizedSource, format, options);
    let metadata;
    try {
        metadata = runner.metadata;
    } finally {
        runner.dispose();
    }
    return {
        source: normalizedSource,
        metadata,
        hash: crypto.createHash('sha256').update(normalizedSource).digest('hex'),
        format
    };
}

function parseOnlineSourceMetadata(source, options = {}) {
    try {
        return validateOnlineSourceScript(source, options).metadata;
    } catch (error) {
        if (options.throwOnError) throw error;
        return null;
    }
}

function createOnlineSourceRunner(scriptSource, options = {}) {
    const format = getOnlineSourceFormat(scriptSource, options);
    if (format === 'lxmusic') return createLXMusicSourceRunner(scriptSource, options);
    if (format === 'cerumusic') return createCeruMusicSourceRunner(scriptSource, options);
    if (format === MUSICFREE_SOURCE_FORMAT) return createMusicFreeSourceRunner(scriptSource, options);
    return createQtMusicSourceRunner(scriptSource, options);
}

function makeSafeConsole(logger) {
    const write = typeof logger === 'function' ? logger : () => {};
    return Object.freeze({
        log: (...args) => write('log', args.map(item => String(item)).join(' ')),
        info: (...args) => write('info', args.map(item => String(item)).join(' ')),
        warn: (...args) => write('warn', args.map(item => String(item)).join(' ')),
        error: (...args) => write('error', args.map(item => String(item)).join(' '))
    });
}

function createLXMusicSourceRunner(scriptSource, options = {}) {
    const limits = mergeLimits(options.limits);
    const validated = validateLXMusicUserApiScript(scriptSource, {
        limits,
        metadata: options.metadata,
        allowUnknownSources: options.allowUnknownSources
    });
    const source = validated.source;
    const state = {
        initialized: null,
        requestHandler: null,
        updateAlertShown: false,
        timers: new Set(),
        disposed: false
    };
    const hostFetch = options.fetch;
    const request = (url, requestOptions, callback) => {
        if (state.disposed) return () => {};
        const opts = requestOptions && typeof requestOptions === 'object' ? requestOptions : {};
        const headers = {};
        for (const [key, value] of Object.entries(opts.headers || {})) {
            const normalized = normalizeText(value, limits.maxHeaderValueLength);
            if (normalized) headers[key] = normalized;
        }
        let requestBody;
        try {
            requestBody = prepareRequestBody(opts, headers, limits);
        } catch (error) {
            callback?.call(lx, error, null, null);
            return () => {};
        }
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const task = (async() => {
            try {
                const response = await fetchWithLimits(url, {
                    fetch: hostFetch,
                    method: String(opts.method || 'GET').toUpperCase(),
                    headers,
                    body: requestBody,
                    timeoutMs: opts.timeout,
                    limits,
                    maxBytes: limits.maxResponseBytes,
                    signal: controller?.signal
                });
                const bodyBuffer = await readLimitedResponseBuffer(response, limits.maxResponseBytes);
                let responseBody = opts.binary === true ? new Uint8Array(bodyBuffer) : bodyBuffer.toString('utf8');
                // LXMusic's desktop bridge attempts JSON decoding before
                // invoking the callback. Preserve that behavior for scripts.
                if (opts.binary !== true) {
                    try { responseBody = JSON.parse(responseBody); } catch { /* plain text */ }
                }
                const info = {
                    statusCode: Number(response.status ?? response.statusCode ?? 0),
                    statusMessage: normalizeText(response.statusText, 256),
                    headers: response.headers || {},
                    bytes: bodyBuffer.length,
                    raw: bodyBuffer,
                    body: responseBody
                };
                callback?.call(lx, null, info, responseBody);
            } catch (error) {
                callback?.call(lx, error instanceof Error ? error : new Error(String(error)), null, null);
            }
        })();
        return () => controller?.abort();
    };

    const send = (eventName, data) => {
        if (state.disposed) return Promise.reject(new Error('Source runner disposed'));
        if (eventName === 'inited') {
            if (state.initialized) return Promise.reject(new Error('Script is already initialized'));
            state.initialized = normalizeMetadata(data, validated.metadata);
            return Promise.resolve();
        }
        if (eventName === 'updateAlert') {
            if (state.updateAlertShown) return Promise.reject(new Error('The update alert can only be called once.'));
            state.updateAlertShown = true;
            return Promise.resolve();
        }
        return Promise.reject(new Error(`Unsupported LXMusic event: ${eventName}`));
    };
    const on = (eventName, handler) => {
        if (eventName !== 'request' || typeof handler !== 'function') {
            return Promise.reject(new Error('Only the request event is supported'));
        }
        state.requestHandler = handler;
        return Promise.resolve();
    };
    const timerSet = (callback, delay, ...args) => {
        if (state.timers.size >= limits.maxTimers) throw new Error('Too many timers');
        const timeout = Math.max(0, Math.min(Number(delay) || 0, limits.maxRequestTimeoutMs));
        const timer = setTimeout(() => {
            state.timers.delete(timer);
            if (!state.disposed) callback(...args);
        }, timeout);
        state.timers.add(timer);
        return timer;
    };
    const timerClear = timer => {
        clearTimeout(timer);
        state.timers.delete(timer);
    };
    const lx = {
        EVENT_NAMES: Object.freeze({ request: 'request', inited: 'inited', updateAlert: 'updateAlert' }),
        request,
        send,
        on,
        utils: Object.freeze({
            crypto: Object.freeze({
                aesEncrypt: (value, mode, key, iv) => {
                    const cipher = crypto.createCipheriv(
                        String(mode),
                        toCryptoInput(key),
                        toCryptoInput(iv)
                    );
                    return Buffer.concat([cipher.update(toBuffer(value)), cipher.final()]);
                },
                rsaEncrypt: (value, key) => {
                    const input = toBuffer(value);
                    // LXMusic's desktop bridge currently targets 1024-bit RSA
                    // source APIs and pads to that block size before applying
                    // RSA_NO_PADDING.
                    const padded = Buffer.concat([Buffer.alloc(128 - input.length), input]);
                    const publicKey = Buffer.isBuffer(key) || isArrayBufferLike(key) ? toBuffer(key) : String(key);
                    return crypto.publicEncrypt({ key: publicKey, padding: crypto.constants.RSA_NO_PADDING }, padded);
                },
                md5: value => crypto.createHash('md5').update(hashInput(value)).digest('hex'),
                randomBytes: size => crypto.randomBytes(Math.max(0, Math.min(Number(size) || 0, 1024 * 1024)))
            }),
            buffer: Object.freeze({
                from: (value, encoding, length) => {
                    if (typeof value === 'string') return Buffer.from(value, encoding);
                    if (value instanceof ArrayBuffer) return Buffer.from(value, encoding, length);
                    if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
                    return Buffer.from(value);
                },
                bufToString: (value, encoding = 'utf8') => {
                    if (typeof value === 'string') return Buffer.from(value, 'binary').toString(encoding);
                    return toBuffer(value).toString(encoding);
                }
            }),
            zlib: Object.freeze({
                inflate: value => createZlibPromise('inflate', value),
                deflate: value => createZlibPromise('deflate', value)
            })
        }),
        currentScriptInfo: Object.freeze({ ...validated.metadata, rawScript: source }),
        version: '2.0.0',
        env: 'desktop'
    };

    const sandbox = Object.create(null);
    Object.assign(sandbox, {
        lx,
        console: makeSafeConsole(options.logger),
        URL,
        URLSearchParams,
        FormData: typeof FormData === 'function' ? FormData : undefined,
        Blob: typeof Blob === 'function' ? Blob : undefined,
        TextEncoder: globalThis.TextEncoder,
        TextDecoder: globalThis.TextDecoder,
        atob: typeof globalThis.atob === 'function' ? globalThis.atob : undefined,
        btoa: typeof globalThis.btoa === 'function' ? globalThis.btoa : undefined,
        Uint8Array,
        ArrayBuffer,
        JSON,
        Math,
        Date,
        Promise,
        setTimeout: timerSet,
        clearTimeout: timerClear
    });
    // Explicitly shadow common escape hatches. `require` and `process` are
    // also rejected by the static validator, but keeping them undefined makes
    // failures deterministic when a script is edited while running.
    sandbox.require = undefined;
    sandbox.process = undefined;
    sandbox.Buffer = undefined;
    sandbox.eval = undefined;
    sandbox.Function = undefined;
    sandbox.global = undefined;
    sandbox.globalThis = sandbox;
    const context = vm.createContext(sandbox, { name: 'qqnt-toolbox-online-source' });
    let execution;
    try {
        execution = new vm.Script(source, { displayErrors: true }).runInContext(context, { timeout: limits.scriptTimeoutMs });
    } catch (error) {
        for (const timer of state.timers) clearTimeout(timer);
        state.timers.clear();
        throw new OnlineSourceError(`Source initialization failed: ${error.message}`, 'script-error', { cause: error });
    }

    const waitForReady = async(timeoutMs = limits.actionTimeoutMs) => {
        if (state.disposed) throw new OnlineSourceError('Source runner disposed', 'disposed');
        const deadline = Date.now() + timeoutMs;
        while ((!state.requestHandler || !state.initialized) && Date.now() < deadline) {
            if (state.disposed) throw new OnlineSourceError('Source runner disposed', 'disposed');
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        if (!state.requestHandler || !state.initialized) throw new OnlineSourceError('Source did not finish initialization', 'source-not-ready');
        return state.initialized;
    };
    const invoke = async(action, payload, timeoutMs = limits.actionTimeoutMs) => {
        await waitForReady(timeoutMs);
        const promise = Promise.resolve().then(() => state.requestHandler.call(lx, payload));
        let timer;
        try {
            return await Promise.race([
                promise,
                new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new OnlineSourceError('Source request timed out', 'timeout', { timeoutMs })), timeoutMs);
                })
            ]);
        } finally {
            clearTimeout(timer);
        }
    };
    const requestMusicUrl = async(songInfo, quality = '320k', sourceId) => {
        const metadata = await waitForReady();
        const source = normalizeSourceId(sourceId) || Object.keys(metadata.sources)[0] || 'local';
        const sourceInfo = metadata.sources[source];
        if (sourceInfo && !sourceInfo.actions.includes('musicUrl')) {
            throw new OnlineSourceError('Source does not support musicUrl', 'unsupported-action');
        }
        const requestedType = normalizeText(quality, 32) || '320k';
        const supportedTypes = Array.isArray(sourceInfo?.qualitys)
            ? sourceInfo.qualitys.filter(type => SUPPORTED_QUALITIES.has(type))
            : [];
        const type = source === 'local'
            ? null
            : supportedTypes.length
                ? (supportedTypes.includes(requestedType)
                    ? requestedType
                    : supportedTypes.includes('320k')
                        ? '320k'
                        : supportedTypes[0])
                : requestedType;
        const result = await invoke('musicUrl', {
            source,
            action: 'musicUrl',
            info: { type, musicInfo: songInfo && typeof songInfo === 'object' ? songInfo : {} }
        });
        if (typeof result !== 'string' || result.length > limits.maxUrlLength) {
            throw new OnlineSourceError('Source returned an invalid audio URL', 'invalid-result');
        }
        return normalizeHttpUrl(result, { limits });
    };
    /**
     * Toolbox extension for source scripts that expose search themselves.
     *
     * Supported call forms are:
     *   requestMusicSearch('keyword', page, limit, sourceId)
     *   requestMusicSearch({ query, page, limit, sourceId, action })
     *
     * The standard LXMusic user API has no search action. We therefore only
     * invoke a provider when it explicitly announces `search` or
     * `musicSearch`; ordinary musicUrl-only scripts continue to work exactly
     * as before.
     */
    const requestMusicSearch = async(queryOrOptions, page = 1, limit = 30, sourceId, options = {}) => {
        let params = {};
        if (isSearchRecord(queryOrOptions)) params = { ...queryOrOptions };
        else params.query = queryOrOptions;
        if (isSearchRecord(page)) params = { ...params, ...page };
        if (isSearchRecord(limit)) params = { ...params, ...limit };
        if (isSearchRecord(sourceId)) params = { ...params, ...sourceId };
        if (isSearchRecord(options)) params = { ...params, ...options };

        // A convenient `(query, sourceId)` form is useful to callers and does
        // not conflict with the numeric page argument.
        if (!isSearchRecord(queryOrOptions) && typeof page === 'string' && sourceId === undefined) {
            params.sourceId = page;
            params.page = 1;
        }
        const text = normalizeText(firstSearchValue(
            params.query,
            params.text,
            params.keyword,
            params.searchText
        ), limits.maxSearchTextLength);
        if (!text) throw new OnlineSourceError('Search text is required', 'invalid-search');

        const requestedPage = Number(params.page ?? page);
        const requestedLimit = Number(params.limit ?? limit);
        const searchPage = Number.isFinite(requestedPage) && requestedPage > 0
            ? Math.min(Math.floor(requestedPage), 10_000)
            : 1;
        const searchLimit = Number.isFinite(requestedLimit) && requestedLimit > 0
            ? Math.min(Math.floor(requestedLimit), limits.maxSearchResults)
            : Math.min(30, limits.maxSearchResults);

        const metadata = await waitForReady();
        const requestedSource = searchIdentifier(firstSearchValue(
            params.sourceId,
            params.source,
            params.providerId,
            params.provider
        ));
        const source = normalizeSourceId(requestedSource) || Object.keys(metadata.sources)
            .find(id => metadata.sources[id]?.actions?.some(action => SEARCH_ACTIONS.has(action))) || '';
        const sourceInfo = source ? metadata.sources[source] : null;
        const actions = Array.isArray(sourceInfo?.actions)
            ? sourceInfo.actions.filter(action => SEARCH_ACTIONS.has(action))
            : [];
        if (!sourceInfo || !actions.length) {
            throw new OnlineSourceError('Source does not support search', 'unsupported-action', { source: requestedSource || source });
        }
        const requestedAction = normalizeText(params.action, 32);
        const action = requestedAction
            ? (actions.includes(requestedAction) ? requestedAction : '')
            : actions[0];
        if (!action) {
            throw new OnlineSourceError('Source does not support the requested search action', 'unsupported-action', {
                source,
                action: requestedAction
            });
        }
        const info = {
            text,
            query: text,
            keyword: text,
            searchText: text,
            page: searchPage,
            limit: searchLimit
        };
        const requestedTimeout = Number(params.timeoutMs);
        const searchTimeout = Number.isFinite(requestedTimeout) && requestedTimeout > 0
            ? Math.min(requestedTimeout, limits.actionTimeoutMs)
            : limits.actionTimeoutMs;
        const result = await invoke(action, {
            source,
            action,
            // Keep the LXMusic request shape (`info`) while exposing aliases
            // at the top level for small Toolbox-specific source scripts.
            info,
            query: text,
            text,
            keyword: text,
            page: searchPage,
            limit: searchLimit
        }, searchTimeout);
        return normalizeSearchResults(result, {
            limits,
            maxResults: searchLimit,
            sourceId: source,
            providerId: searchIdentifier(firstSearchValue(params.providerId, params.provider))
        });
    };
    const searchMusic = requestMusicSearch;
    const dispose = () => {
        state.disposed = true;
        for (const timer of state.timers) clearTimeout(timer);
        state.timers.clear();
        state.requestHandler = null;
    };
    // Prevent an unused top-level value from keeping lint tools noisy while
    // retaining the result for debugging integrations.
    void execution;
    const runner = {
        source,
        requestMusicUrl,
        requestMusicSearch,
        searchMusic,
        invoke,
        waitForReady,
        dispose
    };
    Object.defineProperty(runner, 'metadata', {
        enumerable: true,
        get: () => state.initialized || validated.metadata
    });
    return runner;
}

async function loadScriptInput(input, options = {}) {
    const limits = mergeLimits(options.limits);
    if (input && typeof input === 'object' && !Buffer.isBuffer(input)) {
        if (typeof input.source === 'string') return { source: input.source, sourceUrl: input.url ? normalizeHttpUrl(input.url, { limits }) : '' };
        if (input.url) return loadScriptInput(String(input.url), options);
        if (input.path) return loadScriptInput(String(input.path), options);
    }
    const text = String(input ?? '').trim();
    if (!text) throw new OnlineSourceError('Script input is empty', 'invalid-script');
    if (/^https?:\/\//i.test(text)) {
        const response = await fetchWithLimits(text, { ...options, limits, maxBytes: limits.maxScriptBytes });
        assertOkResponse(response);
        return { source: await readLimitedResponseText(response, limits.maxScriptBytes), sourceUrl: normalizeHttpUrl(text, { limits }) };
    }
    // LXMusic persists imported scripts as `gz_<base64(zlib(script))>`.
    // Accept the encoded value directly as well as a file containing it.
    if (text.startsWith('gz_')) return { source: text, sourceUrl: '' };
    // Newlines and common script delimiters indicate that the value itself is
    // source code rather than a path. This keeps `importLXMusicScript(source)`
    // convenient while still accepting relative/absolute local paths.
    if (text.includes('\n') || text.includes('\r') || /[;{}]/.test(text.slice(0, 256))) {
        return { source: text, sourceUrl: '' };
    }
    const filePath = path.resolve(options.cwd || process.cwd(), text);
    let stat;
    try { stat = await fsp.stat(filePath); } catch (error) {
        throw new OnlineSourceError('Local script was not found', 'file-not-found', { cause: error });
    }
    if (!stat.isFile()) throw new OnlineSourceError('Local script is not a file', 'invalid-script');
    if (stat.size > limits.maxScriptBytes) throw new OnlineSourceError('Script is too large', 'script-too-large');
    return { source: await fsp.readFile(filePath, 'utf8'), sourcePath: filePath, sourceUrl: '' };
}

async function importLXMusicUserApiScript(input, options = {}) {
    const loaded = await loadScriptInput(input, options);
    const validated = validateLXMusicUserApiScript(loaded.source, options);
    let metadata = normalizeMetadata(validated.metadata, options.metadata || {});
    // `sources` is often built through a local variable instead of an inline
    // literal. Run the trusted source through the same restricted adapter so
    // the persisted metadata reflects the providers it actually announces.
    if (options.resolveRuntimeMetadata !== false) {
        const runner = createLXMusicSourceRunner(validated.source, {
            ...options,
            metadata
        });
        try {
            metadata = normalizeMetadata(await runner.waitForReady(), metadata);
        } finally {
            runner.dispose();
        }
    }
    const id = normalizeSourceId(options.id || metadata.id) || `online_${validated.hash.slice(0, 16)}`;
    metadata.id = id;
    const result = {
        id,
        metadata,
        source: validated.source,
        hash: validated.hash,
        sourcePath: loaded.sourcePath || '',
        sourceUrl: loaded.sourceUrl || ''
    };
    if (options.rootPath) {
        const root = path.resolve(options.rootPath);
        await fsp.mkdir(root, { recursive: true });
        const scriptPath = ensureWithinRoot(root, path.join(root, `${sanitizeFileName(id, 'source')}.js`));
        await fsp.writeFile(scriptPath, validated.source, { encoding: 'utf8', flag: 'wx' }).catch(async error => {
            if (error.code !== 'EEXIST') throw error;
            await fsp.writeFile(scriptPath, validated.source, 'utf8');
        });
        result.scriptPath = scriptPath;
        const metadataPath = ensureWithinRoot(root, path.join(root, `${sanitizeFileName(id, 'source')}.json`));
        await fsp.writeFile(metadataPath, JSON.stringify({ ...metadata, sourceUrl: result.sourceUrl, hash: result.hash }, null, 2), 'utf8');
        result.metadataPath = metadataPath;
    }
    return result;
}

async function importOnlineSourceScript(input, options = {}) {
    const loaded = await loadScriptInput(input, options);
    const validated = validateOnlineSourceScript(loaded.source, options);
    const metadata = normalizeMetadata(validated.metadata, options.metadata || {});
    const id = normalizeSourceId(options.id || metadata.id) || `online_${validated.hash.slice(0, 16)}`;
    metadata.id = id;
    const result = {
        id,
        metadata,
        format: validated.format,
        source: validated.source,
        hash: validated.hash,
        sourcePath: loaded.sourcePath || '',
        sourceUrl: loaded.sourceUrl || ''
    };
    if (options.rootPath) {
        const root = path.resolve(options.rootPath);
        await fsp.mkdir(root, { recursive: true });
        const scriptPath = ensureWithinRoot(root, path.join(root, `${sanitizeFileName(id, 'source')}.js`));
        await fsp.writeFile(scriptPath, validated.source, { encoding: 'utf8', flag: 'wx' }).catch(async error => {
            if (error.code !== 'EEXIST') throw error;
            await fsp.writeFile(scriptPath, validated.source, 'utf8');
        });
        result.scriptPath = scriptPath;
        const metadataPath = ensureWithinRoot(root, path.join(root, `${sanitizeFileName(id, 'source')}.json`));
        await fsp.writeFile(metadataPath, JSON.stringify({
            ...metadata,
            format: validated.format,
            sourceUrl: result.sourceUrl,
            hash: result.hash
        }, null, 2), 'utf8');
        result.metadataPath = metadataPath;
    }
    return result;
}

function inferAudioExtension(url, contentType = '') {
    const pathname = (() => {
        try { return new URL(url).pathname; } catch { return ''; }
    })();
    const extension = path.extname(pathname).toLowerCase();
    if (/^\.(?:mp3|m4a|aac|flac|ogg|opus|wav|amr|wma|webm)$/i.test(extension)) return extension;
    const type = String(contentType).toLowerCase().split(';')[0].trim();
    const map = {
        'audio/mpeg': '.mp3',
        'audio/mp3': '.mp3',
        'audio/mp4': '.m4a',
        'audio/aac': '.aac',
        'audio/flac': '.flac',
        'audio/ogg': '.ogg',
        'audio/opus': '.opus',
        'audio/wav': '.wav',
        'audio/x-wav': '.wav',
        'audio/webm': '.webm'
    };
    // Keep the fallback in Toolbox's supported audio extension set. The
    // extension is only a container hint; callers may still choose to
    // transcode the downloaded bytes before sending.
    return map[type] || '.mp3';
}

async function downloadAudioUrl(url, options = {}) {
    const limits = mergeLimits(options.limits);
    const normalizedUrl = normalizeHttpUrl(url, { limits });
    const rootPath = options.rootPath || options.destinationRoot;
    if (!rootPath) throw new OnlineSourceError('A destination directory is required', 'invalid-destination');
    const root = path.resolve(rootPath);
    await fsp.mkdir(root, { recursive: true });
    const response = await fetchWithLimits(normalizedUrl, { ...options, limits, maxBytes: limits.maxDownloadBytes });
    assertOkResponse(response);
    const contentType = getHeader(response, 'content-type');
    const extension = inferAudioExtension(normalizedUrl, contentType);
    const requestedName = options.fileName || options.name || '';
    const baseName = sanitizeFileName(requestedName || path.basename(new URL(normalizedUrl).pathname, path.extname(new URL(normalizedUrl).pathname)) || `audio-${Date.now()}`);
    const fileName = path.extname(baseName) ? baseName : `${baseName}${extension}`;
    const target = ensureWithinRoot(root, path.join(root, fileName));
    const temporary = ensureWithinRoot(root, path.join(
        root,
        `.${fileName}.${process.pid}.${Date.now()}-${crypto.randomBytes(6).toString('hex')}.part`
    ));
    let size;
    try {
        size = await writeLimitedResponseToFile(response, temporary, limits.maxDownloadBytes);
        await fsp.rename(temporary, target);
    } catch (error) {
        await fsp.rm(temporary, { force: true }).catch(() => {});
        if (error instanceof OnlineSourceError) throw error;
        throw new OnlineSourceError('Unable to save downloaded audio', 'file-write-error', { cause: error });
    }
    return {
        ok: true,
        url: normalizedUrl,
        path: target,
        filePath: target,
        fileName,
        size,
        contentType
    };
}

const importUserApiScript = importOnlineSourceScript;
const downloadAudioSource = downloadAudioUrl;

module.exports = {
    DEFAULT_LIMITS,
    OnlineSourceError,
    SUPPORTED_ACTIONS: Object.freeze(Array.from(SUPPORTED_ACTIONS)),
    SEARCH_ACTIONS: Object.freeze(Array.from(SEARCH_ACTIONS)),
    SUPPORTED_QUALITIES: Object.freeze(Array.from(SUPPORTED_QUALITIES)),
    ONLINE_SOURCE_FORMATS: ONLINE_SOURCE_ALL_FORMATS,
    createCeruMusicSourceRunner,
    createLXMusicSourceRunner,
    createMusicFreeSourceRunner,
    createOnlineSourceRunner,
    createQtMusicSourceRunner,
    decodeCompressedScript,
    detectOnlineSourceFormat,
    downloadAudioSource,
    downloadAudioUrl,
    ensureWithinRoot,
    extractHeaderMetadata,
    importLXMusicUserApiScript,
    importOnlineSourceScript,
    importUserApiScript,
    inferAudioExtension,
    normalizeHttpUrl,
    normalizeMetadata,
    normalizeSearchItem,
    normalizeSearchResults,
    parseOnlineSourceMetadata,
    parseLXMusicScriptMetadata,
    readLimitedResponseBuffer,
    readLimitedResponseText,
    sanitizeFileName,
    validateLXMusicUserApiScript,
    validateOnlineSourceScript
};
