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
    compareZhCn,
    isBookVisibleInCharBindPopup,
    isBookVisibleInSelector,
    orderSectionsForExternalDropdown,
    togglePinnedBook,
} from './core.js';
import { getCurrentCharacterAvatar, getCurrentEditorWorldName, getHostContext, getPowerUserSettings, getWorldNames, saveSettings } from './host.js';
import { scrollContentToItem, scrollNativeWorldEntry } from './content-scroll.js';
import { revealNativeEntryGroup } from './entry-groups/native-view.js';

/** @type {WeakMap<HTMLElement, () => void>} */
const _bubbleGuardCleanupMap = new WeakMap();

/**
 * Prevent `mousedown`, `touchstart`, and `click` events inside floating popovers/sheets
 * from bubbling to `document.documentElement` (`<html>`) and collapsing ST `.openDrawer`s.
 * Always bubble phase (`false`).
 * @param {HTMLElement | null} rootEl
 */
function bindDrawerSafeBubbleGuard(rootEl) {
    if (!(rootEl instanceof HTMLElement) || rootEl.dataset.wboBubbleGuarded === '1') return;
    rootEl.dataset.wboBubbleGuarded = '1';
    const stopBubble = (ev) => ev.stopPropagation();
    rootEl.addEventListener('mousedown', stopBubble, false);
    rootEl.addEventListener('touchstart', stopBubble, { capture: false, passive: true });
    rootEl.addEventListener('click', stopBubble, false);
    _bubbleGuardCleanupMap.set(rootEl, () => {
        rootEl.removeEventListener('mousedown', stopBubble, false);
        rootEl.removeEventListener('touchstart', stopBubble, false);
        rootEl.removeEventListener('click', stopBubble, false);
    });
}

/**
 * Cleanly remove the bubble guard from a reused container if it is repurposed
 * for a non-worldbook `<select>` (such as `#world_info_sort_order`).
 * @param {HTMLElement | null} rootEl
 */
function unbindDrawerSafeBubbleGuard(rootEl) {
    if (!(rootEl instanceof HTMLElement)) return;
    const cleanup = _bubbleGuardCleanupMap.get(rootEl);
    if (cleanup) {
        try { cleanup(); } catch { /* ignore */ }
        _bubbleGuardCleanupMap.delete(rootEl);
    }
    delete rootEl.dataset.wboBubbleGuarded;
}

let _pinDirtyOnClose = false;
/** @type {Set<() => void>} */
const _openCustomPickerClosers = new Set();
/** @type {(() => void) | null} */
let _closeMobileEditorPicker = null;

function flushPinDirtyOnClose() {
    if (_pinDirtyOnClose && _latestSettings && _latestClassification) {
        _pinDirtyOnClose = false;
        applyAllNativeWorldFilters(_latestClassification, _latestSettings);
    }
}

/**
 * Close any open SillyTavern / plugin worldbook dropdowns (Select2, mobile picker,
 * popup grouped picker, or external custom popovers) so they never overlap or block
 * another selector when switching focus.
 * @param {{ except?: 'global' | 'editor' | null }} [opts]
 */
export function closeAllOpenWorldDropdowns({ except = null } = {}) {
    const $ = globalThis.jQuery;
    if ($ && except !== 'editor') {
        try {
            const $ed = $('#world_editor_select');
            if ($ed.data('select2')?.isOpen?.()) {
                $ed.select2('close');
            }
        } catch { /* ignore */ }
    }
    if ($ && except !== 'global') {
        try {
            const $gl = $('#world_info');
            if ($gl.data('select2')?.isOpen?.()) {
                $gl.select2('close');
            }
        } catch { /* ignore */ }
    }

    for (const closer of [..._openCustomPickerClosers]) {
        try {
            closer({ except });
        } catch { /* ignore */ }
    }

    if (except !== 'editor') {
        if (_closeMobileEditorPicker) {
            _closeMobileEditorPicker();
        } else {
            document.getElementById(MOBILE_PICKER_OVERLAY_ID)?.remove();
            document.getElementById(MOBILE_TRIGGER_ID)?.classList.remove('is-open');
        }
    }

    if (typeof document !== 'undefined') {
        document.querySelectorAll('#wbo-quick-exclude-backdrop, #wbo-vis-popover-backdrop, #wbo-search-opts-backdrop').forEach((el) => el.remove());

        document.querySelectorAll(ENHANCED_POPOVER_SELECTORS.containerSelector).forEach((el) => {
            if (!(el instanceof HTMLElement) || !el.isConnected) return;
            // Skip persistent containers that are already closed (`display: none`) so they aren't destroyed before opening.
            if (el.hidden || el.style.display === 'none') {
                el.dataset.wboPersistentPopover = '1';
                return;
            }
            const role = detectEnhancedPopoverRole(el);
            // NEVER close, hide, dispatch Escape, or remove non-worldbook popovers (e.g. `#world_info_sort_order`)!
            if (!role) return;
            if (except === role) return;
            const isPersistent = el.dataset.wboPersistentPopover === '1';
            try {
                el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true }));
            } catch { /* ignore */ }
            if (el.isConnected && !el.hidden && el.style.display !== 'none') {
                el.style.display = 'none';
                if (!isPersistent) {
                    el.remove();
                }
            }
        });
    }
}

/**
 * Toggle pin status for a worldbook directly from any native dropdown/sheet/popover
 * without rebuilding or closing the currently open dropdown.
 * @param {string} worldName
 * @returns {boolean} new pinned state
 */
function toggleWorldPinFromNative(worldName) {
    const clean = String(worldName ?? '').trim();
    if (!clean || !_latestSettings) return false;
    const isPinnedNow = togglePinnedBook(_latestSettings, clean);
    if (_latestClassification?.byName) {
        const meta = _latestClassification.byName.get(clean);
        if (meta) meta.isPinned = isPinnedNow;
        const pinnedBooks = [];
        for (const m of _latestClassification.byName.values()) {
            if (m.isPinned) pinnedBooks.push(m);
        }
        pinnedBooks.sort((a, b) => compareZhCn(a.primaryTitle || a.realName, b.primaryTitle || b.realName));
        _latestClassification.pinnedBooks = pinnedBooks;
        _latestClassification.pinnedCount = pinnedBooks.length;
    }
    _pinDirtyOnClose = true;
    _lastGlobalSignature = null;
    _lastEditorSignature = null;
    saveSettings();
    try {
        if (typeof window !== 'undefined' && typeof CustomEvent === 'function') {
            window.dispatchEvent(new CustomEvent('wbo:pin-changed', { detail: { worldName: clean, isPinned: isPinnedNow } }));
        }
    } catch { /* ignore */ }
    return isPinnedNow;
}

/**
 * Bind capture-phase handlers on a Select2 `.select2-results__options` container so clicking
 * `.wbo-s2-pin-btn` toggles pin in place WITHOUT selecting the row or closing Select2.
 * @param {HTMLElement} resultsList
 * @param {(info: { worldName: string, isPinned: boolean }) => void} [onAfterToggle]
 * @returns {() => void}
 */
function bindSelect2PinHandlers(resultsList, onAfterToggle = null) {
    const onPointerBlock = (ev) => {
        const pinBtn = ev.target instanceof Element ? ev.target.closest('.wbo-s2-pin-btn') : null;
        if (!pinBtn) return;
        ev.preventDefault();
        ev.stopPropagation();
        ev.stopImmediatePropagation();
    };
    const onPinClick = (ev) => {
        const pinBtn = ev.target instanceof Element ? ev.target.closest('.wbo-s2-pin-btn') : null;
        if (!pinBtn) return;
        ev.preventDefault();
        ev.stopPropagation();
        ev.stopImmediatePropagation();
        const worldName = pinBtn.getAttribute('data-pin-world') || '';
        if (!worldName) return;
        const nextPinned = toggleWorldPinFromNative(worldName);
        resultsList.querySelectorAll('.wbo-s2-pin-btn').forEach((btn) => {
            if (btn.getAttribute('data-pin-world') === worldName) {
                btn.classList.toggle('is-pinned', nextPinned);
                btn.setAttribute('aria-pressed', nextPinned ? 'true' : 'false');
                btn.title = nextPinned ? '取消置顶' : '置顶此世界书';
                btn.textContent = nextPinned ? '★' : '☆';
            }
        });
        if (typeof onAfterToggle === 'function') {
            onAfterToggle({ worldName, isPinned: nextPinned });
        }
    };
    resultsList.addEventListener('pointerdown', onPointerBlock, true);
    resultsList.addEventListener('mousedown', onPointerBlock, true);
    resultsList.addEventListener('mouseup', onPointerBlock, true);
    resultsList.addEventListener('touchstart', onPointerBlock, { capture: true, passive: false });
    resultsList.addEventListener('click', onPinClick, true);
    return () => {
        resultsList.removeEventListener('pointerdown', onPointerBlock, true);
        resultsList.removeEventListener('mousedown', onPointerBlock, true);
        resultsList.removeEventListener('mouseup', onPointerBlock, true);
        resultsList.removeEventListener('touchstart', onPointerBlock, true);
        resultsList.removeEventListener('click', onPinClick, true);
    };
}

/**
 * Fallback injector ensuring every Select2 `<li class="select2-results__option">` has a right-aligned
 * `.wbo-s2-pin-btn` (`☆` / `★`) even if Select2 rendered options before `templateResult` was patched.
 * @param {HTMLElement} resultsList
 */
function ensureSelect2RowsHavePinBtn(resultsList) {
    if (!(resultsList instanceof HTMLElement)) return;
    resultsList.querySelectorAll('li.select2-results__option:not(.select2-results__option--group)').forEach((li) => {
        if (!(li instanceof HTMLElement)) return;
        if (li.classList.contains('select2-results__message')) return;
        if (li.querySelector('.wbo-s2-pin-btn')) return;
        const rawText = (li.textContent || '').trim();
        if (!rawText || rawText.startsWith('---')) return;
        const meta = _latestClassification?.byName?.get(rawText);
        const worldName = meta?.realName || rawText;
        const isPinned = Boolean(meta?.isPinned ?? _latestSettings?.pinnedBooks?.includes?.(worldName));
        li.classList.add('wbo-s2-li-flex');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `wbo-s2-pin-btn${isPinned ? ' is-pinned' : ''}`;
        btn.setAttribute('data-pin-world', worldName);
        btn.setAttribute('aria-pressed', isPinned ? 'true' : 'false');
        btn.title = isPinned ? '取消置顶' : '置顶此世界书';
        btn.textContent = isPinned ? '★' : '☆';
        li.appendChild(btn);
    });
}

/** @type {Map<string, HTMLOptionElement>} */
const _globalDetachedMap = new Map();
/** @type {Map<string, HTMLOptionElement>} */
const _editorDetachedMap = new Map();
/** @type {WeakMap<HTMLSelectElement, { vw: number, multiple: boolean, metrics: Record<string, string> }>} */
const _nativeAppearanceCache = new WeakMap();

const ENHANCED_POPOVER_SELECTORS = Object.freeze({
    containerClass: 'gr-container-enhanced',
    globalContainerId: 'gr-global-dropdown-container',
    displaySelector: '#WIMultiSelector .gr-select2-display',
    containerSelector: '#gr-global-dropdown-container, .gr-container-enhanced',
    optionSelector: '.gr-option',
    pinClass: 'gr-option-pin',
    groupLabelClass: 'gr-group-label',
    groupLabelSelector: ':scope > .gr-group-label',
    searchInputSelector: 'input[type="text"], input[type="search"], .gr-search-input',
});
let sharedPopoverOpening = null;
let enhancedStyleObserver = null;
let enhancedGlobalRecoveryTimer = null;
let enhancedGlobalClickHandler = null;
let removePluginSelectIsolation = null;
const ENHANCED_GLOBAL_DISPLAY = '#WIMultiSelector .gr-select2-display[data-gr-select-id="world_info"]';
const ENHANCED_STYLE_SELECTOR = 'style[data-gr-dropdown-style]';

export function hasCompatibleDropdownScript() {
    if (typeof document === 'undefined') return false;
    try {
        const scripts = globalThis.TavernHelper?.getScriptTrees?.({ type: 'global' });
        if (Array.isArray(scripts)) {
            return scripts.flatMap((item) => item?.type === 'folder' ? (item.scripts || []) : [item]).some((item) => {
                const code = item?.content;
                return typeof code === 'string'
                    && code.includes('gr-global-dropdown-container')
                    && code.includes('gr-select2-display')
                    && code.includes('data-gr-dropdown-style');
            });
        }
    } catch { /* Older hosts can only detect the running script. */ }
    return Boolean(document.querySelector(ENHANCED_STYLE_SELECTOR));
}

function hasOpenEnhancedGlobalPicker() {
    const popover = document.getElementById(ENHANCED_POPOVER_SELECTORS.globalContainerId);
    return popover && !popover.hidden && popover.style.display !== 'none' && detectEnhancedPopoverRole(popover) === 'global';
}

function restoreGlobalPickerFromStaleDisplay(display, { open = false } = {}) {
    const select = document.getElementById('world_info');
    if (!display?.isConnected || !(select instanceof HTMLSelectElement)) return;
    const $select = globalThis.jQuery ? globalThis.jQuery(select) : null;
    const select2 = $select?.data('select2');
    const nativeDisplay = select2?.$container?.[0] || select.parentElement?.querySelector(':scope > .select2-container');
    display.remove();
    if (select.style.display === 'none') select.style.removeProperty('display');
    if (nativeDisplay?.style.display === 'none') nativeDisplay.style.removeProperty('display');
    if (!open) return;
    if (select2) $select.select2('open');
    else {
        try { select.showPicker?.(); } catch { /* The restored native control is available for the next tap. */ }
    }
}

const WORLD_INFO_SORT_OPTION_FALLBACKS = new Set([
    'Search', 'Priority', 'Custom', 'Title A-Z', 'Title Z-A',
    'Tokens ↗', 'Tokens ↘', 'Depth ↗', 'Depth ↘',
    'Order ↗', 'Order ↘', 'UID ↗', 'UID ↘',
    'Trigger% ↗', 'Trigger% ↘', 'Length ↗', 'Length ↘',
]);

function getEnhancedPopoverOptionText(el) {
    if (el.dataset?.wboEnhancedWorld) return el.dataset.wboEnhancedWorld;
    if (el.dataset?.wboOriginalPlaceholder) return el.dataset.wboOriginalPlaceholder;
    let txt = '';
    for (const node of el.childNodes) {
        if (node.nodeType === 3) txt += node.textContent || '';
        else if (
            node instanceof HTMLElement &&
            !node.classList.contains(ENHANCED_POPOVER_SELECTORS.pinClass) &&
            !node.classList.contains('wbo-s2-badge') &&
            !node.classList.contains('wbo-s2-right') &&
            !node.hasAttribute?.('data-wbo-ui')
        ) {
            txt += node.textContent || '';
        }
    }
    return txt.trim() || (el.textContent || '').trim();
}

function getEnhancedOptionNodes(container) {
    return [...container.querySelectorAll(ENHANCED_POPOVER_SELECTORS.optionSelector)].filter((row) =>
        !['gr-theme-toggle', 'gr-filter-toggle', 'gr-create-new-option'].some((cls) => row.classList.contains(cls)),
    );
}

function mountEnhancedDropdownBar(optionsHost, bar, searchInput) {
    const scrollable = optionsHost.parentElement;
    if (!scrollable?.classList.contains('gr-options')) return false;
    let sticky = scrollable.querySelector(':scope > .wbo-enhanced-sticky');
    if (!sticky) {
        sticky = document.createElement('div');
        sticky.className = 'wbo-enhanced-sticky';
        sticky.setAttribute('data-wbo-ui', '1');
        scrollable.insertBefore(sticky, optionsHost);
        const searchBox = searchInput?.closest('.gr-search-box') || searchInput;
        if (searchBox?.parentElement === scrollable) sticky.appendChild(searchBox);
    }
    sticky.appendChild(bar);
    return true;
}

function enhancePresetDropdownGroups(container) {
    if (container.querySelector('.wbo-preset-filter-bar')) return;
    const optionsHost = container.querySelector('.gr-options-container');
    if (!optionsHost) return;
    const sections = [];
    const options = new Set(getEnhancedOptionNodes(optionsHost));
    let section = { id: 'other', name: '其他', rows: [] };
    sections.push(section);
    for (const child of optionsHost.children) {
        if (child.classList.contains(ENHANCED_POPOVER_SELECTORS.groupLabelClass)) {
            section = { id: String(sections.length), name: child.textContent.trim(), heading: child, rows: [] };
            sections.push(section);
        } else if (options.has(child)) {
            section.rows.push(child);
        }
    }
    const groups = sections.filter((item) => item.name && item.rows.length);
    if (groups.length < 2) return;
    const { barEl } = createDropdownFilterBar(groups.map(({ id, name }) => ({ id, label: name })), SPECIAL_GROUPS.ALL, 'wbo-preset-filter-bar');
    bindDrawerSafeBubbleGuard(barEl);
    barEl.addEventListener('mousedown', (event) => event.preventDefault());
    barEl.addEventListener('click', (event) => {
        const button = event.target instanceof Element ? event.target.closest('[data-wbo-pill]') : null;
        if (!button) return;
        const id = button.dataset.wboPill;
        for (const item of groups) {
            const hide = id !== SPECIAL_GROUPS.ALL && item.id !== id;
            item.heading?.classList.toggle('wbo-preset-group-hidden', hide);
            for (const row of item.rows) row.classList.toggle('wbo-preset-group-hidden', hide);
        }
        for (const pill of barEl.querySelectorAll('[data-wbo-pill]')) {
            pill.classList.toggle('is-active', pill === button);
            pill.setAttribute('aria-pressed', String(pill === button));
        }
        findScrollableListEl(optionsHost, container).scrollTop = 0;
    });
    if (!mountEnhancedDropdownBar(optionsHost, barEl, container.querySelector(ENHANCED_POPOVER_SELECTORS.searchInputSelector))) {
        optionsHost.before(barEl);
    }
}

function clearEnhancedPresetGroups(container) {
    if (!container?.querySelector('.wbo-preset-filter-bar')) return;
    container.querySelectorAll('.wbo-preset-filter-bar').forEach((el) => el.remove());
    container.querySelectorAll('.wbo-preset-group-hidden').forEach((el) => el.classList.remove('wbo-preset-group-hidden'));
    container.querySelectorAll('.wbo-enhanced-sticky').forEach((el) => el.replaceWith(...el.children));
}

function matchesSharedSelectOptions(selectId, rows) {
    const select = document.getElementById(selectId);
    if (!select?.options.length || rows.length > select.options.length) return false;
    const labels = new Map([...select.options].map((option) => [option.value, option.textContent.trim()]));
    return rows.length > 0 && rows.every((row) => labels.get(row.dataset.value) === getEnhancedPopoverOptionText(row));
}

function detectEnhancedPopoverRole(containerEl) {
    if (!(containerEl instanceof HTMLElement)) return null;
    const usesSharedContainer = containerEl.id === ENHANCED_POPOVER_SELECTORS.globalContainerId
        && Boolean(containerEl.querySelector('.gr-options-container'));
    if (containerEl.closest('#WIMultiSelector') || (containerEl.id === ENHANCED_POPOVER_SELECTORS.globalContainerId && !usesSharedContainer)) return 'global';
    if (usesSharedContainer) {
        if (!containerEl.dataset.wboSourceRole && sharedPopoverOpening && Date.now() - sharedPopoverOpening.at < 750
            && containerEl !== sharedPopoverOpening.previous) {
            containerEl.dataset.wboSourceRole = sharedPopoverOpening.role;
            sharedPopoverOpening = null;
        }
        const source = containerEl.dataset.wboSourceRole;
        if (source) return source === 'editor' || source === 'global' ? source : null;
    }

    const optionNodes = getEnhancedOptionNodes(containerEl);
    if (optionNodes.length === 0) {
        delete containerEl.dataset.wboPopoverRole;
        return null;
    }

    const knownWorldNames = new Set();
    if (_latestClassification?.byName) {
        for (const k of _latestClassification.byName.keys()) knownWorldNames.add(k);
    }
    for (const selId of ['world_editor_select', 'world_info']) {
        const sel = document.getElementById(selId);
        if (sel) {
            sel.querySelectorAll('option').forEach((opt) => {
                const name = (opt.dataset?.wboRealName || opt.textContent || '').trim();
                if (opt.value !== '' && name && !name.startsWith('---')) knownWorldNames.add(name);
            });
        }
    }
    for (const k of _editorDetachedMap.keys()) knownWorldNames.add(k);
    for (const k of _globalDetachedMap.keys()) knownWorldNames.add(k);

    const sortTexts = new Set(WORLD_INFO_SORT_OPTION_FALLBACKS);
    const sortSelect = document.getElementById('world_info_sort_order');
    if (sortSelect) {
        sortSelect.querySelectorAll('option').forEach((opt) => {
            const label = (opt.textContent || '').trim();
            if (label && !label.startsWith('---')) sortTexts.add(label);
        });
    }

    let nonEmptyCount = 0;
    let matchedWorldCount = 0;
    let sortMatchCount = 0;
    for (const optEl of optionNodes) {
        const hasValAttr = optEl.hasAttribute?.('data-value');
        const rawVal = optEl.dataset?.value;
        const text = getEnhancedPopoverOptionText(optEl);
        if ((hasValAttr && (rawVal ?? '') === '') || !text || text.startsWith('---')) continue;
        nonEmptyCount += 1;
        if (knownWorldNames.has(text)) matchedWorldCount += 1;
        if (sortTexts.has(text)) sortMatchCount += 1;
    }
    if (nonEmptyCount === 0) {
        delete containerEl.dataset.wboPopoverRole;
        return null;
    }
    if (sortMatchCount >= 2 && sortMatchCount / nonEmptyCount >= 0.45 && sortMatchCount >= matchedWorldCount) {
        delete containerEl.dataset.wboPopoverRole;
        if (usesSharedContainer) containerEl.dataset.wboSourceRole = 'sort';
        return null;
    }
    if (knownWorldNames.size === 0) {
        delete containerEl.dataset.wboPopoverRole;
        return null;
    }
    const isWorldbookPopover =
        (matchedWorldCount >= 2 && matchedWorldCount / nonEmptyCount >= 0.45) ||
        (matchedWorldCount >= 1 && matchedWorldCount === nonEmptyCount);
    if (!isWorldbookPopover) {
        delete containerEl.dataset.wboPopoverRole;
        return null;
    }
    if (usesSharedContainer) {
        const rows = optionNodes.filter((row) => row.dataset.value !== '' && !getEnhancedPopoverOptionText(row).startsWith('---'));
        const matchesEditor = matchesSharedSelectOptions('world_editor_select', rows);
        const matchesGlobal = matchesSharedSelectOptions('world_info', rows);
        if (matchesGlobal && (!matchesEditor || rows.some((row) => row.querySelector('.gr-option-pin:not(.wbo-gr-pin-btn)')))) {
            containerEl.dataset.wboSourceRole = 'global';
            return 'global';
        }
        if (!matchesEditor) return null;
    }
    return 'editor';
}

function syncEnhancedPinButton(button, pinned) {
    button.classList.toggle('is-pinned', pinned);
    button.setAttribute('aria-pressed', String(pinned));
    button.title = pinned ? '取消收藏' : '收藏世界书';
    button.setAttribute('aria-label', button.title);
    if (!button.querySelector('svg')) button.textContent = pinned ? '★' : '☆';
}

function adoptEnhancedPinIcon(row, button) {
    const original = row.querySelector('.gr-option-pin:not(.wbo-gr-pin-btn)');
    if (!original) return;
    const icon = original.querySelector('svg');
    const path = icon?.querySelector('path')?.getAttribute('d');
    if (path && !button.querySelector('svg')) {
        const ns = 'http://www.w3.org/2000/svg';
        const glyph = document.createElementNS(ns, 'svg');
        glyph.setAttribute('viewBox', icon.getAttribute('viewBox') || '0 0 24 24');
        glyph.setAttribute('width', '13');
        glyph.setAttribute('height', '13');
        glyph.setAttribute('fill', 'currentColor');
        glyph.setAttribute('aria-hidden', 'true');
        const stroke = document.createElementNS(ns, 'path');
        stroke.setAttribute('d', path);
        glyph.appendChild(stroke);
        button.replaceChildren(glyph);
    }
    original.remove();
}

function syncEnhancedEditorOptionTitle(row, meta) {
    if (!meta?.isCharBound && !meta?.isInCharGroup) return;
    row.dataset.wboEnhancedWorld = meta.realName;
    let label = row.querySelector(':scope > .wbo-gr-world-title');
    if (!label) {
        for (const node of [...row.childNodes]) if (node.nodeType === 3) node.remove();
        label = document.createElement('span');
        label.className = 'wbo-gr-world-title';
        row.prepend(label);
    }
    label.textContent = meta.primaryTitle || meta.realName;
    label.title = meta.realName;
    if (meta.subtitle) {
        const subtitle = document.createElement('small');
        subtitle.textContent = meta.subtitle;
        label.appendChild(subtitle);
    }
}

/**
 * Walk past Select2 / enhanced-select / mobile-trigger wrapper siblings to find
 * the owning `<select>` element (checking preceding siblings first since Select2
 * and custom displays are mounted after their `<select>`).
 * @param {Element | null} el
 * @returns {Element | null}
 */
function findOwningSelectSibling(el) {
    if (!(el instanceof Element)) return null;
    const isWrapperSibling = (node) =>
        node instanceof Element &&
        (node.classList.contains('select2-container') ||
            node.classList.contains('gr-select2-display') ||
            node.id === MOBILE_TRIGGER_ID);

    let prev = el.previousElementSibling;
    while (prev && isWrapperSibling(prev)) {
        prev = prev.previousElementSibling;
    }
    if (prev && prev.tagName === 'SELECT') return prev;

    let next = el.nextElementSibling;
    while (next && isWrapperSibling(next)) {
        next = next.nextElementSibling;
    }
    if (next && next.tagName === 'SELECT') return next;
    return null;
}

function isNativeSortTriggerTarget(target) {
    if (target.closest('#world_info_sort_order, [data-gr-select-id="world_info_sort_order"], #select2-world_info_sort_order-container')) return true;
    const wrapper = target.closest('#world_popup .gr-select2-display, #world_popup .select2-container');
    return Boolean(wrapper && (wrapper.querySelector('#select2-world_info_sort_order-container')
        || findOwningSelectSibling(wrapper)?.id === 'world_info_sort_order'));
}

/**
 * Determine whether a click/mousedown target belongs specifically to `#world_editor_select`
 * (and NOT `#world_info_sort_order` or entry-level `<select>`s inside `#world_popup_entries_list`).
 * @param {EventTarget | null} t
 * @returns {boolean}
 */
function isEditorSelectTriggerTarget(t) {
    if (!(t instanceof Element)) return false;
    if (t.closest('#world_info_sort_order, #world_popup_entries_list')) return false;
    if (t.closest('#world_editor_select, #wbo-mobile-editor-trigger')) return true;

    const disp = t.closest('#world_popup .gr-select2-display');
    if (disp) {
        const selAttr = disp.dataset.grSelectId || disp.getAttribute('data-select-id') || disp.getAttribute('data-for') || '';
        if (selAttr === 'world_info_sort_order') return false;
        if (selAttr === 'world_editor_select') return true;
        const ownerSel = findOwningSelectSibling(disp);
        if (ownerSel?.id === 'world_info_sort_order') return false;
        if (ownerSel?.id === 'world_editor_select') return true;
        if (ownerSel) return false;
        const parent = disp.parentElement;
        return Boolean(parent?.querySelector('#world_editor_select') && !parent?.querySelector('#world_info_sort_order'));
    }

    const s2 = t.closest('#world_popup .select2-container');
    if (s2) {
        if (s2.querySelector('#select2-world_info_sort_order-container')) return false;
        if (s2.querySelector('#select2-world_editor_select-container')) return true;
        const ownerSel = findOwningSelectSibling(s2);
        if (ownerSel?.id === 'world_info_sort_order') return false;
        if (ownerSel?.id === 'world_editor_select') return true;
        if (ownerSel) return false;
        const parent = s2.parentElement;
        return Boolean(parent?.querySelector('#world_editor_select') && !parent?.querySelector('#world_info_sort_order'));
    }

    return false;
}

let _isApplying = false;
let _latestClassification = null;
let _latestSettings = null;
let _currentlyEditingWorld = null;
let _pendingClearedEditingWorld = false;
let _lastGlobalSignature = null;
let _lastEditorSignature = null;
let _deferredGlobalTimer = null;

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
/** @type {any[]} */
const _sweepPopoverTimers = [];

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
 * Purge deleted worldbooks from detached option caches so a deleted hidden book
 * is never resurrected into native `<select>` elements or stale group counts.
 * @param {Set<string>} liveWorldNamesSet
 */
export function pruneDetachedWorldNames(liveWorldNamesSet) {
    if (!(liveWorldNamesSet instanceof Set) || liveWorldNamesSet.size === 0) return;
    let globalPruned = false;
    let editorPruned = false;
    for (const key of [..._globalDetachedMap.keys()]) {
        if (!liveWorldNamesSet.has(key)) {
            _globalDetachedMap.delete(key);
            globalPruned = true;
        }
    }
    for (const key of [..._editorDetachedMap.keys()]) {
        if (!liveWorldNamesSet.has(key)) {
            _editorDetachedMap.delete(key);
            editorPruned = true;
        }
    }
    if (_currentlyEditingWorld && !liveWorldNamesSet.has(_currentlyEditingWorld)) {
        _currentlyEditingWorld = null;
        _pendingClearedEditingWorld = true;
        editorPruned = true;
    }
    if (globalPruned) _lastGlobalSignature = null;
    if (editorPruned) _lastEditorSignature = null;
}

/**
 * Record the worldbook currently opened in the native editor so we keep it visible.
 * @param {string | null} worldName
 */
export function setCurrentlyEditingWorld(worldName) {
    const clean = worldName ? String(worldName).trim() : null;
    _currentlyEditingWorld = clean;
    if (clean) _pendingClearedEditingWorld = false;
    if (typeof document !== 'undefined') syncOpenEditingBadges();
}

function syncOpenEditingBadges() {
    const active = getCurrentEditorWorldName() || _currentlyEditingWorld;
    const updateBadge = (actions, current) => {
        if (!actions) return;
        const existing = actions.querySelector('[data-wbo-editing-badge]');
        if (!current) existing?.remove();
        else if (!existing) {
            const badge = document.createElement('span');
            badge.className = 'wbo-s2-badge is-editing';
            badge.setAttribute('data-wbo-ui', '1');
            badge.setAttribute('data-wbo-editing-badge', '1');
            badge.textContent = '当前编辑';
            actions.insertBefore(badge, actions.firstChild);
        }
    };
    const $ = globalThis.jQuery;
    const select = document.getElementById('world_editor_select');
    const dropdown = $ && select ? $(select).data('select2')?.$dropdown?.[0] : null;
    dropdown?.querySelectorAll('.wbo-s2-item[data-wbo-world]').forEach((row) => {
        updateBadge(row.querySelector('.wbo-s2-right'), row.getAttribute('data-wbo-world') === active);
    });
    document.getElementById(MOBILE_PICKER_OVERLAY_ID)?.querySelectorAll('.wbo-mp-row').forEach((row) => {
        const current = row.querySelector('[data-mp-world]')?.getAttribute('data-mp-world') === active;
        row.classList.toggle('is-selected', current);
        const actions = row.querySelector('.wbo-mp-row-actions');
        updateBadge(actions, current);
        const check = actions?.querySelector('.wbo-mp-check');
        if (!current) check?.remove();
        else if (!check && actions) {
            const marker = document.createElement('i');
            marker.className = 'fa-solid fa-check wbo-mp-check';
            actions.insertBefore(marker, actions.querySelector('.wbo-mp-pin-btn'));
        }
    });
    document.querySelectorAll('[data-wbo-popover-role="editor"]').forEach((popover) => {
        if (!popover.hidden && popover.style.display !== 'none') scheduleContainerReEnhance(popover);
    });
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

function matchesGlobalDropdownGroup(meta, groupId) {
    if (groupId === SPECIAL_GROUPS.ALL) return true;
    if (groupId === SPECIAL_GROUPS.PINNED) return Boolean(meta?.isPinned);
    return meta?.groupId === groupId;
}

function globalSelect2Matcher(params, data) {
    const meta = _latestClassification?.byName?.get(String(data.text ?? '').trim());
    return matchesGlobalDropdownGroup(meta, _activeGlobalPillId) ? customSelect2Matcher(params, data) : null;
}

/**
 * Build Select2 `templateResult` DOM node showing clean alias/character name,
 * optional muted original author title, group pill, and optional `当前编辑` badge.
 * @param {any} state
 * @param {{ showGroupPill: boolean, showEditingBadge?: boolean }} opts
 */
function renderSelect2OptionResult(state, { showGroupPill, showEditingBadge = false }) {
    if (!state.id) return state.text; // placeholder or optgroup header
    const realName = String(state.text ?? '').trim();
    const meta = _latestClassification?.byName?.get(realName);
    if (!meta) return state.text;

    const $ = globalThis.jQuery;
    if (!$) return state.text;

    const hasCustomGroups = (_latestClassification?.customGroups?.length || 0) > 0;
    const isEditing = showEditingBadge && realName === (getCurrentEditorWorldName() || _currentlyEditingWorld);
    const editingBadge = isEditing
        ? '<span class="wbo-s2-badge is-editing" data-wbo-ui="1" data-wbo-editing-badge="1">当前编辑</span>'
        : '';
    const groupBadge = showGroupPill && (hasCustomGroups || meta.isInCharGroup)
        ? `<span class="wbo-s2-badge${meta.isInCharGroup ? ' is-char' : ''}">${escHtml(meta.groupName)}</span>`
        : '';
    const subHtml = meta.subtitle
        ? `<span class="wbo-s2-sub" title="${escHtml(meta.realName)}">${escHtml(meta.subtitle)}</span>`
        : '';
    const isPinned = Boolean(meta.isPinned);
    const pinBtnHtml = `<button type="button" class="wbo-s2-pin-btn${isPinned ? ' is-pinned' : ''}" data-pin-world="${escHtml(meta.realName)}" title="${isPinned ? '取消置顶' : '置顶此世界书'}" aria-pressed="${isPinned ? 'true' : 'false'}">${isPinned ? '★' : '☆'}</button>`;

    return $(`
        <span class="wbo-s2-item" data-wbo-world="${escHtml(meta.realName)}" title="${escHtml(meta.realName)}">
            <span class="wbo-s2-main">
                <span class="wbo-s2-title">${escHtml(meta.primaryTitle)}</span>
                ${subHtml}
            </span>
            <span class="wbo-s2-right">
                ${editingBadge}
                ${groupBadge}
                ${pinBtnHtml}
            </span>
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
 * Build a map of `worldName -> String(index)` from authoritative SillyTavern
 * `world_names` (never from DOM-only fallback when options may be detached).
 * @returns {Map<string, string>}
 */
function getLiveWorldIndexMap() {
    const ctx = getHostContext();
    let liveList = null;
    if (typeof ctx?.getWorldInfoNames === 'function') {
        const arr = ctx.getWorldInfoNames();
        if (Array.isArray(arr) && arr.length > 0) liveList = arr;
    }
    if (!liveList && Array.isArray(ctx?.world_names) && ctx.world_names.length > 0) {
        liveList = ctx.world_names;
    }
    if (!liveList) {
        const probe = '__wbo_live_probe__';
        const probed = getWorldNames([probe]);
        if (Array.isArray(probed) && probed.length > 0 && !probed.includes(probe)) {
            liveList = probed;
        }
    }
    const map = new Map();
    if (Array.isArray(liveList)) {
        liveList.forEach((name, idx) => {
            const clean = String(name ?? '').trim();
            if (clean && !map.has(clean)) map.set(clean, String(idx));
        });
    }
    return map;
}

/**
 * Re-sync `<option>.value` on attached options and detached map entries against
 * live `world_names` indices and deduplicate stale duplicate `<option>`s.
 * @param {HTMLSelectElement} selectEl
 * @param {Map<string, HTMLOptionElement> | null} [detachedMap=null]
 */
function syncSelectOptionsWithLiveWorldNames(selectEl, detachedMap = null) {
    if (!(selectEl instanceof HTMLSelectElement)) return;
    const liveIndexMap = getLiveWorldIndexMap();
    const byName = new Map();
    const currentSelectedVal = selectEl.value;
    let clearedSelectedStale = false;
    for (const opt of Array.from(selectEl.querySelectorAll('option'))) {
        if (opt.value === '') continue;
        const name = (opt.textContent || '').trim();
        if (!name) continue;
        const liveVal = liveIndexMap.get(name);
        if (liveIndexMap.size > 0 && liveVal === undefined) {
            if (opt.selected || (currentSelectedVal !== '' && opt.value === currentSelectedVal)) {
                opt.selected = false;
                clearedSelectedStale = true;
                if (selectEl.id === 'world_editor_select' && _currentlyEditingWorld === name) {
                    _currentlyEditingWorld = null;
                    _pendingClearedEditingWorld = true;
                }
            }
            opt.remove();
            continue;
        }
        if (liveVal !== undefined && opt.value !== liveVal) {
            opt.value = liveVal;
        }
        const prev = byName.get(name);
        if (prev) {
            if (opt.selected && !prev.selected) {
                prev.remove();
                byName.set(name, opt);
            } else {
                opt.remove();
            }
        } else {
            byName.set(name, opt);
        }
    }
    if (clearedSelectedStale && !selectEl.multiple) {
        selectEl.value = '';
    }
    if (detachedMap instanceof Map) {
        for (const [name, opt] of [...detachedMap.entries()]) {
            if (byName.has(name)) {
                detachedMap.delete(name);
                continue;
            }
            if (liveIndexMap.size > 0) {
                const liveVal = liveIndexMap.get(name);
                if (liveVal === undefined) {
                    detachedMap.delete(name);
                } else if (opt && opt.value !== liveVal) {
                    opt.value = liveVal;
                }
            }
        }
    }
}

/**
 * Restore all detached options back into a `<select>` and unwrap ALL `<optgroup>`s
 * so leftover or foreign empty group headers never remain.
 * @param {HTMLSelectElement} selectEl
 * @param {Map<string, HTMLOptionElement>} detachedMap
 */
function restoreSelectOptions(selectEl, detachedMap) {
    const optgroups = Array.from(selectEl.querySelectorAll('optgroup'));
    if (optgroups.length > 0) {
        const unwrapFrag = document.createDocumentFragment();
        for (const grp of optgroups) {
            while (grp.firstChild) {
                unwrapFrag.appendChild(grp.firstChild);
            }
            grp.remove();
        }
        selectEl.appendChild(unwrapFrag);
    }

    // Collect existing option texts to avoid duplicates after upstream `updateWorldInfoList`
    const existingByText = new Map();
    selectEl.querySelectorAll('option').forEach((opt) => {
        if (opt.value === '') return;
        const name = (opt.textContent || '').trim();
        if (!name) return;
        const prev = existingByText.get(name);
        if (prev) {
            if (opt.selected && !prev.selected) {
                prev.remove();
                existingByText.set(name, opt);
            } else {
                opt.remove();
            }
        } else {
            existingByText.set(name, opt);
        }
    });

    if (detachedMap.size > 0) {
        const restoreFrag = document.createDocumentFragment();
        for (const [name, opt] of detachedMap.entries()) {
            if (!existingByText.has(name)) {
                restoreFrag.appendChild(opt);
                existingByText.set(name, opt);
            }
        }
        selectEl.appendChild(restoreFrag);
        detachedMap.clear();
    }
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
        return compareZhCn(a.textContent || '', b.textContent || '');
    });
}

/**
 * Build an O(1) rank lookup map from external-ordered sections (`UNGROUPED` last)
 * so native `<option>` sorting uses pure integer subtraction with zero string collation overhead!
 * @param {any} classification
 * @returns {Map<string, number>}
 */
function buildBookOrderRankMap(classification) {
    const rankMap = new Map();
    let idx = 0;
    for (const sec of orderSectionsForExternalDropdown(classification?.orderedSections || [])) {
        for (const b of sec.books || []) {
            if (b?.realName && !rankMap.has(b.realName)) {
                rankMap.set(b.realName, idx++);
            }
        }
    }
    return rankMap;
}

const compareAsciiKey = ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Compute a stable signature of what `#world_info` or `#world_editor_select`
 * should contain, so we skip touching Select2 completely when nothing changed.
 */
function computeSelectSignature(selectEl, detachedMap, classification, settings, mode) {
    const liveIndexMap = getLiveWorldIndexMap();
    const allNames = [];
    const seen = new Set();
    selectEl.querySelectorAll('option').forEach((opt) => {
        if (opt.value === '') return;
        const name = (opt.textContent || '').trim();
        if (name && !seen.has(name)) {
            seen.add(name);
            const liveVal = liveIndexMap.size > 0 ? (liveIndexMap.get(name) ?? '__deleted__') : opt.value;
            allNames.push(`${name}:${opt.value}:${liveVal}:${opt.selected ? 1 : 0}`);
        }
    });
    for (const [name, opt] of detachedMap.entries()) {
        if (!seen.has(name)) {
            seen.add(name);
            const liveVal = liveIndexMap.size > 0 ? (liveIndexMap.get(name) ?? '__deleted__') : (opt?.value ?? '');
            allNames.push(`${name}:${opt?.value ?? ''}:${liveVal}:0`);
        }
    }
    allNames.sort();

    const groupSig = (classification.orderedSections || []).map((s) => `${s.id}=${s.name}`).join('|');
    const assignmentSig = Object.entries(settings.assignments || {})
        .sort(compareAsciiKey)
        .map(([k, v]) => `${k}>${v}`)
        .join('|');
    const aliasSig = Object.entries(settings.aliases || {})
        .sort(compareAsciiKey)
        .map(([k, v]) => `${k}=${v}`)
        .join('|');
    const charSig = [...classification.characterBooks.map((b) => `${b.realName}:${b.primaryTitle}:${b.subtitle}`)].join('|');

    const foreignOptgroupCount = mode === 'editor'
        ? selectEl.querySelectorAll('optgroup:not([data-wbo-group])').length
        : 0;
    const ownOptgroupCount = mode === 'editor'
        ? selectEl.querySelectorAll('optgroup[data-wbo-group]').length
        : 0;

    const hiddenList = mode === 'global'
        ? (Array.isArray(settings.globalHiddenGroupIds) ? settings.globalHiddenGroupIds : [SPECIAL_GROUPS.CHARACTER])
        : (Array.isArray(settings.editorHiddenGroupIds) ? settings.editorHiddenGroupIds : [SPECIAL_GROUPS.CHARACTER]);
    const hiddenSig = [...hiddenList].sort().join(',');
    const pinnedSig = [...(Array.isArray(settings.pinnedBooks) ? settings.pinnedBooks : [])].sort().join(',');
    const currentChatAvatarSig = mode === 'editor' && settings.pinCurrentChatCharBookInEditor !== false
        ? (getCurrentCharacterAvatar() || '')
        : '';

    return JSON.stringify([
        mode,
        Boolean(settings.showCharBooks),
        hiddenSig,
        pinnedSig,
        currentChatAvatarSig,
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
    syncSelectOptionsWithLiveWorldNames(selectEl, _globalDetachedMap);

    const placeholderOpts = [];
    const visibleOpts = [];

    const globalHiddenSet = new Set(
        Array.isArray(settings.globalHiddenGroupIds)
            ? settings.globalHiddenGroupIds
            : (settings.hideCharBooksByDefault !== false ? [SPECIAL_GROUPS.CHARACTER] : []),
    );

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
            hiddenGroupIds: globalHiddenSet,
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

    // Order visible options cleanly: pinned first, then pre-sorted classification rank (O(1) integer compare)
    const rankMap = buildBookOrderRankMap(classification);
    visibleOpts.sort((a, b) => {
        const na = (a.textContent || '').trim();
        const nb = (b.textContent || '').trim();
        const pa = classification?.byName?.get(na)?.isPinned ? 1 : 0;
        const pb = classification?.byName?.get(nb)?.isPinned ? 1 : 0;
        if (pa !== pb) return pb - pa;
        const ra = rankMap.get(na);
        const rb = rankMap.get(nb);
        if (ra !== undefined && rb !== undefined && ra !== rb) return ra - rb;
        if (ra !== undefined) return -1;
        if (rb !== undefined) return 1;
        return compareZhCn(na, nb);
    });

    const frag = document.createDocumentFragment();
    for (const opt of [...placeholderOpts, ...visibleOpts]) {
        frag.appendChild(opt);
    }
    selectEl.appendChild(frag);

    if (hasSelect2 && $select && selectEl.dataset.wboS2Ready !== '1') {
        const patched = patchExistingSelect2InPlace($select, {
            matcher: globalSelect2Matcher,
            templateResult: (state) => renderSelect2OptionResult(state, {
                showGroupPill: _activeGlobalPillId === SPECIAL_GROUPS.ALL || _activeGlobalPillId === SPECIAL_GROUPS.PINNED,
            }),
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
    if (sig === _lastEditorSignature && (skipSelectionSync || !_pendingClearedEditingWorld)) return;
    _lastEditorSignature = sig;

    const $select = $ ? $(selectEl) : null;
    const hasSelect2 = Boolean($select && ($select.data('select2') || $select.hasClass('select2-hidden-accessible')));

    const prevValue = selectEl.value;
    const prevSelectedOpt =
        selectEl.selectedOptions?.[0] ||
        Array.from(selectEl.options || []).find((o) => o.selected || (prevValue !== '' && o.value === prevValue));
    const prevSelectedName =
        prevSelectedOpt && prevSelectedOpt.value !== '' ? (prevSelectedOpt.textContent || '').trim() : '';

    restoreSelectOptions(selectEl, _editorDetachedMap);
    syncSelectOptionsWithLiveWorldNames(selectEl, _editorDetachedMap);

    const placeholderOpts = [];
    const bareTopOpts = [];
    const visibleByGroup = new Map();

    const editorHiddenSet = new Set(
        Array.isArray(settings.editorHiddenGroupIds)
            ? settings.editorHiddenGroupIds
            : (settings.hideCharBooksByDefault !== false ? [SPECIAL_GROUPS.CHARACTER] : []),
    );
    const currentChatAvatar = settings.pinCurrentChatCharBookInEditor !== false
        ? getCurrentCharacterAvatar()
        : null;

    const bareMetaByOpt = new WeakMap();

    for (const opt of Array.from(selectEl.querySelectorAll('option'))) {
        if (opt.value === '') {
            placeholderOpts.push(opt);
            continue;
        }
        const realName = (opt.textContent || '').trim();
        const meta = classification.byName.get(realName);
        const isActiveEditing = prevSelectedName !== ''
            ? realName === prevSelectedName
            : Boolean(opt.selected || (prevValue !== '' && opt.value === prevValue) || (_currentlyEditingWorld && realName === _currentlyEditingWorld));
        const isEditing = isActiveEditing;
        const isCurrentChatCharBook = Boolean(
            currentChatAvatar &&
            meta?.charOwners?.some((o) => o.avatar === currentChatAvatar),
        );

        const visible = isBookVisibleInSelector({
            bookMeta: meta,
            activeFilterGroupId: SPECIAL_GROUPS.DEFAULT,
            showCharBooks: Boolean(settings.showCharBooks),
            hiddenGroupIds: editorHiddenSet,
            isSelected: opt.selected,
            isCurrentlyEditing: isEditing,
            isCurrentChatCharBook,
        });

        if (visible) {
            if (isActiveEditing) opt.dataset.wboEditing = '1';
            else delete opt.dataset.wboEditing;
            const gid = meta?.groupId || SPECIAL_GROUPS.UNGROUPED;
            const isFromHiddenGroup = Boolean(!settings.showCharBooks && editorHiddenSet.has(gid));
            if (isCurrentChatCharBook || (isEditing && isFromHiddenGroup)) {
                bareMetaByOpt.set(opt, { isActiveEditing, isCurrentChatCharBook });
                bareTopOpts.push(opt);
            } else {
                if (!visibleByGroup.has(gid)) visibleByGroup.set(gid, []);
                visibleByGroup.get(gid).push(opt);
            }
        } else {
            delete opt.dataset.wboEditing;
            opt.remove();
            _editorDetachedMap.set(realName, opt);
        }
    }

    const frag = document.createDocumentFragment();
    // Re-append placeholders first
    for (const opt of placeholderOpts) {
        frag.appendChild(opt);
    }

    const rankMap = buildBookOrderRankMap(classification);
    if (bareTopOpts.length > 0) {
        bareTopOpts.sort((a, b) => {
            const na = (a.textContent || '').trim();
            const nb = (b.textContent || '').trim();
            const pa = classification?.byName?.get(na)?.isPinned ? 1 : 0;
            const pb = classification?.byName?.get(nb)?.isPinned ? 1 : 0;
            if (pa !== pb) return pb - pa;
            const ea = bareMetaByOpt.get(a)?.isActiveEditing ? 1 : 0;
            const eb = bareMetaByOpt.get(b)?.isActiveEditing ? 1 : 0;
            if (ea !== eb) return eb - ea;
            const ca = bareMetaByOpt.get(a)?.isCurrentChatCharBook ? 1 : 0;
            const cb = bareMetaByOpt.get(b)?.isCurrentChatCharBook ? 1 : 0;
            if (ca !== cb) return cb - ca;
            const ra = rankMap.get(na);
            const rb = rankMap.get(nb);
            if (ra !== undefined && rb !== undefined && ra !== rb) return ra - rb;
            if (ra !== undefined) return -1;
            if (rb !== undefined) return 1;
            return compareZhCn(na, nb);
        });
        for (const opt of bareTopOpts) {
            frag.appendChild(opt);
        }
    }

    const orderedSections = orderSectionsForExternalDropdown(classification.orderedSections || []).map((s) => ({
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
            const na = (a.textContent || '').trim();
            const nb = (b.textContent || '').trim();
            const pa = classification?.byName?.get(na)?.isPinned ? 1 : 0;
            const pb = classification?.byName?.get(nb)?.isPinned ? 1 : 0;
            if (pa !== pb) return pb - pa;
            const ra = rankMap.get(na);
            const rb = rankMap.get(nb);
            if (ra !== undefined && rb !== undefined && ra !== rb) return ra - rb;
            if (ra !== undefined) return -1;
            if (rb !== undefined) return 1;
            return compareZhCn(na, nb);
        });

        if (useOptgroups) {
            const optgroup = document.createElement('optgroup');
            optgroup.label = `${sec.label} (${opts.length})`;
            optgroup.setAttribute('data-wbo-group', sec.id);
            for (const opt of opts) {
                optgroup.appendChild(opt);
            }
            frag.appendChild(optgroup);
        } else {
            for (const opt of opts) {
                frag.appendChild(opt);
            }
        }
    }
    selectEl.appendChild(frag);

    // Preserve selection cleanly by book name against live world_names indices
    let restoredOpt = null;
    if (prevSelectedName !== '') {
        restoredOpt = Array.from(selectEl.querySelectorAll('option')).find(
            (o) => o.value !== '' && (o.textContent || '').trim() === prevSelectedName,
        ) || null;
    }
    let selectionCleared = false;
    if (restoredOpt) {
        for (const o of Array.from(selectEl.querySelectorAll('option'))) {
            o.selected = o === restoredOpt;
        }
        selectEl.value = restoredOpt.value;
        if (!_currentlyEditingWorld) {
            _currentlyEditingWorld = prevSelectedName;
        }
        _pendingClearedEditingWorld = false;
    } else if (prevSelectedName === '' && prevValue !== '') {
        selectEl.value = prevValue;
    } else if (prevSelectedName !== '') {
        selectEl.value = '';
        if (_currentlyEditingWorld === prevSelectedName) {
            _currentlyEditingWorld = null;
        }
        selectionCleared = true;
        _pendingClearedEditingWorld = Boolean(skipSelectionSync);
    } else {
        // Explicit empty placeholder restoration: moving `<option value="">` via DocumentFragment
        // causes Chromium single-<select> to auto-select another option while real options remain attached.
        let matchedEmpty = false;
        for (const o of Array.from(selectEl.querySelectorAll('option'))) {
            const isEmpty = !matchedEmpty && o.value === '';
            if (isEmpty) matchedEmpty = true;
            o.selected = isEmpty;
        }
        selectEl.value = '';
        if (_currentlyEditingWorld) {
            const stillHasEditing = Array.from(selectEl.querySelectorAll('option')).some(
                (o) => o.value !== '' && (o.textContent || '').trim() === _currentlyEditingWorld,
            );
            if (!stillHasEditing) {
                _currentlyEditingWorld = null;
                selectionCleared = true;
                _pendingClearedEditingWorld = Boolean(skipSelectionSync);
            }
        } else if (!skipSelectionSync && _pendingClearedEditingWorld) {
            selectionCleared = true;
            _pendingClearedEditingWorld = false;
        }
    }

    if (hasSelect2 && $select && selectEl.dataset.wboS2Ready !== '1') {
        const patched = patchExistingSelect2InPlace($select, {
            matcher: customSelect2Matcher,
            templateResult: (state) => renderSelect2OptionResult(state, { showGroupPill: false, showEditingBadge: true }),
            templateSelection: renderEditorSelect2Selection,
        });
        if (patched) {
            selectEl.dataset.wboS2Ready = '1';
        }
    }
    if (!skipSelectionSync) {
        if (selectionCleared) {
            if (hasSelect2 && $select) {
                try { $select.trigger('change'); } catch { /* ignore */ }
            } else {
                selectEl.dispatchEvent(new Event('change', { bubbles: true }));
            }
        } else if (hasSelect2 && $select && (selectEl.value !== '' || prevValue !== '' || prevSelectedName !== '')) {
            // Refresh displayed title in Select2 box (namespaced so host `change` does NOT refire;
            // skipped during `select2:opening` so `.select2-selection__rendered` is never rebuilt mid-click)
            try { $select.trigger('change.select2'); } catch { /* ignore */ }
        }
    }

    // On native mobile `<select>` (iOS Safari / iPadOS / TauriTavern iOS / Android where Select2 is skipped),
    // system menus cannot filter or collapse groups. Mount a sleek grouped picker trigger when >= 2 sections exist!
    syncMobileEditorTrigger(selectEl, Boolean(!hasSelect2 && useOptgroups));
    syncMobileEditorTriggerLabel();
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
 * Mirror the exact live visual geometry & theme tokens of a native `<select>` onto our
 * custom trigger button so swapping `<select>` <-> trigger never turns thicker or squarer!
 * @param {HTMLSelectElement} selectEl
 * @param {HTMLElement} triggerEl
 */
function mirrorNativeSelectAppearance(selectEl, triggerEl) {
    if (!selectEl || !triggerEl) return;
    const vw = globalThis.innerWidth || 0;
    const cached = _nativeAppearanceCache.get(selectEl);
    if (cached && cached.vw === vw && cached.multiple === Boolean(selectEl.multiple)) {
        Object.assign(triggerEl.style, cached.metrics);
        return;
    }

    const wasHidden = selectEl.classList.contains('wbo-mobile-select-hidden');
    if (wasHidden) selectEl.classList.remove('wbo-mobile-select-hidden');
    try {
        // For `<select multiple>`, browsers default to a tall 4-row list box; mirror a clean single-line
        // height from the sibling primary `<select>` (or cap at 38px) so it never looks bloated!
        const styleSource = (selectEl.multiple && selectEl.closest('.character_world')?.querySelector('.character_world_info_selector'))
            || selectEl;
        const srcWasHidden = styleSource !== selectEl && styleSource.classList.contains('wbo-mobile-select-hidden');
        if (srcWasHidden) styleSource.classList.remove('wbo-mobile-select-hidden');
        try {
            const cs = globalThis.getComputedStyle(styleSource);
            const selfCs = styleSource === selectEl ? cs : globalThis.getComputedStyle(selectEl);
            const rect = styleSource.getBoundingClientRect();
            const rawH = rect.height > 14 ? Math.round(rect.height) : parseFloat(cs.height);
            const finalH = Number.isFinite(rawH) && rawH > 14
                ? Math.min(selectEl.multiple ? 38 : 48, Math.max(selectEl.multiple ? 28 : 22, Math.round(rawH)))
                : 32;
            const padLeft = parseFloat(cs.paddingLeft) || 10;
            const metrics = {
                height: `${finalH}px`,
                minHeight: `${finalH}px`,
                maxHeight: `${finalH}px`,
                lineHeight: '1.35',
                borderRadius: cs.borderRadius,
                border: `${cs.borderTopWidth} ${cs.borderTopStyle} ${cs.borderTopColor}`,
                backgroundColor: cs.backgroundColor,
                color: cs.color,
                fontSize: cs.fontSize,
                fontFamily: cs.fontFamily,
                fontWeight: cs.fontWeight,
                boxShadow: cs.boxShadow,
                padding: `0 ${Math.max(8, Math.round(padLeft))}px`,
                marginTop: selfCs.marginTop,
                marginRight: selfCs.marginRight,
                marginBottom: selfCs.marginBottom,
                marginLeft: selfCs.marginLeft,
                alignSelf: selfCs.alignSelf && selfCs.alignSelf !== 'auto' ? selfCs.alignSelf : '',
                verticalAlign: selfCs.verticalAlign,
            };
            Object.assign(triggerEl.style, metrics);
            if (rect.height > 14) {
                _nativeAppearanceCache.set(selectEl, { vw, multiple: Boolean(selectEl.multiple), metrics });
            }
        } finally {
            if (srcWasHidden) styleSource.classList.add('wbo-mobile-select-hidden');
        }
    } catch {
        // Fallback to theme defaults
    } finally {
        if (wasHidden) selectEl.classList.add('wbo-mobile-select-hidden');
    }
}

/**
 * Check whether a pointer/mouse event's viewport coordinates fall inside a visible element's rect.
 * Used when a full-screen `.wbo-mp-backdrop` intercepts `pointerdown` right over the trigger button.
 * @param {Event | null | undefined} ev
 * @param {Element | null | undefined} el
 */
function isPointInsideElementRect(ev, el) {
    if (!(el instanceof Element)) return false;
    const x = ev?.clientX;
    const y = ev?.clientY;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    const rect = el.getBoundingClientRect?.();
    if (!rect || !(rect.width > 0 && rect.height > 0)) return false;
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

/**
 * Consume a recent `wboDismissedTapAt` marker set by `onGlobalDismiss` when a `pointerdown`
 * on `.wbo-mp-backdrop` over `triggerEl` closed the overlay right before the synthesized `click`.
 * @param {HTMLElement | null | undefined} triggerEl
 * @param {number} [windowMs]
 */
function consumeRecentDismissedTap(triggerEl, windowMs = 600) {
    if (!(triggerEl instanceof HTMLElement)) return false;
    const ts = Number(triggerEl.dataset.wboDismissedTapAt || 0);
    delete triggerEl.dataset.wboDismissedTapAt;
    return ts > 0 && Date.now() - ts < windowMs;
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
        trigger.className = 'wbo-mobile-editor-trigger';
        trigger.innerHTML = `
            <span class="wbo-mobile-trigger-text">--- 选择以编辑 ---</span>
            <i class="fa-solid fa-chevron-down wbo-mobile-trigger-chev"></i>
        `;
        trigger.addEventListener('click', (ev) => {
            if (consumeRecentDismissedTap(trigger)) {
                ev.preventDefault();
                ev.stopPropagation();
                return;
            }
            ev.preventDefault();
            ev.stopPropagation();
            closeAllOpenWorldDropdowns({ except: 'editor' });
            openMobileEditorPickerSheet();
        });
        // Mirror native `<select>` geometry ONCE while `<select>` is still visible (zero forced reflow on subsequent toggles!)
        mirrorNativeSelectAppearance(selectEl, trigger);
        selectEl.insertAdjacentElement('afterend', trigger);
    } else if (!_nativeAppearanceCache.has(selectEl)) {
        mirrorNativeSelectAppearance(selectEl, trigger);
    }

    selectEl.classList.add('wbo-mobile-select-hidden');
    syncMobileEditorTriggerLabel();
}

/**
 * Resolve palette for in-host dropdown popovers outside the Group Manager modal:
 * defaults to `'host'` (follows active SillyTavern theme seamlessly) unless user explicitly opts out.
 */
function getOutsideDropdownPalette() {
    if (_latestSettings?.outsideDropdownFollowHostTheme !== false) {
        return 'host';
    }
    return _latestSettings?.themePalette || 'classic';
}

/**
 * Resolve light/dark class for in-host dropdown popovers (always matches host when following host theme).
 */
function detectMobilePickerThemeClass() {
    if (_latestSettings?.outsideDropdownFollowHostTheme === false) {
        const mode = _latestSettings?.themeMode || 'auto';
        if (mode === 'light') return 'wbo-theme-light';
        if (mode === 'dark') return 'wbo-theme-dark';
    }
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
        if (_closeMobileEditorPicker) {
            _closeMobileEditorPicker();
        } else {
            existingOverlay.remove();
            triggerEl.classList.remove('is-open');
        }
        return;
    }

    syncEditorBeforeOpen();

    if (!_latestSettings.dropdownCollapsed || typeof _latestSettings.dropdownCollapsed !== 'object') {
        _latestSettings.dropdownCollapsed = {};
    }

    // Build live option list from `#world_editor_select` synced to live `world_names` indices
    syncSelectOptionsWithLiveWorldNames(selectEl, _editorDetachedMap);
    const optValueByRealName = new Map();
    selectEl.querySelectorAll('option').forEach((opt) => {
        if (opt.value !== '') {
            optValueByRealName.set((opt.textContent || '').trim(), opt.value);
        }
    });
    const currentSelectedOpt = selectEl.selectedOptions?.[0];
    const currentSelectedVal = currentSelectedOpt && currentSelectedOpt.value !== '' ? currentSelectedOpt.value : '';
    const currentSelectedName =
        currentSelectedOpt && currentSelectedOpt.value !== '' ? (currentSelectedOpt.textContent || '').trim() : '';
    const activeEditName = currentSelectedName || _currentlyEditingWorld || '';

    const editorHiddenSet = new Set(
        Array.isArray(_latestSettings.editorHiddenGroupIds)
            ? _latestSettings.editorHiddenGroupIds
            : (_latestSettings.hideCharBooksByDefault !== false ? [SPECIAL_GROUPS.CHARACTER] : []),
    );
    const currentChatAvatar = _latestSettings.pinCurrentChatCharBookInEditor !== false
        ? getCurrentCharacterAvatar()
        : null;
    const bareNames = new Set();
    const bareBooks = [];
    for (const [realName] of optValueByRealName.entries()) {
        const meta = _latestClassification.byName?.get(realName);
        const isCurrentChatCharBook = Boolean(
            currentChatAvatar &&
            meta?.charOwners?.some((o) => o.avatar === currentChatAvatar),
        );
        const isEditing = Boolean(activeEditName && realName === activeEditName);
        const gid = meta?.groupId || SPECIAL_GROUPS.UNGROUPED;
        const isFromHiddenGroup = Boolean(!_latestSettings.showCharBooks && editorHiddenSet.has(gid));
        if (isCurrentChatCharBook || (isEditing && isFromHiddenGroup)) {
            bareNames.add(realName);
            bareBooks.push(meta || {
                realName,
                primaryTitle: realName,
                subtitle: '',
                searchableText: realName.toLowerCase(),
                isPinned: Boolean(_latestSettings.pinnedBooks?.includes?.(realName)),
            });
        }
    }
    bareBooks.sort((a, b) => {
        const pa = _latestClassification?.byName?.get(a.realName)?.isPinned ? 1 : 0;
        const pb = _latestClassification?.byName?.get(b.realName)?.isPinned ? 1 : 0;
        if (pa !== pb) return pb - pa;
        const ea = activeEditName && a.realName === activeEditName ? 1 : 0;
        const eb = activeEditName && b.realName === activeEditName ? 1 : 0;
        if (ea !== eb) return eb - ea;
        const ca = currentChatAvatar && a.charOwners?.some((o) => o.avatar === currentChatAvatar) ? 1 : 0;
        const cb = currentChatAvatar && b.charOwners?.some((o) => o.avatar === currentChatAvatar) ? 1 : 0;
        if (ca !== cb) return cb - ca;
        return compareZhCn(a.primaryTitle || a.realName, b.primaryTitle || b.realName);
    });

    const sortSectionBooksPinnedFirst = (list) => [...list].sort((a, b) => {
        const pa = _latestClassification?.byName?.get(a.realName)?.isPinned ? 1 : 0;
        const pb = _latestClassification?.byName?.get(b.realName)?.isPinned ? 1 : 0;
        if (pa !== pb) return pb - pa;
        return 0;
    });

    const sections = orderSectionsForExternalDropdown(_latestClassification.orderedSections || [])
        .map((sec) => {
            const books = sortSectionBooksPinnedFirst(
                (sec.books || []).filter((b) => optValueByRealName.has(b.realName) && !bareNames.has(b.realName)),
            );
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

    const overlay = document.createElement('div');
    overlay.id = MOBILE_PICKER_OVERLAY_ID;
    overlay.className = 'wbo-mp-backdrop';

    const popover = document.createElement('div');
    popover.className = `wbo-modal wbo-mp-popover ${detectMobilePickerThemeClass()}`;
    popover.setAttribute('data-wbo-palette', getOutsideDropdownPalette());

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

    const scrollRestoreTimers = [];
    let restoringScroll = true;
    const cancelScrollRestore = () => {
        restoringScroll = false;
        while (scrollRestoreTimers.length) clearTimeout(scrollRestoreTimers.pop());
    };
    let initialVw = globalThis.innerWidth || document.documentElement.clientWidth || 390;
    let lockedOpenAbove = null;

    // Anchor popover directly below (or above if near bottom) the trigger box, clamped inside visualViewport
    const positionPopover = ({ preserveDirection = false } = {}) => {
        const rect = triggerEl.getBoundingClientRect();
        const vw = globalThis.innerWidth || document.documentElement.clientWidth || 390;
        const layoutVh = globalThis.innerHeight || document.documentElement.clientHeight || 800;
        const vv = globalThis.visualViewport;
        const effectiveTop = vv ? Math.max(6, vv.offsetTop || 0) : 6;
        const effectiveBottom = vv && Number.isFinite(vv.height)
            ? Math.min(layoutVh, (vv.offsetTop || 0) + vv.height)
            : layoutVh;
        const margin = 10;
        const popWidth = Math.min(Math.max(rect.width + 64, 280), vw - margin * 2);
        const left = Math.max(margin, Math.min(rect.left, vw - popWidth - margin));

        const spaceBelow = Math.max(0, effectiveBottom - rect.bottom - 10);
        const spaceAbove = Math.max(0, rect.top - effectiveTop - 10);
        const keepDir = preserveDirection || popover.contains(document.activeElement);
        let openAbove;
        if (lockedOpenAbove === null || !keepDir) {
            openAbove = spaceBelow < 220 && spaceAbove > spaceBelow;
            lockedOpenAbove = openAbove;
        } else {
            openAbove = lockedOpenAbove;
            if (openAbove && spaceAbove < 120 && spaceBelow > spaceAbove + 40) {
                openAbove = false;
                lockedOpenAbove = false;
            } else if (!openAbove && spaceBelow < 120 && spaceAbove > spaceBelow + 40) {
                openAbove = true;
                lockedOpenAbove = true;
            }
        }

        popover.style.width = `${Math.round(popWidth)}px`;
        popover.style.left = `${Math.round(left)}px`;

        const availTotal = Math.max(120, Math.floor(effectiveBottom - effectiveTop));
        const minClampH = Math.min(120, availTotal);
        if (openAbove) {
            const desiredEdgeFromTop = Math.max(
                effectiveTop + minClampH,
                Math.min(rect.top - 4, effectiveBottom - 6),
            );
            const availAbove = Math.max(120, Math.floor(desiredEdgeFromTop - effectiveTop));
            const maxH = Math.max(120, Math.min(420, availAbove));
            popover.style.top = 'auto';
            popover.style.bottom = `${Math.round(layoutVh - desiredEdgeFromTop)}px`;
            popover.style.maxHeight = `${maxH}px`;
        } else {
            const maxTopAllowed = Math.max(effectiveTop, effectiveBottom - minClampH - 6);
            const topPx = Math.max(effectiveTop, Math.min(rect.bottom + 4, maxTopAllowed));
            const availBelow = Math.max(120, Math.floor(effectiveBottom - topPx - 6));
            const maxH = Math.max(120, Math.min(420, availBelow));
            popover.style.bottom = 'auto';
            popover.style.top = `${Math.round(topPx)}px`;
            popover.style.maxHeight = `${maxH}px`;
        }
    };
    positionPopover();

    /** @type {MutationObserver | null} */
    let wiDrawerObserver = null;
    const onGlobalDismiss = (ev) => {
        const t = ev?.target instanceof Element ? ev.target : null;
        if (t && (popover.contains(t) || triggerEl.contains(t))) return;
        if (isPointInsideElementRect(ev, triggerEl)) {
            triggerEl.dataset.wboDismissedTapAt = String(Date.now());
        }
        closePicker();
    };
    const onViewportChange = (ev) => {
        const curVw = globalThis.innerWidth || document.documentElement.clientWidth || initialVw;
        const activeEl = document.activeElement;
        const isInputFocused = Boolean(activeEl && popover.contains(activeEl));
        const isOrientation = ev?.type === 'orientationchange';
        if (isInputFocused || Math.abs(curVw - initialVw) <= 60) {
            if (isOrientation && isInputFocused) {
                initialVw = curVw;
            }
            positionPopover({ preserveDirection: !isOrientation || !isInputFocused });
            return;
        }
        if (isOrientation || Math.abs(curVw - initialVw) > 60) {
            closePicker();
        }
    };

    const closePicker = () => {
        cancelScrollRestore();
        if (_closeMobileEditorPicker === closePicker) {
            _closeMobileEditorPicker = null;
        }
        _openCustomPickerClosers.delete(pickerCloserEntry);
        if (wiDrawerObserver) {
            wiDrawerObserver.disconnect();
            wiDrawerObserver = null;
        }
        document.removeEventListener('pointerdown', onGlobalDismiss, true);
        globalThis.removeEventListener('resize', onViewportChange);
        globalThis.removeEventListener('orientationchange', onViewportChange);
        globalThis.visualViewport?.removeEventListener('resize', onViewportChange);
        globalThis.visualViewport?.removeEventListener('scroll', onViewportChange);
        overlay.remove();
        triggerEl.classList.remove('is-open');
        flushPinDirtyOnClose();
    };
    _closeMobileEditorPicker = closePicker;
    const pickerCloserEntry = ({ except } = {}) => {
        if (except !== 'editor') closePicker();
    };
    _openCustomPickerClosers.add(pickerCloserEntry);

    // Immediately dismiss the dropdown whenever `#WorldInfo` drawer closes, any top-bar drawer icon is tapped,
    // or unfocused orientation/width changes — never close/rebuild while the soft keyboard is resizing height!
    const wiDrawer = document.getElementById('WorldInfo');
    if (wiDrawer) {
        wiDrawerObserver = new MutationObserver(() => {
            if (wiDrawer.classList.contains('closedDrawer') || !triggerEl.isConnected) {
                closePicker();
            }
        });
        wiDrawerObserver.observe(wiDrawer, { attributes: true, attributeFilter: ['class', 'style'] });
    }
    document.addEventListener('pointerdown', onGlobalDismiss, true);
    globalThis.addEventListener('resize', onViewportChange);
    globalThis.addEventListener('orientationchange', onViewportChange);
    globalThis.visualViewport?.addEventListener('resize', onViewportChange, { passive: true });
    globalThis.visualViewport?.addEventListener('scroll', onViewportChange, { passive: true });

    bindDrawerSafeBubbleGuard(overlay);
    bindDrawerSafeBubbleGuard(popover);
    overlay.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (ev.target === overlay) closePicker();
    });

    const pillsEl = popover.querySelector('#wbo-mp-pills');
    const expandBtn = popover.querySelector('#wbo-mp-expand');
    const syncExpand = bindDropdownPillsExpansion(pillsEl, expandBtn);
    const searchInput = popover.querySelector('#wbo-mp-search');
    const listEl = popover.querySelector('#wbo-mp-list');

    const getPinnedBooks = () => {
        const list = [];
        const seen = new Set();
        for (const b of bareBooks) {
            if (b.isPinned && !seen.has(b.realName)) {
                seen.add(b.realName);
                list.push(b);
            }
        }
        for (const sec of sections) {
            for (const b of sec.books) {
                if (b.isPinned && !seen.has(b.realName)) {
                    seen.add(b.realName);
                    list.push(b);
                }
            }
        }
        return list;
    };

    const renderPills = () => {
        if (!pillsEl) return;
        const totalCount = bareBooks.length + sections.reduce((sum, s) => sum + s.books.length, 0);
        const pinnedCount = getPinnedBooks().length;
        const items = [
            { id: SPECIAL_GROUPS.ALL, label: '全部', count: totalCount, color: '' },
            ...(pinnedCount > 0 || activePillId === SPECIAL_GROUPS.PINNED
                ? [{ id: SPECIAL_GROUPS.PINNED, label: '★ 已置顶', count: pinnedCount, color: '' }]
                : []),
            ...sections.map((s) => ({ id: s.id, label: s.name, count: s.books.length, color: s.color })),
        ];
        pillsEl.innerHTML = items.map((p) => `
            <button type="button" class="wbo-pill${activePillId === p.id ? ' is-active' : ''}" data-mp-pill="${escHtml(p.id)}">
                ${p.color ? `<span class="wbo-pill-dot" style="background:${escHtml(p.color)}"></span>` : ''}
                <span>${escHtml(p.label)}</span>
                <span class="wbo-pill-count">${p.count}</span>
            </button>
        `).join('');
        syncExpand();
    };

    const renderMpRowHtml = (b) => {
        const optVal = optValueByRealName.get(b.realName) || '';
        const isCurrent = b.realName === (getCurrentEditorWorldName() || _currentlyEditingWorld);
        const isPinned = Boolean(b.isPinned);
        return `
            <div class="wbo-mp-row${isCurrent ? ' is-selected' : ''}">
                <button type="button" class="wbo-mp-row-main" data-mp-val="${escHtml(optVal)}" data-mp-world="${escHtml(b.realName)}">
                    <span class="wbo-mp-row-text">
                        <span class="wbo-mp-row-title">${escHtml(b.primaryTitle)}</span>
                        ${b.subtitle ? `<span class="wbo-mp-row-sub">${escHtml(b.subtitle)}</span>` : ''}
                    </span>
                </button>
                <div class="wbo-mp-row-actions">
                    ${isCurrent ? '<span class="wbo-s2-badge is-editing" data-wbo-ui="1" data-wbo-editing-badge="1">当前编辑</span>' : ''}
                    ${isCurrent ? '<i class="fa-solid fa-check wbo-mp-check"></i>' : ''}
                    <button type="button" class="wbo-mp-pin-btn${isPinned ? ' is-pinned' : ''}" data-mp-pin="${escHtml(b.realName)}" title="${isPinned ? '取消置顶' : '置顶此世界书'}" aria-pressed="${isPinned ? 'true' : 'false'}">${isPinned ? '★' : '☆'}</button>
                </div>
            </div>
        `;
    };

    const renderList = () => {
        if (!listEl) return;
        const q = searchQuery.trim().toLowerCase();
        const tokens = q ? q.split(/\s+/).filter(Boolean) : [];
        if (!q && activePillId === SPECIAL_GROUPS.PINNED) {
            const pinned = getPinnedBooks();
            listEl.innerHTML = pinned.length > 0
                ? `<div class="wbo-mp-sec"><div class="wbo-mp-sec-head is-static"><span class="wbo-mp-dot-ind">•</span><span class="wbo-group-name">★ 已置顶</span><span class="wbo-group-count">${pinned.length}</span></div><div class="wbo-mp-sec-body">${pinned.map(renderMpRowHtml).join('')}</div></div>`
                : '<div class="wbo-empty-hint">暂无置顶世界书，点击行右侧 ☆ 可置顶</div>';
            return;
        }
        const isIsolated = !q && activePillId !== SPECIAL_GROUPS.ALL;

        const matchingBare = !isIsolated
            ? (tokens.length > 0
                ? bareBooks.filter((b) => tokens.every((tok) => (b.searchableText || b.realName.toLowerCase()).includes(tok)))
                : bareBooks)
            : [];
        const bareHtml = matchingBare.length > 0
            ? `<div class="wbo-mp-sec wbo-mp-bare-sec"><div class="wbo-mp-sec-body">${matchingBare.map(renderMpRowHtml).join('')}</div></div>`
            : '';

        const secHtml = sections.map((sec) => {
            if (isIsolated && sec.id !== activePillId) return '';
            const books = tokens.length > 0
                ? sec.books.filter((b) => tokens.every((tok) => (b.searchableText || b.realName.toLowerCase()).includes(tok)))
                : sec.books;
            if (books.length === 0) return '';
            const collapsed = !q && !isIsolated && Boolean(_latestSettings.dropdownCollapsed[sec.id]);
            const rowsHtml = collapsed
                ? ''
                : books.map(renderMpRowHtml).join('');

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

        const html = `${bareHtml}${secHtml}`;
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

    // Track touch/pointer scroll distance so swiping through a long list NEVER accidentally selects an item
    let listPointerStart = null;
    let listMovedDuringGesture = false;
    listEl?.addEventListener('pointerdown', (ev) => {
        listPointerStart = { x: ev.clientX, y: ev.clientY };
        listMovedDuringGesture = false;
    }, { passive: true });
    listEl?.addEventListener('pointermove', (ev) => {
        if (!listPointerStart) return;
        if (Math.hypot(ev.clientX - listPointerStart.x, ev.clientY - listPointerStart.y) > 8) {
            listMovedDuringGesture = true;
        }
    }, { passive: true });

    listEl?.addEventListener('click', (ev) => {
        if (listMovedDuringGesture) {
            listMovedDuringGesture = false;
            return;
        }
        const target = ev.target instanceof Element ? ev.target : null;
        if (!target) return;
        const pinBtn = target.closest('[data-mp-pin]');
        if (pinBtn) {
            ev.preventDefault();
            ev.stopPropagation();
            const pinWorld = pinBtn.getAttribute('data-mp-pin') || '';
            if (pinWorld) {
                const nextPinned = toggleWorldPinFromNative(pinWorld);
                for (const b of bareBooks) {
                    if (b.realName === pinWorld) b.isPinned = nextPinned;
                }
                for (const sec of sections) {
                    for (const b of sec.books) {
                        if (b.realName === pinWorld) b.isPinned = nextPinned;
                    }
                }
                const prevTop = listEl.scrollTop;
                renderPills();
                renderList();
                listEl.scrollTop = prevTop;
            }
            return;
        }
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
                if (nextBtn) scrollContentToItem(listEl, nextBtn);
            } else {
                listEl.scrollTop = prevTop;
            }
            return;
        }
        const rowBtn = target.closest('[data-mp-val]');
        if (rowBtn) {
            const realName = (rowBtn.getAttribute('data-mp-world') || '').trim();
            let val = rowBtn.getAttribute('data-mp-val') ?? '';
            if (realName) {
                const liveMap = getLiveWorldIndexMap();
                if (liveMap.size > 0 && !liveMap.has(realName)) {
                    setCurrentlyEditingWorld(null);
                    _pendingClearedEditingWorld = false;
                    val = '';
                    const prevApplying = _isApplying;
                    _isApplying = true;
                    try {
                        syncSelectOptionsWithLiveWorldNames(selectEl, _editorDetachedMap);
                    } finally {
                        _editorSelectObserver?.takeRecords();
                        _isApplying = prevApplying;
                    }
                } else {
                    ensureEditorOptionAttached(realName);
                    const liveOpt = Array.from(selectEl.querySelectorAll('option')).find(
                        (opt) => opt.value !== '' && (opt.textContent || '').trim() === realName,
                    );
                    if (liveOpt) {
                        val = liveOpt.value;
                    } else if (liveMap.size > 0) {
                        val = liveMap.get(realName) ?? '';
                    }
                }
            }
            if (val !== '' && listEl) rememberEditorListAnchor(realName, rowBtn.closest('.wbo-mp-row'), listEl, activePillId);
            selectOptionValue(val);
        }
    });

    if (searchInput instanceof HTMLInputElement) {
        let composing = false;
        let searchTimer = null;
        searchInput.addEventListener('compositionstart', () => { composing = true; });
        searchInput.addEventListener('compositionend', () => {
            composing = false;
            clearTimeout(searchTimer);
            searchQuery = searchInput.value;
            renderList();
        });
        searchInput.addEventListener('input', () => {
            if (composing) return;
            searchQuery = searchInput.value;
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => { renderList(); }, 80);
        });
    }

    renderPills();
    renderList();
    if (listEl) {
        const restore = () => {
            if (!restoringScroll) return;
            restoreEditorListPosition(listEl, activePillId, (name) =>
                listEl.querySelector(`[data-mp-world="${CSS.escape(name)}"]`)?.closest('.wbo-mp-row'));
        };
        popover.addEventListener('pointerdown', cancelScrollRestore, { capture: true, once: true });
        popover.addEventListener('wheel', cancelScrollRestore, { passive: true, once: true });
        searchInput?.addEventListener('input', cancelScrollRestore, { once: true });
        requestAnimationFrame(restore);
        for (const delay of [35, 110, 220]) scrollRestoreTimers.push(setTimeout(restore, delay));
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
/**
 * Apply native filtering safely while suppressing self-triggered MutationObserver loops.
 * When `deferGlobal` is true (e.g. instant `#wbo-hdr-show-char` tap on mobile), updates
 * `#world_editor_select` first on the immediate frame and schedules `#world_info` right after
 * so the tapped toolbar responds without waiting on 200+ global `<option>` mutations.
 * @param {any} classification
 * @param {Record<string, any>} settings
 * @param {{ force?: boolean, deferGlobal?: boolean }} [opts]
 */
export function applyAllNativeWorldFilters(classification, settings, { force = false, deferGlobal = false } = {}) {
    _latestClassification = classification;
    _latestSettings = settings;
    if (force) {
        _lastGlobalSignature = null;
        _lastEditorSignature = null;
    }
    clearTimeout(_deferredGlobalTimer);
    _deferredGlobalTimer = null;

    if (_isApplying) return;
    _isApplying = true;
    try {
        if (deferGlobal) {
            applyEditorWorldSelectFilter(classification, settings);
        } else {
            applyGlobalWorldSelectFilter(classification, settings);
            applyEditorWorldSelectFilter(classification, settings);
        }
    } finally {
        // CRITICAL: flush mutation records generated by our own DOM updates BEFORE
        // releasing `_isApplying`, otherwise MutationObserver fires on the next microtask
        // and creates an infinite Select2 destroy/rebuild oscillation loop!
        _globalSelectObserver?.takeRecords();
        _editorSelectObserver?.takeRecords();
        _isApplying = false;
    }

    if (deferGlobal) {
        _deferredGlobalTimer = setTimeout(() => {
            _deferredGlobalTimer = null;
            if (_isApplying || !_latestClassification || !_latestSettings) return;
            _isApplying = true;
            try {
                applyGlobalWorldSelectFilter(_latestClassification, _latestSettings);
            } finally {
                _globalSelectObserver?.takeRecords();
                _isApplying = false;
            }
        }, 60);
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
    const liveIndexMap = getLiveWorldIndexMap();
    const liveVal = liveIndexMap.get(clean);
    if (liveIndexMap.size > 0 && liveVal === undefined) {
        if (_currentlyEditingWorld === clean) {
            _currentlyEditingWorld = null;
        }
    } else {
        setCurrentlyEditingWorld(clean);
    }

    const selectEl = document.getElementById('world_editor_select');
    if (!selectEl) return;

    const matchingAttached = Array.from(selectEl.querySelectorAll('option')).filter(
        (opt) => opt.value !== '' && (opt.textContent || '').trim() === clean,
    );

    const prevApplying = _isApplying;
    _isApplying = true;
    try {
        if (matchingAttached.length > 0) {
            const keep = matchingAttached.find((o) => o.selected) || matchingAttached[0];
            for (const dup of matchingAttached) {
                if (dup !== keep) dup.remove();
            }
            if (liveVal !== undefined && keep.value !== liveVal) {
                keep.value = liveVal;
            }
            if (_editorDetachedMap.has(clean)) {
                _editorDetachedMap.delete(clean);
            }
            _lastEditorSignature = null;
        } else if (_editorDetachedMap.has(clean)) {
            const opt = _editorDetachedMap.get(clean);
            _editorDetachedMap.delete(clean);
            if (opt) {
                if (liveVal !== undefined) opt.value = liveVal;
                selectEl.appendChild(opt);
            }
            _lastEditorSignature = null;
        } else if (liveVal !== undefined) {
            const opt = document.createElement('option');
            opt.value = liveVal;
            opt.textContent = clean;
            selectEl.appendChild(opt);
            _lastEditorSignature = null;
        }

        if (liveIndexMap.size > 0) {
            syncSelectOptionsWithLiveWorldNames(selectEl, _editorDetachedMap);
            _lastEditorSignature = null;
        }
    } finally {
        _editorSelectObserver?.takeRecords();
        _isApplying = prevApplying;
    }
}

/**
 * Programmatically open a worldbook in the native editor — even if it belongs to
 * the currently hidden character group!
 * @param {string} realName
 * @returns {boolean}
 */
export function openWorldInNativeEditor(realName, { focusUid = null } = {}) {
    const clean = String(realName ?? '').trim();
    if (!clean) return false;
    ensureEditorOptionAttached(clean);

    // Re-apply cleanly if classification is ready so optgroups stay tidy
    if (_latestClassification && _latestSettings) {
        applyAllNativeWorldFilters(_latestClassification, _latestSettings);
    }

    const selectEl = document.getElementById('world_editor_select');
    if (!selectEl) return false;

    const prevApplying = _isApplying;
    _isApplying = true;
    try {
        if (getLiveWorldIndexMap().size > 0) {
            syncSelectOptionsWithLiveWorldNames(selectEl, _editorDetachedMap);
        }
    } finally {
        _editorSelectObserver?.takeRecords();
        _isApplying = prevApplying;
    }

    const targetOpt = Array.from(selectEl.querySelectorAll('option')).find(
        (opt) => opt.value !== '' && (opt.textContent || '').trim() === clean,
    );
    if (!targetOpt) return false;

    const liveVal = getLiveWorldIndexMap().get(clean);
    if (liveVal !== undefined && targetOpt.value !== liveVal) {
        targetOpt.value = liveVal;
    }

    for (const o of Array.from(selectEl.querySelectorAll('option'))) {
        o.selected = o === targetOpt;
    }
    const $ = globalThis.jQuery;
    if ($) {
        $(selectEl).val(targetOpt.value).trigger('change');
    } else {
        selectEl.value = targetOpt.value;
        selectEl.dispatchEvent(new Event('change', { bubbles: true }));
    }
    syncMobileEditorTriggerLabel();

    // Expand WorldInfo drawer if currently closed
    const drawer = document.getElementById('WorldInfo');
    if (drawer && drawer.classList.contains('closedDrawer')) {
        const icon = document.querySelector('#WI-SP-button .drawer-icon');
        if (icon instanceof HTMLElement) icon.click();
    }

    // Optionally scroll & softly highlight a specific entry UID once SillyTavern renders `#world_popup_entries_list`
    if (focusUid !== null && focusUid !== undefined && String(focusUid).trim() !== '') {
        const uidStr = String(focusUid).trim();
        let tries = 0;
        const locateEntry = () => {
            const list = document.getElementById('world_popup_entries_list');
            const entryEl = list?.querySelector(`.world_entry[uid="${CSS.escape(uidStr)}"]`);
            if (entryEl instanceof HTMLElement) {
                revealNativeEntryGroup(clean, uidStr);
                scrollNativeWorldEntry(entryEl);
                entryEl.classList.add('wbo-entry-locate-flash');
                setTimeout(() => entryEl.classList.remove('wbo-entry-locate-flash'), 1800);
                return;
            }
            if (tries < 15) {
                tries += 1;
                setTimeout(locateEntry, 120);
            }
        };
        setTimeout(locateEntry, 180);
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

    // Only re-hide a detached hidden book (char group or user-excluded global group) if it was deactivated
    if (!active && _latestClassification && _latestSettings) {
        const meta = _latestClassification.byName?.get(clean);
        const globalHiddenList = Array.isArray(_latestSettings.globalHiddenGroupIds)
            ? _latestSettings.globalHiddenGroupIds
            : (_latestSettings.hideCharBooksByDefault !== false ? [SPECIAL_GROUPS.CHARACTER] : []);
        const isGloballyHidden = Boolean(meta && globalHiddenList.includes(meta.groupId));
        if (isGloballyHidden && !_latestSettings.showCharBooks) {
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
 * Batch-switch or overlay multiple global worldbooks in `#world_info` in a SINGLE pass,
 * firing `change` at most once so switching a 10-book combo never triggers 10 host saves.
 *
 * @param {Iterable<string>} targetBookNames
 * @param {{ mode?: 'replace' | 'add' }} [opts]
 * @returns {{ ok: boolean, changed: boolean, prevActive: string[], nextActive: string[], missing: string[] }}
 */
export function setGlobalWorldsBatch(targetBookNames, { mode = 'replace' } = {}) {
    const cleanTargets = [
        ...new Set(
            Array.from(targetBookNames || [])
                .map((n) => String(n ?? '').trim())
                .filter(Boolean),
        ),
    ];
    const selectEl = document.getElementById('world_info');
    if (!(selectEl instanceof HTMLSelectElement)) {
        return { ok: false, changed: false, prevActive: [], nextActive: [], missing: cleanTargets };
    }

    const prevActive = [];
    const optByName = new Map();
    for (const opt of Array.from(selectEl.querySelectorAll('option'))) {
        if (opt.value === '') continue;
        const name = (opt.textContent || '').trim();
        if (!name) continue;
        optByName.set(name, opt);
        if (opt.selected) prevActive.push(name);
    }

    const wantSet = mode === 'add'
        ? new Set([...prevActive, ...cleanTargets])
        : new Set(cleanTargets);

    const toReattach = [];
    const missing = [];
    for (const name of cleanTargets) {
        if (!optByName.has(name)) {
            if (_globalDetachedMap.has(name)) {
                toReattach.push(name);
            } else {
                missing.push(name);
            }
        }
    }

    if (toReattach.length > 0) {
        _isApplying = true;
        try {
            const frag = document.createDocumentFragment();
            for (const name of toReattach) {
                const opt = _globalDetachedMap.get(name);
                if (opt) {
                    _globalDetachedMap.delete(name);
                    frag.appendChild(opt);
                    optByName.set(name, opt);
                }
            }
            selectEl.appendChild(frag);
            _lastGlobalSignature = null;
        } finally {
            _globalSelectObserver?.takeRecords();
            _isApplying = false;
        }
    }

    let changedCount = 0;
    const nextActive = [];
    for (const [name, opt] of optByName.entries()) {
        const nextSel = wantSet.has(name);
        if (opt.selected !== nextSel) {
            opt.selected = nextSel;
            changedCount += 1;
        }
        if (nextSel) nextActive.push(name);
    }

    if (changedCount > 0) {
        const prevFocus = document.activeElement;
        const $ = globalThis.jQuery;
        if ($) {
            $(selectEl).trigger('change');
        } else {
            selectEl.dispatchEvent(new Event('change', { bubbles: true }));
        }
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
        if (_latestClassification && _latestSettings) {
            setTimeout(() => {
                if (_latestClassification && _latestSettings) {
                    applyAllNativeWorldFilters(_latestClassification, _latestSettings);
                }
            }, 0);
        }
    }

    return {
        ok: true,
        changed: changedCount > 0,
        prevActive,
        nextActive,
        missing,
    };
}

/**
 * Build grouped section metadata for any `<select>` popup based on its live `<option>`s.
 * Optionally pins currently selected options (`已选附加书`) and hoists the current character's
 * own books bare at the top (without a `当前角色` wrapper).
 *
 * @param {HTMLSelectElement} selectEl
 * @param {{ currentAvatar?: string | null, prioritizeCharGroup?: boolean, pinSelectedSection?: boolean }} [opts]
 */
function buildPopupGroupedSections(
    selectEl,
    { currentAvatar = null, prioritizeCharGroup = false, pinSelectedSection = false } = {},
) {
    const optByRealName = new Map();
    selectEl.querySelectorAll('option').forEach((opt) => {
        if (opt.value === '') return;
        const realName = (opt.dataset.wboRealName || opt.textContent || '').trim();
        opt.dataset.wboRealName = realName;
        if (realName && !optByRealName.has(realName)) {
            optByRealName.set(realName, opt);
        }
    });

    /** @type {Array<{ realName: string, primaryTitle: string, subtitle: string, searchableText: string, value: string, selected: boolean, isPinned?: boolean }>} */
    const bareBooks = [];
    /** @type {Array<{ id: string, name: string, color: string, books: Array<{ realName: string, primaryTitle: string, subtitle: string, searchableText: string, value: string, selected: boolean, isPinned?: boolean }> }>} */
    const sections = [];
    const placed = new Set();

    // For multi-select (e.g. Extra Worldbooks), pin already-selected books right at the very top!
    if (pinSelectedSection) {
        const selectedBooks = [];
        for (const [realName, opt] of optByRealName.entries()) {
            if (!opt.selected) continue;
            const meta = _latestClassification?.byName?.get(realName);
            placed.add(realName);
            selectedBooks.push({
                realName,
                primaryTitle: meta?.primaryTitle || realName,
                subtitle: meta?.subtitle || '',
                searchableText: meta?.searchableText || realName.toLowerCase(),
                value: opt.value,
                selected: true,
                isPinned: Boolean(meta?.isPinned),
            });
        }
        if (selectedBooks.length > 0) {
            selectedBooks.sort((a, b) => {
                const pa = _latestClassification?.byName?.get(a.realName)?.isPinned ? 1 : 0;
                const pb = _latestClassification?.byName?.get(b.realName)?.isPinned ? 1 : 0;
                if (pa !== pb) return pb - pa;
                return compareZhCn(a.primaryTitle, b.primaryTitle);
            });
            sections.push({
                id: '__selected_extras__',
                name: '已选附加书',
                color: '#4c6ef5',
                books: selectedBooks,
            });
        }
    }

    if (currentAvatar) {
        for (const [realName, opt] of optByRealName.entries()) {
            if (placed.has(realName)) continue;
            const meta = _latestClassification?.byName?.get(realName);
            const belongsToCurrent = Boolean(
                meta?.charOwners?.some((o) => o.avatar === currentAvatar),
            );
            if (belongsToCurrent) {
                placed.add(realName);
                bareBooks.push({
                    realName,
                    primaryTitle: meta?.primaryTitle || realName,
                    subtitle: meta?.subtitle || '',
                    searchableText: meta?.searchableText || realName.toLowerCase(),
                    value: opt.value,
                    selected: opt.selected,
                    isPinned: Boolean(meta?.isPinned),
                });
            }
        }
        if (bareBooks.length > 1) {
            bareBooks.sort((a, b) => {
                const pa = _latestClassification?.byName?.get(a.realName)?.isPinned ? 1 : 0;
                const pb = _latestClassification?.byName?.get(b.realName)?.isPinned ? 1 : 0;
                if (pa !== pb) return pb - pa;
                return compareZhCn(a.primaryTitle, b.primaryTitle);
            });
        }
    }

    let baseOrdered = orderSectionsForExternalDropdown(_latestClassification?.orderedSections || []);
    if (prioritizeCharGroup) {
        // For Primary worldbook binding: place `角色世界书` at top while keeping `未分组` last
        baseOrdered = orderSectionsForExternalDropdown(
            [...baseOrdered].sort((a, b) => {
                if (a.id === SPECIAL_GROUPS.CHARACTER && b.id !== SPECIAL_GROUPS.CHARACTER) return -1;
                if (b.id === SPECIAL_GROUPS.CHARACTER && a.id !== SPECIAL_GROUPS.CHARACTER) return 1;
                return 0;
            }),
        );
    }

    for (const sec of baseOrdered) {
        const books = [];
        for (const b of sec.books || []) {
            if (placed.has(b.realName)) continue;
            const opt = optByRealName.get(b.realName);
            if (!opt) continue;
            placed.add(b.realName);
            books.push({
                realName: b.realName,
                primaryTitle: b.primaryTitle || b.realName,
                subtitle: b.subtitle || '',
                searchableText: b.searchableText || b.realName.toLowerCase(),
                value: opt.value,
                selected: opt.selected,
                isPinned: Boolean(b.isPinned),
            });
        }
        if (books.length > 0) {
            books.sort((a, b) => {
                const pa = _latestClassification?.byName?.get(a.realName)?.isPinned ? 1 : 0;
                const pb = _latestClassification?.byName?.get(b.realName)?.isPinned ? 1 : 0;
                if (pa !== pb) return pb - pa;
                return 0;
            });
            sections.push({
                id: sec.id,
                name: sec.name,
                color: sec.color || '#8c99a6',
                books,
            });
        }
    }

    // Any remaining options not in classification
    const leftovers = [];
    for (const [realName, opt] of optByRealName.entries()) {
        if (placed.has(realName)) continue;
        leftovers.push({
            realName,
            primaryTitle: realName,
            subtitle: '',
            searchableText: realName.toLowerCase(),
            value: opt.value,
            selected: opt.selected,
        });
    }
    if (leftovers.length > 0) {
        sections.push({
            id: '__other__',
            name: '其他',
            color: '#8c99a6',
            books: leftovers,
        });
    }

    return { bareBooks, sections, optByRealName };
}

/**
 * Attach a clean, in-place anchored grouped+searchable dropdown trigger to ANY native `<select>`
 * (both single-select and `<select multiple>`), safely rendering inside `<dialog>` top-layer!
 *
 * @param {HTMLSelectElement} selectEl
 * @param {{
 *   multiple?: boolean,
 *   currentAvatar?: string | null,
 *   collapseCharByDefault?: boolean,
 *   prioritizeCharGroup?: boolean,
 *   placeholder?: string,
 * }} [opts]
 */
const groupedSelectControls = new WeakMap();

export function closeGroupedSelectControl(selectEl) {
    return groupedSelectControls.get(selectEl)?.closePopover() ?? false;
}

export function attachGroupedSelectControl(
    selectEl,
    {
        multiple = false,
        currentAvatar = null,
        collapseCharByDefault = true,
        prioritizeCharGroup = false,
        placeholder = '--- 未选择 ---',
    } = {},
) {
    if (!selectEl) return;
    const existing = groupedSelectControls.get(selectEl);
    if (existing) {
        existing.syncTriggerText();
        return;
    }
    if (!_latestClassification || !_latestSettings) return;
    selectEl.dataset.wboGroupedControl = '1';
    const panelRoot = selectEl.closest('.weg-modal-backdrop');

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'wbo-mobile-editor-trigger wbo-popup-select-trigger';
    trigger.setAttribute('aria-expanded', 'false');
    if (selectEl.getAttribute('aria-label')) trigger.setAttribute('aria-label', selectEl.getAttribute('aria-label'));
    trigger.innerHTML = `
        <span class="wbo-mobile-trigger-text"></span>
        <i class="fa-solid fa-chevron-down wbo-mobile-trigger-chev"></i>
    `;

    const syncTriggerText = () => {
        trigger.disabled = selectEl.disabled;
        const textSpan = trigger.querySelector('.wbo-mobile-trigger-text');
        if (!textSpan) return;
        const selectedOpts = Array.from(selectEl.selectedOptions || []).filter((o) => o.value !== '');
        if (selectedOpts.length === 0) {
            const ph = multiple
                ? placeholder
                : (selectEl.querySelector('option[value=""]')?.textContent?.trim() || placeholder);
            textSpan.textContent = ph;
            trigger.classList.add('is-placeholder');
            return;
        }
        trigger.classList.remove('is-placeholder');
        const names = selectedOpts.map((opt) => {
            const realName = (opt.dataset.wboRealName || opt.textContent || '').trim();
            return _latestClassification?.byName?.get(realName)?.primaryTitle || realName;
        });
        textSpan.textContent = multiple
            ? (names.length <= 2 ? names.join('、') : `已选 ${names.length} 本：${names.slice(0, 2).join('、')}…`)
            : names[0];
    };

    const localCollapsed = {};
    if (collapseCharByDefault) {
        localCollapsed[SPECIAL_GROUPS.CHARACTER] = true;
    }

    let openOverlay = null;
    let removeGlobalDismiss = null;
    const closePopover = () => {
        if (!openOverlay) return false;
        _openCustomPickerClosers.delete(popoverCloserEntry);
        if (removeGlobalDismiss) {
            removeGlobalDismiss();
            removeGlobalDismiss = null;
        }
        if (openOverlay) {
            openOverlay.remove();
            openOverlay = null;
        }
        trigger.classList.remove('is-open');
        trigger.setAttribute('aria-expanded', 'false');
        flushPinDirtyOnClose();
        return true;
    };
    const popoverCloserEntry = () => closePopover();

    const openPopover = () => {
        if (openOverlay) {
            closePopover();
            return;
        }
        closeAllOpenWorldDropdowns();

        const { bareBooks, sections } = buildPopupGroupedSections(selectEl, {
            currentAvatar,
            prioritizeCharGroup,
            pinSelectedSection: multiple,
        });
        let activePillId = SPECIAL_GROUPS.ALL;
        let searchQuery = '';

        // CRITICAL: mount inside `<dialog>` when inside SillyTavern's native Popup so we stay in top-layer!
        const mountRoot = panelRoot || selectEl.closest('dialog') || document.body;

        const overlay = document.createElement('div');
        overlay.className = 'wbo-mp-backdrop';
        openOverlay = overlay;

        const popover = document.createElement('div');
        popover.className = `wbo-modal wbo-mp-popover ${detectMobilePickerThemeClass()}`;
        popover.setAttribute('data-wbo-palette', getOutsideDropdownPalette());

        const getSelectedValSet = () =>
            new Set(Array.from(selectEl.selectedOptions || []).map((o) => o.value).filter((v) => v !== ''));

        popover.innerHTML = `
            <div class="wbo-mp-top">
                <div class="wbo-search-wrap wbo-mp-search-wrap">
                    <i class="fa-solid fa-magnifying-glass"></i>
                    <input type="search" class="wbo-search-input" id="wbo-pop-search" placeholder="搜索世界书 / 角色名..." autocomplete="off" spellcheck="false">
                </div>
                ${panelRoot ? '' : `<button type="button" class="wbo-mp-clear-btn" id="wbo-pop-clear"${getSelectedValSet().size > 0 ? '' : ' hidden'}>清除</button>`}
            </div>
            <div class="wbo-mp-pills-row"${sections.length < 2 ? ' hidden' : ''}>
                <div class="wbo-pills-rail">
                    <div class="wbo-pills" id="wbo-pop-pills"></div>
                    <button type="button" class="wbo-pill-expand-btn" id="wbo-pop-expand" title="展开全部分组"${sections.length < 3 ? ' hidden' : ''}>
                        <i class="fa-solid fa-chevron-down"></i>
                    </button>
                </div>
            </div>
            <div class="wbo-mp-list" id="wbo-pop-list"></div>
        `;

        overlay.appendChild(popover);
        mountRoot.appendChild(overlay);
        trigger.classList.add('is-open');
        trigger.setAttribute('aria-expanded', 'true');
        overlay.addEventListener('keydown', (event) => {
            if (event.key !== 'Escape' || event.isComposing) return;
            event.stopPropagation();
            closePopover();
        });

        let lockedOpenAbove = null;
        const positionPopover = ({ preserveDirection = false } = {}) => {
            const rect = trigger.getBoundingClientRect();
            const vw = globalThis.innerWidth || document.documentElement.clientWidth || 390;
            const layoutVh = globalThis.innerHeight || document.documentElement.clientHeight || 800;
            const vv = globalThis.visualViewport;
            const effectiveTop = vv ? Math.max(6, vv.offsetTop || 0) : 6;
            const effectiveBottom = vv && Number.isFinite(vv.height)
                ? Math.min(layoutVh, (vv.offsetTop || 0) + vv.height)
                : layoutVh;
            const margin = 10;
            const popWidth = Math.min(Math.max(rect.width, 280), vw - margin * 2);
            const left = Math.max(margin, Math.min(rect.left, vw - popWidth - margin));

            const spaceBelow = Math.max(0, effectiveBottom - rect.bottom - 10);
            const spaceAbove = Math.max(0, rect.top - effectiveTop - 10);
            const keepDir = preserveDirection || popover.contains(document.activeElement);
            let openAbove;
            if (lockedOpenAbove === null || !keepDir) {
                openAbove = spaceBelow < 210 && spaceAbove > spaceBelow;
                lockedOpenAbove = openAbove;
            } else {
                openAbove = lockedOpenAbove;
                if (openAbove && spaceAbove < 120 && spaceBelow > spaceAbove + 40) {
                    openAbove = false;
                    lockedOpenAbove = false;
                } else if (!openAbove && spaceBelow < 120 && spaceAbove > spaceBelow + 40) {
                    openAbove = true;
                    lockedOpenAbove = true;
                }
            }

            popover.style.width = `${Math.round(popWidth)}px`;
            popover.style.left = `${Math.round(left)}px`;

            const availTotal = Math.max(120, Math.floor(effectiveBottom - effectiveTop));
            const minClampH = Math.min(120, availTotal);
            if (openAbove) {
                const desiredEdgeFromTop = Math.max(
                    effectiveTop + minClampH,
                    Math.min(rect.top - 4, effectiveBottom - 6),
                );
                const availAbove = Math.max(120, Math.floor(desiredEdgeFromTop - effectiveTop));
                const maxH = Math.max(120, Math.min(390, availAbove));
                popover.style.top = 'auto';
                popover.style.bottom = `${Math.round(layoutVh - desiredEdgeFromTop)}px`;
                popover.style.maxHeight = `${maxH}px`;
            } else {
                const maxTopAllowed = Math.max(effectiveTop, effectiveBottom - minClampH - 6);
                const topPx = Math.max(effectiveTop, Math.min(rect.bottom + 4, maxTopAllowed));
                const availBelow = Math.max(120, Math.floor(effectiveBottom - topPx - 6));
                const maxH = Math.max(120, Math.min(390, availBelow));
                popover.style.bottom = 'auto';
                popover.style.top = `${Math.round(topPx)}px`;
                popover.style.maxHeight = `${maxH}px`;
            }
        };
        positionPopover();

        bindDrawerSafeBubbleGuard(overlay);
        bindDrawerSafeBubbleGuard(popover);
        const onGlobalDismiss = (ev) => {
            const t = ev?.target instanceof Element ? ev.target : null;
            if (t && (popover.contains(t) || trigger.contains(t))) return;
            if (isPointInsideElementRect(ev, trigger)) {
                trigger.dataset.wboDismissedTapAt = String(Date.now());
            }
            closePopover();
        };
        const onViewportChange = (ev) => {
            const isOrientation = ev?.type === 'orientationchange';
            positionPopover({ preserveDirection: !isOrientation });
        };
        document.addEventListener('pointerdown', onGlobalDismiss, true);
        globalThis.addEventListener('resize', onViewportChange);
        globalThis.addEventListener('orientationchange', onViewportChange);
        globalThis.visualViewport?.addEventListener('resize', onViewportChange, { passive: true });
        globalThis.visualViewport?.addEventListener('scroll', onViewportChange, { passive: true });
        removeGlobalDismiss = () => {
            document.removeEventListener('pointerdown', onGlobalDismiss, true);
            globalThis.removeEventListener('resize', onViewportChange);
            globalThis.removeEventListener('orientationchange', onViewportChange);
            globalThis.visualViewport?.removeEventListener('resize', onViewportChange);
            globalThis.visualViewport?.removeEventListener('scroll', onViewportChange);
        };
        _openCustomPickerClosers.add(popoverCloserEntry);
        overlay.addEventListener('click', (ev) => {
            ev.stopPropagation();
            if (ev.target === overlay) closePopover();
        });

        const pillsEl = popover.querySelector('#wbo-pop-pills');
        const expandBtn = popover.querySelector('#wbo-pop-expand');
        const syncExpand = bindDropdownPillsExpansion(pillsEl, expandBtn);
        const clearBtn = popover.querySelector('#wbo-pop-clear');
        const searchInput = popover.querySelector('#wbo-pop-search');
        const listEl = popover.querySelector('#wbo-pop-list');

        const getPinnedBooks = () => {
            const list = [];
            const seen = new Set();
            for (const b of bareBooks) {
                if ((_latestClassification?.byName?.get(b.realName)?.isPinned ?? b.isPinned) && !seen.has(b.realName)) {
                    seen.add(b.realName);
                    list.push(b);
                }
            }
            for (const sec of sections) {
                for (const b of sec.books) {
                    if ((_latestClassification?.byName?.get(b.realName)?.isPinned ?? b.isPinned) && !seen.has(b.realName)) {
                        seen.add(b.realName);
                        list.push(b);
                    }
                }
            }
            return list;
        };

        const renderPills = () => {
            if (!pillsEl) return;
            const totalCount = bareBooks.length + sections.reduce((sum, s) => sum + s.books.length, 0);
            const pinnedCount = getPinnedBooks().length;
            const items = [
                { id: SPECIAL_GROUPS.ALL, label: '全部', count: totalCount, color: '' },
                ...(pinnedCount > 0 || activePillId === SPECIAL_GROUPS.PINNED
                    ? [{ id: SPECIAL_GROUPS.PINNED, label: '★ 已置顶', count: pinnedCount, color: '' }]
                    : []),
                ...sections.map((s) => ({ id: s.id, label: s.name, count: s.books.length, color: s.color })),
            ];
            pillsEl.innerHTML = items.map((p) => `
                <button type="button" class="wbo-pill${activePillId === p.id ? ' is-active' : ''}" data-pop-pill="${escHtml(p.id)}">
                    ${p.color ? `<span class="wbo-pill-dot" style="background:${escHtml(p.color)}"></span>` : ''}
                    <span>${escHtml(p.label)}</span>
                    <span class="wbo-pill-count">${p.count}</span>
                </button>
            `).join('');
            syncExpand();
        };

        const renderPopRowHtml = (b, selectedSet) => {
            const isSel = selectedSet.has(b.value);
            const isPinned = Boolean(_latestClassification?.byName?.get(b.realName)?.isPinned ?? b.isPinned);
            const pinHtml = `<button type="button" class="wbo-mp-pin-btn${isPinned ? ' is-pinned' : ''}" data-pop-pin="${escHtml(b.realName)}" title="${isPinned ? '取消置顶' : '置顶此世界书'}" aria-pressed="${isPinned ? 'true' : 'false'}">${isPinned ? '★' : '☆'}</button>`;
            if (multiple) {
                return `
                    <div class="wbo-mp-row is-multi-row${isSel ? ' is-selected' : ''}" data-pop-row-val="${escHtml(b.value)}">
                        <span class="wbo-mp-row-text">
                            <span class="wbo-mp-row-title">${escHtml(b.primaryTitle)}</span>
                            ${b.subtitle ? `<span class="wbo-mp-row-sub">${escHtml(b.subtitle)}</span>` : ''}
                        </span>
                        <div class="wbo-mp-row-actions">
                            ${pinHtml}
                            <button type="button" class="wbo-mp-toggle-pill${isSel ? ' is-on' : ''}" data-pop-toggle-val="${escHtml(b.value)}">
                                ${isSel ? '<i class="fa-solid fa-check"></i><span>已选</span>' : '<span>添加</span>'}
                            </button>
                        </div>
                    </div>
                `;
            }
            return `
                <div class="wbo-mp-row${isSel ? ' is-selected' : ''}">
                    <button type="button" class="wbo-mp-row-main" data-pop-val="${escHtml(b.value)}">
                        <span class="wbo-mp-row-text">
                            <span class="wbo-mp-row-title">${escHtml(b.primaryTitle)}</span>
                            ${b.subtitle ? `<span class="wbo-mp-row-sub">${escHtml(b.subtitle)}</span>` : ''}
                        </span>
                    </button>
                    <div class="wbo-mp-row-actions">
                        ${isSel ? '<i class="fa-solid fa-check wbo-mp-check"></i>' : ''}
                        ${pinHtml}
                    </div>
                </div>
            `;
        };

        const renderList = () => {
            if (!listEl) return;
            const selectedSet = getSelectedValSet();
            if (clearBtn instanceof HTMLElement) clearBtn.hidden = selectedSet.size === 0;
            const q = searchQuery.trim().toLowerCase();
            const tokens = q ? q.split(/\s+/).filter(Boolean) : [];
            if (!q && activePillId === SPECIAL_GROUPS.PINNED) {
                const pinned = getPinnedBooks();
                listEl.innerHTML = pinned.length > 0
                    ? `<div class="wbo-mp-sec"><div class="wbo-mp-sec-head is-static"><span class="wbo-mp-dot-ind">•</span><span class="wbo-group-name">★ 已置顶</span><span class="wbo-group-count">${pinned.length}</span></div><div class="wbo-mp-sec-body">${pinned.map((b) => renderPopRowHtml(b, selectedSet)).join('')}</div></div>`
                    : '<div class="wbo-empty-hint">暂无置顶世界书，点击行右侧 ☆ 可置顶</div>';
                return;
            }
            const isIsolated = !q && activePillId !== SPECIAL_GROUPS.ALL;

            const matchingBare = !isIsolated
                ? (tokens.length > 0
                    ? bareBooks.filter((b) => tokens.every((tok) => b.searchableText.includes(tok)))
                    : bareBooks)
                : [];
            const bareHtml = matchingBare.length > 0
                ? `<div class="wbo-mp-sec wbo-mp-bare-sec"><div class="wbo-mp-sec-body">${matchingBare.map((b) => renderPopRowHtml(b, selectedSet)).join('')}</div></div>`
                : '';

            const secHtml = sections.map((sec) => {
                if (isIsolated && sec.id !== activePillId) return '';
                const books = tokens.length > 0
                    ? sec.books.filter((b) => tokens.every((tok) => b.searchableText.includes(tok)))
                    : sec.books;
                if (books.length === 0) return '';
                const collapsed = !q && !isIsolated && Boolean(localCollapsed[sec.id]);
                const rowsHtml = collapsed
                    ? ''
                    : books.map((b) => renderPopRowHtml(b, selectedSet)).join('');

                return `
                    <div class="wbo-mp-sec${collapsed ? ' is-collapsed' : ''}">
                        <button type="button" class="wbo-mp-sec-head${isIsolated ? ' is-static' : ''}" data-pop-toggle="${escHtml(sec.id)}">
                            ${isIsolated ? '<span class="wbo-mp-dot-ind">•</span>' : `<i class="fa-solid ${collapsed ? 'fa-chevron-right' : 'fa-chevron-down'} wbo-chevron"></i>`}
                            <span class="wbo-group-dot" style="background:${escHtml(sec.color)}"></span>
                            <span class="wbo-group-name">${escHtml(sec.name)}</span>
                            <span class="wbo-group-count">${books.length}</span>
                        </button>
                        ${collapsed ? '' : `<div class="wbo-mp-sec-body">${rowsHtml}</div>`}
                    </div>
                `;
            }).filter(Boolean).join('');

            const html = `${bareHtml}${secHtml}`;
            listEl.innerHTML = html || '<div class="wbo-empty-hint">无匹配世界书</div>';
        };

        const fireSelectChange = () => {
            const $ = globalThis.jQuery;
            if ($ && !panelRoot) {
                $(selectEl).trigger('change');
            } else {
                selectEl.dispatchEvent(new Event('change', { bubbles: true }));
            }
            syncTriggerText();
        };

        clearBtn?.addEventListener('click', () => {
            if (multiple) {
                for (const opt of Array.from(selectEl.options)) {
                    opt.selected = false;
                }
                fireSelectChange();
                renderList();
            } else {
                selectEl.value = '';
                fireSelectChange();
                closePopover();
            }
        });

        pillsEl?.addEventListener('click', (ev) => {
            const btn = ev.target instanceof Element ? ev.target.closest('[data-pop-pill]') : null;
            if (!btn) return;
            const gid = btn.getAttribute('data-pop-pill') || SPECIAL_GROUPS.ALL;
            activePillId = (gid === activePillId && gid !== SPECIAL_GROUPS.ALL) ? SPECIAL_GROUPS.ALL : gid;
            renderPills();
            renderList();
            if (listEl) listEl.scrollTop = 0;
        });

        // Prevent scroll-swipes from accidentally toggling or selecting a worldbook row
        let popStart = null;
        let popMoved = false;
        listEl?.addEventListener('pointerdown', (ev) => {
            popStart = { x: ev.clientX, y: ev.clientY };
            popMoved = false;
        }, { passive: true });
        listEl?.addEventListener('pointermove', (ev) => {
            if (!popStart) return;
            if (Math.hypot(ev.clientX - popStart.x, ev.clientY - popStart.y) > 8) {
                popMoved = true;
            }
        }, { passive: true });

        listEl?.addEventListener('click', (ev) => {
            if (popMoved) {
                popMoved = false;
                return;
            }
            const target = ev.target instanceof Element ? ev.target : null;
            if (!target) return;
            const pinBtn = target.closest('[data-pop-pin]');
            if (pinBtn) {
                ev.preventDefault();
                ev.stopPropagation();
                const pinWorld = pinBtn.getAttribute('data-pop-pin') || '';
                if (pinWorld) {
                    const nextPinned = toggleWorldPinFromNative(pinWorld);
                    for (const b of bareBooks) {
                        if (b.realName === pinWorld) b.isPinned = nextPinned;
                    }
                    for (const sec of sections) {
                        for (const b of sec.books) {
                            if (b.realName === pinWorld) b.isPinned = nextPinned;
                        }
                    }
                    const prevTop = listEl.scrollTop;
                    renderPills();
                    renderList();
                    listEl.scrollTop = prevTop;
                }
                return;
            }
            const toggleBtn = target.closest('[data-pop-toggle]');
            if (toggleBtn) {
                if (activePillId !== SPECIAL_GROUPS.ALL || searchQuery.trim()) return;
                const gid = toggleBtn.getAttribute('data-pop-toggle');
                if (!gid) return;
                const willCollapse = !localCollapsed[gid];
                localCollapsed[gid] = willCollapse;
                const prevTop = listEl.scrollTop;
                renderList();
                if (willCollapse) {
                    const nextBtn = listEl.querySelector(`[data-pop-toggle="${CSS.escape(gid)}"]`);
                    if (nextBtn) scrollContentToItem(listEl, nextBtn);
                } else {
                    listEl.scrollTop = prevTop;
                }
                return;
            }
            if (multiple) {
                const pillBtn = target.closest('[data-pop-toggle-val]');
                if (!pillBtn) return;
                const val = pillBtn.getAttribute('data-pop-toggle-val') ?? '';
                const opt = Array.from(selectEl.options).find((o) => o.value === val);
                if (!opt) return;
                const nextSel = !opt.selected;
                opt.selected = nextSel;
                fireSelectChange();
                const rowEl = pillBtn.closest('.wbo-mp-row');
                rowEl?.classList.toggle('is-selected', nextSel);
                pillBtn.classList.toggle('is-on', nextSel);
                pillBtn.innerHTML = nextSel
                    ? '<i class="fa-solid fa-check"></i><span>已选</span>'
                    : '<span>添加</span>';
                if (clearBtn instanceof HTMLElement) {
                    clearBtn.hidden = getSelectedValSet().size === 0;
                }
                return;
            }
            const rowBtn = target.closest('[data-pop-val]');
            if (rowBtn) {
                const val = rowBtn.getAttribute('data-pop-val') ?? '';
                selectEl.value = val;
                fireSelectChange();
                closePopover();
            }
        });

        if (searchInput instanceof HTMLInputElement) {
            let composing = false;
            let searchTimer = null;
            searchInput.addEventListener('compositionstart', () => { composing = true; });
            searchInput.addEventListener('compositionend', () => {
                composing = false;
                clearTimeout(searchTimer);
                searchQuery = searchInput.value;
                renderList();
            });
            searchInput.addEventListener('input', () => {
                if (composing) return;
                searchQuery = searchInput.value;
                clearTimeout(searchTimer);
                searchTimer = setTimeout(() => { renderList(); }, 80);
            });
        }

        renderPills();
        renderList();
    };

    trigger.addEventListener('click', (ev) => {
        if (consumeRecentDismissedTap(trigger)) {
            ev.preventDefault();
            ev.stopPropagation();
            return;
        }
        ev.preventDefault();
        ev.stopPropagation();
        openPopover();
    });

    selectEl.insertAdjacentElement('afterend', trigger);
    mirrorNativeSelectAppearance(selectEl, trigger);
    selectEl.classList.add('wbo-mobile-select-hidden');
    selectEl.addEventListener('change', syncTriggerText);
    groupedSelectControls.set(selectEl, { syncTriggerText, closePopover });
    syncTriggerText();
}

/**
 * Enhance a desktop Select2 multi-select (`extrasSelect` inside `.character_world` `<dialog>`)
 * with `<optgroup>` grouping, collapsible sticky headers, and an in-dropdown group pill bar —
 * WITHOUT ever calling `select2('destroy')` so `dropdownParent: popupDialog` stays 100% intact!
 * @param {HTMLSelectElement} extrasSelect
 * @param {string | null} currentAvatar
 */
function enhanceDesktopExtrasSelect2(extrasSelect, currentAvatar) {
    const $ = globalThis.jQuery;
    if (!$ || !extrasSelect) return;
    const $sel = $(extrasSelect);
    if (!$sel.data('select2')) return;

    const rebuildExtrasOptgroups = () => {
        // First unwrap any existing optgroups without losing option.selected
        const existingGroups = Array.from(extrasSelect.querySelectorAll('optgroup'));
        if (existingGroups.length > 0) {
            const unwrapFrag = document.createDocumentFragment();
            for (const g of existingGroups) {
                while (g.firstChild) unwrapFrag.appendChild(g.firstChild);
                g.remove();
            }
            extrasSelect.appendChild(unwrapFrag);
        }

        const { bareBooks, sections } = buildPopupGroupedSections(extrasSelect, {
            currentAvatar,
            prioritizeCharGroup: false,
            pinSelectedSection: true,
        });
        const optMap = new Map();
        for (const opt of Array.from(extrasSelect.querySelectorAll('option'))) {
            if (opt.value !== '') optMap.set(opt.value, opt);
        }

        if (sections.length >= 2) {
            const frag = document.createDocumentFragment();
            for (const b of bareBooks) {
                const opt = optMap.get(b.value);
                if (opt) frag.appendChild(opt);
            }
            for (const sec of sections) {
                const grp = document.createElement('optgroup');
                grp.label = `${sec.name} (${sec.books.length})`;
                grp.setAttribute('data-wbo-group', sec.id);
                for (const b of sec.books) {
                    const opt = optMap.get(b.value);
                    if (opt) grp.appendChild(opt);
                }
                if (grp.childElementCount > 0) frag.appendChild(grp);
            }
            extrasSelect.appendChild(frag);
        } else if (bareBooks.length > 0) {
            const frag = document.createDocumentFragment();
            for (const b of bareBooks) {
                const opt = optMap.get(b.value);
                if (opt) frag.appendChild(opt);
            }
            for (const sec of sections) {
                for (const b of sec.books) {
                    const opt = optMap.get(b.value);
                    if (opt) frag.appendChild(opt);
                }
            }
            extrasSelect.appendChild(frag);
        }
    };

    rebuildExtrasOptgroups();

    patchExistingSelect2InPlace($sel, {
        matcher: customSelect2Matcher,
        templateResult: (state) => renderSelect2OptionResult(state, { showGroupPill: false }),
    });

    const localCollapsed = {};
    if (_latestSettings?.autoHideInCharBindPopup) {
        localCollapsed[SPECIAL_GROUPS.CHARACTER] = true;
    }
    let activePillId = SPECIAL_GROUPS.ALL;

    $sel.off('select2:opening.wboExtras select2:open.wboExtras')
        .on('select2:opening.wboExtras', () => {
            rebuildExtrasOptgroups();
        })
        .on('select2:open.wboExtras', () => {
        requestAnimationFrame(() => {
            const inst = $sel.data('select2');
            const dropdownEl = inst?.$dropdown?.[0];
            if (!(dropdownEl instanceof HTMLElement)) return;
            const resultsList = dropdownEl.querySelector('.select2-results__options');
            if (!(resultsList instanceof HTMLElement)) return;

            ensureSelect2RowsHavePinBtn(resultsList);
            if (resultsList.dataset.wboExtrasPinBound !== '1') {
                resultsList.dataset.wboExtrasPinBound = '1';
                bindDrawerSafeBubbleGuard(dropdownEl);
                bindSelect2PinHandlers(resultsList);
                const pinObs = new MutationObserver(() => ensureSelect2RowsHavePinBtn(resultsList));
                pinObs.observe(resultsList, { childList: true, subtree: true });
            }

            const labelToId = new Map();
            const pillSections = [];
            extrasSelect.querySelectorAll('optgroup[data-wbo-group]').forEach((og) => {
                const gid = og.getAttribute('data-wbo-group');
                const lbl = og.label || '';
                if (gid && lbl) {
                    labelToId.set(lbl, gid);
                    pillSections.push({ id: gid, label: lbl.replace(/\s*\((\d+)\)$/, ' $1') });
                }
            });
            if (pillSections.length < 2) return;

            dropdownEl.querySelector('.wbo-dd-filter-bar')?.remove();
            const built = createDropdownFilterBar(pillSections, activePillId);
            const barEl = built.barEl;

            const syncGroups = () => {
                const searchField = extrasSelect.parentElement?.querySelector('.select2-search__field');
                const searching = searchField instanceof HTMLInputElement && searchField.value.trim().length > 0;
                const isIsolated = !searching && activePillId !== SPECIAL_GROUPS.ALL;
                resultsList.querySelectorAll(':scope > li.select2-results__option--group').forEach((li) => {
                    const head = li.querySelector(':scope > .select2-results__group');
                    if (!(head instanceof HTMLElement)) return;
                    const gid = labelToId.get((head.textContent || '').trim());
                    if (!gid) return;
                    head.classList.add('wbo-dd-group-head');
                    head.classList.toggle('is-isolated', isIsolated);
                    head.setAttribute('data-wbo-dd-group', gid);
                    li.classList.toggle('wbo-dd-group-hidden', isIsolated && gid !== activePillId);
                    li.classList.toggle('wbo-dd-collapsed', !searching && !isIsolated && Boolean(localCollapsed[gid]));
                });
            };

            barEl.addEventListener('mousedown', (ev) => ev.stopPropagation());
            barEl.addEventListener('click', (ev) => {
                ev.stopPropagation();
                const btn = ev.target instanceof Element ? ev.target.closest('.wbo-dd-pill') : null;
                if (!btn) return;
                ev.preventDefault();
                const gid = btn.getAttribute('data-wbo-pill') || SPECIAL_GROUPS.ALL;
                activePillId = (gid === activePillId && gid !== SPECIAL_GROUPS.ALL) ? SPECIAL_GROUPS.ALL : gid;
                barEl.querySelectorAll('.wbo-dd-pill').forEach((b) => {
                    b.classList.toggle('is-active', b.getAttribute('data-wbo-pill') === activePillId);
                });
                syncGroups();
                resultsList.scrollTop = 0;
            });

            resultsList._wboExtrasState = {
                getActivePillId: () => activePillId,
                localCollapsed,
                syncGroups,
            };
            if (resultsList.dataset.wboExtrasListBound !== '1') {
                resultsList.dataset.wboExtrasListBound = '1';
                bindDrawerSafeBubbleGuard(dropdownEl);
                bindSelect2PinHandlers(resultsList);
                resultsList.addEventListener('mousedown', (ev) => {
                    const head = ev.target instanceof Element ? ev.target.closest('.wbo-dd-group-head') : null;
                    if (!head) return;
                    ev.preventDefault();
                    ev.stopPropagation();
                    const st = resultsList._wboExtrasState;
                    if (!st || st.getActivePillId() !== SPECIAL_GROUPS.ALL) return;
                    const gid = head.getAttribute('data-wbo-dd-group');
                    if (!gid) return;
                    st.localCollapsed[gid] = !st.localCollapsed[gid];
                    st.syncGroups();
                }, true);
                resultsList.addEventListener('mouseup', (ev) => {
                    if (ev.target instanceof Element && ev.target.closest('.wbo-dd-group-head')) {
                        ev.preventDefault();
                        ev.stopPropagation();
                    }
                }, true);
                resultsList.addEventListener('click', (ev) => {
                    if (ev.target instanceof Element && ev.target.closest('.wbo-dd-group-head')) {
                        ev.preventDefault();
                        ev.stopPropagation();
                    }
                }, true);
            }

            const resultsContainer = dropdownEl.querySelector('.select2-results');
            if (resultsContainer) {
                resultsContainer.parentElement?.insertBefore(barEl, resultsContainer);
            }
            const searchField = extrasSelect.parentElement?.querySelector('.select2-search__field');
            if (searchField instanceof HTMLInputElement && searchField.dataset.wboExtrasSearch !== '1') {
                searchField.dataset.wboExtrasSearch = '1';
                searchField.addEventListener('input', () => requestAnimationFrame(syncGroups));
            }
            syncGroups();
        });
    });
}

/**
 * Enhance a dynamically opened `.character_world` ("Link to World Info") popup:
 * - Zero intrusive top filter bars!
 * - Primary Worldbook gets an in-place grouped+searchable dropdown pinning `当前角色` first
 *   and keeping `角色世界书` easily accessible (collapsed by default if `autoHideInCharBindPopup`).
 * - Extra Worldbooks get grouped `<optgroup>` + in-dropdown pills on desktop Select2,
 *   and an in-place multi-select grouped+searchable dropdown on mobile!
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
    const collapseChar = Boolean(_latestSettings.autoHideInCharBindPopup);

    // Primary worldbook: always plain `<select>` in ST -> upgrade directly to grouped+searchable dropdown!
    // Pin `当前角色` at top and keep `角色世界书` immediately available via pill/expand/search.
    if (primarySelect instanceof HTMLSelectElement) {
        attachGroupedSelectControl(primarySelect, {
            multiple: false,
            currentAvatar,
            collapseCharByDefault: collapseChar,
            prioritizeCharGroup: true,
            placeholder: '--- 无主世界书 ---',
        });
    }

    // Extra worldbooks:
    // - On desktop (`!isNativeMobileSelectMode()`), SillyTavern ALWAYS initializes Select2 inside `Popup.onOpen`
    //   (which may run slightly after the `<dialog>` is appended!). Wait cleanly for Select2 and patch it in place;
    //   NEVER attach a duplicate native trigger button below desktop Select2!
    // - On mobile (`isNativeMobileSelectMode()`), SillyTavern skips Select2 -> attach our clean single-line
    //   grouped+searchable multi-select control.
    if (extrasSelect instanceof HTMLSelectElement) {
        if (isNativeMobileSelectMode()) {
            attachGroupedSelectControl(extrasSelect, {
                multiple: true,
                currentAvatar,
                collapseCharByDefault: collapseChar,
                prioritizeCharGroup: false,
                placeholder: '未选择附加世界书，点击选择...',
            });
        } else {
            let attempts = 0;
            const waitDesktopSelect2 = () => {
                if (!extrasSelect.isConnected) return;
                const $ = globalThis.jQuery;
                const hasS2 = Boolean($ && ($(extrasSelect).data('select2') || $(extrasSelect).hasClass('select2-hidden-accessible')));
                if (hasS2) {
                    enhanceDesktopExtrasSelect2(extrasSelect, currentAvatar);
                    return;
                }
                if (attempts < 10) {
                    attempts += 1;
                    setTimeout(waitDesktopSelect2, 60);
                }
            };
            setTimeout(waitDesktopSelect2, 40);
        }
    }
}

/**
 * Enhance any standard SillyTavern single-select worldbook popup
 * (User Persona / Chat / Move-Copy Entry) with the same clean in-place grouped+searchable dropdown!
 * Zero external filter bars glued above the popup!
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

    attachGroupedSelectControl(selectEl, {
        multiple: false,
        currentAvatar: null,
        collapseCharByDefault: !Boolean(_latestSettings.showCharBooks),
        prioritizeCharGroup: false,
        placeholder: selectEl.querySelector('option[value=""]')?.textContent?.trim() || '--- 无 ---',
    });
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
    editorAnchor: null,
};

function rememberEditorListAnchor(name, row, host, groupId) {
    if (!name || !row || !host.clientHeight) return;
    const rowRect = row.getBoundingClientRect();
    if (!rowRect.height) return;
    const scrollHost = findScrollableListEl(row.parentElement, host);
    _dropdownMemory.editorAnchor = {
        name,
        groupId,
        outerTop: host.scrollTop,
        offset: rowRect.top - scrollHost.getBoundingClientRect().top,
    };
}

function restoreEditorListPosition(host, groupId, findRow) {
    if (!host.isConnected || !host.clientHeight) return;
    const anchor = _dropdownMemory.editorAnchor;
    if (anchor?.groupId === groupId && anchor.name === getCurrentEditorWorldName()) {
        const row = findRow(anchor.name);
        if (row?.getBoundingClientRect().height) {
            const scrollHost = findScrollableListEl(row.parentElement, host);
            if (scrollHost !== host) host.scrollTop = anchor.outerTop;
            scrollHost.scrollTop += row.getBoundingClientRect().top - scrollHost.getBoundingClientRect().top - anchor.offset;
            return;
        }
    }
    const savedTop = _dropdownMemory.scrollTopByGroup[groupId];
    if (typeof savedTop === 'number') host.scrollTop = savedTop;
}

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
    barEl.className = `wbo-dd-filter-bar${extraClass ? ` ${extraClass}` : ''}`;

    const allBtn = document.createElement('button');
    allBtn.type = 'button';
    allBtn.className = `wbo-dd-pill is-pinned-all${activePillGroupId === SPECIAL_GROUPS.ALL ? ' is-active' : ''}`;
    allBtn.setAttribute('data-wbo-pill', SPECIAL_GROUPS.ALL);
    allBtn.setAttribute('aria-pressed', String(activePillGroupId === SPECIAL_GROUPS.ALL));
    allBtn.textContent = '全部';

    const divider = document.createElement('span');
    divider.className = 'wbo-dd-divider';
    divider.setAttribute('aria-hidden', 'true');

    const scrollEl = document.createElement('div');
    scrollEl.className = 'wbo-dd-pill-scroll';
    scrollEl.innerHTML = groupItems
        .map((p) => `<button type="button" class="wbo-dd-pill${p.id === activePillGroupId ? ' is-active' : ''}" aria-pressed="${p.id === activePillGroupId}" data-wbo-pill="${escHtml(p.id)}">${escHtml(p.label)}</button>`)
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
    expandBtn.hidden = true;
    expandBtn.innerHTML = '<i class="fa-solid fa-chevron-down" aria-hidden="true"></i>';
    barEl.append(allBtn, divider, scrollEl, expandBtn);
    bindDropdownPillsExpansion(scrollEl, expandBtn, { expandedEl: barEl, remember: true });
    return { barEl, scrollEl };
}

function bindDropdownPillsExpansion(pills, button, { expandedEl = pills, remember = false } = {}) {
    if (!pills || !button) return () => {};
    let preferExpanded = false;
    button.hidden = true;
    const sync = () => {
        if (!pills.isConnected || !pills.clientWidth) return;
        const { scrollLeft, scrollTop } = pills;
        expandedEl.classList.remove('is-expanded');
        button.style.position = 'absolute';
        const overflows = pills.scrollWidth > pills.clientWidth;
        button.style.removeProperty('position');
        const expanded = overflows && (remember ? _dropdownMemory.pillsExpanded : preferExpanded);
        button.hidden = !overflows;
        button.title = expanded ? '收起为单行' : '展开查看所有分组';
        button.setAttribute('aria-expanded', String(expanded));
        const icon = button.querySelector('i');
        if (icon) icon.className = expanded ? 'fa-solid fa-chevron-up' : 'fa-solid fa-chevron-down';
        expandedEl.classList.toggle('is-expanded', expanded);
        if (expanded) pills.scrollTop = scrollTop;
        else pills.scrollLeft = scrollLeft;
    };
    button.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
    });
    button.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (button.hidden) return;
        preferExpanded = !expandedEl.classList.contains('is-expanded');
        if (remember) _dropdownMemory.pillsExpanded = preferExpanded;
        sync();
    });
    if (typeof globalThis.ResizeObserver === 'function') {
        const pillsObserver = new MutationObserver(sync);
        const sizeObserver = new globalThis.ResizeObserver(() => {
            if (pills.isConnected) sync();
            else {
                sizeObserver.disconnect();
                pillsObserver.disconnect();
            }
        });
        pillsObserver.observe(pills, { childList: true });
        sizeObserver.observe(pills);
    } else {
        requestAnimationFrame(sync);
    }
    return sync;
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
    bindDrawerSafeBubbleGuard(dropdownEl);

    const resultsList = dropdownEl.querySelector('.select2-results__options');
    if (!(resultsList instanceof HTMLElement)) return;

    const getDropdownOptionWorldName = (li) => {
        const s2Item = li.querySelector('.wbo-s2-item');
        const fromAttr = s2Item?.getAttribute('data-wbo-world') || li.querySelector('.wbo-s2-pin-btn')?.getAttribute('data-pin-world');
        if (fromAttr) return fromAttr;
        return (li.textContent || '').trim();
    };

    const getPinnedCountInSelect = () => {
        let cnt = 0;
        selectEl.querySelectorAll('option').forEach((opt) => {
            const name = (opt.textContent || '').trim();
            if (name && _latestClassification?.byName?.get(name)?.isPinned) cnt += 1;
        });
        return cnt;
    };

    // Build ordered group descriptors directly from the live `<optgroup>` elements
    const groups = Array.from(selectEl.querySelectorAll('optgroup[data-wbo-group]')).map((og) => {
        const id = og.getAttribute('data-wbo-group') || '';
        const fullLabel = og.label || '';
        const shortName = fullLabel.replace(/\s*\(\d+\)\s*$/, '').trim() || fullLabel;
        return { id, fullLabel, shortName, count: og.querySelectorAll('option').length };
    });

    const groupByLabel = new Map(groups.map((g) => [g.fullLabel, g]));
    const validGroupIds = new Set(groups.map((g) => g.id));
    if (getPinnedCountInSelect() > 0 || _dropdownMemory.activePillGroupId === SPECIAL_GROUPS.PINNED) {
        validGroupIds.add(SPECIAL_GROUPS.PINNED);
    }
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
     * Synchronize collapsible state, chevrons, pinned filter, and active pill filter onto every
     * `<li class="select2-results__option--group">` inside the open dropdown.
     */
    const decorateGroupItems = () => {
        const searching = isSearching();
        const isPinFilter = !searching && activePillGroupId === SPECIAL_GROUPS.PINNED;
        const isGroupIsolated = !searching && activePillGroupId !== SPECIAL_GROUPS.ALL && !isPinFilter;
        const groupNodes = resultsList.querySelectorAll(':scope > li.select2-results__option--group');

        if (isPinFilter) {
            resultsList.querySelectorAll('li.select2-results__option:not(.select2-results__option--group)').forEach((optLi) => {
                const name = getDropdownOptionWorldName(optLi);
                const pinned = Boolean(name && _latestClassification?.byName?.get(name)?.isPinned);
                optLi.classList.toggle('wbo-dd-pin-hidden', !pinned);
            });
        } else {
            resultsList.querySelectorAll('li.wbo-dd-pin-hidden').forEach((optLi) => {
                optLi.classList.remove('wbo-dd-pin-hidden');
            });
        }

        groupNodes.forEach((li) => {
            if (!(li instanceof HTMLElement)) return;
            const label = li.getAttribute('aria-label') || li.querySelector(':scope > .select2-results__group')?.textContent?.trim() || '';
            const desc = groupByLabel.get(label);
            const gid = desc?.id || label;
            li.setAttribute('data-wbo-dd-group', gid);

            const head = li.querySelector(':scope > .select2-results__group');
            const isIsolated = isGroupIsolated || isPinFilter;
            if (head instanceof HTMLElement) {
                head.classList.add('wbo-dd-group-head');
                head.classList.toggle('is-isolated', isIsolated);
                head.setAttribute('data-wbo-dd-group', gid);
                head.setAttribute('title', isIsolated ? '' : '点击展开或折叠该分组');
            }

            if (isPinFilter) {
                const hasPinnedChild = Boolean(li.querySelector('.select2-results__option:not(.select2-results__option--group):not(.wbo-dd-pin-hidden)'));
                li.classList.toggle('wbo-dd-group-hidden', !hasPinnedChild);
                li.classList.remove('wbo-dd-collapsed');
            } else {
                const hiddenByPill = isGroupIsolated && gid !== activePillGroupId;
                li.classList.toggle('wbo-dd-group-hidden', hiddenByPill);
                const isCollapsed = !searching && !isGroupIsolated && Boolean(_latestSettings.dropdownCollapsed[gid]);
                li.classList.toggle('wbo-dd-collapsed', isCollapsed);
            }
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

    const syncPinnedPillBtn = () => {
        if (!filterBar) return;
        const cnt = getPinnedCountInSelect();
        const scrollWrap = filterBar.querySelector('.wbo-dd-pill-scroll');
        let pinPill = filterBar.querySelector(`[data-wbo-pill="${SPECIAL_GROUPS.PINNED}"]`);
        if (cnt > 0 || activePillGroupId === SPECIAL_GROUPS.PINNED) {
            if (!pinPill && scrollWrap) {
                pinPill = document.createElement('button');
                pinPill.type = 'button';
                pinPill.className = `wbo-dd-pill${activePillGroupId === SPECIAL_GROUPS.PINNED ? ' is-active' : ''}`;
                pinPill.setAttribute('data-wbo-pill', SPECIAL_GROUPS.PINNED);
                scrollWrap.prepend(pinPill);
            }
            if (pinPill) pinPill.textContent = `★ 已置顶 ${cnt}`;
        } else if (pinPill) {
            pinPill.remove();
        }
    };

    const initialPinnedCount = getPinnedCountInSelect();
    if (groups.length >= 2 || initialPinnedCount > 0 || activePillGroupId === SPECIAL_GROUPS.PINNED) {
        const pillDescriptors = [
            ...(initialPinnedCount > 0 || activePillGroupId === SPECIAL_GROUPS.PINNED
                ? [{ id: SPECIAL_GROUPS.PINNED, label: `★ 已置顶 ${initialPinnedCount}` }]
                : []),
            ...(groups.length >= 2 ? groups.map((g) => ({ id: g.id, label: `${g.shortName} ${g.count}` })) : []),
        ];
        const built = createDropdownFilterBar(
            pillDescriptors,
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

    ensureSelect2RowsHavePinBtn(resultsList);
    const unbindPinHandlers = bindSelect2PinHandlers(resultsList, () => {
        syncPinnedPillBtn();
        decorateGroupItems();
    });

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
        const row = t?.closest('.select2-results__option:not(.select2-results__option--group)');
        if (row && !t.closest('.wbo-s2-pin-btn')) {
            cancelRestore();
            saveCurrentScroll();
            rememberEditorListAnchor(getDropdownOptionWorldName(row), row, getScrollHost(), activePillGroupId);
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
        restoreEditorListPosition(getScrollHost(), activePillGroupId, (name) =>
            resultsList.querySelector(`[data-wbo-world="${CSS.escape(name)}"]`)?.closest('.select2-results__option'));
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
        unbindPinHandlers();
        if (searchInput instanceof HTMLInputElement) {
            searchInput.removeEventListener('input', onSearchInput);
        }
        filterBar?.remove();
    };

    decorateGroupItems();
    requestAnimationFrame(applySavedScrollPositions);
    applySavedScrollPositions();
}

/** @type {(() => void) | null} */
let _openGlobalDropdownCleanup = null;
/** @type {string} */
let _activeGlobalPillId = SPECIAL_GROUPS.ALL;

function cleanupOpenGlobalDropdown() {
    if (_openGlobalDropdownCleanup) {
        try { _openGlobalDropdownCleanup(); } catch { /* ignore */ }
        _openGlobalDropdownCleanup = null;
    }
    document.querySelectorAll('.wbo-global-dd-bar').forEach((el) => el.remove());
}

/**
 * Decorate the open global Select2 dropdown without changing its options or search field.
 */
function enhanceOpenGlobalDropdown() {
    cleanupOpenGlobalDropdown();
    const $ = globalThis.jQuery;
    const globalSel = document.getElementById('world_info');
    if (!$ || !globalSel || !_latestClassification) return;

    const inst = $(globalSel).data('select2');
    const dropdownEl = inst?.$dropdown?.[0];
    if (!(dropdownEl instanceof HTMLElement)) return;
    const resultsList = dropdownEl.querySelector('.select2-results__options');
    const resultsWrap = dropdownEl.querySelector('.select2-results');
    if (!(resultsList instanceof HTMLElement) || !resultsWrap?.parentElement) return;
    bindDrawerSafeBubbleGuard(dropdownEl);

    const searchField = dropdownEl.querySelector('.select2-search__field')
        || globalSel.parentElement?.querySelector('.select2-search__field');
    const readGroups = () => {
        const counts = new Map();
        let favorites = 0;
        for (const option of globalSel.querySelectorAll('option')) {
            const meta = _latestClassification.byName.get((option.textContent || '').trim());
            if (!meta) continue;
            counts.set(meta.groupId, (counts.get(meta.groupId) || 0) + 1);
            if (meta.isPinned) favorites++;
        }
        const groups = orderSectionsForExternalDropdown(_latestClassification.orderedSections || [])
            .filter((section) => counts.has(section.id))
            .map((section) => ({ id: section.id, label: `${section.name} ${counts.get(section.id)}` }));
        if (favorites) groups.unshift({ id: SPECIAL_GROUPS.PINNED, label: `收藏 ${favorites}` });
        return groups;
    };
    _activeGlobalPillId = readGroups()[0]?.id === SPECIAL_GROUPS.PINNED ? SPECIAL_GROUPS.PINNED : SPECIAL_GROUPS.ALL;

    const header = document.createElement('li');
    header.className = 'wbo-global-favorites-heading wbo-dd-group-head is-isolated';
    header.setAttribute('role', 'presentation');
    header.textContent = '收藏';
    const syncResults = () => {
        ensureSelect2RowsHavePinBtn(resultsList);
        const favorites = [];
        for (const row of resultsList.querySelectorAll('li.select2-results__option:not(.select2-results__option--group):not(.select2-results__message)')) {
            const name = row.querySelector('.wbo-s2-item')?.getAttribute('data-wbo-world')
                || row.querySelector('.wbo-s2-pin-btn')?.getAttribute('data-pin-world')
                || (row.textContent || '').trim();
            const meta = _latestClassification.byName.get(name);
            row.classList.toggle('wbo-dd-pin-hidden', !matchesGlobalDropdownGroup(meta, _activeGlobalPillId));
            if (meta?.isPinned) favorites.push(row);
        }
        if (_activeGlobalPillId === SPECIAL_GROUPS.ALL && favorites.length) {
            resultsList.prepend(header, ...favorites);
        } else {
            header.remove();
        }
        observer.takeRecords();
    };
    const refreshResults = () => {
        if (searchField) searchField.dispatchEvent(new Event('input', { bubbles: true }));
        else inst.trigger?.('query', { term: '' });
        syncResults();
    };

    let barEl;
    let pillScrollEl;
    const renderBar = () => {
        const groups = readGroups();
        if (!groups.some((group) => group.id === _activeGlobalPillId)) _activeGlobalPillId = SPECIAL_GROUPS.ALL;
        const scrollLeft = pillScrollEl?.scrollLeft || 0;
        barEl?.remove();
        const built = createDropdownFilterBar(groups, _activeGlobalPillId, 'wbo-global-dd-bar');
        barEl = built.barEl;
        pillScrollEl = built.scrollEl;
        barEl.hidden = groups.length === 0;
        barEl.addEventListener('mousedown', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
        });
        barEl.addEventListener('click', (ev) => {
            ev.stopPropagation();
            const button = ev.target instanceof Element ? ev.target.closest('[data-wbo-pill]') : null;
            if (!button) return;
            ev.preventDefault();
            const id = button.getAttribute('data-wbo-pill') || SPECIAL_GROUPS.ALL;
            _activeGlobalPillId = id === _activeGlobalPillId ? SPECIAL_GROUPS.ALL : id;
            barEl.querySelectorAll('[data-wbo-pill]').forEach((pill) => {
                const active = pill.getAttribute('data-wbo-pill') === _activeGlobalPillId;
                pill.classList.toggle('is-active', active);
                pill.setAttribute('aria-pressed', String(active));
            });
            refreshResults();
        });
        resultsWrap.parentElement.insertBefore(barEl, resultsWrap);
        pillScrollEl.scrollLeft = scrollLeft;
    };

    const observer = new MutationObserver(syncResults);
    observer.observe(resultsList, { childList: true });
    const unbindPin = bindSelect2PinHandlers(resultsList, () => {
        renderBar();
        refreshResults();
    });
    renderBar();
    refreshResults();

    _openGlobalDropdownCleanup = () => {
        observer.disconnect();
        unbindPin();
        header.remove();
        barEl?.remove();
    };
}

/**
 * Synchronously assert our custom optgroups on the worldbook editor before opening.
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

/** @type {WeakMap<HTMLElement, MutationObserver>} */
const _containerObserverMap = new WeakMap();
/** @type {WeakMap<HTMLElement, MutationObserver>} */
const _hostObserverMap = new WeakMap();
/** @type {Set<HTMLElement>} */
const _observedContainers = new Set();
/** @type {Set<HTMLElement>} */
const _observedHosts = new Set();
/** @type {Set<MutationObserver>} */
const _activeEnhancedObservers = new Set();
/** @type {Set<any>} */
const _activePopoverRestoreTimers = new Set();
/** @type {Map<HTMLElement, { kind: 'raf' | 'timeout', id: any }>} */
const _pendingContainerEnhance = new Map();
/** @type {Set<any>} */
const _activeEnhancedRafs = new Set();
let _observersActive = false;

function scheduleEnhancedRaf(cb) {
    if (!_observersActive || typeof requestAnimationFrame !== 'function') return null;
    let done = false;
    let id = null;
    id = requestAnimationFrame(() => {
        done = true;
        if (id !== null && id !== undefined) _activeEnhancedRafs.delete(id);
        if (!_observersActive) return;
        cb();
    });
    if (!done && id !== null && id !== undefined) {
        _activeEnhancedRafs.add(id);
    }
    return id;
}

function isWboInjectedMutationNode(node) {
    if (!(node instanceof Element)) return false;
    return Boolean(
        node.hasAttribute('data-wbo-ui') ||
        node.classList.contains('wbo-pop-filter-bar') ||
        node.classList.contains('wbo-gr-pin-btn') ||
        node.classList.contains('wbo-dd-group-head') ||
        node.classList.contains('wbo-s2-right') ||
        node.classList.contains('wbo-pop-section'),
    );
}

function markIfPersistentPopover(el) {
    if (el instanceof HTMLElement && (el.hidden || el.style.display === 'none')) {
        el.dataset.wboPersistentPopover = '1';
        delete el.dataset.wboGlobalOpen;
    }
}

function hasNonWboMutation(mutations) {
    if (!Array.isArray(mutations) || mutations.length === 0) return true;
    for (const m of mutations) {
        if (m?.type === 'attributes') continue;
        const added = m?.addedNodes ? Array.from(m.addedNodes) : [];
        const removed = m?.removedNodes ? Array.from(m.removedNodes) : [];
        if (added.length === 0 && removed.length === 0) return true;
        if (added.some((n) => !isWboInjectedMutationNode(n)) || removed.some((n) => !isWboInjectedMutationNode(n))) {
            return true;
        }
    }
    return false;
}

function scheduleContainerReEnhance(containerEl) {
    if (!_observersActive || !(containerEl instanceof HTMLElement) || _pendingContainerEnhance.has(containerEl)) return;
    let done = false;
    const handle = { kind: 'timeout', id: null };
    _pendingContainerEnhance.set(containerEl, handle);
    const run = () => {
        done = true;
        _pendingContainerEnhance.delete(containerEl);
        if (!_observersActive || !containerEl.isConnected || containerEl.dataset.wboEnhancing === '1') return;
        enhanceCustomDropdownPopover(containerEl);
    };
    if (typeof requestAnimationFrame === 'function') {
        handle.kind = 'raf';
        handle.id = requestAnimationFrame(run);
    } else {
        handle.kind = 'timeout';
        handle.id = setTimeout(run, 0);
    }
    if (done) {
        _pendingContainerEnhance.delete(containerEl);
    }
}

function handleEnhancedContainerMutations(containerEl, mutations) {
    if (!_observersActive || !containerEl.isConnected || containerEl.dataset.wboEnhancing === '1') return;
    const reopeningGlobal = !containerEl.hidden && containerEl.style.display !== 'none' &&
        !containerEl.dataset.wboGlobalOpen && containerEl.dataset.wboPopoverRole === 'global';
    if (!reopeningGlobal && !hasNonWboMutation(mutations)) return;
    const nextRole = detectEnhancedPopoverRole(containerEl);
    const hasStaleState = Boolean(
        containerEl.dataset.wboPopoverRole ||
        containerEl.dataset.wboBubbleGuarded ||
        containerEl._wboPopState ||
        containerEl.querySelector('.wbo-pop-filter-bar, .wbo-preset-filter-bar'),
    );
    if (!nextRole) {
        if (hasStaleState || containerEl.dataset.wboSourceRole === 'preset') {
            enhanceCustomDropdownPopover(containerEl);
        }
        return;
    }
    const curOpts = getEnhancedOptionNodes(containerEl);
    const needsEnhance = reopeningGlobal ||
        containerEl.dataset.wboPopoverRole !== nextRole ||
        containerEl.dataset.wboPopoverReady !== '1' ||
        curOpts.some((o) => {
            const txt = getEnhancedPopoverOptionText(o);
            return txt && !txt.startsWith('---') && !o.querySelector('.wbo-gr-pin-btn');
        });
    if (needsEnhance) {
        scheduleContainerReEnhance(containerEl);
    }
}

function ensureEnhancedContainerObserver(containerEl) {
    if (!_observersActive || !(containerEl instanceof HTMLElement) || _containerObserverMap.has(containerEl)) return;
    if (typeof MutationObserver !== 'function') return;
    if (_observedContainers.size > 32) {
        for (const el of _observedContainers) {
            if (!el.isConnected) {
                const oldObs = _containerObserverMap.get(el);
                if (oldObs) {
                    try { oldObs.disconnect(); } catch { /* ignore */ }
                    _activeEnhancedObservers.delete(oldObs);
                    _containerObserverMap.delete(el);
                }
                _observedContainers.delete(el);
            }
        }
    }
    markIfPersistentPopover(containerEl);
    const containerObs = new MutationObserver((mutations) => {
        markIfPersistentPopover(containerEl);
        handleEnhancedContainerMutations(containerEl, mutations);
    });
    containerObs.observe(containerEl, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['style', 'hidden'],
    });
    _containerObserverMap.set(containerEl, containerObs);
    _observedContainers.add(containerEl);
    _activeEnhancedObservers.add(containerObs);
}

/**
 * Progressively enhance custom select popovers when they open for
 * `#world_editor_select` / `#world_info`:
 * - Reorganizes the existing live option nodes in place (preserving all click/touch
 *   listeners and styling!) into collapsible user groups + in-dropdown group filter pills!
 * @param {HTMLElement} containerEl
 */
function enhanceCustomDropdownPopover(containerEl) {
    if (!containerEl || !containerEl.isConnected) return;
    if (containerEl.dataset.wboEnhancing === '1') return;

    markIfPersistentPopover(containerEl);
    ensureEnhancedContainerObserver(containerEl);
    containerEl.dataset.wboEnhancing = '1';
    let observedHost = null;
    try {
    const detectedRole = detectEnhancedPopoverRole(containerEl);
    if (!detectedRole) {
        if (containerEl.dataset.wboSourceRole === 'preset' && _latestSettings?.adaptEnhancedPresetGroups === true
            && document.querySelector(ENHANCED_STYLE_SELECTOR)) {
            enhancePresetDropdownGroups(containerEl);
            return;
        }
        clearEnhancedPresetGroups(containerEl);
        containerEl._wboPopState?.cancelRestore?.();
        unbindDrawerSafeBubbleGuard(containerEl);
        delete containerEl.dataset.wboPopoverRole;
        delete containerEl.dataset.wboPopoverReady;
        delete containerEl.dataset.wboEditingWorld;
        delete containerEl.dataset.wboChatAvatar;
        delete containerEl.dataset.wboEnhancedStyle;
        containerEl.querySelectorAll('.wbo-pop-filter-bar').forEach((el) => el.remove());
        containerEl.querySelectorAll('.wbo-enhanced-sticky').forEach((el) => el.replaceWith(...el.children));
        containerEl.querySelectorAll('.wbo-pop-search').forEach((el) => el.remove());
        containerEl.querySelectorAll('[data-wbo-editing-badge]').forEach((el) => el.remove());
        containerEl._wboOnPinChanged = undefined;
        delete containerEl._wboPopState;
        return;
    }
    bindDrawerSafeBubbleGuard(containerEl);
    containerEl.dataset.wboPopoverRole = detectedRole;
    const isGlobalPopover = detectedRole === 'global';
    const isGlobalOpening = isGlobalPopover && !containerEl.hidden && containerEl.style.display !== 'none' && !containerEl.dataset.wboGlobalOpen;

    if (!_latestClassification || !_latestSettings || _latestClassification.byName.size === 0) {
        return;
    }

    const optionNodes = getEnhancedOptionNodes(containerEl);
    if (optionNodes.length === 0) return;

    const existingSec = optionNodes[0].closest?.('.wbo-pop-section');
    const optionsHost = existingSec?.parentElement || optionNodes[0].parentElement;
    if (!(optionsHost instanceof HTMLElement)) return;
    observedHost = optionsHost;
    const useEnhancedStyle = optionsHost.classList.contains('gr-options-container');
    if (useEnhancedStyle) containerEl.dataset.wboEnhancedStyle = '1';
    const previousGlobalScrollTop = isGlobalPopover ? findScrollableListEl(optionsHost, containerEl).scrollTop : 0;

    const globalNamesByValue = new Map();
    if (isGlobalPopover) {
        for (const option of document.getElementById('world_info')?.querySelectorAll('option') || []) {
            const name = (option.dataset.wboRealName || option.textContent || '').trim();
            if (option.value && _latestClassification.byName.has(name)) globalNamesByValue.set(option.value, name);
        }
    }
    const getOptionText = (option) => {
        const text = getEnhancedPopoverOptionText(option);
        if (!isGlobalPopover || _latestClassification.byName.has(text)) return text;
        const value = option.getAttribute('data-value');
        return globalNamesByValue.get(value) || (_latestClassification.byName.has(value) ? value : text);
    };

    // Bind in-place pin click delegation ONCE per containerEl (survives host re-renders of option children!)
    if (containerEl.dataset.wboPinDelegated !== '1') {
        containerEl.dataset.wboPinDelegated = '1';
        const blockPinEvt = (ev) => {
            const role = containerEl.dataset.wboPopoverRole;
            if (role !== 'global' && role !== 'editor') return;
            const pinBtn = ev.target instanceof Element ? ev.target.closest('.wbo-gr-pin-btn') : null;
            if (!pinBtn) return;
            ev.preventDefault();
            ev.stopPropagation();
            ev.stopImmediatePropagation();
        };
        const onGrPinClick = (ev) => {
            const role = containerEl.dataset.wboPopoverRole;
            if (role !== 'global' && role !== 'editor') return;
            const pinBtn = ev.target instanceof Element ? ev.target.closest('.wbo-gr-pin-btn') : null;
            if (!pinBtn) return;
            ev.preventDefault();
            ev.stopPropagation();
            ev.stopImmediatePropagation();
            const worldName = pinBtn.getAttribute('data-pin-world') || '';
            if (!worldName) return;
            const nextPinned = toggleWorldPinFromNative(worldName);
            containerEl.querySelectorAll('.wbo-gr-pin-btn').forEach((btn) => {
                if (btn.getAttribute('data-pin-world') === worldName) {
                    syncEnhancedPinButton(btn, nextPinned);
                }
            });
            containerEl._wboOnPinChanged?.({ worldName, isPinned: nextPinned });
        };
        containerEl.addEventListener('pointerdown', blockPinEvt, true);
        containerEl.addEventListener('mousedown', blockPinEvt, true);
        containerEl.addEventListener('mouseup', blockPinEvt, true);
        containerEl.addEventListener('touchstart', blockPinEvt, { capture: true, passive: false });
        containerEl.addEventListener('touchend', onGrPinClick, { capture: true, passive: false });
        containerEl.addEventListener('click', onGrPinClick, true);
    }

    // Watch `optionsHost` so if the host re-renders `.gr-option` items on subsequent opens without recreating `containerEl`,
    // we automatically re-inject `☆ / ★` pin buttons and group sections (or unbind if repurposed)!
    if (_observersActive && optionsHost.dataset.wboOptObserved !== '1') {
        if (_observedHosts.size > 32) {
            for (const h of _observedHosts) {
                if (!h.isConnected) {
                    const oldObs = _hostObserverMap.get(h);
                    if (oldObs) {
                        try { oldObs.disconnect(); } catch { /* ignore */ }
                        _activeEnhancedObservers.delete(oldObs);
                        _hostObserverMap.delete(h);
                    }
                    delete h.dataset.wboOptObserved;
                    _observedHosts.delete(h);
                }
            }
        }
        optionsHost.dataset.wboOptObserved = '1';
        const hostObs = new MutationObserver((mutations) => {
            handleEnhancedContainerMutations(containerEl, mutations);
        });
        hostObs.observe(optionsHost, { childList: true });
        _hostObserverMap.set(optionsHost, hostObs);
        _observedHosts.add(optionsHost);
        _activeEnhancedObservers.add(hostObs);
    }

    const editorSel = !isGlobalPopover ? document.getElementById('world_editor_select') : null;
    const selectedEditorOpt = editorSel?.selectedOptions?.[0];
    const selectedEditorName =
        selectedEditorOpt && selectedEditorOpt.value !== '' ? (selectedEditorOpt.textContent || '').trim() : '';
    const activeEditName = !isGlobalPopover ? (selectedEditorName || _currentlyEditingWorld || '') : '';
    const currentChatAvatar =
        !isGlobalPopover && _latestSettings.pinCurrentChatCharBookInEditor !== false
            ? getCurrentCharacterAvatar()
            : null;
    const editorHiddenSet = new Set(
        Array.isArray(_latestSettings.editorHiddenGroupIds)
            ? _latestSettings.editorHiddenGroupIds
            : (_latestSettings.hideCharBooksByDefault !== false ? [SPECIAL_GROUPS.CHARACTER] : []),
    );

    // Check if current `.gr-option` nodes are already enhanced with our pin buttons & current editing/chat state
    const realOptionNodes = optionNodes.filter((optEl) => {
        const val = optEl.dataset?.value ?? '';
        const text = getOptionText(optEl);
        return !(optEl.hasAttribute('data-value') && val === '') && Boolean(text) && !text.startsWith('---');
    });
    if (realOptionNodes.length === 0) return;
    const alreadyHasPins = realOptionNodes.every((optEl) => Boolean(optEl.querySelector('.wbo-gr-pin-btn')));
    const stateChanged =
        !isGlobalPopover &&
        ((containerEl.dataset.wboEditingWorld || '') !== activeEditName ||
            (containerEl.dataset.wboChatAvatar || '') !== (currentChatAvatar || ''));
    const hasGlobalControls = !isGlobalPopover || (
        containerEl.querySelector('.wbo-pop-filter-bar') &&
        containerEl.querySelector(ENHANCED_POPOVER_SELECTORS.searchInputSelector)
    );
    if (alreadyHasPins && containerEl.dataset.wboPopoverReady === '1' && !stateChanged && hasGlobalControls && !isGlobalOpening) return;

    containerEl.dataset.wboPopoverReady = '1';
    if (isGlobalOpening) containerEl.dataset.wboGlobalOpen = '1';
    containerEl.dataset.wboEditingWorld = activeEditName;
    containerEl.dataset.wboChatAvatar = currentChatAvatar || '';
    containerEl.querySelectorAll('.wbo-pop-filter-bar').forEach((el) => el.remove());
    containerEl.querySelectorAll('[data-wbo-editing-badge]').forEach((el) => el.remove());

    if (!isGlobalPopover && useEnhancedStyle) {
        for (const optEl of optionNodes) {
            const previous = optEl.previousElementSibling;
            if (previous?.matches('.gr-group-label:not(.wbo-dd-group-head)') && previous.textContent.trim() === '角色世界书') {
                optEl.dataset.wboPreferredRoleBook = '1';
            }
        }
    }

    // Unwrap any previously created `.wbo-pop-section`s if re-enhancing a reused container
    const prevSections = Array.from(optionsHost.querySelectorAll(':scope > .wbo-pop-section'));
    if (prevSections.length > 0) {
        for (const sec of prevSections) {
            sec.querySelectorAll(ENHANCED_POPOVER_SELECTORS.optionSelector).forEach((o) => optionsHost.appendChild(o));
            sec.remove();
        }
    }

    // Inject right-aligned `[当前编辑] [☆ / ★]` controls into EVERY real `.gr-option` row!
    for (const optEl of realOptionNodes) {
        const text = getOptionText(optEl);
        const meta = _latestClassification.byName.get(text);
        const worldName = meta?.realName || text;
        const isPinned = Boolean(meta?.isPinned ?? _latestSettings?.pinnedBooks?.includes?.(worldName));
        const isEditingRow = Boolean(!isGlobalPopover && activeEditName && worldName === activeEditName);
        optEl.classList.add('wbo-has-pin');
        if (!isGlobalPopover && useEnhancedStyle) {
            syncEnhancedEditorOptionTitle(optEl, meta);
            optEl.classList.toggle('selected', isEditingRow);
        }

        let pinBtn = optEl.querySelector('.wbo-gr-pin-btn');
        if (!pinBtn) {
            pinBtn = document.createElement('button');
            pinBtn.type = 'button';
            pinBtn.className = `${ENHANCED_POPOVER_SELECTORS.pinClass} wbo-s2-pin-btn wbo-gr-pin-btn${isPinned ? ' is-pinned' : ''}`;
            pinBtn.setAttribute('data-pin-world', worldName);
            pinBtn.setAttribute('data-wbo-gr-pin', worldName);
        }
        if (useEnhancedStyle && isGlobalPopover) adoptEnhancedPinIcon(optEl, pinBtn);
        syncEnhancedPinButton(pinBtn, isPinned);

        let rightWrap = optEl.querySelector(':scope > .wbo-s2-right');
        if (!rightWrap) {
            rightWrap = document.createElement('span');
            rightWrap.className = 'wbo-s2-right';
            rightWrap.setAttribute('data-wbo-ui', '1');
            optEl.appendChild(rightWrap);
        }
        if (isEditingRow) {
            const badge = document.createElement('span');
            badge.className = 'wbo-s2-badge is-editing';
            badge.setAttribute('data-wbo-ui', '1');
            badge.setAttribute('data-wbo-editing-badge', '1');
            badge.textContent = '当前编辑';
            rightWrap.appendChild(badge);
        }
        rightWrap.appendChild(pinBtn);
    }

    if (!_latestSettings.dropdownCollapsed || typeof _latestSettings.dropdownCollapsed !== 'object') {
        _latestSettings.dropdownCollapsed = {};
    }

    const placeholders = [];
    const bareEditorItems = [];
    const bareEditorMeta = new WeakMap();
    /** @type {Map<string, HTMLElement[]>} */
    const bucketByGroup = new Map();

    for (const optEl of optionNodes) {
        const val = optEl.dataset?.value ?? '';
        const text = getOptionText(optEl);
        if ((optEl.hasAttribute('data-value') && val === '') || !text || text.startsWith('---')) {
            if (!isGlobalPopover && useEnhancedStyle && (val === '' || text.startsWith('---'))) {
                optEl.dataset.wboOriginalPlaceholder ||= text;
                const label = activeEditName ? '清除当前选择' : optEl.dataset.wboOriginalPlaceholder;
                if (optEl.textContent !== label) optEl.textContent = label;
                optEl.classList.toggle('selected', !activeEditName);
            }
            placeholders.push(optEl);
            continue;
        }
        const meta = _latestClassification.byName.get(text);
        const worldName = meta?.realName || text;
        const gid = meta?.groupId || SPECIAL_GROUPS.UNGROUPED;
        if (!isGlobalPopover) {
            const isEditingRow = Boolean(activeEditName && worldName === activeEditName);
            const isCurrentChatCharBook = Boolean(
                optEl.dataset.wboPreferredRoleBook === '1' ||
                (currentChatAvatar && meta?.charOwners?.some((o) => o.avatar === currentChatAvatar)),
            );
            const isFromHiddenGroup = Boolean(!_latestSettings.showCharBooks && editorHiddenSet.has(gid));
            if (isCurrentChatCharBook || (isEditingRow && isFromHiddenGroup)) {
                bareEditorMeta.set(optEl, {
                    isPinned: Boolean(meta?.isPinned ?? _latestSettings?.pinnedBooks?.includes?.(worldName)),
                    isEditing: isEditingRow,
                    isCurrentChatCharBook,
                    groupId: gid,
                });
                bareEditorItems.push(optEl);
                continue;
            }
        }
        if (!bucketByGroup.has(gid)) bucketByGroup.set(gid, []);
        bucketByGroup.get(gid).push(optEl);
    }

    if (bareEditorItems.length > 1) {
        bareEditorItems.sort((a, b) => {
            const ma = bareEditorMeta.get(a);
            const mb = bareEditorMeta.get(b);
            const pa = ma?.isPinned ? 1 : 0;
            const pb = mb?.isPinned ? 1 : 0;
            if (pa !== pb) return pb - pa;
            const ea = ma?.isEditing ? 1 : 0;
            const eb = mb?.isEditing ? 1 : 0;
            if (ea !== eb) return eb - ea;
            const ca = ma?.isCurrentChatCharBook ? 1 : 0;
            const cb = mb?.isCurrentChatCharBook ? 1 : 0;
            if (ca !== cb) return cb - ca;
            const ta = _latestClassification.byName.get(getOptionText(a))?.primaryTitle || getOptionText(a);
            const tb = _latestClassification.byName.get(getOptionText(b))?.primaryTitle || getOptionText(b);
            return compareZhCn(ta, tb);
        });
    }

    const orderedSections = orderSectionsForExternalDropdown(_latestClassification.orderedSections || []).filter(
        (sec) => (bucketByGroup.get(sec.id)?.length || 0) > 0,
    );
    const getPopoverPinnedCount = () => {
        let cnt = 0;
        for (const optEl of realOptionNodes) {
            const name = getOptionText(optEl);
            if (name && _latestClassification?.byName?.get(name)?.isPinned) cnt += 1;
        }
        return cnt;
    };
    const initialPopPinned = getPopoverPinnedCount();
    if (useEnhancedStyle) optionsHost.querySelectorAll(ENHANCED_POPOVER_SELECTORS.groupLabelSelector).forEach((el) => el.remove());

    // When only 1 section exists and 0 pinned books, keep DOM flat (zero headers) — pin buttons & bare top items are ALREADY mounted!
    if (!isGlobalPopover && orderedSections.length < 2 && initialPopPinned === 0) {
        if (bareEditorItems.length > 0) {
            for (const ph of placeholders) optionsHost.appendChild(ph);
            for (const optEl of bareEditorItems) optionsHost.appendChild(optEl);
            for (const sec of orderedSections) {
                for (const optEl of bucketByGroup.get(sec.id) || []) {
                    optionsHost.appendChild(optEl);
                }
            }
        }
        containerEl._wboOnPinChanged = () => {};
        delete containerEl._wboPopState;
        return;
    }

    // Remove flat default labels before inserting our grouped sections
    optionsHost.querySelectorAll(ENHANCED_POPOVER_SELECTORS.groupLabelSelector).forEach((el) => el.remove());

    for (const ph of placeholders) {
        optionsHost.appendChild(ph);
    }
    for (const optEl of bareEditorItems) {
        optionsHost.appendChild(optEl);
    }

    const validGroupIds = new Set(orderedSections.map((sec) => sec.id));
    if (initialPopPinned > 0 || (!isGlobalPopover && _dropdownMemory.activePillGroupId === SPECIAL_GROUPS.PINNED)) {
        validGroupIds.add(SPECIAL_GROUPS.PINNED);
    }
    const previousGroup = isGlobalPopover
        ? (isGlobalOpening ? SPECIAL_GROUPS.PINNED : containerEl._wboPopState?.getActivePillId())
        : _dropdownMemory.activePillGroupId;
    let activePillGroupId = validGroupIds.has(previousGroup) ? previousGroup : SPECIAL_GROUPS.ALL;
    if (!isGlobalPopover) _dropdownMemory.activePillGroupId = activePillGroupId;

    let isRestoringScroll = true;
    let searchInput = containerEl.querySelector(ENHANCED_POPOVER_SELECTORS.searchInputSelector);
    if (isGlobalPopover && !(searchInput instanceof HTMLInputElement)) {
        searchInput = document.createElement('input');
        searchInput.type = 'search';
        searchInput.className = 'wbo-pop-search';
        searchInput.placeholder = '搜索世界书…';
        searchInput.setAttribute('aria-label', '搜索全局世界书');
        searchInput.setAttribute('spellcheck', 'false');
        searchInput.setAttribute('autocomplete', 'off');
        searchInput.setAttribute('data-wbo-ui', '1');
        containerEl.insertBefore(searchInput, containerEl.firstChild);
    }
    const filterGlobalSearch = isGlobalPopover && searchInput instanceof HTMLInputElement;
    if (searchInput instanceof HTMLInputElement && searchInput.spellcheck) searchInput.spellcheck = false;
    const isSearching = () =>
        searchInput instanceof HTMLInputElement && searchInput.value.trim().length > 0;

    /** @type {HTMLElement[]} */
    const sectionEls = [];

    // For global worldbook popover, hoist pinned books into a top `★ 已置顶` section so they always appear first
    const pinnedGlobalItems = [];
    if (isGlobalPopover && initialPopPinned > 0) {
        for (const sec of orderedSections) {
            const list = bucketByGroup.get(sec.id) || [];
            const keep = [];
            for (const optEl of list) {
                const name = getOptionText(optEl);
                if (name && _latestClassification?.byName?.get(name)?.isPinned) {
                    optEl.dataset.wboOrigGroup = sec.id;
                    pinnedGlobalItems.push(optEl);
                } else {
                    keep.push(optEl);
                }
            }
            bucketByGroup.set(sec.id, keep);
        }
        pinnedGlobalItems.sort((a, b) => {
            const ma = _latestClassification.byName.get(getOptionText(a));
            const mb = _latestClassification.byName.get(getOptionText(b));
            return compareZhCn(ma?.primaryTitle || getOptionText(a), mb?.primaryTitle || getOptionText(b));
        });
        if (pinnedGlobalItems.length > 0) {
            const secEl = document.createElement('div');
            secEl.className = 'wbo-pop-section';
            secEl.setAttribute('data-wbo-dd-group', SPECIAL_GROUPS.PINNED);

            const headEl = document.createElement('div');
            headEl.className = `${ENHANCED_POPOVER_SELECTORS.groupLabelClass} wbo-dd-group-head`;
            headEl.setAttribute('data-wbo-dd-group', SPECIAL_GROUPS.PINNED);
            headEl.textContent = `收藏 (${pinnedGlobalItems.length})`;
            headEl.title = '点击展开或折叠该分组';

            const bodyEl = document.createElement('div');
            bodyEl.className = 'wbo-pop-group-body';
            for (const optEl of pinnedGlobalItems) {
                bodyEl.appendChild(optEl);
            }

            secEl.append(headEl, bodyEl);
            optionsHost.appendChild(secEl);
            sectionEls.push(secEl);
        }
    }

    for (const sec of orderedSections) {
        const items = bucketByGroup.get(sec.id) || [];
        if (items.length === 0) continue;
        items.sort((a, b) => {
            const ma = _latestClassification.byName.get(getOptionText(a));
            const mb = _latestClassification.byName.get(getOptionText(b));
            const pa = ma?.isPinned ? 1 : 0;
            const pb = mb?.isPinned ? 1 : 0;
            if (pa !== pb) return pb - pa;
            const ta = ma?.primaryTitle || getOptionText(a);
            const tb = mb?.primaryTitle || getOptionText(b);
            return compareZhCn(ta, tb);
        });

        const secEl = document.createElement('div');
        secEl.className = 'wbo-pop-section';
        secEl.setAttribute('data-wbo-dd-group', sec.id);

        const headEl = document.createElement('div');
        headEl.className = `${ENHANCED_POPOVER_SELECTORS.groupLabelClass} wbo-dd-group-head`;
        headEl.setAttribute('data-wbo-dd-group', sec.id);
        headEl.textContent = `${sec.name} (${items.length})`;
        headEl.title = '点击展开或折叠该分组';

        const bodyEl = document.createElement('div');
        bodyEl.className = 'wbo-pop-group-body';
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
            const active = btn.getAttribute('data-wbo-pill') === activePillGroupId;
            btn.classList.toggle('is-active', active);
            btn.setAttribute('aria-pressed', String(active));
        });
    };

    const getScrollHost = () => findScrollableListEl(optionsHost, containerEl);

    const syncSections = () => {
        const searching = isSearching();
        const applyGroupFilter = !searching || isGlobalPopover;
        const isPinFilter = applyGroupFilter && activePillGroupId === SPECIAL_GROUPS.PINNED;
        const isIsolated = applyGroupFilter && activePillGroupId !== SPECIAL_GROUPS.ALL && !isPinFilter;
        const searchTerms = filterGlobalSearch ? searchInput.value.trim().toLowerCase().split(/\s+/).filter(Boolean) : [];
        for (const o of bareEditorItems) {
            if (searching) {
                o.classList.remove('wbo-dd-pin-hidden');
            } else if (isPinFilter) {
                const name = getOptionText(o);
                const pinned = Boolean(name && _latestClassification?.byName?.get(name)?.isPinned);
                o.classList.toggle('wbo-dd-pin-hidden', !pinned);
            } else if (isIsolated) {
                const gid = bareEditorMeta.get(o)?.groupId || SPECIAL_GROUPS.UNGROUPED;
                o.classList.toggle('wbo-dd-pin-hidden', gid !== activePillGroupId);
            } else {
                o.classList.remove('wbo-dd-pin-hidden');
            }
        }
        for (const secEl of sectionEls) {
            const gid = secEl.getAttribute('data-wbo-dd-group') || '';
            const headEl = secEl.querySelector(':scope > .wbo-dd-group-head');
            if (headEl instanceof HTMLElement) {
                headEl.classList.toggle('is-isolated', isIsolated || isPinFilter);
                headEl.title = (isIsolated || isPinFilter) ? '' : '点击展开或折叠该分组';
            }
            const optsInSec = Array.from(secEl.querySelectorAll(ENHANCED_POPOVER_SELECTORS.optionSelector));
            for (const o of optsInSec) {
                if (filterGlobalSearch) {
                    const name = getOptionText(o);
                    const text = _latestClassification.byName.get(name)?.searchableText || name.toLowerCase();
                    o.classList.toggle('wbo-pop-search-hidden', !searchTerms.every((term) => text.includes(term)));
                }
                if (isIsolated && gid === SPECIAL_GROUPS.PINNED) {
                    o.classList.toggle('wbo-dd-pin-hidden', o.dataset.wboOrigGroup !== activePillGroupId);
                } else if (!isPinFilter) {
                    o.classList.remove('wbo-dd-pin-hidden');
                } else {
                    const name = getOptionText(o);
                    const pinned = Boolean(name && _latestClassification?.byName?.get(name)?.isPinned);
                    o.classList.toggle('wbo-dd-pin-hidden', !pinned);
                }
            }
            if (searching) {
                const hasVisibleChild = optsInSec.some(
                    (o) => o.style.display !== 'none' &&
                        !o.classList.contains('wbo-pop-search-hidden') && !o.classList.contains('wbo-dd-pin-hidden'),
                );
                const hiddenByPill = isIsolated && gid !== activePillGroupId && gid !== SPECIAL_GROUPS.PINNED;
                secEl.classList.toggle('wbo-dd-group-hidden', !hasVisibleChild || hiddenByPill);
                secEl.classList.remove('wbo-dd-collapsed');
            } else if (isPinFilter) {
                const hasPinnedChild = optsInSec.some((o) => !o.classList.contains('wbo-dd-pin-hidden'));
                secEl.classList.toggle('wbo-dd-group-hidden', !hasPinnedChild);
                secEl.classList.remove('wbo-dd-collapsed');
            } else if (isIsolated && gid === SPECIAL_GROUPS.PINNED) {
                const hasOrigMatch = optsInSec.some((o) => !o.classList.contains('wbo-dd-pin-hidden'));
                secEl.classList.toggle('wbo-dd-group-hidden', !hasOrigMatch);
                secEl.classList.remove('wbo-dd-collapsed');
            } else {
                const hiddenByPill = isIsolated && gid !== activePillGroupId;
                secEl.classList.toggle('wbo-dd-group-hidden', hiddenByPill);
                const collapsed = !isIsolated && Boolean(_latestSettings.dropdownCollapsed[gid]);
                secEl.classList.toggle('wbo-dd-collapsed', collapsed);
            }
        }
    };

    const popoverScrollHost = getScrollHost();
    const restoreTimers = [];
    const cancelRestore = () => {
        isRestoringScroll = false;
        while (restoreTimers.length) {
            const tid = restoreTimers.pop();
            clearTimeout(tid);
            _activePopoverRestoreTimers.delete(tid);
        }
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

    containerEl._wboPopState?.cancelRestore?.();
    containerEl._wboPopState = {
        getActivePillId: () => activePillGroupId,
        isSearching,
        isRestoringScroll: () => isRestoringScroll,
        syncSections,
        cancelRestore,
        savePopoverScroll,
        setActivePillId: (nextId) => {
            activePillGroupId = nextId;
        },
    };

    if (optionsHost.dataset.wboHostListenersBound !== '1') {
        optionsHost.dataset.wboHostListenersBound = '1';
        optionsHost.addEventListener('mousedown', (ev) => {
            const role = containerEl.dataset.wboPopoverRole;
            if (role !== 'global' && role !== 'editor') return;
            const head = ev.target instanceof Element ? ev.target.closest('.wbo-dd-group-head') : null;
            if (!head) return;
            ev.preventDefault();
            ev.stopPropagation();
            const st = containerEl._wboPopState;
            if (!st || st.getActivePillId() !== SPECIAL_GROUPS.ALL) return;
            const gid = head.getAttribute('data-wbo-dd-group');
            if (!gid) return;
            _latestSettings.dropdownCollapsed[gid] = !_latestSettings.dropdownCollapsed[gid];
            saveSettings();
            st.syncSections();
        }, true);

        optionsHost.addEventListener('click', (ev) => {
            const role = containerEl.dataset.wboPopoverRole;
            if (role !== 'global' && role !== 'editor') return;
            const head = ev.target instanceof Element ? ev.target.closest('.wbo-dd-group-head') : null;
            if (!head) return;
            ev.preventDefault();
            ev.stopPropagation();
        }, true);

        const onPopoverOptionPointerDown = (ev) => {
            const role = containerEl.dataset.wboPopoverRole;
            if (role !== 'global' && role !== 'editor') return;
            const row = ev.target instanceof Element ? ev.target.closest(ENHANCED_POPOVER_SELECTORS.optionSelector) : null;
            if (row && !ev.target.closest('.wbo-gr-pin-btn')) {
                const st = containerEl._wboPopState;
                if (!st) return;
                st.cancelRestore();
                st.savePopoverScroll();
                if (role === 'editor') {
                    rememberEditorListAnchor(getEnhancedPopoverOptionText(row), row, getScrollHost(), st.getActivePillId());
                }
            }
        };
        optionsHost.addEventListener('pointerdown', onPopoverOptionPointerDown, true);
        optionsHost.addEventListener('mousedown', onPopoverOptionPointerDown, true);
    }

    const initialPopPinnedCount = initialPopPinned;
    if (isGlobalPopover || orderedSections.length >= 2 || initialPopPinnedCount > 0 || activePillGroupId === SPECIAL_GROUPS.PINNED) {
        const built = createDropdownFilterBar(
            [
                ...(initialPopPinnedCount > 0 || activePillGroupId === SPECIAL_GROUPS.PINNED
                    ? [{ id: SPECIAL_GROUPS.PINNED, label: `${isGlobalPopover ? '收藏' : '★ 已置顶'} ${initialPopPinnedCount}` }]
                    : []),
                ...orderedSections.map((sec) => ({
                    id: sec.id,
                    label: `${sec.name} ${(bucketByGroup.get(sec.id) || []).length + (isGlobalPopover ? pinnedGlobalItems.filter((el) => el.dataset.wboOrigGroup === sec.id).length : 0)}`,
                })),
            ],
            activePillGroupId,
            'wbo-pop-filter-bar',
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
            if (!isGlobalPopover) _dropdownMemory.activePillGroupId = activePillGroupId;
            syncPillButtons();
            syncSections();
            scrollHost.scrollTop = _dropdownMemory.scrollTopByGroup[activePillGroupId] ?? 0;
        });

        pillScrollEl.addEventListener('scroll', () => {
            if (!isRestoringScroll && pillScrollEl.clientWidth > 0) {
                _dropdownMemory.pillBarScrollLeft = pillScrollEl.scrollLeft;
            }
        }, { passive: true });

        if (!useEnhancedStyle || !mountEnhancedDropdownBar(optionsHost, filterBar, searchInput)) {
            if (optionsHost === containerEl) containerEl.insertBefore(filterBar, sectionEls[0] || optionsHost.firstChild);
            else optionsHost.parentElement?.insertBefore(filterBar, optionsHost);
        }
    }

    // Listen on BOTH optionsHost and discovered scrollHost (and containerEl) in case popover layout settles lazily
    const scrollTargets = new Set([optionsHost, popoverScrollHost, containerEl]);
    for (const st of scrollTargets) {
        if (st.dataset.wboScrollBound === '1') continue;
        st.dataset.wboScrollBound = '1';
        st.addEventListener('scroll', () => {
            const role = containerEl.dataset.wboPopoverRole;
            if (role !== 'global' && role !== 'editor') return;
            const pState = containerEl._wboPopState;
            if (!pState) return;
            if (!pState.isRestoringScroll?.() && !pState.isSearching?.() && st.clientHeight > 0 && st.scrollHeight > st.clientHeight + 2) {
                _dropdownMemory.scrollTopByGroup[pState.getActivePillId()] = st.scrollTop;
            }
        }, { passive: true });
        st.addEventListener('wheel', () => {
            const role = containerEl.dataset.wboPopoverRole;
            if (role !== 'global' && role !== 'editor') return;
            containerEl._wboPopState?.cancelRestore();
        }, { passive: true });
        st.addEventListener('touchmove', () => {
            const role = containerEl.dataset.wboPopoverRole;
            if (role !== 'global' && role !== 'editor') return;
            containerEl._wboPopState?.cancelRestore();
        }, { passive: true });
    }

    if (searchInput instanceof HTMLInputElement && searchInput.dataset.wboPopSearchBound !== '1') {
        searchInput.dataset.wboPopSearchBound = '1';
        const syncSearch = () => {
            const role = containerEl.dataset.wboPopoverRole;
            if (role !== 'global' && role !== 'editor') return;
            const pState = containerEl._wboPopState;
            if (!pState) return;
            pState.cancelRestore();
            requestAnimationFrame(pState.syncSections);
        };
        searchInput.addEventListener('compositionend', syncSearch);
        searchInput.addEventListener('input', (ev) => {
            if (!ev.isComposing) syncSearch();
        });
    }

    const syncPopoverPinnedPill = () => {
        if (!filterBar) return;
        const cnt = getPopoverPinnedCount();
        const scrollWrap = filterBar.querySelector('.wbo-dd-pill-scroll');
        let pinPill = filterBar.querySelector(`[data-wbo-pill="${SPECIAL_GROUPS.PINNED}"]`);
        if (cnt > 0 || activePillGroupId === SPECIAL_GROUPS.PINNED) {
            if (!pinPill && scrollWrap) {
                pinPill = document.createElement('button');
                pinPill.type = 'button';
                pinPill.className = `wbo-dd-pill${activePillGroupId === SPECIAL_GROUPS.PINNED ? ' is-active' : ''}`;
                pinPill.setAttribute('data-wbo-pill', SPECIAL_GROUPS.PINNED);
                scrollWrap.prepend(pinPill);
            }
            if (pinPill) pinPill.textContent = `★ 已置顶 ${cnt}`;
        } else if (pinPill) {
            pinPill.remove();
        }
    };
    containerEl._wboOnPinChanged = () => {
        if (isGlobalPopover) {
            delete containerEl.dataset.wboPopoverReady;
            enhanceCustomDropdownPopover(containerEl);
            return;
        }
        syncPopoverPinnedPill();
        syncSections();
    };

    syncSections();
    const applyPopoverScroll = () => {
        if (!_observersActive || !isRestoringScroll || !containerEl.isConnected) return;
        const role = containerEl.dataset.wboPopoverRole;
        if (role !== 'global' && role !== 'editor') return;
        if (pillScrollEl && pillScrollEl.clientWidth > 0) {
            pillScrollEl.scrollLeft = _dropdownMemory.pillBarScrollLeft;
        }
        if (role === 'editor') {
            restoreEditorListPosition(getScrollHost(), activePillGroupId, (name) =>
                [...containerEl.querySelectorAll(ENHANCED_POPOVER_SELECTORS.optionSelector)].find((row) => getOptionText(row) === name));
            return;
        }
        const host = getScrollHost();
        if (host.clientHeight > 0) host.scrollTop = isGlobalOpening ? 0 : previousGlobalScrollTop;
    };
    applyPopoverScroll();
    scheduleEnhancedRaf(applyPopoverScroll);
    const scheduleRestoreTimer = (fn, delay) => {
        const tid = setTimeout(() => {
            _activePopoverRestoreTimers.delete(tid);
            fn();
        }, delay);
        restoreTimers.push(tid);
        _activePopoverRestoreTimers.add(tid);
    };
    scheduleRestoreTimer(applyPopoverScroll, 35);
    scheduleRestoreTimer(applyPopoverScroll, 110);
    scheduleRestoreTimer(() => {
        applyPopoverScroll();
        isRestoringScroll = false;
    }, 210);
    } finally {
        _containerObserverMap.get(containerEl)?.takeRecords();
        if (observedHost) _hostObserverMap.get(observedHost)?.takeRecords();
        delete containerEl.dataset.wboEnhancing;
    }
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
    _observersActive = true;

    // Keep the browser default action for panel selects without reaching document-level overrides.
    const selectEvents = ['mousedown', 'touchend', 'keydown'];
    const protectPanelSelect = (event) => {
        if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
        const select = event.target instanceof Element ? event.target.closest('select') : null;
        if (select?.closest('.wbo-modal, .weg-modal, #wbo-extension-settings')
            && document.querySelector(ENHANCED_STYLE_SELECTOR)) event.stopPropagation();
    };
    for (const event of selectEvents) globalThis.addEventListener?.(event, protectPanelSelect, true);
    removePluginSelectIsolation = () => {
        for (const event of selectEvents) globalThis.removeEventListener?.(event, protectPanelSelect, true);
    };

    let openBeforePress = false;
    const recoverClick = (event) => {
        const display = event.target instanceof Element ? event.target.closest(ENHANCED_GLOBAL_DISPLAY) : null;
        if (!display) return;
        const chip = event.target.closest('.gr-select2-chip-remove')?.closest('.gr-select2-chip');
        const chipValue = chip?.dataset.value;
        const checked = [...(document.getElementById('world_info')?.selectedOptions || [])];
        const chipName = chip?.querySelector('span')?.textContent.trim();
        const activeOption = chip ? checked.find((option) => option.textContent.trim() === chipName)
            || checked.find((option) => option.value === chipValue) : null;
        const closing = openBeforePress;
        const openPopover = hasOpenEnhancedGlobalPicker() ? document.getElementById(ENHANCED_POPOVER_SELECTORS.globalContainerId) : null;
        if (!activeOption && !closing && openPopover) return;
        clearTimeout(enhancedGlobalRecoveryTimer);
        enhancedGlobalRecoveryTimer = setTimeout(() => {
            enhancedGlobalRecoveryTimer = null;
            if (!display.isConnected) return;
            if (activeOption) {
                if (!activeOption.selected) return;
                restoreGlobalPickerFromStaleDisplay(display);
                setGlobalWorldActive(activeOption.dataset.wboRealName || activeOption.textContent.trim(), false);
            } else if (closing) {
                if (openPopover?.isConnected && hasOpenEnhancedGlobalPicker()) {
                    openPopover.remove();
                    restoreGlobalPickerFromStaleDisplay(display);
                }
            } else if (!hasOpenEnhancedGlobalPicker()) {
                restoreGlobalPickerFromStaleDisplay(display, { open: true });
            }
        }, 160);
    };
    const rememberPress = (event) => {
        if (event.target instanceof Element && event.target.closest(ENHANCED_GLOBAL_DISPLAY)) {
            openBeforePress = Boolean(hasOpenEnhancedGlobalPicker());
        }
    };
    document.addEventListener('pointerdown', rememberPress, true);
    document.addEventListener('click', recoverClick, true);
    enhancedGlobalClickHandler = () => {
        document.removeEventListener('pointerdown', rememberPress, true);
        document.removeEventListener('click', recoverClick, true);
    };
    if (document.head) {
        enhancedStyleObserver = new MutationObserver((records) => {
            const detachedStyle = records.some((record) => [...record.removedNodes].some((node) =>
                node instanceof Element && node.matches(ENHANCED_STYLE_SELECTOR),
            ));
            if (detachedStyle && !document.querySelector(ENHANCED_STYLE_SELECTOR)) {
                clearEnhancedPresetGroups(document.getElementById(ENHANCED_POPOVER_SELECTORS.globalContainerId));
                if (hasOpenEnhancedGlobalPicker()) document.getElementById(ENHANCED_POPOVER_SELECTORS.globalContainerId)?.remove();
                restoreGlobalPickerFromStaleDisplay(document.querySelector(ENHANCED_GLOBAL_DISPLAY));
            }
        });
        enhancedStyleObserver.observe(document.head, { childList: true });
    }

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

        // Native mobile `<select>` fallback: skip completely when signature is already clean
        // so tapping the native iOS `<select>` triggers 0ms of plugin work before the system menu opens!
        _editorNativeOpenHandler = () => {
            if (_lastEditorSignature !== null) return;
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
                closeAllOpenWorldDropdowns({ except: 'editor' });
                syncEditorBeforeOpen();
            } else if (ev?.target?.id === 'world_info') {
                closeAllOpenWorldDropdowns({ except: 'global' });
            }
        };
        _editorSelect2OpenHandler = (ev) => {
            if (ev?.target?.id === 'world_editor_select') {
                requestAnimationFrame(enhanceOpenEditorDropdown);
            } else if (ev?.target?.id === 'world_info') {
                requestAnimationFrame(enhanceOpenGlobalDropdown);
            }
        };
        _editorSelect2CloseHandler = (ev) => {
            if (ev?.target?.id === 'world_editor_select') {
                cleanupOpenEditorDropdown();
                if (_pinDirtyOnClose && _latestSettings && _latestClassification) {
                    _pinDirtyOnClose = false;
                    applyAllNativeWorldFilters(_latestClassification, _latestSettings);
                }
            } else if (ev?.target?.id === 'world_info') {
                cleanupOpenGlobalDropdown();
                if (_pinDirtyOnClose && _latestSettings && _latestClassification) {
                    _pinDirtyOnClose = false;
                    applyAllNativeWorldFilters(_latestClassification, _latestSettings);
                }
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

        const wiChoice = t.closest('#WIMultiSelector .select2-selection__choice');
        if (wiChoice) {
            if (t.closest('.select2-selection__choice__remove')) return;
            const displayEl = wiChoice.querySelector('.select2-selection__choice__display');
            const rawTitle = (
                displayEl?.textContent ||
                wiChoice.getAttribute('title') ||
                wiChoice.textContent ||
                ''
            ).replace(/^\s*×\s*/, '').trim();
            if (rawTitle) {
                ensureEditorOptionAttached(rawTitle);
            }
            return;
        }

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
    document.addEventListener('mousedown', _docWorldJumpPreAttach, true);
    document.addEventListener('click', _docWorldJumpPreAttach, true);

    // Guard against SillyTavern's `$(document).on('click')` unpinned-drawer auto-closer
    // firing when opening `#world_editor_select` / `#world_info` spawns a body-mounted
    // Select2 dropdown or custom popover directly under the pointer between pointerdown & click!
    const sweepOpenEnhancedPopovers = () => {
        if (!_observersActive || typeof document === 'undefined') return;
        document.querySelectorAll(ENHANCED_POPOVER_SELECTORS.containerSelector).forEach((el) => {
            if (el instanceof HTMLElement && el.isConnected) {
                enhanceCustomDropdownPopover(el);
            }
        });
    };
    const schedulePopoverSweep = () => {
        if (!_observersActive) return;
        scheduleEnhancedRaf(sweepOpenEnhancedPopovers);
        _sweepPopoverTimers.push(
            setTimeout(sweepOpenEnhancedPopovers, 35),
            setTimeout(sweepOpenEnhancedPopovers, 110),
        );
    };

    _docDrawerGuardMouseDown = (ev) => {
        const t = ev.target instanceof Element ? ev.target : null;
        if (!t) return;
        const inSortTrigger = isNativeSortTriggerTarget(t);
        const inGlobalTrigger = Boolean(
            t.closest(`#world_info, #WIMultiSelector, ${ENHANCED_POPOVER_SELECTORS.displaySelector}`),
        );
        const inEditorTrigger = isEditorSelectTriggerTarget(t);
        const enhancedContainer = t.closest(ENHANCED_POPOVER_SELECTORS.containerSelector);
        const dropdownTrigger = t.closest('select, .gr-select2-display, .select2-selection, #wbo-mobile-editor-trigger');
        if (!enhancedContainer && dropdownTrigger) {
            const sourceSelect = dropdownTrigger.closest('select') || findOwningSelectSibling(dropdownTrigger.closest('.select2-container, .gr-select2-display'));
            const isPreset = sourceSelect?.id === 'settings_preset_openai'
                || dropdownTrigger.dataset.grSelectId === 'settings_preset_openai'
                || Boolean(dropdownTrigger.querySelector('#select2-settings_preset_openai-container'));
            sharedPopoverOpening = {
                role: inSortTrigger ? 'sort' : inGlobalTrigger ? 'global' : inEditorTrigger ? 'editor' : isPreset ? 'preset' : 'other',
                at: Date.now(),
                previous: document.getElementById(ENHANCED_POPOVER_SELECTORS.globalContainerId),
            };
        }
        const inWorldEnhanced = Boolean(
            enhancedContainer instanceof HTMLElement && detectEnhancedPopoverRole(enhancedContainer) !== null,
        );
        const s2Drop = t.closest('.select2-dropdown');
        const inSortS2Drop = Boolean(s2Drop?.querySelector('#select2-world_info_sort_order-results'));
        const inWorldS2Drop = Boolean(s2Drop && !inSortS2Drop);
        if (inGlobalTrigger) {
            closeAllOpenWorldDropdowns({ except: 'global' });
            schedulePopoverSweep();
        } else if (inEditorTrigger) {
            closeAllOpenWorldDropdowns({ except: 'editor' });
            schedulePopoverSweep();
        } else if (
            !inWorldEnhanced &&
            !inWorldS2Drop &&
            (inSortTrigger || t.closest('#world_popup .gr-select2-display, #world_popup .select2-container'))
        ) {
            closeAllOpenWorldDropdowns({ except: 'global' });
        }
        const inWorldSelect = Boolean(
            inGlobalTrigger ||
            inEditorTrigger ||
            t.closest('#WIMultiSelector .select2-container, #wbo-mobile-picker-overlay, .wbo-mp-backdrop, .wbo-mp-popover') ||
            inWorldS2Drop ||
            inWorldEnhanced,
        );
        // A host sort menu can disappear on mousedown, before the resulting click reaches the drawer guard.
        if (inWorldSelect || inSortTrigger || inSortS2Drop || enhancedContainer?.dataset.wboSourceRole === 'sort') {
            _lastWorldSelectMouseDownAt = Date.now();
        }
    };
    _docDrawerGuardClick = (ev) => {
        const wiDrawer = document.getElementById('WorldInfo');
        if (!wiDrawer || wiDrawer.classList.contains('closedDrawer')) return;
        const t = ev.target instanceof Element ? ev.target : null;
        if (!t) return;
        if (t.closest?.('.drawer-icon')) return;
        const enhancedContainer = t.closest?.(ENHANCED_POPOVER_SELECTORS.containerSelector);
        const inWorldEnhanced = Boolean(
            enhancedContainer instanceof HTMLElement && detectEnhancedPopoverRole(enhancedContainer) !== null,
        );
        const s2Drop = t.closest?.('.select2-dropdown');
        const inWorldS2Drop = Boolean(s2Drop && !s2Drop.querySelector('#select2-world_info_sort_order-results'));
        const inDropdownOverlay = Boolean(
            inWorldEnhanced ||
            inWorldS2Drop ||
            t.closest?.('#wbo-mobile-picker-overlay, .wbo-mp-backdrop, .wbo-mp-popover'),
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
                if (node.id === ENHANCED_POPOVER_SELECTORS.globalContainerId || node.classList.contains(ENHANCED_POPOVER_SELECTORS.containerClass)) {
                    markIfPersistentPopover(node);
                    ensureEnhancedContainerObserver(node);
                    const syncRole = detectEnhancedPopoverRole(node);
                    if (syncRole) {
                        node.dataset.wboPopoverRole = syncRole;
                        bindDrawerSafeBubbleGuard(node);
                    }
                    scheduleEnhancedRaf(() => enhanceCustomDropdownPopover(node));
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
    sweepOpenEnhancedPopovers();
    scheduleEnhancedRaf(sweepOpenEnhancedPopovers);
}

/**
 * Stop observers cleanly.
 */
export function stopNativeObservers() {
    removePluginSelectIsolation?.();
    removePluginSelectIsolation = null;
    if (typeof document !== 'undefined') clearEnhancedPresetGroups(document.getElementById(ENHANCED_POPOVER_SELECTORS.globalContainerId));
    enhancedStyleObserver?.disconnect();
    enhancedStyleObserver = null;
    clearTimeout(enhancedGlobalRecoveryTimer);
    enhancedGlobalRecoveryTimer = null;
    enhancedGlobalClickHandler?.();
    enhancedGlobalClickHandler = null;
    sharedPopoverOpening = null;
    _observersActive = false;
    cleanupOpenEditorDropdown();
    cleanupOpenGlobalDropdown();
    for (const closer of [..._openCustomPickerClosers]) {
        try { closer(); } catch { /* ignore */ }
    }
    _openCustomPickerClosers.clear();
    clearTimeout(_resyncTimer);
    _resyncTimer = null;
    while (_sweepPopoverTimers.length) clearTimeout(_sweepPopoverTimers.pop());
    for (const tid of _activePopoverRestoreTimers) clearTimeout(tid);
    _activePopoverRestoreTimers.clear();
    for (const handle of _pendingContainerEnhance.values()) {
        if (handle.kind === 'raf') {
            if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle.id);
        } else {
            clearTimeout(handle.id);
        }
    }
    _pendingContainerEnhance.clear();
    for (const rafId of _activeEnhancedRafs) {
        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
    }
    _activeEnhancedRafs.clear();
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
    for (const el of _observedContainers) {
        const obs = _containerObserverMap.get(el);
        if (obs) {
            try { obs.disconnect(); } catch { /* ignore */ }
            _containerObserverMap.delete(el);
        }
    }
    _observedContainers.clear();
    for (const host of _observedHosts) {
        const obs = _hostObserverMap.get(host);
        if (obs) {
            try { obs.disconnect(); } catch { /* ignore */ }
            _hostObserverMap.delete(host);
        }
        delete host.dataset.wboOptObserved;
    }
    _observedHosts.clear();
    for (const obs of _activeEnhancedObservers) {
        try { obs.disconnect(); } catch { /* ignore */ }
    }
    _activeEnhancedObservers.clear();
    _pendingClearedEditingWorld = false;
    if (_editorNativeOpenHandler) {
        const editorEl = document.getElementById('world_editor_select');
        if (editorEl) {
            editorEl.removeEventListener('mousedown', _editorNativeOpenHandler);
            editorEl.removeEventListener('focus', _editorNativeOpenHandler);
        }
        _editorNativeOpenHandler = null;
    }
    if (_docWorldJumpPreAttach) {
        document.removeEventListener('mousedown', _docWorldJumpPreAttach, true);
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
    clearTimeout(_deferredGlobalTimer);
    _deferredGlobalTimer = null;
    stopNativeObservers();
    _currentlyEditingWorld = null;
    _pendingClearedEditingWorld = false;
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
