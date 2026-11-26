/** Cross-worldbook entry search and entry browser. */

import {
    _callbacks,
    _previewCache,
    applyThemeClass,
    bindDrawerSafeBubbleGuard,
    bindImeSafeEnter,
    closeGroupVisibilityPopover,
    closeSubModal,
    createSubModal,
    esc,
    isDesktopAutoFocusAllowed,
    MANAGER_OVERLAY_ID,
} from './panel-window.js';
import {
    _activePreviewControllers,
    _searchQuery,
    closeManagerModal,
    renderManagerGroupsListOnly,
} from './panel-manager.js';
import {
    searchWorldbookEntriesStream,
    showToast,
} from './host.js';
import {
    searchEntriesInPayload,
    SPECIAL_GROUPS,
} from './core.js';
import { openWorldInNativeEditor } from './native-filter.js';
import { mountEntryAccordion } from './entry-accordion.js';

let _lastEntrySearchQuery = '';

/** @type {{ cancelled: boolean } | null} */
let _mgrInlineEntrySignal = null;

function cancelManagerInlineEntrySearch() {
    if (_mgrInlineEntrySignal) {
        _mgrInlineEntrySignal.cancelled = true;
        _mgrInlineEntrySignal = null;
    }
}

/**
 * Sync the Group Manager unified search bar placeholder, inline `搜索/停止` button,
 * search-options indicator, and compact recent-search history chips.
 */
function syncManagerSearchBarUi() {
    const overlay = document.getElementById(MANAGER_OVERLAY_ID);
    if (!overlay || !_callbacks) return;
    const { settings } = _callbacks.getState();

    const inBook = settings.mgrSearchInBookName !== false;
    const inChar = settings.mgrSearchInCharName !== false;
    const inEntries = Boolean(settings.mgrSearchInEntries);
    const splitSpaces = Boolean(settings.mgrSearchSplitSpaces);

    const searchInput = overlay.querySelector('#wbo-mgr-search-input');
    if (searchInput instanceof HTMLInputElement) {
        const parts = [];
        if (inBook) parts.push('世界书名');
        if (inChar) parts.push('角色名');
        if (inEntries) parts.push('条目内容');
        searchInput.placeholder = parts.length > 0
            ? (inEntries ? `搜 ${parts.join(' / ')}（回车搜正文）` : `搜索 ${parts.join(' / ')}...`)
            : '请先点右侧设置勾选搜索范围';
    }

    const goBtn = overlay.querySelector('#wbo-mgr-entry-go-btn');
    const goLabel = overlay.querySelector('#wbo-mgr-entry-go-label');
    if (goBtn instanceof HTMLElement) {
        goBtn.hidden = !inEntries;
        const running = Boolean(_mgrInlineEntrySignal);
        goBtn.classList.toggle('is-active', running);
        const icon = goBtn.querySelector('i');
        if (icon) icon.className = running ? 'fa-solid fa-stop' : 'fa-solid fa-magnifying-glass';
        if (goLabel) goLabel.textContent = running ? '停止' : '搜索';
    }

    const optsBtn = overlay.querySelector('#wbo-mgr-search-opts-btn');
    if (optsBtn instanceof HTMLElement) {
        const hasCustom = inEntries || splitSpaces || !inBook || !inChar;
        optsBtn.classList.toggle('is-active', hasCustom);
    }

    const histRow = overlay.querySelector('#wbo-mgr-hist-row');
    if (histRow instanceof HTMLElement) {
        const list = Array.isArray(settings.entrySearchHistory) ? settings.entrySearchHistory : [];
        if (!inEntries || list.length === 0) {
            histRow.hidden = true;
            histRow.innerHTML = '';
        } else {
            histRow.hidden = false;
            histRow.innerHTML = `
                <span class="wbo-es-history-label">最近</span>
                ${list.map((term) => `
                    <span class="wbo-es-hist-chip">
                        <button type="button" class="wbo-es-hist-term" data-mgr-hist-pick="${esc(term)}">${esc(term)}</button>
                        <button type="button" class="wbo-es-hist-del" data-mgr-hist-del="${esc(term)}" aria-label="删除">×</button>
                    </span>
                `).join('')}
                <button type="button" class="wbo-link-btn wbo-es-hist-clear" id="wbo-mgr-hist-clear">清空</button>
            `;
        }
    }
}

function clearManagerInlineEntryResults() {
    cancelManagerInlineEntrySearch();
    const box = document.getElementById('wbo-mgr-es-box');
    if (box instanceof HTMLElement) {
        box.hidden = true;
        box.innerHTML = '';
    }
    syncManagerSearchBarUi();
}

function openManagerSearchOptionsPopover(anchorBtn) {
    const existing = document.getElementById('wbo-search-opts-backdrop');
    if (existing) {
        existing.remove();
        return;
    }
    closeGroupVisibilityPopover();
    if (!_callbacks) return;
    const { settings } = _callbacks.getState();

    const backdrop = document.createElement('div');
    backdrop.id = 'wbo-search-opts-backdrop';
    backdrop.className = 'wbo-vis-backdrop';

    const pop = document.createElement('div');
    pop.className = 'wbo-modal wbo-vis-popover wbo-search-opts-popover';
    applyThemeClass(pop);
    pop.innerHTML = `
        <div class="wbo-vis-title">搜索范围与方式</div>
        <label class="wbo-check-line">
            <input type="checkbox" data-so-key="mgrSearchInBookName"${settings.mgrSearchInBookName !== false ? ' checked' : ''}>
            <span>世界书名</span>
        </label>
        <label class="wbo-check-line">
            <input type="checkbox" data-so-key="mgrSearchInCharName"${settings.mgrSearchInCharName !== false ? ' checked' : ''}>
            <span>角色名</span>
        </label>
        <label class="wbo-check-line">
            <input type="checkbox" data-so-key="mgrSearchInEntries"${settings.mgrSearchInEntries ? ' checked' : ''}>
            <span>条目内容</span>
        </label>
        <div class="wbo-local-divider"></div>
        <label class="wbo-check-line">
            <input type="checkbox" data-so-key="mgrSearchSplitSpaces"${settings.mgrSearchSplitSpaces ? ' checked' : ''}>
            <span>空格分隔多词（同时包含）</span>
        </label>
    `;

    backdrop.appendChild(pop);
    document.body.appendChild(backdrop);
    bindDrawerSafeBubbleGuard(backdrop);
    bindDrawerSafeBubbleGuard(pop);

    const rect = anchorBtn.getBoundingClientRect();
    const vw = globalThis.innerWidth || document.documentElement.clientWidth || 390;
    const vh = globalThis.innerHeight || document.documentElement.clientHeight || 800;
    const popW = 228;
    const left = Math.max(10, Math.min(rect.right - popW, vw - popW - 10));
    const openAbove = vh - rect.bottom < 190 && rect.top > 190;
    pop.style.width = `${popW}px`;
    pop.style.left = `${Math.round(left)}px`;
    if (openAbove) {
        pop.style.bottom = `${Math.round(vh - rect.top + 4)}px`;
        pop.style.top = 'auto';
    } else {
        pop.style.top = `${Math.round(rect.bottom + 4)}px`;
        pop.style.bottom = 'auto';
    }

    backdrop.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (ev.target === backdrop) closeGroupVisibilityPopover();
    });

    pop.querySelectorAll('input[data-so-key]').forEach((cb) => {
        cb.addEventListener('change', async () => {
            if (!(cb instanceof HTMLInputElement) || !_callbacks) return;
            const key = cb.getAttribute('data-so-key');
            if (!key) return;
            const cur = _callbacks.getState().settings;
            cur[key] = cb.checked;
            if (key === 'mgrSearchInEntries' && !cb.checked) {
                clearManagerInlineEntryResults();
            }
            syncManagerSearchBarUi();
            renderManagerGroupsListOnly();
            await _callbacks.onMutation({ save: true, uiOnly: true });
        });
    });
}

async function runManagerInlineEntrySearch() {
    if (!_callbacks) return;
    const box = document.getElementById('wbo-mgr-es-box');
    if (!(box instanceof HTMLElement)) return;
    const q = _searchQuery.trim();
    if (!q) {
        showToast('info', '请先在搜索框输入关键词');
        const input = document.getElementById('wbo-mgr-search-input');
        if (input instanceof HTMLInputElement && isDesktopAutoFocusAllowed()) input.focus({ preventScroll: true });
        return;
    }

    const { settings, classification } = _callbacks.getState();
    const filterId = settings.activeFilterGroupId;
    let targetBooks = [];
    if (filterId === SPECIAL_GROUPS.ALL) {
        targetBooks = [...classification.byName.values()];
    } else if (filterId === SPECIAL_GROUPS.PINNED) {
        targetBooks = [...(classification.pinnedBooks || [])];
    } else if (filterId === SPECIAL_GROUPS.CHARACTER) {
        targetBooks = [...classification.characterBooks];
    } else if (filterId === SPECIAL_GROUPS.UNGROUPED) {
        targetBooks = [...classification.ungroupedBooks];
    } else if (filterId === SPECIAL_GROUPS.DEFAULT) {
        targetBooks = settings.showCharBooks
            ? [...classification.byName.values()]
            : [...classification.byName.values()].filter((b) => !b.isInCharGroup);
    } else {
        const sec = (classification.orderedSections || []).find((s) => s.id === filterId);
        targetBooks = sec?.books ? [...sec.books] : [];
    }

    // Save to recent search history
    const prevHist = Array.isArray(settings.entrySearchHistory) ? settings.entrySearchHistory : [];
    settings.entrySearchHistory = [q, ...prevHist.filter((x) => x !== q)].slice(0, 10);
    void _callbacks.onMutation({ save: true, uiOnly: true });

    cancelManagerInlineEntrySearch();
    const signal = { cancelled: false };
    _mgrInlineEntrySignal = signal;
    syncManagerSearchBarUi();

    const splitSpaces = Boolean(settings.mgrSearchSplitSpaces);
    const tokens = splitSpaces ? q.split(/\s+/).filter(Boolean) : [q];
    const bookMetaByName = new Map(targetBooks.map((b) => [b.realName, b]));

    box.hidden = false;
    box.innerHTML = `
        <div class="wbo-mgr-es-head">
            <span class="wbo-es-progress-text" id="wbo-mgr-es-prog-text">准备扫描 0 / ${targetBooks.length} 本…</span>
            <button type="button" class="wbo-link-btn" data-mgr-es-clear="1">收起结果</button>
        </div>
        <div class="wbo-es-progress-bar"><div class="wbo-es-progress-fill" id="wbo-mgr-es-prog-fill"></div></div>
        <div class="wbo-mgr-es-list" id="wbo-mgr-es-list"></div>
    `;

    const progText = box.querySelector('#wbo-mgr-es-prog-text');
    const progFill = box.querySelector('#wbo-mgr-es-prog-fill');
    const listEl = box.querySelector('#wbo-mgr-es-list');

    const res = await searchWorldbookEntriesStream({
        worldNames: targetBooks.map((b) => b.realName),
        concurrency: 2,
        yieldMs: 12,
        maxTotalHits: 120,
        signal,
        matcher: (payload) => searchEntriesInPayload(payload, q, {
            searchTitleAndKeys: true,
            searchContent: true,
            includeDisabled: true,
            splitSpaces,
            maxHitsPerBook: 6,
        }),
        onBookResult: ({ worldName, hits, totalMatchesInBook }) => {
            if (!listEl || signal.cancelled) return;
            const meta = bookMetaByName.get(worldName);
            const card = document.createElement('div');
            card.className = 'wbo-es-book-card';
            const moreTag = totalMatchesInBook > hits.length
                ? `<span class="wbo-tag">共 ${totalMatchesInBook} 条，显示前 ${hits.length} 条</span>`
                : `<span class="wbo-tag">${hits.length} 条命中</span>`;
            const itemsHtml = hits.map((h) => `
                <details class="wbo-es-entry">
                    <summary class="wbo-es-entry-sum">
                        <span class="wbo-es-entry-head">
                            <span class="wbo-es-entry-title">${highlightTokensHtml(h.title, tokens)}</span>
                            ${h.disabled ? '<span class="wbo-tag">已禁用</span>' : ''}
                            ${h.matchedIn.map((m) => `<span class="wbo-tag">${esc(m)}</span>`).join('')}
                            <button type="button" class="wbo-link-btn wbo-es-jump-uid" data-es-inplugin="${esc(worldName)}" data-es-uid="${esc(h.uid)}">插件内编辑</button>
                            <button type="button" class="wbo-link-btn" data-es-open="${esc(worldName)}" data-es-uid="${esc(h.uid)}" title="跳去酒馆原生编辑器定位此条目">原生定位</button>
                        </span>
                        ${h.keys.length > 0 ? `<div class="wbo-es-entry-keys">触发词：${highlightTokensHtml(h.keys.join('、'), tokens)}</div>` : ''}
                        ${h.snippet ? `<div class="wbo-es-entry-snip">${highlightTokensHtml(h.snippet, tokens)}</div>` : ''}
                    </summary>
                    <div class="wbo-es-entry-body">${highlightTokensHtml(h.content || '(无正文)', tokens)}</div>
                </details>
            `).join('');
            card.innerHTML = `
                <div class="wbo-es-book-head">
                    <div class="wbo-es-book-info">
                        <span class="wbo-es-book-title">${esc(meta?.primaryTitle || worldName)}</span>
                        ${meta?.groupName ? `<span class="wbo-tag">${esc(meta.groupName)}</span>` : ''}
                        ${moreTag}
                    </div>
                    <span class="wbo-es-book-actions">
                        <button type="button" class="wbo-btn wbo-es-open-btn" data-es-inplugin="${esc(worldName)}">
                            <i class="fa-regular fa-pen-to-square"></i> 浏览/编辑
                        </button>
                        <button type="button" class="wbo-icon-btn" data-es-open="${esc(worldName)}" title="在酒馆原生编辑器打开">
                            <i class="fa-solid fa-arrow-up-right-from-square"></i>
                        </button>
                    </span>
                </div>
                <div class="wbo-es-entries">${itemsHtml}</div>
            `;
            listEl.appendChild(card);
        },
        onProgress: ({ done, total, hitCount, matchedBooks }) => {
            if (signal.cancelled) return;
            const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 100;
            if (progFill instanceof HTMLElement) progFill.style.width = `${pct}%`;
            if (progText) {
                progText.textContent = `条目搜索 ${done}/${total} 本 · 命中 ${matchedBooks} 本共 ${hitCount} 条`;
            }
        },
    });

    if (_mgrInlineEntrySignal === signal) {
        _mgrInlineEntrySignal = null;
        syncManagerSearchBarUi();
        if (progFill instanceof HTMLElement && !res.cancelled) progFill.style.width = '100%';
        if (progText) {
            const suffix = res.cancelled ? '（已停止）' : res.capped ? '（已达上限 120 条）' : '（完成）';
            progText.textContent = `条目搜索 ${res.done}/${res.total} 本 · 命中 ${res.matchedBooks} 本共 ${res.hitCount} 条 ${suffix}`;
        }
        if (listEl && res.hitCount === 0) {
            listEl.innerHTML = '<div class="wbo-empty-hint">当前范围内未找到包含该关键词的条目（可打开角色书开关或切换全部分组后重试）</div>';
        }
    }
}

/**
 * In-plugin lightweight entry browser & single-entry direct editor inside a fixed-dimension
 * `pinnedLayout` submodal:
 * - List view renders ONLY lightweight rows (title, keyword preview, blue/green dot, toggle switch)
 * - Single-entry edit view mounts 1 `<textarea>` on demand and shallow-merges changes onto the
 *   original raw entry JSON on save (zero native/unknown field loss, zero `worldInfoCache` bloat).
 * @param {object} bookMeta
 */
function openBookEntryBrowserModal(bookMetaOrName, { initialUid = null, stack = false } = {}) {
    const bookMeta = typeof bookMetaOrName === 'string'
        ? (_callbacks?.getState?.()?.classification?.byName?.get(bookMetaOrName) || { realName: bookMetaOrName, primaryTitle: bookMetaOrName })
        : bookMetaOrName;
    if (!bookMeta?.realName) return;
    const worldName = bookMeta.realName;
    const displayTitle = bookMeta.primaryTitle || worldName;
    const backLabel = stack ? '返回' : '返回分组';

    const { overlay, modal } = createSubModal(
        `条目浏览：${displayTitle}`,
        `
            <div class="wbo-pinned-top">
                <div class="wbo-eb-topbar">
                    <button type="button" class="wbo-btn" id="wbo-eb-back-btn">
                        <i class="fa-solid fa-arrow-left"></i> ${esc(backLabel)}
                    </button>
                    <span class="wbo-spacer"></span>
                    <button type="button" class="wbo-btn" id="wbo-eb-open-native-btn">
                        <i class="fa-solid fa-arrow-up-right-from-square"></i> 在酒馆编辑器打开
                    </button>
                </div>
            </div>
            <div class="wbo-step-scroll wbo-eb-scroll">
                <div class="wbo-eb-acc-host" id="wbo-eb-acc-host"></div>
            </div>
            <div class="wbo-modal-footer wbo-pinned-footer">
                <button type="button" class="wbo-btn" id="wbo-eb-close-btn">关闭</button>
            </div>
        `,
        { wide: true, pinnedLayout: true, stack },
    );
    const bodyEl = modal.querySelector('.wbo-modal-body');
    const hostEl = modal.querySelector('#wbo-eb-acc-host');
    if (!(bodyEl instanceof HTMLElement) || !(hostEl instanceof HTMLElement)) return;

    let accCtrl = null;
    const closeThis = () => {
        if (accCtrl?.hasDirtyEditors?.() && !globalThis.confirm('有未保存的条目修改，确认放弃并关闭？')) {
            return;
        }
        accCtrl?.destroy?.();
        accCtrl = null;
        closeSubModal({ overlay });
    };

    bodyEl.querySelector('#wbo-eb-back-btn')?.addEventListener('click', closeThis);
    bodyEl.querySelector('#wbo-eb-close-btn')?.addEventListener('click', closeThis);
    bodyEl.querySelector('#wbo-eb-open-native-btn')?.addEventListener('click', () => {
        if (accCtrl?.hasDirtyEditors?.() && !globalThis.confirm('有未保存的条目修改，确认直接前往酒馆编辑器？')) {
            return;
        }
        accCtrl?.destroy?.();
        accCtrl = null;
        openWorldInNativeEditor(worldName, { focusUid: initialUid || null });
        closeSubModal({ all: true });
        closeManagerModal();
    });

    accCtrl = mountEntryAccordion(hostEl, {
        worldName,
        initialUid,
        getMonoFont: () => Boolean(_callbacks?.getState?.()?.settings?.entryEditorMonoFont),
        onToggleMonoFont: (nextMono) => {
            if (!_callbacks) return;
            const cur = _callbacks.getState().settings;
            cur.entryEditorMonoFont = Boolean(nextMono);
            void _callbacks.onMutation({ save: true, uiOnly: true });
        },
        getTallMode: () => Boolean(_callbacks?.getState?.()?.settings?.entryEditorTall),
        onToggleTallMode: (nextTall) => {
            if (!_callbacks) return;
            const cur = _callbacks.getState().settings;
            cur.entryEditorTall = Boolean(nextTall);
            void _callbacks.onMutation({ save: true, uiOnly: true });
        },
        getSyncOrder: () => Boolean(_callbacks?.getState?.()?.settings?.syncEntryOrderOnDrag),
        onEntryMutated: ({ worldName: mutatedWorld }) => {
            _previewCache.delete(mutatedWorld);
            const activeCtrl = _activePreviewControllers.get(mutatedWorld);
            if (activeCtrl && activeCtrl !== accCtrl) {
                void activeCtrl.refresh?.();
            }
        },
        onOpenNative: (uid) => {
            accCtrl?.destroy?.();
            accCtrl = null;
            openWorldInNativeEditor(worldName, { focusUid: uid || null });
            closeSubModal({ all: true });
            closeManagerModal();
        },
    });
}

/**
 * Highlight matched search tokens safely inside escaped text.
 * @param {string} text
 * @param {string[]} tokens
 * @returns {string}
 */
function highlightTokensHtml(text, tokens) {
    const raw = String(text ?? '');
    if (!raw || !Array.isArray(tokens) || tokens.length === 0) return esc(raw);
    const escapedToks = [...new Set(tokens.filter(Boolean))]
        .sort((a, b) => b.length - a.length)
        .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (escapedToks.length === 0) return esc(raw);
    const re = new RegExp(`(${escapedToks.join('|')})`, 'gi');
    return raw
        .split(re)
        .map((part, i) => (i % 2 === 1 ? `<mark class="wbo-search-mark">${esc(part)}</mark>` : esc(part)))
        .join('');
}

/**
 * Low-memory, streaming cross-worldbook entry content search modal.
 * Never runs in background and bypasses `worldInfoCache` so TauriTavern iOS never OOM-crashes!
 * @param {string} [initialQuery='']
 */
function openEntrySearchModal(initialQuery = '', { autoRun = false } = {}) {
    if (!_callbacks) return;
    const { settings, classification } = _callbacks.getState();

    const nonCharBooks = [...classification.byName.values()].filter((b) => !b.isInCharGroup);
    const allBooks = [...classification.byName.values()];
    const scopeOptions = [
        { value: '__nonchar__', label: `全部非角色书 (${nonCharBooks.length} 本)` },
        { value: '__all__', label: `全部世界书含角色书 (${allBooks.length} 本)` },
        ...(classification.orderedSections || [])
            .filter((s) => (s.books?.length || 0) > 0)
            .map((s) => ({ value: s.id, label: `仅「${s.name}」 (${s.books.length} 本)` })),
    ];
    const validScopeSet = new Set(scopeOptions.map((o) => o.value));
    const effectiveScope = validScopeSet.has(settings.entrySearchScope) ? settings.entrySearchScope : '__nonchar__';
    const effectiveQuery = initialQuery !== '' ? initialQuery : _lastEntrySearchQuery;

    const { overlay, modal } = createSubModal(
        '搜索世界书条目',
        `
            <div class="wbo-pinned-top wbo-es-pinned-top">
                <div class="wbo-es-top">
                    <div class="wbo-search-wrap wbo-es-input-wrap">
                        <i class="fa-solid fa-magnifying-glass"></i>
                        <input type="search" class="wbo-search-input" id="wbo-es-query" value="${esc(effectiveQuery)}" placeholder="输入关键词，如：第二人称、防抢话" autocomplete="off" spellcheck="false">
                    </div>
                    <button type="button" class="wbo-btn wbo-btn-primary" id="wbo-es-run-btn">
                        <i class="fa-solid fa-magnifying-glass"></i> 搜索
                    </button>
                    <button type="button" class="wbo-btn" id="wbo-es-stop-btn" hidden>
                        <i class="fa-solid fa-stop"></i> 停止
                    </button>
                </div>

                <div class="wbo-es-history-row" id="wbo-es-history-row" hidden></div>

                <div class="wbo-es-controls">
                    <select class="wbo-select wbo-es-scope" id="wbo-es-scope">
                        ${scopeOptions.map((o) => `<option value="${esc(o.value)}"${o.value === effectiveScope ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}
                    </select>
                    <div class="wbo-es-checks">
                        <label class="wbo-check-line">
                            <input type="checkbox" id="wbo-es-in-title"${settings.entrySearchInTitle !== false ? ' checked' : ''}>
                            <span>标题与触发词</span>
                        </label>
                        <label class="wbo-check-line">
                            <input type="checkbox" id="wbo-es-in-content"${settings.entrySearchInContent !== false ? ' checked' : ''}>
                            <span>正文内容</span>
                        </label>
                        <label class="wbo-check-line">
                            <input type="checkbox" id="wbo-es-inc-disabled"${settings.entrySearchIncludeDisabled !== false ? ' checked' : ''}>
                            <span>含已禁用</span>
                        </label>
                        <label class="wbo-check-line">
                            <input type="checkbox" id="wbo-es-split-spaces"${settings.mgrSearchSplitSpaces ? ' checked' : ''}>
                            <span>空格分隔多词</span>
                        </label>
                    </div>
                </div>

                <div class="wbo-es-progress-wrap" id="wbo-es-progress-wrap" hidden>
                    <div class="wbo-es-progress-bar"><div class="wbo-es-progress-fill" id="wbo-es-progress-fill"></div></div>
                    <div class="wbo-es-progress-text" id="wbo-es-progress-text"></div>
                </div>
            </div>

            <div class="wbo-es-results wbo-es-results-pinned" id="wbo-es-results">
                <div class="wbo-empty-hint">输入关键词开始搜索</div>
            </div>

            <div class="wbo-modal-footer wbo-pinned-footer">
                <button type="button" class="wbo-btn" id="wbo-es-close-btn">关闭</button>
            </div>
        `,
        { wide: true, pinnedLayout: true },
    );

    const queryInput = modal.querySelector('#wbo-es-query');
    const historyRow = modal.querySelector('#wbo-es-history-row');
    const scopeSelect = modal.querySelector('#wbo-es-scope');
    const inTitleCb = modal.querySelector('#wbo-es-in-title');
    const inContentCb = modal.querySelector('#wbo-es-in-content');
    const incDisabledCb = modal.querySelector('#wbo-es-inc-disabled');
    const splitSpacesCb = modal.querySelector('#wbo-es-split-spaces');
    const runBtn = modal.querySelector('#wbo-es-run-btn');
    const stopBtn = modal.querySelector('#wbo-es-stop-btn');
    const progWrap = modal.querySelector('#wbo-es-progress-wrap');
    const progFill = modal.querySelector('#wbo-es-progress-fill');
    const progText = modal.querySelector('#wbo-es-progress-text');
    const resultsEl = modal.querySelector('#wbo-es-results');

    // Persist search scope & option checkboxes permanently; remember typed query in session
    queryInput?.addEventListener('input', () => {
        if (queryInput instanceof HTMLInputElement) {
            _lastEntrySearchQuery = queryInput.value;
        }
    });
    scopeSelect?.addEventListener('change', () => {
        if (scopeSelect instanceof HTMLSelectElement) {
            settings.entrySearchScope = scopeSelect.value || '__nonchar__';
            void _callbacks?.onMutation({ save: true, uiOnly: true });
        }
    });
    inTitleCb?.addEventListener('change', () => {
        if (inTitleCb instanceof HTMLInputElement) {
            settings.entrySearchInTitle = inTitleCb.checked;
            void _callbacks?.onMutation({ save: true, uiOnly: true });
        }
    });
    inContentCb?.addEventListener('change', () => {
        if (inContentCb instanceof HTMLInputElement) {
            settings.entrySearchInContent = inContentCb.checked;
            void _callbacks?.onMutation({ save: true, uiOnly: true });
        }
    });
    incDisabledCb?.addEventListener('change', () => {
        if (incDisabledCb instanceof HTMLInputElement) {
            settings.entrySearchIncludeDisabled = incDisabledCb.checked;
            void _callbacks?.onMutation({ save: true, uiOnly: true });
        }
    });
    splitSpacesCb?.addEventListener('change', () => {
        if (splitSpacesCb instanceof HTMLInputElement) {
            settings.mgrSearchSplitSpaces = splitSpacesCb.checked;
            syncManagerSearchBarUi();
            void _callbacks?.onMutation({ save: true, uiOnly: true });
        }
    });

    const renderHistoryChips = () => {
        if (!(historyRow instanceof HTMLElement)) return;
        const list = Array.isArray(settings.entrySearchHistory) ? settings.entrySearchHistory : [];
        if (list.length === 0) {
            historyRow.hidden = true;
            historyRow.innerHTML = '';
            return;
        }
        historyRow.hidden = false;
        historyRow.innerHTML = `
            <span class="wbo-es-history-label">最近</span>
            ${list.map((term) => `
                <span class="wbo-es-hist-chip">
                    <button type="button" class="wbo-es-hist-term" data-es-hist-pick="${esc(term)}">${esc(term)}</button>
                    <button type="button" class="wbo-es-hist-del" data-es-hist-del="${esc(term)}" aria-label="删除">×</button>
                </span>
            `).join('')}
            <button type="button" class="wbo-link-btn wbo-es-hist-clear" id="wbo-es-hist-clear">清空</button>
        `;
    };
    const pushSearchHistory = (term) => {
        const clean = String(term ?? '').trim();
        if (!clean) return;
        const prev = Array.isArray(settings.entrySearchHistory) ? settings.entrySearchHistory : [];
        settings.entrySearchHistory = [clean, ...prev.filter((x) => x !== clean)].slice(0, 10);
        renderHistoryChips();
        void _callbacks?.onMutation({ save: true, uiOnly: true });
    };
    renderHistoryChips();

    historyRow?.addEventListener('click', (ev) => {
        const target = ev.target instanceof Element ? ev.target : null;
        if (!target) return;
        if (target.closest('#wbo-es-hist-clear')) {
            settings.entrySearchHistory = [];
            renderHistoryChips();
            void _callbacks?.onMutation({ save: true, uiOnly: true });
            return;
        }
        const delBtn = target.closest('[data-es-hist-del]');
        if (delBtn) {
            const term = delBtn.getAttribute('data-es-hist-del') || '';
            settings.entrySearchHistory = (settings.entrySearchHistory || []).filter((x) => x !== term);
            renderHistoryChips();
            void _callbacks?.onMutation({ save: true, uiOnly: true });
            return;
        }
        const pickBtn = target.closest('[data-es-hist-pick]');
        if (pickBtn) {
            const term = pickBtn.getAttribute('data-es-hist-pick') || '';
            _lastEntrySearchQuery = term;
            if (queryInput instanceof HTMLInputElement) queryInput.value = term;
            void runSearch();
        }
    });

    /** @type {{ cancelled: boolean } | null} */
    let activeSignal = null;

    // Cancel any running stream immediately when sub-modal closes!
    const cleanupObs = new MutationObserver(() => {
        if (!overlay.isConnected) {
            if (activeSignal) activeSignal.cancelled = true;
            cleanupObs.disconnect();
        }
    });
    cleanupObs.observe(document.body, { childList: true });

    const resolveTargetBooks = () => {
        const val = scopeSelect instanceof HTMLSelectElement ? scopeSelect.value : '__nonchar__';
        if (val === '__all__') return allBooks;
        if (val === '__nonchar__') return nonCharBooks;
        const sec = (classification.orderedSections || []).find((s) => s.id === val);
        return sec?.books || nonCharBooks;
    };

    const runSearch = async () => {
        const q = queryInput instanceof HTMLInputElement ? queryInput.value.trim() : '';
        if (!q) {
            showToast('info', '请先输入要搜索的关键词');
            if (queryInput instanceof HTMLInputElement && isDesktopAutoFocusAllowed()) queryInput.focus({ preventScroll: true });
            return;
        }
        const searchTitleAndKeys = Boolean(inTitleCb instanceof HTMLInputElement ? inTitleCb.checked : true);
        const searchContent = Boolean(inContentCb instanceof HTMLInputElement ? inContentCb.checked : true);
        const includeDisabled = Boolean(incDisabledCb instanceof HTMLInputElement ? incDisabledCb.checked : true);
        const splitSpaces = Boolean(splitSpacesCb instanceof HTMLInputElement ? splitSpacesCb.checked : false);
        if (!searchTitleAndKeys && !searchContent) {
            showToast('info', '请至少勾选「标题与触发词」或「正文内容」');
            return;
        }

        if (activeSignal) activeSignal.cancelled = true;
        const signal = { cancelled: false };
        activeSignal = signal;
        pushSearchHistory(q);

        const targetBooks = resolveTargetBooks();
        const bookMetaByName = new Map(targetBooks.map((b) => [b.realName, b]));
        const tokens = splitSpaces ? q.split(/\s+/).filter(Boolean) : [q];

        if (resultsEl) resultsEl.innerHTML = '';
        if (progWrap instanceof HTMLElement) progWrap.hidden = false;
        if (progFill instanceof HTMLElement) progFill.style.width = '0%';
        if (progText) progText.textContent = `准备扫描 0 / ${targetBooks.length} 本…`;
        if (runBtn instanceof HTMLButtonElement) runBtn.hidden = true;
        if (stopBtn instanceof HTMLButtonElement) stopBtn.hidden = false;

        const res = await searchWorldbookEntriesStream({
            worldNames: targetBooks.map((b) => b.realName),
            concurrency: 2,
            yieldMs: 12,
            maxTotalHits: 150,
            signal,
            matcher: (payload) => searchEntriesInPayload(payload, q, {
                searchTitleAndKeys,
                searchContent,
                includeDisabled,
                splitSpaces,
                maxHitsPerBook: 8,
            }),
            onBookResult: ({ worldName, hits, totalMatchesInBook }) => {
                if (!resultsEl || signal.cancelled) return;
                const meta = bookMetaByName.get(worldName);
                const card = document.createElement('div');
                card.className = 'wbo-es-book-card';
                const moreTag = totalMatchesInBook > hits.length
                    ? `<span class="wbo-tag">共 ${totalMatchesInBook} 条，显示前 ${hits.length} 条</span>`
                    : `<span class="wbo-tag">${hits.length} 条命中</span>`;
                const itemsHtml = hits.map((h) => `
                    <details class="wbo-es-entry">
                        <summary class="wbo-es-entry-sum">
                            <span class="wbo-es-entry-head">
                                <span class="wbo-es-entry-title">${highlightTokensHtml(h.title, tokens)}</span>
                                ${h.disabled ? '<span class="wbo-tag">已禁用</span>' : ''}
                                ${h.matchedIn.map((m) => `<span class="wbo-tag">${esc(m)}</span>`).join('')}
                                <button type="button" class="wbo-link-btn wbo-es-jump-uid" data-es-inplugin="${esc(worldName)}" data-es-uid="${esc(h.uid)}">插件内编辑</button>
                                <button type="button" class="wbo-link-btn" data-es-open="${esc(worldName)}" data-es-uid="${esc(h.uid)}" title="跳去酒馆原生编辑器定位此条目">原生定位</button>
                            </span>
                            ${h.keys.length > 0 ? `<div class="wbo-es-entry-keys">触发词：${highlightTokensHtml(h.keys.join('、'), tokens)}</div>` : ''}
                            ${h.snippet ? `<div class="wbo-es-entry-snip">${highlightTokensHtml(h.snippet, tokens)}</div>` : ''}
                        </summary>
                        <div class="wbo-es-entry-body">${highlightTokensHtml(h.content || '(无正文)', tokens)}</div>
                    </details>
                `).join('');
                card.innerHTML = `
                    <div class="wbo-es-book-head">
                        <div class="wbo-es-book-info">
                            <span class="wbo-es-book-title">${esc(meta?.primaryTitle || worldName)}</span>
                            ${meta?.groupName ? `<span class="wbo-tag">${esc(meta.groupName)}</span>` : ''}
                            ${moreTag}
                        </div>
                        <span class="wbo-es-book-actions">
                            <button type="button" class="wbo-btn wbo-es-open-btn" data-es-inplugin="${esc(worldName)}">
                                <i class="fa-regular fa-pen-to-square"></i> 浏览/编辑
                            </button>
                            <button type="button" class="wbo-icon-btn" data-es-open="${esc(worldName)}" title="在酒馆原生编辑器打开">
                                <i class="fa-solid fa-arrow-up-right-from-square"></i>
                            </button>
                        </span>
                    </div>
                    <div class="wbo-es-entries">${itemsHtml}</div>
                `;
                resultsEl.appendChild(card);
            },
            onProgress: ({ done, total, hitCount, matchedBooks }) => {
                if (signal.cancelled) return;
                const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 100;
                if (progFill instanceof HTMLElement) progFill.style.width = `${pct}%`;
                if (progText) {
                    progText.textContent = `已扫描 ${done} / ${total} 本 · 命中 ${matchedBooks} 本共 ${hitCount} 条`;
                }
            },
        });

        if (activeSignal === signal) {
            activeSignal = null;
            if (runBtn instanceof HTMLButtonElement) runBtn.hidden = false;
            if (stopBtn instanceof HTMLButtonElement) stopBtn.hidden = true;
            if (progFill instanceof HTMLElement && !res.cancelled) progFill.style.width = '100%';
            if (progText) {
                const statusSuffix = res.cancelled
                    ? '（已停止）'
                    : res.capped
                        ? '（已达单次显示上限 150 条，建议缩小分组或加词）'
                        : '（完成）';
                progText.textContent = `扫描 ${res.done} / ${res.total} 本 · 命中 ${res.matchedBooks} 本共 ${res.hitCount} 条 ${statusSuffix}`;
            }
            if (resultsEl && res.hitCount === 0) {
                resultsEl.innerHTML = '<div class="wbo-empty-hint">当前范围内未找到包含该关键词的条目，可切换搜索范围或换词重试。</div>';
            }
        }
    };

    runBtn?.addEventListener('click', () => { void runSearch(); });
    stopBtn?.addEventListener('click', () => {
        if (activeSignal) activeSignal.cancelled = true;
    });
    modal.querySelector('#wbo-es-close-btn')?.addEventListener('click', () => {
        if (activeSignal) activeSignal.cancelled = true;
        closeSubModal();
    });
    bindImeSafeEnter(queryInput, () => { void runSearch(); });
    resultsEl?.addEventListener('click', (ev) => {
        const target = ev.target instanceof Element ? ev.target : null;
        if (!target) return;
        const inPluginBtn = target.closest('[data-es-inplugin]');
        if (inPluginBtn) {
            ev.preventDefault();
            ev.stopPropagation();
            const worldName = inPluginBtn.getAttribute('data-es-inplugin');
            const uid = inPluginBtn.getAttribute('data-es-uid');
            if (!worldName) return;
            if (activeSignal) activeSignal.cancelled = true;
            const meta = _callbacks?.getState?.()?.classification?.byName?.get(worldName)
                || { realName: worldName, primaryTitle: worldName };
            openBookEntryBrowserModal(meta, { initialUid: uid || null, stack: true });
            return;
        }
        const btn = target.closest('[data-es-open]');
        if (!btn) return;
        ev.preventDefault();
        ev.stopPropagation();
        const worldName = btn.getAttribute('data-es-open');
        const uid = btn.getAttribute('data-es-uid');
        if (!worldName) return;
        if (activeSignal) activeSignal.cancelled = true;
        openWorldInNativeEditor(worldName, { focusUid: uid || null });
        closeSubModal({ all: true });
        closeManagerModal();
    });

    if (autoRun && String(initialQuery).trim()) {
        setTimeout(() => { void runSearch(); }, 30);
    } else if (queryInput instanceof HTMLInputElement && isDesktopAutoFocusAllowed()) {
        setTimeout(() => {
            if (queryInput.isConnected && isDesktopAutoFocusAllowed()) queryInput.focus({ preventScroll: true });
        }, 20);
    }
}

export {
    _mgrInlineEntrySignal,
    cancelManagerInlineEntrySearch,
    clearManagerInlineEntryResults,
    openBookEntryBrowserModal,
    openEntrySearchModal,
    openManagerSearchOptionsPopover,
    runManagerInlineEntrySearch,
    syncManagerSearchBarUi,
};
