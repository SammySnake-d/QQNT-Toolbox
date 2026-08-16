'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { gunzipSync, inflateSync } = require('node:zlib');
const test = require('node:test');

const {
    C2C_PULL_COMMAND,
    GROUP_PULL_COMMAND,
    LONG_MESSAGE_COMMAND,
    PROTO_SEND_COMMAND,
    buildDirectElementRequest,
    buildLongMessageUploadRequest,
    buildNativeSendRequest,
    buildPullMessageRequest,
    createForwardCard,
    createLongMessageReferenceElements,
    createPullMessageViews,
    createXmlElements,
    decodeGenericProtobuf,
    encodeGenericProtobuf,
    extractLongMessageResid,
    normalizeArkJson,
    parseElementJson,
    summarizeResponseShape
} = require('../src/message-packet');

test('encodes and decodes generic numeric-field protobuf', () => {
    const input = {
        '1': 123,
        '2': { '1': 'hello', '2': 'hex->00ff' },
        '3': [{ '1': 1 }, { '1': 2 }],
        '4': true
    };
    const decoded = decodeGenericProtobuf(encodeGenericProtobuf(input));
    assert.equal(decoded['1'], 123);
    assert.equal(decoded['2']['1'], 'hello');
    assert.equal(decoded['2']['2'], 'hex->00ff');
    assert.deepEqual(decoded['3'], [{ '1': 1 }, { '1': 2 }]);
    assert.equal(decoded['4'], 1);
});

test('validates element JSON and Ark JSON independently', () => {
    assert.deepEqual(parseElementJson('{"1":{"1":"hello"}}').elements, [
        { '1': { '1': 'hello' } }
    ]);
    assert.equal(parseElementJson('[{"1":{"1":"a"}},{"1":{"1":"b"}}]').elements.length, 2);
    assert.equal(normalizeArkJson(' {"app":"com.tencent.test"} '), '{"app":"com.tencent.test"}');
    assert.throws(() => parseElementJson('{"name":"bad"}'), /字段.*无效/);
    assert.throws(() => parseElementJson('[]'), /不能为空数组/);
    assert.throws(() => normalizeArkJson('[]'), /顶层必须是对象/);
});

test('builds native Ark and text requests', () => {
    const attributes = new Map([[0, { attrId: '123' }]]);
    const peer = { chatType: 1, peerUid: 'u_private' };
    assert.deepEqual(buildNativeSendRequest(peer, 'text', 'hello', attributes).msgElements, [{
        elementType: 1,
        elementId: '',
        textElement: { content: 'hello' }
    }]);
    assert.deepEqual(buildNativeSendRequest(peer, 'ark', '{}', attributes).msgElements, [{
        elementType: 10,
        elementId: '',
        arkElement: { bytesData: '{}' }
    }]);
});

test('builds direct group and private element packets', () => {
    const elements = [{ '1': { '1': 'hello' } }];
    const group = buildDirectElementRequest(
        { chatType: 2, peerUid: '998877' },
        elements,
        { msgSeq: 10, msgRand: 20 }
    );
    assert.equal(group.command, PROTO_SEND_COMMAND);
    assert.equal(group.object['1']['2']['1'], 998877n);
    assert.deepEqual(group.object['3']['1']['2'], elements);
    assert.equal(group.object['4'], 10);

    const direct = buildDirectElementRequest(
        { chatType: 1, peerUid: 'u_private' },
        elements,
        { msgSeq: 1, msgRand: 2 }
    );
    assert.equal(direct.object['1']['1']['2'], 'u_private');
    assert.ok(direct.packet.length > 0);
});

test('builds and resolves long-message upload packets', () => {
    const elements = [{ '1': { '1': 'long text' } }];
    const upload = buildLongMessageUploadRequest(
        { chatType: 2, peerUid: '998877' },
        '998877',
        elements
    );
    assert.equal(upload.command, LONG_MESSAGE_COMMAND);
    const decoded = decodeGenericProtobuf(upload.packet);
    const compressedHex = decoded['2']['4'].slice(5);
    const content = decodeGenericProtobuf(gunzipSync(Buffer.from(compressedHex, 'hex')));
    assert.equal(content['2']['1'], 'MultiMsg');
    assert.deepEqual(createLongMessageReferenceElements('res-1'), [{
        '37': {
            '6': 1,
            '7': 'res-1',
            '17': 0,
            '19': { '15': 0, '31': 0, '41': 0 }
        }
    }]);
    const response = { rspBuffer: encodeGenericProtobuf({ '2': { '3': 'res-1' } }) };
    assert.equal(extractLongMessageResid(response), 'res-1');

    const stringResponse = encodeGenericProtobuf({ '2': { '3': 'res-string' } });
    assert.equal(
        extractLongMessageResid({ rsp: stringResponse.toString('latin1') }),
        'res-string'
    );
});

test('creates XML and both forward card variants', () => {
    const xmlElements = createXmlElements('<msg serviceID="35"></msg>');
    const xmlBytes = xmlElements[0]['12']['1'];
    assert.equal(xmlBytes[0], 1);
    assert.equal(inflateSync(xmlBytes.subarray(1)).toString(), '<msg serviceID="35"></msg>');

    const ark = createForwardCard('res-id', {
        prompt: '[转发]',
        description: '一条消息'
    }, { fileName: 'file-id', uniseq: 'sequence-id' });
    assert.equal(ark.longMessage, false);
    assert.equal(ark.elements[0]['51']['1'][0], 1);
    assert.match(ark.source, /com\.tencent\.multimsg/);
    assert.match(ark.source, /res-id/);

    const xml = createForwardCard('res-id', {
        prompt: '[转发]',
        description: '<sender>',
        xml: true
    }, { fileName: 'file-id' });
    assert.equal(xml.longMessage, true);
    assert.equal(xml.elements[0]['12']['2'], 60);
    assert.match(xml.source, /&lt;sender&gt;/);
});

test('builds group and private pull requests', () => {
    const group = buildPullMessageRequest({
        chatType: 2,
        peerUid: '998877',
        msgSeq: 123
    });
    assert.equal(group.command, GROUP_PULL_COMMAND);
    assert.deepEqual(group.object, {
        '1': { '1': 998877n, '2': 123, '3': 123 },
        '2': true
    });

    const direct = buildPullMessageRequest({ chatType: 1, peerUid: 'u_private', msgSeq: 456 });
    assert.equal(direct.command, C2C_PULL_COMMAND);
    assert.deepEqual(direct.object, { '2': 'u_private', '3': 456, '4': 456 });
});

test('formats PB, PB element and MsgRecord pull views', () => {
    const packet = encodeGenericProtobuf({
        '3': {
            '3': 998877,
            '4': 123,
            '5': 123,
            '6': [{
                '3': { '1': { '2': [
                    { '1': { '1': 'hello' } },
                    { '51': { '1': 'hex->0102' } }
                ] } }
            }]
        }
    });
    const views = createPullMessageViews(
        { rsp: packet.toString('latin1') },
        '{\n  "msgId": "1"\n}',
        GROUP_PULL_COMMAND
    );
    assert.match(views.pb, /"3"/);
    assert.match(views.elements, /hello/);
    assert.match(views.elements, /hex->0102/);
    assert.match(views.msgRecord, /msgId/);

    const base64Views = createPullMessageViews(
        { rsp: packet.toString('base64').replace(/=+$/, '') },
        '',
        GROUP_PULL_COMMAND
    );
    assert.match(base64Views.elements, /hello/);

    const base64UrlViews = createPullMessageViews(
        { rsp: packet.toString('base64url') },
        '',
        GROUP_PULL_COMMAND
    );
    assert.match(base64UrlViews.elements, /hex->0102/);

    const c2cPacket = encodeGenericProtobuf({
        '4': 'u_private',
        '7': [{ '3': { '1': { '2': [{ '1': { '1': 'private' } }] } } }]
    });
    const c2cViews = createPullMessageViews(
        { rspbuffer: c2cPacket },
        '',
        C2C_PULL_COMMAND
    );
    assert.match(c2cViews.elements, /private/);
});

test('summarizes SSO response shape without exposing response content', () => {
    const content = '\u0008\u0001private-message-content';
    const summary = summarizeResponseShape({ rspbuffer: content, code: 0 });
    assert.deepEqual(summary.response.keys, ['rspbuffer', 'code']);
    assert.equal(summary.response.fields.rspbuffer.type, 'string');
    assert.equal(summary.response.fields.rspbuffer.length, content.length);
    assert.equal(summary.response.fields.code.type, 'number');
    assert.equal(summary.extracted.length, content.length);
    assert.equal(JSON.stringify(summary).includes('private-message-content'), false);
});

test('wires the full message editor, pull menu and IPC without logging content', () => {
    const root = path.join(__dirname, '..');
    const mainSource = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    const rendererSource = fs.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8');
    const editorSource = fs.readFileSync(path.join(root, 'src', 'message-packet-editor.js'), 'utf8');
    const editorStyle = fs.readFileSync(path.join(root, 'src', 'message-packet-editor.css'), 'utf8');

    assert.match(rendererSource, /createMessagePacketEditor/);
    assert.match(rendererSource, /toolbox:message-pull/);
    assert.match(editorSource, /value: 'element'/);
    assert.match(editorSource, /value: 'ark'/);
    assert.match(editorSource, /value: 'xml'/);
    assert.match(editorSource, /value: 'text'/);
    assert.match(editorSource, /value: 'longmsg'/);
    assert.match(editorSource, /value: 'forward'/);
    assert.match(editorSource, /fakeForwardEntry\.after\(entry\)/);
    assert.match(editorSource, /state\.textarea\.scrollTop = 0/);
    assert.match(editorStyle, /\.qpacket-body\s*\{[\s\S]*?display: flex;[\s\S]*?flex-direction: column;/);
    assert.match(editorStyle, /\.qpacket-editor-field\s*\{[\s\S]*?flex: 1 1 0;[\s\S]*?min-height: 180px;/);
    assert.match(editorStyle, /\.qpacket-editor\s*\{[\s\S]*?height: 100%;/);
    assert.match(mainSource, /message-packet\.pull-requested/);
    assert.doesNotMatch(mainSource, /recordDiagnostic\([^\n]+payload\?\.content/);
});
