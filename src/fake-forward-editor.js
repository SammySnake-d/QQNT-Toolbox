import {
    bindNativeChatToolbarAction,
    createNativeChatToolbarEntry,
    findNativeChatToolbar
} from './chat-toolbar-entry.js';

const ROOT_ID = 'qqnt-toolbox-fake-forward-editor';
const STYLE_ID = 'qqnt-toolbox-fake-forward-style';
const ENTRY_CLASS = 'qqnt-toolbox-fake-forward-entry';
const MAX_MESSAGES = 100;
const MAX_TEXT_LENGTH = 10000;
const MAX_IMAGES_PER_MESSAGE = 20;
const MAX_NESTED_DEPTH = 3;
const MAX_TOTAL_MESSAGES = 300;
const MAX_FORWARD_SEGMENT_CACHE = 8;
const IMAGE_FILE_PATTERN = /\.(?:apng|bmp|gif|jfif|jpe?g|png|webp)$/i;
const VIDEO_FILE_PATTERN = /\.(?:3g2|3gp|asf|avi|flv|m2ts|m4v|mkv|mov|mp4|mpeg|mpg|mts|ogv|ts|vob|webm|wmv)$/i;
const IMAGE_TOKEN_CLASS = 'qff-composer-image';
const ATTACHMENT_TOKEN_CLASS = 'qff-composer-attachment';
const FORWARD_TOKEN_CLASS = 'qff-composer-forward';
const COMPOSER_BLOCK_TAGS = new Set(['DIV', 'P', 'LI']);

function createElement(tag, className = '', text = '') {
    const element = document.createElement(tag);
    if (className) {
        element.className = className;
    }
    if (text) {
        element.textContent = text;
    }
    return element;
}

function createButton(className, label, title = '') {
    const button = createElement('button', className, label);
    button.type = 'button';
    if (title) {
        button.title = title;
        button.setAttribute('aria-label', title);
    }
    return button;
}

function applyEntryGlyph(svg) {
    const namespace = 'http://www.w3.org/2000/svg';
    svg.replaceChildren();
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('qff-entry-icon');
    const paths = [
        'M13 5H7a4 4 0 0 0-4 4v11l4-3h8a4 4 0 0 0 4-4v-1',
        'M18 3v6',
        'M15 6h6'
    ];
    for (const data of paths) {
        const path = document.createElementNS(namespace, 'path');
        path.setAttribute('d', data);
        path.setAttribute('stroke', 'currentColor');
        path.setAttribute('stroke-width', '1.6');
        path.setAttribute('stroke-linecap', 'round');
        path.setAttribute('stroke-linejoin', 'round');
        svg.append(path);
    }
    return svg;
}

function formatDateTimeParts(timestamp = Date.now()) {
    const date = new Date(Number(timestamp) || Date.now());
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    const value = local.toISOString();
    return {
        date: value.slice(0, 10),
        time: value.slice(11, 16)
    };
}

function parseDateTimeParts(date, time) {
    const timestamp = new Date(String(date || '') + 'T' + String(time || '')).getTime();
    return Number.isFinite(timestamp) ? timestamp : Date.now();
}

function formatListTime(timestamp) {
    return new Intl.DateTimeFormat('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    }).format(new Date(Number(timestamp) || Date.now()));
}

function avatarUrl(uin) {
    return 'https://q1.qlogo.cn/g?b=qq&nk=' + encodeURIComponent(uin) + '&s=100';
}

function localImageUrl(filePath) {
    const normalized = String(filePath || '').replace(/\\/g, '/');
    const encoded = normalized.split('/').map(part =>
        encodeURIComponent(part).replace(/%3A/gi, ':')
    ).join('/');
    return 'local:///' + encoded;
}

function inferColorScheme(color) {
    const match = String(color || '').match(/^rgba?\(\s*(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)/i);
    if (!match) {
        return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    const brightness = Number(match[1]) * 0.299 + Number(match[2]) * 0.587 + Number(match[3]) * 0.114;
    return brightness >= 160 ? 'dark' : 'light';
}

function removeTrailingMediaPlaceholderBreaks(segments) {
    if (!segments.some(segment => ['image', 'video', 'file', 'forward'].includes(segment?.type))) {
        return segments;
    }
    const trailing = segments.at(-1);
    if (trailing?.type !== 'text' || !/[\r\n]/.test(trailing.text)) {
        return segments;
    }
    trailing.text = trailing.text.replace(/(?:\r?\n)+[ \t]*$/, '');
    if (!trailing.text.trim()) {
        segments.pop();
    }
    return segments;
}

function normalizeDraftMessages(source, depth = 0, budget = { remaining: MAX_TOTAL_MESSAGES }) {
    if (!Array.isArray(source) || depth > MAX_NESTED_DEPTH || budget.remaining <= 0) {
        return [];
    }
    const messages = [];
    for (const item of source.slice(0, MAX_MESSAGES)) {
        if (!item || typeof item !== 'object' || budget.remaining <= 0) {
            continue;
        }
        budget.remaining -= 1;
        messages.push({
            id: String(item.id || makeEntryId()),
            senderUin: String(item.senderUin || ''),
            senderName: String(item.senderName || ''),
            segments: normalizeDraftSegments(item, { depth, budget }),
            timestamp: Number(item.timestamp) || Date.now()
        });
    }
    return messages;
}

function normalizeDraftSegments(source, context = {}) {
    const depth = Math.max(0, Number(context.depth) || 0);
    const budget = context.budget || { remaining: MAX_TOTAL_MESSAGES };
    const rawSegments = Array.isArray(source?.segments)
        ? source.segments
        : [
            ...(String(source?.content || '') ? [{ type: 'text', text: String(source.content) }] : []),
            ...(Array.isArray(source?.images)
                ? source.images.map(image => ({ type: 'image', ...image }))
                : [])
        ];
    const segments = [];
    let imageCount = 0;
    let textLength = 0;
    for (const segment of rawSegments) {
        if (segment?.type === 'text') {
            const remaining = MAX_TEXT_LENGTH - textLength;
            const text = String(segment.text ?? '').slice(0, Math.max(0, remaining));
            if (!text) {
                continue;
            }
            textLength += text.length;
            const previous = segments.at(-1);
            if (previous?.type === 'text') {
                previous.text += text;
            } else {
                segments.push({ type: 'text', text });
            }
        } else if (segment?.type === 'image' && imageCount < MAX_IMAGES_PER_MESSAGE) {
            const image = {
                type: 'image',
                path: String(segment.path || ''),
                name: String(segment.name || '')
            };
            if (image.path) {
                segments.push(image);
                imageCount += 1;
            }
        } else if (segment?.type === 'video' || segment?.type === 'file') {
            const media = {
                type: segment.type,
                path: String(segment.path || ''),
                name: String(segment.name || ''),
                size: Math.max(0, Number(segment.size) || 0)
            };
            if (media.path) {
                segments.push(media);
            }
        } else if (segment?.type === 'forward' && depth < MAX_NESTED_DEPTH) {
            const messages = normalizeDraftMessages(segment.messages, depth + 1, budget);
            if (messages.length) {
                segments.push({
                    type: 'forward',
                    uuid: String(segment.uuid || segment.id || makeEntryId()),
                    messages,
                    source: String(segment.source || ''),
                    summary: String(segment.summary || ''),
                    prompt: String(segment.prompt || '[聊天记录]')
                });
            }
        }
    }
    removeTrailingMediaPlaceholderBreaks(segments);
    const standalone = segments.filter(segment =>
        segment.type === 'video' || segment.type === 'file' || segment.type === 'forward'
    );
    if (standalone.length && (standalone.length !== 1 || segments.length !== 1)) {
        return [];
    }
    return segments;
}

export function readFakeForwardComposerSegments(root, options = {}) {
    const segments = [];
    const appendText = text => {
        if (!text) {
            return;
        }
        const previous = segments.at(-1);
        if (previous?.type === 'text') {
            previous.text += text;
        } else {
            segments.push({ type: 'text', text });
        }
    };
    const appendBlockBoundary = () => {
        const previous = segments.at(-1);
        if (segments.length && !(previous?.type === 'text' && previous.text.endsWith('\n'))) {
            appendText('\n');
        }
    };
    const visitChildren = parent => {
        let hasPreviousNode = false;
        for (const child of Array.from(parent?.childNodes || [])) {
            const tagName = String(child?.tagName || '').toUpperCase();
            if (hasPreviousNode && COMPOSER_BLOCK_TAGS.has(tagName)) {
                appendBlockBoundary();
            }
            visit(child);
            hasPreviousNode ||= child?.nodeType === 1 ||
                (child?.nodeType === 3 && Boolean(child.nodeValue));
        }
    };
    const visit = node => {
        if (node?.nodeType === 3) {
            appendText(node.nodeValue || '');
            return;
        }
        if (node?.nodeType !== 1) {
            return;
        }
        if (node.classList?.contains(IMAGE_TOKEN_CLASS)) {
            segments.push({
                type: 'image',
                path: String(node.dataset?.path || ''),
                name: String(node.dataset?.name || ''),
                pending: node.dataset?.pending === 'true'
            });
            return;
        }
        if (node.classList?.contains(ATTACHMENT_TOKEN_CLASS)) {
            segments.push({
                type: node.dataset?.type === 'video' ? 'video' : 'file',
                path: String(node.dataset?.path || ''),
                name: String(node.dataset?.name || ''),
                size: Math.max(0, Number(node.dataset?.size) || 0),
                pending: node.dataset?.pending === 'true'
            });
            return;
        }
        if (node.classList?.contains(FORWARD_TOKEN_CLASS)) {
            let forward = node.__qffForward || options.resolveForward?.(
                String(node.dataset?.forwardId || '')
            );
            if (!forward && node.dataset?.forward) {
                try {
                    forward = JSON.parse(node.dataset.forward);
                } catch {
                    forward = null;
                }
            }
            const normalized = normalizeDraftSegments({
                segments: forward ? [{ ...forward, type: 'forward' }] : []
            }, { depth: Math.max(0, Number(options.depth) || 0) });
            if (normalized[0]?.type === 'forward') {
                segments.push(normalized[0]);
            }
            return;
        }
        if (String(node.tagName || '').toUpperCase() === 'BR') {
            appendText('\n');
            return;
        }
        visitChildren(node);
    };
    visitChildren(root);
    return removeTrailingMediaPlaceholderBreaks(segments);
}

function messagePreview(message) {
    return normalizeDraftSegments(message).map(segment => {
        if (segment.type === 'image') {
            return '[图片]';
        }
        if (segment.type === 'video') {
            return `[视频] ${segment.name}`;
        }
        if (segment.type === 'file') {
            return `[文件] ${segment.name}`;
        }
        if (segment.type === 'forward') {
            return `[聊天记录] ${segment.messages.length} 条消息`;
        }
        return segment.text;
    }).join('').trim();
}

function getForwardSegment(message) {
    return Array.isArray(message?.segments)
        ? message.segments.find(segment => segment?.type === 'forward') || null
        : null;
}

function hasValidSenderUin(message) {
    return /^\d{5,20}$/.test(String(message?.senderUin || '').trim());
}

export function countFakeForwardDraftMessages(messages) {
    let count = 0;
    for (const message of Array.isArray(messages) ? messages : []) {
        count += 1;
        for (const segment of Array.isArray(message?.segments) ? message.segments : []) {
            if (segment?.type === 'forward') {
                count += countFakeForwardDraftMessages(segment.messages);
            }
        }
    }
    return count;
}

function mergeNestedIntoSegments(segments, nested, editing) {
    const result = Array.isArray(segments) ? segments.slice() : [];
    const index = editing ? result.findIndex(segment =>
        segment.type === 'forward' && segment.uuid === nested.uuid
    ) : -1;
    if (index >= 0) {
        result.splice(index, 1, nested);
        return result;
    }
    return [nested];
}

export function projectFakeForwardDraftMessages(messages, scopeStack = []) {
    let projected = Array.isArray(messages) ? messages.slice() : [];
    for (let index = scopeStack.length - 1; index >= 0; index -= 1) {
        const frame = scopeStack[index];
        const nested = { ...frame.segment, messages: projected };
        const form = frame.form || {};
        const parentMessage = {
            id: String(form.selectedId || `projected-${index}`),
            senderUin: String(form.senderUin || ''),
            senderName: String(form.senderName || ''),
            segments: mergeNestedIntoSegments(form.segments, nested, frame.editing),
            timestamp: parseDateTimeParts(form.timestampDate, form.timestampTime)
        };
        const parentMessages = Array.isArray(frame.parentMessages)
            ? frame.parentMessages.slice()
            : [];
        const parentIndex = parentMessages.findIndex(message =>
            message.id === form.selectedId
        );
        if (parentIndex >= 0) {
            parentMessages.splice(parentIndex, 1, parentMessage);
        } else {
            parentMessages.push(parentMessage);
        }
        projected = parentMessages;
    }
    return projected;
}

export function encodeFakeForwardDraftGraph(snapshot = {}) {
    const lists = {};
    const refsBySignature = new Map();
    const activeLists = new WeakSet();
    let nextRef = 1;

    const encodeSegments = (source, depth) => {
        const segments = [];
        for (const segment of Array.isArray(source) ? source : []) {
            if (segment?.type === 'text') {
                segments.push({ type: 'text', text: String(segment.text || '') });
            } else if (segment?.type === 'image') {
                segments.push({
                    type: 'image',
                    path: String(segment.path || ''),
                    name: String(segment.name || '')
                });
            } else if (segment?.type === 'video' || segment?.type === 'file') {
                segments.push({
                    type: segment.type,
                    path: String(segment.path || ''),
                    name: String(segment.name || ''),
                    size: Math.max(0, Number(segment.size) || 0)
                });
            } else if (segment?.type === 'forward' && depth < MAX_NESTED_DEPTH) {
                segments.push({
                    type: 'forward',
                    uuid: String(segment.uuid || segment.id || makeEntryId()),
                    messagesRef: encodeMessages(segment.messages, depth + 1),
                    source: String(segment.source || ''),
                    summary: String(segment.summary || ''),
                    prompt: String(segment.prompt || '[聊天记录]')
                });
            }
        }
        return segments;
    };

    const encodeMessages = (source, depth = 0) => {
        const messages = Array.isArray(source) ? source : [];
        if (activeLists.has(messages)) {
            throw new Error('草稿中存在循环嵌套');
        }
        activeLists.add(messages);
        try {
            const encoded = messages.slice(0, MAX_MESSAGES).map(message => ({
                id: String(message?.id || makeEntryId()),
                senderUin: String(message?.senderUin || ''),
                senderName: String(message?.senderName || ''),
                segments: encodeSegments(message?.segments, depth),
                timestamp: Number(message?.timestamp) || Date.now()
            }));
            const signature = JSON.stringify(encoded);
            const existing = refsBySignature.get(signature);
            if (existing) {
                return existing;
            }
            const ref = 'list-' + nextRef++;
            refsBySignature.set(signature, ref);
            lists[ref] = encoded;
            return ref;
        } finally {
            activeLists.delete(messages);
        }
    };

    const encodeForm = (form, depth) => ({
        selectedId: String(form?.selectedId || ''),
        senderUin: String(form?.senderUin || ''),
        senderName: String(form?.senderName || ''),
        timestampDate: String(form?.timestampDate || ''),
        timestampTime: String(form?.timestampTime || ''),
        segments: encodeSegments(form?.segments, depth)
    });

    const levels = (Array.isArray(snapshot.levels) ? snapshot.levels : []).map(
        (level, index) => ({
            parentMessagesRef: encodeMessages(level?.parentMessages, index),
            form: encodeForm(level?.form, index),
            segment: {
                type: 'forward',
                uuid: String(level?.segment?.uuid || makeEntryId()),
                source: String(level?.segment?.source || ''),
                summary: String(level?.segment?.summary || ''),
                prompt: String(level?.segment?.prompt || '[聊天记录]')
            },
            editing: level?.editing === true,
            returnUuid: String(level?.returnUuid || '')
        })
    );
    return {
        format: 'deduplicated-graph',
        lists,
        rootMessagesRef: encodeMessages(snapshot.rootMessages),
        levels,
        currentMessagesRef: encodeMessages(snapshot.currentMessages, levels.length),
        currentForm: encodeForm(snapshot.currentForm, levels.length)
    };
}

export function decodeFakeForwardDraftGraph(session = {}) {
    if (session?.format !== 'deduplicated-graph' ||
        !session.lists || typeof session.lists !== 'object' ||
        Array.isArray(session.lists) ||
        Object.keys(session.lists).length > 5000) {
        throw new Error('草稿图格式无效');
    }
    const levels = Array.isArray(session.levels) ? session.levels : [];
    if (levels.length > MAX_NESTED_DEPTH) {
        throw new Error('草稿嵌套层级无效');
    }
    const activeRefs = new Set();
    let decodedMessages = 0;

    const decodeSegments = (source, depth) => {
        const segments = [];
        for (const segment of Array.isArray(source) ? source : []) {
            if (segment?.type === 'text') {
                segments.push({ type: 'text', text: String(segment.text || '') });
            } else if (segment?.type === 'image') {
                segments.push({
                    type: 'image',
                    path: String(segment.path || ''),
                    name: String(segment.name || '')
                });
            } else if (segment?.type === 'video' || segment?.type === 'file') {
                segments.push({
                    type: segment.type,
                    path: String(segment.path || ''),
                    name: String(segment.name || ''),
                    size: Math.max(0, Number(segment.size) || 0)
                });
            } else if (segment?.type === 'forward' && depth < MAX_NESTED_DEPTH) {
                segments.push({
                    type: 'forward',
                    uuid: String(segment.uuid || makeEntryId()),
                    messages: decodeMessages(segment.messagesRef, depth + 1),
                    source: String(segment.source || ''),
                    summary: String(segment.summary || ''),
                    prompt: String(segment.prompt || '[聊天记录]')
                });
            }
        }
        return segments;
    };

    const decodeMessages = (ref, depth = 0) => {
        const key = String(ref || '');
        if (!Object.prototype.hasOwnProperty.call(session.lists, key) ||
            !Array.isArray(session.lists[key]) || activeRefs.has(key)) {
            throw new Error('草稿消息引用无效');
        }
        activeRefs.add(key);
        try {
            const source = session.lists[key];
            decodedMessages += source.length;
            if (source.length > MAX_MESSAGES || decodedMessages > 5000) {
                throw new Error('草稿消息数量无效');
            }
            return source.map(message => ({
                id: String(message?.id || makeEntryId()),
                senderUin: String(message?.senderUin || ''),
                senderName: String(message?.senderName || ''),
                segments: decodeSegments(message?.segments, depth),
                timestamp: Number(message?.timestamp) || Date.now()
            }));
        } finally {
            activeRefs.delete(key);
        }
    };

    const decodeForm = (form, depth) => ({
        selectedId: String(form?.selectedId || ''),
        senderUin: String(form?.senderUin || ''),
        senderName: String(form?.senderName || ''),
        timestampDate: String(form?.timestampDate || ''),
        timestampTime: String(form?.timestampTime || ''),
        segments: decodeSegments(form?.segments, depth)
    });

    return {
        rootMessages: decodeMessages(session.rootMessagesRef),
        levels: levels.map((level, index) => ({
            parentMessages: decodeMessages(level?.parentMessagesRef, index),
            form: decodeForm(level?.form, index),
            segment: {
                type: 'forward',
                uuid: String(level?.segment?.uuid || makeEntryId()),
                source: String(level?.segment?.source || ''),
                summary: String(level?.segment?.summary || ''),
                prompt: String(level?.segment?.prompt || '[聊天记录]')
            },
            editing: level?.editing === true,
            returnUuid: String(level?.returnUuid || '')
        })),
        currentMessages: decodeMessages(session.currentMessagesRef, levels.length),
        currentForm: decodeForm(session.currentForm, levels.length)
    };
}

function isSupportedPeer(peer) {
    return [1, 2].includes(Number(peer?.chatType)) && Boolean(String(peer?.peerUid || '').trim());
}

function makeEntryId() {
    return globalThis.crypto?.randomUUID?.() ||
        String(Date.now()) + '-' + Math.random().toString(16).slice(2);
}

export function createFakeForwardEditor(options = {}) {
    const state = {
        rootMessages: [],
        messages: [],
        scopeStack: [],
        selectedId: '',
        sending: false,
        finishingNested: false,
        resolvingSenderName: false,
        observer: null,
        refreshFrame: 0,
        installed: false,
        root: null,
        list: null,
        count: null,
        title: null,
        status: null,
        sendButton: null,
        draggedImage: null,
        objectUrls: new Set(),
        forwardSegments: new Map(),
        previousOverflow: '',
        fields: {}
    };

    function getStorageKey() {
        const scope = String(options.getStorageScope?.() || 'default').replace(/[^\w-]/g, '');
        return 'qqnt-toolbox-fake-forward-draft:' + (scope || 'default');
    }

    function loadDraft() {
        try {
            const value = JSON.parse(localStorage.getItem(getStorageKey()) || '[]');
            if (Number(value?.version) === 3 &&
                value?.session?.format === 'deduplicated-graph') {
                const decoded = decodeFakeForwardDraftGraph(value.session);
                state.rootMessages = normalizeDraftMessages(decoded.rootMessages);
                state.messages = state.rootMessages;
                state.scopeStack = [];
                return { ...decoded, format: 'decoded-graph' };
            }
            const messages = Array.isArray(value) ? value : value?.messages;
            const budget = Number(value?.version) === 3
                ? { remaining: MAX_TOTAL_MESSAGES + MAX_NESTED_DEPTH + 1 }
                : undefined;
            state.rootMessages = normalizeDraftMessages(messages, 0, budget);
            state.messages = state.rootMessages;
            state.scopeStack = [];
            return !Array.isArray(value) && [2, 3].includes(Number(value?.version))
                ? value.session || null
                : null;
        } catch {
            state.rootMessages = [];
            state.messages = state.rootMessages;
            state.scopeStack = [];
            return null;
        }
    }

    function saveDraft() {
        try {
            const keepSession = Boolean(state.fields.composer) && (
                state.scopeStack.length > 0 || hasPendingForm()
            );
            const session = keepSession ? encodeFakeForwardDraftGraph({
                rootMessages: state.rootMessages,
                levels: state.scopeStack,
                currentMessages: state.messages,
                currentForm: captureFormDraft()
            }) : null;
            const stored = keepSession ? {
                version: 3,
                session
            } : state.rootMessages;
            if (state.rootMessages.length || keepSession) {
                localStorage.setItem(getStorageKey(), JSON.stringify(stored));
            } else {
                localStorage.removeItem(getStorageKey());
            }
            return true;
        } catch (error) {
            setStatus('草稿过大，未能自动保存，请先发送或精简内容', 'error');
            console.warn('[QQNT-Toolbox] 保存伪造转发草稿失败', error);
            return false;
        }
    }

    function normalizeStoredForm(form, depth) {
        return {
            selectedId: String(form?.selectedId || ''),
            senderUin: String(form?.senderUin || ''),
            senderName: String(form?.senderName || ''),
            timestampDate: String(form?.timestampDate || ''),
            timestampTime: String(form?.timestampTime || ''),
            segments: normalizeDraftSegments({ segments: form?.segments }, { depth })
        };
    }

    function formFromStoredMessage(message, selectedId, depth) {
        const timestamp = formatDateTimeParts(message?.timestamp);
        return normalizeStoredForm({
            selectedId,
            senderUin: message?.senderUin,
            senderName: message?.senderName,
            timestampDate: timestamp.date,
            timestampTime: timestamp.time,
            segments: message?.segments
        }, depth);
    }

    function restoreCompactDraftSession(session) {
        if (!Array.isArray(session?.levels) ||
            session.levels.length > MAX_NESTED_DEPTH) {
            return false;
        }
        try {
            const rootMessages = normalizeDraftMessages(
                state.rootMessages,
                0,
                { remaining: MAX_TOTAL_MESSAGES + MAX_NESTED_DEPTH + 1 }
            );
            const scopeStack = [];
            let messages = rootMessages;
            for (let index = 0; index < session.levels.length; index += 1) {
                const level = session.levels[index];
                const messageIndex = messages.findIndex(message =>
                    message.id === String(level?.messageId || '')
                );
                if (messageIndex < 0) {
                    throw new Error('嵌套草稿路径无效');
                }
                const message = messages[messageIndex];
                const forwardUuid = String(level?.forwardUuid || '');
                const forward = message.segments.find(segment =>
                    segment.type === 'forward' && segment.uuid === forwardUuid
                );
                if (!forward) {
                    throw new Error('嵌套草稿记录无效');
                }
                const selectedId = String(level?.selectedId || '');
                const editing = level?.editing === true;
                const form = formFromStoredMessage(message, selectedId, index);
                if (!editing) {
                    form.segments = form.segments.filter(segment =>
                        segment.type !== 'forward' || segment.uuid !== forwardUuid
                    );
                }
                const childMessages = normalizeDraftMessages(forward.messages, index + 1);
                if (!selectedId) {
                    messages.splice(messageIndex, 1);
                }
                scopeStack.push({
                    parentMessages: messages,
                    form,
                    segment: {
                        type: 'forward',
                        uuid: forwardUuid || makeEntryId(),
                        source: String(forward.source || ''),
                        summary: String(forward.summary || ''),
                        prompt: String(forward.prompt || '[聊天记录]')
                    },
                    editing,
                    returnUuid: String(level?.returnUuid || '')
                });
                messages = childMessages;
            }

            let currentForm = {};
            if (session.current?.form) {
                currentForm = normalizeStoredForm(
                    session.current.form,
                    scopeStack.length
                );
            } else if (session.current?.messageId) {
                const messageIndex = messages.findIndex(message =>
                    message.id === String(session.current.messageId)
                );
                if (messageIndex < 0) {
                    throw new Error('当前草稿消息无效');
                }
                const selectedId = String(session.current.selectedId || '');
                currentForm = formFromStoredMessage(
                    messages[messageIndex],
                    selectedId,
                    scopeStack.length
                );
                if (!selectedId) {
                    messages.splice(messageIndex, 1);
                }
            }
            state.rootMessages = rootMessages;
            state.scopeStack = scopeStack;
            state.messages = messages;
            restoreFormDraft(currentForm);
            syncScopeUi();
            return true;
        } catch {
            state.scopeStack = [];
            state.messages = state.rootMessages;
            return false;
        }
    }

    function restoreDraftSession(session) {
        if (session?.format === 'compact-tree') {
            return restoreCompactDraftSession(session);
        }
        if (!session || !Array.isArray(session.levels) ||
            session.levels.length > MAX_NESTED_DEPTH) {
            return false;
        }
        try {
            state.scopeStack = session.levels.map((level, index) => ({
                parentMessages: index === 0
                    ? state.rootMessages
                    : normalizeDraftMessages(level?.parentMessages, index),
                form: normalizeStoredForm(level?.form, index),
                segment: {
                    type: 'forward',
                    uuid: String(level?.segment?.uuid || makeEntryId()),
                    source: String(level?.segment?.source || ''),
                    summary: String(level?.segment?.summary || ''),
                    prompt: String(level?.segment?.prompt || '[聊天记录]')
                },
                editing: level?.editing === true,
                returnUuid: String(level?.returnUuid || '')
            }));
            state.messages = state.scopeStack.length
                ? normalizeDraftMessages(session.currentMessages, state.scopeStack.length)
                : state.rootMessages;
            restoreFormDraft(normalizeStoredForm(
                session.currentForm,
                state.scopeStack.length
            ));
            syncScopeUi();
            return true;
        } catch {
            state.scopeStack = [];
            state.messages = state.rootMessages;
            return false;
        }
    }

    function setStatus(message = '', kind = '') {
        if (!state.status) {
            return;
        }
        state.status.textContent = message;
        state.status.title = message;
        state.status.dataset.kind = kind;
    }

    function syncNestedButtonAvailability() {
        const button = state.fields.addNested;
        if (!button) {
            return;
        }
        const emptyNestedScope = state.scopeStack.length > 0 && state.messages.length === 0;
        const atDepthLimit = state.scopeStack.length >= MAX_NESTED_DEPTH;
        button.disabled = state.sending || state.finishingNested ||
            atDepthLimit || emptyNestedScope;
        button.title = atDepthLimit
            ? '已达到最多 ' + MAX_NESTED_DEPTH + ' 层'
            : (emptyNestedScope
                ? '请先在当前子合并中添加一条消息'
                : '向当前层添加一个子合并');
        button.setAttribute('aria-label', button.title);
    }

    function syncEditorGuide() {
        const mode = state.fields.editorMode;
        const guide = state.fields.editorGuide;
        if (!mode || !guide) {
            return;
        }
        const depth = state.scopeStack.length;
        const hasForward = Boolean(state.fields.composer?.querySelector(
            '.' + FORWARD_TOKEN_CLASS
        ));
        if (state.fields.senderUinLabel) {
            state.fields.senderUinLabel.textContent = hasForward
                ? '这张子合并在当前层的发送者 QQ'
                : '发送者 QQ';
            state.fields.senderNameLabel.textContent = hasForward
                ? '在当前层显示的昵称'
                : '显示昵称';
            state.fields.composerLabel.textContent = hasForward
                ? '子合并内容'
                : '消息内容';
        }
        if (hasForward) {
            mode.textContent = state.selectedId ? '编辑子合并卡片' : '准备加入子合并';
            guide.textContent = state.selectedId
                ? '可补充这张卡片的显示信息，点击下方聊天记录卡片可编辑内容。'
                : '填写这张子合并在当前层显示的发送者，再加入当前层。';
        } else if (depth) {
            mode.textContent = `正在编辑第 ${depth} 层子合并`;
            guide.textContent = '添加本层消息后，点击“完成此子合并”回到上一级。';
        } else if (state.selectedId) {
            mode.textContent = '正在编辑消息';
            guide.textContent = '保存后会替换左侧选中的消息。';
        } else {
            mode.textContent = '新建普通消息';
            guide.textContent = '填写发送者与内容后加入当前层，或从左侧直接创建子合并。';
        }
    }

    function renderList() {
        if (!state.list) {
            return;
        }
        state.list.replaceChildren();
        state.count.textContent = String(state.messages.length) + '/' + MAX_MESSAGES;
        if (!state.messages.length) {
            state.list.append(createElement('li', 'qff-empty', '暂无消息'));
        } else {
            for (const message of state.messages) {
                const item = createElement('li');
                const button = createButton('qff-message', '');
                const forward = getForwardSegment(message);
                const needsSender = forward && !hasValidSenderUin(message);
                button.dataset.kind = forward ? 'forward' : 'message';
                button.dataset.incomplete = String(Boolean(needsSender));
                button.setAttribute('aria-selected', String(message.id === state.selectedId));
                let identity;
                if (forward) {
                    identity = createElement('span', 'qff-forward-avatar');
                    identity.setAttribute('aria-hidden', 'true');
                    identity.append(createElement('span'), createElement('span'));
                } else {
                    identity = createElement('img', 'qff-avatar');
                    identity.alt = '';
                    identity.src = avatarUrl(message.senderUin);
                    identity.addEventListener(
                        'error',
                        () => identity.removeAttribute('src'),
                        { once: true }
                    );
                }
                const main = createElement('span', 'qff-message-main');
                const meta = createElement('span', 'qff-message-meta');
                meta.append(
                    createElement(
                        'span',
                        'qff-message-name',
                        needsSender
                            ? '待填写显示信息'
                            : (message.senderName || message.senderUin)
                    ),
                    createElement('span', 'qff-message-time', formatListTime(message.timestamp))
                );
                main.append(
                    meta,
                    createElement(
                        'span',
                        'qff-message-text',
                        forward
                            ? `子合并 · ${forward.messages.length} 条消息`
                            : messagePreview(message)
                    )
                );
                button.append(identity, main);
                button.addEventListener('click', () => selectMessage(message.id));
                item.append(button);
                state.list.append(item);
            }
        }
        const index = state.messages.findIndex(item => item.id === state.selectedId);
        const blocked = state.sending || state.finishingNested;
        state.fields.moveUp.disabled = blocked || index <= 0;
        state.fields.moveDown.disabled = blocked || index < 0 || index >= state.messages.length - 1;
        state.fields.remove.disabled = blocked || index < 0;
        state.sendButton.disabled = blocked || state.resolvingSenderName || state.messages.length === 0;
        syncNestedButtonAvailability();
        syncEditorGuide();
    }

    function readComposerSegments() {
        return readFakeForwardComposerSegments(state.fields.composer, {
            depth: state.scopeStack.length,
            resolveForward: id => state.forwardSegments.get(id)
        });
    }

    function releaseImagePreview(token) {
        const url = token?.dataset?.objectUrl;
        if (!url) {
            return;
        }
        URL.revokeObjectURL(url);
        state.objectUrls.delete(url);
        delete token.dataset.objectUrl;
    }

    function removeComposerToken(token) {
        if (!token || state.sending) {
            return;
        }
        releaseImagePreview(token);
        if (token.classList?.contains(FORWARD_TOKEN_CLASS)) {
            state.forwardSegments.delete(String(token.dataset?.forwardId || ''));
        }
        token.remove();
        state.fields.composer.focus();
    }

    function rememberForwardSegment(forwardId, segment) {
        state.forwardSegments.set(forwardId, segment);
        while (state.forwardSegments.size > MAX_FORWARD_SEGMENT_CACHE) {
            state.forwardSegments.delete(state.forwardSegments.keys().next().value);
        }
    }

    function createComposerImage(image, previewUrl = '') {
        const token = createElement('span', IMAGE_TOKEN_CLASS);
        token.contentEditable = 'false';
        token.draggable = true;
        token.dataset.path = String(image.path || '');
        token.dataset.name = String(image.name || '');
        token.dataset.pending = String(!image.path);
        token.title = image.name || image.path || '图片';
        const preview = createElement('img', 'qff-composer-image-preview');
        preview.alt = '';
        preview.draggable = false;
        preview.src = previewUrl || localImageUrl(image.path);
        const remove = createButton('qff-composer-image-remove', '×', '移除图片');
        remove.addEventListener('pointerdown', event => event.preventDefault());
        remove.addEventListener('click', () => removeComposerToken(token));
        token.addEventListener('dragstart', event => {
            if (state.sending) {
                event.preventDefault();
                return;
            }
            state.draggedImage = token;
            token.classList.add('qff-composer-image-dragging');
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('application/x-qqnt-toolbox-image', 'move');
        });
        token.addEventListener('dragend', () => {
            token.classList.remove('qff-composer-image-dragging');
            state.draggedImage = null;
        });
        if (previewUrl) {
            token.dataset.objectUrl = previewUrl;
            state.objectUrls.add(previewUrl);
        }
        token.append(preview, remove);
        return token;
    }

    function formatFileSize(value) {
        const size = Math.max(0, Number(value) || 0);
        if (size < 1024) {
            return size + ' B';
        }
        if (size < 1024 * 1024) {
            return (size / 1024).toFixed(size < 10 * 1024 ? 1 : 0) + ' KB';
        }
        if (size < 1024 * 1024 * 1024) {
            return (size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
        }
        return (size / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
    }

    function createComposerAttachment(media) {
        const type = media.type === 'video' ? 'video' : 'file';
        const extension = /\.([^.]+)$/.exec(String(media.name || ''))?.[1] || '';
        const token = createElement('span', ATTACHMENT_TOKEN_CLASS);
        token.contentEditable = 'false';
        token.dataset.type = type;
        token.dataset.path = String(media.path || '');
        token.dataset.name = String(media.name || '');
        token.dataset.size = String(Math.max(0, Number(media.size) || 0));
        token.dataset.pending = String(!media.path);
        token.title = media.name || media.path || (type === 'video' ? '视频' : '文件');
        const icon = createElement(
            'span',
            'qff-composer-attachment-icon',
            type === 'video' ? '▶' : (extension.slice(0, 4).toUpperCase() || 'FILE')
        );
        const details = createElement('span', 'qff-composer-attachment-details');
        details.append(
            createElement('span', 'qff-composer-attachment-name', media.name || (type === 'video' ? '视频' : '文件')),
            createElement('span', 'qff-composer-attachment-meta', formatFileSize(media.size))
        );
        const remove = createButton(
            'qff-composer-image-remove qff-composer-attachment-remove',
            '×',
            type === 'video' ? '移除视频' : '移除文件'
        );
        remove.addEventListener('pointerdown', event => event.preventDefault());
        remove.addEventListener('click', () => removeComposerToken(token));
        token.append(icon, details, remove);
        return token;
    }

    function createComposerForward(forward) {
        const segment = normalizeDraftSegments({ segments: [forward] }, {
            depth: state.scopeStack.length
        })[0];
        if (!segment) {
            return null;
        }
        const token = createElement('span', FORWARD_TOKEN_CLASS);
        token.contentEditable = 'false';
        token.setAttribute('role', 'group');
        token.setAttribute('aria-label', '嵌套聊天记录');
        const forwardId = makeEntryId();
        token.dataset.forwardId = forwardId;
        token.dataset.forwardUuid = segment.uuid;
        token.__qffForward = segment;
        rememberForwardSegment(forwardId, segment);
        const icon = createElement('span', 'qff-composer-forward-icon');
        icon.setAttribute('aria-hidden', 'true');
        icon.append(createElement('span'), createElement('span'));
        const details = createElement('span', 'qff-composer-forward-details');
        const preview = segment.messages.slice(0, 3).map(message =>
            `${message.senderName || message.senderUin}: ${messagePreview(message)}`
        ).filter(Boolean).join(' · ');
        details.append(
            createElement('span', 'qff-composer-forward-name', '聊天记录'),
            createElement(
                'span',
                'qff-composer-forward-meta',
                `${segment.messages.length} 条消息${preview ? ` · ${preview}` : ''}`
            )
        );
        const edit = createElement('span', 'qff-composer-forward-edit', '编辑');
        const open = createButton(
            'qff-composer-forward-open',
            '',
            '编辑嵌套聊天记录'
        );
        open.append(icon, details, edit);
        const remove = createButton(
            'qff-composer-image-remove qff-composer-forward-remove',
            '×',
            '移除嵌套聊天记录'
        );
        remove.addEventListener('pointerdown', event => event.preventDefault());
        remove.addEventListener('click', event => {
            event.stopPropagation();
            removeComposerToken(token);
        });
        const openNested = () => {
            if (state.sending) {
                return;
            }
            enterNestedRecord(segment);
        };
        open.addEventListener('click', openNested);
        token.addEventListener('click', event => {
            if (event.target === token) {
                openNested();
            }
        });
        token.append(open, remove);
        return token;
    }

    function renderComposer(segments = []) {
        for (const token of state.fields.composer.querySelectorAll('.' + IMAGE_TOKEN_CLASS)) {
            releaseImagePreview(token);
        }
        state.forwardSegments.clear();
        const nodes = [];
        for (const segment of normalizeDraftSegments({ segments })) {
            if (segment.type === 'image') {
                nodes.push(createComposerImage(segment));
            } else if (segment.type === 'video' || segment.type === 'file') {
                nodes.push(createComposerAttachment(segment));
            } else if (segment.type === 'forward') {
                const token = createComposerForward(segment);
                if (token) {
                    nodes.push(token);
                }
            } else {
                nodes.push(document.createTextNode(segment.text));
            }
        }
        state.fields.composer.replaceChildren(...nodes);
    }

    function getComposerRange() {
        const selection = window.getSelection();
        if (selection?.rangeCount) {
            const range = selection.getRangeAt(0);
            if (state.fields.composer.contains(range.commonAncestorContainer)) {
                return range.cloneRange();
            }
        }
        const range = document.createRange();
        range.selectNodeContents(state.fields.composer);
        range.collapse(false);
        return range;
    }

    function getDropRange(event) {
        const targetToken = event.target instanceof Element
            ? event.target.closest('.' + IMAGE_TOKEN_CLASS)
            : null;
        if (targetToken && state.fields.composer.contains(targetToken)) {
            const range = document.createRange();
            const before = event.clientX < targetToken.getBoundingClientRect().left + targetToken.offsetWidth / 2;
            range[before ? 'setStartBefore' : 'setStartAfter'](targetToken);
            range.collapse(true);
            return range;
        }
        const caret = document.caretRangeFromPoint?.(event.clientX, event.clientY);
        if (caret && state.fields.composer.contains(caret.commonAncestorContainer)) {
            return caret;
        }
        return getComposerRange();
    }

    function selectAfter(node) {
        const range = document.createRange();
        range.setStartAfter(node);
        range.collapse(true);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
    }

    function insertText(text, range = getComposerRange()) {
        if (!text) {
            return;
        }
        const currentLength = readComposerSegments()
            .filter(segment => segment.type === 'text')
            .reduce((length, segment) => length + segment.text.length, 0);
        const value = String(text).slice(0, Math.max(0, MAX_TEXT_LENGTH - currentLength));
        if (!value) {
            setStatus('消息内容不能超过 ' + MAX_TEXT_LENGTH + ' 个字符', 'error');
            return;
        }
        range.deleteContents();
        const node = document.createTextNode(value);
        range.insertNode(node);
        selectAfter(node);
    }

    function isImageFile(file) {
        return file instanceof File &&
            (String(file.type || '').startsWith('image/') || IMAGE_FILE_PATTERN.test(file.name || ''));
    }

    function isVideoFile(file) {
        return file instanceof File &&
            (String(file.type || '').startsWith('video/') || VIDEO_FILE_PATTERN.test(file.name || ''));
    }

    function getTransferFiles(dataTransfer) {
        const files = Array.from(dataTransfer?.files || []).filter(file => file instanceof File);
        if (files.length) {
            return files;
        }
        return Array.from(dataTransfer?.items || [])
            .filter(item => item.kind === 'file')
            .map(item => item.getAsFile())
            .filter(file => file instanceof File);
    }

    async function getLocalFilePath(file) {
        const directPath = String(file?.path || '');
        if (directPath) {
            return directPath;
        }
        return String(await options.getFilePath?.(file) || '');
    }

    async function resolveComposerImage(file, token) {
        try {
            let image = {
                path: await getLocalFilePath(file),
                name: String(file.name || '')
            };
            if (!image.path) {
                image = await options.stageImage?.({
                    name: file.name,
                    type: file.type,
                    data: await file.arrayBuffer()
                });
            }
            if (!image?.path) {
                throw new Error('无法读取图片文件');
            }
            if (!token.isConnected) {
                return;
            }
            token.dataset.path = String(image.path);
            token.dataset.name = String(image.name || file.name || '');
            token.dataset.pending = 'false';
            token.title = token.dataset.name || token.dataset.path;
            const preview = token.querySelector('.qff-composer-image-preview');
            preview.src = localImageUrl(token.dataset.path);
            releaseImagePreview(token);
        } catch (error) {
            removeComposerToken(token);
            setStatus(error?.message || '图片处理失败', 'error');
        }
    }

    async function resolveComposerAttachment(file, token) {
        try {
            const filePath = await getLocalFilePath(file);
            if (!filePath) {
                throw new Error('无法读取本地文件路径');
            }
            if (!token.isConnected) {
                return;
            }
            token.dataset.path = filePath;
            token.dataset.pending = 'false';
        } catch (error) {
            removeComposerToken(token);
            setStatus(error?.message || '文件处理失败', 'error');
        }
    }

    function insertImageFiles(files, range = getComposerRange()) {
        const currentCount = state.fields.composer.querySelectorAll('.' + IMAGE_TOKEN_CLASS).length;
        const accepted = files.slice(0, Math.max(0, MAX_IMAGES_PER_MESSAGE - currentCount));
        if (!accepted.length) {
            setStatus('每条消息最多包含 ' + MAX_IMAGES_PER_MESSAGE + ' 张图片', 'error');
            return;
        }
        range.deleteContents();
        let lastToken = null;
        for (const file of accepted) {
            const previewUrl = URL.createObjectURL(file);
            const token = createComposerImage({ name: file.name }, previewUrl);
            range.insertNode(token);
            range.setStartAfter(token);
            range.collapse(true);
            lastToken = token;
            resolveComposerImage(file, token);
        }
        if (lastToken) {
            selectAfter(lastToken);
        }
    }

    function insertAttachmentFile(file) {
        const hasContent = readComposerSegments().some(segment =>
            segment.type !== 'text' || segment.text.trim()
        );
        if (hasContent) {
            setStatus('视频、文件或嵌套聊天记录必须单独作为一条消息', 'error');
            return;
        }
        const type = isVideoFile(file) ? 'video' : 'file';
        const token = createComposerAttachment({
            type,
            name: file.name,
            size: file.size
        });
        state.fields.composer.replaceChildren(token);
        selectAfter(token);
        resolveComposerAttachment(file, token);
    }

    function insertComposerFiles(files, range = getComposerRange()) {
        if (!files.length) {
            return;
        }
        if (state.fields.composer.querySelector(
            '.' + ATTACHMENT_TOKEN_CLASS + ', .' + FORWARD_TOKEN_CLASS
        )) {
            setStatus('视频、文件或嵌套聊天记录必须单独作为一条消息', 'error');
            return;
        }
        if (files.every(isImageFile)) {
            insertImageFiles(files, range);
            return;
        }
        if (files.length !== 1) {
            setStatus('视频或文件每条消息只能添加一个', 'error');
            return;
        }
        insertAttachmentFile(files[0]);
    }

    function handleComposerPaste(event) {
        const files = getTransferFiles(event.clipboardData);
        if (files.length) {
            event.preventDefault();
            insertComposerFiles(files);
            return;
        }
        const text = event.clipboardData?.getData('text/plain');
        if (text !== undefined) {
            event.preventDefault();
            if (state.fields.composer.querySelector(
                '.' + ATTACHMENT_TOKEN_CLASS + ', .' + FORWARD_TOKEN_CLASS
            )) {
                setStatus('视频、文件或嵌套聊天记录必须单独作为一条消息', 'error');
                return;
            }
            insertText(text);
        }
    }

    function handleComposerDrop(event) {
        if (state.sending) {
            return;
        }
        const range = getDropRange(event);
        if (state.draggedImage) {
            event.preventDefault();
            event.stopPropagation();
            const token = state.draggedImage;
            range.insertNode(token);
            selectAfter(token);
            return;
        }
        const files = getTransferFiles(event.dataTransfer);
        if (files.length) {
            event.preventDefault();
            event.stopPropagation();
            insertComposerFiles(files, range);
        }
    }

    function handleComposerKeydown(event) {
        if (event.target instanceof Element && event.target.closest('button')) {
            return;
        }
        const standalone = state.fields.composer.querySelector(
            '.' + ATTACHMENT_TOKEN_CLASS + ', .' + FORWARD_TOKEN_CLASS
        );
        if (!standalone || event.ctrlKey || event.metaKey || event.altKey) {
            return;
        }
        if (event.key === 'Backspace' || event.key === 'Delete') {
            event.preventDefault();
            removeComposerToken(standalone);
            return;
        }
        if (event.key === 'Enter' || event.key.length === 1) {
            event.preventDefault();
            setStatus('视频、文件或嵌套聊天记录必须单独作为一条消息', 'error');
        }
    }

    function captureFormDraft() {
        return {
            selectedId: state.selectedId,
            senderUin: state.fields.senderUin.value,
            senderName: state.fields.senderName.value,
            timestampDate: state.fields.timestampDate.value,
            timestampTime: state.fields.timestampTime.value,
            segments: readComposerSegments()
        };
    }

    function focusForwardRecord(uuid) {
        requestAnimationFrame(() => {
            let target = null;
            if (uuid) {
                target = Array.from(state.fields.composer.querySelectorAll(
                    '.' + FORWARD_TOKEN_CLASS
                )).find(token => token.dataset.forwardUuid === uuid);
            }
            const control = target?.querySelector('.qff-composer-forward-open');
            (control || state.fields.composer).focus();
        });
    }

    function restoreFormDraft(draft) {
        state.selectedId = String(draft?.selectedId || '');
        state.fields.senderUin.value = String(draft?.senderUin || '');
        state.fields.senderName.value = String(draft?.senderName || '');
        state.fields.timestampDate.value = String(draft?.timestampDate || '');
        state.fields.timestampTime.value = String(draft?.timestampTime || '');
        if (!state.fields.timestampDate.value || !state.fields.timestampTime.value) {
            setTimestampFields();
        }
        renderComposer(draft?.segments || []);
        const hasForward = Array.isArray(draft?.segments) &&
            draft.segments.some(segment => segment?.type === 'forward');
        state.fields.commit.textContent = state.selectedId
            ? (hasForward ? '保存显示信息' : '保存消息')
            : (hasForward ? '添加到当前层' : '添加消息');
        state.fields.cancelEdit.hidden = !state.selectedId;
        renderList();
    }

    function hasPendingForm() {
        if (state.selectedId || state.fields.senderUin.value.trim() ||
            state.fields.senderName.value.trim()) {
            return true;
        }
        return readComposerSegments().some(segment =>
            segment.type !== 'text' || segment.text.trim()
        );
    }

    function isUneditedPendingForward() {
        if (!state.selectedId) {
            return false;
        }
        const message = state.messages.find(item => item.id === state.selectedId);
        return Boolean(
            getForwardSegment(message) &&
            !state.fields.senderUin.value.trim() &&
            !state.fields.senderName.value.trim() &&
            parseDateTimeParts(
                state.fields.timestampDate.value,
                state.fields.timestampTime.value
            ) === message.timestamp
        );
    }

    function syncScopeUi() {
        const depth = state.scopeStack.length;
        if (!state.root) {
            return;
        }
        state.title.textContent = '伪造合并转发';
        state.fields.layerPath.textContent = [
            '外层记录',
            ...Array.from({ length: depth }, (_, index) =>
                `子合并 ${index + 1}/${MAX_NESTED_DEPTH}`
            )
        ].join(' › ');
        state.fields.footerCancel.textContent = depth ? '放弃本子合并' : '取消';
        state.fields.addNested.textContent = depth ? '添加下一级' : '添加子合并';
        state.sendButton.textContent = state.sending
            ? (depth ? '处理中' : '发送中')
            : (depth ? '完成此子合并' : '发送合并转发');
        renderList();
    }

    function enterNestedRecord(forward = null) {
        if (state.sending || state.finishingNested) {
            return;
        }
        const depth = state.scopeStack.length;
        if (depth >= MAX_NESTED_DEPTH) {
            setStatus('聊天记录最多嵌套 ' + MAX_NESTED_DEPTH + ' 层', 'error');
            return;
        }
        const existing = forward?.type === 'forward';
        if (!existing && isUneditedPendingForward()) {
            clearForm();
        }
        if (!existing && depth > 0 && !state.messages.length) {
            setStatus('请先在当前子合并中添加至少一条消息', 'error');
            return;
        }
        if (!existing && !state.selectedId && state.messages.length >= MAX_MESSAGES) {
            setStatus('一次最多生成 ' + MAX_MESSAGES + ' 条消息', 'error');
            return;
        }
        if (!existing && readComposerSegments().some(segment =>
            segment.type !== 'text' || segment.text.trim()
        )) {
            setStatus('嵌套聊天记录必须单独作为一条消息', 'error');
            return;
        }
        const segment = existing ? forward : {
            type: 'forward',
            uuid: makeEntryId(),
            messages: [],
            prompt: '[聊天记录]'
        };
        state.scopeStack.push({
            parentMessages: state.messages,
            form: captureFormDraft(),
            segment: {
                type: 'forward',
                uuid: String(segment.uuid || makeEntryId()),
                source: String(segment.source || ''),
                summary: String(segment.summary || ''),
                prompt: String(segment.prompt || '[聊天记录]')
            },
            editing: existing,
            returnUuid: existing ? String(segment.uuid || '') : ''
        });
        state.messages = normalizeDraftMessages(segment.messages, depth + 1);
        clearForm();
        syncScopeUi();
        setStatus('正在编辑子合并；添加完消息后点击“完成此子合并”');
        saveDraft();
        state.fields.senderUin.focus();
    }

    async function finishNestedRecord() {
        const frame = state.scopeStack.at(-1);
        if (!frame || state.finishingNested) {
            return;
        }
        if (hasPendingForm()) {
            setStatus('请先添加或保存当前消息', 'error');
            return;
        }
        if (!state.messages.length) {
            setStatus('嵌套聊天记录至少需要一条消息', 'error');
            return;
        }
        const depth = state.scopeStack.length;
        const nested = {
            ...frame.segment,
            messages: normalizeDraftMessages(state.messages, depth)
        };
        if (countFakeForwardDraftMessages(projectFakeForwardDraftMessages(
            state.messages,
            state.scopeStack
        )) > MAX_TOTAL_MESSAGES) {
            setStatus('嵌套聊天记录合计最多包含 ' + MAX_TOTAL_MESSAGES + ' 条消息', 'error');
            return;
        }
        state.finishingNested = true;
        try {
            state.scopeStack.pop();
            state.messages = frame.parentMessages;
            const parentDraft = frame.form;
            const parentSegments = mergeNestedIntoSegments(
                parentDraft.segments,
                nested,
                frame.editing
            );
            const parentIndex = state.messages.findIndex(message =>
                message.id === parentDraft.selectedId
            );
            const existingParent = parentIndex >= 0 ? state.messages[parentIndex] : null;
            const parentMessage = {
                id: existingParent?.id || parentDraft.selectedId || makeEntryId(),
                senderUin: String(parentDraft.senderUin || existingParent?.senderUin || ''),
                senderName: String(parentDraft.senderName || existingParent?.senderName || ''),
                segments: normalizeDraftSegments({
                    segments: parentSegments
                }, { depth: state.scopeStack.length }),
                timestamp: parseDateTimeParts(
                    parentDraft.timestampDate,
                    parentDraft.timestampTime
                )
            };
            if (parentIndex >= 0) {
                state.messages.splice(parentIndex, 1, parentMessage);
            } else if (state.messages.length < MAX_MESSAGES) {
                state.messages.push(parentMessage);
            } else {
                setStatus('一次最多生成 ' + MAX_MESSAGES + ' 条消息', 'error');
                return;
            }
            syncScopeUi();
            clearForm();
            saveDraft();
            setStatus(parentIndex >= 0
                ? '已更新子合并；可继续添加另一个子合并'
                : '已添加子合并草稿；可继续添加，或在左侧补充显示信息');
        } finally {
            state.finishingNested = false;
            syncScopeUi();
        }
    }

    function cancelNestedRecord() {
        if (state.finishingNested) {
            return;
        }
        const frame = state.scopeStack.pop();
        if (!frame) {
            return;
        }
        state.messages = frame.parentMessages;
        restoreFormDraft(frame.form);
        syncScopeUi();
        setStatus();
        saveDraft();
        focusForwardRecord(frame.returnUuid);
    }

    function setTimestampFields(timestamp = Date.now()) {
        const value = formatDateTimeParts(timestamp);
        state.fields.timestampDate.value = value.date;
        state.fields.timestampTime.value = value.time;
    }

    function clearForm() {
        state.selectedId = '';
        state.fields.senderUin.value = '';
        state.fields.senderName.value = '';
        setTimestampFields();
        renderComposer();
        state.fields.commit.textContent = '添加消息';
        state.fields.cancelEdit.hidden = true;
        setStatus();
        renderList();
    }

    function selectMessage(id) {
        const message = state.messages.find(item => item.id === id);
        if (!message) {
            clearForm();
            return;
        }
        state.selectedId = id;
        state.fields.senderUin.value = message.senderUin;
        state.fields.senderName.value = message.senderName;
        setTimestampFields(message.timestamp);
        renderComposer(message.segments);
        state.fields.commit.textContent = getForwardSegment(message)
            ? '保存显示信息'
            : '保存消息';
        state.fields.cancelEdit.hidden = false;
        setStatus();
        renderList();
    }

    async function commitForm() {
        if (state.resolvingSenderName) {
            return;
        }
        const senderUin = state.fields.senderUin.value.trim();
        let senderName = state.fields.senderName.value.trim();
        const segments = readComposerSegments();
        const textLength = segments.filter(segment => segment.type === 'text')
            .reduce((length, segment) => length + segment.text.length, 0);
        const images = segments.filter(segment => segment.type === 'image');
        const standalone = segments.filter(segment =>
            segment.type === 'video' || segment.type === 'file' || segment.type === 'forward'
        );
        const isForwardMessage = standalone.length === 1 &&
            standalone[0].type === 'forward' && segments.length === 1;
        const editingMessage = Boolean(state.selectedId);
        if (!/^\d{5,20}$/.test(senderUin)) {
            setStatus('请输入有效的发送者 QQ 号', 'error');
            state.fields.senderUin.focus();
            return;
        }
        if (segments.some(segment => segment.pending || (
            ['image', 'video', 'file'].includes(segment.type) && !segment.path
        ))) {
            setStatus('文件正在处理，请稍候', 'error');
            return;
        }
        if (standalone.length && (standalone.length !== 1 || segments.length !== 1)) {
            setStatus('视频、文件或嵌套聊天记录必须单独作为一条消息', 'error');
            return;
        }
        const hasText = segments.some(segment => segment.type === 'text' && segment.text.trim());
        if (!hasText && !images.length && !standalone.length) {
            setStatus('请输入消息内容', 'error');
            state.fields.composer.focus();
            return;
        }
        if (textLength > MAX_TEXT_LENGTH) {
            setStatus('消息内容不能超过 ' + MAX_TEXT_LENGTH + ' 个字符', 'error');
            return;
        }
        if (!senderName) {
            state.resolvingSenderName = true;
            state.fields.commit.disabled = true;
            state.sendButton.disabled = true;
            setStatus('正在获取昵称');
            try {
                senderName = String(await options.resolveSenderName?.(senderUin) || '').trim();
            } catch {
                senderName = '';
            } finally {
                state.resolvingSenderName = false;
                state.fields.commit.disabled = state.sending || state.resolvingSenderName;
                renderList();
            }
            if (!senderName) {
                setStatus('未能获取该 QQ 号的昵称，请手动填写', 'error');
                state.fields.senderName.focus();
                return;
            }
            state.fields.senderName.value = senderName;
        }
        const next = {
            id: state.selectedId || makeEntryId(),
            senderUin,
            senderName,
            segments: normalizeDraftSegments({ segments }, {
                depth: state.scopeStack.length
            }),
            timestamp: parseDateTimeParts(
                state.fields.timestampDate.value,
                state.fields.timestampTime.value
            )
        };
        const index = state.messages.findIndex(item => item.id === state.selectedId);
        const candidateMessages = state.messages.slice();
        if (index >= 0) {
            candidateMessages.splice(index, 1, next);
        } else {
            candidateMessages.push(next);
        }
        if (countFakeForwardDraftMessages(projectFakeForwardDraftMessages(
            candidateMessages,
            state.scopeStack
        )) > MAX_TOTAL_MESSAGES) {
            setStatus('嵌套聊天记录合计最多包含 ' + MAX_TOTAL_MESSAGES + ' 条消息', 'error');
            return;
        }
        if (index >= 0) {
            state.messages.splice(index, 1, next);
        } else if (state.messages.length < MAX_MESSAGES) {
            state.messages.push(next);
        } else {
            setStatus('一次最多生成 ' + MAX_MESSAGES + ' 条消息', 'error');
            return;
        }
        clearForm();
        if (isForwardMessage) {
            setStatus(editingMessage
                ? '已保存子合并修改'
                : '已添加子合并；可继续添加另一个子合并');
        }
        saveDraft();
    }

    function moveSelected(offset) {
        const index = state.messages.findIndex(item => item.id === state.selectedId);
        const target = index + offset;
        if (index < 0 || target < 0 || target >= state.messages.length) {
            return;
        }
        [state.messages[index], state.messages[target]] = [state.messages[target], state.messages[index]];
        saveDraft();
        renderList();
    }

    function removeSelected() {
        const index = state.messages.findIndex(item => item.id === state.selectedId);
        if (index < 0) {
            return;
        }
        state.messages.splice(index, 1);
        clearForm();
        saveDraft();
    }

    function setSending(sending) {
        state.sending = sending;
        state.root?.querySelectorAll('input').forEach(control => {
            control.disabled = sending;
        });
        state.fields.composer.contentEditable = String(!sending);
        state.fields.composer.querySelectorAll('.qff-composer-image-remove').forEach(control => {
            control.disabled = sending;
        });
        state.fields.composer.querySelectorAll('button').forEach(control => {
            control.disabled = sending;
        });
        state.fields.addFile.disabled = sending;
        syncNestedButtonAvailability();
        state.fields.footerCancel.disabled = sending;
        state.fields.commit.disabled = sending || state.resolvingSenderName;
        state.fields.cancelEdit.disabled = sending;
        syncScopeUi();
    }

    function close(force = false) {
        if (!state.root || ((state.sending || state.finishingNested) && !force)) {
            return;
        }
        if (!saveDraft() && !force) {
            return;
        }
        state.root.hidden = true;
        document.body.style.overflow = state.previousOverflow;
    }

    function findIncompleteDraftPath(messages, path = []) {
        for (const message of Array.isArray(messages) ? messages : []) {
            const nextPath = [...path, String(message?.id || '')];
            if (!hasValidSenderUin(message)) {
                return nextPath;
            }
            const forward = getForwardSegment(message);
            if (forward) {
                const nestedPath = findIncompleteDraftPath(forward.messages, nextPath);
                if (nestedPath) {
                    return nestedPath;
                }
            }
        }
        return null;
    }

    function focusDraftPath(path) {
        if (!Array.isArray(path) || !path.length) {
            return;
        }
        state.scopeStack = [];
        state.messages = state.rootMessages;
        clearForm();
        for (let index = 0; index < path.length; index += 1) {
            const message = state.messages.find(item => item.id === path[index]);
            if (!message) {
                return;
            }
            selectMessage(message.id);
            if (index < path.length - 1) {
                const forward = getForwardSegment(message);
                if (!forward) {
                    return;
                }
                enterNestedRecord(forward);
            }
        }
    }

    async function send() {
        if (state.scopeStack.length) {
            await finishNestedRecord();
            return;
        }
        const peer = options.getPeer?.();
        if (!isSupportedPeer(peer)) {
            setStatus('当前会话不支持伪造合并转发', 'error');
            return;
        }
        if (!state.messages.length || state.sending) {
            return;
        }
        if (hasPendingForm()) {
            setStatus('请先添加或保存当前消息', 'error');
            return;
        }
        const incompletePath = findIncompleteDraftPath(state.messages);
        if (incompletePath) {
            focusDraftPath(incompletePath);
            setStatus('请先填写这张子合并在当前层显示的发送者 QQ 号', 'error');
            state.fields.senderUin.focus();
            return;
        }
        setSending(true);
        setStatus('正在生成聊天记录');
        try {
            const result = await options.send?.({
                peer,
                messages: state.messages.map(message => ({
                    senderUin: message.senderUin,
                    senderName: message.senderName,
                    segments: normalizeDraftSegments(message),
                    timestamp: message.timestamp
                }))
            });
            if (result?.ok === false) {
                throw new Error(result.reason || '发送失败');
            }
            state.rootMessages = [];
            state.messages = state.rootMessages;
            saveDraft();
            clearForm();
            close(true);
        } catch (error) {
            setStatus(error?.message || '发送失败', 'error');
            options.onError?.(error);
        } finally {
            setSending(false);
        }
    }

    function createField(labelText, input) {
        const field = createElement('label', 'qff-field');
        field.append(createElement('span', 'qff-label', labelText), input);
        return field;
    }

    function ensureStylesheet() {
        if (document.getElementById(STYLE_ID)) {
            return;
        }
        const link = createElement('link');
        link.id = STYLE_ID;
        link.rel = 'stylesheet';
        link.href = new URL('./fake-forward-editor.css', import.meta.url).href;
        document.head.append(link);
    }

    function syncColorScheme() {
        const themeSource = state.root?.querySelector('.qff-dialog') || state.root;
        if (!themeSource || !state.fields.timestampDate || !state.fields.timestampTime) {
            return;
        }
        const scheme = inferColorScheme(getComputedStyle(themeSource).color);
        state.root.style.colorScheme = scheme;
        state.fields.timestampDate.style.colorScheme = scheme;
        state.fields.timestampTime.style.colorScheme = scheme;
    }

    function ensureEditor() {
        if (state.root?.isConnected) {
            return;
        }
        ensureStylesheet();
        const root = createElement('div');
        root.id = ROOT_ID;
        root.hidden = true;
        const dialog = createElement('section', 'qff-dialog');
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');

        const header = createElement('header', 'qff-header');
        const titleGroup = createElement('div', 'qff-title-group');
        state.title = createElement('h2', 'qff-title', '伪造合并转发');
        state.fields.layerPath = createElement('span', 'qff-layer-path', '外层记录');
        state.title.id = 'qqnt-toolbox-fake-forward-title';
        dialog.setAttribute('aria-labelledby', state.title.id);
        titleGroup.append(state.title, state.fields.layerPath);
        const closeButton = createButton('qff-close', '×', '关闭');
        header.append(titleGroup, closeButton);

        const body = createElement('div', 'qff-body qqnt-toolbox-scrollable');
        const listPane = createElement('section', 'qff-list-pane');
        const listHeader = createElement('div', 'qff-list-header');
        const listHeading = createElement('div', 'qff-list-heading');
        state.count = createElement('span', 'qff-count');
        listHeading.append(createElement('span', 'qff-list-title', '当前层'), state.count);
        state.list = createElement('ol', 'qff-list qqnt-toolbox-scrollable');
        const listActions = createElement('div', 'qff-list-actions');
        state.fields.moveUp = createButton('qff-list-action', '↑', '上移');
        state.fields.moveDown = createButton('qff-list-action', '↓', '下移');
        state.fields.remove = createButton('qff-list-action qff-list-delete', '×', '删除');
        listActions.append(state.fields.moveUp, state.fields.moveDown, state.fields.remove);
        listHeader.append(listHeading, listActions);
        const listFooter = createElement('div', 'qff-list-footer');
        state.fields.addNested = createButton(
            'qff-button qff-nested-button',
            '添加子合并',
            '向当前层添加一个子合并'
        );
        listFooter.append(state.fields.addNested);
        listPane.append(listHeader, state.list, listFooter);

        const form = createElement('form', 'qff-form qqnt-toolbox-scrollable');
        const fieldRow = createElement('div', 'qff-field-row');
        state.fields.senderUin = createElement('input', 'qff-input');
        state.fields.senderUin.type = 'text';
        state.fields.senderUin.inputMode = 'numeric';
        state.fields.senderUin.maxLength = 20;
        state.fields.senderUin.autocomplete = 'off';
        state.fields.senderName = createElement('input', 'qff-input');
        state.fields.senderName.type = 'text';
        state.fields.senderName.maxLength = 80;
        state.fields.senderName.autocomplete = 'off';
        const senderUinField = createField('发送者 QQ', state.fields.senderUin);
        const senderNameField = createField('显示昵称', state.fields.senderName);
        state.fields.senderUinLabel = senderUinField.querySelector('.qff-label');
        state.fields.senderNameLabel = senderNameField.querySelector('.qff-label');
        fieldRow.append(senderUinField, senderNameField);
        const timeRow = createElement('div', 'qff-time-row');
        state.fields.timestampDate = createElement('input', 'qff-input');
        state.fields.timestampDate.type = 'date';
        state.fields.timestampDate.required = true;
        state.fields.timestampTime = createElement('input', 'qff-input');
        state.fields.timestampTime.type = 'time';
        state.fields.timestampTime.required = true;
        const dateField = createField('日期', state.fields.timestampDate);
        const clockField = createField('时间', state.fields.timestampTime);
        dateField.classList.add('qff-date-field');
        clockField.classList.add('qff-clock-field');
        timeRow.append(dateField, clockField);
        state.fields.composer = createElement(
            'div',
            'qff-composer qqnt-toolbox-scrollable'
        );
        state.fields.composer.contentEditable = 'true';
        state.fields.composer.spellcheck = false;
        state.fields.composer.setAttribute('role', 'textbox');
        state.fields.composer.setAttribute('aria-label', '消息内容');
        state.fields.composer.setAttribute('aria-multiline', 'true');
        state.fields.filePicker = createElement('input');
        state.fields.filePicker.type = 'file';
        state.fields.filePicker.multiple = true;
        state.fields.filePicker.hidden = true;
        const editorSummary = createElement('div', 'qff-editor-summary');
        state.fields.editorMode = createElement('span', 'qff-editor-mode', '新建普通消息');
        state.fields.editorGuide = createElement(
            'span',
            'qff-editor-guide',
            '填写发送者与内容后加入当前层，或从左侧直接创建子合并。'
        );
        editorSummary.append(state.fields.editorMode, state.fields.editorGuide);
        const composerField = createElement('div', 'qff-field qff-composer-field');
        const composerShell = createElement('div', 'qff-composer-shell');
        const composerToolbar = createElement('div', 'qff-composer-toolbar');
        const addFile = createButton('qff-button qff-file-button', '添加文件', '添加媒体或文件');
        state.fields.addFile = addFile;
        const formActions = createElement('div', 'qff-form-actions');
        state.fields.cancelEdit = createButton('qff-button', '取消编辑');
        state.fields.commit = createButton('qff-button qff-commit', '添加消息');
        state.fields.commit.type = 'submit';
        formActions.append(state.fields.cancelEdit, state.fields.commit);
        const composerInsertActions = createElement('div', 'qff-composer-insert-actions');
        composerInsertActions.append(addFile);
        composerToolbar.append(composerInsertActions, formActions);
        composerShell.append(state.fields.composer);
        state.fields.composerLabel = createElement('span', 'qff-label', '消息内容');
        composerField.append(
            state.fields.composerLabel,
            composerShell,
            composerToolbar,
            state.fields.filePicker
        );
        form.append(
            editorSummary,
            fieldRow,
            timeRow,
            composerField
        );
        body.append(listPane, form);

        const footer = createElement('footer', 'qff-footer');
        state.status = createElement('span', 'qff-status');
        state.status.setAttribute('aria-live', 'polite');
        const footerActions = createElement('div', 'qff-footer-actions');
        state.fields.footerCancel = createButton('qff-button', '取消');
        state.sendButton = createButton('qff-button qff-primary', '发送');
        footerActions.append(state.fields.footerCancel, state.sendButton);
        footer.append(state.status, footerActions);
        dialog.append(header, body, footer);
        root.append(dialog);
        document.body.append(root);
        state.root = root;

        closeButton.addEventListener('click', () => close());
        state.fields.footerCancel.addEventListener('click', () => {
            if (state.scopeStack.length) {
                cancelNestedRecord();
            } else {
                close();
            }
        });
        form.addEventListener('submit', event => {
            event.preventDefault();
            commitForm().catch(error => setStatus(error?.message || '保存失败', 'error'));
        });
        state.fields.cancelEdit.addEventListener('click', () => {
            clearForm();
            saveDraft();
        });
        state.fields.composer.addEventListener('paste', handleComposerPaste);
        state.fields.composer.addEventListener('keydown', handleComposerKeydown);
        state.fields.composer.addEventListener('dragover', event => {
            if (state.draggedImage || Array.from(event.dataTransfer?.types || []).includes('Files')) {
                event.preventDefault();
                event.dataTransfer.dropEffect = state.draggedImage ? 'move' : 'copy';
            }
        });
        state.fields.composer.addEventListener('drop', handleComposerDrop);
        addFile.addEventListener('click', () => state.fields.filePicker.click());
        state.fields.addNested.addEventListener('click', () => enterNestedRecord());
        state.fields.filePicker.addEventListener('change', () => {
            insertComposerFiles(Array.from(state.fields.filePicker.files || []));
            state.fields.filePicker.value = '';
        });
        state.fields.moveUp.addEventListener('click', () => moveSelected(-1));
        state.fields.moveDown.addEventListener('click', () => moveSelected(1));
        state.fields.remove.addEventListener('click', removeSelected);
        state.sendButton.addEventListener('click', () => {
            if (state.scopeStack.length) {
                finishNestedRecord().catch(error =>
                    setStatus(error?.message || '保存嵌套记录失败', 'error')
                );
            } else {
                send().catch(error => setStatus(error?.message || '发送失败', 'error'));
            }
        });
        syncScopeUi();
    }

    function open() {
        if (!options.getEnabled?.() || !isSupportedPeer(options.getPeer?.())) {
            return;
        }
        ensureEditor();
        state.forwardSegments.clear();
        const session = loadDraft();
        if (!restoreDraftSession(session)) {
            clearForm();
            syncScopeUi();
        }
        state.previousOverflow = document.body.style.overflow;
        state.root.hidden = false;
        syncColorScheme();
        requestAnimationFrame(() => {
            if (state.root && !state.root.hidden) {
                syncColorScheme();
            }
        });
        document.body.style.overflow = 'hidden';
        state.fields.senderUin.focus();
    }

    function removeEntries() {
        document.querySelectorAll('.' + ENTRY_CLASS).forEach(element => element.remove());
    }

    function connectObserver() {
        if (state.observer) {
            return;
        }
        state.observer = new MutationObserver(scheduleSync);
        state.observer.observe(document.body, { childList: true, subtree: true });
    }

    function disconnectObserver() {
        state.observer?.disconnect();
        state.observer = null;
    }

    function sync() {
        const enabled = options.getEnabled?.() === true;
        if (!enabled) {
            disconnectObserver();
            removeEntries();
            close();
            return;
        }
        ensureStylesheet();
        connectObserver();
        const toolbar = findNativeChatToolbar();
        const available = isSupportedPeer(options.getPeer?.()) &&
            Boolean(toolbar);
        if (!available) {
            removeEntries();
            close();
            return;
        }
        if (toolbar.querySelector(':scope > .' + ENTRY_CLASS)) {
            return;
        }
        removeEntries();
        const entry = createNativeChatToolbarEntry(toolbar, {
            className: ENTRY_CLASS,
            label: '伪造转发',
            renderIcon: applyEntryGlyph
        });
        if (!entry) {
            return;
        }
        bindNativeChatToolbarAction(entry, open);
        toolbar.append(entry);
    }

    function scheduleSync() {
        if (state.refreshFrame) {
            return;
        }
        state.refreshFrame = requestAnimationFrame(() => {
            state.refreshFrame = 0;
            sync();
        });
    }

    function handleKeydown(event) {
        if (event.key === 'Escape' && state.root && !state.root.hidden &&
            state.root.isConnected && state.root.getClientRects().length > 0) {
            event.preventDefault();
            event.stopPropagation();
            if (state.scopeStack.length) {
                cancelNestedRecord();
            } else {
                close();
            }
        }
    }

    function install() {
        if (state.installed) {
            return;
        }
        state.installed = true;
        document.addEventListener('keydown', handleKeydown, true);
        window.addEventListener('hashchange', scheduleSync);
        sync();
    }

    function destroy() {
        if (state.root?.isConnected) {
            saveDraft();
        }
        disconnectObserver();
        if (state.refreshFrame) {
            cancelAnimationFrame(state.refreshFrame);
        }
        document.removeEventListener('keydown', handleKeydown, true);
        window.removeEventListener('hashchange', scheduleSync);
        removeEntries();
        for (const url of state.objectUrls) {
            URL.revokeObjectURL(url);
        }
        state.objectUrls.clear();
        state.forwardSegments.clear();
        state.root?.remove();
        state.root = null;
        state.installed = false;
    }

    return { destroy, install, open, sync };
}
