/**
 * Worldbook Entry Groups — Group editor and chat-bound route controls.
 */

import { attachModalWindowControls, isDesktopAutoFocusAllowed, UNDO_SVG } from '../panel-window.js';

import {
    ENTRY_ACTIVATION_MODES,
    GROUP_MODES,
    SPECIAL_GROUP_UNGROUPED,
    VALID_COLOR_MODES,
    VALID_EDITOR_HEIGHTS,
    VALID_PALETTES,
    WORLD_INFO_POSITION,
    applyAutoGroupProposals,
    applyTextareaTabIndent,
    buildGroupedView,
    cloneBookConfig,
    collectOrphanedOpenDrafts,
    computeEditDirty,
    computeEntryTogglePlan,
    computeGroupTogglePlan,
    countPinnedEntries,
    createGroupId,
    createTextareaHistory,
    detectAutoGroups,
    estimateEntryTokens,
    findNextMatchInText,
    formatGreetingCommentTag,
    formatOrphanedDraftText,
    isBookConfigEmpty,
    matchEntries,
    normalizeBookConfig,
    normalizeKeywordList,
    parseEntryKeywordsInput,
    pruneOrphanAssignments,
    reconcileAccordionDraftOnExternalRefresh,
    removeGroupFromBookConfig,
    setEntryPinned,
    setGroupPinned,
    sliceGroupedSectionsForRender,
} from './core.js';
import {
    applyGreetingPresetToWorldbook,
    applyTauriSurface,
    applyWorldbookTogglePlan,
    copyTextToClipboard,
    detectHostColorScheme,
    getActiveChatBoundProfile,
    getPreferredDefaultBook,
    getSettings,
    getWorldNames,
    loadWorldbookEntryForEditUncached,
    locateEntryInNativeEditor,
    loadWorldbookSummariesUncached,
    recordStateIntoActiveChatIfMatching,
    resolveGreetingCoordinationForBook,
    saveActiveChatBoundProfile,
    saveWorldbookEntryEdit,
    showToast,
} from './host.js';
import { removeNativeEntryGroups, revealNativeEntryGroup, syncNativeEntryGroups } from './native-view.js';
import { attachGroupedSelectControl, closeGroupedSelectControl } from '../native-filter.js';

const MODAL_BACKDROP_ID = 'weg-modal-backdrop';
const MINIMIZE_PILL_ID = 'weg-minimized-pill';
const FLOATING_MENU_ID = 'weg-floating-menu';
const MAX_UNDO_STEPS = 15;
const INCREMENTAL_RENDER_STEP = 60;

let _callbacks = null;

let _isOpen = false;
let _isMinimized = false;
let _minimizedScrollTop = 0;
let _currentBook = '';
let _loadingBook = false;
let _writingToggle = false;
let _loadError = '';
/** @type {Array<any>} */
let _loadedSummaries = [];
let _greetingCharName = '';
let _greetingIndex = null;

let _searchQuery = '';
let _isComposing = false;
/** @type {'all' | 'pinned' | 'enabled' | 'disabled'} */
let _statusFilter = 'all';
let _batchMode = false;
/** @type {Set<string>} */
const _selectedUids = new Set();

/** @type {Map<string, Array<any>>} */
const _undoStacks = new Map();

let _submodal = null;
let _windowInteractCleanup = null;
let _floatingMenuCleanup = null;
let _modalKeydownCleanup = null;

let _editorLoadCounter = 0;
/** @type {Map<string, any>} */
const _openEditors = new Map();
/** @type {Map<string, HTMLElement>} */
const _mountedEditorEls = new Map();
let _visibleRenderLimit = INCREMENTAL_RENDER_STEP;
let _freezePinnedOrder = false;
let _sessionGroupOrder = [];

const BOOK_SCOPED_SUBMODAL_TYPES = new Set(['confirm-discard', 'group-form', 'batch-move', 'auto-detect']);

function cssEsc(val) {
    const str = String(val ?? '');
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
        return CSS.escape(str);
    }
    return str.replace(/["\\]/g, '\\$&');
}

function makeSafeDomId(uid) {
    return String(uid ?? '').replace(/[^a-zA-Z0-9_-]/g, (ch) => `_${ch.charCodeAt(0).toString(16)}_`);
}

function stopStDrawerCollapsePropagation(el) {
    if (!(el instanceof Element)) return;
    for (const evtName of ['pointerdown', 'mousedown', 'touchstart', 'click']) {
        el.addEventListener(evtName, (ev) => {
            ev.stopPropagation();
        });
    }
}

function getDirtyEditorUids() {
    const dirty = [];
    for (const [uid, state] of _openEditors.entries()) {
        if (state?.dirty) dirty.push(uid);
    }
    return dirty;
}

function clearAllEditors({ unmount = true } = {}) {
    ++_editorLoadCounter;
    _openEditors.clear();
    if (unmount) {
        for (const el of _mountedEditorEls.values()) {
            el.remove();
        }
        _mountedEditorEls.clear();
    }
}

function esc(val) {
    return String(val ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function isNarrowViewport() {
    if (typeof window === 'undefined') return false;
    return window.__TAURITAVERN_HOST__?.kind === 'mobile'
        || window.innerWidth <= 768 || Boolean(window.matchMedia?.('(pointer: coarse)')?.matches);
}

export function bindPanelCallbacks(callbacks) {
    _callbacks = callbacks || null;
}

function notifySettingsChanged() {
    _callbacks?.onSettingsChanged?.();
}

function getBookConfigMutable(settings, worldName) {
    if (!worldName) return normalizeBookConfig(null);
    if (!settings.books || typeof settings.books !== 'object') {
        settings.books = {};
    }
    if (!settings.books[worldName]) {
        settings.books[worldName] = normalizeBookConfig(null);
    } else {
        settings.books[worldName] = normalizeBookConfig(settings.books[worldName]);
    }
    return settings.books[worldName];
}

function saveBookConfigWithCleanEmpty(settings, worldName, bookConfig) {
    if (!worldName) return;
    const norm = normalizeBookConfig(bookConfig);
    if (!settings.books || typeof settings.books !== 'object') {
        settings.books = {};
    }
    if (isBookConfigEmpty(norm)) {
        delete settings.books[worldName];
    } else {
        settings.books[worldName] = norm;
    }
    notifySettingsChanged();
}

function pushUndoSnapshot(worldName, bookConfig) {
    if (!worldName) return;
    if (!_undoStacks.has(worldName)) {
        _undoStacks.set(worldName, []);
    }
    const stack = _undoStacks.get(worldName);
    stack.push(cloneBookConfig(bookConfig));
    if (stack.length > MAX_UNDO_STEPS) {
        stack.shift();
    }
}

function getUndoCount(worldName) {
    if (!worldName) return 0;
    return _undoStacks.get(worldName)?.length || 0;
}

function popUndoSnapshot(worldName) {
    if (!worldName) return null;
    const stack = _undoStacks.get(worldName);
    if (!stack || stack.length === 0) return null;
    return stack.pop() || null;
}

export function syncAllNativeEntryPoints() {
    syncNativeEntryGroups(openEntryGroupsModal);
}

export function isEntryGroupsModalOpen() {
    return _isOpen;
}

export function getCurrentModalWorldName() {
    return _isOpen ? _currentBook : '';
}

function applyModalThemeAttributes(modalEl) {
    if (!modalEl) return;
    const settings = getSettings();
    const palette = VALID_PALETTES.includes(settings.palette) ? settings.palette : 'paper';
    const modePref = VALID_COLOR_MODES.includes(settings.colorMode) ? settings.colorMode : 'auto';
    const resolvedScheme = modePref === 'auto' ? detectHostColorScheme() : modePref;

    modalEl.setAttribute('data-weg-palette', palette);
    modalEl.classList.toggle('weg-theme-light', resolvedScheme === 'light');
    modalEl.classList.toggle('weg-theme-dark', resolvedScheme !== 'light');
}

function closeFloatingMenu() {
    if (_floatingMenuCleanup) {
        _floatingMenuCleanup();
        _floatingMenuCleanup = null;
    }
    if (typeof document !== 'undefined') {
        document.getElementById(FLOATING_MENU_ID)?.remove();
    }
}

function openFloatingMenu(anchorEl, items) {
    closeFloatingMenu();
    if (!anchorEl || typeof document === 'undefined') return;

    const menu = document.createElement('div');
    menu.id = FLOATING_MENU_ID;
    menu.className = 'weg-floating-menu';
    menu.setAttribute('role', 'menu');
    applyModalThemeAttributes(menu);
    stopStDrawerCollapsePropagation(menu);

    for (const item of items) {
        if (!item) continue;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `weg-floating-menu-item${item.danger ? ' is-danger' : ''}`;
        btn.disabled = Boolean(item.disabled);
        btn.setAttribute('role', 'menuitem');
        btn.innerHTML = `${item.icon ? `<i class="fa-solid ${esc(item.icon)} weg-menu-icon" aria-hidden="true"></i>` : ''}<span>${esc(item.label)}</span>`;
        btn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            closeFloatingMenu();
            if (!item.disabled) item.onClick();
        });
        menu.appendChild(btn);
    }

    document.body.appendChild(menu);

    const anchorRect = anchorEl.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pad = 8;

    let left = anchorRect.right - menuRect.width;
    if (left < pad) left = pad;
    if (left + menuRect.width > vw - pad) left = Math.max(pad, vw - menuRect.width - pad);

    let top = anchorRect.bottom + 4;
    if (top + menuRect.height > vh - pad && anchorRect.top - menuRect.height - 4 >= pad) {
        top = anchorRect.top - menuRect.height - 4;
    } else if (top + menuRect.height > vh - pad) {
        top = Math.max(pad, vh - menuRect.height - pad);
    }
    if (top < pad) top = pad;

    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;

    const onOutsidePointer = (ev) => {
        const target = ev.target instanceof Node ? ev.target : null;
        if (target && (menu.contains(target) || anchorEl.contains(target))) return;
        closeFloatingMenu();
    };
    const onEscape = (ev) => {
        if (ev.key === 'Escape') {
            ev.stopPropagation();
            closeFloatingMenu();
        }
    };

    setTimeout(() => {
        document.addEventListener('pointerdown', onOutsidePointer, true);
        document.addEventListener('keydown', onEscape, true);
    }, 0);

    _floatingMenuCleanup = () => {
        document.removeEventListener('pointerdown', onOutsidePointer, true);
        document.removeEventListener('keydown', onEscape, true);
    };
}

async function loadBookIntoModal(worldName, { silent = false, preserveSelection = false } = {}) {
    const clean = String(worldName ?? '').trim();
    const bookChanged = _currentBook !== clean;
    _currentBook = clean;
    _loadError = '';
    if (!preserveSelection) {
        _selectedUids.clear();
    }
    if (bookChanged || !preserveSelection) {
        clearAllEditors();
        _visibleRenderLimit = INCREMENTAL_RENDER_STEP;
        _freezePinnedOrder = false;
    }

    if (!clean) {
        _loadedSummaries = [];
        _greetingCharName = '';
        _greetingIndex = null;
        renderModalContents();
        return;
    }

    const settings = getSettings();
    if (settings.lastOpenedBook !== clean) {
        settings.lastOpenedBook = clean;
        notifySettingsChanged();
    }

    if (!silent) {
        _loadingBook = true;
        renderModalContents();
    }

    const [bookRes, greetRes] = await Promise.all([
        loadWorldbookSummariesUncached(clean),
        settings.syncGreetingTags !== false
            ? resolveGreetingCoordinationForBook(clean, { allowFetchShallow: false })
            : Promise.resolve({ characterName: '', greetingIndex: null }),
    ]);

    if (!_isOpen || _currentBook !== clean) return;

    _loadingBook = false;
    if (!bookRes.ok) {
        _loadError = bookRes.error || '读取世界书失败';
        _loadedSummaries = [];
        _greetingCharName = '';
        _greetingIndex = null;
        renderModalContents();
        return;
    }

    _loadedSummaries = bookRes.summaries;
    _greetingCharName = greetRes.characterName || '';
    _greetingIndex = greetRes.greetingIndex || null;
    void _greetingCharName;

    const curSettings = getSettings();
    if (curSettings.books?.[clean]) {
        const validSet = new Set(_loadedSummaries.map((e) => e.uid));
        const removed = pruneOrphanAssignments(curSettings.books[clean], validSet);
        if (removed > 0) {
            saveBookConfigWithCleanEmpty(curSettings, clean, curSettings.books[clean]);
        }
    }

    if (_selectedUids.size > 0) {
        const validSet = new Set(_loadedSummaries.map((e) => e.uid));
        for (const uid of [..._selectedUids]) {
            if (!validSet.has(uid)) _selectedUids.delete(uid);
        }
    }

    renderModalContents();
}

export async function refreshOpenModalBook({ silent = false } = {}) {
    if (!_isOpen || !_currentBook || _writingToggle) return;
    if (_openEditors.size > 0) {
        await handleExternalEntriesUpdated(_currentBook);
        return;
    }
    _freezePinnedOrder = false;
    await loadBookIntoModal(_currentBook, { silent, preserveSelection: true });
}

export async function handleExternalEntriesUpdated(worldName, { showToastOnComplete = false } = {}) {
    const clean = String(worldName ?? '').trim();
    if (!_isOpen || !clean || _currentBook !== clean || _writingToggle) return;

    const bookRes = await loadWorldbookSummariesUncached(clean);
    if (!_isOpen || _currentBook !== clean) return;
    if (!bookRes.ok) {
        if (showToastOnComplete) {
            showToast('error', bookRes.error || '刷新世界书失败');
        }
        return;
    }

    _loadedSummaries = bookRes.summaries;
    const curSettings = getSettings();
    if (curSettings.books?.[clean]) {
        const validSet = new Set(_loadedSummaries.map((e) => e.uid));
        const removed = pruneOrphanAssignments(curSettings.books[clean], validSet);
        if (removed > 0) {
            saveBookConfigWithCleanEmpty(curSettings, clean, curSettings.books[clean]);
        }
    }

    const openUids = [..._openEditors.keys()];
    for (const uid of openUids) {
        const state = _openEditors.get(uid);
        if (!state || state.worldName !== clean || state.loading || state.saving) continue;

        const entryRes = await loadWorldbookEntryForEditUncached(clean, uid);
        if (!_isOpen || _currentBook !== clean || _openEditors.get(uid) !== state) return;

        const latestSnap = entryRes.ok ? entryRes.entry : null;
        const rec = reconcileAccordionDraftOnExternalRefresh(state, latestSnap);

        if (rec.action === 'close') {
            collapseAccordionEditorImmediate(uid, { skipRender: true });
            continue;
        }
        if (rec.action === 'warn-deleted') {
            state.externalDeleted = true;
            state.externalStale = true;
            const panelEl = _mountedEditorEls.get(uid);
            if (panelEl) updateAccordionPanelChrome(panelEl, state);
            continue;
        }
        if (rec.action === 'update-clean') {
            state.initialSnapshot = rec.nextInitial;
            state.draft = rec.nextDraft;
            state.dirty = false;
            state.externalStale = false;
            state.externalDeleted = false;
            const panelEl = _mountedEditorEls.get(uid);
            if (panelEl) {
                applySnapshotToMountedForm(panelEl, state);
                updateAccordionPanelChrome(panelEl, state);
            }
            continue;
        }
        if (rec.action === 'keep-dirty-unchanged') {
            state.externalStale = false;
            state.externalDeleted = false;
            continue;
        }
        if (rec.action === 'mark-external-stale') {
            state.initialSnapshot = rec.nextInitial;
            state.externalStale = true;
            state.externalDeleted = false;
            state.dirty = computeEditDirty(state.initialSnapshot, state.draft);
            const panelEl = _mountedEditorEls.get(uid);
            if (panelEl) updateAccordionPanelChrome(panelEl, state);
        }
    }

    renderBodyAndFooterOnly();
    if (showToastOnComplete) {
        showToast('info', '已刷新当前世界书');
    }
}

export function handleExternalWorldbookRenamed(oldName, newName) {
    if (_undoStacks.has(oldName)) {
        _undoStacks.set(newName, _undoStacks.get(oldName));
        _undoStacks.delete(oldName);
    }
    if (_currentBook === oldName) {
        _currentBook = newName;
    }
    for (const state of _openEditors.values()) {
        if (state && state.worldName === oldName) {
            state.worldName = newName;
        }
    }
    if (_isOpen) {
        renderModalContents();
    }
}

export function handleExternalWorldbookDeleted(deletedNames) {
    const delSet = new Set((deletedNames || []).map((n) => String(n ?? '').trim()).filter(Boolean));
    for (const name of delSet) {
        _undoStacks.delete(name);
    }
    for (const [uid, state] of [..._openEditors.entries()]) {
        if (state && delSet.has(state.worldName)) {
            collapseAccordionEditorImmediate(uid, { skipRender: true });
        }
    }
    if (delSet.has(_currentBook)) {
        _batchMode = false;
        _selectedUids.clear();
        if (_submodal && BOOK_SCOPED_SUBMODAL_TYPES.has(_submodal.type)) {
            _submodal = null;
            if (_isOpen) renderSubmodalHost();
        }
    }
    if (_isOpen && delSet.has(_currentBook)) {
        const settings = getSettings();
        const fallback = getPreferredDefaultBook(settings);
        void loadBookIntoModal(fallback, { silent: false, preserveSelection: false });
    } else if (_isOpen) {
        renderModalContents();
    } else if (delSet.has(_currentBook)) {
        _currentBook = '';
    }
}

function ensureModalShell() {
    let backdrop = document.getElementById(MODAL_BACKDROP_ID);
    if (backdrop) return backdrop;

    backdrop = document.createElement('div');
    backdrop.id = MODAL_BACKDROP_ID;
    backdrop.className = 'weg-modal-backdrop';
    applyTauriSurface(backdrop, 'backdrop');

    backdrop.addEventListener('click', (ev) => {
        if (ev.target === backdrop) {
            ev.stopPropagation();
        }
    });

    const modal = document.createElement('div');
    modal.className = 'weg-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-label', '世界书条目分组');
    applyTauriSurface(modal, 'fullscreen-window');
    applyModalThemeAttributes(modal);

    modal.innerHTML = `
        <div class="weg-view weg-list-view" id="weg-list-view">
            <header class="weg-header" data-weg-drag-handle="1">
                <div class="weg-header-title-wrap">
                    <span class="weg-header-title">世界书条目分组</span>
                    <span class="weg-header-stats" id="weg-header-stats"></span>
                </div>
                <div class="weg-header-actions">
                    <button type="button" class="weg-btn weg-btn-subtle" id="weg-btn-auto-detect" title="按标题前缀、分隔条、NSFW 或开场白注释自动建组">自动识别</button>
                    <button type="button" class="weg-btn weg-btn-primary" id="weg-btn-new-group">新建分组</button>
                    <button type="button" class="weg-icon-btn" id="weg-btn-settings" title="外观与联动设置" aria-label="设置">
                        <i class="fa-solid fa-sliders" aria-hidden="true"></i>
                    </button>
                    <button type="button" class="weg-icon-btn" id="weg-btn-minimize" title="暂收窗口（保留状态与草稿）" aria-label="最小化">
                        <i class="fa-solid fa-minus" aria-hidden="true"></i>
                    </button>
                    <button type="button" class="weg-icon-btn weg-close-btn" id="weg-btn-close" title="关闭窗口" aria-label="关闭">
                        <i class="fa-solid fa-xmark" aria-hidden="true"></i>
                    </button>
                </div>
            </header>

            <div class="weg-toolbar">
                <div class="weg-book-bar">
                    <select class="weg-select weg-book-select" id="weg-book-select" aria-label="选择世界书"></select>
                    <button type="button" class="weg-icon-btn" id="weg-btn-refresh" title="重新读取当前世界书状态" aria-label="刷新">
                        <i class="fa-solid fa-rotate-right" aria-hidden="true"></i>
                    </button>
                </div>
                <div class="weg-filter-bar">
                    <div class="weg-search-wrap">
                        <i class="fa-solid fa-magnifying-glass weg-search-icon" aria-hidden="true"></i>
                        <input type="search" class="weg-input weg-search-input" id="weg-search-input" aria-label="搜索条目" placeholder="搜索条目标题、触发词、正文或 UID…" autocomplete="off" spellcheck="false" />
                        <button type="button" class="weg-clear-input-btn" id="weg-search-clear" title="清空搜索词" hidden>清空</button>
                    </div>
                </div>
            </div>

            <div class="weg-quick-filters" id="weg-quick-filters" role="tablist" aria-label="快捷筛选">
                <button type="button" class="weg-filter-pill is-active" data-weg-filter="all" role="tab" aria-selected="true">全部</button>
                <button type="button" class="weg-filter-pill is-pin-pill" id="weg-filter-pinned-pill" data-weg-filter="pinned" role="tab" aria-selected="false">
                    <i class="fa-solid fa-star" aria-hidden="true"></i>
                    <span>已置顶</span>
                    <span class="weg-filter-pill-count" id="weg-filter-pinned-count">(0)</span>
                </button>
                <button type="button" class="weg-filter-pill" data-weg-filter="enabled" role="tab" aria-selected="false">已开启</button>
                <button type="button" class="weg-filter-pill" data-weg-filter="disabled" role="tab" aria-selected="false">已关闭</button>
            </div>

            <div class="weg-save-bar" id="weg-save-bar"></div>

            <main class="weg-body" id="weg-body"></main>

            <footer class="weg-footer" id="weg-footer"></footer>
        </div>

        <div class="weg-submodal-host" id="weg-submodal-host" hidden></div>
    `;

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    stopStDrawerCollapsePropagation(modal);
    const subHost = modal.querySelector('#weg-submodal-host');
    if (subHost) stopStDrawerCollapsePropagation(subHost);
    wireShellEvents(modal);

    return backdrop;
}

function removeMinimizedPill() {
    if (typeof document !== 'undefined') {
        document.getElementById(MINIMIZE_PILL_ID)?.remove();
    }
}

function minimizeEntryGroupsModal() {
    if (typeof document === 'undefined' || !_isOpen || _isMinimized) return;
    closeFloatingMenu();
    const backdrop = document.getElementById(MODAL_BACKDROP_ID);
    closeGroupedSelectControl(backdrop?.querySelector('#weg-book-select'));
    const bodyEl = backdrop?.querySelector('#weg-body');
    _minimizedScrollTop = bodyEl instanceof HTMLElement ? bodyEl.scrollTop : 0;
    _isMinimized = true;
    if (backdrop instanceof HTMLElement) {
        backdrop.hidden = true;
    }

    removeMinimizedPill();
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.id = MINIMIZE_PILL_ID;
    pill.className = 'weg-minimized-pill';
    pill.setAttribute('aria-label', '恢复条目分组面板');
    applyModalThemeAttributes(pill);
    const dirtyCount = getDirtyEditorUids().length;
    pill.innerHTML = `
        <i class="fa-solid fa-folder-tree" aria-hidden="true"></i>
        <span>条目分组 · 点击恢复${dirtyCount > 0 ? ` (${dirtyCount}条未保存)` : ''}</span>
    `;
    stopStDrawerCollapsePropagation(pill);
    pill.addEventListener('click', (ev) => {
        ev.stopPropagation();
        restoreMinimizedModal();
    });
    document.body.appendChild(pill);
}

function restoreMinimizedModal() {
    if (typeof document === 'undefined' || !_isOpen) return;
    _isMinimized = false;
    removeMinimizedPill();

    const backdrop = document.getElementById(MODAL_BACKDROP_ID);
    if (backdrop instanceof HTMLElement) {
        backdrop.hidden = false;
        const modal = backdrop.querySelector('.weg-modal');
        if (modal instanceof HTMLElement) {
            applyModalThemeAttributes(modal);
        }
        const bodyEl = backdrop.querySelector('#weg-body');
        if (bodyEl instanceof HTMLElement) {
            bodyEl.scrollTop = _minimizedScrollTop;
            requestAnimationFrame(() => {
                if (bodyEl.isConnected) bodyEl.scrollTop = _minimizedScrollTop;
            });
        }
    }
}

function requestCloseEntryGroupsModal() {
    const dirtyUids = getDirtyEditorUids();
    if (dirtyUids.length > 0) {
        _submodal = {
            type: 'confirm-discard',
            scope: 'modal',
            nextAction: 'close',
            dirtyCount: dirtyUids.length,
        };
        renderSubmodalHost();
        return;
    }
    closeEntryGroupsModal({ force: true });
}

function wireShellEvents(modal) {
    const closeBtn = modal.querySelector('#weg-btn-close');
    const minimizeBtn = modal.querySelector('#weg-btn-minimize');
    const newGroupBtn = modal.querySelector('#weg-btn-new-group');
    const autoDetectBtn = modal.querySelector('#weg-btn-auto-detect');
    const settingsBtn = modal.querySelector('#weg-btn-settings');
    const bookSelect = modal.querySelector('#weg-book-select');
    const refreshBtn = modal.querySelector('#weg-btn-refresh');
    const searchInput = modal.querySelector('#weg-search-input');
    const searchClearBtn = modal.querySelector('#weg-search-clear');
    const quickFiltersEl = modal.querySelector('#weg-quick-filters');
    const saveBarEl = modal.querySelector('#weg-save-bar');
    const bodyEl = modal.querySelector('#weg-body');
    const footerEl = modal.querySelector('#weg-footer');

    closeBtn?.addEventListener('click', () => requestCloseEntryGroupsModal());
    minimizeBtn?.addEventListener('click', () => minimizeEntryGroupsModal());

    newGroupBtn?.addEventListener('click', () => {
        if (!_currentBook) {
            showToast('warning', '请先选择一本世界书');
            return;
        }
        openGroupFormSubmodal(null);
    });

    autoDetectBtn?.addEventListener('click', () => {
        if (!_currentBook || _loadedSummaries.length === 0) {
            showToast('warning', '当前世界书暂无可识别条目');
            return;
        }
        void openAutoDetectSubmodal();
    });

    settingsBtn?.addEventListener('click', () => {
        openSettingsSubmodal();
    });

    bookSelect?.addEventListener('change', (ev) => {
        const nextBook = String(ev.target?.value ?? '').trim();
        if (nextBook === _currentBook) return;
        const dirtyUids = getDirtyEditorUids();
        if (dirtyUids.length > 0) {
            if (bookSelect instanceof HTMLSelectElement) {
                bookSelect.value = _currentBook;
            }
            _submodal = {
                type: 'confirm-discard',
                scope: 'modal',
                nextAction: 'switch-book',
                targetBook: nextBook,
                dirtyCount: dirtyUids.length,
            };
            renderSubmodalHost();
            return;
        }
        _batchMode = false;
        _selectedUids.clear();
        void loadBookIntoModal(nextBook, { silent: false, preserveSelection: false });
    });

    refreshBtn?.addEventListener('click', () => {
        if (!_currentBook) return;
        _freezePinnedOrder = false;
        if (_openEditors.size > 0) {
            void handleExternalEntriesUpdated(_currentBook, { showToastOnComplete: true });
        } else {
            void loadBookIntoModal(_currentBook, { silent: false, preserveSelection: true });
        }
    });

    if (searchInput instanceof HTMLInputElement) {
        searchInput.addEventListener('compositionstart', () => {
            _isComposing = true;
        });
        searchInput.addEventListener('compositionend', () => {
            _isComposing = false;
            _searchQuery = searchInput.value;
            _visibleRenderLimit = INCREMENTAL_RENDER_STEP;
            if (searchClearBtn instanceof HTMLElement) {
                searchClearBtn.hidden = !_searchQuery;
            }
            renderBodyAndFooterOnly();
        });
        searchInput.addEventListener('input', () => {
            if (_isComposing) return;
            _searchQuery = searchInput.value;
            _visibleRenderLimit = INCREMENTAL_RENDER_STEP;
            if (searchClearBtn instanceof HTMLElement) {
                searchClearBtn.hidden = !_searchQuery;
            }
            renderBodyAndFooterOnly();
        });
    }

    searchClearBtn?.addEventListener('click', () => {
        if (searchInput instanceof HTMLInputElement) {
            searchInput.value = '';
            if (isDesktopAutoFocusAllowed()) searchInput.focus({ preventScroll: true });
        }
        _searchQuery = '';
        _visibleRenderLimit = INCREMENTAL_RENDER_STEP;
        if (searchClearBtn instanceof HTMLElement) searchClearBtn.hidden = true;
        renderBodyAndFooterOnly();
    });

    quickFiltersEl?.addEventListener('click', (ev) => {
        const target = ev.target instanceof Element ? ev.target : null;
        const pill = target?.closest('[data-weg-filter]');
        if (!(pill instanceof HTMLElement)) return;
        const nextFilter = pill.getAttribute('data-weg-filter') || 'all';
        if (!['all', 'pinned', 'enabled', 'disabled'].includes(nextFilter)) return;
        _statusFilter = /** @type {any} */ (nextFilter);
        _visibleRenderLimit = INCREMENTAL_RENDER_STEP;
        _freezePinnedOrder = false;
        renderBodyAndFooterOnly();
    });

    // Pure metadata per-chat save bar actions + 1-click greeting preset selector
    saveBarEl?.addEventListener('change', async (ev) => {
        const sel = ev.target instanceof HTMLSelectElement ? ev.target : null;
        if (!sel || sel.id !== 'weg-preset-greeting-select' || sel.value === '') return;
        const swipeIdx = Number.parseInt(sel.value, 10);
        sel.value = '';
        if (!Number.isInteger(swipeIdx) || !_currentBook || !_greetingIndex || _writingToggle) return;

        const targetBook = _currentBook;
        _writingToggle = true;
        renderBodyAndFooterOnly();
        const res = await applyGreetingPresetToWorldbook(targetBook, _greetingIndex, swipeIdx);
        _writingToggle = false;

        if (!_isOpen || _currentBook !== targetBook) {
            if (_isOpen) {
                renderBodyAndFooterOnly();
            }
            return;
        }

        if (!res.ok) {
            showToast('error', res.error || '套用开场白方案失败');
            renderBodyAndFooterOnly();
            return;
        }
        _loadedSummaries = res.summaries;
        syncAllNativeEntryPoints();
        renderModalContents();
        showToast('success', `已套用方案「${res.routeLabel}」并记住到本存档`);
    });

    saveBarEl?.addEventListener('click', (ev) => {
        const target = ev.target instanceof Element ? ev.target : null;
        if (!target) return;
        const btn = target.closest('[data-weg-save-action]');
        if (!(btn instanceof HTMLElement) || btn.hasAttribute('disabled')) return;

        const action = btn.getAttribute('data-weg-save-action');
        if (action === 'bind-current') {
            if (!_currentBook || _loadedSummaries.length === 0) return;
            const prof = recordStateIntoActiveChatIfMatching(_currentBook, _loadedSummaries, {
                greetingIndex: _greetingIndex,
                force: true,
            });
            if (prof) {
                syncAllNativeEntryPoints();
                renderBodyAndFooterOnly();
                showToast('success', `已将当前状态记住到本存档（${prof.routeLabel}）`);
            }
        } else if (action === 'unbind-current') {
            saveActiveChatBoundProfile(null);
            syncAllNativeEntryPoints();
            renderBodyAndFooterOnly();
            showToast('info', '已解除当前聊天存档的路线绑定');
        }
    });

    bodyEl?.addEventListener('click', async (ev) => {
        const target = ev.target instanceof Element ? ev.target : null;
        if (!target) return;

        const deletedActionBtn = target.closest('[data-weg-deleted-action]');
        if (deletedActionBtn instanceof HTMLElement) {
            ev.stopPropagation();
            const action = deletedActionBtn.getAttribute('data-weg-deleted-action');
            const uid = deletedActionBtn.getAttribute('data-weg-deleted-uid') || '';
            const state = uid ? _openEditors.get(uid) : null;
            if (!uid || !state) return;
            if (action === 'copy') {
                state.syncDraftFromDom?.();
                const text = formatOrphanedDraftText(state);
                if (!text) {
                    showToast('info', '草稿内容为空');
                    return;
                }
                const ok = await copyTextToClipboard(text);
                showToast(ok ? 'success' : 'warning', ok ? `已复制条目 #${uid} 草稿` : '复制失败，请手动全选下方草稿复制');
            } else if (action === 'discard') {
                collapseAccordionEditorImmediate(uid, { skipRender: true });
                renderBodyAndFooterOnly();
                showToast('info', `已放弃条目 #${uid} 的未保存草稿`);
            }
            return;
        }

        if (target.closest('.weg-acc-panel')) {
            return;
        }

        const loadMoreBtn = target.closest('#weg-btn-load-more-60');
        if (loadMoreBtn instanceof HTMLElement) {
            _visibleRenderLimit = Number.isFinite(_visibleRenderLimit)
                ? _visibleRenderLimit + INCREMENTAL_RENDER_STEP
                : INCREMENTAL_RENDER_STEP;
            renderBodyAndFooterOnly();
            return;
        }

        const loadAllBtn = target.closest('#weg-btn-load-all');
        if (loadAllBtn instanceof HTMLElement) {
            _visibleRenderLimit = Infinity;
            renderBodyAndFooterOnly();
            return;
        }

        const pinGrpBtn = target.closest('[data-weg-pin-group]');
        if (pinGrpBtn instanceof HTMLElement) {
            ev.stopPropagation();
            const groupId = pinGrpBtn.getAttribute('data-weg-pin-group') || '';
            if (groupId) togglePinGroup(groupId);
            return;
        }

        const grpToggle = target.closest('[data-weg-group-toggle]');
        if (grpToggle instanceof HTMLElement) {
            ev.stopPropagation();
            const groupId = grpToggle.getAttribute('data-weg-group-toggle') || '';
            const nextEnabled = grpToggle.getAttribute('data-weg-next-enabled') === '1';
            void handleGroupToggle(groupId, nextEnabled);
            return;
        }

        const grpMenuBtn = target.closest('[data-weg-group-menu]');
        if (grpMenuBtn instanceof HTMLElement) {
            ev.stopPropagation();
            const groupId = grpMenuBtn.getAttribute('data-weg-group-menu') || '';
            openGroupActionsMenu(grpMenuBtn, groupId);
            return;
        }

        const batchCheck = target.closest('[data-weg-group-batch]');
        if (batchCheck instanceof HTMLInputElement) {
            ev.stopPropagation();
            const groupId = batchCheck.dataset.wegGroupBatch;
            const bookCfg = getBookConfigMutable(getSettings(), _currentBook);
            toggleSelectedEntries(getGroupEntryUids(bookCfg, groupId));
            return;
        }

        const grpHeader = target.closest('[data-weg-group-header]');
        if (grpHeader instanceof HTMLElement) {
            const groupId = grpHeader.getAttribute('data-weg-group-header') || '';
            toggleGroupCollapse(groupId);
            return;
        }

        const pinEntryBtn = target.closest('[data-weg-pin-entry]');
        if (pinEntryBtn instanceof HTMLElement) {
            ev.stopPropagation();
            const uid = pinEntryBtn.getAttribute('data-weg-pin-entry') || '';
            if (uid) togglePinEntry(uid);
            return;
        }

        const entryToggle = target.closest('[data-weg-entry-toggle]');
        if (entryToggle instanceof HTMLElement) {
            ev.stopPropagation();
            const uid = entryToggle.getAttribute('data-weg-entry-toggle') || '';
            const nextEnabled = entryToggle.getAttribute('data-weg-next-enabled') === '1';
            void handleEntryToggle(uid, nextEnabled);
            return;
        }

        const entryMenuBtn = target.closest('[data-weg-entry-menu]');
        if (entryMenuBtn instanceof HTMLElement) {
            ev.stopPropagation();
            const uid = entryMenuBtn.getAttribute('data-weg-entry-menu') || '';
            openEntryActionsMenu(entryMenuBtn, uid);
            return;
        }

        const entryRow = target.closest('[data-weg-entry-row]');
        if (entryRow instanceof HTMLElement) {
            const uid = entryRow.getAttribute('data-weg-entry-row') || '';
            if (!uid) return;
            if (_batchMode) {
                if (_selectedUids.has(uid)) _selectedUids.delete(uid);
                else _selectedUids.add(uid);
                renderBodyAndFooterOnly();
                return;
            }
            if (!target.closest('button, input, select, a, .weg-switch, .weg-more-btn, .weg-pin-btn')) {
                void toggleAccordionEditor(uid);
            }
        }
    });

    footerEl?.addEventListener('click', (ev) => {
        const target = ev.target instanceof Element ? ev.target : null;
        if (!target) return;
        const actionBtn = target.closest('[data-weg-footer-action]');
        if (!(actionBtn instanceof HTMLElement) || actionBtn.hasAttribute('disabled')) return;

        const action = actionBtn.getAttribute('data-weg-footer-action');
        if (action === 'enter-batch') {
            _batchMode = true;
            _selectedUids.clear();
            renderBodyAndFooterOnly();
        } else if (action === 'exit-batch') {
            _batchMode = false;
            _selectedUids.clear();
            renderBodyAndFooterOnly();
        } else if (action === 'select-visible') {
            toggleSelectAllVisibleEntries();
        } else if (action === 'batch-move') {
            if (_selectedUids.size === 0) {
                showToast('info', '请先点击条目勾选要移动的项');
                return;
            }
            openBatchMoveSubmodal([..._selectedUids]);
        } else if (action === 'toggle-collapse-all') {
            toggleCollapseAllGroups();
        } else if (action === 'undo') {
            handleUndoLastGroupChange();
        }
    });

    if (_modalKeydownCleanup) {
        _modalKeydownCleanup();
        _modalKeydownCleanup = null;
    }
    const onModalKeydown = (ev) => {
        if (!_isOpen) return;
        const targetEl = ev.target instanceof Element ? ev.target : null;
        const accPanel = targetEl?.closest?.('.weg-acc-panel');
        const accUid = accPanel?.getAttribute('data-weg-acc-uid') || '';
        const accState = accUid ? _openEditors.get(accUid) : null;

        if (ev.isComposing || _isComposing || accState?.composing || ev.keyCode === 229) return;

        if (ev.key === 'Escape') {
            if (closeGroupedSelectControl(bookSelect)) {
                ev.stopPropagation();
                return;
            }
            if (_submodal) {
                ev.stopPropagation();
                closeSubmodal();
                return;
            }
            if (accUid && accState) {
                ev.stopPropagation();
                requestCollapseAccordionEditor(accUid);
            }
            return;
        }

        if (accUid && accState && !_submodal && (ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
            ev.preventDefault();
            void handleSaveAccordionEntry(accUid);
        }
    };
    modal.addEventListener('keydown', onModalKeydown);
    _modalKeydownCleanup = () => {
        modal.removeEventListener('keydown', onModalKeydown);
    };
}

export async function openEntryGroupsModal(opts = {}) {
    if (typeof document === 'undefined') return;
    const requestedBook = String(opts?.worldName ?? '').trim();

    if (_isOpen && _isMinimized) {
        restoreMinimizedModal();
        if (requestedBook && requestedBook !== _currentBook && getWorldNames().includes(requestedBook)) {
            const dirtyUids = getDirtyEditorUids();
            if (dirtyUids.length > 0) {
                _submodal = {
                    type: 'confirm-discard',
                    scope: 'modal',
                    nextAction: 'switch-book',
                    targetBook: requestedBook,
                    dirtyCount: dirtyUids.length,
                };
                renderSubmodalHost();
            } else {
                _batchMode = false;
                _selectedUids.clear();
                await loadBookIntoModal(requestedBook, { silent: false, preserveSelection: false });
            }
        }
        return;
    }

    const settings = getSettings();
    const backdrop = ensureModalShell();
    const modal = backdrop.querySelector('.weg-modal');
    _isMinimized = false;
    _minimizedScrollTop = 0;
    removeMinimizedPill();
    if (modal instanceof HTMLElement) {
        applyModalThemeAttributes(modal);
    }

    clearAllEditors();
    _visibleRenderLimit = INCREMENTAL_RENDER_STEP;
    _freezePinnedOrder = false;

    _isOpen = true;
    backdrop.hidden = false;
    if (modal instanceof HTMLElement && !_windowInteractCleanup) {
        _windowInteractCleanup = attachModalWindowControls(modal, modal.querySelector('[data-weg-drag-handle]'));
    }

    const names = getWorldNames();
    let targetBook = '';
    if (requestedBook && names.includes(requestedBook)) {
        targetBook = requestedBook;
    } else if (_currentBook && names.includes(_currentBook)) {
        targetBook = _currentBook;
    } else {
        targetBook = getPreferredDefaultBook(settings);
    }

    await loadBookIntoModal(targetBook, { silent: false, preserveSelection: false });

    if (!isNarrowViewport()) {
        const searchInput = backdrop.querySelector('#weg-search-input');
        if (searchInput instanceof HTMLInputElement) {
            requestAnimationFrame(() => {
                if (searchInput.isConnected && isDesktopAutoFocusAllowed()) searchInput.focus({ preventScroll: true });
            });
        }
    }
}

export function closeEntryGroupsModal() {
    closeFloatingMenu();
    removeMinimizedPill();
    _submodal = null;
    _isOpen = false;
    _isMinimized = false;
    _minimizedScrollTop = 0;
    _loadingBook = false;
    _loadError = '';
    _loadedSummaries = [];
    _greetingCharName = '';
    _greetingIndex = null;
    _batchMode = false;
    _selectedUids.clear();
    _visibleRenderLimit = INCREMENTAL_RENDER_STEP;
    _freezePinnedOrder = false;
    _sessionGroupOrder = [];
    clearAllEditors();

    if (typeof document !== 'undefined') {
        const backdrop = document.getElementById(MODAL_BACKDROP_ID);
        if (backdrop) {
            closeGroupedSelectControl(backdrop.querySelector('#weg-book-select'));
            backdrop.hidden = true;
            const bodyEl = backdrop.querySelector('#weg-body');
            if (bodyEl) bodyEl.innerHTML = '';
            const subHost = backdrop.querySelector('#weg-submodal-host');
            if (subHost instanceof HTMLElement) {
                subHost.hidden = true;
                subHost.innerHTML = '';
            }
        }
    }
}

export function teardownPanels() {
    closeEntryGroupsModal();
    if (_windowInteractCleanup) {
        _windowInteractCleanup();
        _windowInteractCleanup = null;
    }
    if (_modalKeydownCleanup) {
        _modalKeydownCleanup();
        _modalKeydownCleanup = null;
    }
    _undoStacks.clear();
    if (typeof document !== 'undefined') {
        document.getElementById(MODAL_BACKDROP_ID)?.remove();
        removeNativeEntryGroups();
    }
}

function toggleGroupCollapse(groupId) {
    if (!_currentBook) return;
    const settings = getSettings();
    const bookCfg = getBookConfigMutable(settings, _currentBook);

    if (groupId === SPECIAL_GROUP_UNGROUPED) {
        if (!bookCfg.groups.length) return;
        bookCfg.ungroupedCollapsed = !bookCfg.ungroupedCollapsed;
    } else {
        const grp = bookCfg.groups.find((g) => g.id === groupId);
        if (!grp) return;
        grp.collapsed = !grp.collapsed;
    }
    saveBookConfigWithCleanEmpty(settings, _currentBook, bookCfg);
    renderBodyAndFooterOnly();
}

function toggleCollapseAllGroups() {
    if (!_currentBook) return;
    const settings = getSettings();
    const bookCfg = getBookConfigMutable(settings, _currentBook);
    if (!bookCfg.groups.length) return;
    const allCollapsed = bookCfg.groups.every((g) => g.collapsed) && bookCfg.ungroupedCollapsed;
    const nextCollapsed = !allCollapsed;
    for (const g of bookCfg.groups) {
        g.collapsed = nextCollapsed;
    }
    bookCfg.ungroupedCollapsed = nextCollapsed;
    saveBookConfigWithCleanEmpty(settings, _currentBook, bookCfg);
    renderBodyAndFooterOnly();
}

function handleUndoLastGroupChange() {
    if (!_currentBook) return;
    const prev = popUndoSnapshot(_currentBook);
    if (!prev) return;
    const settings = getSettings();
    _freezePinnedOrder = false;
    saveBookConfigWithCleanEmpty(settings, _currentBook, prev);
    renderModalContents();
    showToast('info', '已撤销上一步分组操作');
}

async function handleGroupToggle(groupId, targetEnabled, { forceBindChat = false } = {}) {
    if (!_currentBook || _writingToggle || _loadingBook) return;
    const settings = getSettings();
    const bookCfg = getBookConfigMutable(settings, _currentBook);
    const plan = computeGroupTogglePlan(_loadedSummaries, bookCfg, groupId, targetEnabled);

    const targetBook = _currentBook;
    const grp = bookCfg.groups.find((g) => g.id === groupId);

    if (plan.size > 0) {
        _writingToggle = true;
        renderBodyAndFooterOnly();

        const res = await applyWorldbookTogglePlan(targetBook, plan);
        _writingToggle = false;

        if (!_isOpen || _currentBook !== targetBook) {
            if (_isOpen) {
                renderBodyAndFooterOnly();
            }
            return;
        }
        if (!res.ok) {
            showToast('error', res.error || '切换整组开关失败');
            renderBodyAndFooterOnly();
            return;
        }
        _loadedSummaries = res.summaries;
    }

    // Do NOT overwrite save route binding when manually toggling a transient `scene` (NSFW) group!
    let bound = null;
    if (grp?.mode !== GROUP_MODES.SCENE || forceBindChat) {
        bound = recordStateIntoActiveChatIfMatching(targetBook, _loadedSummaries, {
            preferredIfGroupId: grp?.mode === GROUP_MODES.IF_LINE && targetEnabled ? grp.id : '',
            customLabel: grp?.mode === GROUP_MODES.IF_LINE && targetEnabled ? grp.name : '',
            greetingIndex: _greetingIndex,
            force: forceBindChat,
        });
        syncAllNativeEntryPoints();
    }

    if (grp?.mode === GROUP_MODES.IF_LINE && targetEnabled) {
        showToast(
            'success',
            bound
                ? `已切换本档阶段至「${grp.name}」`
                : `已切换至「${grp.name}」，其余 IF 线已自动关闭`,
        );
    }
    renderModalContents();
}

async function handleEntryToggle(uid, targetEnabled) {
    if (!_currentBook || _writingToggle || _loadingBook) return;
    const settings = getSettings();
    const bookCfg = getBookConfigMutable(settings, _currentBook);
    const plan = computeEntryTogglePlan(_loadedSummaries, bookCfg, uid, targetEnabled);
    if (plan.size === 0) return;

    _writingToggle = true;
    renderBodyAndFooterOnly();

    const targetBook = _currentBook;
    const res = await applyWorldbookTogglePlan(targetBook, plan);
    _writingToggle = false;

    if (!_isOpen || _currentBook !== targetBook) {
        if (_isOpen) {
            renderBodyAndFooterOnly();
        }
        return;
    }
    if (!res.ok) {
        showToast('error', res.error || '切换条目状态失败');
        renderBodyAndFooterOnly();
        return;
    }

    _loadedSummaries = res.summaries;
    for (const [openUid, state] of _openEditors.entries()) {
        if (state && !state.dirty && state.initialSnapshot) {
            const matchSum = _loadedSummaries.find((s) => s.uid === openUid);
            if (matchSum && Boolean(state.initialSnapshot.enabled) !== !matchSum.disabled) {
                state.initialSnapshot.enabled = !matchSum.disabled;
                if (state.draft) state.draft.enabled = !matchSum.disabled;
                const panelEl = _mountedEditorEls.get(openUid);
                if (panelEl) applySnapshotToMountedForm(panelEl, state);
            }
        }
    }
    recordStateIntoActiveChatIfMatching(targetBook, _loadedSummaries, {
        greetingIndex: _greetingIndex,
    });
    syncAllNativeEntryPoints();

    renderModalContents();
}

function toggleSelectAllVisibleEntries() {
    const settings = getSettings();
    const bookCfg = _currentBook ? getBookConfigMutable(settings, _currentBook) : normalizeBookConfig(null);
    const matchedSet = matchEntries(_loadedSummaries, _searchQuery, {
        multiTerm: Boolean(settings.searchMultiTerm),
        statusFilter: _statusFilter,
        greetingByUid: _greetingIndex?.byUid || null,
        pinnedEntrySet: new Set(bookCfg.pinnedEntryUids),
        pinnedGroupSet: new Set(bookCfg.pinnedGroupIds),
        assignments: bookCfg.assignments,
    });
    toggleSelectedEntries([...matchedSet]);
}

function getGroupEntryUids(bookCfg, groupId) {
    return _loadedSummaries
        .filter((entry) => (bookCfg.assignments[entry.uid] || SPECIAL_GROUP_UNGROUPED) === groupId)
        .map((entry) => entry.uid);
}

function toggleSelectedEntries(uids) {
    if (!uids.length) return;
    _batchMode = true;
    const allSelected = uids.every((uid) => _selectedUids.has(uid));
    for (const uid of uids) {
        if (allSelected) _selectedUids.delete(uid);
        else _selectedUids.add(uid);
    }
    renderBodyAndFooterOnly();
}

function updateQuickFilterBar(backdrop, bookCfg) {
    if (!backdrop) return;
    const pinnedCount = countPinnedEntries(_loadedSummaries, bookCfg);
    const pinnedCountEl = backdrop.querySelector('#weg-filter-pinned-count');
    if (pinnedCountEl instanceof HTMLElement) {
        pinnedCountEl.textContent = `(${pinnedCount})`;
    }
    backdrop.querySelectorAll('#weg-quick-filters [data-weg-filter]').forEach((btn) => {
        if (!(btn instanceof HTMLElement)) return;
        const active = btn.getAttribute('data-weg-filter') === _statusFilter;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
}

function updateUndoButtonInPlace(backdrop) {
    const undoBtn = backdrop?.querySelector('[data-weg-footer-action="undo"]');
    if (!(undoBtn instanceof HTMLButtonElement)) return;
    const undoCount = getUndoCount(_currentBook);
    undoBtn.disabled = undoCount === 0;
    undoBtn.textContent = undoCount > 0 ? `撤销 (${undoCount})` : '撤销';
}

function updatePinButtonElement(btn, isPinned, itemKind) {
    if (!(btn instanceof HTMLElement)) return;
    const label = itemKind === 'group'
        ? (isPinned ? '取消置顶分组' : '置顶分组')
        : (isPinned ? '取消置顶条目' : '置顶条目');
    btn.classList.toggle('is-pinned', isPinned);
    btn.setAttribute('aria-pressed', isPinned ? 'true' : 'false');
    btn.setAttribute('aria-label', label);
    btn.setAttribute('title', label);
    const icon = btn.querySelector('i');
    if (icon instanceof HTMLElement) {
        icon.classList.toggle('fa-solid', isPinned);
        icon.classList.toggle('fa-regular', !isPinned);
    }
}

function togglePinGroup(groupId) {
    if (!_currentBook || _loadingBook) return;
    const settings = getSettings();
    const bookCfg = getBookConfigMutable(settings, _currentBook);
    const snapshot = cloneBookConfig(bookCfg);
    const res = setGroupPinned(bookCfg, groupId);
    if (!res.changed) return;

    pushUndoSnapshot(_currentBook, snapshot);
    _freezePinnedOrder = true;
    saveBookConfigWithCleanEmpty(settings, _currentBook, bookCfg);

    const backdrop = typeof document !== 'undefined' ? document.getElementById(MODAL_BACKDROP_ID) : null;
    if (backdrop) {
        const card = backdrop.querySelector(`.weg-group-card[data-weg-group-card="${cssEsc(groupId)}"]`);
        if (card instanceof HTMLElement) {
            card.classList.toggle('is-pinned', res.pinned);
            const pinBtn = card.querySelector(`[data-weg-pin-group="${cssEsc(groupId)}"]`);
            updatePinButtonElement(pinBtn, res.pinned, 'group');
        }
        updateQuickFilterBar(backdrop, bookCfg);
        updateUndoButtonInPlace(backdrop);
    }

    showToast('info', res.pinned ? '已置顶该分组' : '已取消置顶分组');
}

function togglePinEntry(uid) {
    if (!_currentBook || _loadingBook) return;
    const settings = getSettings();
    const bookCfg = getBookConfigMutable(settings, _currentBook);
    const snapshot = cloneBookConfig(bookCfg);
    const res = setEntryPinned(bookCfg, uid);
    if (!res.changed) return;

    pushUndoSnapshot(_currentBook, snapshot);
    saveBookConfigWithCleanEmpty(settings, _currentBook, bookCfg);

    const backdrop = typeof document !== 'undefined' ? document.getElementById(MODAL_BACKDROP_ID) : null;
    if (_statusFilter === 'pinned') {
        renderBodyAndFooterOnly();
    } else if (backdrop) {
        const row = backdrop.querySelector(`.weg-entry-row[data-weg-entry-row="${cssEsc(uid)}"]`);
        if (row instanceof HTMLElement) {
            row.classList.toggle('is-pinned', res.pinned);
            const pinBtn = row.querySelector(`[data-weg-pin-entry="${cssEsc(uid)}"]`);
            updatePinButtonElement(pinBtn, res.pinned, 'entry');
        }
        updateQuickFilterBar(backdrop, bookCfg);
        updateUndoButtonInPlace(backdrop);
    }

    showToast('info', res.pinned ? '已置顶该条目' : '已取消置顶条目');
}

function openGroupActionsMenu(anchorEl, groupId) {
    if (!_currentBook) return;
    const settings = getSettings();
    const bookCfg = getBookConfigMutable(settings, _currentBook);

    if (groupId === SPECIAL_GROUP_UNGROUPED) {
        const ungroupedUids = getGroupEntryUids(bookCfg, groupId);

        openFloatingMenu(anchorEl, [
            {
                label: ungroupedUids.length && ungroupedUids.every((uid) => _selectedUids.has(uid)) ? '取消勾选未分组条目' : '全选未分组条目',
                icon: 'fa-check-double',
                disabled: ungroupedUids.length === 0,
                onClick: () => toggleSelectedEntries(ungroupedUids),
            },
            {
                label: '自动识别未分组条目',
                icon: 'fa-wand-magic-sparkles',
                disabled: ungroupedUids.length === 0,
                onClick: () => {
                    void openAutoDetectSubmodal();
                },
            },
        ]);
        return;
    }

    const idx = bookCfg.groups.findIndex((g) => g.id === groupId);
    const grp = idx >= 0 ? bookCfg.groups[idx] : null;
    if (!grp) return;

    const groupUids = _loadedSummaries
        .filter((e) => bookCfg.assignments[e.uid] === groupId)
        .map((e) => e.uid);

    const isGroupPinned = Array.isArray(bookCfg.pinnedGroupIds) && bookCfg.pinnedGroupIds.includes(groupId);
    const { saveCtx } = getActiveChatBoundProfile(_currentBook);
    const isCurrentChatBook = Boolean(saveCtx && saveCtx.primaryWorldName === _currentBook);

    openFloatingMenu(anchorEl, [
        ...(isCurrentChatBook && grp.mode !== GROUP_MODES.SCENE ? [{
            label: '切换到此线并记为本档当前阶段',
            icon: 'fa-bookmark',
            disabled: groupUids.length === 0,
            onClick: () => {
                if (grp.mode === GROUP_MODES.NORMAL) {
                    grp.mode = GROUP_MODES.IF_LINE;
                    saveBookConfigWithCleanEmpty(settings, _currentBook, bookCfg);
                }
                void handleGroupToggle(groupId, true, { forceBindChat: true });
            },
        }] : []),
        {
            label: isGroupPinned ? '取消置顶分组' : '置顶分组',
            icon: 'fa-star',
            onClick: () => togglePinGroup(groupId),
        },
        {
            label: '编辑名称、模式与触发词',
            icon: 'fa-pen',
            onClick: () => openGroupFormSubmodal(grp),
        },
        {
            label: grp.mode === GROUP_MODES.IF_LINE ? '改回普通组' : '设为 IF 线互斥组',
            icon: 'fa-code-branch',
            onClick: () => {
                pushUndoSnapshot(_currentBook, bookCfg);
                grp.mode = grp.mode === GROUP_MODES.IF_LINE ? GROUP_MODES.NORMAL : GROUP_MODES.IF_LINE;
                saveBookConfigWithCleanEmpty(settings, _currentBook, bookCfg);
                renderModalContents();
            },
        },
        {
            label: grp.mode === GROUP_MODES.SCENE ? '取消情境按需（改为普通组）' : '设为情境按需组（如 NSFW）',
            icon: 'fa-bolt',
            onClick: () => {
                pushUndoSnapshot(_currentBook, bookCfg);
                grp.mode = grp.mode === GROUP_MODES.SCENE ? GROUP_MODES.NORMAL : GROUP_MODES.SCENE;
                saveBookConfigWithCleanEmpty(settings, _currentBook, bookCfg);
                renderModalContents();
                showToast('info', grp.mode === GROUP_MODES.SCENE
                    ? `已将「${grp.name}」设为情境按需组（日常关 / 触发自动开）`
                    : `已将「${grp.name}」改回普通组`);
            },
        },
        {
            label: groupUids.length && groupUids.every((uid) => _selectedUids.has(uid)) ? '取消勾选本组条目' : '全选本组条目',
            icon: 'fa-check-double',
            disabled: groupUids.length === 0,
            onClick: () => toggleSelectedEntries(groupUids),
        },
        {
            label: '复制开场白联动标签',
            icon: 'fa-copy',
            disabled: groupUids.length === 0,
            onClick: async () => {
                const tag = formatGreetingCommentTag(groupUids, 'lore');
                if (!tag) {
                    showToast('warning', '本组没有可导出数字 UID 的条目');
                    return;
                }
                const ok = await copyTextToClipboard(tag);
                showToast(ok ? 'success' : 'warning', ok
                    ? `已复制：${tag}`
                    : `请手动复制：${tag}`);
            },
        },
        {
            label: '上移分组',
            icon: 'fa-arrow-up',
            disabled: idx <= 0,
            onClick: () => {
                pushUndoSnapshot(_currentBook, bookCfg);
                const [item] = bookCfg.groups.splice(idx, 1);
                bookCfg.groups.splice(idx - 1, 0, item);
                saveBookConfigWithCleanEmpty(settings, _currentBook, bookCfg);
                renderBodyAndFooterOnly();
            },
        },
        {
            label: '下移分组',
            icon: 'fa-arrow-down',
            disabled: idx >= bookCfg.groups.length - 1,
            onClick: () => {
                pushUndoSnapshot(_currentBook, bookCfg);
                const [item] = bookCfg.groups.splice(idx, 1);
                bookCfg.groups.splice(idx + 1, 0, item);
                saveBookConfigWithCleanEmpty(settings, _currentBook, bookCfg);
                renderBodyAndFooterOnly();
            },
        },
        {
            label: '解散分组（条目退回未分组）',
            icon: 'fa-folder-minus',
            danger: true,
            onClick: () => {
                pushUndoSnapshot(_currentBook, bookCfg);
                removeGroupFromBookConfig(bookCfg, groupId);
                saveBookConfigWithCleanEmpty(settings, _currentBook, bookCfg);
                renderModalContents();
                showToast('info', `已解散分组「${grp.name}」，可随时点底部撤销恢复`);
            },
        },
    ]);
}

function openEntryActionsMenu(anchorEl, uid) {
    if (!_currentBook) return;
    const entry = _loadedSummaries.find((e) => e.uid === uid);
    if (!entry) return;

    const settings = getSettings();
    const bookCfg = getBookConfigMutable(settings, _currentBook);
    const currentGroupId = bookCfg.assignments[uid] || SPECIAL_GROUP_UNGROUPED;
    const isEntryPinned = Array.isArray(bookCfg.pinnedEntryUids) && bookCfg.pinnedEntryUids.includes(uid);

    const isExpanded = _openEditors.has(uid);

    openFloatingMenu(anchorEl, [
        {
            label: isExpanded ? '收起编辑框' : '编辑条目',
            icon: 'fa-pen-to-square',
            onClick: () => {
                void toggleAccordionEditor(uid);
            },
        },
        {
            label: isEntryPinned ? '取消置顶' : '置顶条目',
            icon: 'fa-star',
            onClick: () => togglePinEntry(uid),
        },
        {
            label: '在酒馆原生编辑器中定位',
            icon: 'fa-location-crosshairs',
            onClick: () => {
                if (_openEditors.get(uid)?.dirty) requestLocateFromAccordion(uid);
                else executeLocateForEntry(_currentBook, entry.uid, entry.rawComment || entry.keys?.[0] || '');
            },
        },
        {
            label: '移入其他分组…',
            icon: 'fa-folder-tree',
            onClick: () => openBatchMoveSubmodal([uid]),
        },
        ...(currentGroupId !== SPECIAL_GROUP_UNGROUPED ? [{
            label: '移回未分组',
            icon: 'fa-rotate-left',
            onClick: () => {
                pushUndoSnapshot(_currentBook, bookCfg);
                delete bookCfg.assignments[uid];
                saveBookConfigWithCleanEmpty(settings, _currentBook, bookCfg);
                renderBodyAndFooterOnly();
            },
        }] : []),
        {
            label: '复制条目联动注释',
            icon: 'fa-copy',
            onClick: async () => {
                const tag = formatGreetingCommentTag([uid], 'lore');
                if (!tag) return;
                const ok = await copyTextToClipboard(tag);
                if (ok) showToast('success', `已复制：${tag}`);
            },
        },
    ]);
}

function renderModalContents() {
    if (!_isOpen || typeof document === 'undefined') return;
    const backdrop = document.getElementById(MODAL_BACKDROP_ID);
    if (!backdrop) return;

    const modal = backdrop.querySelector('.weg-modal');
    if (modal instanceof HTMLElement) {
        applyModalThemeAttributes(modal);
    }

    const bookSelect = backdrop.querySelector('#weg-book-select');
    if (bookSelect instanceof HTMLSelectElement) {
        const names = getWorldNames();
        if (names.length === 0) {
            bookSelect.innerHTML = '<option value="">暂无可用世界书</option>';
            bookSelect.disabled = true;
        } else {
            bookSelect.disabled = false;
            bookSelect.innerHTML = names
                .map((n) => `<option value="${esc(n)}"${n === _currentBook ? ' selected' : ''}>${esc(n)}</option>`)
                .join('');
        }
        attachGroupedSelectControl(bookSelect, { collapseCharByDefault: false });
    }

    renderBodyAndFooterOnly();
    renderSubmodalHost();
}

function renderSaveBindingBar(saveBarEl) {
    if (!(saveBarEl instanceof HTMLElement)) return;

    const presetGreets = _greetingIndex?.presetGreetings || [];
    const presetSelectHtml = presetGreets.length > 0 ? `
        <select class="weg-mini-select" id="weg-preset-greeting-select" aria-label="套用开场白联动方案" ${_writingToggle ? 'disabled' : ''}>
            <option value="">套用开场方案 (${presetGreets.length})…</option>
            ${presetGreets.map((g) => `<option value="${g.swipeIndex}">${esc(g.title ? `${g.label} ${g.title}` : `开场白 ${g.label}`)}（${g.loreUids.length}条）</option>`).join('')}
        </select>
    ` : '';

    const { saveCtx, profile } = getActiveChatBoundProfile(_currentBook);
    if (!saveCtx) {
        saveBarEl.innerHTML = `
            <span class="weg-save-bar-text is-muted">当前未进入聊天存档（进入对话后，切换路线或脚本改书会自动记住本档阶段）</span>
            ${presetSelectHtml ? `<div class="weg-save-bar-actions">${presetSelectHtml}</div>` : ''}
        `;
        return;
    }

    if (saveCtx.primaryWorldName !== _currentBook) {
        const hint = saveCtx.primaryWorldName
            ? `当前聊天角色主书为「${saveCtx.primaryWorldName}」，切回该书可管理本档路线`
            : '当前聊天角色尚未绑定主世界书';
        saveBarEl.innerHTML = `
            <span class="weg-save-bar-text is-muted">${esc(hint)}</span>
            ${presetSelectHtml ? `<div class="weg-save-bar-actions">${presetSelectHtml}</div>` : ''}
        `;
        return;
    }

    const shortChatId = saveCtx.chatId.length > 20 ? `${saveCtx.chatId.slice(0, 20)}…` : saveCtx.chatId;

    if (profile) {
        saveBarEl.innerHTML = `
            <div class="weg-save-bar-info" title="仅存储于当前存档元数据，不扫描聊天记录；本档用面板或角色卡脚本切线都会自动同步更新">
                <i class="fa-solid fa-bookmark weg-save-icon is-bound" aria-hidden="true"></i>
                <span class="weg-save-bar-text">本档当前阶段：<strong>${esc(profile.routeLabel)}</strong> <span class="weg-save-chatid">(${esc(shortChatId)})</span></span>
            </div>
            <div class="weg-save-bar-actions">
                ${presetSelectHtml}
                <button type="button" class="weg-mini-btn" data-weg-save-action="bind-current" title="将当前开关组合更新为本档记忆">更新本档</button>
                <button type="button" class="weg-mini-btn is-muted" data-weg-save-action="unbind-current" title="解除本存档绑定">解除</button>
            </div>
        `;
    } else {
        saveBarEl.innerHTML = `
            <div class="weg-save-bar-info" title="聊天存档：${esc(saveCtx.chatId)}">
                <i class="fa-regular fa-bookmark weg-save-icon" aria-hidden="true"></i>
                <span class="weg-save-bar-text is-muted">当前存档（${esc(shortChatId)}）暂未锁线，切换路线、套用方案或点右侧即可记住</span>
            </div>
            <div class="weg-save-bar-actions">
                ${presetSelectHtml}
                <button type="button" class="weg-mini-btn is-primary" data-weg-save-action="bind-current" ${_loadedSummaries.length === 0 ? 'disabled' : ''}>锁定本档</button>
            </div>
        `;
    }
}

function applySessionOrderToGroupedView(grouped) {
    if (!grouped || !Array.isArray(grouped.sections)) return grouped;
    const groupOrderMap = new Map(_sessionGroupOrder.map((id, idx) => [id, idx]));

    const orderedSections = [...grouped.sections].sort((a, b) => {
        if (a.isUngrouped && !b.isUngrouped) return 1;
        if (!a.isUngrouped && b.isUngrouped) return -1;
        const ia = groupOrderMap.has(a.id) ? groupOrderMap.get(a.id) : Number.MAX_SAFE_INTEGER;
        const ib = groupOrderMap.has(b.id) ? groupOrderMap.get(b.id) : Number.MAX_SAFE_INTEGER;
        return ia - ib;
    });

    return { ...grouped, sections: orderedSections };
}

function renderBodyAndFooterOnly() {
    if (!_isOpen || typeof document === 'undefined') return;
    const backdrop = document.getElementById(MODAL_BACKDROP_ID);
    if (!backdrop) return;

    const statsEl = backdrop.querySelector('#weg-header-stats');
    const saveBarEl = backdrop.querySelector('#weg-save-bar');
    const bodyEl = backdrop.querySelector('#weg-body');
    const footerEl = backdrop.querySelector('#weg-footer');
    if (!(bodyEl instanceof HTMLElement) || !(footerEl instanceof HTMLElement)) return;

    const prevScrollTop = bodyEl.scrollTop;
    const settings = getSettings();
    const bookCfg = _currentBook ? getBookConfigMutable(settings, _currentBook) : normalizeBookConfig(null);

    // Detach live mounted accordion panels before rebuilding list HTML so cursor/undo/focus stay intact
    for (const [uid, panelEl] of [..._mountedEditorEls.entries()]) {
        panelEl.remove();
        if (!_openEditors.has(uid)) {
            _mountedEditorEls.delete(uid);
        }
    }

    let grouped = buildGroupedView(_loadedSummaries, bookCfg, { sortPinned: !_freezePinnedOrder, sortPinnedEntries: false });
    if (_freezePinnedOrder) {
        grouped = applySessionOrderToGroupedView(grouped);
    } else {
        _sessionGroupOrder = grouped.sections.map((s) => s.id);
    }

    updateQuickFilterBar(backdrop, bookCfg);
    renderSaveBindingBar(saveBarEl);

    if (statsEl instanceof HTMLElement) {
        if (!_currentBook) {
            statsEl.textContent = '';
        } else if (_loadingBook) {
            statsEl.textContent = '正在读取…';
        } else {
            statsEl.textContent = `已开 ${grouped.totalEnabled} / ${grouped.totalEntries} 条`;
        }
    }

    const orphanedDrafts = (_currentBook && !_loadingBook && !_loadError)
        ? collectOrphanedOpenDrafts(_openEditors, _loadedSummaries, _currentBook)
        : [];
    for (const item of orphanedDrafts) {
        const st = _openEditors.get(item.uid);
        if (st) {
            st.externalDeleted = true;
            st.externalStale = true;
        }
    }
    const deletedDraftsHtml = orphanedDrafts.length > 0 ? `
        <div class="weg-deleted-drafts-wrap" id="weg-deleted-drafts-wrap">
            ${orphanedDrafts.map((item) => {
                const titleSuffix = item.title ? `（${item.title}）` : '';
                return `
                    <section class="weg-deleted-draft-card" data-weg-deleted-uid="${esc(item.uid)}">
                        <div class="weg-deleted-draft-head">
                            <div class="weg-deleted-draft-msg">
                                <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
                                <span>条目 #${esc(item.uid)}${esc(titleSuffix)} 已被其他操作删除，已保留你的未保存草稿</span>
                            </div>
                            <div class="weg-deleted-draft-actions">
                                <button type="button" class="weg-mini-btn" data-weg-deleted-action="copy" data-weg-deleted-uid="${esc(item.uid)}">复制草稿</button>
                                <button type="button" class="weg-mini-btn is-danger" data-weg-deleted-action="discard" data-weg-deleted-uid="${esc(item.uid)}">放弃此草稿</button>
                            </div>
                        </div>
                        <div class="weg-acc-slot" data-weg-acc-slot="${esc(item.uid)}"></div>
                    </section>
                `;
            }).join('')}
        </div>
    ` : '';

    if (!_currentBook) {
        bodyEl.innerHTML = `
            <div class="weg-empty-state">
                <p class="weg-empty-title">当前还没有可管理的世界书</p>
                <p class="weg-empty-desc">先在酒馆导入或创建世界书后，即可在这里按分组、IF 线或情境管理条目开关。</p>
            </div>
        `;
    } else if (_loadingBook) {
        bodyEl.innerHTML = `
            <div class="weg-empty-state">
                <p class="weg-empty-title">正在读取「${esc(_currentBook)}」…</p>
                <p class="weg-empty-desc">采用不占宿主缓存的轻量直读方式，仅加载条目摘要。</p>
            </div>
        `;
    } else if (_loadError) {
        bodyEl.innerHTML = `
            <div class="weg-empty-state">
                <p class="weg-empty-title">${esc(_loadError)}</p>
                <p class="weg-empty-desc">请点击上方刷新按钮重试，或检查该世界书文件是否仍存在。</p>
            </div>
        `;
    } else {
        if (_loadedSummaries.length === 0) {
            bodyEl.innerHTML = `${deletedDraftsHtml}
                <div class="weg-empty-state">
                    <p class="weg-empty-title">「${esc(_currentBook)}」里还没有条目</p>
                    <p class="weg-empty-desc">在酒馆原生世界书编辑器添加条目后，点击上方刷新即可开始分组。</p>
                </div>
            `;
        } else {
            const pinnedEntrySet = new Set(grouped.pinnedEntryUids || []);
            const pinnedGroupSet = new Set(grouped.pinnedGroupIds || []);
            const matchedUidSet = matchEntries(_loadedSummaries, _searchQuery, {
                multiTerm: Boolean(settings.searchMultiTerm),
                statusFilter: _statusFilter,
                greetingByUid: _greetingIndex?.byUid || null,
                pinnedEntrySet,
                pinnedGroupSet,
                assignments: bookCfg.assignments,
            });
            const isFiltering = Boolean(_searchQuery.trim()) || _statusFilter !== 'all';

            const conflictNoticeHtml = grouped.ifLineSummary.hasConflict ? `
                <div class="weg-inline-notice">
                    <span>当前有 ${grouped.ifLineSummary.activeGroupNames.length} 条 IF 线同时存在开启条目（${esc(grouped.ifLineSummary.activeGroupNames.join('、'))}）。开启任意一条 IF 线组将自动收起其余线。</span>
                </div>
            ` : '';

            const candidateSections = [];
            for (const sec of grouped.sections) {
                if (sec.isUngrouped && sec.totalCount === 0 && grouped.sections.length > 1) {
                    continue;
                }
                const visibleEntries = isFiltering
                    ? sec.entries.filter((e) => matchedUidSet.has(e.uid))
                    : sec.entries;
                if (isFiltering && visibleEntries.length === 0) {
                    continue;
                }
                const canCollapse = !sec.isUngrouped || bookCfg.groups.length > 0;
                candidateSections.push({
                    ...sec,
                    visibleEntries,
                    canCollapse,
                    effectiveCollapsed: canCollapse && !isFiltering && sec.collapsed,
                });
            }

            const sliced = sliceGroupedSectionsForRender(candidateSections, {
                limit: _visibleRenderLimit,
                alwaysIncludeUids: new Set(_openEditors.keys()),
                isFiltering,
            });

            const sectionsHtml = [];
            for (const sec of sliced.sections) {
                if (!sec.effectiveCollapsed && sec.renderedEntries.length === 0 && sec.visibleEntries.length > 0) {
                    continue;
                }

                let modeBadge = '';
                if (sec.mode === GROUP_MODES.IF_LINE) {
                    modeBadge = '<span class="weg-badge weg-badge-if" title="开启本组时自动关闭本书其他 IF 线组，并更新本档当前阶段">IF 互斥</span>';
                } else if (sec.mode === GROUP_MODES.SCENE) {
                    const sceneAutoOn = settings.enableSceneAutoToggle !== false;
                    modeBadge = `<span class="weg-badge weg-badge-scene" title="${sceneAutoOn ? '日常自动关闭，最近对话出现触发词时当轮自动开启' : '情境自动开关已在设置中关闭，当前仅手动控制'}">情境按需</span>`;
                } else if (sec.mode === GROUP_MODES.RADIO) {
                    modeBadge = '<span class="weg-badge weg-badge-radio" title="开启本组任意一条时，自动关闭本组其余条目">组内单选</span>';
                }

                const hasCollapsedDirty = sec.effectiveCollapsed
                    && sec.entries.some((e) => Boolean(_openEditors.get(e.uid)?.dirty));
                const dirtyBadgeHtml = hasCollapsedDirty
                    ? '<span class="weg-badge weg-badge-dirty" title="该折叠分组内存在未保存的内联编辑草稿">未保存</span>'
                    : '';

                const switchOn = sec.mode === GROUP_MODES.RADIO ? sec.enabledCount > 0 : sec.allEnabled;
                const switchPartial = !switchOn && sec.someEnabled;
                const nextGroupEnabled = switchOn ? '0' : '1';

                let rowsHtml = '';
                if (!sec.effectiveCollapsed) {
                    if (sec.visibleEntries.length === 0) {
                        rowsHtml = `<div class="weg-group-empty">暂无条目，可通过底部「多选移组」或条目菜单移入</div>`;
                    } else {
                        rowsHtml = `<div class="weg-entry-list">${sec.renderedEntries.map((entry) => renderEntryItemHtml(entry, pinnedEntrySet.has(entry.uid))).join('')}</div>`;
                    }
                }

                const pinGroupBtnHtml = sec.isUngrouped
                    ? ''
                    : `<button
                        type="button"
                        class="weg-pin-btn${sec.pinned ? ' is-pinned' : ''}"
                        data-weg-pin-group="${esc(sec.id)}"
                        aria-pressed="${sec.pinned ? 'true' : 'false'}"
                        aria-label="${sec.pinned ? '取消置顶分组' : '置顶分组'}"
                        title="${sec.pinned ? '取消置顶分组' : '置顶分组'}"
                    ><i class="fa-${sec.pinned ? 'solid' : 'regular'} fa-star" aria-hidden="true"></i></button>`;

                const selectedCount = _batchMode ? sec.entries.filter((entry) => _selectedUids.has(entry.uid)).length : 0;
                const allSelected = selectedCount > 0 && selectedCount === sec.totalCount;
                const batchCheckHtml = _batchMode ? `<input type="checkbox" class="weg-group-batch-check"
                    data-weg-group-batch="${esc(sec.id)}" aria-label="${allSelected ? '取消全选' : '全选'} ${esc(sec.name)}的全部条目"
                    ${allSelected ? 'checked' : ''} ${selectedCount && !allSelected ? 'data-weg-group-mixed' : ''} ${sec.totalCount === 0 ? 'disabled' : ''}>` : '';
                sectionsHtml.push(`
                    <section class="weg-group-card${sec.mode === GROUP_MODES.IF_LINE && sec.enabledCount > 0 ? ' is-active-if' : ''}${sec.pinned ? ' is-pinned' : ''}" data-weg-group-card="${esc(sec.id)}">
                        <div class="weg-group-header"${sec.canCollapse ? ` data-weg-group-header="${esc(sec.id)}"` : ''}>
                            <div class="weg-group-header-main">
                                ${batchCheckHtml}
                                <i class="fa-solid ${sec.canCollapse ? `fa-chevron-${sec.effectiveCollapsed ? 'right' : 'down'}` : 'fa-list-ul'} weg-chevron" aria-hidden="true"></i>
                                <span class="weg-group-name">${esc(sec.name)}</span>
                                ${modeBadge}
                                ${dirtyBadgeHtml}
                                <span class="weg-group-count">${sec.enabledCount}/${sec.totalCount}</span>
                            </div>
                            <div class="weg-row-controls">
                                <button
                                    type="button"
                                    class="weg-switch${switchOn ? ' is-on' : ''}${switchPartial ? ' is-partial' : ''}"
                                    role="switch"
                                    aria-checked="${switchOn ? 'true' : 'false'}"
                                    aria-label="切换分组 ${esc(sec.name)}"
                                    data-weg-group-toggle="${esc(sec.id)}"
                                    data-weg-next-enabled="${nextGroupEnabled}"
                                    ${sec.totalCount === 0 || _writingToggle ? 'disabled' : ''}
                                >
                                    <span class="weg-switch-thumb"></span>
                                </button>
                                <button
                                    type="button"
                                    class="weg-more-btn"
                                    aria-label="分组操作菜单"
                                    data-weg-group-menu="${esc(sec.id)}"
                                >···</button>
                                ${pinGroupBtnHtml}
                            </div>
                        </div>
                        ${rowsHtml}
                    </section>
                `);
            }

            const loadMoreHtml = sliced.hiddenCount > 0 ? `
                <div class="weg-load-more-bar" id="weg-load-more-bar">
                    <span class="weg-load-more-info">已显示 ${sliced.shownCount} / ${sliced.totalCount} 条（还有 ${sliced.hiddenCount} 条未展开）</span>
                    <div class="weg-load-more-actions">
                        <button type="button" class="weg-btn weg-btn-subtle" id="weg-btn-load-more-60">继续加载 ${Math.min(INCREMENTAL_RENDER_STEP, sliced.hiddenCount)} 条</button>
                        <button type="button" class="weg-btn weg-btn-subtle" id="weg-btn-load-all">展开全部（剩余 ${sliced.hiddenCount} 条）</button>
                    </div>
                </div>
            ` : '';

            if (sectionsHtml.length === 0) {
                const emptyDesc = _statusFilter === 'pinned'
                    ? '点击分组或条目右侧的星标按钮即可置顶常用项。'
                    : '尝试清空搜索词或切回「全部」筛选。';
                bodyEl.innerHTML = `${conflictNoticeHtml}${deletedDraftsHtml}
                    <div class="weg-empty-state">
                        <p class="weg-empty-title">没有匹配的条目</p>
                        <p class="weg-empty-desc">${esc(emptyDesc)}</p>
                    </div>
                `;
            } else {
                bodyEl.innerHTML = `${conflictNoticeHtml}${deletedDraftsHtml}${sectionsHtml.join('')}${loadMoreHtml}`;
            }
        }

        // Re-attach live accordion editor DOM nodes or rehydrate dirty drafts for re-expanded groups & deleted-entry cards
        for (const [uid, state] of [..._openEditors.entries()]) {
            const slot = bodyEl.querySelector(`[data-weg-acc-slot="${cssEsc(uid)}"]`);
            const row = bodyEl.querySelector(`[data-weg-entry-row="${cssEsc(uid)}"]`);
            if (slot instanceof HTMLElement) {
                if (row instanceof HTMLElement) row.classList.add('is-expanded');
                if (_mountedEditorEls.has(uid)) {
                    const existingPanel = _mountedEditorEls.get(uid);
                    slot.appendChild(existingPanel);
                    syncAccordionPanelPreferences(existingPanel);
                    updateAccordionPanelChrome(existingPanel, state);
                } else {
                    const panelEl = createAccordionPanelShell(uid);
                    _mountedEditorEls.set(uid, panelEl);
                    slot.appendChild(panelEl);
                    if (state.loading) {
                        renderAccordionLoadingState(panelEl, uid);
                    } else if (state.error) {
                        renderAccordionErrorState(panelEl, uid, state.error);
                    } else {
                        mountAccordionFormIntoPanel(panelEl, state, { hydrateFromDraft: true });
                    }
                }
            } else {
                const detachedPanel = _mountedEditorEls.get(uid);
                if (detachedPanel) {
                    detachedPanel.remove();
                    _mountedEditorEls.delete(uid);
                }
                if (!state.dirty && !state.externalDeleted) {
                    _openEditors.delete(uid);
                }
            }
        }
    }

    for (const check of bodyEl.querySelectorAll('[data-weg-group-mixed]')) check.indeterminate = true;
    bodyEl.scrollTop = prevScrollTop;

    const undoCount = getUndoCount(_currentBook);
    const allGroupsCollapsed = bookCfg.groups.every((g) => g.collapsed) && bookCfg.ungroupedCollapsed;

    if (_batchMode) {
        footerEl.innerHTML = `
            <div class="weg-footer-status">已选 <strong>${_selectedUids.size}</strong> 条（点击条目行可直接勾选）</div>
            <div class="weg-footer-buttons">
                <button type="button" class="weg-btn weg-btn-subtle" data-weg-footer-action="select-visible">全选当前</button>
                <button type="button" class="weg-btn weg-btn-primary" data-weg-footer-action="batch-move" ${_selectedUids.size === 0 ? 'disabled' : ''}>移入分组…</button>
                <button type="button" class="weg-btn weg-btn-subtle" data-weg-footer-action="exit-batch">完成</button>
            </div>
        `;
    } else {
        const customGroupCount = bookCfg.groups.length;
        const openCount = _openEditors.size;
        const statusText = _writingToggle
            ? '正在单次合并保存世界书…'
            : (_currentBook
                ? (openCount > 0 ? `共 ${customGroupCount} 个自定义分组 · 已展开 ${openCount} 条编辑` : `共 ${customGroupCount} 个自定义分组`)
                : '未选择世界书');
        footerEl.innerHTML = `
            <div class="weg-footer-status">${esc(statusText)}</div>
            <div class="weg-footer-buttons">
                <button type="button" class="weg-btn weg-btn-subtle" data-weg-footer-action="enter-batch" ${_loadedSummaries.length === 0 ? 'disabled' : ''}>多选移组</button>
                ${customGroupCount ? `<button type="button" class="weg-btn weg-btn-subtle" data-weg-footer-action="toggle-collapse-all" ${_loadedSummaries.length === 0 ? 'disabled' : ''}>${allGroupsCollapsed ? '全部展开' : '全部折叠'}</button>` : ''}
                <button type="button" class="weg-btn weg-btn-subtle" data-weg-footer-action="undo" ${undoCount === 0 ? 'disabled' : ''}>撤销${undoCount > 0 ? ` (${undoCount})` : ''}</button>
            </div>
        `;
    }
}

function buildEntryRowInnerHtml(entry, isPinned = false) {
    const isEnabled = !entry.disabled;
    const isSelected = _selectedUids.has(entry.uid);

    let dotClass = 'is-normal';
    let dotTitle = '关键词触发条目';
    if (entry.constant) {
        dotClass = 'is-constant';
        dotTitle = '常驻条目（蓝灯）';
    } else if (entry.vectorized) {
        dotClass = 'is-vector';
        dotTitle = '向量触发条目';
    }

    let greetingBadgeHtml = '';
    const greetMeta = _greetingIndex?.byUid?.get?.(entry.uid);
    if (greetMeta) {
        const incList = greetMeta.includeGreetings;
        const excList = greetMeta.excludeGreetings;
        if (incList.length > 0) {
            const first = incList[0];
            const shortText = incList.length === 1
                ? (first.title ? `${first.label} ${first.title.slice(0, 8)}` : `开场白 ${first.label}`)
                : `开场白 ×${incList.length}`;
            const fullTip = `关联开场白注释（开启于：${incList.map((g) => (g.title ? `${g.label} ${g.title}` : g.label)).join('、')}）`;
            greetingBadgeHtml = `<span class="weg-greet-tag" title="${esc(fullTip)}">${esc(shortText)}</span>`;
        } else if (excList.length > 0) {
            const fullTip = `在开场白 ${excList.map((g) => (g.title ? `${g.label} ${g.title}` : g.label)).join('、')} 中自动排除关闭`;
            greetingBadgeHtml = `<span class="weg-greet-tag is-exclude" title="${esc(fullTip)}">排除联动</span>`;
        }
    }

    const keysPreview = entry.keys.length > 0 ? `触发词：${entry.keys.join('、')}` : '无触发词';
    const rowTooltip = `[#${entry.uid}] ${entry.title}\n${keysPreview}`;

    const batchCheckboxHtml = _batchMode
        ? `<span class="weg-checkbox${isSelected ? ' is-checked' : ''}" aria-hidden="true">${isSelected ? '✓' : ''}</span>`
        : '';

    return `
        <div class="weg-entry-main" title="${esc(rowTooltip)}">
            ${batchCheckboxHtml}
            <span class="weg-strategy-dot ${dotClass}" title="${esc(dotTitle)}"></span>
            <span class="weg-entry-uid">#${esc(entry.uid)}</span>
            <span class="weg-entry-title">${esc(entry.title)}</span>
            ${greetingBadgeHtml}
        </div>
        <div class="weg-row-controls">
            <button
                type="button"
                class="weg-switch weg-switch-sm${isEnabled ? ' is-on' : ''}"
                role="switch"
                aria-checked="${isEnabled ? 'true' : 'false'}"
                aria-label="切换条目 ${esc(entry.title)}"
                data-weg-entry-toggle="${esc(entry.uid)}"
                data-weg-next-enabled="${isEnabled ? '0' : '1'}"
                ${_writingToggle ? 'disabled' : ''}
            >
                <span class="weg-switch-thumb"></span>
            </button>
            <button
                type="button"
                class="weg-more-btn"
                aria-label="条目操作菜单"
                data-weg-entry-menu="${esc(entry.uid)}"
            >···</button>
            <button
                type="button"
                class="weg-pin-btn${isPinned ? ' is-pinned' : ''}"
                data-weg-pin-entry="${esc(entry.uid)}"
                aria-pressed="${isPinned ? 'true' : 'false'}"
                aria-label="${isPinned ? '取消置顶条目' : '置顶条目'}"
                title="${isPinned ? '取消置顶条目' : '置顶条目'}"
            ><i class="fa-${isPinned ? 'solid' : 'regular'} fa-star" aria-hidden="true"></i></button>
        </div>
    `;
}

function renderEntryItemHtml(entry, isPinned = false) {
    const isEnabled = !entry.disabled;
    const isSelected = _selectedUids.has(entry.uid);
    const isExpanded = _openEditors.has(entry.uid);

    return `
        <div class="weg-entry-item" data-weg-entry-item="${esc(entry.uid)}">
            <div class="weg-entry-row${isEnabled ? '' : ' is-disabled'}${isPinned ? ' is-pinned' : ''}${isExpanded ? ' is-expanded' : ''}${_batchMode ? ' is-batch' : ''}${isSelected ? ' is-selected' : ''}" data-weg-entry-row="${esc(entry.uid)}">
                ${buildEntryRowInnerHtml(entry, isPinned)}
            </div>
            <div class="weg-acc-slot" data-weg-acc-slot="${esc(entry.uid)}"></div>
        </div>
    `;
}

// ============================================================================
// Multi-Open Inline Accordion Editor (Lazy Mount + Immediate Clean Unmount)
// ============================================================================

function createAccordionPanelShell(uid) {
    const panel = document.createElement('div');
    panel.className = 'weg-acc-panel';
    panel.setAttribute('data-weg-acc-uid', String(uid));
    return panel;
}

function renderAccordionLoadingState(panelEl, uid) {
    panelEl.innerHTML = `
        <div class="weg-acc-state-box">
            <span>正在读取条目 #${esc(uid)}…</span>
            <button type="button" class="weg-btn weg-btn-subtle weg-acc-mini-btn" data-weg-acc-action="collapse">收起</button>
        </div>
    `;
    panelEl.querySelector('[data-weg-acc-action="collapse"]')?.addEventListener('click', () => {
        requestCollapseAccordionEditor(uid);
    });
}

function renderAccordionErrorState(panelEl, uid, errorMsg) {
    panelEl.innerHTML = `
        <div class="weg-acc-state-box is-error">
            <span>${esc(errorMsg || '读取条目失败')}</span>
            <button type="button" class="weg-btn weg-btn-subtle weg-acc-mini-btn" data-weg-acc-action="collapse">收起</button>
        </div>
    `;
    panelEl.querySelector('[data-weg-acc-action="collapse"]')?.addEventListener('click', () => {
        requestCollapseAccordionEditor(uid);
    });
}

function syncAccordionPanelPreferences(panelEl) {
    if (!(panelEl instanceof HTMLElement)) return;
    const settings = getSettings();
    const isMono = Boolean(settings.editorMonospace);
    const heightSize = VALID_EDITOR_HEIGHTS.includes(settings.editorHeightSize) ? settings.editorHeightSize : 'M';

    panelEl.setAttribute('data-weg-height', heightSize);
    const textarea = panelEl.querySelector('[data-weg-acc-field="content"]');
    if (textarea instanceof HTMLTextAreaElement) {
        textarea.classList.toggle('is-monospace', isMono);
        textarea.classList.remove('is-size-s', 'is-size-m', 'is-size-l');
        textarea.classList.add(`is-size-${heightSize.toLowerCase()}`);
    }
    const monoBtn = panelEl.querySelector('[data-weg-acc-action="toggle-monospace"]');
    if (monoBtn instanceof HTMLElement) {
        monoBtn.classList.toggle('is-active', isMono);
        monoBtn.setAttribute('aria-pressed', isMono ? 'true' : 'false');
    }
    panelEl.querySelectorAll('[data-weg-acc-height]').forEach((btn) => {
        if (!(btn instanceof HTMLElement)) return;
        const active = btn.getAttribute('data-weg-acc-height') === heightSize;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
}

function syncAllMountedAccordionPreferences() {
    for (const panelEl of _mountedEditorEls.values()) {
        syncAccordionPanelPreferences(panelEl);
    }
}

function updateAccordionPanelChrome(panelEl, state) {
    if (!(panelEl instanceof HTMLElement) || !state) return;

    const statusEl = panelEl.querySelector('[data-weg-acc-field="status"]');
    const saveBtn = panelEl.querySelector('[data-weg-acc-action="save"]');
    const collapseBtn = panelEl.querySelector('[data-weg-acc-action="collapse"]');
    const locateBtn = panelEl.querySelector('[data-weg-acc-action="locate"]');
    const staleBanner = panelEl.querySelector('[data-weg-acc-field="stale-banner"]');
    const staleMsgEl = panelEl.querySelector('[data-weg-acc-field="stale-msg"]');
    const reloadLatestBtn = panelEl.querySelector('[data-weg-acc-action="reload-latest"]');
    const undoBtn = panelEl.querySelector('[data-weg-acc-action="undo"]');
    const redoBtn = panelEl.querySelector('[data-weg-acc-action="redo"]');

    if (undoBtn instanceof HTMLButtonElement) {
        undoBtn.disabled = !state.history?.canUndo?.() || Boolean(state.saving);
    }
    if (redoBtn instanceof HTMLButtonElement) {
        redoBtn.disabled = !state.history?.canRedo?.() || Boolean(state.saving);
    }

    if (staleBanner instanceof HTMLElement) {
        staleBanner.hidden = !state.externalStale;
        if (staleMsgEl instanceof HTMLElement) {
            staleMsgEl.textContent = state.externalDeleted
                ? '该条目已被其他操作删除（已保留你的未保存草稿）'
                : '该条目已被外部更新（已保留你的未保存草稿）';
        }
        if (reloadLatestBtn instanceof HTMLElement) {
            reloadLatestBtn.hidden = Boolean(state.externalDeleted);
        }
    }

    if (statusEl instanceof HTMLElement) {
        statusEl.classList.toggle('is-dirty', Boolean(state.dirty || state.externalDeleted));
        if (state.saving) {
            statusEl.textContent = '正在保存…';
        } else if (state.error) {
            statusEl.textContent = state.error;
        } else if (state.externalDeleted) {
            statusEl.textContent = '条目已在外部删除，可复制草稿或放弃';
        } else if (state.dirty) {
            statusEl.textContent = '有未保存的修改';
        } else {
            statusEl.textContent = '其余原生高级字段原样保留';
        }
    }

    const isSaving = Boolean(state.saving);
    const isExtDeleted = Boolean(state.externalDeleted);
    const disableSave = state.loading || isSaving || Boolean(state.error) || isExtDeleted;
    if (saveBtn instanceof HTMLButtonElement) saveBtn.disabled = disableSave;
    if (collapseBtn instanceof HTMLButtonElement) collapseBtn.disabled = isSaving;
    if (locateBtn instanceof HTMLButtonElement) locateBtn.disabled = isSaving || Boolean(state.loading) || isExtDeleted;
}

function applySnapshotToMountedForm(panelEl, state) {
    if (!(panelEl instanceof HTMLElement) || !state?.draft) return;
    const data = state.draft;

    const commentInput = panelEl.querySelector('[data-weg-acc-field="comment"]');
    const enabledSwitch = panelEl.querySelector('[data-weg-acc-field="enabled"]');
    const modeSelect = panelEl.querySelector('[data-weg-acc-field="mode"]');
    const posSelect = panelEl.querySelector('[data-weg-acc-field="position"]');
    const depthInput = panelEl.querySelector('[data-weg-acc-field="depth"]');
    const orderInput = panelEl.querySelector('[data-weg-acc-field="order"]');
    const keysInput = panelEl.querySelector('[data-weg-acc-field="key"]');
    const keys2Input = panelEl.querySelector('[data-weg-acc-field="keysecondary"]');
    const contentArea = panelEl.querySelector('[data-weg-acc-field="content"]');
    const counterEl = panelEl.querySelector('[data-weg-acc-field="counter"]');

    if (commentInput instanceof HTMLInputElement) commentInput.value = String(data.comment ?? '');
    if (enabledSwitch instanceof HTMLElement) {
        const on = Boolean(data.enabled);
        enabledSwitch.setAttribute('aria-checked', on ? 'true' : 'false');
        enabledSwitch.classList.toggle('is-on', on);
    }
    if (modeSelect instanceof HTMLSelectElement) modeSelect.value = String(data.mode ?? ENTRY_ACTIVATION_MODES.SELECTIVE);
    if (posSelect instanceof HTMLSelectElement) posSelect.value = String(data.position ?? WORLD_INFO_POSITION.BEFORE);
    if (depthInput instanceof HTMLInputElement) {
        depthInput.value = String(data.depth ?? 4);
        depthInput.disabled = Number(data.position) !== WORLD_INFO_POSITION.AT_DEPTH;
    }
    if (orderInput instanceof HTMLInputElement) orderInput.value = String(data.order ?? 100);
    if (keysInput instanceof HTMLInputElement) keysInput.value = Array.isArray(data.key) ? data.key.join(', ') : '';
    if (keys2Input instanceof HTMLInputElement) keys2Input.value = Array.isArray(data.keysecondary) ? data.keysecondary.join(', ') : '';
    if (contentArea instanceof HTMLTextAreaElement) contentArea.value = String(data.content ?? '');
    if (state.history && !state.dirty) {
        state.history.reset(String(data.content ?? ''), 0, 0);
    }
    if (counterEl instanceof HTMLElement) {
        const text = String(data.content ?? '');
        counterEl.textContent = `${text.length} 字 · ≈ ${estimateEntryTokens(text)} tokens`;
    }
}

function mountAccordionFormIntoPanel(panelEl, state, { hydrateFromDraft = false } = {}) {
    const uid = state.uid;
    const entry = hydrateFromDraft && state.draft ? state.draft : state.initialSnapshot;
    if (!entry) return;

    const safeId = makeSafeDomId(uid);
    const showVectorOption = entry.mode === ENTRY_ACTIVATION_MODES.VECTORIZED;
    const isAtDepth = entry.position === WORLD_INFO_POSITION.AT_DEPTH;
    const settings = getSettings();
    const isMono = Boolean(settings.editorMonospace);
    const heightSize = VALID_EDITOR_HEIGHTS.includes(settings.editorHeightSize) ? settings.editorHeightSize : 'M';
    const contentText = String(entry.content ?? '');
    if (!state.history) {
        state.history = createTextareaHistory(contentText, 0, 0);
    }

    panelEl.setAttribute('data-weg-height', heightSize);
    panelEl.innerHTML = `
        <div class="weg-acc-stale-banner" data-weg-acc-field="stale-banner" ${state.externalStale ? '' : 'hidden'}>
            <span class="weg-acc-stale-msg" data-weg-acc-field="stale-msg"></span>
            <button type="button" class="weg-mini-btn" data-weg-acc-action="reload-latest" ${state.externalDeleted ? 'hidden' : ''}>载入最新</button>
        </div>

        <div class="weg-acc-form">
            <div class="weg-acc-top-row">
                <div class="weg-acc-title-col">
                    <label class="weg-field-label" for="weg-acc-comment-${safeId}">条目标题</label>
                    <div class="weg-input-with-clear">
                        <input type="text" class="weg-input" id="weg-acc-comment-${safeId}" data-weg-acc-field="comment" placeholder="填写条目标题或备注…" autocomplete="off" spellcheck="false" />
                        <button type="button" class="weg-clear-input-btn" data-weg-acc-clear="comment">清空</button>
                    </div>
                </div>
                <div class="weg-acc-enable-col">
                    <span class="weg-field-label">启用</span>
                    <button
                        type="button"
                        class="weg-switch${entry.enabled ? ' is-on' : ''}"
                        id="weg-acc-enabled-${safeId}"
                        data-weg-acc-field="enabled"
                        role="switch"
                        aria-checked="${entry.enabled ? 'true' : 'false'}"
                        aria-label="切换条目启用状态"
                    >
                        <span class="weg-switch-thumb"></span>
                    </button>
                </div>
            </div>

            <div class="weg-acc-meta-grid">
                <div class="weg-acc-field">
                    <label class="weg-field-label" for="weg-acc-mode-${safeId}">触发方式</label>
                    <select class="weg-select" id="weg-acc-mode-${safeId}" data-weg-acc-field="mode">
                        <option value="${ENTRY_ACTIVATION_MODES.CONSTANT}">蓝灯 · 常驻生效</option>
                        <option value="${ENTRY_ACTIVATION_MODES.SELECTIVE}">绿灯 · 关键词触发</option>
                        ${showVectorOption ? `<option value="${ENTRY_ACTIVATION_MODES.VECTORIZED}">紫灯 · 向量触发</option>` : ''}
                    </select>
                </div>
                <div class="weg-acc-field">
                    <label class="weg-field-label" for="weg-acc-position-${safeId}">插入位置</label>
                    <select class="weg-select" id="weg-acc-position-${safeId}" data-weg-acc-field="position">
                        <option value="${WORLD_INFO_POSITION.BEFORE}">角色定义前</option>
                        <option value="${WORLD_INFO_POSITION.AFTER}">角色定义后</option>
                        <option value="${WORLD_INFO_POSITION.AN_TOP}">作者注释前</option>
                        <option value="${WORLD_INFO_POSITION.AN_BOTTOM}">作者注释后</option>
                        <option value="${WORLD_INFO_POSITION.AT_DEPTH}">指定深度 (@D)</option>
                        <option value="${WORLD_INFO_POSITION.EM_TOP}">示范对话前</option>
                        <option value="${WORLD_INFO_POSITION.EM_BOTTOM}">示范对话后</option>
                        <option value="${WORLD_INFO_POSITION.OUTLET}">输出槽 (Outlet)</option>
                    </select>
                </div>
                <div class="weg-acc-field">
                    <label class="weg-field-label" for="weg-acc-depth-${safeId}">深度</label>
                    <input type="number" class="weg-input weg-acc-depth-input" id="weg-acc-depth-${safeId}" data-weg-acc-field="depth" min="0" max="999" step="1" ${isAtDepth ? '' : 'disabled'} />
                </div>
                <div class="weg-acc-field">
                    <label class="weg-field-label" for="weg-acc-order-${safeId}">顺序</label>
                    <input type="number" class="weg-input" id="weg-acc-order-${safeId}" data-weg-acc-field="order" min="0" max="9999" step="1" />
                </div>
            </div>

            <div class="weg-acc-keys-grid">
                <div class="weg-acc-field">
                    <label class="weg-field-label" for="weg-acc-keys-${safeId}">主触发词 <span class="weg-field-hint">(逗号分隔，支持正则)</span></label>
                    <div class="weg-input-with-clear">
                        <input type="text" class="weg-input" id="weg-acc-keys-${safeId}" data-weg-acc-field="key" placeholder="例如：王都, 皇城" autocomplete="off" spellcheck="false" />
                        <button type="button" class="weg-clear-input-btn" data-weg-acc-clear="key">清空</button>
                    </div>
                </div>
                <div class="weg-acc-field">
                    <label class="weg-field-label" for="weg-acc-keys2-${safeId}">次触发词 <span class="weg-field-hint">(常驻模式可留空)</span></label>
                    <div class="weg-input-with-clear">
                        <input type="text" class="weg-input" id="weg-acc-keys2-${safeId}" data-weg-acc-field="keysecondary" placeholder="可选过滤词…" autocomplete="off" spellcheck="false" />
                        <button type="button" class="weg-clear-input-btn" data-weg-acc-clear="keysecondary">清空</button>
                    </div>
                </div>
            </div>

            <div class="weg-acc-content-wrap">
                <div class="weg-acc-content-head">
                    <label class="weg-field-label" for="weg-acc-content-${safeId}">条目正文</label>
                    <div class="weg-acc-editor-tools">
                        <button
                            type="button"
                            class="weg-editor-tool-btn"
                            data-weg-acc-action="undo"
                            title="撤回正文改动 (Ctrl+Z)"
                            disabled
                        >${UNDO_SVG} 撤回</button>
                        <button
                            type="button"
                            class="weg-editor-tool-btn"
                            data-weg-acc-action="redo"
                            title="取消撤回 (Ctrl+Y / Ctrl+Shift+Z)"
                            disabled
                        >${UNDO_SVG} 重做</button>
                        <button
                            type="button"
                            class="weg-editor-tool-btn"
                            data-weg-acc-action="copy-content"
                            title="复制完整条目正文"
                        >复制正文</button>
                        <button
                            type="button"
                            class="weg-editor-tool-btn${isMono ? ' is-active' : ''}"
                            data-weg-acc-action="toggle-monospace"
                            aria-pressed="${isMono ? 'true' : 'false'}"
                            title="切换等宽代码字体 / 常规字体"
                        >等宽代码字体</button>
                        <div class="weg-size-seg" role="group" aria-label="编辑框高度">
                            <button type="button" class="weg-size-seg-btn${heightSize === 'S' ? ' is-active' : ''}" data-weg-acc-height="S" aria-pressed="${heightSize === 'S' ? 'true' : 'false'}" title="紧凑高度">S</button>
                            <button type="button" class="weg-size-seg-btn${heightSize === 'M' ? ' is-active' : ''}" data-weg-acc-height="M" aria-pressed="${heightSize === 'M' ? 'true' : 'false'}" title="标准高度">M</button>
                            <button type="button" class="weg-size-seg-btn${heightSize === 'L' ? ' is-active' : ''}" data-weg-acc-height="L" aria-pressed="${heightSize === 'L' ? 'true' : 'false'}" title="加高视图">L</button>
                        </div>
                        <span class="weg-acc-counter" data-weg-acc-field="counter">${contentText.length} 字 · ≈ ${estimateEntryTokens(contentText)} tokens</span>
                    </div>
                </div>
                <div class="weg-acc-find-row">
                    <input
                        type="text"
                        class="weg-input weg-acc-find-input"
                        id="weg-acc-find-${safeId}"
                        data-weg-acc-field="find-query"
                        placeholder="框内查找正文关键词…"
                        autocomplete="off"
                        spellcheck="false"
                    />
                    <span class="weg-acc-find-count" data-weg-acc-field="find-count"></span>
                    <button type="button" class="weg-editor-tool-btn" data-weg-acc-action="find-prev" title="定位上一个匹配">上一个</button>
                    <button type="button" class="weg-editor-tool-btn" data-weg-acc-action="find-next" title="定位下一个匹配">下一个</button>
                </div>
                <textarea
                    class="weg-textarea weg-acc-textarea${isMono ? ' is-monospace' : ''} is-size-${heightSize.toLowerCase()}"
                    id="weg-acc-content-${safeId}"
                    data-weg-acc-field="content"
                    spellcheck="false"
                    placeholder="填写该条目触发后注入的正文内容…（支持 Tab / Shift+Tab 缩进与 Ctrl+Z 撤回）"
                ></textarea>
            </div>

            <div class="weg-acc-actions">
                <span class="weg-acc-status" data-weg-acc-field="status"></span>
                <div class="weg-acc-action-btns">
                    <button type="button" class="weg-btn weg-btn-subtle" data-weg-acc-action="locate" title="在酒馆原生编辑器中定位此条目">跳原生定位</button>
                    <button type="button" class="weg-btn weg-btn-subtle" data-weg-acc-action="collapse">收起</button>
                    <button type="button" class="weg-btn weg-btn-primary" data-weg-acc-action="save">保存</button>
                </div>
            </div>
        </div>
    `;

    applySnapshotToMountedForm(panelEl, state);

    const commentInput = panelEl.querySelector('[data-weg-acc-field="comment"]');
    const enabledSwitch = panelEl.querySelector('[data-weg-acc-field="enabled"]');
    const modeSelect = panelEl.querySelector('[data-weg-acc-field="mode"]');
    const posSelect = panelEl.querySelector('[data-weg-acc-field="position"]');
    const depthInput = panelEl.querySelector('[data-weg-acc-field="depth"]');
    const orderInput = panelEl.querySelector('[data-weg-acc-field="order"]');
    const keysInput = panelEl.querySelector('[data-weg-acc-field="key"]');
    const keys2Input = panelEl.querySelector('[data-weg-acc-field="keysecondary"]');
    const contentArea = panelEl.querySelector('[data-weg-acc-field="content"]');
    const counterEl = panelEl.querySelector('[data-weg-acc-field="counter"]');
    const findInput = panelEl.querySelector('[data-weg-acc-field="find-query"]');
    const findCountEl = panelEl.querySelector('[data-weg-acc-field="find-count"]');

    const syncDraftFromDom = () => {
        if (!_openEditors.has(uid) || !state.initialSnapshot) return;
        const init = state.initialSnapshot;
        const posVal = posSelect instanceof HTMLSelectElement
            ? Number.parseInt(posSelect.value, 10)
            : init.position;
        const parsedDepth = depthInput instanceof HTMLInputElement
            ? Number.parseInt(depthInput.value, 10)
            : init.depth;
        const parsedOrder = orderInput instanceof HTMLInputElement
            ? Number(orderInput.value)
            : init.order;

        const nextPos = Number.isInteger(posVal) ? posVal : init.position;
        const nextDepth = Number.isInteger(parsedDepth)
            ? Math.max(0, Math.min(1000, parsedDepth))
            : init.depth;
        const nextOrder = Number.isFinite(parsedOrder) ? Math.round(parsedOrder) : init.order;
        const nextContent = contentArea instanceof HTMLTextAreaElement ? contentArea.value : init.content;

        if (depthInput instanceof HTMLInputElement) {
            depthInput.disabled = nextPos !== WORLD_INFO_POSITION.AT_DEPTH;
        }
        if (counterEl instanceof HTMLElement) {
            counterEl.textContent = `${nextContent.length} 字 · ≈ ${estimateEntryTokens(nextContent)} tokens`;
        }

        state.draft = {
            uid: init.uid,
            comment: commentInput instanceof HTMLInputElement ? commentInput.value : init.comment,
            enabled: enabledSwitch instanceof HTMLElement
                ? enabledSwitch.getAttribute('aria-checked') === 'true'
                : init.enabled,
            mode: modeSelect instanceof HTMLSelectElement ? modeSelect.value : init.mode,
            position: nextPos,
            depth: nextDepth,
            order: nextOrder,
            key: keysInput instanceof HTMLInputElement ? parseEntryKeywordsInput(keysInput.value) : init.key,
            keysecondary: keys2Input instanceof HTMLInputElement ? parseEntryKeywordsInput(keys2Input.value) : init.keysecondary,
            content: nextContent,
        };
        state.dirty = computeEditDirty(init, state.draft);
        updateAccordionPanelChrome(panelEl, state);
    };

    state.syncDraftFromDom = syncDraftFromDom;

    const applyHistorySnap = (snap) => {
        if (!snap || !(contentArea instanceof HTMLTextAreaElement)) return;
        contentArea.value = snap.value;
        if (isDesktopAutoFocusAllowed()) contentArea.focus({ preventScroll: true });
        contentArea.setSelectionRange(snap.selectionStart, snap.selectionEnd);
        syncDraftFromDom();
    };

    const performUndo = () => {
        const snap = state.history?.undo?.();
        if (snap) applyHistorySnap(snap);
    };

    const performRedo = () => {
        const snap = state.history?.redo?.();
        if (snap) applyHistorySnap(snap);
    };

    const performFind = (direction) => {
        if (!(contentArea instanceof HTMLTextAreaElement) || !(findInput instanceof HTMLInputElement)) return;
        const query = findInput.value;
        if (!query) {
            if (findCountEl instanceof HTMLElement) findCountEl.textContent = '';
            return;
        }
        const fromIdx = direction === 'prev' ? contentArea.selectionStart : contentArea.selectionEnd;
        const res = findNextMatchInText(contentArea.value, query, fromIdx, { direction });
        if (findCountEl instanceof HTMLElement) {
            findCountEl.textContent = res.found ? `${res.matchIndex + 1}/${res.totalMatches}` : '0/0';
        }
        if (!res.found) {
            showToast('info', '未找到匹配内容');
            return;
        }
        if (isDesktopAutoFocusAllowed()) contentArea.focus({ preventScroll: true });
        contentArea.setSelectionRange(res.start, res.end);
    };

    const formEl = panelEl.querySelector('.weg-acc-form');
    if (formEl instanceof HTMLElement) {
        formEl.addEventListener('compositionstart', () => {
            state.composing = true;
        });
        formEl.addEventListener('compositionend', (ev) => {
            state.composing = false;
            if (ev.target === contentArea && contentArea instanceof HTMLTextAreaElement) {
                state.history?.push?.(contentArea.value, contentArea.selectionStart, contentArea.selectionEnd);
            }
            syncDraftFromDom();
        });
        formEl.addEventListener('input', (ev) => {
            if (state.composing) return;
            if (ev.target === findInput) {
                if (findCountEl instanceof HTMLElement) {
                    const q = findInput.value;
                    if (!q) {
                        findCountEl.textContent = '';
                    } else if (contentArea instanceof HTMLTextAreaElement) {
                        const probe = findNextMatchInText(contentArea.value, q, 0, { direction: 'next' });
                        findCountEl.textContent = probe.found ? `${probe.totalMatches} 处` : '0/0';
                    }
                }
                return;
            }
            if (ev.target === contentArea && contentArea instanceof HTMLTextAreaElement) {
                state.history?.push?.(contentArea.value, contentArea.selectionStart, contentArea.selectionEnd);
            }
            syncDraftFromDom();
        });
        formEl.addEventListener('change', (ev) => {
            if (ev.target === findInput) return;
            syncDraftFromDom();
        });
    }

    if (findInput instanceof HTMLInputElement) {
        findInput.addEventListener('keydown', (ev) => {
            if (ev.isComposing || state.composing || ev.keyCode === 229) return;
            if (ev.key === 'Enter') {
                ev.preventDefault();
                performFind(ev.shiftKey ? 'prev' : 'next');
            }
        });
    }

    if (contentArea instanceof HTMLTextAreaElement) {
        contentArea.addEventListener('keydown', (ev) => {
            if (ev.isComposing || state.composing || ev.keyCode === 229) return;
            if (ev.key === 'Tab') {
                ev.preventDefault();
                const res = applyTextareaTabIndent(
                    contentArea.value,
                    contentArea.selectionStart,
                    contentArea.selectionEnd,
                    { shiftKey: ev.shiftKey, indentStr: '  ' },
                );
                contentArea.value = res.value;
                contentArea.selectionStart = res.selectionStart;
                contentArea.selectionEnd = res.selectionEnd;
                state.history?.push?.(res.value, res.selectionStart, res.selectionEnd);
                syncDraftFromDom();
                return;
            }
            if ((ev.ctrlKey || ev.metaKey) && !ev.altKey) {
                const lower = ev.key.toLowerCase();
                if (lower === 'z' && !ev.shiftKey) {
                    ev.preventDefault();
                    performUndo();
                } else if ((lower === 'y' && !ev.shiftKey) || (lower === 'z' && ev.shiftKey)) {
                    ev.preventDefault();
                    performRedo();
                }
            }
        });
    }

    panelEl.querySelector('[data-weg-acc-action="undo"]')?.addEventListener('click', performUndo);
    panelEl.querySelector('[data-weg-acc-action="redo"]')?.addEventListener('click', performRedo);
    panelEl.querySelector('[data-weg-acc-action="find-prev"]')?.addEventListener('click', () => performFind('prev'));
    panelEl.querySelector('[data-weg-acc-action="find-next"]')?.addEventListener('click', () => performFind('next'));
    panelEl.querySelector('[data-weg-acc-action="copy-content"]')?.addEventListener('click', async () => {
        if (!(contentArea instanceof HTMLTextAreaElement)) return;
        if (!contentArea.value) {
            showToast('info', '条目正文为空');
            return;
        }
        const ok = await copyTextToClipboard(contentArea.value);
        showToast(ok ? 'success' : 'warning', ok ? '已复制条目正文' : '复制失败，请手动全选复制');
    });

    enabledSwitch?.addEventListener('click', () => {
        if (!(enabledSwitch instanceof HTMLElement)) return;
        const nextOn = enabledSwitch.getAttribute('aria-checked') !== 'true';
        enabledSwitch.setAttribute('aria-checked', nextOn ? 'true' : 'false');
        enabledSwitch.classList.toggle('is-on', nextOn);
        syncDraftFromDom();
    });

    panelEl.querySelectorAll('[data-weg-acc-clear]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const field = btn.getAttribute('data-weg-acc-clear');
            const inp = field ? panelEl.querySelector(`[data-weg-acc-field="${field}"]`) : null;
            if (inp instanceof HTMLInputElement) {
                inp.value = '';
                syncDraftFromDom();
                if (isDesktopAutoFocusAllowed()) inp.focus({ preventScroll: true });
            }
        });
    });

    panelEl.querySelector('[data-weg-acc-action="toggle-monospace"]')?.addEventListener('click', () => {
        const cur = getSettings();
        cur.editorMonospace = !cur.editorMonospace;
        notifySettingsChanged();
        syncAllMountedAccordionPreferences();
    });

    panelEl.querySelectorAll('[data-weg-acc-height]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const size = btn.getAttribute('data-weg-acc-height');
            if (!size || !VALID_EDITOR_HEIGHTS.includes(size)) return;
            const cur = getSettings();
            cur.editorHeightSize = size;
            notifySettingsChanged();
            syncAllMountedAccordionPreferences();
        });
    });

    panelEl.querySelector('[data-weg-acc-action="save"]')?.addEventListener('click', () => {
        void handleSaveAccordionEntry(uid);
    });

    panelEl.querySelector('[data-weg-acc-action="collapse"]')?.addEventListener('click', () => {
        requestCollapseAccordionEditor(uid);
    });

    panelEl.querySelector('[data-weg-acc-action="locate"]')?.addEventListener('click', () => {
        requestLocateFromAccordion(uid);
    });

    panelEl.querySelector('[data-weg-acc-action="reload-latest"]')?.addEventListener('click', () => {
        if (state.externalDeleted || !state.initialSnapshot) {
            showToast('warning', '该条目已在外部删除');
            return;
        }
        state.draft = {
            ...state.initialSnapshot,
            key: [...state.initialSnapshot.key],
            keysecondary: [...state.initialSnapshot.keysecondary],
        };
        state.dirty = false;
        state.externalStale = false;
        state.externalDeleted = false;
        applySnapshotToMountedForm(panelEl, state);
        updateAccordionPanelChrome(panelEl, state);
        showToast('info', `已载入条目 #${uid} 最新内容`);
    });

    updateAccordionPanelChrome(panelEl, state);
}

async function toggleAccordionEditor(uid) {
    const targetUid = String(uid ?? '').trim();
    if (!targetUid) return;
    if (_openEditors.has(targetUid)) {
        requestCollapseAccordionEditor(targetUid);
        return;
    }
    await openAccordionEditor(targetUid);
}

async function openAccordionEditor(uid) {
    if (typeof document === 'undefined' || !_isOpen || !_currentBook) return;
    const targetUid = String(uid ?? '').trim();
    const targetBook = _currentBook;
    if (!targetUid) return;
    if (_openEditors.has(targetUid)) return;

    const loadSeq = ++_editorLoadCounter;
    const state = {
        uid: targetUid,
        worldName: targetBook,
        loadSeq,
        loading: true,
        saving: false,
        dirty: false,
        error: '',
        externalStale: false,
        externalDeleted: false,
        composing: false,
        initialSnapshot: null,
        draft: null,
        syncDraftFromDom: null,
    };
    _openEditors.set(targetUid, state);

    const backdrop = document.getElementById(MODAL_BACKDROP_ID);
    const slot = backdrop?.querySelector(`[data-weg-acc-slot="${cssEsc(targetUid)}"]`);
    const row = backdrop?.querySelector(`[data-weg-entry-row="${cssEsc(targetUid)}"]`);
    if (row instanceof HTMLElement) row.classList.add('is-expanded');

    let panelEl = _mountedEditorEls.get(targetUid);
    if (!panelEl) {
        panelEl = createAccordionPanelShell(targetUid);
        _mountedEditorEls.set(targetUid, panelEl);
    }
    if (slot instanceof HTMLElement) {
        slot.appendChild(panelEl);
        renderAccordionLoadingState(panelEl, targetUid);
    }
    updateFooterOpenEditorCount(backdrop);

    let res = await loadWorldbookEntryForEditUncached(targetBook, targetUid);
    const liveState = _openEditors.get(targetUid);
    if (!liveState || liveState.loadSeq !== loadSeq || !_isOpen) {
        return;
    }
    if (liveState.worldName !== _currentBook) {
        if (!res.ok) {
            res = await loadWorldbookEntryForEditUncached(liveState.worldName, targetUid);
            if (!_openEditors.has(targetUid) || _openEditors.get(targetUid).loadSeq !== loadSeq || !_isOpen) {
                return;
            }
        }
        if (liveState.worldName !== _currentBook) {
            collapseAccordionEditorImmediate(targetUid);
            return;
        }
    }

    const activePanel = _mountedEditorEls.get(targetUid);
    if (!res.ok || !res.entry) {
        liveState.loading = false;
        liveState.error = res.error || '读取条目失败';
        if (activePanel) {
            renderAccordionErrorState(activePanel, targetUid, liveState.error);
        }
        return;
    }

    liveState.loading = false;
    liveState.initialSnapshot = res.entry;
    liveState.draft = {
        ...res.entry,
        key: [...res.entry.key],
        keysecondary: [...res.entry.keysecondary],
    };

    if (activePanel) {
        mountAccordionFormIntoPanel(activePanel, liveState, { hydrateFromDraft: false });
    }
}

function updateFooterOpenEditorCount(backdrop) {
    if (!backdrop || _batchMode || _writingToggle || !_currentBook) return;
    const footerStatus = backdrop.querySelector('.weg-footer-status');
    if (!(footerStatus instanceof HTMLElement)) return;
    const settings = getSettings();
    const customGroupCount = getBookConfigMutable(settings, _currentBook).groups.length;
    const openCount = _openEditors.size;
    footerStatus.textContent = openCount > 0
        ? `共 ${customGroupCount} 个自定义分组 · 已展开 ${openCount} 条编辑`
        : `共 ${customGroupCount} 个自定义分组`;
}

function collapseAccordionEditorImmediate(uid, { skipRender = false } = {}) {
    const targetUid = String(uid ?? '').trim();
    if (!targetUid) return;
    const state = _openEditors.get(targetUid);
    if (state) {
        state.loadSeq = -1;
    }
    _openEditors.delete(targetUid);

    const panelEl = _mountedEditorEls.get(targetUid);
    if (panelEl) {
        panelEl.remove();
        _mountedEditorEls.delete(targetUid);
    }

    if (typeof document !== 'undefined') {
        const backdrop = document.getElementById(MODAL_BACKDROP_ID);
        const row = backdrop?.querySelector(`[data-weg-entry-row="${cssEsc(targetUid)}"]`);
        if (row instanceof HTMLElement) row.classList.remove('is-expanded');
        const deletedCard = backdrop?.querySelector(`.weg-deleted-draft-card[data-weg-deleted-uid="${cssEsc(targetUid)}"]`);
        if (deletedCard instanceof HTMLElement) {
            const wrap = deletedCard.parentElement;
            deletedCard.remove();
            if (wrap instanceof HTMLElement && wrap.children.length === 0) {
                wrap.remove();
            }
        }
        if (!skipRender) {
            updateFooterOpenEditorCount(backdrop);
        }
    }
}

function requestCollapseAccordionEditor(uid) {
    const targetUid = String(uid ?? '').trim();
    const state = _openEditors.get(targetUid);
    if (!state) return;
    if (state.saving) return;
    if (state.dirty) {
        _submodal = {
            type: 'confirm-discard',
            scope: 'accordion',
            uid: targetUid,
            nextAction: 'collapse',
        };
        renderSubmodalHost();
        return;
    }
    collapseAccordionEditorImmediate(targetUid);
}

function requestLocateFromAccordion(uid) {
    const targetUid = String(uid ?? '').trim();
    const state = _openEditors.get(targetUid);
    if (!state || state.loading || state.saving) return;
    if (state.dirty) {
        _submodal = {
            type: 'confirm-discard',
            scope: 'accordion',
            uid: targetUid,
            nextAction: 'locate',
        };
        renderSubmodalHost();
        return;
    }
    executeLocateForEntry(
        state.worldName || _currentBook,
        targetUid,
        state.draft?.comment || state.initialSnapshot?.comment || state.draft?.key?.[0] || '',
    );
}

function executeLocateForEntry(worldName, uid, hint) {
    if (!worldName || !uid) return;
    const narrow = isNarrowViewport();
    const shouldClose = narrow || getSettings().closeOnLocate !== false;
    if (shouldClose) {
        const dirtyCount = getDirtyEditorUids().length;
        if (dirtyCount > 0) {
            _submodal = { type: 'confirm-discard', scope: 'modal', nextAction: 'locate', targetBook: worldName, uid, hint, dirtyCount };
            renderSubmodalHost();
            return;
        }
        closeEntryGroupsModal();
    }
    if (narrow) _callbacks?.onRevealNativeEditor?.();
    revealNativeEntryGroup(worldName, uid);
    void locateEntryInNativeEditor(worldName, uid, hint).then((ok) => {
        if (!ok) showToast('info', `未能定位「${worldName}」的条目 #${uid}`);
    });
}

function refreshEntryRowAndStatsInPlace(uid, disabledChanged) {
    if (typeof document === 'undefined') return;
    const backdrop = document.getElementById(MODAL_BACKDROP_ID);
    if (!backdrop) return;
    const settings = getSettings();
    const bookCfg = _currentBook ? getBookConfigMutable(settings, _currentBook) : normalizeBookConfig(null);
    const entry = _loadedSummaries.find((e) => e.uid === uid);

    if (entry) {
        const row = backdrop.querySelector(`.weg-entry-row[data-weg-entry-row="${cssEsc(uid)}"]`);
        if (row instanceof HTMLElement) {
            const isPinned = Array.isArray(bookCfg.pinnedEntryUids) && bookCfg.pinnedEntryUids.includes(uid);
            row.classList.toggle('is-disabled', Boolean(entry.disabled));
            row.classList.toggle('is-pinned', isPinned);
            row.classList.toggle('is-expanded', _openEditors.has(uid));
            row.innerHTML = buildEntryRowInnerHtml(entry, isPinned);
        }
    }

    if (disabledChanged) {
        const grouped = buildGroupedView(_loadedSummaries, bookCfg, { sortPinned: false });
        const statsEl = backdrop.querySelector('#weg-header-stats');
        if (statsEl instanceof HTMLElement) {
            statsEl.textContent = `已开 ${grouped.totalEnabled} / ${grouped.totalEntries} 条`;
        }
        for (const sec of grouped.sections) {
            const card = backdrop.querySelector(`.weg-group-card[data-weg-group-card="${cssEsc(sec.id)}"]`);
            if (!(card instanceof HTMLElement)) continue;
            const countEl = card.querySelector('.weg-group-count');
            if (countEl instanceof HTMLElement) {
                countEl.textContent = `${sec.enabledCount}/${sec.totalCount}`;
            }
            const sw = card.querySelector(`[data-weg-group-toggle="${cssEsc(sec.id)}"]`);
            if (sw instanceof HTMLElement) {
                const switchOn = sec.mode === GROUP_MODES.RADIO ? sec.enabledCount > 0 : sec.allEnabled;
                const switchPartial = !switchOn && sec.someEnabled;
                sw.classList.toggle('is-on', switchOn);
                sw.classList.toggle('is-partial', switchPartial);
                sw.setAttribute('aria-checked', switchOn ? 'true' : 'false');
                sw.setAttribute('data-weg-next-enabled', switchOn ? '0' : '1');
            }
        }
        renderSaveBindingBar(backdrop.querySelector('#weg-save-bar'));
    }
}

async function handleSaveAccordionEntry(uid) {
    const targetUid = String(uid ?? '').trim();
    const state = _openEditors.get(targetUid);
    if (!state || state.loading || state.saving || _writingToggle || state.error) {
        return false;
    }

    state.syncDraftFromDom?.();
    const draft = state.draft;
    if (!draft) return false;

    const targetBook = state.worldName;
    state.saving = true;
    _writingToggle = true;

    const panelEl = _mountedEditorEls.get(targetUid);
    if (panelEl) updateAccordionPanelChrome(panelEl, state);

    let res;
    try {
        res = await saveWorldbookEntryEdit(targetBook, targetUid, {
            comment: draft.comment,
            enabled: draft.enabled,
            mode: draft.mode,
            key: draft.key,
            keysecondary: draft.keysecondary,
            position: draft.position,
            depth: draft.depth,
            order: draft.order,
            content: draft.content,
        });
    } finally {
        _writingToggle = false;
    }

    if (!_isOpen || _openEditors.get(targetUid) !== state || state.worldName !== targetBook || _currentBook !== targetBook) {
        if (_openEditors.get(targetUid) === state) {
            state.saving = false;
            const activePanel = _mountedEditorEls.get(targetUid);
            if (activePanel) updateAccordionPanelChrome(activePanel, state);
            if (_isOpen && !res?.ok) {
                showToast('error', res?.error || '世界书已切换或改名，请重新保存');
            }
        }
        return false;
    }

    state.saving = false;
    if (!res?.ok) {
        const activePanel = _mountedEditorEls.get(targetUid);
        if (activePanel) updateAccordionPanelChrome(activePanel, state);
        showToast('error', res?.error || '保存条目失败');
        return false;
    }

    _loadedSummaries = res.summaries;
    if (res.disabledChanged) {
        recordStateIntoActiveChatIfMatching(targetBook, _loadedSummaries, {
            greetingIndex: _greetingIndex,
        });
    }
    syncAllNativeEntryPoints();

    state.initialSnapshot = res.entry;
    state.draft = {
        ...res.entry,
        key: [...res.entry.key],
        keysecondary: [...res.entry.keysecondary],
    };
    state.dirty = false;
    state.externalStale = false;
    state.externalDeleted = false;

    const activePanel = _mountedEditorEls.get(targetUid);
    if (activePanel) {
        applySnapshotToMountedForm(activePanel, state);
        updateAccordionPanelChrome(activePanel, state);
    }
    refreshEntryRowAndStatsInPlace(targetUid, res.disabledChanged);
    showToast('success', `条目 #${targetUid} 已保存`);
    return true;
}

// ============================================================================
// Submodals
// ============================================================================

function closeSubmodal() {
    _submodal = null;
    renderSubmodalHost();
}

function openGroupFormSubmodal(existingGroup = null) {
    _submodal = {
        type: 'group-form',
        groupId: existingGroup?.id || null,
        initialName: existingGroup?.name || '',
        mode: existingGroup?.mode || GROUP_MODES.NORMAL,
        sceneKeywordsText: (existingGroup?.sceneKeywords || []).join(', '),
        cooldownTurns: existingGroup?.cooldownTurns || 2,
    };
    renderSubmodalHost();
}

function openBatchMoveSubmodal(uids) {
    _submodal = {
        type: 'batch-move',
        uids: [...new Set(uids)],
    };
    renderSubmodalHost();
}

async function openAutoDetectSubmodal() {
    const settings = getSettings();
    const targetBook = _currentBook;
    const bookCfg = getBookConfigMutable(settings, targetBook);
    const hasExistingAssignments = Object.keys(bookCfg.assignments).length > 0;

    if (!_greetingIndex && targetBook) {
        const res = await resolveGreetingCoordinationForBook(targetBook, { allowFetchShallow: true });
        if (!_isOpen || _currentBook !== targetBook) return;
        if (res.greetingIndex) {
            _greetingCharName = res.characterName || '';
            _greetingIndex = res.greetingIndex;
        }
    }

    const strategy = 'smart';
    const onlyUngrouped = hasExistingAssignments;
    const proposals = detectAutoGroups(_loadedSummaries, {
        strategy,
        onlyUngrouped,
        existingAssignments: bookCfg.assignments,
        greetingIndex: _greetingIndex,
    });

    _submodal = {
        type: 'auto-detect',
        strategy,
        onlyUngrouped,
        proposals: proposals.map((p) => ({ ...p, checked: true, mode: p.suggestedMode })),
    };
    renderSubmodalHost();
}

function openSettingsSubmodal() {
    _submodal = { type: 'settings' };
    renderSubmodalHost();
}

function renderSubmodalHost() {
    if (typeof document === 'undefined') return;
    const host = document.querySelector(`#${MODAL_BACKDROP_ID} #weg-submodal-host`);
    if (!(host instanceof HTMLElement)) return;

    if (!_submodal) {
        host.hidden = true;
        host.innerHTML = '';
        return;
    }

    host.hidden = false;

    if (_submodal.type === 'confirm-discard') {
        const scope = _submodal.scope || 'accordion';
        const nextAction = _submodal.nextAction || 'collapse';
        if (scope === 'modal') {
            const dirtyCount = _submodal.dirtyCount || getDirtyEditorUids().length;
            const targetBook = _submodal.targetBook || '';
            const { uid, hint } = _submodal;
            host.innerHTML = `
                <div class="weg-submodal-card weg-submodal-compact" role="dialog" aria-label="放弃未保存的修改">
                    <div class="weg-submodal-header">
                        <span class="weg-submodal-title">有未保存的修改</span>
                        <button type="button" class="weg-icon-btn" data-weg-sub-close="1" aria-label="返回"><i class="fa-solid fa-xmark"></i></button>
                    </div>
                    <div class="weg-submodal-body">
                        <p class="weg-empty-desc">当前有 ${dirtyCount} 个展开的条目存在未保存修改，离开后这些改动将会丢失。</p>
                    </div>
                    <div class="weg-submodal-footer weg-discard-footer">
                        <button type="button" class="weg-btn weg-btn-subtle" id="weg-discard-stay-btn">继续编辑</button>
                        <button type="button" class="weg-btn weg-btn-danger" id="weg-discard-drop-btn">放弃全部修改</button>
                    </div>
                </div>
            `;
            wireCommonSubmodalClose(host);
            host.querySelector('#weg-discard-stay-btn')?.addEventListener('click', () => closeSubmodal());
            host.querySelector('#weg-discard-drop-btn')?.addEventListener('click', () => {
                closeSubmodal();
                clearAllEditors();
                if (nextAction === 'switch-book') {
                    _batchMode = false;
                    _selectedUids.clear();
                    void loadBookIntoModal(targetBook, { silent: false, preserveSelection: false });
                } else if (nextAction === 'locate') {
                    executeLocateForEntry(targetBook, uid, hint);
                } else {
                    closeEntryGroupsModal();
                }
            });
            return;
        }

        const uid = _submodal.uid || '';
        const targetState = _openEditors.get(uid);
        const isExtDeleted = Boolean(targetState?.externalDeleted);
        const saveLabel = nextAction === 'locate' ? '保存并定位' : '保存并收起';
        const promptBody = isExtDeleted
            ? `条目 #${esc(uid)} 已被其他操作删除，但还保留着未保存草稿，放弃后这些改动将会丢失。`
            : `条目 #${esc(uid)} 还有尚未保存的修改，收起或离开后这些改动将会丢失。`;
        host.innerHTML = `
            <div class="weg-submodal-card weg-submodal-compact" role="dialog" aria-label="放弃未保存的修改">
                <div class="weg-submodal-header">
                    <span class="weg-submodal-title">有未保存的修改</span>
                    <button type="button" class="weg-icon-btn" data-weg-sub-close="1" aria-label="返回"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="weg-submodal-body">
                    <p class="weg-empty-desc">${promptBody}</p>
                </div>
                <div class="weg-submodal-footer weg-discard-footer">
                    <button type="button" class="weg-btn weg-btn-subtle" id="weg-discard-stay-btn">继续编辑</button>
                    <button type="button" class="weg-btn weg-btn-danger" id="weg-discard-drop-btn">放弃修改</button>
                    ${isExtDeleted ? '' : `<button type="button" class="weg-btn weg-btn-primary" id="weg-discard-save-btn">${saveLabel}</button>`}
                </div>
            </div>
        `;
        wireCommonSubmodalClose(host);
        host.querySelector('#weg-discard-stay-btn')?.addEventListener('click', () => closeSubmodal());
        host.querySelector('#weg-discard-drop-btn')?.addEventListener('click', () => {
            const state = _openEditors.get(uid);
            const snapWorld = state?.worldName || _currentBook;
            const snapHint = state?.draft?.comment || state?.initialSnapshot?.comment || state?.draft?.key?.[0] || '';
            closeSubmodal();
            collapseAccordionEditorImmediate(uid);
            if (nextAction === 'locate') {
                executeLocateForEntry(snapWorld, uid, snapHint);
            }
        });
        host.querySelector('#weg-discard-save-btn')?.addEventListener('click', async () => {
            const state = _openEditors.get(uid);
            const snapWorld = state?.worldName || _currentBook;
            const snapHint = state?.draft?.comment || state?.initialSnapshot?.comment || state?.draft?.key?.[0] || '';
            closeSubmodal();
            const ok = await handleSaveAccordionEntry(uid);
            if (!ok) return;
            if (nextAction === 'locate') {
                executeLocateForEntry(snapWorld, uid, snapHint);
            } else {
                collapseAccordionEditorImmediate(uid);
            }
        });
        return;
    }

    if (_submodal.type === 'group-form') {
        const isEdit = Boolean(_submodal.groupId);
        const showSceneOpts = _submodal.mode === GROUP_MODES.SCENE;
        host.innerHTML = `
            <div class="weg-submodal-card" role="dialog" aria-label="${isEdit ? '编辑分组' : '新建分组'}">
                <div class="weg-submodal-header">
                    <span class="weg-submodal-title">${isEdit ? '编辑分组' : '新建分组'}</span>
                    <button type="button" class="weg-icon-btn" data-weg-sub-close="1" aria-label="返回"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="weg-submodal-body">
                    <label class="weg-field-label" for="weg-group-name-input">分组名称</label>
                    <div class="weg-input-with-clear">
                        <input type="text" class="weg-input" id="weg-group-name-input" value="${esc(_submodal.initialName)}" placeholder="例如：支线 A / 场景组" maxlength="40" autocomplete="off" spellcheck="false" />
                        <button type="button" class="weg-clear-input-btn" id="weg-group-name-clear">清空</button>
                    </div>

                    <div class="weg-field-label" style="margin-top: 12px;">开关联动模式</div>
                    <div class="weg-mode-options" id="weg-group-mode-list">
                        ${renderModeOptionHtml(GROUP_MODES.NORMAL, _submodal.mode, '普通组', '整组一键全开或全关，与其他分组互不影响')}
                        ${renderModeOptionHtml(GROUP_MODES.IF_LINE, _submodal.mode, 'IF 线 / 阶段互斥组', '开启本组时自动关闭其他 IF 线组，并更新本存档当前阶段（支持 18岁→30岁跨阶段演进）')}
                        ${renderModeOptionHtml(GROUP_MODES.SCENE, _submodal.mode, '情境按需组（如 NSFW）', '日常对话保持关闭；最近消息出现触发词时当轮自动开启，脱离剧情后自动关回')}
                        ${renderModeOptionHtml(GROUP_MODES.RADIO, _submodal.mode, '组内单选组', '开启本组内任意一条时，自动关闭本组其余条目')}
                    </div>

                    <div class="weg-scene-extra" id="weg-scene-extra" ${showSceneOpts ? '' : 'hidden'}>
                        <label class="weg-field-label" for="weg-scene-kw-input" style="margin-top: 12px;">自定义情境触发词（留空则使用内置亲密剧情词库）</label>
                        <div class="weg-input-with-clear">
                            <input type="text" class="weg-input" id="weg-scene-kw-input" value="${esc(_submodal.sceneKeywordsText)}" placeholder="多个词用逗号分隔" autocomplete="off" spellcheck="false" />
                            <button type="button" class="weg-clear-input-btn" id="weg-scene-kw-clear">清空</button>
                        </div>
                        <div class="weg-scene-cooldown-row">
                            <span>脱离触发词后继续保持开启轮数</span>
                            <input type="number" class="weg-input weg-cooldown-input" id="weg-scene-cooldown-input" min="1" max="10" value="${Number(_submodal.cooldownTurns) || 2}" />
                        </div>
                    </div>
                </div>
                <div class="weg-submodal-footer">
                    <button type="button" class="weg-btn weg-btn-subtle" data-weg-sub-close="1">取消</button>
                    <button type="button" class="weg-btn weg-btn-primary" id="weg-group-save-btn">${isEdit ? '保存修改' : '创建分组'}</button>
                </div>
            </div>
        `;
        wireGroupFormSubmodal(host);
        return;
    }

    if (_submodal.type === 'batch-move') {
        const settings = getSettings();
        const bookCfg = getBookConfigMutable(settings, _currentBook);
        const count = _submodal.uids.length;

        const modeNameMap = {
            [GROUP_MODES.NORMAL]: '普通组',
            [GROUP_MODES.IF_LINE]: 'IF 互斥',
            [GROUP_MODES.SCENE]: '情境按需',
            [GROUP_MODES.RADIO]: '组内单选',
        };

        const groupItemsHtml = bookCfg.groups.map((g) => `
            <button type="button" class="weg-move-target-btn" data-weg-move-target="${esc(g.id)}">
                <span class="weg-move-target-name">${esc(g.name)}</span>
                <span class="weg-move-target-meta">${esc(modeNameMap[g.mode] || '普通组')}</span>
            </button>
        `).join('');

        host.innerHTML = `
            <div class="weg-submodal-card" role="dialog" aria-label="移动条目到分组">
                <div class="weg-submodal-header">
                    <span class="weg-submodal-title">移动已选的 ${count} 个条目</span>
                    <button type="button" class="weg-icon-btn" data-weg-sub-close="1" aria-label="返回"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="weg-submodal-body">
                    <div class="weg-field-label">选择已有分组</div>
                    <div class="weg-move-target-list">
                        ${groupItemsHtml || '<div class="weg-group-empty">当前还没有自定义分组，可在下方直接新建并移入</div>'}
                        <button type="button" class="weg-move-target-btn is-muted" data-weg-move-target="${SPECIAL_GROUP_UNGROUPED}">
                            <span class="weg-move-target-name">移回「未分组」</span>
                            <span class="weg-move-target-meta">解除分组归属</span>
                        </button>
                    </div>

                    <div class="weg-field-label" style="margin-top: 12px;">或直接新建分组并移入</div>
                    <div class="weg-inline-new-group">
                        <div class="weg-input-with-clear">
                            <input type="text" class="weg-input" id="weg-quick-new-group-input" placeholder="输入新分组名称…" maxlength="40" autocomplete="off" spellcheck="false" />
                            <button type="button" class="weg-clear-input-btn" id="weg-quick-new-clear">清空</button>
                        </div>
                        <button type="button" class="weg-btn weg-btn-primary" id="weg-quick-new-move-btn">新建并移入</button>
                    </div>
                </div>
                <div class="weg-submodal-footer">
                    <button type="button" class="weg-btn weg-btn-subtle" data-weg-sub-close="1">取消</button>
                </div>
            </div>
        `;
        wireBatchMoveSubmodal(host);
        return;
    }

    if (_submodal.type === 'auto-detect') {
        const proposals = _submodal.proposals || [];
        const checkedCount = proposals.filter((p) => p.checked).length;
        const sourceLabelMap = {
            scene: '情境识别',
            greeting: '开场白标签',
            divider: '分隔条区间',
            prefix: '标题前缀',
        };

        const listHtml = proposals.length === 0
            ? `<div class="weg-empty-state weg-empty-compact">
                <p class="weg-empty-title">未识别到可自动归类的分组</p>
                <p class="weg-empty-desc">可尝试切换上方识别方式，或取消勾选「仅识别未分组条目」。</p>
               </div>`
            : proposals.map((p, idx) => `
                <div class="weg-detect-row">
                    <label class="weg-detect-check-label">
                        <input type="checkbox" data-weg-detect-idx="${idx}" ${p.checked ? 'checked' : ''} />
                        <span class="weg-detect-name">${esc(p.name)}</span>
                        <span class="weg-badge">${esc(sourceLabelMap[p.source] || '自动')}</span>
                        <span class="weg-group-count">${p.uids.length} 条</span>
                    </label>
                    <select class="weg-select weg-detect-mode-select" data-weg-detect-mode="${idx}" aria-label="分组模式">
                        <option value="${GROUP_MODES.NORMAL}" ${p.mode === GROUP_MODES.NORMAL ? 'selected' : ''}>普通组</option>
                        <option value="${GROUP_MODES.IF_LINE}" ${p.mode === GROUP_MODES.IF_LINE ? 'selected' : ''}>IF 互斥</option>
                        <option value="${GROUP_MODES.SCENE}" ${p.mode === GROUP_MODES.SCENE ? 'selected' : ''}>情境按需</option>
                        <option value="${GROUP_MODES.RADIO}" ${p.mode === GROUP_MODES.RADIO ? 'selected' : ''}>组内单选</option>
                    </select>
                </div>
            `).join('');

        host.innerHTML = `
            <div class="weg-submodal-card weg-submodal-wide" role="dialog" aria-label="自动识别建组">
                <div class="weg-submodal-header">
                    <span class="weg-submodal-title">自动识别建组预览</span>
                    <button type="button" class="weg-icon-btn" data-weg-sub-close="1" aria-label="返回"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="weg-submodal-body">
                    <div class="weg-detect-controls">
                        <select class="weg-select" id="weg-detect-strategy" aria-label="识别规则">
                            <option value="smart" ${_submodal.strategy === 'smart' ? 'selected' : ''}>智能综合识别（含 NSFW / 前缀 / 分隔条）</option>
                            <option value="scene" ${_submodal.strategy === 'scene' ? 'selected' : ''}>仅识别亲密剧情 (NSFW) 条目</option>
                            <option value="prefix" ${_submodal.strategy === 'prefix' ? 'selected' : ''}>仅按标题前缀（如【世界观】/ 18岁线-）</option>
                            <option value="divider" ${_submodal.strategy === 'divider' ? 'selected' : ''}>仅按分隔条区间（如 === 设定 ===）</option>
                            <option value="greeting" ${_submodal.strategy === 'greeting' ? 'selected' : ''}>仅按角色开场白联动注释</option>
                        </select>
                        <label class="weg-inline-check">
                            <input type="checkbox" id="weg-detect-only-ungrouped" ${_submodal.onlyUngrouped ? 'checked' : ''} />
                            <span>仅识别未分组条目</span>
                        </label>
                    </div>
                    <div class="weg-detect-list">${listHtml}</div>
                </div>
                <div class="weg-submodal-footer">
                    <button type="button" class="weg-btn weg-btn-subtle" data-weg-sub-close="1">取消</button>
                    <button type="button" class="weg-btn weg-btn-primary" id="weg-detect-apply-btn" ${checkedCount === 0 ? 'disabled' : ''}>应用所选分组 (${checkedCount})</button>
                </div>
            </div>
        `;
        wireAutoDetectSubmodal(host);
        return;
    }

    if (_submodal.type === 'settings') {
        const settings = getSettings();
        const hasBookGroups = Boolean(_currentBook && settings.books?.[_currentBook]);
        host.innerHTML = `
            <div class="weg-submodal-card" role="dialog" aria-label="面板设置">
                <div class="weg-submodal-header">
                    <span class="weg-submodal-title">外观与联动设置</span>
                    <button type="button" class="weg-icon-btn" data-weg-sub-close="1" aria-label="返回"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="weg-submodal-body weg-settings-list">
                    <div class="weg-setting-row">
                        <div class="weg-setting-text">
                            <div class="weg-setting-name">切换聊天存档时自动恢复本档路线</div>
                            <div class="weg-setting-desc">仅读取存档头元数据（零聊天记录扫描），切档自动恢复对应 IF 线</div>
                        </div>
                        <button type="button" class="weg-switch${settings.autoSwitchOnChatChange !== false ? ' is-on' : ''}" id="weg-set-auto-chat-switch" role="switch" aria-checked="${settings.autoSwitchOnChatChange !== false}">
                            <span class="weg-switch-thumb"></span>
                        </button>
                    </div>

                    <div class="weg-setting-row">
                        <div class="weg-setting-text">
                            <div class="weg-setting-name">按最近对话自动开关情境组（如 NSFW）</div>
                            <div class="weg-setting-desc">仅检测最新 1~2 条消息片段，有相关剧情时当轮开启，恢复日常后自动关闭</div>
                        </div>
                        <button type="button" class="weg-switch${settings.enableSceneAutoToggle !== false ? ' is-on' : ''}" id="weg-set-scene-auto" role="switch" aria-checked="${settings.enableSceneAutoToggle !== false}">
                            <span class="weg-switch-thumb"></span>
                        </button>
                    </div>

                    <div class="weg-setting-row">
                        <div class="weg-setting-text">
                            <div class="weg-setting-name">弹窗配色方案</div>
                            <div class="weg-setting-desc">独立弹窗实底配色，确保不同主题下清晰易读</div>
                        </div>
                        <select class="weg-select weg-setting-control" id="weg-set-palette">
                            <option value="paper" ${settings.palette === 'paper' ? 'selected' : ''}>素雅纸墨</option>
                            <option value="ink" ${settings.palette === 'ink' ? 'selected' : ''}>素纸青岚</option>
                            <option value="warm" ${settings.palette === 'warm' ? 'selected' : ''}>暖笺琥珀</option>
                            <option value="sakura" ${settings.palette === 'sakura' ? 'selected' : ''}>雾粉紫烟</option>
                            <option value="host" ${settings.palette === 'host' ? 'selected' : ''}>跟随酒馆</option>
                        </select>
                    </div>

                    <div class="weg-setting-row">
                        <div class="weg-setting-text">
                            <div class="weg-setting-name">明暗模式</div>
                            <div class="weg-setting-desc">可跟随当前酒馆背景明暗或固定浅色、深色</div>
                        </div>
                        <select class="weg-select weg-setting-control" id="weg-set-colormode">
                            <option value="auto" ${settings.colorMode === 'auto' ? 'selected' : ''}>跟随酒馆</option>
                            <option value="light" ${settings.colorMode === 'light' ? 'selected' : ''}>浅色模式</option>
                            <option value="dark" ${settings.colorMode === 'dark' ? 'selected' : ''}>深色模式</option>
                        </select>
                    </div>

                    <div class="weg-setting-row">
                        <div class="weg-setting-text">
                            <div class="weg-setting-name">显示原生编辑器分组按钮</div>
                            <div class="weg-setting-desc">在原生编辑器页码旁打开条目分组管理</div>
                        </div>
                        <button type="button" class="weg-switch${settings.showNativeEntryBtn !== false ? ' is-on' : ''}" id="weg-set-native-btn" role="switch" aria-checked="${settings.showNativeEntryBtn !== false}">
                            <span class="weg-switch-thumb"></span>
                        </button>
                    </div>

                    <div class="weg-setting-row">
                        <div class="weg-setting-text">
                            <div class="weg-setting-name">电脑宽屏定位时关闭本窗口</div>
                            <div class="weg-setting-desc">手机与窄屏定位时自动让出原生编辑器</div>
                        </div>
                        <button type="button" class="weg-switch${settings.closeOnLocate !== false ? ' is-on' : ''}" id="weg-set-close-locate" role="switch" aria-checked="${settings.closeOnLocate !== false}">
                            <span class="weg-switch-thumb"></span>
                        </button>
                    </div>

                    <div class="weg-setting-row">
                        <div class="weg-setting-text">
                            <div class="weg-setting-name">清空当前世界书的分组记录</div>
                            <div class="weg-setting-desc">仅重置插件内的分组归属，不修改世界书任何条目</div>
                        </div>
                        <button type="button" class="weg-btn weg-btn-danger weg-setting-control" id="weg-set-clear-book" ${hasBookGroups ? '' : 'disabled'}>清空本书分组</button>
                    </div>
                </div>
                <div class="weg-submodal-footer">
                    <button type="button" class="weg-btn weg-btn-primary" data-weg-sub-close="1">完成</button>
                </div>
            </div>
        `;
        wireSettingsSubmodal(host);
    }
}

function renderModeOptionHtml(modeValue, selectedMode, title, desc) {
    const active = modeValue === selectedMode;
    return `
        <label class="weg-mode-card${active ? ' is-active' : ''}">
            <input type="radio" name="weg_group_mode" value="${esc(modeValue)}" ${active ? 'checked' : ''} />
            <div class="weg-mode-card-body">
                <div class="weg-mode-card-title">${esc(title)}</div>
                <div class="weg-mode-card-desc">${esc(desc)}</div>
            </div>
        </label>
    `;
}

function wireCommonSubmodalClose(host) {
    host.querySelectorAll('[data-weg-sub-close]').forEach((btn) => {
        btn.addEventListener('click', () => closeSubmodal());
    });
}

function wireGroupFormSubmodal(host) {
    wireCommonSubmodalClose(host);
    const nameInput = host.querySelector('#weg-group-name-input');
    const clearBtn = host.querySelector('#weg-group-name-clear');
    const sceneExtra = host.querySelector('#weg-scene-extra');
    const sceneKwInput = host.querySelector('#weg-scene-kw-input');
    const sceneKwClear = host.querySelector('#weg-scene-kw-clear');
    const cooldownInput = host.querySelector('#weg-scene-cooldown-input');
    const saveBtn = host.querySelector('#weg-group-save-btn');
    const modeRadios = host.querySelectorAll('input[name="weg_group_mode"]');

    if (nameInput instanceof HTMLInputElement && !isNarrowViewport()) {
        requestAnimationFrame(() => {
            if (!nameInput.isConnected || !isDesktopAutoFocusAllowed()) return;
            nameInput.focus({ preventScroll: true });
            nameInput.select();
        });
    }

    clearBtn?.addEventListener('click', () => {
        if (nameInput instanceof HTMLInputElement) {
            nameInput.value = '';
            if (isDesktopAutoFocusAllowed()) nameInput.focus({ preventScroll: true });
        }
    });

    sceneKwClear?.addEventListener('click', () => {
        if (sceneKwInput instanceof HTMLInputElement) {
            sceneKwInput.value = '';
            if (isDesktopAutoFocusAllowed()) sceneKwInput.focus({ preventScroll: true });
        }
    });

    modeRadios.forEach((radio) => {
        radio.addEventListener('change', () => {
            if (!_submodal) return;
            _submodal.mode = radio.value;
            if (sceneExtra instanceof HTMLElement) {
                sceneExtra.hidden = radio.value !== GROUP_MODES.SCENE;
            }
            host.querySelectorAll('.weg-mode-card').forEach((card) => {
                const inp = card.querySelector('input[name="weg_group_mode"]');
                card.classList.toggle('is-active', Boolean(inp?.checked));
            });
        });
    });

    const submit = () => {
        if (!_submodal || !_currentBook) return;
        const rawName = nameInput instanceof HTMLInputElement ? nameInput.value.trim() : '';
        if (!rawName) {
            showToast('warning', '请填写分组名称');
            return;
        }

        const settings = getSettings();
        const bookCfg = getBookConfigMutable(settings, _currentBook);
        const duplicate = bookCfg.groups.find((g) => g.name === rawName && g.id !== _submodal.groupId);
        if (duplicate) {
            showToast('warning', `已存在同名分组「${rawName}」`);
            return;
        }

        pushUndoSnapshot(_currentBook, bookCfg);
        const chosenMode = (
            _submodal.mode === GROUP_MODES.IF_LINE ||
            _submodal.mode === GROUP_MODES.RADIO ||
            _submodal.mode === GROUP_MODES.SCENE
        )
            ? _submodal.mode
            : GROUP_MODES.NORMAL;

        const kwList = sceneKwInput instanceof HTMLInputElement
            ? normalizeKeywordList(sceneKwInput.value)
            : [];
        const rawCd = cooldownInput instanceof HTMLInputElement
            ? Number.parseInt(cooldownInput.value, 10)
            : 2;
        const cooldownTurns = Number.isInteger(rawCd) ? Math.max(1, Math.min(10, rawCd)) : 2;

        if (_submodal.groupId) {
            const target = bookCfg.groups.find((g) => g.id === _submodal.groupId);
            if (target) {
                target.name = rawName;
                target.mode = chosenMode;
                target.sceneKeywords = kwList;
                target.cooldownTurns = cooldownTurns;
            }
        } else {
            bookCfg.groups.push({
                id: createGroupId('grp'),
                name: rawName,
                mode: chosenMode,
                collapsed: false,
                sceneKeywords: kwList,
                cooldownTurns,
            });
        }

        saveBookConfigWithCleanEmpty(settings, _currentBook, bookCfg);
        closeSubmodal();
        renderModalContents();
    };

    saveBtn?.addEventListener('click', submit);
    let nameComposing = false;
    nameInput?.addEventListener('compositionstart', () => {
        nameComposing = true;
    });
    nameInput?.addEventListener('compositionend', () => {
        nameComposing = false;
    });
    nameInput?.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && !ev.isComposing && !nameComposing && !_isComposing && ev.keyCode !== 229) {
            ev.preventDefault();
            submit();
        }
    });
}

function wireBatchMoveSubmodal(host) {
    wireCommonSubmodalClose(host);
    const uids = _submodal?.uids || [];
    const quickInput = host.querySelector('#weg-quick-new-group-input');
    const quickClear = host.querySelector('#weg-quick-new-clear');
    const quickMoveBtn = host.querySelector('#weg-quick-new-move-btn');

    const applyMoveToGroupId = (targetGroupId, targetLabel) => {
        if (!_currentBook || uids.length === 0) return;
        const settings = getSettings();
        const bookCfg = getBookConfigMutable(settings, _currentBook);
        pushUndoSnapshot(_currentBook, bookCfg);

        for (const uid of uids) {
            if (targetGroupId === SPECIAL_GROUP_UNGROUPED) {
                delete bookCfg.assignments[uid];
            } else {
                bookCfg.assignments[uid] = targetGroupId;
            }
        }

        saveBookConfigWithCleanEmpty(settings, _currentBook, bookCfg);
        for (const uid of uids) _selectedUids.delete(uid);
        closeSubmodal();
        renderModalContents();
        showToast('success', `已将 ${uids.length} 个条目移入「${targetLabel}」`);
    };

    host.querySelectorAll('[data-weg-move-target]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const gid = btn.getAttribute('data-weg-move-target') || SPECIAL_GROUP_UNGROUPED;
            const settings = getSettings();
            const bookCfg = getBookConfigMutable(settings, _currentBook);
            const label = gid === SPECIAL_GROUP_UNGROUPED
                ? '未分组'
                : (bookCfg.groups.find((g) => g.id === gid)?.name || '目标分组');
            applyMoveToGroupId(gid, label);
        });
    });

    quickClear?.addEventListener('click', () => {
        if (quickInput instanceof HTMLInputElement) {
            quickInput.value = '';
            if (isDesktopAutoFocusAllowed()) quickInput.focus({ preventScroll: true });
        }
    });

    const createAndMove = () => {
        const name = quickInput instanceof HTMLInputElement ? quickInput.value.trim() : '';
        if (!name) {
            showToast('warning', '请先输入新分组名称');
            return;
        }
        const settings = getSettings();
        const bookCfg = getBookConfigMutable(settings, _currentBook);
        let group = bookCfg.groups.find((g) => g.name === name);
        pushUndoSnapshot(_currentBook, bookCfg);
        if (!group) {
            group = {
                id: createGroupId('grp'),
                name,
                mode: GROUP_MODES.NORMAL,
                collapsed: false,
                sceneKeywords: [],
                cooldownTurns: 2,
            };
            bookCfg.groups.push(group);
        }
        for (const uid of uids) {
            bookCfg.assignments[uid] = group.id;
        }
        saveBookConfigWithCleanEmpty(settings, _currentBook, bookCfg);
        for (const uid of uids) _selectedUids.delete(uid);
        closeSubmodal();
        renderModalContents();
        showToast('success', `已新建分组「${name}」并移入 ${uids.length} 个条目`);
    };

    quickMoveBtn?.addEventListener('click', createAndMove);
    let quickComposing = false;
    quickInput?.addEventListener('compositionstart', () => {
        quickComposing = true;
    });
    quickInput?.addEventListener('compositionend', () => {
        quickComposing = false;
    });
    quickInput?.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && !ev.isComposing && !quickComposing && !_isComposing && ev.keyCode !== 229) {
            ev.preventDefault();
            createAndMove();
        }
    });
}

function wireAutoDetectSubmodal(host) {
    wireCommonSubmodalClose(host);
    const strategySelect = host.querySelector('#weg-detect-strategy');
    const onlyUngroupedCheck = host.querySelector('#weg-detect-only-ungrouped');
    const applyBtn = host.querySelector('#weg-detect-apply-btn');

    const recomputeProposals = () => {
        if (!_submodal || !_currentBook) return;
        const settings = getSettings();
        const bookCfg = getBookConfigMutable(settings, _currentBook);
        const strategy = strategySelect instanceof HTMLSelectElement ? strategySelect.value : 'smart';
        const onlyUngrouped = onlyUngroupedCheck instanceof HTMLInputElement ? onlyUngroupedCheck.checked : true;
        const nextProposals = detectAutoGroups(_loadedSummaries, {
            strategy,
            onlyUngrouped,
            existingAssignments: bookCfg.assignments,
            greetingIndex: _greetingIndex,
        });
        _submodal.strategy = strategy;
        _submodal.onlyUngrouped = onlyUngrouped;
        _submodal.proposals = nextProposals.map((p) => ({ ...p, checked: true, mode: p.suggestedMode }));
        renderSubmodalHost();
    };

    strategySelect?.addEventListener('change', recomputeProposals);
    onlyUngroupedCheck?.addEventListener('change', recomputeProposals);

    host.querySelectorAll('[data-weg-detect-idx]').forEach((cb) => {
        cb.addEventListener('change', () => {
            if (!_submodal) return;
            const idx = Number(cb.getAttribute('data-weg-detect-idx'));
            if (_submodal.proposals[idx]) {
                _submodal.proposals[idx].checked = cb.checked;
            }
            const checkedCount = _submodal.proposals.filter((p) => p.checked).length;
            if (applyBtn instanceof HTMLButtonElement) {
                applyBtn.disabled = checkedCount === 0;
                applyBtn.textContent = `应用所选分组 (${checkedCount})`;
            }
        });
    });

    host.querySelectorAll('[data-weg-detect-mode]').forEach((sel) => {
        sel.addEventListener('change', () => {
            if (!_submodal) return;
            const idx = Number(sel.getAttribute('data-weg-detect-mode'));
            if (_submodal.proposals[idx]) {
                _submodal.proposals[idx].mode = sel.value;
            }
        });
    });

    applyBtn?.addEventListener('click', () => {
        if (!_submodal || !_currentBook) return;
        const chosen = (_submodal.proposals || []).filter((p) => p.checked);
        if (chosen.length === 0) return;

        const settings = getSettings();
        const bookCfg = getBookConfigMutable(settings, _currentBook);
        pushUndoSnapshot(_currentBook, bookCfg);

        const nextCfg = applyAutoGroupProposals(bookCfg, chosen, {
            replaceExisting: !_submodal.onlyUngrouped,
        });
        saveBookConfigWithCleanEmpty(settings, _currentBook, nextCfg);
        closeSubmodal();
        renderModalContents();
        showToast('success', `已生成 ${chosen.length} 个条目分组，点底部「撤销」可随时还原`);
    });
}

function wireSettingsSubmodal(host) {
    wireCommonSubmodalClose(host);
    const settings = getSettings();

    const autoChatSwitch = host.querySelector('#weg-set-auto-chat-switch');
    const sceneAutoSwitch = host.querySelector('#weg-set-scene-auto');
    const paletteSel = host.querySelector('#weg-set-palette');
    const modeSel = host.querySelector('#weg-set-colormode');
    const nativeBtnSwitch = host.querySelector('#weg-set-native-btn');
    const closeLocateSwitch = host.querySelector('#weg-set-close-locate');
    const clearBookBtn = host.querySelector('#weg-set-clear-book');

    paletteSel?.addEventListener('change', () => {
        if (paletteSel instanceof HTMLSelectElement) {
            settings.palette = paletteSel.value;
            notifySettingsChanged();
            renderModalContents();
        }
    });

    modeSel?.addEventListener('change', () => {
        if (modeSel instanceof HTMLSelectElement) {
            settings.colorMode = modeSel.value;
            notifySettingsChanged();
            renderModalContents();
        }
    });

    const bindSwitch = (el, key, onAfter) => {
        el?.addEventListener('click', () => {
            settings[key] = !settings[key];
            notifySettingsChanged();
            onAfter?.();
            renderSubmodalHost();
            renderBodyAndFooterOnly();
        });
    };

    bindSwitch(autoChatSwitch, 'autoSwitchOnChatChange');
    bindSwitch(sceneAutoSwitch, 'enableSceneAutoToggle');
    bindSwitch(nativeBtnSwitch, 'showNativeEntryBtn');
    bindSwitch(closeLocateSwitch, 'closeOnLocate');

    clearBookBtn?.addEventListener('click', () => {
        if (!_currentBook || !settings.books?.[_currentBook]) return;
        pushUndoSnapshot(_currentBook, settings.books[_currentBook]);
        delete settings.books[_currentBook];
        notifySettingsChanged();
        closeSubmodal();
        renderModalContents();
        showToast('info', `已清空「${_currentBook}」的分组配置，点底部撤销可恢复`);
    });
}
