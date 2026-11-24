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
import { getCurrentCharacterAvatar, saveSettings } from './host.js';

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
    if (!_latestSettings.dropdownCollapsed || typeof _latestSettings.dropdownCollapsed !== 'object') {
        _latestSettings.dropdownCollapsed = {};
    }

    let activePillGroupId = SPECIAL_GROUPS.ALL;
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
            if (head instanceof HTMLElement) {
                head.classList.add('wbo-dd-group-head');
                head.setAttribute('data-wbo-dd-group', gid);
                head.setAttribute('title', '点击展开或折叠该分组');
            }

            // Filter visibility when user picked a single group pill inside the dropdown
            const hiddenByPill = !searching && activePillGroupId !== SPECIAL_GROUPS.ALL && gid !== activePillGroupId;
            li.classList.toggle('wbo-dd-group-hidden', hiddenByPill);

            // Auto-expand while searching OR when isolated via filter pill
            const isCollapsed = !searching && activePillGroupId === SPECIAL_GROUPS.ALL && Boolean(_latestSettings.dropdownCollapsed[gid]);
            li.classList.toggle('wbo-dd-collapsed', isCollapsed);
        });
    };

    // Delegate mousedown/click on group headers to fold/unfold without closing Select2!
    const onResultsMouseDown = (ev) => {
        const head = ev.target instanceof Element ? ev.target.closest('.wbo-dd-group-head') : null;
        if (!head) return;
        ev.preventDefault();
        ev.stopPropagation();
        const gid = head.getAttribute('data-wbo-dd-group');
        if (!gid) return;
        if (activePillGroupId !== SPECIAL_GROUPS.ALL) {
            // If isolated to one group, clicking its header folds/unfolds via returning to ALL
            activePillGroupId = SPECIAL_GROUPS.ALL;
            syncPillButtons();
        }
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
    const syncPillButtons = () => {
        if (!filterBar) return;
        filterBar.querySelectorAll('.wbo-dd-pill').forEach((btn) => {
            const gid = btn.getAttribute('data-wbo-pill');
            btn.classList.toggle('is-active', gid === activePillGroupId);
        });
    };

    if (groups.length >= 2) {
        filterBar = document.createElement('div');
        filterBar.className = 'wbo-dd-filter-bar';
        const pillItems = [
            { id: SPECIAL_GROUPS.ALL, label: '全部' },
            ...groups.map((g) => ({ id: g.id, label: `${g.shortName} ${g.count}` })),
        ];
        filterBar.innerHTML = pillItems
            .map((p) => `<button type="button" class="wbo-dd-pill${p.id === activePillGroupId ? ' is-active' : ''}" data-wbo-pill="${escHtml(p.id)}">${escHtml(p.label)}</button>`)
            .join('');

        // Keep dropdown open and search intact when tapping a pill
        filterBar.addEventListener('mousedown', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
        });
        filterBar.addEventListener('click', (ev) => {
            const btn = ev.target instanceof Element ? ev.target.closest('.wbo-dd-pill') : null;
            if (!btn) return;
            ev.preventDefault();
            ev.stopPropagation();
            const gid = btn.getAttribute('data-wbo-pill') || SPECIAL_GROUPS.ALL;
            activePillGroupId = (gid === activePillGroupId && gid !== SPECIAL_GROUPS.ALL)
                ? SPECIAL_GROUPS.ALL
                : gid;
            syncPillButtons();
            decorateGroupItems();
            resultsList.scrollTop = 0;
        });

        const resultsWrap = dropdownEl.querySelector('.select2-results');
        if (resultsWrap && resultsWrap.parentElement) {
            resultsWrap.parentElement.insertBefore(filterBar, resultsWrap);
        }
    }

    const onSearchInput = () => {
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

    _openDropdownCleanup = () => {
        resultsList.removeEventListener('mousedown', onResultsMouseDown, true);
        resultsList.removeEventListener('click', onResultsClick, true);
        if (searchInput instanceof HTMLInputElement) {
            searchInput.removeEventListener('input', onSearchInput);
        }
        filterBar?.remove();
    };

    decorateGroupItems();
}

/**
 * Synchronously assert our custom `<optgroup>`s on `#world_editor_select` right
 * before the dropdown opens (beats any capture-phase or document-level handlers
 * that may have reorganized `<optgroup>`s on pointerdown/opening).
 */
function syncEditorBeforeOpen() {
    if (_isApplying || !_latestClassification || !_latestSettings) return;
    _isApplying = true;
    try {
        _lastEditorSignature = null;
        applyEditorWorldSelectFilter(_latestClassification, _latestSettings);
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
    if (orderedSections.length === 0) return;

    // Remove flat default labels before inserting our grouped sections
    optionsHost.querySelectorAll(':scope > .gr-group-label').forEach((el) => el.remove());

    for (const ph of placeholders) {
        optionsHost.appendChild(ph);
    }

    let activePillGroupId = SPECIAL_GROUPS.ALL;
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
    const syncPillButtons = () => {
        if (!filterBar) return;
        filterBar.querySelectorAll('.wbo-dd-pill').forEach((btn) => {
            btn.classList.toggle('is-active', btn.getAttribute('data-wbo-pill') === activePillGroupId);
        });
    };

    const syncSections = () => {
        const searching = isSearching();
        for (const secEl of sectionEls) {
            const gid = secEl.getAttribute('data-wbo-dd-group') || '';
            if (searching) {
                const hasVisibleChild = Array.from(secEl.querySelectorAll('.gr-option')).some(
                    (o) => o instanceof HTMLElement && o.style.display !== 'none',
                );
                secEl.classList.toggle('wbo-dd-group-hidden', !hasVisibleChild);
                secEl.classList.remove('wbo-dd-collapsed');
            } else {
                const hiddenByPill = activePillGroupId !== SPECIAL_GROUPS.ALL && gid !== activePillGroupId;
                secEl.classList.toggle('wbo-dd-group-hidden', hiddenByPill);
                const collapsed = activePillGroupId === SPECIAL_GROUPS.ALL && Boolean(_latestSettings.dropdownCollapsed[gid]);
                secEl.classList.toggle('wbo-dd-collapsed', collapsed);
            }
        }
    };

    optionsHost.addEventListener('mousedown', (ev) => {
        const head = ev.target instanceof Element ? ev.target.closest('.wbo-dd-group-head') : null;
        if (!head) return;
        ev.preventDefault();
        ev.stopPropagation();
        const gid = head.getAttribute('data-wbo-dd-group');
        if (!gid) return;
        if (activePillGroupId !== SPECIAL_GROUPS.ALL) {
            activePillGroupId = SPECIAL_GROUPS.ALL;
            syncPillButtons();
        }
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
        filterBar = document.createElement('div');
        filterBar.className = 'wbo-dd-filter-bar wbo-gr-filter-bar';
        const pillItems = [
            { id: SPECIAL_GROUPS.ALL, label: '全部' },
            ...orderedSections.map((sec) => ({
                id: sec.id,
                label: `${sec.name} ${(bucketByGroup.get(sec.id) || []).length}`,
            })),
        ];
        filterBar.innerHTML = pillItems
            .map((p) => `<button type="button" class="wbo-dd-pill${p.id === activePillGroupId ? ' is-active' : ''}" data-wbo-pill="${escHtml(p.id)}">${escHtml(p.label)}</button>`)
            .join('');

        for (const evtName of ['mousedown', 'touchstart']) {
            filterBar.addEventListener(evtName, (ev) => {
                ev.stopPropagation();
            });
        }
        filterBar.addEventListener('click', (ev) => {
            const btn = ev.target instanceof Element ? ev.target.closest('.wbo-dd-pill') : null;
            if (!btn) return;
            ev.preventDefault();
            ev.stopPropagation();
            const gid = btn.getAttribute('data-wbo-pill') || SPECIAL_GROUPS.ALL;
            activePillGroupId = (gid === activePillGroupId && gid !== SPECIAL_GROUPS.ALL)
                ? SPECIAL_GROUPS.ALL
                : gid;
            syncPillButtons();
            syncSections();
            optionsHost.scrollTop = 0;
        });

        optionsHost.parentElement?.insertBefore(filterBar, optionsHost);
    }

    if (searchInput instanceof HTMLInputElement) {
        searchInput.addEventListener('input', () => {
            requestAnimationFrame(syncSections);
        });
    }

    syncSections();
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

    // Lightweight popup observer: inspects only newly added top-level dialog/popup/custom-dropdown nodes
    _charPopupObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (!(node instanceof HTMLElement)) continue;
                if (node.id === 'gr-global-dropdown-container' || node.classList.contains('gr-container-enhanced')) {
                    requestAnimationFrame(() => enhanceCustomDropdownPopover(node));
                } else if (node.classList.contains('character_world')) {
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
    } finally {
        _isApplying = false;
    }
}
