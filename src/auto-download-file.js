'use strict';

const SIZE_UNITS = Object.freeze({
    B: 1,
    KB: 1024,
    MB: 1024 * 1024,
    GB: 1024 * 1024 * 1024
});

const SIZE_UNIT_NAMES = Object.freeze(Object.keys(SIZE_UNITS));
const MAX_FILTER_PEERS = 256;
const MAX_SIZE_VALUE = 1024 * 1024;

function normalizeText(value) {
    return String(value ?? '').trim();
}

function normalizeSizeUnit(value) {
    const unit = normalizeText(value).toUpperCase();
    return SIZE_UNITS[unit] ? unit : 'MB';
}

function normalizeSizeValue(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) {
        return 0;
    }
    return Math.min(Math.floor(number), MAX_SIZE_VALUE);
}

function sizeToBytes(value, unit) {
    return normalizeSizeValue(value) * SIZE_UNITS[normalizeSizeUnit(unit)];
}

function getAutoDownloadPeerDescriptor(value) {
    const chatType = Number(
        value?.chatType || value?.peer?.chatType || value?.contact?.chatType
    ) || 0;
    if (chatType !== 2) {
        return null;
    }
    const peerUid = normalizeText(
        value?.peerUid || value?.peerUin || value?.peer?.peerUid || value?.peer?.peerUin ||
        value?.contact?.peerUid || value?.contact?.peerUin
    );
    if (!peerUid) {
        return null;
    }
    return {
        key: `2:${peerUid}`,
        chatType: 2,
        peerUid
    };
}

function normalizeAutoDownloadFilterPeers(values) {
    const peers = new Map();
    for (const source of Array.isArray(values) ? values : []) {
        const descriptor = getAutoDownloadPeerDescriptor(source);
        if (!descriptor || peers.has(descriptor.key)) {
            continue;
        }
        peers.set(descriptor.key, {
            ...descriptor,
            label: normalizeText(source?.label).slice(0, 80)
        });
        if (peers.size >= MAX_FILTER_PEERS) {
            break;
        }
    }
    return Array.from(peers.values());
}

function normalizeAutoDownloadFileConfig(config = {}) {
    const source = config && typeof config === 'object' ? config : {};
    return {
        enabled: source.enabled === true,
        minSizeValue: normalizeSizeValue(source.minSizeValue),
        minSizeUnit: normalizeSizeUnit(source.minSizeUnit),
        maxSizeEnabled: source.maxSizeEnabled === true,
        maxSizeValue: normalizeSizeValue(source.maxSizeValue),
        maxSizeUnit: normalizeSizeUnit(source.maxSizeUnit),
        filterPeers: normalizeAutoDownloadFilterPeers(source.filterPeers)
    };
}

function getAutoDownloadSizeBounds(config) {
    const normalized = normalizeAutoDownloadFileConfig(config);
    const min = sizeToBytes(normalized.minSizeValue, normalized.minSizeUnit);
    const max = normalized.maxSizeEnabled
        ? sizeToBytes(normalized.maxSizeValue, normalized.maxSizeUnit)
        : Infinity;
    return { min, max };
}

function isAutoDownloadSizeAllowed(config, fileSize) {
    const size = Number(fileSize);
    if (!Number.isFinite(size) || size <= 0) {
        return false;
    }
    const { min, max } = getAutoDownloadSizeBounds(config);
    if (max !== Infinity && min > max) {
        return false;
    }
    return size >= min && size <= max;
}

function shouldAutoDownloadForPeer(config, record) {
    const descriptor = getAutoDownloadPeerDescriptor(record);
    if (!descriptor) {
        return false;
    }
    const normalized = normalizeAutoDownloadFileConfig(config);
    return normalized.filterPeers.some(peer => peer.key === descriptor.key);
}

function getFileElementIdentity(fileElement) {
    const md5 = normalizeText(fileElement?.fileMd5 || fileElement?.md5).toLowerCase();
    if (md5) {
        return `md5:${md5}`;
    }
    const uuid = normalizeText(fileElement?.fileUuid || fileElement?.fileModelId);
    if (uuid) {
        return `uuid:${uuid}`;
    }
    const name = normalizeText(fileElement?.fileName);
    const size = Number(fileElement?.fileSize) || 0;
    return name || size ? `name:${name}:${size}` : '';
}

function collectAutoDownloadFileTargets(config, record) {
    if (!shouldAutoDownloadForPeer(config, record)) {
        return [];
    }
    const elements = Array.isArray(record?.elements) ? record.elements : [];
    const targets = [];
    for (let index = 0; index < elements.length; index++) {
        const element = elements[index];
        const fileElement = element?.fileElement;
        if (!fileElement) {
            continue;
        }
        const fileSize = Number(fileElement.fileSize) || 0;
        if (!isAutoDownloadSizeAllowed(config, fileSize)) {
            continue;
        }
        const identity = getFileElementIdentity(fileElement);
        if (!identity) {
            continue;
        }
        targets.push({
            index,
            element,
            fileElement,
            identity,
            fileName: normalizeText(fileElement.fileName) || '文件',
            fileSize
        });
    }
    return targets;
}

module.exports = {
    SIZE_UNITS,
    SIZE_UNIT_NAMES,
    MAX_FILTER_PEERS,
    MAX_SIZE_VALUE,
    normalizeSizeUnit,
    normalizeSizeValue,
    sizeToBytes,
    getAutoDownloadPeerDescriptor,
    normalizeAutoDownloadFilterPeers,
    normalizeAutoDownloadFileConfig,
    getAutoDownloadSizeBounds,
    isAutoDownloadSizeAllowed,
    shouldAutoDownloadForPeer,
    getFileElementIdentity,
    collectAutoDownloadFileTargets
};
