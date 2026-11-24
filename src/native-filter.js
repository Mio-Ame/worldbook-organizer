/**
 * Worldbook Organizer — Native SillyTavern / TauriTavern selector filter & display layer.
 *
 * Safety invariants verified against upstream `world-info.js`:
 * 1. `#world_info`:
 *    - NEVER wrap `<option>` in `<optgroup>` because upstream `getWIElement()` uses
 *      `$('#world_info').children()` for `/world` slash commands.
 *    - NEVER mutate `<option>`'s `textContent` or `value` because upstream maps
 *      option text & numeric index directly to `world_names`.
 *    - NEVER detach an already-selected `<option>`.
 *    - On desktop Select2, use `templateResult` to show clean virtual alias / character
 *      name + optional small original title + group pill, while keeping selected chips
 *      compatible with upstream `select2ChoiceClickSubscribe`.
 * 2. `#world_editor_select`:
 *    - Upstream ONLY queries `.find(':selected')`, `.find('option[value!=""]')`, and `.val()`,
 *      so grouping visible options with `<optgroup>` is 100% safe on both desktop Select2
 *      and mobile native `<select>`.
 *    - On desktop Select2, both `templateResult` and `templateSelection` render the clean
 *      virtual alias / character name + optional small original title.
 *    - Always keeps the currently edited worldbook visible even if it belongs to the
 *      hidden character group.
 * 3. `.character_world` popup:
 *    - Lightweight MutationObserver injects a filter bar that hides OTHER characters'
 *      worldbooks by default while preserving the current character's own books.
 */

import {
    SPECIAL_GROUPS,
    isBookVisibleInCharBindPopup,
    isBookVisibleInSelector,
} from './core.js';
import { getCurrentCharacterAvatar, getHostContext, getPowerUserSettings, saveSettings } from './host.js';

/** @type {Map<string, HTMLOptionElement>} */
const _globalDetachedMap = new Map();
/** @type {Map<string, HTMLOptionElement>} */
const _editorDetachedMap = new Map();

let _isApplying = false;
let _latestClassification = null;
let _latestSettings = null;
let _currentlyEditingWorld = null;
let _lastGlobalSignature = null;
let _lastEditorSignature = null;

/**
 * Detect whether `#world_editor_select` lacks Select2 (e.g. mobile / TauriTavern iOS & Android).
 * @returns {boolean}
 */
export function isNativeMobileSelectMode() {
    const sel = document.getElementById('world_editor_select');
    if (!sel) return false;
    const $ = globalThis.jQuery;
    const hasSelect2 = Boolean($ && ($(sel).data('select2') || $(sel).hasClass('select2-hidden-accessible')));
    return !hasSelect2;
}

/** @type {MutationObserver | null} */
let _globalSelectObserver = null;
/** @type {MutationObserver | null} */
let _editorSelectObserver = null;
/** @type {MutationObserver | null} */
let _charPopupObserver = null;
let _resyncTimer = null;

/**
 * Escape HTML safely for Select2 template strings.
 * @param {string} str
 * @returns {string}
 */
function escHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Return all real worldbook names currently held in detached caches (so `getWorldNames`
 * never loses track of hidden options if upstream modules aren't available).
 * @returns {string[]}
 */
export function getDetachedWorldNames() {
    return [...new Set([..._globalDetachedMap.keys(), ..._editorDetachedMap.keys()])];
}

/**
 * Record the worldbook currently opened in the native editor so we keep it visible.
 * @param {string | null} worldName
 */
export function setCurrentlyEditingWorld(worldName) {
    _currentlyEditingWorld = worldName ? String(worldName).trim() : null;
}

/**
 * Build Select2 custom matcher that searches across real name, virtual alias,
 * character owner names, notes, and group name!
 * @param {any} params
 * @param {any} data
 */
function customSelect2Matcher(params, data) {
    const term = String(params?.term ?? '').trim().toLowerCase();
    if (!term) return data;

    // Handle optgroup children recursively
    if (Array.isArray(data.children)) {
        const matchedChildren = [];
        for (const child of data.children) {
            const match = customSelect2Matcher(params, child);
            if (match) matchedChildren.push(match);
        }
        if (matchedChildren.length > 0) {
            return { ...data, children: matchedChildren };
        }
        return null;
    }

    const realName = String(data.text ?? '').trim();
    const meta = _latestClassification?.byName?.get(realName);
    const haystack = meta?.searchableText || realName.toLowerCase();
    const tokens = term.split(/\s+/).filter(Boolean);
    return tokens.every((tok) => haystack.includes(tok)) ? data : null;
}

/**
 * Build Select2 `templateResult` DOM node showing clean alias/character name,
 * optional muted original author title, and group pill.
 * @param {any} state
 * @param {{ showGroupPill: boolean }} opts
 */
function renderSelect2OptionResult(state, { showGroupPill }) {
    if (!state.id) return state.text; // placeholder or optgroup header
    const realName = String(state.text ?? '').trim();
    const meta = _latestClassification?.byName?.get(realName);
    if (!meta) return state.text;

    const $ = globalThis.jQuery;
    if (!$) return state.text;

    const hasCustomGroups = (_latestClassification?.customGroups?.length || 0) > 0;
    const groupBadge = showGroupPill && (hasCustomGroups || meta.isInCharGroup)
        ? `<span class="wbo-s2-badge${meta.isInCharGroup ? ' is-char' : ''}">${escHtml(meta.groupName)}</span>`
        : '';
    const subHtml = meta.subtitle
        ? `<span class="wbo-s2-sub" title="${escHtml(meta.realName)}">${escHtml(meta.subtitle)}</span>`
        : '';

    return $(`
        <span class="wbo-s2-item" title="${escHtml(meta.realName)}">
            <span class="wbo-s2-main">
                <span class="wbo-s2-title">${escHtml(meta.primaryTitle)}</span>
                ${subHtml}
            </span>
            ${groupBadge}
        </span>
    `);
}

/**
 * Build Select2 `templateSelection` for `#world_editor_select` (single select).
 * Returns a plain string so the native single-line selection box, clear icon,
 * and dropdown arrow layout remain 100% untouched across all themes.
 * @param {any} state
 */
function renderEditorSelect2Selection(state) {
    if (!state.id) return state.text;
    const realName = String(state.text ?? '').trim();
    const meta = _latestClassification?.byName?.get(realName);
    if (!meta) return state.text;
    return meta.primaryTitle;
}

/**
 * Restore all detached options back into a `<select>` and unwrap ALL `<optgroup>`s
 * so leftover or foreign empty group headers never remain.
 * @param {HTMLSelectElement} selectEl
 * @param {Map<string, HTMLOptionElement>} detachedMap
 */
function restoreSelectOptions(selectEl, detachedMap) {
    const optgroups = Array.from(selectEl.querySelectorAll('optgroup'));
    for (const grp of optgroups) {
        while (grp.firstChild) {
            selectEl.appendChild(grp.firstChild);
        }
        grp.remove();
    }

    // Collect existing option texts to avoid duplicates after upstream `updateWorldInfoList`
    const existingByText = new Map();
    selectEl.querySelectorAll('option').forEach((opt) => {
        if (opt.value !== '') {
            existingByText.set((opt.textContent || '').trim(), opt);
        }
    });

    for (const [name, opt] of detachedMap.entries()) {
        if (!existingByText.has(name)) {
            selectEl.appendChild(opt);
            existingByText.set(name, opt);
        }
    }
    detachedMap.clear();
}

/**
 * Sort options by their numeric `value` (upstream `world_names` index) to preserve
 * native order when restoring or when not grouping.
 * @param {HTMLOptionElement[]} options
 */
function sortByNativeValue(options) {
    return options.sort((a, b) => {
        const na = Number(a.value);
        const nb = Number(b.value);
        if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
        return (a.textContent || '').localeCompare(b.textContent || '', 'zh-CN');
    });
}

/**
 * Compute a stable signature of what `#world_info` or `#world_editor_select`
 * should contain, so we skip touching Select2 completely when nothing changed.
 */
function computeSelectSignature(selectEl, detachedMap, classification, settings, mode) {
    const allNames = [];
    const seen = new Set();
    selectEl.querySelectorAll('option').forEach((opt) => {
        if (opt.value === '') return;
        const name = (opt.textContent || '').trim();
        if (name && !seen.has(name)) {
            seen.add(name);
            allNames.push(`${name}:${opt.selected ? 1 : 0}`);
        }
    });
    for (const name of detachedMap.keys()) {
        if (!seen.has(name)) {
            seen.add(name);
            allNames.push(`${name}:0`);
        }
    }
    allNames.sort();

    const groupSig = (classification.orderedSections || []).map((s) => `${s.id}=${s.name}`).join('|');
    const assignmentSig = Object.entries(settings.assignments || {})
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}>${v}`)
        .join('|');
    const aliasSig = Object.entries(settings.aliases || {})
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join('|');
    const charSig = [...classification.characterBooks.map((b) => `${b.realName}:${b.primaryTitle}:${b.subtitle}`)].join('|');

    const foreignOptgroupCount = mode === 'editor'
        ? selectEl.querySelectorAll('optgroup:not([data-wbo-group])').length
        : 0;
    const ownOptgroupCount = mode === 'editor'
        ? selectEl.querySelectorAll('optgroup[data-wbo-group]').length
        : 0;

    return JSON.stringify([
        mode,
        Boolean(settings.showCharBooks),
        Boolean(settings.showNativeOptgroups),
        settings.charBookTitleMode,
        settings.aliasTitleMode,
        mode === 'editor' ? _currentlyEditingWorld : '',
        foreignOptgroupCount,
        ownOptgroupCount,
        groupSig,
        assignmentSig,
        aliasSig,
        charSig,
        allNames.join(','),
    ]);
}

/**
 * Patch an already-initialized Select2 instance's options IN PLACE without ever
 * calling `select2('destroy')`! This preserves native Select2 DOM, theme arrows,
 * and compatibility with other extensions with zero artifacts or flicker.
 * @param {any} $select
 * @param {Record<string, any>} patch
 * @returns {boolean} true if patched in place
 */
function patchExistingSelect2InPlace($select, patch) {
    try {
        const inst = $select?.data?.('select2');
        const optsObj = inst?.options?.options;
        if (!optsObj || typeof optsObj !== 'object') return false;
        Object.assign(optsObj, patch);
        return true;
    } catch {
        return false;
    }
}

/**
 * Apply filtering and group ordering to `#world_info` (global multi-select).
 * NEVER uses `<optgroup>`, NEVER detaches selected options, and NEVER destroys native Select2!
 * @param {any} classification
 * @param {Record<string, any>} settings
 */
function applyGlobalWorldSelectFilter(classification, settings) {
    const $ = globalThis.jQuery;
    const selectEl = document.getElementById('world_info');
    if (!selectEl) return;

    const sig = computeSelectSignature(selectEl, _globalDetachedMap, classification, settings, 'global');
    if (sig === _lastGlobalSignature) return;
    _lastGlobalSignature = sig;

    const $select = $ ? $(selectEl) : null;
    const hasSelect2 = Boolean($select && ($select.data('select2') || $select.hasClass('select2-hidden-accessible')));

    restoreSelectOptions(selectEl, _globalDetachedMap);

    const placeholderOpts = [];
    const visibleOpts = [];

    for (const opt of Array.from(selectEl.querySelectorAll('option'))) {
        if (opt.value === '') {
            placeholderOpts.push(opt);
            continue;
        }
        const realName = (opt.textContent || '').trim();
        const meta = classification.byName.get(realName);
        const visible = isBookVisibleInSelector({
            bookMeta: meta,
            activeFilterGroupId: SPECIAL_GROUPS.DEFAULT,
            showCharBooks: Boolean(settings.showCharBooks),
            isSelected: opt.selected,
            isCurrentlyEditing: false,
        });

        if (visible) {
            visibleOpts.push(opt);
        } else {
            opt.remove();
            _globalDetachedMap.set(realName, opt);
        }
    }

    // Order visible options cleanly by user's unified sectionOrder -> primary title
    const groupOrder = new Map();
    (classification.sectionOrder || []).forEach((id, idx) => groupOrder.set(id, idx));

    visibleOpts.sort((a, b) => {
        const ma = classification.byName.get((a.textContent || '').trim());
        const mb = classification.byName.get((b.textContent || '').trim());
        const ga = groupOrder.get(ma?.groupId) ?? 10000;
        const gb = groupOrder.get(mb?.groupId) ?? 10000;
        if (ga !== gb) return ga - gb;
        const ta = ma?.primaryTitle || (a.textContent || '');
        const tb = mb?.primaryTitle || (b.textContent || '');
        return ta.localeCompare(tb, 'zh-CN');
    });

    for (const opt of [...placeholderOpts, ...visibleOpts]) {
        selectEl.appendChild(opt);
    }

    if (hasSelect2 && $select && selectEl.dataset.wboS2Ready !== '1') {
        const patched = patchExistingSelect2InPlace($select, {
            matcher: customSelect2Matcher,
            templateResult: (state) => renderSelect2OptionResult(state, { showGroupPill: true }),
        });
        if (patched) {
            selectEl.dataset.wboS2Ready = '1';
        }
    }
}

/**
 * Apply filtering and `<optgroup>` grouping to `#world_editor_select`.
 * Safe for both desktop Select2 and mobile native `<select>`.
 * Patches existing Select2 in place (NEVER destroys Select2 DOM or creates stray arrow artifacts!).
 * @param {any} classification
 * @param {Record<string, any>} settings
 */
function applyEditorWorldSelectFilter(classification, settings, { skipSelectionSync = false } = {}) {
    const $ = globalThis.jQuery;
    const selectEl = document.getElementById('world_editor_select');
    if (!selectEl) return;

    const sig = computeSelectSignature(selectEl, _editorDetachedMap, classification, settings, 'editor');
    if (sig === _lastEditorSignature) return;
    _lastEditorSignature = sig;

    const $select = $ ? $(selectEl) : null;
    const hasSelect2 = Boolean($select && ($select.data('select2') || $select.hasClass('select2-hidden-accessible')));

    const prevValue = selectEl.value;
    restoreSelectOptions(selectEl, _editorDetachedMap);

    const placeholderOpts = [];
    const visibleByGroup = new Map();

    for (const opt of Array.from(selectEl.querySelectorAll('option'))) {
        if (opt.value === '') {
            placeholderOpts.push(opt);
            continue;
        }
        const realName = (opt.textContent || '').trim();
        const meta = classification.byName.get(realName);
        const isEditing = opt.selected || (prevValue !== '' && opt.value === prevValue) || realName === _currentlyEditingWorld;

        const visible = isBookVisibleInSelector({
            bookMeta: meta,
            activeFilterGroupId: SPECIAL_GROUPS.DEFAULT,
            showCharBooks: Boolean(settings.showCharBooks),
            isSelected: opt.selected,
            isCurrentlyEditing: isEditing,
        });

        if (visible) {
            const gid = meta?.groupId || SPECIAL_GROUPS.UNGROUPED;
            if (!visibleByGroup.has(gid)) visibleByGroup.set(gid, []);
            visibleByGroup.get(gid).push(opt);
        } else {
            opt.remove();
            _editorDetachedMap.set(realName, opt);
        }
    }

    // Re-append placeholders first
    for (const opt of placeholderOpts) {
        selectEl.appendChild(opt);
    }

    const orderedSections = (classification.orderedSections || []).map((s) => ({
        id: s.id,
        label: s.name,
    }));

    const nonEmptySections = orderedSections.filter((sec) => (visibleByGroup.get(sec.id)?.length || 0) > 0);
    // Keep `#world_editor_select` 100% flat & native when only 1 section exists
    // (e.g., user only uses "hide character worldbooks" with 0 custom groups — zero visual intrusion!)
    const useOptgroups = Boolean(settings.showNativeOptgroups) && nonEmptySections.length >= 2;

    for (const sec of nonEmptySections) {
        const opts = visibleByGroup.get(sec.id);
        opts.sort((a, b) => {
            const ma = classification.byName.get((a.textContent || '').trim());
            const mb = classification.byName.get((b.textContent || '').trim());
            const ta = ma?.primaryTitle || (a.textContent || '');
            const tb = mb?.primaryTitle || (b.textContent || '');
            return ta.localeCompare(tb, 'zh-CN');
        });

        if (useOptgroups) {
            const optgroup = document.createElement('optgroup');
            optgroup.label = `${sec.label} (${opts.length})`;
            optgroup.setAttribute('data-wbo-group', sec.id);
            for (const opt of opts) {
                optgroup.appendChild(opt);
            }
            selectEl.appendChild(optgroup);
        } else {
            for (const opt of opts) {
                selectEl.appendChild(opt);
            }
        }
    }

    // Preserve selection cleanly
    if (prevValue !== '') {
        selectEl.value = prevValue;
    }

    if (hasSelect2 && $select && selectEl.dataset.wboS2Ready !== '1') {
        const patched = patchExistingSelect2InPlace($select, {
            matcher: customSelect2Matcher,
            templateResult: (state) => renderSelect2OptionResult(state, { showGroupPill: false }),
            templateSelection: renderEditorSelect2Selection,
        });
        if (patched) {
            selectEl.dataset.wboS2Ready = '1';
        }
    } else if (!skipSelectionSync && hasSelect2 && $select && prevValue !== '') {
        // Refresh displayed title in Select2 box (namespaced so host `change` does NOT refire;
        // skipped during `select2:opening` so `.select2-selection__rendered` is never rebuilt mid-click)
        try { $select.trigger('change.select2'); } catch { /* ignore */ }
    }

    // On native mobile `<select>` (iOS Safari / iPadOS / TauriTavern iOS / Android where Select2 is skipped),
    // system menus cannot filter or collapse groups. Mount a sleek grouped picker trigger when >= 2 sections exist!
    syncMobileEditorTrigger(selectEl, Boolean(!hasSelect2 && useOptgroups));
}

const MOBILE_TRIGGER_ID = 'wbo-mobile-editor-trigger';
const MOBILE_PICKER_OVERLAY_ID = 'wbo-mobile-picker-overlay';

/**
 * Sync the text shown inside the mobile grouped editor trigger button to match `#world_editor_select`.
 */
export function syncMobileEditorTriggerLabel() {
    const trigger = document.getElementById(MOBILE_TRIGGER_ID);
    const selectEl = document.getElementById('world_editor_select');
    if (!(trigger instanceof HTMLElement) || !(selectEl instanceof HTMLSelectElement)) return;
    const selectedOpt = selectEl.selectedOptions?.[0];
    const isSelected = Boolean(selectedOpt && selectedOpt.value !== '');
    const realName = isSelected ? (selectedOpt.textContent || '').trim() : '';
    const meta = realName ? _latestClassification?.byName?.get(realName) : null;
    const placeholderText = selectEl.querySelector('option[value=""]')?.textContent?.trim() || '--- 选择以编辑 ---';
    const label = isSelected ? (meta?.primaryTitle || realName) : placeholderText;

    const textSpan = trigger.querySelector('.wbo-mobile-trigger-text');
    if (textSpan) textSpan.textContent = label;
    trigger.classList.toggle('is-placeholder', !isSelected);
}

/**
 * Mount or remove the iOS/mobile grouped worldbook trigger button in place of the native `<select>`.
 * @param {HTMLSelectElement} selectEl
 * @param {boolean} enabled
 */
function syncMobileEditorTrigger(selectEl, enabled) {
    if (!selectEl) return;
    const existing = document.getElementById(MOBILE_TRIGGER_ID);
    if (!enabled) {
        selectEl.classList.remove('wbo-mobile-select-hidden');
        existing?.remove();
        document.getElementById(MOBILE_PICKER_OVERLAY_ID)?.remove();
        return;
    }

    let trigger = existing;
    if (!trigger) {
        trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.id = MOBILE_TRIGGER_ID;
        trigger.className = 'text_pole wbo-mobile-editor-trigger';
        trigger.innerHTML = `
            <span class="wbo-mobile-trigger-text">--- 选择以编辑 ---</span>
            <i class="fa-solid fa-chevron-down wbo-mobile-trigger-chev"></i>
        `;
        trigger.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            openMobileEditorPickerSheet();
        });
        selectEl.insertAdjacentElement('afterend', trigger);
    }

    selectEl.classList.add('wbo-mobile-select-hidden');
    syncMobileEditorTriggerLabel();
}

/**
 * Detect host light/dark mode for the mobile picker sheet (matches panel modals cleanly).
 */
function detectMobilePickerThemeClass() {
    const mode = _latestSettings?.themeMode || 'auto';
    if (mode === 'light') return 'wbo-theme-light';
    if (mode === 'dark') return 'wbo-theme-dark';
    try {
        const probe = document.getElementById('WorldInfo') || document.body;
        const m = (probe ? globalThis.getComputedStyle(probe).color : '').match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
        if (m) {
            const lum = 0.299 * Number(m[1]) + 0.587 * Number(m[2]) + 0.114 * Number(m[3]);
            return lum < 140 ? 'wbo-theme-light' : 'wbo-theme-dark';
        }
    } catch { /* ignore */ }
    return 'wbo-theme-dark';
}

/**
 * Open an anchored in-place dropdown panel right beneath `#wbo-mobile-editor-trigger`
 * (behaves just like desktop Select2 — NEVER hijacks the full screen on iOS/Android!).
 * Tapping outside dismisses it smoothly.
 */
function openMobileEditorPickerSheet() {
    const selectEl = document.getElementById('world_editor_select');
    const triggerEl = document.getElementById(MOBILE_TRIGGER_ID);
    if (!(selectEl instanceof HTMLSelectElement) || !(triggerEl instanceof HTMLElement)) return;
    if (!_latestClassification || !_latestSettings) return;

    // Toggle closed if already open
    const existingOverlay = document.getElementById(MOBILE_PICKER_OVERLAY_ID);
    if (existingOverlay) {
        existingOverlay.remove();
        triggerEl.classList.remove('is-open');
        return;
    }

    syncEditorBeforeOpen();

    if (!_latestSettings.dropdownCollapsed || typeof _latestSettings.dropdownCollapsed !== 'object') {
        _latestSettings.dropdownCollapsed = {};
    }

    // Build live option list from `#world_editor_select` so every option value matches ST's exact index
    const optValueByRealName = new Map();
    selectEl.querySelectorAll('option').forEach((opt) => {
        if (opt.value !== '') {
            optValueByRealName.set((opt.textContent || '').trim(), opt.value);
        }
    });
    const currentSelectedOpt = selectEl.selectedOptions?.[0];
    const currentSelectedVal = currentSelectedOpt && currentSelectedOpt.value !== '' ? currentSelectedOpt.value : '';

    const sections = (_latestClassification.orderedSections || [])
        .map((sec) => {
            const books = (sec.books || []).filter((b) => optValueByRealName.has(b.realName));
            return { id: sec.id, name: sec.name, color: sec.color, books };
        })
        .filter((sec) => sec.books.length > 0);

    const validIds = new Set(sections.map((s) => s.id));
    let activePillId =
        _dropdownMemory.activePillGroupId !== SPECIAL_GROUPS.ALL && validIds.has(_dropdownMemory.activePillGroupId)
            ? _dropdownMemory.activePillGroupId
            : SPECIAL_GROUPS.ALL;
    _dropdownMemory.activePillGroupId = activePillId;
    let searchQuery = '';
    let pillsExpanded = false;

    const overlay = document.createElement('div');
    overlay.id = MOBILE_PICKER_OVERLAY_ID;
    overlay.className = 'wbo-mp-backdrop';

    const popover = document.createElement('div');
    popover.className = `wbo-modal wbo-mp-popover ${detectMobilePickerThemeClass()}`;
    popover.setAttribute('data-wbo-palette', _latestSettings.themePalette || 'classic');

    popover.innerHTML = `
        <div class="wbo-mp-top">
            <div class="wbo-search-wrap wbo-mp-search-wrap">
                <i class="fa-solid fa-magnifying-glass"></i>
                <input type="search" class="wbo-search-input" id="wbo-mp-search" placeholder="搜索世界书..." autocomplete="off" spellcheck="false">
            </div>
            ${currentSelectedVal ? '<button type="button" class="wbo-mp-clear-btn" id="wbo-mp-clear" title="清除当前选择">清除</button>' : ''}
        </div>
        <div class="wbo-mp-pills-row">
            <div class="wbo-pills-rail">
                <div class="wbo-pills" id="wbo-mp-pills"></div>
                <button type="button" class="wbo-pill-expand-btn" id="wbo-mp-expand" title="展开全部分组"${sections.length < 2 ? ' hidden' : ''}>
                    <i class="fa-solid fa-chevron-down"></i>
                </button>
            </div>
        </div>
        <div class="wbo-mp-list" id="wbo-mp-list"></div>
    `;

    overlay.appendChild(popover);
    document.body.appendChild(overlay);
    triggerEl.classList.add('is-open');

    // Anchor popover directly below (or above if near bottom) the trigger box
    const positionPopover = () => {
        const rect = triggerEl.getBoundingClientRect();
        const vw = globalThis.innerWidth || document.documentElement.clientWidth || 390;
        const vh = globalThis.innerHeight || document.documentElement.clientHeight || 800;
        const margin = 10;
        const popWidth = Math.min(Math.max(rect.width + 64, 280), vw - margin * 2);
        const left = Math.max(margin, Math.min(rect.left, vw - popWidth - margin));

        const spaceBelow = vh - rect.bottom - 14;
        const spaceAbove = rect.top - 14;
        const openAbove = spaceBelow < 220 && spaceAbove > spaceBelow;
        const maxH = Math.max(180, Math.min(420, Math.floor((openAbove ? spaceAbove : spaceBelow) - 6)));

        popover.style.width = `${Math.round(popWidth)}px`;
        popover.style.left = `${Math.round(left)}px`;
        popover.style.maxHeight = `${maxH}px`;
        if (openAbove) {
            popover.style.top = 'auto';
            popover.style.bottom = `${Math.round(vh - rect.top + 4)}px`;
        } else {
            popover.style.bottom = 'auto';
            popover.style.top = `${Math.round(rect.bottom + 4)}px`;
        }
    };
    positionPopover();

    const closePicker = () => {
        overlay.remove();
        triggerEl.classList.remove('is-open');
    };

    const stopPopover = (ev) => ev.stopPropagation();
    for (const evtName of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'click', 'touchstart', 'touchend']) {
        popover.addEventListener(evtName, stopPopover);
    }
    overlay.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (ev.target === overlay) closePicker();
    });

    const pillsEl = popover.querySelector('#wbo-mp-pills');
    const expandBtn = popover.querySelector('#wbo-mp-expand');
    const searchInput = popover.querySelector('#wbo-mp-search');
    const listEl = popover.querySelector('#wbo-mp-list');

    const renderPills = () => {
        if (!pillsEl) return;
        const totalCount = sections.reduce((sum, s) => sum + s.books.length, 0);
        const items = [
            { id: SPECIAL_GROUPS.ALL, label: '全部', count: totalCount, color: '' },
            ...sections.map((s) => ({ id: s.id, label: s.name, count: s.books.length, color: s.color })),
        ];
        pillsEl.innerHTML = items.map((p) => `
            <button type="button" class="wbo-pill${activePillId === p.id ? ' is-active' : ''}" data-mp-pill="${escHtml(p.id)}">
                ${p.color ? `<span class="wbo-pill-dot" style="background:${escHtml(p.color)}"></span>` : ''}
                <span>${escHtml(p.label)}</span>
                <span class="wbo-pill-count">${p.count}</span>
            </button>
        `).join('');
    };

    const renderList = () => {
        if (!listEl) return;
        const q = searchQuery.trim().toLowerCase();
        const tokens = q ? q.split(/\s+/).filter(Boolean) : [];
        const isIsolated = !q && activePillId !== SPECIAL_GROUPS.ALL;

        const html = sections.map((sec) => {
            if (isIsolated && sec.id !== activePillId) return '';
            const books = tokens.length > 0
                ? sec.books.filter((b) => tokens.every((tok) => (b.searchableText || b.realName.toLowerCase()).includes(tok)))
                : sec.books;
            if (books.length === 0) return '';
            const collapsed = !q && !isIsolated && Boolean(_latestSettings.dropdownCollapsed[sec.id]);
            const rowsHtml = collapsed
                ? ''
                : books.map((b) => {
                    const optVal = optValueByRealName.get(b.realName) || '';
                    const isCurrent = optVal !== '' && optVal === currentSelectedVal;
                    return `
                        <button type="button" class="wbo-mp-row${isCurrent ? ' is-selected' : ''}" data-mp-val="${escHtml(optVal)}">
                            <span class="wbo-mp-row-text">
                                <span class="wbo-mp-row-title">${escHtml(b.primaryTitle)}</span>
                                ${b.subtitle ? `<span class="wbo-mp-row-sub">${escHtml(b.subtitle)}</span>` : ''}
                            </span>
                            ${isCurrent ? '<i class="fa-solid fa-check wbo-mp-check"></i>' : ''}
                        </button>
                    `;
                }).join('');

            return `
                <div class="wbo-mp-sec${collapsed ? ' is-collapsed' : ''}">
                    <button type="button" class="wbo-mp-sec-head${isIsolated ? ' is-static' : ''}" data-mp-toggle="${escHtml(sec.id)}">
                        ${isIsolated ? '<span class="wbo-mp-dot-ind">•</span>' : `<i class="fa-solid ${collapsed ? 'fa-chevron-right' : 'fa-chevron-down'} wbo-chevron"></i>`}
                        <span class="wbo-group-dot" style="background:${escHtml(sec.color || '#8c99a6')}"></span>
                        <span class="wbo-group-name">${escHtml(sec.name)}</span>
                        <span class="wbo-group-count">${books.length}</span>
                    </button>
                    ${collapsed ? '' : `<div class="wbo-mp-sec-body">${rowsHtml}</div>`}
                </div>
            `;
        }).filter(Boolean).join('');

        listEl.innerHTML = html || '<div class="wbo-empty-hint">无匹配世界书</div>';
    };

    const selectOptionValue = (val) => {
        if (listEl && !searchQuery.trim()) {
            _dropdownMemory.scrollTopByGroup[activePillId] = listEl.scrollTop;
        }
        const $ = globalThis.jQuery;
        if ($) {
            $(selectEl).val(val).trigger('change');
        } else {
            selectEl.value = val;
            selectEl.dispatchEvent(new Event('change', { bubbles: true }));
        }
        syncMobileEditorTriggerLabel();
        closePicker();
    };

    popover.querySelector('#wbo-mp-clear')?.addEventListener('click', () => selectOptionValue(''));

    expandBtn?.addEventListener('click', () => {
        pillsExpanded = !pillsExpanded;
        pillsEl?.classList.toggle('is-expanded', pillsExpanded);
        expandBtn.innerHTML = `<i class="fa-solid ${pillsExpanded ? 'fa-chevron-up' : 'fa-chevron-down'}"></i>`;
    });

    pillsEl?.addEventListener('click', (ev) => {
        const btn = ev.target instanceof Element ? ev.target.closest('[data-mp-pill]') : null;
        if (!btn) return;
        if (listEl && !searchQuery.trim()) {
            _dropdownMemory.scrollTopByGroup[activePillId] = listEl.scrollTop;
        }
        const gid = btn.getAttribute('data-mp-pill') || SPECIAL_GROUPS.ALL;
        activePillId = (gid === activePillId && gid !== SPECIAL_GROUPS.ALL) ? SPECIAL_GROUPS.ALL : gid;
        _dropdownMemory.activePillGroupId = activePillId;
        renderPills();
        renderList();
        if (listEl) listEl.scrollTop = _dropdownMemory.scrollTopByGroup[activePillId] ?? 0;
    });

    listEl?.addEventListener('click', (ev) => {
        const target = ev.target instanceof Element ? ev.target : null;
        if (!target) return;
        const toggleBtn = target.closest('[data-mp-toggle]');
        if (toggleBtn) {
            if (activePillId !== SPECIAL_GROUPS.ALL || searchQuery.trim()) return;
            const gid = toggleBtn.getAttribute('data-mp-toggle');
            if (!gid) return;
            const willCollapse = !_latestSettings.dropdownCollapsed[gid];
            _latestSettings.dropdownCollapsed[gid] = willCollapse;
            saveSettings();
            const prevTop = listEl.scrollTop;
            renderList();
            if (willCollapse) {
                const nextBtn = listEl.querySelector(`[data-mp-toggle="${CSS.escape(gid)}"]`);
                if (nextBtn instanceof HTMLElement) {
                    nextBtn.scrollIntoView({ block: 'nearest' });
                }
            } else {
                listEl.scrollTop = prevTop;
            }
            return;
        }
        const rowBtn = target.closest('[data-mp-val]');
        if (rowBtn) {
            const val = rowBtn.getAttribute('data-mp-val') ?? '';
            selectOptionValue(val);
        }
    });

    if (searchInput instanceof HTMLInputElement) {
        let composing = false;
        searchInput.addEventListener('compositionstart', () => { composing = true; });
        searchInput.addEventListener('compositionend', () => {
            composing = false;
            searchQuery = searchInput.value;
            renderList();
        });
        searchInput.addEventListener('input', () => {
            if (composing) return;
            searchQuery = searchInput.value;
            renderList();
        });
    }

    renderPills();
    renderList();
    if (listEl) {
        const savedTop = _dropdownMemory.scrollTopByGroup[activePillId];
        if (typeof savedTop === 'number' && savedTop > 0) {
            requestAnimationFrame(() => { listEl.scrollTop = savedTop; });
        }
    }
}

/**
 * Apply current classification & settings to both `#world_info` and `#world_editor_select`.
 * Protected by a re-entry lock AND `takeRecords()` flush so our own DOM edits
 * NEVER trigger MutationObserver feedback loops!
 * @param {any} classification
 * @param {Record<string, any>} settings
 * @param {{ force?: boolean }} [opts]
 */
export function applyAllNativeWorldFilters(classification, settings, { force = false } = {}) {
    _latestClassification = classification;
    _latestSettings = settings;
    if (force) {
        _lastGlobalSignature = null;
        _lastEditorSignature = null;
    }
    if (_isApplying) return;
    _isApplying = true;
    try {
        applyGlobalWorldSelectFilter(classification, settings);
        applyEditorWorldSelectFilter(classification, settings);
    } finally {
        // CRITICAL: flush mutation records generated by our own DOM updates BEFORE
        // releasing `_isApplying`, otherwise MutationObserver fires on the next microtask
        // and creates an infinite Select2 destroy/rebuild oscillation loop!
        _globalSelectObserver?.takeRecords();
        _editorSelectObserver?.takeRecords();
        _isApplying = false;
    }
}

/**
 * Synchronously ensure a specific worldbook's `<option>` is attached in `#world_editor_select`
 * BEFORE SillyTavern's own `openWorldInfoEditor(worldName)` runs `$('#world_editor_select').val(idx).trigger('change')`.
 * Without this, clicking a character card's globe button (`#world_button`) or chat lorebook button
 * when character worldbooks are hidden would fail to find the detached `<option>` and close the editor!
 * @param {string | null | undefined} worldName
 */
export function ensureEditorOptionAttached(worldName) {
    const clean = String(worldName ?? '').trim();
    if (!clean) return;
    setCurrentlyEditingWorld(clean);

    const selectEl = document.getElementById('world_editor_select');
    if (!selectEl) return;

    if (_editorDetachedMap.has(clean)) {
        _isApplying = true;
        try {
            const opt = _editorDetachedMap.get(clean);
            _editorDetachedMap.delete(clean);
            if (opt) selectEl.appendChild(opt);
            _lastEditorSignature = null;
        } finally {
            _editorSelectObserver?.takeRecords();
            _isApplying = false;
        }
    }
}

/**
 * Programmatically open a worldbook in the native editor — even if it belongs to
 * the currently hidden character group!
 * @param {string} realName
 * @returns {boolean}
 */
export function openWorldInNativeEditor(realName) {
    const clean = String(realName ?? '').trim();
    if (!clean) return false;
    ensureEditorOptionAttached(clean);

    // Re-apply cleanly if classification is ready so optgroups stay tidy
    if (_latestClassification && _latestSettings) {
        applyAllNativeWorldFilters(_latestClassification, _latestSettings);
    }

    const selectEl = document.getElementById('world_editor_select');
    if (!selectEl) return false;

    const targetOpt = Array.from(selectEl.querySelectorAll('option')).find(
        (opt) => opt.value !== '' && (opt.textContent || '').trim() === clean,
    );
    if (!targetOpt) return false;

    const $ = globalThis.jQuery;
    if ($) {
        $(selectEl).val(targetOpt.value).trigger('change');
    } else {
        selectEl.value = targetOpt.value;
        selectEl.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // Expand WorldInfo drawer if currently closed
    const drawer = document.getElementById('WorldInfo');
    if (drawer && drawer.classList.contains('closedDrawer')) {
        const icon = document.querySelector('#WI-SP-button .drawer-icon');
        if (icon instanceof HTMLElement) icon.click();
    }
    return true;
}

/**
 * Programmatically toggle a worldbook in `#world_info` (global active list),
 * even if the book was temporarily hidden in the dropdown.
 * @param {string} realName
 * @param {boolean} active
 * @returns {boolean}
 */
export function setGlobalWorldActive(realName, active) {
    const clean = String(realName ?? '').trim();
    if (!clean) return false;

    const selectEl = document.getElementById('world_info');
    if (!selectEl) return false;

    let targetOpt = Array.from(selectEl.querySelectorAll('option')).find(
        (opt) => opt.value !== '' && (opt.textContent || '').trim() === clean,
    );

    // If enabling a hidden option, re-attach it first
    if (!targetOpt && active && _globalDetachedMap.has(clean)) {
        _isApplying = true;
        try {
            targetOpt = _globalDetachedMap.get(clean);
            _globalDetachedMap.delete(clean);
            selectEl.appendChild(targetOpt);
            _lastGlobalSignature = null;
        } finally {
            _globalSelectObserver?.takeRecords();
            _isApplying = false;
        }
    }

    if (!targetOpt) return false;
    const prevFocus = document.activeElement;
    targetOpt.selected = Boolean(active);

    const $ = globalThis.jQuery;
    if ($) {
        $(selectEl).trigger('change');
    } else {
        selectEl.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // Prevent Select2 from stealing focus into `#world_info` and scrolling the page
    const curFocus = document.activeElement;
    if (curFocus instanceof HTMLElement && curFocus !== prevFocus) {
        const inWorldInfo = curFocus === selectEl || Boolean(curFocus.closest?.('#world_info, .select2-container'));
        if (inWorldInfo) {
            curFocus.blur();
            if (prevFocus instanceof HTMLElement && prevFocus.isConnected) {
                try { prevFocus.focus({ preventScroll: true }); } catch { /* ignore */ }
            }
        }
    }

    // Only re-hide a detached hidden character book if it was deactivated
    if (!active && _latestClassification && _latestSettings) {
        const meta = _latestClassification.byName?.get(clean);
        if (meta?.isInCharGroup && !_latestSettings.showCharBooks) {
            setTimeout(() => {
                if (_latestClassification && _latestSettings) {
                    applyAllNativeWorldFilters(_latestClassification, _latestSettings);
                }
            }, 0);
        }
    }

    return true;
}

/**
 * Enhance a dynamically opened `.character_world` ("Link to World Info") popup
 * with a lightweight filter bar hiding OTHER characters' worldbooks by default.
 * @param {HTMLElement} charWorldEl
 */
function enhanceCharBindPopup(charWorldEl) {
    if (!charWorldEl || charWorldEl.dataset.wboEnhanced === '1') return;
    if (!_latestClassification || !_latestSettings) return;
    if (_latestSettings.adaptCharBindPopup === false) return;
    charWorldEl.dataset.wboEnhanced = '1';

    const primarySelect = charWorldEl.querySelector('.character_world_info_selector');
    const extrasSelect = charWorldEl.querySelector('.character_extra_world_info_selector');
    if (!primarySelect && !extrasSelect) return;

    const currentAvatar = getCurrentCharacterAvatar();
    let hideOthers = Boolean(_latestSettings.autoHideInCharBindPopup);
    let filterGroupId = hideOthers ? SPECIAL_GROUPS.DEFAULT : SPECIAL_GROUPS.ALL;

    /** @type {Map<HTMLSelectElement, Map<string, HTMLOptionElement>>} */
    const popupDetached = new Map();
    if (primarySelect) popupDetached.set(primarySelect, new Map());
    if (extrasSelect) popupDetached.set(extrasSelect, new Map());

    const bar = document.createElement('div');
    bar.className = 'wbo-charpopup-bar';

    const brand = document.createElement('span');
    brand.className = 'wbo-popup-brand';
    brand.title = '由「世界书分组管理」插件提供筛选';
    brand.innerHTML = '<i class="fa-solid fa-layer-group"></i><span>分组筛选</span>';

    const groupSelect = document.createElement('select');
    groupSelect.className = 'text_pole wbo-charpopup-select';
    groupSelect.title = '按分组筛选世界书';

    const populateGroupOptions = () => {
        groupSelect.innerHTML = '';
        const items = [
            { id: SPECIAL_GROUPS.DEFAULT, label: '隐藏其他角色书' },
            { id: SPECIAL_GROUPS.ALL, label: '全部世界书' },
            ..._latestClassification.customGroups.map((g) => ({ id: g.id, label: `分组：${g.name}` })),
            ...(_latestClassification.customGroups.length > 0 ? [{ id: SPECIAL_GROUPS.UNGROUPED, label: '未分组' }] : []),
            { id: SPECIAL_GROUPS.CHARACTER, label: '角色世界书' },
        ];
        for (const item of items) {
            const opt = document.createElement('option');
            opt.value = item.id;
            opt.textContent = item.label;
            if (item.id === filterGroupId) opt.selected = true;
            groupSelect.appendChild(opt);
        }
    };

    const applyPopupFilter = () => {
        const targets = [primarySelect, extrasSelect].filter(Boolean);
        const $ = globalThis.jQuery;

        for (const sel of targets) {
            const detached = popupDetached.get(sel);
            const $sel = $ ? $(sel) : null;
            const hadS2 = Boolean($sel && ($sel.data('select2') || $sel.hasClass('select2-hidden-accessible')));

            // CRITICAL: NEVER call `$sel.select2('destroy')` inside SillyTavern's native `<dialog>`!
            // Re-initializing Select2 without `dropdownParent: $(popup.dlg)` moves its dropdown to
            // `document.body` BEHIND the top-layer `<dialog>`, turning the multi-select into an
            // unopenable text input! Mutating `<option>`s + patching Select2 in place preserves
            // `dropdownParent`, placeholder, and top-layer isolation 100%!
            restoreSelectOptions(sel, detached);
            const placeholders = [];
            const visible = [];

            for (const opt of Array.from(sel.querySelectorAll('option'))) {
                if (opt.value === '') {
                    placeholders.push(opt);
                    continue;
                }
                const realName = (opt.textContent || '').trim();
                const meta = _latestClassification.byName.get(realName);
                const show = isBookVisibleInCharBindPopup({
                    bookMeta: meta,
                    currentCharAvatar: currentAvatar,
                    hideOtherCharBooks: hideOthers,
                    filterGroupId,
                    isSelected: opt.selected,
                });
                if (show) {
                    visible.push(opt);
                } else {
                    opt.remove();
                    detached.set(realName, opt);
                }
            }

            sortByNativeValue(visible);
            for (const opt of [...placeholders, ...visible]) {
                sel.appendChild(opt);
            }

            if (hadS2 && $sel) {
                patchExistingSelect2InPlace($sel, {
                    matcher: customSelect2Matcher,
                    templateResult: (state) => renderSelect2OptionResult(state, { showGroupPill: true }),
                });
                try { $sel.trigger('change.select2'); } catch { /* ignore */ }
            }
        }
    };

    bar.addEventListener('click', (ev) => ev.stopPropagation());
    bar.addEventListener('mousedown', (ev) => ev.stopPropagation());

    groupSelect.addEventListener('change', () => {
        filterGroupId = groupSelect.value;
        hideOthers = filterGroupId === SPECIAL_GROUPS.DEFAULT;
        applyPopupFilter();
    });

    populateGroupOptions();
    bar.append(brand, groupSelect);
    charWorldEl.prepend(bar);

    // Let upstream Select2 finish initializing in `Popup.onOpen`, then filter & patch in place
    setTimeout(applyPopupFilter, 60);
    setTimeout(() => {
        const $ = globalThis.jQuery;
        if (!$ || !charWorldEl.isConnected) return;
        for (const sel of [primarySelect, extrasSelect].filter(Boolean)) {
            const $sel = $(sel);
            if ($sel.data('select2')) {
                patchExistingSelect2InPlace($sel, {
                    matcher: customSelect2Matcher,
                    templateResult: (state) => renderSelect2OptionResult(state, { showGroupPill: true }),
                });
            }
        }
    }, 220);
}

/**
 * Enhance any standard SillyTavern single-select worldbook popup:
 * - User Persona worldbook (`.persona_world` -> `.persona_world_info_selector`)
 * - Chat worldbook (`.chat_world` -> `.chat_world_info_selector`)
 * - Move/Copy entry target (`#move_entry_target_select`)
 * Safely groups visible options into `<optgroup>`s without altering `option.value`,
 * and injects a compact group-filter + character-book visibility bar above the select.
 *
 * @param {HTMLElement} hostContainer
 * @param {HTMLSelectElement} selectEl
 * @param {{ settingKey: string }} opts
 */
function enhanceStandardWorldSelectPopup(hostContainer, selectEl, { settingKey }) {
    if (!hostContainer || !selectEl || selectEl.dataset.wboEnhanced === '1') return;
    if (!_latestClassification || !_latestSettings) return;
    if (settingKey && _latestSettings[settingKey] === false) return;
    selectEl.dataset.wboEnhanced = '1';

    let showCharBooks = Boolean(_latestSettings.showCharBooks);
    let filterGroupId = showCharBooks ? SPECIAL_GROUPS.ALL : SPECIAL_GROUPS.DEFAULT;
    /** @type {Map<string, HTMLOptionElement>} */
    const detached = new Map();

    const bar = document.createElement('div');
    bar.className = 'wbo-charpopup-bar';

    const brand = document.createElement('span');
    brand.className = 'wbo-popup-brand';
    brand.title = '由「世界书分组管理」插件提供筛选';
    brand.innerHTML = '<i class="fa-solid fa-layer-group"></i><span>分组筛选</span>';

    const groupSelect = document.createElement('select');
    groupSelect.className = 'text_pole wbo-charpopup-select';
    groupSelect.title = '按分组筛选世界书';

    const populateGroupOptions = () => {
        groupSelect.innerHTML = '';
        const items = [
            { id: SPECIAL_GROUPS.DEFAULT, label: '隐藏角色书' },
            { id: SPECIAL_GROUPS.ALL, label: '全部世界书' },
            ..._latestClassification.customGroups.map((g) => ({ id: g.id, label: `分组：${g.name}` })),
            ...(_latestClassification.customGroups.length > 0 ? [{ id: SPECIAL_GROUPS.UNGROUPED, label: '未分组' }] : []),
            ...(_latestClassification.charCount > 0 ? [{ id: SPECIAL_GROUPS.CHARACTER, label: '角色世界书' }] : []),
        ];
        for (const item of items) {
            const opt = document.createElement('option');
            opt.value = item.id;
            opt.textContent = item.label;
            if (item.id === filterGroupId) opt.selected = true;
            groupSelect.appendChild(opt);
        }
    };

    const applyFilter = () => {
        const prevValue = selectEl.value;
        restoreSelectOptions(selectEl, detached);

        const placeholders = [];
        const visibleByGroup = new Map();

        for (const opt of Array.from(selectEl.querySelectorAll('option'))) {
            if (opt.value === '') {
                placeholders.push(opt);
                continue;
            }
            const realName = (opt.dataset.wboRealName || opt.textContent || '').trim();
            opt.dataset.wboRealName = realName;
            const meta = _latestClassification.byName.get(realName);
            const show = isBookVisibleInSelector({
                bookMeta: meta,
                activeFilterGroupId: filterGroupId,
                showCharBooks,
                isSelected: opt.selected || (prevValue !== '' && opt.value === prevValue),
                isCurrentlyEditing: false,
            });
            if (show) {
                // Show clean alias when available while preserving `option.value` untouched!
                if (meta && meta.primaryTitle && meta.primaryTitle !== realName) {
                    opt.textContent = meta.subtitle ? `${meta.primaryTitle} (${meta.subtitle})` : meta.primaryTitle;
                } else {
                    opt.textContent = realName;
                }
                const gid = meta?.groupId || SPECIAL_GROUPS.UNGROUPED;
                if (!visibleByGroup.has(gid)) visibleByGroup.set(gid, []);
                visibleByGroup.get(gid).push(opt);
            } else {
                opt.remove();
                detached.set(realName, opt);
            }
        }

        for (const opt of placeholders) selectEl.appendChild(opt);

        const orderedSections = (_latestClassification.orderedSections || []).filter(
            (sec) => (visibleByGroup.get(sec.id)?.length || 0) > 0,
        );
        const useOptgroups = (filterGroupId === SPECIAL_GROUPS.DEFAULT || filterGroupId === SPECIAL_GROUPS.ALL) && orderedSections.length >= 2;

        for (const sec of orderedSections) {
            const opts = visibleByGroup.get(sec.id) || [];
            opts.sort((a, b) => (a.textContent || '').localeCompare(b.textContent || '', 'zh-CN'));
            if (useOptgroups) {
                const grp = document.createElement('optgroup');
                grp.label = `${sec.name} (${opts.length})`;
                for (const opt of opts) grp.appendChild(opt);
                selectEl.appendChild(grp);
            } else {
                for (const opt of opts) selectEl.appendChild(opt);
            }
        }

        if (prevValue !== '') selectEl.value = prevValue;
    };

    bar.addEventListener('click', (ev) => ev.stopPropagation());
    bar.addEventListener('mousedown', (ev) => ev.stopPropagation());

    groupSelect.addEventListener('change', () => {
        filterGroupId = groupSelect.value;
        showCharBooks = filterGroupId === SPECIAL_GROUPS.ALL || filterGroupId === SPECIAL_GROUPS.CHARACTER;
        applyFilter();
    });

    populateGroupOptions();
    bar.append(brand, groupSelect);
    selectEl.parentElement?.insertBefore(bar, selectEl);
    applyFilter();
}

/** @type {(() => void) | null} */
let _editorNativeOpenHandler = null;
/** @type {((ev: any) => void) | null} */
let _editorSelect2OpeningHandler = null;
/** @type {((ev: any) => void) | null} */
let _editorSelect2OpenHandler = null;
/** @type {((ev: any) => void) | null} */
let _editorSelect2CloseHandler = null;
/** @type {MutationObserver | null} */
let _openDropdownResultsObserver = null;
/** @type {(() => void) | null} */
let _openDropdownCleanup = null;
/** @type {((ev: Event) => void) | null} */
let _docDrawerGuardMouseDown = null;
/** @type {((ev: Event) => void) | null} */
let _docDrawerGuardClick = null;
/** @type {((ev: MouseEvent) => void) | null} */
let _docWorldJumpPreAttach = null;
let _lastWorldSelectMouseDownAt = 0;

/**
 * Persistent in-session memory for `#world_editor_select` dropdown (both native Select2
 * and custom dropdown popovers) so reopening restores the exact group tab, horizontal
 * pill scroll offset, and per-group vertical option scroll position instead of jumping!
 */
const _dropdownMemory = {
    activePillGroupId: SPECIAL_GROUPS.ALL,
    pillBarScrollLeft: 0,
    pillsExpanded: false,
    /** @type {Record<string, number>} */
    scrollTopByGroup: {},
};

/**
 * Locate the actual vertically scrollable container starting at `startEl` up to `boundaryEl`.
 * Handles both Select2 (`ul.select2-results__options` or `.select2-results`) and
 * custom popovers where either the options list or a wrapper scrolls.
 * @param {HTMLElement} startEl
 * @param {HTMLElement} boundaryEl
 * @returns {HTMLElement}
 */
function findScrollableListEl(startEl, boundaryEl) {
    let cur = startEl;
    while (cur && cur instanceof HTMLElement) {
        const cs = globalThis.getComputedStyle(cur);
        const oy = cs?.overflowY || '';
        const isScrollableStyle = oy === 'auto' || oy === 'scroll' || oy === 'overlay';
        if (isScrollableStyle && cur.scrollHeight > cur.clientHeight + 2) {
            return cur;
        }
        if (cur === boundaryEl) break;
        cur = cur.parentElement;
    }
    cur = startEl;
    while (cur && cur instanceof HTMLElement) {
        const cs = globalThis.getComputedStyle(cur);
        const oy = cs?.overflowY || '';
        if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') {
            return cur;
        }
        if (cur === boundaryEl) break;
        cur = cur.parentElement;
    }
    return startEl;
}

/**
 * Build the split in-dropdown group filter bar:
 * `[全部] | [scrollable group pills...]` so scrolled pills clip cleanly at the divider
 * and NEVER slide underneath the pinned `全部` button!
 * @param {Array<{ id: string, label: string }>} groupItems
 * @param {string} activePillGroupId
 * @param {string} [extraClass='']
 * @returns {{ barEl: HTMLDivElement, scrollEl: HTMLDivElement }}
 */
function createDropdownFilterBar(groupItems, activePillGroupId, extraClass = '') {
    const barEl = document.createElement('div');
    barEl.className = `wbo-dd-filter-bar${extraClass ? ` ${extraClass}` : ''}${_dropdownMemory.pillsExpanded ? ' is-expanded' : ''}`;

    const allBtn = document.createElement('button');
    allBtn.type = 'button';
    allBtn.className = `wbo-dd-pill is-pinned-all${activePillGroupId === SPECIAL_GROUPS.ALL ? ' is-active' : ''}`;
    allBtn.setAttribute('data-wbo-pill', SPECIAL_GROUPS.ALL);
    allBtn.textContent = '全部';

    const divider = document.createElement('span');
    divider.className = 'wbo-dd-divider';
    divider.setAttribute('aria-hidden', 'true');

    const scrollEl = document.createElement('div');
    scrollEl.className = 'wbo-dd-pill-scroll';
    scrollEl.innerHTML = groupItems
        .map((p) => `<button type="button" class="wbo-dd-pill${p.id === activePillGroupId ? ' is-active' : ''}" data-wbo-pill="${escHtml(p.id)}">${escHtml(p.label)}</button>`)
        .join('');

    scrollEl.addEventListener('wheel', (ev) => {
        if (!barEl.classList.contains('is-expanded') && Math.abs(ev.deltaY) > Math.abs(ev.deltaX) && scrollEl.scrollWidth > scrollEl.clientWidth) {
            ev.preventDefault();
            scrollEl.scrollLeft += ev.deltaY;
        }
    }, { passive: false });

    const expandBtn = document.createElement('button');
    expandBtn.type = 'button';
    expandBtn.className = 'wbo-dd-expand-btn';
    expandBtn.title = _dropdownMemory.pillsExpanded ? '收起为单行' : '展开查看全部分组';
    expandBtn.innerHTML = `<i class="fa-solid ${_dropdownMemory.pillsExpanded ? 'fa-chevron-up' : 'fa-chevron-down'}"></i>`;
    expandBtn.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
    });
    expandBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        _dropdownMemory.pillsExpanded = !_dropdownMemory.pillsExpanded;
        barEl.classList.toggle('is-expanded', _dropdownMemory.pillsExpanded);
        expandBtn.title = _dropdownMemory.pillsExpanded ? '收起为单行' : '展开查看全部分组';
        expandBtn.innerHTML = `<i class="fa-solid ${_dropdownMemory.pillsExpanded ? 'fa-chevron-up' : 'fa-chevron-down'}"></i>`;
    });

    barEl.append(allBtn, divider, scrollEl, expandBtn);
    return { barEl, scrollEl };
}

/**
 * Clean up any temporary interactive controls attached to an open `#world_editor_select`
 * Select2 dropdown (zero DOM left behind once closed!).
 */
function cleanupOpenEditorDropdown() {
    if (_openDropdownResultsObserver) {
        _openDropdownResultsObserver.disconnect();
        _openDropdownResultsObserver = null;
    }
    if (_openDropdownCleanup) {
        try { _openDropdownCleanup(); } catch { /* ignore */ }
        _openDropdownCleanup = null;
    }
    document.querySelectorAll('.wbo-dd-filter-bar').forEach((el) => el.remove());
}

/**
 * Enhance the currently open `#world_editor_select` Select2 dropdown with:
 * 1. Clickable collapsible/expandable group headers (with instant chevron toggle,
 *    auto-expanding whenever the user types a search query).
 * 2. A sleek 1-line in-dropdown group filter pill strip (when 2+ groups exist)
 *    so users can switch or isolate groups right inside the dropdown without
 *    ever leaving it!
 */
function enhanceOpenEditorDropdown() {
    cleanupOpenEditorDropdown();
    const $ = globalThis.jQuery;
    const selectEl = document.getElementById('world_editor_select');
    if (!$ || !selectEl || !_latestSettings) return;

    const inst = $(selectEl).data('select2');
    const dropdownEl = inst?.$dropdown?.[0];
    if (!(dropdownEl instanceof HTMLElement)) return;

    const resultsList = dropdownEl.querySelector('.select2-results__options');
    if (!(resultsList instanceof HTMLElement)) return;

    // Build ordered group descriptors directly from the live `<optgroup>` elements
    const groups = Array.from(selectEl.querySelectorAll('optgroup[data-wbo-group]')).map((og) => {
        const id = og.getAttribute('data-wbo-group') || '';
        const fullLabel = og.label || '';
        const shortName = fullLabel.replace(/\s*\(\d+\)\s*$/, '').trim() || fullLabel;
        return { id, fullLabel, shortName, count: og.querySelectorAll('option').length };
    });

    if (groups.length === 0) return;

    const groupByLabel = new Map(groups.map((g) => [g.fullLabel, g]));
    const validGroupIds = new Set(groups.map((g) => g.id));
    if (!_latestSettings.dropdownCollapsed || typeof _latestSettings.dropdownCollapsed !== 'object') {
        _latestSettings.dropdownCollapsed = {};
    }

    // Restore previously selected group pill if it still exists in this dropdown
    let activePillGroupId =
        _dropdownMemory.activePillGroupId !== SPECIAL_GROUPS.ALL && validGroupIds.has(_dropdownMemory.activePillGroupId)
            ? _dropdownMemory.activePillGroupId
            : SPECIAL_GROUPS.ALL;
    _dropdownMemory.activePillGroupId = activePillGroupId;

    let isRestoringScroll = true;
    const searchInput = dropdownEl.querySelector('.select2-search__field');

    const isSearching = () =>
        searchInput instanceof HTMLInputElement && searchInput.value.trim().length > 0;

    /**
     * Synchronize collapsible state, chevrons, and active pill filter onto every
     * `<li class="select2-results__option--group">` inside the open dropdown.
     */
    const decorateGroupItems = () => {
        const searching = isSearching();
        const groupNodes = resultsList.querySelectorAll(':scope > li.select2-results__option--group');

        groupNodes.forEach((li) => {
            if (!(li instanceof HTMLElement)) return;
            const label = li.getAttribute('aria-label') || li.querySelector(':scope > .select2-results__group')?.textContent?.trim() || '';
            const desc = groupByLabel.get(label);
            const gid = desc?.id || label;
            li.setAttribute('data-wbo-dd-group', gid);

            const head = li.querySelector(':scope > .select2-results__group');
            const isIsolated = !searching && activePillGroupId !== SPECIAL_GROUPS.ALL;
            if (head instanceof HTMLElement) {
                head.classList.add('wbo-dd-group-head');
                head.classList.toggle('is-isolated', isIsolated);
                head.setAttribute('data-wbo-dd-group', gid);
                head.setAttribute('title', isIsolated ? '' : '点击展开或折叠该分组');
            }

            // Filter visibility when user picked a single group pill inside the dropdown
            const hiddenByPill = isIsolated && gid !== activePillGroupId;
            li.classList.toggle('wbo-dd-group-hidden', hiddenByPill);

            // Auto-expand while searching OR when isolated via filter pill
            const isCollapsed = !searching && !isIsolated && Boolean(_latestSettings.dropdownCollapsed[gid]);
            li.classList.toggle('wbo-dd-collapsed', isCollapsed);
        });
    };

    // Delegate mousedown/click on group headers: ONLY fold/unfold in "全部" view
    // (never unexpectedly teleport back to "全部" — use the "全部" pill for that!).
    const onResultsMouseDown = (ev) => {
        const head = ev.target instanceof Element ? ev.target.closest('.wbo-dd-group-head') : null;
        if (!head) return;
        ev.preventDefault();
        ev.stopPropagation();
        if (activePillGroupId !== SPECIAL_GROUPS.ALL) return;
        const gid = head.getAttribute('data-wbo-dd-group');
        if (!gid) return;
        _latestSettings.dropdownCollapsed[gid] = !_latestSettings.dropdownCollapsed[gid];
        saveSettings();
        decorateGroupItems();
    };
    const onResultsClick = (ev) => {
        const head = ev.target instanceof Element ? ev.target.closest('.wbo-dd-group-head') : null;
        if (!head) return;
        ev.preventDefault();
        ev.stopPropagation();
    };

    resultsList.addEventListener('mousedown', onResultsMouseDown, true);
    resultsList.addEventListener('click', onResultsClick, true);

    // Optional compact 1-line group filter bar inside the dropdown when 2+ groups exist
    let filterBar = null;
    let pillScrollEl = null;
    const syncPillButtons = () => {
        if (!filterBar) return;
        filterBar.querySelectorAll('.wbo-dd-pill').forEach((btn) => {
            const gid = btn.getAttribute('data-wbo-pill');
            btn.classList.toggle('is-active', gid === activePillGroupId);
        });
    };

    const getScrollHost = () => findScrollableListEl(resultsList, dropdownEl);

    if (groups.length >= 2) {
        const built = createDropdownFilterBar(
            groups.map((g) => ({ id: g.id, label: `${g.shortName} ${g.count}` })),
            activePillGroupId,
        );
        filterBar = built.barEl;
        pillScrollEl = built.scrollEl;

        // Keep dropdown open and NEVER let clicks bubble to `document` (which closes unpinned `#WorldInfo`!)
        filterBar.addEventListener('mousedown', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
        });
        filterBar.addEventListener('click', (ev) => {
            ev.stopPropagation();
            const btn = ev.target instanceof Element ? ev.target.closest('.wbo-dd-pill') : null;
            if (!btn) return;
            ev.preventDefault();
            const scrollHost = getScrollHost();
            if (!isSearching() && scrollHost.clientHeight > 0) {
                _dropdownMemory.scrollTopByGroup[activePillGroupId] = scrollHost.scrollTop;
            }
            const gid = btn.getAttribute('data-wbo-pill') || SPECIAL_GROUPS.ALL;
            activePillGroupId = (gid === activePillGroupId && gid !== SPECIAL_GROUPS.ALL)
                ? SPECIAL_GROUPS.ALL
                : gid;
            _dropdownMemory.activePillGroupId = activePillGroupId;
            syncPillButtons();
            decorateGroupItems();
            const targetTop = _dropdownMemory.scrollTopByGroup[activePillGroupId] ?? 0;
            scrollHost.scrollTop = targetTop;
        });

        pillScrollEl.addEventListener('scroll', () => {
            if (!isRestoringScroll && pillScrollEl.clientWidth > 0) {
                _dropdownMemory.pillBarScrollLeft = pillScrollEl.scrollLeft;
            }
        }, { passive: true });

        const resultsWrap = dropdownEl.querySelector('.select2-results');
        if (resultsWrap && resultsWrap.parentElement) {
            resultsWrap.parentElement.insertBefore(filterBar, resultsWrap);
        }
    }

    // Prevent ANY click inside `.select2-dropdown` (search bar, filter bar, margins) from
    // bubbling to `document` and triggering SillyTavern's unpinned-drawer auto-closer!
    const onDropdownClickStop = (ev) => {
        ev.stopPropagation();
    };
    dropdownEl.addEventListener('click', onDropdownClickStop);

    const scrollHost = getScrollHost();
    const saveCurrentScroll = () => {
        const host = getScrollHost();
        // CRITICAL: ignore detached/hidden `scrollTop === 0` after Select2 starts closing!
        if (!isSearching() && host.isConnected && host.clientHeight > 0) {
            _dropdownMemory.scrollTopByGroup[activePillGroupId] = host.scrollTop;
        }
        if (pillScrollEl && pillScrollEl.isConnected && pillScrollEl.clientWidth > 0) {
            _dropdownMemory.pillBarScrollLeft = pillScrollEl.scrollLeft;
        }
    };

    const restoreTimers = [];
    const cancelRestore = () => {
        isRestoringScroll = false;
        while (restoreTimers.length) clearTimeout(restoreTimers.pop());
    };

    const onResultsScroll = () => {
        if (!isRestoringScroll) {
            saveCurrentScroll();
        }
    };
    const onUserScrollInteract = () => {
        cancelRestore();
    };
    const onOptionPointerDown = (ev) => {
        const t = ev.target instanceof Element ? ev.target : null;
        if (t?.closest('.select2-results__option:not(.select2-results__option--group)')) {
            cancelRestore();
            saveCurrentScroll();
        }
    };
    scrollHost.addEventListener('scroll', onResultsScroll, { passive: true });
    scrollHost.addEventListener('wheel', onUserScrollInteract, { passive: true });
    scrollHost.addEventListener('touchmove', onUserScrollInteract, { passive: true });
    resultsList.addEventListener('pointerdown', onOptionPointerDown, true);
    resultsList.addEventListener('mousedown', onOptionPointerDown, true);

    const onSearchInput = () => {
        cancelRestore();
        requestAnimationFrame(decorateGroupItems);
    };
    if (searchInput instanceof HTMLInputElement) {
        searchInput.addEventListener('input', onSearchInput);
    }

    // Re-decorate whenever Select2 rebuilds result `<li>` nodes during search
    _openDropdownResultsObserver = new MutationObserver(() => {
        decorateGroupItems();
    });
    _openDropdownResultsObserver.observe(resultsList, { childList: true });

    // Restore both horizontal pill scroll & per-group vertical list scroll AFTER Select2's
    // internal `ensureHighlightVisible()` runs so reopening stays at the exact spot!
    const applySavedScrollPositions = () => {
        if (!isRestoringScroll) return;
        if (pillScrollEl && pillScrollEl.clientWidth > 0) {
            pillScrollEl.scrollLeft = _dropdownMemory.pillBarScrollLeft;
        }
        const savedTop = _dropdownMemory.scrollTopByGroup[activePillGroupId];
        if (typeof savedTop === 'number' && savedTop > 0) {
            const host = getScrollHost();
            if (host.clientHeight > 0) {
                host.scrollTop = savedTop;
            }
        }
    };

    restoreTimers.push(
        setTimeout(applySavedScrollPositions, 25),
        setTimeout(applySavedScrollPositions, 90),
        setTimeout(() => {
            applySavedScrollPositions();
            isRestoringScroll = false;
        }, 180),
    );

    _openDropdownCleanup = () => {
        cancelRestore();
        // Only snapshot scroll if the list is still visibly laid out (never overwrite with 0 when hidden!)
        if (!isSearching() && scrollHost.isConnected && scrollHost.clientHeight > 0) {
            _dropdownMemory.scrollTopByGroup[activePillGroupId] = scrollHost.scrollTop;
        }
        if (pillScrollEl && pillScrollEl.isConnected && pillScrollEl.clientWidth > 0) {
            _dropdownMemory.pillBarScrollLeft = pillScrollEl.scrollLeft;
        }
        dropdownEl.removeEventListener('click', onDropdownClickStop);
        scrollHost.removeEventListener('scroll', onResultsScroll);
        scrollHost.removeEventListener('wheel', onUserScrollInteract);
        scrollHost.removeEventListener('touchmove', onUserScrollInteract);
        resultsList.removeEventListener('pointerdown', onOptionPointerDown, true);
        resultsList.removeEventListener('mousedown', onOptionPointerDown, true);
        resultsList.removeEventListener('mousedown', onResultsMouseDown, true);
        resultsList.removeEventListener('click', onResultsClick, true);
        if (searchInput instanceof HTMLInputElement) {
            searchInput.removeEventListener('input', onSearchInput);
        }
        filterBar?.remove();
    };

    decorateGroupItems();
    requestAnimationFrame(applySavedScrollPositions);
    applySavedScrollPositions();
}

/**
 * Synchronously assert our custom `<optgroup>`s on `#world_editor_select` right
 * before the dropdown opens — ONLY doing work when foreign `<optgroup>`s were
 * injected or the live signature changed (0ms no-op in hide-only & steady state!).
 */
function syncEditorBeforeOpen() {
    if (_isApplying || !_latestClassification || !_latestSettings) return;
    const selectEl = document.getElementById('world_editor_select');
    if (!selectEl) return;
    const hasForeign = Boolean(selectEl.querySelector('optgroup:not([data-wbo-group])'));
    if (!hasForeign) {
        const curSig = computeSelectSignature(selectEl, _editorDetachedMap, _latestClassification, _latestSettings, 'editor');
        if (curSig === _lastEditorSignature) return;
    }
    _isApplying = true;
    try {
        _lastEditorSignature = null;
        applyEditorWorldSelectFilter(_latestClassification, _latestSettings, { skipSelectionSync: true });
    } finally {
        _editorSelectObserver?.takeRecords();
        _isApplying = false;
    }
}

/**
 * Progressively enhance custom third-party select popovers (e.g. `.gr-container-enhanced`)
 * when they open for `#world_editor_select` / `#world_info`:
 * - Reorganizes the existing live `.gr-option` nodes in place (preserving all click/touch
 *   listeners and styling!) into collapsible user groups + in-dropdown group filter pills!
 * @param {HTMLElement} containerEl
 */
function enhanceCustomDropdownPopover(containerEl) {
    if (!containerEl || !containerEl.isConnected || containerEl.dataset.wboPopoverReady === '1') return;
    if (!_latestClassification || !_latestSettings || _latestClassification.byName.size === 0) return;

    const optionNodes = Array.from(containerEl.querySelectorAll('.gr-option'));
    if (optionNodes.length === 0) return;

    const optionsHost = optionNodes[0].parentElement;
    if (!(optionsHost instanceof HTMLElement)) return;

    const getOptionText = (el) => {
        // Read text excluding any nested pin/icon spans
        let txt = '';
        for (const node of el.childNodes) {
            if (node.nodeType === 3) txt += node.textContent || '';
            else if (node instanceof HTMLElement && !node.classList.contains('gr-option-pin')) {
                txt += node.textContent || '';
            }
        }
        return txt.trim() || (el.textContent || '').trim();
    };

    // Verify this popover is actually displaying worldbooks (not presets/themes/etc.)
    let nonEmptyCount = 0;
    let matchedWorldCount = 0;
    for (const optEl of optionNodes) {
        const val = optEl.dataset?.value ?? '';
        const text = getOptionText(optEl);
        if (!val || !text || text.startsWith('---')) continue;
        nonEmptyCount += 1;
        if (_latestClassification.byName.has(text)) {
            matchedWorldCount += 1;
        }
    }
    if (nonEmptyCount === 0) return;
    const isWorldbookPopover =
        (matchedWorldCount >= 2 && matchedWorldCount / nonEmptyCount >= 0.45) ||
        (matchedWorldCount >= 1 && matchedWorldCount === nonEmptyCount);
    if (!isWorldbookPopover) return;

    containerEl.dataset.wboPopoverReady = '1';

    if (!_latestSettings.dropdownCollapsed || typeof _latestSettings.dropdownCollapsed !== 'object') {
        _latestSettings.dropdownCollapsed = {};
    }

    const placeholders = [];
    /** @type {Map<string, HTMLElement[]>} */
    const bucketByGroup = new Map();

    for (const optEl of optionNodes) {
        const val = optEl.dataset?.value ?? '';
        const text = getOptionText(optEl);
        if (val === '' || text.startsWith('---')) {
            placeholders.push(optEl);
            continue;
        }
        const meta = _latestClassification.byName.get(text);
        const gid = meta?.groupId || SPECIAL_GROUPS.UNGROUPED;
        if (!bucketByGroup.has(gid)) bucketByGroup.set(gid, []);
        bucketByGroup.get(gid).push(optEl);
    }

    const orderedSections = (_latestClassification.orderedSections || []).filter(
        (sec) => (bucketByGroup.get(sec.id)?.length || 0) > 0,
    );
    // Do not inject group headers/bars when only 1 section exists (zero intrusion for hide-only users!)
    if (orderedSections.length < 2) return;

    // Remove flat default labels before inserting our grouped sections
    optionsHost.querySelectorAll(':scope > .gr-group-label').forEach((el) => el.remove());

    for (const ph of placeholders) {
        optionsHost.appendChild(ph);
    }

    const validGroupIds = new Set(orderedSections.map((sec) => sec.id));
    let activePillGroupId =
        _dropdownMemory.activePillGroupId !== SPECIAL_GROUPS.ALL && validGroupIds.has(_dropdownMemory.activePillGroupId)
            ? _dropdownMemory.activePillGroupId
            : SPECIAL_GROUPS.ALL;
    _dropdownMemory.activePillGroupId = activePillGroupId;

    let isRestoringScroll = true;
    const searchInput = containerEl.querySelector('input[type="text"], input[type="search"], .gr-search-input');
    const isSearching = () =>
        searchInput instanceof HTMLInputElement && searchInput.value.trim().length > 0;

    /** @type {HTMLElement[]} */
    const sectionEls = [];

    for (const sec of orderedSections) {
        const items = bucketByGroup.get(sec.id) || [];
        items.sort((a, b) => {
            const ma = _latestClassification.byName.get(getOptionText(a));
            const mb = _latestClassification.byName.get(getOptionText(b));
            const ta = ma?.primaryTitle || getOptionText(a);
            const tb = mb?.primaryTitle || getOptionText(b);
            return ta.localeCompare(tb, 'zh-CN');
        });

        const secEl = document.createElement('div');
        secEl.className = 'wbo-gr-section';
        secEl.setAttribute('data-wbo-dd-group', sec.id);

        const headEl = document.createElement('div');
        headEl.className = 'gr-group-label wbo-dd-group-head';
        headEl.setAttribute('data-wbo-dd-group', sec.id);
        headEl.textContent = `${sec.name} (${items.length})`;
        headEl.title = '点击展开或折叠该分组';

        const bodyEl = document.createElement('div');
        bodyEl.className = 'wbo-gr-group-body';
        for (const optEl of items) {
            bodyEl.appendChild(optEl);
        }

        secEl.append(headEl, bodyEl);
        optionsHost.appendChild(secEl);
        sectionEls.push(secEl);
    }

    let filterBar = null;
    let pillScrollEl = null;
    const syncPillButtons = () => {
        if (!filterBar) return;
        filterBar.querySelectorAll('.wbo-dd-pill').forEach((btn) => {
            btn.classList.toggle('is-active', btn.getAttribute('data-wbo-pill') === activePillGroupId);
        });
    };

    const getScrollHost = () => findScrollableListEl(optionsHost, containerEl);

    const syncSections = () => {
        const searching = isSearching();
        const isIsolated = !searching && activePillGroupId !== SPECIAL_GROUPS.ALL;
        for (const secEl of sectionEls) {
            const gid = secEl.getAttribute('data-wbo-dd-group') || '';
            const headEl = secEl.querySelector(':scope > .wbo-dd-group-head');
            if (headEl instanceof HTMLElement) {
                headEl.classList.toggle('is-isolated', isIsolated);
                headEl.title = isIsolated ? '' : '点击展开或折叠该分组';
            }
            if (searching) {
                const hasVisibleChild = Array.from(secEl.querySelectorAll('.gr-option')).some(
                    (o) => o instanceof HTMLElement && o.style.display !== 'none',
                );
                secEl.classList.toggle('wbo-dd-group-hidden', !hasVisibleChild);
                secEl.classList.remove('wbo-dd-collapsed');
            } else {
                const hiddenByPill = isIsolated && gid !== activePillGroupId;
                secEl.classList.toggle('wbo-dd-group-hidden', hiddenByPill);
                const collapsed = !isIsolated && Boolean(_latestSettings.dropdownCollapsed[gid]);
                secEl.classList.toggle('wbo-dd-collapsed', collapsed);
            }
        }
    };

    optionsHost.addEventListener('mousedown', (ev) => {
        const head = ev.target instanceof Element ? ev.target.closest('.wbo-dd-group-head') : null;
        if (!head) return;
        ev.preventDefault();
        ev.stopPropagation();
        if (activePillGroupId !== SPECIAL_GROUPS.ALL) return;
        const gid = head.getAttribute('data-wbo-dd-group');
        if (!gid) return;
        _latestSettings.dropdownCollapsed[gid] = !_latestSettings.dropdownCollapsed[gid];
        saveSettings();
        syncSections();
    }, true);

    optionsHost.addEventListener('click', (ev) => {
        const head = ev.target instanceof Element ? ev.target.closest('.wbo-dd-group-head') : null;
        if (!head) return;
        ev.preventDefault();
        ev.stopPropagation();
    }, true);

    if (orderedSections.length >= 2) {
        const built = createDropdownFilterBar(
            orderedSections.map((sec) => ({
                id: sec.id,
                label: `${sec.name} ${(bucketByGroup.get(sec.id) || []).length}`,
            })),
            activePillGroupId,
            'wbo-gr-filter-bar',
        );
        filterBar = built.barEl;
        pillScrollEl = built.scrollEl;

        for (const evtName of ['mousedown', 'touchstart']) {
            filterBar.addEventListener(evtName, (ev) => {
                ev.stopPropagation();
            });
        }
        filterBar.addEventListener('click', (ev) => {
            ev.stopPropagation();
            const btn = ev.target instanceof Element ? ev.target.closest('.wbo-dd-pill') : null;
            if (!btn) return;
            ev.preventDefault();
            const scrollHost = getScrollHost();
            if (!isSearching() && scrollHost.clientHeight > 0) {
                _dropdownMemory.scrollTopByGroup[activePillGroupId] = scrollHost.scrollTop;
            }
            const gid = btn.getAttribute('data-wbo-pill') || SPECIAL_GROUPS.ALL;
            activePillGroupId = (gid === activePillGroupId && gid !== SPECIAL_GROUPS.ALL)
                ? SPECIAL_GROUPS.ALL
                : gid;
            _dropdownMemory.activePillGroupId = activePillGroupId;
            syncPillButtons();
            syncSections();
            scrollHost.scrollTop = _dropdownMemory.scrollTopByGroup[activePillGroupId] ?? 0;
        });

        pillScrollEl.addEventListener('scroll', () => {
            if (!isRestoringScroll && pillScrollEl.clientWidth > 0) {
                _dropdownMemory.pillBarScrollLeft = pillScrollEl.scrollLeft;
            }
        }, { passive: true });

        optionsHost.parentElement?.insertBefore(filterBar, optionsHost);
    }

    // Prevent ANY click inside the body-mounted custom popover from bubbling to `document`
    // and closing an unpinned `#WorldInfo` drawer!
    containerEl.addEventListener('click', (ev) => {
        ev.stopPropagation();
    });

    const popoverScrollHost = getScrollHost();
    const restoreTimers = [];
    const cancelRestore = () => {
        isRestoringScroll = false;
        while (restoreTimers.length) clearTimeout(restoreTimers.pop());
    };
    const savePopoverScroll = () => {
        const host = getScrollHost();
        if (!isSearching() && host.isConnected && host.clientHeight > 0) {
            _dropdownMemory.scrollTopByGroup[activePillGroupId] = host.scrollTop;
        }
        if (pillScrollEl && pillScrollEl.isConnected && pillScrollEl.clientWidth > 0) {
            _dropdownMemory.pillBarScrollLeft = pillScrollEl.scrollLeft;
        }
    };

    // Listen on BOTH optionsHost and discovered scrollHost (and containerEl) in case popover layout settles lazily
    const scrollTargets = new Set([optionsHost, popoverScrollHost, containerEl]);
    for (const st of scrollTargets) {
        st.addEventListener('scroll', () => {
            if (!isRestoringScroll && !isSearching() && st.clientHeight > 0 && st.scrollHeight > st.clientHeight + 2) {
                _dropdownMemory.scrollTopByGroup[activePillGroupId] = st.scrollTop;
            }
        }, { passive: true });
        st.addEventListener('wheel', cancelRestore, { passive: true });
        st.addEventListener('touchmove', cancelRestore, { passive: true });
    }

    // Capture exact scroll position right before clicking an option closes the popover
    const onGrOptionPointerDown = (ev) => {
        if (ev.target instanceof Element && ev.target.closest('.gr-option')) {
            cancelRestore();
            savePopoverScroll();
        }
    };
    optionsHost.addEventListener('pointerdown', onGrOptionPointerDown, true);
    optionsHost.addEventListener('mousedown', onGrOptionPointerDown, true);

    if (searchInput instanceof HTMLInputElement) {
        searchInput.addEventListener('input', () => {
            cancelRestore();
            requestAnimationFrame(syncSections);
        });
    }

    syncSections();
    const applyPopoverScroll = () => {
        if (!isRestoringScroll) return;
        if (pillScrollEl && pillScrollEl.clientWidth > 0) {
            pillScrollEl.scrollLeft = _dropdownMemory.pillBarScrollLeft;
        }
        const savedTop = _dropdownMemory.scrollTopByGroup[activePillGroupId];
        if (typeof savedTop === 'number' && savedTop > 0) {
            const host = getScrollHost();
            if (host.clientHeight > 0) {
                host.scrollTop = savedTop;
            }
        }
    };
    applyPopoverScroll();
    requestAnimationFrame(applyPopoverScroll);
    restoreTimers.push(
        setTimeout(applyPopoverScroll, 35),
        setTimeout(applyPopoverScroll, 110),
        setTimeout(() => {
            applyPopoverScroll();
            isRestoringScroll = false;
        }, 210),
    );
}

/**
 * Install lightweight observers on `#world_info`, `#world_editor_select`, and
 * `.character_world` popups so upstream `updateWorldInfoList()` refreshes keep
 * filtering intact without any polling!
 *
 * @param {() => void} onUpstreamWorldListChanged
 */
export function startNativeObservers(onUpstreamWorldListChanged) {
    stopNativeObservers();

    const scheduleResync = () => {
        if (_isApplying) return;
        _lastGlobalSignature = null;
        _lastEditorSignature = null;
        clearTimeout(_resyncTimer);
        _resyncTimer = setTimeout(() => {
            if (_isApplying) return;
            onUpstreamWorldListChanged?.();
        }, 180);
    };

    const globalEl = document.getElementById('world_info');
    if (globalEl) {
        _globalSelectObserver = new MutationObserver(scheduleResync);
        // Observe direct childList ONLY (zero subtree cost)
        _globalSelectObserver.observe(globalEl, { childList: true, subtree: false });
    }

    const editorEl = document.getElementById('world_editor_select');
    if (editorEl) {
        _editorSelectObserver = new MutationObserver(scheduleResync);
        _editorSelectObserver.observe(editorEl, { childList: true, subtree: false });

        // Native mobile `<select>` fallback: ensure optgroups right before opening
        _editorNativeOpenHandler = () => {
            if (isNativeMobileSelectMode()) {
                syncEditorBeforeOpen();
            }
        };
        editorEl.addEventListener('mousedown', _editorNativeOpenHandler);
        editorEl.addEventListener('focus', _editorNativeOpenHandler);
    }

    // Desktop Select2:
    // 1. On `select2:opening` (window level), assert our `<optgroup>`s right before render.
    // 2. On `select2:open`, attach collapsible group headers + in-dropdown group filter bar.
    // 3. On `select2:close`, clean up temporary dropdown listeners/bar immediately.
    const $ = globalThis.jQuery;
    if ($) {
        _editorSelect2OpeningHandler = (ev) => {
            if (ev?.target?.id === 'world_editor_select') {
                syncEditorBeforeOpen();
            }
        };
        _editorSelect2OpenHandler = (ev) => {
            if (ev?.target?.id === 'world_editor_select') {
                requestAnimationFrame(enhanceOpenEditorDropdown);
            }
        };
        _editorSelect2CloseHandler = (ev) => {
            if (ev?.target?.id === 'world_editor_select') {
                cleanupOpenEditorDropdown();
            }
        };
        $(window).on('select2:opening.wboEditorOpen', _editorSelect2OpeningHandler);
        $(window).on('select2:open.wboEditorOpen', _editorSelect2OpenHandler);
        $(window).on('select2:close.wboEditorOpen', _editorSelect2CloseHandler);
    }

    // Pre-attach hidden character/chat worldbooks synchronously in CAPTURE phase BEFORE
    // SillyTavern's `#world_button` or `.chat_lorebook_button` click handler calls
    // `openWorldInfoEditor(worldName)` -> `$('#world_editor_select').val(idx).trigger('change')`!
    _docWorldJumpPreAttach = (ev) => {
        const t = ev.target instanceof Element ? ev.target : null;
        if (!t || ev.shiftKey || ev.altKey) return;

        if (t.closest('#world_button')) {
            const ctx = getHostContext();
            const $ = globalThis.jQuery;
            const chid = $ ? $('#set_character_world').data('chid') : undefined;
            const ch = chid !== undefined && chid !== -1 ? ctx?.characters?.[chid] : null;
            const charWorldInput = document.getElementById('character_world');
            const worldName =
                ch?.data?.extensions?.world ||
                (charWorldInput instanceof HTMLInputElement ? charWorldInput.value : '') ||
                (ch?.avatar ? _latestSettings?.cachedCharBindings?.[ch.avatar]?.primary : '') ||
                '';
            if (worldName) {
                ensureEditorOptionAttached(worldName);
            }
            return;
        }

        if (t.closest('.chat_lorebook_button')) {
            const ctx = getHostContext();
            const chatWorld = ctx?.chatMetadata?.world_info || '';
            if (chatWorld) {
                ensureEditorOptionAttached(chatWorld);
            }
            return;
        }

        if (t.closest('#persona_lore_button')) {
            const pu = getPowerUserSettings();
            const personaWorld = pu?.persona_description_lorebook || '';
            if (personaWorld) {
                ensureEditorOptionAttached(personaWorld);
            }
        }
    };
    document.addEventListener('click', _docWorldJumpPreAttach, true);

    // Guard against SillyTavern's `$(document).on('click')` unpinned-drawer auto-closer
    // firing when opening `#world_editor_select` / `#world_info` spawns a body-mounted
    // Select2 dropdown or custom popover directly under the pointer between pointerdown & click!
    _docDrawerGuardMouseDown = (ev) => {
        const t = ev.target instanceof Element ? ev.target : null;
        if (!t) return;
        const inWorldSelect = Boolean(
            t.closest('#world_editor_select, #world_info, #world_popup .select2-container, #WIMultiSelector .select2-container, #WorldInfo .select2-container, #WorldInfo .gr-select2-display, .select2-dropdown, #gr-global-dropdown-container, .gr-container-enhanced'),
        );
        if (inWorldSelect) {
            _lastWorldSelectMouseDownAt = Date.now();
        }
    };
    _docDrawerGuardClick = (ev) => {
        const wiDrawer = document.getElementById('WorldInfo');
        if (!wiDrawer || wiDrawer.classList.contains('closedDrawer')) return;
        const t = ev.target instanceof Element ? ev.target : null;
        if (!t) return;
        if (t.closest?.('.drawer-icon')) return;
        const inDropdownOverlay = Boolean(
            t.closest?.('.select2-dropdown, #gr-global-dropdown-container, .gr-container-enhanced'),
        );
        const isRecentOrphanClick =
            Date.now() - _lastWorldSelectMouseDownAt < 500 &&
            (t === document.body || t === document.documentElement || !t.isConnected);
        if (inDropdownOverlay || isRecentOrphanClick) {
            ev.stopPropagation();
        }
    };
    document.addEventListener('pointerdown', _docDrawerGuardMouseDown, true);
    document.addEventListener('mousedown', _docDrawerGuardMouseDown, true);
    // Attach on `document.body` in BUBBLE phase (fires AFTER all dropdown inner buttons/options,
    // and strictly BEFORE SillyTavern's `$(document).on('click')` unpinned-drawer auto-closer!).
    document.body.addEventListener('click', _docDrawerGuardClick);

    // Lightweight popup observer: inspects only newly added top-level dialog/popup/custom-dropdown nodes
    _charPopupObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (!(node instanceof HTMLElement)) continue;
                if (node.id === 'gr-global-dropdown-container' || node.classList.contains('gr-container-enhanced')) {
                    // Zero overhead in hide-only mode (when no custom groups & char books hidden)
                    const needsPopoverGrouping =
                        (_latestClassification?.customGroups?.length || 0) > 0 ||
                        Boolean(_latestSettings?.showCharBooks);
                    if (needsPopoverGrouping) {
                        requestAnimationFrame(() => enhanceCustomDropdownPopover(node));
                    }
                } else if (node.classList.contains('character_world')) {
                    enhanceCharBindPopup(node);
                } else if (node.classList.contains('persona_world')) {
                    const sel = node.querySelector('.persona_world_info_selector');
                    if (sel instanceof HTMLSelectElement) {
                        enhanceStandardWorldSelectPopup(node, sel, { settingKey: 'adaptPersonaBindPopup' });
                    }
                } else if (node.classList.contains('chat_world')) {
                    const sel = node.querySelector('.chat_world_info_selector');
                    if (sel instanceof HTMLSelectElement) {
                        enhanceStandardWorldSelectPopup(node, sel, { settingKey: 'adaptChatBindPopup' });
                    }
                } else if (node.tagName === 'DIALOG' || node.classList.contains('popup') || node.id === 'dialogue_popup') {
                    const cw = node.querySelector('.character_world');
                    if (cw instanceof HTMLElement) enhanceCharBindPopup(cw);
                    const pw = node.querySelector('.persona_world');
                    const pwSel = pw?.querySelector('.persona_world_info_selector');
                    if (pw instanceof HTMLElement && pwSel instanceof HTMLSelectElement) {
                        enhanceStandardWorldSelectPopup(pw, pwSel, { settingKey: 'adaptPersonaBindPopup' });
                    }
                    const chatW = node.querySelector('.chat_world');
                    const chatSel = chatW?.querySelector('.chat_world_info_selector');
                    if (chatW instanceof HTMLElement && chatSel instanceof HTMLSelectElement) {
                        enhanceStandardWorldSelectPopup(chatW, chatSel, { settingKey: 'adaptChatBindPopup' });
                    }
                    const moveSel = node.querySelector('#move_entry_target_select');
                    if (moveSel instanceof HTMLSelectElement) {
                        enhanceStandardWorldSelectPopup(node, moveSel, { settingKey: 'adaptMoveEntryPopup' });
                    }
                }
            }
        }
    });
    _charPopupObserver.observe(document.body, { childList: true, subtree: false });
}

/**
 * Stop observers cleanly.
 */
export function stopNativeObservers() {
    cleanupOpenEditorDropdown();
    clearTimeout(_resyncTimer);
    _resyncTimer = null;
    if (_globalSelectObserver) {
        _globalSelectObserver.disconnect();
        _globalSelectObserver = null;
    }
    if (_editorSelectObserver) {
        _editorSelectObserver.disconnect();
        _editorSelectObserver = null;
    }
    if (_charPopupObserver) {
        _charPopupObserver.disconnect();
        _charPopupObserver = null;
    }
    if (_editorNativeOpenHandler) {
        const editorEl = document.getElementById('world_editor_select');
        if (editorEl) {
            editorEl.removeEventListener('mousedown', _editorNativeOpenHandler);
            editorEl.removeEventListener('focus', _editorNativeOpenHandler);
        }
        _editorNativeOpenHandler = null;
    }
    if (_docWorldJumpPreAttach) {
        document.removeEventListener('click', _docWorldJumpPreAttach, true);
        _docWorldJumpPreAttach = null;
    }
    if (_docDrawerGuardMouseDown) {
        document.removeEventListener('pointerdown', _docDrawerGuardMouseDown, true);
        document.removeEventListener('mousedown', _docDrawerGuardMouseDown, true);
        _docDrawerGuardMouseDown = null;
    }
    if (_docDrawerGuardClick) {
        document.body.removeEventListener('click', _docDrawerGuardClick);
        _docDrawerGuardClick = null;
    }
    if (globalThis.jQuery) {
        if (_editorSelect2OpeningHandler) {
            globalThis.jQuery(window).off('select2:opening.wboEditorOpen', _editorSelect2OpeningHandler);
            _editorSelect2OpeningHandler = null;
        }
        if (_editorSelect2OpenHandler) {
            globalThis.jQuery(window).off('select2:open.wboEditorOpen', _editorSelect2OpenHandler);
            _editorSelect2OpenHandler = null;
        }
        if (_editorSelect2CloseHandler) {
            globalThis.jQuery(window).off('select2:close.wboEditorOpen', _editorSelect2CloseHandler);
            _editorSelect2CloseHandler = null;
        }
    }
}

/**
 * Fully restore native `#world_info` and `#world_editor_select` to untouched state
 * (used on extension disable / clean).
 */
export function teardownNativeFilters() {
    stopNativeObservers();
    _lastGlobalSignature = null;
    _lastEditorSignature = null;
    _isApplying = true;
    try {
        const $ = globalThis.jQuery;
        for (const [id, detachedMap] of [
            ['world_info', _globalDetachedMap],
            ['world_editor_select', _editorDetachedMap],
        ]) {
            const sel = document.getElementById(id);
            if (!sel) continue;
            delete sel.dataset.wboS2Ready;
            const $sel = $ ? $(sel) : null;
            const hadS2 = Boolean($sel && ($sel.data('select2') || $sel.hasClass('select2-hidden-accessible')));
            if (hadS2) {
                try { $sel.select2('destroy'); } catch { /* ignore */ }
            }
            restoreSelectOptions(sel, detachedMap);
            const placeholders = [];
            const rest = [];
            for (const opt of Array.from(sel.querySelectorAll('option'))) {
                if (opt.value === '') placeholders.push(opt);
                else rest.push(opt);
            }
            sortByNativeValue(rest);
            for (const opt of [...placeholders, ...rest]) sel.appendChild(opt);

            if (hadS2 && $sel) {
                try {
                    if (id === 'world_info') {
                        $sel.select2({
                            width: '100%',
                            placeholder: 'No Worlds active. Click here to select.',
                            allowClear: true,
                            closeOnSelect: false,
                        });
                    } else {
                        $sel.select2({
                            placeholder: '--- Pick to Edit ---',
                            allowClear: true,
                            closeOnSelect: true,
                            multiple: false,
                        });
                    }
                } catch { /* ignore */ }
            }
        }
        document.querySelectorAll('.wbo-charpopup-bar').forEach((el) => el.remove());
        document.getElementById(MOBILE_TRIGGER_ID)?.remove();
        document.getElementById(MOBILE_PICKER_OVERLAY_ID)?.remove();
        document.getElementById('world_editor_select')?.classList.remove('wbo-mobile-select-hidden');
    } finally {
        _isApplying = false;
    }
}
