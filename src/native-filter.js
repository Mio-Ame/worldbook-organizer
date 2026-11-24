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
    matchesSearch,
} from './core.js';
import { getCurrentCharacterAvatar } from './host.js';

/** @type {Map<string, HTMLOptionElement>} */
const _globalDetachedMap = new Map();
/** @type {Map<string, HTMLOptionElement>} */
const _editorDetachedMap = new Map();

let _isApplying = false;
let _latestClassification = null;
let _latestSettings = null;
let _currentlyEditingWorld = null;
let _mobileSearchQuery = '';
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

/**
 * Set optional search query for native mobile `<select>` controls that lack Select2 search.
 * @param {string} query
 */
export function setMobileSearchFilter(query) {
    const clean = String(query ?? '').trim();
    if (clean === _mobileSearchQuery) return;
    _mobileSearchQuery = clean;
    if (_latestClassification && _latestSettings && isNativeMobileSelectMode()) {
        applyAllNativeWorldFilters(_latestClassification, _latestSettings);
    }
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

    const groupBadge = showGroupPill
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
 * Safe because upstream reads `<option>` text/value, never the rendered span.
 * @param {any} state
 */
function renderEditorSelect2Selection(state) {
    if (!state.id) return state.text;
    const realName = String(state.text ?? '').trim();
    const meta = _latestClassification?.byName?.get(realName);
    if (!meta) return state.text;

    const $ = globalThis.jQuery;
    if (!$) return meta.primaryTitle;

    const subHtml = meta.subtitle
        ? ` <span class="wbo-s2-sel-sub">(${escHtml(meta.subtitle)})</span>`
        : '';
    return $(`<span class="wbo-s2-sel" title="${escHtml(meta.realName)}">${escHtml(meta.primaryTitle)}${subHtml}</span>`);
}

/**
 * Restore all detached options back into a `<select>` and unwrap ALL `<optgroup>`s
 * (including any leftover empty optgroups from other extensions like ST-BaiBai-Tools)
 * so ghost empty group headers never remain.
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
 * Re-attach click-to-open-editor on `#world_info` Select2 chips after Select2 re-init.
 * Matches upstream behavior without losing quick editing.
 * @param {any} $select
 */
function bindGlobalSelect2ChipClick($select) {
    const $container = $select.next('.select2-container');
    if (!$container.length) return;
    $container.off('click.wboChip').on('click.wboChip', '.select2-selection__choice', (ev) => {
        // Ignore clicks on the remove "×" button
        if (ev.target && ev.target.closest('.select2-selection__choice__remove')) return;
        const choiceEl = ev.currentTarget;
        const rawTitle = choiceEl.getAttribute('title') || choiceEl.textContent || '';
        const worldName = rawTitle.replace(/^×\s*/, '').trim();
        if (!worldName) return;
        openWorldInNativeEditor(worldName);
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

    return JSON.stringify([
        mode,
        settings.activeFilterGroupId,
        Boolean(settings.showCharBooks),
        Boolean(settings.showNativeOptgroups),
        settings.charBookTitleMode,
        settings.aliasTitleMode,
        mode === 'editor' ? _currentlyEditingWorld : '',
        isNativeMobileSelectMode() ? _mobileSearchQuery : '',
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
            activeFilterGroupId: settings.activeFilterGroupId,
            showCharBooks: Boolean(settings.showCharBooks),
            isSelected: opt.selected,
            isCurrentlyEditing: false,
        }) && (opt.selected || hasSelect2 || !_mobileSearchQuery || matchesSearch(meta || { realName }, _mobileSearchQuery));

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
function applyEditorWorldSelectFilter(classification, settings) {
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
            activeFilterGroupId: settings.activeFilterGroupId,
            showCharBooks: Boolean(settings.showCharBooks),
            isSelected: opt.selected,
            isCurrentlyEditing: isEditing,
        }) && (isEditing || hasSelect2 || !_mobileSearchQuery || matchesSearch(meta || { realName }, _mobileSearchQuery));

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
    const useOptgroups = Boolean(settings.showNativeOptgroups) && nonEmptySections.length > 0;

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
            dropdownCssClass: 'wbo-editor-s2-dropdown',
            matcher: customSelect2Matcher,
            templateResult: (state) => renderSelect2OptionResult(state, { showGroupPill: false }),
            templateSelection: renderEditorSelect2Selection,
        });
        if (patched) {
            selectEl.dataset.wboS2Ready = '1';
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
 * Programmatically open a worldbook in the native editor — even if it belongs to
 * the currently hidden character group!
 * @param {string} realName
 * @returns {boolean}
 */
export function openWorldInNativeEditor(realName) {
    const clean = String(realName ?? '').trim();
    if (!clean) return false;
    setCurrentlyEditingWorld(clean);

    // Ensure the option is attached in `#world_editor_select`
    if (_editorDetachedMap.has(clean) && _latestClassification && _latestSettings) {
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
    targetOpt.selected = Boolean(active);

    const $ = globalThis.jQuery;
    if ($) {
        $(selectEl).trigger('change');
    } else {
        selectEl.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // Re-apply filter so deactivating a hidden character book hides it again cleanly
    if (!active && _latestClassification && _latestSettings) {
        setTimeout(() => {
            if (_latestClassification && _latestSettings) {
                applyAllNativeWorldFilters(_latestClassification, _latestSettings);
            }
        }, 0);
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
    charWorldEl.dataset.wboEnhanced = '1';

    const primarySelect = charWorldEl.querySelector('.character_world_info_selector');
    const extrasSelect = charWorldEl.querySelector('.character_extra_world_info_selector');
    if (!primarySelect && !extrasSelect) return;

    const currentAvatar = getCurrentCharacterAvatar();
    let hideOthers = Boolean(_latestSettings.autoHideInCharBindPopup);
    let filterGroupId = SPECIAL_GROUPS.DEFAULT;

    /** @type {Map<HTMLSelectElement, Map<string, HTMLOptionElement>>} */
    const popupDetached = new Map();
    if (primarySelect) popupDetached.set(primarySelect, new Map());
    if (extrasSelect) popupDetached.set(extrasSelect, new Map());

    const bar = document.createElement('div');
    bar.className = 'wbo-charpopup-bar';

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'menu_button wbo-btn-compact';

    const groupSelect = document.createElement('select');
    groupSelect.className = 'text_pole wbo-charpopup-select';
    groupSelect.title = '按分组筛选世界书';

    const populateGroupOptions = () => {
        groupSelect.innerHTML = '';
        const items = [
            { id: SPECIAL_GROUPS.DEFAULT, label: '默认（排除其他角色书）' },
            { id: SPECIAL_GROUPS.ALL, label: '显示全部世界书' },
            ..._latestClassification.customGroups.map((g) => ({ id: g.id, label: `分组：${g.name}` })),
            { id: SPECIAL_GROUPS.UNGROUPED, label: '仅未分组' },
            { id: SPECIAL_GROUPS.CHARACTER, label: '仅角色世界书' },
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
        let hiddenCount = 0;
        const targets = [primarySelect, extrasSelect].filter(Boolean);
        const $ = globalThis.jQuery;

        for (const sel of targets) {
            const detached = popupDetached.get(sel);
            const $sel = $ ? $(sel) : null;
            const hadS2 = Boolean($sel && ($sel.data('select2') || $sel.hasClass('select2-hidden-accessible')));
            if (hadS2) {
                try { $sel.select2('destroy'); } catch { /* ignore */ }
            }

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
                    if (sel === primarySelect) hiddenCount += 1;
                }
            }

            sortByNativeValue(visible);
            for (const opt of [...placeholders, ...visible]) {
                sel.appendChild(opt);
            }

            if (hadS2 && $sel) {
                try {
                    $sel.select2({
                        width: '100%',
                        allowClear: true,
                        closeOnSelect: !sel.multiple,
                        matcher: customSelect2Matcher,
                        templateResult: (state) => renderSelect2OptionResult(state, { showGroupPill: true }),
                    });
                } catch { /* ignore */ }
            }
        }

        toggleBtn.innerHTML = hideOthers
            ? `<i class="fa-solid fa-eye-slash"></i> 已隐藏其他角色书${hiddenCount > 0 ? ` (${hiddenCount})` : ''}`
            : `<i class="fa-solid fa-eye"></i> 显示全部角色书`;
        toggleBtn.classList.toggle('wbo-btn-active', hideOthers);
    };

    toggleBtn.addEventListener('click', () => {
        hideOthers = !hideOthers;
        if (!hideOthers && filterGroupId === SPECIAL_GROUPS.DEFAULT) {
            filterGroupId = SPECIAL_GROUPS.ALL;
            groupSelect.value = SPECIAL_GROUPS.ALL;
        } else if (hideOthers && filterGroupId === SPECIAL_GROUPS.ALL) {
            filterGroupId = SPECIAL_GROUPS.DEFAULT;
            groupSelect.value = SPECIAL_GROUPS.DEFAULT;
        }
        applyPopupFilter();
    });

    groupSelect.addEventListener('change', () => {
        filterGroupId = groupSelect.value;
        hideOthers = filterGroupId === SPECIAL_GROUPS.DEFAULT;
        applyPopupFilter();
    });

    populateGroupOptions();
    bar.append(toggleBtn, groupSelect);
    charWorldEl.prepend(bar);

    // Let upstream Select2 finish initializing if it runs right after DOM insertion
    setTimeout(applyPopupFilter, 60);
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
    }

    // Lightweight popup observer: inspects only newly added top-level dialog/popup nodes
    _charPopupObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (!(node instanceof HTMLElement)) continue;
                if (node.classList.contains('character_world')) {
                    enhanceCharBindPopup(node);
                } else if (node.tagName === 'DIALOG' || node.classList.contains('popup') || node.id === 'dialogue_popup') {
                    const cw = node.querySelector('.character_world');
                    if (cw instanceof HTMLElement) enhanceCharBindPopup(cw);
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
    } finally {
        _isApplying = false;
    }
}
