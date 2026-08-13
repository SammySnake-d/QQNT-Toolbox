'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');

const {
    OnlineSourceError,
    createOnlineSourceRunner,
    createLXMusicSourceRunner,
    decodeCompressedScript,
    detectOnlineSourceFormat,
    downloadAudioUrl,
    importLXMusicUserApiScript,
    importOnlineSourceScript,
    normalizeHttpUrl,
    normalizeSearchResults,
    parseOnlineSourceMetadata,
    parseLXMusicScriptMetadata,
    validateLXMusicUserApiScript
} = require('../src/voice/online-source');

const SAMPLE_SCRIPT = `/*
 * @name Test source
 * @description A source used by the unit tests
 * @author Toolbox
 * @version 1.0.0
 */
lx.send('inited', {
  sources: {
    test: { type: 'music', actions: ['musicUrl'], qualitys: ['128k', '320k'] }
  }
});
lx.on('request', async ({ action, info }) => {
  if (action !== 'musicUrl') throw new Error('unexpected action');
  return 'https://cdn.example.test/' + encodeURIComponent(info.musicInfo.id) + '.mp3';
});`;

const OFFICIAL_STYLE_SCRIPT = `/**
 * @name Official style source
 */
const { EVENT_NAMES, request, on, send } = globalThis.lx;
on(EVENT_NAMES.request, ({ info }) => Promise.resolve(info.musicInfo.url));
send(EVENT_NAMES.inited, {
  sources: {
    test: { type: 'music', actions: ['musicUrl'], qualitys: ['320k'] }
  }
});`;

const DYNAMIC_SOURCES_SCRIPT = `
const sources = {
  kg: { type: 'music', actions: ['musicUrl'], qualitys: ['320k'] },
  wy: { type: 'music', actions: ['musicUrl'], qualitys: ['128k'] }
};
lx.on('request', ({ source, info }) => Promise.resolve(
  'https://cdn.example.test/' + source + '-' + info.type + '.mp3'
));
lx.send('inited', { sources });`;

const SEARCH_SCRIPT = `
const { EVENT_NAMES, on, send } = globalThis.lx;
on(EVENT_NAMES.request, ({ action, source, info }) => {
  if (source !== 'kg' || action !== 'search') throw new Error('unexpected search request');
  if (info.text !== 'hello' || info.page !== 2 || info.limit !== 2) throw new Error('search request shape mismatch');
  return {
    source: 'kg',
    data: { list: [
      { songmid: 'song-1', SongName: 'First song', SingerName: 'One' },
      { musicInfo: { id: 'song-2', source: 'kg' }, title: 'Second song', singer: ['Two', { name: 'Three' }] }
    ], total: 2, allPage: 1 }
  };
});
send(EVENT_NAMES.inited, {
  sources: { kg: { type: 'music', actions: ['musicUrl', 'search'], qualitys: ['320k'] } }
});`;

// CeruMusic plugins export their resolver through CommonJS and obtain the
// HTTP bridge from the global `cerumusic` object. Keep this structurally close
// to a real plugin instead of testing a Toolbox-specific source shape.
const CERU_MUSIC_PLUGIN = `
const pluginInfo = {
  name: 'Ceru fixture', version: '1.0.0', author: 'Toolbox', type: 'cr'
};
const sources = {
  kw: { name: 'Kuwo', qualitys: ['128k', '320k', 'flac'] }
};
const { request, NoticeCenter, version } = cerumusic;
NoticeCenter('info', { version });
// Real Ceru plugins commonly check for updates while loading. The adapter
// must not grant that request network access during initialization.
void request('https://api.example.test/ceru/initialization').catch(() => {});
async function musicUrl(source, musicInfo, quality) {
  const songId = musicInfo.hash ?? musicInfo.songmid ?? musicInfo.id;
  const response = await request(
    'https://api.example.test/ceru/resolve?source=' + encodeURIComponent(source) +
      '&songId=' + encodeURIComponent(songId) + '&quality=' + encodeURIComponent(quality),
    { method: 'GET', headers: { 'X-Source-Version': pluginInfo.version } }
  );
  return response.body.url;
}
module.exports = { pluginInfo, sources, musicUrl };
`;

// QT MusicPlugin sources install a `globalThis.MusicPlugin` object inside an
// IIFE, expose JSON encoded metadata, and call the supplied `customFetch`.
const QT_MUSIC_PLUGIN = `
(function () {
  const PLUGIN_INFO = JSON.stringify({
    uid: 'qt-fixture', name: 'QT fixture', version: '1.0.0', support: ['tx']
  });
  async function getMusicUrl(source, id, quality) {
    const value = await customFetch(
      'https://api.example.test/qt/resolve?source=' + encodeURIComponent(source) +
        '&songId=' + encodeURIComponent(id) + '&quality=' + encodeURIComponent(quality),
      { method: 'GET', headers: { 'X-Plugin': 'qt-fixture' } }
    );
    return JSON.parse(value).url;
  }
  globalThis.MusicPlugin = { info: PLUGIN_INFO, getMusicUrl };
})();
`;

// This module intentionally has a display name distinct from its platform.
// An imported source stores the provider ID from import-time metadata, so a
// subsequent runner has to accept that persisted ID rather than deriving a
// different one from the module at runtime.
const MUSICFREE_MODULE = `
const axios = require('axios');
module.exports = {
  platform: 'runtime-platform',
  version: '1.0.0',
  author: 'Toolbox',
  supportedQualities: ['128k', '320k'],
  async search(keyword, page, type) {
    const response = await axios.get('https://api.example.test/musicfree/search', {
      params: { keyword, page, type }
    });
    return { isEnd: true, data: response.data.items };
  },
  async getMediaSource(item, quality) {
    const response = await axios.post('https://api.example.test/musicfree/resolve', {
      id: item.id, quality
    });
    return { url: response.data.url };
  }
};
`;

const MUSICFREE_CRYPTO_MODULE = `
const CryptoJs = require('crypto-js');
const bigInteger = require('big-integer');
const { load } = require('cheerio');
module.exports = {
  platform: 'crypto fixture',
  supportedQualities: ['320k'],
  async search() {
    const encrypted = CryptoJs.AES.encrypt(
      CryptoJs.enc.Utf8.parse('hello'),
      CryptoJs.enc.Utf8.parse('0123456789abcdef'),
      { iv: CryptoJs.enc.Utf8.parse('0102030405060708'), mode: CryptoJs.mode.CBC }
    ).toString();
    const encryptedKey = bigInteger('2', 16)
      .modPow(bigInteger('10', 16), bigInteger('11', 16)).toString(16);
    const signature = CryptoJs.HmacSHA256('a', 'b').toString(CryptoJs.enc.Hex);
    return {
      isEnd: true,
      data: [{ id: encryptedKey, title: load('<b>A&amp;B</b>')().text() + encrypted.length + signature.length }]
    };
  },
  async getMediaSource() { return { url: 'https://cdn.example.test/crypto-fixture.mp3' }; }
};
`;

async function temporaryDirectory(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qqnt-toolbox-online-source-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    return directory;
}

test('normalizes only credential-free HTTP(S) URLs', () => {
    assert.equal(normalizeHttpUrl(' https://example.test/audio.mp3 '), 'https://example.test/audio.mp3');
    assert.throws(() => normalizeHttpUrl('file:///tmp/audio.mp3'), error => error.code === 'invalid-url');
    assert.throws(() => normalizeHttpUrl('https://user:pass@example.test/a'), error => error.code === 'invalid-url');
});

test('reads LXMusic header and init metadata without running network code', () => {
    const metadata = parseLXMusicScriptMetadata(SAMPLE_SCRIPT);
    assert.equal(metadata.name, 'Test source');
    assert.equal(metadata.description, 'A source used by the unit tests');
    assert.deepEqual(metadata.sources.test.actions, ['musicUrl']);
    assert.deepEqual(metadata.sources.test.qualitys, ['128k', '320k']);
});

test('accepts the official destructured LXMusic event style', async() => {
    const metadata = parseLXMusicScriptMetadata(OFFICIAL_STYLE_SCRIPT);
    assert.deepEqual(metadata.sources.test.actions, ['musicUrl']);
    const runner = createLXMusicSourceRunner(OFFICIAL_STYLE_SCRIPT);
    assert.equal(
        await runner.requestMusicUrl({ url: 'https://cdn.example.test/song.mp3' }, '320k', 'test'),
        'https://cdn.example.test/song.mp3'
    );
    runner.dispose();
});

test('recognizes CeruMusic CommonJS plugins, blocks initialization requests, and resolves an audio URL', async() => {
    const initializationFetches = [];
    assert.equal(detectOnlineSourceFormat(CERU_MUSIC_PLUGIN), 'cerumusic');
    const parsed = parseOnlineSourceMetadata(CERU_MUSIC_PLUGIN, {
        fetch: async(...args) => {
            initializationFetches.push(args);
            throw new Error('CeruMusic initialization must not reach fetch');
        }
    });
    assert.equal(parsed.name, 'Ceru fixture');
    assert.deepEqual(parsed.sources.kw.qualitys, ['128k', '320k', 'flac']);
    assert.deepEqual(initializationFetches, []);

    const requests = [];
    const runner = createOnlineSourceRunner(CERU_MUSIC_PLUGIN, {
        fetch: async(url, options) => {
            requests.push({ url: String(url), options });
            return new Response(JSON.stringify({ url: 'https://cdn.example.test/ceru.flac' }), {
                status: 200,
                headers: { 'content-type': 'application/json' }
            });
        }
    });
    assert.equal(
        await runner.requestMusicUrl({ hash: 'ceru song' }, 'flac', 'kw'),
        'https://cdn.example.test/ceru.flac'
    );
    runner.dispose();

    assert.equal(requests.length, 1);
    const request = new URL(requests[0].url);
    assert.equal(request.pathname, '/ceru/resolve');
    assert.equal(request.searchParams.get('source'), 'kw');
    assert.equal(request.searchParams.get('songId'), 'ceru song');
    assert.equal(request.searchParams.get('quality'), 'flac');
    assert.equal(requests[0].options.headers['X-Source-Version'], '1.0.0');
});

test('recognizes QT MusicPlugin sources and maps Toolbox audio quality through customFetch', async() => {
    const initializationFetches = [];
    assert.equal(detectOnlineSourceFormat(QT_MUSIC_PLUGIN), 'qt-music');
    const parsed = parseOnlineSourceMetadata(QT_MUSIC_PLUGIN, {
        fetch: async(...args) => {
            initializationFetches.push(args);
            throw new Error('QT initialization must not reach fetch');
        }
    });
    assert.equal(parsed.id, 'qt-fixture');
    assert.equal(parsed.name, 'QT fixture');
    assert.deepEqual(Object.keys(parsed.sources), ['tx']);
    assert.deepEqual(initializationFetches, []);

    const requests = [];
    const runner = createOnlineSourceRunner(QT_MUSIC_PLUGIN, {
        fetch: async(url, options) => {
            requests.push({ url: String(url), options });
            return new Response(JSON.stringify({ url: 'https://cdn.example.test/qt.mp3' }), {
                status: 200,
                headers: { 'content-type': 'application/json' }
            });
        }
    });
    assert.equal(
        await runner.requestMusicUrl({ songmid: 'qt-song' }, '320k', 'tx'),
        'https://cdn.example.test/qt.mp3'
    );
    runner.dispose();

    assert.equal(requests.length, 1);
    const request = new URL(requests[0].url);
    assert.equal(request.pathname, '/qt/resolve');
    assert.equal(request.searchParams.get('source'), 'tx');
    assert.equal(request.searchParams.get('songId'), 'qt-song');
    assert.equal(request.searchParams.get('quality'), 'exhigh');
    assert.equal(requests[0].options.headers['X-Plugin'], 'qt-fixture');
});

test('uses the persisted MusicFree provider ID for search and media resolution', async t => {
    const root = await temporaryDirectory(t);
    assert.equal(detectOnlineSourceFormat(MUSICFREE_MODULE), 'musicfree');
    const imported = await importOnlineSourceScript(MUSICFREE_MODULE, {
        rootPath: root,
        id: 'musicfree-fixture',
        // This represents the display name saved by a MusicFree manifest. It
        // intentionally differs from the module's runtime `platform`.
        name: 'Saved catalog source'
    });
    const importedMetadata = JSON.parse(await fs.readFile(imported.metadataPath, 'utf8'));
    const [importedProviderId] = Object.keys(importedMetadata.sources);
    assert.equal(imported.format, 'musicfree');
    assert.equal(importedMetadata.format, 'musicfree');
    assert.ok(importedProviderId);

    // A manifest entry can have a stable key that differs from a module's
    // display/platform label. Exercise the post-restart path by loading a
    // saved metadata record with that key rather than relying on the runner's
    // freshly evaluated module metadata.
    const providerId = 'manifest_provider_key';
    const persisted = {
        ...importedMetadata,
        sources: {
            [providerId]: importedMetadata.sources[importedProviderId]
        }
    };
    await fs.writeFile(imported.metadataPath, JSON.stringify(persisted, null, 2), 'utf8');
    const savedMetadata = JSON.parse(await fs.readFile(imported.metadataPath, 'utf8'));

    const requests = [];
    const runner = createOnlineSourceRunner(imported.source, {
        format: savedMetadata.format,
        metadata: savedMetadata,
        fetch: async(url, options = {}) => {
            requests.push({ url: String(url), options });
            const request = new URL(String(url));
            if (request.pathname === '/musicfree/search') {
                assert.equal(options.method, 'GET');
                assert.equal(request.searchParams.get('keyword'), 'fixture query');
                assert.equal(request.searchParams.get('page'), '2');
                assert.equal(request.searchParams.get('type'), 'music');
                return new Response(JSON.stringify({
                    items: [{ id: 'musicfree-song', title: 'MusicFree fixture', artist: 'Toolbox' }]
                }), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            if (request.pathname === '/musicfree/resolve') {
                assert.equal(options.method, 'POST');
                assert.deepEqual(JSON.parse(options.body), { id: 'musicfree-song', quality: '320k' });
                return new Response(JSON.stringify({ url: 'https://cdn.example.test/musicfree.mp3' }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' }
                });
            }
            throw new Error(`Unexpected MusicFree request: ${request.pathname}`);
        }
    });
    assert.ok(runner.metadata.sources[providerId]);
    const search = await runner.requestMusicSearch('fixture query', {
        sourceId: providerId,
        page: 2,
        limit: 5
    });
    assert.equal(search.page, 2);
    assert.equal(search.hasMore, false);
    assert.equal(search.results.length, 1);
    assert.equal(search.results[0].id, 'musicfree-song');
    assert.equal(search.results[0].title, 'MusicFree fixture');
    assert.equal(search.results[0].sourceId, providerId);
    assert.equal(
        await runner.requestMusicUrl(search.results[0].musicInfo, 'flac', providerId),
        'https://cdn.example.test/musicfree.mp3'
    );
    runner.dispose();
    assert.equal(requests.length, 2);
});

test('runs the restricted MusicFree crypto, big-integer, and cheerio compatibility surface', async() => {
    const runner = createOnlineSourceRunner(MUSICFREE_CRYPTO_MODULE, {
        format: 'musicfree',
        providerId: 'crypto-fixture'
    });
    const result = await runner.requestMusicSearch('fixture', { sourceId: 'crypto-fixture' });
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].id, '1');
    assert.equal(result.results[0].title, 'A&B2464');
    assert.equal(
        await runner.requestMusicUrl({ id: '1' }, '320k', 'crypto-fixture'),
        'https://cdn.example.test/crypto-fixture.mp3'
    );
    runner.dispose();
});

test('normalizes common search result wrappers and preserves provider IDs', () => {
    const results = normalizeSearchResults({
        name: 'Provider search response',
        source: 'provider-a',
        results: [
            { id: 42, name: 'A song', artists: [{ name: 'A singer' }] },
            { musicInfo: { id: 'b', source: 'provider-b' }, title: 'B song', singer: 'B singer' }
        ]
    });
    assert.equal(results.length, 2);
    assert.equal(results[0].musicInfo.id, 42);
    assert.equal(results[0].title, 'A song');
    assert.equal(results[0].singer, 'A singer');
    assert.equal(results[0].artist, 'A singer');
    assert.equal(results[0].source, 'provider-a');
    assert.equal(results[0].sourceId, 'provider-a');
    assert.equal(results[1].musicInfo.source, 'provider-b');
    assert.equal(results[1].title, 'B song');
});

test('keeps cyclic and oversized search metadata serializable and bounded', () => {
    const cyclic = { id: 'cycle', name: 'Cycle song' };
    cyclic.self = cyclic;
    cyclic.payload = 'x'.repeat(200_000);
    const results = normalizeSearchResults({ list: [cyclic] }, {
        limits: { maxSearchItemBytes: 1024 }
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].musicInfo.id, 'cycle');
    assert.doesNotThrow(() => JSON.stringify(results));
    assert.ok(Buffer.byteLength(JSON.stringify(results), 'utf8') < 8 * 1024);
});

test('supports the optional search action without changing musicUrl scripts', async() => {
    const metadata = parseLXMusicScriptMetadata(SEARCH_SCRIPT);
    assert.deepEqual(metadata.sources.kg.actions, ['musicUrl', 'search']);
    const runner = createLXMusicSourceRunner(SEARCH_SCRIPT);
    const results = await runner.requestMusicSearch('hello', 2, 2, 'kg');
    assert.equal(results.length, 2);
    assert.deepEqual(results.map(item => item.title), ['First song', 'Second song']);
    assert.equal(results[0].singer, 'One');
    assert.equal(results[0].musicInfo.source, 'kg');
    assert.equal(results[1].musicInfo.id, 'song-2');
    runner.dispose();
});

test('rejects search requests for providers that do not declare the extension', async() => {
    const runner = createLXMusicSourceRunner(SAMPLE_SCRIPT);
    await assert.rejects(runner.requestMusicSearch('hello'), error => error.code === 'unsupported-action');
    runner.dispose();
});

test('bounds optional search results and accepts the musicSearch alias', async() => {
    const script = `
      const { EVENT_NAMES, on, send } = globalThis.lx;
      on(EVENT_NAMES.request, ({ action }) => action === 'musicSearch'
        ? Array.from({ length: 5 }, (_, index) => ({ id: index, title: 'Song ' + index }))
        : 'https://cdn.example.test/song.mp3');
      send(EVENT_NAMES.inited, {
        sources: { test: { type: 'music', actions: ['musicSearch'], qualitys: [] } }
      });`;
    const runner = createLXMusicSourceRunner(script, { limits: { maxSearchResults: 2 } });
    const results = await runner.searchMusic({ query: 'songs', sourceId: 'test', limit: 10 });
    assert.equal(results.length, 2);
    assert.deepEqual(results.map(item => item.id), ['0', '1']);
    runner.dispose();
});

test('falls back to a provider-supported quality', async() => {
    const script = `
      const { EVENT_NAMES, on, send } = globalThis.lx;
      on(EVENT_NAMES.request, ({ info }) => Promise.resolve(
        'https://cdn.example.test/' + info.type + '.mp3'
      ));
      send(EVENT_NAMES.inited, {
        sources: { only128: { type: 'music', actions: ['musicUrl'], qualitys: ['128k'] } }
      });`;
    const runner = createLXMusicSourceRunner(script);
    assert.equal(
        await runner.requestMusicUrl({ id: 'song' }, '320k', 'only128'),
        'https://cdn.example.test/128k.mp3'
    );
    runner.dispose();
});

test('provides the official buffer, crypto and zlib utility surface', async() => {
    const script = `
      const { EVENT_NAMES, on, send, utils } = globalThis.lx;
      on(EVENT_NAMES.request, async () => {
        const input = utils.buffer.from('toolbox');
        const packed = await utils.zlib.deflate(input);
        const unpacked = await utils.zlib.inflate(packed);
        const encrypted = utils.crypto.aesEncrypt(
          input,
          'aes-128-ecb',
          utils.buffer.from('0123456789abcdef'),
          ''
        );
        if (input.toString('base64') !== 'dG9vbGJveA==' ||
            utils.buffer.bufToString(unpacked) !== 'toolbox' ||
            utils.crypto.md5(input) !== '0e842b75e5f8473161ee799ef5a129fd' ||
            !encrypted.length || !utils.crypto.randomBytes(8).length) {
          throw new Error('LX utility compatibility failure');
        }
        return 'https://cdn.example.test/utility.mp3';
      });
      send(EVENT_NAMES.inited, {
        sources: { test: { type: 'music', actions: ['musicUrl'], qualitys: ['320k'] } }
      });`;
    const runner = createLXMusicSourceRunner(script);
    assert.equal(await runner.requestMusicUrl({ id: 'utility' }, '320k', 'test'), 'https://cdn.example.test/utility.mp3');
    runner.dispose();
});

test('rejects scripts that try to access Node or omit the LX protocol', () => {
    assert.throws(() => validateLXMusicUserApiScript('process.exit()'), error => error.code === 'unsafe-script');
    assert.throws(() => validateLXMusicUserApiScript('const answer = 42;'), error => error.code === 'invalid-script');
});

test('runs musicUrl handlers in a restricted VM', async() => {
    const runner = createLXMusicSourceRunner(SAMPLE_SCRIPT);
    assert.equal(await runner.requestMusicUrl({ id: 'song/1' }, '320k', 'test'), 'https://cdn.example.test/song%2F1.mp3');
    runner.dispose();
    await assert.rejects(runner.requestMusicUrl({ id: 'again' }), error => error.code === 'disposed');
});

test('bridges lx.request and bounds response data', async() => {
    const requests = [];
    const script = `
      lx.send('inited', { sources: { test: { type: 'music', actions: ['musicUrl'], qualitys: ['128k'] } } });
      lx.on('request', ({ action }) => new Promise((resolve, reject) => {
        lx.request('https://api.example.test/resolve', { timeout: 1000 }, (error, response) => {
          if (error) return reject(error);
          resolve(response.body.url);
        });
      }));`;
    const runner = createLXMusicSourceRunner(script, {
        fetch: async(url) => {
            requests.push(url);
            return new Response(JSON.stringify({ url: 'https://cdn.example.test/ok.ogg' }), {
                status: 200,
                headers: { 'content-type': 'application/json' }
            });
        }
    });
    assert.equal(await runner.requestMusicUrl({ id: 'song' }, '128k', 'test'), 'https://cdn.example.test/ok.ogg');
    assert.deepEqual(requests, ['https://api.example.test/resolve']);
    runner.dispose();
});

test('bridges multipart formData and preserves non-2xx response details', async() => {
    let requestBody;
    const script = `
      lx.send('inited', { sources: { test: { type: 'music', actions: ['musicUrl'], qualitys: ['128k'] } } });
      lx.on('request', () => new Promise((resolve, reject) => {
        lx.request('https://api.example.test/form', {
          method: 'POST',
          formData: { hello: 'world' }
        }, (error, response) => {
          if (error) return reject(error);
          if (response.statusCode !== 404 || response.body.url !== 'https://cdn.example.test/form.mp3') {
            return reject(new Error('response shape mismatch'));
          }
          resolve(response.body.url);
        });
      }));`;
    const runner = createLXMusicSourceRunner(script, {
        fetch: async(_url, options) => {
            requestBody = options.body;
            return new Response(JSON.stringify({ url: 'https://cdn.example.test/form.mp3' }), {
                status: 404,
                headers: { 'content-type': 'application/json' }
            });
        }
    });
    assert.equal(await runner.requestMusicUrl({ id: 'form' }, '128k', 'test'), 'https://cdn.example.test/form.mp3');
    assert.ok(requestBody instanceof FormData);
    assert.equal(requestBody.get('hello'), 'world');
    runner.dispose();
});

test('imports local and remote scripts into a controlled directory', async t => {
    const root = await temporaryDirectory(t);
    const localPath = path.join(root, 'source.js');
    await fs.writeFile(localPath, SAMPLE_SCRIPT, 'utf8');
    const importedLocal = await importLXMusicUserApiScript(localPath, { rootPath: path.join(root, 'installed') });
    assert.equal(importedLocal.sourcePath, localPath);
    assert.equal(await fs.readFile(importedLocal.scriptPath, 'utf8'), SAMPLE_SCRIPT);
    assert.equal(JSON.parse(await fs.readFile(importedLocal.metadataPath, 'utf8')).name, 'Test source');

    const importedRemote = await importLXMusicUserApiScript('https://example.test/source.js', {
        fetch: async() => new Response(SAMPLE_SCRIPT, { status: 200 }),
        rootPath: path.join(root, 'remote-installed'),
        id: 'remote-test'
    });
    assert.equal(importedRemote.id, 'remote-test');
    assert.equal(importedRemote.sourceUrl, 'https://example.test/source.js');
});

test('persists providers announced through a dynamic source declaration', async t => {
    const root = await temporaryDirectory(t);
    const imported = await importLXMusicUserApiScript(DYNAMIC_SOURCES_SCRIPT, {
        rootPath: root,
        id: 'dynamic-sources'
    });

    assert.deepEqual(Object.keys(imported.metadata.sources), ['kg', 'wy']);
    const savedMetadata = JSON.parse(await fs.readFile(imported.metadataPath, 'utf8'));
    assert.deepEqual(Object.keys(savedMetadata.sources), ['kg', 'wy']);
});

test('accepts LXMusic gz_ scripts supplied as an encoded string', async t => {
    const root = await temporaryDirectory(t);
    const encoded = `gz_${zlib.deflateSync(Buffer.from(SAMPLE_SCRIPT, 'utf8')).toString('base64')}`;
    assert.equal(decodeCompressedScript(encoded), SAMPLE_SCRIPT);
    const imported = await importLXMusicUserApiScript(encoded, { rootPath: root, id: 'compressed-test' });
    assert.equal(imported.source, SAMPLE_SCRIPT);
    assert.equal(await fs.readFile(imported.scriptPath, 'utf8'), SAMPLE_SCRIPT);
});

test('downloads bounded audio into the requested root and infers its extension', async t => {
    const root = await temporaryDirectory(t);
    const result = await downloadAudioUrl('https://cdn.example.test/song?id=1', {
        rootPath: root,
        fetch: async() => new Response(Buffer.from('audio-data'), {
            status: 200,
            headers: { 'content-type': 'audio/ogg' }
        }),
        fileName: 'My song'
    });
    assert.equal(result.fileName, 'My song.ogg');
    assert.equal(await fs.readFile(result.path, 'utf8'), 'audio-data');
    assert.equal(path.dirname(result.path), path.resolve(root));
});

test('streams a download into a temporary file instead of buffering the full body', async t => {
    const root = await temporaryDirectory(t);
    let usedArrayBuffer = false;
    const response = {
        status: 200,
        headers: new Headers({ 'content-type': 'audio/mpeg' }),
        body: new ReadableStream({
            start(controller) {
                controller.enqueue(Buffer.from('audio-'));
                controller.enqueue(Buffer.from('data'));
                controller.close();
            }
        }),
        arrayBuffer: async() => {
            usedArrayBuffer = true;
            throw new Error('The body should be streamed');
        }
    };
    const result = await downloadAudioUrl('https://cdn.example.test/stream', {
        rootPath: root,
        fetch: async() => response,
        fileName: 'stream'
    });

    assert.equal(usedArrayBuffer, false);
    assert.equal(result.size, 10);
    assert.equal(await fs.readFile(result.path, 'utf8'), 'audio-data');
});

test('fails before writing an oversized audio response', async t => {
    const root = await temporaryDirectory(t);
    await assert.rejects(downloadAudioUrl('https://cdn.example.test/large', {
        rootPath: root,
        limits: { maxDownloadBytes: 3 },
        fetch: async() => new Response(Buffer.from('1234'), { status: 200 })
    }), error => error instanceof OnlineSourceError && error.code === 'response-too-large');
    assert.deepEqual(await fs.readdir(root), []);
});
