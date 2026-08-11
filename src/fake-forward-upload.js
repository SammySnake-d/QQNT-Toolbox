'use strict';

const crypto = require('crypto');
const path = require('path');

const MAX_FAKE_FORWARD_TRANSFER_ID = 0x7fffffff;
const RICH_MEDIA_UPLOAD_COMPLETE_COMMAND = 'nodeIKernelMsgListener/onRichMediaUploadComplete';

function normalizeText(value) {
    return String(value ?? '').trim();
}

function normalizeIdentifier(value) {
    const text = normalizeText(value);
    return text && text !== '0' && text !== 'undefined' && text !== 'null' ? text : '';
}

function normalizeComparableUploadPath(value) {
    let text = normalizeText(value);
    if (!text) {
        return '';
    }
    try {
        if (/^file:\/\//i.test(text)) {
            text = decodeURIComponent(text.replace(/^file:\/{2,3}/i, ''));
        }
    } catch {
    }
    return text.replace(/\//g, '\\').replace(/^\\+([a-z]:)/i, '$1').toLowerCase();
}

function getUploadPathName(value) {
    const comparable = normalizeComparableUploadPath(value);
    return comparable ? path.win32.basename(comparable) : '';
}

function pathsReferToSameUpload(candidate, expected) {
    const candidatePath = normalizeComparableUploadPath(candidate);
    const expectedPath = normalizeComparableUploadPath(expected);
    if (!candidatePath || !expectedPath) {
        return false;
    }
    if (candidatePath === expectedPath) {
        return true;
    }
    const candidateName = getUploadPathName(candidatePath);
    return Boolean(candidateName) && candidateName === getUploadPathName(expectedPath);
}

function uploadPathsMatchExactly(candidate, expected) {
    const candidatePath = normalizeComparableUploadPath(candidate);
    const expectedPath = normalizeComparableUploadPath(expected);
    return Boolean(candidatePath) && candidatePath === expectedPath;
}

function createFakeForwardTransferId(randomInt = crypto.randomInt) {
    return randomInt(1, MAX_FAKE_FORWARD_TRANSFER_ID + 1);
}

function getNativeCommandName(value) {
    if (!value || typeof value !== 'object') {
        return '';
    }
    for (const candidate of [
        value.cmdName,
        value.eventName,
        value.command?.cmdName,
        value.data?.cmdName,
        value.payload?.cmdName
    ]) {
        const command = normalizeText(candidate);
        if (command) {
            return command;
        }
    }
    return '';
}

function isRichMediaUploadCompleteEvent(response, result) {
    const command = getNativeCommandName(result) || getNativeCommandName(response);
    return command.toLowerCase().endsWith(RICH_MEDIA_UPLOAD_COMPLETE_COMMAND.toLowerCase());
}

function getCandidateUploadPaths(value) {
    return [
        value?.filePath,
        value?.localPath,
        value?.path,
        value?.fileName,
        value?.commonFileInfo?.filePath,
        value?.commonFileInfo?.localPath,
        value?.commonFileInfo?.fileName
    ].map(normalizeText).filter(Boolean);
}

function getCandidateUploadIdentifiers(value) {
    return [
        value?.transferId,
        value?.fileModelId,
        value?.taskId,
        value?.commonFileInfo?.transferId,
        value?.commonFileInfo?.fileModelId,
        value?.commonFileInfo?.taskId
    ].map(normalizeIdentifier).filter(Boolean);
}

function isUploadInfo(value) {
    return Boolean(value?.commonFileInfo) ||
        value?.fileErrCode !== undefined ||
        value?.fileId !== undefined ||
        value?.uuid !== undefined;
}

function uploadInfoMatches(value, criteria, inheritedIdentifiers = []) {
    const expectedIdentifiers = [criteria.transferId, criteria.fileModelId]
        .map(normalizeIdentifier)
        .filter(Boolean);
    const ownIdentifiers = getCandidateUploadIdentifiers(value);
    const candidateIdentifiers = ownIdentifiers.length ? ownIdentifiers : inheritedIdentifiers;
    const matchesIdentifier = expectedIdentifiers.length > 0 &&
        candidateIdentifiers.some(candidate => expectedIdentifiers.includes(candidate));
    const expectedPath = normalizeText(criteria.filePath);
    const candidatePaths = getCandidateUploadPaths(value);
    const matchesExactPath = Boolean(expectedPath) &&
        candidatePaths.some(candidate => uploadPathsMatchExactly(candidate, expectedPath));
    const matchesPath = Boolean(expectedPath) &&
        candidatePaths.some(candidate => pathsReferToSameUpload(candidate, expectedPath));
    if (!expectedIdentifiers.length && !expectedPath) {
        return true;
    }
    if (matchesIdentifier || matchesExactPath) {
        return true;
    }
    return (!expectedIdentifiers.length || !candidateIdentifiers.length) && matchesPath;
}

function findRichMediaUploadInfo(
    value,
    criteria = {},
    depth = 0,
    seen = new WeakSet(),
    inheritedIdentifiers = []
) {
    if (!value || typeof value !== 'object' || value instanceof Uint8Array || depth > 8 || seen.has(value)) {
        return null;
    }
    seen.add(value);
    const ownIdentifiers = getCandidateUploadIdentifiers(value);
    const candidateIdentifiers = ownIdentifiers.length ? ownIdentifiers : inheritedIdentifiers;
    if (isUploadInfo(value) && uploadInfoMatches(value, criteria, inheritedIdentifiers)) {
        return value;
    }
    const children = value instanceof Map ? value.values() : Object.values(value);
    for (const child of children) {
        const found = findRichMediaUploadInfo(
            child,
            criteria,
            depth + 1,
            seen,
            candidateIdentifiers
        );
        if (found) {
            return found;
        }
    }
    return null;
}

function summarizeRichMediaUploadEvent(response, result, criteria = {}) {
    const uploadInfo = findRichMediaUploadInfo(result, {}) || findRichMediaUploadInfo(response, {});
    const matched = Boolean(
        findRichMediaUploadInfo(result, criteria) || findRichMediaUploadInfo(response, criteria)
    );
    return {
        command: getNativeCommandName(result) || getNativeCommandName(response),
        matched,
        transferId: normalizeIdentifier(
            uploadInfo?.transferId || uploadInfo?.commonFileInfo?.transferId
        ),
        fileModelId: normalizeIdentifier(
            uploadInfo?.fileModelId || uploadInfo?.commonFileInfo?.fileModelId
        ),
        fileName: getUploadPathName(
            uploadInfo?.filePath ||
            uploadInfo?.localPath ||
            uploadInfo?.fileName ||
            uploadInfo?.commonFileInfo?.filePath ||
            uploadInfo?.commonFileInfo?.fileName
        ),
        fileErrCode: uploadInfo?.fileErrCode,
        hasFileId: Boolean(uploadInfo?.fileId || uploadInfo?.commonFileInfo?.uuid)
    };
}

function waitForFakeForwardUploadResult(invocation, eventPromise, criteria, onInvocationSettled) {
    const invocationResult = Promise.resolve(invocation).then(result => {
        const uploadInfo = findRichMediaUploadInfo(result, criteria);
        onInvocationSettled?.({ result, usable: Boolean(uploadInfo) });
        return uploadInfo ? result : new Promise(() => {});
    });
    return Promise.race([eventPromise, invocationResult]);
}

module.exports = {
    MAX_FAKE_FORWARD_TRANSFER_ID,
    RICH_MEDIA_UPLOAD_COMPLETE_COMMAND,
    createFakeForwardTransferId,
    findRichMediaUploadInfo,
    getNativeCommandName,
    isRichMediaUploadCompleteEvent,
    normalizeComparableUploadPath,
    pathsReferToSameUpload,
    summarizeRichMediaUploadEvent,
    waitForFakeForwardUploadResult
};
