/**
 * Worldbook Organizer — Zero-footprint `#WorldInfo` header controls +
 * standalone sticky-header Group Manager modal + collapsible API channels +
 * full character-worldbook coverage scan modal.
 */

import {
    AI_ORGANIZE_CATEGORY_PRESETS,
    AI_ORGANIZE_NAMING_PRESETS,
    DEFAULT_LOCAL_ORGANIZE_CATEGORY_IDS,
    GROUP_COLOR_PALETTE,
    LOCAL_ORGANIZE_CATEGORIES,
    SPECIAL_GROUPS,
    addCustomGroup,
    analyzeSensitiveOrganizeState,
    applyAiOrganizeProposals,
    buildAiOrganizePrompt,
    buildLocalOrganizeProposals,
    cleanupDeletedWorldSettings,
    classifyWorldbooks,
    compareWorldbookEntries,
    computeScanPromptState,
    createApiChannelId,
    deepClone,
    deleteAiOrganizePreset,
    deleteGlobalPreset,
    exportConfigData,
    extractEmbeddedCharacterBookPreview,
    findCardsWithUnimportedBooks,
    findMatchingGlobalPreset,
    findSensitiveTargetGroup,
    findUnscannedShallowCharacters,
    getEffectiveAiOrganizePresets,
    getVisibleSectionMoveBounds,
    importConfigData,
    isPotentiallySensitiveTitle,
    matchesSearch,
    migrateSettingsOnWorldRename,
    moveBooksToNamedGroup,
    moveGlobalPreset,
    moveSectionOrder,
    parseAiOrganizeResponse,
    partitionGroupPickerBooks,
    promoteSectionToTop,
    pushUndoSnapshot,
    reorderBookInGroup,
    reorderSection,
    resetAiOrganizePresets,
    restoreOrganizeSnapshot,
    searchEntriesInPayload,
    summarizeCharacterWorldCoverage,
    summarizePersonaWorldBindings,
    togglePinnedBook,
    undoLastAiOrganize,
    updateCachedCharBindings,
    upsertAiOrganizePreset,
    upsertGlobalPreset,
} from './core.js';
import {
    applyTauriSurface,
    callCustomApiForOrganize,
    callHostAiForOrganize,
    deleteWorldbooksFromHost,
    discardPendingRenamedEventsForRollback,
    fetchCustomApiModels,
    fetchFullCharacterOnDemand,
    fetchWorldbookCluesOnDemand,
    fetchWorldbookPreviewEntries,
    flushWorldInfoListRefresh,
    getActiveGlobalWorldSet,
    getCharactersInMemory,
    getCurrentEditorWorldName,
    getHostContext,
    getPowerUserSettings,
    getWorldNames,
    importEmbeddedWorldbookForCharacter,
    openCharacterByAvatar,
    realRenameWorldbook,
    saveSettings,
    scanShallowCharactersInBatches,
    searchWorldbookEntriesStream,
    showToast,
    unbindExtraWorldbookFromChar,
    unbindPrimaryWorldbookFromChar,
    unbindWorldbookFromPersona,
} from './host.js';
import { mountEntryAccordion } from './entry-accordion.js';
import {
    closeAllOpenWorldDropdowns,
    openWorldInNativeEditor,
    setGlobalWorldActive,
    setGlobalWorldsBatch,
} from './native-filter.js';

const CHAR_TOGGLE_BTN_ID = 'wbo-hdr-show-char';
const WI_QUICK_ACTIONS_ID = 'wbo-wi-quick-actions';
const WAND_ENTRY_ID = 'wbo-wand-entry';
const SETTINGS_ROOT_ID = 'wbo-extension-settings';
const MANAGER_OVERLAY_ID = 'wbo-manager-overlay';
const GROUP_MGR_OVERLAY_ID = 'wbo-gm-floating-overlay';
const SUBMODAL_OVERLAY_ID = 'wbo-submodal-overlay';
const PROMPT_OVERLAY_ID = 'wbo-prompt-overlay';

let _searchQuery = '';
let _lastEntrySearchQuery = '';
let _isComposing = false;
let _callbacks = null;
let _lastModalListSig = null;
let _batchMode = false;
let _mgrPillsExpanded = false;
let _mgrSearchTimer = null;
/** @type {{ left?: number, top?: number, width: number, height: number } | null} */
let _sessionManagerModalBox = null;
/** @type {(() => void) | null} */
let _syncFloatingGroupManager = null;
/** @type {{ prevBooks: string[], label: string } | null} */
let _lastGlobalSwitchUndo = null;
/** @type {{ cancelled: boolean } | null} */
let _mgrInlineEntrySignal = null;
/** @type {MutationObserver | null} */
let _charBtnWidthObserver = null;
/** @type {Set<string>} */
const _batchSelected = new Set();
/** @type {Map<string, string[]>} */
const _renderedGroupBooksMap = new Map();
/** @type {Map<string, { total: number, enabledCount: number, entries: Array<any> }>} */
const _previewCache = new Map();
/** @type {Map<string, any>} */
const _activePreviewControllers = new Map();
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
export function invalidatePreviewCache(worldName = null) {
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

function isDesktopAutoFocusAllowed() {
    const w = globalThis.innerWidth || (typeof document !== 'undefined' ? document.documentElement?.clientWidth : 0) || 0;
    const coarse = typeof globalThis.matchMedia === 'function' && globalThis.matchMedia('(pointer: coarse)').matches;
    return w > 680 && !coarse;
}

function bindImeSafeEnter(inputEl, onEnter, { preventDefault = true } = {}) {
    if (!(inputEl instanceof HTMLElement) || typeof onEnter !== 'function') return;
    let composing = false;
    inputEl.addEventListener('compositionstart', () => { composing = true; });
    inputEl.addEventListener('compositionend', () => { composing = false; });
    inputEl.addEventListener('keydown', (ev) => {
        if (ev.isComposing || ev.keyCode === 229 || composing) return;
        if (ev.key === 'Enter') {
            if (preventDefault) ev.preventDefault();
            onEnter(ev);
        }
    });
}

const UNDO_SVG = '<svg class="wbo-undo-svg" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>';

function isEntryGroupsInstalled() {
    if (typeof document === 'undefined') return false;
    const ctx = getHostContext();
    const disabledList = ctx?.extensionSettings?.disabledExtensions;
    if (Array.isArray(disabledList) && disabledList.some((x) => String(x).includes('worldbook-entry-groups'))) {
        return false;
    }
    return Boolean(
        document.getElementById('weg-wand-entry') ||
        document.getElementById('weg-native-entry-btn') ||
        document.querySelector('link[data-weg-style-ver], link[href*="worldbook-entry-groups/"]'),
    );
}

function getEntryGroupsSummary(worldName) {
    if (!isEntryGroupsInstalled()) return [];
    const ctx = getHostContext();
    const groups = ctx?.extensionSettings?.worldbook_entry_groups?.books?.[worldName]?.groups;
    return Array.isArray(groups) ? groups : [];
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
    document.querySelectorAll('.wbo-modal, #wbo-restore-pill').forEach((el) => {
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
 * Mount clean, theme-native shortcut buttons on the right side of `#WorldInfo`'s top title row:
 * - Default `'merged'` mode: 1 compact `快捷` button opening the fixed-size Quick Hub (`全局组合 | 排除分组` + `搜条目 / 分组管理`)
 * - Optional `'split'` mode: user-selectable `组合` / `排除` / `搜条目` buttons
 * - Optional `'off'` mode: zero top-bar buttons
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
        <div id="wbo-wi-merged-btn" class="menu_button wbo-wi-quick-btn" role="button" tabindex="0" title="切换全局世界书组合、设置排除分组或搜条目">
            <i class="fa-solid fa-sliders"></i>
            <span>快捷</span>
        </div>
        <div id="wbo-wi-combo-btn" class="menu_button wbo-wi-quick-btn" role="button" tabindex="0" title="快速切换或保存全局世界书组合" hidden>
            <i class="fa-solid fa-bookmark"></i>
            <span>组合</span>
        </div>
        <div id="wbo-wi-exclude-btn" class="menu_button wbo-wi-quick-btn" role="button" tabindex="0" title="快速设置全局框与编辑框默认排除的分组" hidden>
            <i class="fa-solid fa-filter"></i>
            <span>排除</span>
        </div>
        <div id="wbo-wi-entry-search-btn" class="menu_button wbo-wi-quick-btn" role="button" tabindex="0" title="跨世界书按需搜索条目内容" hidden>
            <i class="fa-solid fa-magnifying-glass"></i>
            <span>搜条目</span>
        </div>
    `;
    headerRow.appendChild(box);

    const mergedBtn = box.querySelector('#wbo-wi-merged-btn');
    mergedBtn?.addEventListener('click', (ev) => {
        ev.stopPropagation();
        closeAllOpenWorldDropdowns();
        if (mergedBtn instanceof HTMLElement) {
            openQuickHubPopover(mergedBtn);
        }
    });

    const comboBtn = box.querySelector('#wbo-wi-combo-btn');
    comboBtn?.addEventListener('click', (ev) => {
        ev.stopPropagation();
        closeAllOpenWorldDropdowns();
        if (comboBtn instanceof HTMLElement) {
            openQuickHubPopover(comboBtn, { forceTab: 'presets' });
        }
    });

    const excludeBtn = box.querySelector('#wbo-wi-exclude-btn');
    excludeBtn?.addEventListener('click', (ev) => {
        ev.stopPropagation();
        closeAllOpenWorldDropdowns();
        if (excludeBtn instanceof HTMLElement) {
            openQuickHubPopover(excludeBtn, { forceTab: 'exclude' });
        }
    });

    box.querySelector('#wbo-wi-entry-search-btn')?.addEventListener('click', (ev) => {
        ev.stopPropagation();
        closeAllOpenWorldDropdowns();
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
 * Sync ONLY the native `#WorldInfo` header shortcut buttons & char-toggle icon
 * without touching or re-rendering the Group Manager modal.
 */
export function syncNativeQuickActionsUi() {
    if (!_callbacks) return;
    const showCharBtn = ensureHeaderBar();

    const { settings, classification } = _callbacks.getState();

    // Sync native WorldInfo title-bar shortcut buttons (`快捷`三合一 or `组合` / `排除` / `搜条目`分开显示)
    const quickBox = document.getElementById(WI_QUICK_ACTIONS_ID);
    if (quickBox) {
        const mode = settings.nativeQuickActionsMode || 'merged';
        const showMerged = mode === 'merged';
        const showCombo = mode === 'split' && settings.showNativeComboBtn !== false;
        const showExclude = mode === 'split' && settings.showNativeExcludeBtn !== false;
        const showEntrySearch = mode === 'split' && settings.showNativeEntrySearchBtn !== false;

        const mgBtn = quickBox.querySelector('#wbo-wi-merged-btn');
        const cbBtn = quickBox.querySelector('#wbo-wi-combo-btn');
        const exBtn = quickBox.querySelector('#wbo-wi-exclude-btn');
        const esBtn = quickBox.querySelector('#wbo-wi-entry-search-btn');

        if (mgBtn instanceof HTMLElement) mgBtn.hidden = !showMerged;
        if (cbBtn instanceof HTMLElement) cbBtn.hidden = !showCombo;
        if (exBtn instanceof HTMLElement) exBtn.hidden = !showExclude;
        if (esBtn instanceof HTMLElement) esBtn.hidden = !showEntrySearch;
        quickBox.hidden = !(showMerged || showCombo || showExclude || showEntrySearch);
        syncNativeQuickComboTitles();
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
}

/**
 * Sync the native inline char-toggle icon AND the Group Manager modal (ONLY if open — 0 work when closed!).
 */
export function renderEmbeddedPanel({ backgroundCatchUp = false } = {}) {
    if (!_callbacks) return;
    syncNativeQuickActionsUi();

    // Only refresh Group Manager when it is actually open (0 background scanning when closed!)
    if (document.getElementById(MANAGER_OVERLAY_ID)) {
        refreshManagerModalContent({ backgroundCatchUp });
    }
}

function syncNativeQuickComboTitles() {
    if (!_callbacks) return;
    const { settings } = _callbacks.getState();
    const activeGlobals = getActiveGlobalWorldSet();
    const matched = findMatchingGlobalPreset(settings.globalPresets, activeGlobals);
    const mergedBtn = document.getElementById('wbo-wi-merged-btn');
    const comboBtn = document.getElementById('wbo-wi-combo-btn');
    const comboSuffix = matched
        ? `（当前组合：${matched.name} · 已开 ${activeGlobals.size} 本）`
        : (activeGlobals.size > 0 ? `（当前已开 ${activeGlobals.size} 本全局书）` : '');
    if (mergedBtn instanceof HTMLElement) {
        mergedBtn.title = `快捷面板${comboSuffix}：全局组合 / 排除分组 / 搜条目`;
        mergedBtn.classList.toggle('is-active', Boolean(matched));
    }
    if (comboBtn instanceof HTMLElement) {
        comboBtn.title = `全局世界书组合${comboSuffix}`;
        comboBtn.classList.toggle('is-active', Boolean(matched));
    }
}

/**
 * Sync the Group Manager's top `组合` button badge.
 */
function syncManagerComboStripUi() {
    const overlay = document.getElementById(MANAGER_OVERLAY_ID);
    if (!overlay || !_callbacks) return;
    const { settings } = _callbacks.getState();
    const presets = Array.isArray(settings.globalPresets) ? settings.globalPresets : [];
    const activeGlobals = getActiveGlobalWorldSet();
    const matched = findMatchingGlobalPreset(presets, activeGlobals);

    const comboBtn = overlay.querySelector('#wbo-mgr-combo-btn');
    const comboLbl = overlay.querySelector('#wbo-mgr-combo-label');
    if (comboBtn instanceof HTMLElement) {
        comboBtn.classList.toggle('is-active', Boolean(matched));
        comboBtn.title = matched
            ? `全局组合（当前生效：${matched.name}）`
            : '自由组合全局世界书并保存方案';
    }
    if (comboLbl) {
        comboLbl.textContent = presets.length > 0 ? `组合 ${presets.length}` : '组合';
    }
}

/**
 * Apply a Global Worldbook Combo (or clear/undo) in one batch and update all indicators.
 * @param {Iterable<string>} targetBooks
 * @param {{ mode?: 'replace' | 'add', label?: string, recordUndo?: boolean }} [opts]
 */
function executeGlobalBooksSwitch(targetBooks, { mode = 'replace', label = '切换组合', recordUndo = true } = {}) {
    const res = setGlobalWorldsBatch(targetBooks, { mode });
    if (!res.ok) {
        showToast('warning', '未找到原生全局世界书选择框 (#world_info)');
        return res;
    }
    if (res.changed && recordUndo) {
        _lastGlobalSwitchUndo = {
            prevBooks: res.prevActive,
            label,
        };
    }
    syncNativeQuickComboTitles();
    syncEmbeddedPanelIndicators();
    return res;
}

let _isSyncingEmbeddedIndicators = false;

/**
 * Lightweight in-place sync when native `#world_info` or `#world_editor_select` changes.
 * Updates both per-row global pills AND group header active counts with zero DOM rebuild!
 */
export function syncEmbeddedPanelIndicators() {
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
    const entryGroups = getEntryGroupsSummary(book.realName);
    const entryGroupsTag = entryGroups.length > 0
        ? `<span class="wbo-tag" title="条目分组已配置 ${entryGroups.length} 个分组">${entryGroups.length} 组</span>`
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
                            ${entryGroupsTag}
                        </span>
                        ${noteHtml}
                    </span>
                </div>
                <div class="wbo-book-actions">
                    ${globalBtnHtml}
                    ${isEntryGroupsInstalled() ? `
                    <button type="button" class="wbo-icon-btn wbo-book-action-secondary" data-action="open-entry-groups" title="条目分组">
                        <i class="fa-solid fa-folder-tree"></i>
                    </button>` : ''}
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
                    <button type="button"
                        class="wbo-icon-btn wbo-star-btn${book.isPinned ? ' is-pinned' : ''}"
                        data-action="toggle-pin-book"
                        title="${book.isPinned ? '取消置顶' : '置顶'}"
                        aria-pressed="${book.isPinned ? 'true' : 'false'}">
                        <i class="${book.isPinned ? 'fa-solid' : 'fa-regular'} fa-star"></i>
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
        extraHeaderActionsHtml: '',
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
    const visActionBtn = id === SPECIAL_GROUPS.PINNED
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

const RESTORE_PILL_ID = 'wbo-restore-pill';
/** @type {WeakMap<HTMLElement, () => void>} */
const _modalWindowCleanupMap = new WeakMap();
/** @type {Array<{ el: HTMLElement, top: number }>} */
let _minimizedScrollSnapshots = [];

/**
 * Prevent `mousedown`, `touchstart`, and `click` events inside floating roots
 * from bubbling to `document.documentElement` (`<html>`), which SillyTavern uses
 * to auto-collapse unpinned `.openDrawer`s. Always bubble phase (`false`) so
 * child inputs, scrolling, and clicks keep working cleanly.
 * @param {HTMLElement | null} rootEl
 */
function bindDrawerSafeBubbleGuard(rootEl) {
    if (!(rootEl instanceof HTMLElement) || rootEl.dataset.wboBubbleGuarded === '1') return;
    rootEl.dataset.wboBubbleGuarded = '1';
    const stopBubble = (ev) => ev.stopPropagation();
    rootEl.addEventListener('mousedown', stopBubble, false);
    rootEl.addEventListener('touchstart', stopBubble, { capture: false, passive: true });
    rootEl.addEventListener('click', stopBubble, false);
}

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

function minimizeManagerModal() {
    const overlay = document.getElementById(MANAGER_OVERLAY_ID);
    if (!(overlay instanceof HTMLElement)) return;

    // Snapshot scroll positions of scrollable containers so hiding via display:none preserves 100% scroll offset
    const snaps = [];
    const listEl = overlay.querySelector('#wbo-mgr-groups-list');
    if (listEl instanceof HTMLElement) snaps.push({ el: listEl, top: listEl.scrollTop });
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
    let initialBox = null;
    if (vw > 680) {
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
                <div class="wbo-subtle-tip">删除或解除分组仅取消归类，世界书本体不会被删除，相关世界书将回到「未分组」。可一边浏览底层世界书与条目，一边在此调整分组。</div>
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
    const gmWinCleanup = attachModalWindowControls(modal, modal.querySelector('.wbo-modal-header'), { initialBox });
    _modalWindowCleanupMap.set(modal, gmWinCleanup);

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
            <div class="wbo-modal-footer wbo-footer-pair">
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
 * Enable unified desktop `PointerEvent` header dragging and 8-direction invisible edge/corner
 * resizing with fixed top/left anchoring (zero flex-center rebound!) and session box memory.
 * @param {HTMLElement} modal
 * @param {HTMLElement | null} handleEl
 * @param {{ initialBox?: { left?: number, top?: number, width?: number, height?: number } | null }} [opts]
 * @returns {() => void}
 */
function attachModalWindowControls(modal, handleEl, { initialBox = null } = {}) {
    if (!modal || !handleEl) return () => {};

    let posLeft = 0;
    let posTop = 0;
    let hasFixedPos = false;
    let dragging = false;
    let resizing = false;
    let resizeDir = '';
    let startX = 0;
    let startY = 0;
    let baseLeft = 0;
    let baseTop = 0;
    let dragW = 0;
    let startRect = null;

    const getBounds = () => {
        const vw = Math.max(globalThis.innerWidth || document.documentElement?.clientWidth || 1200, 280);
        const vh = Math.max(globalThis.innerHeight || document.documentElement?.clientHeight || 800, 320);
        const isMobile = vw <= 680;
        const minW = isMobile ? Math.min(310, Math.max(240, vw - 16)) : 340;
        const minH = isMobile ? 250 : 280;
        const maxW = isMobile ? Math.max(minW, Math.round(vw - 16)) : Math.max(minW, vw);
        const maxH = isMobile ? Math.max(minH, Math.round(vh - 16)) : Math.max(minH, vh);
        return { vw, vh, isMobile, minW, minH, maxW, maxH };
    };

    const applyFixedPosition = (left, top) => {
        posLeft = Math.round(left);
        posTop = Math.round(top);
        hasFixedPos = true;
        modal.classList.add('is-positioned');
        modal.style.left = `${posLeft}px`;
        modal.style.top = `${posTop}px`;
        modal.style.transform = 'none';
    };

    const pinToFixedPosition = () => {
        const { isMobile } = getBounds();
        if (isMobile || hasFixedPos) return;
        const rect = modal.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        applyFixedPosition(rect.left, rect.top);
    };

    const saveManagerBoxSession = () => {
        if (!modal.classList.contains('wbo-manager-modal') || getBounds().isMobile) return;
        const r = modal.getBoundingClientRect();
        if (r.width >= 300 && r.height >= 260) {
            _sessionManagerModalBox = {
                left: hasFixedPos ? posLeft : Math.round(r.left),
                top: hasFixedPos ? posTop : Math.round(r.top),
                width: Math.round(r.width),
                height: Math.round(r.height),
            };
        }
    };

    const clampIntoViewport = () => {
        const { vw, vh, isMobile, minW, minH, maxW, maxH } = getBounds();
        if (isMobile) return;

        if (modal.classList.contains('is-resized')) {
            const curRect = modal.getBoundingClientRect();
            const clampedW = Math.max(minW, Math.min(maxW, Math.round(curRect.width || minW)));
            const clampedH = Math.max(minH, Math.min(maxH, Math.round(curRect.height || minH)));
            modal.style.width = `${clampedW}px`;
            modal.style.height = `${clampedH}px`;
            modal.style.maxHeight = `${clampedH}px`;
            modal.style.setProperty('--wbo-stable-h', `${clampedH}px`);
        }

        const rect = modal.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        const visibleHeaderMin = Math.min(100, Math.max(56, Math.round(rect.width * 0.35)));
        let nextLeft = hasFixedPos ? posLeft : Math.round(rect.left);
        let nextTop = hasFixedPos ? posTop : Math.round(rect.top);
        let changed = false;

        if (nextLeft + rect.width < visibleHeaderMin) {
            nextLeft = visibleHeaderMin - rect.width;
            changed = true;
        } else if (nextLeft > vw - visibleHeaderMin) {
            nextLeft = vw - visibleHeaderMin;
            changed = true;
        }
        if (nextTop < 0) {
            nextTop = 0;
            changed = true;
        } else if (nextTop > vh - 48) {
            nextTop = Math.max(0, vh - 48);
            changed = true;
        }
        if (changed && hasFixedPos) {
            applyFixedPosition(nextLeft, nextTop);
        }
    };

    // Initialize desktop fixed anchoring & optional initial/saved box
    const initBounds = getBounds();
    if (!initBounds.isMobile) {
        if (modal.classList.contains('wbo-manager-modal') && _sessionManagerModalBox) {
            const savedW = Math.max(initBounds.minW, Math.min(initBounds.maxW, _sessionManagerModalBox.width));
            const savedH = Math.max(initBounds.minH, Math.min(initBounds.maxH, _sessionManagerModalBox.height));
            modal.classList.add('is-resized');
            modal.style.width = `${savedW}px`;
            modal.style.height = `${savedH}px`;
            modal.style.maxHeight = `${savedH}px`;
            modal.style.setProperty('--wbo-stable-h', `${savedH}px`);
            if (Number.isFinite(_sessionManagerModalBox.left) && Number.isFinite(_sessionManagerModalBox.top)) {
                applyFixedPosition(_sessionManagerModalBox.left, _sessionManagerModalBox.top);
            } else {
                pinToFixedPosition();
            }
            clampIntoViewport();
        } else if (initialBox && Number.isFinite(initialBox.width) && Number.isFinite(initialBox.height)) {
            const w = Math.max(initBounds.minW, Math.min(initBounds.maxW, Math.round(initialBox.width)));
            const h = Math.max(initBounds.minH, Math.min(initBounds.maxH, Math.round(initialBox.height)));
            modal.classList.add('is-resized');
            modal.style.width = `${w}px`;
            modal.style.height = `${h}px`;
            modal.style.maxHeight = `${h}px`;
            modal.style.setProperty('--wbo-stable-h', `${h}px`);
            if (Number.isFinite(initialBox.left) && Number.isFinite(initialBox.top)) {
                applyFixedPosition(initialBox.left, initialBox.top);
            } else {
                pinToFixedPosition();
            }
            clampIntoViewport();
        } else {
            pinToFixedPosition();
        }
    }

    handleEl.addEventListener('pointerdown', (ev) => {
        if (ev.pointerType === 'mouse' && ev.button !== 0) return;
        const target = ev.target instanceof Element ? ev.target : null;
        if (target?.closest('button, input, select, textarea, a, label, .wbo-resize-edge')) return;
        if (getBounds().isMobile) return;

        pinToFixedPosition();
        dragging = true;
        startX = ev.clientX;
        startY = ev.clientY;
        baseLeft = posLeft;
        baseTop = posTop;
        dragW = modal.getBoundingClientRect().width || 360;
        modal.classList.add('is-dragging-modal');
        try { handleEl.setPointerCapture(ev.pointerId); } catch { /* ignore */ }
        ev.preventDefault();
    });

    handleEl.addEventListener('pointermove', (ev) => {
        if (!dragging) return;
        const { vw, vh } = getBounds();
        const visibleHeaderMin = Math.min(100, Math.max(56, Math.round(dragW * 0.35)));
        const minLeft = -(dragW - visibleHeaderMin);
        const maxLeft = vw - visibleHeaderMin;
        const maxTop = Math.max(0, vh - 48);

        const nextLeft = Math.max(minLeft, Math.min(maxLeft, baseLeft + (ev.clientX - startX)));
        const nextTop = Math.max(0, Math.min(maxTop, baseTop + (ev.clientY - startY)));
        applyFixedPosition(nextLeft, nextTop);
    });

    const endDrag = (ev) => {
        if (!dragging) return;
        dragging = false;
        modal.classList.remove('is-dragging-modal');
        try { handleEl.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
        saveManagerBoxSession();
    };
    handleEl.addEventListener('pointerup', endDrag);
    handleEl.addEventListener('pointercancel', endDrag);

    // 8 invisible natural edge & corner resize hotzones (hidden on mobile & prompt modals via CSS)
    const resizeDirs = ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se'];
    if (!modal.classList.contains('wbo-prompt-modal')) {
        for (const dir of resizeDirs) {
            if (modal.querySelector(`.wbo-resize-edge[data-resize-dir="${dir}"]`)) continue;
            const edge = document.createElement('div');
            edge.className = `wbo-resize-edge wbo-resize-${dir}`;
            edge.setAttribute('data-resize-dir', dir);
            modal.appendChild(edge);

            edge.addEventListener('pointerdown', (ev) => {
                if (ev.pointerType === 'mouse' && ev.button !== 0) return;
                if (getBounds().isMobile) return;
                ev.stopPropagation();
                ev.preventDefault();
                pinToFixedPosition();
                const rect = modal.getBoundingClientRect();
                resizing = true;
                resizeDir = dir;
                startX = ev.clientX;
                startY = ev.clientY;
                startRect = {
                    left: hasFixedPos ? posLeft : Math.round(rect.left),
                    top: hasFixedPos ? posTop : Math.round(rect.top),
                    right: Math.round((hasFixedPos ? posLeft : rect.left) + rect.width),
                    bottom: Math.round((hasFixedPos ? posTop : rect.top) + rect.height),
                    width: Math.round(rect.width),
                    height: Math.round(rect.height),
                };
                modal.classList.add('is-resizing-modal');
                try { edge.setPointerCapture(ev.pointerId); } catch { /* ignore */ }
            });

            edge.addEventListener('pointermove', (ev) => {
                if (!resizing || resizeDir !== dir || !startRect) return;
                const { vw, vh, minW, minH, maxW, maxH } = getBounds();
                const dxPtr = ev.clientX - startX;
                const dyPtr = ev.clientY - startY;

                let nextLeft = startRect.left;
                let nextTop = startRect.top;
                let nextW = startRect.width;
                let nextH = startRect.height;

                if (dir.includes('e')) {
                    const availW = startRect.left >= 0 ? Math.min(maxW, vw - startRect.left) : maxW;
                    nextW = Math.round(Math.max(minW, Math.min(Math.max(minW, availW), startRect.width + dxPtr)));
                } else if (dir.includes('w')) {
                    const availW = Math.min(maxW, startRect.right);
                    nextW = Math.round(Math.max(minW, Math.min(Math.max(minW, availW), startRect.width - dxPtr)));
                    nextLeft = startRect.right - nextW;
                }

                if (dir.includes('s')) {
                    const availH = Math.min(maxH, vh - startRect.top);
                    nextH = Math.round(Math.max(minH, Math.min(Math.max(minH, availH), startRect.height + dyPtr)));
                } else if (dir.includes('n')) {
                    const availH = Math.min(maxH, startRect.bottom);
                    nextH = Math.round(Math.max(minH, Math.min(Math.max(minH, availH), startRect.height - dyPtr)));
                    nextTop = startRect.bottom - nextH;
                }

                modal.classList.add('is-resized');
                modal.style.width = `${nextW}px`;
                modal.style.height = `${nextH}px`;
                modal.style.maxHeight = `${nextH}px`;
                modal.style.setProperty('--wbo-stable-h', `${nextH}px`);
                if (dir.includes('w') || dir.includes('n')) {
                    applyFixedPosition(nextLeft, nextTop);
                }
            });

            const endResize = (ev) => {
                if (!resizing || resizeDir !== dir) return;
                resizing = false;
                resizeDir = '';
                startRect = null;
                modal.classList.remove('is-resizing-modal');
                try { edge.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
                clampIntoViewport();
                saveManagerBoxSession();
            };
            edge.addEventListener('pointerup', endResize);
            edge.addEventListener('pointercancel', endResize);
        }
    }

    const onViewportChange = () => {
        if (!modal.isConnected) return;
        const { isMobile } = getBounds();
        if (isMobile) {
            hasFixedPos = false;
            modal.classList.remove('is-positioned');
            modal.style.left = '';
            modal.style.top = '';
            modal.style.transform = '';
            return;
        }
        pinToFixedPosition();
        clampIntoViewport();
    };
    globalThis.addEventListener('resize', onViewportChange);
    globalThis.addEventListener('orientationchange', onViewportChange);

    return () => {
        globalThis.removeEventListener('resize', onViewportChange);
        globalThis.removeEventListener('orientationchange', onViewportChange);
    };
}

/**
 * Open the standalone Group Manager modal (zero space occupied in `#WorldInfo` when closed!).
 */
export function openManagerModal() {
    if (!_callbacks) return;
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
    _mgrPillsExpanded = Boolean(_callbacks.getState()?.settings?.groupPanelExpanded);

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
                <div class="wbo-modal-header-actions">
                    <button type="button" class="wbo-icon-btn wbo-modal-settings-btn" data-action="open-settings-modal" title="显示与行为设置" aria-label="设置">
                        <i class="fa-solid fa-gear"></i>
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
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Isolate modal events from SillyTavern's unpinned-drawer auto-closer, and close ONLY via the `×` button!
    bindDrawerSafeBubbleGuard(modal);
    const cleanupWinCtrl = attachModalWindowControls(modal, modal.querySelector('.wbo-modal-header'));
    _modalWindowCleanupMap.set(modal, cleanupWinCtrl);
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
            if (!_mgrPillsExpanded && Math.abs(ev.deltaY) > Math.abs(ev.deltaX) && pillsRow.scrollWidth > pillsRow.clientWidth) {
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

    modal.addEventListener('dragstart', (ev) => {
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
    });

    modal.addEventListener('dragover', (ev) => {
        if (!dragState) return;
        const target = ev.target instanceof Element ? ev.target : null;
        if (!target) return;

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
    });

    modal.addEventListener('drop', async (ev) => {
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

            const targetGroupId = validPillGid || (dropGroupId && dropGroupId !== SPECIAL_GROUPS.PINNED ? dropGroupId : null);
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
    });

    modal.addEventListener('dragend', () => {
        clearTempDraggable();
        clearDropHighlights();
        dragState = null;
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
                    if (collapsedEl instanceof HTMLElement) {
                        collapsedEl.scrollIntoView({ block: 'nearest' });
                    }
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
                _mgrPillsExpanded = !_mgrPillsExpanded;
                settings.groupPanelExpanded = _mgrPillsExpanded;
                const subbar = modal.querySelector('.wbo-mgr-subbar');
                const pills = modal.querySelector('#wbo-mgr-pills');
                const expBtn = modal.querySelector('#wbo-mgr-pills-expand');
                subbar?.classList.toggle('is-pills-expanded', _mgrPillsExpanded);
                pills?.classList.toggle('is-expanded', _mgrPillsExpanded);
                if (expBtn instanceof HTMLElement) {
                    expBtn.title = _mgrPillsExpanded ? '收起为单行' : '展开查看全部分组';
                    expBtn.innerHTML = `<i class="fa-solid ${_mgrPillsExpanded ? 'fa-chevron-up' : 'fa-chevron-down'}"></i>`;
                }
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
                if (_lastGlobalSwitchUndo) {
                    const snap = _lastGlobalSwitchUndo;
                    _lastGlobalSwitchUndo = null;
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
                        btn.setAttribute('title', nextPinned ? '取消置顶' : '置顶');
                        const icon = btn.querySelector('i');
                        if (icon) icon.className = `${nextPinned ? 'fa-solid' : 'fa-regular'} fa-star`;
                    });

                    // Update `★ 已置顶` filter pill count in-place
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
                            newPill.innerHTML = `<span>★ 已置顶</span><span class="wbo-pill-count">${classification.pinnedCount}</span>`;
                            const firstPill = pillsEl.querySelector('.wbo-pill');
                            if (firstPill) firstPill.insertAdjacentElement('afterend', newPill);
                            else pillsEl.appendChild(newPill);
                            if (groupBarEl instanceof HTMLElement && groupBarEl.hidden && pillsEl.children.length > 1) {
                                groupBarEl.hidden = false;
                                if (listCreateBtn instanceof HTMLElement) listCreateBtn.hidden = true;
                            }
                        }
                    }

                    await _callbacks.onMutation({ save: true, pinInPlaceOnly: true });
                    showToast('info', nextPinned ? `已置顶「${meta?.primaryTitle || bookName}」` : '已取消置顶');
                }
                break;
            }
            case 'open-entry-groups': {
                const holder = target.closest('.wbo-book-item, .wbo-book-row');
                const bookName = holder?.getAttribute('data-book');
                if (bookName) {
                    openEntryGroupsForBook(bookName);
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
                label: '★ 已置顶',
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
        if (input instanceof HTMLInputElement && isDesktopAutoFocusAllowed()) input.focus();
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
    // Read LIVE collapse & hidden-group state from `settings` (never stale cached `classification`!)
    const structSig = JSON.stringify([
        q,
        _batchMode,
        currentEditor || '',
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

    const prevScroll = listEl.scrollTop;
    _renderedGroupBooksMap.clear();
    const activeGlobals = getActiveGlobalWorldSet();
    const hasCustomGroups = classification.customGroups.length > 0;
    const filterId = settings.activeFilterGroupId;
    const isAllView = filterId === SPECIAL_GROUPS.ALL || (filterId === SPECIAL_GROUPS.DEFAULT && settings.showCharBooks);
    const includeCharExplicitly = filterId === SPECIAL_GROUPS.CHARACTER || isAllView;

    /** @type {Array<{ type: 'raw', html: string, isMovable?: boolean } | { type: 'section', id: string, name: string, color: string, collapsed: boolean, isCustom: boolean, isSingleView: boolean, isMovable: boolean, charBookTitleMode?: string, hiddenInGlobal?: boolean, hiddenInEditor?: boolean, books: Array<any> }>} */
    const renderSpecs = [];

    const pushSectionSpec = (sec, { isSingleView = false, isMovable = true, forceOpen = false } = {}) => {
        if (sec.kind === 'custom') {
            const books = q ? sec.books.filter((b) => matchesSearch(b, q, searchOpts)) : sec.books;
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
            const books = q ? sec.books.filter((b) => matchesSearch(b, q, searchOpts)) : sec.books;
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
                name: '★ 已置顶',
                color: '#e09f3e',
                collapsed: false,
                isCustom: false,
                isSingleView: true,
                isMovable: false,
                books: pinnedList,
            });
        } else {
            renderSpecs.push({
                type: 'raw',
                html: `<div class="wbo-empty-hint">${q ? '已置顶中无匹配世界书' : '暂无已置顶的世界书，点击书行右侧 ★ 即可置顶'}</div>`,
            });
        }
    } else if (isAllView) {
        const pinnedList = q
            ? (classification.pinnedBooks || []).filter((b) => matchesSearch(b, q, searchOpts))
            : (classification.pinnedBooks || []);
        if (pinnedList.length > 0) {
            const charSec = orderedSections.find((s) => s.kind === 'character');
            if (charSec) {
                pushSectionSpec(charSec, { isSingleView: false, isMovable: false });
            }
            renderSpecs.push({
                type: 'section',
                id: SPECIAL_GROUPS.PINNED,
                name: '★ 已置顶',
                color: '#e09f3e',
                collapsed: Boolean(q) ? false : Boolean(settings.pinnedGroupCollapsed),
                isCustom: false,
                isSingleView: false,
                isMovable: false,
                books: pinnedList,
            });
            orderedSections.forEach((sec) => {
                if (sec.kind !== 'character') {
                    pushSectionSpec(sec, { isSingleView: false, isMovable: true });
                }
            });
        } else {
            orderedSections.forEach((sec) => {
                pushSectionSpec(sec, { isSingleView: false, isMovable: true });
            });
        }
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

    listEl.scrollTop = prevScroll;
    syncBatchBarUi();
    return true;
}

// ==================== Sub-Modals (stack above Manager Modal) ====================

/** @type {HTMLElement[]} */
const _subModalStack = [];

function prunePreviewCacheAfterSubModal() {
    const expandedBooks = new Set();
    document.querySelectorAll(`#${MANAGER_OVERLAY_ID} .wbo-book-item[data-book]`).forEach((item) => {
        const preview = item.querySelector('.wbo-book-preview');
        const name = item.getAttribute('data-book');
        if (name && preview instanceof HTMLElement && !preview.hidden) {
            expandedBooks.add(name);
        }
    });
    for (const key of [..._previewCache.keys()]) {
        if (!expandedBooks.has(key)) {
            _previewCache.delete(key);
        }
    }
}

function cleanupOverlayWindowControls(overlayEl) {
    if (!(overlayEl instanceof HTMLElement)) return;
    const m = overlayEl.querySelector('.wbo-modal');
    if (m instanceof HTMLElement) {
        const fn = _modalWindowCleanupMap.get(m);
        if (typeof fn === 'function') {
            fn();
            _modalWindowCleanupMap.delete(m);
        }
    }
}

function closeSubModal(opts = null) {
    const promptOverlay = document.getElementById(PROMPT_OVERLAY_ID);
    if (promptOverlay) {
        cleanupOverlayWindowControls(promptOverlay);
        promptOverlay.remove();
    }
    const closeAll = Boolean(opts && opts.all === true);
    if (closeAll) {
        while (_subModalStack.length > 0) {
            const top = _subModalStack.pop();
            cleanupOverlayWindowControls(top);
            top?.remove();
        }
        document.querySelectorAll(`#${SUBMODAL_OVERLAY_ID}, .wbo-submodal-overlay`).forEach((el) => {
            cleanupOverlayWindowControls(el);
            el.remove();
        });
        prunePreviewCacheAfterSubModal();
        return;
    }

    const specific = opts?.overlay instanceof HTMLElement ? opts.overlay : null;
    if (specific) {
        const idx = _subModalStack.lastIndexOf(specific);
        if (idx >= 0) _subModalStack.splice(idx, 1);
        cleanupOverlayWindowControls(specific);
        specific.remove();
    } else if (_subModalStack.length > 0) {
        const top = _subModalStack.pop();
        cleanupOverlayWindowControls(top);
        top?.remove();
    } else {
        const el = document.getElementById(SUBMODAL_OVERLAY_ID);
        cleanupOverlayWindowControls(el);
        el?.remove();
    }
    if (_subModalStack.length === 0) {
        prunePreviewCacheAfterSubModal();
    }
    document.getElementById('wbo-mgr-scan-btn')?.blur?.();
}

/**
 * Lightweight in-plugin text prompt submodal (safe replacement for `window.prompt()`
 * in iOS WKWebView / TauriTavern).
 * @param {{ title?: string, label?: string, initialValue?: string, placeholder?: string, confirmText?: string, cancelText?: string }} [opts]
 * @returns {Promise<string | null>}
 */
function openInlineTextPrompt({
    title = '输入内容',
    label = '',
    initialValue = '',
    placeholder = '请输入...',
    confirmText = '确定',
    cancelText = '取消',
} = {}) {
    document.getElementById(PROMPT_OVERLAY_ID)?.remove();
    return new Promise((resolve) => {
        let settled = false;
        const finish = (val) => {
            if (settled) return;
            settled = true;
            document.removeEventListener('keydown', onEsc, true);
            cleanupOverlayWindowControls(overlay);
            overlay.remove();
            resolve(val);
        };

        const overlay = document.createElement('div');
        overlay.id = PROMPT_OVERLAY_ID;
        overlay.className = 'wbo-modal-overlay wbo-prompt-overlay';
        applyTauriSurface(overlay, 'backdrop');

        const modal = document.createElement('div');
        modal.className = 'wbo-modal wbo-prompt-modal';
        applyThemeClass(modal);
        applyTauriSurface(modal, 'fullscreen-window');

        modal.innerHTML = `
            <div class="wbo-modal-header wbo-draggable-header">
                <div class="wbo-modal-header-top">
                    <span class="wbo-modal-title">${esc(title)}</span>
                    <button type="button" class="wbo-icon-btn wbo-modal-close" aria-label="关闭">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>
            </div>
            <div class="wbo-modal-body">
                <div class="wbo-field">
                    ${label ? `<label class="wbo-label">${esc(label)}</label>` : ''}
                    <div class="wbo-input-clear-row">
                        <input type="text" class="wbo-input" id="wbo-inline-prompt-input" value="${esc(initialValue)}" placeholder="${esc(placeholder)}" autocomplete="off" spellcheck="false">
                        <button type="button" class="wbo-btn wbo-input-clear-btn" id="wbo-inline-prompt-clear" title="清空输入框">清空</button>
                    </div>
                </div>
                <div class="wbo-modal-footer wbo-footer-pair">
                    <button type="button" class="wbo-btn wbo-btn-primary" id="wbo-inline-prompt-ok">${esc(confirmText)}</button>
                    <button type="button" class="wbo-btn" id="wbo-inline-prompt-cancel">${esc(cancelText)}</button>
                </div>
            </div>
        `;

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        bindDrawerSafeBubbleGuard(overlay);
        bindDrawerSafeBubbleGuard(modal);
        const promptWinCleanup = attachModalWindowControls(modal, modal.querySelector('.wbo-modal-header'));
        _modalWindowCleanupMap.set(modal, promptWinCleanup);

        const input = modal.querySelector('#wbo-inline-prompt-input');
        const clearBtn = modal.querySelector('#wbo-inline-prompt-clear');
        const okBtn = modal.querySelector('#wbo-inline-prompt-ok');
        const cancelBtn = modal.querySelector('#wbo-inline-prompt-cancel');
        const closeBtn = modal.querySelector('.wbo-modal-close');

        const confirm = () => {
            const val = input instanceof HTMLInputElement ? input.value.trim() : '';
            if (!val) {
                showToast('warning', '请输入内容');
                if (input instanceof HTMLInputElement && isDesktopAutoFocusAllowed()) {
                    input.focus();
                }
                return;
            }
            finish(val);
        };

        const onEsc = (ev) => {
            if (ev.key === 'Escape') {
                ev.preventDefault();
                ev.stopPropagation();
                finish(null);
            }
        };
        document.addEventListener('keydown', onEsc, true);

        closeBtn?.addEventListener('click', () => finish(null));
        cancelBtn?.addEventListener('click', () => finish(null));
        okBtn?.addEventListener('click', confirm);
        clearBtn?.addEventListener('click', () => {
            if (input instanceof HTMLInputElement) {
                input.value = '';
                if (isDesktopAutoFocusAllowed()) input.focus();
            }
        });
        if (input instanceof HTMLInputElement) {
            bindImeSafeEnter(input, confirm);
            if (isDesktopAutoFocusAllowed()) {
                input.focus();
                input.select();
            }
        }
    });
}

/**
 * Create a sub-modal stacked above the Group Manager modal without closing `#WorldInfo`.
 */
function createSubModal(title, bodyHtml, { wide = false, pinnedLayout = false, stack = false, floating = false } = {}) {
    if (!stack) {
        closeSubModal({ all: true });
    }
    const stackIdx = _subModalStack.length;
    const overlay = document.createElement('div');
    overlay.id = stackIdx === 0 ? SUBMODAL_OVERLAY_ID : `${SUBMODAL_OVERLAY_ID}-${stackIdx}`;
    overlay.className = `wbo-modal-overlay wbo-submodal-overlay${floating ? ' wbo-floating-overlay' : ''}`;
    if (stackIdx > 0) {
        overlay.style.zIndex = String(10020 + stackIdx);
    }
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
                <div class="wbo-modal-header-actions">
                    <button type="button" class="wbo-icon-btn wbo-modal-close" aria-label="关闭">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>
            </div>
        </div>
        <div class="wbo-modal-body${pinnedLayout ? ' wbo-pinned-body' : ''}">${bodyHtml}</div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    _subModalStack.push(overlay);

    // Isolate events from SillyTavern and close ONLY via the `×` / action buttons (never backdrop click!)
    if (!floating) {
        bindDrawerSafeBubbleGuard(overlay);
    }
    bindDrawerSafeBubbleGuard(modal);
    const subWinCleanup = attachModalWindowControls(modal, modal.querySelector('.wbo-modal-header'));
    _modalWindowCleanupMap.set(modal, subWinCleanup);
    modal.querySelector('.wbo-modal-close')?.addEventListener('click', (ev) => {
        ev.stopPropagation();
        closeSubModal({ overlay });
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
            <label class="wbo-ai-pick-row wbo-gp-row" data-gp-row-sec="${esc(sectionKind)}" data-pick-search="${esc(b.searchableText || b.realName.toLowerCase())}">
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
                <div class="wbo-gp-pills" id="wbo-gp-pills">
                    <button type="button" class="wbo-pill" data-gp-pill="ungrouped">
                        <span>未分组</span><span class="wbo-pill-count">${ungroupedBooks.length}</span>
                    </button>
                    <button type="button" class="wbo-pill" data-gp-pill="selected">
                        <span>已选</span><span class="wbo-pill-count" id="wbo-gp-selected-pill-count">${pickedSet.size}</span>
                    </button>
                    <button type="button" class="wbo-pill is-active" data-gp-pill="all">
                        <span>全部</span><span class="wbo-pill-count">${allCandidates.length}</span>
                    </button>
                    ${otherTotalCount > 0 ? `
                        <button type="button" class="wbo-pill" data-gp-pill="other">
                            <span>其他已分组</span><span class="wbo-pill-count">${otherTotalCount}</span>
                        </button>
                    ` : ''}
                </div>
                <div class="wbo-gp-toolbar">
                    <input type="search" class="wbo-input wbo-group-pick-filter" id="wbo-group-pick-filter" placeholder="搜索书名/别名/角色..." autocomplete="off" spellcheck="false">
                    ${ungroupedBooks.length > 0 ? '<button type="button" class="wbo-btn wbo-gp-quick-btn" id="wbo-gp-select-ungrouped-btn">全选当前可见未分组</button>' : ''}
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
        if (visibleUngrouped.length === 0) {
            quickUngroupedBtn.disabled = true;
            quickUngroupedBtn.textContent = '全选当前可见未分组';
            return;
        }
        quickUngroupedBtn.disabled = false;
        const allChecked = visibleUngrouped.every((row) => {
            const cb = row.querySelector('.wbo-group-pick-check');
            return cb instanceof HTMLInputElement && pickedSet.has(cb.value);
        });
        quickUngroupedBtn.textContent = allChecked ? '取消当前可见未分组' : '全选当前可见未分组';
    };

    const applyPickerFilters = () => {
        if (!pickListEl) return;
        const q = pickFilter instanceof HTMLInputElement ? pickFilter.value.trim().toLowerCase() : '';
        const forceOtherOpen = Boolean(q) || activeGpPill === 'other' || activeGpPill === 'selected';
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
            else if (activeGpPill === 'selected') matchPill = Boolean(val && pickedSet.has(val));
            else if (activeGpPill === 'other') matchPill = secKind === 'other';

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
            b.classList.toggle('is-active', b.getAttribute('data-gp-pill') === activeGpPill);
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
 * Global Worldbook Combos Manager & Free-Pick Builder Modal:
 * - View 1 (`list`): manage saved combos, 1-click apply (replace) / overlay (+add), overwrite with current active,
 *   clear all active globals, 1-click undo, reorder, or delete.
 * - View 2 (`edit`): freely combine ANY worldbooks across collapsible groups (or seed from current active globals),
 *   save, or save & immediately activate!
 */
function openGlobalCombosModal({ editPresetId = null, initialMode = null, seedCurrentActive = false } = {}) {
    if (!_callbacks) return;
    let { settings, classification } = _callbacks.getState();

    const startInEdit = Boolean(
        editPresetId ||
        initialMode === 'create' ||
        seedCurrentActive,
    );

    const { modal } = createSubModal(
        '全局世界书组合',
        `
            <div class="wbo-ai-step wbo-cmb-step" id="wbo-cmb-step-list"${startInEdit ? ' hidden' : ''}>
                <div class="wbo-pinned-top wbo-cmb-topbar">
                    <div class="wbo-cmb-live-row">
                        <span class="wbo-cmb-live-info" id="wbo-cmb-live-info"></span>
                        <span class="wbo-cmb-live-actions">
                            <button type="button" class="wbo-btn wbo-sens-undo-btn" id="wbo-cmb-undo-btn" hidden>${UNDO_SVG}<span>撤回切换</span></button>
                            <button type="button" class="wbo-btn" id="wbo-cmb-clear-global-btn">全关当前全局</button>
                        </span>
                    </div>
                    <div class="wbo-cmb-create-row">
                        <button type="button" class="wbo-btn" id="wbo-cmb-save-current-btn">
                            <i class="fa-solid fa-floppy-disk"></i> 存当前全局为组合
                        </button>
                        <button type="button" class="wbo-btn wbo-btn-primary" id="wbo-cmb-free-new-btn">
                            <i class="fa-solid fa-plus"></i> 自由勾选新建组合
                        </button>
                    </div>
                </div>
                <div class="wbo-step-scroll">
                    <div class="wbo-cmb-list" id="wbo-cmb-list"></div>
                </div>
                <div class="wbo-modal-footer wbo-pinned-footer">
                    <span class="wbo-subtle-tip">切换组合只会开关全局激活状态，不会改动世界书内容或分组。</span>
                    <span class="wbo-spacer"></span>
                    <button type="button" class="wbo-btn" id="wbo-cmb-close-btn">完成</button>
                </div>
            </div>

            <div class="wbo-ai-step wbo-cmb-step" id="wbo-cmb-step-edit"${startInEdit ? '' : ' hidden'}>
                <div class="wbo-pinned-top wbo-cmb-edit-top">
                    <div class="wbo-eb-topbar">
                        <button type="button" class="wbo-btn" id="wbo-cmb-back-list-btn">
                            <i class="fa-solid fa-arrow-left"></i> 返回组合列表
                        </button>
                        <span class="wbo-ai-subview-title" id="wbo-cmb-edit-heading">新建全局组合</span>
                        <span class="wbo-spacer"></span>
                        <span class="wbo-tag" id="wbo-cmb-picked-badge">已选 0 本</span>
                    </div>
                    <div class="wbo-cmb-name-bar">
                        <input type="text" class="wbo-input" id="wbo-cmb-name-input" placeholder="输入组合名称，例如：现代日常套、古风通用套、跑团检定套" spellcheck="false">
                        <button type="button" class="wbo-btn" id="wbo-cmb-seed-active-btn" title="把当前全局已开启的世界书勾选进来">填入当前已开</button>
                        <button type="button" class="wbo-btn" id="wbo-cmb-clear-pick-btn">清空勾选</button>
                    </div>
                    <div class="wbo-gp-pills" id="wbo-cmb-pills"></div>
                    <div class="wbo-gp-toolbar">
                        <input type="search" class="wbo-input wbo-group-pick-filter" id="wbo-cmb-book-filter" placeholder="搜索世界书名 / 显示名 / 分组..." autocomplete="off" spellcheck="false">
                        <button type="button" class="wbo-btn wbo-gp-quick-btn" id="wbo-cmb-toggle-visible-btn">全选当前可见</button>
                    </div>
                </div>
                <div class="wbo-step-scroll">
                    <div class="wbo-ai-book-list wbo-cmb-pick-list" id="wbo-cmb-pick-list"></div>
                    <div class="wbo-ai-status" id="wbo-cmb-edit-status"></div>
                </div>
                <div class="wbo-modal-footer wbo-pinned-footer wbo-ai-footer wbo-ai-footer-single">
                    <div class="wbo-ai-footer-left">
                        <button type="button" class="wbo-btn" id="wbo-cmb-cancel-edit-btn">取消</button>
                    </div>
                    <div class="wbo-ai-footer-right">
                        <button type="button" class="wbo-btn" id="wbo-cmb-save-only-btn">仅保存</button>
                        <button type="button" class="wbo-btn wbo-btn-primary" id="wbo-cmb-save-apply-btn">保存并立即启用</button>
                    </div>
                </div>
            </div>
        `,
        { wide: true, pinnedLayout: true, floating: true },
    );

    const stepList = modal.querySelector('#wbo-cmb-step-list');
    const stepEdit = modal.querySelector('#wbo-cmb-step-edit');
    const liveInfoEl = modal.querySelector('#wbo-cmb-live-info');
    const undoBtn = modal.querySelector('#wbo-cmb-undo-btn');
    const clearGlobalBtn = modal.querySelector('#wbo-cmb-clear-global-btn');
    const saveCurrentBtn = modal.querySelector('#wbo-cmb-save-current-btn');
    const listEl = modal.querySelector('#wbo-cmb-list');

    const editHeadingEl = modal.querySelector('#wbo-cmb-edit-heading');
    const pickedBadgeEl = modal.querySelector('#wbo-cmb-picked-badge');
    const nameInput = modal.querySelector('#wbo-cmb-name-input');
    const seedActiveBtn = modal.querySelector('#wbo-cmb-seed-active-btn');
    const pillsEl = modal.querySelector('#wbo-cmb-pills');
    const filterInput = modal.querySelector('#wbo-cmb-book-filter');
    const toggleVisBtn = modal.querySelector('#wbo-cmb-toggle-visible-btn');
    const pickListEl = modal.querySelector('#wbo-cmb-pick-list');
    const editStatusEl = modal.querySelector('#wbo-cmb-edit-status');

    let currentEditId = editPresetId || null;
    /** @type {Set<string>} */
    const pickedSet = new Set();
    let activeEditPill = '__nonchar__';

    const setEditStatus = (msg, isErr = false) => {
        if (!editStatusEl) return;
        editStatusEl.textContent = msg;
        editStatusEl.className = `wbo-ai-status${isErr ? ' is-error' : ''}`;
    };

    const renderListView = () => {
        ({ settings, classification } = _callbacks.getState());
        const presets = Array.isArray(settings.globalPresets) ? settings.globalPresets : [];
        const activeGlobals = getActiveGlobalWorldSet();
        const matched = findMatchingGlobalPreset(presets, activeGlobals);

        if (liveInfoEl) {
            liveInfoEl.innerHTML = matched
                ? `当前已开 <b>${activeGlobals.size}</b> 本全局世界书 · 生效组合：<b>「${esc(matched.name)}」</b>`
                : `当前已开 <b>${activeGlobals.size}</b> 本全局世界书`;
        }
        if (undoBtn instanceof HTMLElement) {
            undoBtn.hidden = !_lastGlobalSwitchUndo;
            if (_lastGlobalSwitchUndo) {
                undoBtn.title = `撤回「${_lastGlobalSwitchUndo.label}」`;
            }
        }
        if (clearGlobalBtn instanceof HTMLButtonElement) {
            clearGlobalBtn.disabled = activeGlobals.size === 0;
        }
        if (saveCurrentBtn instanceof HTMLButtonElement) {
            saveCurrentBtn.disabled = activeGlobals.size === 0;
        }

        if (!listEl) return;
        if (presets.length === 0) {
            listEl.innerHTML = `
                <div class="wbo-empty-hint wbo-qhub-empty">
                    <div class="wbo-qhub-empty-title">还没有保存过全局组合</div>
                    <div class="wbo-qhub-empty-steps">
                        <div>• 点上方<b>「存当前全局为组合」</b>：直接保存当前已开的全局书</div>
                        <div>• 点上方<b>「自由勾选新建组合」</b>：跨分组自由勾选任意世界书</div>
                    </div>
                </div>
            `;
            return;
        }

        listEl.innerHTML = presets.map((p, idx) => {
            const isMatched = matched?.id === p.id;
            const bookTags = p.books.map((realName) => {
                const meta = classification.byName.get(realName);
                const label = meta?.primaryTitle || realName;
                const isOn = activeGlobals.has(realName);
                return `<span class="wbo-tag${isOn ? ' is-on-tag' : ''}" title="${esc(realName)}">${esc(label)}</span>`;
            }).join('');

            return `
                <div class="wbo-card wbo-cmb-card${isMatched ? ' is-active-combo' : ''}" data-cmb-id="${esc(p.id)}">
                    <div class="wbo-cmb-card-head">
                        <div class="wbo-cmb-card-title-wrap">
                            <span class="wbo-cmb-card-name">${esc(p.name)}</span>
                            <span class="wbo-tag">${p.books.length} 本</span>
                            ${isMatched ? '<span class="wbo-tag is-on-tag">当前生效</span>' : ''}
                        </div>
                        <div class="wbo-cmb-card-order">
                            <button type="button" class="wbo-icon-btn" data-cmb-act="up" data-cmb-id="${esc(p.id)}" ${idx === 0 ? 'disabled' : ''} title="上移">
                                <i class="fa-solid fa-arrow-up"></i>
                            </button>
                            <button type="button" class="wbo-icon-btn" data-cmb-act="down" data-cmb-id="${esc(p.id)}" ${idx === presets.length - 1 ? 'disabled' : ''} title="下移">
                                <i class="fa-solid fa-arrow-down"></i>
                            </button>
                        </div>
                    </div>
                    <div class="wbo-cmb-card-books">${bookTags}</div>
                    <div class="wbo-cmb-card-actions">
                        <button type="button" class="wbo-btn wbo-btn-primary" data-cmb-act="apply" data-cmb-id="${esc(p.id)}">
                            <i class="fa-solid fa-bolt"></i> ${isMatched ? '重新应用' : '一键切换'}
                        </button>
                        <button type="button" class="wbo-btn" data-cmb-act="add" data-cmb-id="${esc(p.id)}" title="保留当前已开启的世界书，额外开启本组合中的世界书">
                            + 叠加开启
                        </button>
                        <button type="button" class="wbo-btn" data-cmb-act="overwrite-current" data-cmb-id="${esc(p.id)}" ${activeGlobals.size === 0 ? 'disabled' : ''} title="用当前全局已开启的世界书更新此组合">
                            更新为当前
                        </button>
                        <button type="button" class="wbo-btn" data-cmb-act="edit" data-cmb-id="${esc(p.id)}">
                            <i class="fa-solid fa-pen"></i> 编辑
                        </button>
                        <button type="button" class="wbo-btn wbo-btn-danger" data-cmb-act="delete" data-cmb-id="${esc(p.id)}">
                            <i class="fa-regular fa-trash-can"></i> 删除
                        </button>
                    </div>
                </div>
            `;
        }).join('');
    };

    const syncEditPickedBadge = () => {
        if (pickedBadgeEl) pickedBadgeEl.textContent = `已选 ${pickedSet.size} 本`;
        const selPillCnt = pillsEl?.querySelector('#wbo-cmb-sel-pill-cnt');
        if (selPillCnt) selPillCnt.textContent = String(pickedSet.size);
    };

    const syncToggleVisibleBtn = () => {
        if (!(toggleVisBtn instanceof HTMLButtonElement) || !pickListEl) return;
        const visRows = Array.from(pickListEl.querySelectorAll('.wbo-cmb-pick-row')).filter(
            (r) => r instanceof HTMLElement && !r.hidden,
        );
        if (visRows.length === 0) {
            toggleVisBtn.disabled = true;
            toggleVisBtn.textContent = '全选当前可见';
            return;
        }
        toggleVisBtn.disabled = false;
        const allChecked = visRows.every((r) => {
            const cb = r.querySelector('.wbo-cmb-book-check');
            return cb instanceof HTMLInputElement && pickedSet.has(cb.value);
        });
        toggleVisBtn.textContent = allChecked ? '取消当前可见' : '全选当前可见';
    };

    const applyEditFilters = () => {
        if (!pickListEl) return;
        const q = filterInput instanceof HTMLInputElement ? filterInput.value.trim().toLowerCase() : '';
        let visibleCount = 0;

        pickListEl.querySelectorAll('.wbo-cmb-pick-row').forEach((row) => {
            if (!(row instanceof HTMLElement)) return;
            const gid = row.getAttribute('data-cmb-gid') || '';
            const isChar = row.getAttribute('data-cmb-char') === '1';
            const cb = row.querySelector('.wbo-cmb-book-check');
            const bookName = cb instanceof HTMLInputElement ? cb.value : '';
            const hay = row.getAttribute('data-pick-search') || '';

            let matchPill = true;
            if (activeEditPill === '__nonchar__') {
                matchPill = !isChar || pickedSet.has(bookName);
            } else if (activeEditPill === '__selected__') {
                matchPill = Boolean(bookName && pickedSet.has(bookName));
            } else if (activeEditPill === '__all__') {
                matchPill = true;
            } else {
                matchPill = gid === activeEditPill;
            }

            const matchSearch = !q || hay.includes(q);
            const show = matchPill && matchSearch;
            row.hidden = !show;
            if (show) visibleCount += 1;
        });

        pickListEl.querySelectorAll('.wbo-gp-sec').forEach((sec) => {
            if (!(sec instanceof HTMLElement)) return;
            const hasVis = Array.from(sec.querySelectorAll('.wbo-cmb-pick-row')).some(
                (r) => r instanceof HTMLElement && !r.hidden,
            );
            sec.hidden = !hasVis;
        });

        const emptyEl = pickListEl.querySelector('#wbo-cmb-pick-empty');
        if (emptyEl instanceof HTMLElement) emptyEl.hidden = visibleCount > 0;
        syncToggleVisibleBtn();
    };

    const openEditView = ({ preset = null, seedActive = false } = {}) => {
        ({ settings, classification } = _callbacks.getState());
        currentEditId = preset?.id || null;
        pickedSet.clear();
        const activeGlobals = getActiveGlobalWorldSet();

        if (preset) {
            for (const b of preset.books || []) pickedSet.add(b);
        } else if (seedActive) {
            for (const b of activeGlobals) pickedSet.add(b);
        }

        if (editHeadingEl) {
            editHeadingEl.textContent = preset ? `编辑组合：${preset.name}` : '新建全局组合';
        }
        if (nameInput instanceof HTMLInputElement) {
            nameInput.value = preset?.name || '';
        }
        if (seedActiveBtn instanceof HTMLButtonElement) {
            seedActiveBtn.textContent = `填入当前已开 (${activeGlobals.size})`;
            seedActiveBtn.disabled = activeGlobals.size === 0;
        }
        if (filterInput instanceof HTMLInputElement) {
            filterInput.value = '';
        }
        activeEditPill = '__nonchar__';
        setEditStatus('');

        const orderedSections = classification.orderedSections || [];
        if (pillsEl) {
            const sectionPills = orderedSections
                .filter((s) => (s.books?.length || 0) > 0 && s.kind !== 'character')
                .map((s) => `
                    <button type="button" class="wbo-pill" data-cmb-pill="${esc(s.id)}">
                        ${s.kind === 'custom' ? `<span class="wbo-pill-dot" style="background:${esc(s.color)}"></span>` : ''}
                        <span>${esc(s.name)}</span>
                        <span class="wbo-pill-count">${s.books.length}</span>
                    </button>
                `).join('');
            pillsEl.innerHTML = `
                <button type="button" class="wbo-pill is-active" data-cmb-pill="__nonchar__">
                    <span>非角色书</span><span class="wbo-pill-count">${classification.nonCharCount}</span>
                </button>
                <button type="button" class="wbo-pill" data-cmb-pill="__selected__">
                    <span>已选</span><span class="wbo-pill-count" id="wbo-cmb-sel-pill-cnt">${pickedSet.size}</span>
                </button>
                ${sectionPills}
                ${classification.charCount > 0 ? `
                    <button type="button" class="wbo-pill" data-cmb-pill="__all__">
                        <span>含角色书</span><span class="wbo-pill-count">${classification.totalCount}</span>
                    </button>
                ` : ''}
            `;
        }

        if (pickListEl) {
            const sectionsHtml = orderedSections
                .filter((sec) => (sec.books?.length || 0) > 0)
                .map((sec) => {
                    const rows = sec.books.map((b) => {
                        const checked = pickedSet.has(b.realName) ? ' checked' : '';
                        const isLiveGlobal = activeGlobals.has(b.realName);
                        return `
                            <label class="wbo-ai-pick-row wbo-cmb-pick-row"
                                data-cmb-gid="${esc(sec.id)}"
                                data-cmb-char="${sec.kind === 'character' ? '1' : '0'}"
                                data-pick-search="${esc(b.searchableText || b.realName.toLowerCase())}">
                                <input type="checkbox" class="wbo-cmb-book-check" value="${esc(b.realName)}"${checked}>
                                <span class="wbo-ai-pick-name" title="${esc(b.realName)}">${esc(b.primaryTitle)}${b.subtitle ? ` <small>${esc(b.subtitle)}</small>` : ''}</span>
                                ${isLiveGlobal ? '<span class="wbo-tag is-on-tag">已全局</span>' : ''}
                                <span class="wbo-tag">${esc(b.groupName)}</span>
                            </label>
                        `;
                    }).join('');
                    return `
                        <div class="wbo-gp-sec" data-cmb-sec="${esc(sec.id)}">
                            <div class="wbo-gp-sec-head">
                                <span>${esc(sec.name)} <small>(${sec.books.length})</small></span>
                            </div>
                            <div class="wbo-gp-sec-body">${rows}</div>
                        </div>
                    `;
                }).join('');
            pickListEl.innerHTML = `${sectionsHtml}<div class="wbo-empty-hint" id="wbo-cmb-pick-empty" hidden>无匹配世界书</div>`;
        }

        syncEditPickedBadge();
        applyEditFilters();

        if (stepList instanceof HTMLElement) stepList.hidden = true;
        if (stepEdit instanceof HTMLElement) stepEdit.hidden = false;
        if (nameInput instanceof HTMLInputElement && isDesktopAutoFocusAllowed()) {
            nameInput.focus();
        }
    };

    const showListView = () => {
        renderListView();
        if (stepEdit instanceof HTMLElement) stepEdit.hidden = true;
        if (stepList instanceof HTMLElement) stepList.hidden = false;
    };

    const saveEditedCombo = async ({ applyAfterSave = false } = {}) => {
        const name = nameInput instanceof HTMLInputElement ? nameInput.value.trim() : '';
        const res = upsertGlobalPreset(settings, {
            id: currentEditId,
            name,
            books: pickedSet,
        });
        if (!res.ok) {
            setEditStatus(res.error || '保存失败', true);
            if (!name && nameInput instanceof HTMLInputElement && isDesktopAutoFocusAllowed()) {
                nameInput.focus();
            }
            return;
        }
        await _callbacks.onMutation({ save: true, uiOnly: true });
        if (applyAfterSave && res.preset) {
            const sw = executeGlobalBooksSwitch(res.preset.books, {
                mode: 'replace',
                label: `启用「${res.preset.name}」`,
            });
            if (sw.ok) {
                showToast('success', `已保存并启用组合「${res.preset.name}」（共 ${sw.nextActive.length} 本）`);
            }
        } else if (res.preset) {
            showToast('success', res.created ? `已保存全局组合「${res.preset.name}」` : `已更新组合「${res.preset.name}」`);
        }
        syncManagerComboStripUi();
        syncNativeQuickComboTitles();
        showListView();
    };

    // Wire List View actions
    modal.querySelector('#wbo-cmb-free-new-btn')?.addEventListener('click', () => {
        openEditView({ preset: null, seedActive: false });
    });
    saveCurrentBtn?.addEventListener('click', () => {
        openEditView({ preset: null, seedActive: true });
    });
    clearGlobalBtn?.addEventListener('click', () => {
        const activeGlobals = getActiveGlobalWorldSet();
        if (activeGlobals.size === 0) return;
        const sw = executeGlobalBooksSwitch([], {
            mode: 'replace',
            label: `全关全局 (${activeGlobals.size}本)`,
        });
        if (sw.ok) {
            renderListView();
            showToast('info', `已关闭全部 ${sw.prevActive.length} 本全局世界书（可点「撤回切换」恢复）`);
        }
    });
    undoBtn?.addEventListener('click', () => {
        if (!_lastGlobalSwitchUndo) return;
        const snap = _lastGlobalSwitchUndo;
        _lastGlobalSwitchUndo = null;
        const sw = executeGlobalBooksSwitch(snap.prevBooks, { mode: 'replace', recordUndo: false });
        if (sw.ok) {
            renderListView();
            showToast('info', `已撤回，恢复 ${sw.nextActive.length} 本全局世界书`);
        }
    });

    listEl?.addEventListener('click', async (ev) => {
        const btn = ev.target instanceof Element ? ev.target.closest('[data-cmb-act]') : null;
        if (!btn) return;
        const act = btn.getAttribute('data-cmb-act') || '';
        const id = btn.getAttribute('data-cmb-id') || '';
        const preset = (settings.globalPresets || []).find((p) => p.id === id);
        if (!preset) return;

        if (act === 'apply') {
            const sw = executeGlobalBooksSwitch(preset.books, {
                mode: 'replace',
                label: `启用「${preset.name}」`,
            });
            if (sw.ok) {
                renderListView();
                showToast('success', `已切换至「${preset.name}」（共开启 ${sw.nextActive.length} 本）`);
            }
        } else if (act === 'add') {
            const sw = executeGlobalBooksSwitch(preset.books, {
                mode: 'add',
                label: `叠加「${preset.name}」`,
            });
            if (sw.ok) {
                renderListView();
                showToast('success', `已叠加开启「${preset.name}」（当前共开启 ${sw.nextActive.length} 本）`);
            }
        } else if (act === 'overwrite-current') {
            const activeGlobals = getActiveGlobalWorldSet();
            if (activeGlobals.size === 0) return;
            if (!globalThis.confirm(`确认将组合「${preset.name}」的内容更新为当前已开的 ${activeGlobals.size} 本全局世界书？`)) return;
            upsertGlobalPreset(settings, { id: preset.id, name: preset.name, books: activeGlobals });
            await _callbacks.onMutation({ save: true, uiOnly: true });
            syncManagerComboStripUi();
            renderListView();
            showToast('success', `已将「${preset.name}」更新为当前全局开启的 ${activeGlobals.size} 本`);
        } else if (act === 'edit') {
            openEditView({ preset });
        } else if (act === 'delete') {
            if (!globalThis.confirm(`确认删除全局组合「${preset.name}」？\n（仅删除保存的组合方案，不会关闭或删除世界书本身）`)) return;
            if (deleteGlobalPreset(settings, preset.id)) {
                await _callbacks.onMutation({ save: true, uiOnly: true });
                syncManagerComboStripUi();
                syncNativeQuickComboTitles();
                renderListView();
                showToast('info', `已删除组合「${preset.name}」`);
            }
        } else if (act === 'up' || act === 'down') {
            if (moveGlobalPreset(settings, preset.id, act === 'up' ? -1 : 1)) {
                await _callbacks.onMutation({ save: true, uiOnly: true });
                syncManagerComboStripUi();
                renderListView();
            }
        }
    });

    // Wire Edit View actions
    modal.querySelector('#wbo-cmb-back-list-btn')?.addEventListener('click', showListView);
    modal.querySelector('#wbo-cmb-cancel-edit-btn')?.addEventListener('click', () => {
        if ((settings.globalPresets || []).length === 0 && startInEdit) {
            closeSubModal();
        } else {
            showListView();
        }
    });
    seedActiveBtn?.addEventListener('click', () => {
        const activeGlobals = getActiveGlobalWorldSet();
        for (const name of activeGlobals) pickedSet.add(name);
        pickListEl?.querySelectorAll('.wbo-cmb-book-check').forEach((cb) => {
            if (cb instanceof HTMLInputElement) cb.checked = pickedSet.has(cb.value);
        });
        syncEditPickedBadge();
        applyEditFilters();
    });
    modal.querySelector('#wbo-cmb-clear-pick-btn')?.addEventListener('click', () => {
        pickedSet.clear();
        pickListEl?.querySelectorAll('.wbo-cmb-book-check').forEach((cb) => {
            if (cb instanceof HTMLInputElement) cb.checked = false;
        });
        syncEditPickedBadge();
        applyEditFilters();
    });
    pillsEl?.addEventListener('click', (ev) => {
        const btn = ev.target instanceof Element ? ev.target.closest('[data-cmb-pill]') : null;
        if (!btn) return;
        activeEditPill = btn.getAttribute('data-cmb-pill') || '__nonchar__';
        pillsEl.querySelectorAll('[data-cmb-pill]').forEach((b) => {
            b.classList.toggle('is-active', b.getAttribute('data-cmb-pill') === activeEditPill);
        });
        applyEditFilters();
    });
    pickListEl?.addEventListener('change', (ev) => {
        const cb = ev.target;
        if (!(cb instanceof HTMLInputElement) || !cb.classList.contains('wbo-cmb-book-check')) return;
        if (cb.checked) pickedSet.add(cb.value);
        else pickedSet.delete(cb.value);
        setEditStatus('');
        syncEditPickedBadge();
        if (activeEditPill === '__selected__') applyEditFilters();
        else syncToggleVisibleBtn();
    });
    toggleVisBtn?.addEventListener('click', () => {
        if (!pickListEl) return;
        const visRows = Array.from(pickListEl.querySelectorAll('.wbo-cmb-pick-row')).filter(
            (r) => r instanceof HTMLElement && !r.hidden,
        );
        if (visRows.length === 0) return;
        const allChecked = visRows.every((r) => {
            const cb = r.querySelector('.wbo-cmb-book-check');
            return cb instanceof HTMLInputElement && pickedSet.has(cb.value);
        });
        for (const r of visRows) {
            const cb = r.querySelector('.wbo-cmb-book-check');
            if (!(cb instanceof HTMLInputElement)) continue;
            cb.checked = !allChecked;
            if (!allChecked) pickedSet.add(cb.value);
            else pickedSet.delete(cb.value);
        }
        syncEditPickedBadge();
        syncToggleVisibleBtn();
    });
    if (filterInput instanceof HTMLInputElement) {
        let composing = false;
        filterInput.addEventListener('compositionstart', () => { composing = true; });
        filterInput.addEventListener('compositionend', () => { composing = false; applyEditFilters(); });
        filterInput.addEventListener('input', () => { if (!composing) applyEditFilters(); });
    }

    modal.querySelector('#wbo-cmb-save-only-btn')?.addEventListener('click', () => {
        void saveEditedCombo({ applyAfterSave: false });
    });
    modal.querySelector('#wbo-cmb-save-apply-btn')?.addEventListener('click', () => {
        void saveEditedCombo({ applyAfterSave: true });
    });
    bindImeSafeEnter(nameInput, () => {
        void saveEditedCombo({ applyAfterSave: false });
    });
    modal.querySelector('#wbo-cmb-close-btn')?.addEventListener('click', closeSubModal);

    if (startInEdit) {
        const targetPreset = editPresetId
            ? (settings.globalPresets || []).find((p) => p.id === editPresetId) || null
            : null;
        openEditView({ preset: targetPreset, seedActive: seedCurrentActive });
    } else {
        renderListView();
    }
}

/**
 * AI Smart Worldbook Organizer modal:
 * - Collapsible saved multi-channel API config (cross-device via extensionSettings)
 * - Supports optional real filename normalization when user allows it
 */
function openAiOrganizeModal({ initialTab = null } = {}) {
    if (!_callbacks) return;
    let { settings, classification } = _callbacks.getState();

    const buildBookPool = (cls) => {
        const nonChar = [
            ...cls.ungroupedBooks,
            ...cls.customGroups.flatMap((g) => g.books),
        ];
        return {
            nonCharBooks: nonChar,
            allBooks: [...nonChar, ...cls.characterBooks],
        };
    };
    let { nonCharBooks, allBooks } = buildBookPool(classification);

    if (allBooks.length === 0) {
        showToast('warning', '当前没有可整理的世界书');
        return;
    }

    let activeOrganizeScope = classification.ungroupedBooks.length === 0
        ? 'nonchar'
        : (settings.aiOrganizeScope === 'nonchar' ? 'nonchar' : 'ungrouped');
    const defaultChecked = new Set(
        (activeOrganizeScope === 'ungrouped' ? classification.ungroupedBooks : nonCharBooks).map((b) => b.realName),
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
    for (const sName of sensitiveSet) {
        defaultChecked.delete(sName);
    }

    const renderBookPickRow = (b, checkedSet, isSens) => {
        const checked = checkedSet.has(b.realName) ? 'checked' : '';
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
    };

    const renderAiBookListHtml = (checkedSet, sensState) => {
        const normalRows = sensState.normalBooks.map((b) => renderBookPickRow(b, checkedSet, false)).join('');
        if (sensState.sensitiveBooks.length === 0) {
            return normalRows;
        }
        const sensRows = sensState.sensitiveBooks.map((b) => renderBookPickRow(b, checkedSet, true)).join('');
        const ungroupedSensCount = sensState.ungroupedSensitive.length;
        const groupedSensCount = sensState.groupedSensitive.length;
        const charSensCount = sensState.charSensitive.length;
        const subHint = [
            ungroupedSensCount > 0 ? `未分组 ${ungroupedSensCount} 本` : '',
            groupedSensCount > 0 ? `已归组 ${groupedSensCount} 本` : '',
            charSensCount > 0 ? `角色书 ${charSensCount} 本` : '',
        ].filter(Boolean).join(' · ');
        return `
            ${sensState.normalBooks.length > 0 ? `
                <div class="wbo-ai-pick-section" data-ai-section="normal">
                    <div class="wbo-ai-pick-sec-head">
                        <span>正常世界书 (${sensState.normalBooks.length})</span>
                    </div>
                    ${normalRows}
                </div>
            ` : ''}
            <div class="wbo-ai-pick-section is-sensitive" id="wbo-ai-sens-section" data-ai-section="sensitive">
                <div class="wbo-ai-pick-sec-head">
                    <span>疑似敏感世界书 (${sensState.sensitiveBooks.length})${subHint ? ` <small>${esc(subHint)}</small>` : ''}</span>
                    ${ungroupedSensCount > 0 ? `<button type="button" class="wbo-btn wbo-sens-toggle-btn" data-action-move-nsfw="1">一键归入 NSFW 分组 (${ungroupedSensCount})</button>` : ''}
                </div>
                ${sensRows}
            </div>
        `;
    };

    const initialSensState = analyzeSensitiveOrganizeState({
        allBooks,
        scope: activeOrganizeScope,
        checkedNames: defaultChecked,
    });
    const bookChecksHtml = renderAiBookListHtml(defaultChecked, initialSensState);

    const activeCh = getActiveChannel();
    const startTab = initialTab || (settings.organizeLastTab === 'organize' ? 'organize' : 'local');
    const initialLocalScope = classification.ungroupedBooks.length === 0
        ? 'nonchar'
        : (settings.localOrganizeScope === 'nonchar' ? 'nonchar' : 'ungrouped');
    const initialSavedRules = Array.isArray(settings.localOrganizeCustomRules)
        ? settings.localOrganizeCustomRules
        : [];
    const effectiveAiPresets = getEffectiveAiOrganizePresets(settings);
    const savedPresetIdSet = new Set(Array.isArray(settings.aiOrganizePresetIds) ? settings.aiOrganizePresetIds : []);
    const renderAiPresetChipsGroupHtml = (list) => list.map((p) => {
        const active = savedPresetIdSet.has(p.id);
        return `<button type="button" class="wbo-preset-chip${active ? ' is-active' : ''}" data-preset-cat="${esc(p.cat)}" data-preset-id="${esc(p.id)}" data-preset-text="${esc(p.text)}">${esc(p.label)}</button>`;
    }).join('');
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
                            <input type="radio" name="wbo-local-scope" value="ungrouped"${initialLocalScope === 'ungrouped' ? ' checked' : ''}>
                            <span class="wbo-scope-body">
                                <span class="wbo-scope-title">仅整理未分组 <span class="wbo-tag" data-local-scope-count="ungrouped">${classification.ungroupedBooks.length} 本</span></span>
                                <span class="wbo-scope-desc">保持已有分组不变</span>
                            </span>
                        </label>
                        <label class="wbo-scope-card">
                            <input type="radio" name="wbo-local-scope" value="nonchar"${initialLocalScope === 'nonchar' ? ' checked' : ''}>
                            <span class="wbo-scope-body">
                                <span class="wbo-scope-title">全部非角色书 <span class="wbo-tag" data-local-scope-count="nonchar">${classification.nonCharCount} 本</span></span>
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
                        <input type="checkbox" id="wbo-local-any-prefix"${settings.localOrganizeUseAnyPrefix ? ' checked' : ''}>
                        <span>同时按书名开头的 [分类] / 【分类】 前缀自动建组</span>
                    </label>
                    <label class="wbo-check-line">
                        <input type="checkbox" id="wbo-local-clean-titles"${settings.localOrganizeCleanTitles ? ' checked' : ''}>
                        <span>顺手清理显示名末尾的 (1)、副本、作者署名</span>
                    </label>
                </div>

                <details class="wbo-collapse-box" id="wbo-local-rules-details"${initialSavedRules.length > 0 ? ' open' : ''}>
                    <summary class="wbo-collapse-summary">
                        <span class="wbo-summary-left"><i class="fa-solid fa-chevron-right wbo-details-chev"></i><span>自定义归类关键词</span></span>
                        <span class="wbo-collapse-hint" id="wbo-local-rules-count">可选</span>
                    </summary>
                    <div class="wbo-collapse-body">
                        <div class="wbo-rule-builder-row">
                            <div class="wbo-rule-field">
                                <span class="wbo-rule-field-label">书名关键词</span>
                                <input type="text" class="wbo-input" id="wbo-local-rule-kw" placeholder="如：穿搭、现代" spellcheck="false">
                            </div>
                            <div class="wbo-rule-field">
                                <span class="wbo-rule-field-label">归入分组</span>
                                <input type="text" class="wbo-input" id="wbo-local-rule-grp" list="wbo-existing-groups-datalist" placeholder="如：User 人设" spellcheck="false">
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
                            ${UNDO_SVG} <span id="wbo-local-undo-label">${esc(getUndoButtonLabel())}</span>
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
                    <div class="wbo-sens-banner" id="wbo-sens-banner" ${initialSensState.bannerMode === 'hidden' ? 'hidden' : ''}>
                        <i class="fa-solid fa-triangle-exclamation"></i>
                        <span id="wbo-sens-banner-text">已默认排除 ${initialSensState.ungroupedSensitive.length} 本未分组疑似敏感世界书，避免触发 AI 拒答浪费额度</span>
                        <span class="wbo-sens-banner-actions">
                            <button type="button" class="wbo-btn wbo-sens-toggle-btn" id="wbo-pick-toggle-sens">包含敏感书</button>
                            <button type="button" class="wbo-btn wbo-sens-toggle-btn" id="wbo-sens-move-nsfw-btn" data-action-move-nsfw="1" ${initialSensState.ungroupedSensitive.length > 0 ? '' : 'hidden'}>${esc((() => { const matched = findSensitiveTargetGroup(settings.groups); return matched ? `一键归入「${matched.name}」` : '一键归入 NSFW 分组'; })())}</button>
                        </span>
                    </div>
                    <div class="wbo-sens-confirm-bar" id="wbo-sens-confirm-bar" hidden>
                        <span class="wbo-sens-confirm-text" id="wbo-sens-confirm-text"></span>
                        <span class="wbo-sens-confirm-actions">
                            <button type="button" class="wbo-btn wbo-btn-primary" id="wbo-sens-confirm-ok">确认归入</button>
                            <button type="button" class="wbo-btn" id="wbo-sens-confirm-cancel">取消</button>
                        </span>
                    </div>
                    <div class="wbo-sens-result-bar" id="wbo-sens-result-bar" hidden>
                        <span class="wbo-sens-result-text" id="wbo-sens-result-text"></span>
                        <button type="button" class="wbo-btn wbo-sens-undo-btn" id="wbo-sens-inline-undo">${UNDO_SVG}<span>撤回</span></button>
                    </div>
                    <input type="search" class="wbo-input wbo-ai-book-filter" id="wbo-ai-book-filter" placeholder="搜索筛选世界书..." autocomplete="off" spellcheck="false">
                    <div class="wbo-ai-book-list" id="wbo-ai-book-list">${bookChecksHtml}</div>
                </div>

                <div class="wbo-card wbo-ai-card">
                    <div class="wbo-ai-section-head">
                        <span>2. 选择风格</span>
                        <span class="wbo-ai-quick-picks">
                            <button type="button" class="wbo-link-btn" id="wbo-ai-save-as-preset-btn">+ 存为预设</button>
                            <button type="button" class="wbo-link-btn" id="wbo-ai-manage-presets-btn">修改/管理预设</button>
                        </span>
                    </div>
                    <div class="wbo-ai-options">
                        <div class="wbo-preset-rows" id="wbo-ai-preset-rows">
                            <div class="wbo-preset-group">
                                <span class="wbo-preset-label">分类方式</span>
                                <div class="wbo-preset-chips-grid" id="wbo-ai-cat-presets-grid">
                                    ${renderAiPresetChipsGroupHtml(effectiveAiPresets.categoryPresets)}
                                </div>
                            </div>
                            <div class="wbo-preset-group">
                                <span class="wbo-preset-label">命名与自定义</span>
                                <div class="wbo-preset-chips-grid" id="wbo-ai-name-presets-grid">
                                    ${renderAiPresetChipsGroupHtml(effectiveAiPresets.namingPresets)}
                                </div>
                            </div>
                        </div>
                        <textarea class="wbo-textarea wbo-rule-textarea" id="wbo-ai-custom-rule" rows="2" placeholder="可选：点上方预设自动填入，也可直接修改文案并点右上角「+ 存为预设」..." spellcheck="false">${esc(settings.aiOrganizeCustomRule || '')}</textarea>
                        <div class="wbo-ai-save-preset-bar" id="wbo-ai-save-preset-bar" hidden>
                            <input type="text" class="wbo-input" id="wbo-ai-new-preset-label" placeholder="预设名称，例如：我的跑团分类法" spellcheck="false">
                            <select class="wbo-select wbo-inline-select" id="wbo-ai-new-preset-cat">
                                <option value="group">归入「分类方式」</option>
                                <option value="custom">归入「命名与自定义」</option>
                            </select>
                            <button type="button" class="wbo-btn wbo-btn-primary" id="wbo-ai-confirm-save-preset">保存预设</button>
                            <button type="button" class="wbo-btn" id="wbo-ai-cancel-save-preset">取消</button>
                        </div>

                        <details class="wbo-collapse-box"${settings.aiOrganizeIncludeClues ? ' open' : ''}>
                            <summary class="wbo-collapse-summary">
                                <span class="wbo-summary-left"><i class="fa-solid fa-chevron-right wbo-details-chev"></i><span>高级选项（读取条目摘要 / 修改真实文件名）</span></span>
                            </summary>
                            <div class="wbo-collapse-body">
                                <div class="wbo-clue-block">
                                    <label class="wbo-check-line">
                                        <input type="checkbox" id="wbo-ai-include-clues"${settings.aiOrganizeIncludeClues ? ' checked' : ''}>
                                        <span>附带书内条目摘要辅助归类</span>
                                    </label>
                                    <div class="wbo-clue-subrow${settings.aiOrganizeIncludeClues ? '' : ' is-disabled'}" id="wbo-ai-clue-subrow">
                                        <span class="wbo-clue-field">
                                            <span>读取条数</span>
                                            <input type="number" class="wbo-input wbo-inline-num" id="wbo-ai-clue-count" value="${Number(settings.aiOrganizeClueCount || 5)}" min="1" max="15"${settings.aiOrganizeIncludeClues ? '' : ' disabled'}>
                                            <span>条</span>
                                        </span>
                                        <span class="wbo-clue-field">
                                            <span>摘要内容</span>
                                            <select class="wbo-select wbo-inline-select" id="wbo-ai-snippet-len"${settings.aiOrganizeIncludeClues ? '' : ' disabled'}>
                                                <option value="50"${Number(settings.aiOrganizeSnippetLen ?? 50) === 50 ? ' selected' : ''}>标题 + 50字摘要</option>
                                                <option value="120"${Number(settings.aiOrganizeSnippetLen) === 120 ? ' selected' : ''}>标题 + 120字摘要</option>
                                                <option value="0"${Number(settings.aiOrganizeSnippetLen) === 0 ? ' selected' : ''}>仅标题与关键词</option>
                                            </select>
                                        </span>
                                    </div>
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

                <div class="wbo-refusal-box" id="wbo-ai-refusal-box" hidden></div>
                <div class="wbo-ai-status" id="wbo-ai-status"></div>
                </div>

                <div class="wbo-modal-footer wbo-ai-footer wbo-pinned-footer">
                    <div class="wbo-ai-footer-left">
                        <button type="button" class="wbo-btn" id="wbo-ai-undo-btn" ${hasUndo ? '' : 'hidden'} title="恢复到上一次整理前的分组与显示名">
                            ${UNDO_SVG} <span id="wbo-ai-undo-label">${esc(getUndoButtonLabel())}</span>
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

            <div class="wbo-ai-step" id="wbo-ai-step-external" hidden>
                <div class="wbo-pinned-top">
                    <div class="wbo-eb-topbar">
                        <button type="button" class="wbo-btn" id="wbo-external-back-btn">
                            <i class="fa-solid fa-arrow-left"></i> 返回 AI 整理
                        </button>
                        <span class="wbo-ai-subview-title">外部 AI 整理（免 API 额度）</span>
                    </div>
                </div>
                <div class="wbo-step-scroll">
                    <div class="wbo-card">
                        <div class="wbo-ai-section-head">
                            <span>两步完成外部 AI 归类</span>
                        </div>
                        <div class="wbo-subtle-tip">1. 点击下方「复制提示词」发给任意外部 AI；<br>2. 把 AI 返回的 JSON 粘贴到下方文本框，点击「解析并预览」。</div>
                        <textarea class="wbo-textarea wbo-external-json-textarea" id="wbo-ai-json-input" rows="10" placeholder='在此粘贴外部 AI 返回的 JSON 结果...' spellcheck="false"></textarea>
                    </div>
                    <div class="wbo-refusal-box" id="wbo-external-refusal-box" hidden></div>
                    <div class="wbo-ai-status" id="wbo-external-status"></div>
                </div>
                <div class="wbo-modal-footer wbo-pinned-footer wbo-footer-pair">
                    <button type="button" class="wbo-btn" id="wbo-ai-copy-prompt-btn">
                        <i class="fa-regular fa-copy"></i> 复制提示词
                    </button>
                    <button type="button" class="wbo-btn wbo-btn-primary" id="wbo-ai-parse-paste-btn">解析并预览</button>
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
                        <input type="text" class="wbo-input" id="wbo-api-name" value="${esc(activeCh?.name || '')}" placeholder="配置名称，例如：常用通道 1" spellcheck="false">
                        <input type="text" class="wbo-input" id="wbo-api-base-url" value="${esc(activeCh?.baseUrl || 'https://api.openai.com/v1')}" placeholder="Base URL，例如 https://api.openai.com/v1" spellcheck="false">
                        <div class="wbo-api-model-row">
                            <input type="password" class="wbo-input" id="wbo-api-key" value="${esc(activeCh?.apiKey || '')}" placeholder="API Key" autocomplete="off" spellcheck="false">
                            <button type="button" class="wbo-btn" id="wbo-toggle-key-btn" title="显示或隐藏密钥">
                                <i class="fa-regular fa-eye"></i>
                            </button>
                        </div>
                        <div class="wbo-api-model-row">
                            <input type="text" class="wbo-input" id="wbo-api-model" value="${esc(activeCh?.model || '')}" list="wbo-api-models-datalist" placeholder="模型名称" spellcheck="false">
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

            <div class="wbo-ai-step" id="wbo-ai-step-presets" hidden>
                <div class="wbo-pinned-top">
                    <div class="wbo-eb-topbar">
                        <button type="button" class="wbo-btn" id="wbo-presets-back-btn">
                            <i class="fa-solid fa-arrow-left"></i> 返回 AI 整理
                        </button>
                        <span class="wbo-ai-subview-title">管理与自定义 AI 整理预设</span>
                        <span class="wbo-spacer"></span>
                        <button type="button" class="wbo-btn" id="wbo-presets-add-blank-btn">
                            <i class="fa-solid fa-plus"></i> 新增预设
                        </button>
                    </div>
                </div>
                <div class="wbo-step-scroll">
                    <div class="wbo-subtle-tip">可直接修改任意预设的按钮名称与提示词，保存后永久生效；不满意随时可恢复默认预设。</div>
                    <div class="wbo-ai-presets-mgr-list" id="wbo-ai-presets-mgr-list"></div>
                    <div class="wbo-ai-status" id="wbo-ai-presets-status"></div>
                </div>
                <div class="wbo-modal-footer wbo-pinned-footer wbo-ai-footer wbo-ai-footer-single">
                    <div class="wbo-ai-footer-left">
                        <button type="button" class="wbo-btn" id="wbo-presets-reset-btn">
                            <i class="fa-solid fa-rotate-left"></i> 恢复默认预设
                        </button>
                    </div>
                    <div class="wbo-ai-footer-right">
                        <button type="button" class="wbo-btn wbo-btn-primary" id="wbo-presets-done-btn">完成返回</button>
                    </div>
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
                        <textarea class="wbo-textarea wbo-rule-textarea" id="wbo-ai-redo-reason" rows="2" placeholder="可选：说明调整期望（例如：把规则补丁单独建组，或合并相近的小分组）" spellcheck="false"></textarea>
                        <div class="wbo-ai-actions-row">
                            <button type="button" class="wbo-btn wbo-btn-primary" id="wbo-ai-redo-run-btn" disabled>
                                <i class="fa-solid fa-rotate"></i> 重新发送给 AI
                            </button>
                            <button type="button" class="wbo-btn" id="wbo-ai-redo-copy-btn" disabled>
                                <i class="fa-regular fa-copy"></i> 复制重排提示词
                            </button>
                        </div>
                        <div class="wbo-redo-paste-box" id="wbo-redo-paste-box" hidden>
                            <textarea class="wbo-textarea" id="wbo-ai-redo-json-input" rows="3" placeholder="将外部 AI 返回的重排 JSON 粘贴到此处，仅更新已选中的重排项" spellcheck="false"></textarea>
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
    const externalStatusEl = modal.querySelector('#wbo-external-status');
    const externalRefusalBox = modal.querySelector('#wbo-external-refusal-box');
    const previewStatusEl = modal.querySelector('#wbo-ai-preview-status');
    const channelStatusEl = modal.querySelector('#wbo-api-channel-status');
    const stepLocal = modal.querySelector('#wbo-ai-step-local');
    const stepSelect = modal.querySelector('#wbo-ai-step-select');
    const stepExternal = modal.querySelector('#wbo-ai-step-external');
    const stepApi = modal.querySelector('#wbo-ai-step-api');
    const stepPresets = modal.querySelector('#wbo-ai-step-presets');
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
            if (settings.organizeLastTab !== tabName) {
                settings.organizeLastTab = tabName;
                void _callbacks?.onMutation({ save: true, uiOnly: true });
            }
        }
        if (stepLocal instanceof HTMLElement) stepLocal.hidden = tabName !== 'local';
        if (stepSelect instanceof HTMLElement) stepSelect.hidden = tabName !== 'organize';
        if (stepExternal instanceof HTMLElement) stepExternal.hidden = tabName !== 'external';
        if (stepApi instanceof HTMLElement) stepApi.hidden = tabName !== 'api';
        if (stepPresets instanceof HTMLElement) stepPresets.hidden = tabName !== 'presets';
        if (stepPreview instanceof HTMLElement) stepPreview.hidden = true;
        // Hide the 2-way top bar while inside dedicated sub-views (`api` / `external` / `presets`)
        if (tabsBar instanceof HTMLElement) tabsBar.hidden = tabName === 'api' || tabName === 'external' || tabName === 'presets';
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
    modal.querySelector('#wbo-external-back-btn')?.addEventListener('click', () => switchAiTab('organize'));
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

    // Persist Local Organize scope & checkboxes across restarts
    modal.querySelectorAll('input[name="wbo-local-scope"]').forEach((radio) => {
        radio.addEventListener('change', () => {
            const val = modal.querySelector('input[name="wbo-local-scope"]:checked')?.value;
            if (val === 'ungrouped' || val === 'nonchar') {
                settings.localOrganizeScope = val;
                void _callbacks?.onMutation({ save: true, uiOnly: true });
            }
        });
    });
    modal.querySelector('#wbo-local-any-prefix')?.addEventListener('change', (ev) => {
        if (ev.currentTarget instanceof HTMLInputElement) {
            settings.localOrganizeUseAnyPrefix = ev.currentTarget.checked;
            void _callbacks?.onMutation({ save: true, uiOnly: true });
        }
    });
    modal.querySelector('#wbo-local-clean-titles')?.addEventListener('change', (ev) => {
        if (ev.currentTarget instanceof HTMLInputElement) {
            settings.localOrganizeCleanTitles = ev.currentTarget.checked;
            void _callbacks?.onMutation({ save: true, uiOnly: true });
        }
    });

    // Visual 2-box custom rule builder for 免 AI 整理 (persisted in settings.localOrganizeCustomRules!)
    /** @type {Array<{ kw: string, group: string }>} */
    const localCustomRules = deepClone(initialSavedRules);
    const persistLocalCustomRules = () => {
        settings.localOrganizeCustomRules = deepClone(localCustomRules);
        void _callbacks?.onMutation({ save: true, uiOnly: true });
    };
    const ruleKwInput = modal.querySelector('#wbo-local-rule-kw');
    const ruleGrpInput = modal.querySelector('#wbo-local-rule-grp');
    const ruleChipsEl = modal.querySelector('#wbo-local-rule-chips');
    const ruleCountEl = modal.querySelector('#wbo-local-rules-count');

    const renderLocalRuleChips = () => {
        if (ruleCountEl) {
            ruleCountEl.textContent = localCustomRules.length > 0 ? `已保存 ${localCustomRules.length} 条` : '点击展开';
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
        persistLocalCustomRules();
    };
    modal.querySelector('#wbo-local-rule-add-btn')?.addEventListener('click', addLocalRuleFromInputs);
    bindImeSafeEnter(ruleGrpInput, addLocalRuleFromInputs);
    ruleChipsEl?.addEventListener('click', (ev) => {
        const btn = ev.target instanceof Element ? ev.target.closest('[data-del-rule-idx]') : null;
        if (!btn) return;
        const idx = Number(btn.getAttribute('data-del-rule-idx'));
        if (Number.isInteger(idx) && idx >= 0 && idx < localCustomRules.length) {
            localCustomRules.splice(idx, 1);
            renderLocalRuleChips();
            persistLocalCustomRules();
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
            persistLocalCustomRules();
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

    const includeCluesCb = modal.querySelector('#wbo-ai-include-clues');
    const clueSubrowEl = modal.querySelector('#wbo-ai-clue-subrow');
    const clueCountInput = modal.querySelector('#wbo-ai-clue-count');
    const snippetLenSelect = modal.querySelector('#wbo-ai-snippet-len');
    const syncClueControlsState = (shouldSave = false) => {
        const enabled = Boolean(includeCluesCb instanceof HTMLInputElement && includeCluesCb.checked);
        if (clueSubrowEl instanceof HTMLElement) clueSubrowEl.classList.toggle('is-disabled', !enabled);
        if (clueCountInput instanceof HTMLInputElement) clueCountInput.disabled = !enabled;
        if (snippetLenSelect instanceof HTMLSelectElement) snippetLenSelect.disabled = !enabled;
        if (shouldSave) {
            settings.aiOrganizeIncludeClues = enabled;
            if (clueCountInput instanceof HTMLInputElement) {
                const rawN = Number(clueCountInput.value);
                if (Number.isFinite(rawN)) {
                    settings.aiOrganizeClueCount = Math.max(1, Math.min(15, Math.round(rawN)));
                }
            }
            if (snippetLenSelect instanceof HTMLSelectElement) {
                const rawLen = Number(snippetLenSelect.value);
                if ([0, 50, 120].includes(rawLen)) settings.aiOrganizeSnippetLen = rawLen;
            }
            void _callbacks?.onMutation({ save: true, uiOnly: true });
        }
    };
    includeCluesCb?.addEventListener('change', () => syncClueControlsState(true));
    clueCountInput?.addEventListener('change', () => syncClueControlsState(true));
    snippetLenSelect?.addEventListener('change', () => syncClueControlsState(true));
    syncClueControlsState(false);

    modal.querySelector('#wbo-toggle-external-ai-btn')?.addEventListener('click', () => {
        switchAiTab('external');
    });

    // Interactive & customizable AI Organize Preset chips + persistent rule text
    const customRuleInput = modal.querySelector('#wbo-ai-custom-rule');
    const presetRowsEl = modal.querySelector('#wbo-ai-preset-rows');
    const catPresetsGridEl = modal.querySelector('#wbo-ai-cat-presets-grid');
    const namePresetsGridEl = modal.querySelector('#wbo-ai-name-presets-grid');
    const savePresetBar = modal.querySelector('#wbo-ai-save-preset-bar');
    const newPresetLabelInput = modal.querySelector('#wbo-ai-new-preset-label');
    const newPresetCatSelect = modal.querySelector('#wbo-ai-new-preset-cat');
    const presetsMgrListEl = modal.querySelector('#wbo-ai-presets-mgr-list');
    const presetsStatusEl = modal.querySelector('#wbo-ai-presets-status');
    let ruleSaveTimer = null;

    const persistAiStyleSettings = () => {
        settings.aiOrganizePresetIds = Array.from(modal.querySelectorAll('.wbo-preset-chip.is-active'))
            .map((btn) => btn.getAttribute('data-preset-id') || '')
            .filter(Boolean);
        settings.aiOrganizeCustomRule = customRuleInput instanceof HTMLTextAreaElement ? customRuleInput.value : '';
        void _callbacks?.onMutation({ save: true, uiOnly: true });
    };

    const rebuildAiPresetChipsDom = () => {
        const eff = getEffectiveAiOrganizePresets(settings);
        const activeIds = new Set(Array.isArray(settings.aiOrganizePresetIds) ? settings.aiOrganizePresetIds : []);
        const buildHtml = (list) => list.map((p) => {
            const active = activeIds.has(p.id);
            return `<button type="button" class="wbo-preset-chip${active ? ' is-active' : ''}" data-preset-cat="${esc(p.cat)}" data-preset-id="${esc(p.id)}" data-preset-text="${esc(p.text)}">${esc(p.label)}</button>`;
        }).join('');
        if (catPresetsGridEl) catPresetsGridEl.innerHTML = buildHtml(eff.categoryPresets);
        if (namePresetsGridEl) namePresetsGridEl.innerHTML = buildHtml(eff.namingPresets);
    };

    const syncPresetRuleTextPreservingExtra = () => {
        if (!(customRuleInput instanceof HTMLTextAreaElement)) return;
        const allKnownTexts = new Set(
            getEffectiveAiOrganizePresets(settings).all.map((p) => p.text.trim()).filter(Boolean),
        );
        const manualLines = customRuleInput.value
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l && !allKnownTexts.has(l));
        const activeTexts = Array.from(modal.querySelectorAll('.wbo-preset-chip.is-active'))
            .map((btn) => (btn.getAttribute('data-preset-text') || '').trim())
            .filter(Boolean);
        customRuleInput.value = [...activeTexts, ...manualLines].join('\n');
        persistAiStyleSettings();
    };

    presetRowsEl?.addEventListener('click', (ev) => {
        const chip = ev.target instanceof Element ? ev.target.closest('.wbo-preset-chip') : null;
        if (!chip) return;
        const cat = chip.getAttribute('data-preset-cat');
        const willActivate = !chip.classList.contains('is-active');
        if (cat && (cat === 'group' || cat === 'name') && willActivate) {
            modal.querySelectorAll(`.wbo-preset-chip[data-preset-cat="${cat}"]`).forEach((other) => {
                other.classList.remove('is-active');
            });
        }
        chip.classList.toggle('is-active', willActivate);
        syncPresetRuleTextPreservingExtra();
    });

    customRuleInput?.addEventListener('input', () => {
        clearTimeout(ruleSaveTimer);
        ruleSaveTimer = setTimeout(() => { persistAiStyleSettings(); }, 180);
    });

    // Quick "+ 存为预设" inline bar
    modal.querySelector('#wbo-ai-save-as-preset-btn')?.addEventListener('click', () => {
        if (!(savePresetBar instanceof HTMLElement)) return;
        const willShow = savePresetBar.hidden;
        savePresetBar.hidden = !willShow;
        if (willShow && newPresetLabelInput instanceof HTMLInputElement && isDesktopAutoFocusAllowed()) {
            newPresetLabelInput.focus();
        }
    });
    modal.querySelector('#wbo-ai-cancel-save-preset')?.addEventListener('click', () => {
        if (savePresetBar instanceof HTMLElement) savePresetBar.hidden = true;
    });
    const confirmSaveQuickPreset = () => {
        const label = newPresetLabelInput instanceof HTMLInputElement ? newPresetLabelInput.value.trim() : '';
        const cat = newPresetCatSelect instanceof HTMLSelectElement ? newPresetCatSelect.value : 'group';
        const text = customRuleInput instanceof HTMLTextAreaElement ? customRuleInput.value.trim() : '';
        if (!text) {
            setStatus('请先在文本框中填写或编辑要保存为预设的提示词', true);
            return;
        }
        const res = upsertAiOrganizePreset(settings, { label, cat, text });
        if (!res.ok) {
            setStatus(res.error || '保存预设失败', true);
            return;
        }
        if (res.preset) {
            if (cat === 'group') {
                const effAll = getEffectiveAiOrganizePresets(settings).all;
                const groupIds = new Set(effAll.filter((p) => p.cat === 'group').map((p) => p.id));
                settings.aiOrganizePresetIds = [
                    ...(settings.aiOrganizePresetIds || []).filter((id) => !groupIds.has(id)),
                    res.preset.id,
                ];
            } else {
                settings.aiOrganizePresetIds = [...new Set([...(settings.aiOrganizePresetIds || []), res.preset.id])];
            }
        }
        if (newPresetLabelInput instanceof HTMLInputElement) newPresetLabelInput.value = '';
        if (savePresetBar instanceof HTMLElement) savePresetBar.hidden = true;
        rebuildAiPresetChipsDom();
        persistAiStyleSettings();
        setStatus(`已保存自定义预设「${res.preset?.label}」`, 'success');
    };
    modal.querySelector('#wbo-ai-confirm-save-preset')?.addEventListener('click', confirmSaveQuickPreset);
    bindImeSafeEnter(newPresetLabelInput, confirmSaveQuickPreset);

    // Full Preset Management sub-view (`#wbo-ai-step-presets`)
    const setPresetsStatus = (msg, kind = 'info') => {
        if (!presetsStatusEl) return;
        presetsStatusEl.textContent = msg;
        presetsStatusEl.className = `wbo-ai-status${kind === 'error' ? ' is-error' : (kind === 'success' ? ' is-success' : '')}`;
    };
    const renderPresetsManagerList = () => {
        if (!presetsMgrListEl) return;
        const eff = getEffectiveAiOrganizePresets(settings);
        const resetBtn = modal.querySelector('#wbo-presets-reset-btn');
        if (resetBtn instanceof HTMLButtonElement) resetBtn.disabled = !eff.isCustomized;

        presetsMgrListEl.innerHTML = eff.all.map((p) => `
            <div class="wbo-card wbo-preset-mgr-card" data-pm-id="${esc(p.id)}">
                <div class="wbo-preset-mgr-top">
                    <input type="text" class="wbo-input wbo-pm-label" value="${esc(p.label)}" placeholder="按钮名称" spellcheck="false">
                    <select class="wbo-select wbo-inline-select wbo-pm-cat">
                        <option value="group"${p.cat === 'group' ? ' selected' : ''}>分类方式（单选）</option>
                        <option value="name"${p.cat === 'name' ? ' selected' : ''}>命名格式（单选）</option>
                        <option value="custom"${p.cat !== 'group' && p.cat !== 'name' ? ' selected' : ''}>附加要求（可多选）</option>
                    </select>
                    <button type="button" class="wbo-btn wbo-btn-primary" data-pm-act="save">保存</button>
                    <button type="button" class="wbo-btn wbo-btn-danger" data-pm-act="delete" title="删除此预设">删除</button>
                </div>
                <textarea class="wbo-textarea wbo-pm-text" rows="2" placeholder="发送给 AI 的归类或命名要求..." spellcheck="false">${esc(p.text)}</textarea>
            </div>
        `).join('');
    };

    modal.querySelector('#wbo-ai-manage-presets-btn')?.addEventListener('click', () => {
        setPresetsStatus('');
        renderPresetsManagerList();
        switchAiTab('presets');
    });
    const exitPresetsSubView = () => {
        rebuildAiPresetChipsDom();
        switchAiTab('organize');
    };
    modal.querySelector('#wbo-presets-back-btn')?.addEventListener('click', exitPresetsSubView);
    modal.querySelector('#wbo-presets-done-btn')?.addEventListener('click', exitPresetsSubView);

    modal.querySelector('#wbo-presets-add-blank-btn')?.addEventListener('click', () => {
        const eff = getEffectiveAiOrganizePresets(settings);
        let idx = eff.all.length + 1;
        let defaultName = `自定义预设 ${idx}`;
        while (eff.all.some((p) => p.label === defaultName)) {
            idx += 1;
            defaultName = `自定义预设 ${idx}`;
        }
        const res = upsertAiOrganizePreset(settings, {
            label: defaultName,
            cat: 'group',
            text: '请按我常用的分类习惯归纳分组，保持组名简短直观。',
        });
        if (res.ok) {
            void _callbacks?.onMutation({ save: true, uiOnly: true });
            renderPresetsManagerList();
            setPresetsStatus(`已新增「${defaultName}」，修改文字后点击保存即可`, 'success');
            const scrollEl = stepPresets?.querySelector('.wbo-step-scroll');
            if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
        }
    });

    modal.querySelector('#wbo-presets-reset-btn')?.addEventListener('click', () => {
        if (!globalThis.confirm('确认将 AI 整理预设恢复为默认方案？（你新增或修改过的预设将被重置）')) return;
        resetAiOrganizePresets(settings);
        settings.aiOrganizePresetIds = [];
        void _callbacks?.onMutation({ save: true, uiOnly: true });
        renderPresetsManagerList();
        rebuildAiPresetChipsDom();
        setPresetsStatus('已恢复默认预设方案', 'success');
    });

    presetsMgrListEl?.addEventListener('click', (ev) => {
        const btn = ev.target instanceof Element ? ev.target.closest('[data-pm-act]') : null;
        if (!btn) return;
        const card = btn.closest('.wbo-preset-mgr-card');
        if (!(card instanceof HTMLElement)) return;
        const id = card.getAttribute('data-pm-id') || '';
        const act = btn.getAttribute('data-pm-act') || '';
        if (act === 'save') {
            const label = card.querySelector('.wbo-pm-label')?.value?.trim() || '';
            const cat = card.querySelector('.wbo-pm-cat')?.value || 'group';
            const text = card.querySelector('.wbo-pm-text')?.value?.trim() || '';
            const prevText = getEffectiveAiOrganizePresets(settings).all.find((p) => p.id === id)?.text || '';
            const res = upsertAiOrganizePreset(settings, { id, label, cat, text });
            if (!res.ok) {
                setPresetsStatus(res.error || '保存失败', 'error');
                return;
            }
            if (prevText && prevText !== text && customRuleInput instanceof HTMLTextAreaElement && customRuleInput.value.includes(prevText)) {
                customRuleInput.value = customRuleInput.value.replace(prevText, text);
                settings.aiOrganizeCustomRule = customRuleInput.value;
            }
            void _callbacks?.onMutation({ save: true, uiOnly: true });
            renderPresetsManagerList();
            rebuildAiPresetChipsDom();
            setPresetsStatus(`已保存预设「${label}」`, 'success');
        } else if (act === 'delete') {
            const curName = card.querySelector('.wbo-pm-label')?.value?.trim() || '该预设';
            if (!globalThis.confirm(`确认删除预设「${curName}」？`)) return;
            if (deleteAiOrganizePreset(settings, id)) {
                void _callbacks?.onMutation({ save: true, uiOnly: true });
                renderPresetsManagerList();
                rebuildAiPresetChipsDom();
                setPresetsStatus(`已删除预设「${curName}」`, 'info');
            }
        }
    });

    // IME-safe filter inside AI book list
    const aiBookFilter = modal.querySelector('#wbo-ai-book-filter');
    const applyAiFilter = () => {
        if (!(aiBookFilter instanceof HTMLInputElement)) return;
        const q = aiBookFilter.value.trim().toLowerCase();
        modal.querySelectorAll('#wbo-ai-book-list .wbo-ai-pick-row').forEach((row) => {
            if (!(row instanceof HTMLElement)) return;
            const hay = row.getAttribute('data-ai-search') || '';
            row.hidden = Boolean(q && !hay.includes(q));
        });
        modal.querySelectorAll('#wbo-ai-book-list .wbo-ai-pick-section').forEach((sec) => {
            if (!(sec instanceof HTMLElement)) return;
            const hasVisibleRow = Array.from(sec.querySelectorAll('.wbo-ai-pick-row')).some(
                (r) => r instanceof HTMLElement && !r.hidden,
            );
            sec.hidden = !hasVisibleRow;
        });
    };
    if (aiBookFilter instanceof HTMLInputElement) {
        let composing = false;
        aiBookFilter.addEventListener('compositionstart', () => { composing = true; });
        aiBookFilter.addEventListener('compositionend', () => { composing = false; applyAiFilter(); });
        aiBookFilter.addEventListener('input', () => { if (!composing) applyAiFilter(); });
    }

    const setStatus = (msg, state = false, target = 'main') => {
        const el = target === 'preview'
            ? previewStatusEl
            : (target === 'channel' ? channelStatusEl : (target === 'external' ? externalStatusEl : statusEl));
        if (!el) return;
        const kind = state === true ? 'error' : (state === 'error' || state === 'success' ? state : 'info');
        el.textContent = msg;
        el.className = `wbo-ai-status${kind === 'error' ? ' is-error' : (kind === 'success' ? ' is-success' : '')}`;
        if (msg && kind === 'error' && el instanceof HTMLElement) {
            try { el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch { /* ignore */ }
        }
    };

    const showRefusalAlert = (parsed, target = 'main') => {
        const box = target === 'external' ? externalRefusalBox : refusalBox;
        if (!(box instanceof HTMLElement)) return;
        const snippet = parsed.refusalSnippet ? `<div class="wbo-refusal-quote">AI 回复原文：${esc(parsed.refusalSnippet)}</div>` : '';
        const uncheckBtn = sensitiveSet.size > 0
            ? `<div style="margin-top:6px;"><button type="button" class="wbo-btn" data-refusal-uncheck-sens="1">一键取消勾选疑似敏感书</button></div>`
            : '';
        box.innerHTML = `
            <div><b>AI 拒绝了本次整理请求</b></div>
            <div style="margin-top:4px;">${esc(parsed.error)}</div>
            ${snippet}
            ${uncheckBtn}
        `;
        box.hidden = false;
        box.querySelector('[data-refusal-uncheck-sens]')?.addEventListener('click', () => {
            modal.querySelectorAll('.wbo-ai-book-check').forEach((el) => {
                if (el instanceof HTMLInputElement && sensitiveSet.has(el.value)) {
                    el.checked = false;
                }
            });
            box.hidden = true;
            setStatus('已取消勾选疑似敏感世界书，可重新整理，敏感书请手动拖拽分组。', false, target);
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
        ({ settings, classification } = _callbacks.getState());
        ({ nonCharBooks, allBooks } = buildBookPool(classification));

        const prevChecked = new Set(getSelectedBookNames());
        const nextSensState = analyzeSensitiveOrganizeState({
            allBooks,
            scope: activeOrganizeScope,
            checkedNames: prevChecked,
        });
        const listEl = modal.querySelector('#wbo-ai-book-list');
        if (listEl) {
            listEl.innerHTML = renderAiBookListHtml(prevChecked, nextSensState);
            applyAiFilter();
        }
        const ungroupedCntEl = modal.querySelector('[data-local-scope-count="ungrouped"]');
        const noncharCntEl = modal.querySelector('[data-local-scope-count="nonchar"]');
        if (ungroupedCntEl) ungroupedCntEl.textContent = `${classification.ungroupedBooks.length} 本`;
        if (noncharCntEl) noncharCntEl.textContent = `${classification.nonCharCount} 本`;

        syncSensBannerUi();
        syncUndoButtons();
        setStatus('已撤销上一次整理，恢复为整理前的分组与显示名。', 'success');
        if (localStatusEl) {
            localStatusEl.textContent = '已撤销上一次整理，恢复为整理前的分组与显示名。';
            localStatusEl.className = 'wbo-ai-status is-success';
        }
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

    const sensConfirmBar = modal.querySelector('#wbo-sens-confirm-bar');
    const sensConfirmText = modal.querySelector('#wbo-sens-confirm-text');
    const sensResultBar = modal.querySelector('#wbo-sens-result-bar');
    const sensResultText = modal.querySelector('#wbo-sens-result-text');

    const syncSensBannerUi = () => {
        const state = analyzeSensitiveOrganizeState({
            allBooks,
            scope: activeOrganizeScope,
            checkedNames: getSelectedBookNames(),
        });
        const matchedGroup = findSensitiveTargetGroup(settings.groups);
        const textEl = modal.querySelector('#wbo-sens-banner-text');
        const btnEl = modal.querySelector('#wbo-pick-toggle-sens');
        const nsfwBtn = modal.querySelector('#wbo-sens-move-nsfw-btn');
        const bannerEl = modal.querySelector('#wbo-sens-banner');
        if (bannerEl instanceof HTMLElement) {
            bannerEl.hidden = state.bannerMode === 'hidden';
            bannerEl.classList.toggle('is-danger', state.bannerMode === 'danger');
        }
        if (nsfwBtn instanceof HTMLElement) {
            nsfwBtn.hidden = state.ungroupedSensitive.length === 0;
            nsfwBtn.textContent = matchedGroup ? `一键归入「${matchedGroup.name}」` : '一键归入 NSFW 分组';
        }
        if (state.ungroupedSensitive.length === 0 && sensConfirmBar instanceof HTMLElement) {
            sensConfirmBar.hidden = true;
        }
        if (state.bannerMode === 'danger') {
            if (textEl) textEl.textContent = `当前勾选了 ${state.checkedSensitive.length} 本疑似敏感世界书，审查严格模型可能拒答浪费额度`;
            if (btnEl) btnEl.textContent = '一键排除';
        } else if (state.bannerMode === 'warn') {
            if (textEl) textEl.textContent = `当前有 ${state.ungroupedSensitive.length} 本未分组疑似敏感世界书已默认排除，避免触发 AI 拒答浪费额度`;
            if (btnEl) btnEl.textContent = '包含敏感书';
        }
    };

    const showSensInlineConfirm = () => {
        const state = analyzeSensitiveOrganizeState({
            allBooks,
            scope: activeOrganizeScope,
            checkedNames: getSelectedBookNames(),
        });
        const targets = state.ungroupedSensitive.map((b) => b.realName);
        if (targets.length === 0) {
            if (sensResultText && sensResultBar instanceof HTMLElement) {
                sensResultText.textContent = '当前没有未分组的疑似敏感世界书。';
                const undoBtn = modal.querySelector('#wbo-sens-inline-undo');
                if (undoBtn instanceof HTMLElement) undoBtn.hidden = true;
                sensResultBar.hidden = false;
            }
            return;
        }
        const matched = findSensitiveTargetGroup(settings.groups);
        const targetLabel = matched ? `现有分组「${matched.name}」` : '新建「NSFW」分组';
        const previewNames = targets.slice(0, 3).map((n) => `「${classification.byName.get(n)?.displayName || n}」`).join('、');
        const moreText = targets.length > 3 ? ` 等 ${targets.length} 本` : `（共 ${targets.length} 本）`;
        if (sensConfirmText && sensConfirmBar instanceof HTMLElement) {
            sensConfirmText.textContent = `确认将 ${previewNames}${moreText} 归入${targetLabel}？`;
            sensConfirmBar.hidden = false;
        }
    };

    const moveUngroupedSensitiveToNsfw = async () => {
        const state = analyzeSensitiveOrganizeState({
            allBooks,
            scope: activeOrganizeScope,
            checkedNames: getSelectedBookNames(),
        });
        const targets = state.ungroupedSensitive.map((b) => b.realName);
        if (targets.length === 0) {
            if (sensConfirmBar instanceof HTMLElement) sensConfirmBar.hidden = true;
            return;
        }
        const prevChecked = new Set(getSelectedBookNames());
        for (const name of targets) prevChecked.delete(name);

        const matchedGroup = findSensitiveTargetGroup(settings.groups);
        const res = moveBooksToNamedGroup(settings, targets, matchedGroup?.name || 'NSFW', {
            targetGroupId: matchedGroup?.id || '',
            label: matchedGroup ? `一键归入「${matchedGroup.name}」` : '一键归入 NSFW 分组',
            isCharBoundFn: (name) => Boolean(classification.byName.get(name)?.isCharBound),
        });
        if (sensConfirmBar instanceof HTMLElement) sensConfirmBar.hidden = true;
        await _callbacks.onMutation({ save: true });
        ({ settings, classification } = _callbacks.getState());
        ({ nonCharBooks, allBooks } = buildBookPool(classification));

        const nextSensState = analyzeSensitiveOrganizeState({
            allBooks,
            scope: activeOrganizeScope,
            checkedNames: prevChecked,
        });
        const listEl = modal.querySelector('#wbo-ai-book-list');
        if (listEl) {
            listEl.innerHTML = renderAiBookListHtml(prevChecked, nextSensState);
            applyAiFilter();
        }
        syncUndoButtons();
        syncSensBannerUi();
        const msg = `已将 ${res.movedCount} 本疑似敏感世界书归入「${res.groupName}」分组`;
        if (sensResultText && sensResultBar instanceof HTMLElement) {
            sensResultText.textContent = msg;
            const undoBtn = modal.querySelector('#wbo-sens-inline-undo');
            if (undoBtn instanceof HTMLElement) undoBtn.hidden = false;
            sensResultBar.hidden = false;
        }
        setStatus(msg, 'success');
    };

    modal.querySelector('#wbo-ai-book-list')?.addEventListener('change', syncSensBannerUi);
    modal.querySelector('#wbo-ai-step-select')?.addEventListener('click', (ev) => {
        const el = ev.target instanceof Element ? ev.target : null;
        if (!el) return;
        if (el.closest('[data-action-move-nsfw]')) {
            showSensInlineConfirm();
            return;
        }
        if (el.closest('#wbo-sens-confirm-ok')) {
            void moveUngroupedSensitiveToNsfw();
            return;
        }
        if (el.closest('#wbo-sens-confirm-cancel')) {
            if (sensConfirmBar instanceof HTMLElement) sensConfirmBar.hidden = true;
            return;
        }
        if (el.closest('#wbo-sens-inline-undo')) {
            void (async () => {
                if (!undoLastAiOrganize(settings)) return;
                await _callbacks.onMutation({ save: true });
                ({ settings, classification } = _callbacks.getState());
                ({ nonCharBooks, allBooks } = buildBookPool(classification));
                const prevChecked = new Set(getSelectedBookNames());
                const nextSensState = analyzeSensitiveOrganizeState({
                    allBooks,
                    scope: activeOrganizeScope,
                    checkedNames: prevChecked,
                });
                const listEl = modal.querySelector('#wbo-ai-book-list');
                if (listEl) {
                    listEl.innerHTML = renderAiBookListHtml(prevChecked, nextSensState);
                    applyAiFilter();
                }
                syncSensBannerUi();
                syncUndoButtons();
                if (sensResultText && sensResultBar instanceof HTMLElement) {
                    sensResultText.textContent = '已撤回刚才的敏感书归组操作。';
                    const undoBtn = modal.querySelector('#wbo-sens-inline-undo');
                    if (undoBtn instanceof HTMLElement) undoBtn.hidden = true;
                    sensResultBar.hidden = false;
                }
                setStatus('已撤回上一步敏感书归组操作。', 'success');
            })();
        }
    });

    modal.querySelector('#wbo-pick-ungrouped')?.addEventListener('click', () => {
        activeOrganizeScope = 'ungrouped';
        settings.aiOrganizeScope = 'ungrouped';
        void _callbacks?.onMutation({ save: true, uiOnly: true });
        setCheckedByPredicate((m) => m.groupId === SPECIAL_GROUPS.UNGROUPED && !sensitiveSet.has(m.realName));
        syncSensBannerUi();
    });
    modal.querySelector('#wbo-pick-nonchar')?.addEventListener('click', () => {
        activeOrganizeScope = 'nonchar';
        settings.aiOrganizeScope = 'nonchar';
        void _callbacks?.onMutation({ save: true, uiOnly: true });
        setCheckedByPredicate((m) => !m.isInCharGroup && !sensitiveSet.has(m.realName));
        syncSensBannerUi();
    });
    modal.querySelector('#wbo-pick-toggle-sens')?.addEventListener('click', () => {
        const state = analyzeSensitiveOrganizeState({
            allBooks,
            scope: activeOrganizeScope,
            checkedNames: getSelectedBookNames(),
        });
        if (state.checkedSensitive.length > 0) {
            const checkedSensSet = new Set(state.checkedSensitive.map((b) => b.realName));
            modal.querySelectorAll('.wbo-ai-book-check').forEach((el) => {
                if (el instanceof HTMLInputElement && checkedSensSet.has(el.value)) {
                    el.checked = false;
                }
            });
            syncSensBannerUi();
            setStatus('已排除疑似敏感世界书，可点「一键归入 NSFW 分组」或手动拖拽分组。');
            return;
        }
        const scopeSensSet = new Set(state.scopeSensitive.map((b) => b.realName));
        modal.querySelectorAll('.wbo-ai-book-check').forEach((el) => {
            if (el instanceof HTMLInputElement && scopeSensSet.has(el.value)) {
                el.checked = true;
            }
        });
        syncSensBannerUi();
        setStatus('已勾选当前整理范围内的疑似敏感世界书，请确认当前使用的是内容限制较宽松的模型，避免触发拒答浪费额度。');
    });
    modal.querySelector('#wbo-pick-none')?.addEventListener('click', () => {
        activeOrganizeScope = 'custom_none';
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
            presetsPool: getEffectiveAiOrganizePresets(settings).all,
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
                                <input type="text" class="wbo-input wbo-prop-alias" value="${esc(item.alias)}" placeholder="规范后的显示名" spellcheck="false">
                            </label>
                            <label class="wbo-prop-field">
                                <span class="wbo-prop-label">说明</span>
                                <input type="text" class="wbo-input wbo-prop-note" value="${esc(item.note)}" placeholder="可选：一句话用途说明" spellcheck="false">
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
        if (stepExternal instanceof HTMLElement) stepExternal.hidden = true;
        if (stepApi instanceof HTMLElement) stepApi.hidden = true;
        if (stepPresets instanceof HTMLElement) stepPresets.hidden = true;
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

    previewList?.addEventListener('change', async (ev) => {
        const target = ev.target;
        if (target instanceof HTMLSelectElement && target.classList.contains('wbo-preview-merge-select')) {
            const fromGroup = target.getAttribute('data-merge-from') || '';
            let destGroup = target.value;
            if (!fromGroup || !destGroup) return;
            if (destGroup === '__new__') {
                const customName = await openInlineTextPrompt({
                    title: '整组归入新分组',
                    label: `将「${fromGroup}」整组归入新分组`,
                    placeholder: '输入新分组名',
                    confirmText: '确定',
                });
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
                const customName = await openInlineTextPrompt({
                    title: '新建分组',
                    label: '新分组名称',
                    placeholder: '输入新分组名称',
                    confirmText: '确定',
                });
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

    previewList?.addEventListener('click', async (ev) => {
        const btn = ev.target instanceof Element ? ev.target.closest('[data-action]') : null;
        if (!btn) return;
        const action = btn.getAttribute('data-action');
        if (action === 'rename-preview-group') {
            const oldName = btn.getAttribute('data-group-name') || '';
            if (!oldName) return;
            const nextName = await openInlineTextPrompt({
                title: '修改分组名称',
                label: `将分组「${oldName}」改名为`,
                initialValue: oldName,
                placeholder: '输入新分组名称',
                confirmText: '确定',
            });
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

    const parseAndOpenPreview = (rawText, statusTarget = 'main') => {
        const validSet = new Set(classification.byName.keys());
        const parsed = parseAiOrganizeResponse(rawText, validSet);
        const box = statusTarget === 'external' ? externalRefusalBox : refusalBox;
        if (!parsed.ok) {
            if (parsed.isRefusal) {
                showRefusalAlert(parsed, statusTarget);
                setStatus('', false, statusTarget);
            } else {
                if (box instanceof HTMLElement) box.hidden = true;
                setStatus(parsed.error || '解析失败', true, statusTarget);
            }
            return;
        }
        if (box instanceof HTMLElement) box.hidden = true;
        setStatus('', false, statusTarget);
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
        const prompts = await preparePromptPayload({ statusTarget: 'external' });
        if (!prompts) return;
        const fullPrompt = `${prompts.systemPrompt}\n\n---\n\n${prompts.userPrompt}`;
        try {
            await navigator.clipboard.writeText(fullPrompt);
            setStatus('已复制提示词，可将外部 AI 返回的 JSON 粘贴到上方输入框后点「解析并预览」。', 'success', 'external');
        } catch {
            const textarea = modal.querySelector('#wbo-ai-json-input');
            if (textarea instanceof HTMLTextAreaElement) {
                textarea.value = fullPrompt;
                textarea.select();
            }
            setStatus('剪贴板受限，已将提示词填入输入框。', false, 'external');
        }
    });

    modal.querySelector('#wbo-ai-parse-paste-btn')?.addEventListener('click', () => {
        const raw = modal.querySelector('#wbo-ai-json-input')?.value || '';
        parseAndOpenPreview(raw, 'external');
    });

    modal.querySelector('#wbo-ai-back-btn')?.addEventListener('click', () => {
        switchAiTab(lastOrganizeSourceTab);
    });

    modal.querySelector('#wbo-ai-cancel-btn')?.addEventListener('click', closeSubModal);

    const applyProgressBox = modal.querySelector('#wbo-apply-progress-box');
    const applyCancelBtn = modal.querySelector('#wbo-ai-cancel-btn');

    const rollbackRealRenames = async (completedRenames, preSnapshot, activeLiveNamesSet = null) => {
        if (applyProgressBox instanceof HTMLElement) {
            applyProgressBox.hidden = false;
            applyProgressBox.innerHTML = `<div class="wbo-progress-head"><span>正在撤回已修改的 ${completedRenames.length} 本世界书，请稍候...</span></div>`;
        }
        const liveNames = activeLiveNamesSet instanceof Set ? activeLiveNamesSet : new Set(getWorldNames());
        let rolledBack = 0;
        const rolledBackPairs = [];
        const unrolledPairs = [];
        const rollbackErrors = [];
        for (let i = completedRenames.length - 1; i >= 0; i -= 1) {
            const pair = completedRenames[i];
            const res = await realRenameWorldbook(pair.newName, pair.oldName, settings, {
                deferRefresh: true,
                existingNamesSet: liveNames,
            });
            if (res.ok) {
                rolledBack += 1;
                rolledBackPairs.push(pair);
            } else {
                unrolledPairs.push(pair);
                rollbackErrors.push(`${pair.newName} → ${pair.oldName}：${res.error || '未知错误'}`);
            }
        }
        discardPendingRenamedEventsForRollback(rolledBackPairs);
        // Restore pre-apply settings metadata cleanly (including pinnedBooks!)
        if (preSnapshot) {
            settings.groups = deepClone(preSnapshot.groups);
            settings.assignments = deepClone(preSnapshot.assignments);
            settings.aliases = deepClone(preSnapshot.aliases);
            settings.notes = deepClone(preSnapshot.notes);
            settings.charBookOverrides = deepClone(preSnapshot.charBookOverrides);
            settings.cachedCharBindings = deepClone(preSnapshot.cachedCharBindings);
            settings.sectionOrder = deepClone(preSnapshot.sectionOrder);
            settings.undoSnapshots = deepClone(preSnapshot.undoSnapshots);
            settings.pinnedBooks = deepClone(preSnapshot.pinnedBooks || []);
            for (const pair of unrolledPairs) {
                migrateSettingsOnWorldRename(settings, pair.oldName, pair.newName);
            }
        }
        await flushWorldInfoListRefresh();
        await _callbacks.onRescan();
        return { rolledBack, rollbackErrors };
    };

    const applyOutboundCharExclusions = (targetSettings, appliedProposals, resolveIsCharBound) => {
        if (!targetSettings || !Array.isArray(appliedProposals) || appliedProposals.length === 0) return;
        targetSettings.charBookOverrides ||= {};
        for (const p of appliedProposals) {
            if (!p?.realName) continue;
            if (p.applyGroup === false) continue;
            const cleanGroup = typeof p.group === 'string' ? p.group.trim() : '';
            if (!cleanGroup || cleanGroup === '角色世界书') continue;
            if (cleanGroup !== '未分组' && !targetSettings.assignments?.[p.realName]) continue;
            if (resolveIsCharBound(p.realName)) {
                targetSettings.charBookOverrides[p.realName] = 'exclude_from_char';
            }
        }
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
                pinnedBooks: deepClone(settings.pinnedBooks || []),
            };

            let cancelled = false;
            const liveNamesSet = new Set(getWorldNames());
            /** @type {Array<{ oldName: string, newName: string }>} */
            const completedRenames = [];
            /** @type {Array<{ oldName: string, newName: string, error: string }>} */
            const failedItems = [];
            const adjustedProposals = [];
            const origNameByFinalName = new Map();

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
                origNameByFinalName.set(finalRealName, item.realName);
                adjustedProposals.push({
                    realName: finalRealName,
                    alias: '',
                    group: item.group,
                    note: item.note,
                    applyAlias: false,
                });
            }

            if (cancelled) {
                const { rolledBack, rollbackErrors } = await rollbackRealRenames(completedRenames, preSnapshot, liveNamesSet);
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
            applyAiOrganizeProposals(settings, adjustedProposals, {
                label: previewFromLocal ? '免 AI 整理' : 'AI 整理',
                isCharBoundFn: (name) => {
                    const origName = origNameByFinalName.get(name) || name;
                    return Boolean((classification.byName.get(origName)?.charOwners || []).some((o) => o && o.source !== 'embedded'));
                },
            });
            applyOutboundCharExclusions(settings, adjustedProposals, (name) => {
                const origName = origNameByFinalName.get(name) || name;
                return Boolean(classification.byName.get(origName)?.isCharBound);
            });
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
                    const { rolledBack, rollbackErrors } = await rollbackRealRenames(completedRenames, preSnapshot, liveNamesSet);
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
            isCharBoundFn: (name) => Boolean((classification.byName.get(name)?.charOwners || []).some((o) => o && o.source !== 'embedded')),
        });
        applyOutboundCharExclusions(
            settings,
            chosen,
            (name) => Boolean(classification.byName.get(name)?.isCharBound),
        );
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
function openScanAndImportModal({ initialTab = '' } = {}) {
    if (!_callbacks) return;
    document.getElementById('wbo-mgr-scan-btn')?.blur?.();

    const sourceLabel = (s) => {
        if (s === 'primary') return '当前主绑';
        if (s === 'extra') return '额外附加（可能为通用书或旧版残留）';
        return '本地同名';
    };

    const matchReasonLabel = (m) => {
        if (m.reason === 'exact_name') return `与角色「${m.charName}」同名，但角色卡未绑定`;
        if (m.reason === 'unscanned_card_name') return `与未扫描角色卡「${m.charName}」同名`;
        return `与角色「${m.charName}」近似同名，但角色卡未绑定`;
    };

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
            settings,
        });
        const personaSummary = summarizePersonaWorldBindings({
            powerUserSettings: getPowerUserSettings(),
            worldNamesSet,
            bindingMap: bindingMap || new Map(),
        });

        const scanBtnLabel = unscannedShallow.length > 0
            ? `开始扫描角色卡（含 ${unscannedShallow.length} 张未加载）`
            : '重新扫描角色卡';

        const charJumpBtn = (avatar, name) =>
            `<button type="button" class="wbo-jump-link" data-jump-char="${esc(avatar)}" title="跳转到角色卡「${esc(name)}」">${esc(name)}</button>`;
        const worldChipHtml = (worldName, {
            suffix = '',
            unbindExtraKey = '',
            unbindExtraLabel = '',
            roleText = '',
            unbindKind = '',
            unbindTarget = '',
        } = {}) => `
            <span class="wbo-cov-chip-group">
                <button type="button" class="wbo-jump-link is-world" data-jump-world="${esc(worldName)}" data-cov-role-text="${esc(roleText)}" data-cov-unbind-kind="${esc(unbindKind)}" data-cov-unbind-target="${esc(unbindTarget)}" title="点击查看此世界书的操作选项">${esc(worldName)}${suffix ? `<small>${esc(suffix)}</small>` : ''}</button>
                <button type="button" class="wbo-cov-mini-btn" data-cov-preview="${esc(worldName)}" title="原地预览此世界书条目"><i class="fa-regular fa-eye"></i></button>
                ${unbindExtraKey ? `<button type="button" class="wbo-cov-mini-btn is-danger" data-cov-unbind-extra="${esc(unbindExtraKey)}" data-cov-world="${esc(worldName)}" title="${esc(unbindExtraLabel || '解除此附加世界书绑定')}"><i class="fa-solid fa-xmark"></i></button>` : ''}
            </span>
        `;

        /** @type {Array<{ key: string, label: string, count: number, rowsHtml: string }>} */
        const covTabs = [];

        const renderCovTable = (rowsHtml, subjectColLabel = '角色名') => `
            <div class="wbo-cov-table-head">
                <span>${esc(subjectColLabel)}</span>
                <span>世界书</span>
            </div>
            <div class="wbo-cov-table-body">${rowsHtml}</div>
        `;

        const overrides = settings.charBookOverrides || {};
        const unboundMatches = coverage.unboundNameMatches || [];
        const embeddedMatches = (coverage.embeddedNameMatches || []).filter((m) => {
            const ov = overrides[m?.worldName];
            return ov !== 'include_in_char' && ov !== 'exclude_from_char';
        });
        const totalSameNameCount = unboundMatches.length + embeddedMatches.length;

        if (totalSameNameCount > 0) {
            const unboundRowsHtml = unboundMatches.map((m) => `
                <div class="wbo-cov-row-wrap">
                    <div class="wbo-cov-row">
                        <div class="wbo-cov-subject">
                            ${charJumpBtn(m.avatar, m.charName)}
                            <span class="wbo-cov-reason">${esc(matchReasonLabel(m))}</span>
                        </div>
                        <div class="wbo-cov-targets">
                            ${worldChipHtml(m.worldName, {
                                roleText: `${matchReasonLabel(m)}。可点「归入角色世界书」手动归类`,
                            })}
                            <button type="button" class="wbo-cov-action-pill is-primary" data-cov-assign-char="${esc(m.worldName)}" data-cov-match-kind="unbound" title="将此世界书归入「角色世界书」分组">归入角色世界书</button>
                        </div>
                    </div>
                    <div class="wbo-cov-drawer" hidden></div>
                </div>
            `).join('');

            const embeddedRowsHtml = embeddedMatches.map((m) => `
                <div class="wbo-cov-row-wrap">
                    <div class="wbo-cov-row">
                        <div class="wbo-cov-subject">
                            ${charJumpBtn(m.avatar, m.charName)}
                            <button type="button" class="wbo-cov-action-pill" data-cov-emb-diff="${esc(m.avatar)}" data-cov-emb-world="${esc(m.worldName)}" data-cov-primary-world="${esc(m.primaryWorld || '')}" title="对比角色卡自带内容与这本本地同名书">对比差异</button>
                        </div>
                        <div class="wbo-cov-targets">
                            ${worldChipHtml(m.worldName, {
                                roleText: `这是未启用的本地重名世界书${m.primaryWorld ? `（角色「${m.charName}」当前实际正在使用的是「${m.primaryWorld}」）` : ''}`,
                            })}
                            <span class="wbo-tag is-warn" title="本地未启用的重名世界书副本">本地重名</span>
                            <button type="button" class="wbo-cov-action-pill is-primary" data-cov-assign-char="${esc(m.worldName)}" data-cov-match-kind="embedded" title="将此世界书归入「角色世界书」分组">归入角色世界书</button>
                        </div>
                    </div>
                    <div class="wbo-cov-drawer" hidden></div>
                </div>
            `).join('');

            covTabs.push({
                key: 'same_name',
                label: '同名待归类',
                count: totalSameNameCount,
                rowsHtml: `
                    <div class="wbo-cov-same-name-alert">
                        <span>以下 <b>${totalSameNameCount}</b> 本世界书与角色卡同名或相近，但角色卡中未直接绑定（如卡内未填绑定、角色卡尚未扫描或旧版同名副本），因此暂未自动归入「角色世界书」。确认属于角色时可一键归类。</span>
                    </div>
                    ${renderCovTable(`${unboundRowsHtml}${embeddedRowsHtml}`, '角色名')}
                `,
            });
        }

        if (coverage.multiBookChars.length > 0) {
            covTabs.push({
                key: 'multi',
                label: '多本书角色',
                count: coverage.multiBookChars.length,
                rowsHtml: renderCovTable(coverage.multiBookChars.map((c) => {
                    const bookNamesJson = JSON.stringify(c.books.map((b) => b.worldName));
                    const primaryBook = c.books.find((b) => b.source === 'primary')?.worldName || '';
                    return `
                        <div class="wbo-cov-row-wrap">
                            <div class="wbo-cov-row">
                                <div class="wbo-cov-subject">
                                    ${charJumpBtn(c.avatar, c.charName)}
                                    ${c.books.length >= 2 ? `<button type="button" class="wbo-cov-action-pill" data-cov-diff="${esc(bookNamesJson)}" title="对比这些世界书的条目差异">对比差异</button>` : ''}
                                </div>
                                <div class="wbo-cov-targets">
                                    ${c.books.map((b) => {
                                        const roleText = b.source === 'primary'
                                            ? `此书为角色「${c.charName}」的当前主绑世界书`
                                            : `此书为角色「${c.charName}」的额外附加绑定${primaryBook ? `（该角色另有主绑书「${primaryBook}」）` : ''}`;
                                        return worldChipHtml(b.worldName, {
                                            suffix: sourceLabel(b.source),
                                            unbindExtraKey: b.source === 'extra' ? c.avatar : '',
                                            unbindExtraLabel: `解除「${c.charName}」的附加世界书「${b.worldName}」`,
                                            roleText,
                                            unbindKind: b.source === 'extra' ? 'extra' : '',
                                            unbindTarget: b.source === 'extra' ? c.avatar : '',
                                        });
                                    }).join('')}
                                </div>
                            </div>
                            <div class="wbo-cov-drawer" hidden></div>
                        </div>
                    `;
                }).join(''), '角色名'),
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
                                ${worldChipHtml(s.worldName, {
                                    suffix: `${(s.owners || []).length}卡共用`,
                                    roleText: `此书被 ${(s.owners || []).map((o) => `「${o.charName}」`).join('、')} 共用`,
                                })}
                            </div>
                        </div>
                        <div class="wbo-cov-drawer" hidden></div>
                    </div>
                `).join(''), '角色名'),
            });
        }
        if (personaSummary.totalBoundCount > 0) {
            covTabs.push({
                key: 'persona',
                label: 'User 人设绑定',
                count: personaSummary.totalBoundCount,
                rowsHtml: `
                    ${personaSummary.anomalyCount > 0 ? `
                        <div class="wbo-cov-orphan-bar">
                            <span>发现 ${personaSummary.missingPersonaBindings.length} 项人设缺失世界书、${personaSummary.personaCharCrossBindings.length} 项与角色卡交叉绑定，请核对是否需要清理。</span>
                        </div>
                    ` : ''}
                    ${renderCovTable(personaSummary.personaBindings.map((pb) => {
                        const charCrossBadge = pb.charOwners.length > 0
                            ? `<span class="wbo-cov-subject-badge is-char">交叉角色：${esc(pb.charOwners.map((o) => o.charName).join('、'))}</span>`
                            : '';
                        const roleText = pb.charOwners.length > 0
                            ? `此书被 User 人设「${pb.personaName}」绑定，同时也被角色卡「${pb.charOwners.map((o) => o.charName).join('、')}」绑定`
                            : `此书为 User 人设「${pb.personaName}」的当前绑定世界书`;
                        return `
                            <div class="wbo-cov-row-wrap">
                                <div class="wbo-cov-row">
                                    <div class="wbo-cov-subject">
                                        <span class="wbo-cov-persona-name">${esc(pb.personaName)}</span>
                                    </div>
                                    <div class="wbo-cov-targets">
                                        ${pb.missing ? `
                                            <span class="wbo-cov-missing">缺失：${esc(pb.worldName)}</span>
                                            <button type="button" class="wbo-cov-action-pill is-danger" data-cov-clear-persona="${esc(pb.pid)}" data-cov-persona-world="${esc(pb.worldName)}" data-cov-persona-name="${esc(pb.personaName)}" title="清除人设上已失效的世界书引用">清除失效绑定</button>
                                        ` : `
                                            ${worldChipHtml(pb.worldName, {
                                                suffix: pb.charOwners.length > 0 ? '人设+角色交叉' : '',
                                                roleText,
                                                unbindKind: 'persona',
                                                unbindTarget: pb.pid,
                                            })}
                                            ${charCrossBadge}
                                        `}
                                    </div>
                                </div>
                                <div class="wbo-cov-drawer" hidden></div>
                            </div>
                        `;
                    }).join(''), '人设名称')}
                `,
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
                `).join(''), '角色名'),
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
                                        suffix: '额外附加（旧版残留）',
                                        unbindExtraKey: o.charKey || o.charName,
                                        unbindExtraLabel: `清理已删角色「${o.charName}」对「${o.worldName}」的残留绑定`,
                                        roleText: `此书为已删除角色「${o.charName}」的残留附加绑定，可安全解除`,
                                        unbindKind: 'extra',
                                        unbindTarget: o.charKey || o.charName,
                                    })}
                                </div>
                            </div>
                            <div class="wbo-cov-drawer" hidden></div>
                        </div>
                    `).join(''), '角色名')}
                `,
            });
        }
        const totalDiffItems = covTabs.reduce((acc, t) => acc + t.count, 0);
        const firstTabKey = (initialTab && covTabs.some((t) => t.key === initialTab))
            ? initialTab
            : (covTabs[0]?.key || '');
        const overviewSummary = covTabs.length > 0
            ? covTabs.map((t) => `${t.label} ${t.count}`).join(' · ')
            : '所有角色卡与世界书一一对应，未发现异常。';

        const coverageHtml = covTabs.length > 0
            ? `
                <div class="wbo-card wbo-cov-panel">
                    <div class="wbo-ai-section-head">
                        <span>对应明细 · 共 ${totalDiffItems} 项记录</span>
                        <span class="wbo-subtle-tip">点击世界书查看操作选项</span>
                    </div>
                    <div class="wbo-cov-tab-bar">
                        ${covTabs.map((t) => `
                            <button type="button" class="wbo-pill${t.key === firstTabKey ? ' is-active' : ''}" data-cov-tab="${esc(t.key)}">
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
                <span>User 人设绑定：<b>${personaSummary.totalBoundCount}</b> 项${personaSummary.anomalyCount > 0 ? `（异常 ${personaSummary.anomalyCount}）` : ''}</span>
                ${unscannedShallow.length > 0 ? `<span>待扫描：<b>${unscannedShallow.length}</b> 张</span>` : ''}
            </div>

            <div class="wbo-ai-actions-row">
                <button type="button" class="wbo-btn wbo-btn-primary" id="wbo-scan-all-btn">
                    <i class="fa-solid fa-magnifying-glass"></i> ${esc(scanBtnLabel)}
                </button>
            </div>
            <div class="wbo-ai-status wbo-scan-top-status" id="wbo-scan-status" hidden></div>

            ${coverageHtml}
            ${unimportedSection}
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
            const kind = state === true ? 'error' : (state === 'error' || state === 'success' ? state : 'info');
            const cls = `wbo-ai-status wbo-scan-top-status${kind === 'error' ? ' is-error' : (kind === 'success' ? ' is-success' : '')}`;
            if (statusEl instanceof HTMLElement) {
                statusEl.textContent = msg;
                statusEl.className = cls;
                statusEl.hidden = !msg;
            }
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
                const kind = statusKind === true ? 'error' : (statusKind === 'error' || statusKind === 'success' ? statusKind : 'info');
                const cls = `wbo-ai-status wbo-scan-top-status${kind === 'error' ? ' is-error' : (kind === 'success' ? ' is-success' : '')}`;
                const nextStatus = modal.querySelector('#wbo-scan-status');
                if (nextStatus instanceof HTMLElement) {
                    nextStatus.textContent = statusMsg;
                    nextStatus.className = cls;
                    nextStatus.hidden = false;
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
                    const renderTitleChips = (arr, emptyText) => {
                        if (arr.length === 0) return `<span class="wbo-subtle-tip">${emptyText}</span>`;
                        const visible = arr.slice(0, 16).map((x) => `<span class="wbo-tag">${esc(x.title)}</span>`).join('');
                        const rest = arr.slice(16).map((x) => `<span class="wbo-tag" data-diff-extra hidden>${esc(x.title)}</span>`).join('');
                        const moreBtn = arr.length > 16
                            ? `<button type="button" class="wbo-link-btn wbo-diff-more-btn" data-expand-diff-chips>展开其余 ${arr.length - 16} 条</button>`
                            : '';
                        return `${visible}${rest}${moreBtn}`;
                    };

                    drawer.innerHTML = `
                        <div class="wbo-preview-head wbo-cov-drawer-head">
                            <span><b>对比结果</b>：${identical ? '两本书内容完全一样，解除其中一本即可。' : `相同 ${diff.sameCount} 条 · 仅第 1 本有 ${diff.onlyA.length} 条 · 仅第 2 本有 ${diff.onlyB.length} 条${diff.modified.length > 0 ? ` · 同名但内容不同 ${diff.modified.length} 条` : ''}`}</span>
                            <button type="button" class="wbo-link-btn" data-close-cov-drawer>收起</button>
                        </div>
                        <div class="wbo-diff-grid">
                            <div class="wbo-diff-col">
                                <div class="wbo-diff-col-head">仅「${esc(bookA)}」有（${diff.onlyA.length} 条）</div>
                                <div class="wbo-diff-chips">${renderTitleChips(diff.onlyA, '无独有条目')}</div>
                            </div>
                            <div class="wbo-diff-col">
                                <div class="wbo-diff-col-head">仅「${esc(bookB)}」有（${diff.onlyB.length} 条）</div>
                                <div class="wbo-diff-chips">${renderTitleChips(diff.onlyB, '无独有条目')}</div>
                            </div>
                        </div>
                        ${diff.modified.length > 0 ? `
                            <div class="wbo-diff-mod">
                                <div class="wbo-diff-col-head">同名但内容不同（${diff.modified.length} 条）</div>
                                <div class="wbo-diff-chips">${diff.modified.slice(0, 12).map((m) => `<span class="wbo-tag" title="${esc(bookA)}: ${m.lenA}字 / ${esc(bookB)}: ${m.lenB}字">${esc(m.title)} (${m.lenA} vs ${m.lenB}字)</span>`).join('')}</div>
                            </div>
                        ` : ''}
                    `;
                    drawer.querySelectorAll('[data-expand-diff-chips]').forEach((eb) => {
                        eb.addEventListener('click', () => {
                            const col = eb.closest('.wbo-diff-chips');
                            col?.querySelectorAll('[data-diff-extra]').forEach((el) => { el.hidden = false; });
                            eb.remove();
                        });
                    });
                    drawer.querySelector('[data-close-cov-drawer]')?.addEventListener('click', () => {
                        drawer.hidden = true;
                        drawer.removeAttribute('data-drawer-key');
                    });
                    requestAnimationFrame(() => { try { drawer.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch { /* ignore */ } });
                } catch (err) {
                    drawer.innerHTML = `<div class="wbo-preview-loading">对比失败：${esc(err?.message || err)}</div>`;
                }
            });
        });

        // On-demand embedded character_book vs local worldbook diff inside Embedded Name Matches rows
        modal.querySelectorAll('[data-cov-emb-diff]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const avatar = btn.getAttribute('data-cov-emb-diff') || '';
                const embWorld = btn.getAttribute('data-cov-emb-world') || '';
                const primaryWorld = btn.getAttribute('data-cov-primary-world') || '';
                const wrap = btn.closest('.wbo-cov-row-wrap');
                const drawer = wrap?.querySelector('.wbo-cov-drawer');
                if (!avatar || !embWorld || !(drawer instanceof HTMLElement)) return;
                const key = `embdiff:${avatar}||${embWorld}`;
                if (!drawer.hidden && drawer.getAttribute('data-drawer-key') === key) {
                    drawer.hidden = true;
                    drawer.removeAttribute('data-drawer-key');
                    return;
                }
                drawer.setAttribute('data-drawer-key', key);
                drawer.hidden = false;
                drawer.innerHTML = `<div class="wbo-preview-loading">正在对比卡内世界书与本地「${esc(embWorld)}」...</div>`;
                try {
                    const [charObj, localData] = await Promise.all([
                        fetchFullCharacterOnDemand(avatar, { allowUnshallow: false }),
                        _previewCache.has(embWorld) ? _previewCache.get(embWorld) : fetchWorldbookPreviewEntries(embWorld),
                    ]);
                    setPreviewCache(embWorld, localData);
                    if (!drawer.isConnected || drawer.getAttribute('data-drawer-key') !== key) return;
                    const embPreview = extractEmbeddedCharacterBookPreview(charObj);
                    if (!embPreview) {
                        drawer.innerHTML = '<div class="wbo-preview-loading">未能读取该角色卡的内嵌世界书条目</div>';
                        return;
                    }
                    const diff = compareWorldbookEntries(embPreview.entries || [], localData?.entries || []);
                    const identical = diff.onlyA.length === 0 && diff.onlyB.length === 0 && diff.modified.length === 0;
                    const renderTitleChips = (arr, emptyText) => {
                        if (arr.length === 0) return `<span class="wbo-subtle-tip">${emptyText}</span>`;
                        const visible = arr.slice(0, 16).map((x) => `<span class="wbo-tag">${esc(x.title)}</span>`).join('');
                        const rest = arr.slice(16).map((x) => `<span class="wbo-tag" data-diff-extra hidden>${esc(x.title)}</span>`).join('');
                        const moreBtn = arr.length > 16
                            ? `<button type="button" class="wbo-link-btn wbo-diff-more-btn" data-expand-diff-chips>展开其余 ${arr.length - 16} 条</button>`
                            : '';
                        return `${visible}${rest}${moreBtn}`;
                    };

                    drawer.innerHTML = `
                        <div class="wbo-preview-head wbo-cov-drawer-head">
                            <span><b>对比结果</b>：${identical ? '两边内容完全一样，这本本地重名书可以直接删掉。' : `内容有差异（相同 ${diff.sameCount} 条 · 仅角色卡自带 ${diff.onlyA.length} 条 · 仅本地这本有 ${diff.onlyB.length} 条${diff.modified.length > 0 ? ` · 同名但内容不同 ${diff.modified.length} 条` : ''}）`}</span>
                            <button type="button" class="wbo-link-btn" data-close-cov-drawer>收起</button>
                        </div>
                        <div class="wbo-diff-grid">
                            <div class="wbo-diff-col">
                                <div class="wbo-diff-col-head">角色卡自带独有（${diff.onlyA.length} 条）</div>
                                <div class="wbo-diff-chips">${renderTitleChips(diff.onlyA, '无独有条目')}</div>
                            </div>
                            <div class="wbo-diff-col">
                                <div class="wbo-diff-col-head">本地这本独有（${diff.onlyB.length} 条）</div>
                                <div class="wbo-diff-chips">${renderTitleChips(diff.onlyB, '无独有条目')}</div>
                            </div>
                        </div>
                        ${diff.modified.length > 0 ? `
                            <div class="wbo-diff-mod">
                                <div class="wbo-diff-col-head">同名但内容不同（${diff.modified.length} 条）</div>
                                <div class="wbo-diff-chips">${diff.modified.slice(0, 12).map((m) => `<span class="wbo-tag" title="卡内: ${m.lenA}字 / 本地: ${m.lenB}字">${esc(m.title)} (${m.lenA} vs ${m.lenB}字)</span>`).join('')}</div>
                            </div>
                        ` : ''}
                    `;
                    drawer.querySelectorAll('[data-expand-diff-chips]').forEach((eb) => {
                        eb.addEventListener('click', () => {
                            const col = eb.closest('.wbo-diff-chips');
                            col?.querySelectorAll('[data-diff-extra]').forEach((el) => { el.hidden = false; });
                            eb.remove();
                        });
                    });
                    drawer.querySelector('[data-close-cov-drawer]')?.addEventListener('click', () => {
                        drawer.hidden = true;
                        drawer.removeAttribute('data-drawer-key');
                    });
                    requestAnimationFrame(() => { try { drawer.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch { /* ignore */ } });
                } catch (err) {
                    drawer.innerHTML = `<div class="wbo-preview-loading">对比失败：${esc(err?.message || err)}</div>`;
                }
            });
        });

        // Direct 1-click clear broken User Persona worldbook reference (missing file)
        modal.querySelectorAll('[data-cov-clear-persona]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const pid = btn.getAttribute('data-cov-clear-persona') || '';
                const worldName = btn.getAttribute('data-cov-persona-world') || '';
                const personaName = btn.getAttribute('data-cov-persona-name') || pid;
                if (!pid) return;
                if (!globalThis.confirm(`确认清除 User 人设「${personaName}」对已缺失世界书「${worldName}」的绑定？`)) return;
                const tabKey = getActiveCovTabKey();
                const res = await unbindWorldbookFromPersona(pid, worldName);
                if (!res.ok) {
                    setStatus(`清除失败：${res.error || '未知错误'}`, 'error');
                    return;
                }
                await _callbacks.onRescan();
                showToast('success', `已清除 User 人设「${personaName}」的失效世界书绑定`);
                rerenderScanBody(tabKey, `已清除 User 人设「${personaName}」的失效世界书绑定`, 'success');
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
                const res = await unbindExtraWorldbookFromChar(charKey, worldName, { deferSave: true });
                if (res.ok) cleared += 1;
            }
            if (cleared > 0) {
                saveSettings();
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

        modal.querySelectorAll('[data-cov-assign-char]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const worldName = btn.getAttribute('data-cov-assign-char') || '';
                if (!worldName || !_callbacks) return;
                const matchKind = btn.getAttribute('data-cov-match-kind') || '';
                const tabKey = getActiveCovTabKey();
                const { settings: curSettings, classification: curCls } = _callbacks.getState();
                const meta = curCls.byName.get(worldName);
                const hasRealBinding = Boolean(
                    (meta?.charOwners || []).some((o) => o && o.source !== 'embedded'),
                );
                curSettings.charBookOverrides ||= {};
                if (matchKind !== 'embedded' && hasRealBinding) {
                    delete curSettings.charBookOverrides[worldName];
                } else {
                    curSettings.charBookOverrides[worldName] = 'include_in_char';
                }
                delete curSettings.assignments[worldName];
                await _callbacks.onMutation({ save: true });
                showToast('success', `已将「${worldName}」归入「角色世界书」`);
                rerenderScanBody(tabKey, `已将「${worldName}」归入「角色世界书」`, 'success');
            });
        });

        modal.querySelectorAll('[data-jump-char]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const avatar = btn.getAttribute('data-jump-char');
                if (!avatar) return;
                cancelSignal.cancelled = true;
                closeSubModal({ all: true });
                closeManagerModal();
                const ok = await openCharacterByAvatar(avatar);
                if (!ok) showToast('warning', '未能定位该角色卡');
            });
        });

        modal.querySelectorAll('[data-jump-world]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const worldName = btn.getAttribute('data-jump-world');
                if (!worldName) return;
                const wrap = btn.closest('.wbo-cov-row-wrap');
                const drawer = wrap?.querySelector('.wbo-cov-drawer');
                if (!(drawer instanceof HTMLElement)) {
                    openBookEntryBrowserModal(worldName, { stack: true });
                    return;
                }
                const key = `actions:${worldName}`;
                if (!drawer.hidden && drawer.getAttribute('data-drawer-key') === key) {
                    drawer.hidden = true;
                    drawer.removeAttribute('data-drawer-key');
                    return;
                }
                const roleText = btn.getAttribute('data-cov-role-text') || `世界书「${worldName}」`;
                const unbindKind = btn.getAttribute('data-cov-unbind-kind') || '';
                const unbindTarget = btn.getAttribute('data-cov-unbind-target') || '';
                const canUnbind = (unbindKind === 'extra' || unbindKind === 'persona') && unbindTarget;

                drawer.setAttribute('data-drawer-key', key);
                drawer.hidden = false;
                drawer.innerHTML = `
                    <div class="wbo-cov-action-strip">
                        <div class="wbo-cov-action-head">
                            <span class="wbo-cov-role-note">${esc(roleText)}</span>
                            <button type="button" class="wbo-link-btn" data-close-cov-drawer>收起</button>
                        </div>
                        <div class="wbo-cov-action-btns">
                            <button type="button" class="wbo-btn wbo-btn-primary" data-cov-inplugin-edit="${esc(worldName)}">
                                <i class="fa-regular fa-pen-to-square"></i> 插件内查看/编辑条目
                            </button>
                            <button type="button" class="wbo-btn" data-cov-native-edit="${esc(worldName)}">
                                <i class="fa-solid fa-arrow-up-right-from-square"></i> 跳去原生编辑器
                            </button>
                            ${canUnbind ? `
                                <button type="button" class="wbo-btn wbo-btn-danger" data-cov-strip-unbind="${esc(unbindKind)}" data-cov-strip-target="${esc(unbindTarget)}" data-cov-world="${esc(worldName)}">
                                    <i class="fa-solid fa-link-slash"></i> 直接解除此绑定
                                </button>
                            ` : ''}
                        </div>
                    </div>
                `;

                drawer.querySelector('[data-close-cov-drawer]')?.addEventListener('click', () => {
                    drawer.hidden = true;
                    drawer.removeAttribute('data-drawer-key');
                });
                drawer.querySelector('[data-cov-inplugin-edit]')?.addEventListener('click', () => {
                    const meta = _callbacks?.getState?.()?.classification?.byName?.get(worldName)
                        || { realName: worldName, primaryTitle: worldName };
                    openBookEntryBrowserModal(meta, { stack: true });
                });
                drawer.querySelector('[data-cov-native-edit]')?.addEventListener('click', () => {
                    cancelSignal.cancelled = true;
                    closeSubModal({ all: true });
                    closeManagerModal();
                    if (!openWorldInNativeEditor(worldName)) {
                        showToast('warning', `未能打开世界书「${worldName}」`);
                    }
                });
                drawer.querySelector('[data-cov-strip-unbind]')?.addEventListener('click', async (ev) => {
                    const stripBtn = ev.currentTarget;
                    const kind = stripBtn?.getAttribute?.('data-cov-strip-unbind') || '';
                    const targetKey = stripBtn?.getAttribute?.('data-cov-strip-target') || '';
                    if (!kind || !targetKey) return;
                    const label = kind === 'persona' ? 'User 人设世界书绑定' : '附加世界书绑定';
                    if (!globalThis.confirm(`确认直接解除「${worldName}」的${label}？\n（仅解除绑定，世界书文件不会被删除）`)) return;
                    const tabKey = getActiveCovTabKey();
                    const res = kind === 'persona'
                        ? await unbindWorldbookFromPersona(targetKey, worldName)
                        : await unbindExtraWorldbookFromChar(targetKey, worldName);
                    if (!res.ok) {
                        setStatus(`解除失败：${res.error || '未知错误'}`, 'error');
                        return;
                    }
                    await _callbacks.onRescan();
                    showToast('success', `已解除「${worldName}」的${label}`);
                    rerenderScanBody(tabKey, `已解除「${worldName}」的${label}`, 'success');
                });
            });
        });

        modal.querySelector('#wbo-scan-all-btn')?.addEventListener('click', async (ev) => {
            const btn = ev.currentTarget;
            if (btn instanceof HTMLButtonElement) {
                btn.disabled = true;
                btn.innerHTML = '<i class="fa-solid fa-arrows-rotate fa-spin"></i> <span>正在扫描...</span>';
            }
            cancelSignal.cancelled = false;

            const prevState = _callbacks.getState();
            const prevChars = getCharactersInMemory();
            const prevWorldSet = new Set(getWorldNames([...prevState.classification.byName.keys()]));
            const prevCov = summarizeCharacterWorldCoverage({
                characters: prevChars,
                bindingMap: prevState.bindingMap || new Map(),
                worldNamesSet: prevWorldSet,
                cachedCharBindings: prevState.settings.cachedCharBindings,
                settings: prevState.settings,
            });
            const prevUnimported = findCardsWithUnimportedBooks({
                characters: prevChars,
                worldNamesSet: prevWorldSet,
                cachedCharBindings: prevState.settings.cachedCharBindings,
            });
            const prevSig = JSON.stringify([
                prevChars.length,
                prevState.classification.charCount,
                prevUnimported.length,
                prevCov.multiBookChars.length,
                prevCov.missingFileChars.length,
                prevCov.orphanExtraBooks.length,
                prevCov.sharedBooks.length,
                prevCov.embeddedNameMatches.length,
                (prevCov.unboundNameMatches || []).length,
                prevCov.unboundChars.length,
            ]);

            const { settings } = prevState;
            const targets = findUnscannedShallowCharacters(prevChars, settings.cachedCharBindings);
            let scannedNewCount = 0;

            if (targets.length > 0) {
                setStatus(`正在扫描 ${targets.length} 张未加载角色卡...`);
                const res = await scanShallowCharactersInBatches(targets, {
                    signal: cancelSignal,
                    onProgress: (done, total, currentName) => {
                        setStatus(`正在扫描 (${done}/${total})：${currentName}`);
                    },
                });
                scannedNewCount = res.scanned.length;
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
                const latest = _callbacks.getState();
                const latestChars = getCharactersInMemory();
                const latestWorldSet = new Set(getWorldNames([...latest.classification.byName.keys()]));
                const latestCov = summarizeCharacterWorldCoverage({
                    characters: latestChars,
                    bindingMap: latest.bindingMap || new Map(),
                    worldNamesSet: latestWorldSet,
                    cachedCharBindings: latest.settings.cachedCharBindings,
                    settings: latest.settings,
                });
                const latestPersona = summarizePersonaWorldBindings({
                    powerUserSettings: getPowerUserSettings(),
                    worldNamesSet: latestWorldSet,
                    bindingMap: latest.bindingMap || new Map(),
                });
                const latestUnimported = findCardsWithUnimportedBooks({
                    characters: latestChars,
                    worldNamesSet: latestWorldSet,
                    cachedCharBindings: latest.settings.cachedCharBindings,
                });
                const nextSig = JSON.stringify([
                    latestChars.length,
                    latest.classification.charCount,
                    latestUnimported.length,
                    latestCov.multiBookChars.length,
                    latestCov.missingFileChars.length,
                    latestCov.orphanExtraBooks.length,
                    latestCov.sharedBooks.length,
                    latestCov.embeddedNameMatches.length,
                    (latestCov.unboundNameMatches || []).length,
                    latestCov.unboundChars.length,
                ]);
                const hasChanges = scannedNewCount > 0 || prevSig !== nextSig;
                const personaCount = Object.keys(getPowerUserSettings()?.personas || {}).length;
                const anomalyCount = latestCov.multiBookChars.length
                    + latestCov.missingFileChars.length
                    + latestCov.orphanExtraBooks.length
                    + latestCov.sharedBooks.length
                    + latestPersona.anomalyCount;
                const now = new Date();
                const hhmmss = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
                const summaryMsg = hasChanges
                    ? `${hhmmss} 扫描完成：共 ${latestChars.length} 张角色卡、${latest.classification.charCount} 本绑定书（待处理 ${anomalyCount} 项）`
                    : `${hhmmss} 已重新扫描，暂无新增变动（共 ${latestChars.length} 张角色卡、${latest.classification.charCount} 本绑定书）`;

                const nextStatus = modal.querySelector('#wbo-scan-status');
                const nextScanBtn = modal.querySelector('#wbo-scan-all-btn');
                if (nextStatus instanceof HTMLElement) {
                    nextStatus.textContent = summaryMsg;
                    nextStatus.className = 'wbo-ai-status is-success wbo-scan-top-status';
                    nextStatus.hidden = false;
                }
                if (nextScanBtn instanceof HTMLButtonElement) {
                    const restoreLabel = nextScanBtn.textContent || '重新扫描角色卡';
                    nextScanBtn.textContent = hasChanges ? '✓ 扫描完成' : '✓ 无新增变动';
                    setTimeout(() => {
                        if (nextScanBtn.isConnected) {
                            nextScanBtn.textContent = restoreLabel;
                        }
                    }, 2200);
                }
                showToast(
                    'success',
                    hasChanges
                        ? `扫描完成：已更新 ${latestChars.length} 张角色卡绑定状态`
                        : '✓ 已重新扫描，未发现新增变动',
                );
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
                const res = await importEmbeddedWorldbookForCharacter(avatars[i], {
                    worldNamesSet: knownNames,
                    deferRefresh: true,
                });
                if (res.status === 'imported') {
                    imported += 1;
                    if (res.name) knownNames.add(res.name);
                } else if (res.status === 'exists' || res.status === 'nobook') {
                    skipped += 1;
                } else {
                    failed += 1;
                }
            }

            if (imported > 0) {
                await flushWorldInfoListRefresh();
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
const QUICK_ACTION_UI_ONLY_KEYS = new Set([
    'showNativeComboBtn',
    'showNativeExcludeBtn',
    'showNativeEntrySearchBtn',
    'showNativeCharToggleBtn',
]);

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
            if (QUICK_ACTION_UI_ONLY_KEYS.has(key)) {
                await _callbacks.onMutation({ save: true, uiOnly: true, quickActionsOnly: true });
                return;
            }
            if (key === 'syncEntryOrderOnDrag') {
                await _callbacks.onMutation({ save: true, uiOnly: true });
                return;
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

    const initialSettingsTab = ['appearance', 'display', 'behavior'].includes(settings.settingsLastTab)
        ? settings.settingsLastTab
        : 'appearance';
    const quickModeButtonsHtml = [
        { id: 'merged', label: '三合一按钮' },
        { id: 'split', label: '分开显示' },
        { id: 'off', label: '隐藏顶栏按钮' },
    ].map((m) => `
        <button type="button"
            class="wbo-mode-chip${(settings.nativeQuickActionsMode || 'merged') === m.id ? ' is-active' : ''}"
            data-quick-actions-mode="${esc(m.id)}">${esc(m.label)}</button>
    `).join('');

    const { modal } = createSubModal(
        '显示与行为设置',
        `
            <div class="wbo-pinned-tabs-bar" id="wbo-settings-tabs">
                <div class="wbo-tabs">
                    <button type="button" class="wbo-tab${initialSettingsTab === 'appearance' ? ' is-active' : ''}" data-settings-tab="appearance">外观与入口</button>
                    <button type="button" class="wbo-tab${initialSettingsTab === 'display' ? ' is-active' : ''}" data-settings-tab="display">标题与排除</button>
                    <button type="button" class="wbo-tab${initialSettingsTab === 'behavior' ? ' is-active' : ''}" data-settings-tab="behavior">识别与适配</button>
                </div>
            </div>

            <div class="wbo-step-scroll">
            <div class="wbo-settings-tab-pane" data-settings-pane="appearance"${initialSettingsTab === 'appearance' ? '' : ' hidden'}>
                <div class="wbo-card">
                    <div class="wbo-ai-section-head"><span>面板配色</span></div>
                    <div class="wbo-palette-grid">${paletteButtonsHtml}</div>
                    <div class="wbo-setting-inline-row wbo-setting-theme-mode-row">
                        <span class="wbo-setting-subhead">明暗模式</span>
                        <div class="wbo-mode-group">${modeButtonsHtml}</div>
                    </div>
                    <label class="wbo-check-line">
                        <input type="checkbox" data-setting="outsideDropdownFollowHostTheme">
                        <span>插件面板外的下拉筛选框跟随酒馆主题</span>
                    </label>
                </div>

                <div class="wbo-card">
                    <div class="wbo-ai-section-head"><span>世界书原生面板快捷按钮</span></div>
                    <div class="wbo-setting-inline-row">
                        <span>顶栏右侧入口样式</span>
                        <div class="wbo-mode-group">${quickModeButtonsHtml}</div>
                    </div>
                    <div class="wbo-split-quick-checks" id="wbo-split-quick-checks"${(settings.nativeQuickActionsMode || 'merged') === 'split' ? '' : ' hidden'}>
                        <label class="wbo-check-line">
                            <input type="checkbox" data-setting="showNativeComboBtn">
                            <span>显示顶栏右侧「组合」快捷按钮</span>
                        </label>
                        <label class="wbo-check-line">
                            <input type="checkbox" data-setting="showNativeExcludeBtn">
                            <span>显示顶栏右侧「排除」快捷按钮</span>
                        </label>
                        <label class="wbo-check-line">
                            <input type="checkbox" data-setting="showNativeEntrySearchBtn">
                            <span>显示顶栏右侧「搜条目」快捷按钮</span>
                        </label>
                    </div>
                    <div class="wbo-local-divider"></div>
                    <label class="wbo-check-line">
                        <input type="checkbox" data-setting="showNativeCharToggleBtn">
                        <span>显示编辑下拉框旁「角色书显隐」按钮</span>
                    </label>
                    <div class="wbo-subtle-tip">默认「三合一按钮」仅占 1 个图标位（内含全局组合、排除分组与搜条目直达）；也可切换为分开显示或完全隐藏。</div>
                </div>
            </div>

            <div class="wbo-settings-tab-pane" data-settings-pane="display"${initialSettingsTab === 'display' ? '' : ' hidden'}>
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
                            <span class="wbo-exclude-title-wrap">
                                <span>全局激活框</span>
                                <span class="wbo-exclude-count" data-exclude-count="globalHiddenGroupIds">隐藏 ${sectionOptions.filter((s) => (settings.globalHiddenGroupIds || []).includes(s.id)).length} / 显示 ${sectionOptions.length - sectionOptions.filter((s) => (settings.globalHiddenGroupIds || []).includes(s.id)).length} 组</span>
                            </span>
                            <span class="wbo-ai-quick-picks">
                                <button type="button" class="wbo-link-btn" data-exclude-preset="select-all" data-exclude-scope="globalHiddenGroupIds">全选</button>
                                <button type="button" class="wbo-link-btn" data-exclude-preset="invert" data-exclude-scope="globalHiddenGroupIds">反选</button>
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
                            <span class="wbo-exclude-title-wrap">
                                <span>编辑下拉框</span>
                                <span class="wbo-exclude-count" data-exclude-count="editorHiddenGroupIds">隐藏 ${sectionOptions.filter((s) => (settings.editorHiddenGroupIds || []).includes(s.id)).length} / 显示 ${sectionOptions.length - sectionOptions.filter((s) => (settings.editorHiddenGroupIds || []).includes(s.id)).length} 组</span>
                            </span>
                            <span class="wbo-ai-quick-picks">
                                <button type="button" class="wbo-link-btn" data-exclude-preset="copy-global" data-exclude-scope="editorHiddenGroupIds">同全局</button>
                                <button type="button" class="wbo-link-btn" data-exclude-preset="select-all" data-exclude-scope="editorHiddenGroupIds">全选</button>
                                <button type="button" class="wbo-link-btn" data-exclude-preset="invert" data-exclude-scope="editorHiddenGroupIds">反选</button>
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

            <div class="wbo-settings-tab-pane" data-settings-pane="behavior"${initialSettingsTab === 'behavior' ? '' : ' hidden'}>
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
                    <label class="wbo-check-line">
                        <input type="checkbox" data-setting="syncEntryOrderOnDrag">
                        <span>拖动调整条目顺序时同步改写插入顺序 (order)</span>
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
        { pinnedLayout: true, floating: true },
    );

    modal.querySelectorAll('[data-settings-tab]').forEach((tabBtn) => {
        tabBtn.addEventListener('click', () => {
            const targetTab = tabBtn.getAttribute('data-settings-tab') || 'appearance';
            if (_callbacks) {
                const cur = _callbacks.getState().settings;
                cur.settingsLastTab = targetTab;
                void _callbacks.onMutation({ save: true, uiOnly: true });
            }
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

    const syncQuickActionsModeUi = () => {
        const cur = _callbacks?.getState?.()?.settings || settings;
        const curMode = cur.nativeQuickActionsMode || 'merged';
        modal.querySelectorAll('[data-quick-actions-mode]').forEach((btn) => {
            btn.classList.toggle('is-active', btn.getAttribute('data-quick-actions-mode') === curMode);
        });
        const splitBox = modal.querySelector('#wbo-split-quick-checks');
        if (splitBox instanceof HTMLElement) splitBox.hidden = curMode !== 'split';
    };
    modal.querySelectorAll('[data-quick-actions-mode]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const val = btn.getAttribute('data-quick-actions-mode');
            if (!val || !_callbacks) return;
            const cur = _callbacks.getState().settings;
            cur.nativeQuickActionsMode = val;
            syncQuickActionsModeUi();
            await _callbacks.onMutation({ save: true, uiOnly: true, quickActionsOnly: true });
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
            const hiddenCnt = sectionOptions.filter((s) => set.has(s.id)).length;
            const cntEl = modal.querySelector(`[data-exclude-count="${targetKey}"]`);
            if (cntEl) cntEl.textContent = `隐藏 ${hiddenCnt} / 显示 ${sectionOptions.length - hiddenCnt} 组`;
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
            } else if (preset === 'select-all') {
                cur[scopeKey] = sectionOptions.map((s) => s.id);
                if (cur[scopeKey].length > 0) cur.showCharBooks = false;
            } else if (preset === 'invert') {
                const prev = new Set(Array.isArray(cur[scopeKey]) ? cur[scopeKey] : []);
                cur[scopeKey] = sectionOptions.map((s) => s.id).filter((id) => !prev.has(id));
                if (cur[scopeKey].length > 0) cur.showCharBooks = false;
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
            syncQuickActionsModeUi();
            syncAllOpenModalsTheme();
        }
    });
    modal.querySelector('#wbo-settings-close-btn')?.addEventListener('click', closeSubModal);
}

/**
 * Fixed-size, theme-following 3-in-1 Quick Hub popover anchored inside `#WorldInfo`:
 * - Tab 1 (`presets`): switch Global Worldbook Combos in 1 click, overlay (+叠加), save current active books,
 *   clear all globals, or 1-click undo.
 * - Tab 2 (`exclude`): toggle Global & Editor default excluded groups.
 * - Pinned bottom bar: jump directly to `分组管理` or `搜条目`.
 *
 * @param {HTMLElement} anchorEl
 * @param {{ forceTab?: 'presets' | 'exclude' | null }} [opts]
 */
function openQuickHubPopover(anchorEl, { forceTab = null } = {}) {
    const existing = document.getElementById('wbo-quick-exclude-backdrop');
    if (existing) {
        const prevAnchorId = existing.getAttribute('data-anchor-id') || '';
        const nextAnchorId = anchorEl?.id || '';
        existing.remove();
        if (prevAnchorId === nextAnchorId) return;
    }
    closeGroupVisibilityPopover();
    if (!_callbacks) return;
    const { settings, classification } = _callbacks.getState();

    const isSplitMode = Boolean(forceTab);
    let activeHubTab = forceTab || (settings.quickHubLastTab === 'exclude' ? 'exclude' : 'presets');

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
    backdrop.setAttribute('data-anchor-id', anchorEl?.id || '');

    const pop = document.createElement('div');
    pop.className = 'wbo-modal wbo-mp-popover wbo-qe-popover wbo-qhub-popover';
    if (settings.outsideDropdownFollowHostTheme !== false) {
        pop.classList.add(detectHostThemeClass());
        pop.setAttribute('data-wbo-palette', 'host');
    } else {
        applyThemeClass(pop);
    }

    pop.innerHTML = `
        <div class="wbo-qe-head wbo-qhub-head">
            ${isSplitMode
                ? `<div class="wbo-qhub-single-title">${activeHubTab === 'exclude' ? '排除分组' : '全局组合'}</div>`
                : `
                    <div class="wbo-qhub-tabs">
                        <button type="button" class="wbo-qhub-tab${activeHubTab === 'presets' ? ' is-active' : ''}" data-qhub-tab="presets">全局组合</button>
                        <button type="button" class="wbo-qhub-tab${activeHubTab === 'exclude' ? ' is-active' : ''}" data-qhub-tab="exclude">排除分组</button>
                    </div>
                `}
            <button type="button" class="wbo-icon-btn wbo-qe-close" aria-label="关闭"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="wbo-qe-body wbo-qhub-body">
            <div class="wbo-qhub-pane" data-qhub-pane="presets"${activeHubTab === 'presets' ? '' : ' hidden'}>
                <div class="wbo-qhub-top-bar">
                    <span class="wbo-qhub-status" id="wbo-qhub-status"></span>
                    <span class="wbo-qhub-top-btns">
                        <button type="button" class="wbo-link-btn" id="wbo-qhub-save-cur-toggle">+ 存当前</button>
                        <button type="button" class="wbo-link-btn" id="wbo-qhub-free-new">自由新建</button>
                    </span>
                </div>
                <div class="wbo-qhub-save-row" id="wbo-qhub-save-row" hidden>
                    <input type="text" class="wbo-input" id="wbo-qhub-save-input" placeholder="组合名称，如：现代通用套" spellcheck="false">
                    <button type="button" class="wbo-btn wbo-btn-primary" id="wbo-qhub-save-ok">保存</button>
                    <button type="button" class="wbo-btn" id="wbo-qhub-save-cancel">取消</button>
                </div>
                <div class="wbo-qhub-undo-bar" id="wbo-qhub-undo-bar" hidden>
                    <span id="wbo-qhub-undo-text"></span>
                    <button type="button" class="wbo-btn wbo-sens-undo-btn" id="wbo-qhub-undo-btn">${UNDO_SVG}<span>撤回</span></button>
                </div>
                <div class="wbo-qhub-combo-list" id="wbo-qhub-combo-list"></div>
                <div class="wbo-qhub-sub-actions">
                    <button type="button" class="wbo-link-btn" id="wbo-qhub-open-combos">管理全部组合</button>
                    <button type="button" class="wbo-link-btn" id="wbo-qhub-clear-all">全关全局</button>
                </div>
            </div>

            <div class="wbo-qhub-pane" data-qhub-pane="exclude"${activeHubTab === 'exclude' ? '' : ' hidden'}>
                <div class="wbo-exclude-tip">勾选下方分组即在对应下拉框中隐藏（默认排除角色世界书）</div>
                <div class="wbo-exclude-block">
                    <div class="wbo-exclude-head">
                        <span class="wbo-exclude-title">全局激活框</span>
                        <span class="wbo-exclude-count" data-qe-count="globalHiddenGroupIds">已排除 ${sectionOptions.filter((s) => (settings.globalHiddenGroupIds || []).includes(s.id)).length} / ${sectionOptions.length} 组</span>
                    </div>
                    <div class="wbo-exclude-quick-row">
                        <button type="button" class="wbo-link-btn" data-qe-preset="char-only" data-qe-scope="globalHiddenGroupIds" title="恢复默认：仅排除角色世界书">默认(仅角色书)</button>
                        <button type="button" class="wbo-link-btn" data-qe-preset="select-all" data-qe-scope="globalHiddenGroupIds">全选</button>
                        <button type="button" class="wbo-link-btn" data-qe-preset="invert" data-qe-scope="globalHiddenGroupIds">反选</button>
                        <button type="button" class="wbo-link-btn" data-qe-preset="clear" data-qe-scope="globalHiddenGroupIds">清空</button>
                    </div>
                    <div class="wbo-local-cats">${renderChips('globalHiddenGroupIds', settings.globalHiddenGroupIds)}</div>
                </div>
                <div class="wbo-local-divider"></div>
                <div class="wbo-exclude-block">
                    <div class="wbo-exclude-head">
                        <span class="wbo-exclude-title">编辑下拉框</span>
                        <span class="wbo-exclude-count" data-qe-count="editorHiddenGroupIds">已排除 ${sectionOptions.filter((s) => (settings.editorHiddenGroupIds || []).includes(s.id)).length} / ${sectionOptions.length} 组</span>
                    </div>
                    <div class="wbo-exclude-quick-row">
                        <button type="button" class="wbo-link-btn" data-qe-preset="copy-global" data-qe-scope="editorHiddenGroupIds">同全局</button>
                        <button type="button" class="wbo-link-btn" data-qe-preset="char-only" data-qe-scope="editorHiddenGroupIds">仅角色书</button>
                        <button type="button" class="wbo-link-btn" data-qe-preset="select-all" data-qe-scope="editorHiddenGroupIds">全选</button>
                        <button type="button" class="wbo-link-btn" data-qe-preset="invert" data-qe-scope="editorHiddenGroupIds">反选</button>
                        <button type="button" class="wbo-link-btn" data-qe-preset="clear" data-qe-scope="editorHiddenGroupIds">清空</button>
                    </div>
                    <div class="wbo-local-cats">${renderChips('editorHiddenGroupIds', settings.editorHiddenGroupIds)}</div>
                </div>
            </div>
        </div>
        ${isSplitMode ? '' : `
        <div class="wbo-qe-foot">
            <button type="button" class="wbo-btn wbo-qe-foot-btn" id="wbo-qe-open-mgr">
                <i class="fa-solid fa-layer-group"></i> 分组管理
            </button>
            <button type="button" class="wbo-btn wbo-qe-foot-btn" id="wbo-qe-open-search">
                <i class="fa-solid fa-magnifying-glass"></i> 搜条目
            </button>
        </div>
        `}
    `;

    backdrop.appendChild(pop);
    document.body.appendChild(backdrop);
    bindDrawerSafeBubbleGuard(backdrop);
    bindDrawerSafeBubbleGuard(pop);

    const rect = anchorEl.getBoundingClientRect();
    const vw = globalThis.innerWidth || document.documentElement.clientWidth || 390;
    const vh = globalThis.innerHeight || document.documentElement.clientHeight || 800;
    const popW = Math.min(348, vw - 20);
    const left = Math.max(10, Math.min(rect.right - popW, vw - popW - 10));
    const spaceBelow = vh - rect.bottom - 14;
    const spaceAbove = rect.top - 14;
    const openAbove = spaceBelow < 240 && spaceAbove > spaceBelow;
    const availSpace = Math.floor((openAbove ? spaceAbove : spaceBelow) - 6);
    const fixedH = Math.max(230, Math.min(380, availSpace));
    pop.style.width = `${Math.round(popW)}px`;
    pop.style.height = `${fixedH}px`;
    pop.style.maxHeight = `${fixedH}px`;
    pop.style.left = `${Math.round(left)}px`;
    if (openAbove) {
        pop.style.bottom = `${Math.round(vh - rect.top + 6)}px`;
        pop.style.top = 'auto';
    } else {
        pop.style.top = `${Math.round(rect.bottom + 6)}px`;
        pop.style.bottom = 'auto';
    }

    const qhubStatusEl = pop.querySelector('#wbo-qhub-status');
    const qhubSaveToggleBtn = pop.querySelector('#wbo-qhub-save-cur-toggle');
    const qhubSaveRow = pop.querySelector('#wbo-qhub-save-row');
    const qhubSaveInput = pop.querySelector('#wbo-qhub-save-input');
    const qhubUndoBar = pop.querySelector('#wbo-qhub-undo-bar');
    const qhubUndoText = pop.querySelector('#wbo-qhub-undo-text');
    const qhubListEl = pop.querySelector('#wbo-qhub-combo-list');
    const qhubClearBtn = pop.querySelector('#wbo-qhub-clear-all');

    const renderQhubCombos = () => {
        const curState = _callbacks?.getState?.() || { settings, classification };
        const curSettings = curState.settings;
        const curCls = curState.classification;
        const presets = Array.isArray(curSettings.globalPresets) ? curSettings.globalPresets : [];
        const activeGlobals = getActiveGlobalWorldSet();
        const matched = findMatchingGlobalPreset(presets, activeGlobals);

        if (qhubStatusEl) {
            qhubStatusEl.innerHTML = matched
                ? `已开 <b>${activeGlobals.size}</b> 本 · 生效：<b>${esc(matched.name)}</b>`
                : `当前已开 <b>${activeGlobals.size}</b> 本全局书`;
        }
        if (qhubSaveToggleBtn instanceof HTMLButtonElement) {
            qhubSaveToggleBtn.disabled = activeGlobals.size === 0;
        }
        if (qhubClearBtn instanceof HTMLButtonElement) {
            qhubClearBtn.disabled = activeGlobals.size === 0;
            qhubClearBtn.textContent = activeGlobals.size > 0 ? `全关全局 (${activeGlobals.size})` : '全关全局';
        }
        if (qhubUndoBar instanceof HTMLElement) {
            qhubUndoBar.hidden = !_lastGlobalSwitchUndo;
            if (_lastGlobalSwitchUndo && qhubUndoText) {
                qhubUndoText.textContent = `刚执行：${_lastGlobalSwitchUndo.label}`;
            }
        }
        if (!qhubListEl) return;
        if (presets.length === 0) {
            qhubListEl.innerHTML = `
                <div class="wbo-empty-hint wbo-qhub-empty">
                    <div class="wbo-qhub-empty-title">暂无已保存的全局组合</div>
                    <div class="wbo-qhub-empty-steps">
                        <div>• 点<b>「+ 存当前」</b>：保存当前已开的全局书</div>
                        <div>• 点<b>「自由新建」</b>：勾选任意世界书搭配组合</div>
                    </div>
                </div>
            `;
            return;
        }
        qhubListEl.innerHTML = presets.map((p) => {
            const isMatched = matched?.id === p.id;
            const previewTitles = p.books
                .slice(0, 3)
                .map((n) => curCls?.byName?.get(n)?.primaryTitle || n)
                .join('、');
            const moreCnt = p.books.length > 3 ? ` 等 ${p.books.length} 本` : '';
            return `
                <div class="wbo-qhub-combo-row${isMatched ? ' is-active' : ''}">
                    <button type="button" class="wbo-qhub-combo-main" data-qhub-apply="${esc(p.id)}" title="点击一键切换为此组合">
                        <span class="wbo-qhub-combo-title">
                            <span>${esc(p.name)}</span>
                            <span class="wbo-tag">${p.books.length}本</span>
                            ${isMatched ? '<span class="wbo-tag is-on-tag">生效</span>' : ''}
                        </span>
                        <span class="wbo-qhub-combo-sub">${esc(`${previewTitles}${moreCnt}`)}</span>
                    </button>
                    <div class="wbo-qhub-combo-acts">
                        <button type="button" class="wbo-btn wbo-qhub-mini-btn" data-qhub-add="${esc(p.id)}" title="保留已开并叠加开启">+叠加</button>
                        <button type="button" class="wbo-icon-btn" data-qhub-edit="${esc(p.id)}" title="编辑此组合"><i class="fa-solid fa-pen"></i></button>
                        <button type="button" class="wbo-icon-btn wbo-icon-danger" data-qhub-delete="${esc(p.id)}" title="删除此组合" aria-label="删除此组合"><i class="fa-regular fa-trash-can"></i></button>
                    </div>
                </div>
            `;
        }).join('');
    };

    const syncExcludeUi = () => {
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
            const hiddenCnt = sectionOptions.filter((s) => set.has(s.id)).length;
            const cntEl = pop.querySelector(`[data-qe-count="${key}"]`);
            if (cntEl) cntEl.textContent = `已排除 ${hiddenCnt} / ${sectionOptions.length} 组`;
        }
    };

    renderQhubCombos();

    pop.querySelectorAll('[data-qhub-tab]').forEach((tabBtn) => {
        tabBtn.addEventListener('click', () => {
            const nextTab = tabBtn.getAttribute('data-qhub-tab') === 'exclude' ? 'exclude' : 'presets';
            activeHubTab = nextTab;
            if (!forceTab && _callbacks) {
                const cur = _callbacks.getState().settings;
                cur.quickHubLastTab = nextTab;
                void _callbacks.onMutation({ save: true, uiOnly: true });
            }
            pop.querySelectorAll('[data-qhub-tab]').forEach((b) => {
                b.classList.toggle('is-active', b.getAttribute('data-qhub-tab') === nextTab);
            });
            pop.querySelectorAll('[data-qhub-pane]').forEach((pane) => {
                if (pane instanceof HTMLElement) {
                    pane.hidden = pane.getAttribute('data-qhub-pane') !== nextTab;
                }
            });
            const bodyEl = pop.querySelector('.wbo-qhub-body');
            if (bodyEl) bodyEl.scrollTop = 0;
        });
    });

    qhubSaveToggleBtn?.addEventListener('click', () => {
        if (!(qhubSaveRow instanceof HTMLElement)) return;
        const willShow = qhubSaveRow.hidden;
        qhubSaveRow.hidden = !willShow;
        if (willShow && qhubSaveInput instanceof HTMLInputElement && isDesktopAutoFocusAllowed()) {
            qhubSaveInput.focus();
        }
    });
    pop.querySelector('#wbo-qhub-save-cancel')?.addEventListener('click', () => {
        if (qhubSaveRow instanceof HTMLElement) qhubSaveRow.hidden = true;
    });
    const confirmQuickSaveCurrent = async () => {
        if (!_callbacks) return;
        const cur = _callbacks.getState().settings;
        const activeGlobals = getActiveGlobalWorldSet();
        const name = qhubSaveInput instanceof HTMLInputElement ? qhubSaveInput.value.trim() : '';
        const res = upsertGlobalPreset(cur, { name, books: activeGlobals });
        if (!res.ok) {
            showToast('warning', res.error || '保存失败');
            return;
        }
        if (qhubSaveInput instanceof HTMLInputElement) qhubSaveInput.value = '';
        if (qhubSaveRow instanceof HTMLElement) qhubSaveRow.hidden = true;
        await _callbacks.onMutation({ save: true, uiOnly: true });
        syncNativeQuickComboTitles();
        syncManagerComboStripUi();
        renderQhubCombos();
        showToast('success', `已保存全局组合「${res.preset?.name}」（${activeGlobals.size} 本）`);
    };
    pop.querySelector('#wbo-qhub-save-ok')?.addEventListener('click', () => { void confirmQuickSaveCurrent(); });
    bindImeSafeEnter(qhubSaveInput, () => { void confirmQuickSaveCurrent(); });

    pop.querySelector('#wbo-qhub-free-new')?.addEventListener('click', () => {
        closeGroupVisibilityPopover();
        openGlobalCombosModal({ initialMode: 'create' });
    });
    pop.querySelector('#wbo-qhub-open-combos')?.addEventListener('click', () => {
        closeGroupVisibilityPopover();
        openGlobalCombosModal();
    });
    qhubClearBtn?.addEventListener('click', () => {
        const activeGlobals = getActiveGlobalWorldSet();
        if (activeGlobals.size === 0) return;
        const sw = executeGlobalBooksSwitch([], {
            mode: 'replace',
            label: `全关 (${activeGlobals.size}本)`,
        });
        if (sw.ok) {
            renderQhubCombos();
            showToast('info', `已关闭全部 ${sw.prevActive.length} 本全局世界书`);
        }
    });
    pop.querySelector('#wbo-qhub-undo-btn')?.addEventListener('click', () => {
        if (!_lastGlobalSwitchUndo) return;
        const snap = _lastGlobalSwitchUndo;
        _lastGlobalSwitchUndo = null;
        const sw = executeGlobalBooksSwitch(snap.prevBooks, { mode: 'replace', recordUndo: false });
        if (sw.ok) {
            renderQhubCombos();
            showToast('info', `已撤回，恢复 ${sw.nextActive.length} 本全局世界书`);
        }
    });
    qhubListEl?.addEventListener('click', (ev) => {
        const target = ev.target instanceof Element ? ev.target : null;
        if (!target || !_callbacks) return;
        const cur = _callbacks.getState().settings;
        const applyBtn = target.closest('[data-qhub-apply]');
        if (applyBtn) {
            const id = applyBtn.getAttribute('data-qhub-apply') || '';
            const preset = (cur.globalPresets || []).find((p) => p.id === id);
            if (preset) {
                const sw = executeGlobalBooksSwitch(preset.books, {
                    mode: 'replace',
                    label: `启用「${preset.name}」`,
                });
                if (sw.ok) {
                    renderQhubCombos();
                    showToast('success', `已切换至「${preset.name}」（共开启 ${sw.nextActive.length} 本）`);
                }
            }
            return;
        }
        const addBtn = target.closest('[data-qhub-add]');
        if (addBtn) {
            const id = addBtn.getAttribute('data-qhub-add') || '';
            const preset = (cur.globalPresets || []).find((p) => p.id === id);
            if (preset) {
                const sw = executeGlobalBooksSwitch(preset.books, {
                    mode: 'add',
                    label: `叠加「${preset.name}」`,
                });
                if (sw.ok) {
                    renderQhubCombos();
                    showToast('success', `已叠加开启「${preset.name}」（共 ${sw.nextActive.length} 本）`);
                }
            }
            return;
        }
        const editBtn = target.closest('[data-qhub-edit]');
        if (editBtn) {
            const id = editBtn.getAttribute('data-qhub-edit') || '';
            closeGroupVisibilityPopover();
            openGlobalCombosModal({ editPresetId: id });
            return;
        }
        const delBtn = target.closest('[data-qhub-delete]');
        if (delBtn) {
            const id = delBtn.getAttribute('data-qhub-delete') || '';
            const preset = (cur.globalPresets || []).find((p) => p.id === id);
            if (!preset) return;
            if (!globalThis.confirm(`确认删除全局组合「${preset.name}」吗？\n（仅删除组合方案，不会删除世界书）`)) return;
            deleteGlobalPreset(cur, id);
            void _callbacks.onMutation({ save: true, uiOnly: true });
            syncManagerComboStripUi();
            syncNativeQuickComboTitles();
            renderQhubCombos();
            showToast('success', `已删除组合「${preset.name}」`);
        }
    });

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
            syncExcludeUi();
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
            } else if (preset === 'select-all') {
                cur[scopeKey] = sectionOptions.map((s) => s.id);
                if (cur[scopeKey].length > 0) cur.showCharBooks = false;
            } else if (preset === 'invert') {
                const prev = new Set(Array.isArray(cur[scopeKey]) ? cur[scopeKey] : []);
                cur[scopeKey] = sectionOptions.map((s) => s.id).filter((id) => !prev.has(id));
                if (cur[scopeKey].length > 0) cur.showCharBooks = false;
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
            syncExcludeUi();
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

function openQuickExcludePopover(anchorEl) {
    openQuickHubPopover(anchorEl, { forceTab: 'exclude' });
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
    bindDrawerSafeBubbleGuard(backdrop);
    bindDrawerSafeBubbleGuard(pop);

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
    const hasEntryGroups = isEntryGroupsInstalled();
    const entryGroupsItemHtml = hasEntryGroups
        ? `
        <button type="button" class="wbo-book-more-item" data-more-act="open-entry-groups">
            <i class="fa-solid fa-folder-tree"></i><span>条目分组</span>
        </button>`
        : '';
    pop.innerHTML = `
        <button type="button" class="wbo-book-more-item" data-more-act="edit-book">
            <i class="fa-solid fa-arrow-up-right-from-square"></i><span>在编辑器中打开</span>
        </button>
        ${entryGroupsItemHtml}
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
    bindDrawerSafeBubbleGuard(backdrop);
    bindDrawerSafeBubbleGuard(pop);

    const rect = anchorBtn.getBoundingClientRect();
    const vw = globalThis.innerWidth || document.documentElement.clientWidth || 390;
    const vh = globalThis.innerHeight || document.documentElement.clientHeight || 800;
    const popW = 164;
    const minH = hasEntryGroups ? 216 : 184;
    const left = Math.max(10, Math.min(rect.right - popW, vw - popW - 10));
    const openAbove = vh - rect.bottom < minH && rect.top > minH;
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
            } else if (act === 'open-entry-groups') {
                openEntryGroupsForBook(bookMeta.realName);
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
            if (queryInput instanceof HTMLInputElement && isDesktopAutoFocusAllowed()) queryInput.focus();
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
        setTimeout(() => queryInput.focus(), 20);
    }
}

/**
 * Remove all DOM nodes mounted by this panel module cleanly.
 */
export function teardownPanels() {
    _isSyncingEmbeddedIndicators = false;
    _searchQuery = '';
    destroyAllPreviewControllers();
    removeRestorePill();
    cancelManagerInlineEntrySearch();
    closeGroupVisibilityPopover();
    clearTimeout(_mgrSearchTimer);
    _mgrSearchTimer = null;
    _charBtnWidthObserver?.disconnect();
    _charBtnWidthObserver = null;
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
