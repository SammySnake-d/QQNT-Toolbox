import {
    bindNativeChatToolbarAction,
    createNativeChatToolbarEntry,
    findNativeChatToolbar
} from './chat-toolbar-entry.js';

const ROOT_ID = 'qqnt-toolbox-message-packet-editor';
const RESULT_ROOT_ID = 'qqnt-toolbox-message-packet-result';
const STYLE_ID = 'qqnt-toolbox-message-packet-style';
const ENTRY_CLASS = 'qqnt-toolbox-message-packet-entry';
const FAKE_FORWARD_ENTRY_CLASS = 'qqnt-toolbox-fake-forward-entry';
const TYPE_OPTIONS = [
    { value: 'element', label: '元素' },
    { value: 'ark', label: 'Ark' },
    { value: 'xml', label: 'XML' },
    { value: 'text', label: '文本' }
];
const METHOD_OPTIONS = [
    { value: 'direct', label: '直接' },
    { value: 'longmsg', label: '长消息' },
    { value: 'forward', label: '转发' }
];
const RESULT_OPTIONS = [
    { value: 'pb', label: 'PB' },
    { value: 'elements', label: 'PB(elem)' },
    { value: 'msgRecord', label: 'MsgRecord' }
];
const CONTENT_DEFAULTS = {
    element: '{\n  "1": {\n    "1": "Hello"\n  }\n}',
    ark: '{}',
    xml: '<?xml version="1.0" encoding="utf-8"?>\n<msg serviceID="35" brief="[XML消息]"></msg>',
    text: ''
};

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

function createButton(className, label, ariaLabel = '') {
    const button = createElement('button', className, label);
    button.type = 'button';
    if (ariaLabel) {
        button.setAttribute('aria-label', ariaLabel);
        button.title = ariaLabel;
    }
    return button;
}

function createInput(label, name, placeholder = '') {
    const field = createElement('label', 'qpacket-compact-field');
    field.append(createElement('span', 'qpacket-compact-label', label));
    const input = createElement('input', 'qpacket-input');
    input.name = name;
    input.placeholder = placeholder;
    input.autocomplete = 'off';
    field.append(input);
    return { field, input };
}

function createSegmented(options, value, onChange) {
    const root = createElement('div', 'qpacket-segmented');
    root.setAttribute('role', 'tablist');
    const buttons = new Map();
    for (const option of options) {
        const button = createButton('qpacket-segment', option.label);
        button.dataset.value = option.value;
        button.setAttribute('role', 'tab');
        button.addEventListener('click', () => onChange(option.value));
        root.append(button);
        buttons.set(option.value, button);
    }
    const select = nextValue => {
        for (const [optionValue, button] of buttons) {
            const selected = optionValue === nextValue;
            button.dataset.selected = String(selected);
            button.setAttribute('aria-selected', String(selected));
        }
    };
    select(value);
    return { root, select, buttons };
}

function applyEntryGlyph(svg) {
    const namespace = 'http://www.w3.org/2000/svg';
    svg.replaceChildren();
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('aria-hidden', 'true');
    const paths = [
        ['m9 18-6-6 6-6', 'round'],
        ['m15 6 6 6-6 6', 'round'],
        ['m14 4-4 16', 'round']
    ];
    for (const [data, linecap] of paths) {
        const path = document.createElementNS(namespace, 'path');
        path.setAttribute('d', data);
        path.setAttribute('stroke', 'currentColor');
        path.setAttribute('stroke-width', '1.6');
        path.setAttribute('stroke-linecap', linecap);
        path.setAttribute('stroke-linejoin', 'round');
        svg.append(path);
    }
}

export function isSupportedMessagePacketPeer(peer) {
    return [1, 2].includes(Number(peer?.chatType)) && Boolean(String(peer?.peerUid || '').trim());
}

function toSerializable(value, seen) {
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
        return value;
    }
    if (typeof value === 'bigint') {
        return value.toString();
    }
    if (typeof value === 'undefined') {
        return null;
    }
    if (value instanceof Uint8Array) {
        return `hex->${Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('')}`;
    }
    if (value instanceof Date) {
        return value.toISOString();
    }
    if (!value || typeof value !== 'object') {
        return String(value);
    }
    if (seen.has(value)) {
        return '[Circular]';
    }
    seen.add(value);
    if (Array.isArray(value)) {
        const result = value.map(item => toSerializable(item, seen));
        seen.delete(value);
        return result;
    }
    if (value instanceof Map) {
        const result = {};
        for (const [key, child] of value) {
            result[String(key)] = toSerializable(child, seen);
        }
        seen.delete(value);
        return result;
    }
    const result = {};
    for (const key of Object.getOwnPropertyNames(value)) {
        try {
            const child = value[key];
            if (typeof child !== 'function') {
                result[key] = toSerializable(child, seen);
            }
        } catch {
            result[key] = '[Unavailable]';
        }
    }
    seen.delete(value);
    return result;
}

export function serializeMessageRecord(record) {
    return JSON.stringify(toSerializable(record, new WeakSet()), null, 2);
}

function createPullRecord(record) {
    const peer = record?.peer && typeof record.peer === 'object' ? record.peer : {};
    return {
        chatType: Number(record?.chatType || peer.chatType) || 0,
        peerUid: String(record?.peerUid || peer.peerUid || ''),
        peerUin: String(record?.peerUin || peer.peerUin || ''),
        msgSeq: Number(record?.msgSeq),
        msgTime: Number(record?.msgTime),
        msgId: String(record?.msgId || '')
    };
}

function parseJsonContent(value, type) {
    let parsed;
    try {
        parsed = JSON.parse(String(value || '').trim());
    } catch {
        throw new Error(type === 'ark' ? 'Ark JSON 格式错误' : '元素 JSON 格式错误');
    }
    if (type === 'ark' && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))) {
        throw new Error('Ark JSON 顶层必须是对象');
    }
    if (type === 'element' && (!parsed || typeof parsed !== 'object')) {
        throw new Error('元素 JSON 顶层必须是对象或数组');
    }
    return parsed;
}

export function createMessagePacketEditor(options = {}) {
    const state = {
        installed: false,
        observer: null,
        refreshFrame: 0,
        root: null,
        resultRoot: null,
        textarea: null,
        editorLabel: null,
        methodRow: null,
        forwardFields: null,
        status: null,
        formatButton: null,
        sendButton: null,
        typeControl: null,
        methodControl: null,
        resultControl: null,
        resultTextarea: null,
        resultStatus: null,
        sending: false,
        pulling: false,
        type: 'element',
        method: 'direct',
        resultType: 'pb',
        contents: { ...CONTENT_DEFAULTS },
        resultViews: { pb: '', elements: '', msgRecord: '' },
        previousOverflow: ''
    };

    function ensureStylesheet() {
        if (document.getElementById(STYLE_ID)) {
            return;
        }
        const link = createElement('link');
        link.id = STYLE_ID;
        link.rel = 'stylesheet';
        link.href = new URL('./message-packet-editor.css', import.meta.url).href;
        document.head.append(link);
    }

    function setStatus(message = '', kind = '') {
        if (!state.status) {
            return;
        }
        state.status.textContent = message;
        state.status.title = message;
        state.status.dataset.kind = kind;
    }

    function setResultStatus(message = '', kind = '') {
        if (!state.resultStatus) {
            return;
        }
        state.resultStatus.textContent = message;
        state.resultStatus.dataset.kind = kind;
    }

    function setSending(sending) {
        state.sending = sending;
        state.root?.querySelectorAll('button,input,textarea').forEach(control => {
            control.disabled = sending;
        });
        if (state.sendButton) {
            state.sendButton.textContent = sending ? '发送中' : '发送';
        }
    }

    function closeSender(force = false) {
        if (!state.root || state.root.hidden || (state.sending && !force)) {
            return;
        }
        state.root.hidden = true;
        if (!state.resultRoot || state.resultRoot.hidden) {
            document.body.style.overflow = state.previousOverflow;
        }
    }

    function closeResult() {
        if (!state.resultRoot || state.resultRoot.hidden || state.pulling) {
            return;
        }
        state.resultRoot.hidden = true;
        if (!state.root || state.root.hidden) {
            document.body.style.overflow = state.previousOverflow;
        }
    }

    function updateModeUi() {
        state.typeControl?.select(state.type);
        state.methodControl?.select(state.method);
        if (state.textarea) {
            state.textarea.value = state.contents[state.type];
            state.textarea.placeholder = state.type === 'text' ? '输入消息文本' : '';
            state.textarea.setSelectionRange(0, 0);
            state.textarea.scrollTop = 0;
            state.textarea.scrollLeft = 0;
        }
        if (state.editorLabel) {
            state.editorLabel.textContent = {
                element: '数字字段 JSON',
                ark: 'Ark JSON',
                xml: 'XML',
                text: '消息文本'
            }[state.type];
        }
        if (state.methodRow) {
            state.methodRow.hidden = state.type !== 'element';
        }
        if (state.forwardFields) {
            state.forwardFields.hidden = state.type !== 'element' || state.method !== 'forward';
        }
        if (state.formatButton) {
            state.formatButton.hidden = !['element', 'ark'].includes(state.type);
        }
    }

    function changeType(type) {
        if (state.sending || state.type === type) {
            return;
        }
        state.contents[state.type] = state.textarea?.value ?? state.contents[state.type];
        state.type = type;
        setStatus();
        updateModeUi();
        state.textarea?.focus();
    }

    function changeMethod(method) {
        if (state.sending) {
            return;
        }
        state.method = method;
        setStatus();
        updateModeUi();
    }

    function formatJson() {
        try {
            const parsed = parseJsonContent(state.textarea?.value, state.type);
            state.textarea.value = JSON.stringify(parsed, null, 2);
            state.contents[state.type] = state.textarea.value;
            setStatus('JSON 已格式化', 'success');
        } catch (error) {
            setStatus(error?.message || 'JSON 格式错误', 'error');
            state.textarea?.focus();
        }
    }

    async function send() {
        if (state.sending) {
            return;
        }
        try {
            const peer = options.getPeer?.();
            if (!isSupportedMessagePacketPeer(peer)) {
                throw new Error('当前会话不支持消息工具');
            }
            const content = String(state.textarea?.value || '').trim();
            if (!content) {
                throw new Error('请输入消息内容');
            }
            if (['element', 'ark'].includes(state.type)) {
                parseJsonContent(content, state.type);
            }
            state.contents[state.type] = content;
            const form = state.root.querySelector('.qpacket-forward-fields');
            setSending(true);
            setStatus('正在发送');
            const result = await options.send?.({
                peer,
                selfUin: options.getSelfUin?.() || '',
                type: state.type,
                method: state.type === 'element' ? state.method : undefined,
                content,
                forward: {
                    senderUin: form?.elements.senderUin?.value || options.getSelfUin?.() || '',
                    nickname: form?.elements.nickname?.value || '',
                    prompt: form?.elements.prompt?.value || '',
                    description: form?.elements.description?.value || '',
                    xml: form?.elements.xmlForward?.checked === true
                }
            });
            if (!result?.ok) {
                throw new Error(result?.message || '消息发送失败');
            }
            setStatus('发送成功', 'success');
        } catch (error) {
            setStatus(error?.message || '消息发送失败', 'error');
            options.onError?.(error);
        } finally {
            setSending(false);
        }
    }

    function ensureSender() {
        if (state.root?.isConnected) {
            return;
        }
        ensureStylesheet();
        const root = createElement('div');
        root.id = ROOT_ID;
        root.hidden = true;
        const dialog = createElement('form', 'qpacket-dialog');
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');

        const header = createElement('header', 'qpacket-header');
        header.append(
            createElement('h2', 'qpacket-title', '消息工具'),
            createButton('qpacket-close', '×', '关闭')
        );

        const body = createElement('div', 'qpacket-body');
        const typeControl = createSegmented(TYPE_OPTIONS, state.type, changeType);
        body.append(typeControl.root);

        const methodRow = createElement('div', 'qpacket-method-row');
        methodRow.append(createElement('span', 'qpacket-row-label', '发送方式'));
        const methodControl = createSegmented(METHOD_OPTIONS, state.method, changeMethod);
        methodRow.append(methodControl.root);
        body.append(methodRow);

        const forwardFields = createElement('fieldset', 'qpacket-forward-fields');
        const sender = createInput('发送者 QQ', 'senderUin', 'QQ 号');
        const nickname = createInput('昵称', 'nickname', '可选');
        const prompt = createInput('外显', 'prompt', '[聊天记录]');
        const description = createInput('描述', 'description', '查看1条转发消息');
        const xmlLabel = createElement('label', 'qpacket-check-field');
        const xmlCheck = createElement('input');
        xmlCheck.type = 'checkbox';
        xmlCheck.name = 'xmlForward';
        xmlLabel.append(xmlCheck, createElement('span', '', 'XML 卡片'));
        forwardFields.append(sender.field, nickname.field, prompt.field, description.field, xmlLabel);
        body.append(forwardFields);

        const editorField = createElement('label', 'qpacket-editor-field');
        const editorLabel = createElement('span', 'qpacket-editor-label');
        const textarea = createElement('textarea', 'qpacket-editor');
        textarea.spellcheck = false;
        textarea.autocomplete = 'off';
        textarea.autocapitalize = 'off';
        editorField.append(editorLabel, textarea);
        body.append(editorField);

        const footer = createElement('footer', 'qpacket-footer');
        const status = createElement('div', 'qpacket-status');
        status.setAttribute('role', 'status');
        const actions = createElement('div', 'qpacket-actions');
        const formatButton = createButton('qpacket-button qpacket-secondary', '格式化');
        const sendButton = createButton('qpacket-button qpacket-primary', '发送');
        sendButton.type = 'submit';
        actions.append(formatButton, sendButton);
        footer.append(status, actions);

        dialog.append(header, body, footer);
        root.append(dialog);
        document.body.append(root);

        state.root = root;
        state.textarea = textarea;
        state.editorLabel = editorLabel;
        state.methodRow = methodRow;
        state.forwardFields = forwardFields;
        state.status = status;
        state.formatButton = formatButton;
        state.sendButton = sendButton;
        state.typeControl = typeControl;
        state.methodControl = methodControl;

        header.querySelector('.qpacket-close').addEventListener('click', () => closeSender());
        formatButton.addEventListener('click', formatJson);
        textarea.addEventListener('input', () => setStatus());
        dialog.addEventListener('submit', event => {
            event.preventDefault();
            send();
        });
        root.addEventListener('pointerdown', event => {
            if (event.target === root) {
                closeSender();
            }
        });
        updateModeUi();
    }

    function showResultType(type) {
        state.resultType = type;
        state.resultControl?.select(type);
        if (state.resultTextarea) {
            state.resultTextarea.value = state.resultViews[type] || '';
        }
    }

    function ensureResult() {
        if (state.resultRoot?.isConnected) {
            return;
        }
        ensureStylesheet();
        const root = createElement('div');
        root.id = RESULT_ROOT_ID;
        root.hidden = true;
        const dialog = createElement('section', 'qpacket-dialog qpacket-result-dialog');
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        const header = createElement('header', 'qpacket-header');
        header.append(
            createElement('h2', 'qpacket-title', '消息拉取'),
            createButton('qpacket-close', '×', '关闭')
        );
        const body = createElement('div', 'qpacket-result-body');
        const resultControl = createSegmented(RESULT_OPTIONS, state.resultType, showResultType);
        const textarea = createElement('textarea', 'qpacket-editor qpacket-result-editor');
        textarea.readOnly = true;
        textarea.spellcheck = false;
        body.append(resultControl.root, textarea);
        const footer = createElement('footer', 'qpacket-footer');
        const status = createElement('div', 'qpacket-status');
        status.setAttribute('role', 'status');
        const copyButton = createButton('qpacket-button qpacket-primary', '复制全部');
        footer.append(status, copyButton);
        dialog.append(header, body, footer);
        root.append(dialog);
        document.body.append(root);

        state.resultRoot = root;
        state.resultControl = resultControl;
        state.resultTextarea = textarea;
        state.resultStatus = status;
        header.querySelector('.qpacket-close').addEventListener('click', closeResult);
        copyButton.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(state.resultTextarea.value);
                setResultStatus('已复制', 'success');
            } catch {
                setResultStatus('复制失败', 'error');
            }
        });
        root.addEventListener('pointerdown', event => {
            if (event.target === root) {
                closeResult();
            }
        });
    }

    function open() {
        if (!options.getEnabled?.() || !isSupportedMessagePacketPeer(options.getPeer?.())) {
            return;
        }
        ensureSender();
        state.previousOverflow = document.body.style.overflow;
        state.root.hidden = false;
        document.body.style.overflow = 'hidden';
        const senderInput = state.forwardFields?.querySelector('[name="senderUin"]');
        if (senderInput && !senderInput.value) {
            senderInput.value = options.getSelfUin?.() || '';
        }
        setStatus();
        requestAnimationFrame(() => state.textarea?.focus());
    }

    async function pull(record) {
        if (state.pulling || !options.getEnabled?.()) {
            return;
        }
        ensureResult();
        state.previousOverflow = document.body.style.overflow;
        state.resultRoot.hidden = false;
        document.body.style.overflow = 'hidden';
        state.pulling = true;
        state.resultRoot.querySelectorAll('button').forEach(button => {
            button.disabled = true;
        });
        state.resultViews = { pb: '正在拉取...', elements: '正在拉取...', msgRecord: '正在拉取...' };
        showResultType('pb');
        setResultStatus('正在拉取');
        try {
            const result = await options.pull?.({
                record: createPullRecord(record),
                msgRecord: serializeMessageRecord(record)
            });
            if (!result?.ok || !result.views) {
                throw new Error(result?.message || '消息拉取失败');
            }
            state.resultViews = result.views;
            showResultType('pb');
            setResultStatus('拉取完成', 'success');
        } catch (error) {
            state.resultViews = {
                pb: error?.message || '消息拉取失败',
                elements: '',
                msgRecord: serializeMessageRecord(record)
            };
            showResultType('pb');
            setResultStatus(error?.message || '消息拉取失败', 'error');
            options.onError?.(error);
        } finally {
            state.pulling = false;
            state.resultRoot.querySelectorAll('button').forEach(button => {
                button.disabled = false;
            });
        }
    }

    function removeEntries() {
        document.querySelectorAll('.' + ENTRY_CLASS).forEach(element => element.remove());
    }

    function placeEntry(toolbar, entry) {
        const fakeForwardEntry = toolbar.querySelector(':scope > .' + FAKE_FORWARD_ENTRY_CLASS);
        if (fakeForwardEntry) {
            if (fakeForwardEntry.nextElementSibling !== entry) {
                fakeForwardEntry.after(entry);
            }
        } else if (entry.parentElement !== toolbar) {
            toolbar.append(entry);
        }
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
        if (options.getEnabled?.() !== true) {
            disconnectObserver();
            removeEntries();
            closeSender(true);
            if (state.resultRoot && !state.resultRoot.hidden && !state.pulling) {
                closeResult();
            }
            return;
        }
        ensureStylesheet();
        connectObserver();
        const toolbar = findNativeChatToolbar();
        if (!toolbar || !isSupportedMessagePacketPeer(options.getPeer?.())) {
            removeEntries();
            closeSender(true);
            return;
        }
        let entry = toolbar.querySelector(':scope > .' + ENTRY_CLASS);
        if (!entry) {
            removeEntries();
            entry = createNativeChatToolbarEntry(toolbar, {
                className: ENTRY_CLASS,
                label: '消息工具',
                renderIcon: applyEntryGlyph
            });
            if (!entry) {
                return;
            }
            bindNativeChatToolbarAction(entry, open);
        }
        placeEntry(toolbar, entry);
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
        if (event.key !== 'Escape') {
            return;
        }
        if (state.resultRoot && !state.resultRoot.hidden) {
            event.preventDefault();
            event.stopPropagation();
            closeResult();
        } else if (state.root && !state.root.hidden) {
            event.preventDefault();
            event.stopPropagation();
            closeSender();
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
        disconnectObserver();
        if (state.refreshFrame) {
            cancelAnimationFrame(state.refreshFrame);
        }
        document.removeEventListener('keydown', handleKeydown, true);
        window.removeEventListener('hashchange', scheduleSync);
        removeEntries();
        closeSender(true);
        state.root?.remove();
        state.resultRoot?.remove();
        document.body.style.overflow = state.previousOverflow;
        state.root = null;
        state.resultRoot = null;
        state.installed = false;
    }

    return { destroy, install, open, pull, sync };
}
