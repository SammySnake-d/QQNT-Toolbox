'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
    MAX_FAKE_FORWARD_TRANSFER_ID,
    createFakeForwardTransferId,
    findRichMediaUploadInfo,
    isRichMediaUploadCompleteEvent,
    pathsReferToSameUpload,
    summarizeRichMediaUploadEvent,
    waitForFakeForwardUploadResult
} = require('../src/fake-forward-upload');

function uploadEvent(transferId, filePath, fileId = `/media-${transferId}`) {
    return {
        eventName: 'nodeIKernelMsgListener/onRichMediaUploadComplete',
        payload: {
            transferId,
            fileModelId: String(transferId),
            filePath,
            fileId,
            fileErrCode: '0',
            commonFileInfo: { uuid: fileId, filePath }
        }
    };
}

test('creates positive signed 32-bit transfer ids', () => {
    let receivedMin = 0;
    let receivedMax = 0;
    const transferId = createFakeForwardTransferId((min, max) => {
        receivedMin = min;
        receivedMax = max;
        return max - 1;
    });

    assert.equal(receivedMin, 1);
    assert.equal(receivedMax, MAX_FAKE_FORWARD_TRANSFER_ID + 1);
    assert.equal(transferId, MAX_FAKE_FORWARD_TRANSFER_ID);
});

test('matches upload paths across file URLs and path separator changes', () => {
    assert.equal(pathsReferToSameUpload(
        'file:///C:/Temp/qqnt-toolbox-fake-forward-abc.png',
        'C:\\Temp\\qqnt-toolbox-fake-forward-abc.png'
    ), true);
    assert.equal(pathsReferToSameUpload(
        'D:\\QQCache\\qqnt-toolbox-fake-forward-abc.png',
        'C:\\Temp\\qqnt-toolbox-fake-forward-abc.png'
    ), true);
    assert.equal(pathsReferToSameUpload('one.png', 'two.png'), false);
});

test('keeps concurrent upload completion events correlated by transfer id', () => {
    const first = uploadEvent(101, 'C:\\Temp\\first.png');
    const second = uploadEvent(202, 'C:\\Temp\\second.png');
    const firstCriteria = {
        transferId: 101,
        fileModelId: '101',
        filePath: 'C:\\Temp\\first.png'
    };

    assert.equal(isRichMediaUploadCompleteEvent({}, first), true);
    assert.equal(findRichMediaUploadInfo(first, firstCriteria)?.fileId, '/media-101');
    assert.equal(findRichMediaUploadInfo(second, firstCriteria), null);
    assert.deepEqual(summarizeRichMediaUploadEvent({}, first, firstCriteria), {
        command: 'nodeIKernelMsgListener/onRichMediaUploadComplete',
        matched: true,
        transferId: '101',
        fileModelId: '101',
        fileName: 'first.png',
        fileErrCode: '0',
        hasFileId: true
    });
});

test('uses exact paths or explicit ids before falling back to a relocated file name', () => {
    const expected = {
        fileModelId: '101',
        filePath: 'C:\\Temp\\same.png'
    };
    const otherTask = uploadEvent(202, 'D:\\QQCache\\same.png');
    const exactPathWithAnotherModel = uploadEvent(202, 'C:\\Temp\\same.png');
    const legacyWithoutTaskId = uploadEvent(undefined, 'D:\\QQCache\\same.png');
    delete legacyWithoutTaskId.payload.transferId;
    delete legacyWithoutTaskId.payload.fileModelId;

    assert.equal(findRichMediaUploadInfo(otherTask, expected), null);
    assert.equal(findRichMediaUploadInfo(exactPathWithAnotherModel, expected)?.fileId, '/media-202');
    assert.equal(findRichMediaUploadInfo(legacyWithoutTaskId, expected)?.fileId, '/media-undefined');
});

test('correlates image uploads by path without assuming transfer id becomes file model id', () => {
    const event = uploadEvent(98765, 'D:\\QQCache\\image.png');
    assert.equal(findRichMediaUploadInfo(event, {
        filePath: 'C:\\Temp\\image.png'
    })?.fileId, '/media-98765');
});

test('accepts direct native upload results and otherwise keeps waiting for the event', async () => {
    const criteria = { transferId: 303, fileModelId: '303', filePath: 'C:\\Temp\\third.png' };
    const event = uploadEvent(303, 'C:\\Temp\\third.png');
    const settled = [];
    const fromEvent = await waitForFakeForwardUploadResult(
        Promise.resolve(undefined),
        Promise.resolve(event),
        criteria,
        value => settled.push(value.usable)
    );
    assert.equal(fromEvent, event);
    assert.deepEqual(settled, [false]);

    const direct = uploadEvent(303, 'C:\\Temp\\third.png').payload;
    const fromInvocation = await waitForFakeForwardUploadResult(
        Promise.resolve(direct),
        new Promise(() => {}),
        criteria
    );
    assert.equal(fromInvocation, direct);

    await assert.rejects(waitForFakeForwardUploadResult(
        Promise.reject(new Error('native upload rejected')),
        new Promise(() => {}),
        criteria
    ), /native upload rejected/);
});

test('ships the upload helper in release packages', () => {
    const releaseScript = fs.readFileSync(
        path.join(__dirname, '..', 'tools', 'build-release.ps1'),
        'utf8'
    );
    assert.match(releaseScript, /QQNT-Toolbox\/src\/fake-forward-upload\.js/);
});
