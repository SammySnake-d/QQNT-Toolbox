'use strict';

function createVoiceLibraryPanel(options = {}) {
    const ROOT_ID = 'qqnt-toolbox-voice-library';
    const STYLE_ID = 'qqnt-toolbox-voice-library-style';
    const LIST_RENDER_OVERSCAN = 8;
    const LIST_RENDER_STEP = 8;
    const LIST_MIN_RENDER_COUNT = 24;
    const ESTIMATED_LIST_ROW_HEIGHT = 55;
    const ONLINE_PROVIDER_LABELS = Object.freeze({
        kw: '\u9177\u6211\u97f3\u4e50',
        mg: '\u54aa\u5495\u97f3\u4e50',
        kg: '\u9177\u72d7\u97f3\u4e50',
        tx: 'QQ \u97f3\u4e50',
        wy: '\u7f51\u6613\u4e91\u97f3\u4e50'
    });
    const ICON_PATHS = Object.freeze({
        folder: '<path d="M3 5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.7.9L12 6h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
        fileAudio: '<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2Z"/><path d="M14 2v6h6"/><path d="M9 13v4M12 11v8M15 13v4"/>',
        more: '<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>',
        chevronLeft: '<path d="m15 18-6-6 6-6"/>',
        refresh: '<path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5"/>',
        close: '<path d="M18 6 6 18M6 6l12 12"/>',
        send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
        play: '<path d="m6 3 14 9-14 9Z"/>',
        previous: '<path d="M19 20 8 12l11-8v16Z"/><path d="M5 19V5"/>',
        next: '<path d="m5 4 11 8-11 8V4Z"/><path d="M19 5v14"/>',
        rename: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
        delete: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5M14 11v5"/>',
        folderPlus: '<path d="M3 5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.7.9L12 6h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M12 10v6M9 13h6"/>',
        moveTo: '<path d="M3 5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.7.9L12 6h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="m9 12 3 3 3-3M12 9v6"/>',
        cloud: '<path d="M7.5 18.5h9.2a4.3 4.3 0 0 0 .4-8.6A6 6 0 0 0 5.4 8.7 4.8 4.8 0 0 0 7.5 18.5Z"/><path d="M12 12v6M9.5 14.5 12 12l2.5 2.5"/>',
        download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
        music: '<path d="M9 18V5l10-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/>',
        search: '<circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 5 5"/>',
        chart: '<path d="M4 19V9M10 19V5M16 19v-7M22 19H2"/>',
        playlist: '<path d="M4 6h11M4 11h11M4 16h7"/><path d="M18 10v8"/><circle cx="15.5" cy="18" r="2.5"/>'
    });
    const TEXT = {
        title: '\u8bed\u97f3\u6d88\u606f',
        library: '\u8bed\u97f3\u5e93',
        empty: '\u6682\u65e0\u8bed\u97f3',
        folderEmpty: '\u8be5\u6587\u4ef6\u5939\u6682\u65e0\u8bed\u97f3',
        item: '\u8bed\u97f3',
        items: '\u9879',
        unknown: '\u672a\u77e5',
        back: '\u8fd4\u56de',
        refresh: '\u5237\u65b0',
        pick: '\u9009\u62e9\u53d1\u9001',
        add: '\u6dfb\u52a0\u5230\u8bed\u97f3\u5e93',
        open: '\u6253\u5f00',
        send: '\u53d1\u9001',
        play: '\u64ad\u653e',
        pause: '\u6682\u505c',
        previous: '\u4e0a\u4e00\u9996',
        next: '\u4e0b\u4e00\u9996',
        rename: '\u91cd\u547d\u540d',
        move: '\u79fb\u52a8',
        moveTo: '\u79fb\u52a8\u5230',
        newFolder: '\u65b0\u5efa\u6587\u4ef6\u5939',
        remove: '\u5220\u9664',
        more: '\u66f4\u591a\u64cd\u4f5c',
        close: '\u5173\u95ed',
        cancel: '\u53d6\u6d88',
        confirm: '\u786e\u5b9a',
        notPlaying: '\u672a\u64ad\u653e',
        progress: '\u64ad\u653e\u8fdb\u5ea6',
        choose: '\u9009\u62e9\u4e2d',
        refreshing: '\u5237\u65b0\u4e2d',
        sending: '\u53d1\u9001\u4e2d',
        converting: '\u4e34\u65f6\u8f6c\u6362\u5e76\u53d1\u9001\u4e2d',
        loading: '\u52a0\u8f7d\u64ad\u653e\u4e2d',
        renaming: '\u91cd\u547d\u540d\u4e2d',
        creatingFolder: '\u65b0\u5efa\u6587\u4ef6\u5939\u4e2d',
        moving: '\u79fb\u52a8\u4e2d',
        deleting: '\u5220\u9664\u4e2d',
        missing: '\u672a\u627e\u5230\u6761\u76ee',
        noMoveTarget: '\u6ca1\u6709\u53ef\u7528\u7684\u76ee\u6807\u6587\u4ef6\u5939',
        emptyName: '\u540d\u79f0\u4e0d\u80fd\u4e3a\u7a7a',
        deleteTitle: '\u5220\u9664\u8bed\u97f3',
        deleteMessage: '\u5220\u9664\u540e\u65e0\u6cd5\u6062\u590d\uff0c\u786e\u5b9a\u7ee7\u7eed\u5417\uff1f',
        deleteFolderTitle: '\u5220\u9664\u6587\u4ef6\u5939',
        deleteFolderMessage: '\u6587\u4ef6\u5939\u5185\u7684\u6240\u6709\u8bed\u97f3\u548c\u5b50\u6587\u4ef6\u5939\u90fd\u4f1a\u88ab\u5220\u9664\uff0c\u4e14\u65e0\u6cd5\u6062\u590d\u3002',
        offline: '\u79bb\u7ebf\u8bed\u97f3\u5e93',
        online: '\u5728\u7ebf\u97f3\u6e90',
        switchToOnline: '\u5728\u7ebf\u97f3\u6e90',
        switchToOffline: '\u672c\u5730\u8bed\u97f3\u5e93',
        searchOffline: '\u641c\u7d22\u5f53\u524d\u6587\u4ef6\u5939',
        onlineSearch: '\u641c\u7d22\u5728\u7ebf\u6b4c\u66f2',
        searchOnlinePlaceholder: '\u641c\u7d22\u6b4c\u540d\u3001\u6b4c\u624b\u6216\u5173\u952e\u8bcd',
        clearSearch: '\u6e05\u9664\u641c\u7d22',
        onlineMore: '\u5176\u4ed6\u5728\u7ebf\u64cd\u4f5c',
        allOnlineSources: '\u5168\u90e8\u97f3\u6e90',
        onlineNoSource: '\u6682\u65e0\u53ef\u7528\u7684\u5728\u7ebf\u97f3\u6e90',
        onlineNoResult: '\u6682\u65e0\u5728\u7ebf\u6b4c\u66f2',
        onlineSources: '\u4e2a\u97f3\u6e90',
        songs: '\u9996',
        saveToLibraryShort: '\u4fdd\u5b58\u5230\u8bed\u97f3\u5e93',
        search: '\u641c\u7d22',
        searchLoading: '\u641c\u7d22\u4e2d',
        contentLoading: '\u52a0\u8f7d\u5728\u7ebf\u5185\u5bb9\u4e2d',
        recommend: '\u63a8\u8350',
        charts: '\u6392\u884c\u699c',
        playlists: '\u6b4c\u5355',
        hot: '\u6700\u70ed',
        latest: '\u6700\u65b0',
        backToList: '\u8fd4\u56de\u5217\u8868',
        chartsCount: '\u4e2a\u699c\u5355',
        playlistsCount: '\u4e2a\u6b4c\u5355',
        convertSend: '\u8f6c\u6362\u53d1\u9001',
        originalSend: '\u539f\u683c\u5f0f\u53d1\u9001'
    };
    const state = {
        root: null,
        host: null,
        items: [],
        folders: [],
        folder: '',
        parent: '',
        busy: false,
        statusTimer: 0,
        windowBlurHandler: null,
        moved: false,
        position: null,
        renderedItemStart: 0,
        renderedItemEnd: 0,
        listRenderFrame: 0,
        finishDrag: null,
        dragging: false,
        pendingLibraryPayload: undefined,
        pendingLibraryFrame: 0,
        pendingOnlineSearchPayload: undefined,
        playingRow: null,
        playerItem: null,
        playerQueue: [],
        selectedItemId: '',
        selectedItem: null,
        view: 'offline',
        offlineQuery: '',
        offlineSearchActive: false,
        onlineQuery: '',
        onlineSourceKey: '',
        onlineQuality: '320k',
        onlineSources: [],
        onlineSearchResults: [],
        onlineSearchContext: null,
        onlineSearchRequestId: '',
        onlineSection: 'recommend',
        onlineSort: 'hot',
        onlineBrowseItems: [],
        onlineBrowseContext: null,
        onlineBrowseRequestId: '',
        onlineHistory: null
    };

    function createElement(tagName, className = '', textContent) {
        const element = document.createElement(tagName);
        if (className) {
            element.className = className;
        }
        if (textContent !== undefined) {
            element.textContent = textContent;
        }
        return element;
    }

    function createButton(label, action, className = '', title = label) {
        const button = createElement('button', className, label);
        button.type = 'button';
        button.dataset.voiceAction = action;
        if (title) {
            button.title = title;
            button.setAttribute('aria-label', title);
        }
        return button;
    }

    function createIcon(name, className = '') {
        const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        icon.classList.add('qvlib-icon');
        if (className) {
            icon.classList.add(className);
        }
        icon.setAttribute('viewBox', '0 0 24 24');
        icon.setAttribute('fill', 'none');
        icon.setAttribute('stroke', 'currentColor');
        icon.setAttribute('stroke-width', '1.8');
        icon.setAttribute('stroke-linecap', 'round');
        icon.setAttribute('stroke-linejoin', 'round');
        icon.setAttribute('aria-hidden', 'true');
        icon.innerHTML = ICON_PATHS[name] || '';
        return icon;
    }

    function createIconButton(iconName, action, className, title) {
        const button = createButton('', action, className, title);
        button.append(createIcon(iconName));
        return button;
    }

    function createLabeledButton(iconName, label, action, className = '') {
        const button = createButton('', action, className, label);
        button.append(createIcon(iconName), createElement('span', '', label));
        return button;
    }

    function ensureStyle() {
        if (document.getElementById(STYLE_ID)) {
            return;
        }
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = String(options.cssText || '').replaceAll('${ROOT_ID}', ROOT_ID);
        document.head.append(style);
    }

    function formatClockTime(seconds) {
        const value = Math.max(0, Math.floor(Number(seconds) || 0));
        const minutes = Math.floor(value / 60);
        const rest = value % 60;
        return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
    }

    function formatDuration(seconds) {
        const value = Math.ceil(Number(seconds) || 0);
        return value > 0 ? formatClockTime(value) : TEXT.unknown;
    }

    function formatPlayerTime(seconds) {
        return formatClockTime(seconds);
    }

    function getFolderTitle(folder = '') {
        const parts = String(folder || '').split('/').filter(Boolean);
        return parts[parts.length - 1] || TEXT.library;
    }

    function normalizeFolderPath(folder = '') {
        return String(folder || '')
            .replace(/\\/g, '/')
            .split('/')
            .filter(Boolean)
            .join('/');
    }

    function getParentFolder(folder = '') {
        const parts = normalizeFolderPath(folder).split('/').filter(Boolean);
        parts.pop();
        return parts.join('/');
    }

    function getFolderOptionLabel(folder = '') {
        const normalized = normalizeFolderPath(folder);
        return normalized ? `${TEXT.library} / ${normalized.split('/').join(' / ')}` : TEXT.library;
    }

    function getLibraryItem(itemId) {
        return state.items.find(item => String(item.id) === String(itemId)) || null;
    }

    function normalizeSearchText(value) {
        return String(value || '').trim().toLocaleLowerCase();
    }

    function getOfflineDisplayItems() {
        const query = normalizeSearchText(state.offlineQuery);
        if (!query) {
            return state.items;
        }
        return state.items.filter(item => String(item?.title || '').toLocaleLowerCase().includes(query));
    }

    function mapOnlineSongs(results, context = {}) {
        return (Array.isArray(results) ? results : [])
            .map((result, index) => {
                const info = getSearchResultInfo(result);
                if (!info) {
                    return null;
                }
                const title = formatSearchResultTitle(result, info);
                const sourceId = String(result.toolboxSourceId || context.sourceId || '');
                const providerId = String(result.toolboxProviderId || context.providerId || '');
                const sourceKey = getOnlineSourceKey(sourceId, providerId);
                const sourceOption = getOnlineSourceOptions('musicUrl').find(option => option.value === sourceKey);
                const identity = String(info.id || info.songmid || info.hash || index);
                return {
                    id: `online:${encodeURIComponent(sourceKey)}:${encodeURIComponent(identity)}:${index}`,
                    kind: 'online',
                    title,
                    meta: [formatSearchResultMeta(result, info), String(result.toolboxSourceLabel || sourceOption?.label || '')]
                        .filter(Boolean)
                        .join(' \u00b7 '),
                    sourceLabel: String(result.toolboxSourceLabel || sourceOption?.label || ''),
                    sourceId,
                    providerId,
                    quality: String(result.toolboxQuality || context.quality || state.onlineQuality || '320k'),
                    result,
                    songInfo: info
                };
            })
            .filter(Boolean);
    }

    function getOnlineDisplayItems() {
        if (state.onlineSearchContext?.keyword) {
            return mapOnlineSongs(state.onlineSearchResults, state.onlineSearchContext);
        }
        const mode = String(state.onlineBrowseContext?.mode || '');
        if (mode === 'recommend' || mode === 'detail') {
            return mapOnlineSongs(state.onlineBrowseItems, state.onlineBrowseContext);
        }
        return (Array.isArray(state.onlineBrowseItems) ? state.onlineBrowseItems : []).map((item, index) => ({
            ...item,
            id: String(item.id || `online-collection-${index}`),
            kind: 'onlineCollection',
            title: String(item.title || TEXT.item),
            meta: String(item.subtitle || '')
        }));
    }

    function getDisplayItems() {
        return state.view === 'online' ? getOnlineDisplayItems() : getOfflineDisplayItems();
    }

    function getItem(itemId) {
        return getDisplayItems().find(item => String(item.id) === String(itemId)) || null;
    }

    function emit(action) {
        options.onAction?.({
            ...action,
            folder: action.folder ?? state.folder
        });
    }

    function updateDisabledState() {
        if (!state.root) {
            return;
        }
        state.root.querySelectorAll('[data-voice-action]').forEach(button => {
            const action = button.dataset.voiceAction;
            if (action === 'close') {
                button.disabled = false;
                return;
            }
            if (action === 'playerToggle') {
                const audio = state.root.querySelector('audio');
                button.disabled = !audio?.src;
                return;
            }
            if (action === 'playerPrevious' || action === 'playerNext') {
                button.disabled = state.busy || !getAdjacentPlayerItem(action === 'playerNext' ? 1 : -1);
                return;
            }
            if (action === 'sendMenu' && button.classList.contains('qvlib-player-send')) {
                const audio = state.root.querySelector('audio');
                button.disabled = state.busy || !audio?.src || !state.playerItem;
                return;
            }
            button.disabled = state.busy;
        });
        renderOnlineToolbar();
    }

    function setStatus(message = '', statusOptions = {}) {
        if (!state.root) {
            return;
        }
        if (Object.prototype.hasOwnProperty.call(statusOptions, 'disabled')) {
            state.busy = Boolean(statusOptions.disabled);
            if (state.busy) {
                closeItemMenu();
            }
            updateDisabledState();
        }
        clearTimeout(state.statusTimer);
        state.statusTimer = 0;
        if (state.root.hidden) {
            state.root.querySelector('.qvlib-toast')?.remove();
            return;
        }
        let toast = state.root.querySelector('.qvlib-toast');
        if (!message) {
            toast?.classList.remove('is-visible');
            if (toast) {
                setTimeout(() => {
                    if (!toast.classList.contains('is-visible')) {
                        toast.remove();
                    }
                }, 160);
            }
            return;
        }
        if (!toast) {
            toast = createElement('div', 'qvlib-toast');
            state.root.querySelector('.qvlib-shell')?.append(toast);
        }
        toast.textContent = message;
        toast.classList.toggle('is-error', Boolean(statusOptions.error));
        requestAnimationFrame(() => toast.classList.add('is-visible'));
        if (statusOptions.resetAfterMs) {
            state.statusTimer = setTimeout(() => setStatus(''), statusOptions.resetAfterMs);
        }
    }

    function closeDialog() {
        state.root?.querySelector('.qvlib-dialog-layer')?.remove();
    }

    function closeItemMenu(restoreFocus = false) {
        if (!state.root) {
            return false;
        }
        const menu = state.root.querySelector('.qvlib-item-menu');
        if (!menu) {
            return false;
        }
        const triggerId = menu.dataset.triggerId || '';
        const row = menu.dataset.voiceItemId
            ? Array.from(state.root.querySelectorAll('.qvlib-row')).find(candidate =>
                candidate.dataset.voiceItemId === menu.dataset.voiceItemId
            )
            : null;
        const trigger = triggerId
            ? state.root.querySelector(`[data-menu-trigger-id="${triggerId}"]`)
            : null;
        menu.remove();
        state.root.querySelectorAll('[aria-haspopup="menu"][aria-expanded="true"]').forEach(button => {
            button.setAttribute('aria-expanded', 'false');
        });
        if (restoreFocus) {
            trigger?.focus?.();
        }
        row?.classList.remove('is-menu-open');
        return true;
    }

    function releasePointerActionFocus() {
        const activeElement = document.activeElement;
        if (activeElement?.matches?.('.qvlib-more') && state.root?.contains(activeElement) &&
            !state.root.querySelector('.qvlib-item-menu')) {
            activeElement.blur?.();
        }
    }

    function setSelectedItem(itemId = '') {
        const item = state.view === 'offline' ? getLibraryItem(itemId) : null;
        state.selectedItem = item && item.kind !== 'folder'
            ? { ...item, parentPath: item.parentPath ?? state.folder }
            : null;
        state.selectedItemId = state.selectedItem ? String(state.selectedItem.id) : '';
        for (const row of state.root?.querySelectorAll('.qvlib-row') || []) {
            const selected = Boolean(state.selectedItemId) && row.dataset.voiceItemId === state.selectedItemId;
            if (row.classList.contains('is-file')) {
                row.querySelector('.qvlib-primary')?.setAttribute('aria-pressed', String(selected));
            }
        }
        syncPlayingRows();
        updateDisabledState();
    }

    function getPlayingItemId() {
        return String(state.playerItem?.id || '');
    }

    function setPlayerItem(item = null) {
        state.playerItem = item ? { ...item, id: String(item.id || '') } : null;
        syncViewLayout();
        syncPlayingRows();
        updateDisabledState();
    }

    function isPlayerQueueItem(item) {
        return item?.kind === 'online' || (item?.kind && !['folder', 'onlineCollection'].includes(item.kind));
    }

    function capturePlayerQueue(item) {
        const playbackKind = item?.kind === 'online' ? 'online' : 'library';
        const queue = getDisplayItems()
            .filter(isPlayerQueueItem)
            .map(entry => ({ ...entry, playbackKind: entry.kind === 'online' ? 'online' : 'library' }));
        if (item && !queue.some(entry => String(entry.id) === String(item.id))) {
            queue.push({ ...item, playbackKind });
        }
        state.playerQueue = queue;
    }

    function getAdjacentPlayerItem(direction) {
        const queue = Array.isArray(state.playerQueue) ? state.playerQueue : [];
        const currentId = String(state.playerItem?.id || '');
        const currentIndex = queue.findIndex(item => String(item.id) === currentId);
        const nextIndex = currentIndex + (direction > 0 ? 1 : -1);
        return currentIndex >= 0 && nextIndex >= 0 && nextIndex < queue.length
            ? queue[nextIndex]
            : null;
    }

    function preparePlayerItem(item, options = {}) {
        if (!item) {
            return false;
        }
        if (options.preserveQueue !== true) {
            capturePlayerQueue(item);
        }
        const audio = state.root?.querySelector('.qvlib-player audio');
        const title = state.root?.querySelector('.qvlib-player-title');
        audio?.pause?.();
        audio?.removeAttribute?.('src');
        audio?.load?.();
        setPlayerItem({
            ...item,
            playbackKind: item.playbackKind || (item.kind === 'online' ? 'online' : 'library')
        });
        if (title) {
            title.textContent = item.title || TEXT.item;
        }
        syncPlayer();
        return true;
    }

    function playAdjacentPlayerItem(direction) {
        const item = getAdjacentPlayerItem(direction);
        if (!item) {
            syncPlayer();
            return false;
        }
        if (item.playbackKind === 'online' || item.kind === 'online') {
            previewOnlineResult(item, { preserveQueue: true });
        } else {
            previewLibraryItem(item, { preserveQueue: true });
        }
        return true;
    }

    function showItemMenu(itemId, anchor = null, point = null, options = {}) {
        const shell = state.root?.querySelector('.qvlib-shell');
        const item = options.item || getItem(itemId);
        if (!shell || !item || state.busy) {
            return;
        }
        closeItemMenu();
        const menu = createElement('div', 'qvlib-item-menu');
        menu.setAttribute('role', 'menu');
        menu.setAttribute('aria-label', `${item.title || TEXT.item} ${TEXT.more}`);
        menu.dataset.voiceItemId = String(item.id);
        const row = Array.from(state.root.querySelectorAll('.qvlib-row')).find(candidate =>
            candidate.dataset.voiceItemId === String(item.id)
        );
        row?.classList.add('is-menu-open');
        const menuTrigger = anchor?.matches?.('[aria-haspopup="menu"]')
            ? anchor
            : row?.querySelector('.qvlib-more');
        const triggerId = menuTrigger?.dataset?.menuTriggerId || '';
        if (triggerId) {
            menu.dataset.triggerId = triggerId;
            menuTrigger.setAttribute('aria-expanded', 'true');
        }
        const sendSpecs = item.kind === 'ptt'
            ? [[TEXT.send, 'sendWithMode', 'send', '', 'convert']]
            : [
                [TEXT.convertSend, 'sendWithMode', 'send', '', 'convert'],
                [TEXT.originalSend, 'sendWithMode', 'fileAudio', '', 'original']
            ];
        const specs = options.sendOnly
            ? sendSpecs
            : item.kind === 'online'
            ? [
                [TEXT.play, 'previewOnline', 'play', ''],
                ...sendSpecs,
                [TEXT.saveToLibraryShort, 'saveOnlineResult', 'download', '']
            ]
            : item.kind === 'folder'
            ? [
                [TEXT.move, 'moveLibrary', 'moveTo', ''],
                [TEXT.rename, 'renameLibrary', 'rename', ''],
                [TEXT.remove, 'deleteLibrary', 'delete', 'qvlib-menu-delete']
            ]
            : [
                ...sendSpecs,
                [TEXT.play, 'previewLibrary', 'play', ''],
                [TEXT.move, 'moveLibrary', 'moveTo', ''],
                [TEXT.rename, 'renameLibrary', 'rename', ''],
                [TEXT.remove, 'deleteLibrary', 'delete', 'qvlib-menu-delete']
            ];
        for (const [label, action, iconName, className, sendMode] of specs) {
            const button = createLabeledButton(
                iconName,
                label,
                action,
                `qvlib-menu-item ${className}`.trim()
            );
            button.dataset.voiceItemId = item.id;
            if (sendMode) {
                button.dataset.sendMode = sendMode;
                button.dataset.sendSource = options.source || 'item';
            }
            button.setAttribute('role', 'menuitem');
            menu.append(button);
        }
        menu.addEventListener('keydown', event => {
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                return;
            }
            const entries = Array.from(menu.querySelectorAll('[role="menuitem"]'));
            const currentIndex = Math.max(0, entries.indexOf(document.activeElement));
            const nextIndex = event.key === 'Home'
                ? 0
                : event.key === 'End'
                    ? entries.length - 1
                    : (currentIndex + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length;
            event.preventDefault();
            event.stopPropagation();
            entries[nextIndex]?.focus?.();
        });
        menu.addEventListener('focusout', () => {
            requestAnimationFrame(() => {
                if (!menu.isConnected || menu.contains(document.activeElement)) {
                    return;
                }
                const activeTrigger = menu.dataset.triggerId
                    ? state.root?.querySelector(`[data-menu-trigger-id="${menu.dataset.triggerId}"]`)
                    : null;
                if (document.activeElement !== activeTrigger) {
                    closeItemMenu();
                }
            });
        });
        shell.append(menu);
        const shellRect = shell.getBoundingClientRect();
        const anchorRect = anchor?.getBoundingClientRect?.() || null;
        const menuWidth = menu.offsetWidth || 132;
        const menuHeight = menu.offsetHeight || specs.length * 34 + 8;
        const margin = 8;
        const originLeft = point
            ? Number(point.clientX) - shellRect.left
            : Number(anchorRect?.right) - shellRect.left - menuWidth;
        let top = point
            ? Number(point.clientY) - shellRect.top
            : Number(anchorRect?.bottom) - shellRect.top + 4;
        const availableWidth = shell.clientWidth || shellRect.width;
        const availableHeight = shell.clientHeight || shellRect.height;
        const left = Math.min(
            Math.max(margin, availableWidth - menuWidth - margin),
            Math.max(margin, Number.isFinite(originLeft) ? originLeft : margin)
        );
        if (top + menuHeight > availableHeight - margin) {
            top = point
                ? Number(point.clientY) - shellRect.top - menuHeight
                : Number(anchorRect?.top) - shellRect.top - menuHeight - 4;
        }
        menu.style.left = `${left}px`;
        menu.style.top = `${Math.max(margin, top)}px`;
        menu.querySelector('[role="menuitem"]')?.focus?.();
    }

    function toggleItemMenu(itemId, control, options = {}) {
        const triggerId = control?.dataset?.menuTriggerId || '';
        const openMenu = state.root?.querySelector('.qvlib-item-menu');
        if (triggerId && openMenu?.dataset?.triggerId === triggerId) {
            closeItemMenu(true);
            return false;
        }
        showItemMenu(itemId, control, null, options);
        return true;
    }

    function showDialog(dialogOptions = {}) {
        const shell = state.root?.querySelector('.qvlib-shell');
        if (!shell) {
            return;
        }
        closeDialog();
        const layer = createElement('div', 'qvlib-dialog-layer');
        const form = createElement('form', 'qvlib-dialog');
        const title = createElement('div', 'qvlib-dialog-title', dialogOptions.title || '');
        form.append(title);
        if (dialogOptions.message) {
            form.append(createElement('div', 'qvlib-dialog-message', dialogOptions.message));
        }
        let input = null;
        let select = null;
        const fields = {};
        if (Array.isArray(dialogOptions.fields)) {
            for (const fieldOptions of dialogOptions.fields) {
                if (!fieldOptions?.name) {
                    continue;
                }
                const field = createElement('label', 'qvlib-dialog-field');
                if (fieldOptions.label) {
                    field.append(createElement('span', 'qvlib-dialog-field-label', fieldOptions.label));
                }
                let control;
                if (fieldOptions.type === 'select') {
                    control = createElement('select');
                    for (const optionSpec of fieldOptions.options || []) {
                        const option = createElement('option');
                        option.value = String(optionSpec?.value ?? '');
                        option.textContent = String(optionSpec?.label ?? option.value);
                        control.append(option);
                    }
                } else if (fieldOptions.type === 'textarea') {
                    control = createElement('textarea');
                    control.rows = Math.max(2, Math.min(10, Number(fieldOptions.rows) || 4));
                } else {
                    control = createElement('input');
                    control.type = fieldOptions.type || 'text';
                }
                control.value = String(fieldOptions.value ?? '');
                control.maxLength = Math.max(1, Number(fieldOptions.maxLength) || 80);
                if (fieldOptions.placeholder) {
                    control.placeholder = fieldOptions.placeholder;
                }
                control.setAttribute('aria-label', fieldOptions.label || fieldOptions.name);
                field.append(control);
                form.append(field);
                fields[fieldOptions.name] = control;
            }
        } else if (dialogOptions.inputValue !== undefined) {
            input = createElement('input');
            input.value = dialogOptions.inputValue || '';
            input.maxLength = 80;
            form.append(input);
        }
        if (Array.isArray(dialogOptions.selectOptions)) {
            select = createElement('select');
            select.setAttribute('aria-label', dialogOptions.selectLabel || dialogOptions.title || '');
            for (const optionSpec of dialogOptions.selectOptions) {
                const option = createElement('option');
                option.value = String(optionSpec?.value ?? '');
                option.textContent = String(optionSpec?.label ?? option.value);
                select.append(option);
            }
            form.append(select);
        }
        const actions = createElement('div', 'qvlib-dialog-actions');
        const cancel = createElement('button', '', TEXT.cancel);
        cancel.type = 'button';
        cancel.addEventListener('click', closeDialog);
        const readValues = () => Object.keys(fields).length
            ? Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, String(field.value || '').trim()]))
            : (input || select)?.value.trim() ?? '';
        for (const secondary of dialogOptions.secondaryActions || []) {
            if (!secondary?.label || typeof secondary.onClick !== 'function') {
                continue;
            }
            const button = createElement('button', 'qvlib-dialog-secondary', secondary.label);
            button.type = 'button';
            button.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                secondary.onClick(readValues(), button);
            });
            actions.append(button);
        }
        const confirm = createElement(
            'button',
            `qvlib-dialog-confirm${dialogOptions.danger ? ' is-danger' : ''}`,
            dialogOptions.confirmText || TEXT.confirm
        );
        confirm.type = 'submit';
        form.addEventListener('submit', event => {
            event.preventDefault();
            event.stopPropagation();
            dialogOptions.onConfirm?.(readValues());
        });
        actions.append(cancel, confirm);
        form.append(actions);
        layer.append(form);
        layer.addEventListener('pointerdown', event => {
            if (event.target === layer) {
                closeDialog();
            }
        });
        shell.append(layer);
        const firstField = Object.values(fields)[0] || input || select;
        if (firstField) {
            firstField.focus();
            if (firstField === input) {
                input.select?.();
            }
        } else {
            cancel.focus();
        }
    }

    function showRenameDialog(item) {
        showDialog({
            title: TEXT.rename,
            inputValue: item.title || '',
            onConfirm: nextTitle => {
                if (!nextTitle) {
                    setStatus(TEXT.emptyName, { error: true, resetAfterMs: 1600 });
                    return;
                }
                closeDialog();
                setStatus(TEXT.renaming, { disabled: true });
                emit({
                    type: 'renameLibrary',
                    id: item.id,
                    title: nextTitle,
                    selectedItemId: state.selectedItemId
                });
            }
        });
    }

    function showCreateFolderDialog() {
        showDialog({
            title: TEXT.newFolder,
            inputValue: '',
            onConfirm: title => {
                if (!title) {
                    setStatus(TEXT.emptyName, { error: true, resetAfterMs: 1600 });
                    return;
                }
                closeDialog();
                setStatus(TEXT.creatingFolder, { disabled: true });
                emit({ type: 'createLibraryFolder', title });
            }
        });
    }

    function sourceSupportsAction(info, action) {
        const actions = Array.isArray(info?.actions)
            ? info.actions
            : typeof info?.actions === 'string'
                ? info.actions.split(/[\s,|]+/).filter(Boolean)
                : [];
        return action === 'search'
            ? (actions.includes('search') || actions.includes('musicSearch')) && actions.includes('musicUrl')
            : actions.includes(action);
    }

    function getOnlineSourceOptions(requiredAction = 'musicUrl') {
        return state.onlineSources.flatMap(source => {
            const providers = Object.entries(source?.sources || {})
                .filter(([, info]) => info?.type === 'music' && sourceSupportsAction(info, 'musicUrl'))
                .map(([providerId, info]) => ({
                    value: `${source.id}|${providerId}`,
                    label: `${source.name || source.id} / ${ONLINE_PROVIDER_LABELS[providerId] || info.name || providerId}`,
                    qualitys: Array.isArray(info.qualitys) ? info.qualitys : [],
                    supportsSearch: sourceSupportsAction(info, 'search')
                }))
                .filter(option => requiredAction !== 'search' || option.supportsSearch);
            if (providers.length) {
                return providers;
            }
            return requiredAction === 'musicUrl'
                ? [{
                    value: `${source.id}|`,
                    label: source.name || source.id,
                    qualitys: []
                }]
                : [];
        });
    }

    function getOnlineSourceKey(sourceId, providerId) {
        return `${String(sourceId || '')}|${String(providerId || '')}`;
    }

    function isOnlineSearchContextAvailable(context) {
        const availableKeys = new Set(getOnlineSourceOptions('search').map(option => option.value));
        const targets = Array.isArray(context?.targets) ? context.targets : [];
        if (targets.length) {
            return targets.some(target => availableKeys.has(getOnlineSourceKey(target?.sourceId, target?.providerId)));
        }
        if (!context?.sourceId || !context?.providerId) {
            return false;
        }
        return availableKeys.has(getOnlineSourceKey(context.sourceId, context.providerId));
    }

    function isOnlineBrowseContextAvailable(context) {
        if (!context) {
            return false;
        }
        const availableKeys = new Set(getOnlineSourceOptions('musicUrl').map(option => option.value));
        const collection = context.collection && typeof context.collection === 'object'
            ? context.collection
            : null;
        if (collection?.sourceId && collection?.providerId) {
            return availableKeys.has(getOnlineSourceKey(collection.sourceId, collection.providerId));
        }
        const targets = Array.isArray(context.targets) ? context.targets : [];
        return targets.some(target =>
            availableKeys.has(getOnlineSourceKey(target?.sourceId, target?.providerId))
        );
    }

    function filterAvailableOnlineBrowseItems(items) {
        const availableKeys = new Set(getOnlineSourceOptions('musicUrl').map(option => option.value));
        return (Array.isArray(items) ? items : []).filter(item => {
            const sourceId = item?.toolboxSourceId || item?.sourceId;
            const providerId = item?.toolboxProviderId || item?.providerId;
            return availableKeys.has(getOnlineSourceKey(sourceId, providerId));
        });
    }

    function invalidateOnlineSearchRequest(prefix = 'online') {
        state.onlineSearchRequestId = `${prefix}-${makeSearchRequestId()}`;
    }

    function invalidateOnlineBrowseRequest(prefix = 'browse') {
        state.onlineBrowseRequestId = `${prefix}-${makeSearchRequestId()}`;
    }

    function formatSearchResultTitle(result = {}, info = {}) {
        return String(
            result.title || result.name || info.songName || info.name || info.title || info.id || TEXT.item
        ).trim() || TEXT.item;
    }

    function formatSearchResultMeta(result = {}, info = {}) {
        const artistValue = result.artist || result.artists || result.singer ||
            info.artist || info.artists || info.singer;
        const artist = Array.isArray(artistValue)
            ? artistValue.map(item => typeof item === 'object' ? item.name : item).filter(Boolean).join(', ')
            : String(artistValue || '').trim();
        const album = String(result.album || info.album || '').trim();
        const duration = Number(result.duration || info.duration || info.durationMs || 0);
        return [artist, album, duration > 0 ? formatDuration(duration > 1000 ? duration / 1000 : duration) : '']
            .filter(Boolean)
            .join(' \u00b7 ') || TEXT.online;
    }

    function getSearchResultInfo(result = {}) {
        const info = result.musicInfo && typeof result.musicInfo === 'object'
            ? result.musicInfo
            : result.info && typeof result.info === 'object'
                ? result.info
                : result;
        if (!info || typeof info !== 'object' || Array.isArray(info)) {
            return null;
        }
        return info;
    }

    function getSearchResultProvider(result, context = {}, songInfo = {}) {
        const candidates = [
            result?.providerId,
            result?.provider,
            result?.sourceId,
            result?.source,
            songInfo?.providerId,
            songInfo?.provider,
            songInfo?.sourceId,
            songInfo?.source,
            context.providerId
        ].map(value => String(value || '').trim()).filter(Boolean);
        const source = state.onlineSources.find(item => String(item?.id || '') === String(context.sourceId || ''));
        const declaredProviders = new Set(Object.keys(source?.sources || {}));
        return candidates.find(candidate => declaredProviders.has(candidate)) || String(context.providerId || '');
    }

    function makeSearchRequestId() {
        return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    }

    function getSelectedOnlineSourceOption(requiredAction = 'musicUrl') {
        const options = getOnlineSourceOptions(requiredAction);
        if (!options.length) {
            return null;
        }
        return options.find(option => option.value === state.onlineSourceKey) || null;
    }

    function getOnlineCatalogTargets() {
        const supported = new Set(['tx', 'wy']);
        const options = getOnlineSourceOptions('musicUrl').filter(option => {
            const providerId = String(option.value || '').split('|')[1] || '';
            return supported.has(providerId);
        });
        const selected = getSelectedOnlineSourceOption('musicUrl');
        const selectedProvider = String(selected?.value || '').split('|')[1] || '';
        const selectedOptions = selected && supported.has(selectedProvider) ? [selected] : options;
        const seenProviders = new Set();
        return selectedOptions.map(option => {
            const [sourceId, providerId] = String(option.value || '').split('|');
            return { sourceId, providerId, label: option.label };
        }).filter(target => {
            if (!target.sourceId || !target.providerId || seenProviders.has(target.providerId)) {
                return false;
            }
            seenProviders.add(target.providerId);
            return true;
        });
    }

    function requestOnlineBrowse(options = {}) {
        const mode = options.mode || state.onlineSection || 'recommend';
        const targets = options.collection
            ? [{
                sourceId: String(options.collection.sourceId || ''),
                providerId: String(options.collection.providerId || ''),
                label: String(options.collection.sourceLabel || '')
            }]
            : getOnlineCatalogTargets();
        if (!targets.length) {
            state.onlineBrowseItems = [];
            state.onlineBrowseContext = { mode, sort: state.onlineSort };
            renderList(true);
            return;
        }
        const requestId = makeSearchRequestId();
        state.onlineBrowseRequestId = requestId;
        state.onlineBrowseItems = [];
        state.onlineBrowseContext = {
            requestId,
            mode,
            sort: state.onlineSort,
            targets,
            collection: options.collection || null
        };
        state.onlineSearchResults = [];
        state.onlineSearchContext = null;
        renderOnlineNavigation();
        renderList(true);
        setStatus(TEXT.contentLoading, { disabled: false });
        emit({
            type: 'browseOnlineCatalog',
            requestId,
            targets,
            mode,
            sort: state.onlineSort,
            collection: options.collection || null,
            page: 1,
            limit: mode === 'detail' ? 50 : (mode === 'recommend' ? 16 : 24)
        });
    }

    function requestOnlineSearch(options = {}) {
        const searchOptions = getOnlineSourceOptions('search');
        const option = getSelectedOnlineSourceOption('search');
        const keyword = String(state.onlineQuery || '').trim();
        const selectedOptions = option ? [option] : searchOptions;
        const recommend = options.recommend === true && !keyword;
        if (!selectedOptions.length || (!keyword && !recommend)) {
            renderOnlineToolbar();
            if (!keyword && !recommend) {
                return;
            }
            renderList(true);
            return;
        }
        const targets = selectedOptions.map(target => {
            const [sourceId, providerId] = String(target.value || '').split('|');
            return { sourceId, providerId, label: target.label };
        }).filter(target => target.sourceId && target.providerId);
        const requestId = makeSearchRequestId();
        state.onlineSearchContext = { requestId, targets };
        state.onlineSearchRequestId = requestId;
        state.onlineSearchResults = [];
        state.onlineBrowseItems = [];
        state.onlineBrowseContext = null;
        state.onlineHistory = null;
        renderList(true);
        setStatus(TEXT.searchLoading, { disabled: true });
        emit({
            type: 'searchOnlineSources',
            requestId,
            targets,
            keyword,
            recommend,
            quality: state.onlineQuality || '320k',
            resultAction: 'send',
            page: 1,
            limit: recommend ? 24 : 50
        });
    }

    function performOnlineResultAction(item, action, sendMode = 'convert') {
        if (!item?.songInfo || !item.sourceId || !item.providerId) {
            setStatus(TEXT.missing, { error: true, resetAfterMs: 1600 });
            return;
        }
        const save = action === 'save';
        setStatus(save ? TEXT.loading : TEXT.sending, save ? { disabled: true } : {});
        emit({
            type: save ? 'downloadOnlineAudio' : 'sendOnlineAudio',
            sourceId: item.sourceId,
            providerId: getSearchResultProvider(item.result, item, item.songInfo),
            songInfo: item.songInfo,
            quality: item.quality || state.onlineQuality || '320k',
            title: item.title || '',
            ...(save ? {} : { sendMode })
        });
    }

    function previewOnlineResult(item, options = {}) {
        if (!item?.songInfo || !item.sourceId || !item.providerId) {
            setStatus(TEXT.missing, { error: true, resetAfterMs: 1600 });
            return;
        }
        preparePlayerItem({ ...item, playbackKind: 'online' }, options);
        setStatus(TEXT.loading, { disabled: true });
        emit({
            type: 'previewOnlineAudio',
            id: item.id,
            sourceId: item.sourceId,
            providerId: getSearchResultProvider(item.result, item, item.songInfo),
            songInfo: item.songInfo,
            quality: item.quality || state.onlineQuality || '320k',
            title: item.title || ''
        });
    }

    function showMoveDialog(item) {
        const sourcePath = normalizeFolderPath(item.relativePath || '');
        const currentParent = normalizeFolderPath(item.parentPath ?? state.folder);
        const folders = Array.from(new Set(state.folders.map(normalizeFolderPath)))
            .filter(folder => folder !== currentParent)
            .filter(folder => item.kind !== 'folder' || (
                folder !== sourcePath && !folder.startsWith(`${sourcePath}/`)
            ));
        if (!folders.length) {
            setStatus(TEXT.noMoveTarget, { error: true, resetAfterMs: 1800 });
            return;
        }
        showDialog({
            title: `${TEXT.moveTo} ${item.title || TEXT.item}`,
            selectLabel: TEXT.moveTo,
            selectOptions: folders.map(folder => ({
                value: folder,
                label: getFolderOptionLabel(folder)
            })),
            onConfirm: targetFolder => {
                closeDialog();
                setStatus(TEXT.moving, { disabled: true });
                emit({
                    type: 'moveLibrary',
                    id: item.id,
                    targetFolder,
                    selectedItemId: state.selectedItemId
                });
            }
        });
    }

    function selectionIsAffectedBy(item) {
        if (!state.selectedItem || !item) {
            return false;
        }
        if (String(state.selectedItem.id) === String(item.id)) {
            return true;
        }
        if (item.kind !== 'folder') {
            return false;
        }
        const folderPath = normalizeFolderPath(item.relativePath || '');
        const selectedPath = normalizeFolderPath(state.selectedItem.relativePath || '');
        return Boolean(folderPath && selectedPath.startsWith(`${folderPath}/`));
    }

    function showDeleteDialog(item) {
        const isFolder = item.kind === 'folder';
        showDialog({
            title: isFolder ? TEXT.deleteFolderTitle : TEXT.deleteTitle,
            message: `${item.title || TEXT.item}\n${isFolder ? TEXT.deleteFolderMessage : TEXT.deleteMessage}`,
            confirmText: TEXT.remove,
            danger: true,
            onConfirm: () => {
                closeDialog();
                if (selectionIsAffectedBy(item)) {
                    resetPlayer();
                    setSelectedItem('');
                }
                setStatus(TEXT.deleting, { disabled: true });
                emit({ type: 'deleteLibrary', id: item.id });
            }
        });
    }

    function isAudioPlaying(audio) {
        return Boolean(audio?.src && !audio.paused && !audio.ended);
    }

    function syncPlayingRows() {
        const audio = state.root?.querySelector('.qvlib-player audio');
        const isPlaying = isAudioPlaying(audio);
        let playingRow = null;
        const playingItemId = getPlayingItemId();
        if (isPlaying && playingItemId) {
            const cachedRow = state.playingRow;
            playingRow = cachedRow?.isConnected &&
                cachedRow.dataset.voiceItemId === playingItemId
                ? cachedRow
                : Array.from(state.root?.querySelectorAll('.qvlib-row.is-file') || [])
                    .find(row => row.dataset.voiceItemId === playingItemId) || null;
        }
        if (state.playingRow && state.playingRow !== playingRow) {
            state.playingRow.classList.remove('is-playing');
        }
        playingRow?.classList.add('is-playing');
        state.playingRow = playingRow;
    }

    function syncPlayer() {
        const player = state.root?.querySelector('.qvlib-player');
        const audio = player?.querySelector('audio');
        const track = player?.querySelector('.qvlib-track');
        const time = player?.querySelector('.qvlib-player-time');
        const toggle = player?.querySelector('[data-voice-action="playerToggle"]');
        const previous = player?.querySelector('[data-voice-action="playerPrevious"]');
        const next = player?.querySelector('[data-voice-action="playerNext"]');
        const send = player?.querySelector('[data-voice-action="sendMenu"]');
        if (!player || !audio || !track || !time || !toggle) {
            return;
        }
        const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
        const current = duration ? Math.min(audio.currentTime || 0, duration) : 0;
        const progress = duration ? Math.min(100, Math.max(0, current / duration * 100)) : 0;
        player.classList.toggle('is-ready', duration > 0);
        track.style.setProperty('--voice-progress', `${progress}%`);
        track.setAttribute('aria-valuenow', String(Math.round(progress)));
        track.setAttribute('aria-disabled', String(duration <= 0));
        track.tabIndex = duration > 0 ? 0 : -1;
        const timeText = duration
            ? `${formatPlayerTime(current)} / ${formatPlayerTime(duration)}`
            : formatPlayerTime(0);
        track.setAttribute('aria-valuetext', timeText);
        time.textContent = timeText;
        const isPlaying = isAudioPlaying(audio);
        toggle.dataset.playing = String(isPlaying);
        toggle.title = isPlaying ? TEXT.pause : TEXT.play;
        toggle.setAttribute('aria-label', toggle.title);
        toggle.disabled = !audio.src;
        if (previous) {
            previous.disabled = state.busy || !getAdjacentPlayerItem(-1);
        }
        if (next) {
            next.disabled = state.busy || !getAdjacentPlayerItem(1);
        }
        if (send) {
            send.disabled = state.busy || !audio.src || !state.playerItem;
        }
        syncPlayingRows();
    }

    function resetPlayer() {
        const player = state.root?.querySelector('.qvlib-player');
        const audio = player?.querySelector('audio');
        const title = player?.querySelector('.qvlib-player-title');
        if (!audio) {
            return;
        }
        audio.pause?.();
        audio.removeAttribute('src');
        audio.load?.();
        state.playerItem = null;
        state.playerQueue = [];
        if (title) {
            title.textContent = TEXT.notPlaying;
        }
        syncPlayer();
        syncViewLayout();
    }

    function seekPlayer(event) {
        const player = state.root?.querySelector('.qvlib-player');
        const audio = player?.querySelector('audio');
        const track = player?.querySelector('.qvlib-track');
        const duration = Number.isFinite(audio?.duration) && audio.duration > 0 ? audio.duration : 0;
        const rect = track?.getBoundingClientRect?.();
        if (!audio || !track || !duration || !rect?.width) {
            return;
        }
        const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
        audio.currentTime = duration * ratio;
        syncPlayer();
    }

    function createPlayer() {
        const player = createElement('div', 'qvlib-player');
        const title = createElement('div', 'qvlib-player-title', TEXT.notPlaying);
        const time = createElement('div', 'qvlib-player-time', formatPlayerTime(0));
        const controls = createElement('div', 'qvlib-player-controls');
        const previous = createIconButton('previous', 'playerPrevious', 'qvlib-player-skip', TEXT.previous);
        const toggle = createButton('', 'playerToggle', 'qvlib-player-toggle', TEXT.play);
        toggle.dataset.playing = 'false';
        const next = createIconButton('next', 'playerNext', 'qvlib-player-skip', TEXT.next);
        controls.append(previous, toggle, next);
        const send = createIconButton('send', 'sendMenu', 'qvlib-player-send', TEXT.send);
        send.dataset.menuTriggerId = 'qvlib-player-send-menu';
        send.setAttribute('aria-haspopup', 'menu');
        send.setAttribute('aria-expanded', 'false');
        const track = createElement('div', 'qvlib-track');
        track.setAttribute('role', 'slider');
        track.setAttribute('aria-label', TEXT.progress);
        track.setAttribute('aria-valuemin', '0');
        track.setAttribute('aria-valuemax', '100');
        track.tabIndex = 0;
        const progress = createElement('div', 'qvlib-progress');
        const thumb = createElement('div', 'qvlib-thumb');
        const audio = document.createElement('audio');
        audio.preload = 'metadata';
        track.append(progress, thumb);
        player.append(title, time, controls, track, send, audio);
        for (const eventName of ['loadedmetadata', 'timeupdate', 'play', 'pause']) {
            audio.addEventListener(eventName, syncPlayer);
        }
        audio.addEventListener('ended', () => {
            syncPlayer();
            playAdjacentPlayerItem(1);
        });
        track.addEventListener('pointerdown', event => {
            event.preventDefault();
            track.setPointerCapture?.(event.pointerId);
            seekPlayer(event);
        });
        track.addEventListener('pointermove', event => {
            if (event.buttons === 1) {
                seekPlayer(event);
            }
        });
        track.addEventListener('pointerup', event => {
            if (track.hasPointerCapture?.(event.pointerId)) {
                track.releasePointerCapture(event.pointerId);
            }
            syncPlayer();
        });
        track.addEventListener('keydown', event => {
            if (!Number.isFinite(audio.duration) || audio.duration <= 0) {
                return;
            }
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                return;
            }
            event.preventDefault();
            if (event.key === 'Home') {
                audio.currentTime = 0;
            } else if (event.key === 'End') {
                audio.currentTime = audio.duration;
            } else {
                audio.currentTime = Math.min(
                    audio.duration,
                    Math.max(0, audio.currentTime + (event.key === 'ArrowRight' ? 5 : -5))
                );
            }
            syncPlayer();
        });
        return player;
    }

    function renderNavigation() {
        const nav = state.root?.querySelector('.qvlib-nav');
        if (!nav) {
            return;
        }
        nav.hidden = state.view !== 'offline' || !state.folder;
        nav.replaceChildren();
        if (!state.folder) {
            return;
        }
        const back = createIconButton('chevronLeft', 'backFolder', 'qvlib-back', TEXT.back);
        const path = createElement('div', 'qvlib-path');
        path.append(
            createElement('div', 'qvlib-path-current', getFolderTitle(state.folder)),
            createElement('div', 'qvlib-path-parent', state.parent || TEXT.library)
        );
        nav.append(back, path);
    }

    function renderOnlineNavigation() {
        const navigation = state.root?.querySelector('.qvlib-online-navigation');
        if (!navigation) {
            return;
        }
        navigation.hidden = state.view !== 'online';
        navigation.replaceChildren();
        if (state.view !== 'online') {
            return;
        }
        const detail = state.onlineBrowseContext?.mode === 'detail';
        if (detail) {
            const back = createIconButton('chevronLeft', 'backOnlineCollection', 'qvlib-back', TEXT.backToList);
            const collection = state.onlineBrowseContext?.collection || {};
            const info = state.onlineBrowseContext?.info || {};
            const cover = createElement('span', 'qvlib-detail-cover');
            const coverUrl = String(info.coverUrl || collection.coverUrl || '');
            if (coverUrl) {
                const image = createElement('img');
                image.src = coverUrl;
                image.alt = '';
                image.loading = 'lazy';
                cover.append(image);
            } else {
                cover.append(createIcon(collection.collectionKind === 'chart' ? 'chart' : 'playlist'));
            }
            const heading = createElement('div', 'qvlib-detail-heading');
            heading.append(
                createElement('div', 'qvlib-detail-title', String(info.title || collection.title || TEXT.item)),
                createElement('div', 'qvlib-detail-subtitle', String(info.subtitle || collection.subtitle || ''))
            );
            navigation.append(back, cover, heading);
            return;
        }
        const tabs = createElement('div', 'qvlib-online-tabs');
        for (const [section, label] of [
            ['recommend', TEXT.recommend],
            ['charts', TEXT.charts],
            ['playlists', TEXT.playlists]
        ]) {
            const button = createButton(label, 'switchOnlineSection', 'qvlib-online-tab', label);
            button.dataset.onlineSection = section;
            const selected = state.onlineSection === section && !state.onlineSearchContext?.keyword;
            button.classList.toggle('is-active', selected);
            button.setAttribute('aria-pressed', String(selected));
            tabs.append(button);
        }
        const sort = createElement('div', 'qvlib-online-sort');
        for (const [value, label] of [['hot', TEXT.hot], ['new', TEXT.latest]]) {
            const button = createButton(label, 'setOnlineSort', 'qvlib-online-sort-button', label);
            button.dataset.onlineSort = value;
            const selected = state.onlineSort === value;
            button.classList.toggle('is-active', selected);
            button.setAttribute('aria-pressed', String(selected));
            sort.append(button);
        }
        sort.hidden = state.onlineSearchContext?.keyword || !['recommend', 'playlists'].includes(state.onlineSection);
        navigation.append(tabs, sort);
    }

    function renderViewControls() {
        const shell = state.root?.querySelector('.qvlib-shell');
        const title = state.root?.querySelector('.qvlib-title');
        const controls = state.root?.querySelector('.qvlib-view-controls');
        if (!shell || !title || !controls) {
            return;
        }
        const online = state.view === 'online';
        shell.classList.toggle('is-online-view', online);
        title.textContent = online ? TEXT.online : TEXT.offline;
        controls.querySelectorAll('[data-voice-view]').forEach(button => {
            const selected = button.dataset.voiceView === state.view;
            button.classList.toggle('is-active', selected);
            button.setAttribute('aria-pressed', String(selected));
        });
    }

    function renderOnlineToolbar() {
        const toolbar = state.root?.querySelector('.qvlib-online-toolbar');
        if (!toolbar) {
            return;
        }
        const online = state.view === 'online';
        toolbar.hidden = !online;
        if (!online) {
            return;
        }
        const sourceSelect = toolbar.querySelector('[data-online-source]');
        const sourceOptions = getOnlineSourceOptions('search');
        sourceSelect.replaceChildren();
        const allSourcesOption = createElement('option');
        allSourcesOption.value = '';
        allSourcesOption.textContent = TEXT.allOnlineSources;
        sourceSelect.append(allSourcesOption);
        for (const optionSpec of sourceOptions) {
            const option = createElement('option');
            option.value = optionSpec.value;
            option.textContent = optionSpec.label;
            sourceSelect.append(option);
        }
        const selected = getSelectedOnlineSourceOption('search');
        sourceSelect.value = selected?.value || '';
        sourceSelect.disabled = state.busy || sourceOptions.length === 0;
        const query = toolbar.querySelector('[data-online-query]');
        query.value = state.onlineQuery;
        query.disabled = state.busy || getOnlineSourceOptions('search').length === 0;
        const clearButton = toolbar.querySelector('[data-voice-action="clearOnlineSearch"]');
        clearButton.hidden = !state.onlineQuery;
        clearButton.disabled = query.disabled;
        const searchButton = toolbar.querySelector('[data-voice-action="searchOnline"]');
        searchButton.disabled = state.busy || getOnlineSourceOptions('search').length === 0 || !String(state.onlineQuery || '').trim();
    }

    function renderOfflineSearch() {
        const search = state.root?.querySelector('.qvlib-offline-search');
        if (!search) {
            return;
        }
        search.hidden = state.view !== 'offline' || !state.offlineSearchActive;
        const input = search.querySelector('[data-offline-query]');
        if (input) {
            input.value = state.offlineQuery;
        }
        const clearButton = search.querySelector('[data-voice-action="clearOfflineSearch"]');
        if (clearButton) {
            clearButton.hidden = !state.offlineQuery;
        }
    }

    function switchView(nextView) {
        const view = nextView === 'online' ? 'online' : 'offline';
        if (state.view === view) {
            if (view === 'online') {
                emit({ type: 'listOnlineSources' });
            }
            return;
        }
        closeItemMenu();
        state.view = view;
        invalidateOnlineSearchRequest('view');
        invalidateOnlineBrowseRequest('view');
        setSelectedItem('');
        renderViewControls();
        renderOnlineNavigation();
        syncViewLayout();
        renderOfflineSearch();
        renderOnlineToolbar();
        renderOnlineNavigation();
        renderList(true);
        if (view === 'online') {
            emit({ type: 'listOnlineSources' });
        }
    }

    function syncViewLayout() {
        const online = state.view === 'online';
        state.root?.querySelectorAll('.qvlib-library-only').forEach(element => {
            element.hidden = online;
        });
        const footer = state.root?.querySelector('.qvlib-footer');
        if (footer) {
            footer.hidden = online;
        }
    }

    function getItemMetaText(item) {
        if (item.kind === 'online') {
            return item.meta || TEXT.online;
        }
        if (item.kind === 'folder') {
            return `${Number(item.count) || 0} ${TEXT.items}`;
        }
        return formatDuration(item.duration);
    }

    function isOnlineCollectionView() {
        const mode = String(state.onlineBrowseContext?.mode || '');
        return state.view === 'online' && !state.onlineSearchContext?.keyword &&
            (mode === 'charts' || mode === 'playlists');
    }

    function createCollectionCard(item) {
        const card = createButton('', 'openOnlineCollection', 'qvlib-collection-card', `${TEXT.open} ${item.title || TEXT.item}`);
        card.dataset.voiceItemId = item.id;
        card.setAttribute('role', 'listitem');
        const artwork = createElement('span', 'qvlib-collection-artwork');
        if (item.coverUrl) {
            const image = createElement('img');
            image.src = item.coverUrl;
            image.alt = '';
            image.loading = 'lazy';
            artwork.append(image);
        } else {
            artwork.append(createIcon(item.collectionKind === 'chart' ? 'chart' : 'playlist'));
        }
        const text = createElement('span', 'qvlib-collection-text');
        const title = createElement('span', 'qvlib-collection-title', item.title || TEXT.item);
        title.title = item.title || TEXT.item;
        const meta = createElement('span', 'qvlib-collection-meta', item.meta || item.sourceLabel || TEXT.online);
        text.append(title, meta);
        card.append(artwork, text);
        return card;
    }

    function createListRow(item, itemIndex, playingItemId = '') {
        const isFolder = item.kind === 'folder';
        const isOnline = item.kind === 'online';
        const row = createElement(
            'div',
            `qvlib-row ${isFolder ? 'is-folder' : 'is-file'}${isOnline ? ' is-online' : ''}${item.kind === 'media' ? ' is-media' : ''}`
        );
        row.dataset.voiceItemId = item.id;
        row.dataset.voiceKind = isFolder ? 'folder' : (isOnline ? 'online' : 'file');
        row.dataset.voiceIndex = String(itemIndex);
        if (!isFolder && playingItemId === String(item.id)) {
            row.classList.add('is-playing');
        }
        row.setAttribute('role', 'listitem');
        const primary = createButton(
            '',
            isFolder ? 'openFolder' : (isOnline ? 'previewOnline' : 'previewLibrary'),
            'qvlib-primary',
            `${isFolder ? TEXT.open : TEXT.play} ${item.title || TEXT.item}`
        );
        primary.dataset.voiceItemId = item.id;
        if (!isFolder && !isOnline) {
            primary.setAttribute('aria-pressed', String(state.selectedItemId === String(item.id)));
        }
        const icon = createElement('span', 'qvlib-item-icon');
        icon.append(createIcon(isFolder ? 'folder' : (isOnline ? 'music' : 'fileAudio')));
        if (!isFolder) {
            const playingIndicator = createElement('span', 'qvlib-playing-indicator');
            playingIndicator.setAttribute('aria-hidden', 'true');
            for (let index = 0; index < 4; index++) {
                playingIndicator.append(createElement('span', 'qvlib-playing-bar'));
            }
            icon.append(playingIndicator);
        }
        const main = createElement('div', 'qvlib-main');
        const name = createElement('div', 'qvlib-name', item.title || TEXT.item);
        name.title = item.title || TEXT.item;
        main.append(name, createElement('div', 'qvlib-meta', getItemMetaText(item)));
        primary.append(icon, main);
        const actions = createElement('div', 'qvlib-actions');
        if (isOnline) {
            const send = createIconButton('send', 'sendMenu', 'qvlib-row-action', TEXT.send);
            send.dataset.voiceItemId = item.id;
            send.dataset.menuTriggerId = `qvlib-send-menu-${String(item.id).replace(/[^a-z0-9_-]/gi, '-')}`;
            send.setAttribute('aria-haspopup', 'menu');
            send.setAttribute('aria-expanded', 'false');
            const save = createIconButton('download', 'saveOnlineResult', 'qvlib-row-action', TEXT.saveToLibraryShort);
            save.dataset.voiceItemId = item.id;
            actions.append(send, save);
        }
        const more = createIconButton('more', 'itemMenu', 'qvlib-more', TEXT.more);
        more.dataset.voiceItemId = item.id;
        more.dataset.menuTriggerId = `qvlib-menu-${String(item.id).replace(/[^a-z0-9_-]/gi, '-')}`;
        more.setAttribute('aria-haspopup', 'menu');
        more.setAttribute('aria-expanded', 'false');
        actions.append(more);
        row.append(primary, actions);
        return row;
    }

    function getListRenderRange(itemCount, scrollTop, clientHeight) {
        const count = Math.max(0, Math.trunc(Number(itemCount)) || 0);
        if (!count) {
            return { start: 0, end: 0 };
        }
        const top = Math.max(0, Number(scrollTop) || 0);
        const viewportHeight = Math.max(
            ESTIMATED_LIST_ROW_HEIGHT,
            Number(clientHeight) || 0
        );
        const firstVisible = Math.min(
            count - 1,
            Math.floor(top / ESTIMATED_LIST_ROW_HEIGHT)
        );
        const visibleEnd = Math.min(
            count,
            Math.max(
                firstVisible + 1,
                Math.ceil((top + viewportHeight) / ESTIMATED_LIST_ROW_HEIGHT)
            )
        );
        const unalignedStart = Math.max(0, firstVisible - LIST_RENDER_OVERSCAN);
        let start = Math.floor(unalignedStart / LIST_RENDER_STEP) * LIST_RENDER_STEP;
        const end = Math.min(
            count,
            Math.max(start + LIST_MIN_RENDER_COUNT, visibleEnd + LIST_RENDER_OVERSCAN)
        );
        if (end === count && end - start < LIST_MIN_RENDER_COUNT) {
            start = Math.max(0, end - LIST_MIN_RENDER_COUNT);
        }
        return { start, end };
    }

    function createListSpacer(className, rowCount) {
        const spacer = createElement('div', `qvlib-list-spacer ${className}`);
        spacer.setAttribute('aria-hidden', 'true');
        spacer.style.height = `${Math.max(0, rowCount) * ESTIMATED_LIST_ROW_HEIGHT}px`;
        return spacer;
    }

    function renderListWindow(targetScrollTop = null, force = false) {
        const list = state.root?.querySelector('.qvlib-list');
        const displayItems = getDisplayItems();
        if (!list || !displayItems.length) {
            return;
        }
        const scrollTop = targetScrollTop === null
            ? list.scrollTop
            : Math.max(0, Number(targetScrollTop) || 0);
        const { start, end } = getListRenderRange(
            displayItems.length,
            scrollTop,
            list.clientHeight
        );
        if (!force && start === state.renderedItemStart && end === state.renderedItemEnd) {
            return;
        }
        const audio = state.root?.querySelector('.qvlib-player audio');
        const playingItemId = isAudioPlaying(audio) ? getPlayingItemId() : '';
        const fragment = document.createDocumentFragment();
        fragment.append(createListSpacer('qvlib-list-spacer-top', start));
        for (let index = start; index < end; index++) {
            fragment.append(createListRow(displayItems[index], index, playingItemId));
        }
        fragment.append(createListSpacer(
            'qvlib-list-spacer-bottom',
            displayItems.length - end
        ));
        list.replaceChildren(fragment);
        state.playingRow = null;
        state.renderedItemStart = start;
        state.renderedItemEnd = end;
        list.scrollTop = scrollTop;
        syncPlayingRows();
        updateDisabledState();
    }

    function cancelListWindowRender() {
        if (!state.listRenderFrame) {
            return;
        }
        cancelAnimationFrame(state.listRenderFrame);
        state.listRenderFrame = 0;
    }

    function handleListScroll() {
        closeItemMenu();
        if (isOnlineCollectionView()) {
            return;
        }
        if (state.listRenderFrame) {
            return;
        }
        state.listRenderFrame = requestAnimationFrame(() => {
            state.listRenderFrame = 0;
            renderListWindow();
        });
    }

    function renderList(resetScroll = false) {
        const list = state.root?.querySelector('.qvlib-list');
        const count = state.root?.querySelector('.qvlib-count');
        if (!list) {
            return;
        }
        closeItemMenu();
        cancelListWindowRender();
        const previousScrollTop = resetScroll ? 0 : list.scrollTop;
        const displayItems = getDisplayItems();
        if (count) {
            const collectionView = isOnlineCollectionView();
            const countLabel = state.view === 'online'
                ? (collectionView
                    ? (state.onlineBrowseContext?.mode === 'charts' ? TEXT.chartsCount : TEXT.playlistsCount)
                    : TEXT.songs)
                : TEXT.items;
            const countValue = displayItems.length;
            count.textContent = `${countValue} ${countLabel}`;
        }
        renderNavigation();
        renderOnlineNavigation();
        list.replaceChildren();
        list.classList.toggle('is-collection-grid', isOnlineCollectionView());
        state.renderedItemStart = 0;
        state.renderedItemEnd = 0;
        if (!displayItems.length) {
            const selectedOnlineSource = getSelectedOnlineSourceOption('musicUrl');
            const hasSearchSources = getOnlineSourceOptions('search').length > 0;
            const emptyText = state.view === 'online'
                ? (!selectedOnlineSource && !hasSearchSources
                    ? TEXT.onlineNoSource
                    : TEXT.onlineNoResult)
                : (state.offlineQuery ? TEXT.empty : (state.folder ? TEXT.folderEmpty : TEXT.empty));
            list.append(createElement('div', 'qvlib-empty', emptyText));
            return;
        }
        if (isOnlineCollectionView()) {
            const fragment = document.createDocumentFragment();
            for (const item of displayItems) {
                fragment.append(createCollectionCard(item));
            }
            list.append(fragment);
            list.scrollTop = previousScrollTop;
            updateDisabledState();
        } else {
            renderListWindow(previousScrollTop, true);
        }
    }

    function updateLibraryItems(payload = {}) {
        if (!state.root || String(payload.folder || '') !== state.folder || !Array.isArray(payload.items)) {
            return false;
        }
        const durations = new Map();
        for (const item of payload.items) {
            const duration = Number(item?.duration) || 0;
            if (item?.id && duration > 0) {
                durations.set(String(item.id), duration);
            }
        }
        if (!durations.size) {
            return false;
        }
        let changed = false;
        for (const item of state.items) {
            const duration = durations.get(String(item.id));
            if (duration && Number(item.duration) !== duration) {
                item.duration = duration;
                changed = true;
            }
        }
        const selectedDuration = durations.get(state.selectedItemId);
        if (state.selectedItem && selectedDuration && Number(state.selectedItem.duration) !== selectedDuration) {
            state.selectedItem.duration = selectedDuration;
        }
        if (!changed) {
            return false;
        }
        if (state.view !== 'offline') {
            return true;
        }
        for (const row of state.root.querySelectorAll('.qvlib-row[data-voice-item-id]')) {
            const item = getItem(row.dataset.voiceItemId);
            const meta = row.querySelector('.qvlib-meta');
            if (item && meta) {
                meta.textContent = getItemMetaText(item);
            }
        }
        return true;
    }

    function haveSameLibraryRows(previousItems, nextItems) {
        if (!Array.isArray(previousItems) || !Array.isArray(nextItems) ||
            previousItems.length !== nextItems.length) {
            return false;
        }
        return previousItems.every((previousItem, index) => {
            const nextItem = nextItems[index];
            return String(previousItem?.id || '') === String(nextItem?.id || '') &&
                String(previousItem?.kind || '') === String(nextItem?.kind || '') &&
                String(previousItem?.title || '') === String(nextItem?.title || '') &&
                normalizeFolderPath(previousItem?.relativePath || '') ===
                    normalizeFolderPath(nextItem?.relativePath || '') &&
                normalizeFolderPath(previousItem?.parentPath || '') ===
                    normalizeFolderPath(nextItem?.parentPath || '');
        });
    }

    function updateRenderedListMetadata() {
        const count = state.root?.querySelector('.qvlib-count');
        if (count) {
            const collectionView = isOnlineCollectionView();
            const countLabel = state.view === 'online'
                ? (collectionView
                    ? (state.onlineBrowseContext?.mode === 'charts' ? TEXT.chartsCount : TEXT.playlistsCount)
                    : TEXT.songs)
                : TEXT.items;
            const countText = `${getDisplayItems().length} ${countLabel}`;
            if (count.textContent !== countText) {
                count.textContent = countText;
            }
        }
        for (const row of state.root?.querySelectorAll('.qvlib-row[data-voice-item-id]') || []) {
            const indexedItem = getDisplayItems()[Number(row.dataset.voiceIndex)];
            const item = String(indexedItem?.id || '') === row.dataset.voiceItemId
                ? indexedItem
                : getItem(row.dataset.voiceItemId);
            if (!item) {
                continue;
            }
            const isFolder = item.kind === 'folder';
            const itemTitle = item.title || TEXT.item;
            const name = row.querySelector('.qvlib-name');
            const meta = row.querySelector('.qvlib-meta');
            const primary = row.querySelector('.qvlib-primary');
            if (name && name.textContent !== itemTitle) {
                name.textContent = itemTitle;
            }
            if (name && name.title !== itemTitle) {
                name.title = itemTitle;
            }
            const metaText = getItemMetaText(item);
            if (meta && meta.textContent !== metaText) {
                meta.textContent = metaText;
            }
            if (primary) {
                const controlTitle = `${isFolder ? TEXT.open : TEXT.play} ${itemTitle}`;
                if (primary.title !== controlTitle) {
                    primary.title = controlTitle;
                    primary.setAttribute('aria-label', controlTitle);
                }
                if (!isFolder && item.kind !== 'online') {
                    primary.setAttribute('aria-pressed', String(state.selectedItemId === String(item.id)));
                }
            }
        }
        syncPlayingRows();
    }

    function applyLibraryPayload(payload) {
        const previousFolder = state.folder;
        const previousParent = state.parent;
        const previousItems = state.items;
        const hasOnlineSearchPayload = !Array.isArray(payload) &&
            Object.prototype.hasOwnProperty.call(payload || {}, 'onlineSearchResults');
        const hasOnlineBrowsePayload = !Array.isArray(payload) &&
            Object.prototype.hasOwnProperty.call(payload || {}, 'onlineBrowseItems');
        const payloadSearchContext = payload?.onlineSearchContext && typeof payload.onlineSearchContext === 'object'
            ? payload.onlineSearchContext
            : null;
        const payloadBrowseContext = payload?.onlineBrowseContext && typeof payload.onlineBrowseContext === 'object'
            ? payload.onlineBrowseContext
            : null;
        const isStaleOnlineSearchPayload = hasOnlineSearchPayload &&
            Boolean(state.onlineSearchRequestId) &&
            Boolean(payloadSearchContext?.requestId) &&
            String(payloadSearchContext.requestId) !== state.onlineSearchRequestId;
        let shouldApplyOnlineSearchPayload = hasOnlineSearchPayload && !isStaleOnlineSearchPayload;
        const isStaleOnlineBrowsePayload = hasOnlineBrowsePayload &&
            Boolean(state.onlineBrowseRequestId) &&
            Boolean(payloadBrowseContext?.requestId) &&
            String(payloadBrowseContext.requestId) !== state.onlineBrowseRequestId;
        let shouldApplyOnlineBrowsePayload = hasOnlineBrowsePayload && !isStaleOnlineBrowsePayload;
        const hasSelectedItem = !Array.isArray(payload) &&
            Object.prototype.hasOwnProperty.call(payload || {}, 'selectedItem');
        if (Array.isArray(payload)) {
            state.items = payload;
            state.folders = [''];
            state.folder = '';
            state.parent = '';
        } else {
            const hasItems = Object.prototype.hasOwnProperty.call(payload || {}, 'items');
            const hasFolders = Object.prototype.hasOwnProperty.call(payload || {}, 'folders');
            const hasFolder = Object.prototype.hasOwnProperty.call(payload || {}, 'folder');
            const hasParent = Object.prototype.hasOwnProperty.call(payload || {}, 'parent');
            const hasOnlineSources = Object.prototype.hasOwnProperty.call(payload || {}, 'onlineSources');
            if (hasItems) {
                state.items = Array.isArray(payload?.items) ? payload.items : [];
            }
            if (hasOnlineSources) {
                state.onlineSources = Array.isArray(payload?.onlineSources) ? payload.onlineSources : [];
                const selectedSourceAvailable = !state.onlineSourceKey ||
                    getOnlineSourceOptions('musicUrl').some(option => option.value === state.onlineSourceKey);
                const contextToValidate = shouldApplyOnlineSearchPayload
                    ? payloadSearchContext
                    : state.onlineSearchContext;
                if (!selectedSourceAvailable ||
                    (contextToValidate && !isOnlineSearchContextAvailable(contextToValidate))) {
                    state.onlineSourceKey = '';
                    state.onlineSearchResults = [];
                    state.onlineSearchContext = null;
                    invalidateOnlineSearchRequest('sources');
                    shouldApplyOnlineSearchPayload = false;
                }
                const browseContextToValidate = shouldApplyOnlineBrowsePayload
                    ? payloadBrowseContext
                    : state.onlineBrowseContext;
                if (browseContextToValidate && !isOnlineBrowseContextAvailable(browseContextToValidate)) {
                    state.onlineBrowseItems = [];
                    state.onlineBrowseContext = null;
                    state.onlineHistory = null;
                    invalidateOnlineBrowseRequest('sources');
                    shouldApplyOnlineBrowsePayload = false;
                } else {
                    state.onlineBrowseItems = filterAvailableOnlineBrowseItems(state.onlineBrowseItems);
                    if (state.onlineHistory) {
                        if (!isOnlineBrowseContextAvailable(state.onlineHistory.context)) {
                            state.onlineHistory = null;
                        } else {
                            state.onlineHistory.items = filterAvailableOnlineBrowseItems(state.onlineHistory.items);
                        }
                    }
                }
                if (state.view === 'online' && !shouldApplyOnlineSearchPayload && !shouldApplyOnlineBrowsePayload &&
                    !state.onlineSearchContext && !state.onlineBrowseContext &&
                    !String(state.onlineQuery || '').trim() && getOnlineCatalogTargets().length) {
                    requestAnimationFrame(() => requestOnlineBrowse());
                }
            }
            if (shouldApplyOnlineSearchPayload) {
                state.onlineSearchResults = Array.isArray(payload.onlineSearchResults)
                    ? payload.onlineSearchResults
                    : [];
                state.onlineSearchContext = payloadSearchContext
                    ? { ...payloadSearchContext }
                    : null;
            }
            if (shouldApplyOnlineBrowsePayload) {
                state.onlineBrowseItems = filterAvailableOnlineBrowseItems(payload.onlineBrowseItems);
                state.onlineBrowseContext = payloadBrowseContext
                    ? { ...payloadBrowseContext }
                    : null;
            }
            if (hasFolders && Array.isArray(payload?.folders)) {
                state.folders = Array.from(new Set(payload.folders.map(normalizeFolderPath)));
                if (!state.folders.includes('')) {
                    state.folders.unshift('');
                }
            }
            if (hasFolder) {
                state.folder = payload?.folder || '';
            }
            if (hasParent) {
                state.parent = payload?.parent || '';
            }
        }
        const canReuseRenderedRows = previousFolder === state.folder &&
            haveSameLibraryRows(previousItems, state.items);
        if (hasSelectedItem) {
            const selectedItem = payload?.selectedItem;
            if (selectedItem && selectedItem.kind !== 'folder') {
                state.selectedItem = { ...selectedItem };
                state.selectedItemId = String(selectedItem.id || '');
            } else {
                state.selectedItem = null;
                state.selectedItemId = '';
            }
        } else if (state.selectedItem) {
            const refreshedItem = getLibraryItem(state.selectedItemId);
            if (refreshedItem && refreshedItem.kind !== 'folder') {
                state.selectedItem = {
                    ...refreshedItem,
                    parentPath: refreshedItem.parentPath ?? state.folder
                };
            } else if (String(state.selectedItem.parentPath || '') === String(state.folder || '')) {
                if (state.playerItem?.playbackKind === 'library' &&
                    String(state.playerItem.id) === String(state.selectedItemId)) {
                    resetPlayer();
                }
                state.selectedItem = null;
                state.selectedItemId = '';
            }
        }
        if (state.view === 'online') {
            renderViewControls();
            renderOnlineToolbar();
            if (shouldApplyOnlineSearchPayload || shouldApplyOnlineBrowsePayload ||
                Object.prototype.hasOwnProperty.call(payload || {}, 'onlineSources')) {
                renderList(true);
            }
        } else if (canReuseRenderedRows) {
            if (previousParent !== state.parent) {
                renderNavigation();
            }
            updateRenderedListMetadata();
        } else {
            renderList(previousFolder !== state.folder);
        }
        updateDisabledState();
    }

    function schedulePendingLibraryFlush() {
        if (state.dragging || state.pendingLibraryFrame || (
            state.pendingLibraryPayload === undefined && state.pendingOnlineSearchPayload === undefined
        )) {
            return;
        }
        state.pendingLibraryFrame = requestAnimationFrame(() => {
            state.pendingLibraryFrame = 0;
            if (state.dragging || (
                state.pendingLibraryPayload === undefined && state.pendingOnlineSearchPayload === undefined
            )) {
                return;
            }
            const payload = mergePendingLibraryPayload(
                state.pendingLibraryPayload,
                state.pendingOnlineSearchPayload
            );
            state.pendingLibraryPayload = undefined;
            state.pendingOnlineSearchPayload = undefined;
            applyLibraryPayload(payload);
        });
    }

    function mergePendingLibraryPayload(basePayload, onlinePayload) {
        if (onlinePayload === undefined) {
            return basePayload;
        }
        if (basePayload === undefined || Array.isArray(basePayload)) {
            return onlinePayload;
        }
        if (Array.isArray(onlinePayload)) {
            return basePayload;
        }
        return {
            ...basePayload,
            ...onlinePayload,
            items: Array.isArray(basePayload.items) ? basePayload.items : onlinePayload.items,
            folders: Array.isArray(basePayload.folders) ? basePayload.folders : onlinePayload.folders,
            folder: basePayload.folder ?? onlinePayload.folder,
            parent: basePayload.parent ?? onlinePayload.parent
        };
    }

    function setLibrary(payload) {
        if (state.dragging || state.pendingLibraryFrame) {
            const isOnlinePayload = !Array.isArray(payload) &&
                (Object.prototype.hasOwnProperty.call(payload || {}, 'onlineSearchResults') ||
                    Object.prototype.hasOwnProperty.call(payload || {}, 'onlineBrowseItems'));
            if (isOnlinePayload) {
                state.pendingOnlineSearchPayload = payload;
            } else {
                state.pendingLibraryPayload = payload;
            }
            schedulePendingLibraryFlush();
            return;
        }
        applyLibraryPayload(payload);
    }

    function playPreview(payload = {}) {
        const audio = state.root?.querySelector('audio');
        const title = state.root?.querySelector('.qvlib-player-title');
        const expectedId = String(state.playerItem?.id || '');
        if (!audio || !payload.previewUrl || String(payload.id || '') !== expectedId) {
            return;
        }
        if (title) {
            title.textContent = payload.previewTitle || TEXT.item;
        }
        audio.src = payload.previewUrl;
        if (!state.root.hidden) {
            audio.play?.().catch(() => {});
        }
        syncPlayer();
    }

    function handleAction(action, itemId = '', control = null) {
        if (action === 'close') {
            close();
            return;
        }
        if (action === 'itemMenu') {
            toggleItemMenu(itemId, control);
            return;
        }
        if (action === 'playerToggle') {
            const audio = state.root?.querySelector('audio');
            if (!audio?.src) {
                return;
            }
            if (isAudioPlaying(audio)) {
                audio.pause?.();
            } else {
                if (audio.ended) {
                    audio.currentTime = 0;
                }
                audio.play?.().catch(() => {});
            }
            syncPlayer();
            return;
        }
        if (action === 'playerPrevious' || action === 'playerNext') {
            playAdjacentPlayerItem(action === 'playerNext' ? 1 : -1);
            return;
        }
        if (action === 'sendMenu') {
            const item = control?.classList?.contains('qvlib-player-send')
                ? state.playerItem
                : getItem(itemId);
            if (item) {
                toggleItemMenu(item.id, control, {
                    item,
                    sendOnly: true,
                    source: control?.classList?.contains('qvlib-player-send') ? 'player' : 'item'
                });
            }
            return;
        }
        if (action === 'pickMenu') {
            toggleItemMenu('__pick__', control, {
                item: { id: '__pick__', kind: 'pick', title: TEXT.pick },
                sendOnly: true,
                source: 'pick'
            });
            return;
        }
        if (action === 'sendWithMode') {
            const sendMode = control?.dataset?.sendMode === 'original' ? 'original' : 'convert';
            const source = control?.dataset?.sendSource || 'item';
            const item = source === 'player' ? state.playerItem : getItem(itemId);
            closeItemMenu();
            if (source === 'pick') {
                setStatus(TEXT.choose, { disabled: true });
                emit({ type: 'pick', sendMode });
            } else if (item?.kind === 'online' || item?.playbackKind === 'online') {
                performOnlineResultAction(item, 'send', sendMode);
            } else if (item) {
                setStatus(item.kind === 'media' && sendMode === 'convert' ? TEXT.converting : TEXT.sending, { disabled: false });
                emit({ type: 'sendLibrary', id: item.id, sendMode });
            }
            return;
        }
        closeItemMenu();
        if (action === 'switchOffline' || action === 'switchOnline') {
            switchView(action === 'switchOnline' ? 'online' : 'offline');
            return;
        }
        if (action === 'toggleOfflineSearch') {
            state.offlineSearchActive = !state.offlineSearchActive;
            if (!state.offlineSearchActive) {
                state.offlineQuery = '';
            }
            renderOfflineSearch();
            renderList(true);
            state.root?.querySelector('[data-offline-query]')?.focus?.();
            return;
        }
        if (action === 'clearOfflineSearch') {
            state.offlineQuery = '';
            renderOfflineSearch();
            renderList(true);
            state.root?.querySelector('[data-offline-query]')?.focus?.();
            return;
        }
        if (action === 'searchOnline') {
            requestOnlineSearch();
            return;
        }
        if (action === 'clearOnlineSearch') {
            state.onlineQuery = '';
            renderOnlineToolbar();
            state.root?.querySelector('[data-online-query]')?.focus?.();
            return;
        }
        if (action === 'switchOnlineSection') {
            const section = ['recommend', 'charts', 'playlists'].includes(control?.dataset?.onlineSection)
                ? control.dataset.onlineSection
                : 'recommend';
            state.onlineSection = section;
            state.onlineHistory = null;
            state.onlineQuery = '';
            state.onlineSearchResults = [];
            state.onlineSearchContext = null;
            invalidateOnlineSearchRequest('section');
            requestOnlineBrowse({ mode: section });
            return;
        }
        if (action === 'setOnlineSort') {
            const sort = control?.dataset?.onlineSort === 'new' ? 'new' : 'hot';
            if (state.onlineSort === sort) {
                return;
            }
            state.onlineSort = sort;
            state.onlineHistory = null;
            requestOnlineBrowse({ mode: state.onlineSection });
            return;
        }
        if (action === 'openOnlineCollection') {
            const collection = getItem(itemId);
            if (!collection || collection.kind !== 'onlineCollection') {
                setStatus(TEXT.missing, { error: true, resetAfterMs: 1600 });
                return;
            }
            const list = state.root?.querySelector('.qvlib-list');
            state.onlineHistory = {
                section: state.onlineSection,
                sort: state.onlineSort,
                items: state.onlineBrowseItems.slice(),
                context: state.onlineBrowseContext ? { ...state.onlineBrowseContext } : null,
                scrollTop: list?.scrollTop || 0
            };
            requestOnlineBrowse({ mode: 'detail', collection });
            return;
        }
        if (action === 'backOnlineCollection') {
            const history = state.onlineHistory;
            if (history) {
                state.onlineSection = history.section || state.onlineSection;
                state.onlineSort = history.sort || state.onlineSort;
                state.onlineBrowseItems = Array.isArray(history.items) ? history.items : [];
                state.onlineBrowseContext = history.context ? { ...history.context } : null;
                state.onlineHistory = null;
                invalidateOnlineBrowseRequest('back');
                renderList(true);
                const list = state.root?.querySelector('.qvlib-list');
                if (list) list.scrollTop = Math.max(0, Number(history.scrollTop) || 0);
            } else {
                requestOnlineBrowse({ mode: state.onlineSection });
            }
            return;
        }
        if (action === 'createFolder') {
            showCreateFolderDialog();
            return;
        }
        if (action === 'saveOnlineResult') {
            performOnlineResultAction(getItem(itemId), 'save');
            return;
        }
        if (action === 'previewOnline') {
            previewOnlineResult(getItem(itemId));
            return;
        }
        if (action === 'backFolder') {
            const folder = state.parent || '';
            setStatus(TEXT.refreshing, { disabled: true });
            emit({ type: 'list', folder });
            return;
        }
        if (action === 'list' || action === 'pickSave') {
            setStatus(action === 'list' ? TEXT.refreshing : TEXT.choose, { disabled: true });
            emit({ type: action });
            return;
        }
        const item = getItem(itemId);
        if (!item) {
            setStatus(TEXT.missing, { error: true, resetAfterMs: 1600 });
            return;
        }
        if (action === 'openFolder') {
            setStatus(TEXT.refreshing, { disabled: true });
            emit({ type: 'list', folder: item.relativePath || '' });
            return;
        }
        if (action === 'previewLibrary') {
            previewLibraryItem(item);
            return;
        }
        if (action === 'renameLibrary') {
            showRenameDialog(item);
            return;
        }
        if (action === 'moveLibrary') {
            showMoveDialog(item);
            return;
        }
        if (action === 'deleteLibrary') {
            showDeleteDialog(item);
        }
    }

    function previewLibraryItem(item, options = {}) {
        if (!item || item.kind === 'folder') {
            setStatus(TEXT.missing, { error: true, resetAfterMs: 1600 });
            return;
        }
        preparePlayerItem({ ...item, playbackKind: 'library' }, options);
        if (options.preserveQueue !== true) {
            setSelectedItem(item.id);
        }
        setStatus(TEXT.loading, { disabled: true });
        emit({ type: 'previewLibrary', id: item.id });
    }

    function getShellSize(shell, viewportWidth, viewportHeight) {
        return {
            width: shell.offsetWidth || Math.min(420, Math.max(0, viewportWidth - 16)),
            height: shell.offsetHeight || Math.min(480, Math.max(0, viewportHeight - 16))
        };
    }

    function setPosition(left, top) {
        const shell = state.root?.querySelector('.qvlib-shell');
        if (!state.root || !shell) {
            return null;
        }
        const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
        const { width, height } = getShellSize(shell, viewportWidth, viewportHeight);
        const margin = 8;
        const nextLeft = Number(left);
        const nextTop = Number(top);
        const position = {
            left: Math.min(
                Math.max(margin, viewportWidth - width - margin),
                Math.max(margin, Number.isFinite(nextLeft) ? nextLeft : margin)
            ),
            top: Math.min(
                Math.max(margin, viewportHeight - height - margin),
                Math.max(margin, Number.isFinite(nextTop) ? nextTop : margin)
            )
        };
        shell.style.left = `${position.left}px`;
        shell.style.top = `${position.top}px`;
        return position;
    }

    function updatePlacement() {
        if (!state.root || state.root.hidden) {
            return;
        }
        if (!state.host?.isConnected) {
            state.host = options.resolveHost?.() || null;
        }
        const hostRect = state.host?.getBoundingClientRect?.();
        const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
        const shell = state.root.querySelector('.qvlib-shell');
        const { width, height } = getShellSize(shell, viewportWidth, viewportHeight);
        const left = state.moved && state.position
            ? state.position.left
            : (hostRect?.width > 0 ? hostRect.left + (hostRect.width - width) / 2 : (viewportWidth - width) / 2);
        const top = state.moved && state.position
            ? state.position.top
            : (hostRect?.height > 0 ? hostRect.top + (hostRect.height - height) / 2 : (viewportHeight - height) / 2);
        const position = setPosition(left, top);
        if (state.moved && position) {
            state.position = position;
        }
    }

    function installDrag(shell, header) {
        let dragState = null;
        let dragFrame = 0;

        const updateDragPosition = event => {
            if (!dragState || !Number.isFinite(event?.clientX) || !Number.isFinite(event?.clientY)) {
                return;
            }
            dragState.position = {
                left: Math.min(
                    dragState.maxLeft,
                    Math.max(dragState.margin, event.clientX - dragState.offsetX)
                ),
                top: Math.min(
                    dragState.maxTop,
                    Math.max(dragState.margin, event.clientY - dragState.offsetY)
                )
            };
        };

        const applyDragPosition = () => {
            dragFrame = 0;
            if (!dragState) {
                return;
            }
            shell.style.transform = `translate3d(${dragState.position.left - dragState.startLeft}px, ${dragState.position.top - dragState.startTop}px, 0)`;
        };

        const finish = event => {
            if (!dragState || (event?.pointerId !== undefined && dragState.pointerId !== event.pointerId)) {
                return;
            }
            if (event?.type !== 'lostpointercapture') {
                updateDragPosition(event);
            }
            const finishedDrag = dragState;
            dragState = null;
            if (dragFrame) {
                cancelAnimationFrame(dragFrame);
                dragFrame = 0;
            }
            if (header.hasPointerCapture?.(finishedDrag.pointerId)) {
                header.releasePointerCapture(finishedDrag.pointerId);
            }
            shell.style.left = `${finishedDrag.position.left}px`;
            shell.style.top = `${finishedDrag.position.top}px`;
            shell.style.transform = '';
            shell.classList.remove('is-dragging');
            state.dragging = false;
            state.position = { ...finishedDrag.position };
            state.moved = true;
            schedulePendingLibraryFlush();
        };

        header.addEventListener('pointerdown', event => {
            if (event.button !== 0 || event.target?.closest?.('button, [role="button"], input, select, textarea, a')) {
                return;
            }
            const rect = shell.getBoundingClientRect();
            const margin = 8;
            const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
            const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
            dragState = {
                pointerId: event.pointerId,
                offsetX: event.clientX - rect.left,
                offsetY: event.clientY - rect.top,
                startLeft: rect.left,
                startTop: rect.top,
                margin,
                maxLeft: Math.max(margin, viewportWidth - rect.width - margin),
                maxTop: Math.max(margin, viewportHeight - rect.height - margin),
                position: {
                    left: rect.left,
                    top: rect.top
                }
            };
            shell.classList.add('is-dragging');
            state.dragging = true;
            header.setPointerCapture?.(event.pointerId);
            event.preventDefault();
        });
        header.addEventListener('pointermove', event => {
            if (!dragState || dragState.pointerId !== event.pointerId) {
                return;
            }
            updateDragPosition(event);
            if (!dragFrame) {
                dragFrame = requestAnimationFrame(applyDragPosition);
            }
            event.preventDefault();
        });
        header.addEventListener('pointerup', finish);
        header.addEventListener('pointercancel', finish);
        header.addEventListener('lostpointercapture', finish);
        return finish;
    }

    function buildPanel() {
        const root = createElement('div');
        root.id = ROOT_ID;
        const shell = createElement('div', 'qvlib-shell');
        const header = createElement('div', 'qvlib-header');
        const heading = createElement('div', 'qvlib-heading');
        heading.append(
            createElement('div', 'qvlib-title', TEXT.title),
            createElement('div', 'qvlib-count', `0 ${TEXT.items}`)
        );
        const viewControls = createElement('div', 'qvlib-view-controls');
        const offlineView = createIconButton('folder', 'switchOffline', 'qvlib-icon-button qvlib-view-button', TEXT.switchToOffline);
        offlineView.dataset.voiceView = 'offline';
        const onlineView = createIconButton('cloud', 'switchOnline', 'qvlib-icon-button qvlib-view-button', TEXT.switchToOnline);
        onlineView.dataset.voiceView = 'online';
        viewControls.append(offlineView, onlineView);
        const createFolder = createIconButton('folderPlus', 'createFolder', 'qvlib-icon-button qvlib-library-only', TEXT.newFolder);
        const offlineSearch = createIconButton('search', 'toggleOfflineSearch', 'qvlib-icon-button qvlib-library-only', TEXT.searchOffline);
        const refresh = createIconButton('refresh', 'list', 'qvlib-icon-button qvlib-library-only', TEXT.refresh);
        const closeButton = createIconButton('close', 'close', 'qvlib-icon-button qvlib-close', TEXT.close);
        header.append(heading, createFolder, offlineSearch, refresh, viewControls, closeButton);
        const nav = createElement('div', 'qvlib-nav');
        nav.hidden = true;
        const offlineSearchBar = createElement('div', 'qvlib-offline-search');
        offlineSearchBar.hidden = true;
        const offlineSearchField = createElement('div', 'qvlib-offline-search-field');
        const offlineSearchInput = createElement('input');
        offlineSearchInput.type = 'text';
        offlineSearchInput.placeholder = TEXT.searchOffline;
        offlineSearchInput.dataset.offlineQuery = 'true';
        offlineSearchInput.setAttribute('aria-label', TEXT.searchOffline);
        offlineSearchInput.addEventListener('input', () => {
            state.offlineQuery = offlineSearchInput.value;
            renderOfflineSearch();
            renderList(true);
        });
        const clearOfflineSearch = createIconButton('close', 'clearOfflineSearch', 'qvlib-search-clear', TEXT.clearSearch);
        clearOfflineSearch.hidden = true;
        offlineSearchField.append(offlineSearchInput, clearOfflineSearch);
        offlineSearchBar.append(offlineSearchField);
        const onlineToolbar = createElement('div', 'qvlib-online-toolbar');
        onlineToolbar.hidden = true;
        const sourceSelect = createElement('select');
        sourceSelect.dataset.onlineSource = 'true';
        sourceSelect.setAttribute('aria-label', TEXT.online);
        sourceSelect.addEventListener('change', () => {
            const nextSourceKey = sourceSelect.value;
            if (state.onlineSourceKey === nextSourceKey) {
                return;
            }
            state.onlineSourceKey = nextSourceKey;
            state.onlineSearchResults = [];
            state.onlineSearchContext = null;
            state.onlineBrowseItems = [];
            state.onlineBrowseContext = null;
            state.onlineHistory = null;
            invalidateOnlineSearchRequest('source');
            invalidateOnlineBrowseRequest('source');
            renderList(true);
            if (String(state.onlineQuery || '').trim()) {
                requestOnlineSearch();
            } else {
                requestOnlineBrowse({ mode: state.onlineSection });
            }
        });
        const onlineSearchField = createElement('div', 'qvlib-online-search-field');
        const onlineSearchInput = createElement('input');
        onlineSearchInput.type = 'text';
        onlineSearchInput.placeholder = TEXT.searchOnlinePlaceholder;
        onlineSearchInput.dataset.onlineQuery = 'true';
        onlineSearchInput.setAttribute('aria-label', TEXT.onlineSearch);
        onlineSearchInput.addEventListener('input', () => {
            state.onlineQuery = onlineSearchInput.value;
            renderOnlineToolbar();
        });
        onlineSearchInput.addEventListener('keydown', event => {
            if (event.key === 'Enter') {
                event.preventDefault();
                requestOnlineSearch();
            }
        });
        const clearOnlineSearch = createIconButton('close', 'clearOnlineSearch', 'qvlib-online-search-clear', TEXT.clearSearch);
        clearOnlineSearch.hidden = true;
        const onlineSearchButton = createIconButton('search', 'searchOnline', 'qvlib-online-search-button', TEXT.search);
        onlineSearchField.append(onlineSearchInput, clearOnlineSearch);
        onlineToolbar.append(onlineSearchField, onlineSearchButton, sourceSelect);
        const onlineNavigation = createElement('div', 'qvlib-online-navigation');
        onlineNavigation.hidden = true;
        const listFrame = createElement('div', 'qvlib-list-frame');
        const list = createElement('div', 'qvlib-list qqnt-toolbox-scrollable');
        list.id = `${ROOT_ID}-list`;
        list.setAttribute('role', 'list');
        list.tabIndex = 0;
        list.addEventListener('scroll', handleListScroll, { passive: true });
        listFrame.append(list);
        const player = createPlayer();
        const footer = createElement('div', 'qvlib-footer');
        const pick = createLabeledButton('send', TEXT.pick, 'pickMenu');
        pick.dataset.menuTriggerId = 'qvlib-pick-send-menu';
        pick.setAttribute('aria-haspopup', 'menu');
        pick.setAttribute('aria-expanded', 'false');
        footer.append(pick, createLabeledButton('folderPlus', TEXT.add, 'pickSave'));
        shell.append(header, nav, offlineSearchBar, onlineToolbar, onlineNavigation, listFrame, player, footer);
        root.append(shell);
        root.addEventListener('click', event => {
            const control = event.target?.closest?.('[data-voice-action]');
            if (!control || !root.contains(control)) {
                event.stopPropagation();
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation?.();
            handleAction(
                control.dataset.voiceAction,
                control.dataset.voiceItemId || '',
                control
            );
        });
        root.addEventListener('pointerdown', event => {
            if (!event.target?.closest?.('.qvlib-item-menu, [aria-haspopup="menu"]')) {
                closeItemMenu();
            }
        }, true);
        root.addEventListener('pointerleave', () => {
            root.classList.add('is-pointer-outside');
            releasePointerActionFocus();
        });
        root.addEventListener('pointerenter', () => {
            root.classList.remove('is-pointer-outside');
        });
        root.addEventListener('pointercancel', releasePointerActionFocus, true);
        for (const eventName of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'dblclick', 'wheel', 'dragover', 'drop']) {
            root.addEventListener(eventName, event => {
                if (event.target === root) {
                    event.preventDefault();
                }
                event.stopPropagation();
            });
        }
        root.addEventListener('contextmenu', event => {
            const row = event.target?.closest?.('.qvlib-row[data-voice-item-id]');
            if (row && root.contains(row)) {
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation?.();
                const hasPointerPosition = Number.isFinite(event.clientX) && Number.isFinite(event.clientY) &&
                    (event.clientX !== 0 || event.clientY !== 0);
                const anchor = hasPointerPosition
                    ? null
                    : row.querySelector('.qvlib-more') || row.querySelector('.qvlib-primary');
                showItemMenu(row.dataset.voiceItemId, anchor, hasPointerPosition ? event : null);
                return;
            }
            event.preventDefault();
            event.stopPropagation();
        });
        state.finishDrag = installDrag(shell, header);
        return root;
    }

    function open() {
        ensureStyle();
        const host = options.resolveHost?.();
        if (!host) {
            return false;
        }
        const reopening = Boolean(state.root?.isConnected);
        state.host = host;
        if (!reopening) {
            state.root = buildPanel();
            document.body.append(state.root);
            renderViewControls();
            syncViewLayout();
            renderOfflineSearch();
            renderOnlineToolbar();
            renderOnlineNavigation();
            renderList(true);
            syncPlayer();
        } else {
            state.root.hidden = false;
            state.root.classList.remove('is-pointer-outside');
            renderViewControls();
            syncViewLayout();
            syncPlayer();
        }
        if (!state.windowBlurHandler) {
            state.windowBlurHandler = () => {
                state.finishDrag?.();
                state.root?.classList.add('is-pointer-outside');
                closeItemMenu();
                releasePointerActionFocus();
            };
            window.addEventListener('blur', state.windowBlurHandler);
        }
        updatePlacement();
        emit({ type: reopening ? 'listOnlineSources' : 'list' });
        return true;
    }

    function close() {
        if (!state.root) {
            return;
        }
        clearTimeout(state.statusTimer);
        state.statusTimer = 0;
        state.finishDrag?.();
        state.dragging = false;
        if (state.windowBlurHandler) {
            window.removeEventListener('blur', state.windowBlurHandler);
            state.windowBlurHandler = null;
        }
        closeDialog();
        closeItemMenu();
        state.root.querySelector('.qvlib-toast')?.remove();
        const audio = state.root?.querySelector('audio');
        audio?.pause?.();
        syncPlayer();
        state.root.hidden = true;
        state.root.classList.remove('is-pointer-outside');
        state.host = null;
    }

    function handleEscape() {
        if (!state.root) {
            return false;
        }
        if (state.root.querySelector('.qvlib-dialog-layer')) {
            closeDialog();
        } else if (closeItemMenu(true)) {
            return true;
        } else {
            close();
        }
        return true;
    }

    return {
        open,
        close,
        isOpen: () => Boolean(
            state.root?.isConnected && !state.root.hidden && state.root.getClientRects().length > 0
        ),
        contains: target => Boolean(state.root?.contains(target)),
        updatePlacement,
        setStatus,
        setLibrary,
        updateLibraryItems,
        playPreview,
        handleEscape
    };
}

module.exports = createVoiceLibraryPanel;
