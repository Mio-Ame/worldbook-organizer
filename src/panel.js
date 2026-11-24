/**
 * Worldbook Organizer — Zero-footprint `#WorldInfo` header controls +
 * standalone sticky-header Group Manager modal + collapsible API channels +
 * full character-worldbook coverage scan modal.
 */

import {
    GROUP_COLOR_PALETTE,
    SPECIAL_GROUPS,
    addCustomGroup,
    applyAiOrganizeProposals,
    buildAiOrganizePrompt,
    createApiChannelId,
    exportConfigData,
    findCardsWithUnimportedBooks,
    findUnscannedShallowCharacters,
    importConfigData,
    matchesSearch,
    moveSectionOrder,
    parseAiOrganizeResponse,
    summarizeCharacterWorldCoverage,
    undoLastAiOrganize,
    updateCachedCharBindings,
} from './core.js';
import {
    applyTauriSurface,
    callCustomApiForOrganize,
    callHostAiForOrganize,
    fetchCustomApiModels,
    fetchWorldbookCluesOnDemand,
    getActiveGlobalWorldSet,
    getCharactersInMemory,
    getCurrentEditorWorldName,
    getWorldNames,
    importEmbeddedWorldbookForCharacter,
    readBaiBaiSharedChannels,
    realRenameWorldbook,
    scanShallowCharactersInBatches,
    showToast,
    testCustomApiChannel,
} from './host.js';
import {
    isNativeMobileSelectMode,
    openWorldInNativeEditor,
    setGlobalWorldActive,
    setMobileSearchFilter,
} from './native-filter.js';

const HEADER_BAR_ID = 'wbo-header-bar';
const MOBILE_SEARCH_ID = 'wbo-mobile-search-bar';
const SETTINGS_ROOT_ID = 'wbo-extension-settings';
const MANAGER_OVERLAY_ID = 'wbo-manager-overlay';
const SUBMODAL_OVERLAY_ID = 'wbo-submodal-overlay';

let _searchQuery = '';
let _isComposing = false;
let _callbacks = null;

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
 * Mount minimal zero-footprint controls right into `#WorldInfo`'s existing title row
 * (`margin-left: auto`), adding 0px vertical bloat to the native World Info page!
 * @returns {HTMLElement | null}
 */
function ensureHeaderBar() {
    let bar = document.getElementById(HEADER_BAR_ID);
    if (bar) return bar;

    const wiDrawer = document.getElementById('WorldInfo');
    if (!wiDrawer) return null;

    // Locate the native `🔒 世界书` header row
    const pinDiv = document.getElementById('WI_panel_pin_div');
    const titleRow = pinDiv?.parentElement || wiDrawer.querySelector('.flex-container');
    if (!titleRow) return null;

    bar = document.createElement('div');
    bar.id = HEADER_BAR_ID;
    bar.className = 'wbo-header-bar';
    bar.innerHTML = `
        <label class="wbo-tool-switch" title="开启后显示角色卡绑定的世界书，关闭则隐藏">
            <input type="checkbox" class="wbo-show-char-checkbox" id="wbo-hdr-show-char">
            <span class="wbo-switch-track"></span>
            <span id="wbo-hdr-char-label">角色书 0</span>
        </label>
        <select class="wbo-tool-select" id="wbo-hdr-group-select" title="按分组筛选世界书" hidden></select>
        <button type="button" class="wbo-tool-btn" id="wbo-hdr-open-manager" title="打开世界书分组管理">
            <i class="fa-solid fa-layer-group"></i>
            <span id="wbo-hdr-manager-label">分组管理</span>
        </button>
    `;

    titleRow.appendChild(bar);

    // Bind header bar events once
    bar.querySelector('#wbo-hdr-show-char')?.addEventListener('change', async (ev) => {
        if (!_callbacks) return;
        const cb = ev.currentTarget;
        if (!(cb instanceof HTMLInputElement)) return;
        const { settings } = _callbacks.getState();
        settings.showCharBooks = cb.checked;
        if (!settings.showCharBooks && settings.activeFilterGroupId === SPECIAL_GROUPS.CHARACTER) {
            settings.activeFilterGroupId = SPECIAL_GROUPS.DEFAULT;
        }
        if (settings.showCharBooks) {
            settings.charGroupCollapsed = false;
        }
        await _callbacks.onMutation({ save: true });
    });

    bar.querySelector('#wbo-hdr-group-select')?.addEventListener('change', async (ev) => {
        if (!_callbacks) return;
        const sel = ev.currentTarget;
        if (!(sel instanceof HTMLSelectElement)) return;
        const { settings } = _callbacks.getState();
        settings.activeFilterGroupId = sel.value || SPECIAL_GROUPS.DEFAULT;
        if (settings.activeFilterGroupId === SPECIAL_GROUPS.CHARACTER) {
            settings.charGroupCollapsed = false;
        }
        await _callbacks.onMutation({ save: true });
    });

    bar.querySelector('#wbo-hdr-open-manager')?.addEventListener('click', (ev) => {
        ev.stopPropagation();
        openManagerModal();
    });

    // Optional ultra-slim search bar ONLY on mobile native selects that lack Select2 search
    ensureMobileSearchBar();
    return bar;
}

/**
 * Mount a slim IME-safe search bar ONLY when `#world_editor_select` lacks Select2
 * (e.g. TauriTavern iOS/Android mobile). Completely hidden on desktop!
 */
function ensureMobileSearchBar() {
    let wrap = document.getElementById(MOBILE_SEARCH_ID);
    const mobileNoSelect2 = isNativeMobileSelectMode();

    if (!mobileNoSelect2) {
        if (wrap) wrap.hidden = true;
        return;
    }

    if (!wrap) {
        const holder = document.getElementById('wi-holder');
        const worldPopup = document.getElementById('world_popup');
        if (!holder) return;

        wrap = document.createElement('div');
        wrap.id = MOBILE_SEARCH_ID;
        wrap.className = 'wbo-mobile-search-bar';
        wrap.innerHTML = `
            <i class="fa-solid fa-magnifying-glass"></i>
            <input type="search" class="wbo-search-input" id="wbo-mobile-search-input" placeholder="搜索世界书 / 角色名..." autocomplete="off" spellcheck="false">
        `;
        if (worldPopup && worldPopup.parentElement === holder) {
            holder.insertBefore(wrap, worldPopup);
        } else {
            holder.appendChild(wrap);
        }

        const input = wrap.querySelector('#wbo-mobile-search-input');
        if (input instanceof HTMLInputElement) {
            let composing = false;
            input.addEventListener('compositionstart', () => { composing = true; });
            input.addEventListener('compositionend', () => {
                composing = false;
                setMobileSearchFilter(input.value);
            });
            input.addEventListener('input', () => {
                if (composing) return;
                setMobileSearchFilter(input.value);
            });
        }
    }

    wrap.hidden = false;
}

/**
 * Sync the lightweight header controls AND the Group Manager modal (if open).
 */
export function renderEmbeddedPanel() {
    if (!_callbacks) return;
    const bar = ensureHeaderBar();
    ensureMobileSearchBar();

    const { settings, classification } = _callbacks.getState();
    const hasCustomGroups = classification.customGroups.length > 0;
    const orderedSections = classification.orderedSections || [];

    const characters = getCharactersInMemory();
    const unscannedShallowCount = findUnscannedShallowCharacters(characters, settings.cachedCharBindings).length;
    const unimportedBookCount = findCardsWithUnimportedBooks({
        characters,
        worldNamesSet: new Set(classification.byName.keys()),
        cachedCharBindings: settings.cachedCharBindings,
    }).length;
    const scanBadgeCount = unscannedShallowCount + unimportedBookCount;

    if (bar) {
        const cb = bar.querySelector('#wbo-hdr-show-char');
        const lbl = bar.querySelector('#wbo-hdr-char-label');
        if (cb instanceof HTMLInputElement) cb.checked = Boolean(settings.showCharBooks);
        if (lbl) lbl.textContent = `角色书 ${classification.charCount}`;

        const quickSel = bar.querySelector('#wbo-hdr-group-select');
        if (quickSel instanceof HTMLSelectElement) {
            if (hasCustomGroups) {
                const opts = [
                    {
                        id: SPECIAL_GROUPS.DEFAULT,
                        label: settings.showCharBooks ? `全部 (${classification.totalCount})` : `通用 (${classification.nonCharCount})`,
                    },
                    ...orderedSections.map((sec) => ({
                        id: sec.id,
                        label: `${sec.name} (${sec.books.length})`,
                    })),
                ];
                quickSel.innerHTML = opts
                    .map((o) => `<option value="${esc(o.id)}"${o.id === settings.activeFilterGroupId ? ' selected' : ''}>${esc(o.label)}</option>`)
                    .join('');
                quickSel.hidden = false;
            } else {
                quickSel.hidden = true;
            }
        }

        const mgrLabel = bar.querySelector('#wbo-hdr-manager-label');
        if (mgrLabel) {
            mgrLabel.textContent = scanBadgeCount > 0 ? `分组管理 · ${scanBadgeCount}` : '分组管理';
        }
    }

    // If the Group Manager modal is currently open, refresh it cleanly in place
    if (document.getElementById(MANAGER_OVERLAY_ID)) {
        refreshManagerModalContent();
    }
}

/**
 * Lightweight in-place sync when native `#world_info` or `#world_editor_select` changes.
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
        row.classList.toggle('is-active', isActive);
        row.classList.toggle('is-editing', isEditing);
        const globalBtn = row.querySelector('[data-action="toggle-global"]');
        if (globalBtn) {
            globalBtn.classList.toggle('is-on', isActive);
            globalBtn.textContent = isActive ? '已全局' : '全局';
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
                ${isActive ? '已全局' : '全局'}
            </button>
        `;

    return `
        <div class="wbo-book-row${isActive && !book.isInCharGroup ? ' is-active' : ''}${isEditing ? ' is-editing' : ''}" data-book="${esc(book.realName)}">
            <button type="button" class="wbo-book-main" data-action="edit-book" title="${esc(book.realName)}">
                <div class="wbo-book-title-line">
                    <span class="wbo-book-title">${esc(book.primaryTitle)}</span>
                    ${subHtml}
                    ${extraTag}
                    ${ownerHint}
                    ${personaHint}
                </div>
                ${noteHtml}
            </button>
            <div class="wbo-book-actions">
                ${globalBtnHtml}
                <button type="button" class="wbo-icon-btn" data-action="rename-alias" title="编辑名称与备注">
                    <i class="fa-solid fa-tag"></i>
                </button>
                <button type="button" class="wbo-icon-btn" data-action="move-group" title="移动分组">
                    <i class="fa-solid fa-folder-open"></i>
                </button>
            </div>
        </div>
    `;
}

/**
 * Render one collapsible group section with sticky header (`position: sticky; top: 0`).
 */
function renderGroupSectionHtml({
    id,
    name,
    color,
    collapsed,
    isCustom,
    canMoveUp,
    canMoveDown,
    books,
    activeGlobals,
    currentEditor,
}) {
    const activeCount = books.filter((b) => activeGlobals.has(b.realName)).length;
    const countLabel = activeCount > 0 ? `${activeCount}/${books.length}` : `${books.length}`;
    const orderActions = `
        <button type="button" class="wbo-icon-btn" data-action="move-section-up" data-group-id="${esc(id)}" ${canMoveUp ? '' : 'disabled'} title="上移">
            <i class="fa-solid fa-arrow-up"></i>
        </button>
        <button type="button" class="wbo-icon-btn" data-action="move-section-down" data-group-id="${esc(id)}" ${canMoveDown ? '' : 'disabled'} title="下移">
            <i class="fa-solid fa-arrow-down"></i>
        </button>
    `;
    const customActions = isCustom
        ? `
            <button type="button" class="wbo-icon-btn" data-action="rename-group" data-group-id="${esc(id)}" title="重命名">
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
            : `<div class="wbo-group-body wbo-empty-hint">暂无世界书</div>`);

    return `
        <div class="wbo-group${collapsed ? ' is-collapsed' : ''}" data-group-id="${esc(id)}">
            <div class="wbo-group-header">
                <button type="button" class="wbo-group-toggle" data-action="toggle-group-collapse" data-group-id="${esc(id)}" aria-expanded="${!collapsed}">
                    <i class="fa-solid ${collapsed ? 'fa-chevron-right' : 'fa-chevron-down'} wbo-chevron"></i>
                    <span class="wbo-group-dot" style="background:${esc(color)}"></span>
                    <span class="wbo-group-name">${esc(name)}</span>
                    <span class="wbo-group-count">${esc(countLabel)}</span>
                </button>
                <div class="wbo-group-actions">
                    ${orderActions}
                    ${customActions}
                </div>
            </div>
            ${rowsHtml}
        </div>
    `;
}

function closeManagerModal() {
    document.getElementById(MANAGER_OVERLAY_ID)?.remove();
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

    const overlay = document.createElement('div');
    overlay.id = MANAGER_OVERLAY_ID;
    overlay.className = 'wbo-modal-overlay';
    applyTauriSurface(overlay, 'backdrop');

    const modal = document.createElement('div');
    modal.className = 'wbo-modal wbo-manager-modal';
    applyTauriSurface(modal, 'fullscreen-window');

    modal.innerHTML = `
        <div class="wbo-modal-header">
            <span class="wbo-modal-title">世界书分组管理</span>
            <div class="wbo-mgr-header-tools">
                <label class="wbo-tool-switch" title="开启后显示角色卡世界书，关闭则隐藏">
                    <input type="checkbox" class="wbo-show-char-checkbox" id="wbo-mgr-show-char">
                    <span class="wbo-switch-track"></span>
                    <span id="wbo-mgr-char-label">角色书 0</span>
                </label>
                <button type="button" class="wbo-tool-btn" data-action="create-group" title="新建分组">
                    <i class="fa-solid fa-folder-plus"></i>
                    <span>新建</span>
                </button>
                <button type="button" class="wbo-tool-btn" data-action="open-ai-organize" title="AI 整理命名与分类">
                    <i class="fa-solid fa-wand-magic-sparkles"></i>
                    <span>AI整理</span>
                </button>
                <button type="button" class="wbo-tool-btn" id="wbo-mgr-undo-btn" data-action="undo-ai" title="撤销上次 AI 整理" hidden>
                    <i class="fa-solid fa-rotate-left"></i>
                    <span>撤销</span>
                </button>
                <button type="button" class="wbo-tool-btn" id="wbo-mgr-scan-btn" data-action="open-scan-modal" title="扫描角色世界书">
                    <i class="fa-solid fa-arrows-rotate"></i>
                    <span id="wbo-mgr-scan-label">扫描</span>
                </button>
                <button type="button" class="wbo-icon-btn wbo-modal-close" aria-label="关闭">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>
        </div>
        <div class="wbo-mgr-subbar">
            <div class="wbo-pills" id="wbo-mgr-pills"></div>
            <div class="wbo-search-wrap">
                <i class="fa-solid fa-magnifying-glass"></i>
                <input type="search" class="wbo-search-input" id="wbo-mgr-search-input" value="${esc(_searchQuery)}" placeholder="搜索世界书 / 角色名..." autocomplete="off" spellcheck="false">
            </div>
        </div>
        <div class="wbo-groups-list wbo-mgr-list" id="wbo-mgr-groups-list"></div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Isolate all pointer/mouse/click events so `#WorldInfo` never auto-closes
    const stopAll = (ev) => ev.stopPropagation();
    for (const evtName of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend']) {
        overlay.addEventListener(evtName, stopAll);
    }
    overlay.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (ev.target === overlay) closeManagerModal();
    });
    modal.querySelector('.wbo-modal-close')?.addEventListener('click', (ev) => {
        ev.stopPropagation();
        closeManagerModal();
    });

    // IME-safe persistent search input inside modal
    const searchInput = modal.querySelector('#wbo-mgr-search-input');
    if (searchInput instanceof HTMLInputElement) {
        searchInput.addEventListener('compositionstart', () => { _isComposing = true; });
        searchInput.addEventListener('compositionend', () => {
            _isComposing = false;
            _searchQuery = searchInput.value;
            renderManagerGroupsListOnly();
        });
        searchInput.addEventListener('input', () => {
            if (_isComposing) return;
            _searchQuery = searchInput.value;
            renderManagerGroupsListOnly();
        });
    }

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
        }
        await _callbacks.onMutation({ save: true });
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
                await _callbacks.onMutation({ save: true });
                break;
            }
            case 'select-filter': {
                const gid = target.getAttribute('data-group-id') || SPECIAL_GROUPS.DEFAULT;
                settings.activeFilterGroupId = gid;
                if (gid === SPECIAL_GROUPS.CHARACTER) {
                    settings.charGroupCollapsed = false;
                }
                await _callbacks.onMutation({ save: true });
                break;
            }
            case 'toggle-group-collapse': {
                const gid = target.getAttribute('data-group-id');
                if (gid === SPECIAL_GROUPS.CHARACTER) {
                    settings.charGroupCollapsed = !settings.charGroupCollapsed;
                } else if (gid === SPECIAL_GROUPS.UNGROUPED) {
                    settings.ungroupedCollapsed = !settings.ungroupedCollapsed;
                } else {
                    const grp = settings.groups.find((g) => g.id === gid);
                    if (grp) grp.collapsed = !grp.collapsed;
                }
                renderManagerGroupsListOnly();
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
                const wiDrawer = document.getElementById('WorldInfo');
                const prevDrawerScroll = wiDrawer ? wiDrawer.scrollTop : 0;
                const nextActive = !getActiveGlobalWorldSet().has(bookName);
                setGlobalWorldActive(bookName, nextActive);
                syncEmbeddedPanelIndicators();
                // Lock background drawer scroll so toggling global never jumps page
                if (wiDrawer) {
                    wiDrawer.scrollTop = prevDrawerScroll;
                    requestAnimationFrame(() => { wiDrawer.scrollTop = prevDrawerScroll; });
                }
                break;
            }
            case 'edit-book': {
                const row = target.closest('.wbo-book-row');
                const bookName = row?.getAttribute('data-book');
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
            case 'open-ai-organize': {
                openAiOrganizeModal();
                break;
            }
            case 'undo-ai': {
                if (undoLastAiOrganize(settings)) {
                    await _callbacks.onMutation({ save: true });
                    showToast('success', '已撤销上一次 AI 整理');
                }
                break;
            }
            case 'open-scan-modal': {
                openScanAndImportModal();
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

    const undoBtn = overlay.querySelector('#wbo-mgr-undo-btn');
    if (undoBtn instanceof HTMLElement) {
        undoBtn.hidden = !(Array.isArray(settings.undoSnapshots) && settings.undoSnapshots.length > 0);
    }

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

    const pillsEl = overlay.querySelector('#wbo-mgr-pills');
    if (pillsEl) {
        const pills = [
            {
                id: SPECIAL_GROUPS.DEFAULT,
                label: settings.showCharBooks ? '全部' : '通用',
                count: settings.showCharBooks ? classification.totalCount : classification.nonCharCount,
            },
            ...orderedSections
                .filter((sec) => !(sec.kind === 'ungrouped' && !hasCustomGroups))
                .map((sec) => ({
                    id: sec.id,
                    label: sec.name,
                    color: sec.kind === 'custom' ? sec.color : undefined,
                    count: sec.books.length,
                })),
        ];
        pillsEl.innerHTML = pills
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
            .join('');
    }

    renderManagerGroupsListOnly();
}

/**
 * Re-render ONLY `#wbo-mgr-groups-list` while preserving scroll position and search input!
 */
function renderManagerGroupsListOnly() {
    if (!_callbacks) return;
    const listEl = document.getElementById('wbo-mgr-groups-list');
    if (!listEl) return;

    const prevScroll = listEl.scrollTop;
    const { settings, classification } = _callbacks.getState();
    const activeGlobals = getActiveGlobalWorldSet();
    const currentEditor = getCurrentEditorWorldName();
    const q = _searchQuery.trim();
    const hasCustomGroups = classification.customGroups.length > 0;
    const orderedSections = classification.orderedSections || [];
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
            const books = q ? sec.books.filter((b) => matchesSearch(b, q)) : sec.books;
            if (q && books.length === 0) return;
            sections.push(
                renderGroupSectionHtml({
                    id: sec.id,
                    name: sec.name,
                    color: sec.color,
                    collapsed: q ? false : Boolean(sec.collapsed),
                    isCustom: true,
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
            const books = q ? sec.books.filter((b) => matchesSearch(b, q)) : sec.books;
            if (q && books.length === 0) return;
            sections.push(
                renderGroupSectionHtml({
                    id: SPECIAL_GROUPS.UNGROUPED,
                    name: hasCustomGroups ? '未分组' : '通用世界书',
                    color: '#8c99a6',
                    collapsed: q ? false : Boolean(settings.ungroupedCollapsed),
                    isCustom: false,
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
            const matchedCharBooks = q ? sec.books.filter((b) => matchesSearch(b, q)) : sec.books;
            if (includeCharExplicitly) {
                if (q && matchedCharBooks.length === 0) return;
                sections.push(
                    renderGroupSectionHtml({
                        id: SPECIAL_GROUPS.CHARACTER,
                        name: '角色世界书',
                        color: '#7c8594',
                        collapsed: q ? false : Boolean(settings.charGroupCollapsed),
                        isCustom: false,
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

    listEl.innerHTML = sections.length > 0
        ? sections.join('')
        : '<div class="wbo-empty-hint">无匹配世界书</div>';

    listEl.scrollTop = prevScroll;
}

// ==================== Sub-Modals (stack above Manager Modal) ====================

function closeSubModal() {
    document.getElementById(SUBMODAL_OVERLAY_ID)?.remove();
}

/**
 * Create a sub-modal stacked above the Group Manager modal without closing `#WorldInfo`.
 */
function createSubModal(title, bodyHtml, { wide = false } = {}) {
    closeSubModal();
    const overlay = document.createElement('div');
    overlay.id = SUBMODAL_OVERLAY_ID;
    overlay.className = 'wbo-modal-overlay wbo-submodal-overlay';
    applyTauriSurface(overlay, 'backdrop');

    const modal = document.createElement('div');
    modal.className = `wbo-modal${wide ? ' is-wide' : ''}`;
    applyTauriSurface(modal, 'fullscreen-window');

    modal.innerHTML = `
        <div class="wbo-modal-header">
            <span class="wbo-modal-title">${esc(title)}</span>
            <button type="button" class="wbo-icon-btn wbo-modal-close" aria-label="关闭">
                <i class="fa-solid fa-xmark"></i>
            </button>
        </div>
        <div class="wbo-modal-body">${bodyHtml}</div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const stopAll = (ev) => ev.stopPropagation();
    for (const evtName of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend']) {
        overlay.addEventListener(evtName, stopAll);
    }

    overlay.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (ev.target === overlay) closeSubModal();
    });
    modal.querySelector('.wbo-modal-close')?.addEventListener('click', (ev) => {
        ev.stopPropagation();
        closeSubModal();
    });

    return { overlay, modal };
}

/**
 * Create or rename a custom group.
 */
function openCreateOrRenameGroupModal(group) {
    if (!_callbacks) return;
    const { settings } = _callbacks.getState();
    const isEdit = Boolean(group);
    const initialColor = group?.color || GROUP_COLOR_PALETTE[settings.groups.length % GROUP_COLOR_PALETTE.length];

    const swatches = GROUP_COLOR_PALETTE.map(
        (c) => `<button type="button" class="wbo-swatch${c === initialColor ? ' is-selected' : ''}" data-color="${c}" style="background:${c}" aria-label="颜色 ${c}"></button>`,
    ).join('');

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
            <div class="wbo-modal-footer">
                <button type="button" class="wbo-btn" id="wbo-cancel-btn">取消</button>
                <button type="button" class="wbo-btn wbo-btn-primary" id="wbo-save-group-btn">保存</button>
            </div>
        `,
    );

    let chosenColor = initialColor;
    modal.querySelectorAll('.wbo-swatch').forEach((btn) => {
        btn.addEventListener('click', () => {
            chosenColor = btn.getAttribute('data-color') || initialColor;
            modal.querySelectorAll('.wbo-swatch').forEach((b) => b.classList.remove('is-selected'));
            btn.classList.add('is-selected');
        });
    });

    const input = modal.querySelector('#wbo-group-name-input');
    if (input instanceof HTMLInputElement) {
        input.focus();
        input.select();
    }

    const submit = async () => {
        const name = input instanceof HTMLInputElement ? input.value.trim() : '';
        if (!name) {
            showToast('warning', '请输入分组名称');
            return;
        }
        if (isEdit && group) {
            group.name = name;
            group.color = chosenColor;
        } else {
            addCustomGroup(settings, { name, color: chosenColor });
        }
        closeSubModal();
        await _callbacks.onMutation({ save: true });
        showToast('success', isEdit ? `已更新分组「${name}」` : `已新建分组「${name}」`);
    };

    modal.querySelector('#wbo-cancel-btn')?.addEventListener('click', closeSubModal);
    modal.querySelector('#wbo-save-group-btn')?.addEventListener('click', submit);
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
                <input type="text" class="wbo-input" id="wbo-alias-input" value="${esc(bookMeta.alias || '')}" placeholder="${esc(bookMeta.primaryTitle)}">
            </div>
            <div class="wbo-field">
                <label class="wbo-label">备注</label>
                <input type="text" class="wbo-input" id="wbo-note-input" value="${esc(bookMeta.note || '')}" placeholder="用途或特点">
            </div>
            <div class="wbo-ai-status" id="wbo-rename-status"></div>
            <div class="wbo-modal-footer">
                <button type="button" class="wbo-btn" id="wbo-clear-alias-btn">恢复默认</button>
                <span class="wbo-spacer"></span>
                <button type="button" class="wbo-btn" id="wbo-cancel-btn">取消</button>
                <button type="button" class="wbo-btn wbo-btn-primary" id="wbo-save-alias-btn">保存</button>
            </div>
        `,
    );

    const aliasInput = modal.querySelector('#wbo-alias-input');
    const noteInput = modal.querySelector('#wbo-note-input');
    const realHint = modal.querySelector('#wbo-real-rename-hint');
    const nameLabel = modal.querySelector('#wbo-name-input-label');
    const clearBtn = modal.querySelector('#wbo-clear-alias-btn');
    const statusEl = modal.querySelector('#wbo-rename-status');

    const getMode = () => modal.querySelector('input[name="wbo-rename-mode"]:checked')?.value || 'alias';

    modal.querySelectorAll('input[name="wbo-rename-mode"]').forEach((radio) => {
        radio.addEventListener('change', () => {
            const isReal = getMode() === 'real';
            if (realHint instanceof HTMLElement) realHint.hidden = !isReal;
            if (nameLabel) nameLabel.textContent = isReal ? '新文件名' : '显示名称';
            if (clearBtn instanceof HTMLElement) clearBtn.hidden = isReal;
            if (isReal && aliasInput instanceof HTMLInputElement && !aliasInput.value.trim()) {
                aliasInput.value = bookMeta.alias || bookMeta.realName;
                aliasInput.select();
            }
        });
    });

    if (aliasInput instanceof HTMLInputElement) aliasInput.focus();

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
            await _callbacks.onRescan();
            const m = res.migrated;
            const summary = [
                m?.chars ? `${m.chars} 张角色卡` : '',
                m?.extras ? `${m.extras} 条附加绑定` : '',
                m?.personas ? `${m.personas} 个人设` : '',
            ].filter(Boolean).join('、');
            showToast('success', `已改名为「${inputName}」${summary ? `，同步更新 ${summary}` : ''}`);
            return;
        }

        if (inputName && inputName !== bookMeta.realName) {
            settings.aliases[bookMeta.realName] = inputName;
        } else {
            delete settings.aliases[bookMeta.realName];
        }

        if (note) settings.notes[bookMeta.realName] = note;
        else delete settings.notes[bookMeta.realName];

        closeSubModal();
        await _callbacks.onMutation({ save: true });
    };

    clearBtn?.addEventListener('click', () => {
        if (aliasInput instanceof HTMLInputElement) aliasInput.value = '';
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
        openCreateOrRenameGroupModal(null);
    });
    modal.querySelector('#wbo-cancel-btn')?.addEventListener('click', closeSubModal);
}

/**
 * AI Smart Worldbook Organizer modal:
 * - Collapsible saved multi-channel API config (cross-device via extensionSettings)
 * - Supports optional real filename normalization when user allows it
 */
function openAiOrganizeModal() {
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
    const baibaiChannels = readBaiBaiSharedChannels();

    const getActiveChannel = () =>
        settings.apiChannels.find((c) => c.id === settings.activeApiChannelId) || settings.apiChannels[0] || null;

    const getApiSummaryText = () => {
        if (settings.apiProvider !== 'custom') return '酒馆当前 API';
        const ch = getActiveChannel();
        if (!ch) return '自定义 API（未配置）';
        return ch.model ? `${ch.name} · ${ch.model}` : ch.name;
    };

    const bookChecksHtml = allBooks
        .map((b) => {
            const checked = defaultChecked.has(b.realName) ? 'checked' : '';
            const tag = b.isInCharGroup ? '<span class="wbo-tag">角色书</span>' : `<span class="wbo-tag">${esc(b.groupName)}</span>`;
            return `
                <label class="wbo-ai-pick-row">
                    <input type="checkbox" class="wbo-ai-book-check" value="${esc(b.realName)}" ${checked}>
                    <span class="wbo-ai-pick-name" title="${esc(b.realName)}">${esc(b.primaryTitle)}${b.subtitle ? ` <small>${esc(b.subtitle)}</small>` : ''}</span>
                    ${tag}
                </label>
            `;
        })
        .join('');

    const activeCh = getActiveChannel();

    const { modal } = createSubModal(
        'AI 整理世界书',
        `
            <div class="wbo-ai-step" id="wbo-ai-step-select">
                <details class="wbo-collapse-box" id="wbo-api-collapse">
                    <summary class="wbo-collapse-summary">
                        <span>API 方案：<b id="wbo-api-summary-text">${esc(getApiSummaryText())}</b></span>
                        <span class="wbo-collapse-hint">展开配置</span>
                    </summary>
                    <div class="wbo-collapse-body">
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
                                ${baibaiChannels.length > 0 ? `<button type="button" class="wbo-btn" id="wbo-ch-import-baibai-btn">导入柏宝书渠道</button>` : ''}
                            </div>
                            <input type="text" class="wbo-input" id="wbo-api-name" value="${esc(activeCh?.name || '')}" placeholder="配置名称，例如：中转 Flash">
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
                                <button type="button" class="wbo-btn" id="wbo-test-channel-btn">测试</button>
                            </div>
                            <div class="wbo-ai-status" id="wbo-api-channel-status"></div>
                        </div>
                    </div>
                </details>

                <div class="wbo-ai-section-head">
                    <span>选择要整理的世界书</span>
                    <span class="wbo-ai-quick-picks">
                        <button type="button" class="wbo-link-btn" id="wbo-pick-ungrouped">仅未分组</button>
                        <button type="button" class="wbo-link-btn" id="wbo-pick-nonchar">全部通用</button>
                        <button type="button" class="wbo-link-btn" id="wbo-pick-none">清空</button>
                    </span>
                </div>
                <div class="wbo-ai-book-list">${bookChecksHtml}</div>

                <div class="wbo-ai-options">
                    <label class="wbo-check-line">
                        <input type="checkbox" id="wbo-ai-include-clues">
                        <span>附带每本书前 5 条条目关键词摘要</span>
                    </label>
                    <label class="wbo-check-line">
                        <input type="checkbox" id="wbo-ai-allow-real-rename">
                        <span>允许规范修改世界书真实文件名，并自动同步角色卡与人设绑定</span>
                    </label>
                    <input type="text" class="wbo-input" id="wbo-ai-custom-rule" placeholder="命名与分类规范（可选）：例如统一按 [分类] 名称 格式，去掉作者名和版本号">
                </div>

                <div class="wbo-ai-actions-row">
                    <button type="button" class="wbo-btn wbo-btn-primary" id="wbo-ai-run-btn">
                        <i class="fa-solid fa-wand-magic-sparkles"></i> 开始 AI 整理
                    </button>
                    <button type="button" class="wbo-btn" id="wbo-ai-copy-prompt-btn">
                        <i class="fa-regular fa-copy"></i> 复制提示词
                    </button>
                </div>

                <details class="wbo-collapse-box" id="wbo-ai-paste-details">
                    <summary class="wbo-collapse-summary">
                        <span>粘贴外部 AI 返回的 JSON</span>
                    </summary>
                    <div class="wbo-collapse-body">
                        <textarea class="wbo-textarea" id="wbo-ai-json-input" rows="4" placeholder='{"原世界书名": {"alias": "规范后名称", "group": "分组名", "note": "简介"}}'></textarea>
                        <div>
                            <button type="button" class="wbo-btn" id="wbo-ai-parse-paste-btn">解析预览</button>
                        </div>
                    </div>
                </details>

                <div class="wbo-ai-status" id="wbo-ai-status"></div>
            </div>

            <div class="wbo-ai-step" id="wbo-ai-step-preview" hidden>
                <div class="wbo-ai-section-head">
                    <span>预览与微调</span>
                    <button type="button" class="wbo-link-btn" id="wbo-ai-back-btn">返回重选</button>
                </div>
                <div class="wbo-radio-row">
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
                    将按下方「新名称」真实重命名世界书文件，并同步更新角色卡主/附绑定、User 人设绑定、当前聊天与全局激活。
                </div>
                <div class="wbo-ai-preview-list" id="wbo-ai-preview-list"></div>
                <div class="wbo-ai-status" id="wbo-ai-preview-status"></div>
                <div class="wbo-modal-footer">
                    <button type="button" class="wbo-btn" id="wbo-ai-cancel-btn">取消</button>
                    <button type="button" class="wbo-btn wbo-btn-primary" id="wbo-ai-apply-btn">确认应用</button>
                </div>
            </div>
        `,
        { wide: true },
    );

    const statusEl = modal.querySelector('#wbo-ai-status');
    const previewStatusEl = modal.querySelector('#wbo-ai-preview-status');
    const channelStatusEl = modal.querySelector('#wbo-api-channel-status');
    const stepSelect = modal.querySelector('#wbo-ai-step-select');
    const stepPreview = modal.querySelector('#wbo-ai-step-preview');
    const previewList = modal.querySelector('#wbo-ai-preview-list');
    const customApiBox = modal.querySelector('#wbo-custom-api-box');
    const summaryTextEl = modal.querySelector('#wbo-api-summary-text');
    const channelSelect = modal.querySelector('#wbo-channel-select');
    const nameInput = modal.querySelector('#wbo-api-name');
    const urlInput = modal.querySelector('#wbo-api-base-url');
    const keyInput = modal.querySelector('#wbo-api-key');
    const modelInput = modal.querySelector('#wbo-api-model');

    let editingChannelId = activeCh?.id || null;

    const setStatus = (msg, isError = false, target = 'main') => {
        const el = target === 'preview' ? previewStatusEl : (target === 'channel' ? channelStatusEl : statusEl);
        if (!el) return;
        el.textContent = msg;
        el.className = `wbo-ai-status${isError ? ' is-error' : ''}`;
    };

    const refreshSummary = () => {
        if (summaryTextEl) summaryTextEl.textContent = getApiSummaryText();
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
        setStatus(`已保存配置「${draft.name}」`, false, 'channel');
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

    modal.querySelector('#wbo-ch-import-baibai-btn')?.addEventListener('click', async () => {
        let added = 0;
        for (const ch of baibaiChannels) {
            const exists = settings.apiChannels.some((e) => e.baseUrl === ch.baseUrl && e.model === ch.model);
            if (exists) continue;
            const newCh = { id: createApiChannelId(settings.apiChannels), ...ch };
            settings.apiChannels.push(newCh);
            added += 1;
        }
        if (added > 0) {
            const latest = settings.apiChannels[settings.apiChannels.length - 1];
            settings.activeApiChannelId = latest.id;
            loadChannelIntoForm(latest);
            refreshSummary();
            await _callbacks.onMutation({ save: true, uiOnly: true });
            setStatus(`已从柏宝书导入 ${added} 个渠道`, false, 'channel');
        } else {
            setStatus('柏宝书渠道均已存在', false, 'channel');
        }
    });

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
            setStatus(`已拉取 ${models.length} 个模型`, false, 'channel');
        } catch (err) {
            setStatus(String(err?.message || err), true, 'channel');
        } finally {
            if (btn instanceof HTMLButtonElement) btn.disabled = false;
        }
    });

    modal.querySelector('#wbo-test-channel-btn')?.addEventListener('click', async (ev) => {
        const btn = ev.currentTarget;
        if (btn instanceof HTMLButtonElement) btn.disabled = true;
        try {
            const draft = readFormDraft();
            setStatus('正在测试连接...', false, 'channel');
            const res = await testCustomApiChannel(draft);
            setStatus(res.message, !res.ok, 'channel');
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

    modal.querySelector('#wbo-pick-ungrouped')?.addEventListener('click', () =>
        setCheckedByPredicate((m) => m.groupId === SPECIAL_GROUPS.UNGROUPED),
    );
    modal.querySelector('#wbo-pick-nonchar')?.addEventListener('click', () =>
        setCheckedByPredicate((m) => !m.isInCharGroup),
    );
    modal.querySelector('#wbo-pick-none')?.addEventListener('click', () =>
        setCheckedByPredicate(() => false),
    );

    const preparePromptPayload = async () => {
        const selectedNames = getSelectedBookNames();
        if (selectedNames.length === 0) {
            setStatus('请至少勾选一本世界书', true);
            return null;
        }
        const includeClues = Boolean(modal.querySelector('#wbo-ai-include-clues')?.checked);
        const allowRealRename = Boolean(modal.querySelector('#wbo-ai-allow-real-rename')?.checked);
        const customRule = modal.querySelector('#wbo-ai-custom-rule')?.value?.trim() || '';
        const filenameRule = allowRealRename
            ? '建议的新名称将直接作为规范化的世界书文件名，请勿包含 \\ / : * ? " < > | 等非法文件名字符。'
            : '';
        const customInstruction = [customRule, filenameRule].filter(Boolean).join(' ');

        const booksPayload = [];
        for (let i = 0; i < selectedNames.length; i += 1) {
            const name = selectedNames[i];
            const meta = classification.byName.get(name);
            let sampleEntries = [];
            if (includeClues) {
                setStatus(`读取条目摘要 (${i + 1}/${selectedNames.length})...`);
                sampleEntries = await fetchWorldbookCluesOnDemand(name, 5);
            }
            booksPayload.push({
                realName: name,
                currentAlias: meta?.alias || '',
                currentGroup: meta?.groupName || '',
                sampleEntries,
            });
        }

        return buildAiOrganizePrompt({
            books: booksPayload,
            existingGroups: settings.groups.map((g) => g.name),
            customInstruction,
        });
    };

    let currentProposals = [];

    const showPreview = (proposals, ignoredCount) => {
        currentProposals = proposals;
        if (!previewList || !(stepSelect instanceof HTMLElement) || !(stepPreview instanceof HTMLElement)) return;

        // Pre-select real rename radio if user checked "允许规范修改世界书真实文件名"
        const allowReal = Boolean(modal.querySelector('#wbo-ai-allow-real-rename')?.checked);
        const targetRadio = modal.querySelector(`input[name="wbo-ai-apply-mode"][value="${allowReal ? 'real' : 'alias'}"]`);
        if (targetRadio instanceof HTMLInputElement) targetRadio.checked = true;
        syncRealHint();

        previewList.innerHTML = proposals
            .map(
                (p, idx) => `
                <div class="wbo-ai-prop-row" data-idx="${idx}">
                    <label class="wbo-ai-prop-check">
                        <input type="checkbox" class="wbo-prop-selected" checked>
                    </label>
                    <div class="wbo-ai-prop-fields">
                        <div class="wbo-ai-prop-orig" title="${esc(p.realName)}">${esc(p.realName)}</div>
                        <div class="wbo-ai-prop-inputs">
                            <input type="text" class="wbo-input wbo-prop-alias" value="${esc(p.alias)}" placeholder="新名称">
                            <input type="text" class="wbo-input wbo-prop-group" value="${esc(p.group)}" placeholder="分组名">
                        </div>
                        <input type="text" class="wbo-input wbo-prop-note" value="${esc(p.note)}" placeholder="备注">
                    </div>
                </div>
            `,
            )
            .join('');

        stepSelect.hidden = true;
        stepPreview.hidden = false;
        if (ignoredCount > 0) {
            showToast('info', `已解析 ${proposals.length} 条建议，忽略 ${ignoredCount} 条无效项`);
        }
    };

    const parseAndOpenPreview = (rawText) => {
        const validSet = new Set(classification.byName.keys());
        const parsed = parseAiOrganizeResponse(rawText, validSet);
        if (!parsed.ok) {
            setStatus(parsed.error || '解析失败', true);
            return;
        }
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
            setStatus(`调用失败：${err?.message || err}`, true);
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
            setStatus('已复制提示词，可将外部 AI 返回的 JSON 粘贴到下方。');
        } catch {
            const details = modal.querySelector('#wbo-ai-paste-details');
            const textarea = modal.querySelector('#wbo-ai-json-input');
            if (details instanceof HTMLDetailsElement) details.open = true;
            if (textarea instanceof HTMLTextAreaElement) {
                textarea.value = fullPrompt;
                textarea.select();
            }
            setStatus('剪贴板受限，已将提示词填入下方文本框。');
        }
    });

    modal.querySelector('#wbo-ai-parse-paste-btn')?.addEventListener('click', () => {
        const raw = modal.querySelector('#wbo-ai-json-input')?.value || '';
        parseAndOpenPreview(raw);
    });

    modal.querySelector('#wbo-ai-back-btn')?.addEventListener('click', () => {
        if (stepSelect instanceof HTMLElement) stepSelect.hidden = false;
        if (stepPreview instanceof HTMLElement) stepPreview.hidden = true;
    });

    modal.querySelector('#wbo-ai-cancel-btn')?.addEventListener('click', closeSubModal);

    modal.querySelector('#wbo-ai-apply-btn')?.addEventListener('click', async (ev) => {
        const applyBtn = ev.currentTarget;
        const applyMode = modal.querySelector('input[name="wbo-ai-apply-mode"]:checked')?.value || 'alias';
        const chosen = [];
        modal.querySelectorAll('.wbo-ai-prop-row').forEach((row) => {
            const checked = row.querySelector('.wbo-prop-selected')?.checked;
            if (!checked) return;
            const idx = Number(row.getAttribute('data-idx'));
            const orig = currentProposals[idx];
            if (!orig) return;
            chosen.push({
                realName: orig.realName,
                alias: row.querySelector('.wbo-prop-alias')?.value?.trim() || '',
                group: row.querySelector('.wbo-prop-group')?.value?.trim() || '',
                note: row.querySelector('.wbo-prop-note')?.value?.trim() || '',
            });
        });

        if (chosen.length === 0) {
            showToast('warning', '请至少勾选一项');
            return;
        }

        if (applyMode === 'real') {
            if (!globalThis.confirm(`确定对选中的 ${chosen.length} 本世界书执行真实规范改名并同步绑定吗？`)) {
                return;
            }
            if (applyBtn instanceof HTMLButtonElement) applyBtn.disabled = true;
            let renamedCount = 0;
            let failedCount = 0;
            const adjustedProposals = [];

            for (let i = 0; i < chosen.length; i += 1) {
                const item = chosen[i];
                let finalRealName = item.realName;
                if (item.alias && item.alias !== item.realName) {
                    setStatus(`正在真实改名 (${i + 1}/${chosen.length})：${item.realName} → ${item.alias}`, false, 'preview');
                    const res = await realRenameWorldbook(item.realName, item.alias, settings);
                    if (res.ok) {
                        finalRealName = item.alias;
                        renamedCount += 1;
                    } else {
                        failedCount += 1;
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

            applyAiOrganizeProposals(settings, adjustedProposals);
            closeSubModal();
            await _callbacks.onRescan();
            showToast('success', `真实改名完成：成功 ${renamedCount} 本${failedCount > 0 ? `，跳过/失败 ${failedCount} 本` : ''}`);
            return;
        }

        const { appliedCount, createdGroups } = applyAiOrganizeProposals(settings, chosen);
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

        const coverageParts = [];
        if (coverage.multiBookChars.length > 0) {
            coverageParts.push(`
                <div class="wbo-cov-block">
                    <div class="wbo-cov-title">绑定了多本世界书的角色卡 (${coverage.multiBookChars.length})</div>
                    <ul class="wbo-cov-list">
                        ${coverage.multiBookChars.map((c) => `<li><b>${esc(c.charName)}</b>（${c.books.length} 本）：${c.books.map((b) => `${esc(b.worldName)}[${sourceLabel(b.source)}]`).join('、')}</li>`).join('')}
                    </ul>
                </div>
            `);
        }
        if (coverage.orphanExtraBooks.length > 0) {
            coverageParts.push(`
                <div class="wbo-cov-block">
                    <div class="wbo-cov-title">已删角色残留的附加世界书 (${coverage.orphanExtraBooks.length})</div>
                    <ul class="wbo-cov-list">
                        ${coverage.orphanExtraBooks.map((o) => `<li><b>${esc(o.worldName)}</b>（原角色：${esc(o.charName)}）</li>`).join('')}
                    </ul>
                </div>
            `);
        }
        if (coverage.missingFileChars.length > 0) {
            coverageParts.push(`
                <div class="wbo-cov-block">
                    <div class="wbo-cov-title">绑定的世界书文件不存在 (${coverage.missingFileChars.length})</div>
                    <ul class="wbo-cov-list">
                        ${coverage.missingFileChars.map((c) => `<li><b>${esc(c.charName)}</b> → ${esc(c.missingWorld)}</li>`).join('')}
                    </ul>
                </div>
            `);
        }
        if (coverage.unboundChars.length > 0) {
            coverageParts.push(`
                <div class="wbo-cov-block">
                    <div class="wbo-cov-title">未绑定世界书的角色卡 (${coverage.unboundChars.length})</div>
                    <div class="wbo-cov-names">
                        ${coverage.unboundChars.map((c) => `<span class="wbo-tag">${esc(c.charName)}${c.shallow ? ' · 未加载' : ''}</span>`).join('')}
                    </div>
                </div>
            `);
        }
        if (coverage.sharedBooks.length > 0) {
            coverageParts.push(`
                <div class="wbo-cov-block">
                    <div class="wbo-cov-title">多张角色卡共用同一世界书 (${coverage.sharedBooks.length})</div>
                    <ul class="wbo-cov-list">
                        ${coverage.sharedBooks.map((s) => `<li><b>${esc(s.worldName)}</b>：${esc(s.charNames.join('、'))}</li>`).join('')}
                    </ul>
                </div>
            `);
        }

        const totalDiffItems =
            coverage.multiBookChars.length +
            coverage.orphanExtraBooks.length +
            coverage.missingFileChars.length +
            coverage.unboundChars.length +
            coverage.sharedBooks.length;

        const coverageHtml = coverageParts.length > 0
            ? `
                <details class="wbo-collapse-box" ${totalDiffItems <= 8 ? 'open' : ''}>
                    <summary class="wbo-collapse-summary">
                        <span>角色与世界书对应明细</span>
                    </summary>
                    <div class="wbo-collapse-body">${coverageParts.join('')}</div>
                </details>
            `
            : '';

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

            <div class="wbo-modal-footer">
                <button type="button" class="wbo-btn" id="wbo-scan-close-btn">关闭</button>
            </div>
        `;
    };

    const { modal } = createSubModal('扫描角色世界书', renderModalBody(), { wide: true });
    const cancelSignal = { cancelled: false };

    const bindHandlers = () => {
        const statusEl = modal.querySelector('#wbo-scan-status');
        const setStatus = (msg, isError = false) => {
            if (!statusEl) return;
            statusEl.textContent = msg;
            statusEl.className = `wbo-ai-status${isError ? ' is-error' : ''}`;
        };

        modal.querySelector('#wbo-scan-close-btn')?.addEventListener('click', () => {
            cancelSignal.cancelled = true;
            closeSubModal();
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
                if (nextStatus) nextStatus.textContent = '扫描完成。';
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

// ==================== Extension Settings Panel ====================

/**
 * Mount the extension settings accordion inside `#extensions_settings2` (or `#extensions_settings`).
 */
export function renderExtensionSettingsPanel() {
    if (!_callbacks) return;
    const container = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!container) return;

    let root = document.getElementById(SETTINGS_ROOT_ID);
    if (!root) {
        root = document.createElement('div');
        root.id = SETTINGS_ROOT_ID;
        root.className = 'wbo-ext-settings';
        container.appendChild(root);
    }

    const { settings, classification } = _callbacks.getState();

    root.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>世界书分组管理</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="wbo-settings-body">
                    <div class="wbo-settings-summary">
                        共 ${classification.totalCount} 本世界书：${classification.nonCharCount} 本通用 / ${classification.charCount} 本角色绑定
                    </div>

                    <label class="wbo-check-line">
                        <input type="checkbox" data-setting="hideCharBooksByDefault" ${settings.hideCharBooksByDefault ? 'checked' : ''}>
                        <span>默认隐藏角色卡绑定的世界书</span>
                    </label>

                    <label class="wbo-check-line">
                        <input type="checkbox" data-setting="includeExtraCharBooks" ${settings.includeExtraCharBooks ? 'checked' : ''}>
                        <span>将角色附加世界书归入角色世界书</span>
                    </label>

                    <label class="wbo-check-line">
                        <input type="checkbox" data-setting="includeEmbeddedNameMatch" ${settings.includeEmbeddedNameMatch ? 'checked' : ''}>
                        <span>识别角色卡内嵌同名世界书</span>
                    </label>

                    <label class="wbo-check-line">
                        <input type="checkbox" data-setting="autoImportMissingCharBook" ${settings.autoImportMissingCharBook ? 'checked' : ''}>
                        <span>打开角色卡时自动导入缺失的卡内世界书</span>
                    </label>

                    <label class="wbo-check-line">
                        <input type="checkbox" data-setting="autoHideInCharBindPopup" ${settings.autoHideInCharBindPopup ? 'checked' : ''}>
                        <span>角色绑定弹窗默认隐藏其他角色世界书</span>
                    </label>

                    <label class="wbo-check-line">
                        <input type="checkbox" data-setting="showNativeOptgroups" ${settings.showNativeOptgroups ? 'checked' : ''}>
                        <span>编辑器下拉框按分组显示</span>
                    </label>

                    <div class="wbo-setting-row">
                        <span>角色世界书标题显示</span>
                        <select class="wbo-select" data-setting-select="charBookTitleMode">
                            <option value="char_with_sub" ${settings.charBookTitleMode === 'char_with_sub' ? 'selected' : ''}>角色名 + 小字原标题</option>
                            <option value="char_only" ${settings.charBookTitleMode === 'char_only' ? 'selected' : ''}>仅角色名</option>
                            <option value="original" ${settings.charBookTitleMode === 'original' ? 'selected' : ''}>原标题</option>
                        </select>
                    </div>

                    <div class="wbo-setting-row">
                        <span>显示别名样式</span>
                        <select class="wbo-select" data-setting-select="aliasTitleMode">
                            <option value="alias_with_sub" ${settings.aliasTitleMode === 'alias_with_sub' ? 'selected' : ''}>别名 + 小字原文件名</option>
                            <option value="alias_only" ${settings.aliasTitleMode === 'alias_only' ? 'selected' : ''}>仅别名</option>
                        </select>
                    </div>

                    <div class="wbo-settings-actions">
                        <button type="button" class="wbo-btn" data-settings-action="manager">
                            <i class="fa-solid fa-layer-group"></i> 打开分组管理
                        </button>
                        <button type="button" class="wbo-btn" data-settings-action="scan">
                            <i class="fa-solid fa-arrows-rotate"></i> 扫描角色卡
                        </button>
                        <button type="button" class="wbo-btn" data-settings-action="export">
                            <i class="fa-solid fa-download"></i> 导出配置
                        </button>
                        <button type="button" class="wbo-btn" data-settings-action="import">
                            <i class="fa-solid fa-upload"></i> 导入配置
                        </button>
                        <input type="file" id="wbo-import-config-file" accept=".json" hidden>
                    </div>
                </div>
            </div>
        </div>
    `;

    root.querySelectorAll('input[data-setting]').forEach((el) => {
        el.addEventListener('change', async () => {
            if (!(el instanceof HTMLInputElement)) return;
            const key = el.getAttribute('data-setting');
            if (!key) return;
            settings[key] = el.checked;
            if (key === 'hideCharBooksByDefault') {
                settings.showCharBooks = !el.checked;
            }
            await _callbacks.onMutation({ save: true });
        });
    });

    root.querySelectorAll('select[data-setting-select]').forEach((el) => {
        el.addEventListener('change', async () => {
            if (!(el instanceof HTMLSelectElement)) return;
            const key = el.getAttribute('data-setting-select');
            if (!key) return;
            settings[key] = el.value;
            await _callbacks.onMutation({ save: true });
        });
    });

    root.querySelector('[data-settings-action="manager"]')?.addEventListener('click', () => {
        openManagerModal();
    });

    root.querySelector('[data-settings-action="scan"]')?.addEventListener('click', () => {
        openScanAndImportModal();
    });

    root.querySelector('[data-settings-action="export"]')?.addEventListener('click', () => {
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
    });

    const importFileInput = root.querySelector('#wbo-import-config-file');
    root.querySelector('[data-settings-action="import"]')?.addEventListener('click', () => {
        if (importFileInput instanceof HTMLInputElement) {
            importFileInput.value = '';
            importFileInput.click();
        }
    });

    importFileInput?.addEventListener('change', async () => {
        if (!(importFileInput instanceof HTMLInputElement) || !importFileInput.files?.[0]) return;
        try {
            const text = await importFileInput.files[0].text();
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
    });
}

/**
 * Remove all DOM nodes mounted by this panel module cleanly.
 */
export function teardownPanels() {
    closeSubModal();
    closeManagerModal();
    document.getElementById(HEADER_BAR_ID)?.remove();
    document.getElementById(MOBILE_SEARCH_ID)?.remove();
    document.getElementById(SETTINGS_ROOT_ID)?.remove();
}
