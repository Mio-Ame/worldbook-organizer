/**
 * Worldbook Organizer — Zero-footprint `#WorldInfo` header controls +
 * standalone sticky-header Group Manager modal + collapsible API channels +
 * full character-worldbook coverage scan modal.
 */

import {
    DEFAULT_LOCAL_ORGANIZE_CATEGORY_IDS,
    GROUP_COLOR_PALETTE,
    LOCAL_ORGANIZE_CATEGORIES,
    SPECIAL_GROUPS,
    addCustomGroup,
    applyAiOrganizeProposals,
    buildAiOrganizePrompt,
    buildLocalOrganizeProposals,
    cleanupDeletedWorldSettings,
    classifyWorldbooks,
    compareWorldbookEntries,
    createApiChannelId,
    deepClone,
    exportConfigData,
    findCardsWithUnimportedBooks,
    findUnscannedShallowCharacters,
    importConfigData,
    isPotentiallySensitiveTitle,
    matchesSearch,
    moveSectionOrder,
    parseAiOrganizeResponse,
    promoteSectionToTop,
    pushUndoSnapshot,
    reorderSection,
    restoreOrganizeSnapshot,
    searchEntriesInPayload,
    summarizeCharacterWorldCoverage,
    undoLastAiOrganize,
    updateCachedCharBindings,
} from './core.js';
import {
    applyTauriSurface,
    callCustomApiForOrganize,
    callHostAiForOrganize,
    deleteWorldbooksFromHost,
    fetchCustomApiModels,
    fetchWorldbookCluesOnDemand,
    fetchWorldbookPreviewEntries,
    flushWorldInfoListRefresh,
    getActiveGlobalWorldSet,
    getCharactersInMemory,
    getCurrentEditorWorldName,
    getWorldNames,
    importEmbeddedWorldbookForCharacter,
    openCharacterByAvatar,
    realRenameWorldbook,
    scanShallowCharactersInBatches,
    searchWorldbookEntriesStream,
    showToast,
    unbindExtraWorldbookFromChar,
    unbindPrimaryWorldbookFromChar,
} from './host.js';
import {
    openWorldInNativeEditor,
    setGlobalWorldActive,
} from './native-filter.js';

const CHAR_TOGGLE_BTN_ID = 'wbo-hdr-show-char';
const WI_QUICK_ACTIONS_ID = 'wbo-wi-quick-actions';
const WAND_ENTRY_ID = 'wbo-wand-entry';
const SETTINGS_ROOT_ID = 'wbo-extension-settings';
const MANAGER_OVERLAY_ID = 'wbo-manager-overlay';
const SUBMODAL_OVERLAY_ID = 'wbo-submodal-overlay';

let _searchQuery = '';
let _isComposing = false;
let _callbacks = null;
let _lastModalListSig = null;
let _batchMode = false;
let _mgrPillsExpanded = false;
let _mgrSearchTimer = null;
/** @type {{ cancelled: boolean } | null} */
let _mgrInlineEntrySignal = null;
/** @type {MutationObserver | null} */
let _charBtnWidthObserver = null;
/** @type {Set<string>} */
const _batchSelected = new Set();
/** @type {Map<string, { total: number, enabledCount: number, entries: Array<any> }>} */
const _previewCache = new Map();
const MAX_PREVIEW_CACHE_BOOKS = 8;

function setPreviewCache(bookName, data) {
    if (!bookName) return;
    if (_previewCache.has(bookName)) _previewCache.delete(bookName);
    _previewCache.set(bookName, data);
    while (_previewCache.size > MAX_PREVIEW_CACHE_BOOKS) {
        const oldest = _previewCache.keys().next().value;
        if (oldest === undefined) break;
        _previewCache.delete(oldest);
    }
}

/**
 * Detect whether the current SillyTavern / TauriTavern theme is light or dark
 * by inspecting computed body text luminance, so our modals & controls stay
 * 100% solid, legible, and insulated from translucent or colored host themes.
 * @returns {'wbo-theme-light' | 'wbo-theme-dark'}
 */
function detectHostThemeClass() {
    try {
        const probe = document.getElementById('WorldInfo') || document.body;
        const colorStr = probe ? globalThis.getComputedStyle(probe).color : '';
        const match = colorStr.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
        if (match) {
            const r = Number(match[1]);
            const g = Number(match[2]);
            const b = Number(match[3]);
            const lum = 0.299 * r + 0.587 * g + 0.114 * b;
            // Dark text -> light theme; bright text -> dark theme
            return lum < 140 ? 'wbo-theme-light' : 'wbo-theme-dark';
        }
    } catch {
        // Fallback below
    }
    return 'wbo-theme-dark';
}

const THEME_PALETTES = Object.freeze([
    { id: 'classic', label: '素雅纸墨', lightBg: '#f6f6f3', darkBg: '#191a1d', accent: '#2b2b2e' },
    { id: 'ink', label: '素纸青岚', lightBg: '#f1f4f6', darkBg: '#20252d', accent: '#2c7a7b' },
    { id: 'warm', label: '暖笺琥珀', lightBg: '#f6f2ea', darkBg: '#221e1b', accent: '#b66634' },
    { id: 'sakura', label: '雾粉紫烟', lightBg: '#f8f4f7', darkBg: '#211d24', accent: '#b85c88' },
    { id: 'host', label: '跟随酒馆', lightBg: '#eef1f5', darkBg: '#242730', accent: '#7c8594' },
]);

/**
 * Sync the active palette & light/dark mode onto a modal element.
 * @param {HTMLElement | null} el
 */
function applyThemeClass(el) {
    if (!el) return;
    const settings = _callbacks?.getState?.()?.settings;
    const mode = settings?.themeMode || 'auto';
    const palette = settings?.themePalette || 'classic';
    const cls = mode === 'light'
        ? 'wbo-theme-light'
        : mode === 'dark'
            ? 'wbo-theme-dark'
            : detectHostThemeClass();
    el.classList.remove('wbo-theme-light', 'wbo-theme-dark');
    el.classList.add(cls);
    el.setAttribute('data-wbo-palette', palette);
}

/**
 * Sync theme classes onto all currently open plugin modals immediately.
 */
function syncAllOpenModalsTheme() {
    document.querySelectorAll('.wbo-modal').forEach((el) => {
        if (el instanceof HTMLElement) applyThemeClass(el);
    });
}

/**
 * Escape HTML special characters safely.
 * @param {string} str
 * @returns {string}
 */
function esc(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Configure host/controller callbacks used by UI actions.
 * @param {{
 *   getState: () => { settings: any, classification: any, bindingMap: Map<string, any> },
 *   onMutation: (opts?: { save?: boolean, uiOnly?: boolean }) => void | Promise<void>,
 *   onRescan: () => Promise<void>,
 * }} callbacks
 */
export function bindPanelCallbacks(callbacks) {
    _callbacks = callbacks;
}

/**
 * Mount minimal theme-native controls right above `#world_editor_select` inside `#world_popup`
 * (right next to the dropdown at natural eye level!) AND add a Magic Wand (`#extensionsMenu`)
 * shortcut so users can open Group Manager from either the World Info panel or the chat bar.
 * @returns {HTMLElement | null}
 */
function ensureWandMenuEntry() {
    const existing = document.getElementById(WAND_ENTRY_ID);
    if (existing) return existing;

    const menu = document.getElementById('extensionsMenu');
    if (!menu) return null;

    const item = document.createElement('div');
    item.id = WAND_ENTRY_ID;
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.tabIndex = 0;
    item.title = '打开世界书分组管理';
    item.innerHTML = `
        <i class="fa-solid fa-layer-group fa-fw extensionsMenuExtensionButton"></i>
        <span>世界书分组管理</span>
    `;
    item.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (menu instanceof HTMLElement) menu.style.display = 'none';
        openManagerModal();
    });

    menu.appendChild(item);

    const wandBtn = document.getElementById('extensionsMenuButton');
    if (wandBtn instanceof HTMLElement && globalThis.getComputedStyle(wandBtn).display === 'none') {
        wandBtn.style.display = 'flex';
    }
    return item;
}

function syncNativeCharBtnWidth(btn) {
    if (!(btn instanceof HTMLElement)) return false;
    const importBtn = document.getElementById('world_import_button');
    if (!(importBtn instanceof HTMLElement)) return false;
    const w = Math.round(importBtn.getBoundingClientRect().width);
    if (w >= 18 && w <= 80) {
        btn.style.setProperty('--wbo-char-btn-w', `${w}px`);
        btn.dataset.wboWidthSynced = '1';
        return true;
    }
    return false;
}

function scheduleNativeCharBtnWidthSync(btn) {
    if (syncNativeCharBtnWidth(btn)) return;
    const wiDrawer = document.getElementById('WorldInfo');
    if (!wiDrawer || typeof MutationObserver !== 'function') return;
    _charBtnWidthObserver?.disconnect();
    const obs = new MutationObserver(() => {
        if (!btn.isConnected) {
            obs.disconnect();
            if (_charBtnWidthObserver === obs) _charBtnWidthObserver = null;
            return;
        }
        if (!wiDrawer.classList.contains('closedDrawer')) {
            requestAnimationFrame(() => {
                if (syncNativeCharBtnWidth(btn)) {
                    obs.disconnect();
                    if (_charBtnWidthObserver === obs) _charBtnWidthObserver = null;
                }
            });
        }
    });
    _charBtnWidthObserver = obs;
    obs.observe(wiDrawer, { attributes: true, attributeFilter: ['class'] });
}

/**
 * Mount two ultra-clean, theme-native shortcut buttons (`排除` + `搜条目`) on the empty
 * right side of `#WorldInfo`'s top title row (`世界/知识书`), zero extra rows & zero crowding!
 */
function ensureWorldInfoQuickActions() {
    let box = document.getElementById(WI_QUICK_ACTIONS_ID);
    if (box) return box;

    const wiDrawer = document.getElementById('WorldInfo');
    const pinDiv = document.getElementById('WI_panel_pin_div');
    const headerRow = pinDiv?.parentElement || wiDrawer?.querySelector(':scope > .flex-container');
    if (!headerRow) return null;

    box = document.createElement('div');
    box.id = WI_QUICK_ACTIONS_ID;
    box.className = 'wbo-wi-quick-actions';
    box.innerHTML = `
        <div id="wbo-wi-exclude-btn" class="menu_button wbo-wi-quick-btn" role="button" tabindex="0" title="快速设置全局框与编辑框默认排除的分组">
            <i class="fa-solid fa-filter"></i>
            <span>排除</span>
        </div>
        <div id="wbo-wi-entry-search-btn" class="menu_button wbo-wi-quick-btn" role="button" tabindex="0" title="跨世界书按需搜索条目内容">
            <i class="fa-solid fa-magnifying-glass"></i>
            <span>搜条目</span>
        </div>
    `;
    headerRow.appendChild(box);

    const excludeBtn = box.querySelector('#wbo-wi-exclude-btn');
    excludeBtn?.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (excludeBtn instanceof HTMLElement) {
            openQuickExcludePopover(excludeBtn);
        }
    });

    box.querySelector('#wbo-wi-entry-search-btn')?.addEventListener('click', (ev) => {
        ev.stopPropagation();
        openEntrySearchModal('');
    });

    return box;
}

function ensureHeaderBar() {
    ensureWandMenuEntry();
    ensureWorldInfoQuickActions();

    // Remove any legacy standalone row from earlier versions
    document.getElementById('wbo-header-bar')?.remove();

    let btn = document.getElementById(CHAR_TOGGLE_BTN_ID);
    if (btn) {
        if (btn.dataset.wboWidthSynced !== '1') syncNativeCharBtnWidth(btn);
        return btn;
    }

    const importBtn = document.getElementById('world_import_button');
    const editorSelect = document.getElementById('world_editor_select');
    const editorRow = importBtn?.parentElement || editorSelect?.closest?.('.flex-container') || editorSelect?.parentElement;
    if (!editorRow) return null;

    // Blend seamlessly into SillyTavern's native `#world_popup` toolbar row (0 extra rows, exact sibling width!)
    btn = document.createElement('div');
    btn.id = CHAR_TOGGLE_BTN_ID;
    btn.className = 'menu_button fa-solid fa-fw fa-user-slash wbo-native-char-btn';
    btn.tabIndex = 0;
    btn.setAttribute('role', 'button');
    btn.title = '角色世界书已隐藏，点击显示（右键或长按可自定义排除分组）';

    if (importBtn && importBtn.parentElement === editorRow) {
        editorRow.insertBefore(btn, importBtn);
    } else {
        editorRow.appendChild(btn);
    }
    scheduleNativeCharBtnWidthSync(btn);

    // Right-click (desktop) or 420ms long-press (mobile) opens quick-exclude popover right next to native box!
    let longPressTimer = null;
    let suppressNextClick = false;
    btn.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        openQuickExcludePopover(btn);
    });
    btn.addEventListener('pointerdown', (ev) => {
        if (ev.pointerType === 'mouse' && ev.button !== 0) return;
        suppressNextClick = false;
        clearTimeout(longPressTimer);
        longPressTimer = setTimeout(() => {
            longPressTimer = null;
            suppressNextClick = true;
            openQuickExcludePopover(btn);
        }, 420);
    }, { passive: true });
    const cancelLongPress = () => {
        clearTimeout(longPressTimer);
        longPressTimer = null;
    };
    btn.addEventListener('pointerup', cancelLongPress, { passive: true });
    btn.addEventListener('pointercancel', cancelLongPress, { passive: true });
    btn.addEventListener('pointerleave', cancelLongPress, { passive: true });

    btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (suppressNextClick) {
            suppressNextClick = false;
            return;
        }
        if (!_callbacks) return;
        const { settings } = _callbacks.getState();
        const nextShown = !settings.showCharBooks;
        settings.showCharBooks = nextShown;
        if (!nextShown && settings.activeFilterGroupId === SPECIAL_GROUPS.CHARACTER) {
            settings.activeFilterGroupId = SPECIAL_GROUPS.DEFAULT;
        }
        if (nextShown) {
            settings.charGroupCollapsed = false;
            promoteSectionToTop(settings, SPECIAL_GROUPS.CHARACTER);
        }
        // Paint the flipped icon FIRST (rAF + macrotask guarantees paint commits before iOS unhides native `<select>`)
        btn.classList.toggle('fa-user', nextShown);
        btn.classList.toggle('fa-user-slash', !nextShown);
        btn.classList.toggle('is-active', nextShown);
        btn.setAttribute('aria-pressed', String(nextShown));
        requestAnimationFrame(() => {
            setTimeout(() => {
                void _callbacks?.onMutation({ save: true, charToggleOnly: true });
            }, 0);
        });
    });

    return btn;
}

/**
 * Sync the native inline char-toggle icon AND the Group Manager modal (ONLY if open — 0 work when closed!).
 */
export function renderEmbeddedPanel() {
    if (!_callbacks) return;
    const showCharBtn = ensureHeaderBar();

    const { settings, classification } = _callbacks.getState();

    // Sync native WorldInfo title-bar shortcut buttons (`排除` / `搜条目`) visibility
    const quickBox = document.getElementById(WI_QUICK_ACTIONS_ID);
    if (quickBox) {
        const showExclude = settings.showNativeExcludeBtn !== false;
        const showEntrySearch = settings.showNativeEntrySearchBtn !== false;
        const exBtn = quickBox.querySelector('#wbo-wi-exclude-btn');
        const esBtn = quickBox.querySelector('#wbo-wi-entry-search-btn');
        if (exBtn instanceof HTMLElement) exBtn.hidden = !showExclude;
        if (esBtn instanceof HTMLElement) esBtn.hidden = !showEntrySearch;
        quickBox.hidden = !showExclude && !showEntrySearch;
    }

    if (showCharBtn) {
        showCharBtn.hidden = settings.showNativeCharToggleBtn === false;
        const shown = Boolean(settings.showCharBooks);
        showCharBtn.classList.toggle('fa-user', shown);
        showCharBtn.classList.toggle('fa-user-slash', !shown);
        showCharBtn.classList.toggle('is-active', shown);
        showCharBtn.setAttribute('aria-pressed', String(shown));

        const gHidden = Array.isArray(settings.globalHiddenGroupIds) ? settings.globalHiddenGroupIds : [];
        const eHidden = Array.isArray(settings.editorHiddenGroupIds) ? settings.editorHiddenGroupIds : [];
        const allHiddenIds = [...new Set([...gHidden, ...eHidden])];
        const hasExtraExcluded = allHiddenIds.some((id) => id !== SPECIAL_GROUPS.CHARACTER);
        if (hasExtraExcluded) {
            const nameById = new Map((classification.orderedSections || []).map((s) => [s.id, s.name]));
            const names = allHiddenIds.map((id) => nameById.get(id)).filter(Boolean);
            showCharBtn.title = shown
                ? `正在显示全部已隐藏分组（${names.join('、')}），点击收起`
                : `已默认隐藏 ${names.join('、')}，点击全部显示`;
        } else {
            showCharBtn.title = shown
                ? `正在显示角色世界书（${classification.charCount} 本），点击隐藏`
                : `已隐藏角色世界书（${classification.charCount} 本），点击显示`;
        }
    }

    // Only refresh Group Manager when it is actually open (0 background scanning when closed!)
    if (document.getElementById(MANAGER_OVERLAY_ID)) {
        refreshManagerModalContent();
    }
}

/**
 * Lightweight in-place sync when native `#world_info` or `#world_editor_select` changes.
 * Updates both per-row global pills AND group header active counts with zero DOM rebuild!
 */
export function syncEmbeddedPanelIndicators() {
    const listEl = document.getElementById('wbo-mgr-groups-list');
    if (!listEl) return;

    const activeGlobals = getActiveGlobalWorldSet();
    const currentEditor = getCurrentEditorWorldName();

    listEl.querySelectorAll('.wbo-book-row').forEach((row) => {
        const name = row.getAttribute('data-book');
        if (!name) return;
        const isActive = activeGlobals.has(name);
        const isEditing = currentEditor === name;
        const globalBtn = row.querySelector('[data-action="toggle-global"]');
        row.classList.toggle('is-active', Boolean(globalBtn && isActive));
        row.classList.toggle('is-editing', isEditing);
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
}

// ==================== Standalone Group Manager Modal ====================

/**
 * Render one worldbook row inside the Group Manager modal:
 * - Character worldbooks have NO global activation toggle (prevents accidental global enabling!)
 * - Non-character worldbooks use an explicit right-side `全局 / 已全局` button instead of a misclick-prone left checkbox
 */
function renderBookRowHtml(book, activeGlobals, currentEditor) {
    const isActive = activeGlobals.has(book.realName);
    const isEditing = currentEditor === book.realName;
    const isExtraChar = book.isInCharGroup && book.charOwners?.every((o) => o.source === 'extra');

    const extraTag = isExtraChar ? '<span class="wbo-tag">附加</span>' : '';
    const ownerHint = book.isCharBound && !book.isInCharGroup
        ? `<span class="wbo-tag" title="绑定角色：${esc(book.charOwners.map((o) => o.charName).join('、'))}">${esc(book.charOwners[0]?.charName || '')}</span>`
        : '';
    const personaHint = book.personaOwners?.length
        ? `<span class="wbo-tag" title="绑定人设：${esc(book.personaOwners.join('、'))}">人设</span>`
        : '';
    const subHtml = book.subtitle
        ? `<span class="wbo-book-sub" title="${esc(book.realName)}">${esc(book.subtitle)}</span>`
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
    const mainTitle = _batchMode ? '点击勾选或取消勾选' : '点击展开预览条目内容';

    return `
        <div class="wbo-book-item" data-book="${esc(book.realName)}">
            <div class="wbo-book-row${isActive && !book.isInCharGroup ? ' is-active' : ''}${isEditing ? ' is-editing' : ''}${_batchMode && batchChecked ? ' is-batch-selected' : ''}" data-book="${esc(book.realName)}" draggable="true">
                <span class="wbo-drag-handle" title="${_batchMode ? '拖动移动当前项或全部已勾选项' : '拖动移动到分组'}"><i class="fa-solid fa-grip-vertical"></i></span>
                ${batchCheckHtml}
                <button type="button" class="wbo-book-main" data-action="${mainAction}" title="${mainTitle}">
                    <i class="fa-solid fa-chevron-right wbo-book-chev"></i>
                    <span class="wbo-book-text-col">
                        <span class="wbo-book-title-line">
                            <span class="wbo-book-title">${esc(book.primaryTitle)}</span>
                            ${subHtml}
                            ${extraTag}
                            ${ownerHint}
                            ${personaHint}
                        </span>
                        ${noteHtml}
                    </span>
                </button>
                <div class="wbo-book-actions">
                    ${globalBtnHtml}
                    <button type="button" class="wbo-icon-btn wbo-book-action-secondary" data-action="edit-book" title="在酒馆编辑器中打开">
                        <i class="fa-solid fa-arrow-up-right-from-square"></i>
                    </button>
                    <button type="button" class="wbo-icon-btn wbo-book-action-secondary" data-action="rename-alias" title="编辑名称与备注">
                        <i class="fa-solid fa-pen-to-square"></i>
                    </button>
                    <button type="button" class="wbo-icon-btn wbo-book-action-secondary" data-action="move-group" title="移动分组">
                        <i class="fa-solid fa-folder-open"></i>
                    </button>
                    <button type="button" class="wbo-icon-btn wbo-icon-danger wbo-book-action-secondary" data-action="delete-single-book" title="删除世界书">
                        <i class="fa-regular fa-trash-can"></i>
                    </button>
                    <button type="button" class="wbo-icon-btn wbo-book-more-btn" data-action="book-more-menu" title="更多操作" aria-label="更多操作">
                        <i class="fa-solid fa-ellipsis"></i>
                    </button>
                </div>
            </div>
            <div class="wbo-book-preview" hidden></div>
        </div>
    `;
}

/**
 * Toggle inline on-demand entry preview directly below a worldbook row inside the Group Manager modal.
 * @param {HTMLElement} itemEl
 * @param {string} bookName
 */
async function toggleInlineBookPreview(itemEl, bookName) {
    const previewEl = itemEl.querySelector('.wbo-book-preview');
    const rowEl = itemEl.querySelector('.wbo-book-row');
    if (!(previewEl instanceof HTMLElement)) return;

    const willOpen = previewEl.hidden;
    if (!willOpen) {
        previewEl.hidden = true;
        rowEl?.classList.remove('is-preview-open');
        return;
    }

    previewEl.hidden = false;
    rowEl?.classList.add('is-preview-open');

    const renderData = (data) => {
        const footerLinks = `
            <span class="wbo-preview-head-actions">
                <button type="button" class="wbo-link-btn" data-action="edit-book">在酒馆编辑器打开</button>
                <button type="button" class="wbo-link-btn is-danger" data-action="delete-single-book">删除此书</button>
            </span>
        `;
        if (!data || data.total === 0) {
            previewEl.innerHTML = `
                <div class="wbo-preview-head">
                    <span>暂无条目内容</span>
                    ${footerLinks}
                </div>
            `;
            return;
        }
        const maxShown = 30;
        const shown = data.entries.slice(0, maxShown);
        const moreCount = data.total - shown.length;

        const entriesHtml = shown.map((entry) => {
            const badges = [
                entry.constant ? '<span class="wbo-entry-badge is-const">常驻</span>' : '',
                entry.disabled ? '<span class="wbo-entry-badge is-off">已禁用</span>' : '',
                ...entry.keys.slice(0, 4).map((k) => `<span class="wbo-entry-key">${esc(k)}</span>`),
            ].filter(Boolean).join('');
            const hasContent = Boolean(entry.content);
            return `
                <details class="wbo-preview-entry${entry.disabled ? ' is-disabled' : ''}">
                    <summary class="wbo-preview-entry-head">
                        <i class="fa-solid fa-chevron-right wbo-details-chev"></i>
                        <span class="wbo-preview-entry-title">${esc(entry.title)}</span>
                        <span class="wbo-preview-entry-badges">${badges}</span>
                    </summary>
                    ${hasContent
                        ? `<div class="wbo-preview-entry-content">${esc(entry.content)}</div>`
                        : '<div class="wbo-preview-entry-content is-empty">条目正文为空</div>'}
                </details>
            `;
        }).join('');

        previewEl.innerHTML = `
            <div class="wbo-preview-head">
                <span>共 ${data.total} 条（启用 ${data.enabledCount} 条）</span>
                ${footerLinks}
            </div>
            <div class="wbo-preview-list">${entriesHtml}</div>
            ${moreCount > 0 ? `<div class="wbo-preview-more">还有 ${moreCount} 条未展开，可点击右上角在酒馆编辑器查看全部</div>` : ''}
        `;
    };

    if (_previewCache.has(bookName)) {
        renderData(_previewCache.get(bookName));
        return;
    }

    previewEl.innerHTML = '<div class="wbo-preview-loading">正在读取条目内容...</div>';
    try {
        const data = await fetchWorldbookPreviewEntries(bookName);
        setPreviewCache(bookName, data);
        if (previewEl.isConnected && !previewEl.hidden) {
            renderData(data);
        }
    } catch (err) {
        if (previewEl.isConnected && !previewEl.hidden) {
            previewEl.innerHTML = `<div class="wbo-preview-loading">读取失败：${esc(String(err?.message || err))}</div>`;
        }
    }
}

/**
 * Assign a worldbook to a target group (`customId`, `UNGROUPED`, or `CHARACTER`).
 * Returns false if disallowed (e.g. dropping a non-character book into `角色世界书`).
 */
function assignBookToGroup(settings, bookMeta, targetGroupId) {
    if (!bookMeta || !targetGroupId) return false;
    if (bookMeta.groupId === targetGroupId) return false;

    if (targetGroupId === SPECIAL_GROUPS.CHARACTER) {
        if (!bookMeta.isCharBound) {
            showToast('warning', '只有角色卡绑定的世界书可以放入「角色世界书」');
            return false;
        }
        delete settings.assignments[bookMeta.realName];
        delete settings.charBookOverrides[bookMeta.realName];
        return true;
    }

    if (targetGroupId === SPECIAL_GROUPS.UNGROUPED) {
        delete settings.assignments[bookMeta.realName];
        if (bookMeta.isCharBound) {
            settings.charBookOverrides[bookMeta.realName] = 'exclude_from_char';
        }
        return true;
    }

    settings.assignments[bookMeta.realName] = targetGroupId;
    if (bookMeta.isCharBound) {
        settings.charBookOverrides[bookMeta.realName] = 'exclude_from_char';
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
    charBookTitleMode = 'char_with_sub',
    hiddenInGlobal = false,
    hiddenInEditor = false,
    canMoveUp,
    canMoveDown,
    books,
    activeGlobals,
    currentEditor,
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
    const visActionBtn = visHiddenAny
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
    const orderActions = isSingleView
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
            ? `<div class="wbo-group-body">${books.map((b) => renderBookRowHtml(b, activeGlobals, currentEditor)).join('')}</div>`
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
            <span class="wbo-group-drag-handle" title="拖动调整分组顺序"><i class="fa-solid fa-grip-vertical"></i></span>
            ${batchGroupCheckHtml}
            <button type="button" class="wbo-group-toggle" data-action="toggle-group-collapse" data-group-id="${esc(id)}" aria-expanded="${!collapsed}">
                <i class="fa-solid ${collapsed ? 'fa-chevron-right' : 'fa-chevron-down'} wbo-chevron"></i>
                <span class="wbo-group-dot" style="background:${esc(color)}"></span>
                <span class="wbo-group-name">${esc(name)}</span>
                <span class="wbo-group-count">${esc(countLabel)}</span>
            </button>
        `;

    return `
        <div class="wbo-group${collapsed ? ' is-collapsed' : ''}" data-group-id="${esc(id)}" data-book-count="${books.length}" data-group-books="${esc(JSON.stringify(books.map((b) => b.realName)))}">
            <div class="wbo-group-header"${isSingleView ? '' : ` draggable="true" data-drag-group-id="${esc(id)}"`}>
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

function closeGroupVisibilityPopover() {
    document.getElementById('wbo-vis-popover-backdrop')?.remove();
    document.getElementById('wbo-quick-exclude-backdrop')?.remove();
    document.getElementById('wbo-search-opts-backdrop')?.remove();
}

function cancelManagerInlineEntrySearch() {
    if (_mgrInlineEntrySignal) {
        _mgrInlineEntrySignal.cancelled = true;
        _mgrInlineEntrySignal = null;
    }
}

function closeManagerModal() {
    cancelManagerInlineEntrySearch();
    closeGroupVisibilityPopover();
    _lastModalListSig = null;
    _batchMode = false;
    _batchSelected.clear();
    _previewCache.clear();
    document.getElementById(MANAGER_OVERLAY_ID)?.remove();
}

/**
 * Read the list of book realNames belonging to a rendered `.wbo-group` element (works even when collapsed!).
 * @param {Element} groupEl
 * @returns {string[]}
 */
function getRenderedGroupBookNames(groupEl) {
    const raw = groupEl.getAttribute('data-group-books');
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
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
 * Dedicated Group Management modal: view all custom groups in one clean list,
 * batch-select groups to dissolve/delete at once, reorder, or rename.
 */
function openManageGroupsModal() {
    if (!_callbacks) return;
    const selectedGroupIds = new Set();

    const { modal } = createSubModal(
        '管理分组',
        `
            <div class="wbo-gm-toolbar">
                <span class="wbo-batch-count" id="wbo-gm-sel-count">已选 0 个分组</span>
                <button type="button" class="wbo-link-btn" id="wbo-gm-toggle-all">全选</button>
                <span class="wbo-spacer"></span>
                <button type="button" class="wbo-btn" id="wbo-gm-new-btn">
                    <i class="fa-solid fa-folder-plus"></i> 新建分组
                </button>
            </div>
            <div class="wbo-gm-list" id="wbo-gm-list"></div>
            <div class="wbo-subtle-tip">删除或解除分组仅取消归类，世界书本体不会被删除，相关世界书将回到「未分组」。</div>
            <div class="wbo-modal-footer wbo-ai-footer wbo-ai-footer-single">
                <div class="wbo-ai-footer-left">
                    <button type="button" class="wbo-btn wbo-btn-danger" id="wbo-gm-del-selected" disabled>
                        <i class="fa-regular fa-trash-can"></i> 解除所选分组
                    </button>
                </div>
                <div class="wbo-ai-footer-right">
                    <button type="button" class="wbo-btn" id="wbo-gm-close-btn">完成</button>
                </div>
            </div>
        `,
    );

    const listEl = modal.querySelector('#wbo-gm-list');
    const selCountEl = modal.querySelector('#wbo-gm-sel-count');
    const toggleAllBtn = modal.querySelector('#wbo-gm-toggle-all');
    const delSelBtn = modal.querySelector('#wbo-gm-del-selected');

    const syncSelectionUi = () => {
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
            if (moveSectionOrder(settings, gid, act === 'up' ? -1 : 1)) {
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
                    <div class="wbo-subtle-tip">该分组下的全部世界书将移入目标分组，并删除原分组「${esc(srcGrp.name)}」。</div>
                    <div class="wbo-move-list">${targetListHtml}</div>
                    <div class="wbo-modal-footer">
                        <button type="button" class="wbo-btn" id="wbo-merge-cancel-btn">返回</button>
                    </div>
                `,
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
                    if (settings.activeFilterGroupId === gid) {
                        settings.activeFilterGroupId = targetId;
                    }
                    await _callbacks.onMutation({ save: true });
                    showToast('success', `已将「${srcGrp.name}」的 ${moved} 本世界书归入「${targetGrp.name}」`);
                    openManageGroupsModal();
                });
            });
            mergeModal.querySelector('#wbo-merge-cancel-btn')?.addEventListener('click', () => openManageGroupsModal());
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
    modal.querySelector('#wbo-gm-close-btn')?.addEventListener('click', closeSubModal);

    renderList();
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
            <div class="wbo-modal-footer">
                <button type="button" class="wbo-btn" id="wbo-batch-new-group">新建分组并移入</button>
                <span class="wbo-spacer"></span>
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

    modal.querySelector('#wbo-batch-new-group')?.addEventListener('click', () => {
        const name = globalThis.prompt('输入新分组名称：')?.trim();
        if (!name) return;
        const created = addCustomGroup(settings, { name });
        for (const bookName of bookNames) {
            const meta = classification.byName.get(bookName);
            if (meta) assignBookToGroup(settings, meta, created.id);
        }
        _batchSelected.clear();
        closeSubModal();
        void _callbacks.onMutation({ save: true });
        showToast('success', `已新建「${name}」并移入 ${bookNames.length} 本世界书`);
    });

    modal.querySelector('#wbo-cancel-btn')?.addEventListener('click', closeSubModal);
}

/**
 * Confirm with binding safety warnings and permanently delete selected worldbooks from disk.
 * @param {string[]} bookNames
 */
async function confirmAndDeleteWorldbooks(bookNames) {
    if (!_callbacks || !Array.isArray(bookNames) || bookNames.length === 0) return;
    const { settings, classification } = _callbacks.getState();

    const boundWarnings = [];
    for (const name of bookNames) {
        const meta = classification.byName.get(name);
        if (!meta) continue;
        const refs = [];
        if (meta.charOwners?.length) refs.push(`角色：${meta.charOwners.map((o) => o.charName).join('、')}`);
        if (meta.personaOwners?.length) refs.push(`人设：${meta.personaOwners.join('、')}`);
        if (refs.length > 0) {
            boundWarnings.push(`${meta.primaryTitle}（${refs.join('；')}）`);
        }
    }

    const previewNames = bookNames.slice(0, 8).map((n) => `<li>${esc(n)}</li>`).join('');
    const moreNames = bookNames.length > 8 ? `<li>…等共 ${bookNames.length} 本</li>` : '';
    const warnHtml = boundWarnings.length > 0
        ? `<div class="wbo-refusal-box"><b>注意：其中 ${boundWarnings.length} 本正绑定在角色卡或人设上</b><br>${esc(boundWarnings.slice(0, 5).join('；'))}${boundWarnings.length > 5 ? ' 等' : ''}</div>`
        : '';

    const { modal } = createSubModal(
        `确认清理 ${bookNames.length} 本世界书`,
        `
            <div class="wbo-label">以下世界书将从酒馆硬盘中永久删除（无法撤销）：</div>
            ${warnHtml}
            <ul class="wbo-cov-list">${previewNames}${moreNames}</ul>
            <div class="wbo-ai-status" id="wbo-del-status"></div>
            <div class="wbo-modal-footer">
                <button type="button" class="wbo-btn wbo-btn-danger" id="wbo-confirm-del-btn">确认永久删除</button>
                <button type="button" class="wbo-btn" id="wbo-cancel-btn">取消</button>
            </div>
        `,
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
        closeSubModal();
        await _callbacks.onMutation({ save: true });
        showToast(
            res.failed.length > 0 ? 'warning' : 'success',
            `已删除 ${res.deleted.length} 本世界书${res.failed.length > 0 ? `，失败 ${res.failed.length} 本` : ''}`,
        );
    });
}

/**
 * Enable smooth viewport-clamped dragging on desktop (`> 680px`) via a modal's header bar.
 * On mobile (`<= 680px`), modals run full-screen so dragging is automatically bypassed.
 * @param {HTMLElement} modal
 * @param {HTMLElement | null} handleEl
 */
function attachDesktopModalDrag(modal, handleEl) {
    if (!modal || !handleEl) return;
    let dx = 0;
    let dy = 0;
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let baseDx = 0;
    let baseDy = 0;
    let baseRect = null;

    handleEl.addEventListener('pointerdown', (ev) => {
        if (ev.button !== 0) return;
        if ((globalThis.innerWidth || 0) <= 680) return;
        const target = ev.target instanceof Element ? ev.target : null;
        if (target?.closest('button, input, select, textarea, a, label')) return;

        dragging = true;
        startX = ev.clientX;
        startY = ev.clientY;
        baseDx = dx;
        baseDy = dy;
        baseRect = modal.getBoundingClientRect();
        modal.classList.add('is-dragging-modal');
        try { handleEl.setPointerCapture(ev.pointerId); } catch { /* ignore */ }
        ev.preventDefault();
    });

    handleEl.addEventListener('pointermove', (ev) => {
        if (!dragging || !baseRect) return;
        const vw = globalThis.innerWidth || document.documentElement.clientWidth || 1200;
        const vh = globalThis.innerHeight || document.documentElement.clientHeight || 800;
        const rawDeltaX = ev.clientX - startX;
        const rawDeltaY = ev.clientY - startY;

        // Keep at least 100px of header visible horizontally and full header inside viewport vertically
        const minDeltaX = -(baseRect.right - 100);
        const maxDeltaX = vw - baseRect.left - 100;
        const minDeltaY = -(baseRect.top - 8);
        const maxDeltaY = vh - baseRect.top - 48;

        const clampedX = Math.max(minDeltaX, Math.min(maxDeltaX, rawDeltaX));
        const clampedY = Math.max(minDeltaY, Math.min(maxDeltaY, rawDeltaY));

        dx = baseDx + clampedX;
        dy = baseDy + clampedY;
        modal.style.transform = `translate3d(${Math.round(dx)}px, ${Math.round(dy)}px, 0)`;
    });

    const endDrag = (ev) => {
        if (!dragging) return;
        dragging = false;
        modal.classList.remove('is-dragging-modal');
        try { handleEl.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
    };
    handleEl.addEventListener('pointerup', endDrag);
    handleEl.addEventListener('pointercancel', endDrag);
}

/**
 * Open the standalone Group Manager modal (zero space occupied in `#WorldInfo` when closed!).
 */
function openManagerModal() {
    if (!_callbacks) return;
    if (document.getElementById(MANAGER_OVERLAY_ID)) {
        refreshManagerModalContent();
        return;
    }

    _lastModalListSig = null;

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
    const stableH = Math.round(Math.min(baseVh * 0.84, 720));
    modal.style.setProperty('--wbo-stable-h', `${stableH}px`);

    modal.innerHTML = `
        <div class="wbo-modal-header wbo-draggable-header">
            <div class="wbo-modal-header-top">
                <span class="wbo-modal-title">世界书分组管理</span>
                <button type="button" class="wbo-icon-btn wbo-modal-close" aria-label="关闭">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>
            <div class="wbo-mgr-header-tools">
                <button type="button" class="wbo-tool-btn" data-action="open-ai-organize" title="本地一键整理 / AI 智能整理">
                    <i class="fa-solid fa-wand-magic-sparkles"></i>
                    <span>整理</span>
                </button>
                <button type="button" class="wbo-tool-btn" id="wbo-mgr-scan-btn" data-action="open-scan-modal" title="扫描角色世界书">
                    <i class="fa-solid fa-arrows-rotate"></i>
                    <span id="wbo-mgr-scan-label">扫描</span>
                </button>
                <button type="button" class="wbo-tool-btn" data-action="open-settings-modal" title="显示与行为设置">
                    <i class="fa-solid fa-gear"></i>
                    <span>设置</span>
                </button>
            </div>
        </div>
        <div class="wbo-mgr-subbar${_mgrPillsExpanded ? ' is-pills-expanded' : ''}">
            <div class="wbo-mgr-groupbar" id="wbo-mgr-groupbar">
                <div class="wbo-pills-rail">
                    <div class="wbo-pills${_mgrPillsExpanded ? ' is-expanded' : ''}" id="wbo-mgr-pills"></div>
                    <button type="button" class="wbo-pill-expand-btn" id="wbo-mgr-pills-expand" data-action="toggle-pills-expand" title="${_mgrPillsExpanded ? '收起为单行' : '展开查看全部分组'}">
                        <i class="fa-solid ${_mgrPillsExpanded ? 'fa-chevron-up' : 'fa-chevron-down'}"></i>
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
        </div>
        <div class="wbo-mgr-es-box" id="wbo-mgr-es-box" hidden></div>
        <div class="wbo-batch-bar" id="wbo-batch-bar" hidden>
            <span class="wbo-batch-count" id="wbo-batch-count">已选 0 本</span>
            <button type="button" class="wbo-link-btn" id="wbo-batch-toggle-all" data-action="batch-toggle-visible">全选当前</button>
            <span class="wbo-spacer"></span>
            <button type="button" class="wbo-btn wbo-btn-primary" id="wbo-batch-move-btn" data-action="batch-move" disabled>移入分组</button>
            <button type="button" class="wbo-btn" id="wbo-batch-ungroup-btn" data-action="batch-ungroup" disabled title="解除选中世界书的自定义分组，恢复到未分组">解除分组</button>
            <button type="button" class="wbo-btn wbo-btn-danger" id="wbo-batch-del-btn" data-action="batch-delete" disabled>删除选中</button>
            <button type="button" class="wbo-btn" data-action="toggle-batch-mode">完成</button>
        </div>
        <div class="wbo-groups-list wbo-mgr-list" id="wbo-mgr-groups-list"></div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Isolate modal events from SillyTavern's unpinned-drawer auto-closer, and close ONLY via the `×` button!
    const stopAll = (ev) => ev.stopPropagation();
    for (const evtName of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'click', 'touchstart', 'touchend']) {
        modal.addEventListener(evtName, stopAll);
    }
    attachDesktopModalDrag(modal, modal.querySelector('.wbo-modal-header'));
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
            if (ev.key === 'Enter' && !_isComposing) {
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
            if (!_mgrPillsExpanded && Math.abs(ev.deltaY) > Math.abs(ev.deltaX) && pillsRow.scrollWidth > pillsRow.clientWidth) {
                ev.preventDefault();
                pillsRow.scrollLeft += ev.deltaY;
            }
        }, { passive: false });
    }

    // Drag & Drop inside Group Manager:
    // 1. Drag any `.wbo-book-row` onto any `.wbo-group` or `.wbo-pill` to move that book
    //    (in batch mode, dragging a checked book moves ALL checked books together!).
    // 2. Drag any `.wbo-group-header` onto another `.wbo-group` to reorder sections!
    /** @type {{ type: 'book', bookNames: string[] } | { type: 'group', groupId: string } | null} */
    let dragState = null;

    const clearDropHighlights = () => {
        modal.querySelectorAll('.wbo-drop-target, .wbo-drop-before, .wbo-drop-after, .is-dragging').forEach((el) => {
            el.classList.remove('wbo-drop-target', 'wbo-drop-before', 'wbo-drop-after', 'is-dragging');
        });
    };

    modal.addEventListener('dragstart', (ev) => {
        const target = ev.target instanceof Element ? ev.target : null;
        if (!target) return;

        const bookRow = target.closest('.wbo-book-row[data-book]');
        if (bookRow instanceof HTMLElement) {
            const bookName = bookRow.getAttribute('data-book');
            if (!bookName) return;
            const bookNames = (_batchMode && _batchSelected.has(bookName) && _batchSelected.size > 1)
                ? [..._batchSelected]
                : [bookName];
            dragState = { type: 'book', bookNames };
            if (ev.dataTransfer) {
                ev.dataTransfer.effectAllowed = 'move';
                ev.dataTransfer.setData('text/plain', bookNames.join('\n'));
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
    });

    modal.addEventListener('dragover', (ev) => {
        if (!dragState) return;
        const target = ev.target instanceof Element ? ev.target : null;
        if (!target) return;

        if (dragState.type === 'book') {
            const dropGroup = target.closest('.wbo-group[data-group-id]');
            const dropPill = target.closest('.wbo-pill[data-group-id]');
            const pillGid = dropPill?.getAttribute('data-group-id');
            const validPill = dropPill && pillGid && pillGid !== SPECIAL_GROUPS.DEFAULT && pillGid !== SPECIAL_GROUPS.ALL
                ? dropPill
                : null;
            const dropEl = dropGroup || validPill;
            if (!dropEl) return;

            ev.preventDefault();
            if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
            if (!dropEl.classList.contains('wbo-drop-target')) {
                modal.querySelectorAll('.wbo-drop-target').forEach((el) => el.classList.remove('wbo-drop-target'));
                dropEl.classList.add('wbo-drop-target');
            }
            return;
        }

        if (dragState.type === 'group') {
            const targetGroup = target.closest('.wbo-group[data-group-id]');
            if (!(targetGroup instanceof HTMLElement)) return;
            const targetId = targetGroup.getAttribute('data-group-id');
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
    });

    modal.addEventListener('drop', async (ev) => {
        if (!dragState || !_callbacks) return;
        const activeDrag = dragState;
        const target = ev.target instanceof Element ? ev.target : null;
        const { settings, classification } = _callbacks.getState();

        if (activeDrag.type === 'book' && target) {
            const dropGroup = target.closest('.wbo-group[data-group-id]');
            const dropPill = target.closest('.wbo-pill[data-group-id]');
            const pillGid = dropPill?.getAttribute('data-group-id');
            const targetGroupId = dropGroup?.getAttribute('data-group-id') ||
                (pillGid && pillGid !== SPECIAL_GROUPS.DEFAULT && pillGid !== SPECIAL_GROUPS.ALL ? pillGid : null);

            clearDropHighlights();
            dragState = null;
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
            const targetId = targetGroup?.getAttribute('data-group-id');
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
    });

    modal.addEventListener('dragend', () => {
        clearDropHighlights();
        dragState = null;
    });

    modal.addEventListener('click', async (ev) => {
        const target = ev.target instanceof Element ? ev.target.closest('[data-action]') : null;
        if (!target || !_callbacks) return;

        const action = target.getAttribute('data-action');
        const { settings, classification } = _callbacks.getState();

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
                refreshManagerModalContent();
                await _callbacks.onMutation({ save: true, uiOnly: true });
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
                    if (collapsedEl instanceof HTMLElement) {
                        collapsedEl.scrollIntoView({ block: 'nearest' });
                    }
                }
                await _callbacks.onMutation({ save: true, uiOnly: true });
                break;
            }
            case 'move-section-up': {
                const gid = target.getAttribute('data-group-id');
                if (gid && moveSectionOrder(settings, gid, -1)) {
                    await _callbacks.onMutation({ save: true });
                }
                break;
            }
            case 'move-section-down': {
                const gid = target.getAttribute('data-group-id');
                if (gid && moveSectionOrder(settings, gid, 1)) {
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
                settings.groups = settings.groups.filter((g) => g.id !== gid);
                for (const [book, assigned] of Object.entries(settings.assignments)) {
                    if (assigned === gid) delete settings.assignments[book];
                }
                if (settings.activeFilterGroupId === gid) {
                    settings.activeFilterGroupId = SPECIAL_GROUPS.DEFAULT;
                }
                await _callbacks.onMutation({ save: true });
                showToast('info', `已删除分组「${grp.name}」`);
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
                _mgrPillsExpanded = !_mgrPillsExpanded;
                const subbar = modal.querySelector('.wbo-mgr-subbar');
                const pills = modal.querySelector('#wbo-mgr-pills');
                const expBtn = modal.querySelector('#wbo-mgr-pills-expand');
                subbar?.classList.toggle('is-pills-expanded', _mgrPillsExpanded);
                pills?.classList.toggle('is-expanded', _mgrPillsExpanded);
                if (expBtn instanceof HTMLElement) {
                    expBtn.title = _mgrPillsExpanded ? '收起为单行' : '展开查看全部分组';
                    expBtn.innerHTML = `<i class="fa-solid ${_mgrPillsExpanded ? 'fa-chevron-up' : 'fa-chevron-down'}"></i>`;
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
                    if (settings.assignments && name in settings.assignments) {
                        delete settings.assignments[name];
                        ungroupedCount += 1;
                    }
                    // If a character-bound book was manually pulled out into a custom group, let it return cleanly
                    const meta = classification.byName.get(name);
                    if (meta?.isCharBound && settings.charBookOverrides?.[name] === 'exclude_from_char') {
                        delete settings.charBookOverrides[name];
                    }
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
            case 'edit-book': {
                const holder = target.closest('.wbo-book-item, .wbo-book-row');
                const bookName = holder?.getAttribute('data-book');
                if (bookName) {
                    openWorldInNativeEditor(bookName);
                    closeManagerModal();
                }
                break;
            }
            case 'rename-alias': {
                const row = target.closest('.wbo-book-row');
                const bookName = row?.getAttribute('data-book');
                const meta = bookName ? classification.byName.get(bookName) : null;
                if (meta) openAliasNoteModal(meta);
                break;
            }
            case 'move-group': {
                const row = target.closest('.wbo-book-row');
                const bookName = row?.getAttribute('data-book');
                const meta = bookName ? classification.byName.get(bookName) : null;
                if (meta) openMoveGroupModal(meta);
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
                openScanAndImportModal();
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
}

/**
 * Refresh the Group Manager modal header indicators, filter pills, and list.
 */
function refreshManagerModalContent() {
    const overlay = document.getElementById(MANAGER_OVERLAY_ID);
    if (!overlay || !_callbacks) return;

    const { settings, classification } = _callbacks.getState();
    const hasCustomGroups = classification.customGroups.length > 0;
    const orderedSections = classification.orderedSections || [];

    const cb = overlay.querySelector('#wbo-mgr-show-char');
    const lbl = overlay.querySelector('#wbo-mgr-char-label');
    if (cb instanceof HTMLInputElement) cb.checked = Boolean(settings.showCharBooks);
    if (lbl) lbl.textContent = `角色书 ${classification.charCount}`;

    const modalEl = overlay.querySelector('.wbo-modal');
    if (modalEl instanceof HTMLElement) applyThemeClass(modalEl);

    const characters = getCharactersInMemory();
    const unscannedShallowCount = findUnscannedShallowCharacters(characters, settings.cachedCharBindings).length;
    const unimportedBookCount = findCardsWithUnimportedBooks({
        characters,
        worldNamesSet: new Set(classification.byName.keys()),
        cachedCharBindings: settings.cachedCharBindings,
    }).length;
    const scanBadgeCount = unscannedShallowCount + unimportedBookCount;

    const scanBtn = overlay.querySelector('#wbo-mgr-scan-btn');
    const scanLbl = overlay.querySelector('#wbo-mgr-scan-label');
    if (scanBtn) scanBtn.classList.toggle('is-active', scanBadgeCount > 0);
    if (scanLbl) scanLbl.textContent = scanBadgeCount > 0 ? `扫描 ${scanBadgeCount}` : '扫描';

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
    const expandBtnEl = overlay.querySelector('#wbo-mgr-pills-expand');
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

    // Show the expand chevron ONLY when the pills actually overflow the current viewport width
    // (or while already expanded so the user can collapse it back). Zero dead/no-op buttons!
    if (expandBtnEl instanceof HTMLElement && pillsEl instanceof HTMLElement) {
        if (!showGroupBar) {
            expandBtnEl.hidden = true;
        } else if (_mgrPillsExpanded) {
            expandBtnEl.hidden = false;
        } else {
            expandBtnEl.hidden = true;
            requestAnimationFrame(() => {
                if (!pillsEl.isConnected || _mgrPillsExpanded) return;
                const overflows = pillsEl.scrollWidth > pillsEl.clientWidth + 2;
                expandBtnEl.hidden = !overflows;
            });
        }
    }

    syncManagerSearchBarUi();
    renderManagerGroupsListOnly();
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

    pop.addEventListener('click', (ev) => ev.stopPropagation());
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
        if (input instanceof HTMLInputElement) input.focus();
        return;
    }

    const { settings, classification } = _callbacks.getState();
    const filterId = settings.activeFilterGroupId;
    let targetBooks = [];
    if (filterId === SPECIAL_GROUPS.ALL) {
        targetBooks = [...classification.byName.values()];
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
                            <button type="button" class="wbo-link-btn wbo-es-jump-uid" data-es-open="${esc(worldName)}" data-es-uid="${esc(h.uid)}">定位条目</button>
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
                    <button type="button" class="wbo-btn wbo-es-open-btn" data-es-open="${esc(worldName)}">
                        <i class="fa-solid fa-arrow-up-right-from-square"></i> 编辑
                    </button>
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
 * Re-render ONLY `#wbo-mgr-groups-list` while preserving scroll position and search input!
 */
function renderManagerGroupsListOnly() {
    if (!_callbacks) return;
    const listEl = document.getElementById('wbo-mgr-groups-list');
    if (!listEl) return;

    const { settings, classification } = _callbacks.getState();
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

    // Read LIVE collapse & hidden-group state from `settings` (never stale cached `classification`!)
    const structSig = JSON.stringify([
        q,
        _batchMode,
        settings.activeFilterGroupId,
        settings.charBookTitleMode,
        settings.aliasTitleMode,
        Boolean(settings.showCharBooks),
        Boolean(settings.charGroupCollapsed),
        Boolean(settings.ungroupedCollapsed),
        searchOpts.searchBookName,
        searchOpts.searchCharName,
        Boolean(settings.mgrSearchInEntries),
        searchOpts.splitSpaces,
        [...globalHiddenSet].sort().join(','),
        [...editorHiddenSet].sort().join(','),
        orderedSections.map((sec) => [
            sec.id,
            sec.name,
            sec.color,
            sec.kind === 'custom' ? Boolean(liveGroupById.get(sec.id)?.collapsed) : false,
            sec.books.map((b) => `${b.realName}|${b.primaryTitle}|${b.subtitle}|${b.note}`).join(','),
        ]),
    ]);
    if (structSig === _lastModalListSig && listEl.childElementCount > 0) {
        syncEmbeddedPanelIndicators();
        return;
    }
    _lastModalListSig = structSig;

    const prevScroll = listEl.scrollTop;
    const activeGlobals = getActiveGlobalWorldSet();
    const currentEditor = getCurrentEditorWorldName();
    const hasCustomGroups = classification.customGroups.length > 0;
    const filterId = settings.activeFilterGroupId;
    const includeCharExplicitly =
        filterId === SPECIAL_GROUPS.CHARACTER ||
        filterId === SPECIAL_GROUPS.ALL ||
        (filterId === SPECIAL_GROUPS.DEFAULT && settings.showCharBooks);

    const sections = [];

    orderedSections.forEach((sec, idx) => {
        const canMoveUp = idx > 0;
        const canMoveDown = idx < orderedSections.length - 1;

        if (sec.kind === 'custom') {
            if (filterId !== SPECIAL_GROUPS.DEFAULT && filterId !== SPECIAL_GROUPS.ALL && filterId !== sec.id) return;
            const books = q ? sec.books.filter((b) => matchesSearch(b, q, searchOpts)) : sec.books;
            if (q && books.length === 0) return;
            const liveCollapsed = Boolean(liveGroupById.get(sec.id)?.collapsed);
            const isSingleView = filterId === sec.id;
            const forceOpen = Boolean(q) || isSingleView;
            sections.push(
                renderGroupSectionHtml({
                    id: sec.id,
                    name: sec.name,
                    color: sec.color,
                    collapsed: forceOpen ? false : liveCollapsed,
                    isCustom: true,
                    isSingleView,
                    hiddenInGlobal: globalHiddenSet.has(sec.id),
                    hiddenInEditor: editorHiddenSet.has(sec.id),
                    canMoveUp,
                    canMoveDown,
                    books,
                    activeGlobals,
                    currentEditor,
                }),
            );
            return;
        }

        if (sec.kind === 'ungrouped') {
            if (
                filterId !== SPECIAL_GROUPS.DEFAULT &&
                filterId !== SPECIAL_GROUPS.ALL &&
                filterId !== SPECIAL_GROUPS.UNGROUPED
            ) return;
            const books = q ? sec.books.filter((b) => matchesSearch(b, q, searchOpts)) : sec.books;
            if (q && books.length === 0) return;
            const isSingleView = filterId === SPECIAL_GROUPS.UNGROUPED;
            const forceOpen = Boolean(q) || isSingleView;
            sections.push(
                renderGroupSectionHtml({
                    id: SPECIAL_GROUPS.UNGROUPED,
                    name: hasCustomGroups ? '未分组' : '非角色世界书',
                    color: '#8c99a6',
                    collapsed: forceOpen ? false : Boolean(settings.ungroupedCollapsed),
                    isCustom: false,
                    isSingleView,
                    hiddenInGlobal: globalHiddenSet.has(SPECIAL_GROUPS.UNGROUPED),
                    hiddenInEditor: editorHiddenSet.has(SPECIAL_GROUPS.UNGROUPED),
                    canMoveUp,
                    canMoveDown,
                    books,
                    activeGlobals,
                    currentEditor,
                }),
            );
            return;
        }

        if (sec.kind === 'character' && classification.charCount > 0) {
            const matchedCharBooks = q ? sec.books.filter((b) => matchesSearch(b, q, searchOpts)) : sec.books;
            if (includeCharExplicitly) {
                if (q && matchedCharBooks.length === 0) return;
                const isSingleView = filterId === SPECIAL_GROUPS.CHARACTER;
                const forceOpen = Boolean(q) || isSingleView;
                sections.push(
                    renderGroupSectionHtml({
                        id: SPECIAL_GROUPS.CHARACTER,
                        name: '角色世界书',
                        color: '#7c8594',
                        collapsed: forceOpen ? false : Boolean(settings.charGroupCollapsed),
                        isCustom: false,
                        isSingleView,
                        charBookTitleMode: settings.charBookTitleMode,
                        hiddenInGlobal: globalHiddenSet.has(SPECIAL_GROUPS.CHARACTER),
                        hiddenInEditor: editorHiddenSet.has(SPECIAL_GROUPS.CHARACTER),
                        canMoveUp,
                        canMoveDown,
                        books: matchedCharBooks,
                        activeGlobals,
                        currentEditor,
                    }),
                );
            } else if (filterId === SPECIAL_GROUPS.DEFAULT && q && matchedCharBooks.length > 0) {
                sections.push(`
                    <div class="wbo-char-match-bar">
                        <span>已隐藏的角色书中有 ${matchedCharBooks.length} 项匹配</span>
                        <button type="button" class="wbo-link-btn" data-action="reveal-char-books">查看</button>
                    </div>
                `);
            }
        }
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

    listEl.innerHTML = sections.length > 0
        ? sections.join('')
        : (q && settings.mgrSearchInEntries
            ? '<div class="wbo-empty-hint">按回车或点上方「搜索」开始检索条目内容</div>'
            : '<div class="wbo-empty-hint">无匹配世界书</div>');

    listEl.scrollTop = prevScroll;
    syncBatchBarUi();
}

// ==================== Sub-Modals (stack above Manager Modal) ====================

function closeSubModal() {
    document.getElementById(SUBMODAL_OVERLAY_ID)?.remove();
}

/**
 * Create a sub-modal stacked above the Group Manager modal without closing `#WorldInfo`.
 */
function createSubModal(title, bodyHtml, { wide = false, pinnedLayout = false } = {}) {
    closeSubModal();
    const overlay = document.createElement('div');
    overlay.id = SUBMODAL_OVERLAY_ID;
    overlay.className = 'wbo-modal-overlay wbo-submodal-overlay';
    applyTauriSurface(overlay, 'backdrop');

    const modal = document.createElement('div');
    modal.className = `wbo-modal${wide ? ' is-wide' : ''}${pinnedLayout ? ' is-pinned-layout' : ''}`;
    applyThemeClass(modal);
    applyTauriSurface(modal, 'fullscreen-window');
    if (wide || pinnedLayout) {
        // Lock a steady window height so switching tabs/views NEVER jumps the modal vertically!
        const baseVh = Math.max(globalThis.innerHeight || 0, document.documentElement?.clientHeight || 0, 560);
        const stableH = wide
            ? Math.round(Math.min(baseVh * 0.84, 680))
            : Math.round(Math.min(baseVh * 0.78, 600));
        modal.style.setProperty('--wbo-stable-h', `${stableH}px`);
    }

    modal.innerHTML = `
        <div class="wbo-modal-header wbo-draggable-header">
            <div class="wbo-modal-header-top">
                <span class="wbo-modal-title">${esc(title)}</span>
                <button type="button" class="wbo-icon-btn wbo-modal-close" aria-label="关闭">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>
        </div>
        <div class="wbo-modal-body${pinnedLayout ? ' wbo-pinned-body' : ''}">${bodyHtml}</div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Isolate events from SillyTavern and close ONLY via the `×` / action buttons (never backdrop click!)
    const stopAll = (ev) => ev.stopPropagation();
    for (const evtName of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'click', 'touchstart', 'touchend']) {
        overlay.addEventListener(evtName, stopAll);
    }
    attachDesktopModalDrag(modal, modal.querySelector('.wbo-modal-header'));
    modal.querySelector('.wbo-modal-close')?.addEventListener('click', (ev) => {
        ev.stopPropagation();
        closeSubModal();
    });

    return { overlay, modal };
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

    const currentMemberSet = new Set(
        isEdit && group
            ? Object.entries(settings.assignments || {})
                .filter(([, gid]) => gid === group.id)
                .map(([name]) => name)
            : (initialBookName ? [initialBookName] : []),
    );

    // Show current members first when editing, followed by ungrouped & other custom groups
    const rawCandidates = [
        ...classification.ungroupedBooks,
        ...classification.customGroups.flatMap((g) => g.books),
        ...(initialBookName && classification.byName.get(initialBookName)?.isInCharGroup
            ? [classification.byName.get(initialBookName)]
            : []),
    ].filter(Boolean);

    const candidateBooks = [
        ...rawCandidates.filter((b) => currentMemberSet.has(b.realName)),
        ...rawCandidates.filter((b) => !currentMemberSet.has(b.realName)),
    ];

    const pickSectionHtml = candidateBooks.length > 0
        ? `
            <div class="wbo-field">
                <div class="wbo-ai-section-head">
                    <span>${isEdit ? '管理分组内的世界书' : '选择要加入此分组的世界书'}</span>
                    <input type="search" class="wbo-input wbo-group-pick-filter" id="wbo-group-pick-filter" placeholder="筛选世界书..." autocomplete="off">
                </div>
                <div class="wbo-ai-book-list wbo-group-pick-list" id="wbo-group-pick-list">
                    ${candidateBooks.map((b) => `
                        <label class="wbo-ai-pick-row" data-pick-search="${esc(b.searchableText || b.realName.toLowerCase())}">
                            <input type="checkbox" class="wbo-group-pick-check" value="${esc(b.realName)}"${currentMemberSet.has(b.realName) ? ' checked' : ''}>
                            <span class="wbo-ai-pick-name" title="${esc(b.realName)}">${esc(b.primaryTitle)}${b.subtitle ? ` <small>${esc(b.subtitle)}</small>` : ''}</span>
                            <span class="wbo-tag">${esc(b.groupName)}</span>
                        </label>
                    `).join('')}
                </div>
            </div>
        `
        : '';

    const { modal } = createSubModal(
        isEdit ? '编辑分组' : '新建分组',
        `
            <div class="wbo-field">
                <label class="wbo-label">分组名称</label>
                <input type="text" class="wbo-input" id="wbo-group-name-input" value="${esc(group?.name || '')}" placeholder="例如：文风设定、世界观、系统规则">
            </div>
            <div class="wbo-field">
                <label class="wbo-label">标识颜色</label>
                <div class="wbo-swatches">${swatches}</div>
            </div>
            ${pickSectionHtml}
            <div class="wbo-modal-footer">
                <button type="button" class="wbo-btn wbo-btn-primary" id="wbo-save-group-btn">${isEdit ? '保存' : '创建'}</button>
                <button type="button" class="wbo-btn" id="wbo-cancel-btn">取消</button>
            </div>
        `,
        { wide: candidateBooks.length > 0 },
    );

    let chosenColor = initialColor;
    modal.querySelectorAll('.wbo-swatch').forEach((btn) => {
        btn.addEventListener('click', () => {
            chosenColor = btn.getAttribute('data-color') || initialColor;
            modal.querySelectorAll('.wbo-swatch').forEach((b) => b.classList.remove('is-selected'));
            btn.classList.add('is-selected');
        });
    });

    const pickFilter = modal.querySelector('#wbo-group-pick-filter');
    if (pickFilter instanceof HTMLInputElement) {
        let composing = false;
        const filterRows = () => {
            const q = pickFilter.value.trim().toLowerCase();
            modal.querySelectorAll('#wbo-group-pick-list .wbo-ai-pick-row').forEach((row) => {
                if (!(row instanceof HTMLElement)) return;
                const hay = row.getAttribute('data-pick-search') || '';
                row.hidden = Boolean(q && !hay.includes(q));
            });
        };
        pickFilter.addEventListener('compositionstart', () => { composing = true; });
        pickFilter.addEventListener('compositionend', () => { composing = false; filterRows(); });
        pickFilter.addEventListener('input', () => { if (!composing) filterRows(); });
    }

    const input = modal.querySelector('#wbo-group-name-input');
    if (input instanceof HTMLInputElement && (globalThis.innerWidth || 999) > 680) {
        input.focus();
        input.select();
    }

    const submit = async (selectAfterCreate = false) => {
        const name = input instanceof HTMLInputElement ? input.value.trim() : '';
        if (!name) {
            showToast('warning', '请输入分组名称');
            return;
        }
        const pickedSet = new Set(
            Array.from(modal.querySelectorAll('.wbo-group-pick-check:checked'))
                .map((el) => (el instanceof HTMLInputElement ? el.value : ''))
                .filter(Boolean),
        );

        if (isEdit && group) {
            group.name = name;
            group.color = chosenColor;
            // Remove books unchecked from this group
            for (const prevBook of currentMemberSet) {
                if (!pickedSet.has(prevBook) && settings.assignments[prevBook] === group.id) {
                    delete settings.assignments[prevBook];
                }
            }
            // Add newly checked books into this group
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
    input?.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') submit();
    });
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
                同步更新角色卡主/附绑定、User 人设绑定、当前聊天与全局激活；未打开的旧聊天单聊绑定与脚本硬编码名称需自行留意。
            </div>
            <div class="wbo-field">
                <label class="wbo-label" id="wbo-name-input-label">显示名称</label>
                <div class="wbo-input-clear-row">
                    <input type="text" class="wbo-input" id="wbo-alias-input" value="${esc(initialDisplayValue)}" placeholder="${esc(bookMeta.primaryTitle)}">
                    <button type="button" class="wbo-btn wbo-input-clear-btn" id="wbo-clear-name-input-btn" title="清空输入框">清空</button>
                </div>
            </div>
            <div class="wbo-field">
                <label class="wbo-label">备注</label>
                <input type="text" class="wbo-input" id="wbo-note-input" value="${esc(bookMeta.note || '')}" placeholder="用途或特点">
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
    if (aliasInput instanceof HTMLInputElement && (globalThis.innerWidth || 999) > 680) {
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
            aliasInput.focus();
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
    aliasInput?.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') save(); });
    noteInput?.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') save(); });
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
            id: SPECIAL_GROUPS.UNGROUPED,
            label: bookMeta.isCharBound ? '移出角色世界书' : '未分组',
            color: '#8c99a6',
            desc: '',
        },
        ...(bookMeta.isCharBound
            ? [{
                id: SPECIAL_GROUPS.CHARACTER,
                label: '角色世界书',
                color: '#7c8594',
                desc: bookMeta.charOwners.map((o) => o.charName).join('、'),
            }]
            : []),
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
            <div class="wbo-modal-footer">
                <button type="button" class="wbo-btn" id="wbo-move-new-group">新建分组</button>
                <span class="wbo-spacer"></span>
                <button type="button" class="wbo-btn" id="wbo-cancel-btn">关闭</button>
            </div>
        `,
    );

    modal.querySelectorAll('.wbo-move-option').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const targetId = btn.getAttribute('data-target-group');
            if (!targetId) return;

            if (targetId === SPECIAL_GROUPS.CHARACTER) {
                delete settings.assignments[bookMeta.realName];
                delete settings.charBookOverrides[bookMeta.realName];
            } else if (targetId === SPECIAL_GROUPS.UNGROUPED) {
                delete settings.assignments[bookMeta.realName];
                if (bookMeta.isCharBound) {
                    settings.charBookOverrides[bookMeta.realName] = 'exclude_from_char';
                }
            } else {
                settings.assignments[bookMeta.realName] = targetId;
                if (bookMeta.isCharBound) {
                    settings.charBookOverrides[bookMeta.realName] = 'exclude_from_char';
                }
            }

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
 * AI Smart Worldbook Organizer modal:
 * - Collapsible saved multi-channel API config (cross-device via extensionSettings)
 * - Supports optional real filename normalization when user allows it
 */
function openAiOrganizeModal({ initialTab = null } = {}) {
    if (!_callbacks) return;
    const { settings, classification } = _callbacks.getState();

    const nonCharBooks = [
        ...classification.ungroupedBooks,
        ...classification.customGroups.flatMap((g) => g.books),
    ];
    const allBooks = [...nonCharBooks, ...classification.characterBooks];

    if (allBooks.length === 0) {
        showToast('warning', '当前没有可整理的世界书');
        return;
    }

    const defaultChecked = new Set(
        (classification.ungroupedBooks.length > 0 ? classification.ungroupedBooks : nonCharBooks).map((b) => b.realName),
    );

    const getUndoHistoryCount = () =>
        (Array.isArray(settings.undoSnapshots) ? settings.undoSnapshots.length : 0) + (settings.initialSnapshot ? 1 : 0);

    const getUndoButtonLabel = () => {
        const snaps = Array.isArray(settings.undoSnapshots) ? settings.undoSnapshots : [];
        const total = getUndoHistoryCount();
        if (total === 0) return '暂无可回退版本';
        if (snaps.length === 0 && settings.initialSnapshot) return '恢复最初状态';
        return total > 1 ? `撤销 / 历史回退 (${total})` : '撤销上次整理';
    };
    const hasUndo = getUndoHistoryCount() > 0;

    const getActiveChannel = () =>
        settings.apiChannels.find((c) => c.id === settings.activeApiChannelId) || settings.apiChannels[0] || null;

    const getApiSummaryText = () => {
        if (settings.apiProvider !== 'custom') return '酒馆当前 API';
        const ch = getActiveChannel();
        if (!ch) return '自定义 API（未配置）';
        return ch.model ? `${ch.name} · ${ch.model}` : ch.name;
    };

    const sensitiveSet = new Set(
        allBooks.filter((b) => isPotentiallySensitiveTitle(b.realName)).map((b) => b.realName),
    );
    // Protect users from wasting API quota on safety refusals: uncheck likely-sensitive books by default
    // (still clearly announced in a prominent banner with a 1-click button to re-include if using a lax model).
    for (const sName of sensitiveSet) {
        defaultChecked.delete(sName);
    }

    const bookChecksHtml = allBooks
        .map((b) => {
            const checked = defaultChecked.has(b.realName) ? 'checked' : '';
            const isSens = sensitiveSet.has(b.realName);
            const sensTag = isSens ? '<span class="wbo-tag is-warn" title="含疑似敏感词，部分模型可能拒答">敏感</span>' : '';
            const tag = b.isInCharGroup ? '<span class="wbo-tag">角色书</span>' : `<span class="wbo-tag">${esc(b.groupName)}</span>`;
            return `
                <label class="wbo-ai-pick-row" data-ai-search="${esc(b.searchableText || b.realName.toLowerCase())}">
                    <input type="checkbox" class="wbo-ai-book-check" value="${esc(b.realName)}" ${checked}>
                    <span class="wbo-ai-pick-name" title="${esc(b.realName)}">${esc(b.primaryTitle)}${b.subtitle ? ` <small>${esc(b.subtitle)}</small>` : ''}</span>
                    ${sensTag}
                    ${tag}
                </label>
            `;
        })
        .join('');

    const activeCh = getActiveChannel();
    const startTab = initialTab || 'local';
    const selectedLocalCatSet = new Set(
        Array.isArray(settings.localOrganizeCategories)
            ? settings.localOrganizeCategories
            : DEFAULT_LOCAL_ORGANIZE_CATEGORY_IDS,
    );
    const localCatChipsHtml = LOCAL_ORGANIZE_CATEGORIES.map((cat) => {
        const active = selectedLocalCatSet.has(cat.id);
        return `
            <button type="button" class="wbo-local-cat-btn${active ? ' is-selected' : ''}" data-local-cat="${esc(cat.id)}" aria-pressed="${active ? 'true' : 'false'}">
                <span class="wbo-local-cat-mark">${active ? '<i class="fa-solid fa-check"></i>' : ''}</span>
                <span>${esc(cat.group)}</span>
            </button>
        `;
    }).join('');

    const { modal } = createSubModal(
        '整理世界书',
        `
            <div class="wbo-pinned-tabs-bar" id="wbo-ai-tabs">
                <div class="wbo-tabs">
                    <button type="button" class="wbo-tab${startTab === 'local' ? ' is-active' : ''}" data-ai-tab="local">免 AI 整理</button>
                    <button type="button" class="wbo-tab${startTab === 'organize' ? ' is-active' : ''}" data-ai-tab="organize">AI 整理</button>
                </div>
            </div>

            <div class="wbo-ai-step wbo-local-step" id="wbo-ai-step-local"${startTab === 'local' ? '' : ' hidden'}>
                <div class="wbo-step-scroll">
                <div class="wbo-card wbo-local-card">
                    <div class="wbo-ai-section-head">
                        <span>1. 选择整理范围</span>
                    </div>
                    <div class="wbo-scope-grid">
                        <label class="wbo-scope-card">
                            <input type="radio" name="wbo-local-scope" value="ungrouped"${classification.ungroupedBooks.length > 0 ? ' checked' : ''}>
                            <span class="wbo-scope-body">
                                <span class="wbo-scope-title">仅整理未分组 <span class="wbo-tag">${classification.ungroupedBooks.length} 本</span></span>
                                <span class="wbo-scope-desc">保持已有分组不变</span>
                            </span>
                        </label>
                        <label class="wbo-scope-card">
                            <input type="radio" name="wbo-local-scope" value="nonchar"${classification.ungroupedBooks.length === 0 ? ' checked' : ''}>
                            <span class="wbo-scope-body">
                                <span class="wbo-scope-title">全部非角色书 <span class="wbo-tag">${classification.nonCharCount} 本</span></span>
                                <span class="wbo-scope-desc">按所选规则重新归类</span>
                            </span>
                        </label>
                    </div>
                </div>

                <div class="wbo-card wbo-local-card">
                    <div class="wbo-ai-section-head">
                        <span>2. 选择自动归类分组</span>
                        <span class="wbo-ai-quick-picks">
                            <button type="button" class="wbo-link-btn" id="wbo-local-cats-default">默认</button>
                            <button type="button" class="wbo-link-btn" id="wbo-local-cats-all">全选</button>
                            <button type="button" class="wbo-link-btn" id="wbo-local-cats-none">清空</button>
                        </span>
                    </div>
                    <div class="wbo-local-cats" id="wbo-local-cats">${localCatChipsHtml}</div>
                    <div class="wbo-subtle-tip">点击选中要自动归纳的分组，按书名前缀与关键词匹配，不修改原文件。</div>
                    <div class="wbo-local-divider"></div>
                    <label class="wbo-check-line">
                        <input type="checkbox" id="wbo-local-any-prefix">
                        <span>同时按书名开头的 [分类] / 【分类】 前缀自动建组</span>
                    </label>
                    <label class="wbo-check-line">
                        <input type="checkbox" id="wbo-local-clean-titles">
                        <span>顺手清理显示名末尾的 (1)、副本、作者署名</span>
                    </label>
                </div>

                <details class="wbo-collapse-box" id="wbo-local-rules-details">
                    <summary class="wbo-collapse-summary">
                        <span class="wbo-summary-left"><i class="fa-solid fa-chevron-right wbo-details-chev"></i><span>自定义归类关键词</span></span>
                        <span class="wbo-collapse-hint" id="wbo-local-rules-count">可选</span>
                    </summary>
                    <div class="wbo-collapse-body">
                        <div class="wbo-rule-builder-row">
                            <div class="wbo-rule-field">
                                <span class="wbo-rule-field-label">书名关键词</span>
                                <input type="text" class="wbo-input" id="wbo-local-rule-kw" placeholder="如：穿搭、现代">
                            </div>
                            <div class="wbo-rule-field">
                                <span class="wbo-rule-field-label">归入分组</span>
                                <input type="text" class="wbo-input" id="wbo-local-rule-grp" list="wbo-existing-groups-datalist" placeholder="如：User 人设">
                            </div>
                            <button type="button" class="wbo-btn wbo-rule-add-btn" id="wbo-local-rule-add-btn">添加</button>
                        </div>
                        <div class="wbo-subtle-tip">支持一次填多个关键词，用逗号或空格隔开。</div>
                        <datalist id="wbo-existing-groups-datalist">
                            ${settings.groups.map((g) => `<option value="${esc(g.name)}"></option>`).join('')}
                        </datalist>
                        <div class="wbo-rule-chips" id="wbo-local-rule-chips"></div>
                    </div>
                </details>

                <div class="wbo-ai-status" id="wbo-local-status"></div>
                </div>
                <div class="wbo-modal-footer wbo-ai-footer wbo-ai-footer-single wbo-pinned-footer">
                    <div class="wbo-ai-footer-left">
                        <button type="button" class="wbo-btn" id="wbo-local-undo-btn" ${hasUndo ? '' : 'hidden'}>
                            <i class="fa-solid fa-rotate-left"></i> <span id="wbo-local-undo-label">${esc(getUndoButtonLabel())}</span>
                        </button>
                    </div>
                    <div class="wbo-ai-footer-right">
                        <button type="button" class="wbo-btn wbo-btn-primary" id="wbo-local-run-btn">
                            <i class="fa-solid fa-bolt"></i> 一键自动归类
                        </button>
                    </div>
                </div>
            </div>

            <div class="wbo-ai-step" id="wbo-ai-step-select"${startTab === 'organize' ? '' : ' hidden'}>
                <div class="wbo-step-scroll">
                <div class="wbo-card wbo-ai-card">
                    <div class="wbo-ai-section-head">
                        <span>1. 选择世界书</span>
                        <span class="wbo-ai-quick-picks">
                            <button type="button" class="wbo-link-btn" id="wbo-pick-ungrouped">仅未分组</button>
                            <button type="button" class="wbo-link-btn" id="wbo-pick-nonchar">全部非角色书</button>
                            <button type="button" class="wbo-link-btn" id="wbo-pick-none">取消全选</button>
                        </span>
                    </div>
                    ${sensitiveSet.size > 0 ? `
                        <div class="wbo-sens-banner" id="wbo-sens-banner">
                            <i class="fa-solid fa-triangle-exclamation"></i>
                            <span id="wbo-sens-banner-text">已默认排除 ${sensitiveSet.size} 本疑似敏感世界书，避免触发 AI 拒答浪费额度</span>
                            <button type="button" class="wbo-btn wbo-sens-toggle-btn" id="wbo-pick-toggle-sens">包含敏感书</button>
                        </div>
                    ` : ''}
                    <input type="search" class="wbo-input wbo-ai-book-filter" id="wbo-ai-book-filter" placeholder="搜索筛选世界书..." autocomplete="off">
                    <div class="wbo-ai-book-list" id="wbo-ai-book-list">${bookChecksHtml}</div>
                </div>

                <div class="wbo-card wbo-ai-card">
                    <div class="wbo-ai-section-head">
                        <span>2. 选择风格</span>
                    </div>
                    <div class="wbo-ai-options">
                        <div class="wbo-preset-rows">
                            <div class="wbo-preset-group">
                                <span class="wbo-preset-label">分类方式</span>
                                <button type="button" class="wbo-preset-chip" data-preset-cat="group" data-preset-text="根据每本世界书的实际用途自然归纳为 4~7 个清晰分组，名称简洁直观，不强行套用固定模板。">智能自由分类</button>
                                <button type="button" class="wbo-preset-chip" data-preset-cat="group" data-preset-text="优先按酒馆常用用途归类（如文风、缝合、场景与互动、世界观、小剧场、通用素材）。注意「缝合」指用于缝合进预设的规则指令与功能补丁；约会流程与日常互动归入「场景与互动」。">按酒馆用途</button>
                                <button type="button" class="wbo-preset-chip" data-preset-cat="group" data-preset-text="尽量合并归类，总分组数量控制在 3~5 个高频大类内，减少翻找层级。">精简 3~5 大类</button>
                                <button type="button" class="wbo-preset-chip" data-preset-cat="group" data-preset-text="尽量归入我当前已有的分组中，除非完全无法归类否则少建新分组。">优先复用旧分组</button>
                            </div>
                            <div class="wbo-preset-group">
                                <span class="wbo-preset-label">命名风格</span>
                                <button type="button" class="wbo-preset-chip" data-preset-cat="name" data-preset-text="名称统一按 [分类] 核心主题 格式包裹，去掉作者署名与多余符号。">[分类] 名称</button>
                                <button type="button" class="wbo-preset-chip" data-preset-cat="name" data-preset-text="名称统一按 【分类】核心主题 格式包裹，去掉作者署名与多余符号。">【分类】名称</button>
                                <button type="button" class="wbo-preset-chip" data-preset-cat="name" data-preset-text="名称不加任何括号前缀，只保留简洁直观的纯中文核心主题名。">极简纯中文</button>
                                <button type="button" class="wbo-preset-chip" data-preset-cat="ver" data-preset-text="清理冗余装饰词但保留如 v2.0 等关键版本号。">保留版本号</button>
                            </div>
                        </div>
                        <textarea class="wbo-textarea wbo-rule-textarea" id="wbo-ai-custom-rule" rows="2" placeholder="可选：点上方预设自动填入，或直接写下你的分类和命名要求..."></textarea>

                        <details class="wbo-collapse-box">
                            <summary class="wbo-collapse-summary">
                                <span class="wbo-summary-left"><i class="fa-solid fa-chevron-right wbo-details-chev"></i><span>高级选项（读取条目摘要 / 修改真实文件名）</span></span>
                            </summary>
                            <div class="wbo-collapse-body">
                                <div class="wbo-clue-row">
                                    <label class="wbo-check-line">
                                        <input type="checkbox" id="wbo-ai-include-clues">
                                        <span>附带每本书前</span>
                                    </label>
                                    <input type="number" class="wbo-input wbo-inline-num" id="wbo-ai-clue-count" value="5" min="1" max="15">
                                    <span>条条目，携带</span>
                                    <select class="wbo-select wbo-inline-select" id="wbo-ai-snippet-len">
                                        <option value="50" selected>标题 + 50字摘要</option>
                                        <option value="120">标题 + 120字摘要</option>
                                        <option value="0">仅标题与关键词</option>
                                    </select>
                                </div>
                                <div class="wbo-subtle-tip">摘要在本地直接截取，不额外消耗 AI 额度。</div>
                                <label class="wbo-check-line">
                                    <input type="checkbox" id="wbo-ai-allow-real-rename">
                                    <span>允许同步修改世界书真实文件名，并自动更新角色卡与人设绑定</span>
                                </label>
                            </div>
                        </details>
                    </div>
                </div>

                <div class="wbo-card wbo-external-ai-drawer" id="wbo-external-ai-drawer" hidden>
                    <div class="wbo-ai-section-head">
                        <span>外部 AI 整理（免 API 额度）</span>
                        <button type="button" class="wbo-link-btn" id="wbo-external-ai-hide-btn">收起</button>
                    </div>
                    <textarea class="wbo-textarea" id="wbo-ai-json-input" rows="4" placeholder='1. 先点下方「复制提示词」发给任意外部 AI&#10;2. 把 AI 返回的 JSON 粘贴到这里，再点「解析并预览」'></textarea>
                    <div class="wbo-ai-actions-row">
                        <button type="button" class="wbo-btn" id="wbo-ai-copy-prompt-btn">
                            <i class="fa-regular fa-copy"></i> 复制提示词
                        </button>
                        <button type="button" class="wbo-btn wbo-btn-primary" id="wbo-ai-parse-paste-btn">解析并预览</button>
                    </div>
                </div>

                <div class="wbo-refusal-box" id="wbo-ai-refusal-box" hidden></div>
                <div class="wbo-ai-status" id="wbo-ai-status"></div>
                </div>

                <div class="wbo-modal-footer wbo-ai-footer wbo-pinned-footer">
                    <div class="wbo-ai-footer-left">
                        <button type="button" class="wbo-btn" id="wbo-ai-undo-btn" ${hasUndo ? '' : 'hidden'} title="恢复到上一次整理前的分组与显示名">
                            <i class="fa-solid fa-rotate-left"></i> <span id="wbo-ai-undo-label">${esc(getUndoButtonLabel())}</span>
                        </button>
                        <span class="wbo-api-inline-info">
                            <b id="wbo-api-summary-text">${esc(getApiSummaryText())}</b>
                            <button type="button" class="wbo-link-btn" id="wbo-goto-api-tab">配置 API</button>
                        </span>
                    </div>
                    <div class="wbo-ai-footer-right">
                        <button type="button" class="wbo-btn" id="wbo-toggle-external-ai-btn" title="不使用 API，复制提示词给外部 AI 后粘贴 JSON">
                            <i class="fa-regular fa-copy"></i> 外部 AI 整理
                        </button>
                        <button type="button" class="wbo-btn wbo-btn-primary" id="wbo-ai-run-btn">
                            <i class="fa-solid fa-wand-magic-sparkles"></i> 开始 AI 整理
                        </button>
                    </div>
                </div>
            </div>

            <div class="wbo-ai-step" id="wbo-ai-step-api" hidden>
                <div class="wbo-step-scroll">
                <div class="wbo-card">
                    <div class="wbo-ai-section-head">
                        <span>选择调用渠道</span>
                    </div>
                    <div class="wbo-radio-row">
                        <label class="wbo-radio-opt">
                            <input type="radio" name="wbo-api-provider" value="host" ${settings.apiProvider === 'host' ? 'checked' : ''}>
                            <span>酒馆当前 API</span>
                        </label>
                        <label class="wbo-radio-opt">
                            <input type="radio" name="wbo-api-provider" value="custom" ${settings.apiProvider === 'custom' ? 'checked' : ''}>
                            <span>自定义 OpenAI 兼容 API</span>
                        </label>
                    </div>

                    <div class="wbo-custom-api-box" id="wbo-custom-api-box" ${settings.apiProvider === 'custom' ? '' : 'hidden'}>
                        <div class="wbo-channel-bar">
                            <select class="wbo-select" id="wbo-channel-select"></select>
                            <button type="button" class="wbo-btn" id="wbo-ch-new-btn">新建</button>
                            <button type="button" class="wbo-btn wbo-btn-primary" id="wbo-ch-save-btn">保存</button>
                            <button type="button" class="wbo-btn" id="wbo-ch-del-btn">删除</button>
                        </div>
                        <input type="text" class="wbo-input" id="wbo-api-name" value="${esc(activeCh?.name || '')}" placeholder="配置名称，例如：常用通道 1">
                        <input type="text" class="wbo-input" id="wbo-api-base-url" value="${esc(activeCh?.baseUrl || 'https://api.openai.com/v1')}" placeholder="Base URL，例如 https://api.openai.com/v1">
                        <div class="wbo-api-model-row">
                            <input type="password" class="wbo-input" id="wbo-api-key" value="${esc(activeCh?.apiKey || '')}" placeholder="API Key" autocomplete="off">
                            <button type="button" class="wbo-btn" id="wbo-toggle-key-btn" title="显示或隐藏密钥">
                                <i class="fa-regular fa-eye"></i>
                            </button>
                        </div>
                        <div class="wbo-api-model-row">
                            <input type="text" class="wbo-input" id="wbo-api-model" value="${esc(activeCh?.model || '')}" list="wbo-api-models-datalist" placeholder="模型名称">
                            <datalist id="wbo-api-models-datalist"></datalist>
                            <button type="button" class="wbo-btn" id="wbo-fetch-models-btn">拉取模型</button>
                        </div>
                        <div class="wbo-ai-status" id="wbo-api-channel-status"></div>
                    </div>
                </div>
                </div>
                <div class="wbo-modal-footer wbo-pinned-footer">
                    <button type="button" class="wbo-btn wbo-btn-primary" id="wbo-back-to-organize-btn">返回整理</button>
                </div>
            </div>

            <div class="wbo-ai-step" id="wbo-ai-step-preview" hidden>
                <div class="wbo-step-scroll">
                <div class="wbo-ai-section-head">
                    <span>预览分组结果</span>
                    <button type="button" class="wbo-link-btn" id="wbo-ai-back-btn">返回重选</button>
                </div>
                <div class="wbo-radio-row" id="wbo-preview-apply-mode-row">
                    <label class="wbo-radio-opt">
                        <input type="radio" name="wbo-ai-apply-mode" value="alias" checked>
                        <span>仅改显示名</span>
                    </label>
                    <label class="wbo-radio-opt">
                        <input type="radio" name="wbo-ai-apply-mode" value="real">
                        <span>真实规范改名并同步绑定</span>
                    </label>
                </div>
                <div class="wbo-real-hint" id="wbo-ai-real-hint" hidden>
                    将按修改后的名称真实重命名世界书文件，并同步更新角色卡主/附绑定、User 人设绑定、当前聊天与全局激活。
                </div>
                <div class="wbo-preview-toolbar">
                    <div class="wbo-preview-group-pills" id="wbo-preview-group-pills"></div>
                    <div class="wbo-preview-select-tools">
                        <span class="wbo-preview-sel-count" id="wbo-preview-sel-count">已选 0/0</span>
                        <button type="button" class="wbo-link-btn" id="wbo-preview-clear-notes" hidden>清空说明</button>
                        <button type="button" class="wbo-link-btn" id="wbo-preview-toggle-all">取消全选</button>
                    </div>
                </div>
                <datalist id="wbo-preview-groups-datalist"></datalist>
                <div class="wbo-ai-preview-list" id="wbo-ai-preview-list"></div>

                <details class="wbo-collapse-box" id="wbo-preview-redo-details">
                    <summary class="wbo-collapse-summary">
                        <span class="wbo-summary-left"><i class="fa-solid fa-chevron-right wbo-details-chev"></i><span id="wbo-redo-summary">不满意部分分组？点此选组让 AI 重排</span></span>
                        <button type="button" class="wbo-link-btn" id="wbo-redo-clear-btn" hidden>清除重排</button>
                    </summary>
                    <div class="wbo-collapse-body">
                        <div class="wbo-redo-group-chips" id="wbo-redo-group-chips"></div>
                        <textarea class="wbo-textarea wbo-rule-textarea" id="wbo-ai-redo-reason" rows="2" placeholder="可选：说明不满意的原因或期望（例如：约会指南不要放进世界观，请归入「场景与互动」）"></textarea>
                        <div class="wbo-ai-actions-row">
                            <button type="button" class="wbo-btn wbo-btn-primary" id="wbo-ai-redo-run-btn" disabled>
                                <i class="fa-solid fa-rotate"></i> 重新发送给 AI
                            </button>
                            <button type="button" class="wbo-btn" id="wbo-ai-redo-copy-btn" disabled>
                                <i class="fa-regular fa-copy"></i> 复制重排提示词
                            </button>
                        </div>
                        <div class="wbo-redo-paste-box" id="wbo-redo-paste-box" hidden>
                            <textarea class="wbo-textarea" id="wbo-ai-redo-json-input" rows="3" placeholder="将外部 AI 返回的重排 JSON 粘贴到此处，仅更新已选中的重排项"></textarea>
                            <div class="wbo-ai-actions-row">
                                <button type="button" class="wbo-btn wbo-btn-primary" id="wbo-ai-redo-merge-btn">解析并合并重排结果</button>
                            </div>
                        </div>
                    </div>
                </details>

                <div class="wbo-apply-progress-box" id="wbo-apply-progress-box" hidden></div>
                <div class="wbo-ai-status" id="wbo-ai-preview-status"></div>
                </div>
                <div class="wbo-modal-footer wbo-pinned-footer wbo-footer-pair">
                    <button type="button" class="wbo-btn" id="wbo-ai-cancel-btn">取消</button>
                    <button type="button" class="wbo-btn wbo-btn-primary" id="wbo-ai-apply-btn">确认应用</button>
                </div>
            </div>
        `,
        { wide: true, pinnedLayout: true },
    );

    const statusEl = modal.querySelector('#wbo-ai-status');
    const refusalBox = modal.querySelector('#wbo-ai-refusal-box');
    const previewStatusEl = modal.querySelector('#wbo-ai-preview-status');
    const channelStatusEl = modal.querySelector('#wbo-api-channel-status');
    const stepLocal = modal.querySelector('#wbo-ai-step-local');
    const stepSelect = modal.querySelector('#wbo-ai-step-select');
    const stepApi = modal.querySelector('#wbo-ai-step-api');
    const stepPreview = modal.querySelector('#wbo-ai-step-preview');
    const localStatusEl = modal.querySelector('#wbo-local-status');
    const tabsBar = modal.querySelector('#wbo-ai-tabs');
    const previewList = modal.querySelector('#wbo-ai-preview-list');
    const customApiBox = modal.querySelector('#wbo-custom-api-box');
    const summaryTextEl = modal.querySelector('#wbo-api-summary-text');
    const tabBadgeEl = modal.querySelector('#wbo-api-tab-badge');
    const channelSelect = modal.querySelector('#wbo-channel-select');
    const nameInput = modal.querySelector('#wbo-api-name');
    const urlInput = modal.querySelector('#wbo-api-base-url');
    const keyInput = modal.querySelector('#wbo-api-key');
    const modelInput = modal.querySelector('#wbo-api-model');

    let editingChannelId = activeCh?.id || null;
    let lastOrganizeSourceTab = startTab === 'organize' ? 'organize' : 'local';

    const switchAiTab = (tabName) => {
        if (tabName === 'local' || tabName === 'organize') {
            lastOrganizeSourceTab = tabName;
        }
        if (stepLocal instanceof HTMLElement) stepLocal.hidden = tabName !== 'local';
        if (stepSelect instanceof HTMLElement) stepSelect.hidden = tabName !== 'organize';
        if (stepApi instanceof HTMLElement) stepApi.hidden = tabName !== 'api';
        if (stepPreview instanceof HTMLElement) stepPreview.hidden = true;
        // Hide the 2-way top bar while inside the dedicated API config sub-view so there's zero confusion
        if (tabsBar instanceof HTMLElement) tabsBar.hidden = tabName === 'api';
        modal.querySelectorAll('.wbo-tab').forEach((t) => {
            t.classList.toggle('is-active', t.getAttribute('data-ai-tab') === tabName);
        });
    };

    modal.querySelectorAll('.wbo-tab').forEach((btn) => {
        btn.addEventListener('click', () => {
            const tab = btn.getAttribute('data-ai-tab') || 'local';
            switchAiTab(tab);
        });
    });
    modal.querySelector('#wbo-goto-api-tab')?.addEventListener('click', () => switchAiTab('api'));
    modal.querySelector('#wbo-back-to-organize-btn')?.addEventListener('click', () => switchAiTab('organize'));
    modal.querySelectorAll('details.wbo-collapse-box').forEach((detailsEl) => {
        detailsEl.addEventListener('toggle', () => {
            if (!detailsEl.open) return;
            requestAnimationFrame(() => {
                try {
                    detailsEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                } catch {
                    detailsEl.scrollIntoView(false);
                }
            });
        });
    });

    // Interactive built-in category chips for 免 AI 整理 (persisted in settings.localOrganizeCategories)
    const localCatsEl = modal.querySelector('#wbo-local-cats');
    const syncLocalCatChips = () => {
        settings.localOrganizeCategories = LOCAL_ORGANIZE_CATEGORIES
            .filter((c) => selectedLocalCatSet.has(c.id))
            .map((c) => c.id);
        localCatsEl?.querySelectorAll('[data-local-cat]').forEach((btn) => {
            const id = btn.getAttribute('data-local-cat') || '';
            const active = selectedLocalCatSet.has(id);
            btn.classList.toggle('is-selected', active);
            btn.setAttribute('aria-pressed', active ? 'true' : 'false');
            const mark = btn.querySelector('.wbo-local-cat-mark');
            if (mark) mark.innerHTML = active ? '<i class="fa-solid fa-check"></i>' : '';
        });
        void _callbacks?.onMutation({ save: true, uiOnly: true });
    };
    localCatsEl?.addEventListener('click', (ev) => {
        const btn = ev.target instanceof Element ? ev.target.closest('[data-local-cat]') : null;
        if (!btn) return;
        const id = btn.getAttribute('data-local-cat') || '';
        if (!id) return;
        if (selectedLocalCatSet.has(id)) selectedLocalCatSet.delete(id);
        else selectedLocalCatSet.add(id);
        syncLocalCatChips();
    });
    modal.querySelector('#wbo-local-cats-default')?.addEventListener('click', () => {
        selectedLocalCatSet.clear();
        for (const id of DEFAULT_LOCAL_ORGANIZE_CATEGORY_IDS) selectedLocalCatSet.add(id);
        syncLocalCatChips();
    });
    modal.querySelector('#wbo-local-cats-all')?.addEventListener('click', () => {
        selectedLocalCatSet.clear();
        for (const c of LOCAL_ORGANIZE_CATEGORIES) selectedLocalCatSet.add(c.id);
        syncLocalCatChips();
    });
    modal.querySelector('#wbo-local-cats-none')?.addEventListener('click', () => {
        selectedLocalCatSet.clear();
        syncLocalCatChips();
    });

    // Visual 2-box custom rule builder for 免 AI 整理 (zero special symbols needed!)
    /** @type {Array<{ kw: string, group: string }>} */
    const localCustomRules = [];
    const ruleKwInput = modal.querySelector('#wbo-local-rule-kw');
    const ruleGrpInput = modal.querySelector('#wbo-local-rule-grp');
    const ruleChipsEl = modal.querySelector('#wbo-local-rule-chips');
    const ruleCountEl = modal.querySelector('#wbo-local-rules-count');

    const renderLocalRuleChips = () => {
        if (ruleCountEl) {
            ruleCountEl.textContent = localCustomRules.length > 0 ? `已添加 ${localCustomRules.length} 条` : '点击展开';
        }
        if (!ruleChipsEl) return;
        if (localCustomRules.length === 0) {
            ruleChipsEl.innerHTML = '<span class="wbo-subtle-tip">暂未添加自定义规则</span>';
            return;
        }
        ruleChipsEl.innerHTML = localCustomRules.map((r, idx) => `
            <span class="wbo-rule-chip">
                <span>含「${esc(r.kw)}」→ <b>${esc(r.group)}</b></span>
                <button type="button" class="wbo-rule-chip-del" data-del-rule-idx="${idx}" aria-label="删除">×</button>
            </span>
        `).join('');
    };
    renderLocalRuleChips();

    const addLocalRuleFromInputs = () => {
        const kw = ruleKwInput instanceof HTMLInputElement ? ruleKwInput.value.trim() : '';
        const group = ruleGrpInput instanceof HTMLInputElement ? ruleGrpInput.value.trim() : '';
        if (!kw || !group) {
            if (localStatusEl) {
                localStatusEl.textContent = '请同时填写「书名包含词」和「分组名」后再点添加';
                localStatusEl.className = 'wbo-ai-status is-error';
            }
            return;
        }
        localCustomRules.push({ kw, group });
        if (ruleKwInput instanceof HTMLInputElement) ruleKwInput.value = '';
        if (ruleGrpInput instanceof HTMLInputElement) ruleGrpInput.value = '';
        if (localStatusEl) localStatusEl.textContent = '';
        renderLocalRuleChips();
    };
    modal.querySelector('#wbo-local-rule-add-btn')?.addEventListener('click', addLocalRuleFromInputs);
    ruleGrpInput?.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
            ev.preventDefault();
            addLocalRuleFromInputs();
        }
    });
    ruleChipsEl?.addEventListener('click', (ev) => {
        const btn = ev.target instanceof Element ? ev.target.closest('[data-del-rule-idx]') : null;
        if (!btn) return;
        const idx = Number(btn.getAttribute('data-del-rule-idx'));
        if (Number.isInteger(idx) && idx >= 0 && idx < localCustomRules.length) {
            localCustomRules.splice(idx, 1);
            renderLocalRuleChips();
        }
    });

    modal.querySelector('#wbo-local-run-btn')?.addEventListener('click', () => {
        // Also pick up any rule typed in the boxes even if user forgot to click "添加"!
        const pendingKw = ruleKwInput instanceof HTMLInputElement ? ruleKwInput.value.trim() : '';
        const pendingGrp = ruleGrpInput instanceof HTMLInputElement ? ruleGrpInput.value.trim() : '';
        if (pendingKw && pendingGrp) {
            localCustomRules.push({ kw: pendingKw, group: pendingGrp });
            if (ruleKwInput instanceof HTMLInputElement) ruleKwInput.value = '';
            if (ruleGrpInput instanceof HTMLInputElement) ruleGrpInput.value = '';
            renderLocalRuleChips();
        }

        const scope = modal.querySelector('input[name="wbo-local-scope"]:checked')?.value || 'ungrouped';
        const targetBooks = scope === 'ungrouped'
            ? classification.ungroupedBooks
            : allBooks.filter((b) => !b.isInCharGroup);
        if (targetBooks.length === 0) {
            if (localStatusEl) {
                localStatusEl.textContent = '当前范围内没有需要整理的世界书，可切换为「整理全部非角色书」。';
                localStatusEl.className = 'wbo-ai-status is-error';
            }
            return;
        }
        const cleanTitles = Boolean(modal.querySelector('#wbo-local-clean-titles')?.checked);
        const useAnyBracketPrefix = Boolean(modal.querySelector('#wbo-local-any-prefix')?.checked);
        const customRulesText = localCustomRules.map((r) => `${r.kw} => ${r.group}`).join('\n');
        if (selectedLocalCatSet.size === 0 && !useAnyBracketPrefix && localCustomRules.length === 0 && !cleanTitles) {
            if (localStatusEl) {
                localStatusEl.textContent = '请至少选中一个自动归类分组，或添加自定义归类关键词。';
                localStatusEl.className = 'wbo-ai-status is-error';
            }
            return;
        }
        const proposals = buildLocalOrganizeProposals({
            books: targetBooks.map((b) => ({
                realName: b.realName,
                currentAlias: b.alias || '',
                currentGroup: b.groupName || '',
            })),
            usePrefix: true,
            useAnyBracketPrefix,
            useKeywords: true,
            cleanTitles,
            enabledCategoryIds: [...selectedLocalCatSet],
            customRulesText,
        });
        if (localStatusEl) localStatusEl.textContent = '';
        lastOrganizeSourceTab = 'local';
        showPreview(proposals, 0, { fromLocal: true });
    });

    const externalAiDrawer = modal.querySelector('#wbo-external-ai-drawer');
    const toggleExternalAiBtn = modal.querySelector('#wbo-toggle-external-ai-btn');
    const setExternalAiOpen = (open) => {
        if (externalAiDrawer instanceof HTMLElement) externalAiDrawer.hidden = !open;
        if (toggleExternalAiBtn) toggleExternalAiBtn.classList.toggle('is-active', open);
    };
    toggleExternalAiBtn?.addEventListener('click', () => {
        const isCurrentlyHidden = !(externalAiDrawer instanceof HTMLElement) || externalAiDrawer.hidden;
        setExternalAiOpen(isCurrentlyHidden);
    });
    modal.querySelector('#wbo-external-ai-hide-btn')?.addEventListener('click', () => setExternalAiOpen(false));

    // One-tap prompt preset chips: toggle mutually-exclusive group/name presets & compose multi-line rule text
    const customRuleInput = modal.querySelector('#wbo-ai-custom-rule');
    const syncPresetRuleText = () => {
        if (!(customRuleInput instanceof HTMLTextAreaElement || customRuleInput instanceof HTMLInputElement)) return;
        const activeTexts = Array.from(modal.querySelectorAll('.wbo-preset-chip.is-active'))
            .map((btn) => btn.getAttribute('data-preset-text') || '')
            .filter(Boolean);
        customRuleInput.value = activeTexts.join('\n');
    };
    modal.querySelectorAll('.wbo-preset-chip').forEach((chip) => {
        chip.addEventListener('click', () => {
            const cat = chip.getAttribute('data-preset-cat');
            const willActivate = !chip.classList.contains('is-active');
            if (cat && (cat === 'group' || cat === 'name') && willActivate) {
                modal.querySelectorAll(`.wbo-preset-chip[data-preset-cat="${cat}"]`).forEach((other) => {
                    other.classList.remove('is-active');
                });
            }
            chip.classList.toggle('is-active', willActivate);
            syncPresetRuleText();
        });
    });

    // IME-safe filter inside AI book list
    const aiBookFilter = modal.querySelector('#wbo-ai-book-filter');
    if (aiBookFilter instanceof HTMLInputElement) {
        let composing = false;
        const applyAiFilter = () => {
            const q = aiBookFilter.value.trim().toLowerCase();
            modal.querySelectorAll('#wbo-ai-book-list .wbo-ai-pick-row').forEach((row) => {
                if (!(row instanceof HTMLElement)) return;
                const hay = row.getAttribute('data-ai-search') || '';
                row.hidden = Boolean(q && !hay.includes(q));
            });
        };
        aiBookFilter.addEventListener('compositionstart', () => { composing = true; });
        aiBookFilter.addEventListener('compositionend', () => { composing = false; applyAiFilter(); });
        aiBookFilter.addEventListener('input', () => { if (!composing) applyAiFilter(); });
    }

    const setStatus = (msg, state = false, target = 'main') => {
        const el = target === 'preview' ? previewStatusEl : (target === 'channel' ? channelStatusEl : statusEl);
        if (!el) return;
        const kind = state === true ? 'error' : (state === 'error' || state === 'success' ? state : 'info');
        el.textContent = msg;
        el.className = `wbo-ai-status${kind === 'error' ? ' is-error' : (kind === 'success' ? ' is-success' : '')}`;
        if (msg && kind === 'error' && el instanceof HTMLElement) {
            try { el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch { /* ignore */ }
        }
    };

    const showRefusalAlert = (parsed) => {
        if (!(refusalBox instanceof HTMLElement)) return;
        const snippet = parsed.refusalSnippet ? `<div class="wbo-refusal-quote">AI 回复原文：${esc(parsed.refusalSnippet)}</div>` : '';
        const uncheckBtn = sensitiveSet.size > 0
            ? `<div style="margin-top:6px;"><button type="button" class="wbo-btn" id="wbo-refusal-uncheck-sens">一键取消勾选疑似敏感书</button></div>`
            : '';
        refusalBox.innerHTML = `
            <div><b>AI 拒绝了本次整理请求</b></div>
            <div style="margin-top:4px;">${esc(parsed.error)}</div>
            ${snippet}
            ${uncheckBtn}
        `;
        refusalBox.hidden = false;
        refusalBox.querySelector('#wbo-refusal-uncheck-sens')?.addEventListener('click', () => {
            modal.querySelectorAll('.wbo-ai-book-check').forEach((el) => {
                if (el instanceof HTMLInputElement && sensitiveSet.has(el.value)) {
                    el.checked = false;
                }
            });
            refusalBox.hidden = true;
            setStatus('已取消勾选疑似敏感世界书，可重新点击「开始 AI 整理」，敏感书请手动拖拽分组。');
        });
    };

    const refreshSummary = () => {
        const text = getApiSummaryText();
        if (summaryTextEl) summaryTextEl.textContent = text;
        if (tabBadgeEl) tabBadgeEl.textContent = text;
    };

    const populateChannelSelect = () => {
        if (!(channelSelect instanceof HTMLSelectElement)) return;
        if (settings.apiChannels.length === 0) {
            channelSelect.innerHTML = '<option value="">新建配置</option>';
            return;
        }
        channelSelect.innerHTML = settings.apiChannels
            .map((c) => `<option value="${esc(c.id)}"${c.id === editingChannelId ? ' selected' : ''}>${esc(c.name)}</option>`)
            .join('');
    };

    const loadChannelIntoForm = (ch) => {
        editingChannelId = ch?.id || null;
        if (nameInput instanceof HTMLInputElement) nameInput.value = ch?.name || '';
        if (urlInput instanceof HTMLInputElement) urlInput.value = ch?.baseUrl || 'https://api.openai.com/v1';
        if (keyInput instanceof HTMLInputElement) {
            keyInput.value = ch?.apiKey || '';
            keyInput.type = 'password';
        }
        if (modelInput instanceof HTMLInputElement) modelInput.value = ch?.model || '';
        populateChannelSelect();
    };

    const readFormDraft = () => ({
        name: (nameInput instanceof HTMLInputElement ? nameInput.value.trim() : '') ||
            (modelInput instanceof HTMLInputElement && modelInput.value.trim() ? modelInput.value.trim() : '自定义 API'),
        baseUrl: urlInput instanceof HTMLInputElement ? urlInput.value.trim() : '',
        apiKey: keyInput instanceof HTMLInputElement ? keyInput.value.trim() : '',
        model: modelInput instanceof HTMLInputElement ? modelInput.value.trim() : '',
    });

    populateChannelSelect();

    modal.querySelectorAll('input[name="wbo-api-provider"]').forEach((radio) => {
        radio.addEventListener('change', async () => {
            settings.apiProvider = modal.querySelector('input[name="wbo-api-provider"]:checked')?.value === 'custom' ? 'custom' : 'host';
            if (customApiBox instanceof HTMLElement) customApiBox.hidden = settings.apiProvider !== 'custom';
            refreshSummary();
            await _callbacks.onMutation({ save: true, uiOnly: true });
        });
    });

    channelSelect?.addEventListener('change', async () => {
        if (!(channelSelect instanceof HTMLSelectElement)) return;
        const found = settings.apiChannels.find((c) => c.id === channelSelect.value) || null;
        if (found) {
            settings.activeApiChannelId = found.id;
            loadChannelIntoForm(found);
            refreshSummary();
            await _callbacks.onMutation({ save: true, uiOnly: true });
        }
    });

    modal.querySelector('#wbo-ch-new-btn')?.addEventListener('click', () => {
        loadChannelIntoForm(null);
        setStatus('填写下方参数后点击「保存」创建新配置', false, 'channel');
    });

    modal.querySelector('#wbo-ch-save-btn')?.addEventListener('click', async () => {
        const draft = readFormDraft();
        if (!draft.baseUrl) {
            setStatus('请先填写 Base URL', true, 'channel');
            return;
        }
        const existing = editingChannelId ? settings.apiChannels.find((c) => c.id === editingChannelId) : null;
        if (existing) {
            Object.assign(existing, draft);
            settings.activeApiChannelId = existing.id;
        } else {
            const newCh = { id: createApiChannelId(settings.apiChannels), ...draft };
            settings.apiChannels.push(newCh);
            editingChannelId = newCh.id;
            settings.activeApiChannelId = newCh.id;
        }
        settings.apiProvider = 'custom';
        populateChannelSelect();
        refreshSummary();
        await _callbacks.onMutation({ save: true, uiOnly: true });
        setStatus(`已保存配置「${draft.name}」`, 'success', 'channel');
    });

    modal.querySelector('#wbo-ch-del-btn')?.addEventListener('click', async () => {
        if (!editingChannelId) return;
        const idx = settings.apiChannels.findIndex((c) => c.id === editingChannelId);
        if (idx < 0) return;
        const removed = settings.apiChannels.splice(idx, 1)[0];
        const next = settings.apiChannels[0] || null;
        settings.activeApiChannelId = next?.id || '';
        loadChannelIntoForm(next);
        refreshSummary();
        await _callbacks.onMutation({ save: true, uiOnly: true });
        setStatus(`已删除配置「${removed.name}」`, false, 'channel');
    });

    const formatSnapTime = (ts) => {
        if (!ts) return '';
        const dt = new Date(ts);
        return `${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')} ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
    };

    const syncUndoButtons = () => {
        const stillHas = getUndoHistoryCount() > 0;
        for (const id of ['#wbo-ai-undo-btn', '#wbo-local-undo-btn']) {
            const btn = modal.querySelector(id);
            if (btn instanceof HTMLElement) btn.hidden = !stillHas;
        }
        for (const id of ['#wbo-ai-undo-label', '#wbo-local-undo-label']) {
            const lbl = modal.querySelector(id);
            if (lbl) lbl.textContent = getUndoButtonLabel();
        }
    };

    const openUndoHistoryPicker = () => {
        const snaps = Array.isArray(settings.undoSnapshots) ? settings.undoSnapshots : [];
        const initSnap = settings.initialSnapshot || null;
        if (snaps.length === 0 && !initSnap) return;

        const stepLabel = (idx) => (idx === 0 ? '上一次整理前' : (idx === 1 ? '上上次整理前' : `${idx + 1} 次整理前`));
        const rowsHtml = [
            ...snaps.map((s, idx) => `
                <div class="wbo-undo-row">
                    <div class="wbo-undo-info">
                        <div class="wbo-undo-title">${esc(stepLabel(idx))} <span class="wbo-tag">${esc(s.label || '整理')}</span></div>
                        <div class="wbo-undo-meta">${esc(formatSnapTime(s.at))} · ${Array.isArray(s.groups) ? s.groups.length : 0} 个分组 · 涉及 ${s.count || 0} 本</div>
                    </div>
                    <button type="button" class="wbo-btn" data-restore-target="${idx}">回退到此版本</button>
                </div>
            `),
            ...(initSnap ? [`
                <div class="wbo-undo-row is-initial">
                    <div class="wbo-undo-info">
                        <div class="wbo-undo-title">最初状态 <span class="wbo-tag">首次整理前</span></div>
                        <div class="wbo-undo-meta">${esc(formatSnapTime(initSnap.at))} · ${Array.isArray(initSnap.groups) ? initSnap.groups.length : 0} 个分组</div>
                    </div>
                    <button type="button" class="wbo-btn wbo-btn-danger" data-restore-target="initial">恢复最初</button>
                </div>
            `] : []),
        ].join('');

        const { modal: histModal } = createSubModal(
            '历史版本回退',
            `
                <div class="wbo-subtle-tip">选择任一历史节点即可回退分组、显示名与备注（不改动硬盘世界书文件）。</div>
                <div class="wbo-undo-history-list">${rowsHtml}</div>
                <div class="wbo-modal-footer">
                    <button type="button" class="wbo-btn" id="wbo-undo-hist-back">返回整理</button>
                </div>
            `,
        );

        histModal.querySelectorAll('[data-restore-target]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const raw = btn.getAttribute('data-restore-target');
                const target = raw === 'initial' ? 'initial' : Number(raw);
                const desc = target === 'initial' ? '首次整理前的最初状态' : stepLabel(target);
                if (!globalThis.confirm(`确认回退到「${desc}」？`)) return;
                if (restoreOrganizeSnapshot(settings, target)) {
                    await _callbacks.onMutation({ save: true });
                    showToast('success', `已回退到${desc}`);
                    openAiOrganizeModal({ initialTab: lastOrganizeSourceTab });
                }
            });
        });
        histModal.querySelector('#wbo-undo-hist-back')?.addEventListener('click', () => {
            openAiOrganizeModal({ initialTab: lastOrganizeSourceTab });
        });
    };

    const performUndoAction = async () => {
        if (getUndoHistoryCount() > 1 || (settings.initialSnapshot && (settings.undoSnapshots?.length || 0) === 0)) {
            openUndoHistoryPicker();
            return;
        }
        if (!undoLastAiOrganize(settings)) return;
        await _callbacks.onMutation({ save: true });
        syncUndoButtons();
        setStatus('已撤销上一次整理，恢复为整理前的分组与显示名。', 'success');
        showToast('success', '已撤销上一次整理');
    };
    modal.querySelector('#wbo-ai-undo-btn')?.addEventListener('click', performUndoAction);
    modal.querySelector('#wbo-local-undo-btn')?.addEventListener('click', performUndoAction);

    modal.querySelector('#wbo-toggle-key-btn')?.addEventListener('click', (ev) => {
        if (!(keyInput instanceof HTMLInputElement)) return;
        const show = keyInput.type === 'password';
        keyInput.type = show ? 'text' : 'password';
        const icon = ev.currentTarget?.querySelector?.('i');
        if (icon) icon.className = show ? 'fa-regular fa-eye-slash' : 'fa-regular fa-eye';
    });

    modal.querySelector('#wbo-fetch-models-btn')?.addEventListener('click', async (ev) => {
        const btn = ev.currentTarget;
        if (btn instanceof HTMLButtonElement) btn.disabled = true;
        try {
            const draft = readFormDraft();
            setStatus('正在拉取模型列表...', false, 'channel');
            const models = await fetchCustomApiModels({ baseUrl: draft.baseUrl, apiKey: draft.apiKey });
            const datalist = modal.querySelector('#wbo-api-models-datalist');
            if (datalist) {
                datalist.innerHTML = models.map((m) => `<option value="${esc(m)}"></option>`).join('');
            }
            if (modelInput instanceof HTMLInputElement && !modelInput.value.trim() && models.length > 0) {
                modelInput.value = models[0];
            }
            setStatus(`已拉取 ${models.length} 个模型`, 'success', 'channel');
        } catch (err) {
            setStatus(String(err?.message || err), true, 'channel');
        } finally {
            if (btn instanceof HTMLButtonElement) btn.disabled = false;
        }
    });

    const syncRealHint = () => {
        const isReal = modal.querySelector('input[name="wbo-ai-apply-mode"]:checked')?.value === 'real';
        const hint = modal.querySelector('#wbo-ai-real-hint');
        if (hint instanceof HTMLElement) hint.hidden = !isReal;
    };

    modal.querySelectorAll('input[name="wbo-ai-apply-mode"]').forEach((radio) => {
        radio.addEventListener('change', syncRealHint);
    });

    const getSelectedBookNames = () =>
        Array.from(modal.querySelectorAll('.wbo-ai-book-check:checked')).map((el) => el.value);

    const setCheckedByPredicate = (pred) => {
        modal.querySelectorAll('.wbo-ai-book-check').forEach((el) => {
            if (el instanceof HTMLInputElement) {
                const meta = classification.byName.get(el.value);
                el.checked = Boolean(meta && pred(meta));
            }
        });
    };

    const syncSensBannerUi = () => {
        if (sensitiveSet.size === 0) return;
        const checkedSensCount = Array.from(modal.querySelectorAll('.wbo-ai-book-check:checked'))
            .filter((el) => sensitiveSet.has(el.value)).length;
        const textEl = modal.querySelector('#wbo-sens-banner-text');
        const btnEl = modal.querySelector('#wbo-pick-toggle-sens');
        const bannerEl = modal.querySelector('#wbo-sens-banner');
        if (checkedSensCount > 0) {
            if (textEl) textEl.textContent = `当前勾选了 ${checkedSensCount} 本疑似敏感世界书，审查严格模型可能拒答浪费额度`;
            if (btnEl) btnEl.textContent = '一键排除';
            bannerEl?.classList.add('is-danger');
        } else {
            if (textEl) textEl.textContent = `已排除 ${sensitiveSet.size} 本疑似敏感世界书，避免触发 AI 拒答浪费额度`;
            if (btnEl) btnEl.textContent = '包含敏感书';
            bannerEl?.classList.remove('is-danger');
        }
    };

    modal.querySelector('#wbo-ai-book-list')?.addEventListener('change', syncSensBannerUi);

    modal.querySelector('#wbo-pick-ungrouped')?.addEventListener('click', () => {
        setCheckedByPredicate((m) => m.groupId === SPECIAL_GROUPS.UNGROUPED && !sensitiveSet.has(m.realName));
        syncSensBannerUi();
    });
    modal.querySelector('#wbo-pick-nonchar')?.addEventListener('click', () => {
        setCheckedByPredicate((m) => !m.isInCharGroup && !sensitiveSet.has(m.realName));
        syncSensBannerUi();
    });
    modal.querySelector('#wbo-pick-toggle-sens')?.addEventListener('click', () => {
        const checkedSensCount = Array.from(modal.querySelectorAll('.wbo-ai-book-check:checked'))
            .filter((el) => sensitiveSet.has(el.value)).length;
        const nextChecked = checkedSensCount === 0;
        modal.querySelectorAll('.wbo-ai-book-check').forEach((el) => {
            if (el instanceof HTMLInputElement && sensitiveSet.has(el.value)) {
                el.checked = nextChecked;
            }
        });
        syncSensBannerUi();
        setStatus(nextChecked ? '已勾选疑似敏感世界书，请确认当前使用的是甲薄模型，避免触发拒答浪费额度。' : '已排除疑似敏感世界书，建议手动拖入分组。');
    });
    modal.querySelector('#wbo-pick-none')?.addEventListener('click', () => {
        setCheckedByPredicate(() => false);
        syncSensBannerUi();
    });
    syncSensBannerUi();

    /** @type {Map<string, string[]>} */
    const cachedCluesByBook = new Map();

    const buildCustomInstruction = () => {
        const allowRealRename = Boolean(modal.querySelector('#wbo-ai-allow-real-rename')?.checked);
        const customRule = modal.querySelector('#wbo-ai-custom-rule')?.value?.trim() || '';
        const filenameRule = allowRealRename
            ? '建议的新名称将直接作为规范化的世界书文件名，请勿包含 \\ / : * ? " < > | 等非法文件名字符。'
            : '';
        return [customRule, filenameRule].filter(Boolean).join(' ');
    };

    const preparePromptPayload = async ({ targetNames = null, feedback = null, statusTarget = 'main' } = {}) => {
        if (refusalBox instanceof HTMLElement) refusalBox.hidden = true;
        const selectedNames = Array.isArray(targetNames) ? targetNames : getSelectedBookNames();
        if (selectedNames.length === 0) {
            setStatus('请至少勾选一本世界书', true, statusTarget);
            return null;
        }
        const includeClues = Boolean(modal.querySelector('#wbo-ai-include-clues')?.checked);
        const clueCountRaw = Number(modal.querySelector('#wbo-ai-clue-count')?.value || 5);
        const clueCount = Math.max(1, Math.min(15, Number.isFinite(clueCountRaw) ? Math.round(clueCountRaw) : 5));
        const snippetLenRaw = Number(modal.querySelector('#wbo-ai-snippet-len')?.value ?? 50);
        const snippetChars = Number.isFinite(snippetLenRaw) ? Math.max(0, Math.min(200, snippetLenRaw)) : 50;

        const clueStats = { skippedEntries: 0 };
        const booksPayload = [];
        for (let i = 0; i < selectedNames.length; i += 1) {
            const name = selectedNames[i];
            const meta = classification.byName.get(name);
            let sampleEntries = [];
            if (includeClues) {
                if (feedback && cachedCluesByBook.has(name)) {
                    sampleEntries = cachedCluesByBook.get(name) || [];
                } else {
                    setStatus(`读取条目摘要 (${i + 1}/${selectedNames.length})...`, false, statusTarget);
                    sampleEntries = await fetchWorldbookCluesOnDemand(name, clueCount, {
                        snippetChars,
                        filterSensitive: true,
                        statsOut: clueStats,
                    });
                    cachedCluesByBook.set(name, sampleEntries);
                }
            }
            booksPayload.push({
                realName: name,
                currentAlias: meta?.alias || '',
                currentGroup: meta?.groupName || '',
                sampleEntries,
            });
        }

        if (clueStats.skippedEntries > 0) {
            setStatus(`已自动过滤 ${clueStats.skippedEntries} 条疑似含敏感词的条目摘要，正在准备请求...`, false, statusTarget);
        }

        return buildAiOrganizePrompt({
            books: booksPayload,
            existingGroups: settings.groups.map((g) => g.name),
            customInstruction: buildCustomInstruction(),
            feedback,
        });
    };

    /** @type {Array<{ realName: string, alias: string, group: string, note: string, selected: boolean, redo: boolean, editing: boolean }>} */
    let currentProposals = [];
    let activePreviewGroupFilter = '__all__';
    let previewFromLocal = false;

    const previewPillsEl = modal.querySelector('#wbo-preview-group-pills');
    const previewSelCountEl = modal.querySelector('#wbo-preview-sel-count');
    const previewGroupsDatalist = modal.querySelector('#wbo-preview-groups-datalist');
    const previewApplyModeRow = modal.querySelector('#wbo-preview-apply-mode-row');
    const previewRedoDetails = modal.querySelector('#wbo-preview-redo-details');
    const redoSummaryEl = modal.querySelector('#wbo-redo-summary');
    const redoChipsEl = modal.querySelector('#wbo-redo-group-chips');
    const redoClearBtn = modal.querySelector('#wbo-redo-clear-btn');
    const redoRunBtn = modal.querySelector('#wbo-ai-redo-run-btn');
    const redoCopyBtn = modal.querySelector('#wbo-ai-redo-copy-btn');
    const redoPasteBox = modal.querySelector('#wbo-redo-paste-box');
    const redoReasonInput = modal.querySelector('#wbo-ai-redo-reason');

    const getOrderedPreviewGroups = () => {
        /** @type {Map<string, Array<{ item: any, idx: number }>>} */
        const map = new Map();
        currentProposals.forEach((item, idx) => {
            const gname = (item.group || '').trim() || '未分组';
            if (!map.has(gname)) map.set(gname, []);
            map.get(gname).push({ item, idx });
        });
        return map;
    };

    const syncRedoBarUi = () => {
        if (previewRedoDetails instanceof HTMLElement) {
            previewRedoDetails.hidden = previewFromLocal;
        }
        if (previewFromLocal) return;
        const grouped = getOrderedPreviewGroups();
        const redoItems = currentProposals.filter((p) => p.redo);
        const count = redoItems.length;
        if (redoSummaryEl) {
            redoSummaryEl.textContent = count > 0
                ? `已选 ${count} 本待 AI 重新分组`
                : '不满意部分分组？点此选组让 AI 重排';
        }
        if (redoChipsEl) {
            redoChipsEl.innerHTML = [...grouped.entries()].map(([gname, entries]) => {
                const selectedInGroup = entries.filter((e) => e.item.redo).length;
                const isAll = selectedInGroup === entries.length && entries.length > 0;
                const isPartial = selectedInGroup > 0 && selectedInGroup < entries.length;
                const countLabel = isPartial ? `${selectedInGroup}/${entries.length}` : `${entries.length}`;
                return `
                    <button type="button"
                        class="wbo-redo-chip${isAll ? ' is-active' : (isPartial ? ' is-partial' : '')}"
                        data-redo-group-chip="${esc(gname)}">
                        <span>${esc(gname)}</span><small>${esc(countLabel)}</small>
                    </button>
                `;
            }).join('');
        }
        if (redoClearBtn instanceof HTMLElement) redoClearBtn.hidden = count === 0;
        if (redoRunBtn instanceof HTMLButtonElement) redoRunBtn.disabled = count === 0;
        if (redoCopyBtn instanceof HTMLButtonElement) redoCopyBtn.disabled = count === 0;
    };

    const syncPreviewSelectCount = () => {
        const selectedCount = currentProposals.filter((p) => p.selected).length;
        if (previewSelCountEl) {
            previewSelCountEl.textContent = `已选 ${selectedCount}/${currentProposals.length}`;
        }
        const toggleBtn = modal.querySelector('#wbo-preview-toggle-all');
        if (toggleBtn) {
            const allSelected = currentProposals.length > 0 && selectedCount === currentProposals.length;
            toggleBtn.textContent = allSelected ? '取消全选' : '全选全部';
        }
        const clearNotesBtn = modal.querySelector('#wbo-preview-clear-notes');
        if (clearNotesBtn instanceof HTMLElement) {
            clearNotesBtn.hidden = !currentProposals.some((p) => (p.note || '').trim().length > 0);
        }
    };

    const renderPreviewContent = () => {
        if (!previewList) return;
        const grouped = getOrderedPreviewGroups();
        const groupNames = [...grouped.keys()];
        const allGroupChoices = [...new Set([...groupNames, ...settings.groups.map((g) => g.name), '未分组'])];

        if (activePreviewGroupFilter !== '__all__' && !grouped.has(activePreviewGroupFilter)) {
            activePreviewGroupFilter = '__all__';
        }

        if (previewGroupsDatalist) {
            previewGroupsDatalist.innerHTML = allGroupChoices.map((g) => `<option value="${esc(g)}"></option>`).join('');
        }

        if (previewPillsEl) {
            const pills = [
                { key: '__all__', label: `全部 ${currentProposals.length}` },
                ...groupNames.map((g) => ({ key: g, label: `${g} ${grouped.get(g).length}` })),
            ];
            previewPillsEl.innerHTML = pills
                .map((p) => `
                    <button type="button"
                        class="wbo-pill${activePreviewGroupFilter === p.key ? ' is-active' : ''}"
                        data-preview-filter="${esc(p.key)}">
                        <span>${esc(p.label)}</span>
                    </button>
                `)
                .join('');
        }

        const sectionsToRender = activePreviewGroupFilter === '__all__'
            ? groupNames
            : [activePreviewGroupFilter];

        const prevScroll = previewList.scrollTop;
        previewList.innerHTML = sectionsToRender.map((gname) => {
            const entries = grouped.get(gname) || [];
            const selInGroup = entries.filter((e) => e.item.selected).length;
            const allSel = entries.length > 0 && selInGroup === entries.length;
            const rowsHtml = entries.map(({ item, idx }) => {
                const curGroup = (item.group || '').trim() || '未分组';
                const renamed = Boolean(item.alias && item.alias !== item.realName);
                const titleHtml = renamed
                    ? `<span class="wbo-prop-name-new">${esc(item.alias)}</span><span class="wbo-prop-name-old" title="${esc(item.realName)}">${esc(item.realName)}</span>`
                    : `<span class="wbo-prop-name-new" title="${esc(item.realName)}">${esc(item.realName)}</span>`;
                const noteHint = item.note ? `<div class="wbo-prop-note-sub">${esc(item.note)}</div>` : '';
                const groupOptsHtml = allGroupChoices
                    .map((gc) => `<option value="${esc(gc)}"${gc === curGroup ? ' selected' : ''}>${esc(gc)}</option>`)
                    .join('') + '<option value="__new__">+ 新建分组...</option>';

                const editBlockHtml = item.editing
                    ? `
                        <div class="wbo-prop-edit-drawer">
                            <label class="wbo-prop-field">
                                <span class="wbo-prop-label">新名称</span>
                                <input type="text" class="wbo-input wbo-prop-alias" value="${esc(item.alias)}" placeholder="规范后的显示名">
                            </label>
                            <label class="wbo-prop-field">
                                <span class="wbo-prop-label">说明</span>
                                <input type="text" class="wbo-input wbo-prop-note" value="${esc(item.note)}" placeholder="可选：一句话用途说明">
                            </label>
                        </div>
                    `
                    : '';

                return `
                    <div class="wbo-ai-prop-row is-compact${item.redo ? ' is-redo' : ''}" data-idx="${idx}">
                        <div class="wbo-prop-compact-line">
                            <label class="wbo-ai-prop-check" title="勾选以应用此项">
                                <input type="checkbox" class="wbo-prop-selected"${item.selected ? ' checked' : ''}>
                            </label>
                            <div class="wbo-prop-compact-text">
                                <div class="wbo-prop-compact-title">${titleHtml}</div>
                                ${noteHint}
                            </div>
                            <select class="wbo-select wbo-prop-group-select" title="快速更换分组">${groupOptsHtml}</select>
                            <button type="button" class="wbo-icon-btn wbo-prop-edit-btn${item.editing ? ' is-active' : ''}" data-action="toggle-edit-item" data-idx="${idx}" title="微调名称或说明">
                                <i class="fa-solid fa-pen"></i>
                            </button>
                        </div>
                        ${editBlockHtml}
                    </div>
                `;
            }).join('');

            const mergeTargetOpts = allGroupChoices
                .filter((gc) => gc !== gname)
                .map((gc) => `<option value="${esc(gc)}">${esc(gc)}</option>`)
                .join('') + '<option value="__new__">+ 新建分组...</option>';

            return `
                <div class="wbo-preview-group-sec" data-preview-group="${esc(gname)}">
                    <div class="wbo-preview-group-head">
                        <label class="wbo-preview-group-select-label" title="全选或取消本组">
                            <input type="checkbox" class="wbo-preview-group-check" data-group-name="${esc(gname)}"${allSel ? ' checked' : ''}>
                            <span class="wbo-preview-group-title">${esc(gname)} <small>${selInGroup}/${entries.length}</small></span>
                        </label>
                        <div class="wbo-preview-group-actions">
                            ${gname !== '未分组' ? `<button type="button" class="wbo-link-btn" data-action="rename-preview-group" data-group-name="${esc(gname)}" title="重命名此分组">改组名</button>` : ''}
                            <select class="wbo-select wbo-preview-merge-select" data-merge-from="${esc(gname)}" title="将本组全部世界书归入另一个分组">
                                <option value="" selected>整组归入...</option>
                                ${mergeTargetOpts}
                            </select>
                        </div>
                    </div>
                    <div class="wbo-preview-group-body">${rowsHtml}</div>
                </div>
            `;
        }).join('');

        previewList.querySelectorAll('.wbo-preview-group-check').forEach((cb) => {
            if (!(cb instanceof HTMLInputElement)) return;
            const gname = cb.getAttribute('data-group-name') || '';
            const entries = grouped.get(gname) || [];
            const selInGroup = entries.filter((e) => e.item.selected).length;
            cb.indeterminate = selInGroup > 0 && selInGroup < entries.length;
        });

        previewList.scrollTop = prevScroll;
        syncPreviewSelectCount();
        syncRedoBarUi();
    };

    const showPreview = (proposals, ignoredCount, { fromLocal = false } = {}) => {
        previewFromLocal = Boolean(fromLocal);
        currentProposals = proposals.map((p) => ({
            ...p,
            selected: true,
            redo: false,
            editing: false,
        }));
        activePreviewGroupFilter = '__all__';
        if (!previewList || !(stepSelect instanceof HTMLElement) || !(stepPreview instanceof HTMLElement)) return;
        if (redoPasteBox instanceof HTMLElement) redoPasteBox.hidden = true;
        if (previewRedoDetails instanceof HTMLDetailsElement) previewRedoDetails.open = false;

        // Hide rename-mode radios for pure local grouping when no names changed
        const hasAnyRename = currentProposals.some((p) => p.alias && p.alias !== p.realName);
        if (previewApplyModeRow instanceof HTMLElement) {
            previewApplyModeRow.hidden = previewFromLocal && !hasAnyRename;
        }

        const allowReal = !previewFromLocal && Boolean(modal.querySelector('#wbo-ai-allow-real-rename')?.checked);
        const targetRadio = modal.querySelector(`input[name="wbo-ai-apply-mode"][value="${allowReal ? 'real' : 'alias'}"]`);
        if (targetRadio instanceof HTMLInputElement) targetRadio.checked = true;
        syncRealHint();

        renderPreviewContent();

        if (stepLocal instanceof HTMLElement) stepLocal.hidden = true;
        stepSelect.hidden = true;
        if (stepApi instanceof HTMLElement) stepApi.hidden = true;
        if (tabsBar instanceof HTMLElement) tabsBar.hidden = true;
        stepPreview.hidden = false;
        const groupCount = getOrderedPreviewGroups().size;
        setStatus(
            `解析完成：共 ${proposals.length} 本世界书，分为 ${groupCount} 组${ignoredCount > 0 ? `（忽略 ${ignoredCount} 项无效条目）` : ''}`,
            'success',
            'preview',
        );
    };

    // Delegate preview group filter pill clicks
    previewPillsEl?.addEventListener('click', (ev) => {
        const btn = ev.target instanceof Element ? ev.target.closest('[data-preview-filter]') : null;
        if (!btn) return;
        activePreviewGroupFilter = btn.getAttribute('data-preview-filter') || '__all__';
        renderPreviewContent();
    });

    // Sync live edits & redo marks directly onto `currentProposals` so switching group tabs never loses changes
    previewList?.addEventListener('input', (ev) => {
        const target = ev.target;
        if (!(target instanceof HTMLInputElement)) return;
        const row = target.closest('.wbo-ai-prop-row[data-idx]');
        if (!row) return;
        const idx = Number(row.getAttribute('data-idx'));
        const item = currentProposals[idx];
        if (!item) return;
        if (target.classList.contains('wbo-prop-alias')) item.alias = target.value;
        else if (target.classList.contains('wbo-prop-group')) item.group = target.value;
        else if (target.classList.contains('wbo-prop-note')) item.note = target.value;
    });

    // Preview single smart select-all / clear-all toggle
    modal.querySelector('#wbo-preview-toggle-all')?.addEventListener('click', () => {
        const allSelected = currentProposals.length > 0 && currentProposals.every((p) => p.selected);
        currentProposals.forEach((p) => { p.selected = !allSelected; });
        renderPreviewContent();
    });
    modal.querySelector('#wbo-preview-clear-notes')?.addEventListener('click', () => {
        currentProposals.forEach((p) => { p.note = ''; });
        renderPreviewContent();
    });

    // Direct 1-click group redo chips inside the bottom feedback card
    redoChipsEl?.addEventListener('click', (ev) => {
        const chip = ev.target instanceof Element ? ev.target.closest('[data-redo-group-chip]') : null;
        if (!chip) return;
        const gname = chip.getAttribute('data-redo-group-chip') || '';
        const matching = currentProposals.filter((p) => ((p.group || '').trim() || '未分组') === gname);
        if (matching.length === 0) return;
        const nextState = !matching.every((p) => p.redo);
        matching.forEach((p) => { p.redo = nextState; });
        renderPreviewContent();
    });

    previewList?.addEventListener('change', (ev) => {
        const target = ev.target;
        if (target instanceof HTMLSelectElement && target.classList.contains('wbo-preview-merge-select')) {
            const fromGroup = target.getAttribute('data-merge-from') || '';
            let destGroup = target.value;
            if (!fromGroup || !destGroup) return;
            if (destGroup === '__new__') {
                const customName = globalThis.prompt(`将「${fromGroup}」整组归入新分组，输入新分组名：`)?.trim();
                if (!customName) {
                    target.value = '';
                    return;
                }
                destGroup = customName;
            }
            let moved = 0;
            currentProposals.forEach((p) => {
                if (((p.group || '').trim() || '未分组') === fromGroup) {
                    p.group = destGroup;
                    moved += 1;
                }
            });
            if (activePreviewGroupFilter === fromGroup) {
                activePreviewGroupFilter = destGroup;
            }
            renderPreviewContent();
            setStatus(`已将「${fromGroup}」的 ${moved} 本世界书全部归入「${destGroup}」`, 'success', 'preview');
            return;
        }
        if (target instanceof HTMLSelectElement && target.classList.contains('wbo-prop-group-select')) {
            const row = target.closest('.wbo-ai-prop-row[data-idx]');
            if (!row) return;
            const idx = Number(row.getAttribute('data-idx'));
            const item = currentProposals[idx];
            if (!item) return;
            if (target.value === '__new__') {
                const customName = globalThis.prompt('输入新分组名称：')?.trim();
                if (customName) item.group = customName;
            } else {
                item.group = target.value;
            }
            renderPreviewContent();
            return;
        }
        if (!(target instanceof HTMLInputElement)) return;
        if (target.classList.contains('wbo-preview-group-check')) {
            const gname = target.getAttribute('data-group-name') || '';
            const nextChecked = target.checked;
            currentProposals.forEach((p) => {
                if (((p.group || '').trim() || '未分组') === gname) {
                    p.selected = nextChecked;
                }
            });
            renderPreviewContent();
            return;
        }
        const row = target.closest('.wbo-ai-prop-row[data-idx]');
        if (!row) return;
        const idx = Number(row.getAttribute('data-idx'));
        const item = currentProposals[idx];
        if (!item) return;
        if (target.classList.contains('wbo-prop-selected')) {
            item.selected = target.checked;
            renderPreviewContent();
        } else if (target.classList.contains('wbo-prop-group')) {
            item.group = target.value.trim();
            renderPreviewContent();
        }
    });

    previewList?.addEventListener('click', (ev) => {
        const btn = ev.target instanceof Element ? ev.target.closest('[data-action]') : null;
        if (!btn) return;
        const action = btn.getAttribute('data-action');
        if (action === 'rename-preview-group') {
            const oldName = btn.getAttribute('data-group-name') || '';
            if (!oldName) return;
            const nextName = globalThis.prompt(`修改分组「${oldName}」的名称：`, oldName)?.trim();
            if (!nextName || nextName === oldName) return;
            let changed = 0;
            currentProposals.forEach((p) => {
                if (((p.group || '').trim() || '未分组') === oldName) {
                    p.group = nextName;
                    changed += 1;
                }
            });
            if (activePreviewGroupFilter === oldName) {
                activePreviewGroupFilter = nextName;
            }
            renderPreviewContent();
            setStatus(`已将分组「${oldName}」改名为「${nextName}」（共 ${changed} 本）`, 'success', 'preview');
        } else if (action === 'toggle-edit-item') {
            const idx = Number(btn.getAttribute('data-idx'));
            if (currentProposals[idx]) {
                currentProposals[idx].editing = !currentProposals[idx].editing;
                renderPreviewContent();
            }
        } else if (action === 'toggle-redo-item') {
            const idx = Number(btn.getAttribute('data-idx'));
            if (currentProposals[idx]) {
                currentProposals[idx].redo = !currentProposals[idx].redo;
                renderPreviewContent();
            }
        } else if (action === 'toggle-redo-group') {
            const gname = btn.getAttribute('data-group-name') || '';
            const matching = currentProposals.filter((p) => ((p.group || '').trim() || '未分组') === gname);
            const nextState = !matching.every((p) => p.redo);
            matching.forEach((p) => { p.redo = nextState; });
            renderPreviewContent();
        }
    });

    redoClearBtn?.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        currentProposals.forEach((p) => { p.redo = false; });
        renderPreviewContent();
    });

    const mergeRedoResponseIntoPreview = (rawText) => {
        const redoItems = currentProposals.filter((p) => p.redo);
        const validRedoNames = new Set(redoItems.map((p) => p.realName));
        const parsed = parseAiOrganizeResponse(rawText, validRedoNames.size > 0 ? validRedoNames : new Set(classification.byName.keys()));
        if (!parsed.ok) {
            setStatus(parsed.error || '重排结果解析失败', true, 'preview');
            return false;
        }
        const byName = new Map(currentProposals.map((p) => [p.realName, p]));
        let updatedCount = 0;
        for (const nextItem of parsed.proposals) {
            const target = byName.get(nextItem.realName);
            if (!target) continue;
            if (nextItem.alias) target.alias = nextItem.alias;
            if (nextItem.group) target.group = nextItem.group;
            if (nextItem.note) target.note = nextItem.note;
            target.redo = false;
            updatedCount += 1;
        }
        if (redoPasteBox instanceof HTMLElement) redoPasteBox.hidden = true;
        renderPreviewContent();
        setStatus(`已根据反馈更新 ${updatedCount} 本世界书的分组与名称`, false, 'preview');
        showToast('success', `已更新 ${updatedCount} 本世界书的分组建议`);
        return true;
    };

    const prepareRedoPromptPayload = async () => {
        const redoItems = currentProposals.filter((p) => p.redo);
        if (redoItems.length === 0) {
            setStatus('请先标记至少一本需要重新分组的世界书', true, 'preview');
            return null;
        }
        const acceptedGroups = [...new Set(
            currentProposals
                .filter((p) => !p.redo)
                .map((p) => (p.group || '').trim())
                .filter((g) => g && g !== '未分组'),
        )];
        const reason = (redoReasonInput instanceof HTMLTextAreaElement || redoReasonInput instanceof HTMLInputElement)
            ? redoReasonInput.value.trim()
            : '';
        return preparePromptPayload({
            targetNames: redoItems.map((p) => p.realName),
            feedback: {
                reason,
                previousProposals: redoItems.map((p) => ({
                    realName: p.realName,
                    alias: p.alias,
                    group: p.group,
                    note: p.note,
                })),
                acceptedGroups,
            },
            statusTarget: 'preview',
        });
    };

    redoRunBtn?.addEventListener('click', async () => {
        if (redoRunBtn instanceof HTMLButtonElement) redoRunBtn.disabled = true;
        try {
            const prompts = await prepareRedoPromptPayload();
            if (!prompts) return;
            if (settings.apiProvider === 'custom') {
                const draft = readFormDraft();
                setStatus('正在将不满意项重新发送给自定义 API...', false, 'preview');
                const raw = await callCustomApiForOrganize({
                    baseUrl: draft.baseUrl,
                    apiKey: draft.apiKey,
                    model: draft.model,
                    systemPrompt: prompts.systemPrompt,
                    userPrompt: prompts.userPrompt,
                });
                mergeRedoResponseIntoPreview(raw);
            } else {
                setStatus('正在将不满意项重新发送给酒馆当前 API...', false, 'preview');
                const raw = await callHostAiForOrganize(prompts);
                mergeRedoResponseIntoPreview(raw);
            }
        } catch (err) {
            setStatus(`重排调用失败：${err?.message || err}`, true, 'preview');
        } finally {
            syncRedoBarUi();
        }
    });

    redoCopyBtn?.addEventListener('click', async () => {
        const prompts = await prepareRedoPromptPayload();
        if (!prompts) return;
        const fullPrompt = `${prompts.systemPrompt}\n\n---\n\n${prompts.userPrompt}`;
        if (redoPasteBox instanceof HTMLElement) redoPasteBox.hidden = false;
        try {
            await navigator.clipboard.writeText(fullPrompt);
            setStatus('已复制重排提示词，请将外部 AI 返回的 JSON 粘贴到下方合并。', false, 'preview');
        } catch {
            const ta = modal.querySelector('#wbo-ai-redo-json-input');
            if (ta instanceof HTMLTextAreaElement) {
                ta.value = fullPrompt;
                ta.select();
            }
            setStatus('剪贴板受限，已将重排提示词填入下方文本框。', false, 'preview');
        }
    });

    modal.querySelector('#wbo-ai-redo-merge-btn')?.addEventListener('click', () => {
        const ta = modal.querySelector('#wbo-ai-redo-json-input');
        const raw = ta instanceof HTMLTextAreaElement ? ta.value : '';
        if (mergeRedoResponseIntoPreview(raw) && ta instanceof HTMLTextAreaElement) {
            ta.value = '';
        }
    });

    const parseAndOpenPreview = (rawText) => {
        const validSet = new Set(classification.byName.keys());
        const parsed = parseAiOrganizeResponse(rawText, validSet);
        if (!parsed.ok) {
            if (parsed.isRefusal) {
                showRefusalAlert(parsed);
                setStatus('');
            } else {
                if (refusalBox instanceof HTMLElement) refusalBox.hidden = true;
                setStatus(parsed.error || '解析失败', true);
            }
            return;
        }
        if (refusalBox instanceof HTMLElement) refusalBox.hidden = true;
        setStatus('');
        showPreview(parsed.proposals, parsed.ignoredCount);
    };

    modal.querySelector('#wbo-ai-run-btn')?.addEventListener('click', async (ev) => {
        const btn = ev.currentTarget;
        if (btn instanceof HTMLButtonElement) btn.disabled = true;
        try {
            const prompts = await preparePromptPayload();
            if (!prompts) return;
            if (settings.apiProvider === 'custom') {
                const draft = readFormDraft();
                setStatus('正在调用自定义 API...');
                const raw = await callCustomApiForOrganize({
                    baseUrl: draft.baseUrl,
                    apiKey: draft.apiKey,
                    model: draft.model,
                    systemPrompt: prompts.systemPrompt,
                    userPrompt: prompts.userPrompt,
                });
                parseAndOpenPreview(raw);
            } else {
                setStatus('正在调用酒馆当前 API...');
                const raw = await callHostAiForOrganize(prompts);
                parseAndOpenPreview(raw);
            }
        } catch (err) {
            const msg = `调用失败：${err?.message || err}`;
            setStatus(msg, 'error');
            showToast('error', msg);
        } finally {
            if (btn instanceof HTMLButtonElement) btn.disabled = false;
        }
    });

    modal.querySelector('#wbo-ai-copy-prompt-btn')?.addEventListener('click', async () => {
        const prompts = await preparePromptPayload();
        if (!prompts) return;
        const fullPrompt = `${prompts.systemPrompt}\n\n---\n\n${prompts.userPrompt}`;
        try {
            await navigator.clipboard.writeText(fullPrompt);
            setStatus('已复制提示词，可将外部 AI 返回的 JSON 粘贴到上方输入框后点「解析并预览」。');
        } catch {
            setExternalAiOpen(true);
            const textarea = modal.querySelector('#wbo-ai-json-input');
            if (textarea instanceof HTMLTextAreaElement) {
                textarea.value = fullPrompt;
                textarea.select();
            }
            setStatus('剪贴板受限，已将提示词填入输入框。');
        }
    });

    modal.querySelector('#wbo-ai-parse-paste-btn')?.addEventListener('click', () => {
        const raw = modal.querySelector('#wbo-ai-json-input')?.value || '';
        parseAndOpenPreview(raw);
    });

    modal.querySelector('#wbo-ai-back-btn')?.addEventListener('click', () => {
        switchAiTab(lastOrganizeSourceTab);
    });

    modal.querySelector('#wbo-ai-cancel-btn')?.addEventListener('click', closeSubModal);

    const applyProgressBox = modal.querySelector('#wbo-apply-progress-box');
    const applyCancelBtn = modal.querySelector('#wbo-ai-cancel-btn');

    const rollbackRealRenames = async (completedRenames, preSnapshot) => {
        if (applyProgressBox instanceof HTMLElement) {
            applyProgressBox.hidden = false;
            applyProgressBox.innerHTML = `<div class="wbo-progress-head"><span>正在撤回已修改的 ${completedRenames.length} 本世界书，请稍候...</span></div>`;
        }
        const liveNames = new Set(getWorldNames());
        let rolledBack = 0;
        const rollbackErrors = [];
        for (let i = completedRenames.length - 1; i >= 0; i -= 1) {
            const pair = completedRenames[i];
            const res = await realRenameWorldbook(pair.newName, pair.oldName, settings, {
                deferRefresh: true,
                existingNamesSet: liveNames,
            });
            if (res.ok) rolledBack += 1;
            else rollbackErrors.push(`${pair.newName} → ${pair.oldName}：${res.error || '未知错误'}`);
        }
        // Restore pre-apply settings metadata cleanly
        if (preSnapshot) {
            settings.groups = deepClone(preSnapshot.groups);
            settings.assignments = deepClone(preSnapshot.assignments);
            settings.aliases = deepClone(preSnapshot.aliases);
            settings.notes = deepClone(preSnapshot.notes);
            settings.charBookOverrides = deepClone(preSnapshot.charBookOverrides);
            settings.cachedCharBindings = deepClone(preSnapshot.cachedCharBindings);
            settings.sectionOrder = deepClone(preSnapshot.sectionOrder);
            settings.undoSnapshots = deepClone(preSnapshot.undoSnapshots);
        }
        await flushWorldInfoListRefresh();
        await _callbacks.onRescan();
        return { rolledBack, rollbackErrors };
    };

    modal.querySelector('#wbo-ai-apply-btn')?.addEventListener('click', async (ev) => {
        const applyBtn = ev.currentTarget;
        const applyMode = modal.querySelector('input[name="wbo-ai-apply-mode"]:checked')?.value || 'alias';
        // Read directly from live `currentProposals` so items currently filtered out by a preview group pill are STILL applied!
        const chosen = currentProposals
            .filter((p) => p.selected)
            .map((p) => ({
                realName: p.realName,
                alias: (p.alias || '').trim(),
                group: (p.group || '').trim(),
                note: (p.note || '').trim(),
            }));

        if (chosen.length === 0) {
            showToast('warning', '请至少勾选一项');
            return;
        }

        if (applyMode === 'real') {
            if (!globalThis.confirm(`确定对选中的 ${chosen.length} 本世界书执行真实规范改名并同步绑定吗？\n执行过程中随时可点「取消并撤回」。`)) {
                return;
            }
            if (applyBtn instanceof HTMLButtonElement) applyBtn.disabled = true;
            if (applyCancelBtn instanceof HTMLButtonElement) applyCancelBtn.disabled = true;

            const preSnapshot = {
                groups: deepClone(settings.groups || []),
                assignments: deepClone(settings.assignments || {}),
                aliases: deepClone(settings.aliases || {}),
                notes: deepClone(settings.notes || {}),
                charBookOverrides: deepClone(settings.charBookOverrides || {}),
                cachedCharBindings: deepClone(settings.cachedCharBindings || {}),
                sectionOrder: deepClone(settings.sectionOrder || []),
                undoSnapshots: deepClone(settings.undoSnapshots || []),
            };

            let cancelled = false;
            const liveNamesSet = new Set(getWorldNames());
            /** @type {Array<{ oldName: string, newName: string }>} */
            const completedRenames = [];
            /** @type {Array<{ oldName: string, newName: string, error: string }>} */
            const failedItems = [];
            const adjustedProposals = [];

            const renderRunningProgress = (idx, label) => {
                if (!(applyProgressBox instanceof HTMLElement)) return;
                const pct = Math.round(((idx) / Math.max(1, chosen.length)) * 100);
                applyProgressBox.hidden = false;
                applyProgressBox.innerHTML = `
                    <div class="wbo-progress-head">
                        <span>正在规范改名 (${idx}/${chosen.length})：${esc(label)}</span>
                        <button type="button" class="wbo-btn wbo-btn-danger wbo-progress-cancel-btn" id="wbo-apply-abort-btn">取消并撤回</button>
                    </div>
                    <div class="wbo-progress-track"><div class="wbo-progress-fill" style="width:${pct}%"></div></div>
                `;
                applyProgressBox.querySelector('#wbo-apply-abort-btn')?.addEventListener('click', (e) => {
                    cancelled = true;
                    const b = e.currentTarget;
                    if (b instanceof HTMLButtonElement) {
                        b.disabled = true;
                        b.textContent = '正在取消并撤回...';
                    }
                });
            };

            setStatus('', false, 'preview');

            for (let i = 0; i < chosen.length; i += 1) {
                if (cancelled) break;
                const item = chosen[i];
                let finalRealName = item.realName;
                if (item.alias && item.alias !== item.realName) {
                    renderRunningProgress(i + 1, `${item.realName} → ${item.alias}`);
                    const res = await realRenameWorldbook(item.realName, item.alias, settings, {
                        deferRefresh: true,
                        existingNamesSet: liveNamesSet,
                    });
                    if (res.ok) {
                        finalRealName = item.alias;
                        completedRenames.push({ oldName: item.realName, newName: item.alias });
                    } else {
                        failedItems.push({
                            oldName: item.realName,
                            newName: item.alias,
                            error: res.error || '未知错误',
                        });
                    }
                }
                adjustedProposals.push({
                    realName: finalRealName,
                    alias: '',
                    group: item.group,
                    note: item.note,
                    applyAlias: false,
                });
            }

            if (cancelled) {
                const { rolledBack, rollbackErrors } = await rollbackRealRenames(completedRenames, preSnapshot);
                if (applyBtn instanceof HTMLButtonElement) applyBtn.disabled = false;
                if (applyCancelBtn instanceof HTMLButtonElement) applyCancelBtn.disabled = false;
                if (applyProgressBox instanceof HTMLElement) {
                    applyProgressBox.innerHTML = rollbackErrors.length > 0
                        ? `<div class="wbo-refusal-box"><b>已取消，但有 ${rollbackErrors.length} 项撤回失败：</b><br>${rollbackErrors.map((e) => esc(e)).join('<br>')}</div>`
                        : `<div class="wbo-progress-done">已取消并撤回全部 ${rolledBack} 本已修改的世界书，文件与绑定已恢复原状。</div>`;
                }
                showToast('info', `已取消并撤回 ${rolledBack} 本世界书`);
                return;
            }

            // Commit groups/notes & flush host world list ONCE for the whole batch!
            applyAiOrganizeProposals(settings, adjustedProposals, { label: previewFromLocal ? '免 AI 整理' : 'AI 整理' });
            await flushWorldInfoListRefresh();
            await _callbacks.onRescan();

            if (failedItems.length === 0) {
                closeSubModal();
                showToast('success', `真实改名完成：成功 ${completedRenames.length} 本`);
                return;
            }

            // Keep modal open on partial/full failure so user sees EVERY exact error and can fix or roll back!
            if (applyBtn instanceof HTMLButtonElement) applyBtn.disabled = false;
            if (applyCancelBtn instanceof HTMLButtonElement) applyCancelBtn.disabled = false;

            const failedNameSet = new Set(failedItems.map((f) => f.oldName));
            currentProposals.forEach((p) => {
                p.selected = failedNameSet.has(p.realName);
            });
            renderPreviewContent();

            if (applyProgressBox instanceof HTMLElement) {
                applyProgressBox.hidden = false;
                applyProgressBox.innerHTML = `
                    <div class="wbo-refusal-box">
                        <div><b>改名完成：成功 ${completedRenames.length} 本，失败 ${failedItems.length} 本</b>（已自动勾选失败项，可直接修改新名称后重试）</div>
                        <ul class="wbo-fail-list">
                            ${failedItems.map((f) => `<li><b>${esc(f.oldName)}</b> → ${esc(f.newName)}：${esc(f.error)}</li>`).join('')}
                        </ul>
                        <div class="wbo-ai-actions-row" style="margin-top:8px;">
                            ${completedRenames.length > 0 ? `<button type="button" class="wbo-btn wbo-btn-danger" id="wbo-apply-rollback-btn">撤回已改的 ${completedRenames.length} 本</button>` : ''}
                            <button type="button" class="wbo-btn" id="wbo-apply-keep-close-btn">保留成功项并关闭</button>
                        </div>
                    </div>
                `;
                applyProgressBox.querySelector('#wbo-apply-rollback-btn')?.addEventListener('click', async (e) => {
                    const rbBtn = e.currentTarget;
                    if (rbBtn instanceof HTMLButtonElement) rbBtn.disabled = true;
                    const { rolledBack, rollbackErrors } = await rollbackRealRenames(completedRenames, preSnapshot);
                    if (applyProgressBox instanceof HTMLElement) {
                        applyProgressBox.innerHTML = rollbackErrors.length > 0
                            ? `<div class="wbo-refusal-box"><b>撤回部分失败：</b><br>${rollbackErrors.map((err) => esc(err)).join('<br>')}</div>`
                            : `<div class="wbo-progress-done">已撤回本次成功修改的 ${rolledBack} 本世界书，已全部恢复原状。</div>`;
                    }
                    showToast('info', `已撤回 ${rolledBack} 本世界书`);
                });
                applyProgressBox.querySelector('#wbo-apply-keep-close-btn')?.addEventListener('click', closeSubModal);
            }
            return;
        }

        const { appliedCount, createdGroups } = applyAiOrganizeProposals(settings, chosen, {
            label: previewFromLocal ? '免 AI 整理' : 'AI 整理',
        });
        closeSubModal();
        await _callbacks.onMutation({ save: true });
        const extra = createdGroups.length > 0 ? `，新建分组：${createdGroups.join('、')}` : '';
        showToast('success', `已应用 ${appliedCount} 本世界书的显示名与分组${extra}`);
    });
}

/**
 * Unified Character Worldbook Scan modal with complete accounting for BOTH
 * fewer books (unbound / missing / shared) AND extra books (multi-book chars / orphan extra books).
 */
function openScanAndImportModal() {
    if (!_callbacks) return;

    const sourceLabel = (s) => (s === 'primary' ? '主书' : s === 'extra' ? '附加' : '内嵌');

    const renderModalBody = () => {
        const { settings, classification, bindingMap } = _callbacks.getState();
        const characters = getCharactersInMemory();
        const worldNamesSet = new Set(getWorldNames([...classification.byName.keys()]));
        const unscannedShallow = findUnscannedShallowCharacters(characters, settings.cachedCharBindings);
        const unimported = findCardsWithUnimportedBooks({
            characters,
            worldNamesSet,
            cachedCharBindings: settings.cachedCharBindings,
        });
        const coverage = summarizeCharacterWorldCoverage({
            characters,
            bindingMap: bindingMap || new Map(),
            worldNamesSet,
            cachedCharBindings: settings.cachedCharBindings,
        });

        const scanBtnLabel = unscannedShallow.length > 0
            ? `开始扫描角色卡（含 ${unscannedShallow.length} 张未加载）`
            : '重新扫描角色卡';

        const charJumpBtn = (avatar, name) =>
            `<button type="button" class="wbo-jump-link" data-jump-char="${esc(avatar)}" title="跳转到角色卡「${esc(name)}」">${esc(name)}</button>`;
        const worldChipHtml = (worldName, { suffix = '', unbindExtraKey = '', unbindExtraLabel = '' } = {}) => `
            <span class="wbo-cov-chip-group">
                <button type="button" class="wbo-jump-link is-world" data-jump-world="${esc(worldName)}" title="在编辑器打开世界书「${esc(worldName)}」">${esc(worldName)}${suffix ? `<small>${esc(suffix)}</small>` : ''}</button>
                <button type="button" class="wbo-cov-mini-btn" data-cov-preview="${esc(worldName)}" title="原地预览此世界书条目"><i class="fa-regular fa-eye"></i></button>
                ${unbindExtraKey ? `<button type="button" class="wbo-cov-mini-btn is-danger" data-cov-unbind-extra="${esc(unbindExtraKey)}" data-cov-world="${esc(worldName)}" title="${esc(unbindExtraLabel || '解除此附加世界书绑定')}"><i class="fa-solid fa-xmark"></i></button>` : ''}
            </span>
        `;

        /** @type {Array<{ key: string, label: string, count: number, rowsHtml: string }>} */
        const covTabs = [];

        const renderCovTable = (rowsHtml) => `
            <div class="wbo-cov-table-head">
                <span>角色卡</span>
                <span>世界书</span>
            </div>
            <div class="wbo-cov-table-body">${rowsHtml}</div>
        `;

        if (coverage.multiBookChars.length > 0) {
            covTabs.push({
                key: 'multi',
                label: '多本书角色',
                count: coverage.multiBookChars.length,
                rowsHtml: renderCovTable(coverage.multiBookChars.map((c) => {
                    const bookNamesJson = JSON.stringify(c.books.map((b) => b.worldName));
                    return `
                        <div class="wbo-cov-row-wrap">
                            <div class="wbo-cov-row">
                                <div class="wbo-cov-subject">
                                    ${charJumpBtn(c.avatar, c.charName)}
                                    ${c.books.length >= 2 ? `<button type="button" class="wbo-cov-action-pill" data-cov-diff="${esc(bookNamesJson)}" title="对比这些世界书的条目差异">对比差异</button>` : ''}
                                </div>
                                <div class="wbo-cov-targets">
                                    ${c.books.map((b) => worldChipHtml(b.worldName, {
                                        suffix: sourceLabel(b.source),
                                        unbindExtraKey: b.source === 'extra' ? c.avatar : '',
                                        unbindExtraLabel: `解除「${c.charName}」的附加世界书「${b.worldName}」`,
                                    })).join('')}
                                </div>
                            </div>
                            <div class="wbo-cov-drawer" hidden></div>
                        </div>
                    `;
                }).join('')),
            });
        }
        if (coverage.sharedBooks.length > 0) {
            covTabs.push({
                key: 'shared',
                label: '多卡共用书',
                count: coverage.sharedBooks.length,
                rowsHtml: renderCovTable(coverage.sharedBooks.map((s) => `
                    <div class="wbo-cov-row-wrap">
                        <div class="wbo-cov-row">
                            <div class="wbo-cov-subject">
                                ${(s.owners || []).map((o) => charJumpBtn(o.avatar, o.charName)).join('')}
                            </div>
                            <div class="wbo-cov-targets">
                                ${worldChipHtml(s.worldName, { suffix: `${(s.owners || []).length}卡共用` })}
                            </div>
                        </div>
                        <div class="wbo-cov-drawer" hidden></div>
                    </div>
                `).join('')),
            });
        }
        if (coverage.missingFileChars.length > 0) {
            covTabs.push({
                key: 'missing',
                label: '文件缺失',
                count: coverage.missingFileChars.length,
                rowsHtml: renderCovTable(coverage.missingFileChars.map((c) => `
                    <div class="wbo-cov-row">
                        <div class="wbo-cov-subject">
                            ${charJumpBtn(c.avatar, c.charName)}
                        </div>
                        <div class="wbo-cov-targets">
                            <span class="wbo-cov-missing">缺失：${esc(c.missingWorld)}</span>
                            <button type="button" class="wbo-cov-action-pill is-danger" data-cov-clear-missing="${esc(c.avatar)}" data-cov-char-name="${esc(c.charName)}" title="清除角色卡上已失效的主世界书引用">清除失效绑定</button>
                        </div>
                    </div>
                `).join('')),
            });
        }
        if (coverage.orphanExtraBooks.length > 0) {
            covTabs.push({
                key: 'orphan',
                label: '残留附加书',
                count: coverage.orphanExtraBooks.length,
                rowsHtml: `
                    <div class="wbo-cov-orphan-bar">
                        <span>这些附加绑定对应的角色卡已删除，可直接解除残留绑定（不会删除世界书本体）。</span>
                        <button type="button" class="wbo-cov-action-pill is-danger" id="wbo-cov-clear-all-orphans">一键清理全部 (${coverage.orphanExtraBooks.length})</button>
                    </div>
                    ${renderCovTable(coverage.orphanExtraBooks.map((o) => `
                        <div class="wbo-cov-row-wrap">
                            <div class="wbo-cov-row">
                                <div class="wbo-cov-subject">
                                    <span class="wbo-cov-missing">${esc(o.charName)}（已删）</span>
                                </div>
                                <div class="wbo-cov-targets">
                                    ${worldChipHtml(o.worldName, {
                                        unbindExtraKey: o.charKey || o.charName,
                                        unbindExtraLabel: `清理已删角色「${o.charName}」对「${o.worldName}」的残留绑定`,
                                    })}
                                </div>
                            </div>
                            <div class="wbo-cov-drawer" hidden></div>
                        </div>
                    `).join(''))}
                `,
            });
        }
        if (coverage.embeddedNameMatches?.length > 0) {
            covTabs.push({
                key: 'embedded',
                label: '卡内同名书',
                count: coverage.embeddedNameMatches.length,
                rowsHtml: `
                    <div class="wbo-cov-orphan-bar">
                        <span>这些角色卡已绑定主世界书，同时卡内自带世界书与另一本本地世界书同名（可能是旧版本残留，并非附加绑定，已归入角色世界书隐藏）。</span>
                    </div>
                    ${renderCovTable(coverage.embeddedNameMatches.map((m) => `
                        <div class="wbo-cov-row-wrap">
                            <div class="wbo-cov-row">
                                <div class="wbo-cov-subject">
                                    ${charJumpBtn(m.avatar, m.charName)}
                                </div>
                                <div class="wbo-cov-targets">
                                    ${worldChipHtml(m.worldName, { suffix: '卡内同名' })}
                                </div>
                            </div>
                            <div class="wbo-cov-drawer" hidden></div>
                        </div>
                    `).join(''))}
                `,
            });
        }
        if (coverage.unboundChars.length > 0) {
            covTabs.push({
                key: 'unbound',
                label: '未绑定角色',
                count: coverage.unboundChars.length,
                rowsHtml: renderCovTable(coverage.unboundChars.map((c) => `
                    <div class="wbo-cov-row">
                        <div class="wbo-cov-subject">
                            ${charJumpBtn(c.avatar, c.charName)}
                        </div>
                        <div class="wbo-cov-targets">
                            <span class="wbo-cov-missing">${c.shallow ? '尚未加载（可点上方扫描）' : '未绑定世界书'}</span>
                        </div>
                    </div>
                `).join('')),
            });
        }

        const totalDiffItems = covTabs.reduce((acc, t) => acc + t.count, 0);
        const firstTabKey = covTabs[0]?.key || '';
        const overviewSummary = covTabs.length > 0
            ? covTabs.map((t) => `${t.label} ${t.count}`).join(' · ')
            : '所有角色卡与世界书一一对应，未发现异常。';

        const coverageHtml = covTabs.length > 0
            ? `
                <div class="wbo-card wbo-cov-panel">
                    <div class="wbo-ai-section-head">
                        <span>对应明细 · 共 ${totalDiffItems} 项差异</span>
                        <span class="wbo-subtle-tip">点击名称直接跳转</span>
                    </div>
                    <div class="wbo-cov-overview">${esc(overviewSummary)}</div>
                    <div class="wbo-cov-tab-bar">
                        ${covTabs.map((t, i) => `
                            <button type="button" class="wbo-pill${i === 0 ? ' is-active' : ''}" data-cov-tab="${esc(t.key)}">
                                <span>${esc(t.label)}</span><span class="wbo-pill-count">${t.count}</span>
                            </button>
                        `).join('')}
                    </div>
                    <div class="wbo-cov-panes">
                        ${covTabs.map((t) => `
                            <div class="wbo-cov-pane" data-cov-pane="${esc(t.key)}"${t.key === firstTabKey ? '' : ' hidden'}>
                                ${t.rowsHtml}
                            </div>
                        `).join('')}
                    </div>
                </div>
            `
            : `<div class="wbo-cov-overview">${esc(overviewSummary)}</div>`;

        const unimportedSection = unimported.length > 0
            ? `
                <div class="wbo-field">
                    <div class="wbo-ai-section-head">
                        <span>发现 ${unimported.length} 本尚未导入的卡内世界书</span>
                    </div>
                    <div class="wbo-ai-book-list">
                        ${unimported.map((item) => `
                            <label class="wbo-ai-pick-row">
                                <input type="checkbox" class="wbo-import-book-check" value="${esc(item.avatar)}" checked>
                                <span class="wbo-ai-pick-name">
                                    <b>${esc(item.charName)}</b>
                                    <small>→ ${esc(item.importName)} · ${item.entryCount} 条</small>
                                </span>
                            </label>
                        `).join('')}
                    </div>
                    <div class="wbo-ai-actions-row">
                        <button type="button" class="wbo-btn wbo-btn-primary" id="wbo-import-selected-books-btn">
                            <i class="fa-solid fa-file-import"></i> 导入选中世界书
                        </button>
                    </div>
                </div>
            `
            : '';

        return `
            <div class="wbo-step-scroll">
            <div class="wbo-scan-summary">
                <span>角色卡：<b>${characters.length}</b> 张</span>
                <span>已识别角色世界书：<b>${classification.charCount}</b> 本</span>
                ${unscannedShallow.length > 0 ? `<span>待扫描：<b>${unscannedShallow.length}</b> 张</span>` : ''}
            </div>

            <div class="wbo-ai-actions-row">
                <button type="button" class="wbo-btn wbo-btn-primary" id="wbo-scan-all-btn">
                    <i class="fa-solid fa-magnifying-glass"></i> ${esc(scanBtnLabel)}
                </button>
            </div>

            ${coverageHtml}
            ${unimportedSection}

            <div class="wbo-ai-status" id="wbo-scan-status"></div>
            </div>

            <div class="wbo-modal-footer wbo-pinned-footer">
                <button type="button" class="wbo-btn" id="wbo-scan-close-btn">关闭</button>
            </div>
        `;
    };

    const { modal } = createSubModal('扫描角色世界书', renderModalBody(), { wide: true, pinnedLayout: true });
    const cancelSignal = { cancelled: false };

    const bindHandlers = () => {
        const statusEl = modal.querySelector('#wbo-scan-status');
        const setStatus = (msg, state = false) => {
            if (!statusEl) return;
            const kind = state === true ? 'error' : (state === 'error' || state === 'success' ? state : 'info');
            statusEl.textContent = msg;
            statusEl.className = `wbo-ai-status${kind === 'error' ? ' is-error' : (kind === 'success' ? ' is-success' : '')}`;
        };

        const rerenderScanBody = (activeTabKey = '', statusMsg = '', statusKind = 'success') => {
            const body = modal.querySelector('.wbo-modal-body');
            if (!body) return;
            body.innerHTML = renderModalBody();
            bindHandlers();
            if (activeTabKey) {
                const tabBtn = modal.querySelector(`[data-cov-tab="${CSS.escape(activeTabKey)}"]`);
                if (tabBtn instanceof HTMLElement) tabBtn.click();
            }
            if (statusMsg) {
                const nextStatus = modal.querySelector('#wbo-scan-status');
                if (nextStatus) {
                    nextStatus.textContent = statusMsg;
                    nextStatus.className = `wbo-ai-status${statusKind === 'error' ? ' is-error' : (statusKind === 'success' ? ' is-success' : '')}`;
                }
            }
        };

        const getActiveCovTabKey = () =>
            modal.querySelector('[data-cov-tab].is-active')?.getAttribute('data-cov-tab') || '';

        modal.querySelector('#wbo-scan-close-btn')?.addEventListener('click', () => {
            cancelSignal.cancelled = true;
            closeSubModal();
        });

        modal.querySelectorAll('[data-cov-tab]').forEach((tabBtn) => {
            tabBtn.addEventListener('click', () => {
                const key = tabBtn.getAttribute('data-cov-tab');
                if (!key) return;
                modal.querySelectorAll('[data-cov-tab]').forEach((b) => {
                    b.classList.toggle('is-active', b.getAttribute('data-cov-tab') === key);
                });
                modal.querySelectorAll('[data-cov-pane]').forEach((pane) => {
                    if (pane instanceof HTMLElement) {
                        pane.hidden = pane.getAttribute('data-cov-pane') !== key;
                    }
                });
            });
        });

        // On-demand inline entry preview inside Scan coverage rows
        modal.querySelectorAll('[data-cov-preview]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const worldName = btn.getAttribute('data-cov-preview');
                const wrap = btn.closest('.wbo-cov-row-wrap');
                const drawer = wrap?.querySelector('.wbo-cov-drawer');
                if (!worldName || !(drawer instanceof HTMLElement)) return;
                const key = `preview:${worldName}`;
                if (!drawer.hidden && drawer.getAttribute('data-drawer-key') === key) {
                    drawer.hidden = true;
                    drawer.removeAttribute('data-drawer-key');
                    return;
                }
                drawer.setAttribute('data-drawer-key', key);
                drawer.hidden = false;
                drawer.innerHTML = `<div class="wbo-preview-loading">正在读取「${esc(worldName)}」条目...</div>`;
                try {
                    const data = _previewCache.has(worldName)
                        ? _previewCache.get(worldName)
                        : await fetchWorldbookPreviewEntries(worldName);
                    setPreviewCache(worldName, data);
                    if (!drawer.isConnected || drawer.getAttribute('data-drawer-key') !== key) return;
                    const shown = (data?.entries || []).slice(0, 20);
                    const itemsHtml = shown.length > 0
                        ? shown.map((e) => `
                            <details class="wbo-preview-entry${e.disabled ? ' is-disabled' : ''}">
                                <summary class="wbo-preview-entry-head">
                                    <i class="fa-solid fa-chevron-right wbo-details-chev"></i>
                                    <span class="wbo-preview-entry-title">${esc(e.title)}</span>
                                    <span class="wbo-preview-entry-badges">${e.constant ? '<span class="wbo-entry-badge is-const">常驻</span>' : ''}${e.disabled ? '<span class="wbo-entry-badge is-off">禁用</span>' : ''}</span>
                                </summary>
                                <div class="wbo-preview-entry-content${e.content ? '' : ' is-empty'}">${esc(e.content || '正文为空')}</div>
                            </details>
                        `).join('')
                        : '<div class="wbo-preview-loading">该世界书暂无条目</div>';
                    drawer.innerHTML = `
                        <div class="wbo-preview-head">
                            <span><b>${esc(worldName)}</b> · 共 ${data?.total || 0} 条（启用 ${data?.enabledCount || 0} 条）</span>
                            <button type="button" class="wbo-link-btn" data-close-cov-drawer>收起</button>
                        </div>
                        <div class="wbo-preview-list">${itemsHtml}</div>
                        ${(data?.total || 0) > shown.length ? `<div class="wbo-preview-more">仅展示前 ${shown.length} 条，点书名可在编辑器查看全部</div>` : ''}
                    `;
                    drawer.querySelector('[data-close-cov-drawer]')?.addEventListener('click', () => {
                        drawer.hidden = true;
                        drawer.removeAttribute('data-drawer-key');
                    });
                } catch (err) {
                    drawer.innerHTML = `<div class="wbo-preview-loading">读取失败：${esc(err?.message || err)}</div>`;
                }
            });
        });

        // On-demand 2-book entry diff inside Multi-book character rows
        modal.querySelectorAll('[data-cov-diff]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const rawJson = btn.getAttribute('data-cov-diff');
                const wrap = btn.closest('.wbo-cov-row-wrap');
                const drawer = wrap?.querySelector('.wbo-cov-drawer');
                if (!rawJson || !(drawer instanceof HTMLElement)) return;
                let names = [];
                try { names = JSON.parse(rawJson); } catch { return; }
                if (!Array.isArray(names) || names.length < 2) return;
                const [bookA, bookB] = names;
                const key = `diff:${bookA}||${bookB}`;
                if (!drawer.hidden && drawer.getAttribute('data-drawer-key') === key) {
                    drawer.hidden = true;
                    drawer.removeAttribute('data-drawer-key');
                    return;
                }
                drawer.setAttribute('data-drawer-key', key);
                drawer.hidden = false;
                drawer.innerHTML = `<div class="wbo-preview-loading">正在对比「${esc(bookA)}」与「${esc(bookB)}」...</div>`;
                try {
                    const [dataA, dataB] = await Promise.all([
                        _previewCache.has(bookA) ? _previewCache.get(bookA) : fetchWorldbookPreviewEntries(bookA),
                        _previewCache.has(bookB) ? _previewCache.get(bookB) : fetchWorldbookPreviewEntries(bookB),
                    ]);
                    setPreviewCache(bookA, dataA);
                    setPreviewCache(bookB, dataB);
                    if (!drawer.isConnected || drawer.getAttribute('data-drawer-key') !== key) return;
                    const diff = compareWorldbookEntries(dataA?.entries || [], dataB?.entries || []);
                    const identical = diff.onlyA.length === 0 && diff.onlyB.length === 0 && diff.modified.length === 0;
                    const renderTitleChips = (arr, emptyText) =>
                        arr.length > 0
                            ? arr.slice(0, 12).map((x) => `<span class="wbo-tag">${esc(x.title)}</span>`).join('') + (arr.length > 12 ? `<span class="wbo-subtle-tip">…等 ${arr.length} 条</span>` : '')
                            : `<span class="wbo-subtle-tip">${emptyText}</span>`;

                    drawer.innerHTML = `
                        <div class="wbo-preview-head">
                            <span><b>差异对比</b>：${identical ? '两本世界书条目内容完全一致，可放心解除其中一本' : `完全相同 ${diff.sameCount} 条 · 仅前书 ${diff.onlyA.length} 条 · 仅后书 ${diff.onlyB.length} 条 · 同名内容不同 ${diff.modified.length} 条`}</span>
                            <button type="button" class="wbo-link-btn" data-close-cov-drawer>收起</button>
                        </div>
                        <div class="wbo-diff-grid">
                            <div class="wbo-diff-col">
                                <div class="wbo-diff-col-head">仅「${esc(bookA)}」（共 ${diff.totalA} 条）独有：${diff.onlyA.length}</div>
                                <div class="wbo-diff-chips">${renderTitleChips(diff.onlyA, '无独有条目')}</div>
                            </div>
                            <div class="wbo-diff-col">
                                <div class="wbo-diff-col-head">仅「${esc(bookB)}」（共 ${diff.totalB} 条）独有：${diff.onlyB.length}</div>
                                <div class="wbo-diff-chips">${renderTitleChips(diff.onlyB, '无独有条目')}</div>
                            </div>
                        </div>
                        ${diff.modified.length > 0 ? `
                            <div class="wbo-diff-mod">
                                <div class="wbo-diff-col-head">同名但正文不同（${diff.modified.length} 条）：</div>
                                <div class="wbo-diff-chips">${diff.modified.slice(0, 10).map((m) => `<span class="wbo-tag" title="${esc(bookA)}: ${m.lenA}字 / ${esc(bookB)}: ${m.lenB}字">${esc(m.title)} (${m.lenA} vs ${m.lenB}字)</span>`).join('')}</div>
                            </div>
                        ` : ''}
                    `;
                    drawer.querySelector('[data-close-cov-drawer]')?.addEventListener('click', () => {
                        drawer.hidden = true;
                        drawer.removeAttribute('data-drawer-key');
                    });
                } catch (err) {
                    drawer.innerHTML = `<div class="wbo-preview-loading">对比失败：${esc(err?.message || err)}</div>`;
                }
            });
        });

        // Direct 1-click unbind extra worldbook (works for both Multi-book chars AND Orphan extras!)
        modal.querySelectorAll('[data-cov-unbind-extra]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const charKey = btn.getAttribute('data-cov-unbind-extra') || '';
                const worldName = btn.getAttribute('data-cov-world') || '';
                if (!charKey || !worldName) return;
                if (!globalThis.confirm(`确认解除附加世界书「${worldName}」的绑定？\n（仅解除绑定，世界书文件不会被删除）`)) return;
                const tabKey = getActiveCovTabKey();
                const res = await unbindExtraWorldbookFromChar(charKey, worldName);
                if (!res.ok) {
                    setStatus(`解除失败：${res.error || '未知错误'}`, 'error');
                    return;
                }
                await _callbacks.onRescan();
                showToast('success', `已解除附加世界书「${worldName}」的绑定`);
                rerenderScanBody(tabKey, `已解除附加世界书「${worldName}」的绑定`, 'success');
            });
        });

        // Batch clear all orphan extra bindings
        modal.querySelector('#wbo-cov-clear-all-orphans')?.addEventListener('click', async () => {
            const buttons = Array.from(modal.querySelectorAll('[data-cov-pane="orphan"] [data-cov-unbind-extra]'));
            if (buttons.length === 0) return;
            if (!globalThis.confirm(`确认清理全部 ${buttons.length} 条已删角色的残留附加绑定？\n（仅解除绑定，世界书文件不会被删除）`)) return;
            let cleared = 0;
            for (const b of buttons) {
                const charKey = b.getAttribute('data-cov-unbind-extra') || '';
                const worldName = b.getAttribute('data-cov-world') || '';
                const res = await unbindExtraWorldbookFromChar(charKey, worldName);
                if (res.ok) cleared += 1;
            }
            await _callbacks.onRescan();
            showToast('success', `已清理 ${cleared} 条残留附加绑定`);
            rerenderScanBody('orphan', `已清理 ${cleared} 条残留附加绑定`, 'success');
        });

        // Direct 1-click clear broken primary worldbook reference (missing file)
        modal.querySelectorAll('[data-cov-clear-missing]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const avatar = btn.getAttribute('data-cov-clear-missing') || '';
                const charName = btn.getAttribute('data-cov-char-name') || avatar;
                if (!avatar) return;
                if (!globalThis.confirm(`确认清除角色「${charName}」上已失效的主世界书引用？`)) return;
                const tabKey = getActiveCovTabKey();
                const { settings } = _callbacks.getState();
                const res = await unbindPrimaryWorldbookFromChar(avatar, settings);
                if (!res.ok) {
                    setStatus(`清除失败：${res.error || '未知错误'}`, 'error');
                    return;
                }
                await _callbacks.onRescan();
                showToast('success', `已清除「${charName}」的失效世界书绑定`);
                rerenderScanBody(tabKey, `已清除「${charName}」的失效世界书绑定`, 'success');
            });
        });

        modal.querySelectorAll('[data-jump-char]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const avatar = btn.getAttribute('data-jump-char');
                if (!avatar) return;
                cancelSignal.cancelled = true;
                closeSubModal();
                closeManagerModal();
                const ok = await openCharacterByAvatar(avatar);
                if (!ok) showToast('warning', '未能定位该角色卡');
            });
        });

        modal.querySelectorAll('[data-jump-world]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const worldName = btn.getAttribute('data-jump-world');
                if (!worldName) return;
                cancelSignal.cancelled = true;
                closeSubModal();
                closeManagerModal();
                if (!openWorldInNativeEditor(worldName)) {
                    showToast('warning', `未能打开世界书「${worldName}」`);
                }
            });
        });

        modal.querySelector('#wbo-scan-all-btn')?.addEventListener('click', async (ev) => {
            const btn = ev.currentTarget;
            if (btn instanceof HTMLButtonElement) btn.disabled = true;
            cancelSignal.cancelled = false;

            const { settings } = _callbacks.getState();
            const targets = findUnscannedShallowCharacters(getCharactersInMemory(), settings.cachedCharBindings);

            if (targets.length > 0) {
                setStatus(`正在扫描 ${targets.length} 张未加载角色卡...`);
                const res = await scanShallowCharactersInBatches(targets, {
                    signal: cancelSignal,
                    onProgress: (done, total, currentName) => {
                        setStatus(`正在扫描 (${done}/${total})：${currentName}`);
                    },
                });
                if (res.scanned.length > 0) {
                    const { cached } = updateCachedCharBindings({}, res.scanned);
                    Object.assign(settings.cachedCharBindings, cached);
                }
            } else {
                setStatus('正在刷新角色绑定与附加世界书...');
            }

            await _callbacks.onRescan();
            const body = modal.querySelector('.wbo-modal-body');
            if (body && !cancelSignal.cancelled) {
                body.innerHTML = renderModalBody();
                bindHandlers();
                const nextStatus = modal.querySelector('#wbo-scan-status');
                if (nextStatus) {
                    nextStatus.textContent = '扫描完成。';
                    nextStatus.className = 'wbo-ai-status is-success';
                }
            }
        });

        modal.querySelector('#wbo-import-selected-books-btn')?.addEventListener('click', async (ev) => {
            const btn = ev.currentTarget;
            if (btn instanceof HTMLButtonElement) btn.disabled = true;

            const avatars = Array.from(modal.querySelectorAll('.wbo-import-book-check:checked')).map((el) => el.value);
            if (avatars.length === 0) {
                setStatus('请先勾选要导入的世界书', true);
                if (btn instanceof HTMLButtonElement) btn.disabled = false;
                return;
            }

            let imported = 0;
            let skipped = 0;
            let failed = 0;
            const knownNames = new Set(getWorldNames());

            for (let i = 0; i < avatars.length; i += 1) {
                setStatus(`正在导入 (${i + 1}/${avatars.length})...`);
                const res = await importEmbeddedWorldbookForCharacter(avatars[i], { worldNamesSet: knownNames });
                if (res.status === 'imported') {
                    imported += 1;
                    if (res.name) knownNames.add(res.name);
                } else if (res.status === 'exists' || res.status === 'nobook') {
                    skipped += 1;
                } else {
                    failed += 1;
                }
            }

            await _callbacks.onRescan();
            const body = modal.querySelector('.wbo-modal-body');
            if (body) {
                body.innerHTML = renderModalBody();
                bindHandlers();
                const nextStatus = modal.querySelector('#wbo-scan-status');
                if (nextStatus) {
                    nextStatus.textContent = `导入完成：成功 ${imported} 本，跳过 ${skipped} 本${failed > 0 ? `，失败 ${failed} 本` : ''}。`;
                }
            }
            if (imported > 0) {
                showToast('success', `已导入 ${imported} 本角色世界书`);
            }
        });
    };

    bindHandlers();
}

// ==================== Settings Modal & Extension Settings Panel ====================

function triggerConfigExport() {
    if (!_callbacks) return;
    const { settings } = _callbacks.getState();
    const data = exportConfigData(settings);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `worldbook-organizer-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    showToast('success', '已导出配置');
}

async function handleConfigImportFile(file) {
    if (!_callbacks || !file) return;
    const { settings } = _callbacks.getState();
    try {
        const text = await file.text();
        const res = importConfigData(settings, text);
        if (!res.ok) {
            showToast('error', res.error || '导入失败');
            return;
        }
        await _callbacks.onMutation({ save: true });
        showToast('success', `导入成功：${res.stats.groups} 个分组、${res.stats.aliases} 条别名`);
    } catch (err) {
        showToast('error', `读取配置失败：${err?.message || err}`);
    }
}

/**
 * Sync live setting values into any container holding `[data-setting]` / `[data-setting-select]`.
 * @param {Element} container
 * @param {Record<string, any>} settings
 */
function syncSettingControlsInPlace(container, settings) {
    container.querySelectorAll('input[data-setting]').forEach((el) => {
        if (!(el instanceof HTMLInputElement)) return;
        const key = el.getAttribute('data-setting');
        if (key) el.checked = Boolean(settings[key]);
    });
    container.querySelectorAll('select[data-setting-select]').forEach((el) => {
        if (!(el instanceof HTMLSelectElement)) return;
        const key = el.getAttribute('data-setting-select');
        if (key && settings[key] !== undefined) el.value = String(settings[key]);
    });
}

/**
 * Bind change listeners for `[data-setting]` and `[data-setting-select]` reading live state.
 * @param {Element} container
 */
function bindSettingControlListeners(container) {
    container.querySelectorAll('input[data-setting]').forEach((el) => {
        el.addEventListener('change', async () => {
            if (!(el instanceof HTMLInputElement) || !_callbacks) return;
            const key = el.getAttribute('data-setting');
            if (!key) return;
            const { settings } = _callbacks.getState();
            settings[key] = el.checked;
            if (key === 'hideCharBooksByDefault') {
                settings.showCharBooks = !el.checked;
                for (const listKey of ['globalHiddenGroupIds', 'editorHiddenGroupIds']) {
                    const curList = Array.isArray(settings[listKey]) ? [...settings[listKey]] : [];
                    if (el.checked) {
                        if (!curList.includes(SPECIAL_GROUPS.CHARACTER)) curList.unshift(SPECIAL_GROUPS.CHARACTER);
                    } else {
                        const idx = curList.indexOf(SPECIAL_GROUPS.CHARACTER);
                        if (idx >= 0) curList.splice(idx, 1);
                    }
                    settings[listKey] = curList;
                }
                container.dispatchEvent(new CustomEvent('wbo:sync-exclude-chips'));
            }
            await _callbacks.onMutation({ save: true });
        });
    });

    container.querySelectorAll('select[data-setting-select]').forEach((el) => {
        el.addEventListener('change', async () => {
            if (!(el instanceof HTMLSelectElement) || !_callbacks) return;
            const key = el.getAttribute('data-setting-select');
            if (!key) return;
            const { settings } = _callbacks.getState();
            settings[key] = el.value;
            await _callbacks.onMutation({ save: true });
        });
    });
}

/**
 * Open the Display & Behavior Settings sub-modal directly inside Group Manager.
 */
function openSettingsModal() {
    if (!_callbacks) return;
    const { settings, classification } = _callbacks.getState();

    const sectionOptions = [
        { id: SPECIAL_GROUPS.CHARACTER, name: '角色世界书', color: '#9b72cf' },
        ...(settings.groups || []).map((g) => ({ id: g.id, name: g.name, color: g.color || '#5b8def' })),
        { id: SPECIAL_GROUPS.UNGROUPED, name: '未分组', color: '#8c99a6' },
    ];
    const renderExcludeChipsHtml = (targetKey, selectedIds) => {
        const set = new Set(Array.isArray(selectedIds) ? selectedIds : []);
        return sectionOptions.map((sec) => {
            const active = set.has(sec.id);
            return `
                <button type="button"
                    class="wbo-local-cat-btn${active ? ' is-selected' : ''}"
                    data-exclude-target="${esc(targetKey)}"
                    data-exclude-gid="${esc(sec.id)}"
                    aria-pressed="${active ? 'true' : 'false'}">
                    <span class="wbo-local-cat-mark">${active ? '<i class="fa-solid fa-check"></i>' : ''}</span>
                    <span class="wbo-pill-dot" style="background:${esc(sec.color)}"></span>
                    <span>${esc(sec.name)}</span>
                </button>
            `;
        }).join('');
    };

    const paletteButtonsHtml = THEME_PALETTES.map((p) => `
        <button type="button"
            class="wbo-palette-chip${settings.themePalette === p.id ? ' is-active' : ''}"
            data-theme-palette="${esc(p.id)}">
            <span class="wbo-palette-swatch" style="background:linear-gradient(135deg, ${p.lightBg} 48%, ${p.accent} 52%)"></span>
            <span>${esc(p.label)}</span>
        </button>
    `).join('');

    const modeButtonsHtml = [
        { id: 'auto', label: '跟随酒馆' },
        { id: 'light', label: '浅色' },
        { id: 'dark', label: '深色' },
    ].map((m) => `
        <button type="button"
            class="wbo-mode-chip${(settings.themeMode || 'auto') === m.id ? ' is-active' : ''}"
            data-theme-mode="${esc(m.id)}">${esc(m.label)}</button>
    `).join('');

    const { modal } = createSubModal(
        '显示与行为设置',
        `
            <div class="wbo-pinned-tabs-bar" id="wbo-settings-tabs">
                <div class="wbo-tabs">
                    <button type="button" class="wbo-tab is-active" data-settings-tab="appearance">外观与入口</button>
                    <button type="button" class="wbo-tab" data-settings-tab="display">标题与排除</button>
                    <button type="button" class="wbo-tab" data-settings-tab="behavior">识别与适配</button>
                </div>
            </div>

            <div class="wbo-step-scroll">
            <div class="wbo-settings-tab-pane" data-settings-pane="appearance">
                <div class="wbo-card">
                    <div class="wbo-ai-section-head"><span>面板配色</span></div>
                    <div class="wbo-palette-grid">${paletteButtonsHtml}</div>
                    <div class="wbo-setting-inline-row">
                        <span>明暗模式</span>
                        <div class="wbo-mode-group">${modeButtonsHtml}</div>
                    </div>
                    <label class="wbo-check-line">
                        <input type="checkbox" data-setting="outsideDropdownFollowHostTheme">
                        <span>插件面板外的下拉筛选框跟随酒馆主题</span>
                    </label>
                </div>

                <div class="wbo-card">
                    <div class="wbo-ai-section-head"><span>世界书原生面板快捷按钮</span></div>
                    <label class="wbo-check-line">
                        <input type="checkbox" data-setting="showNativeCharToggleBtn">
                        <span>显示编辑下拉框旁「角色书显隐」按钮</span>
                    </label>
                    <label class="wbo-check-line">
                        <input type="checkbox" data-setting="showNativeExcludeBtn">
                        <span>显示顶栏右侧「排除」快捷按钮</span>
                    </label>
                    <label class="wbo-check-line">
                        <input type="checkbox" data-setting="showNativeEntrySearchBtn">
                        <span>显示顶栏右侧「搜条目」快捷按钮</span>
                    </label>
                    <div class="wbo-subtle-tip">关闭后原生世界书面板保持零额外图标，仍可在魔棒菜单的分组管理面板中使用全部功能。</div>
                </div>
            </div>

            <div class="wbo-settings-tab-pane" data-settings-pane="display" hidden>
                <div class="wbo-card">
                    <div class="wbo-ai-section-head"><span>标题显示</span></div>
                    <div class="wbo-setting-inline-row">
                        <span>角色世界书标题</span>
                        <select class="wbo-select" data-setting-select="charBookTitleMode">
                            <option value="char_with_sub">角色名 + 小字原标题</option>
                            <option value="char_only">仅角色名</option>
                            <option value="original">原标题</option>
                        </select>
                    </div>
                    <div class="wbo-setting-inline-row">
                        <span>显示名展示方式</span>
                        <select class="wbo-select" data-setting-select="aliasTitleMode">
                            <option value="alias_with_sub">显示名 + 小字原名</option>
                            <option value="alias_only">仅显示名</option>
                        </select>
                    </div>
                    <div class="wbo-setting-inline-row">
                        <span id="wbo-alias-count-label">当前已自定义 ${Object.keys(settings.aliases || {}).length} 个显示名</span>
                        <button type="button" class="wbo-btn" id="wbo-reset-all-aliases-btn"${Object.keys(settings.aliases || {}).length === 0 ? ' disabled' : ''}>
                            <i class="fa-solid fa-rotate-left"></i> 全部恢复为文件名
                        </button>
                    </div>
                    <div class="wbo-setting-inline-row">
                        <span id="wbo-note-count-label">当前共有 ${Object.keys(settings.notes || {}).length} 条备注说明</span>
                        <button type="button" class="wbo-btn" id="wbo-clear-all-notes-btn"${Object.keys(settings.notes || {}).length === 0 ? ' disabled' : ''}>
                            <i class="fa-regular fa-trash-can"></i> 清空全部说明
                        </button>
                    </div>
                </div>

                <div class="wbo-card">
                    <div class="wbo-ai-section-head"><span>下拉框默认排除分组</span></div>
                    <div class="wbo-exclude-block">
                        <div class="wbo-exclude-head">
                            <span>全局激活框</span>
                            <span class="wbo-ai-quick-picks">
                                <button type="button" class="wbo-link-btn" data-exclude-preset="char-only" data-exclude-scope="globalHiddenGroupIds">仅角色书</button>
                                <button type="button" class="wbo-link-btn" data-exclude-preset="clear" data-exclude-scope="globalHiddenGroupIds">清空</button>
                            </span>
                        </div>
                        <div class="wbo-local-cats wbo-exclude-chips" data-exclude-list="globalHiddenGroupIds">
                            ${renderExcludeChipsHtml('globalHiddenGroupIds', settings.globalHiddenGroupIds)}
                        </div>
                    </div>
                    <div class="wbo-local-divider"></div>
                    <div class="wbo-exclude-block">
                        <div class="wbo-exclude-head">
                            <span>编辑下拉框</span>
                            <span class="wbo-ai-quick-picks">
                                <button type="button" class="wbo-link-btn" data-exclude-preset="copy-global" data-exclude-scope="editorHiddenGroupIds">同全局</button>
                                <button type="button" class="wbo-link-btn" data-exclude-preset="char-only" data-exclude-scope="editorHiddenGroupIds">仅角色书</button>
                                <button type="button" class="wbo-link-btn" data-exclude-preset="clear" data-exclude-scope="editorHiddenGroupIds">清空</button>
                            </span>
                        </div>
                        <div class="wbo-local-cats wbo-exclude-chips" data-exclude-list="editorHiddenGroupIds">
                            ${renderExcludeChipsHtml('editorHiddenGroupIds', settings.editorHiddenGroupIds)}
                        </div>
                    </div>
                    <div class="wbo-subtle-tip">点击选中要默认隐藏的分组；已全局激活或正在编辑的世界书不会被隐藏。</div>
                    <div class="wbo-local-divider"></div>
                    <label class="wbo-check-line">
                        <input type="checkbox" data-setting="pinCurrentChatCharBookInEditor">
                        <span>聊天中在编辑下拉框置顶当前角色的世界书</span>
                    </label>
                </div>
            </div>

            <div class="wbo-settings-tab-pane" data-settings-pane="behavior" hidden>
                <div class="wbo-card">
                    <div class="wbo-ai-section-head"><span>识别与默认行为</span></div>
                    <label class="wbo-check-line">
                        <input type="checkbox" data-setting="hideCharBooksByDefault">
                        <span>默认隐藏角色卡绑定的世界书</span>
                    </label>
                    <label class="wbo-check-line">
                        <input type="checkbox" data-setting="includeExtraCharBooks">
                        <span>将角色附加世界书归入角色世界书</span>
                    </label>
                    <label class="wbo-check-line">
                        <input type="checkbox" data-setting="includeEmbeddedNameMatch">
                        <span>识别角色卡内嵌同名世界书</span>
                    </label>
                    <label class="wbo-check-line">
                        <input type="checkbox" data-setting="autoScanNewCharacters">
                        <span>导入新角色卡时自动扫描绑定的世界书</span>
                    </label>
                    <label class="wbo-check-line">
                        <input type="checkbox" data-setting="autoImportMissingCharBook">
                        <span>打开角色卡时自动导入缺失的卡内世界书</span>
                    </label>
                    <label class="wbo-check-line">
                        <input type="checkbox" data-setting="showNativeOptgroups">
                        <span>编辑器下拉框按分组显示</span>
                    </label>
                </div>

                <div class="wbo-card">
                    <div class="wbo-ai-section-head"><span>弹窗适配范围</span></div>
                    <label class="wbo-check-line">
                        <input type="checkbox" data-setting="adaptCharBindPopup">
                        <span>角色卡世界书绑定弹窗</span>
                    </label>
                    <label class="wbo-check-line">
                        <input type="checkbox" data-setting="autoHideInCharBindPopup">
                        <span>角色卡绑定弹窗默认排除其他角色世界书</span>
                    </label>
                    <label class="wbo-check-line">
                        <input type="checkbox" data-setting="adaptPersonaBindPopup">
                        <span>User 人设世界书弹窗</span>
                    </label>
                    <label class="wbo-check-line">
                        <input type="checkbox" data-setting="adaptChatBindPopup">
                        <span>当前聊天世界书弹窗</span>
                    </label>
                    <label class="wbo-check-line">
                        <input type="checkbox" data-setting="adaptMoveEntryPopup">
                        <span>移动/复制条目目标世界书弹窗</span>
                    </label>
                </div>
            </div>
            </div>

            <div class="wbo-modal-footer wbo-pinned-footer">
                <button type="button" class="wbo-btn" id="wbo-modal-export-btn">
                    <i class="fa-solid fa-download"></i> 导出配置
                </button>
                <button type="button" class="wbo-btn" id="wbo-modal-import-btn">
                    <i class="fa-solid fa-upload"></i> 导入配置
                </button>
                <input type="file" id="wbo-modal-import-file" accept=".json" hidden>
                <span class="wbo-spacer"></span>
                <button type="button" class="wbo-btn wbo-btn-primary" id="wbo-settings-close-btn">完成</button>
            </div>
        `,
        { pinnedLayout: true },
    );

    modal.querySelectorAll('[data-settings-tab]').forEach((tabBtn) => {
        tabBtn.addEventListener('click', () => {
            const targetTab = tabBtn.getAttribute('data-settings-tab') || 'appearance';
            modal.querySelectorAll('[data-settings-tab]').forEach((b) => {
                b.classList.toggle('is-active', b.getAttribute('data-settings-tab') === targetTab);
            });
            modal.querySelectorAll('[data-settings-pane]').forEach((pane) => {
                if (pane instanceof HTMLElement) {
                    pane.hidden = pane.getAttribute('data-settings-pane') !== targetTab;
                }
            });
            const scrollEl = modal.querySelector('.wbo-step-scroll');
            if (scrollEl) scrollEl.scrollTop = 0;
        });
    });

    syncSettingControlsInPlace(modal, settings);
    bindSettingControlListeners(modal);

    const syncExcludeChips = () => {
        const cur = _callbacks?.getState?.()?.settings || settings;
        for (const targetKey of ['globalHiddenGroupIds', 'editorHiddenGroupIds']) {
            const set = new Set(Array.isArray(cur[targetKey]) ? cur[targetKey] : []);
            modal.querySelectorAll(`[data-exclude-target="${targetKey}"]`).forEach((btn) => {
                const gid = btn.getAttribute('data-exclude-gid') || '';
                const active = set.has(gid);
                btn.classList.toggle('is-selected', active);
                btn.setAttribute('aria-pressed', active ? 'true' : 'false');
                const mark = btn.querySelector('.wbo-local-cat-mark');
                if (mark) mark.innerHTML = active ? '<i class="fa-solid fa-check"></i>' : '';
            });
        }
        const hideCharCb = modal.querySelector('input[data-setting="hideCharBooksByDefault"]');
        if (hideCharCb instanceof HTMLInputElement) {
            const charHiddenAnywhere =
                (Array.isArray(cur.globalHiddenGroupIds) && cur.globalHiddenGroupIds.includes(SPECIAL_GROUPS.CHARACTER)) ||
                (Array.isArray(cur.editorHiddenGroupIds) && cur.editorHiddenGroupIds.includes(SPECIAL_GROUPS.CHARACTER));
            hideCharCb.checked = charHiddenAnywhere;
            cur.hideCharBooksByDefault = charHiddenAnywhere;
        }
    };
    modal.addEventListener('wbo:sync-exclude-chips', syncExcludeChips);

    modal.querySelectorAll('[data-exclude-target]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            if (!_callbacks) return;
            const targetKey = btn.getAttribute('data-exclude-target');
            const gid = btn.getAttribute('data-exclude-gid');
            if (!targetKey || !gid) return;
            const cur = _callbacks.getState().settings;
            const set = new Set(Array.isArray(cur[targetKey]) ? cur[targetKey] : []);
            if (set.has(gid)) set.delete(gid);
            else set.add(gid);
            cur[targetKey] = [...set];
            // If user just excluded a group while reveal toggle was OFF, apply immediately;
            // if user had toggled reveal ON earlier, keep reveal state untouched or switch to hidden when excluding?
            // Keeping `showCharBooks = false` when user actively configures default exclusions ensures instant visible effect!
            if (set.size > 0 && cur.showCharBooks) {
                cur.showCharBooks = false;
            }
            syncExcludeChips();
            await _callbacks.onMutation({ save: true });
        });
    });

    modal.querySelectorAll('[data-exclude-preset]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            if (!_callbacks) return;
            const preset = btn.getAttribute('data-exclude-preset');
            const scopeKey = btn.getAttribute('data-exclude-scope');
            if (!preset || !scopeKey) return;
            const cur = _callbacks.getState().settings;
            if (preset === 'clear') {
                cur[scopeKey] = [];
            } else if (preset === 'char-only') {
                cur[scopeKey] = [SPECIAL_GROUPS.CHARACTER];
                cur.showCharBooks = false;
            } else if (preset === 'copy-global') {
                cur[scopeKey] = Array.isArray(cur.globalHiddenGroupIds) ? [...cur.globalHiddenGroupIds] : [];
                if (cur[scopeKey].length > 0) cur.showCharBooks = false;
            }
            syncExcludeChips();
            await _callbacks.onMutation({ save: true });
        });
    });

    const syncThemeChips = () => {
        const cur = _callbacks?.getState?.()?.settings || settings;
        modal.querySelectorAll('[data-theme-palette]').forEach((btn) => {
            btn.classList.toggle('is-active', btn.getAttribute('data-theme-palette') === (cur.themePalette || 'classic'));
        });
        modal.querySelectorAll('[data-theme-mode]').forEach((btn) => {
            btn.classList.toggle('is-active', btn.getAttribute('data-theme-mode') === (cur.themeMode || 'auto'));
        });
    };

    modal.querySelectorAll('[data-theme-palette]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const val = btn.getAttribute('data-theme-palette');
            if (!val || !_callbacks) return;
            const cur = _callbacks.getState().settings;
            cur.themePalette = val;
            syncThemeChips();
            syncAllOpenModalsTheme();
            await _callbacks.onMutation({ save: true, uiOnly: true });
        });
    });

    modal.querySelectorAll('[data-theme-mode]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const val = btn.getAttribute('data-theme-mode');
            if (!val || !_callbacks) return;
            const cur = _callbacks.getState().settings;
            cur.themeMode = val;
            syncThemeChips();
            syncAllOpenModalsTheme();
            await _callbacks.onMutation({ save: true, uiOnly: true });
        });
    });

    modal.querySelector('#wbo-reset-all-aliases-btn')?.addEventListener('click', async () => {
        if (!_callbacks) return;
        const cur = _callbacks.getState().settings;
        const count = Object.keys(cur.aliases || {}).length;
        if (count === 0) return;
        if (!globalThis.confirm(`确认清除全部 ${count} 个自定义显示名，一键恢复为世界书原文件名？\n（不会影响已有分组，且可在历史版本中回退）`)) return;
        pushUndoSnapshot(cur, { count, label: '恢复原文件名' });
        cur.aliases = {};
        await _callbacks.onMutation({ save: true });
        const lbl = modal.querySelector('#wbo-alias-count-label');
        const btn = modal.querySelector('#wbo-reset-all-aliases-btn');
        if (lbl) lbl.textContent = '当前已自定义 0 个显示名';
        if (btn instanceof HTMLButtonElement) btn.disabled = true;
        showToast('success', `已将 ${count} 本世界书恢复为原文件名`);
    });

    modal.querySelector('#wbo-clear-all-notes-btn')?.addEventListener('click', async () => {
        if (!_callbacks) return;
        const cur = _callbacks.getState().settings;
        const count = Object.keys(cur.notes || {}).length;
        if (count === 0) return;
        if (!globalThis.confirm(`确认清空全部 ${count} 条世界书备注说明？\n（不会影响已有分组与名称，且可在历史版本中回退）`)) return;
        pushUndoSnapshot(cur, { count, label: '清空全部说明' });
        cur.notes = {};
        await _callbacks.onMutation({ save: true });
        const lbl = modal.querySelector('#wbo-note-count-label');
        const btn = modal.querySelector('#wbo-clear-all-notes-btn');
        if (lbl) lbl.textContent = '当前共有 0 条备注说明';
        if (btn instanceof HTMLButtonElement) btn.disabled = true;
        showToast('success', `已清空 ${count} 条备注说明`);
    });

    modal.querySelector('#wbo-modal-export-btn')?.addEventListener('click', triggerConfigExport);
    const importInput = modal.querySelector('#wbo-modal-import-file');
    modal.querySelector('#wbo-modal-import-btn')?.addEventListener('click', () => {
        if (importInput instanceof HTMLInputElement) {
            importInput.value = '';
            importInput.click();
        }
    });
    importInput?.addEventListener('change', async () => {
        if (!(importInput instanceof HTMLInputElement) || !importInput.files?.[0]) return;
        await handleConfigImportFile(importInput.files[0]);
        if (_callbacks) {
            syncSettingControlsInPlace(modal, _callbacks.getState().settings);
            syncExcludeChips();
            syncThemeChips();
            syncAllOpenModalsTheme();
        }
    });
    modal.querySelector('#wbo-settings-close-btn')?.addEventListener('click', closeSubModal);
}

/**
 * Compact, theme-following quick-exclude popover anchored right inside `#WorldInfo`
 * (opened via the `排除` button on the `#WorldInfo` title bar OR right-click/long-press
 * on `#wbo-hdr-show-char`). Lets users toggle Global & Editor excluded groups on the fly
 * without ever opening Group Manager or Settings!
 * @param {HTMLElement} anchorEl
 */
function openQuickExcludePopover(anchorEl) {
    const existing = document.getElementById('wbo-quick-exclude-backdrop');
    if (existing) {
        existing.remove();
        return;
    }
    closeGroupVisibilityPopover();
    if (!_callbacks) return;
    const { settings } = _callbacks.getState();

    const sectionOptions = [
        { id: SPECIAL_GROUPS.CHARACTER, name: '角色世界书', color: '#9b72cf' },
        ...(settings.groups || []).map((g) => ({ id: g.id, name: g.name, color: g.color || '#5b8def' })),
        { id: SPECIAL_GROUPS.UNGROUPED, name: '未分组', color: '#8c99a6' },
    ];
    const renderChips = (targetKey, selectedIds) => {
        const set = new Set(Array.isArray(selectedIds) ? selectedIds : []);
        return sectionOptions.map((sec) => {
            const active = set.has(sec.id);
            return `
                <button type="button"
                    class="wbo-local-cat-btn${active ? ' is-selected' : ''}"
                    data-qe-target="${esc(targetKey)}"
                    data-qe-gid="${esc(sec.id)}"
                    aria-pressed="${active ? 'true' : 'false'}">
                    <span class="wbo-local-cat-mark">${active ? '<i class="fa-solid fa-check"></i>' : ''}</span>
                    <span class="wbo-pill-dot" style="background:${esc(sec.color)}"></span>
                    <span>${esc(sec.name)}</span>
                </button>
            `;
        }).join('');
    };

    const backdrop = document.createElement('div');
    backdrop.id = 'wbo-quick-exclude-backdrop';
    backdrop.className = 'wbo-vis-backdrop';

    const pop = document.createElement('div');
    pop.className = 'wbo-modal wbo-mp-popover wbo-qe-popover';
    if (settings.outsideDropdownFollowHostTheme !== false) {
        pop.classList.add(detectHostThemeClass());
        pop.setAttribute('data-wbo-palette', 'host');
    } else {
        applyThemeClass(pop);
    }

    pop.innerHTML = `
        <div class="wbo-qe-head">
            <span>下拉框默认排除分组</span>
            <button type="button" class="wbo-icon-btn wbo-qe-close" aria-label="关闭"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="wbo-qe-body">
            <div class="wbo-exclude-block">
                <div class="wbo-exclude-head">
                    <span>全局激活框</span>
                    <span class="wbo-ai-quick-picks">
                        <button type="button" class="wbo-link-btn" data-qe-preset="char-only" data-qe-scope="globalHiddenGroupIds">仅角色书</button>
                        <button type="button" class="wbo-link-btn" data-qe-preset="clear" data-qe-scope="globalHiddenGroupIds">清空</button>
                    </span>
                </div>
                <div class="wbo-local-cats">${renderChips('globalHiddenGroupIds', settings.globalHiddenGroupIds)}</div>
            </div>
            <div class="wbo-local-divider"></div>
            <div class="wbo-exclude-block">
                <div class="wbo-exclude-head">
                    <span>编辑下拉框</span>
                    <span class="wbo-ai-quick-picks">
                        <button type="button" class="wbo-link-btn" data-qe-preset="copy-global" data-qe-scope="editorHiddenGroupIds">同全局</button>
                        <button type="button" class="wbo-link-btn" data-qe-preset="char-only" data-qe-scope="editorHiddenGroupIds">仅角色书</button>
                        <button type="button" class="wbo-link-btn" data-qe-preset="clear" data-qe-scope="editorHiddenGroupIds">清空</button>
                    </span>
                </div>
                <div class="wbo-local-cats">${renderChips('editorHiddenGroupIds', settings.editorHiddenGroupIds)}</div>
            </div>
        </div>
        <div class="wbo-qe-foot">
            <button type="button" class="wbo-btn wbo-qe-foot-btn" id="wbo-qe-open-mgr">
                <i class="fa-solid fa-layer-group"></i> 分组管理
            </button>
            <button type="button" class="wbo-btn wbo-qe-foot-btn" id="wbo-qe-open-search">
                <i class="fa-solid fa-magnifying-glass"></i> 搜条目
            </button>
        </div>
    `;

    backdrop.appendChild(pop);
    document.body.appendChild(backdrop);

    const rect = anchorEl.getBoundingClientRect();
    const vw = globalThis.innerWidth || document.documentElement.clientWidth || 390;
    const vh = globalThis.innerHeight || document.documentElement.clientHeight || 800;
    const popW = Math.min(340, vw - 20);
    const left = Math.max(10, Math.min(rect.right - popW, vw - popW - 10));
    const spaceBelow = vh - rect.bottom - 14;
    const spaceAbove = rect.top - 14;
    const openAbove = spaceBelow < 220 && spaceAbove > spaceBelow;
    pop.style.width = `${Math.round(popW)}px`;
    pop.style.left = `${Math.round(left)}px`;
    pop.style.maxHeight = `${Math.max(200, Math.min(420, Math.floor((openAbove ? spaceAbove : spaceBelow) - 6)))}px`;
    if (openAbove) {
        pop.style.bottom = `${Math.round(vh - rect.top + 6)}px`;
        pop.style.top = 'auto';
    } else {
        pop.style.top = `${Math.round(rect.bottom + 6)}px`;
        pop.style.bottom = 'auto';
    }

    const syncUi = () => {
        const cur = _callbacks?.getState?.()?.settings || settings;
        for (const key of ['globalHiddenGroupIds', 'editorHiddenGroupIds']) {
            const set = new Set(Array.isArray(cur[key]) ? cur[key] : []);
            pop.querySelectorAll(`[data-qe-target="${key}"]`).forEach((btn) => {
                const gid = btn.getAttribute('data-qe-gid') || '';
                const active = set.has(gid);
                btn.classList.toggle('is-selected', active);
                btn.setAttribute('aria-pressed', active ? 'true' : 'false');
                const mark = btn.querySelector('.wbo-local-cat-mark');
                if (mark) mark.innerHTML = active ? '<i class="fa-solid fa-check"></i>' : '';
            });
        }
    };

    pop.addEventListener('click', (ev) => ev.stopPropagation());
    pop.querySelector('.wbo-qe-close')?.addEventListener('click', closeGroupVisibilityPopover);
    backdrop.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (ev.target === backdrop) closeGroupVisibilityPopover();
    });

    pop.querySelectorAll('[data-qe-target]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            if (!_callbacks) return;
            const key = btn.getAttribute('data-qe-target');
            const gid = btn.getAttribute('data-qe-gid');
            if (!key || !gid) return;
            const cur = _callbacks.getState().settings;
            const set = new Set(Array.isArray(cur[key]) ? cur[key] : []);
            if (set.has(gid)) set.delete(gid);
            else set.add(gid);
            cur[key] = [...set];
            if (set.size > 0 && cur.showCharBooks) cur.showCharBooks = false;
            if (gid === SPECIAL_GROUPS.CHARACTER) {
                cur.hideCharBooksByDefault =
                    (Array.isArray(cur.globalHiddenGroupIds) && cur.globalHiddenGroupIds.includes(SPECIAL_GROUPS.CHARACTER)) ||
                    (Array.isArray(cur.editorHiddenGroupIds) && cur.editorHiddenGroupIds.includes(SPECIAL_GROUPS.CHARACTER));
            }
            syncUi();
            await _callbacks.onMutation({ save: true });
        });
    });

    pop.querySelectorAll('[data-qe-preset]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            if (!_callbacks) return;
            const preset = btn.getAttribute('data-qe-preset');
            const scopeKey = btn.getAttribute('data-qe-scope');
            if (!preset || !scopeKey) return;
            const cur = _callbacks.getState().settings;
            if (preset === 'clear') {
                cur[scopeKey] = [];
            } else if (preset === 'char-only') {
                cur[scopeKey] = [SPECIAL_GROUPS.CHARACTER];
                cur.showCharBooks = false;
            } else if (preset === 'copy-global') {
                cur[scopeKey] = Array.isArray(cur.globalHiddenGroupIds) ? [...cur.globalHiddenGroupIds] : [];
                if (cur[scopeKey].length > 0) cur.showCharBooks = false;
            }
            cur.hideCharBooksByDefault =
                (Array.isArray(cur.globalHiddenGroupIds) && cur.globalHiddenGroupIds.includes(SPECIAL_GROUPS.CHARACTER)) ||
                (Array.isArray(cur.editorHiddenGroupIds) && cur.editorHiddenGroupIds.includes(SPECIAL_GROUPS.CHARACTER));
            syncUi();
            await _callbacks.onMutation({ save: true });
        });
    });

    pop.querySelector('#wbo-qe-open-mgr')?.addEventListener('click', () => {
        closeGroupVisibilityPopover();
        openManagerModal();
    });
    pop.querySelector('#wbo-qe-open-search')?.addEventListener('click', () => {
        closeGroupVisibilityPopover();
        openEntrySearchModal('');
    });
}

/**
 * Quick 2-checkbox anchored popover right beneath a group header's eye icon so users
 * can toggle global/editor dropdown exclusion for any group in 1 tap without opening Settings.
 * @param {HTMLElement} anchorBtn
 * @param {string} groupId
 * @param {string} groupName
 */
function openGroupVisibilityPopover(anchorBtn, groupId, groupName) {
    closeGroupVisibilityPopover();
    if (!_callbacks) return;
    const { settings } = _callbacks.getState();

    const gHidden = Array.isArray(settings.globalHiddenGroupIds) && settings.globalHiddenGroupIds.includes(groupId);
    const eHidden = Array.isArray(settings.editorHiddenGroupIds) && settings.editorHiddenGroupIds.includes(groupId);

    const backdrop = document.createElement('div');
    backdrop.id = 'wbo-vis-popover-backdrop';
    backdrop.className = 'wbo-vis-backdrop';

    const pop = document.createElement('div');
    pop.className = 'wbo-modal wbo-vis-popover';
    applyThemeClass(pop);
    pop.innerHTML = `
        <div class="wbo-vis-title">${esc(groupName)}</div>
        <label class="wbo-check-line">
            <input type="checkbox" data-vis-scope="globalHiddenGroupIds"${gHidden ? ' checked' : ''}>
            <span>全局激活框隐藏</span>
        </label>
        <label class="wbo-check-line">
            <input type="checkbox" data-vis-scope="editorHiddenGroupIds"${eHidden ? ' checked' : ''}>
            <span>编辑下拉框隐藏</span>
        </label>
    `;

    backdrop.appendChild(pop);
    document.body.appendChild(backdrop);

    const rect = anchorBtn.getBoundingClientRect();
    const vw = globalThis.innerWidth || document.documentElement.clientWidth || 390;
    const vh = globalThis.innerHeight || document.documentElement.clientHeight || 800;
    const popW = 196;
    const left = Math.max(10, Math.min(rect.right - popW, vw - popW - 10));
    const openAbove = vh - rect.bottom < 130 && rect.top > 130;
    pop.style.width = `${popW}px`;
    pop.style.left = `${Math.round(left)}px`;
    if (openAbove) {
        pop.style.bottom = `${Math.round(vh - rect.top + 4)}px`;
        pop.style.top = 'auto';
    } else {
        pop.style.top = `${Math.round(rect.bottom + 4)}px`;
        pop.style.bottom = 'auto';
    }

    pop.addEventListener('click', (ev) => ev.stopPropagation());
    backdrop.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (ev.target === backdrop) closeGroupVisibilityPopover();
    });

    pop.querySelectorAll('input[data-vis-scope]').forEach((cb) => {
        cb.addEventListener('change', async () => {
            if (!(cb instanceof HTMLInputElement) || !_callbacks) return;
            const scopeKey = cb.getAttribute('data-vis-scope');
            if (!scopeKey) return;
            const cur = _callbacks.getState().settings;
            const set = new Set(Array.isArray(cur[scopeKey]) ? cur[scopeKey] : []);
            if (cb.checked) {
                set.add(groupId);
                if (cur.showCharBooks) cur.showCharBooks = false;
            } else {
                set.delete(groupId);
            }
            cur[scopeKey] = [...set];
            if (groupId === SPECIAL_GROUPS.CHARACTER) {
                cur.hideCharBooksByDefault =
                    (Array.isArray(cur.globalHiddenGroupIds) && cur.globalHiddenGroupIds.includes(SPECIAL_GROUPS.CHARACTER)) ||
                    (Array.isArray(cur.editorHiddenGroupIds) && cur.editorHiddenGroupIds.includes(SPECIAL_GROUPS.CHARACTER));
            }
            await _callbacks.onMutation({ save: true });
        });
    });
}

/**
 * Compact mobile overflow popover (`···`) for secondary worldbook row actions
 * (rename/note, move group, delete) so rows stay clean and single-line on phones.
 * @param {HTMLElement} anchorBtn
 * @param {object} bookMeta
 */
function openBookMorePopover(anchorBtn, bookMeta) {
    closeGroupVisibilityPopover();
    if (!bookMeta?.realName) return;

    const backdrop = document.createElement('div');
    backdrop.id = 'wbo-vis-popover-backdrop';
    backdrop.className = 'wbo-vis-backdrop';

    const pop = document.createElement('div');
    pop.className = 'wbo-modal wbo-vis-popover wbo-book-more-popover';
    applyThemeClass(pop);
    pop.innerHTML = `
        <button type="button" class="wbo-book-more-item" data-more-act="edit-book">
            <i class="fa-solid fa-arrow-up-right-from-square"></i><span>在编辑器中打开</span>
        </button>
        <button type="button" class="wbo-book-more-item" data-more-act="rename-alias">
            <i class="fa-solid fa-pen-to-square"></i><span>编辑名称与备注</span>
        </button>
        <button type="button" class="wbo-book-more-item" data-more-act="move-group">
            <i class="fa-solid fa-folder-open"></i><span>移动分组</span>
        </button>
        <div class="wbo-book-more-divider"></div>
        <button type="button" class="wbo-book-more-item is-danger" data-more-act="delete-single-book">
            <i class="fa-regular fa-trash-can"></i><span>删除世界书</span>
        </button>
    `;

    backdrop.appendChild(pop);
    document.body.appendChild(backdrop);

    const rect = anchorBtn.getBoundingClientRect();
    const vw = globalThis.innerWidth || document.documentElement.clientWidth || 390;
    const vh = globalThis.innerHeight || document.documentElement.clientHeight || 800;
    const popW = 164;
    const left = Math.max(10, Math.min(rect.right - popW, vw - popW - 10));
    const openAbove = vh - rect.bottom < 184 && rect.top > 184;
    pop.style.width = `${popW}px`;
    pop.style.left = `${Math.round(left)}px`;
    if (openAbove) {
        pop.style.bottom = `${Math.round(vh - rect.top + 4)}px`;
        pop.style.top = 'auto';
    } else {
        pop.style.top = `${Math.round(rect.bottom + 4)}px`;
        pop.style.bottom = 'auto';
    }

    const onKeyDown = (ev) => {
        if (ev.key === 'Escape') {
            ev.stopPropagation();
            cleanup();
        }
    };
    const cleanup = () => {
        document.removeEventListener('keydown', onKeyDown, true);
        closeGroupVisibilityPopover();
    };
    document.addEventListener('keydown', onKeyDown, true);

    pop.addEventListener('click', (ev) => ev.stopPropagation());
    backdrop.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (ev.target === backdrop) cleanup();
    });

    pop.querySelectorAll('[data-more-act]').forEach((btn) => {
        btn.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            const act = btn.getAttribute('data-more-act');
            cleanup();
            if (act === 'edit-book') {
                openWorldInNativeEditor(bookMeta.realName);
                closeManagerModal();
            } else if (act === 'rename-alias') {
                openAliasNoteModal(bookMeta);
            } else if (act === 'move-group') {
                openMoveGroupModal(bookMeta);
            } else if (act === 'delete-single-book') {
                await confirmAndDeleteWorldbooks([bookMeta.realName]);
            }
        });
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

    const { overlay, modal } = createSubModal(
        '搜索世界书条目',
        `
            <div class="wbo-es-top">
                <div class="wbo-search-wrap wbo-es-input-wrap">
                    <i class="fa-solid fa-magnifying-glass"></i>
                    <input type="search" class="wbo-search-input" id="wbo-es-query" value="${esc(initialQuery)}" placeholder="输入关键词，如：第二人称、防抢话" autocomplete="off" spellcheck="false">
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
                    ${scopeOptions.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('')}
                </select>
                <div class="wbo-es-checks">
                    <label class="wbo-check-line">
                        <input type="checkbox" id="wbo-es-in-title" checked>
                        <span>标题与触发词</span>
                    </label>
                    <label class="wbo-check-line">
                        <input type="checkbox" id="wbo-es-in-content" checked>
                        <span>正文内容</span>
                    </label>
                    <label class="wbo-check-line">
                        <input type="checkbox" id="wbo-es-inc-disabled" checked>
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

            <div class="wbo-es-results" id="wbo-es-results">
                <div class="wbo-empty-hint">输入关键词开始搜索</div>
            </div>
        `,
        { wide: true },
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
            if (queryInput instanceof HTMLInputElement) queryInput.focus();
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
                                <button type="button" class="wbo-link-btn wbo-es-jump-uid" data-es-open="${esc(worldName)}" data-es-uid="${esc(h.uid)}">定位条目</button>
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
                        <button type="button" class="wbo-btn wbo-es-open-btn" data-es-open="${esc(worldName)}">
                            <i class="fa-solid fa-arrow-up-right-from-square"></i> 编辑
                        </button>
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
    queryInput?.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
            ev.preventDefault();
            void runSearch();
        }
    });
    resultsEl?.addEventListener('click', (ev) => {
        const btn = ev.target instanceof Element ? ev.target.closest('[data-es-open]') : null;
        if (!btn) return;
        ev.preventDefault();
        ev.stopPropagation();
        const worldName = btn.getAttribute('data-es-open');
        const uid = btn.getAttribute('data-es-uid');
        if (!worldName) return;
        if (activeSignal) activeSignal.cancelled = true;
        openWorldInNativeEditor(worldName, { focusUid: uid || null });
        closeSubModal();
        closeManagerModal();
    });

    if (autoRun && String(initialQuery).trim()) {
        setTimeout(() => { void runSearch(); }, 30);
    } else if (queryInput instanceof HTMLInputElement && (globalThis.innerWidth || 999) > 680) {
        setTimeout(() => queryInput.focus(), 20);
    }
}

/**
 * Remove all DOM nodes mounted by this panel module cleanly.
 */
export function teardownPanels() {
    cancelManagerInlineEntrySearch();
    closeGroupVisibilityPopover();
    clearTimeout(_mgrSearchTimer);
    _mgrSearchTimer = null;
    _charBtnWidthObserver?.disconnect();
    _charBtnWidthObserver = null;
    closeSubModal();
    closeManagerModal();
    document.getElementById(CHAR_TOGGLE_BTN_ID)?.remove();
    document.getElementById(WI_QUICK_ACTIONS_ID)?.remove();
    document.getElementById('wbo-header-bar')?.remove();
    document.getElementById(WAND_ENTRY_ID)?.remove();
    document.getElementById(SETTINGS_ROOT_ID)?.remove();
}
