/** Global worldbook combinations and host shortcuts. */

import {
    _callbacks,
    applyThemeClass,
    bindDrawerSafeBubbleGuard,
    bindImeSafeEnter,
    CHAR_TOGGLE_BTN_ID,
    closeGroupVisibilityPopover,
    closeSubModal,
    createSubModal,
    detectHostThemeClass,
    esc,
    isDesktopAutoFocusAllowed,
    MANAGER_OVERLAY_ID,
    UNDO_SVG,
    WAND_ENTRY_ID,
    WI_QUICK_ACTIONS_ID,
} from './panel-window.js';
import {
    openManagerModal,
    syncEmbeddedPanelIndicators,
} from './panel-manager.js';
import {
    closeAllOpenWorldDropdowns,
    setGlobalWorldsBatch,
} from './native-filter.js';
import { openEntrySearchModal } from './panel-search.js';
import {
    deleteGlobalPreset,
    findMatchingGlobalPreset,
    moveGlobalPreset,
    promoteSectionToTop,
    SPECIAL_GROUPS,
    upsertGlobalPreset,
} from './core.js';
import {
    getActiveGlobalWorldSet,
    showToast,
} from './host.js';

/** @type {{ prevBooks: string[], label: string } | null} */
let _lastGlobalSwitchUndo = null;

/** @type {MutationObserver | null} */
let _charBtnWidthObserver = null;

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
function syncNativeQuickActionsUi() {
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
                            <button type="button" class="wbo-btn" id="wbo-cmb-clear-global-btn">关闭所有全局</button>
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
                        <button type="button" class="wbo-btn" id="wbo-cmb-seed-active-btn">加入已开启的全局世界书</button>
                        <button type="button" class="wbo-btn" id="wbo-cmb-clear-pick-btn">清空勾选</button>
                    </div>
                    <div class="wbo-gp-pills wbo-book-group-switcher" id="wbo-cmb-pills" role="group" aria-label="世界书分组"></div>
                    <div class="wbo-gp-toolbar">
                        <input type="search" class="wbo-input wbo-group-pick-filter" id="wbo-cmb-book-filter" placeholder="搜索世界书名 / 显示名 / 分组..." autocomplete="off" spellcheck="false">
                        <button type="button" class="wbo-btn wbo-gp-quick-btn" id="wbo-cmb-toggle-visible-btn">全选当前可见</button>
                    </div>
                    <div class="wbo-cmb-pick-feedback" id="wbo-cmb-pick-feedback" role="status" hidden></div>
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
    const pickFeedbackEl = modal.querySelector('#wbo-cmb-pick-feedback');

    let currentEditId = editPresetId || null;
    /** @type {Set<string>} */
    const pickedSet = new Set();
    let activeEditPill = '__nonchar__';

    const setEditStatus = (msg, isErr = false) => {
        if (!editStatusEl) return;
        editStatusEl.textContent = msg;
        editStatusEl.className = `wbo-ai-status${isErr ? ' is-error' : ''}`;
    };

    const setPickFeedback = (message) => {
        if (!pickFeedbackEl) return;
        pickFeedbackEl.textContent = message;
        pickFeedbackEl.hidden = !message;
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
                            应用
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
            seedActiveBtn.disabled = activeGlobals.size === 0;
        }
        if (filterInput instanceof HTMLInputElement) {
            filterInput.value = '';
        }
        activeEditPill = '__nonchar__';
        setEditStatus('');
        setPickFeedback('');

        const orderedSections = classification.orderedSections || [];
        if (pillsEl) {
            const sectionPills = orderedSections
                .filter((s) => s.books?.length)
                .map((s) => `
                    <button type="button" class="wbo-pill" data-cmb-pill="${esc(s.id)}" aria-pressed="false">
                        ${s.kind === 'custom' ? `<span class="wbo-pill-dot" style="background:${esc(s.color)}"></span>` : ''}
                        <span>${esc(s.name)}</span>
                        <span class="wbo-pill-count">${s.books.length}</span>
                    </button>
                `).join('');
            pillsEl.innerHTML = `
                <button type="button" class="wbo-pill is-active" data-cmb-pill="__nonchar__" aria-pressed="true">
                    <span>非角色书</span><span class="wbo-pill-count">${classification.nonCharCount}</span>
                </button>
                <button type="button" class="wbo-pill" data-cmb-pill="__selected__" aria-pressed="false">
                    <span>已选</span><span class="wbo-pill-count" id="wbo-cmb-sel-pill-cnt">${pickedSet.size}</span>
                </button>
                ${sectionPills}
                ${classification.charCount > 0 ? `
                    <button type="button" class="wbo-pill" data-cmb-pill="__all__" aria-pressed="false">
                        <span>全部</span><span class="wbo-pill-count">${classification.totalCount}</span>
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
            label: '关闭所有全局',
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
        const currentBooks = _callbacks.getState().classification.byName;
        const activeGlobals = [...getActiveGlobalWorldSet()].filter((name) => currentBooks.has(name));
        for (const name of activeGlobals) pickedSet.add(name);
        pickListEl?.querySelectorAll('.wbo-cmb-book-check').forEach((cb) => {
            if (cb instanceof HTMLInputElement) cb.checked = pickedSet.has(cb.value);
        });
        syncEditPickedBadge();
        applyEditFilters();
        setPickFeedback(activeGlobals.length ? `已勾选 ${activeGlobals.length} 本已开启的全局世界书` : '当前没有已开启的全局世界书');
    });
    modal.querySelector('#wbo-cmb-clear-pick-btn')?.addEventListener('click', () => {
        pickedSet.clear();
        setPickFeedback('');
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
            const selected = b.getAttribute('data-cmb-pill') === activeEditPill;
            b.classList.toggle('is-active', selected);
            b.setAttribute('aria-pressed', String(selected));
        });
        applyEditFilters();
        const scroll = pickListEl?.closest('.wbo-step-scroll');
        if (scroll) scroll.scrollTop = 0;
    });
    pickListEl?.addEventListener('change', (ev) => {
        const cb = ev.target;
        if (!(cb instanceof HTMLInputElement) || !cb.classList.contains('wbo-cmb-book-check')) return;
        if (cb.checked) pickedSet.add(cb.value);
        else pickedSet.delete(cb.value);
        setEditStatus('');
        setPickFeedback('');
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
        setPickFeedback('');
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
 * Fixed-size, theme-following 3-in-1 Quick Hub popover anchored inside `#WorldInfo`:
 * - Tab 1 (`presets`): apply, layer, save and undo global combinations.
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
    let selectedQhubPresetId = '';

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
                    <button type="button" class="wbo-link-btn" id="wbo-qhub-clear-all">关闭所有全局</button>
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
            const selected = selectedQhubPresetId === p.id;
            const previewTitles = p.books
                .slice(0, 3)
                .map((n) => curCls?.byName?.get(n)?.primaryTitle || n)
                .join('、');
            const moreCnt = p.books.length > 3 ? ` 等 ${p.books.length} 本` : '';
            return `
                <div class="wbo-qhub-combo-row${isMatched ? ' is-active' : ''}${selected ? ' is-selected' : ''}">
                    <button type="button" class="wbo-qhub-combo-main" data-qhub-select="${esc(p.id)}" aria-pressed="${selected}">
                        <span class="wbo-qhub-combo-title">
                            <span>${esc(p.name)}</span>
                            <span class="wbo-tag">${p.books.length}本</span>
                            ${isMatched ? '<span class="wbo-tag is-on-tag">生效</span>' : ''}
                        </span>
                        <span class="wbo-qhub-combo-sub">${esc(`${previewTitles}${moreCnt}`)}</span>
                    </button>
                    <div class="wbo-qhub-combo-acts">
                        <button type="button" class="wbo-btn wbo-btn-primary wbo-qhub-mini-btn" data-qhub-apply="${esc(p.id)}" title="将当前全局世界书切换为此组合" aria-label="应用 ${esc(p.name)}">应用</button>
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
            label: '关闭所有全局',
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
        const selectBtn = target.closest('[data-qhub-select]');
        if (selectBtn) {
            selectedQhubPresetId = selectBtn.getAttribute('data-qhub-select') || '';
            qhubListEl.querySelectorAll('[data-qhub-select]').forEach((button) => {
                const selected = button.getAttribute('data-qhub-select') === selectedQhubPresetId;
                button.setAttribute('aria-pressed', String(selected));
                button.closest('.wbo-qhub-combo-row')?.classList.toggle('is-selected', selected);
            });
            return;
        }
        const applyBtn = target.closest('[data-qhub-apply]');
        if (applyBtn) {
            const id = applyBtn.getAttribute('data-qhub-apply') || '';
            const preset = (cur.globalPresets || []).find((p) => p.id === id);
            if (preset) {
                selectedQhubPresetId = preset.id;
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

function takeGlobalSwitchUndo() {
    const snap = _lastGlobalSwitchUndo;
    _lastGlobalSwitchUndo = null;
    return snap;
}

function disconnectNativeCharBtnWidthObserver() {
    _charBtnWidthObserver?.disconnect();
    _charBtnWidthObserver = null;
}

export {
    disconnectNativeCharBtnWidthObserver,
    executeGlobalBooksSwitch,
    openGlobalCombosModal,
    openGroupVisibilityPopover,
    syncManagerComboStripUi,
    syncNativeQuickActionsUi,
    syncNativeQuickComboTitles,
    takeGlobalSwitchUndo,
};
