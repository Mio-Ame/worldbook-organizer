/**
 * Worldbook Organizer — Shared Multi-Open Accordion Entry List & Inline Editor.
 *
 * Design guarantees:
 * - Zero form DOM nodes in collapsed rows (`<div class="wbo-acc-editor-slot" hidden></div>`).
 * - Lazy-fetches a single entry via uncached `/api/worldinfo/get` ONLY when expanded,
 *   allowing 2~N entries to remain expanded simultaneously for side-by-side comparison.
 * - Unmounts form DOM immediately on clean collapse (confirm-guarded when dirty).
 * - Incremental 60-entry rendering (`继续加载 60 条` / `展开全部`) while search scans
 *   all entries in the book (title, keys, AND full body content) and always keeps any
 *   currently expanded entry mounted & visible.
 * - Per-editor undo/redo stack preserved across `Tab`/`Shift+Tab` indents, in-editor
 *   keyword find (`上一个 / 下一个`), 1-click copy, monospace toggle, live char/token count,
 *   and `spellcheck="false"` on all text fields.
 * - Lossless save via `saveWorldbookEntryPatch` (`mergeEntryPatchOntoRaw`) and in-place
 *   row refresh without disturbing other open editors or forcing mobile `.focus()`.
 */

import {
    WORLD_ENTRY_POSITIONS,
    estimateEntryTokens,
    reorderEntryUids,
    resolveEntryDisplayIndex,
    sortEntryListItems,
} from './core.js';
import {
    createWorldbookEntryDirect,
    deleteWorldbookEntryDirect,
    fetchSingleWorldbookEntry,
    fetchWorldbookEntryContentMatchedUids,
    fetchWorldbookEntryList,
    saveWorldbookEntriesOrderDirect,
    saveWorldbookEntryPatch,
    showToast,
} from './host.js';
import { findScrollableContent, scrollContentToItem } from './content-scroll.js';

const UNDO_SVG = '<svg class="wbo-undo-svg" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>';
const REDO_SVG = '<svg class="wbo-undo-svg" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/></svg>';

function esc(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function getPosLabel(pos) {
    return WORLD_ENTRY_POSITIONS.find((p) => p.value === pos)?.label || '角色定义前';
}

function formatEntryMetaText(item) {
    return `${getPosLabel(item.position)}${item.position === 4 ? ` @D${item.depth}` : ''} · 顺序 ${item.order}`;
}

function formatContentStats(text) {
    const s = String(text ?? '');
    return `${s.length} 字 · 约 ${estimateEntryTokens(s)} tokens`;
}

function normalizeSortMode(mode) {
    return mode === 'order' || mode === 'title' ? mode : 'custom';
}

const SORT_LABELS = { custom: '自定义排序', order: '顺序 (order)', title: '标题' };

/**
 * Mount the shared multi-open entry accordion inside `hostEl`.
 *
 * @param {HTMLElement} hostEl
 * @param {object} opts
 * @param {string} opts.worldName
 * @param {string | null} [opts.initialUid=null]
 * @param {number} [opts.pageSize=60]
 * @param {boolean} [opts.showToolbar=true]
 * @param {string} [opts.extraHeaderActionsHtml='']
 * @param {() => void} [opts.onOpenEntryGroups]
 * @param {() => boolean} [opts.getMonoFont]
 * @param {(nextMono: boolean) => void} [opts.onToggleMonoFont]
 * @param {() => boolean} [opts.getTallMode]
 * @param {(nextTall: boolean) => void} [opts.onToggleTallMode]
 * @param {() => boolean} [opts.getSyncOrder]
 * @param {() => 'custom' | 'order' | 'title'} [opts.getSortMode]
 * @param {(nextSort: 'custom' | 'order' | 'title') => void} [opts.onChangeSortMode]
 * @param {(action: string, target: HTMLElement) => void} [opts.onExtraAction]
 * @param {(info: { worldName: string, total: number, enabledCount: number, action: string, uid?: string }) => void} [opts.onEntryMutated]
 * @param {(uid: string | null) => void} [opts.onOpenNative]
 */
export function mountEntryAccordion(
    hostEl,
    {
        worldName,
        initialUid = null,
        pageSize = 60,
        showToolbar = true,
        extraHeaderActionsHtml = '',
        onOpenEntryGroups = null,
        getMonoFont = () => false,
        onToggleMonoFont = null,
        getTallMode = () => false,
        onToggleTallMode = null,
        getSyncOrder = () => false,
        getSortMode = () => 'custom',
        onChangeSortMode = null,
        onExtraAction = null,
        onEntryMutated = null,
        onOpenNative = null,
    } = {},
) {
    const cleanWorld = String(worldName ?? '').trim();
    const sliceStep = Math.max(1, Number(pageSize) || 60);

    let destroyed = false;
    let sortMode = normalizeSortMode(typeof getSortMode === 'function' ? getSortMode() : 'custom');
    let activeDragCleanup = null;
    let isReordering = false;
    let searchQuery = '';
    let searchSeq = 0;
    let searchTimer = null;
    /** @type {Set<string> | null} */
    let contentMatchUids = null;
    let shownLimit = sliceStep;
    let listState = { ok: false, total: 0, enabledCount: 0, items: [], error: '' };

    /** @type {Map<string, HTMLElement>} */
    const itemElByUid = new Map();
    /** @type {Map<string, { loading: boolean, entry?: any, syncDisabledFromHeader?: (nextDisable: boolean) => void, syncMonoFromSettings?: (mono: boolean) => void, syncOrderFromReorder?: (nextOrder: number) => void, isDirty: () => boolean, slotEl: HTMLElement, itemEl: HTMLElement }>} */
    const expandedEditors = new Map();

    hostEl.innerHTML = `
        <div class="wbo-acc-shell">
            <div class="wbo-preview-head wbo-acc-head">
                <span class="wbo-acc-summary">正在读取条目...</span>
                <span class="wbo-preview-head-actions wbo-acc-head-controls">
                    <span class="wbo-acc-sort-control">
                        <span class="wbo-acc-sort-size" aria-hidden="true">${SORT_LABELS[sortMode]}</span>
                        <select class="wbo-select wbo-acc-sort-select" data-acc-sort aria-label="条目排序方式" title="切换条目列表排序方式">
                            ${Object.entries(SORT_LABELS).map(([mode, label]) =>
                                `<option value="${mode}"${mode === sortMode ? ' selected' : ''}>${label}</option>`,
                            ).join('')}
                        </select>
                    </span>
                    ${extraHeaderActionsHtml}
                </span>
            </div>
            ${showToolbar ? `
                <div class="wbo-acc-toolbar">
                    <div class="wbo-search-wrap wbo-acc-search-wrap">
                        <i class="fa-solid fa-magnifying-glass"></i>
                        <input type="search" class="wbo-search-input wbo-acc-search" placeholder="搜索条目标题、触发词或正文..." autocomplete="off" spellcheck="false">
                    </div>
                    <div class="wbo-acc-toolbar-actions">
                        ${onOpenEntryGroups ? `<button type="button" class="wbo-btn wbo-acc-group-btn" data-acc-extra="open-entry-groups">
                            <i class="fa-solid fa-folder-tree" aria-hidden="true"></i> 条目分组
                        </button>` : ''}
                        <button type="button" class="wbo-btn wbo-btn-primary wbo-acc-new-btn">
                            <i class="fa-solid fa-plus" aria-hidden="true"></i> 新建条目
                        </button>
                    </div>
                </div>
            ` : ''}
            <div class="wbo-acc-list"></div>
            <div class="wbo-empty-hint wbo-acc-empty" hidden></div>
            <div class="wbo-acc-more-bar" hidden>
                <span class="wbo-acc-more-text"></span>
                <div class="wbo-acc-more-actions">
                    <button type="button" class="wbo-btn wbo-acc-load-more-btn">继续加载 ${sliceStep} 条</button>
                    <button type="button" class="wbo-btn wbo-acc-load-all-btn"></button>
                </div>
            </div>
        </div>
    `;

    const summaryEl = hostEl.querySelector('.wbo-acc-summary');
    const sortSelect = hostEl.querySelector('[data-acc-sort]');
    const sortSize = hostEl.querySelector('.wbo-acc-sort-size');
    const searchInput = hostEl.querySelector('.wbo-acc-search');
    const newBtn = hostEl.querySelector('.wbo-acc-new-btn');
    const listEl = hostEl.querySelector('.wbo-acc-list');
    const emptyEl = hostEl.querySelector('.wbo-acc-empty');
    const moreBarEl = hostEl.querySelector('.wbo-acc-more-bar');
    const moreTextEl = hostEl.querySelector('.wbo-acc-more-text');
    const loadMoreBtn = hostEl.querySelector('.wbo-acc-load-more-btn');
    const loadAllBtn = hostEl.querySelector('.wbo-acc-load-all-btn');

    const updateSummary = () => {
        if (!summaryEl) return;
        if (!listState.ok) {
            summaryEl.textContent = listState.error || '读取失败';
            return;
        }
        const total = listState.items.length;
        const enabledCount = listState.items.filter((x) => !x.disable).length;
        listState.total = total;
        listState.enabledCount = enabledCount;
        summaryEl.textContent = total === 0
            ? '暂无条目内容'
            : `共 ${total} 条（启用 ${enabledCount} 条）`;
    };

    const patchRowHeaderDom = (itemEl, item) => {
        if (!(itemEl instanceof HTMLElement) || !item) return;
        itemEl.classList.toggle('is-disabled', Boolean(item.disable));
        const dotEl = itemEl.querySelector('.wbo-eb-dot');
        if (dotEl) {
            dotEl.className = `wbo-eb-dot ${item.constant ? 'is-const' : 'is-key'}`;
            dotEl.setAttribute('title', item.constant ? '蓝灯（常驻）' : '绿灯（关键词触发）');
        }
        const titleEl = itemEl.querySelector('.wbo-eb-row-title');
        if (titleEl) titleEl.textContent = item.title;
        const keysEl = itemEl.querySelector('.wbo-eb-keys');
        if (keysEl) {
            const kwPreview = (item.keys || []).slice(0, 4).join(' / ');
            keysEl.textContent = kwPreview || '无触发词';
            keysEl.classList.toggle('is-empty', !kwPreview);
        }
        const posEl = itemEl.querySelector('.wbo-eb-pos');
        if (posEl) posEl.textContent = formatEntryMetaText(item);
        const toggleCb = itemEl.querySelector('.wbo-acc-toggle-enable');
        if (toggleCb instanceof HTMLInputElement) {
            toggleCb.checked = !item.disable;
        }
        const switchLbl = itemEl.querySelector('.wbo-eb-switch');
        if (switchLbl) {
            switchLbl.setAttribute('title', item.disable ? '点击启用' : '点击禁用');
        }
    };

    const syncSortHandlesUi = () => {
        const locked = sortMode !== 'custom';
        const title = locked ? '切回「自定义排序」后可拖动调序' : '拖动调整条目顺序';
        for (const el of itemElByUid.values()) {
            const handle = el.querySelector('[data-acc-drag-handle]');
            if (handle instanceof HTMLElement) {
                handle.classList.toggle('is-sort-locked', locked);
                handle.setAttribute('title', title);
            }
        }
    };

    const reconcileListDomOrder = () => {
        if (!(listEl instanceof HTMLElement)) return;
        let afterNode = null;
        for (let i = listState.items.length - 1; i >= 0; i -= 1) {
            const el = itemElByUid.get(listState.items[i].uid);
            if (!el || el.parentElement !== listEl) continue;
            if (el.nextElementSibling !== afterNode) {
                listEl.insertBefore(el, afterNode);
            }
            afterNode = el;
        }
    };

    const createRowElement = (item) => {
        const kwPreview = (item.keys || []).slice(0, 4).join(' / ');
        const metaText = formatEntryMetaText(item);
        const locked = sortMode !== 'custom';
        const wrapper = document.createElement('div');
        wrapper.className = `wbo-acc-item${item.disable ? ' is-disabled' : ''}`;
        wrapper.setAttribute('data-acc-uid', item.uid);
        wrapper.innerHTML = `
            <div class="wbo-acc-row">
                <span class="wbo-acc-drag-handle${locked ? ' is-sort-locked' : ''}" data-acc-drag-handle title="${locked ? '切回「自定义排序」后可拖动调序' : '拖动调整条目顺序'}" aria-label="拖动调整条目顺序"><i class="fa-solid fa-grip-vertical"></i></span>
                <button type="button" class="wbo-acc-row-main" data-acc-toggle="${esc(item.uid)}" aria-expanded="false" title="点击展开或收起编辑">
                    <i class="fa-solid fa-chevron-right wbo-acc-chev"></i>
                    <span class="wbo-eb-dot ${item.constant ? 'is-const' : 'is-key'}" title="${item.constant ? '蓝灯（常驻）' : '绿灯（关键词触发）'}"></span>
                    <span class="wbo-eb-row-text">
                        <span class="wbo-eb-row-title">${esc(item.title)}</span>
                        <span class="wbo-eb-row-meta">
                            ${kwPreview ? `<span class="wbo-eb-keys">${esc(kwPreview)}</span>` : '<span class="wbo-eb-keys is-empty">无触发词</span>'}
                            <span class="wbo-eb-pos">${esc(metaText)}</span>
                        </span>
                    </span>
                </button>
                <label class="wbo-tool-switch wbo-eb-switch" title="${item.disable ? '点击启用' : '点击禁用'}">
                    <input type="checkbox" class="wbo-acc-toggle-enable" data-acc-enable="${esc(item.uid)}"${item.disable ? '' : ' checked'}>
                    <span class="wbo-switch-track"></span>
                </label>
            </div>
            <div class="wbo-acc-editor-slot" hidden></div>
        `;
        return wrapper;
    };

    const insertItemElementAtIndex = (item, idx) => {
        if (!(listEl instanceof HTMLElement)) return null;
        let el = itemElByUid.get(item.uid);
        if (el) return el;
        el = createRowElement(item);
        itemElByUid.set(item.uid, el);

        let nextSibling = null;
        for (let j = idx + 1; j < listState.items.length; j += 1) {
            const candidate = itemElByUid.get(listState.items[j].uid);
            if (candidate && candidate.parentElement === listEl) {
                nextSibling = candidate;
                break;
            }
        }
        if (nextSibling) {
            listEl.insertBefore(el, nextSibling);
        } else {
            listEl.appendChild(el);
        }
        return el;
    };

    const syncVisibleRows = () => {
        if (!(listEl instanceof HTMLElement)) return;
        if (!listState.ok) {
            if (emptyEl instanceof HTMLElement) {
                emptyEl.hidden = false;
                emptyEl.textContent = listState.error || '读取失败';
            }
            if (moreBarEl instanceof HTMLElement) moreBarEl.hidden = true;
            return;
        }

        if (listState.items.length === 0) {
            if (emptyEl instanceof HTMLElement) {
                emptyEl.hidden = false;
                emptyEl.textContent = '该世界书暂无条目，可点「新建条目」创建';
            }
            if (moreBarEl instanceof HTMLElement) moreBarEl.hidden = true;
            return;
        }

        const q = searchQuery.trim().toLowerCase();
        let visibleCount = 0;

        for (let i = 0; i < listState.items.length; i += 1) {
            const item = listState.items[i];
            const isExpanded = expandedEditors.has(item.uid);
            let matches = false;
            if (!q) {
                matches = i < shownLimit;
            } else {
                const openCtrl = expandedEditors.get(item.uid);
                const openContent = openCtrl?.entry ? String(openCtrl.getCurrentContent?.() ?? '') : '';
                matches =
                    item.searchText.includes(q) ||
                    item.title.toLowerCase().includes(q) ||
                    Boolean(contentMatchUids && contentMatchUids.has(item.uid)) ||
                    Boolean(openContent && openContent.toLowerCase().includes(q));
            }
            const shouldShow = matches || isExpanded;

            if (shouldShow) {
                const el = insertItemElementAtIndex(item, i);
                if (el) el.hidden = false;
                visibleCount += 1;
            } else {
                const existing = itemElByUid.get(item.uid);
                if (existing) existing.hidden = true;
            }
        }

        reconcileListDomOrder();

        if (emptyEl instanceof HTMLElement) {
            if (visibleCount === 0 && q) {
                emptyEl.hidden = false;
                emptyEl.textContent = '无匹配条目';
            } else {
                emptyEl.hidden = true;
            }
        }

        if (moreBarEl instanceof HTMLElement) {
            const remaining = Math.max(0, listState.items.length - shownLimit);
            if (q || remaining <= 0) {
                moreBarEl.hidden = true;
            } else {
                moreBarEl.hidden = false;
                const shownSoFar = Math.min(shownLimit, listState.items.length);
                if (moreTextEl) {
                    moreTextEl.textContent = `已展示 ${shownSoFar} / ${listState.items.length} 条（剩余 ${remaining} 条）`;
                }
                if (loadMoreBtn instanceof HTMLButtonElement) {
                    const nextBatch = Math.min(sliceStep, remaining);
                    loadMoreBtn.textContent = `继续加载 ${nextBatch} 条`;
                    loadMoreBtn.hidden = false;
                }
                if (loadAllBtn instanceof HTMLButtonElement) {
                    loadAllBtn.textContent = `展开全部（剩余 ${remaining} 条）`;
                    loadAllBtn.hidden = remaining <= sliceStep;
                }
            }
        }
    };

    const runSearchWithFullContent = () => {
        const q = searchQuery.trim();
        searchSeq += 1;
        const seq = searchSeq;
        clearTimeout(searchTimer);
        if (!q) {
            contentMatchUids = null;
            syncVisibleRows();
            return;
        }
        syncVisibleRows();
        searchTimer = setTimeout(async () => {
            try {
                const matched = await fetchWorldbookEntryContentMatchedUids(cleanWorld, q);
                if (destroyed || seq !== searchSeq) return;
                contentMatchUids = matched;
                syncVisibleRows();
            } catch {
                // Keep title/keys matches if transient fetch fails
            }
        }, 40);
    };

    const applyTabIndent = (textarea, isShift) => {
        const value = textarea.value;
        const start = textarea.selectionStart ?? 0;
        const end = textarea.selectionEnd ?? 0;
        const indentUnit = '  ';

        if (start === end && !isShift) {
            textarea.value = `${value.slice(0, start)}${indentUnit}${value.slice(end)}`;
            textarea.selectionStart = textarea.selectionEnd = start + indentUnit.length;
        } else {
            const lineStart = value.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
            const rawLineEnd = value.indexOf('\n', end);
            const lineEnd = rawLineEnd === -1 ? value.length : rawLineEnd;
            const block = value.slice(lineStart, lineEnd);
            const lines = block.split('\n');
            let firstDelta = 0;
            let totalDelta = 0;

            const updatedLines = lines.map((line, idx) => {
                if (isShift) {
                    let removeLen = 0;
                    if (line.startsWith(indentUnit)) removeLen = indentUnit.length;
                    else if (line.startsWith('\t') || line.startsWith(' ')) removeLen = 1;
                    if (idx === 0) firstDelta = -removeLen;
                    totalDelta -= removeLen;
                    return line.slice(removeLen);
                }
                if (idx === 0) firstDelta = indentUnit.length;
                totalDelta += indentUnit.length;
                return `${indentUnit}${line}`;
            });

            const replaced = updatedLines.join('\n');
            textarea.value = `${value.slice(0, lineStart)}${replaced}${value.slice(lineEnd)}`;
            const nextStart = Math.max(lineStart, start + firstDelta);
            const nextEnd = Math.max(nextStart, end + totalDelta);
            textarea.selectionStart = nextStart;
            textarea.selectionEnd = nextEnd;
        }
    };

    const buildMetaBrief = ({ enabled, constant, keyText, position, depth, order }) => {
        const stateText = enabled ? '启用' : '已禁用';
        const modeText = constant ? '蓝灯' : '绿灯';
        const kwCount = String(keyText ?? '').split(/[,\n，、]+/).map((s) => s.trim()).filter(Boolean).length;
        const kwText = kwCount > 0 ? `${kwCount} 词` : '无词';
        const posNum = Number(position);
        const posText = `${getPosLabel(Number.isFinite(posNum) ? posNum : 0)}${posNum === 4 ? ` @D${depth}` : ''}`;
        const ordText = `顺序 ${order}`;
        return `${stateText} · ${modeText} · ${kwText} · ${posText} · ${ordText}`;
    };

    const mountEditorIntoSlot = (itemEl, slotEl, entry) => {
        const uid = String(entry.uid);
        const posOptsHtml = WORLD_ENTRY_POSITIONS.map(
            (p) => `<option value="${p.value}"${Number(entry.position) === p.value ? ' selected' : ''}>${esc(p.label)}</option>`,
        ).join('');
        const initialMono = Boolean(getMonoFont());
        const initialTall = Boolean(getTallMode());
        const initialBrief = buildMetaBrief({
            enabled: !entry.disable,
            constant: Boolean(entry.constant),
            keyText: (entry.key || []).join(', '),
            position: entry.position ?? 0,
            depth: entry.depth ?? 4,
            order: entry.order ?? 100,
        });

        slotEl.innerHTML = `
            <div class="wbo-acc-editor" data-acc-editor-uid="${esc(uid)}">
                <div class="wbo-field wbo-acc-title-field">
                    <label class="wbo-label">条目标题（注释）</label>
                    <input type="text" class="wbo-input" data-acc-field="comment" value="${esc(entry.comment)}" placeholder="用于列表识别的条目标题" spellcheck="false">
                </div>
                <div class="wbo-field wbo-acc-content-field">
                    <div class="wbo-acc-editor-toolbar">
                        <div class="wbo-acc-toolbar-left">
                            <span class="wbo-label">条目正文</span>
                            <span class="wbo-acc-stats" data-acc-stats>${esc(formatContentStats(entry.content))}</span>
                        </div>
                        <div class="wbo-acc-toolbar-right">
                            <span class="wbo-btn-pair">
                                <button type="button" class="wbo-btn wbo-acc-mini-btn" data-acc-undo disabled title="撤回上一步正文修改 (Ctrl+Z)">
                                    ${UNDO_SVG}<span>撤回</span>
                                </button>
                                <button type="button" class="wbo-btn wbo-acc-mini-btn" data-acc-redo disabled title="重做 / 取消撤回 (Ctrl+Y)">
                                    ${REDO_SVG}<span>重做</span>
                                </button>
                            </span>
                            <button type="button" class="wbo-btn wbo-acc-mini-btn" data-acc-copy title="复制当前条目正文">
                                <i class="fa-regular fa-copy"></i><span>复制正文</span>
                            </button>
                            <button type="button" class="wbo-btn wbo-acc-mini-btn${initialMono ? ' is-active' : ''}" data-acc-mono aria-pressed="${initialMono ? 'true' : 'false'}" title="切换等宽代码字体 / 常规字体">
                                <i class="fa-solid fa-code"></i><span>${initialMono ? '常规字体' : '等宽代码字体'}</span>
                            </button>
                            <button type="button" class="wbo-btn wbo-acc-mini-btn${initialTall ? ' is-active' : ''}" data-acc-tall aria-pressed="${initialTall ? 'true' : 'false'}" title="${initialTall ? '恢复默认编辑区高度' : '加高编辑区以便阅读和修改长文本'}">
                                <i class="fa-solid fa-up-down"></i><span>${initialTall ? '恢复默认高度' : '加高编辑区'}</span>
                            </button>
                        </div>
                    </div>
                    <div class="wbo-acc-find-row">
                        <input type="search" class="wbo-input wbo-acc-find-input" data-acc-find-input placeholder="框内查找关键词..." autocomplete="off" spellcheck="false">
                        <div class="wbo-acc-find-nav">
                            <span class="wbo-acc-find-count" data-acc-find-count></span>
                            <button type="button" class="wbo-btn wbo-acc-mini-btn" data-acc-find-prev title="查找上一个 (Shift+Enter)">上一个</button>
                            <button type="button" class="wbo-btn wbo-acc-mini-btn" data-acc-find-next title="查找下一个 (Enter)">下一个</button>
                        </div>
                    </div>
                    <div class="wbo-acc-ta-wrap" data-acc-ta-wrap>
                        <div class="wbo-acc-ta-backdrop" data-acc-ta-backdrop aria-hidden="true" hidden></div>
                        <textarea class="wbo-textarea wbo-ee-textarea wbo-acc-textarea${initialMono ? ' is-mono' : ''}${initialTall ? ' is-tall' : ''}" data-acc-field="content" placeholder="输入世界书条目正文..." spellcheck="false"></textarea>
                    </div>
                </div>
                <details class="wbo-collapse-box wbo-acc-meta-details">
                    <summary class="wbo-collapse-summary wbo-acc-meta-summary">
                        <span class="wbo-acc-meta-title">触发词与策略设置</span>
                        <span class="wbo-acc-meta-brief" data-acc-meta-brief>${esc(initialBrief)}</span>
                    </summary>
                    <div class="wbo-acc-meta-body">
                        <div class="wbo-field">
                            <label class="wbo-label">状态与触发灯</label>
                            <div class="wbo-ee-inline-flags">
                                <label class="wbo-check-line">
                                    <input type="checkbox" data-acc-field="enabled"${entry.disable ? '' : ' checked'}>
                                    <span>启用</span>
                                </label>
                                <select class="wbo-select wbo-ee-mode-select" data-acc-field="mode">
                                    <option value="green"${!entry.constant ? ' selected' : ''}>绿灯 · 关键词触发</option>
                                    <option value="blue"${entry.constant ? ' selected' : ''}>蓝灯 · 常驻激活</option>
                                </select>
                            </div>
                        </div>
                        <div class="wbo-ee-row-2col">
                            <div class="wbo-field">
                                <label class="wbo-label">主触发词（逗号或换行分隔）</label>
                                <input type="text" class="wbo-input" data-acc-field="key" value="${esc((entry.key || []).join(', '))}" placeholder="关键词1, 关键词2" spellcheck="false">
                            </div>
                            <div class="wbo-field">
                                <label class="wbo-label">次触发词（可选）</label>
                                <input type="text" class="wbo-input" data-acc-field="keysecondary" value="${esc((entry.keysecondary || []).join(', '))}" placeholder="辅助过滤词1, 词2" spellcheck="false">
                            </div>
                        </div>
                        <div class="wbo-ee-row-3col">
                            <div class="wbo-field">
                                <label class="wbo-label">插入位置</label>
                                <select class="wbo-select" data-acc-field="position">${posOptsHtml}</select>
                            </div>
                            <div class="wbo-field">
                                <label class="wbo-label">深度 (@D)</label>
                                <input type="number" class="wbo-input" data-acc-field="depth" min="0" step="1" value="${esc(String(entry.depth))}">
                            </div>
                            <div class="wbo-field">
                                <label class="wbo-label">插入顺序</label>
                                <input type="number" class="wbo-input" data-acc-field="order" step="1" value="${esc(String(entry.order))}">
                            </div>
                        </div>
                    </div>
                </details>
                <div class="wbo-acc-editor-footer">
                    <span class="wbo-btn-pair">
                        <button type="button" class="wbo-btn wbo-btn-primary" data-acc-save>保存</button>
                        <button type="button" class="wbo-btn" data-acc-collapse>收起</button>
                    </span>
                    <span class="wbo-btn-pair">
                        <button type="button" class="wbo-btn" data-acc-native title="跳转到酒馆原生编辑器定位该条目">
                            <i class="fa-solid fa-arrow-up-right-from-square"></i> 跳原生定位
                        </button>
                        <button type="button" class="wbo-btn wbo-acc-del-entry-btn" data-acc-delete title="永久删除此条目">
                            <i class="fa-regular fa-trash-can"></i> 删除条目
                        </button>
                    </span>
                    <span class="wbo-acc-save-status" data-acc-status></span>
                </div>
            </div>
        `;

        const commentInput = slotEl.querySelector('[data-acc-field="comment"]');
        const enabledCb = slotEl.querySelector('[data-acc-field="enabled"]');
        const modeSelect = slotEl.querySelector('[data-acc-field="mode"]');
        const keysInput = slotEl.querySelector('[data-acc-field="key"]');
        const keys2Input = slotEl.querySelector('[data-acc-field="keysecondary"]');
        const posSelect = slotEl.querySelector('[data-acc-field="position"]');
        const depthInput = slotEl.querySelector('[data-acc-field="depth"]');
        const orderInput = slotEl.querySelector('[data-acc-field="order"]');
        const metaBriefEl = slotEl.querySelector('[data-acc-meta-brief]');
        const taWrapEl = slotEl.querySelector('[data-acc-ta-wrap]');
        const taBackdropEl = slotEl.querySelector('[data-acc-ta-backdrop]');
        const contentArea = slotEl.querySelector('[data-acc-field="content"]');
        const statsEl = slotEl.querySelector('[data-acc-stats]');
        const undoBtn = slotEl.querySelector('[data-acc-undo]');
        const redoBtn = slotEl.querySelector('[data-acc-redo]');
        const copyBtn = slotEl.querySelector('[data-acc-copy]');
        const findInput = slotEl.querySelector('[data-acc-find-input]');
        const findCountEl = slotEl.querySelector('[data-acc-find-count]');
        const findPrevBtn = slotEl.querySelector('[data-acc-find-prev]');
        const findNextBtn = slotEl.querySelector('[data-acc-find-next]');
        const monoBtn = slotEl.querySelector('[data-acc-mono]');
        const tallBtn = slotEl.querySelector('[data-acc-tall]');
        const saveBtn = slotEl.querySelector('[data-acc-save]');
        const collapseBtn = slotEl.querySelector('[data-acc-collapse]');
        const nativeBtn = slotEl.querySelector('[data-acc-native]');
        const deleteBtn = slotEl.querySelector('[data-acc-delete]');
        const statusEl = slotEl.querySelector('[data-acc-status]');

        // Lightweight per-editor undo/redo stack (survives Tab/Shift+Tab indents)
        const undoStack = [{
            content: String(entry.content ?? ''),
            selectionStart: 0,
            selectionEnd: 0,
            at: 0,
            coalesceable: false,
        }];
        const redoStack = [];
        const MAX_UNDO_STEPS = 80;

        const syncHistoryButtons = () => {
            if (undoBtn instanceof HTMLButtonElement) undoBtn.disabled = undoStack.length <= 1;
            if (redoBtn instanceof HTMLButtonElement) redoBtn.disabled = redoStack.length === 0;
        };

        const pushHistoryState = ({ coalesce = false } = {}) => {
            if (!(contentArea instanceof HTMLTextAreaElement)) return;
            const curVal = contentArea.value;
            const top = undoStack[undoStack.length - 1];
            if (top && top.content === curVal) return;
            const now = Date.now();
            const selStart = contentArea.selectionStart ?? curVal.length;
            const selEnd = contentArea.selectionEnd ?? curVal.length;

            if (coalesce && top?.coalesceable && undoStack.length > 1 && now - top.at < 650) {
                undoStack[undoStack.length - 1] = {
                    content: curVal,
                    selectionStart: selStart,
                    selectionEnd: selEnd,
                    at: now,
                    coalesceable: true,
                };
            } else {
                undoStack.push({
                    content: curVal,
                    selectionStart: selStart,
                    selectionEnd: selEnd,
                    at: now,
                    coalesceable: coalesce,
                });
                if (undoStack.length > MAX_UNDO_STEPS) {
                    undoStack.shift();
                }
            }
            redoStack.length = 0;
            syncHistoryButtons();
        };

        const applyHistoryFrame = (frame) => {
            if (!(contentArea instanceof HTMLTextAreaElement) || !frame) return;
            contentArea.value = frame.content;
            try {
                contentArea.setSelectionRange(frame.selectionStart ?? 0, frame.selectionEnd ?? 0);
            } catch { /* ignore */ }
            if (statsEl) statsEl.textContent = formatContentStats(contentArea.value);
            updateFindMatchCount();
            syncHistoryButtons();
        };

        const performUndo = () => {
            if (undoStack.length <= 1) return false;
            const currentFrame = undoStack.pop();
            if (currentFrame) redoStack.push(currentFrame);
            applyHistoryFrame(undoStack[undoStack.length - 1]);
            return true;
        };

        const performRedo = () => {
            if (redoStack.length === 0) return false;
            const nextFrame = redoStack.pop();
            if (!nextFrame) return false;
            undoStack.push(nextFrame);
            applyHistoryFrame(nextFrame);
            return true;
        };

        // In-editor keyword find + live in-textarea highlight box overlay
        let findCursorIdx = -1;
        /** @type {ResizeObserver | null} */
        let taResizeObserver = null;

        const collectFindMatches = (needleRaw) => {
            if (!(contentArea instanceof HTMLTextAreaElement)) return [];
            const needle = String(needleRaw ?? '').toLowerCase();
            if (!needle) return [];
            const hay = contentArea.value.toLowerCase();
            const indices = [];
            let pos = 0;
            while (pos <= hay.length - needle.length) {
                const idx = hay.indexOf(needle, pos);
                if (idx < 0) break;
                indices.push(idx);
                pos = idx + Math.max(1, needle.length);
            }
            return indices;
        };

        const syncBackdropMetrics = () => {
            if (!(contentArea instanceof HTMLTextAreaElement) || !(taBackdropEl instanceof HTMLElement)) return;
            if (taBackdropEl.hidden || typeof globalThis.getComputedStyle !== 'function') return;
            try {
                const cs = globalThis.getComputedStyle(contentArea);
                const bl = parseFloat(cs.borderLeftWidth) || 0;
                const br = parseFloat(cs.borderRightWidth) || 0;
                const pr = parseFloat(cs.paddingRight) || 0;
                const scrollbarW = Math.max(0, (contentArea.offsetWidth || 0) - (contentArea.clientWidth || 0) - bl - br);
                taBackdropEl.style.fontFamily = cs.fontFamily;
                taBackdropEl.style.fontSize = cs.fontSize;
                taBackdropEl.style.fontWeight = cs.fontWeight;
                taBackdropEl.style.lineHeight = cs.lineHeight;
                taBackdropEl.style.letterSpacing = cs.letterSpacing;
                taBackdropEl.style.paddingTop = cs.paddingTop;
                taBackdropEl.style.paddingBottom = cs.paddingBottom;
                taBackdropEl.style.paddingLeft = cs.paddingLeft;
                taBackdropEl.style.paddingRight = `${pr + scrollbarW}px`;
                taBackdropEl.style.borderRadius = cs.borderRadius;
                taBackdropEl.scrollTop = contentArea.scrollTop;
            } catch { /* ignore */ }
        };

        const syncFindHighlights = ({ scrollToActive = false, focusTextarea = false } = {}) => {
            const q = findInput instanceof HTMLInputElement ? findInput.value : '';
            if (!q || !(contentArea instanceof HTMLTextAreaElement)) {
                findCursorIdx = -1;
                if (findCountEl) findCountEl.textContent = '';
                if (taBackdropEl instanceof HTMLElement) {
                    taBackdropEl.hidden = true;
                    taBackdropEl.innerHTML = '';
                }
                taWrapEl?.classList.remove('has-find-hl');
                return;
            }

            const matches = collectFindMatches(q);
            if (matches.length === 0) {
                findCursorIdx = -1;
                if (findCountEl) findCountEl.textContent = '0/0';
                if (taBackdropEl instanceof HTMLElement) {
                    taBackdropEl.hidden = true;
                    taBackdropEl.innerHTML = '';
                }
                taWrapEl?.classList.remove('has-find-hl');
                return;
            }

            if (findCursorIdx < 0 || findCursorIdx >= matches.length) {
                findCursorIdx = 0;
            }
            if (findCountEl) {
                findCountEl.textContent = `${findCursorIdx + 1}/${matches.length}`;
            }

            if (taBackdropEl instanceof HTMLElement) {
                const raw = contentArea.value;
                const parts = [];
                let cursor = 0;
                for (let i = 0; i < matches.length; i += 1) {
                    const mStart = matches[i];
                    const mEnd = mStart + q.length;
                    if (mStart > cursor) parts.push(esc(raw.slice(cursor, mStart)));
                    const cls = i === findCursorIdx ? 'wbo-acc-hl-mark is-current' : 'wbo-acc-hl-mark';
                    parts.push(`<mark class="${cls}">${esc(raw.slice(mStart, mEnd))}</mark>`);
                    cursor = mEnd;
                }
                if (cursor < raw.length) parts.push(esc(raw.slice(cursor)));
                if (raw.endsWith('\n')) parts.push(' ');
                taBackdropEl.innerHTML = parts.join('');
                taBackdropEl.hidden = false;
                taWrapEl?.classList.add('has-find-hl');
                syncBackdropMetrics();
            }

            const activeStart = matches[findCursorIdx];
            const activeEnd = activeStart + q.length;

            if (scrollToActive) {
                const currentMark = taBackdropEl?.querySelector?.('.wbo-acc-hl-mark.is-current');
                if (currentMark instanceof HTMLElement && contentArea.scrollHeight > contentArea.clientHeight) {
                    const targetTop = Math.max(0, currentMark.offsetTop - contentArea.clientHeight / 3);
                    contentArea.scrollTop = targetTop;
                } else if (contentArea.scrollHeight > contentArea.clientHeight) {
                    const lineCountBefore = contentArea.value.slice(0, activeStart).split('\n').length - 1;
                    contentArea.scrollTop = Math.max(0, lineCountBefore * 20 - contentArea.clientHeight / 3);
                }
                if (taBackdropEl instanceof HTMLElement) {
                    taBackdropEl.scrollTop = contentArea.scrollTop;
                }
            }

            if (focusTextarea) {
                const vw = globalThis.innerWidth || document.documentElement?.clientWidth || 1200;
                const coarse = typeof globalThis.matchMedia === 'function' && globalThis.matchMedia('(pointer: coarse)').matches;
                if (vw > 680 && !coarse) {
                    contentArea.focus({ preventScroll: true });
                }
                try { contentArea.setSelectionRange(activeStart, activeEnd); } catch { /* ignore */ }
            }
        };

        const updateFindMatchCount = () => {
            syncFindHighlights({ scrollToActive: false, focusTextarea: false });
        };

        const stepFindMatch = (dir = 1, { focusTextarea = false } = {}) => {
            if (!(contentArea instanceof HTMLTextAreaElement) || !(findInput instanceof HTMLInputElement)) return;
            const q = findInput.value;
            if (!q) {
                syncFindHighlights();
                return;
            }
            const matches = collectFindMatches(q);
            if (matches.length === 0) {
                findCursorIdx = -1;
                syncFindHighlights();
                return;
            }
            if (findCursorIdx < 0 || findCursorIdx >= matches.length) {
                findCursorIdx = dir >= 0 ? 0 : matches.length - 1;
            } else {
                findCursorIdx = (findCursorIdx + dir + matches.length) % matches.length;
            }
            syncFindHighlights({ scrollToActive: true, focusTextarea });
        };

        if (contentArea instanceof HTMLTextAreaElement) {
            contentArea.value = String(entry.content ?? '');
            if (statsEl) statsEl.textContent = formatContentStats(contentArea.value);
            contentArea.addEventListener('input', () => {
                if (statsEl) statsEl.textContent = formatContentStats(contentArea.value);
                pushHistoryState({ coalesce: true });
                updateFindMatchCount();
            });
            contentArea.addEventListener('scroll', () => {
                if (taBackdropEl instanceof HTMLElement && !taBackdropEl.hidden) {
                    taBackdropEl.scrollTop = contentArea.scrollTop;
                }
            }, { passive: true });
            if (typeof globalThis.ResizeObserver === 'function') {
                taResizeObserver = new globalThis.ResizeObserver(() => syncBackdropMetrics());
                taResizeObserver.observe(contentArea);
            }
            contentArea.addEventListener('keydown', (ev) => {
                if (ev.isComposing || ev.keyCode === 229) return;
                if (ev.key === 'Tab') {
                    ev.preventDefault();
                    pushHistoryState({ coalesce: false });
                    applyTabIndent(contentArea, ev.shiftKey);
                    if (statsEl) statsEl.textContent = formatContentStats(contentArea.value);
                    pushHistoryState({ coalesce: false });
                    updateFindMatchCount();
                    return;
                }
                if ((ev.ctrlKey || ev.metaKey) && !ev.altKey) {
                    const k = ev.key.toLowerCase();
                    if (k === 'z' && !ev.shiftKey) {
                        ev.preventDefault();
                        performUndo();
                    } else if (k === 'y' || (k === 'z' && ev.shiftKey)) {
                        ev.preventDefault();
                        performRedo();
                    }
                }
            });
        }

        undoBtn?.addEventListener('click', () => { performUndo(); });
        redoBtn?.addEventListener('click', () => { performRedo(); });

        copyBtn?.addEventListener('click', async () => {
            const text = contentArea instanceof HTMLTextAreaElement ? contentArea.value : String(entry.content ?? '');
            let copied = false;
            try {
                if (navigator?.clipboard?.writeText) {
                    await navigator.clipboard.writeText(text);
                    copied = true;
                }
            } catch {
                copied = false;
            }
            if (!copied && contentArea instanceof HTMLTextAreaElement) {
                try {
                    contentArea.select();
                    copied = Boolean(document.execCommand?.('copy'));
                } catch {
                    copied = false;
                }
            }
            if (statusEl) {
                statusEl.textContent = copied ? '已复制正文' : '复制受限，请手动全选复制';
                statusEl.className = `wbo-acc-save-status${copied ? ' is-success' : ' is-error'}`;
            }
            showToast(copied ? 'success' : 'warning', copied ? '已复制条目正文' : '剪贴板受限，请手动全选复制');
        });

        if (findInput instanceof HTMLInputElement) {
            let findComposing = false;
            findInput.addEventListener('compositionstart', () => { findComposing = true; });
            findInput.addEventListener('compositionend', () => {
                findComposing = false;
                findCursorIdx = 0;
                syncFindHighlights({ scrollToActive: true, focusTextarea: false });
            });
            findInput.addEventListener('input', () => {
                if (findComposing) return;
                findCursorIdx = 0;
                syncFindHighlights({ scrollToActive: true, focusTextarea: false });
            });
            findInput.addEventListener('keydown', (ev) => {
                if (ev.isComposing || ev.keyCode === 229 || findComposing) return;
                if (ev.key === 'Enter') {
                    ev.preventDefault();
                    stepFindMatch(ev.shiftKey ? -1 : 1, { focusTextarea: false });
                }
            });
        }
        findPrevBtn?.addEventListener('click', () => stepFindMatch(-1, { focusTextarea: true }));
        findNextBtn?.addEventListener('click', () => stepFindMatch(1, { focusTextarea: true }));

        const readFormSnapshot = () => ({
            comment: commentInput instanceof HTMLInputElement ? commentInput.value : String(entry.comment ?? ''),
            enabled: enabledCb instanceof HTMLInputElement ? enabledCb.checked : !entry.disable,
            mode: modeSelect instanceof HTMLSelectElement ? modeSelect.value : (entry.constant ? 'blue' : 'green'),
            key: keysInput instanceof HTMLInputElement ? keysInput.value : (entry.key || []).join(', '),
            keysecondary: keys2Input instanceof HTMLInputElement ? keys2Input.value : (entry.keysecondary || []).join(', '),
            position: posSelect instanceof HTMLSelectElement ? posSelect.value : String(entry.position ?? 0),
            depth: depthInput instanceof HTMLInputElement ? depthInput.value : String(entry.depth ?? 4),
            order: orderInput instanceof HTMLInputElement ? orderInput.value : String(entry.order ?? 100),
            content: contentArea instanceof HTMLTextAreaElement ? contentArea.value : String(entry.content ?? ''),
        });

        let baseline = readFormSnapshot();

        const isDirty = () => {
            const cur = readFormSnapshot();
            return Object.keys(baseline).some((k) => cur[k] !== baseline[k]);
        };

        const syncMonoUi = (monoOn) => {
            if (contentArea instanceof HTMLTextAreaElement) {
                contentArea.classList.toggle('is-mono', monoOn);
            }
            if (monoBtn instanceof HTMLElement) {
                monoBtn.classList.toggle('is-active', monoOn);
                monoBtn.setAttribute('aria-pressed', monoOn ? 'true' : 'false');
                const span = monoBtn.querySelector('span');
                if (span) span.textContent = monoOn ? '常规字体' : '等宽代码字体';
            }
            syncBackdropMetrics();
        };

        monoBtn?.addEventListener('click', () => {
            const nextMono = !getMonoFont();
            onToggleMonoFont?.(nextMono);
            for (const ctrl of expandedEditors.values()) {
                ctrl.syncMonoFromSettings?.(nextMono);
            }
        });

        let localTallOn = initialTall;
        const applyTallTextareaHeight = () => {
            if (!(contentArea instanceof HTMLTextAreaElement)) return;
            const scrollContainer = slotEl.closest('.wbo-groups-list, .wbo-step-scroll, .wbo-modal-body');
            const savedScrollTop = scrollContainer instanceof HTMLElement ? scrollContainer.scrollTop : null;
            const savedTaScroll = contentArea.scrollTop;
            if (localTallOn) {
                contentArea.style.height = 'auto';
                const naturalScrollH = contentArea.scrollHeight || 0;
                const targetH = Math.max(380, Math.min(560, naturalScrollH + 12));
                contentArea.style.height = `${targetH}px`;
            } else {
                contentArea.style.height = '';
            }
            contentArea.scrollTop = savedTaScroll;
            if (scrollContainer instanceof HTMLElement && savedScrollTop !== null) {
                scrollContainer.scrollTop = savedScrollTop;
            }
            syncBackdropMetrics();
        };
        const syncTallUi = (tallOn, { userTriggered = false } = {}) => {
            localTallOn = Boolean(tallOn);
            if (contentArea instanceof HTMLTextAreaElement) {
                const scrollContainer = slotEl.closest('.wbo-groups-list, .wbo-step-scroll, .wbo-modal-body');
                const savedScrollTop = scrollContainer instanceof HTMLElement ? scrollContainer.scrollTop : null;
                contentArea.classList.toggle('is-tall', localTallOn);
                applyTallTextareaHeight();
                if (scrollContainer instanceof HTMLElement && savedScrollTop !== null) {
                    scrollContainer.scrollTop = savedScrollTop;
                }
                if (userTriggered) {
                    requestAnimationFrame(() => {
                        applyTallTextareaHeight();
                        if (scrollContainer instanceof HTMLElement && savedScrollTop !== null) {
                            scrollContainer.scrollTop = savedScrollTop;
                        }
                    });
                }
            }
            if (tallBtn instanceof HTMLElement) {
                tallBtn.classList.toggle('is-active', localTallOn);
                tallBtn.setAttribute('aria-pressed', localTallOn ? 'true' : 'false');
                tallBtn.title = localTallOn ? '恢复默认编辑区高度' : '加高编辑区以便阅读和修改长文本';
                const span = tallBtn.querySelector('span');
                if (span) span.textContent = localTallOn ? '恢复默认高度' : '加高编辑区';
            }
        };
        if (initialTall) {
            requestAnimationFrame(applyTallTextareaHeight);
        }
        tallBtn?.addEventListener('click', () => {
            if (typeof onToggleTallMode === 'function') {
                const nextTall = !getTallMode();
                onToggleTallMode(nextTall);
                for (const ctrl of expandedEditors.values()) {
                    ctrl.syncTallFromSettings?.(nextTall, { userTriggered: ctrl.slotEl === slotEl });
                }
            } else {
                syncTallUi(!localTallOn, { userTriggered: true });
            }
        });

        const refreshMetaBrief = () => {
            if (!metaBriefEl) return;
            const snap = readFormSnapshot();
            metaBriefEl.textContent = buildMetaBrief({
                enabled: snap.enabled,
                constant: snap.mode === 'blue',
                keyText: snap.key,
                position: snap.position,
                depth: snap.depth,
                order: snap.order,
            });
        };
        for (const el of [enabledCb, modeSelect, keysInput, posSelect, depthInput, orderInput]) {
            el?.addEventListener('input', refreshMetaBrief);
            el?.addEventListener('change', refreshMetaBrief);
        }

        collapseBtn?.addEventListener('click', () => {
            collapseEntry(uid);
        });

        nativeBtn?.addEventListener('click', () => {
            onOpenNative?.(uid);
        });

        deleteBtn?.addEventListener('click', async () => {
            const curTitle = (commentInput instanceof HTMLInputElement ? commentInput.value.trim() : '')
                || listState.items.find((x) => x.uid === uid)?.title
                || `#${uid}`;
            if (!globalThis.confirm(`确定删除条目「${curTitle}」吗？删除后不可恢复。`)) {
                return;
            }
            if (deleteBtn instanceof HTMLButtonElement) deleteBtn.disabled = true;
            if (saveBtn instanceof HTMLButtonElement) saveBtn.disabled = true;
            if (statusEl) {
                statusEl.textContent = '正在删除...';
                statusEl.className = 'wbo-acc-save-status';
            }
            const res = await deleteWorldbookEntryDirect(cleanWorld, uid);
            if (destroyed) return;
            if (!res.ok) {
                if (deleteBtn instanceof HTMLButtonElement) deleteBtn.disabled = false;
                if (saveBtn instanceof HTMLButtonElement) saveBtn.disabled = false;
                if (statusEl) {
                    statusEl.textContent = res.error || '删除失败';
                    statusEl.className = 'wbo-acc-save-status is-error';
                }
                showToast('error', res.error || '删除条目失败');
                return;
            }
            taResizeObserver?.disconnect();
            taResizeObserver = null;
            expandedEditors.delete(uid);
            const removedEl = itemElByUid.get(uid);
            itemElByUid.delete(uid);
            removedEl?.remove();
            listState.items = listState.items.filter((x) => x.uid !== uid);
            updateSummary();
            syncVisibleRows();
            onEntryMutated?.({
                worldName: cleanWorld,
                total: listState.total,
                enabledCount: listState.enabledCount,
                action: 'delete',
                uid,
            });
            showToast('success', `已删除条目「${curTitle}」`);
        });

        saveBtn?.addEventListener('click', async () => {
            if (saveBtn instanceof HTMLButtonElement) saveBtn.disabled = true;
            if (statusEl) {
                statusEl.textContent = '正在保存...';
                statusEl.className = 'wbo-acc-save-status';
            }

            const snap = readFormSnapshot();
            const isBlue = snap.mode === 'blue';
            const posTrim = snap.position.trim();
            const depthTrim = snap.depth.trim();
            const orderTrim = snap.order.trim();

            const patch = {
                comment: snap.comment,
                disable: !snap.enabled,
                constant: isBlue,
                key: snap.key,
                keysecondary: snap.keysecondary,
                position: posTrim !== '' ? Number(posTrim) : entry.position,
                depth: depthTrim !== '' ? Number(depthTrim) : entry.depth,
                order: orderTrim !== '' ? Number(orderTrim) : entry.order,
                content: snap.content,
            };
            if (isBlue !== Boolean(entry.constant)) {
                patch.selective = !isBlue;
            }

            const res = await saveWorldbookEntryPatch(cleanWorld, uid, patch);
            if (saveBtn instanceof HTMLButtonElement) saveBtn.disabled = false;
            if (destroyed || !slotEl.isConnected) return;

            if (!res.ok) {
                if (statusEl) {
                    statusEl.textContent = res.error || '保存失败';
                    statusEl.className = 'wbo-acc-save-status is-error';
                }
                showToast('error', res.error || '保存条目失败');
                return;
            }

            if (res.entry) {
                entry = res.entry;
            } else {
                entry.comment = snap.comment;
                entry.disable = !snap.enabled;
                entry.constant = isBlue;
            }
            baseline = readFormSnapshot();

            const idx = listState.items.findIndex((x) => x.uid === uid);
            if (idx >= 0 && res.entry) {
                const updatedComment = String(res.entry.comment ?? '').trim();
                const updatedKeys = Array.isArray(res.entry.key) ? res.entry.key : [];
                const updatedKeys2 = Array.isArray(res.entry.keysecondary) ? res.entry.keysecondary : [];
                const updatedItem = {
                    ...listState.items[idx],
                    title: updatedComment || updatedKeys.slice(0, 2).join(' / ') || listState.items[idx].title,
                    keys: updatedKeys.slice(0, 6),
                    keysecondary: updatedKeys2.slice(0, 4),
                    constant: Boolean(res.entry.constant),
                    disable: Boolean(res.entry.disable),
                    selective: Boolean(res.entry.selective),
                    position: Number(res.entry.position ?? 0),
                    depth: Number(res.entry.depth ?? 4),
                    order: Number(res.entry.order ?? 100),
                    displayIndex: resolveEntryDisplayIndex(res.entry, uid, listState.items[idx].displayIndex ?? idx),
                    searchText: [updatedComment, ...updatedKeys, ...updatedKeys2].join('\n').toLowerCase(),
                };
                listState.items[idx] = updatedItem;
                patchRowHeaderDom(itemEl, updatedItem);
            }

            updateSummary();
            onEntryMutated?.({
                worldName: cleanWorld,
                total: listState.total,
                enabledCount: listState.enabledCount,
                action: 'save',
                uid,
            });
            if (statusEl) {
                statusEl.textContent = '已保存';
                statusEl.className = 'wbo-acc-save-status is-success';
            }
            showToast('success', '条目已保存');
        });

        return {
            loading: false,
            entry,
            slotEl,
            itemEl,
            isDirty,
            getCurrentContent: () => (contentArea instanceof HTMLTextAreaElement ? contentArea.value : String(entry.content ?? '')),
            syncMonoFromSettings: syncMonoUi,
            syncTallFromSettings: syncTallUi,
            syncDisabledFromHeader: (nextDisable) => {
                if (enabledCb instanceof HTMLInputElement) {
                    enabledCb.checked = !nextDisable;
                }
                entry.disable = Boolean(nextDisable);
                baseline.enabled = !nextDisable;
                refreshMetaBrief();
            },
            syncOrderFromReorder: (nextOrder) => {
                if (!Number.isFinite(nextOrder) || isDirty()) return;
                entry.order = nextOrder;
                if (orderInput instanceof HTMLInputElement) {
                    orderInput.value = String(nextOrder);
                }
                baseline.order = String(nextOrder);
                refreshMetaBrief();
            },
            dispose: () => {
                taResizeObserver?.disconnect();
                taResizeObserver = null;
            },
        };
    };

    const expandEntry = async (uid, { scrollIntoView = false, preloadedEntry = null } = {}) => {
        const cleanUid = String(uid ?? '').trim();
        if (!cleanUid || destroyed) return;

        const idx = listState.items.findIndex((x) => x.uid === cleanUid);
        if (idx < 0) return;

        const item = listState.items[idx];
        const itemEl = insertItemElementAtIndex(item, idx);
        if (!(itemEl instanceof HTMLElement)) return;
        itemEl.hidden = false;

        const slotEl = itemEl.querySelector('.wbo-acc-editor-slot');
        const toggleBtn = itemEl.querySelector('[data-acc-toggle]');
        if (!(slotEl instanceof HTMLElement)) return;
        const scrollEntry = () => scrollContentToItem(findScrollableContent(itemEl, itemEl.closest('.wbo-modal')), itemEl);

        if (expandedEditors.has(cleanUid)) {
            if (scrollIntoView) scrollEntry();
            return;
        }

        const pendingToken = Symbol('expand');
        expandedEditors.set(cleanUid, {
            loading: true,
            token: pendingToken,
            slotEl,
            itemEl,
            isDirty: () => false,
        });
        itemEl.classList.add('is-expanded');
        if (toggleBtn) toggleBtn.setAttribute('aria-expanded', 'true');
        slotEl.hidden = false;
        slotEl.innerHTML = '<div class="wbo-preview-loading">正在读取条目...</div>';

        if (scrollIntoView) scrollEntry();

        let entryData = preloadedEntry;
        if (!entryData) {
            const res = await fetchSingleWorldbookEntry(cleanWorld, cleanUid);
            if (destroyed || !slotEl.isConnected) return;
            const curRecord = expandedEditors.get(cleanUid);
            if (!curRecord || curRecord.token !== pendingToken) return;
            if (!res.ok || !res.entry) {
                expandedEditors.delete(cleanUid);
                itemEl.classList.remove('is-expanded');
                if (toggleBtn) toggleBtn.setAttribute('aria-expanded', 'false');
                slotEl.innerHTML = '';
                slotEl.hidden = true;
                showToast('error', res.error || '读取条目失败');
                return;
            }
            entryData = res.entry;
        } else {
            const curRecord = expandedEditors.get(cleanUid);
            if (!curRecord || curRecord.token !== pendingToken) return;
        }

        const editorCtrl = mountEditorIntoSlot(itemEl, slotEl, entryData);
        expandedEditors.set(cleanUid, editorCtrl);
        if (scrollIntoView) scrollEntry();
    };

    const collapseEntry = (uid) => {
        const cleanUid = String(uid ?? '').trim();
        const ctrl = expandedEditors.get(cleanUid);
        if (!ctrl) return true;
        if (ctrl.isDirty?.() && !globalThis.confirm('该条目有未保存的修改，确定放弃修改并收起吗？')) {
            return false;
        }
        ctrl.dispose?.();
        expandedEditors.delete(cleanUid);
        ctrl.itemEl?.classList.remove('is-expanded');
        const toggleBtn = ctrl.itemEl?.querySelector('[data-acc-toggle]');
        if (toggleBtn) toggleBtn.setAttribute('aria-expanded', 'false');
        if (ctrl.slotEl instanceof HTMLElement) {
            ctrl.slotEl.innerHTML = '';
            ctrl.slotEl.hidden = true;
        }
        syncVisibleRows();
        return true;
    };

    hostEl.addEventListener('click', (ev) => {
        const target = ev.target instanceof Element ? ev.target : null;
        if (!target) return;

        const extraBtn = target.closest('[data-acc-extra]');
        if (extraBtn instanceof HTMLElement) {
            ev.preventDefault();
            ev.stopPropagation();
            const act = extraBtn.getAttribute('data-acc-extra');
            if (act === 'open-entry-groups') onOpenEntryGroups?.();
            else if (act) onExtraAction?.(act, extraBtn);
            return;
        }

        const toggleBtn = target.closest('[data-acc-toggle]');
        if (toggleBtn) {
            ev.preventDefault();
            ev.stopPropagation();
            const uid = toggleBtn.getAttribute('data-acc-toggle');
            if (!uid) return;
            if (expandedEditors.has(uid)) {
                collapseEntry(uid);
            } else {
                void expandEntry(uid);
            }
        }
    });

    if (sortSelect instanceof HTMLSelectElement) {
        sortSelect.addEventListener('change', () => {
            sortMode = normalizeSortMode(sortSelect.value);
            if (sortSize) sortSize.textContent = SORT_LABELS[sortMode];
            onChangeSortMode?.(sortMode);
            if (listState.ok) {
                listState.items = sortEntryListItems(listState.items, sortMode);
            }
            syncSortHandlesUi();
            syncVisibleRows();
        });
    }

    // Pointer-based entry drag-reorder (works collapsed & expanded, desktop mouse & mobile touch)
    listEl?.addEventListener('pointerdown', (ev) => {
        if (destroyed || isReordering) return;
        if (ev.pointerType === 'mouse' && ev.button !== 0) return;
        const target = ev.target instanceof Element ? ev.target : null;
        const handle = target?.closest('[data-acc-drag-handle]');
        if (!(handle instanceof HTMLElement)) return;
        const dragItemEl = handle.closest('.wbo-acc-item[data-acc-uid]');
        const dragUid = dragItemEl?.getAttribute('data-acc-uid') || '';
        if (!(dragItemEl instanceof HTMLElement) || !dragUid) return;

        if (sortMode !== 'custom') {
            ev.preventDefault();
            ev.stopPropagation();
            showToast('info', '请先切回「自定义排序」再拖动调整条目顺序');
            return;
        }

        ev.preventDefault();
        ev.stopPropagation();
        activeDragCleanup?.();

        const pointerId = ev.pointerId;
        const startY = Number(ev.clientY) || 0;
        let dragActive = false;
        let targetUid = '';
        let insertAfter = false;

        try {
            if (typeof pointerId === 'number') handle.setPointerCapture?.(pointerId);
        } catch { /* ignore */ }

        const clearDragIndicators = () => {
            dragItemEl.classList.remove('is-dragging');
            listEl.classList.remove('is-entry-dragging');
            listEl.querySelectorAll('.wbo-drop-before, .wbo-drop-after').forEach((el) => {
                el.classList.remove('wbo-drop-before', 'wbo-drop-after');
            });
        };

        const updateDropTarget = (clientY) => {
            const visibleItems = Array.from(listEl.children).filter(
                (el) => el instanceof HTMLElement && el.classList.contains('wbo-acc-item') && !el.hidden && el !== dragItemEl,
            );
            listEl.querySelectorAll('.wbo-drop-before, .wbo-drop-after').forEach((el) => {
                el.classList.remove('wbo-drop-before', 'wbo-drop-after');
            });
            if (visibleItems.length === 0) {
                targetUid = '';
                return;
            }
            let chosenEl = null;
            let chosenAfter = false;
            for (const cand of visibleItems) {
                const rect = cand.getBoundingClientRect();
                const mid = rect.top + rect.height / 2;
                if (clientY < mid) {
                    chosenEl = cand;
                    chosenAfter = false;
                    break;
                }
            }
            if (!chosenEl) {
                chosenEl = visibleItems[visibleItems.length - 1];
                chosenAfter = true;
            }
            targetUid = chosenEl.getAttribute('data-acc-uid') || '';
            insertAfter = chosenAfter;
            chosenEl.classList.toggle('wbo-drop-before', !chosenAfter);
            chosenEl.classList.toggle('wbo-drop-after', chosenAfter);
        };

        const cleanupListeners = () => {
            globalThis.removeEventListener?.('pointermove', onPointerMove);
            globalThis.removeEventListener?.('pointerup', onPointerUp);
            globalThis.removeEventListener?.('pointercancel', onPointerCancel);
            try {
                if (typeof pointerId === 'number') handle.releasePointerCapture?.(pointerId);
            } catch { /* ignore */ }
            clearDragIndicators();
            if (activeDragCleanup === cleanupListeners) {
                activeDragCleanup = null;
            }
        };

        const onPointerMove = (moveEv) => {
            if (destroyed) {
                cleanupListeners();
                return;
            }
            if (typeof pointerId === 'number' && typeof moveEv.pointerId === 'number' && moveEv.pointerId !== pointerId) return;
            const curY = Number(moveEv.clientY) || 0;
            if (!dragActive) {
                if (Math.abs(curY - startY) < 4) return;
                dragActive = true;
                dragItemEl.classList.add('is-dragging');
                listEl.classList.add('is-entry-dragging');
            }
            updateDropTarget(curY);
        };

        const finishDrag = async (cancelled) => {
            const wasActive = dragActive;
            const finalTargetUid = targetUid;
            const finalAfter = insertAfter;
            cleanupListeners();
            if (cancelled || destroyed || !wasActive || !finalTargetUid || finalTargetUid === dragUid) return;

            const syncOrder = Boolean(getSyncOrder?.());
            const prevItems = listState.items.map((x) => ({ ...x }));
            const plan = reorderEntryUids(listState.items, dragUid, finalTargetUid, finalAfter, { syncOrder });
            if (!plan.changed) return;

            for (const item of listState.items) {
                const upd = plan.updatesByUid?.[item.uid];
                if (upd) {
                    item.displayIndex = upd.displayIndex;
                    if (syncOrder && Number.isFinite(upd.order)) {
                        item.order = upd.order;
                    }
                }
            }
            listState.items = sortEntryListItems(listState.items, 'custom');
            syncVisibleRows();
            for (const item of listState.items) {
                const itemEl = itemElByUid.get(item.uid);
                if (itemEl) patchRowHeaderDom(itemEl, item);
                if (syncOrder) {
                    expandedEditors.get(item.uid)?.syncOrderFromReorder?.(item.order);
                }
            }

            isReordering = true;
            const res = await saveWorldbookEntriesOrderDirect(cleanWorld, plan.orderedUids, { syncOrder });
            isReordering = false;
            if (destroyed) return;

            if (!res.ok) {
                listState.items = prevItems;
                syncVisibleRows();
                for (const item of listState.items) {
                    const itemEl = itemElByUid.get(item.uid);
                    if (itemEl) patchRowHeaderDom(itemEl, item);
                    if (syncOrder) {
                        expandedEditors.get(item.uid)?.syncOrderFromReorder?.(item.order);
                    }
                }
                showToast('error', res.error || '保存条目顺序失败');
                return;
            }

            onEntryMutated?.({
                worldName: cleanWorld,
                total: listState.total,
                enabledCount: listState.enabledCount,
                action: 'reorder',
                uid: dragUid,
            });
            showToast('success', syncOrder ? '已保存条目顺序（并同步插入顺序 order）' : '已保存条目自定义顺序');
        };

        const onPointerUp = (upEv) => {
            if (typeof pointerId === 'number' && typeof upEv.pointerId === 'number' && upEv.pointerId !== pointerId) return;
            void finishDrag(false);
        };
        const onPointerCancel = (cancelEv) => {
            if (typeof pointerId === 'number' && typeof cancelEv.pointerId === 'number' && cancelEv.pointerId !== pointerId) return;
            void finishDrag(true);
        };

        activeDragCleanup = cleanupListeners;
        globalThis.addEventListener?.('pointermove', onPointerMove);
        globalThis.addEventListener?.('pointerup', onPointerUp);
        globalThis.addEventListener?.('pointercancel', onPointerCancel);
    });

    listEl?.addEventListener('change', async (ev) => {
        const cb = ev.target;
        if (!(cb instanceof HTMLInputElement) || !cb.classList.contains('wbo-acc-toggle-enable')) return;
        const uid = cb.getAttribute('data-acc-enable');
        if (!uid) return;
        const nextDisable = !cb.checked;
        cb.disabled = true;
        const res = await saveWorldbookEntryPatch(cleanWorld, uid, { disable: nextDisable });
        cb.disabled = false;
        if (destroyed) return;
        if (!res.ok) {
            cb.checked = !cb.checked;
            showToast('error', res.error || '保存开关状态失败');
            return;
        }
        const item = listState.items.find((x) => x.uid === uid);
        if (item) {
            item.disable = nextDisable;
            const itemEl = itemElByUid.get(uid);
            if (itemEl) patchRowHeaderDom(itemEl, item);
        }
        const openCtrl = expandedEditors.get(uid);
        openCtrl?.syncDisabledFromHeader?.(nextDisable);
        updateSummary();
        onEntryMutated?.({
            worldName: cleanWorld,
            total: listState.total,
            enabledCount: listState.enabledCount,
            action: 'toggle',
            uid,
        });
    });

    if (searchInput instanceof HTMLInputElement) {
        let composing = false;
        searchInput.addEventListener('compositionstart', () => { composing = true; });
        searchInput.addEventListener('compositionend', () => {
            composing = false;
            searchQuery = searchInput.value;
            runSearchWithFullContent();
        });
        searchInput.addEventListener('input', () => {
            if (composing) return;
            searchQuery = searchInput.value;
            runSearchWithFullContent();
        });
    }

    loadMoreBtn?.addEventListener('click', () => {
        shownLimit = Math.min(listState.items.length, shownLimit + sliceStep);
        syncVisibleRows();
    });

    loadAllBtn?.addEventListener('click', () => {
        shownLimit = listState.items.length;
        syncVisibleRows();
    });

    newBtn?.addEventListener('click', async () => {
        if (newBtn instanceof HTMLButtonElement) newBtn.disabled = true;
        const created = await createWorldbookEntryDirect(cleanWorld, { comment: '新条目' });
        if (newBtn instanceof HTMLButtonElement) newBtn.disabled = false;
        if (destroyed) return;
        if (!created.ok || !created.entry) {
            showToast('error', created.error || '创建条目失败');
            return;
        }
        const e = created.entry;
        const newItem = {
            uid: String(e.uid),
            title: String(e.comment ?? '').trim() || `条目 #${listState.items.length + 1}`,
            keys: Array.isArray(e.key) ? e.key.slice(0, 6) : [],
            keysecondary: Array.isArray(e.keysecondary) ? e.keysecondary.slice(0, 4) : [],
            constant: Boolean(e.constant),
            disable: Boolean(e.disable),
            selective: Boolean(e.selective),
            position: Number(e.position ?? 0),
            depth: Number(e.depth ?? 4),
            order: Number(e.order ?? 100),
            displayIndex: resolveEntryDisplayIndex(e, e.uid, listState.items.length),
            searchText: String(e.comment ?? '').toLowerCase(),
        };
        listState.ok = true;
        listState.items.push(newItem);
        listState.items = sortEntryListItems(listState.items, sortMode);
        updateSummary();
        syncVisibleRows();
        onEntryMutated?.({
            worldName: cleanWorld,
            total: listState.total,
            enabledCount: listState.enabledCount,
            action: 'create',
            uid: newItem.uid,
        });
        showToast('success', '已新建条目');
        await expandEntry(newItem.uid, { scrollIntoView: true, preloadedEntry: e });
    });

    const loadInitial = async () => {
        const res = await fetchWorldbookEntryList(cleanWorld);
        if (destroyed) return;
        listState = res.ok ? { ...res, items: sortEntryListItems(res.items || [], sortMode) } : res;
        updateSummary();
        syncVisibleRows();

        if (initialUid !== null && initialUid !== undefined && String(initialUid).trim() !== '') {
            const targetUid = String(initialUid).trim();
            if (listState.items.some((x) => x.uid === targetUid)) {
                await expandEntry(targetUid, { scrollIntoView: true });
            } else if (listState.ok) {
                showToast('warning', '未能定位该条目，已显示条目列表');
            }
        }
    };

    const refresh = async () => {
        if (destroyed) return;
        const res = await fetchWorldbookEntryList(cleanWorld);
        if (destroyed || !res.ok) return;
        listState = { ...res, items: sortEntryListItems(res.items || [], sortMode) };
        const validSet = new Set(listState.items.map((x) => x.uid));
        for (const [uid, el] of [...itemElByUid.entries()]) {
            if (!validSet.has(uid)) {
                el.remove();
                itemElByUid.delete(uid);
                expandedEditors.delete(uid);
            }
        }
        for (let i = 0; i < listState.items.length; i += 1) {
            const item = listState.items[i];
            const el = itemElByUid.get(item.uid);
            if (el) {
                patchRowHeaderDom(el, item);
            }
            const openCtrl = expandedEditors.get(item.uid);
            if (openCtrl && !openCtrl.isDirty?.()) {
                openCtrl.syncDisabledFromHeader?.(item.disable);
            }
        }
        updateSummary();
        syncVisibleRows();
    };

    const initialPromise = loadInitial();

    return {
        ready: initialPromise,
        expandEntry,
        collapseEntry,
        refresh,
        setEntryGroupingAction: (action) => {
            if (destroyed) return;
            onOpenEntryGroups = typeof action === 'function' ? action : null;
            const toolbar = hostEl.querySelector('.wbo-acc-toolbar-actions');
            const existing = toolbar?.querySelector('[data-acc-extra="open-entry-groups"]');
            if (!onOpenEntryGroups) { existing?.remove(); return; }
            if (!toolbar || existing) return;
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'wbo-btn wbo-acc-group-btn';
            button.dataset.accExtra = 'open-entry-groups';
            button.innerHTML = '<i class="fa-solid fa-folder-tree" aria-hidden="true"></i> 条目分组';
            toolbar.prepend(button);
        },
        hasDirtyEditors: () => {
            for (const ctrl of expandedEditors.values()) {
                if (ctrl.isDirty?.()) return true;
            }
            return false;
        },
        getExpandedCount: () => expandedEditors.size,
        getExpandedUids: () => [...expandedEditors.keys()],
        destroy: () => {
            destroyed = true;
            activeDragCleanup?.();
            activeDragCleanup = null;
            clearTimeout(searchTimer);
            searchTimer = null;
            contentMatchUids = null;
            for (const ctrl of expandedEditors.values()) {
                ctrl.dispose?.();
            }
            expandedEditors.clear();
            itemElByUid.clear();
            hostEl.innerHTML = '';
        },
    };
}
