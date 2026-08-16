'use strict';

const crypto = require('crypto');
const { deflateSync, gzipSync } = require('zlib');

const NATIVE_SEND_COMMAND = 'nodeIKernelMsgService/sendMsg';
const PROTO_SEND_COMMAND = 'MessageSvc.PbSendMsg';
const LONG_MESSAGE_COMMAND = 'trpc.group.long_msg_interface.MsgService.SsoSendLongMsg';
const GROUP_PULL_COMMAND = 'trpc.msg.register_proxy.RegisterProxy.SsoGetGroupMsg';
const C2C_PULL_COMMAND = 'trpc.msg.register_proxy.RegisterProxy.SsoGetC2cMsg';
const MAX_PACKET_CONTENT_BYTES = 512 * 1024;
const MAX_PROTO_DEPTH = 32;
const MAX_PROTO_FIELDS = 20000;

function normalizeContent(value, label) {
    const content = String(value ?? '').trim();
    if (!content) {
        throw new Error(`请输入${label}`);
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_PACKET_CONTENT_BYTES) {
        throw new Error(`${label}不能超过 512 KB`);
    }
    return content;
}

function parseJson(value, label) {
    const content = normalizeContent(value, label);
    try {
        return { content, value: JSON.parse(content) };
    } catch {
        throw new Error(`${label}格式错误`);
    }
}

function normalizeArkJson(value) {
    const parsed = parseJson(value, 'Ark JSON');
    if (!parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
        throw new Error('Ark JSON 顶层必须是对象');
    }
    return parsed.content;
}

function validateFieldObject(value, path = '') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${path || '元素'}必须是数字字段对象`);
    }
    for (const [key, child] of Object.entries(value)) {
        const field = Number(key);
        if (!/^\d+$/.test(key) || !Number.isInteger(field) || field < 1 || field > 0x1fffffff) {
            throw new Error(`Protobuf 字段 ${path ? `${path}.` : ''}${key} 无效`);
        }
        validateFieldValue(child, path ? `${path}.${key}` : key);
    }
}

function validateFieldValue(value, path) {
    if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index += 1) {
            validateFieldValue(value[index], `${path}[${index}]`);
        }
        return;
    }
    if (value && typeof value === 'object' && !Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
        validateFieldObject(value, path);
        return;
    }
    if (['string', 'boolean', 'bigint'].includes(typeof value)) {
        return;
    }
    if (typeof value === 'number' && Number.isSafeInteger(value)) {
        return;
    }
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
        return;
    }
    throw new Error(`Protobuf 字段 ${path} 的值无效`);
}

function parseElementJson(value) {
    const parsed = parseJson(value, '元素 JSON');
    const elements = Array.isArray(parsed.value) ? parsed.value : [parsed.value];
    if (!elements.length) {
        throw new Error('元素 JSON 不能为空数组');
    }
    elements.forEach((element, index) => validateFieldObject(element, `元素[${index}]`));
    return { content: parsed.content, elements };
}

function encodeVarint(value) {
    let numeric = BigInt(value);
    if (numeric < 0n) {
        numeric = BigInt.asUintN(64, numeric);
    }
    const bytes = [];
    do {
        let byte = Number(numeric & 0x7fn);
        numeric >>= 7n;
        if (numeric) {
            byte |= 0x80;
        }
        bytes.push(byte);
    } while (numeric);
    return Buffer.from(bytes);
}

function encodeFieldValue(field, value) {
    if (Array.isArray(value)) {
        return Buffer.concat(value.map(item => encodeFieldValue(field, item)));
    }
    if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
        const numeric = typeof value === 'boolean' ? (value ? 1n : 0n) : BigInt(value);
        return Buffer.concat([encodeVarint(BigInt(field) << 3n), encodeVarint(numeric)]);
    }
    let bytes;
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
        bytes = Buffer.from(value);
    } else if (typeof value === 'string' && value.startsWith('hex->')) {
        const hex = value.slice(5);
        if (hex.length % 2 || !/^[0-9a-f]*$/i.test(hex)) {
            throw new Error(`Protobuf 字段 ${field} 的十六进制数据无效`);
        }
        bytes = Buffer.from(hex, 'hex');
    } else if (typeof value === 'string') {
        bytes = Buffer.from(value, 'utf8');
    } else {
        validateFieldObject(value);
        bytes = encodeGenericProtobuf(value);
    }
    return Buffer.concat([
        encodeVarint((BigInt(field) << 3n) | 2n),
        encodeVarint(bytes.length),
        bytes
    ]);
}

function encodeGenericProtobuf(value) {
    validateFieldObject(value);
    const fields = [];
    for (const [key, fieldValue] of Object.entries(value)) {
        fields.push(encodeFieldValue(Number(key), fieldValue));
    }
    const packet = Buffer.concat(fields);
    if (packet.length > MAX_PACKET_CONTENT_BYTES * 4) {
        throw new Error('Protobuf 数据不能超过 2 MB');
    }
    return packet;
}

function readVarint(buffer, start) {
    let value = 0n;
    let shift = 0n;
    let offset = start;
    while (offset < buffer.length && shift < 70n) {
        const byte = buffer[offset];
        offset += 1;
        value |= BigInt(byte & 0x7f) << shift;
        if (!(byte & 0x80)) {
            return { offset, value };
        }
        shift += 7n;
    }
    throw new Error('Protobuf varint 数据不完整');
}

function displayInteger(value) {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
}

function addDecodedField(target, key, value) {
    if (!(key in target)) {
        target[key] = value;
    } else if (Array.isArray(target[key])) {
        target[key].push(value);
    } else {
        target[key] = [target[key], value];
    }
}

function decodeText(bytes) {
    try {
        const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        return value && Array.from(value).every(character => {
            const code = character.codePointAt(0);
            return code === 9 || code === 10 || code === 13 || code >= 32;
        }) ? value : null;
    } catch {
        return null;
    }
}

function decodeLengthDelimited(bytes, state, depth) {
    if (!bytes.length) {
        return {};
    }
    const text = decodeText(bytes);
    if (text !== null) {
        return text;
    }
    const fieldCount = state.fields;
    try {
        return decodeMessage(bytes, state, depth + 1);
    } catch {
        state.fields = fieldCount;
        return `hex->${bytes.toString('hex')}`;
    }
}

function decodeMessage(buffer, state, depth) {
    if (depth > MAX_PROTO_DEPTH) {
        throw new Error('Protobuf 嵌套层级过深');
    }
    const result = {};
    let offset = 0;
    let decodedFields = 0;
    while (offset < buffer.length) {
        const tag = readVarint(buffer, offset);
        offset = tag.offset;
        const field = Number(tag.value >> 3n);
        const wireType = Number(tag.value & 7n);
        if (!field || field > 0x1fffffff) {
            throw new Error('Protobuf 字段编号无效');
        }
        state.fields += 1;
        decodedFields += 1;
        if (state.fields > MAX_PROTO_FIELDS) {
            throw new Error('Protobuf 字段数量过多');
        }
        let value;
        if (wireType === 0) {
            const data = readVarint(buffer, offset);
            offset = data.offset;
            value = displayInteger(data.value);
        } else if (wireType === 1) {
            if (offset + 8 > buffer.length) {
                throw new Error('Protobuf fixed64 数据不完整');
            }
            value = displayInteger(buffer.readBigUInt64LE(offset));
            offset += 8;
        } else if (wireType === 2) {
            const length = readVarint(buffer, offset);
            offset = length.offset;
            const size = Number(length.value);
            if (!Number.isSafeInteger(size) || offset + size > buffer.length) {
                throw new Error('Protobuf bytes 数据不完整');
            }
            value = decodeLengthDelimited(buffer.subarray(offset, offset + size), state, depth);
            offset += size;
        } else if (wireType === 5) {
            if (offset + 4 > buffer.length) {
                throw new Error('Protobuf fixed32 数据不完整');
            }
            value = buffer.readUInt32LE(offset);
            offset += 4;
        } else {
            throw new Error(`不支持 Protobuf wire type ${wireType}`);
        }
        addDecodedField(result, String(field), value);
    }
    if (!decodedFields) {
        throw new Error('Protobuf 数据为空');
    }
    return result;
}

function decodeGenericProtobuf(value) {
    const buffer = Buffer.from(value || []);
    if (!buffer.length) {
        return {};
    }
    return decodeMessage(buffer, { fields: 0 }, 0);
}

function asBuffer(value) {
    if (Buffer.isBuffer(value)) {
        return value;
    }
    if (value instanceof Uint8Array) {
        return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    }
    if (value instanceof ArrayBuffer) {
        return Buffer.from(value);
    }
    if (Array.isArray(value) && value.every(item => Number.isInteger(item) && item >= 0 && item <= 255)) {
        return Buffer.from(value);
    }
    if (value?.type === 'Buffer' && Array.isArray(value.data)) {
        return Buffer.from(value.data);
    }
    if (typeof value !== 'string' || !value) {
        return null;
    }
    if (/^(?:[0-9a-f]{2})+$/i.test(value)) {
        return Buffer.from(value, 'hex');
    }
    if (value.length % 4 !== 1 && /^[a-z0-9+/_-]+={0,2}$/i.test(value)) {
        return Buffer.from(value, 'base64');
    }
    return Buffer.from(value, 'latin1');
}

function extractResponseBuffer(response, depth = 0) {
    const direct = asBuffer(response);
    if (direct || !response || typeof response !== 'object' || depth > 4) {
        return direct;
    }
    for (const key of ['rspbuffer', 'rspBuffer', 'rsp', 'payload', 'data', 'value']) {
        const bytes = extractResponseBuffer(response[key], depth + 1);
        if (bytes) {
            return bytes;
        }
    }
    return null;
}

function describeResponseValue(value) {
    const bytes = Buffer.isBuffer(value)
        ? value
        : value instanceof Uint8Array
            ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
            : value instanceof ArrayBuffer
                ? Buffer.from(value)
                : Array.isArray(value) && value.every(item => Number.isInteger(item) && item >= 0 && item <= 255)
                    ? Buffer.from(value)
                    : value?.type === 'Buffer' && Array.isArray(value.data)
                        ? Buffer.from(value.data)
                        : null;
    if (bytes) {
        return {
            type: Buffer.isBuffer(value) ? 'Buffer' : value?.constructor?.name || typeof value,
            length: bytes.length,
            sha256: crypto.createHash('sha256').update(bytes).digest('hex')
        };
    }
    if (typeof value === 'string') {
        let maxCodePoint = 0;
        for (const character of value) {
            maxCodePoint = Math.max(maxCodePoint, character.codePointAt(0));
        }
        return {
            type: 'string',
            length: value.length,
            maxCodePoint,
            hasReplacementCharacter: value.includes('\ufffd'),
            latin1: maxCodePoint <= 0xff,
            hex: value.length > 0 && /^(?:[0-9a-f]{2})+$/i.test(value),
            base64: value.length > 0 && value.length % 4 !== 1 && /^[a-z0-9+/]+={0,2}$/i.test(value),
            base64Url: value.length > 0 && value.length % 4 !== 1 && /^[a-z0-9_-]+={0,2}$/i.test(value),
            utf16Sha256: crypto.createHash('sha256').update(value, 'utf16le').digest('hex')
        };
    }
    if (value === null) {
        return { type: 'null' };
    }
    return { type: typeof value };
}

function summarizeResponseShape(response) {
    const seen = new Set();
    const visit = (value, depth = 0) => {
        const summary = describeResponseValue(value);
        if (!value || typeof value !== 'object' || Buffer.isBuffer(value) ||
            value instanceof Uint8Array || value instanceof ArrayBuffer || Array.isArray(value) ||
            depth >= 4 || seen.has(value)) {
            return summary;
        }
        seen.add(value);
        const keys = Object.keys(value).slice(0, 32);
        return {
            ...summary,
            constructor: value.constructor?.name || '',
            keys,
            fields: Object.fromEntries(keys.map(key => [key, visit(value[key], depth + 1)]))
        };
    };
    const packet = extractResponseBuffer(response);
    return {
        response: visit(response),
        extracted: packet ? describeResponseValue(packet) : null
    };
}

function randomUInt32() {
    return crypto.randomBytes(4).readUInt32BE();
}

function normalizePeer(peer) {
    const chatType = Number(peer?.chatType) || 0;
    const peerUid = String(peer?.peerUid || '').trim();
    if (![1, 2].includes(chatType) || !peerUid) {
        throw new Error('当前会话不支持消息工具');
    }
    return {
        chatType,
        peerUid,
        guildId: String(peer?.guildId || '').trim()
    };
}

function createNativeMessageElement(type, content) {
    if (type === 'ark') {
        return {
            elementType: 10,
            elementId: '',
            arkElement: { bytesData: normalizeArkJson(content) }
        };
    }
    if (type === 'text') {
        return {
            elementType: 1,
            elementId: '',
            textElement: { content: normalizeContent(content, '文本') }
        };
    }
    throw new Error('不支持的原生消息类型');
}

function buildNativeSendRequest(peer, type, content, msgAttributeInfos) {
    return {
        msgId: '0',
        peer: normalizePeer(peer),
        msgElements: [createNativeMessageElement(type, content)],
        msgAttributeInfos
    };
}

function parseTargetUin(value) {
    const target = String(value || '').trim();
    if (!/^\d+$/.test(target)) {
        throw new Error('无法获取目标 QQ 号或群号');
    }
    return BigInt(target);
}

function buildDirectElementObject(peer, elements, options = {}) {
    peer = normalizePeer(peer);
    return {
        '1': peer.chatType === 2
            ? { '2': { '1': parseTargetUin(peer.peerUid) } }
            : { '1': { '2': peer.peerUid } },
        '2': { '1': 1, '2': 0, '3': 0 },
        '3': { '1': { '2': elements } },
        '4': options.msgSeq ?? randomUInt32(),
        '5': options.msgRand ?? randomUInt32()
    };
}

function buildDirectElementRequest(peer, elements, options = {}) {
    const object = buildDirectElementObject(peer, elements, options);
    return { command: PROTO_SEND_COMMAND, object, packet: encodeGenericProtobuf(object) };
}

function createLongMessageContent(elements, forward = null, options = {}) {
    const message = forward ? {
        '1': {
            '1': parseTargetUin(forward.senderUin),
            '5': {},
            '6': {},
            '7': {},
            '8': {
                '1': 10001,
                '4': String(forward.nickname || '').trim() || String(forward.senderUin),
                '5': 2
            }
        },
        '2': {
            '1': 82,
            '2': {},
            '3': {},
            '4': options.msgSeq ?? randomUInt32(),
            '5': options.msgRand ?? randomUInt32(),
            '6': options.divSeq ?? randomUInt32(),
            '7': 1,
            '8': 0,
            '9': 0,
            '15': { '1': 0, '2': 0, '3': 0, '4': '', '5': '' }
        },
        '3': { '1': { '2': elements } }
    } : {
        '3': { '1': { '2': elements } }
    };
    return {
        '2': {
            '1': 'MultiMsg',
            '2': { '1': [message] }
        }
    };
}

function buildLongMessageUploadRequest(peer, peerUin, elements, options = {}) {
    peer = normalizePeer(peer);
    const content = createLongMessageContent(elements, options.forward || null, options);
    const object = {
        '2': {
            '1': peer.chatType === 1 ? 1 : 3,
            '2': { '2': parseTargetUin(peerUin || peer.peerUid) },
            '4': gzipSync(encodeGenericProtobuf(content))
        },
        '15': { '1': 4, '2': 2, '3': 9, '4': 0 }
    };
    return { command: LONG_MESSAGE_COMMAND, content, object, packet: encodeGenericProtobuf(object) };
}

function getPathValue(value, path) {
    if (Array.isArray(value)) {
        for (const item of value) {
            const result = getPathValue(item, path);
            if (result !== undefined) {
                return result;
            }
        }
        return undefined;
    }
    if (!path.length) {
        return value;
    }
    return value && typeof value === 'object'
        ? getPathValue(value[path[0]], path.slice(1))
        : undefined;
}

function extractLongMessageResid(response) {
    const packet = extractResponseBuffer(response);
    if (!packet?.length) {
        throw new Error('QQ 未返回长消息资源数据');
    }
    const decoded = decodeGenericProtobuf(packet);
    const resid = getPathValue(decoded, ['2', '3']);
    if (typeof resid !== 'string' || !resid.trim() || resid.startsWith('hex->')) {
        throw new Error('QQ 未返回长消息资源 ID');
    }
    return resid.trim();
}

function createLongMessageReferenceElements(resid) {
    resid = String(resid || '').trim();
    if (!resid) {
        throw new Error('长消息资源 ID 无效');
    }
    return [{
        '37': {
            '6': 1,
            '7': resid,
            '17': 0,
            '19': { '15': 0, '31': 0, '41': 0 }
        }
    }];
}

function compressRichText(value) {
    return Buffer.concat([Buffer.from([1]), deflateSync(Buffer.from(String(value), 'utf8'))]);
}

function createXmlElements(xml, serviceId = 35) {
    return [{
        '12': {
            '1': compressRichText(normalizeContent(xml, 'XML')),
            '2': serviceId
        }
    }];
}

function escapeXml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function createForwardCard(resid, forward = {}, options = {}) {
    const prompt = String(forward.prompt || '').trim() || '[聊天记录]';
    const description = String(forward.description || '').trim() || '查看1条转发消息';
    const fileName = options.fileName || crypto.randomUUID();
    if (forward.xml === true) {
        const xml = `<?xml version="1.0" encoding="utf-8"?>` +
            `<msg brief="${escapeXml(prompt)}" m_fileName="${escapeXml(fileName)}" ` +
            `action="viewMultiMsg" tSum="1" flag="3" m_resid="${escapeXml(resid)}" ` +
            `serviceID="35" m_fileSize="0"><item layout="1">` +
            `<title color="#000000" size="34">聊天记录</title>` +
            `<title color="#777777" size="26">${escapeXml(description)}</title>` +
            `<hr></hr><summary color="#808080" size="26">QQNT Toolbox</summary>` +
            `</item><source name="QQNT Toolbox"></source></msg>`;
        return { elements: createXmlElements(xml, 60), longMessage: true, source: xml };
    }
    const ark = JSON.stringify({
        app: 'com.tencent.multimsg',
        config: { autosize: 1, forward: 1, round: 1, type: 'normal', width: 300 },
        desc: prompt,
        extra: JSON.stringify({ filename: fileName, tsum: 1 }) + '\n',
        meta: {
            detail: {
                news: [{ text: description }],
                resid,
                source: '聊天记录',
                summary: 'QQNT Toolbox',
                uniseq: options.uniseq || crypto.randomUUID()
            }
        },
        prompt,
        ver: '0.0.0.5',
        view: 'contact'
    });
    return {
        elements: [{ '51': { '1': compressRichText(ark) } }],
        longMessage: false,
        source: ark
    };
}

function buildPullMessageRequest(record) {
    const chatType = Number(record?.chatType || record?.peer?.chatType) || 0;
    if (chatType === 2) {
        const groupUin = record?.peerUid || record?.peer?.peerUid;
        const msgSeq = Number(record?.msgSeq);
        if (!/^\d+$/.test(String(groupUin || '')) || !Number.isSafeInteger(msgSeq) || msgSeq < 0) {
            throw new Error('消息记录缺少群号或消息序号');
        }
        const object = {
            '1': { '1': parseTargetUin(groupUin), '2': msgSeq, '3': msgSeq },
            '2': true
        };
        return { command: GROUP_PULL_COMMAND, object, packet: encodeGenericProtobuf(object) };
    }
    if (chatType === 1) {
        const targetUid = String(record?.peerUid || record?.peer?.peerUid || '').trim();
        const msgSeq = Number(record?.msgSeq);
        if (!targetUid || !Number.isSafeInteger(msgSeq) || msgSeq < 0) {
            throw new Error('消息记录缺少好友 UID 或消息序号');
        }
        const object = { '2': targetUid, '3': msgSeq, '4': msgSeq };
        return { command: C2C_PULL_COMMAND, object, packet: encodeGenericProtobuf(object) };
    }
    throw new Error('当前消息类型不支持拉取');
}

function collectPathValues(value, path) {
    if (Array.isArray(value)) {
        return value.flatMap(item => collectPathValues(item, path));
    }
    if (!path.length) {
        return [value];
    }
    if (!value || typeof value !== 'object' || !(path[0] in value)) {
        return [];
    }
    return collectPathValues(value[path[0]], path.slice(1));
}

function extractPbElements(decoded, command) {
    const path = command === GROUP_PULL_COMMAND
        ? ['3', '6', '3', '1', '2']
        : command === C2C_PULL_COMMAND
            ? ['7', '3', '1', '2']
            : [];
    if (!path.length) {
        return null;
    }
    const values = collectPathValues(decoded, path)
        .flatMap(value => Array.isArray(value) ? value : [value])
        .filter(value => value !== undefined);
    if (!values.length) {
        return null;
    }
    return values.length === 1 ? values[0] : values;
}

function stringifyPacketView(value) {
    return JSON.stringify(value, (_key, child) => {
        if (typeof child === 'bigint') {
            return child.toString();
        }
        if (Buffer.isBuffer(child) || child instanceof Uint8Array) {
            return `hex->${Buffer.from(child).toString('hex')}`;
        }
        return child;
    }, 2);
}

function createPullMessageViews(response, msgRecord = '', command = '') {
    const packet = extractResponseBuffer(response);
    if (!packet?.length) {
        throw new Error('QQ 未返回消息数据');
    }
    const pb = decodeGenericProtobuf(packet);
    const elements = extractPbElements(pb, command);
    return {
        pb: stringifyPacketView(pb),
        elements: elements === null ? '未在响应中找到消息元素' : stringifyPacketView(elements),
        msgRecord: String(msgRecord || '').trim() || '{}'
    };
}

function getDirectSendResult(response) {
    const packet = extractResponseBuffer(response);
    if (!packet?.length) {
        return 0;
    }
    const decoded = decodeGenericProtobuf(packet);
    const value = getPathValue(decoded, ['1']);
    return typeof value === 'number' ? value : Number(value) || 0;
}

module.exports = {
    C2C_PULL_COMMAND,
    GROUP_PULL_COMMAND,
    LONG_MESSAGE_COMMAND,
    MAX_PACKET_CONTENT_BYTES,
    NATIVE_SEND_COMMAND,
    PROTO_SEND_COMMAND,
    buildDirectElementObject,
    buildDirectElementRequest,
    buildLongMessageUploadRequest,
    buildNativeSendRequest,
    buildPullMessageRequest,
    compressRichText,
    createForwardCard,
    createLongMessageContent,
    createLongMessageReferenceElements,
    createNativeMessageElement,
    createPullMessageViews,
    createXmlElements,
    decodeGenericProtobuf,
    encodeGenericProtobuf,
    extractLongMessageResid,
    extractPbElements,
    extractResponseBuffer,
    getDirectSendResult,
    normalizeArkJson,
    normalizePeer,
    parseElementJson,
    summarizeResponseShape,
    stringifyPacketView
};
