/** Worldbook group manager and inline previews. */

import { scrollContentToItem } from './content-scroll.js';
import { bindManagerTouchDrag } from './manager-touch-drag.js';
import {
    _callbacks,
    _modalWindowCleanupMap,
    _previewCache,
    applyThemeClass,
    attachModalWindowControls,
    bindDrawerSafeBubbleGuard,
    bindImeSafeEnter,
    CHAR_TOGGLE_BTN_ID,
    cleanupOverlayWindowControls,
    closeGroupVisibilityPopover,
    closeSubModal,
    createSubModal,
    esc,
    GROUP_MGR_OVERLAY_ID,
    isDesktopAutoFocusAllowed,
    MANAGER_OVERLAY_ID,
    openInlineTextPrompt,
    PROMPT_OVERLAY_ID,
    stableWindowHeight,
    WAND_ENTRY_ID,
    WI_QUICK_ACTIONS_ID,
} from './panel-window.js';
import {
    applyTauriSurface,
    deleteWorldbooksFromHost,
    getActiveGlobalWorldSet,
    getCharLoreEntries,
    getCharactersInMemory,
    getCurrentEditorWorldName,
    getHostContext,
    getPowerUserSettings,
    realRenameWorldbook,
    showToast,
} from './host.js';
import {
    disconnectNativeCharBtnWidthObserver,
    executeGlobalBooksSwitch,
    openGlobalCombosModal,
    openGroupVisibilityPopover,
    syncManagerComboStripUi,
    syncNativeQuickActionsUi,
    syncNativeQuickComboTitles,
    takeGlobalSwitchUndo,
} from './panel-quick.js';
import {
    addCustomGroup,
    buildCharacterBindingIndex,
    buildPersonaBindingIndex,
    cleanupDeletedWorldSettings,
    computeScanPromptState,
    findUnscannedShallowCharacters,
    getVisibleSectionMoveBounds,
    GROUP_COLOR_PALETTE,
    matchesSearch,
    moveSectionOrder,
    partitionGroupPickerBooks,
    promoteSectionToTop,
    pushUndoSnapshot,
    reorderBookInGroup,
    reorderSection,
    SPECIAL_GROUPS,
    togglePinnedBook,
} from './core.js';
import { mountEntryAccordion } from './entry-accordion.js';
import {
    openWorldInNativeEditor,
    setGlobalWorldActive,
} from './native-filter.js';
import {
    _mgrInlineEntrySignal,
    cancelManagerInlineEntrySearch,
    clearManagerInlineEntryResults,
    openBookEntryBrowserModal,
    openEntrySearchModal,
    openManagerSearchOptionsPopover,
    runManagerInlineEntrySearch,
    syncManagerSearchBarUi,
} from './panel-search.js';
import { openAiOrganizeModal } from './panel-organize.js';
import { openCharacterBindingModal } from './panel-binding.js';
import { openScanAndImportModal } from './panel-scan.js';
import { openSettingsModal } from './panel-settings.js';
import { isEntryGroupingAvailable } from './entry-groups/lifecycle.js';
import { ENTRY_GROUPING_STATE_CHANGED } from './entry-groups/feature-gate.js';

const SETTINGS_ROOT_ID = 'wbo-extension-settings';
const ACTIVE_GLOBAL_SECTION_ID = '__active_globals__';

let _searchQuery = '';

let _isComposing = false;

let _lastModalListSig = null;

let _batchMode = false;

let _mgrSearchTimer = null;

/** @type {(() => void) | null} */
let _syncFloatingGroupManager = null;

/** @type {Set<string>} */
const _batchSelected = new Set();

/** @type {Map<string, string[]>} */
const _renderedGroupBooksMap = new Map();

/** @type {Map<string, any>} */
const _activePreviewControllers = new Map();

function syncPreviewEntryGrouping() {
    const available = isEntryGroupingAvailable();
    for (const [bookName, controller] of _activePreviewControllers) {
        controller.setEntryGroupingAction?.(available ? () => openEntryGroupsForBook(bookName) : null);
    }
    if (!available) document.querySelector('.wbo-book-more-popover [data-more-act="entry-groups"]')?.remove();
}

let _hasPendingPinResort = false;

let _hasPendingDeferredListRender = false;

/** @type {string[]} */
let _renderedMovableSectionIds = [];

const MAX_PREVIEW_CACHE_BOOKS = 8;

const MAX_PREVIEW_CACHE_BOOKS_MOBILE = 3;

function destroyAllPreviewControllers() {
    for (const ctrl of _activePreviewControllers.values()) {
        try { ctrl?.destroy?.(); } catch { /* ignore */ }
    }
    _activePreviewControllers.clear();
}

function getPreviewCacheLimit() {
    const w = globalThis.innerWidth || (typeof document !== 'undefined' ? document.documentElement?.clientWidth : 0) || 1200;
    return w <= 680 ? MAX_PREVIEW_CACHE_BOOKS_MOBILE : MAX_PREVIEW_CACHE_BOOKS;
}

function setPreviewCache(bookName, data) {
    if (!bookName) return;
    if (_previewCache.has(bookName)) _previewCache.delete(bookName);
    _previewCache.set(bookName, data);
    const limit = getPreviewCacheLimit();
    while (_previewCache.size > limit) {
        const oldest = _previewCache.keys().next().value;
        if (oldest === undefined) break;
        _previewCache.delete(oldest);
    }
}

/**
 * Invalidate cached entry preview(s) (e.g. after `weg:entries-toggled`) and
 * refresh any currently expanded inline preview for that book.
 * @param {string | null} [worldName=null]
 */
function invalidatePreviewCache(worldName = null) {
    const clean = typeof worldName === 'string' ? worldName.trim() : '';
    if (clean) {
        _previewCache.delete(clean);
    } else {
        _previewCache.clear();
    }
    if (typeof document === 'undefined' || !clean) return;
    const activeCtrl = _activePreviewControllers.get(clean);
    if (activeCtrl && typeof activeCtrl.refresh === 'function') {
        void activeCtrl.refresh();
    }
}

function openEntryGroupsForBook(worldName) {
    try {
        if (typeof window !== 'undefined' && typeof CustomEvent === 'function') {
            window.dispatchEvent(new CustomEvent('weg:open-panel', { detail: { worldName } }));
            return true;
        }
    } catch {
        // Ignore
    }
    return false;
}

/**
 * Sync the native inline char-toggle icon AND the Group Manager modal (ONLY if open — 0 work when closed!).
 */
function renderEmbeddedPanel({ backgroundCatchUp = false } = {}) {
    if (!_callbacks) return;
    syncNativeQuickActionsUi();

    // Only refresh Group Manager when it is actually open (0 background scanning when closed!)
    if (document.getElementById(MANAGER_OVERLAY_ID)) {
        refreshManagerModalContent({ backgroundCatchUp });
    }
}

let _isSyncingEmbeddedIndicators = false;

/**
 * Lightweight in-place sync when native `#world_info` or `#world_editor_select` changes.
 * Updates both per-row global pills AND group header active counts with zero DOM rebuild!
 */
function syncEmbeddedPanelIndicators() {
    if (_isSyncingEmbeddedIndicators) return;
    _isSyncingEmbeddedIndicators = true;
    try {
        syncNativeQuickComboTitles();
        syncManagerComboStripUi();
        const listEl = document.getElementById('wbo-mgr-groups-list');
        if (!listEl) return;

        const activeGlobals = getActiveGlobalWorldSet();
        const currentEditor = getCurrentEditorWorldName();

        if (_callbacks) {
            const { settings, classification } = _callbacks.getState();
            const isAllView = settings.activeFilterGroupId === SPECIAL_GROUPS.ALL ||
                (settings.activeFilterGroupId === SPECIAL_GROUPS.DEFAULT && settings.showCharBooks);
            if (isAllView && listEl.dataset.wboActiveGlobals !== JSON.stringify([...activeGlobals])) {
                if (_activePreviewControllers.size > 0) {
                    _hasPendingDeferredListRender = true;
                } else if (renderManagerGroupsListOnly({ skipIndicatorSync: true })) {
                    return;
                }
            }
            const editingMeta = currentEditor ? classification?.byName?.get(currentEditor) : null;
            const q = _searchQuery.trim();
            const searchOpts = {
                searchBookName: settings.mgrSearchInBookName !== false,
                searchCharName: settings.mgrSearchInCharName !== false,
                splitSpaces: Boolean(settings.mgrSearchSplitSpaces),
            };
            const needsBareEditing = Boolean(
                settings.activeFilterGroupId === SPECIAL_GROUPS.DEFAULT &&
                !settings.showCharBooks &&
                editingMeta?.isInCharGroup &&
                (!q || matchesSearch(editingMeta, q, searchOpts)),
            );
            const hasBareEditing = Boolean(listEl.querySelector('.wbo-mgr-bare-editing'));
            const curBareBook = listEl.querySelector('.wbo-mgr-bare-editing .wbo-book-row')?.getAttribute('data-book') || '';
            if (needsBareEditing !== hasBareEditing || (needsBareEditing && curBareBook !== currentEditor)) {
                const rebuilt = renderManagerGroupsListOnly({ skipIndicatorSync: true });
                if (rebuilt) return;
            }
        }

        listEl.querySelectorAll('.wbo-book-row').forEach((row) => {
            const name = row.getAttribute('data-book');
            if (!name) return;
            const isActive = activeGlobals.has(name);
            const isEditing = currentEditor === name;
            const globalBtn = row.querySelector('[data-action="toggle-global"]');
            row.classList.toggle('is-active', Boolean(globalBtn && isActive));
            row.classList.toggle('is-editing', isEditing);
            const titleLine = row.querySelector('.wbo-book-title-line');
            if (titleLine) {
                const existingBadge = titleLine.querySelector('.wbo-s2-badge.is-editing');
                if (isEditing && !existingBadge) {
                    const badge = document.createElement('span');
                    badge.className = 'wbo-s2-badge is-editing';
                    badge.setAttribute('data-wbo-ui', '1');
                    badge.textContent = '当前编辑';
                    const subEl = titleLine.querySelector('.wbo-book-sub');
                    const anchorEl = subEl || titleLine.querySelector('.wbo-book-title');
                    if (anchorEl) anchorEl.insertAdjacentElement('afterend', badge);
                    else titleLine.appendChild(badge);
                } else if (!isEditing && existingBadge) {
                    existingBadge.remove();
                }
            }
            if (globalBtn) {
                globalBtn.classList.toggle('is-on', isActive);
                globalBtn.innerHTML = isActive
                    ? '<i class="fa-solid fa-check"></i><span>已全局</span>'
                    : '<span>全局</span>';
                globalBtn.setAttribute('title', isActive ? '点击取消全局激活' : '点击设为全局激活');
            }
        });

        // Update each group header active/total counter cleanly in place
        listEl.querySelectorAll('.wbo-group').forEach((groupEl) => {
            const countEl = groupEl.querySelector('.wbo-group-count');
            if (!countEl) return;
            const total = Number(groupEl.getAttribute('data-book-count'));
            if (!Number.isFinite(total)) return;
            const rows = groupEl.querySelectorAll('.wbo-book-row');
            if (rows.length > 0) {
                let activeCount = 0;
                rows.forEach((r) => {
                    const n = r.getAttribute('data-book');
                    if (n && activeGlobals.has(n)) activeCount += 1;
                });
                countEl.textContent = activeCount > 0 ? `${activeCount}/${total}` : `${total}`;
            }
        });
    } finally {
        _isSyncingEmbeddedIndicators = false;
    }
}

// ==================== Standalone Group Manager Modal ====================

/**
 * Render one worldbook row inside the Group Manager modal:
 * - Character worldbooks have NO global activation toggle (prevents accidental global enabling!)
 * - Non-character worldbooks use an explicit right-side `全局 / 已全局` button instead of a misclick-prone left checkbox
 */
function renderBookRowHtml(book, activeGlobals, currentEditor, embeddedMatchSet = null) {
    const isActive = activeGlobals.has(book.realName);
    const isEditing = currentEditor === book.realName;
    const isExtraChar = book.isInCharGroup && book.charOwners?.every((o) => o.source === 'extra');

    const extraTag = isExtraChar ? '<span class="wbo-tag">附加</span>' : '';
    const localSameNameTag = embeddedMatchSet?.has(book.realName)
        ? '<span class="wbo-tag is-warn" title="本地同名文件，未绑定到当前角色卡，多为旧版残留">本地同名</span>'
        : '';
    const ownerHint = book.isCharBound && !book.isInCharGroup
        ? `<span class="wbo-tag" title="绑定角色：${esc(book.charOwners.map((o) => o.charName).join('、'))}">${esc(book.charOwners[0]?.charName || '')}</span>`
        : '';
    const personaHint = book.personaOwners?.length
        ? `<span class="wbo-tag" title="绑定人设：${esc(book.personaOwners.join('、'))}">人设</span>`
        : '';
    const subHtml = book.subtitle
        ? `<span class="wbo-book-sub" title="${esc(book.realName)}">${esc(book.subtitle)}</span>`
        : '';
    const editingBadgeHtml = isEditing
        ? '<span class="wbo-s2-badge is-editing" data-wbo-ui="1">当前编辑</span>'
        : '';
    const noteHtml = book.note
        ? `<div class="wbo-book-note">${esc(book.note)}</div>`
        : '';

    // Never offer global-enable button on character-group books
    const globalBtnHtml = book.isInCharGroup
        ? ''
        : `
            <button type="button"
                class="wbo-global-pill${isActive ? ' is-on' : ''}"
                data-action="toggle-global"
                title="${isActive ? '点击取消全局激活' : '点击设为全局激活'}">
                ${isActive ? '<i class="fa-solid fa-check"></i><span>已全局</span>' : '<span>全局</span>'}
            </button>
        `;

    const batchChecked = _batchSelected.has(book.realName);
    const batchCheckHtml = _batchMode
        ? `<input type="checkbox" class="wbo-batch-check" data-action="toggle-batch-item" value="${esc(book.realName)}"${batchChecked ? ' checked' : ''}>`
        : '';

    const mainAction = _batchMode ? 'toggle-batch-row' : 'toggle-book-preview';
    const mainTitle = _batchMode ? '点击勾选或取消勾选' : '点击展开条目列表，可拖动调序或拖入分组';

    return `
        <div class="wbo-book-item" data-book="${esc(book.realName)}">
            <div class="wbo-book-row${isActive && !book.isInCharGroup ? ' is-active' : ''}${isEditing ? ' is-editing' : ''}${_batchMode && batchChecked ? ' is-batch-selected' : ''}" data-book="${esc(book.realName)}">
                <span class="wbo-drag-handle" title="${_batchMode ? '拖动移动当前项或全部已勾选项' : '拖动调序或移入分组'}"><i class="fa-solid fa-grip-vertical"></i></span>
                ${batchCheckHtml}
                <div role="button" tabindex="0" class="wbo-book-main" data-action="${mainAction}" title="${mainTitle}">
                    <i class="fa-solid fa-chevron-right wbo-book-chev"></i>
                    <span class="wbo-book-text-col">
                        <span class="wbo-book-title-line">
                            <span class="wbo-book-title">${esc(book.primaryTitle)}</span>
                            ${subHtml}
                            ${editingBadgeHtml}
                            ${localSameNameTag}
                            ${extraTag}
                            ${ownerHint}
                            ${personaHint}
                        </span>
                        ${noteHtml}
                    </span>
                </div>
                <div class="wbo-book-actions">
                    ${globalBtnHtml}
                    <button type="button" class="wbo-icon-btn wbo-icon-danger wbo-book-delete-btn" data-action="delete-single-book" title="删除世界书" aria-label="删除世界书">
                        <i class="fa-regular fa-trash-can" aria-hidden="true"></i>
                    </button>
                    <button type="button" class="wbo-icon-btn wbo-book-more-btn" data-action="book-more-menu" title="更多操作" aria-label="更多操作" aria-expanded="false">
                        <i class="fa-solid fa-ellipsis" aria-hidden="true"></i>
                    </button>
                    <button type="button"
                        class="wbo-icon-btn wbo-star-btn${book.isPinned ? ' is-pinned' : ''}"
                        data-action="toggle-pin-book"
                        title="${book.isPinned ? '取消收藏' : '收藏此世界书'}"
                        aria-pressed="${book.isPinned ? 'true' : 'false'}">
                        <i class="${book.isPinned ? 'fa-solid' : 'fa-regular'} fa-star"></i>
                    </button>
                </div>
            </div>
            <div class="wbo-book-preview" hidden></div>
        </div>
    `;
}

/**
 * Toggle inline on-demand entry accordion directly below a worldbook row inside the Group Manager modal.
 * @param {HTMLElement} itemEl
 * @param {string} bookName
 */
async function toggleInlineBookPreview(itemEl, bookName) {
    const previewEl = itemEl.querySelector('.wbo-book-preview');
    const rowEl = itemEl.querySelector('.wbo-book-row');
    if (!(previewEl instanceof HTMLElement)) return;

    const willOpen = previewEl.hidden;
    if (!willOpen) {
        const existingCtrl = _activePreviewControllers.get(bookName);
        if (existingCtrl?.hasDirtyEditors?.() && !globalThis.confirm('该世界书内有未保存的条目修改，确定放弃修改并收起吗？')) {
            return;
        }
        existingCtrl?.destroy?.();
        _activePreviewControllers.delete(bookName);
        previewEl.innerHTML = '';
        previewEl.hidden = true;
        rowEl?.classList.remove('is-preview-open');
        if (_activePreviewControllers.size === 0 && _hasPendingDeferredListRender) {
            _hasPendingDeferredListRender = false;
            renderManagerGroupsListOnly();
        }
        return;
    }

    const staleCtrl = _activePreviewControllers.get(bookName);
    if (staleCtrl) {
        staleCtrl.destroy?.();
        _activePreviewControllers.delete(bookName);
    }

    previewEl.hidden = false;
    rowEl?.classList.add('is-preview-open');

    const ctrl = mountEntryAccordion(previewEl, {
        worldName: bookName,
        pageSize: 60,
        showToolbar: true,
        onOpenEntryGroups: isEntryGroupingAvailable() ? () => openEntryGroupsForBook(bookName) : null,
        getMonoFont: () => Boolean(_callbacks?.getState?.()?.settings?.entryEditorMonoFont),
        onToggleMonoFont: (nextMono) => {
            const curSettings = _callbacks?.getState?.()?.settings;
            if (!curSettings) return;
            curSettings.entryEditorMonoFont = Boolean(nextMono);
            void _callbacks.onMutation({ save: true, uiOnly: true });
        },
        getTallMode: () => Boolean(_callbacks?.getState?.()?.settings?.entryEditorTall),
        onToggleTallMode: (nextTall) => {
            const curSettings = _callbacks?.getState?.()?.settings;
            if (!curSettings) return;
            curSettings.entryEditorTall = Boolean(nextTall);
            void _callbacks.onMutation({ save: true, uiOnly: true });
        },
        getSyncOrder: () => Boolean(_callbacks?.getState?.()?.settings?.syncEntryOrderOnDrag),
        onEntryMutated: ({ worldName: mutatedWorld }) => {
            _previewCache.delete(mutatedWorld);
        },
        onOpenNative: (uid) => {
            openWorldInNativeEditor(bookName, { focusUid: uid || null });
            closeManagerModal();
        },
    });
    _activePreviewControllers.set(bookName, ctrl);
}

/**
 * Assign a worldbook to a target group (`customId`, `UNGROUPED`, or `CHARACTER`).
 */
function assignBookToGroup(settings, bookMeta, targetGroupId) {
    if (!bookMeta || !targetGroupId) return false;
    const hasRealBinding = Boolean(
        (bookMeta.charOwners || []).some((o) => o && o.source !== 'embedded'),
    );
    const needsIncludeConfirm =
        targetGroupId === SPECIAL_GROUPS.CHARACTER &&
        !hasRealBinding &&
        settings.charBookOverrides?.[bookMeta.realName] !== 'include_in_char';
    if (bookMeta.groupId === targetGroupId && !needsIncludeConfirm) return false;

    settings.assignments ||= {};
    settings.charBookOverrides ||= {};

    if (targetGroupId === SPECIAL_GROUPS.CHARACTER) {
        delete settings.assignments[bookMeta.realName];
        if (hasRealBinding) {
            delete settings.charBookOverrides[bookMeta.realName];
        } else {
            settings.charBookOverrides[bookMeta.realName] = 'include_in_char';
        }
        return true;
    }

    if (targetGroupId === SPECIAL_GROUPS.UNGROUPED) {
        delete settings.assignments[bookMeta.realName];
        if (bookMeta.isCharBound) {
            settings.charBookOverrides[bookMeta.realName] = 'exclude_from_char';
        } else if (settings.charBookOverrides?.[bookMeta.realName] === 'include_in_char') {
            delete settings.charBookOverrides[bookMeta.realName];
        }
        return true;
    }

    settings.assignments[bookMeta.realName] = targetGroupId;
    if (bookMeta.isCharBound) {
        settings.charBookOverrides[bookMeta.realName] = 'exclude_from_char';
    } else if (settings.charBookOverrides?.[bookMeta.realName] === 'include_in_char') {
        delete settings.charBookOverrides[bookMeta.realName];
    }
    return true;
}

/**
 * Short display label for the inline character-worldbook title mode pill.
 * @param {string} mode
 * @returns {string}
 */
function getCharTitleModeShortLabel(mode) {
    if (mode === 'char_only') return '仅角色名';
    if (mode === 'original') return '原标题';
    return '角色+原名';
}

/**
 * Render one collapsible group section with sticky header and drag-reorder support.
 */
function renderGroupSectionHtml({
    id,
    name,
    color,
    collapsed,
    isCustom,
    isSingleView = false,
    hideOrderActions = false,
    charBookTitleMode = 'char_with_sub',
    hiddenInGlobal = false,
    hiddenInEditor = false,
    canMoveUp,
    canMoveDown,
    books,
    activeGlobals,
    currentEditor,
    embeddedMatchSet = null,
}) {
    const activeCount = books.filter((b) => activeGlobals.has(b.realName)).length;
    const countLabel = activeCount > 0 ? `${activeCount}/${books.length}` : `${books.length}`;
    const charTitlePill = id === SPECIAL_GROUPS.CHARACTER
        ? `
            <button type="button" class="wbo-char-mode-pill" data-action="cycle-char-title-mode" title="切换角色世界书标题显示：角色+原名 / 仅角色名 / 原标题">
                <i class="fa-solid fa-font"></i>
                <span>${esc(getCharTitleModeShortLabel(charBookTitleMode))}</span>
            </button>
        `
        : '';
    const visHiddenAny = hiddenInGlobal || hiddenInEditor;
    const visLabel = hiddenInGlobal && hiddenInEditor
        ? '双隐'
        : hiddenInGlobal
            ? '全局隐'
            : hiddenInEditor
                ? '编辑隐'
                : '';
    const visTitle = hiddenInGlobal && hiddenInEditor
        ? '已在全局框和编辑框默认隐藏，点击修改'
        : hiddenInGlobal
            ? '已在全局激活框默认隐藏，点击修改'
            : hiddenInEditor
                ? '已在编辑下拉框默认隐藏，点击修改'
                : '设置该分组在全局框 / 编辑框中的默认显隐';
    const visActionBtn = id === SPECIAL_GROUPS.PINNED || id === ACTIVE_GLOBAL_SECTION_ID
        ? ''
        : visHiddenAny
            ? `
                <button type="button" class="wbo-group-vis-pill" data-action="open-group-visibility" data-group-id="${esc(id)}" data-group-name="${esc(name)}" title="${esc(visTitle)}">
                    <i class="fa-solid fa-eye-slash"></i>
                    <span>${esc(visLabel)}</span>
                </button>
            `
            : `
                <button type="button" class="wbo-icon-btn wbo-group-vis-btn" data-action="open-group-visibility" data-group-id="${esc(id)}" data-group-name="${esc(name)}" title="${esc(visTitle)}">
                    <i class="fa-solid fa-eye"></i>
                </button>
            `;
    const disableReorder = isSingleView || hideOrderActions;
    const orderActions = disableReorder
        ? ''
        : `
            <button type="button" class="wbo-icon-btn" data-action="move-section-up" data-group-id="${esc(id)}" ${canMoveUp ? '' : 'disabled'} title="上移">
                <i class="fa-solid fa-arrow-up"></i>
            </button>
            <button type="button" class="wbo-icon-btn" data-action="move-section-down" data-group-id="${esc(id)}" ${canMoveDown ? '' : 'disabled'} title="下移">
                <i class="fa-solid fa-arrow-down"></i>
            </button>
        `;
    const customActions = isCustom
        ? `
            <button type="button" class="wbo-icon-btn" data-action="rename-group" data-group-id="${esc(id)}" title="编辑分组与世界书">
                <i class="fa-solid fa-pen"></i>
            </button>
            <button type="button" class="wbo-icon-btn" data-action="delete-group" data-group-id="${esc(id)}" title="删除分组">
                <i class="fa-solid fa-trash-can"></i>
            </button>
        `
        : '';

    const rowsHtml = collapsed
        ? ''
        : (books.length > 0
            ? `<div class="wbo-group-body">${books.map((b) => renderBookRowHtml(b, activeGlobals, currentEditor, embeddedMatchSet)).join('')}</div>`
            : `<div class="wbo-group-body wbo-empty-hint">暂无世界书，可直接拖动世界书到此处</div>`);

    const batchGroupCheckHtml = _batchMode
        ? `<input type="checkbox" class="wbo-batch-check wbo-batch-group-check" data-action="toggle-batch-group" data-group-id="${esc(id)}" title="全选或取消全选本组世界书"${books.length === 0 ? ' disabled' : ''}>`
        : '';

    const titleNode = isSingleView
        ? `
            ${batchGroupCheckHtml}
            <div class="wbo-group-toggle is-static">
                <span class="wbo-group-dot" style="background:${esc(color)}"></span>
                <span class="wbo-group-name">${esc(name)}</span>
                <span class="wbo-group-count">${esc(countLabel)}</span>
            </div>
        `
        : `
            ${disableReorder ? '' : '<span class="wbo-group-drag-handle" title="拖动调整分组顺序"><i class="fa-solid fa-grip-vertical"></i></span>'}
            ${batchGroupCheckHtml}
            <button type="button" class="wbo-group-toggle" data-action="toggle-group-collapse" data-group-id="${esc(id)}" aria-expanded="${!collapsed}">
                <i class="fa-solid ${collapsed ? 'fa-chevron-right' : 'fa-chevron-down'} wbo-chevron"></i>
                <span class="wbo-group-dot" style="background:${esc(color)}"></span>
                <span class="wbo-group-name">${esc(name)}</span>
                <span class="wbo-group-count">${esc(countLabel)}</span>
            </button>
        `;

    _renderedGroupBooksMap.set(id, books.map((b) => b.realName));
    return `
        <div class="wbo-group${collapsed ? ' is-collapsed' : ''}" data-group-id="${esc(id)}" data-book-count="${books.length}" style="--wbo-group-accent:${esc(color)}">
            <div class="wbo-group-header"${disableReorder ? '' : ` data-drag-group-id="${esc(id)}"`}>
                ${titleNode}
                <div class="wbo-group-actions">
                    ${charTitlePill}
                    ${visActionBtn}
                    ${orderActions}
                    ${customActions}
                </div>
            </div>
            ${rowsHtml}
        </div>
    `;
}

const RESTORE_PILL_ID = 'wbo-restore-pill';

/** @type {Array<{ el: HTMLElement, top: number }>} */
let _minimizedScrollSnapshots = [];

function removeRestorePill() {
    document.getElementById(RESTORE_PILL_ID)?.remove();
    _minimizedScrollSnapshots = [];
}

function closeFloatingGroupManager() {
    _syncFloatingGroupManager = null;
    const gmOverlay = document.getElementById(GROUP_MGR_OVERLAY_ID);
    if (gmOverlay instanceof HTMLElement) {
        cleanupOverlayWindowControls(gmOverlay);
        gmOverlay.remove();
    }
}

function restoreManagerModal() {
    const overlay = document.getElementById(MANAGER_OVERLAY_ID);
    document.getElementById(RESTORE_PILL_ID)?.remove();
    const gmOverlay = document.getElementById(GROUP_MGR_OVERLAY_ID);
    if (gmOverlay instanceof HTMLElement) {
        gmOverlay.hidden = false;
        gmOverlay.style.display = '';
    }
    if (!(overlay instanceof HTMLElement)) return;
    overlay.hidden = false;
    overlay.style.display = '';
    const snaps = _minimizedScrollSnapshots;
    _minimizedScrollSnapshots = [];
    requestAnimationFrame(() => {
        for (const snap of snaps) {
            if (snap.el.isConnected) snap.el.scrollTop = snap.top;
        }
    });
}

function getManagerScrollHost(listEl) {
    return listEl?.closest('.wbo-touch-window.is-resized')?.querySelector('.wbo-mgr-window-scroll') || listEl;
}

function bindFloatingManagerTools(modal) {
    const toggle = modal.querySelector('#wbo-mgr-floating-tools-btn');
    const flyout = modal.querySelector('#wbo-mgr-floating-tools');
    const scrollHost = modal.querySelector('.wbo-mgr-window-scroll');
    const tools = ['.wbo-mgr-header-tools', '.wbo-mgr-subbar'].map((selector) => modal.querySelector(selector));
    const overlay = modal.parentElement;
    const title = modal.querySelector('.wbo-modal-header-top');
    let locations = [];
    let frame = 0;
    let observing = false;
    let disposed = false;

    const close = () => {
        if (flyout.hidden) return;
        const top = scrollHost.scrollTop;
        for (const [placeholder, controls] of locations) placeholder.replaceWith(controls);
        locations = [];
        flyout.hidden = true;
        toggle.setAttribute('aria-expanded', 'false');
        scrollHost.scrollTop = top;
    };

    // While portalled, measure the original slots rather than the visible flyout.
    const isAvailable = (controls) => {
        const slot = locations.find(([, el]) => el === controls)?.[0] || controls;
        const rect = slot.getBoundingClientRect();
        const viewport = window.visualViewport;
        const bounds = modal.getBoundingClientRect();
        let left = Math.max(bounds.left, viewport?.offsetLeft || 0);
        let top = Math.max(bounds.top, viewport?.offsetTop || 0);
        let right = Math.min(bounds.right, (viewport?.offsetLeft || 0) + (viewport?.width || window.innerWidth));
        let bottom = Math.min(bounds.bottom, (viewport?.offsetTop || 0) + (viewport?.height || window.innerHeight));
        const fixed = getComputedStyle(slot).position === 'fixed';
        for (let parent = slot.parentElement; parent && parent !== modal; parent = parent.parentElement) {
            const style = getComputedStyle(parent);
            if (fixed || style.display === 'contents') continue;
            const clip = parent.getBoundingClientRect();
            if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
                left = Math.max(left, clip.left + parent.clientLeft);
                right = Math.min(right, clip.left + parent.clientLeft + parent.clientWidth);
            }
            if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
                top = Math.max(top, clip.top + parent.clientTop);
                bottom = Math.min(bottom, clip.top + parent.clientTop + parent.clientHeight);
            }
        }
        const titleRect = title?.getBoundingClientRect();
        if (titleRect && titleRect.right > rect.left && titleRect.left < rect.right) {
            top = Math.max(top, Math.min(titleRect.bottom, bottom));
        }
        return rect.width > 0 && rect.height > 0 && rect.left >= left - 1 && rect.right <= right + 1
            && rect.top >= top - 1 && rect.bottom <= bottom + 1;
    };

    const sync = () => {
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        if (!observing || disposed) return;
        const needed = tools.some((controls) => !isAvailable(controls));
        if (!needed) close();
        toggle.hidden = !needed;
    };
    const schedule = () => {
        if (observing && !frame && !disposed) frame = requestAnimationFrame(sync);
    };
    const resizeObserver = typeof globalThis.ResizeObserver === 'function'
        ? new globalThis.ResizeObserver(schedule) : null;
    const scrollOptions = { passive: true, capture: true };
    const refresh = () => {
        const active = !disposed && !document.hidden && modal.isConnected && !overlay.hidden
            && overlay.style.display !== 'none' && modal.getClientRects().length > 0
            && modal.matches('.wbo-touch-window');
        if (active !== observing) {
            observing = active;
            if (active) {
                scrollHost.addEventListener('scroll', schedule, scrollOptions);
                window.addEventListener('resize', schedule);
                window.addEventListener('scroll', schedule, { passive: true });
                window.visualViewport?.addEventListener('resize', schedule);
                window.visualViewport?.addEventListener('scroll', schedule);
                for (const el of [modal, scrollHost, ...tools]) resizeObserver?.observe(el);
            } else {
                scrollHost.removeEventListener('scroll', schedule, scrollOptions);
                window.removeEventListener('resize', schedule);
                window.removeEventListener('scroll', schedule);
                window.visualViewport?.removeEventListener('resize', schedule);
                window.visualViewport?.removeEventListener('scroll', schedule);
                resizeObserver?.disconnect();
                if (frame) cancelAnimationFrame(frame);
                frame = 0;
                close();
            }
        }
        if (active) schedule();
        else toggle.hidden = true;
    };

    const onToggle = () => {
        if (!flyout.hidden) {
            close();
            return;
        }
        refresh();
        if (!observing) return;
        sync();
        if (toggle.hidden) return;
        const top = scrollHost.scrollTop;
        locations = tools.map((controls) => {
            const placeholder = document.createElement('div');
            placeholder.style.height = `${controls.getBoundingClientRect().height}px`;
            placeholder.style.flexShrink = '0';
            placeholder.setAttribute('aria-hidden', 'true');
            return [placeholder, controls];
        });
        for (const [placeholder, controls] of locations) {
            controls.replaceWith(placeholder);
            flyout.append(controls);
        }
        flyout.scrollTop = 0;
        flyout.hidden = false;
        toggle.setAttribute('aria-expanded', 'true');
        scrollHost.scrollTop = top;
    };

    const onPointerDown = (event) => {
        if (!flyout.contains(event.target) && !toggle.contains(event.target)) close();
    };
    const onKeyDown = (event) => {
        if (event.key === 'Escape' && !event.isComposing && !_isComposing && !flyout.hidden) {
            event.stopPropagation();
            close();
        }
    };
    toggle.addEventListener('click', onToggle);
    modal.addEventListener('pointerdown', onPointerDown);
    modal.addEventListener('keydown', onKeyDown);
    // Only these two roots are watched for lifecycle changes, never list rows.
    const lifecycleObserver = typeof globalThis.MutationObserver === 'function'
        ? new globalThis.MutationObserver(refresh) : null;
    for (const el of [overlay, modal]) {
        lifecycleObserver?.observe(el, { attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
    }
    document.addEventListener('visibilitychange', refresh);
    close.dispose = () => {
        disposed = true;
        refresh();
        lifecycleObserver?.disconnect();
        document.removeEventListener('visibilitychange', refresh);
        toggle.removeEventListener('click', onToggle);
        modal.removeEventListener('pointerdown', onPointerDown);
        modal.removeEventListener('keydown', onKeyDown);
    };
    toggle.hidden = true;
    refresh();
    return close;
}

function minimizeManagerModal() {
    const overlay = document.getElementById(MANAGER_OVERLAY_ID);
    if (!(overlay instanceof HTMLElement)) return;
    closeGroupVisibilityPopover();

    // Snapshot scroll positions of scrollable containers so hiding via display:none preserves 100% scroll offset
    const snaps = [];
    const scrollHost = getManagerScrollHost(overlay.querySelector('#wbo-mgr-groups-list'));
    if (scrollHost instanceof HTMLElement) snaps.push({ el: scrollHost, top: scrollHost.scrollTop });
    overlay.querySelectorAll('.wbo-step-scroll').forEach((el) => {
        if (el instanceof HTMLElement && el.scrollTop > 0) snaps.push({ el, top: el.scrollTop });
    });
    _minimizedScrollSnapshots = snaps;

    overlay.hidden = true;
    overlay.style.display = 'none';
    const gmOverlay = document.getElementById(GROUP_MGR_OVERLAY_ID);
    if (gmOverlay instanceof HTMLElement) {
        gmOverlay.hidden = true;
        gmOverlay.style.display = 'none';
    }

    document.getElementById(RESTORE_PILL_ID)?.remove();
    const pill = document.createElement('button');
    pill.id = RESTORE_PILL_ID;
    pill.type = 'button';
    pill.className = 'wbo-restore-pill';
    applyThemeClass(pill);
    pill.innerHTML = `<i class="fa-regular fa-window-restore"></i><span>世界书管理 · 点击恢复</span>`;
    bindDrawerSafeBubbleGuard(pill);
    pill.addEventListener('click', (ev) => {
        ev.stopPropagation();
        restoreManagerModal();
    });
    document.body.appendChild(pill);
}

function closeManagerModal() {
    window.removeEventListener(ENTRY_GROUPING_STATE_CHANGED, syncPreviewEntryGrouping);
    removeRestorePill();
    closeFloatingGroupManager();
    destroyAllPreviewControllers();
    closeSubModal({ all: true });
    cancelManagerInlineEntrySearch();
    closeGroupVisibilityPopover();
    _lastModalListSig = null;
    _batchMode = false;
    _batchSelected.clear();
    _renderedGroupBooksMap.clear();
    _previewCache.clear();
    _hasPendingPinResort = false;
    _hasPendingDeferredListRender = false;
    const overlay = document.getElementById(MANAGER_OVERLAY_ID);
    const modal = overlay?.querySelector('.wbo-modal');
    if (modal instanceof HTMLElement) {
        const cleanup = _modalWindowCleanupMap.get(modal);
        if (typeof cleanup === 'function') {
            cleanup();
            _modalWindowCleanupMap.delete(modal);
        }
    }
    overlay?.remove();
}

/**
 * Read the list of book realNames belonging to a rendered `.wbo-group` element (works even when collapsed!).
 * @param {Element} groupEl
 * @returns {string[]}
 */
function getRenderedGroupBookNames(groupEl) {
    const gid = groupEl?.getAttribute?.('data-group-id');
    if (!gid) return [];
    return _renderedGroupBooksMap.get(gid) || [];
}

/**
 * Sync batch selection toolbar state & per-group checkboxes inside the Group Manager modal
 * without rebuilding the list.
 */
function syncBatchBarUi() {
    const overlay = document.getElementById(MANAGER_OVERLAY_ID);
    if (!overlay) return;
    const batchBtn = overlay.querySelector('#wbo-mgr-batch-btn');
    const batchBar = overlay.querySelector('#wbo-batch-bar');
    const countEl = overlay.querySelector('#wbo-batch-count');
    const toggleAllBtn = overlay.querySelector('#wbo-batch-toggle-all');
    const moveBtn = overlay.querySelector('#wbo-batch-move-btn');
    const ungroupBtn = overlay.querySelector('#wbo-batch-ungroup-btn');
    const delBtn = overlay.querySelector('#wbo-batch-del-btn');
    if (batchBtn) batchBtn.classList.toggle('is-active', _batchMode);
    if (batchBar instanceof HTMLElement) batchBar.hidden = !_batchMode;
    const count = _batchSelected.size;
    if (countEl) countEl.textContent = `已选 ${count} 本`;

    const allVisibleNames = [];
    overlay.querySelectorAll('#wbo-mgr-groups-list .wbo-group[data-group-id]').forEach((groupEl) => {
        const names = getRenderedGroupBookNames(groupEl);
        for (const n of names) allVisibleNames.push(n);
        const grpCheck = groupEl.querySelector('.wbo-batch-group-check');
        if (grpCheck instanceof HTMLInputElement) {
            const selectedInGroup = names.filter((n) => _batchSelected.has(n)).length;
            grpCheck.checked = names.length > 0 && selectedInGroup === names.length;
            grpCheck.indeterminate = selectedInGroup > 0 && selectedInGroup < names.length;
        }
    });

    if (toggleAllBtn) {
        const allVisibleSelected =
            allVisibleNames.length > 0 &&
            allVisibleNames.every((n) => _batchSelected.has(n));
        toggleAllBtn.textContent = allVisibleSelected ? '取消全选' : '全选当前';
    }
    if (moveBtn instanceof HTMLButtonElement) moveBtn.disabled = count === 0;
    if (ungroupBtn instanceof HTMLButtonElement) ungroupBtn.disabled = count === 0;
    if (delBtn instanceof HTMLButtonElement) delBtn.disabled = count === 0;
}

/**
 * Non-blocking floating / side-docked Group Management panel: view all custom groups,
 * batch-select groups to dissolve/delete, reorder, merge, or rename while keeping the
 * main Worldbook list & entry accordions underneath 100% scrollable and interactive!
 */
function openManageGroupsModal() {
    if (!_callbacks) return;
    const existingOverlay = document.getElementById(GROUP_MGR_OVERLAY_ID);
    if (existingOverlay instanceof HTMLElement) {
        existingOverlay.hidden = false;
        existingOverlay.style.display = '';
        _syncFloatingGroupManager?.();
        return;
    }

    const selectedGroupIds = new Set();

    const overlay = document.createElement('div');
    overlay.id = GROUP_MGR_OVERLAY_ID;
    overlay.className = 'wbo-modal-overlay wbo-floating-overlay wbo-gm-floating-overlay';
    applyTauriSurface(overlay, 'backdrop');

    const modal = document.createElement('div');
    modal.className = 'wbo-modal is-pinned-layout wbo-gm-floating-panel';
    applyThemeClass(modal);
    applyTauriSurface(modal, 'fullscreen-window');

    const vw = Math.max(globalThis.innerWidth || document.documentElement?.clientWidth || 1200, 280);
    const vh = Math.max(globalThis.innerHeight || document.documentElement?.clientHeight || 800, 320);
    const isMobile = (vw <= 680 && Boolean(globalThis.matchMedia?.('(pointer: coarse)')?.matches))
        || globalThis.__TAURITAVERN_HOST__?.kind === 'mobile';
    let initialBox = null;
    if (isMobile) {
        // Measure the first list at its floating width, before the browser paints.
        modal.classList.add('is-resized');
        modal.style.width = `${Math.max(Math.min(310, vw - 16), Math.round((vw - 16) * 0.9))}px`;
    } else if (vw > 680) {
        const mgrModal = document.querySelector(`#${MANAGER_OVERLAY_ID} .wbo-modal`);
        const mgrRect = mgrModal instanceof HTMLElement ? mgrModal.getBoundingClientRect() : null;
        const panelW = Math.min(400, Math.max(340, Math.round(vw * 0.28)));
        const panelH = Math.min(Math.max(420, Math.round(mgrRect?.height || 560)), vh - 24);
        let panelLeft = Math.max(12, vw - panelW - 16);
        let panelTop = Math.max(12, Math.round((vh - panelH) / 2));
        if (vw >= 1080 && mgrRect && mgrRect.width > 0) {
            panelTop = Math.max(12, Math.min(vh - panelH - 12, Math.round(mgrRect.top)));
            if (mgrRect.right + 12 + panelW <= vw - 12) {
                panelLeft = Math.round(mgrRect.right + 12);
            } else if (mgrRect.left - 12 - panelW >= 12) {
                panelLeft = Math.round(mgrRect.left - 12 - panelW);
            }
        }
        initialBox = { left: panelLeft, top: panelTop, width: panelW, height: panelH };
    }

    modal.innerHTML = `
        <div class="wbo-modal-header wbo-draggable-header">
            <div class="wbo-modal-header-top">
                <span class="wbo-modal-title">管理分组</span>
                <div class="wbo-modal-header-actions">
                    <button type="button" class="wbo-icon-btn wbo-modal-fullscreen-btn" data-wbo-fullscreen-btn="group-manager" aria-label="还原窗口" title="还原窗口后可移动和调整大小">
                        <i class="fa-solid fa-compress" aria-hidden="true"></i>
                    </button>
                    <button type="button" class="wbo-icon-btn wbo-modal-close" aria-label="关闭">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>
            </div>
        </div>
        <div class="wbo-modal-body wbo-pinned-body">
            <div class="wbo-pinned-top">
                <div class="wbo-gm-toolbar">
                    <span class="wbo-batch-count" id="wbo-gm-sel-count">已选 0 个分组</span>
                    <button type="button" class="wbo-link-btn" id="wbo-gm-toggle-all">全选</button>
                    <span class="wbo-spacer"></span>
                    <button type="button" class="wbo-btn" id="wbo-gm-new-btn">
                        <i class="fa-solid fa-folder-plus"></i> 新建分组
                    </button>
                </div>
            </div>
            <div class="wbo-step-scroll">
                <div class="wbo-gm-list" id="wbo-gm-list"></div>
                <div class="wbo-subtle-tip wbo-gm-help">解除分组不会删除世界书，相关世界书将回到「未分组」。</div>
            </div>
            <div class="wbo-modal-footer wbo-pinned-footer wbo-ai-footer wbo-ai-footer-single">
                <div class="wbo-ai-footer-left">
                    <button type="button" class="wbo-btn wbo-btn-danger" id="wbo-gm-del-selected" disabled>
                        <i class="fa-regular fa-trash-can"></i> 解除所选分组
                    </button>
                </div>
                <div class="wbo-ai-footer-right">
                    <button type="button" class="wbo-btn" id="wbo-gm-close-btn">完成</button>
                </div>
            </div>
        </div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    bindDrawerSafeBubbleGuard(modal);

    const listEl = modal.querySelector('#wbo-gm-list');
    const selCountEl = modal.querySelector('#wbo-gm-sel-count');
    const toggleAllBtn = modal.querySelector('#wbo-gm-toggle-all');
    const delSelBtn = modal.querySelector('#wbo-gm-del-selected');

    const syncSelectionUi = () => {
        if (!modal.isConnected || !_callbacks) return;
        const { settings } = _callbacks.getState();
        const total = (settings.groups || []).length;
        const validIds = new Set((settings.groups || []).map((g) => g.id));
        for (const id of [...selectedGroupIds]) {
            if (!validIds.has(id)) selectedGroupIds.delete(id);
        }
        const selCount = selectedGroupIds.size;
        if (selCountEl) selCountEl.textContent = `已选 ${selCount} / ${total} 个分组`;
        if (toggleAllBtn) {
            toggleAllBtn.textContent = total > 0 && selCount === total ? '取消全选' : '全选';
            toggleAllBtn.hidden = total === 0;
        }
        if (delSelBtn instanceof HTMLButtonElement) {
            delSelBtn.disabled = selCount === 0;
            delSelBtn.innerHTML = selCount > 0
                ? `<i class="fa-regular fa-trash-can"></i> 解除所选分组 (${selCount})`
                : '<i class="fa-regular fa-trash-can"></i> 解除所选分组';
        }
    };

    const renderList = () => {
        if (!modal.isConnected || !_callbacks) return;
        const { settings, classification } = _callbacks.getState();
        const countByGroupId = new Map(
            (classification.customGroups || []).map((g) => [g.id, g.books.length]),
        );
        const groups = settings.groups || [];
        if (!listEl) return;

        if (groups.length === 0) {
            listEl.innerHTML = '<div class="wbo-empty-hint">暂无自定义分组，可点右上角「新建分组」或使用「整理」自动创建</div>';
            syncSelectionUi();
            return;
        }

        listEl.innerHTML = groups.map((g, idx) => {
            const bookCount = countByGroupId.get(g.id) || 0;
            const checked = selectedGroupIds.has(g.id) ? ' checked' : '';
            return `
                <div class="wbo-gm-row${checked ? ' is-selected' : ''}" data-gm-id="${esc(g.id)}">
                    <label class="wbo-gm-main">
                        <input type="checkbox" class="wbo-gm-check" value="${esc(g.id)}"${checked}>
                        <span class="wbo-group-dot" style="background:${esc(g.color)}"></span>
                        <span class="wbo-gm-name">${esc(g.name)}</span>
                        <span class="wbo-tag">${bookCount} 本</span>
                    </label>
                    <div class="wbo-gm-actions">
                        <button type="button" class="wbo-icon-btn" data-gm-action="up" data-gm-id="${esc(g.id)}" ${idx === 0 ? 'disabled' : ''} title="上移">
                            <i class="fa-solid fa-arrow-up"></i>
                        </button>
                        <button type="button" class="wbo-icon-btn" data-gm-action="down" data-gm-id="${esc(g.id)}" ${idx === groups.length - 1 ? 'disabled' : ''} title="下移">
                            <i class="fa-solid fa-arrow-down"></i>
                        </button>
                        ${groups.length >= 2 ? `<button type="button" class="wbo-icon-btn" data-gm-action="merge" data-gm-id="${esc(g.id)}" title="整组归入其他分组"><i class="fa-solid fa-code-merge"></i></button>` : ''}
                        <button type="button" class="wbo-icon-btn" data-gm-action="edit" data-gm-id="${esc(g.id)}" title="编辑分组名称、颜色与成员">
                            <i class="fa-solid fa-pen"></i>
                        </button>
                        <button type="button" class="wbo-icon-btn wbo-icon-danger" data-gm-action="delete" data-gm-id="${esc(g.id)}" title="删除分组">
                            <i class="fa-regular fa-trash-can"></i>
                        </button>
                    </div>
                </div>
            `;
        }).join('');
        syncSelectionUi();
    };
    _syncFloatingGroupManager = renderList;

    const deleteGroupsByIds = async (ids) => {
        if (!ids.length) return;
        const { settings } = _callbacks.getState();
        const idSet = new Set(ids);
        const names = settings.groups.filter((g) => idSet.has(g.id)).map((g) => g.name);
        if (names.length === 0) return;
        const label = names.length === 1 ? `「${names[0]}」` : `这 ${names.length} 个分组（${names.slice(0, 3).join('、')}${names.length > 3 ? ' 等' : ''}）`;
        if (!globalThis.confirm(`确认解除并删除${label}？世界书本体不会被删除，将回到未分组。`)) return;

        settings.groups = settings.groups.filter((g) => !idSet.has(g.id));
        for (const [book, assigned] of Object.entries(settings.assignments || {})) {
            if (idSet.has(assigned)) delete settings.assignments[book];
        }
        if (settings.bookOrders && typeof settings.bookOrders === 'object') {
            for (const id of idSet) delete settings.bookOrders[id];
        }
        if (idSet.has(settings.activeFilterGroupId)) {
            settings.activeFilterGroupId = SPECIAL_GROUPS.DEFAULT;
        }
        for (const id of ids) selectedGroupIds.delete(id);
        await _callbacks.onMutation({ save: true });
        renderList();
        showToast('success', names.length === 1 ? `已删除分组「${names[0]}」` : `已解除并删除 ${names.length} 个分组`);
    };

    listEl?.addEventListener('change', (ev) => {
        const cb = ev.target;
        if (!(cb instanceof HTMLInputElement) || !cb.classList.contains('wbo-gm-check')) return;
        const gid = cb.value;
        if (cb.checked) selectedGroupIds.add(gid);
        else selectedGroupIds.delete(gid);
        cb.closest('.wbo-gm-row')?.classList.toggle('is-selected', cb.checked);
        syncSelectionUi();
    });

    listEl?.addEventListener('click', async (ev) => {
        const btn = ev.target instanceof Element ? ev.target.closest('[data-gm-action]') : null;
        if (!btn) return;
        const act = btn.getAttribute('data-gm-action');
        const gid = btn.getAttribute('data-gm-id');
        if (!gid) return;
        const { settings } = _callbacks.getState();

        if (act === 'up' || act === 'down') {
            const visibleGroupIds = (settings.groups || []).map((g) => g.id);
            if (moveSectionOrder(settings, gid, act === 'up' ? -1 : 1, visibleGroupIds)) {
                await _callbacks.onMutation({ save: true });
                renderList();
            }
            return;
        }
        if (act === 'edit') {
            const grp = settings.groups.find((g) => g.id === gid);
            if (grp) openCreateOrRenameGroupModal(grp);
            return;
        }
        if (act === 'merge') {
            const srcGrp = settings.groups.find((g) => g.id === gid);
            const others = settings.groups.filter((g) => g.id !== gid);
            if (!srcGrp || others.length === 0) return;
            const targetListHtml = others.map((og) => `
                <button type="button" class="wbo-move-option" data-merge-target="${esc(og.id)}">
                    <span class="wbo-group-dot" style="background:${esc(og.color)}"></span>
                    <span class="wbo-move-label">${esc(og.name)}</span>
                </button>
            `).join('');
            const { modal: mergeModal } = createSubModal(
                `将「${srcGrp.name}」整组归入`,
                `
                    <div class="wbo-step-scroll">
                        <div class="wbo-subtle-tip">该分组下的全部世界书将移入目标分组，并删除原分组「${esc(srcGrp.name)}」。</div>
                        <div class="wbo-move-list">${targetListHtml}</div>
                    </div>
                    <div class="wbo-modal-footer wbo-pinned-footer">
                        <button type="button" class="wbo-btn" id="wbo-merge-cancel-btn">返回</button>
                    </div>
                `,
                { wide: true, pinnedLayout: true },
            );
            mergeModal.querySelectorAll('[data-merge-target]').forEach((tBtn) => {
                tBtn.addEventListener('click', async () => {
                    const targetId = tBtn.getAttribute('data-merge-target');
                    const targetGrp = settings.groups.find((g) => g.id === targetId);
                    if (!targetGrp) return;
                    let moved = 0;
                    for (const [book, assigned] of Object.entries(settings.assignments || {})) {
                        if (assigned === gid) {
                            settings.assignments[book] = targetId;
                            moved += 1;
                        }
                    }
                    settings.groups = settings.groups.filter((g) => g.id !== gid);
                    if (settings.bookOrders && typeof settings.bookOrders === 'object') {
                        delete settings.bookOrders[gid];
                    }
                    if (settings.activeFilterGroupId === gid) {
                        settings.activeFilterGroupId = targetId;
                    }
                    closeSubModal();
                    await _callbacks.onMutation({ save: true });
                    showToast('success', `已将「${srcGrp.name}」的 ${moved} 本世界书归入「${targetGrp.name}」`);
                    renderList();
                });
            });
            mergeModal.querySelector('#wbo-merge-cancel-btn')?.addEventListener('click', () => closeSubModal());
            return;
        }
        if (act === 'delete') {
            await deleteGroupsByIds([gid]);
        }
    });

    toggleAllBtn?.addEventListener('click', () => {
        const { settings } = _callbacks.getState();
        const groups = settings.groups || [];
        if (selectedGroupIds.size === groups.length) {
            selectedGroupIds.clear();
        } else {
            groups.forEach((g) => selectedGroupIds.add(g.id));
        }
        renderList();
    });

    delSelBtn?.addEventListener('click', () => deleteGroupsByIds([...selectedGroupIds]));
    modal.querySelector('#wbo-gm-new-btn')?.addEventListener('click', () => openCreateOrRenameGroupModal(null));
    modal.querySelector('#wbo-gm-close-btn')?.addEventListener('click', (ev) => {
        ev.stopPropagation();
        closeFloatingGroupManager();
    });
    modal.querySelector('.wbo-modal-close')?.addEventListener('click', (ev) => {
        ev.stopPropagation();
        closeFloatingGroupManager();
    });

    renderList();

    // Fit only this opening's initial content; later list updates keep a stable box.
    // Shared controls give saved manual geometry priority over this default.
    let initialMobileBox = null;
    if (isMobile) {
        const scroll = modal.querySelector('.wbo-step-scroll');
        const style = getComputedStyle(scroll);
        const children = [...scroll.children].filter((el) => el.getClientRects().length);
        const contentHeight = children.reduce((sum, el) => sum + el.getBoundingClientRect().height, 0)
            + Math.max(0, children.length - 1) * (parseFloat(style.rowGap) || 0)
            + (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
        const rect = modal.getBoundingClientRect();
        const shellHeight = rect.height - scroll.getBoundingClientRect().height;
        initialMobileBox = { width: rect.width, height: Math.min(vh * 0.75, Math.ceil(shellHeight + contentHeight)) };
    }
    const gmWinCleanup = attachModalWindowControls(modal, modal.querySelector('.wbo-modal-header'), { initialBox, initialMobileBox });
    _modalWindowCleanupMap.set(modal, gmWinCleanup);
}

/**
 * Open a modal to move multiple selected worldbooks into a target group at once.
 * @param {string[]} bookNames
 */
function openBatchMoveModal(bookNames) {
    if (!_callbacks || !Array.isArray(bookNames) || bookNames.length === 0) return;
    const { settings, classification } = _callbacks.getState();

    const options = [
        ...settings.groups.map((g) => ({ id: g.id, label: g.name, color: g.color })),
        { id: SPECIAL_GROUPS.CHARACTER, label: '角色世界书', color: '#7c8594' },
        { id: SPECIAL_GROUPS.UNGROUPED, label: '未分组', color: '#8c99a6' },
    ];

    const listHtml = options.map((opt) => `
        <button type="button" class="wbo-move-option" data-target-group="${esc(opt.id)}">
            <span class="wbo-group-dot" style="background:${esc(opt.color)}"></span>
            <span class="wbo-move-label">${esc(opt.label)}</span>
        </button>
    `).join('');

    const { modal } = createSubModal(
        `批量移动 ${bookNames.length} 本世界书`,
        `
            <div class="wbo-move-list">${listHtml}</div>
            <div class="wbo-modal-footer wbo-footer-pair">
                <button type="button" class="wbo-btn" id="wbo-batch-new-group">新建分组并移入</button>
                <button type="button" class="wbo-btn" id="wbo-cancel-btn">取消</button>
            </div>
        `,
    );

    modal.querySelectorAll('.wbo-move-option').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const targetId = btn.getAttribute('data-target-group');
            if (!targetId) return;
            let moved = 0;
            for (const name of bookNames) {
                const meta = classification.byName.get(name);
                if (meta && assignBookToGroup(settings, meta, targetId)) {
                    moved += 1;
                }
            }
            _batchSelected.clear();
            closeSubModal();
            await _callbacks.onMutation({ save: true });
            showToast('success', `已将 ${moved} 本世界书移入目标分组`);
        });
    });

    modal.querySelector('#wbo-batch-new-group')?.addEventListener('click', async () => {
        const name = await openInlineTextPrompt({
            title: '新建分组并移入',
            label: '新分组名称',
            placeholder: '例如：文风设定、世界观',
            confirmText: '确定',
        });
        if (!name) return;
        const existing = (settings.groups || []).find(
            (g) => g.name.trim().toLowerCase() === name.toLowerCase(),
        );
        const targetGroup = existing || addCustomGroup(settings, { name });
        for (const bookName of bookNames) {
            const meta = classification.byName.get(bookName);
            if (meta) assignBookToGroup(settings, meta, targetGroup.id);
        }
        _batchSelected.clear();
        closeSubModal();
        await _callbacks.onMutation({ save: true });
        showToast('success', existing
            ? `已移入已有分组「${targetGroup.name}」（共 ${bookNames.length} 本）`
            : `已新建「${name}」并移入 ${bookNames.length} 本世界书`);
    });

    modal.querySelector('#wbo-cancel-btn')?.addEventListener('click', closeSubModal);
}

/**
 * Confirm with binding safety warnings and permanently delete selected worldbooks from disk.
 * @param {string[]} bookNames
 */
async function confirmAndDeleteWorldbooks(bookNames, { stack = false, onComplete } = {}) {
    if (!_callbacks || !Array.isArray(bookNames) || bookNames.length === 0) return;
    const { settings } = _callbacks.getState();
    const bindings = buildCharacterBindingIndex({
        characters: getCharactersInMemory(),
        charLore: getCharLoreEntries(),
        cachedCharBindings: settings.cachedCharBindings,
        worldNamesSet: new Set(bookNames),
    });
    const personas = buildPersonaBindingIndex(getPowerUserSettings());

    const boundWarnings = [];
    const embeddedMatches = [];
    for (const name of bookNames) {
        const owners = (bindings.get(name) || []).filter((owner) => !owner.orphan);
        const refs = [];
        for (const [source, label] of [['primary', '主世界书'], ['extra', '附加世界书']]) {
            const names = owners.filter((owner) => owner.source === source).map((owner) => owner.charName);
            if (names.length) refs.push(`${label}：${names.join('、')}`);
        }
        const personaNames = personas.get(name);
        if (personaNames?.length) refs.push(`人设：${personaNames.join('、')}`);
        if (refs.length > 0) {
            boundWarnings.push(`${name}（${refs.join('；')}）`);
        }
        const embeddedNames = owners.filter((owner) => owner.source === 'embedded').map((owner) => owner.charName);
        if (embeddedNames.length) {
            embeddedMatches.push(`${name}（角色：${embeddedNames.join('、')}）`);
        }
    }

    const previewNames = bookNames.slice(0, 8).map((n) => `<li>${esc(n)}</li>`).join('');
    const moreNames = bookNames.length > 8 ? `<li>…等共 ${bookNames.length} 本</li>` : '';
    const warnHtml = boundWarnings.length > 0
        ? `<div class="wbo-refusal-box"><b>注意：其中 ${boundWarnings.length} 本正绑定在角色卡或人设上</b><br>${esc(boundWarnings.slice(0, 5).join('；'))}${boundWarnings.length > 5 ? ' 等' : ''}</div>`
        : '';
    const embeddedHtml = embeddedMatches.length > 0
        ? `<p class="wbo-subtle-tip" data-delete-embedded-note>以下文件与角色卡内嵌世界书同名。卡内条目会保留在角色卡里。<br>${esc(embeddedMatches.slice(0, 5).join('；'))}${embeddedMatches.length > 5 ? ' 等' : ''}</p>`
        : '';

    const { modal, overlay } = createSubModal(
        `确认删除 ${bookNames.length} 本世界书`,
        `
            <div class="wbo-label">以下酒馆世界书文件将永久删除（无法撤销）：</div>
            <ul class="wbo-cov-list">${previewNames}${moreNames}</ul>
            ${warnHtml}
            ${embeddedHtml}
            <div class="wbo-ai-status" id="wbo-del-status"></div>
            <div class="wbo-modal-footer wbo-footer-pair">
                <button type="button" class="wbo-btn wbo-btn-danger" id="wbo-confirm-del-btn">确认永久删除</button>
                <button type="button" class="wbo-btn" id="wbo-cancel-btn">取消</button>
            </div>
        `,
        { stack },
    );

    modal.querySelector('#wbo-cancel-btn')?.addEventListener('click', closeSubModal);
    modal.querySelector('#wbo-confirm-del-btn')?.addEventListener('click', async (ev) => {
        const btn = ev.currentTarget;
        if (btn instanceof HTMLButtonElement) btn.disabled = true;
        const statusEl = modal.querySelector('#wbo-del-status');
        if (statusEl) statusEl.textContent = '正在删除世界书...';

        const res = await deleteWorldbooksFromHost(bookNames);
        if (res.deleted.length > 0) {
            cleanupDeletedWorldSettings(settings, res.deleted);
            for (const name of res.deleted) {
                _batchSelected.delete(name);
                _previewCache.delete(name);
            }
        }
        if (overlay.isConnected) closeSubModal({ overlay });
        await _callbacks.onMutation({ save: true });
        onComplete?.(res);
        showToast(
            res.failed.length > 0 ? 'warning' : 'success',
            `已删除 ${res.deleted.length} 本世界书${res.failed.length > 0 ? `，失败 ${res.failed.length} 本` : ''}`,
        );
    });
}

/**
 * Open the standalone Group Manager modal (zero space occupied in `#WorldInfo` when closed!).
 */
function openManagerModal() {
    if (!_callbacks) return;
    window.addEventListener(ENTRY_GROUPING_STATE_CHANGED, syncPreviewEntryGrouping);
    const triggerPanelCatchupScanIfNeeded = () => {
        const curSettings = _callbacks?.getState?.()?.settings;
        if (!curSettings || curSettings.autoScanNewCharacters === false) return;
        const unscanned = findUnscannedShallowCharacters(
            getCharactersInMemory(),
            curSettings.cachedCharBindings,
        );
        if (unscanned.length > 0) {
            void _callbacks.onMutation({ save: false, uiOnly: true, catchupScan: true });
        }
    };
    if (document.getElementById(MANAGER_OVERLAY_ID)) {
        restoreManagerModal();
        if (_hasPendingPinResort) {
            _hasPendingPinResort = false;
            void _callbacks.onMutation({ save: false });
        } else {
            refreshManagerModalContent();
        }
        triggerPanelCatchupScanIfNeeded();
        return;
    }

    _lastModalListSig = null;
    _hasPendingPinResort = false;
    const overlay = document.createElement('div');
    overlay.id = MANAGER_OVERLAY_ID;
    overlay.className = 'wbo-modal-overlay wbo-floating-overlay';
    applyTauriSurface(overlay, 'backdrop');

    const modal = document.createElement('div');
    modal.className = 'wbo-modal wbo-manager-modal';
    applyThemeClass(modal);
    applyTauriSurface(modal, 'fullscreen-window');
    // Lock a stable height at open time so desktop tab/list shifts never bounce the window
    const baseVh = Math.max(globalThis.innerHeight || 0, document.documentElement?.clientHeight || 0, 560);
    const stableH = stableWindowHeight(baseVh, 0.84, 720);
    modal.style.setProperty('--wbo-stable-h', `${stableH}px`);

    modal.innerHTML = `<div class="wbo-mgr-window-scroll">
        <div class="wbo-modal-header wbo-draggable-header">
            <div class="wbo-modal-header-top">
                <span class="wbo-modal-title">世界书分组管理</span>
                <div class="wbo-modal-header-actions">
                    <button type="button" class="wbo-icon-btn wbo-modal-settings-btn" data-action="open-settings-modal" title="显示与行为设置" aria-label="设置">
                        <i class="fa-solid fa-gear"></i>
                    </button>
                    <button type="button" class="wbo-icon-btn wbo-mgr-floating-tools-btn" id="wbo-mgr-floating-tools-btn" aria-label="工具箱" aria-controls="wbo-mgr-floating-tools" aria-expanded="false" title="工具箱：展开或收起搜索与分组工具">
                        <i class="fa-solid fa-toolbox" aria-hidden="true"></i>
                    </button>
                    <button type="button" class="wbo-icon-btn wbo-modal-fullscreen-btn" data-wbo-fullscreen-btn="manager" title="还原窗口后可移动和调整大小">
                        <i class="fa-solid fa-compress" aria-hidden="true"></i>
                    </button>
                    <button type="button" class="wbo-icon-btn wbo-modal-minimize-btn" data-wbo-minimize-btn title="最小化（保留草稿）" aria-label="最小化">
                        <i class="fa-solid fa-minus"></i>
                    </button>
                    <button type="button" class="wbo-icon-btn wbo-modal-close" aria-label="关闭">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>
            </div>
            <div class="wbo-mgr-header-tools">
                <button type="button" class="wbo-tool-btn" data-action="open-ai-organize" title="本地一键整理 / AI 智能整理">
                    <i class="fa-solid fa-wand-magic-sparkles"></i>
                    <span>整理</span>
                </button>
                <button type="button" class="wbo-tool-btn" id="wbo-mgr-combo-btn" data-action="open-combos-modal" title="自由组合全局世界书并保存方案">
                    <i class="fa-solid fa-bookmark"></i>
                    <span id="wbo-mgr-combo-label">组合</span>
                </button>
                <button type="button" class="wbo-tool-btn" id="wbo-mgr-scan-btn" data-action="open-scan-modal" title="扫描角色世界书">
                    <i class="fa-solid fa-arrows-rotate"></i>
                    <span id="wbo-mgr-scan-label">扫描</span>
                </button>
            </div>
        </div>
        <div class="wbo-mgr-subbar">
            <div class="wbo-mgr-groupbar" id="wbo-mgr-groupbar">
                <div class="wbo-pills-rail">
                    <div class="wbo-pills" id="wbo-mgr-pills"></div>
                    <button type="button" class="wbo-pill-expand-btn" id="wbo-mgr-pills-expand" data-action="toggle-pills-expand" title="展开查看全部分组" aria-controls="wbo-mgr-pills" aria-expanded="false" hidden>
                        <i class="fa-solid fa-chevron-down" aria-hidden="true"></i>
                    </button>
                </div>
                <div class="wbo-mgr-group-actions">
                    <button type="button" class="wbo-tool-btn" data-action="create-group" title="新建自定义分组">
                        <i class="fa-solid fa-folder-plus"></i>
                        <span>新建分组</span>
                    </button>
                    <button type="button" class="wbo-tool-btn" id="wbo-mgr-manage-groups-btn" data-action="open-manage-groups" title="集中查看、排序、合并或批量删除分组">
                        <i class="fa-solid fa-sliders"></i>
                        <span>管理分组</span>
                    </button>
                </div>
            </div>
            <div class="wbo-mgr-listbar">
                <div class="wbo-mgr-search-row">
                    <div class="wbo-search-wrap">
                        <i class="fa-solid fa-magnifying-glass"></i>
                        <input type="search" class="wbo-search-input" id="wbo-mgr-search-input" value="${esc(_searchQuery)}" placeholder="搜索世界书 / 角色名..." autocomplete="off" spellcheck="false">
                    </div>
                    <button type="button" class="wbo-tool-btn" id="wbo-mgr-entry-go-btn" data-action="run-inline-entry-search" title="按当前关键词搜索条目内容" hidden>
                        <i class="fa-solid fa-magnifying-glass"></i>
                        <span id="wbo-mgr-entry-go-label">搜索</span>
                    </button>
                    <button type="button" class="wbo-tool-btn wbo-search-opts-btn" id="wbo-mgr-search-opts-btn" data-action="open-mgr-search-opts" title="设置搜索范围（世界书名 / 角色名 / 条目内容 / 空格多词）">
                        <i class="fa-solid fa-sliders"></i>
                    </button>
                </div>
                <div class="wbo-mgr-list-tools">
                    <label class="wbo-tool-switch" title="开启后显示角色卡世界书，关闭则隐藏">
                        <input type="checkbox" class="wbo-show-char-checkbox" id="wbo-mgr-show-char">
                        <span class="wbo-switch-track"></span>
                        <span id="wbo-mgr-char-label">角色书 0</span>
                    </label>
                    <button type="button" class="wbo-tool-btn" id="wbo-mgr-list-create-btn" data-action="create-group" title="新建自定义分组" hidden>
                        <i class="fa-solid fa-folder-plus"></i>
                        <span>新建分组</span>
                    </button>
                    <button type="button" class="wbo-tool-btn" id="wbo-mgr-batch-btn" data-action="toggle-batch-mode" title="批量勾选世界书移入分组、解除分组或删除">
                        <i class="fa-solid fa-list-check"></i>
                        <span>批量</span>
                    </button>
                </div>
            </div>
            <div class="wbo-es-history-row wbo-mgr-hist-row" id="wbo-mgr-hist-row" hidden></div>
            <div class="wbo-mgr-scan-prompt" id="wbo-mgr-scan-prompt" hidden></div>
            <div class="wbo-mgr-drag-hint" title="拖动分组左侧 ⋮⋮ 可排序；拖动世界书可调序或拖入上方分组">拖动分组左侧 ⋮⋮ 可排序；拖动世界书可调序或拖入上方分组</div>
        </div>
        <div class="wbo-mgr-es-box" id="wbo-mgr-es-box" hidden></div>
        <div class="wbo-batch-bar" id="wbo-batch-bar" hidden>
            <div class="wbo-batch-bar-top">
                <span class="wbo-batch-count" id="wbo-batch-count">已选 0 本</span>
                <button type="button" class="wbo-link-btn" id="wbo-batch-toggle-all" data-action="batch-toggle-visible">全选当前</button>
            </div>
            <span class="wbo-spacer"></span>
            <div class="wbo-batch-bar-actions">
                <button type="button" class="wbo-btn wbo-btn-primary" id="wbo-batch-move-btn" data-action="batch-move" disabled>移入分组</button>
                <button type="button" class="wbo-btn" id="wbo-batch-ungroup-btn" data-action="batch-ungroup" disabled title="解除选中世界书的自定义分组，恢复到未分组">解除分组</button>
                <button type="button" class="wbo-btn wbo-btn-danger" id="wbo-batch-del-btn" data-action="batch-delete" disabled>删除选中</button>
                <button type="button" class="wbo-btn" data-action="toggle-batch-mode">完成</button>
            </div>
        </div>
        <div class="wbo-groups-list wbo-mgr-list" id="wbo-mgr-groups-list"></div>
    </div><div class="wbo-mgr-floating-tools" id="wbo-mgr-floating-tools" role="region" aria-label="世界书工具" hidden></div>`;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Isolate modal events from SillyTavern's unpinned-drawer auto-closer, and close ONLY via the `×` button!
    bindDrawerSafeBubbleGuard(modal);
    const cleanupWinCtrl = attachModalWindowControls(modal, modal.querySelector('.wbo-modal-header'));
    const closeFloatingTools = bindFloatingManagerTools(modal);
    const pillsResizeObserver = typeof globalThis.ResizeObserver === 'function'
        ? new globalThis.ResizeObserver(() => {
            syncManagerPillsExpansion(overlay, _callbacks?.getState()?.settings?.groupPanelExpanded);
        })
        : null;
    pillsResizeObserver?.observe(modal);
    _modalWindowCleanupMap.set(modal, () => {
        pillsResizeObserver?.disconnect();
        closeFloatingTools.dispose();
        cleanupWinCtrl();
    });
    modal.querySelector('[data-wbo-minimize-btn]')?.addEventListener('click', (ev) => {
        ev.stopPropagation();
        minimizeManagerModal();
    });
    modal.querySelector('.wbo-modal-close')?.addEventListener('click', (ev) => {
        ev.stopPropagation();
        closeManagerModal();
    });

    // IME-safe debounced search input inside modal (smooth even with 500+ worldbooks)
    const searchInput = modal.querySelector('#wbo-mgr-search-input');
    if (searchInput instanceof HTMLInputElement) {
        searchInput.addEventListener('compositionstart', () => { _isComposing = true; });
        searchInput.addEventListener('compositionend', () => {
            _isComposing = false;
            clearTimeout(_mgrSearchTimer);
            _searchQuery = searchInput.value;
            if (!_searchQuery.trim()) clearManagerInlineEntryResults();
            renderManagerGroupsListOnly();
        });
        searchInput.addEventListener('input', () => {
            if (_isComposing) return;
            _searchQuery = searchInput.value;
            if (!_searchQuery.trim()) clearManagerInlineEntryResults();
            clearTimeout(_mgrSearchTimer);
            _mgrSearchTimer = setTimeout(() => { renderManagerGroupsListOnly(); }, 80);
        });
        searchInput.addEventListener('keydown', (ev) => {
            if (ev.isComposing || ev.keyCode === 229 || _isComposing) return;
            if (ev.key === 'Enter') {
                closeFloatingTools();
                const curSettings = _callbacks?.getState?.()?.settings;
                if (curSettings?.mgrSearchInEntries) {
                    ev.preventDefault();
                    void runManagerInlineEntrySearch();
                }
            }
        });
    }

    modal.querySelector('#wbo-mgr-hist-row')?.addEventListener('click', (ev) => {
        const target = ev.target instanceof Element ? ev.target : null;
        if (!target || !_callbacks) return;
        const { settings } = _callbacks.getState();
        if (target.closest('#wbo-mgr-hist-clear')) {
            settings.entrySearchHistory = [];
            syncManagerSearchBarUi();
            void _callbacks.onMutation({ save: true, uiOnly: true });
            return;
        }
        const delBtn = target.closest('[data-mgr-hist-del]');
        if (delBtn) {
            const term = delBtn.getAttribute('data-mgr-hist-del') || '';
            settings.entrySearchHistory = (settings.entrySearchHistory || []).filter((x) => x !== term);
            syncManagerSearchBarUi();
            void _callbacks.onMutation({ save: true, uiOnly: true });
            return;
        }
        const pickBtn = target.closest('[data-mgr-hist-pick]');
        if (pickBtn) {
            const term = pickBtn.getAttribute('data-mgr-hist-pick') || '';
            _searchQuery = term;
            if (searchInput instanceof HTMLInputElement) searchInput.value = term;
            renderManagerGroupsListOnly();
            if (settings.mgrSearchInEntries) {
                void runManagerInlineEntrySearch();
            }
        }
    });

    modal.querySelector('#wbo-mgr-es-box')?.addEventListener('click', (ev) => {
        const target = ev.target instanceof Element ? ev.target : null;
        if (!target) return;
        if (target.closest('[data-mgr-es-clear]')) {
            clearManagerInlineEntryResults();
            return;
        }
        const inPluginBtn = target.closest('[data-es-inplugin]');
        if (inPluginBtn) {
            ev.preventDefault();
            ev.stopPropagation();
            const worldName = inPluginBtn.getAttribute('data-es-inplugin');
            const uid = inPluginBtn.getAttribute('data-es-uid');
            if (!worldName) return;
            const meta = _callbacks?.getState?.()?.classification?.byName?.get(worldName)
                || { realName: worldName, primaryTitle: worldName };
            openBookEntryBrowserModal(meta, { initialUid: uid || null });
            return;
        }
        const openBtn = target.closest('[data-es-open]');
        if (openBtn) {
            ev.preventDefault();
            ev.stopPropagation();
            const worldName = openBtn.getAttribute('data-es-open');
            const uid = openBtn.getAttribute('data-es-uid');
            if (!worldName) return;
            cancelManagerInlineEntrySearch();
            openWorldInNativeEditor(worldName, { focusUid: uid || null });
            closeManagerModal();
        }
    });

    modal.querySelector('#wbo-mgr-show-char')?.addEventListener('change', async (ev) => {
        const cb = ev.currentTarget;
        if (!(cb instanceof HTMLInputElement)) return;
        const { settings } = _callbacks.getState();
        settings.showCharBooks = cb.checked;
        if (!settings.showCharBooks && settings.activeFilterGroupId === SPECIAL_GROUPS.CHARACTER) {
            settings.activeFilterGroupId = SPECIAL_GROUPS.DEFAULT;
        }
        if (settings.showCharBooks) {
            settings.charGroupCollapsed = false;
            promoteSectionToTop(settings, SPECIAL_GROUPS.CHARACTER);
        }
        await _callbacks.onMutation({ save: true, charToggleOnly: true });
    });

    // Smooth horizontal wheel scroll on the single-row group pill strip (disabled when expanded to multi-row)
    const pillsRow = modal.querySelector('#wbo-mgr-pills');
    if (pillsRow instanceof HTMLElement) {
        pillsRow.addEventListener('wheel', (ev) => {
            if (!pillsRow.classList.contains('is-expanded') && Math.abs(ev.deltaY) > Math.abs(ev.deltaX) && pillsRow.scrollWidth > pillsRow.clientWidth) {
                ev.preventDefault();
                pillsRow.scrollLeft += ev.deltaY;
            }
        }, { passive: false });
    }

    // Drag & Drop inside Group Manager:
    // 1. Drag any `.wbo-book-row` (collapsed OR with expanded `.wbo-book-preview`!) onto another `.wbo-book-row`
    //    in the same group to reorder (`bookOrders`), or onto any `.wbo-group` / `.wbo-pill` to move groups
    //    (in batch mode, dragging a checked book moves ALL checked books together!).
    // 2. Drag any `.wbo-group-header` onto another `.wbo-group` to reorder sections!
    /** @type {{ type: 'book', bookNames: string[], sourceGroupId: string } | { type: 'group', groupId: string } | null} */
    let dragState = null;

    const clearDropHighlights = () => {
        modal.classList.remove('is-book-dragging');
        modal.querySelectorAll('.wbo-drop-target, .wbo-drop-before, .wbo-drop-after, .is-dragging').forEach((el) => {
            el.classList.remove('wbo-drop-target', 'wbo-drop-before', 'wbo-drop-after', 'is-dragging');
        });
    };

    const clearTempDraggable = () => {
        modal.querySelectorAll('#wbo-mgr-groups-list [draggable="true"]').forEach((el) => {
            el.removeAttribute('draggable');
        });
    };

    const enableHandleDraggable = (ev) => {
        if (ev.pointerType && ev.pointerType !== 'mouse') return;
        const target = ev.target instanceof Element ? ev.target : null;
        if (!target) return;
        if (target.closest('.wbo-book-preview')) return;
        const bookHandle = target.closest('.wbo-drag-handle');
        if (bookHandle) {
            const bookRow = bookHandle.closest('.wbo-book-row[data-book]');
            if (bookRow) bookRow.setAttribute('draggable', 'true');
            return;
        }
        const bookRowMain = target.closest('.wbo-book-main');
        if (bookRowMain && !target.closest('button, input, select, textarea, a, label, .wbo-book-actions')) {
            const bookRow = bookRowMain.closest('.wbo-book-row[data-book]');
            if (bookRow) bookRow.setAttribute('draggable', 'true');
            return;
        }
        const groupHandle = target.closest('.wbo-group-drag-handle');
        if (groupHandle) {
            const groupHeader = groupHandle.closest('.wbo-group-header[data-drag-group-id]');
            if (groupHeader) groupHeader.setAttribute('draggable', 'true');
        }
    };
    modal.addEventListener('pointerdown', enableHandleDraggable, true);
    modal.addEventListener('mousedown', enableHandleDraggable, true);
    modal.addEventListener('pointerup', clearTempDraggable, true);
    modal.addEventListener('mouseup', clearTempDraggable, true);

    const startManagerDrag = (ev) => {
        const target = ev.target instanceof Element ? ev.target : null;
        if (!target) return;
        if (target.closest('.wbo-book-preview')) return;

        const bookRow = target.closest('.wbo-book-row[data-book]');
        if (bookRow instanceof HTMLElement) {
            const bookName = bookRow.getAttribute('data-book');
            if (!bookName) return;
            const sourceGroupId = bookRow.closest('.wbo-group[data-group-id]')?.getAttribute('data-group-id') || '';
            const bookNames = (_batchMode && _batchSelected.has(bookName) && _batchSelected.size > 1)
                ? [..._batchSelected]
                : [bookName];
            dragState = { type: 'book', bookNames, sourceGroupId };
            modal.classList.add('is-book-dragging');
            if (ev.dataTransfer) {
                ev.dataTransfer.effectAllowed = 'move';
                ev.dataTransfer.setData('text/plain', bookNames.join('\n'));
                try {
                    ev.dataTransfer.setDragImage?.(bookRow, 20, 16);
                } catch { /* ignore */ }
            }
            if (bookNames.length > 1) {
                const nameSet = new Set(bookNames);
                modal.querySelectorAll('#wbo-mgr-groups-list .wbo-book-row[data-book]').forEach((r) => {
                    if (nameSet.has(r.getAttribute('data-book') || '')) r.classList.add('is-dragging');
                });
            } else {
                bookRow.classList.add('is-dragging');
            }
            return;
        }

        const groupHeader = target.closest('.wbo-group-header[data-drag-group-id]');
        if (groupHeader instanceof HTMLElement) {
            const groupId = groupHeader.getAttribute('data-drag-group-id');
            if (!groupId) return;
            dragState = { type: 'group', groupId };
            if (ev.dataTransfer) {
                ev.dataTransfer.effectAllowed = 'move';
                ev.dataTransfer.setData('text/plain', groupId);
            }
            groupHeader.closest('.wbo-group')?.classList.add('is-dragging');
        }
    };

    const updateManagerDrag = (ev) => {
        if (!dragState) return;
        const target = ev.target instanceof Element ? ev.target : null;
        if (!target) return;

        modal.querySelectorAll('.wbo-drop-target, .wbo-drop-before, .wbo-drop-after').forEach((el) => {
            el.classList.remove('wbo-drop-target', 'wbo-drop-before', 'wbo-drop-after');
        });
        if (dragState.type === 'book') {
            const dropPill = target.closest('.wbo-pill[data-group-id]');
            const pillGid = dropPill?.getAttribute('data-group-id');
            const validPill = dropPill && pillGid && pillGid !== SPECIAL_GROUPS.DEFAULT && pillGid !== SPECIAL_GROUPS.ALL && pillGid !== SPECIAL_GROUPS.PINNED
                ? dropPill
                : null;
            if (validPill) {
                ev.preventDefault();
                if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
                modal.querySelectorAll('.wbo-drop-before, .wbo-drop-after').forEach((el) => el.classList.remove('wbo-drop-before', 'wbo-drop-after'));
                if (!validPill.classList.contains('wbo-drop-target')) {
                    modal.querySelectorAll('.wbo-drop-target').forEach((el) => el.classList.remove('wbo-drop-target'));
                    validPill.classList.add('wbo-drop-target');
                }
                return;
            }

            const targetBookRow = target.closest('.wbo-book-row[data-book]');
            const targetBookItem = targetBookRow?.closest('.wbo-book-item[data-book]') || target.closest('.wbo-book-item[data-book]');
            const targetGroup = target.closest('.wbo-group[data-group-id]');
            const targetGid = targetGroup?.getAttribute('data-group-id') || '';
            if (targetGid === ACTIVE_GLOBAL_SECTION_ID) return;

            if (
                targetBookItem instanceof HTMLElement &&
                targetGid &&
                targetGid === dragState.sourceGroupId &&
                targetGid !== SPECIAL_GROUPS.PINNED &&
                dragState.bookNames.length === 1 &&
                targetBookItem.getAttribute('data-book') !== dragState.bookNames[0]
            ) {
                ev.preventDefault();
                if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
                modal.querySelectorAll('.wbo-drop-target').forEach((el) => el.classList.remove('wbo-drop-target'));
                const rowRect = (targetBookRow || targetBookItem).getBoundingClientRect();
                const isBefore = ev.clientY < rowRect.top + rowRect.height / 2;
                modal.querySelectorAll('.wbo-drop-before, .wbo-drop-after').forEach((el) => {
                    if (el !== targetBookItem) el.classList.remove('wbo-drop-before', 'wbo-drop-after');
                });
                targetBookItem.classList.toggle('wbo-drop-before', isBefore);
                targetBookItem.classList.toggle('wbo-drop-after', !isBefore);
                return;
            }

            if (targetGroup && targetGid && targetGid !== SPECIAL_GROUPS.PINNED) {
                ev.preventDefault();
                if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
                modal.querySelectorAll('.wbo-drop-before, .wbo-drop-after').forEach((el) => el.classList.remove('wbo-drop-before', 'wbo-drop-after'));
                if (!targetGroup.classList.contains('wbo-drop-target')) {
                    modal.querySelectorAll('.wbo-drop-target').forEach((el) => el.classList.remove('wbo-drop-target'));
                    targetGroup.classList.add('wbo-drop-target');
                }
            }
            return;
        }

        if (dragState.type === 'group') {
            const targetGroup = target.closest('.wbo-group[data-group-id]');
            if (!(targetGroup instanceof HTMLElement)) return;
            const targetHeader = targetGroup.querySelector('.wbo-group-header[data-drag-group-id]');
            const targetId = targetHeader?.getAttribute('data-drag-group-id') || '';
            if (!targetId || targetId === dragState.groupId) return;

            ev.preventDefault();
            if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
            const rect = targetGroup.getBoundingClientRect();
            const isBefore = ev.clientY < rect.top + rect.height / 2;
            modal.querySelectorAll('.wbo-drop-before, .wbo-drop-after').forEach((el) => {
                if (el !== targetGroup) el.classList.remove('wbo-drop-before', 'wbo-drop-after');
            });
            targetGroup.classList.toggle('wbo-drop-before', isBefore);
            targetGroup.classList.toggle('wbo-drop-after', !isBefore);
        }
    };

    const dropManagerDrag = async (ev) => {
        if (!dragState || !_callbacks) return;
        const activeDrag = dragState;
        const target = ev.target instanceof Element ? ev.target : null;
        const { settings, classification } = _callbacks.getState();

        if (activeDrag.type === 'book' && target) {
            const dropPill = target.closest('.wbo-pill[data-group-id]');
            const pillGid = dropPill?.getAttribute('data-group-id');
            const validPillGid = pillGid && pillGid !== SPECIAL_GROUPS.DEFAULT && pillGid !== SPECIAL_GROUPS.ALL && pillGid !== SPECIAL_GROUPS.PINNED ? pillGid : null;
            const dropGroup = target.closest('.wbo-group[data-group-id]');
            const dropGroupId = dropGroup?.getAttribute('data-group-id') || null;
            const targetBookItem = target.closest('.wbo-book-item[data-book]');
            const targetBookName = targetBookItem?.getAttribute('data-book') || '';
            const isSameGroupReorder = Boolean(
                !validPillGid &&
                targetBookItem instanceof HTMLElement &&
                dropGroupId &&
                dropGroupId === activeDrag.sourceGroupId &&
                dropGroupId !== SPECIAL_GROUPS.PINNED &&
                activeDrag.bookNames.length === 1 &&
                targetBookName &&
                targetBookName !== activeDrag.bookNames[0] &&
                (targetBookItem.classList.contains('wbo-drop-before') || targetBookItem.classList.contains('wbo-drop-after')),
            );
            const reorderPos = targetBookItem?.classList.contains('wbo-drop-after') ? 'after' : 'before';

            clearDropHighlights();
            dragState = null;

            if (isSameGroupReorder) {
                ev.preventDefault();
                const draggedBook = activeDrag.bookNames[0];
                const currentOrder = _renderedGroupBooksMap.get(dropGroupId) || [];
                if (reorderBookInGroup(settings, dropGroupId, draggedBook, targetBookName, reorderPos, currentOrder)) {
                    const sec = (classification.orderedSections || []).find((s) => s.id === dropGroupId);
                    if (sec && Array.isArray(sec.books)) {
                        const orderIdx = new Map((settings.bookOrders?.[dropGroupId] || []).map((n, i) => [n, i]));
                        sec.books.sort((a, b) => (orderIdx.get(a.realName) ?? 999999) - (orderIdx.get(b.realName) ?? 999999));
                        _renderedGroupBooksMap.set(dropGroupId, sec.books.map((b) => b.realName));
                    }
                    const bodyEl = dropGroup?.querySelector('.wbo-group-body');
                    const draggedItem = bodyEl?.querySelector(`.wbo-book-item[data-book="${CSS.escape(draggedBook)}"]`);
                    if (bodyEl && draggedItem instanceof HTMLElement && targetBookItem instanceof HTMLElement) {
                        bodyEl.insertBefore(draggedItem, reorderPos === 'after' ? targetBookItem.nextSibling : targetBookItem);
                    }
                    _lastModalListSig = null;
                    await _callbacks.onMutation({ save: true, pinInPlaceOnly: true });
                    showToast('success', '已调整组内顺序');
                }
                return;
            }

            const targetGroupId = validPillGid || (dropGroupId && dropGroupId !== SPECIAL_GROUPS.PINNED && dropGroupId !== ACTIVE_GLOBAL_SECTION_ID ? dropGroupId : null);
            if (!targetGroupId) return;

            ev.preventDefault();
            let movedCount = 0;
            let lastTitle = '';
            for (const name of activeDrag.bookNames) {
                const meta = classification.byName.get(name);
                if (meta && assignBookToGroup(settings, meta, targetGroupId)) {
                    movedCount += 1;
                    lastTitle = meta.primaryTitle;
                }
            }
            if (movedCount > 0) {
                if (activeDrag.bookNames.length > 1) _batchSelected.clear();
                await _callbacks.onMutation({ save: true });
                const targetName = targetGroupId === SPECIAL_GROUPS.UNGROUPED
                    ? '未分组'
                    : targetGroupId === SPECIAL_GROUPS.CHARACTER
                        ? '角色世界书'
                        : settings.groups.find((g) => g.id === targetGroupId)?.name || '分组';
                const msg = movedCount > 1
                    ? `已将 ${movedCount} 本世界书移入「${targetName}」`
                    : `已将「${lastTitle}」移入「${targetName}」`;
                showToast('success', msg);
            }
            return;
        }

        if (activeDrag.type === 'group' && target) {
            const targetGroup = target.closest('.wbo-group[data-group-id]');
            const targetHeader = targetGroup?.querySelector('.wbo-group-header[data-drag-group-id]');
            const targetId = targetHeader?.getAttribute('data-drag-group-id') || '';
            const pos = targetGroup?.classList.contains('wbo-drop-after') ? 'after' : 'before';
            clearDropHighlights();
            dragState = null;
            if (!targetId || targetId === activeDrag.groupId) return;

            ev.preventDefault();
            if (reorderSection(settings, activeDrag.groupId, targetId, pos)) {
                await _callbacks.onMutation({ save: true });
            }
            return;
        }

        clearDropHighlights();
        dragState = null;
    };

    const cancelManagerDrag = () => {
        clearTempDraggable();
        clearDropHighlights();
        dragState = null;
    };
    modal.addEventListener('dragstart', startManagerDrag);
    modal.addEventListener('dragover', updateManagerDrag);
    modal.addEventListener('drop', dropManagerDrag);
    modal.addEventListener('dragend', cancelManagerDrag);
    const cleanupTouchDrag = bindManagerTouchDrag(modal, {
        start: startManagerDrag, over: updateManagerDrag, drop: dropManagerDrag, cancel: cancelManagerDrag,
    });
    const cleanupManager = _modalWindowCleanupMap.get(modal);
    _modalWindowCleanupMap.set(modal, () => {
        cleanupTouchDrag();
        cleanupManager?.();
    });

    modal.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        const target = ev.target instanceof Element ? ev.target : null;
        if (!target || target.tagName === 'BUTTON' || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
        const mainBtn = target.closest('.wbo-book-main[data-action]');
        if (mainBtn instanceof HTMLElement) {
            ev.preventDefault();
            mainBtn.click();
        }
    });

    modal.addEventListener('click', async (ev) => {
        const target = ev.target instanceof Element ? ev.target.closest('[data-action]') : null;
        if (!target || !_callbacks) return;

        const action = target.getAttribute('data-action');
        const { settings, classification } = _callbacks.getState();

        if (target.closest('#wbo-mgr-floating-tools') && [
            'select-filter', 'create-group', 'open-manage-groups', 'open-ai-organize',
            'open-combos-modal', 'open-scan-modal', 'toggle-batch-mode', 'run-inline-entry-search',
        ].includes(action)) closeFloatingTools();

        switch (action) {
            case 'reveal-char-books': {
                settings.showCharBooks = true;
                settings.charGroupCollapsed = false;
                promoteSectionToTop(settings, SPECIAL_GROUPS.CHARACTER);
                await _callbacks.onMutation({ save: true, charToggleOnly: true });
                break;
            }
            case 'select-filter': {
                const gid = target.getAttribute('data-group-id') || SPECIAL_GROUPS.DEFAULT;
                settings.activeFilterGroupId = gid;
                if (gid === SPECIAL_GROUPS.CHARACTER) {
                    settings.charGroupCollapsed = false;
                }
                if (_hasPendingPinResort) {
                    _hasPendingPinResort = false;
                    await _callbacks.onMutation({ save: true });
                } else {
                    refreshManagerModalContent();
                    await _callbacks.onMutation({ save: true, uiOnly: true });
                }
                break;
            }
            case 'toggle-group-collapse': {
                const gid = target.getAttribute('data-group-id');
                let willCollapse = false;
                if (gid === SPECIAL_GROUPS.CHARACTER) {
                    settings.charGroupCollapsed = !settings.charGroupCollapsed;
                    willCollapse = settings.charGroupCollapsed;
                } else if (gid === SPECIAL_GROUPS.UNGROUPED) {
                    settings.ungroupedCollapsed = !settings.ungroupedCollapsed;
                    willCollapse = settings.ungroupedCollapsed;
                } else if (gid === SPECIAL_GROUPS.PINNED) {
                    settings.pinnedGroupCollapsed = !settings.pinnedGroupCollapsed;
                    willCollapse = settings.pinnedGroupCollapsed;
                } else {
                    const grp = settings.groups.find((g) => g.id === gid);
                    if (grp) {
                        grp.collapsed = !grp.collapsed;
                        willCollapse = grp.collapsed;
                    }
                }
                renderManagerGroupsListOnly();
                if (willCollapse && gid) {
                    const collapsedEl = modal.querySelector(`#wbo-mgr-groups-list .wbo-group[data-group-id="${CSS.escape(gid)}"]`);
                    if (collapsedEl) scrollContentToItem(modal.querySelector('#wbo-mgr-groups-list'), collapsedEl);
                }
                await _callbacks.onMutation({ save: true, uiOnly: true });
                break;
            }
            case 'move-section-up': {
                const gid = target.getAttribute('data-group-id');
                if (gid && moveSectionOrder(settings, gid, -1, _renderedMovableSectionIds)) {
                    await _callbacks.onMutation({ save: true });
                }
                break;
            }
            case 'move-section-down': {
                const gid = target.getAttribute('data-group-id');
                if (gid && moveSectionOrder(settings, gid, 1, _renderedMovableSectionIds)) {
                    await _callbacks.onMutation({ save: true });
                }
                break;
            }
            case 'create-group': {
                openCreateOrRenameGroupModal(null);
                break;
            }
            case 'open-group-visibility': {
                const gid = target.getAttribute('data-group-id');
                const gname = target.getAttribute('data-group-name') || '分组';
                if (gid && target instanceof HTMLElement) {
                    openGroupVisibilityPopover(target, gid, gname);
                }
                break;
            }
            case 'open-mgr-search-opts': {
                if (target instanceof HTMLElement) {
                    openManagerSearchOptionsPopover(target);
                }
                break;
            }
            case 'run-inline-entry-search': {
                if (_mgrInlineEntrySignal) {
                    cancelManagerInlineEntrySearch();
                    syncManagerSearchBarUi();
                } else {
                    void runManagerInlineEntrySearch();
                }
                break;
            }
            case 'enable-and-run-entry-search': {
                settings.mgrSearchInEntries = true;
                syncManagerSearchBarUi();
                await _callbacks.onMutation({ save: true, uiOnly: true });
                void runManagerInlineEntrySearch();
                break;
            }
            case 'open-entry-search': {
                const autoRun = target.getAttribute('data-auto-run') === '1';
                openEntrySearchModal(_searchQuery.trim(), { autoRun });
                break;
            }
            case 'open-manage-groups': {
                openManageGroupsModal();
                break;
            }
            case 'rename-group': {
                const gid = target.getAttribute('data-group-id');
                const grp = settings.groups.find((g) => g.id === gid);
                if (grp) openCreateOrRenameGroupModal(grp);
                break;
            }
            case 'delete-group': {
                const gid = target.getAttribute('data-group-id');
                const grp = settings.groups.find((g) => g.id === gid);
                if (!grp) return;
                if (!globalThis.confirm(`删除分组「${grp.name}」？世界书本体不会被删除。`)) return;
                const affectedCount = Object.values(settings.assignments || {}).filter((assigned) => assigned === gid).length;
                pushUndoSnapshot(settings, { count: affectedCount, label: '删除分组' });
                settings.groups = settings.groups.filter((g) => g.id !== gid);
                for (const [book, assigned] of Object.entries(settings.assignments)) {
                    if (assigned === gid) delete settings.assignments[book];
                }
                if (settings.bookOrders && typeof settings.bookOrders === 'object') {
                    delete settings.bookOrders[gid];
                }
                if (settings.activeFilterGroupId === gid) {
                    settings.activeFilterGroupId = SPECIAL_GROUPS.DEFAULT;
                }
                await _callbacks.onMutation({ save: true });
                showToast('info', `已删除分组「${grp.name}」（可在「整理世界书」内撤销）`);
                break;
            }
            case 'toggle-global': {
                const row = target.closest('.wbo-book-row');
                const bookName = row?.getAttribute('data-book');
                if (!bookName) return;
                const nextActive = !getActiveGlobalWorldSet().has(bookName);
                setGlobalWorldActive(bookName, nextActive);
                syncEmbeddedPanelIndicators();
                break;
            }
            case 'toggle-batch-mode': {
                _batchMode = !_batchMode;
                if (!_batchMode) _batchSelected.clear();
                _lastModalListSig = null;
                syncBatchBarUi();
                renderManagerGroupsListOnly();
                break;
            }
            case 'toggle-batch-group': {
                const groupEl = target.closest('.wbo-group[data-group-id]');
                if (!groupEl) return;
                const names = getRenderedGroupBookNames(groupEl);
                if (names.length === 0) return;
                const cb = target instanceof HTMLInputElement ? target : groupEl.querySelector('.wbo-batch-group-check');
                const nextChecked = cb instanceof HTMLInputElement ? cb.checked : !names.every((n) => _batchSelected.has(n));
                for (const n of names) {
                    if (nextChecked) _batchSelected.add(n);
                    else _batchSelected.delete(n);
                }
                groupEl.querySelectorAll('.wbo-book-row[data-book]').forEach((row) => {
                    row.classList.toggle('is-batch-selected', nextChecked);
                    const rowCb = row.querySelector('.wbo-batch-check');
                    if (rowCb instanceof HTMLInputElement) rowCb.checked = nextChecked;
                });
                syncBatchBarUi();
                break;
            }
            case 'toggle-batch-item':
            case 'toggle-batch-row': {
                const row = target.closest('.wbo-book-row');
                const bookName = row?.getAttribute('data-book');
                if (!bookName) return;
                const cb = row.querySelector('.wbo-batch-check');
                let nextChecked;
                if (action === 'toggle-batch-item' && cb instanceof HTMLInputElement) {
                    nextChecked = cb.checked;
                } else {
                    nextChecked = !_batchSelected.has(bookName);
                    if (cb instanceof HTMLInputElement) cb.checked = nextChecked;
                }
                if (nextChecked) _batchSelected.add(bookName);
                else _batchSelected.delete(bookName);
                row.classList.toggle('is-batch-selected', nextChecked);
                syncBatchBarUi();
                break;
            }
            case 'toggle-pills-expand': {
                if (target.hidden) break;
                settings.groupPanelExpanded = target.getAttribute('aria-expanded') !== 'true';
                syncManagerPillsExpansion(overlay, settings.groupPanelExpanded);
                await _callbacks.onMutation({ save: true, uiOnly: true });
                break;
            }
            case 'open-combos-modal': {
                openGlobalCombosModal();
                break;
            }
            case 'apply-global-combo': {
                const cid = target.getAttribute('data-combo-id') || '';
                const preset = (settings.globalPresets || []).find((p) => p.id === cid);
                if (preset) {
                    const res = executeGlobalBooksSwitch(preset.books, {
                        mode: 'replace',
                        label: `启用「${preset.name}」`,
                    });
                    if (res.ok) {
                        const missHint = res.missing.length > 0 ? `（跳过 ${res.missing.length} 本不存在项）` : '';
                        showToast('success', `已切换至全局组合「${preset.name}」（共开启 ${res.nextActive.length} 本）${missHint}`);
                    }
                }
                break;
            }
            case 'undo-global-combo': {
                const snap = takeGlobalSwitchUndo();
                if (snap) {
                    const res = executeGlobalBooksSwitch(snap.prevBooks, {
                        mode: 'replace',
                        recordUndo: false,
                    });
                    if (res.ok) {
                        showToast('info', `已撤回，恢复切换前的 ${res.nextActive.length} 本全局世界书`);
                    }
                }
                break;
            }
            case 'batch-toggle-visible': {
                const groupEls = Array.from(modal.querySelectorAll('#wbo-mgr-groups-list .wbo-group[data-group-id]'));
                const allNames = groupEls.flatMap((g) => getRenderedGroupBookNames(g));
                const allSelected =
                    allNames.length > 0 &&
                    allNames.every((name) => _batchSelected.has(name));
                if (allSelected) {
                    allNames.forEach((name) => _batchSelected.delete(name));
                } else {
                    allNames.forEach((name) => _batchSelected.add(name));
                }
                modal.querySelectorAll('#wbo-mgr-groups-list .wbo-book-row[data-book]').forEach((row) => {
                    const name = row.getAttribute('data-book') || '';
                    const isChecked = _batchSelected.has(name);
                    row.classList.toggle('is-batch-selected', isChecked);
                    const cb = row.querySelector('.wbo-batch-check');
                    if (cb instanceof HTMLInputElement) cb.checked = isChecked;
                });
                syncBatchBarUi();
                break;
            }
            case 'batch-move': {
                if (_batchSelected.size > 0) {
                    openBatchMoveModal([..._batchSelected]);
                }
                break;
            }
            case 'batch-ungroup': {
                if (_batchSelected.size === 0) break;
                let ungroupedCount = 0;
                for (const name of [..._batchSelected]) {
                    let changedThis = false;
                    if (settings.assignments && name in settings.assignments) {
                        delete settings.assignments[name];
                        changedThis = true;
                    }
                    // If a real character-bound book was pulled out, or an unbound/embedded book was manually included, reset cleanly
                    const meta = classification.byName.get(name);
                    const hasRealBinding = Boolean(
                        (meta?.charOwners || []).some((o) => o && o.source !== 'embedded'),
                    );
                    if (hasRealBinding && settings.charBookOverrides?.[name] === 'exclude_from_char') {
                        delete settings.charBookOverrides[name];
                        changedThis = true;
                    } else if (settings.charBookOverrides?.[name] === 'include_in_char') {
                        if (meta?.isCharBound && !hasRealBinding) {
                            settings.charBookOverrides ||= {};
                            settings.charBookOverrides[name] = 'exclude_from_char';
                        } else {
                            delete settings.charBookOverrides[name];
                        }
                        changedThis = true;
                    }
                    if (changedThis) ungroupedCount += 1;
                }
                _batchSelected.clear();
                await _callbacks.onMutation({ save: true });
                showToast(
                    ungroupedCount > 0 ? 'success' : 'info',
                    ungroupedCount > 0 ? `已解除 ${ungroupedCount} 本世界书的分组` : '选中的世界书原本就未分组',
                );
                break;
            }
            case 'batch-delete': {
                if (_batchSelected.size > 0) {
                    await confirmAndDeleteWorldbooks([..._batchSelected]);
                }
                break;
            }
            case 'delete-single-book': {
                const holder = target.closest('.wbo-book-item, .wbo-book-row');
                const bookName = holder?.getAttribute('data-book');
                if (bookName) {
                    await confirmAndDeleteWorldbooks([bookName]);
                }
                break;
            }
            case 'toggle-book-preview': {
                const itemEl = target.closest('.wbo-book-item');
                const bookName = itemEl?.getAttribute('data-book');
                if (itemEl instanceof HTMLElement && bookName) {
                    await toggleInlineBookPreview(itemEl, bookName);
                }
                break;
            }
            case 'toggle-pin-book': {
                const holder = target.closest('.wbo-book-item, .wbo-book-row');
                const bookName = holder?.getAttribute('data-book');
                if (bookName) {
                    const nextPinned = togglePinnedBook(settings, bookName);
                    const meta = classification.byName.get(bookName);
                    if (meta) {
                        meta.isPinned = nextPinned;
                    }
                    const pinnedSet = new Set(Array.isArray(settings.pinnedBooks) ? settings.pinnedBooks : []);
                    classification.pinnedBooks = [...classification.byName.values()].filter((b) => pinnedSet.has(b.realName));
                    classification.pinnedCount = classification.pinnedBooks.length;
                    _hasPendingPinResort = true;

                    // Update star buttons in-place WITHOUT re-rendering or scrolling/teleporting the row!
                    const listEl = modal.querySelector('#wbo-mgr-groups-list');
                    listEl?.querySelectorAll(`.wbo-book-item[data-book="${CSS.escape(bookName)}"] .wbo-star-btn`).forEach((btn) => {
                        btn.classList.toggle('is-pinned', nextPinned);
                        btn.setAttribute('aria-pressed', nextPinned ? 'true' : 'false');
                        btn.setAttribute('title', nextPinned ? '取消收藏' : '收藏此世界书');
                        const icon = btn.querySelector('i');
                        if (icon) icon.className = `${nextPinned ? 'fa-solid' : 'fa-regular'} fa-star`;
                    });

                    // Update `★ 已收藏` filter pill count in-place
                    const pillsEl = modal.querySelector('#wbo-mgr-pills');
                    const groupBarEl = modal.querySelector('#wbo-mgr-groupbar');
                    const listCreateBtn = modal.querySelector('#wbo-mgr-list-create-btn');
                    if (pillsEl) {
                        let pinnedPill = pillsEl.querySelector(`.wbo-pill[data-group-id="${CSS.escape(SPECIAL_GROUPS.PINNED)}"]`);
                        if (pinnedPill) {
                            const cntEl = pinnedPill.querySelector('.wbo-pill-count');
                            if (cntEl) cntEl.textContent = String(classification.pinnedCount);
                        } else if (classification.pinnedCount > 0) {
                            const newPill = document.createElement('button');
                            newPill.type = 'button';
                            newPill.className = 'wbo-pill';
                            newPill.setAttribute('data-action', 'select-filter');
                            newPill.setAttribute('data-group-id', SPECIAL_GROUPS.PINNED);
                            newPill.innerHTML = `<span>★ 已收藏</span><span class="wbo-pill-count">${classification.pinnedCount}</span>`;
                            const firstPill = pillsEl.querySelector('.wbo-pill');
                            if (firstPill) firstPill.insertAdjacentElement('afterend', newPill);
                            else pillsEl.appendChild(newPill);
                            if (groupBarEl instanceof HTMLElement && groupBarEl.hidden && pillsEl.children.length > 1) {
                                groupBarEl.hidden = false;
                                if (listCreateBtn instanceof HTMLElement) listCreateBtn.hidden = true;
                            }
                        }
                        syncManagerPillsExpansion(overlay, settings.groupPanelExpanded);
                    }

                    await _callbacks.onMutation({ save: true, pinInPlaceOnly: true });
                    showToast('info', nextPinned ? `已收藏「${meta?.primaryTitle || bookName}」` : '已取消收藏');
                }
                break;
            }
            case 'book-more-menu': {
                const row = target.closest('.wbo-book-row');
                const bookName = row?.getAttribute('data-book');
                const meta = bookName ? classification.byName.get(bookName) : null;
                if (meta && target instanceof HTMLElement) {
                    openBookMorePopover(target, meta);
                }
                break;
            }
            case 'open-ai-organize': {
                openAiOrganizeModal();
                break;
            }
            case 'open-local-organize': {
                openAiOrganizeModal({ initialTab: 'local' });
                break;
            }
            case 'open-scan-modal': {
                document.getElementById('wbo-mgr-scan-btn')?.blur?.();
                openScanAndImportModal();
                break;
            }
            case 'open-scan-prompt-action': {
                const targetTab = target.getAttribute('data-scan-tab') || '';
                document.getElementById('wbo-mgr-scan-btn')?.blur?.();
                openScanAndImportModal({ initialTab: targetTab });
                break;
            }
            case 'open-settings-modal': {
                openSettingsModal();
                break;
            }
            case 'cycle-char-title-mode': {
                const order = ['char_with_sub', 'char_only', 'original'];
                const curIdx = order.indexOf(settings.charBookTitleMode);
                const nextMode = order[(curIdx + 1) % order.length];
                settings.charBookTitleMode = nextMode;
                await _callbacks.onMutation({ save: true });
                showToast('info', `角色世界书标题：${getCharTitleModeShortLabel(nextMode)}`);
                break;
            }
        }
    });

    refreshManagerModalContent();
    triggerPanelCatchupScanIfNeeded();
}

function syncManagerPillsExpansion(overlay, preferExpanded) {
    const subbar = overlay.querySelector('.wbo-mgr-subbar');
    const pills = overlay.querySelector('#wbo-mgr-pills');
    const toggle = overlay.querySelector('#wbo-mgr-pills-expand');
    if (overlay.hidden || !subbar || !pills || !toggle) return;

    const { scrollLeft, scrollTop } = pills;
    const scrollHost = getManagerScrollHost(overlay.querySelector('#wbo-mgr-groups-list'));
    const hostScrollTop = scrollHost?.scrollTop;
    // Compare against the single row's full width before reserving room for the toggle.
    subbar.classList.remove('is-pills-expanded');
    pills.classList.remove('is-expanded');
    toggle.style.position = 'absolute';
    const canExpand = pills.clientWidth > 0 && pills.scrollWidth > pills.clientWidth;
    toggle.style.removeProperty('position');
    const expanded = canExpand && Boolean(preferExpanded);

    toggle.hidden = !canExpand;
    toggle.title = expanded ? '收起为单行' : '展开查看全部分组';
    toggle.setAttribute('aria-expanded', String(expanded));
    const icon = toggle.querySelector('i');
    if (icon) icon.className = expanded ? 'fa-solid fa-chevron-up' : 'fa-solid fa-chevron-down';
    subbar.classList.toggle('is-pills-expanded', expanded);
    pills.classList.toggle('is-expanded', expanded);
    if (expanded) pills.scrollTop = scrollTop;
    else pills.scrollLeft = scrollLeft;
    // The temporary single-row measurement can clamp the small window's outer scroll.
    if (scrollHost) scrollHost.scrollTop = hostScrollTop;
}

/**
 * Refresh the Group Manager modal header indicators, filter pills, and list.
 */
function refreshManagerModalContent({ backgroundCatchUp = false } = {}) {
    const overlay = document.getElementById(MANAGER_OVERLAY_ID);
    if (!overlay || !_callbacks) return;

    const { settings, classification, bindingMap } = _callbacks.getState();
    const hasCustomGroups = classification.customGroups.length > 0;
    const orderedSections = classification.orderedSections || [];

    const cb = overlay.querySelector('#wbo-mgr-show-char');
    const lbl = overlay.querySelector('#wbo-mgr-char-label');
    if (cb instanceof HTMLInputElement) cb.checked = Boolean(settings.showCharBooks);
    if (lbl) lbl.textContent = `角色书 ${classification.charCount}`;

    const modalEl = overlay.querySelector('.wbo-modal');
    if (modalEl instanceof HTMLElement) applyThemeClass(modalEl);

    const characters = getCharactersInMemory();
    const scanPrompt = computeScanPromptState({
        worldNames: [...classification.byName.keys()],
        characters,
        bindingMap: bindingMap || new Map(),
        settings,
    });

    const scanBtn = overlay.querySelector('#wbo-mgr-scan-btn');
    const scanLbl = overlay.querySelector('#wbo-mgr-scan-label');
    if (scanBtn) scanBtn.classList.remove('is-active');
    if (scanLbl) scanLbl.textContent = scanPrompt.badgeCount > 0 ? `扫描 ${scanPrompt.badgeCount}` : '扫描';

    const promptEl = overlay.querySelector('#wbo-mgr-scan-prompt');
    if (promptEl instanceof HTMLElement) {
        if (scanPrompt.shouldShowPrompt) {
            const actionLabel = scanPrompt.promptKind === 'manual_scan' ? '立即扫描' : '查看处理';
            const targetTab = scanPrompt.sameNameNeedConfirmCount > 0 ? 'same_name' : '';
            promptEl.hidden = false;
            promptEl.innerHTML = `
                <span class="wbo-mgr-scan-prompt-text">${esc(scanPrompt.promptMessage)}</span>
                <button type="button" class="wbo-link-btn wbo-mgr-scan-prompt-btn" data-action="open-scan-prompt-action" data-scan-tab="${esc(targetTab)}">${esc(actionLabel)}</button>
            `;
        } else {
            promptEl.hidden = true;
            promptEl.innerHTML = '';
        }
    }

    const manageGroupsBtn = overlay.querySelector('#wbo-mgr-manage-groups-btn');
    if (manageGroupsBtn instanceof HTMLElement) {
        manageGroupsBtn.hidden = !hasCustomGroups;
    }

    const pills = [
        {
            id: SPECIAL_GROUPS.DEFAULT,
            label: settings.showCharBooks ? '全部' : '非角色书',
            count: settings.showCharBooks ? classification.totalCount : classification.nonCharCount,
        },
        ...(classification.pinnedCount > 0 || settings.activeFilterGroupId === SPECIAL_GROUPS.PINNED
            ? [{
                id: SPECIAL_GROUPS.PINNED,
                label: '★ 已收藏',
                count: classification.pinnedCount || 0,
            }]
            : []),
        ...orderedSections
            .filter((sec) => !(sec.kind === 'ungrouped' && !hasCustomGroups) && !(sec.kind === 'character' && !settings.showCharBooks))
            .map((sec) => ({
                id: sec.id,
                label: sec.name,
                color: sec.kind === 'custom' ? sec.color : undefined,
                count: sec.books.length,
            })),
    ];

    const showGroupBar = pills.length > 1;
    const groupBarEl = overlay.querySelector('#wbo-mgr-groupbar');
    const listCreateBtn = overlay.querySelector('#wbo-mgr-list-create-btn');
    if (groupBarEl instanceof HTMLElement) groupBarEl.hidden = !showGroupBar;
    if (listCreateBtn instanceof HTMLElement) listCreateBtn.hidden = showGroupBar;

    const pillsEl = overlay.querySelector('#wbo-mgr-pills');
    if (pillsEl) {
        pillsEl.innerHTML = showGroupBar
            ? pills
                .map((p) => {
                    const active = settings.activeFilterGroupId === p.id;
                    const dot = p.color ? `<span class="wbo-pill-dot" style="background:${esc(p.color)}"></span>` : '';
                    return `
                        <button type="button"
                            class="wbo-pill${active ? ' is-active' : ''}"
                            data-action="select-filter"
                            data-group-id="${esc(p.id)}">
                            ${dot}<span>${esc(p.label)}</span><span class="wbo-pill-count">${p.count}</span>
                        </button>
                    `;
                })
                .join('')
            : '';
    }

    syncManagerPillsExpansion(overlay, settings.groupPanelExpanded);

    syncManagerComboStripUi();
    syncManagerSearchBarUi();
    if (backgroundCatchUp && _activePreviewControllers.size > 0) {
        _hasPendingDeferredListRender = true;
    } else {
        _hasPendingDeferredListRender = false;
        renderManagerGroupsListOnly();
    }
    _syncFloatingGroupManager?.();
}

/**
 * Re-render ONLY `#wbo-mgr-groups-list` while preserving scroll position and search input!
 * @param {{ skipIndicatorSync?: boolean }} [options]
 * @returns {boolean} true if the list DOM was rebuilt, false if skipped
 */
function renderManagerGroupsListOnly({ skipIndicatorSync = false } = {}) {
    _hasPendingDeferredListRender = false;
    if (!_callbacks) return false;
    const listEl = document.getElementById('wbo-mgr-groups-list');
    if (!listEl) return false;

    const { settings, classification, bindingMap } = _callbacks.getState();
    const embeddedMatchSet = new Set();
    if (bindingMap instanceof Map) {
        const realBoundAvatars = new Set();
        for (const owners of bindingMap.values()) {
            for (const o of owners || []) {
                if (o && !o.orphan && o.source !== 'embedded' && o.avatar) {
                    realBoundAvatars.add(o.avatar);
                }
            }
        }
        for (const [worldName, owners] of bindingMap.entries()) {
            for (const o of owners || []) {
                if (o && !o.orphan && o.source === 'embedded' && realBoundAvatars.has(o.avatar)) {
                    embeddedMatchSet.add(worldName);
                }
            }
        }
    }
    const q = _searchQuery.trim();
    const orderedSections = classification.orderedSections || [];
    const liveGroupById = new Map((settings.groups || []).map((g) => [g.id, g]));

    const globalHiddenSet = new Set(Array.isArray(settings.globalHiddenGroupIds) ? settings.globalHiddenGroupIds : []);
    const editorHiddenSet = new Set(Array.isArray(settings.editorHiddenGroupIds) ? settings.editorHiddenGroupIds : []);
    const searchOpts = {
        searchBookName: settings.mgrSearchInBookName !== false,
        searchCharName: settings.mgrSearchInCharName !== false,
        splitSpaces: Boolean(settings.mgrSearchSplitSpaces),
    };

    const currentEditor = getCurrentEditorWorldName();
    const activeGlobals = getActiveGlobalWorldSet();
    const filterId = settings.activeFilterGroupId;
    const isAllView = filterId === SPECIAL_GROUPS.ALL || (filterId === SPECIAL_GROUPS.DEFAULT && settings.showCharBooks);
    const activeGlobalKey = isAllView ? JSON.stringify([...activeGlobals]) : '';
    // Read LIVE collapse & hidden-group state from `settings` (never stale cached `classification`!)
    const structSig = JSON.stringify([
        q,
        _batchMode,
        currentEditor || '',
        activeGlobalKey,
        settings.activeFilterGroupId,
        settings.charBookTitleMode,
        settings.aliasTitleMode,
        Boolean(settings.showCharBooks),
        Boolean(settings.charGroupCollapsed),
        Boolean(settings.ungroupedCollapsed),
        Boolean(settings.pinnedGroupCollapsed),
        searchOpts.searchBookName,
        searchOpts.searchCharName,
        Boolean(settings.mgrSearchInEntries),
        searchOpts.splitSpaces,
        [...globalHiddenSet].sort().join(','),
        [...editorHiddenSet].sort().join(','),
        [...embeddedMatchSet].sort().join(','),
        orderedSections.map((sec) => [
            sec.id,
            sec.name,
            sec.color,
            sec.kind === 'custom' ? Boolean(liveGroupById.get(sec.id)?.collapsed) : false,
            sec.books.map((b) => `${b.realName}|${b.primaryTitle}|${b.subtitle}|${b.note}|${b.isPinned ? 1 : 0}`).join(','),
        ]),
    ]);
    if (structSig === _lastModalListSig && listEl.childElementCount > 0) {
        if (!skipIndicatorSync) {
            syncEmbeddedPanelIndicators();
        }
        return false;
    }
    _lastModalListSig = structSig;
    listEl.dataset.wboActiveGlobals = activeGlobalKey;

    const scrollHost = getManagerScrollHost(listEl);
    const prevScroll = scrollHost.scrollTop;
    _renderedGroupBooksMap.clear();
    const hasCustomGroups = classification.customGroups.length > 0;
    const includeCharExplicitly = filterId === SPECIAL_GROUPS.CHARACTER || isAllView;
    const activeGlobalBooks = isAllView
        ? [...activeGlobals].map((name) => classification.byName.get(name)).filter((book) =>
            book && !book.isInCharGroup && (!q || matchesSearch(book, q, searchOpts)))
        : [];
    const activeGlobalNames = new Set(activeGlobalBooks.map((book) => book.realName));

    /** @type {Array<{ type: 'raw', html: string, isMovable?: boolean } | { type: 'section', id: string, name: string, color: string, collapsed: boolean, isCustom: boolean, isSingleView: boolean, isMovable: boolean, charBookTitleMode?: string, hiddenInGlobal?: boolean, hiddenInEditor?: boolean, books: Array<any> }>} */
    const renderSpecs = [];

    const pushSectionSpec = (sec, { isSingleView = false, isMovable = true, forceOpen = false } = {}) => {
        if (sec.kind === 'custom') {
            const books = sec.books.filter((b) => !activeGlobalNames.has(b.realName) && (!q || matchesSearch(b, q, searchOpts)));
            if (q && books.length === 0) return;
            const liveCollapsed = Boolean(liveGroupById.get(sec.id)?.collapsed);
            renderSpecs.push({
                type: 'section',
                id: sec.id,
                name: sec.name,
                color: sec.color,
                collapsed: (Boolean(q) || isSingleView || forceOpen) ? false : liveCollapsed,
                isCustom: true,
                isSingleView,
                isMovable: isMovable && !isSingleView,
                hiddenInGlobal: globalHiddenSet.has(sec.id),
                hiddenInEditor: editorHiddenSet.has(sec.id),
                books,
            });
            return;
        }
        if (sec.kind === 'ungrouped') {
            const books = sec.books.filter((b) => !activeGlobalNames.has(b.realName) && (!q || matchesSearch(b, q, searchOpts)));
            if ((q || !isSingleView) && books.length === 0) return;
            renderSpecs.push({
                type: 'section',
                id: SPECIAL_GROUPS.UNGROUPED,
                name: hasCustomGroups ? '未分组' : '非角色世界书',
                color: '#8c99a6',
                collapsed: (Boolean(q) || isSingleView || forceOpen) ? false : Boolean(settings.ungroupedCollapsed),
                isCustom: false,
                isSingleView,
                isMovable: isMovable && !isSingleView,
                hiddenInGlobal: globalHiddenSet.has(SPECIAL_GROUPS.UNGROUPED),
                hiddenInEditor: editorHiddenSet.has(SPECIAL_GROUPS.UNGROUPED),
                books,
            });
            return;
        }
        if (sec.kind === 'character' && classification.charCount > 0) {
            const matchedCharBooks = q ? sec.books.filter((b) => matchesSearch(b, q, searchOpts)) : sec.books;
            if (q && matchedCharBooks.length === 0) return;
            renderSpecs.push({
                type: 'section',
                id: SPECIAL_GROUPS.CHARACTER,
                name: '角色世界书',
                color: '#7c8594',
                collapsed: (Boolean(q) || isSingleView || forceOpen) ? false : Boolean(settings.charGroupCollapsed),
                isCustom: false,
                isSingleView,
                isMovable: isMovable && !isSingleView,
                charBookTitleMode: settings.charBookTitleMode,
                hiddenInGlobal: globalHiddenSet.has(SPECIAL_GROUPS.CHARACTER),
                hiddenInEditor: editorHiddenSet.has(SPECIAL_GROUPS.CHARACTER),
                books: matchedCharBooks,
            });
        }
    };

    if (filterId === SPECIAL_GROUPS.PINNED) {
        const pinnedList = q
            ? (classification.pinnedBooks || []).filter((b) => matchesSearch(b, q, searchOpts))
            : (classification.pinnedBooks || []);
        if (pinnedList.length > 0) {
            renderSpecs.push({
                type: 'section',
                id: SPECIAL_GROUPS.PINNED,
                name: '★ 已收藏',
                color: '#e09f3e',
                collapsed: Boolean(q) ? false : Boolean(settings.pinnedGroupCollapsed),
                isCustom: false,
                isSingleView: false,
                isMovable: false,
                books: pinnedList,
            });
        } else {
            renderSpecs.push({
                type: 'raw',
                html: `<div class="wbo-empty-hint">${q ? '已收藏中无匹配世界书' : '暂无已收藏的世界书，点击书行右侧 ★ 即可收藏'}</div>`,
            });
        }
    } else if (isAllView) {
        const charSec = orderedSections.find((section) => section.kind === 'character');
        if (charSec) pushSectionSpec(charSec, { isMovable: false });
        if (activeGlobalBooks.length > 0) {
            renderSpecs.push({
                type: 'section',
                id: ACTIVE_GLOBAL_SECTION_ID,
                name: '已开启的全局世界书',
                color: '#6b8d85',
                collapsed: false,
                isSingleView: true,
                isMovable: false,
                books: activeGlobalBooks,
            });
        }
        const pinnedList = (classification.pinnedBooks || []).filter((book) =>
            !activeGlobalNames.has(book.realName) && (!q || matchesSearch(book, q, searchOpts)));
        if (pinnedList.length > 0) {
            renderSpecs.push({
                type: 'section',
                id: SPECIAL_GROUPS.PINNED,
                name: '★ 已收藏',
                color: '#e09f3e',
                collapsed: Boolean(q) ? false : Boolean(settings.pinnedGroupCollapsed),
                isCustom: false,
                isSingleView: false,
                isMovable: false,
                books: pinnedList,
            });
        }
        orderedSections.forEach((section) => {
            if (section.kind !== 'character') pushSectionSpec(section);
        });
    } else {
        if (filterId === SPECIAL_GROUPS.DEFAULT && !settings.showCharBooks && currentEditor) {
            const editingMeta = classification.byName.get(currentEditor);
            if (editingMeta?.isInCharGroup && (!q || matchesSearch(editingMeta, q, searchOpts))) {
                renderSpecs.push({
                    type: 'raw',
                    html: `<div class="wbo-mgr-bare-editing">${renderBookRowHtml(editingMeta, activeGlobals, currentEditor, embeddedMatchSet)}</div>`,
                });
            }
        }
        orderedSections.forEach((sec) => {
            if (sec.kind === 'custom') {
                if (filterId !== SPECIAL_GROUPS.DEFAULT && filterId !== sec.id) return;
                pushSectionSpec(sec, { isSingleView: filterId === sec.id, isMovable: filterId !== sec.id });
                return;
            }
            if (sec.kind === 'ungrouped') {
                if (filterId !== SPECIAL_GROUPS.DEFAULT && filterId !== SPECIAL_GROUPS.UNGROUPED) return;
                pushSectionSpec(sec, { isSingleView: filterId === SPECIAL_GROUPS.UNGROUPED, isMovable: filterId !== SPECIAL_GROUPS.UNGROUPED });
                return;
            }
            if (sec.kind === 'character' && classification.charCount > 0) {
                if (includeCharExplicitly) {
                    pushSectionSpec(sec, { isSingleView: filterId === SPECIAL_GROUPS.CHARACTER, isMovable: false });
                } else if (filterId === SPECIAL_GROUPS.DEFAULT && q) {
                    const matchedCharBooks = sec.books.filter((b) => matchesSearch(b, q, searchOpts));
                    if (matchedCharBooks.length > 0) {
                        renderSpecs.push({
                            type: 'raw',
                            html: `
                                <div class="wbo-char-match-bar">
                                    <span>已隐藏的角色书中有 ${matchedCharBooks.length} 项匹配</span>
                                    <button type="button" class="wbo-link-btn" data-action="reveal-char-books">查看</button>
                                </div>
                            `,
                        });
                    }
                }
            }
        });
    }

    const visibleMovableIds = renderSpecs
        .filter((s) => s.type === 'section' && s.isMovable)
        .map((s) => s.id);
    _renderedMovableSectionIds = visibleMovableIds;
    const boundsMap = getVisibleSectionMoveBounds(visibleMovableIds);

    const sections = renderSpecs.map((spec) => {
        if (spec.type === 'raw') return spec.html;
        const bnd = spec.isMovable ? boundsMap.get(spec.id) : null;
        return renderGroupSectionHtml({
            id: spec.id,
            name: spec.name,
            color: spec.color,
            collapsed: spec.collapsed,
            isCustom: spec.isCustom,
            isSingleView: spec.isSingleView,
            hideOrderActions: !spec.isMovable,
            charBookTitleMode: spec.charBookTitleMode,
            hiddenInGlobal: spec.hiddenInGlobal,
            hiddenInEditor: spec.hiddenInEditor,
            canMoveUp: Boolean(bnd?.canMoveUp),
            canMoveDown: Boolean(bnd?.canMoveDown),
            books: spec.books,
            activeGlobals,
            currentEditor,
            embeddedMatchSet,
        });
    });

    if (q && !settings.mgrSearchInEntries) {
        sections.push(`
            <div class="wbo-entry-search-hint-bar">
                <span>想在条目正文中找「${esc(q)}」？</span>
                <button type="button" class="wbo-btn wbo-entry-search-hint-btn" data-action="enable-and-run-entry-search">
                    <i class="fa-solid fa-magnifying-glass"></i> 搜条目内容
                </button>
            </div>
        `);
    }

    destroyAllPreviewControllers();
    listEl.innerHTML = sections.length > 0
        ? sections.join('')
        : (q && settings.mgrSearchInEntries
            ? '<div class="wbo-empty-hint">按回车或点上方「搜索」开始检索条目内容</div>'
            : '<div class="wbo-empty-hint">无匹配世界书</div>');

    scrollHost.scrollTop = prevScroll;
    syncBatchBarUi();
    return true;
}

/**
 * Create or edit a custom group (including batch member selection for BOTH new and existing groups).
 */
function openCreateOrRenameGroupModal(group, { initialBookName = null } = {}) {
    if (!_callbacks) return;
    const { settings, classification } = _callbacks.getState();
    const isEdit = Boolean(group);
    const initialColor = group?.color || GROUP_COLOR_PALETTE[settings.groups.length % GROUP_COLOR_PALETTE.length];

    const swatches = GROUP_COLOR_PALETTE.map(
        (c) => `<button type="button" class="wbo-swatch${c === initialColor ? ' is-selected' : ''}" data-color="${c}" style="background:${c}" aria-label="颜色 ${c}"></button>`,
    ).join('');

    const {
        currentMemberSet,
        currentMembers,
        ungroupedBooks,
        otherGroups,
        otherTotalCount,
        allCandidates,
    } = partitionGroupPickerBooks({
        classification,
        groupId: isEdit && group ? group.id : null,
        initialBookName,
    });

    const pickedSet = new Set(currentMemberSet);

    const renderPickRow = (b, sectionKind) => {
        const checked = pickedSet.has(b.realName) ? ' checked' : '';
        return `
            <label class="wbo-ai-pick-row wbo-gp-row" data-gp-row-sec="${esc(sectionKind)}" data-gp-group-id="${esc(b.groupId)}" data-pick-search="${esc(b.searchableText || b.realName.toLowerCase())}">
                <input type="checkbox" class="wbo-group-pick-check" value="${esc(b.realName)}"${checked}>
                <span class="wbo-ai-pick-name" title="${esc(b.realName)}">${esc(b.primaryTitle)}${b.subtitle ? ` <small>${esc(b.subtitle)}</small>` : ''}</span>
                <span class="wbo-tag">${esc(b.groupName)}</span>
            </label>
        `;
    };

    const currentSectionHtml = currentMembers.length > 0
        ? `
            <div class="wbo-gp-sec" data-gp-sec="current">
                <div class="wbo-gp-sec-head">
                    <span>本组内世界书 <small>(${currentMembers.length})</small></span>
                </div>
                <div class="wbo-gp-sec-body">
                    ${currentMembers.map((b) => renderPickRow(b, 'current')).join('')}
                </div>
            </div>
        `
        : '';

    const ungroupedSectionHtml = ungroupedBooks.length > 0
        ? `
            <div class="wbo-gp-sec" data-gp-sec="ungrouped">
                <div class="wbo-gp-sec-head">
                    <span>未分组 <small>(${ungroupedBooks.length})</small></span>
                </div>
                <div class="wbo-gp-sec-body">
                    ${ungroupedBooks.map((b) => renderPickRow(b, 'ungrouped')).join('')}
                </div>
            </div>
        `
        : '';

    const otherGroupsHtml = otherGroups.length > 0
        ? `
            <div class="wbo-gp-sec is-collapsed" data-gp-sec="other">
                <button type="button" class="wbo-gp-sec-toggle" id="wbo-gp-other-toggle" aria-expanded="false">
                    <i class="fa-solid fa-chevron-right wbo-gp-chev"></i>
                    <span>已在其他分组的世界书 <small>(${otherTotalCount})</small></span>
                </button>
                <div class="wbo-gp-sec-body" id="wbo-gp-other-body" hidden>
                    ${otherGroups.map((og) => `
                        <div class="wbo-gp-sub" data-gp-sub="${esc(og.id)}">
                            <button type="button" class="wbo-gp-sub-toggle" data-gp-sub-toggle="${esc(og.id)}" aria-expanded="true">
                                <i class="fa-solid fa-chevron-down wbo-gp-chev"></i>
                                <span class="wbo-group-dot" style="background:${esc(og.color)}"></span>
                                <span class="wbo-gp-sub-name">${esc(og.name)}</span>
                                <span class="wbo-tag">${og.books.length}</span>
                            </button>
                            <div class="wbo-gp-sub-body">
                                ${og.books.map((b) => renderPickRow(b, 'other')).join('')}
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `
        : '';

    const pickSectionHtml = allCandidates.length > 0
        ? `
            <div class="wbo-field wbo-group-pick-field">
                <div class="wbo-ai-section-head">
                    <span>${isEdit ? '管理分组内的世界书' : '选择要加入此分组的世界书'}</span>
                    <span class="wbo-tag" id="wbo-gp-picked-badge">已选 ${pickedSet.size}</span>
                </div>
                <div class="wbo-gp-pills wbo-book-group-switcher" id="wbo-gp-pills" role="group" aria-label="世界书分组">
                    <button type="button" class="wbo-pill" data-gp-pill="ungrouped">
                        <span>未分组</span><span class="wbo-pill-count">${ungroupedBooks.length}</span>
                    </button>
                    <button type="button" class="wbo-pill" data-gp-pill="selected">
                        <span>已选</span><span class="wbo-pill-count" id="wbo-gp-selected-pill-count">${pickedSet.size}</span>
                    </button>
                    <button type="button" class="wbo-pill is-active" data-gp-pill="all" aria-pressed="true">
                        <span>全部</span><span class="wbo-pill-count">${allCandidates.length}</span>
                    </button>
                    ${otherTotalCount > 0 ? `
                        <button type="button" class="wbo-pill" data-gp-pill="other">
                            <span>其他已分组</span><span class="wbo-pill-count">${otherTotalCount}</span>
                        </button>
                    ` : ''}
                    ${currentMembers.length ? `
                        <button type="button" class="wbo-pill" data-gp-pill="current">
                            <span>本组</span><span class="wbo-pill-count">${currentMembers.length}</span>
                        </button>` : ''}
                    ${otherGroups.map((item) => `
                        <button type="button" class="wbo-pill" data-gp-pill="group:${esc(item.id)}">
                            <span>${esc(item.name)}</span><span class="wbo-pill-count">${item.books.length}</span>
                        </button>`).join('')}
                </div>
                <div class="wbo-gp-toolbar">
                    <input type="search" class="wbo-input wbo-group-pick-filter" id="wbo-group-pick-filter" placeholder="搜索书名/别名/角色..." autocomplete="off" spellcheck="false">
                    ${ungroupedBooks.length > 0 ? '<button type="button" class="wbo-btn wbo-gp-quick-btn" id="wbo-gp-select-ungrouped-btn">全选当前所有未分组</button>' : ''}
                </div>
                <div class="wbo-ai-book-list wbo-group-pick-list" id="wbo-group-pick-list">
                    ${currentSectionHtml}
                    ${ungroupedSectionHtml}
                    ${otherGroupsHtml}
                    <div class="wbo-empty-hint" id="wbo-gp-empty" hidden>当前筛选下无匹配世界书</div>
                </div>
            </div>
        `
        : '';

    const { modal } = createSubModal(
        isEdit ? '编辑分组' : '新建分组',
        `
            <div class="wbo-step-scroll wbo-group-edit-scroll">
                <div class="wbo-field">
                    <label class="wbo-label">分组名称</label>
                    <input type="text" class="wbo-input" id="wbo-group-name-input" value="${esc(group?.name || '')}" placeholder="例如：文风设定、世界观、系统规则" spellcheck="false">
                </div>
                <div class="wbo-field">
                    <label class="wbo-label">标识颜色</label>
                    <div class="wbo-swatches">${swatches}</div>
                </div>
                ${pickSectionHtml}
            </div>
            <div class="wbo-modal-footer wbo-pinned-footer wbo-footer-pair">
                <button type="button" class="wbo-btn wbo-btn-primary" id="wbo-save-group-btn">${isEdit ? '保存' : '创建'}</button>
                <button type="button" class="wbo-btn" id="wbo-cancel-btn">取消</button>
            </div>
        `,
        { wide: true, pinnedLayout: true },
    );

    let chosenColor = initialColor;
    modal.querySelectorAll('.wbo-swatch').forEach((btn) => {
        btn.addEventListener('click', () => {
            chosenColor = btn.getAttribute('data-color') || initialColor;
            modal.querySelectorAll('.wbo-swatch').forEach((b) => b.classList.remove('is-selected'));
            btn.classList.add('is-selected');
        });
    });

    const pickListEl = modal.querySelector('#wbo-group-pick-list');
    const pickFilter = modal.querySelector('#wbo-group-pick-filter');
    const pillsWrap = modal.querySelector('#wbo-gp-pills');
    const quickUngroupedBtn = modal.querySelector('#wbo-gp-select-ungrouped-btn');
    const otherSecEl = modal.querySelector('.wbo-gp-sec[data-gp-sec="other"]');
    const otherToggleBtn = modal.querySelector('#wbo-gp-other-toggle');
    const otherBodyEl = modal.querySelector('#wbo-gp-other-body');

    let activeGpPill = 'all';
    let otherManuallyExpanded = false;

    const syncPickedCounters = () => {
        const badge = modal.querySelector('#wbo-gp-picked-badge');
        const pillCnt = modal.querySelector('#wbo-gp-selected-pill-count');
        if (badge) badge.textContent = `已选 ${pickedSet.size}`;
        if (pillCnt) pillCnt.textContent = String(pickedSet.size);
    };

    const syncQuickUngroupedLabel = () => {
        if (!(quickUngroupedBtn instanceof HTMLButtonElement) || !pickListEl) return;
        const visibleUngrouped = Array.from(
            pickListEl.querySelectorAll('.wbo-gp-row[data-gp-row-sec="ungrouped"]'),
        ).filter((row) => row instanceof HTMLElement && !row.hidden);
        quickUngroupedBtn.disabled = visibleUngrouped.length === 0;
        const allChecked = visibleUngrouped.length > 0 && visibleUngrouped.every((row) => {
            const cb = row.querySelector('.wbo-group-pick-check');
            return cb instanceof HTMLInputElement && pickedSet.has(cb.value);
        });
        quickUngroupedBtn.textContent = allChecked ? '取消全选当前未分组' : '全选当前所有未分组';
    };

    const applyPickerFilters = () => {
        if (!pickListEl) return;
        const q = pickFilter instanceof HTMLInputElement ? pickFilter.value.trim().toLowerCase() : '';
        const groupId = activeGpPill.startsWith('group:') ? activeGpPill.slice('group:'.length) : '';
        const forceOtherOpen = Boolean(q || groupId) || activeGpPill === 'other' || activeGpPill === 'selected';
        const showOtherBody = forceOtherOpen || otherManuallyExpanded;

        if (otherSecEl instanceof HTMLElement && otherBodyEl instanceof HTMLElement && otherToggleBtn) {
            otherSecEl.classList.toggle('is-collapsed', !showOtherBody);
            otherBodyEl.hidden = !showOtherBody;
            otherToggleBtn.setAttribute('aria-expanded', showOtherBody ? 'true' : 'false');
            const chev = otherToggleBtn.querySelector('.wbo-gp-chev');
            if (chev) chev.className = `fa-solid ${showOtherBody ? 'fa-chevron-down' : 'fa-chevron-right'} wbo-gp-chev`;
        }

        let totalVisibleRows = 0;
        pickListEl.querySelectorAll('.wbo-gp-row').forEach((row) => {
            if (!(row instanceof HTMLElement)) return;
            const secKind = row.getAttribute('data-gp-row-sec') || '';
            const cb = row.querySelector('.wbo-group-pick-check');
            const val = cb instanceof HTMLInputElement ? cb.value : '';
            const hay = row.getAttribute('data-pick-search') || '';

            let matchPill = true;
            if (activeGpPill === 'ungrouped') matchPill = secKind === 'ungrouped';
            else if (activeGpPill === 'current') matchPill = secKind === 'current';
            else if (activeGpPill === 'selected') matchPill = Boolean(val && pickedSet.has(val));
            else if (activeGpPill === 'other') matchPill = secKind === 'other';
            else if (groupId) matchPill = row.getAttribute('data-gp-group-id') === groupId;

            const matchSearch = !q || hay.includes(q);
            const show = matchPill && matchSearch;
            row.hidden = !show;
            if (show) totalVisibleRows += 1;
        });

        // Hide empty sub-groups & outer sections under current filter
        pickListEl.querySelectorAll('.wbo-gp-sub').forEach((subEl) => {
            if (!(subEl instanceof HTMLElement)) return;
            const hasVisible = Array.from(subEl.querySelectorAll('.wbo-gp-row')).some(
                (r) => r instanceof HTMLElement && !r.hidden,
            );
            subEl.hidden = !hasVisible;
            if (groupId && hasVisible) {
                const body = subEl.querySelector('.wbo-gp-sub-body');
                const toggle = subEl.querySelector('.wbo-gp-sub-toggle');
                if (body) body.hidden = false;
                if (toggle) toggle.setAttribute('aria-expanded', 'true');
                const icon = toggle?.querySelector('.wbo-gp-chev');
                if (icon) icon.className = 'fa-solid fa-chevron-down wbo-gp-chev';
            }
        });
        pickListEl.querySelectorAll('.wbo-gp-sec').forEach((secEl) => {
            if (!(secEl instanceof HTMLElement)) return;
            const hasVisible = Array.from(secEl.querySelectorAll('.wbo-gp-row')).some(
                (r) => r instanceof HTMLElement && !r.hidden,
            );
            secEl.hidden = !hasVisible;
        });

        const emptyHint = pickListEl.querySelector('#wbo-gp-empty');
        if (emptyHint instanceof HTMLElement) {
            emptyHint.hidden = totalVisibleRows > 0;
        }
        syncQuickUngroupedLabel();
    };

    pillsWrap?.addEventListener('click', (ev) => {
        const btn = ev.target instanceof Element ? ev.target.closest('[data-gp-pill]') : null;
        if (!btn) return;
        activeGpPill = btn.getAttribute('data-gp-pill') || 'all';
        pillsWrap.querySelectorAll('[data-gp-pill]').forEach((b) => {
            b.classList.toggle('is-active', b === btn);
            b.setAttribute('aria-pressed', String(b === btn));
        });
        applyPickerFilters();
    });

    otherToggleBtn?.addEventListener('click', () => {
        otherManuallyExpanded = !otherManuallyExpanded;
        applyPickerFilters();
    });

    pickListEl?.addEventListener('click', (ev) => {
        const subToggle = ev.target instanceof Element ? ev.target.closest('[data-gp-sub-toggle]') : null;
        if (!subToggle) return;
        const subEl = subToggle.closest('.wbo-gp-sub');
        const body = subEl?.querySelector('.wbo-gp-sub-body');
        if (!(body instanceof HTMLElement)) return;
        const willOpen = body.hidden;
        body.hidden = !willOpen;
        subToggle.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
        const chev = subToggle.querySelector('.wbo-gp-chev');
        if (chev) chev.className = `fa-solid ${willOpen ? 'fa-chevron-down' : 'fa-chevron-right'} wbo-gp-chev`;
    });

    pickListEl?.addEventListener('change', (ev) => {
        const cb = ev.target;
        if (!(cb instanceof HTMLInputElement) || !cb.classList.contains('wbo-group-pick-check')) return;
        if (cb.checked) pickedSet.add(cb.value);
        else pickedSet.delete(cb.value);
        syncPickedCounters();
        if (activeGpPill === 'selected') {
            applyPickerFilters();
        } else {
            syncQuickUngroupedLabel();
        }
    });

    quickUngroupedBtn?.addEventListener('click', () => {
        if (!pickListEl) return;
        const visibleUngrouped = Array.from(
            pickListEl.querySelectorAll('.wbo-gp-row[data-gp-row-sec="ungrouped"]'),
        ).filter((row) => row instanceof HTMLElement && !row.hidden);
        if (visibleUngrouped.length === 0) return;
        const allChecked = visibleUngrouped.every((row) => {
            const cb = row.querySelector('.wbo-group-pick-check');
            return cb instanceof HTMLInputElement && pickedSet.has(cb.value);
        });
        for (const row of visibleUngrouped) {
            const cb = row.querySelector('.wbo-group-pick-check');
            if (!(cb instanceof HTMLInputElement)) continue;
            cb.checked = !allChecked;
            if (!allChecked) pickedSet.add(cb.value);
            else pickedSet.delete(cb.value);
        }
        syncPickedCounters();
        syncQuickUngroupedLabel();
    });

    if (pickFilter instanceof HTMLInputElement) {
        let composing = false;
        pickFilter.addEventListener('compositionstart', () => { composing = true; });
        pickFilter.addEventListener('compositionend', () => { composing = false; applyPickerFilters(); });
        pickFilter.addEventListener('input', () => { if (!composing) applyPickerFilters(); });
    }

    applyPickerFilters();

    const input = modal.querySelector('#wbo-group-name-input');
    if (input instanceof HTMLInputElement && isDesktopAutoFocusAllowed()) {
        input.focus();
        input.select();
    }

    const submit = async () => {
        const name = input instanceof HTMLInputElement ? input.value.trim() : '';
        if (!name) {
            showToast('warning', '请输入分组名称');
            return;
        }
        const duplicate = (settings.groups || []).some(
            (g) => g.id !== group?.id && g.name.trim().toLowerCase() === name.toLowerCase(),
        );
        if (duplicate) {
            showToast('warning', `已存在同名分组「${name}」，请换一个名称`);
            if (input instanceof HTMLInputElement && isDesktopAutoFocusAllowed()) {
                input.focus();
            }
            return;
        }

        if (isEdit && group) {
            group.name = name;
            group.color = chosenColor;
            for (const prevBook of currentMemberSet) {
                if (!pickedSet.has(prevBook) && settings.assignments[prevBook] === group.id) {
                    delete settings.assignments[prevBook];
                }
            }
            for (const bookName of pickedSet) {
                settings.assignments[bookName] = group.id;
                const meta = classification.byName.get(bookName);
                if (meta?.isCharBound) {
                    settings.charBookOverrides[bookName] = 'exclude_from_char';
                }
            }
        } else {
            const created = addCustomGroup(settings, { name, color: chosenColor });
            for (const bookName of pickedSet) {
                settings.assignments[bookName] = created.id;
                const meta = classification.byName.get(bookName);
                if (meta?.isCharBound) {
                    settings.charBookOverrides[bookName] = 'exclude_from_char';
                }
            }
            if (settings.activeFilterGroupId !== SPECIAL_GROUPS.DEFAULT && settings.activeFilterGroupId !== SPECIAL_GROUPS.ALL) {
                settings.activeFilterGroupId = created.id;
            }
        }
        closeSubModal();
        await _callbacks.onMutation({ save: true });
        showToast('success', isEdit ? `已更新分组「${name}」` : `已新建分组「${name}」`);
    };

    modal.querySelector('#wbo-cancel-btn')?.addEventListener('click', closeSubModal);
    modal.querySelector('#wbo-save-group-btn')?.addEventListener('click', () => submit());
    bindImeSafeEnter(input, () => submit());
}

/**
 * Edit display alias OR perform a real rename (with full binding sync).
 */
function openAliasNoteModal(bookMeta) {
    if (!_callbacks) return;
    const { settings } = _callbacks.getState();

    const initialDisplayValue = bookMeta.alias || bookMeta.primaryTitle;
    const initialRealValue = bookMeta.alias || bookMeta.realName;

    const { modal } = createSubModal(
        '编辑名称与备注',
        `
            <div class="wbo-field">
                <label class="wbo-label">原文件名：<code>${esc(bookMeta.realName)}</code></label>
            </div>
            <div class="wbo-radio-row">
                <label class="wbo-radio-opt">
                    <input type="radio" name="wbo-rename-mode" value="alias" checked>
                    <span>仅改显示名</span>
                </label>
                <label class="wbo-radio-opt">
                    <input type="radio" name="wbo-rename-mode" value="real">
                    <span>真实改名并同步绑定</span>
                </label>
            </div>
            <div class="wbo-real-hint" id="wbo-real-rename-hint" hidden>
                同步更新角色卡主/附绑定、User 人设绑定、当前聊天与全局激活；未打开的旧聊天单聊绑定与脚本里写死的固定书名需自行留意。
            </div>
            <div class="wbo-field">
                <label class="wbo-label" id="wbo-name-input-label">显示名称</label>
                <div class="wbo-input-clear-row">
                    <input type="text" class="wbo-input" id="wbo-alias-input" value="${esc(initialDisplayValue)}" placeholder="${esc(bookMeta.primaryTitle)}" spellcheck="false">
                    <button type="button" class="wbo-btn wbo-input-clear-btn" id="wbo-clear-name-input-btn" title="清空输入框">清空</button>
                </div>
            </div>
            <div class="wbo-field">
                <label class="wbo-label">备注</label>
                <input type="text" class="wbo-input" id="wbo-note-input" value="${esc(bookMeta.note || '')}" placeholder="用途或特点" spellcheck="false">
            </div>
            <div class="wbo-ai-status" id="wbo-rename-status"></div>
            <div class="wbo-modal-footer">
                <button type="button" class="wbo-btn" id="wbo-clear-alias-btn">恢复默认</button>
                <span class="wbo-spacer"></span>
                <button type="button" class="wbo-btn wbo-btn-primary" id="wbo-save-alias-btn">保存</button>
                <button type="button" class="wbo-btn" id="wbo-cancel-btn">取消</button>
            </div>
        `,
    );

    const aliasInput = modal.querySelector('#wbo-alias-input');
    const noteInput = modal.querySelector('#wbo-note-input');
    const realHint = modal.querySelector('#wbo-real-rename-hint');
    const nameLabel = modal.querySelector('#wbo-name-input-label');
    const clearBtn = modal.querySelector('#wbo-clear-alias-btn');
    const clearInputBtn = modal.querySelector('#wbo-clear-name-input-btn');
    const statusEl = modal.querySelector('#wbo-rename-status');

    let userEditedName = false;
    aliasInput?.addEventListener('input', () => {
        userEditedName = true;
    });

    const getMode = () => modal.querySelector('input[name="wbo-rename-mode"]:checked')?.value || 'alias';

    modal.querySelectorAll('input[name="wbo-rename-mode"]').forEach((radio) => {
        radio.addEventListener('change', () => {
            const isReal = getMode() === 'real';
            if (realHint instanceof HTMLElement) realHint.hidden = !isReal;
            if (nameLabel) nameLabel.textContent = isReal ? '新文件名' : '显示名称';
            if (clearBtn instanceof HTMLElement) clearBtn.hidden = isReal;
            if (aliasInput instanceof HTMLInputElement && !userEditedName) {
                aliasInput.value = isReal ? initialRealValue : initialDisplayValue;
            }
        });
    });

    // Avoid auto-popping iOS virtual keyboard during fullscreen modal mount (can destabilize WKWebView)
    if (aliasInput instanceof HTMLInputElement && isDesktopAutoFocusAllowed()) {
        aliasInput.focus();
    }

    const save = async () => {
        const mode = getMode();
        const inputName = aliasInput instanceof HTMLInputElement ? aliasInput.value.trim() : '';
        const note = noteInput instanceof HTMLInputElement ? noteInput.value.trim() : '';

        if (mode === 'real') {
            if (!inputName) {
                if (statusEl) {
                    statusEl.textContent = '真实改名不能为空';
                    statusEl.className = 'wbo-ai-status is-error';
                }
                return;
            }
            const saveBtn = modal.querySelector('#wbo-save-alias-btn');
            if (saveBtn instanceof HTMLButtonElement) saveBtn.disabled = true;
            if (statusEl) {
                statusEl.textContent = '正在改名并同步绑定...';
                statusEl.className = 'wbo-ai-status';
            }

            const res = await realRenameWorldbook(bookMeta.realName, inputName, settings);
            if (!res.ok) {
                if (statusEl) {
                    statusEl.textContent = res.error || '改名失败';
                    statusEl.className = 'wbo-ai-status is-error';
                }
                if (saveBtn instanceof HTMLButtonElement) saveBtn.disabled = false;
                return;
            }
            if (note) settings.notes[inputName] = note;
            else delete settings.notes[inputName];
            delete settings.aliases[inputName];

            closeSubModal();
            // Avoid full `onRescan()` (`/api/settings/get` + double save) which can trigger iOS WebView OOM;
            // `realRenameWorldbook` already refreshed the host world list & migrated bindings in memory.
            await _callbacks.onMutation({ save: true });
            const m = res.migrated;
            const summary = [
                m?.chars ? `${m.chars} 张角色卡` : '',
                m?.extras ? `${m.extras} 条附加绑定` : '',
                m?.personas ? `${m.personas} 个人设` : '',
            ].filter(Boolean).join('、');
            showToast('success', `已改名为「${inputName}」${summary ? `，同步更新 ${summary}` : ''}`);
            return;
        }

        const isUnchangedDefault = !bookMeta.alias && inputName === bookMeta.primaryTitle;
        if (inputName && inputName !== bookMeta.realName && !isUnchangedDefault) {
            settings.aliases[bookMeta.realName] = inputName;
        } else if (!inputName || inputName === bookMeta.realName) {
            delete settings.aliases[bookMeta.realName];
        }

        if (note) settings.notes[bookMeta.realName] = note;
        else delete settings.notes[bookMeta.realName];

        closeSubModal();
        await _callbacks.onMutation({ save: true });
    };

    clearInputBtn?.addEventListener('click', () => {
        if (aliasInput instanceof HTMLInputElement) {
            aliasInput.value = '';
            userEditedName = true;
            if (isDesktopAutoFocusAllowed()) aliasInput.focus();
        }
    });
    clearBtn?.addEventListener('click', () => {
        if (aliasInput instanceof HTMLInputElement) {
            aliasInput.value = bookMeta.realName;
            userEditedName = true;
        }
    });
    modal.querySelector('#wbo-cancel-btn')?.addEventListener('click', closeSubModal);
    modal.querySelector('#wbo-save-alias-btn')?.addEventListener('click', save);
    bindImeSafeEnter(aliasInput, save);
    bindImeSafeEnter(noteInput, save);
}

/**
 * Move a worldbook into a custom group, ungrouped, or back to character group.
 */
function openMoveGroupModal(bookMeta) {
    if (!_callbacks) return;
    const { settings } = _callbacks.getState();

    const options = [
        ...settings.groups.map((g) => ({
            id: g.id,
            label: g.name,
            color: g.color,
            desc: '',
        })),
        {
            id: SPECIAL_GROUPS.CHARACTER,
            label: '角色世界书',
            color: '#7c8594',
            desc: bookMeta.isCharBound
                ? bookMeta.charOwners.map((o) => o.charName).join('、')
                : '手动归入角色世界书',
        },
        {
            id: SPECIAL_GROUPS.UNGROUPED,
            label: bookMeta.isCharBound ? '移出角色世界书' : '未分组',
            color: '#8c99a6',
            desc: '',
        },
    ];

    const listHtml = options
        .map(
            (opt) => `
            <button type="button" class="wbo-move-option${bookMeta.groupId === opt.id ? ' is-current' : ''}" data-target-group="${esc(opt.id)}">
                <span class="wbo-group-dot" style="background:${esc(opt.color)}"></span>
                <span class="wbo-move-label">${esc(opt.label)}</span>
                ${opt.desc ? `<span class="wbo-move-desc">${esc(opt.desc)}</span>` : ''}
            </button>
        `,
        )
        .join('');

    const { modal } = createSubModal(
        `移动到分组：${bookMeta.primaryTitle}`,
        `
            <div class="wbo-move-list">${listHtml}</div>
            <div class="wbo-modal-footer wbo-footer-pair">
                <button type="button" class="wbo-btn" id="wbo-move-new-group">新建分组</button>
                <button type="button" class="wbo-btn" id="wbo-cancel-btn">关闭</button>
            </div>
        `,
    );

    modal.querySelectorAll('.wbo-move-option').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const targetId = btn.getAttribute('data-target-group');
            if (!targetId) return;

            assignBookToGroup(settings, bookMeta, targetId);

            closeSubModal();
            await _callbacks.onMutation({ save: true });
        });
    });

    modal.querySelector('#wbo-move-new-group')?.addEventListener('click', () => {
        openCreateOrRenameGroupModal(null, { initialBookName: bookMeta.realName });
    });
    modal.querySelector('#wbo-cancel-btn')?.addEventListener('click', closeSubModal);
}

/**
 * Overflow popover (`···`) for secondary worldbook row actions.
 * @param {HTMLElement} anchorBtn
 * @param {object} bookMeta
 */
function openBookMorePopover(anchorBtn, bookMeta) {
    const wasOpen = anchorBtn.getAttribute('aria-expanded') === 'true';
    closeGroupVisibilityPopover();
    if (wasOpen || !bookMeta?.realName) return;

    const backdrop = document.createElement('div');
    backdrop.id = 'wbo-vis-popover-backdrop';
    backdrop.className = 'wbo-vis-backdrop';

    const pop = document.createElement('div');
    pop.className = 'wbo-modal wbo-vis-popover wbo-book-more-popover';
    applyThemeClass(pop);
    const deleteInMenu = !anchorBtn.parentElement?.querySelector('.wbo-book-delete-btn')?.offsetWidth;
    pop.innerHTML = `
        <button type="button" class="wbo-book-more-item" data-more-act="bind-book-to-character">
            <i class="fa-solid fa-globe" aria-hidden="true"></i><span>绑定到角色</span>
        </button>
        <button type="button" class="wbo-book-more-item" data-more-act="edit-book">
            <i class="fa-solid fa-arrow-up-right-from-square"></i><span>在编辑器中打开</span>
        </button>
        ${isEntryGroupingAvailable() ? `
        <button type="button" class="wbo-book-more-item" data-more-act="entry-groups">
            <i class="fa-solid fa-layer-group" aria-hidden="true"></i><span>条目分组</span>
        </button>` : ''}
        <button type="button" class="wbo-book-more-item" data-more-act="rename-alias">
            <i class="fa-solid fa-pen-to-square"></i><span>编辑名称与备注</span>
        </button>
        <button type="button" class="wbo-book-more-item" data-more-act="move-group">
            <i class="fa-solid fa-folder-open"></i><span>移动分组</span>
        </button>
        ${deleteInMenu ? `
            <div class="wbo-book-more-divider"></div>
            <button type="button" class="wbo-book-more-item is-danger" data-more-act="delete-single-book">
                <i class="fa-regular fa-trash-can"></i><span>删除世界书</span>
            </button>` : ''}
    `;

    backdrop.appendChild(pop);
    document.body.appendChild(backdrop);
    anchorBtn.setAttribute('aria-expanded', 'true');
    bindDrawerSafeBubbleGuard(backdrop);
    bindDrawerSafeBubbleGuard(pop);

    const rect = anchorBtn.getBoundingClientRect();
    const vw = globalThis.innerWidth || document.documentElement.clientWidth || 390;
    const vh = globalThis.innerHeight || document.documentElement.clientHeight || 800;
    const popW = 164;
    const left = Math.max(10, Math.min(rect.right - popW, vw - popW - 10));
    pop.style.width = `${popW}px`;
    pop.style.left = `${Math.round(left)}px`;
    const below = vh - rect.bottom - 14;
    const above = rect.top - 14;
    const openAbove = pop.offsetHeight > below && above > below;
    pop.style.setProperty('max-height', `${Math.max(0, Math.floor(openAbove ? above : below))}px`, 'important');
    if (openAbove) {
        pop.style.bottom = `${Math.round(vh - rect.top + 4)}px`;
        pop.style.top = 'auto';
    } else {
        pop.style.top = `${Math.round(rect.bottom + 4)}px`;
        pop.style.bottom = 'auto';
    }

    const onKeyDown = (ev) => {
        if (!backdrop.isConnected) {
            document.removeEventListener('keydown', onKeyDown, true);
            return;
        }
        if (ev.key === 'Escape') {
            ev.stopPropagation();
            cleanup(true);
        }
    };
    const cleanup = (restoreFocus = false) => {
        closeGroupVisibilityPopover();
        if (restoreFocus && anchorBtn.isConnected && isDesktopAutoFocusAllowed()) {
            anchorBtn.focus({ preventScroll: true });
        }
    };
    backdrop.addEventListener('wbo:popover-close', () => {
        anchorBtn.setAttribute('aria-expanded', 'false');
        document.removeEventListener('keydown', onKeyDown, true);
    }, { once: true });
    document.addEventListener('keydown', onKeyDown, true);

    backdrop.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (ev.target === backdrop) cleanup(true);
    });

    pop.querySelectorAll('[data-more-act]').forEach((btn) => {
        btn.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            const act = btn.getAttribute('data-more-act');
            cleanup();
            if (act === 'edit-book') {
                openWorldInNativeEditor(bookMeta.realName);
                closeManagerModal();
            } else if (act === 'entry-groups') {
                openEntryGroupsForBook(bookMeta.realName);
            } else if (act === 'rename-alias') {
                openAliasNoteModal(bookMeta);
            } else if (act === 'move-group') {
                openMoveGroupModal(bookMeta);
            } else if (act === 'bind-book-to-character') {
                openCharacterBindingModal(bookMeta.realName);
            } else if (act === 'delete-single-book') {
                await confirmAndDeleteWorldbooks([bookMeta.realName]);
            }
        });
    });
    if (isDesktopAutoFocusAllowed()) {
        pop.querySelector('[data-more-act]')?.focus({ preventScroll: true });
    }
}

/**
 * Remove all DOM nodes mounted by this panel module cleanly.
 */
function teardownPanels() {
    _isSyncingEmbeddedIndicators = false;
    _searchQuery = '';
    destroyAllPreviewControllers();
    removeRestorePill();
    cancelManagerInlineEntrySearch();
    closeGroupVisibilityPopover();
    clearTimeout(_mgrSearchTimer);
    _mgrSearchTimer = null;
    disconnectNativeCharBtnWidthObserver();
    document.getElementById(PROMPT_OVERLAY_ID)?.remove();
    closeFloatingGroupManager();
    closeSubModal({ all: true });
    closeManagerModal();
    document.getElementById(CHAR_TOGGLE_BTN_ID)?.remove();
    document.getElementById(WI_QUICK_ACTIONS_ID)?.remove();
    document.getElementById('wbo-header-bar')?.remove();
    document.getElementById(WAND_ENTRY_ID)?.remove();
    document.getElementById(SETTINGS_ROOT_ID)?.remove();
}

export {
    _activePreviewControllers,
    _searchQuery,
    closeManagerModal,
    confirmAndDeleteWorldbooks,
    invalidatePreviewCache,
    openManagerModal,
    renderEmbeddedPanel,
    renderManagerGroupsListOnly,
    setPreviewCache,
    syncEmbeddedPanelIndicators,
    teardownPanels,
};
