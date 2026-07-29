'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    normalizeSizeUnit,
    normalizeSizeValue,
    sizeToBytes,
    getAutoDownloadPeerDescriptor,
    normalizeAutoDownloadFilterPeers,
    normalizeAutoDownloadFileConfig,
    isAutoDownloadSizeAllowed,
    shouldAutoDownloadForPeer,
    getFileElementIdentity,
    collectAutoDownloadFileTargets
} = require('../src/auto-download-file');

const GROUP = { chatType: 2, peerUid: '10086' };
const OTHER_GROUP = { chatType: 2, peerUid: '20024' };

function baseConfig(overrides = {}) {
    return normalizeAutoDownloadFileConfig({
        enabled: true,
        minSizeValue: 1,
        minSizeUnit: 'KB',
        filterPeers: [{ ...GROUP, label: '测试群' }],
        ...overrides
    });
}

test('normalizes size units and values with a safe fallback', () => {
    assert.equal(normalizeSizeUnit('mb'), 'MB');
    assert.equal(normalizeSizeUnit('kb'), 'KB');
    assert.equal(normalizeSizeUnit('unknown'), 'MB');
    assert.equal(normalizeSizeValue(-5), 0);
    assert.equal(normalizeSizeValue('12.9'), 12);
    assert.equal(sizeToBytes(2, 'KB'), 2048);
    assert.equal(sizeToBytes(1, 'MB'), 1024 * 1024);
});

test('only accepts group peers with a usable id', () => {
    assert.equal(getAutoDownloadPeerDescriptor(GROUP).key, '2:10086');
    assert.equal(getAutoDownloadPeerDescriptor({ chatType: 1, peerUid: 'u_x' }), null);
    assert.equal(getAutoDownloadPeerDescriptor({ chatType: 2 }), null);
});

test('deduplicates and bounds the group whitelist', () => {
    const peers = normalizeAutoDownloadFilterPeers([
        { ...GROUP, label: '群A' },
        { ...GROUP, label: '群A-dup' },
        { chatType: 1, peerUid: 'u_friend' },
        { ...OTHER_GROUP, label: '群B' }
    ]);
    assert.deepEqual(peers.map(peer => peer.key), ['2:10086', '2:20024']);
});

test('empty whitelist downloads nothing', () => {
    const config = baseConfig({ filterPeers: [] });
    assert.equal(shouldAutoDownloadForPeer(config, GROUP), false);
    assert.deepEqual(collectAutoDownloadFileTargets(config, {
        ...GROUP,
        elements: [{ fileElement: { fileName: 'a.zip', fileSize: 4096, fileMd5: 'abc' } }]
    }), []);
});

test('private chats are never eligible even if listed', () => {
    const config = baseConfig({ filterPeers: [{ chatType: 1, peerUid: 'u_friend', label: '好友' }] });
    assert.equal(shouldAutoDownloadForPeer(config, { chatType: 1, peerUid: 'u_friend' }), false);
});

test('enforces the required lower bound and optional upper bound', () => {
    const config = baseConfig({
        minSizeValue: 1,
        minSizeUnit: 'KB',
        maxSizeEnabled: true,
        maxSizeValue: 1,
        maxSizeUnit: 'MB'
    });
    assert.equal(isAutoDownloadSizeAllowed(config, 8), false);
    assert.equal(isAutoDownloadSizeAllowed(config, 1024), true);
    assert.equal(isAutoDownloadSizeAllowed(config, 1024 * 1024), true);
    assert.equal(isAutoDownloadSizeAllowed(config, 1024 * 1024 + 1), false);
    assert.equal(isAutoDownloadSizeAllowed(config, 0), false);
});

test('an unbounded max keeps large files eligible', () => {
    const config = baseConfig({ minSizeValue: 1, minSizeUnit: 'B', maxSizeEnabled: false });
    assert.equal(isAutoDownloadSizeAllowed(config, 500 * 1024 * 1024), true);
});

test('rejects an inverted min/max range', () => {
    const config = baseConfig({
        minSizeValue: 10,
        minSizeUnit: 'MB',
        maxSizeEnabled: true,
        maxSizeValue: 1,
        maxSizeUnit: 'MB'
    });
    assert.equal(isAutoDownloadSizeAllowed(config, 5 * 1024 * 1024), false);
});

test('builds a stable identity for dedup', () => {
    assert.equal(getFileElementIdentity({ fileMd5: 'ABC' }), 'md5:abc');
    assert.equal(getFileElementIdentity({ fileUuid: 'uuid-1' }), 'uuid:uuid-1');
    assert.equal(getFileElementIdentity({ fileName: 'a.txt', fileSize: 5 }), 'name:a.txt:5');
    assert.equal(getFileElementIdentity({}), '');
});

test('collects only eligible file targets from a whitelisted group', () => {
    const config = baseConfig({ minSizeValue: 1, minSizeUnit: 'KB' });
    const targets = collectAutoDownloadFileTargets(config, {
        ...GROUP,
        elements: [
            { textElement: { content: 'hi' } },
            { fileElement: { fileName: 'tiny.txt', fileSize: 8, fileMd5: 'aaa' } },
            { fileElement: { fileName: 'doc.pdf', fileSize: 5000, fileMd5: 'bbb' } },
            { picElement: {} }
        ]
    });
    assert.equal(targets.length, 1);
    assert.equal(targets[0].fileName, 'doc.pdf');
    assert.equal(targets[0].identity, 'md5:bbb');
    assert.equal(targets[0].index, 2);
});
