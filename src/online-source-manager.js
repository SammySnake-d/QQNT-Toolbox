const MANAGER_ID = 'qqnt-toolbox-online-source-manager';
const STYLE_ID = 'qqnt-toolbox-online-source-manager-style';

function normalizeText(value) {
    return String(value ?? '').trim();
}

function createElement(tag, className = '', content = '') {
    const element = document.createElement(tag);
    if (className) {
        element.className = className;
    }
    if (content !== '') {
        element.textContent = content;
    }
    return element;
}

function sourceProviderCount(source) {
    return Object.values(source?.sources || {}).filter(provider =>
        provider && typeof provider === 'object' && provider.type === 'music'
    ).length;
}

function sourceMeta(source) {
    const formatLabels = {
        lxmusic: 'LXMusic',
        cerumusic: 'CeruMusic',
        'qt-music': 'QT MusicPlugin',
        musicfree: 'MusicFree'
    };
    const values = [
        formatLabels[normalizeText(source?.format)] || '',
        normalizeText(source?.author),
        normalizeText(source?.version) && `v${normalizeText(source.version)}`,
        sourceProviderCount(source) ? `${sourceProviderCount(source)} 个音源` : ''
    ].filter(Boolean);
    return values.join(' · ');
}

function resolveOpaqueSurface(themeRoot, textColor) {
    const parseColor = value => {
        const match = String(value || '').match(/^rgba?\(\s*(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)(?:\D+(\d*(?:\.\d+)?))?\s*\)$/i);
        return match ? {
            red: Number(match[1]),
            green: Number(match[2]),
            blue: Number(match[3]),
            alpha: match[4] === undefined || match[4] === '' ? 1 : Number(match[4])
        } : null;
    };
    for (let element = themeRoot; element instanceof Element; element = element.parentElement) {
        const color = parseColor(getComputedStyle(element).backgroundColor);
        if (color?.alpha >= 0.98) {
            return `rgb(${color.red}, ${color.green}, ${color.blue})`;
        }
    }
    const text = parseColor(textColor);
    return text && text.red + text.green + text.blue > 420 ? '#202124' : '#ffffff';
}

function ensureStyle() {
    const existing = document.getElementById(STYLE_ID);
    if (existing) {
        return existing.dataset.ready === 'true'
            ? Promise.resolve()
            : new Promise(resolve => {
                existing.addEventListener('load', resolve, { once: true });
                existing.addEventListener('error', resolve, { once: true });
            });
    }
    const link = document.createElement('link');
    link.id = STYLE_ID;
    link.rel = 'stylesheet';
    link.href = new URL('./online-source-manager.css', import.meta.url).href;
    return new Promise(resolve => {
        const complete = () => {
            link.dataset.ready = 'true';
            resolve();
        };
        link.addEventListener('load', complete, { once: true });
        link.addEventListener('error', complete, { once: true });
        document.head.append(link);
    });
}

export function createOnlineSourceManager(options = {}) {
    let cleanup = null;
    let previousFocus = null;
    let revision = 0;

    function close() {
        revision += 1;
        cleanup?.();
        cleanup = null;
        document.getElementById(MANAGER_ID)?.remove();
        if (previousFocus?.isConnected) {
            previousFocus.focus({ preventScroll: true });
        }
        previousFocus = null;
    }

    async function open(themeSource = null) {
        close();
        const openRevision = revision;
        await ensureStyle();
        if (openRevision !== revision) {
            return;
        }

        previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        let disposed = false;
        let busy = false;
        let sources = [];
        let dialog = null;
        let statusTimer = 0;

        const layer = createElement('div');
        layer.id = MANAGER_ID;
        layer.tabIndex = -1;
        layer.setAttribute('role', 'dialog');
        layer.setAttribute('aria-modal', 'true');
        layer.setAttribute('aria-label', '在线音源管理');
        const themeRoot = themeSource?.closest?.('#qqnt-toolbox-settings, #qqnt-toolbox-panel');
        if (themeRoot instanceof Element) {
            const textColor = getComputedStyle(themeRoot).color;
            if (textColor) {
                layer.style.setProperty('--qosm-text', textColor);
            }
            layer.style.setProperty('--qosm-surface', resolveOpaqueSurface(themeRoot, textColor));
        }

        const page = createElement('section', 'qosm-page');
        const header = createElement('header', 'qosm-header');
        const heading = createElement('div', 'qosm-heading');
        const title = createElement('h2', 'qosm-title', '在线音源');
        const count = createElement('span', 'qosm-count');
        heading.append(title, count);
        const headerActions = createElement('div', 'qosm-header-actions');
        const importButton = createElement('button', 'qosm-button qosm-primary', '导入音源');
        const refreshButton = createElement('button', 'qosm-icon-button', '↻');
        const closeButton = createElement('button', 'qosm-close', '×');
        importButton.type = 'button';
        refreshButton.type = 'button';
        closeButton.type = 'button';
        refreshButton.title = '刷新';
        refreshButton.setAttribute('aria-label', '刷新');
        closeButton.setAttribute('aria-label', '关闭');
        headerActions.append(importButton, refreshButton, closeButton);
        header.append(heading, headerActions);

        const body = createElement('main', 'qosm-body');
        const list = createElement('div', 'qosm-list qqnt-toolbox-scrollable');
        list.setAttribute('role', 'list');
        list.setAttribute('aria-label', '已导入音源');
        const status = createElement('div', 'qosm-status');
        body.append(list, status);
        page.append(header, body);
        layer.append(page);
        document.body.append(layer);

        const setStatus = (message = '', state = '') => {
            window.clearTimeout(statusTimer);
            status.textContent = message;
            status.dataset.state = state;
            if (message && state !== 'error') {
                statusTimer = window.setTimeout(() => {
                    status.textContent = '';
                    delete status.dataset.state;
                }, 2200);
            }
        };

        const setBusy = value => {
            busy = value === true;
            importButton.disabled = busy;
            refreshButton.disabled = busy;
            list.querySelectorAll('.qosm-delete').forEach(button => {
                button.disabled = busy;
            });
            if (dialog) {
                dialog.form.querySelectorAll('button, textarea').forEach(control => {
                    control.disabled = busy;
                });
            }
        };

        const render = () => {
            count.textContent = `${sources.length} 个`;
            list.replaceChildren();
            if (!sources.length) {
                list.append(createElement('div', 'qosm-empty', '尚未导入音源'));
                return;
            }
            const fragment = document.createDocumentFragment();
            for (const source of sources) {
                const row = createElement('article', 'qosm-source');
                row.setAttribute('role', 'listitem');
                const details = createElement('div', 'qosm-source-details');
                const name = createElement('div', 'qosm-source-name', normalizeText(source?.name) || normalizeText(source?.id));
                const description = normalizeText(source?.description);
                const metadata = sourceMeta(source);
                details.append(name);
                if (description) {
                    const descriptionNode = createElement('div', 'qosm-source-description', description);
                    descriptionNode.title = description;
                    details.append(descriptionNode);
                }
                if (metadata) {
                    details.append(createElement('div', 'qosm-source-meta', metadata));
                }
                const remove = createElement('button', 'qosm-delete', '删除');
                remove.type = 'button';
                remove.dataset.sourceId = normalizeText(source?.id);
                remove.disabled = busy;
                remove.setAttribute('aria-label', `删除 ${normalizeText(source?.name) || normalizeText(source?.id)}`);
                row.append(details, remove);
                fragment.append(row);
            }
            list.append(fragment);
        };

        const adoptResult = result => {
            if (Array.isArray(result?.sources)) {
                sources = result.sources.slice(0, 128);
            }
            render();
        };

        const closeDialog = () => {
            if (!dialog) {
                return;
            }
            dialog.layer.remove();
            dialog = null;
            importButton.focus({ preventScroll: true });
        };

        const runAction = async (request, successMessage = '') => {
            if (busy) {
                return null;
            }
            setBusy(true);
            try {
                if (typeof options.action !== 'function') {
                    throw new Error('在线音源服务不可用');
                }
                const result = await options.action(request);
                adoptResult(result);
                if (!result?.ok) {
                    throw new Error(normalizeText(result?.message) || '在线音源操作失败');
                }
                if (successMessage) {
                    setStatus(successMessage, 'success');
                }
                return result;
            } catch (error) {
                setStatus(normalizeText(error?.message) || '在线音源操作失败', 'error');
                return null;
            } finally {
                setBusy(false);
            }
        };

        const refresh = async () => {
            if (busy) {
                return;
            }
            setBusy(true);
            try {
                if (typeof options.getState !== 'function') {
                    throw new Error('在线音源服务不可用');
                }
                const result = await options.getState();
                adoptResult(result);
                if (!result?.ok) {
                    throw new Error(normalizeText(result?.message) || '读取在线音源失败');
                }
                setStatus('');
            } catch (error) {
                setStatus(normalizeText(error?.message) || '读取在线音源失败', 'error');
            } finally {
                setBusy(false);
            }
        };

        const openDialog = (kind, source = null) => {
            if (dialog || busy) {
                return;
            }
            const isDelete = kind === 'delete';
            const dialogLayer = createElement('div', 'qosm-dialog-layer');
            const form = createElement('form', 'qosm-dialog');
            const dialogTitle = createElement('h3', 'qosm-dialog-title', isDelete ? '删除音源' : '导入音源');
            const message = createElement(
                'div',
                'qosm-dialog-message',
                isDelete
                    ? `确定删除“${normalizeText(source?.name) || normalizeText(source?.id)}”吗？`
                    : '支持 LXMusic、CeruMusic、QT MusicPlugin 或 MusicFree 清单'
            );
            const input = createElement('textarea', 'qosm-dialog-input');
            input.maxLength = 512 * 1024 * 3;
            input.rows = 7;
            input.placeholder = 'https://example.com/source.js';
            input.setAttribute('aria-label', '音源脚本、MusicFree 清单、URL 或本地路径');
            input.hidden = isDelete;
            const actions = createElement('div', 'qosm-dialog-actions');
            const cancel = createElement('button', 'qosm-button', '取消');
            const confirm = createElement('button', `qosm-button${isDelete ? ' qosm-danger' : ' qosm-primary'}`, isDelete ? '删除' : '导入');
            cancel.type = 'button';
            confirm.type = 'submit';
            actions.append(cancel, confirm);
            form.append(dialogTitle, message, input, actions);
            dialogLayer.append(form);
            page.append(dialogLayer);
            dialog = { layer: dialogLayer, form, input, cancel, confirm };
            cancel.addEventListener('click', closeDialog);
            form.addEventListener('submit', async event => {
                event.preventDefault();
                if (busy) {
                    return;
                }
                const request = isDelete
                    ? { type: 'delete', id: source?.id }
                    : { type: 'import', input: normalizeText(input.value) };
                if (!isDelete && !request.input) {
                    input.focus({ preventScroll: true });
                    return;
                }
                const result = await runAction(request, isDelete ? '已删除音源' : '已导入音源');
                if (result) {
                    closeDialog();
                }
            });
            dialogLayer.addEventListener('pointerdown', event => {
                if (event.target === dialogLayer && !busy) {
                    closeDialog();
                }
            });
            (isDelete ? confirm : input).focus({ preventScroll: true });
        };

        importButton.addEventListener('click', () => openDialog('import'));
        refreshButton.addEventListener('click', refresh);
        closeButton.addEventListener('click', close);
        list.addEventListener('click', event => {
            const button = event.target.closest?.('.qosm-delete[data-source-id]');
            if (!button || busy) {
                return;
            }
            const source = sources.find(item => normalizeText(item?.id) === button.dataset.sourceId);
            if (source) {
                openDialog('delete', source);
            }
        });
        layer.addEventListener('keydown', event => {
            if (event.key !== 'Escape') {
                return;
            }
            event.preventDefault();
            if (dialog && !busy) {
                closeDialog();
            } else if (!busy) {
                close();
            }
        });

        cleanup = () => {
            disposed = true;
            window.clearTimeout(statusTimer);
            dialog?.layer.remove();
            dialog = null;
        };
        render();
        await refresh();
        if (!disposed) {
            layer.focus({ preventScroll: true });
        }
    }

    return Object.freeze({ close, open });
}
