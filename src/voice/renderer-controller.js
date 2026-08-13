'use strict';

function injectedVoiceFileSenderUi(voiceLibraryPanelFactory, voiceLibraryPanelCss) {
    const VOICE_TEXTS = [
        '\u5f00\u59cb\u8bf4\u8bdd',
        '\u6309\u4f4f\u8bf4\u8bdd',
        '\u6309\u4f4f\u7a7a\u683c\u952e',
        '\u6309Esc\u952e',
        '\u70b9\u51fb\u9000\u51fa',
        '\u677e\u5f00\u53d1\u9001'
    ];
    const VOICE_SELECTORS = [
        '.audio-msg-input',
        '[class*="audio-msg-input"]',
        '[class*="record-panel"]',
        '[class*="recordPanel"]',
        '[class*="ptt-panel"]',
        '[class*="pttPanel"]'
    ];
    const MEDIA_EXTENSIONS = new Set([
        '.3g2', '.3gp', '.aac', '.amr', '.asf', '.avi', '.audio', '.flac', '.flv', '.m2ts', '.m4a', '.m4v', '.mkv',
        '.mov', '.mp3', '.mp4', '.mpeg', '.mpg', '.ogg', '.ogv', '.opus', '.ts', '.wav', '.weba', '.webm', '.wmv'
    ]);
    const PTT_BUBBLE_SELECTOR = '.ptt-element, .ptt-message__container';
    let libraryPanel = null;

    function getBridge() {
        window.__voiceFileSenderBridge = window.__voiceFileSenderBridge || {};
        const bridge = window.__voiceFileSenderBridge;
        bridge.queue = bridge.queue || [];
        return bridge;
    }

    function isVoiceFeatureEnabled() {
        return getBridge().enabled === true;
    }

    function shouldKeepVoicePlayingAcrossChats() {
        return getBridge().keepPlayingAcrossChats === true;
    }

    function isVoiceSaveInContextMenuEnabled() {
        const bridge = getBridge();
        return bridge.enabled === true && bridge.saveInContextMenu === true;
    }

    function isVoiceForwardInContextMenuEnabled() {
        const bridge = getBridge();
        return bridge.enabled === true && bridge.forwardInContextMenu === true;
    }

    function getByPath(object, path) {
        return path.split('.').reduce((value, key) => value?.[key], object);
    }

    function findVueValue(element, path) {
        const instances = element?.__VUE__;
        if (!instances?.length) {
            return undefined;
        }
        for (const instance of new Set(instances)) {
            const value = getByPath(instance, path);
            if (value !== undefined) {
                return value;
            }
        }
        return undefined;
    }

    function getCurrentAioData() {
        return findVueValue(document.querySelector('.aio.vue-component'), 'proxy.commonAioStore.curAioData') ||
            findVueValue(document.querySelector('.aio'), 'proxy.commonAioStore.curAioData') ||
            getByPath(globalThis, 'app.__vue_app__.config.globalProperties.$store.state.common_Aio.curAioData');
    }

    function firstNonEmpty(values) {
        return values.find(value => value !== undefined && value !== null && String(value).trim());
    }

    function normalizePeerId(value) {
        const text = String(value ?? '').trim();
        if (!text || text === 'undefined' || text === 'null' || text === '0') {
            return '';
        }
        return text;
    }

    function pickPeerId(values) {
        return normalizePeerId(firstNonEmpty(values));
    }

    function normalizePeerFromAioData(aioData) {
        if (!aioData || typeof aioData !== 'object') {
            return null;
        }
        const header = aioData.header || {};
        const chatType = Number(firstNonEmpty([
            aioData.chatType,
            aioData.type,
            header.chatType,
            aioData.aioType,
            header.type
        ]));
        const isGroup = chatType === 2;
        const isC2c = chatType === 1 || chatType === 100;
        const peerUin = pickPeerId([
            aioData.peerUin,
            header.peerUin,
            aioData.chatUin,
            header.chatUin,
            aioData.uin,
            header.uin,
            aioData.userUin,
            header.userUin,
            aioData.contactUin,
            header.contactUin,
            aioData.targetUin,
            header.targetUin
        ]);
        const peerUid = isGroup
            ? pickPeerId([
                aioData.peerUid,
                header.peerUid,
                aioData.groupCode,
                header.groupCode,
                aioData.groupId,
                header.groupId,
                aioData.peerUin,
                header.peerUin,
                aioData.chatUin,
                header.chatUin,
                aioData.uin,
                header.uin
            ])
            : pickPeerId([
                aioData.peerUid,
                header.peerUid,
                aioData.peer?.peerUid,
                header.peer?.peerUid,
                aioData.peer?.uid,
                header.peer?.uid,
                aioData.peer?.ntUid,
                header.peer?.ntUid,
                aioData.contact?.peerUid,
                header.contact?.peerUid,
                aioData.contact?.uid,
                header.contact?.uid,
                aioData.contact?.ntUid,
                header.contact?.ntUid,
                aioData.buddy?.peerUid,
                header.buddy?.peerUid,
                aioData.buddy?.uid,
                header.buddy?.uid,
                aioData.friend?.peerUid,
                header.friend?.peerUid,
                aioData.friend?.uid,
                header.friend?.uid,
                aioData.target?.peerUid,
                header.target?.peerUid,
                aioData.target?.uid,
                header.target?.uid,
                aioData.uid,
                header.uid,
                aioData.contactUid,
                header.contactUid,
                aioData.userUid,
                header.userUid,
                aioData.targetUid,
                header.targetUid,
                aioData.friendUid,
                header.friendUid,
                aioData.peerUin,
                header.peerUin,
                aioData.chatUin,
                header.chatUin,
                aioData.uin,
                header.uin
            ]);
        if (!chatType || !peerUid || (isC2c && peerUid === 'self')) {
            return null;
        }
        return {
            chatType,
            peerUid,
            peerUin,
            guildId: String(aioData?.guildId || header.guildId || '')
        };
    }

    function getVueInstances(element) {
        if (!(element instanceof Element)) {
            return [];
        }
        const result = [];
        if (Array.isArray(element.__VUE__)) {
            result.push(...element.__VUE__);
        }
        if (element.__vueParentComponent) {
            result.push(element.__vueParentComponent);
        }
        return Array.from(new Set(result.filter(Boolean)));
    }

    function isMsgRecord(value) {
        return Boolean(value && typeof value === 'object' && (value.msgId || value.msgSeq) && Array.isArray(value.elements));
    }

    function getCurrentPeerFromAioComponents() {
        const roots = Array.from(document.querySelectorAll('.aio.vue-component, .aio')).slice(0, 4);
        for (const root of roots) {
            for (const instance of getVueInstances(root)) {
                for (const source of [
                    instance.props,
                    instance.proxy,
                    instance.ctx,
                    instance.setupState,
                    instance.proxy?.commonAioStore?.curAioData,
                    instance.ctx?.commonAioStore?.curAioData,
                    instance.proxy?.aioStore?.curAioData,
                    instance.ctx?.aioStore?.curAioData
                ]) {
                    const peer = normalizePeerFromAioData(source);
                    if (peer) {
                        return peer;
                    }
                }
            }
        }
        return null;
    }

    function getCurrentPeer() {
        return normalizePeerFromAioData(getCurrentAioData()) || getCurrentPeerFromAioComponents();
    }

    function getCurrentPeerSignature() {
        const peer = getCurrentPeer();
        if (!peer) {
            return '';
        }
        return [
            Number(peer.chatType) || 0,
            normalizePeerId(peer.peerUid || peer.peerUin),
            normalizePeerId(peer.guildId)
        ].join(':');
    }

    function compactText(element) {
        return String(element?.innerText || element?.textContent || '').replace(/\s+/g, '');
    }

    function isVoicePanelOpen() {
        const text = compactText(document.body);
        return VOICE_TEXTS.some(item => text.includes(item.replace(/\s+/g, '')));
    }

    function isVisible(element) {
        const rect = element?.getBoundingClientRect?.();
        if (!rect || rect.width <= 0 || rect.height <= 0) {
            return false;
        }
        const style = getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) !== 0;
    }

    function hasVoicePanelText(element) {
        const text = compactText(element);
        return VOICE_TEXTS.some(item => text.includes(item.replace(/\s+/g, '')));
    }

    function findVoicePanelFrom(element) {
        if (!isVoicePanelOpen()) {
            return null;
        }
        let current = element;
        for (let depth = 0; current && current !== document.documentElement && depth < 12; depth += 1) {
            if (VOICE_SELECTORS.some(selector => current.matches?.(selector)) && isVisible(current) && hasVoicePanelText(current)) {
                return current;
            }
            const rect = current.getBoundingClientRect?.();
            const compactEnough = rect && rect.width > 0 && rect.height > 0 && rect.width <= 1200 && rect.height <= 760;
            if (compactEnough && hasVoicePanelText(current)) {
                return current;
            }
            current = current.parentElement;
        }
        return null;
    }

    function findVoicePanel() {
        if (!isVoicePanelOpen()) {
            return null;
        }
        const selectorTarget = document.querySelector('.audio-msg-input');
        if (selectorTarget && isVisible(selectorTarget) && hasVoicePanelText(selectorTarget)) {
            return selectorTarget;
        }
        const candidates = Array.from(document.querySelectorAll('div, section, main')).filter(element => {
            const rect = element.getBoundingClientRect?.();
            if (!rect || rect.width < 260 || rect.height < 90 || rect.width > 1300 || rect.height > 780) {
                return false;
            }
            return isVisible(element) && hasVoicePanelText(element);
        });
        candidates.sort((a, b) => {
            const aRect = a.getBoundingClientRect();
            const bRect = b.getBoundingClientRect();
            return (aRect.width * aRect.height) - (bRect.width * bRect.height);
        });
        return candidates[0] || null;
    }

    function getVoiceDropTarget(event) {
        const activePanel = findVoicePanel();
        if (!activePanel) {
            return null;
        }
        const targets = [];
        if (event?.target instanceof Element) {
            targets.push(event.target);
        }
        const pointTarget = document.elementFromPoint?.(event.clientX, event.clientY);
        if (pointTarget) {
            targets.push(pointTarget);
        }
        for (const target of targets) {
            const panel = findVoicePanelFrom(target);
            if (panel && (panel === activePanel || activePanel.contains(panel) || panel.contains(activePanel))) {
                return panel;
            }
        }
        return null;
    }

    function isMediaPath(filePath) {
        const name = String(filePath || '').toLowerCase();
        const index = name.lastIndexOf('.');
        return index >= 0 && MEDIA_EXTENSIONS.has(name.slice(index));
    }

    function getDropMediaPaths(dataTransfer) {
        return Array.from(dataTransfer?.files || [])
            .map(file => file.path)
            .filter(filePath => filePath && isMediaPath(filePath));
    }

    function isLikelySidebarElement(element) {
        const text = [
            element.id || '',
            String(element.className || ''),
            element.getAttribute?.('role') || '',
            element.getAttribute?.('aria-label') || ''
        ].join(' ');
        return /side|sidebar|right|member|notice|announcement|profile|detail|drawer|contact/i.test(text);
    }

    function getLibraryHostScore(element, trigger) {
        const rect = element.getBoundingClientRect?.();
        if (!rect || rect.width < 360 || rect.height < 260 || !isVisible(element) || isLikelySidebarElement(element)) {
            return Infinity;
        }
        const text = [
            element.id || '',
            String(element.className || ''),
            element.getAttribute?.('role') || ''
        ].join(' ');
        let score = rect.width * rect.height;
        if (/chat|aio|message|conversation|main|content|panel/i.test(text)) {
            score -= 100000;
        }
        if (/input|editor|toolbar|operation/i.test(text)) {
            score += 1000000;
        }
        if (trigger && !element.contains(trigger)) {
            score += 1000000;
        }
        return score;
    }

    function pickLibraryHost(candidates, trigger = null) {
        return candidates
            .filter(Boolean)
            .map(element => ({
                element,
                score: getLibraryHostScore(element, trigger)
            }))
            .filter(item => Number.isFinite(item.score))
            .sort((a, b) => a.score - b.score)[0]?.element || null;
    }

    function findLibraryHostFromTrigger(trigger) {
        if (!(trigger instanceof Element)) {
            return null;
        }
        const candidates = [];
        let current = trigger;
        for (let depth = 0; current && current !== document.documentElement && depth < 18; depth += 1) {
            candidates.push(current);
            current = current.parentElement;
        }
        return pickLibraryHost(candidates, trigger);
    }

    function findLibraryHost() {
        const bridge = getBridge();
        const triggerHost = findLibraryHostFromTrigger(bridge.lastLibraryTrigger);
        if (triggerHost) {
            return triggerHost;
        }
        const selectors = [
            '.group-chat',
            '.c2c-chat',
            '[class*="chat-main"]',
            '[class*="chat-content"]',
            '[class*="message-panel"]',
            '[class*="message-list"]',
            '.chat-panel',
            '.message-panel',
            '.aio.vue-component',
            '.aio'
        ];
        const candidates = selectors.flatMap(selector => Array.from(document.querySelectorAll(selector)));
        return pickLibraryHost(candidates);
    }

    function openLibraryPanel() {
        return libraryPanel?.open();
    }

    function closeLibraryPanel() {
        libraryPanel?.close();
    }

    function updateLibraryPanelPlacement() {
        libraryPanel?.updatePlacement();
    }

    function blockDocumentWhileLibraryOpen(event) {
        if (!libraryPanel?.isOpen()) {
            return;
        }
        if (event.type === 'keydown' && event.key === 'Escape') {
            if (!libraryPanel.handleEscape()) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation?.();
            return;
        }
        if (libraryPanel.contains(event.target) ||
            event.target?.closest?.('#qqnt-toolbox-scrollbar-overlay')) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
    }
    function findVoiceLibraryTriggerFromEvent(event) {
        const selector = [
            '#id-func-bar-microphone_on',
            '[id*="microphone_on"]',
            '[aria-label="\u8bed\u97f3\u6d88\u606f"]',
            '[title="\u8bed\u97f3\u6d88\u606f"]',
            '[data-title="\u8bed\u97f3\u6d88\u606f"]'
        ].join(',');
        const path = (event.composedPath?.() || [])
            .filter(item => item instanceof Element)
            .slice(0, 16);
        for (const item of path) {
            const trigger = item.matches?.(selector) ? item : item.closest?.(selector);
            if (trigger?.closest?.('.chat-func-bar .func-bar-native, .chat-func-bar')) {
                return trigger;
            }
        }
        return null;
    }

    function openLibraryPanelDebounced() {
        if (!isVoiceFeatureEnabled()) {
            closeLibraryPanel();
            return;
        }
        const bridge = getBridge();
        const now = Date.now();
        if (bridge.lastLibraryOpenAt && now - bridge.lastLibraryOpenAt < 350) {
            return;
        }
        bridge.lastLibraryOpenAt = now;
        openLibraryPanel();
    }

    function flushActionQueue() {
        const bridge = getBridge();
        if (!bridge.resolve || bridge.queue.length === 0) {
            return;
        }
        const resolve = bridge.resolve;
        bridge.resolve = null;
        resolve(bridge.queue.shift());
    }

    function enqueueAction(action) {
        const bridge = getBridge();
        bridge.queue.push(action);
        flushActionQueue();
    }

    const panelBridge = getBridge();
    libraryPanel = panelBridge.panelController || voiceLibraryPanelFactory({
        cssText: voiceLibraryPanelCss,
        resolveHost: findLibraryHost,
        onAction: action => {
            const nextAction = { ...action };
            if (['pick', 'sendLibrary', 'sendOnlineAudio'].includes(action.type)) {
                nextAction.peer = getCurrentPeer();
            }
            enqueueAction(nextAction);
        }
    });
    panelBridge.panelController = libraryPanel;

    function normalizePttText(value) {
        const text = String(value ?? '').trim();
        return text && text !== 'undefined' && text !== 'null' && text !== '0' ? text : '';
    }

    function normalizePttDuration(value) {
        const duration = Number(value);
        if (!Number.isFinite(duration) || duration <= 0) {
            return 0;
        }
        return Math.max(1, Math.ceil(duration > 1000 ? duration / 1000 : duration));
    }

    function sanitizePttElement(value) {
        const pttElement = value?.pttElement || value;
        if (!pttElement || typeof pttElement !== 'object') {
            return null;
        }
        const ptt = {
            filePath: normalizePttText(pttElement.filePath),
            sourcePath: normalizePttText(pttElement.sourcePath),
            fileName: normalizePttText(pttElement.fileName),
            md5HexStr: normalizePttText(pttElement.md5HexStr).toLowerCase(),
            duration: normalizePttDuration(pttElement.duration),
            fileUuid: normalizePttText(pttElement.fileUuid),
            fileSubId: normalizePttText(pttElement.fileSubId),
            fileId: normalizePttText(pttElement.fileId),
            ...(Number(pttElement.fileSize) > 0
                ? { fileSize: Math.trunc(Number(pttElement.fileSize)) }
                : {})
        };
        return ptt.filePath || ptt.sourcePath || ptt.fileName || ptt.md5HexStr ||
            ptt.fileUuid || ptt.fileSubId || ptt.fileId
            ? ptt
            : null;
    }

    function makePttForwardPlaceholder(record, ptt) {
        const duration = Math.max(1, Math.ceil(Number(ptt?.duration) || 1));
        return {
            ...record,
            msgType: 2,
            subMsgType: 1,
            elements: [{
                elementType: 1,
                elementId: '',
                textElement: {
                    content: `[\u8bed\u97f3] ${duration}\u2033`,
                    atType: 0,
                    atUid: '',
                    atNtUid: ''
                }
            }]
        };
    }

    function getPttFromRecord(record) {
        const rawPtt = getRawPttFromRecord(record);
        const snapshot = getBridge().compatiblePttOriginalSources?.get?.(rawPtt);
        if (!snapshot) {
            return sanitizePttElement(rawPtt);
        }
        const originalPtt = { ...rawPtt };
        for (const [field, hadValue, value] of snapshot) {
            if (hadValue) {
                originalPtt[field] = value;
            } else {
                delete originalPtt[field];
            }
        }
        return sanitizePttElement(originalPtt);
    }

    function getRawPttFromRecord(record) {
        const element = (Array.isArray(record?.elements) ? record.elements : [])
            .find(item => Number(item?.elementType) === 4 || item?.pttElement);
        return element?.pttElement || null;
    }

    function findMsgRecordInValue(value, depth = 0, seen = new WeakSet()) {
        if (!value || typeof value !== 'object' || depth > 4 || seen.has(value)) {
            return null;
        }
        seen.add(value);
        if (isMsgRecord(value)) {
            return value;
        }
        if (value instanceof Element || ArrayBuffer.isView(value) || value instanceof Map) {
            return null;
        }
        for (const key of ['props', 'setupState', 'ctx', 'proxy', 'msgRecord', 'message', 'record', 'msg']) {
            const record = findMsgRecordInValue(value[key], depth + 1, seen);
            if (record) {
                return record;
            }
        }
        return null;
    }

    function findMessageRecordFromElement(element) {
        const message = element?.closest?.('.message.vue-component, .ml-item, .message');
        if (!message) {
            return null;
        }
        const candidates = [];
        for (let node = element; node && node !== document.body; node = node.parentElement) {
            candidates.push(node);
            if (node === message) {
                break;
            }
        }
        candidates.push(...Array.from(message.querySelectorAll?.('*') || []).slice(0, 80));
        for (const candidate of candidates) {
            for (const instance of getVueInstances(candidate)) {
                const record = findMsgRecordInValue(instance);
                if (record) {
                    return record;
                }
            }
        }
        return null;
    }

    function getCompatiblePttClickRequest(event) {
        if (!isVoiceFeatureEnabled() || event.button > 0) {
            return null;
        }
        const path = (event.composedPath?.() || []).filter(item => item instanceof Element);
        const bubble = path.find(item => item.matches?.(PTT_BUBBLE_SELECTOR)) ||
            event.target?.closest?.(PTT_BUBBLE_SELECTOR);
        const message = bubble?.closest?.('.message.vue-component, .ml-item, .message');
        const record = message && findMessageRecordFromElement(bubble);
        const ptt = getPttFromRecord(record);
        const rawPtt = getRawPttFromRecord(record);
        if (!message || !record || !ptt || !rawPtt) {
            return null;
        }
        return {
            id: String(record.msgId || `${ptt.md5HexStr}:${record.msgSeq || ''}`),
            chatSignature: getCurrentPeerSignature(),
            ptt,
            rawPtt,
            target: bubble,
            bubble,
            message,
        };
    }

    function getCompatiblePttBubble(playback) {
        if (playback?.bubble?.isConnected) {
            return playback.bubble.matches?.('.ptt-element')
                ? playback.bubble
                : playback.bubble.querySelector?.('.ptt-element') || playback.bubble;
        }
        const message = playback?.message?.isConnected
            ? playback.message
            : playback?.target?.closest?.('.message.vue-component, .ml-item, .message');
        return message?.querySelector?.('.ptt-element, .ptt-message__container') || null;
    }

    function clearCompatiblePttTarget(playback) {
        playback?.target?.removeAttribute?.('aria-busy');
    }

    function isMatchingPtt(candidate, playback) {
        if (!candidate || typeof candidate !== 'object') {
            return false;
        }
        if (candidate === playback.rawPtt) {
            return true;
        }
        const expected = playback.ptt;
        return [
            ['md5HexStr', true],
            ['fileUuid', false],
            ['fileSubId', false],
            ['fileName', false]
        ].some(([key, lowerCase]) => {
            const left = normalizePttText(candidate[key]);
            const right = normalizePttText(expected[key]);
            if (!left || !right) {
                return false;
            }
            return lowerCase ? left.toLowerCase() === right.toLowerCase() : left === right;
        });
    }

    function collectCompatiblePttTargets(playback) {
        const targets = new Set([playback.rawPtt]);
        const seen = new WeakSet();
        const visit = (value, depth = 0) => {
            if (!value || typeof value !== 'object' || depth > 4 || seen.has(value) || value instanceof Element) {
                return;
            }
            seen.add(value);
            const pttElement = value.pttElement;
            if (isMatchingPtt(pttElement, playback)) {
                targets.add(pttElement);
            }
            if (isMatchingPtt(value, playback)) {
                targets.add(value);
            }
            if (depth >= 4) {
                return;
            }
            const entries = Array.isArray(value)
                ? value.slice(0, 32).map((item, index) => [String(index), item])
                : Object.keys(value).slice(0, 100).map(key => {
                    try {
                        return [key, value[key]];
                    } catch {
                        return [key, null];
                    }
                });
            for (const [key, child] of entries) {
                if (Array.isArray(value) || /ptt|element|message|msg|record|props|setup|state|ctx|proxy/i.test(key)) {
                    visit(child, depth + 1);
                }
            }
        };
        const elements = [];
        for (let node = playback.bubble; node && node !== document.body; node = node.parentElement) {
            elements.push(node);
            if (node === playback.message) {
                break;
            }
        }
        elements.push(...Array.from(playback.bubble?.querySelectorAll?.('*') || []).slice(0, 24));
        for (const element of elements) {
            for (const instance of getVueInstances(element)) {
                visit(instance.props);
                visit(instance.setupState);
                visit(instance.ctx);
                visit(instance.proxy);
            }
        }
        return Array.from(targets).filter(target => isMatchingPtt(target, playback));
    }

    function bindCompatiblePttSource(playback, pttElement) {
        const replacement = sanitizePttElement(pttElement);
        if (!replacement) {
            return false;
        }
        const bridge = getBridge();
        bridge.compatiblePttOriginalSources ||= new WeakMap();
        bridge.compatiblePttSourceTargets ||= new Map();
        const sourceTargets = bridge.compatiblePttSourceTargets.get(playback.id) || new Set();
        bridge.compatiblePttSourceTargets.set(playback.id, sourceTargets);
        const fields = [
            'filePath', 'sourcePath', 'fileName', 'md5HexStr', 'fileSize',
            'fileUuid', 'fileSubId', 'fileId', 'formatType', 'voiceType', 'voiceChangeType'
        ];
        for (const target of collectCompatiblePttTargets(playback)) {
            let snapshot = bridge.compatiblePttOriginalSources.get(target);
            if (!snapshot) {
                snapshot = fields.map(field => [
                    field,
                    Object.prototype.hasOwnProperty.call(target, field),
                    target[field]
                ]);
                bridge.compatiblePttOriginalSources.set(target, snapshot);
            }
            sourceTargets.add(target);
            for (const field of fields) {
                let nextValue = Object.prototype.hasOwnProperty.call(pttElement, field)
                    ? pttElement[field]
                    : replacement[field];
                if (nextValue === undefined && field === 'sourcePath') {
                    nextValue = replacement.filePath;
                } else if (nextValue === undefined && field === 'fileId') {
                    nextValue = '';
                }
                if (nextValue === undefined) {
                    continue;
                }
                try {
                    Reflect.set(target, field, nextValue);
                } catch {
                }
            }
        }
        return sourceTargets.size > 0;
    }

    function restoreCompatiblePttSource(id = '') {
        const bridge = getBridge();
        const sourceTargets = bridge.compatiblePttSourceTargets;
        const originalSources = bridge.compatiblePttOriginalSources;
        if (!sourceTargets || !originalSources) {
            return;
        }
        const ids = id ? [id] : Array.from(sourceTargets.keys());
        for (const sourceId of ids) {
            for (const target of sourceTargets.get(sourceId) || []) {
                const snapshot = originalSources.get(target);
                if (!snapshot) {
                    continue;
                }
                for (const [field, hadValue, value] of snapshot) {
                    try {
                        if (hadValue) {
                            Reflect.set(target, field, value);
                        } else {
                            Reflect.deleteProperty(target, field);
                        }
                    } catch {
                    }
                }
                originalSources.delete(target);
            }
            sourceTargets.delete(sourceId);
        }
    }

    function stopCompatiblePttAudio(id, options = {}) {
        const bridge = getBridge();
        const media = bridge.compatiblePttMedia?.get?.(id);
        if (!media) {
            return;
        }
        cancelCompatiblePttNativeRestore(media);
        if (media.playing) {
            media.offset = Math.min(
                media.buffer?.duration || Infinity,
                media.offset + Math.max(0, media.context.currentTime - media.startedAt)
            );
        }
        media.playing = false;
        media.source?.stop?.();
        media.source?.disconnect?.();
        media.source = null;
        if (options.reset) {
            media.offset = 0;
            media.ended = false;
            media.hasStarted = false;
        }
        if (bridge.compatiblePttActiveMediaId === id) {
            bridge.compatiblePttActiveMediaId = '';
        }
        if (options.remove) {
            bridge.compatiblePttMedia.delete(id);
        }
    }

    function isCompatiblePttLifecycleActive(media) {
        return Boolean(media?.playing || (!media?.ended && media?.hasStarted));
    }

    function getCompatiblePttCurrentOffset(media) {
        if (!media) {
            return 0;
        }
        const elapsed = media.playing
            ? Math.max(0, media.context.currentTime - media.startedAt)
            : 0;
        return Math.min(Number(media.buffer?.duration) || Infinity, Math.max(0, media.offset + elapsed));
    }

    function isCompatiblePttPlaybackCurrent(playback) {
        if (!playback?.message?.isConnected || !getCompatiblePttBubble(playback)?.isConnected) {
            return false;
        }
        const currentSignature = getCurrentPeerSignature();
        return Boolean(playback.chatSignature && currentSignature === playback.chatSignature);
    }

    function stopCompatiblePttLifecycleMonitor() {
        const bridge = getBridge();
        if (bridge.compatiblePttLifecycleTimer) {
            clearInterval(bridge.compatiblePttLifecycleTimer);
            bridge.compatiblePttLifecycleTimer = null;
        }
        bridge.compatiblePttMountObserver?.disconnect?.();
        bridge.compatiblePttMountObserver = null;
    }

    function findMountedCompatiblePttPlayback(media) {
        const chatSignature = getCurrentPeerSignature();
        if (!media?.chatSignature || chatSignature !== media.chatSignature) {
            return null;
        }
        for (const bubble of Array.from(document.querySelectorAll(PTT_BUBBLE_SELECTOR)).slice(0, 160)) {
            const message = bubble.closest?.('.message.vue-component, .ml-item, .message');
            if (!message || !isVisible(message)) {
                continue;
            }
            const record = findMessageRecordFromElement(bubble);
            const ptt = getPttFromRecord(record);
            const rawPtt = getRawPttFromRecord(record);
            const id = record && ptt
                ? String(record.msgId || `${ptt.md5HexStr}:${record.msgSeq || ''}`)
                : '';
            if (id === media.id && rawPtt) {
                return {
                    id,
                    chatSignature,
                    ptt,
                    rawPtt,
                    target: bubble,
                    bubble,
                    message
                };
            }
        }
        return null;
    }

    function dispatchCompatiblePttNativeSeek(playback, ratio) {
        const bridge = getBridge();
        const progress = getCompatiblePttBubble(playback)
            ?.querySelector?.('.ptt-element__progress, [class*="ptt-element__progress"]');
        const rect = progress?.getBoundingClientRect?.();
        if (!progress || !rect?.width) {
            return false;
        }
        const clientX = rect.left + Math.min(1, Math.max(0, ratio)) * rect.width;
        bridge.compatiblePttNativeSeekId = playback.id;
        try {
            // QQ toggles PTT playback when a click bubbles from the progress bar.
            // A completed drag already commits the seek, so dispatching click here
            // would invert the restored play/pause state on every remount.
            for (const [type, buttons] of [['mousedown', 1], ['mousemove', 1], ['mouseup', 0]]) {
                progress.dispatchEvent(new MouseEvent(type, {
                    bubbles: true,
                    cancelable: true,
                    clientX,
                    clientY: rect.top + rect.height / 2,
                    button: 0,
                    buttons
                }));
            }
        } finally {
            bridge.compatiblePttNativeSeekId = '';
        }
        return true;
    }

    function getCompatiblePttNativeVisualSignature(playback) {
        const bubble = getCompatiblePttBubble(playback);
        const button = bubble?.querySelector?.('.ptt-element__button, [class*="ptt-element__button"]') ||
            (bubble?.matches?.('.ptt-element__button, [class*="ptt-element__button"]') ? bubble : null);
        if (!bubble || !button) {
            return '';
        }
        const describe = element => [
            element?.className,
            element?.getAttribute?.('style'),
            element?.getAttribute?.('aria-label'),
            element?.getAttribute?.('aria-pressed'),
            element?.innerHTML
        ].map(value => String(value ?? '')).join('\n');
        return describe(button);
    }

    function cancelCompatiblePttNativeRestore(media) {
        if (!media) {
            return;
        }
        media.nativeSyncToken = Number(media.nativeSyncToken || 0) + 1;
        media.nativeSyncing = false;
        media.nativeRestorePending = false;
        media.nativeRestoreBubble = null;
    }

    function isCompatiblePttNativeRestoreCurrent(media, bubble, token) {
        return shouldKeepVoicePlayingAcrossChats() &&
            media?.nativeSyncToken === token &&
            media.nativeRestoreBubble === bubble &&
            bubble?.isConnected &&
            getCurrentPeerSignature() === media.chatSignature;
    }

    function waitForCompatiblePttNativeVisualChange(
        media,
        playback,
        bubble,
        token,
        previousSignature,
        expectedSignature = ''
    ) {
        return new Promise(resolve => {
            const button = bubble?.querySelector?.('.ptt-element__button, [class*="ptt-element__button"]') ||
                (bubble?.matches?.('.ptt-element__button, [class*="ptt-element__button"]') ? bubble : null);
            let observer = null;
            let timer = null;
            let stableTimer = null;
            let settled = false;
            let candidateSignature = '';
            const finish = signature => {
                if (settled) {
                    return;
                }
                settled = true;
                observer?.disconnect?.();
                if (timer) {
                    clearTimeout(timer);
                }
                if (stableTimer) {
                    clearTimeout(stableTimer);
                }
                resolve(signature);
            };
            const check = () => {
                if (!isCompatiblePttNativeRestoreCurrent(media, bubble, token)) {
                    finish('');
                    return;
                }
                const signature = getCompatiblePttNativeVisualSignature(playback);
                if (signature && signature !== previousSignature &&
                    (!expectedSignature || signature === expectedSignature)) {
                    if (signature === candidateSignature && stableTimer) {
                        return;
                    }
                    candidateSignature = signature;
                    if (stableTimer) {
                        clearTimeout(stableTimer);
                    }
                    stableTimer = setTimeout(() => {
                        stableTimer = null;
                        if (!isCompatiblePttNativeRestoreCurrent(media, bubble, token)) {
                            finish('');
                            return;
                        }
                        const stableSignature = getCompatiblePttNativeVisualSignature(playback);
                        if (stableSignature === candidateSignature && stableSignature !== previousSignature &&
                            (!expectedSignature || stableSignature === expectedSignature)) {
                            finish(stableSignature);
                            return;
                        }
                        candidateSignature = '';
                    }, 72);
                }
            };
            if (button && typeof MutationObserver === 'function') {
                observer = new MutationObserver(check);
                observer.observe(button, {
                    attributes: true,
                    childList: true,
                    subtree: true
                });
            }
            check();
            if (!settled) {
                timer = setTimeout(() => finish(''), 720);
            }
        });
    }

    function rememberCompatiblePttNativeVisualState(media, playback, playing, previousSignature = '') {
        const bubble = getCompatiblePttBubble(playback);
        const button = bubble?.querySelector?.('.ptt-element__button, [class*="ptt-element__button"]') ||
            (bubble?.matches?.('.ptt-element__button, [class*="ptt-element__button"]') ? bubble : null);
        if (!media || !button) {
            return;
        }
        const stateKey = playing ? 'nativePlayingSignature' : 'nativePausedSignature';
        let observer = null;
        let timer = null;
        const finish = () => {
            observer?.disconnect?.();
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
        };
        const capture = () => {
            const signature = getCompatiblePttNativeVisualSignature(playback);
            if (!signature || (previousSignature && signature === previousSignature) || media.playing !== playing) {
                return false;
            }
            media[stateKey] = signature;
            finish();
            return true;
        };
        if (typeof MutationObserver === 'function') {
            observer = new MutationObserver(capture);
            observer.observe(button, {
                attributes: true,
                childList: true,
                subtree: true
            });
        }
        timer = setTimeout(finish, 360);
        queueMicrotask(capture);
    }

    function waitForCompatiblePttNativeVisualState(media, playback, bubble, token, expectedSignature) {
        return new Promise(resolve => {
            setTimeout(() => {
                resolve(Boolean(
                    expectedSignature &&
                    isCompatiblePttNativeRestoreCurrent(media, bubble, token) &&
                    getCompatiblePttNativeVisualSignature(playback) === expectedSignature
                ));
            }, 72);
        });
    }

    function failCompatiblePttNativeRestore(media, bubble, token) {
        if (media?.nativeSyncToken !== token || media.nativeRestoreBubble !== bubble) {
            return;
        }
        media.nativeSyncing = false;
        media.nativeRestorePending = false;
        media.nativeRestoreBubble = null;
        media.nativeBubble = null;
        media.nativeRestoreAttempts = Number(media.nativeRestoreAttempts || 0) + 1;
        const elapsed = performance.now() - Number(media.nativeRestoreStartedAt || 0);
        if (media.nativeRestoreAttempts >= 3 || elapsed >= 1600 || !bubble.isConnected) {
            media.nativeRestoreBlockedBubble = bubble.isConnected ? bubble : null;
        }
        media.nextNativeLookupAt = performance.now() + 120;
    }

    function restoreCompatiblePttNativeState(media, playback) {
        const bridge = getBridge();
        const pttElement = bridge.compatiblePttSources?.get?.(media.id);
        if (!pttElement || !bindCompatiblePttSource(playback, pttElement)) {
            return false;
        }
        const bubble = getCompatiblePttBubble(playback);
        if (!bubble) {
            return false;
        }
        if (media.nativeRestoreBlockedBubble === bubble) {
            return false;
        }
        if (media.nativeRestorePending && media.nativeRestoreBubble === bubble) {
            return true;
        }
        cancelCompatiblePttNativeRestore(media);
        media.playback = playback;
        media.nativeBubble = null;
        media.nativeRestoreBubble = bubble;
        media.nativeRestorePending = true;
        media.nativeSyncing = true;
        media.nativeRestoreAttempts = 0;
        media.nativeRestoreStartedAt = performance.now();
        media.nativeRestoreBlockedBubble = null;
        const token = media.nativeSyncToken;
        (async () => {
            if (!bindCompatiblePttSource(playback, pttElement)) {
                failCompatiblePttNativeRestore(media, bubble, token);
                return;
            }
            const signatureKey = media.playing ? 'nativePlayingSignature' : 'nativePausedSignature';
            const oppositeSignatureKey = media.playing ? 'nativePausedSignature' : 'nativePlayingSignature';
            let desiredSignature = String(media[signatureKey] || '');
            const beforeToggle = getCompatiblePttNativeVisualSignature(playback);
            if (!beforeToggle) {
                failCompatiblePttNativeRestore(media, bubble, token);
                return;
            }
            if (!desiredSignature && media[oppositeSignatureKey] &&
                beforeToggle !== media[oppositeSignatureKey]) {
                desiredSignature = beforeToggle;
                media[signatureKey] = desiredSignature;
            }
            if (!desiredSignature && !media.playing && !media[oppositeSignatureKey]) {
                desiredSignature = beforeToggle;
                media.nativePausedSignature = desiredSignature;
            }
            if (!desiredSignature || beforeToggle !== desiredSignature) {
                if (!replayCompatiblePttWithNativePlayer(playback)) {
                    failCompatiblePttNativeRestore(media, bubble, token);
                    return;
                }
                const changedSignature = await waitForCompatiblePttNativeVisualChange(
                    media,
                    playback,
                    bubble,
                    token,
                    beforeToggle,
                    desiredSignature
                );
                if (!changedSignature || !isCompatiblePttNativeRestoreCurrent(media, bubble, token)) {
                    failCompatiblePttNativeRestore(media, bubble, token);
                    return;
                }
                desiredSignature ||= changedSignature;
                media[signatureKey] = desiredSignature;
            }
            const duration = Number(media.buffer?.duration) || Number(media.durationMs) / 1000;
            const ratio = duration > 0 ? getCompatiblePttCurrentOffset(media) / duration : 0;
            dispatchCompatiblePttNativeSeek(playback, ratio);
            if (!isCompatiblePttNativeRestoreCurrent(media, bubble, token)) {
                return;
            }
            if (!await waitForCompatiblePttNativeVisualState(
                media,
                playback,
                bubble,
                token,
                desiredSignature
            )) {
                failCompatiblePttNativeRestore(media, bubble, token);
                return;
            }
            media.nativeSyncing = false;
            media.nativeRestorePending = false;
            media.nativeRestoreBubble = null;
            media.nativeBubble = bubble;
            media.nativeRestoreAttempts = 0;
            media.nativeRestoreBlockedBubble = null;
            media.nextNativeLookupAt = 0;
        })().catch(() => failCompatiblePttNativeRestore(media, bubble, token));
        return true;
    }

    function restoreMountedCompatiblePttNativeStates() {
        if (!shouldKeepVoicePlayingAcrossChats()) {
            return;
        }
        const bridge = getBridge();
        const currentSignature = getCurrentPeerSignature();
        for (const media of bridge.compatiblePttMedia?.values?.() || []) {
            if (!isCompatiblePttLifecycleActive(media) || media.chatSignature !== currentSignature ||
                media.nativeBubble?.isConnected ||
                media.nativeRestoreBlockedBubble?.isConnected ||
                (media.nativeRestorePending && media.nativeRestoreBubble?.isConnected)) {
                continue;
            }
            const mounted = findMountedCompatiblePttPlayback(media);
            if (mounted) {
                restoreCompatiblePttNativeState(media, mounted);
            }
        }
    }

    function installCompatiblePttMountObserver() {
        const bridge = getBridge();
        if (bridge.compatiblePttMountObserver || !document.documentElement) {
            return;
        }
        bridge.compatiblePttMountObserver = new MutationObserver(mutations => {
            if (!shouldKeepVoicePlayingAcrossChats()) {
                return;
            }
            const hasMountedPtt = mutations.some(mutation => Array.from(mutation.addedNodes || []).some(node =>
                node instanceof Element &&
                (node.matches?.(PTT_BUBBLE_SELECTOR) || node.querySelector?.(PTT_BUBBLE_SELECTOR))
            ));
            if (hasMountedPtt) {
                restoreMountedCompatiblePttNativeStates();
            }
        });
        bridge.compatiblePttMountObserver.observe(document.documentElement, {
            childList: true,
            subtree: true
        });
    }

    function checkCompatiblePttLifecycle() {
        const bridge = getBridge();
        let monitoring = false;
        const pending = bridge.compatiblePttPlayback;
        if (pending?.checking) {
            monitoring = true;
            if (!shouldKeepVoicePlayingAcrossChats()) {
                pending.lifecycleMisses = isCompatiblePttPlaybackCurrent(pending)
                    ? 0
                    : Number(pending.lifecycleMisses || 0) + 1;
                if (pending.lifecycleMisses >= 2) {
                    clearCompatiblePttTarget(pending);
                    bridge.compatiblePttPlayback = null;
                    monitoring = false;
                }
            }
        }
        for (const [id, media] of bridge.compatiblePttMedia?.entries?.() || []) {
            if (!isCompatiblePttLifecycleActive(media)) {
                continue;
            }
            monitoring = true;
            if (shouldKeepVoicePlayingAcrossChats()) {
                const currentSignature = getCurrentPeerSignature();
                if (currentSignature !== media.chatSignature) {
                    if (media.nativeBubble || media.nativeRestoreBubble) {
                        restoreCompatiblePttSource(id);
                    }
                    cancelCompatiblePttNativeRestore(media);
                    media.nativeBubble = null;
                    continue;
                }
                if (media.nativeBubble?.isConnected) {
                    continue;
                }
                if (media.nativeRestoreBlockedBubble?.isConnected) {
                    continue;
                }
                if (media.nativeRestorePending && media.nativeRestoreBubble?.isConnected) {
                    continue;
                }
                const now = performance.now();
                if (now < Number(media.nextNativeLookupAt || 0)) {
                    continue;
                }
                media.nextNativeLookupAt = now + 480;
                const mounted = findMountedCompatiblePttPlayback(media);
                if (!mounted) {
                    media.nativeBubble = null;
                    continue;
                }
                if (media.nativeBubble !== getCompatiblePttBubble(mounted) &&
                    media.nativeRestoreBubble !== getCompatiblePttBubble(mounted)) {
                    restoreCompatiblePttNativeState(media, mounted);
                }
                continue;
            }
            media.lifecycleMisses = isCompatiblePttPlaybackCurrent(media.playback)
                ? 0
                : Number(media.lifecycleMisses || 0) + 1;
            if (media.lifecycleMisses >= 2) {
                discardCompatiblePttPlayback(id);
            }
        }
        if (!monitoring) {
            stopCompatiblePttLifecycleMonitor();
        }
    }

    function startCompatiblePttLifecycleMonitor() {
        const bridge = getBridge();
        installCompatiblePttMountObserver();
        if (!bridge.compatiblePttLifecycleTimer) {
            bridge.compatiblePttLifecycleTimer = setInterval(checkCompatiblePttLifecycle, 120);
        }
    }

    function stopOtherCompatiblePttAudio(id = '') {
        const bridge = getBridge();
        for (const mediaId of bridge.compatiblePttMedia?.keys?.() || []) {
            if (mediaId !== id) {
                stopCompatiblePttAudio(mediaId, { reset: true });
            }
        }
    }

    function getCompatiblePttAudioContext() {
        const bridge = getBridge();
        const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
        if (!AudioContextClass) {
            return null;
        }
        if (!bridge.compatiblePttAudioContext || bridge.compatiblePttAudioContext.state === 'closed') {
            bridge.compatiblePttAudioContext = new AudioContextClass();
        }
        return bridge.compatiblePttAudioContext;
    }

    async function createCompatiblePttAudio(playback, payload) {
        if (!payload.previewUrl) {
            throw new Error('The original voice media URL is unavailable.');
        }
        const bridge = getBridge();
        bridge.compatiblePttMedia ||= new Map();
        const existing = bridge.compatiblePttMedia.get(playback.id);
        if (existing?.previewUrl === payload.previewUrl) {
            existing.playback = playback;
            return existing;
        }
        if (existing) {
            stopCompatiblePttAudio(playback.id, { reset: true, remove: true });
        }
        const context = getCompatiblePttAudioContext();
        if (!context) {
            throw new Error('Web Audio is unavailable.');
        }
        const response = await fetch(payload.previewUrl);
        if (!response.ok) {
            throw new Error(`Original voice playback failed (${response.status}).`);
        }
        const buffer = await context.decodeAudioData(await response.arrayBuffer());
        const media = {
            id: playback.id,
            context,
            buffer,
            source: null,
            offset: 0,
            startedAt: 0,
            playing: false,
            ended: false,
            hasStarted: false,
            playback,
            previewUrl: payload.previewUrl,
            chatSignature: playback.chatSignature,
            durationMs: Math.max(0, Number(payload.durationMs) || 0)
        };
        bridge.compatiblePttMedia.set(playback.id, media);
        return media;
    }

    async function startCompatiblePttAudio(media) {
        if (!media?.buffer || media.playing) {
            return;
        }
        const bridge = getBridge();
        stopOtherCompatiblePttAudio(media.id);
        await media.context.resume();
        if (media.ended || media.offset >= media.buffer.duration) {
            media.offset = 0;
            media.ended = false;
        }
        const source = media.context.createBufferSource();
        source.buffer = media.buffer;
        source.connect(media.context.destination);
        source.onended = () => {
            if (media.source !== source || !media.playing) {
                return;
            }
            media.source = null;
            media.offset = 0;
            media.playing = false;
            media.ended = true;
            if (bridge.compatiblePttActiveMediaId === media.id) {
                bridge.compatiblePttActiveMediaId = '';
            }
        };
        media.source = source;
        media.startedAt = media.context.currentTime;
        media.playing = true;
        media.hasStarted = true;
        media.lifecycleMisses = 0;
        bridge.compatiblePttActiveMediaId = media.id;
        source.start(0, Math.max(0, Math.min(media.offset, media.buffer.duration - 0.001)));
        startCompatiblePttLifecycleMonitor();
    }

    function seekCompatiblePttAudio(event) {
        if (!(event.target instanceof Element)) {
            return;
        }
        const progress = event.target.closest('.ptt-element__progress, [class*="ptt-element__progress"]');
        if (!progress) {
            return;
        }
        const request = getCompatiblePttClickRequest(event);
        if (request && getBridge().compatiblePttNativeSeekId === request.id) {
            return;
        }
        const media = request && getBridge().compatiblePttMedia?.get?.(request.id);
        const rect = progress.getBoundingClientRect?.();
        const duration = Number(media?.buffer?.duration) || Number(media?.durationMs) / 1000;
        if (!media || !rect?.width || !Number.isFinite(duration) || duration <= 0) {
            return;
        }
        const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
        const wasPlaying = media.playing;
        stopCompatiblePttAudio(media.id);
        media.offset = ratio * duration;
        media.ended = false;
        media.hasStarted = true;
        if (wasPlaying) {
            startCompatiblePttAudio(media).catch(() => {});
        }
    }

    function replayCompatiblePttWithNativePlayer(playback, pttElement = null) {
        const bridge = getBridge();
        if (pttElement && !bindCompatiblePttSource(playback, pttElement)) {
            return false;
        }
        const bubble = getCompatiblePttBubble(playback);
        const button = bubble?.querySelector?.('.ptt-element__button') ||
            (bubble?.matches?.('.ptt-element__button') ? bubble : null) || bubble;
        if (!button) {
            return false;
        }
        bridge.compatiblePttNativeReentryId = playback.id;
        try {
            button.click();
        } finally {
            bridge.compatiblePttNativeReentryId = '';
        }
        return true;
    }

    async function toggleCompatiblePttPlayback(playback, media, pttElement = null) {
        if (!media?.buffer) {
            throw new Error('The original voice audio is unavailable.');
        }
        const beforeToggle = getCompatiblePttNativeVisualSignature(playback);
        if (media.playing) {
            if (beforeToggle) {
                media.nativePlayingSignature = beforeToggle;
            }
            if (!replayCompatiblePttWithNativePlayer(playback, pttElement)) {
                throw new Error('The QQ voice player is unavailable.');
            }
            stopCompatiblePttAudio(media.id);
            rememberCompatiblePttNativeVisualState(media, playback, false, beforeToggle);
            return;
        }
        if (beforeToggle) {
            media.nativePausedSignature = beforeToggle;
        }
        await startCompatiblePttAudio(media);
        if (!replayCompatiblePttWithNativePlayer(playback, pttElement)) {
            stopCompatiblePttAudio(media.id, { reset: true });
            throw new Error('The QQ voice player is unavailable.');
        }
        media.nativeBubble = getCompatiblePttBubble(playback);
        rememberCompatiblePttNativeVisualState(media, playback, true, beforeToggle);
    }

    function discardCompatiblePttPlayback(id) {
        const bridge = getBridge();
        clearCompatiblePttTarget(bridge.compatiblePttMedia?.get?.(id)?.playback);
        stopCompatiblePttAudio(id, { reset: true, remove: true });
        restoreCompatiblePttSource(id);
        bridge.compatiblePttSources?.delete?.(id);
    }

    function isCompatiblePttPlaybackToggle(event, playback) {
        const target = event.target instanceof Element ? event.target : null;
        const bubble = playback?.bubble?.isConnected
            ? playback.bubble
            : getCompatiblePttBubble(playback);
        if (!target || !bubble || !(target === bubble || bubble.contains(target))) {
            return false;
        }
        const progress = target.closest?.('.ptt-element__progress, [class*="ptt-element__progress"]');
        return !progress || !(progress === bubble || bubble.contains(progress));
    }

    function handleCompatiblePttClick(event) {
        const request = getCompatiblePttClickRequest(event);
        if (!request || !isCompatiblePttPlaybackToggle(event, request)) {
            return;
        }
        const bridge = getBridge();
        if (bridge.compatiblePttNativeReentryId === request.id) {
            return;
        }
        stopOtherCompatiblePttAudio(request.id);
        const cachedMedia = bridge.compatiblePttMedia?.get?.(request.id);
        const cachedPtt = bridge.compatiblePttSources?.get?.(request.id);
        if (cachedPtt && cachedMedia) {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation?.();
            if (cachedMedia.nativeSyncing || cachedMedia.togglePending) {
                return;
            }
            cancelCompatiblePttNativeRestore(cachedMedia);
            cachedMedia.playback = request;
            cachedMedia.togglePending = true;
            toggleCompatiblePttPlayback(request, cachedMedia, cachedPtt)
                .catch(() => {
                    discardCompatiblePttPlayback(request.id);
                })
                .finally(() => {
                    cachedMedia.togglePending = false;
                });
            return;
        }
        if (cachedPtt || cachedMedia) {
            discardCompatiblePttPlayback(request.id);
        }
        const current = bridge.compatiblePttPlayback;
        if (current?.id === request.id && current.checking) {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation?.();
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        request.target?.setAttribute?.('aria-busy', 'true');
        bridge.compatiblePttPlayback = { ...request, checking: true };
        startCompatiblePttLifecycleMonitor();
        enqueueAction({ type: 'playCompatiblePtt', id: request.id, ptt: request.ptt });
    }

    async function useCompatiblePttSource(payload = {}) {
        const bridge = getBridge();
        const playback = bridge.compatiblePttPlayback;
        if (!playback || String(payload.id || '') !== playback.id) {
            return;
        }
        if (!shouldKeepVoicePlayingAcrossChats() && !isCompatiblePttPlaybackCurrent(playback)) {
            clearCompatiblePttTarget(playback);
            bridge.compatiblePttPlayback = null;
            return;
        }
        playback.checking = false;
        if (payload.native) {
            replayCompatiblePttWithNativePlayer(playback);
            clearCompatiblePttTarget(playback);
            bridge.compatiblePttPlayback = null;
            return;
        }
        if (!payload.pttElement) {
            clearCompatiblePttTarget(playback);
            bridge.compatiblePttPlayback = null;
            return;
        }
        bridge.compatiblePttSources ||= new Map();
        if (bridge.compatiblePttSources.size >= 64 && !bridge.compatiblePttSources.has(playback.id)) {
            const evictedId = bridge.compatiblePttSources.keys().next().value;
            restoreCompatiblePttSource(evictedId);
            bridge.compatiblePttSources.delete(evictedId);
            stopCompatiblePttAudio(evictedId, { reset: true, remove: true });
        }
        try {
            const media = await createCompatiblePttAudio(playback, payload);
            bridge.compatiblePttSources.set(playback.id, payload.pttElement);
            if (shouldKeepVoicePlayingAcrossChats() && !isCompatiblePttPlaybackCurrent(playback)) {
                await startCompatiblePttAudio(media);
                media.nativeBubble = null;
            } else {
                await toggleCompatiblePttPlayback(playback, media, payload.pttElement);
            }
        } catch {
            discardCompatiblePttPlayback(playback.id);
        }
        clearCompatiblePttTarget(playback);
        bridge.compatiblePttPlayback = null;
    }

    function preparePttForwardAction(state) {
        if (state.actionPrepared) {
            return;
        }
        state.actionPrepared = true;
        enqueueAction({
            type: 'prepareNativePttForward',
            ptt: state.ptt,
            sourceMsgId: state.sourceMsgId
        });
    }

    function bindPttForwardHandler(state, item) {
        const originalHandler = item?.handler;
        if (!item || typeof originalHandler !== 'function') {
            return item;
        }
        const descriptors = Object.getOwnPropertyDescriptors(item);
        delete descriptors.handler;
        const boundItem = Object.create(Object.getPrototypeOf(item), descriptors);
        Object.defineProperty(boundItem, 'handler', {
            configurable: true,
            writable: true,
            value: function boundPttForwardHandler(...args) {
                preparePttForwardAction(state);
                return Reflect.apply(originalHandler, item, [
                    state.placeholderRecord,
                    state.placeholderRecord.elements[0],
                    ...args.slice(2)
                ]);
            }
        });
        return boundItem;
    }

    function prepareNativePttForwardContext(request) {
        const bridge = getBridge();
        restoreNativePttForwardContext(bridge.nativePttForwardState);
        const record = request.originalContext?.msgRecord;
        const ptt = getPttFromRecord(record);
        if (!isVoiceForwardInContextMenuEnabled() || !ptt || !isMsgRecord(record)) {
            return request;
        }
        const placeholderRecord = makePttForwardPlaceholder(record, ptt);
        const placeholderContext = { ...request.originalContext, msgRecord: placeholderRecord };
        const placeholderItems = request.getNativeItemsForContext?.(placeholderContext) || [];
        const state = {
            active: true,
            actionPrepared: false,
            menu: request.menu,
            originalContext: request.originalContext,
            placeholderRecord,
            ptt,
            sourceMsgId: String(record.msgId || '')
        };
        state.forwardItem = bindPttForwardHandler(
            state,
            placeholderItems.find(item => Number(item?.type) === 6) || null
        );
        bridge.nativePttForwardState = state;
        return request;
    }

    function transformNativePttForwardItems(request) {
        const state = getBridge().nativePttForwardState;
        if (!state?.active || state.menu !== request.menu ||
            request.menu?.menuContext !== state.originalContext || !Array.isArray(request.items)) {
            return request;
        }
        const speechToText = request.items.find(item => Number(item?.type) === 15);
        const forward = state.forwardItem || request.items.find(item => Number(item?.type) === 6) || {
            type: 6,
            text: '\u8f6c\u53d1',
            icon: 'one_by_one_forward'
        };
        return {
            ...request,
            items: [
                ...(speechToText ? [speechToText] : []),
                forward,
                ...request.items.filter(item => ![1, 6, 15].includes(Number(item?.type)))
            ]
        };
    }

    function getPttContextMenuItems({ originalContext }) {
        const ptt = getPttFromRecord(originalContext?.msgRecord);
        if (!isVoiceSaveInContextMenuEnabled() || !ptt) {
            return [];
        }
        return [{
            type: 990102,
            text: '\u4fdd\u5b58',
            icon: 'download',
            when: () => true,
            handler: () => enqueueAction({ type: 'savePtt', ptt }),
            __qqntToolboxDescriptor: {
                id: 'toolbox:voice-save',
                label: '\u4fdd\u5b58\u8bed\u97f3',
                toolbox: true
            },
            __qqntToolboxInsertAfter: ['qq:\u6536\u85cf', 'qq:\u8f6c\u53d1']
        }];
    }

    function registerPttContextMenuExtension() {
        const bridge = getBridge();
        const service = window.__qqntToolboxMessageContextMenu;
        if (bridge.messageContextMenuExtensionRegistered || typeof service?.registerExtension !== 'function') {
            return false;
        }
        service.registerExtension({
            id: 'toolbox-voice-message-actions',
            beforeOpen: prepareNativePttForwardContext,
            transformItems: transformNativePttForwardItems,
            getItems: getPttContextMenuItems
        });
        bridge.messageContextMenuExtensionRegistered = true;
        return true;
    }

    function restoreNativePttForwardContext(state) {
        if (!state?.menu?._?.ctx || !state.originalContext) {
            return;
        }
        state.active = false;
        try {
            state.menu._.ctx.menuContext = state.originalContext;
        } catch {
        }
    }

    function handleNativePttForwardMenuClick(event) {
        const state = getBridge().nativePttForwardState;
        if (!state?.active) {
            return;
        }
        if (!isVoiceForwardInContextMenuEnabled()) {
            restoreNativePttForwardContext(state);
            return;
        }
        const item = event.composedPath?.().find(element =>
            element instanceof Element && element.matches?.('.q-context-menu-item')
        );
        if (!item) {
            return;
        }
        const label = compactText(item);
        if (label === '\u8f6c\u53d1') {
            preparePttForwardAction(state);
            return;
        }
        restoreNativePttForwardContext(state);
    }

    function install() {
        if (window.__voiceFileSenderInstalled || window.__voiceFileSenderInstalling) {
            return;
        }
        window.__voiceFileSenderInstalling = true;
        document.addEventListener('dragover', event => {
            if (!isVoiceFeatureEnabled()) {
                return;
            }
            if (!getVoiceDropTarget(event) || getDropMediaPaths(event.dataTransfer).length === 0) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = 'copy';
        }, true);
        document.addEventListener('drop', event => {
            if (!isVoiceFeatureEnabled()) {
                return;
            }
            const panel = getVoiceDropTarget(event);
            const paths = getDropMediaPaths(event.dataTransfer);
            if (!panel || paths.length === 0) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            enqueueAction({
                type: 'drop',
                paths,
                peer: getCurrentPeer()
            });
        }, true);
        document.addEventListener('contextmenu', event => {
            if (!isVoiceFeatureEnabled()) {
                return;
            }
            const trigger = findVoiceLibraryTriggerFromEvent(event);
            if (trigger) {
                getBridge().lastLibraryTrigger = trigger;
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation?.();
                openLibraryPanelDebounced();
            }
        }, true);
        document.addEventListener('click', handleNativePttForwardMenuClick, true);
        document.addEventListener('click', handleCompatiblePttClick, true);
        document.addEventListener('mouseup', seekCompatiblePttAudio, true);
        for (const eventName of ['click', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'dblclick', 'contextmenu', 'wheel', 'dragover', 'drop', 'keydown', 'keyup']) {
            document.addEventListener(eventName, blockDocumentWhileLibraryOpen, true);
        }
        window.addEventListener('resize', () => updateLibraryPanelPlacement(), true);
        window.addEventListener('scroll', () => updateLibraryPanelPlacement(), true);
        window.__voiceFileSenderInstalled = true;
        window.__voiceFileSenderInstalling = false;
    }

    const bridge = getBridge();
    bridge.enabled = window.__voiceFileSenderEnabled === true;
    bridge.keepPlayingAcrossChats = window.__voiceFileSenderKeepPlayingAcrossChats === true;
    bridge.saveInContextMenu = window.__voiceFileSenderSaveInContextMenuEnabled === true;
    bridge.forwardInContextMenu = window.__voiceFileSenderForwardInContextMenuEnabled === true;
    bridge.setEnabled = enabled => {
        bridge.enabled = enabled === true;
        if (!bridge.enabled) {
            closeLibraryPanel();
            bridge.compatiblePttPlayback = null;
            bridge.compatiblePttSources?.clear?.();
            for (const mediaId of bridge.compatiblePttMedia?.keys?.() || []) {
                stopCompatiblePttAudio(mediaId, { reset: true, remove: true });
            }
            bridge.compatiblePttAudioContext?.close?.().catch?.(() => {});
            bridge.compatiblePttAudioContext = null;
            stopCompatiblePttLifecycleMonitor();
            restoreCompatiblePttSource();
            restoreNativePttForwardContext(bridge.nativePttForwardState);
        }
    };
    bridge.setKeepPlayingAcrossChats = enabled => {
        const wasEnabled = bridge.keepPlayingAcrossChats === true;
        bridge.keepPlayingAcrossChats = enabled === true;
        if (wasEnabled && !bridge.keepPlayingAcrossChats) {
            bridge.compatiblePttPlayback = null;
            for (const mediaId of Array.from(bridge.compatiblePttMedia?.keys?.() || [])) {
                discardCompatiblePttPlayback(mediaId);
            }
            stopCompatiblePttLifecycleMonitor();
        }
    };
    bridge.setSaveInContextMenuEnabled = enabled => {
        bridge.saveInContextMenu = enabled === true;
    };
    bridge.setForwardInContextMenuEnabled = enabled => {
        bridge.forwardInContextMenu = enabled === true;
        if (!bridge.forwardInContextMenu) {
            restoreNativePttForwardContext(bridge.nativePttForwardState);
        }
    };
    bridge.setStatus = (text, options = {}) => libraryPanel.setStatus(text, options);
    bridge.setLibrary = payload => libraryPanel.setLibrary(payload);
    bridge.updateLibraryItems = payload => libraryPanel.updateLibraryItems?.(payload);
    bridge.playPreview = payload => libraryPanel.playPreview(payload);
    bridge.useCompatiblePttSource = useCompatiblePttSource;
    registerPttContextMenuExtension();
    install();

    return new Promise(resolve => {
        const nextBridge = getBridge();
        nextBridge.resolve = resolve;
        flushActionQueue();
    });
}

module.exports = injectedVoiceFileSenderUi;
