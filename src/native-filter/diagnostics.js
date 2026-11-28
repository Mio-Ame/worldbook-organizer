/**
 * diagnostic sampling, gesture recording and the compact/full report builders.
 *
 * Move-only slice of src/native-filter.js (original lines 1538-2965). Not a single body was
 * rewritten: the declarations are byte-identical and the surrounding wiring is import/export
 * only. The hub re-imports whatever it still calls, so import sites outside did not change.
 */

import { NATIVE_ACTION_HINT, NATIVE_ACTION_TEXT, NATIVE_WB_AREA_SELECTOR, PLUGIN_VERSION, _diag, _editorDetachedMap, _globalDetachedMap, _latestClassification, _latestSettings, describeDiagTarget, diagNow, elChainText, elTagClass, getDetachedWorldNames, getHostContext, getLiveWorldIndexMap, getPowerUserSettings, hasCompatibleDropdownScript, hashDiagLabel, isTauriTavern } from '../native-filter.js';

function diagPathLength(event) {
    try {
        return typeof event?.composedPath === 'function' ? event.composedPath().length : -1;
    } catch { return -1; }
}

/**
 * `left,top,widthxheight` of an element. Comparing the value taken on pointerdown with the one on
 * pointerup tells whether the layout moved under the finger — on iOS/Tauri that alone cancels the
 * synthesized click, so a "dead" button is really a moved one.
 * @param {Element | null | undefined} el
 * @returns {string}
 */

function rectText(el) {
    try {
        const rect = el?.getBoundingClientRect?.();
        if (!rect) return '';
        return `${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(rect.width)}x${Math.round(rect.height)}`;
    } catch { return ''; }
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {number} largest axis delta in px, or -1 when either rect is missing
 */

function rectDelta(a, b) {
    try {
        const parse = (text) => String(text || '').split(',').map((part) => Number(String(part).split('x')[0]));
        const first = parse(a);
        const second = parse(b);
        if (first.length < 2 || second.length < 2 || !Number.isFinite(first[0]) || !Number.isFinite(second[0])) return -1;
        return Math.max(Math.abs(first[0] - second[0]), Math.abs(first[1] - second[1]));
    } catch { return -1; }
}

/**
 * Everything the plugin itself renders. An "obstruction" that belongs to this list is *our own*
 * panel, not a host bug — the report must not confuse the two.
 */

const OWN_UI_SELECTOR = '.wbo-modal, .wbo-btn, .wbo-diag-menu, [data-wbo-ui], [data-wbo-popover-role],'
    + ' .gr-container-enhanced, .wbo-enhanced-search-panel, .wbo-pop-filter-bar, .wbo-mp-backdrop,'
    + ' .wbo-mp-popover, .wbo-mp-row, .wbo-s2-item, #wbo-mobile-editor-trigger,'
    + ' .wbo-popup-select-trigger, #wbo-mobile-picker-overlay, .wbo-pin-box';

/**
 * @param {Element | null | undefined} el
 * @returns {boolean}
 */

export function isOwnUiElement(el) {
    try {
        return el instanceof Element && Boolean(el.closest?.(OWN_UI_SELECTOR));
    } catch { return false; }
}

/**
 * Who receives a pointer at (x, y), and whether that is the button we care about.
 * @param {number} x
 * @param {number} y
 * @param {Element | null} owner
 * @returns {string} `tag.class:own|:self|:foreign|none|n/a|err`
 */

function describeHitAt(x, y, owner) {
    try {
        if (typeof document?.elementFromPoint !== 'function') return 'n/a';
        const hit = document.elementFromPoint(x, y);
        if (!hit) return 'none';
        const owns = owner instanceof Element && (hit === owner || owner.contains(hit));
        return `${elTagClass(hit, 20)}${owns ? ':own' : (isOwnUiElement(hit) ? ':self' : ':foreign')}`;
    } catch { return 'err'; }
}

/**
 * Which entry row a click belongs to. `uid` is a host-side number, never a user text, and the index
 * is what lets a report say "the same row" or "another row".
 * @param {Element | null} el
 * @returns {{ uid: string, index: number } | null}
 */

export function rowRefOf(el) {
    try {
        if (!(el instanceof Element)) return null;
        const row = el.closest('.world_entry, [uid]');
        if (!(row instanceof Element)) return null;
        const list = row.parentElement;
        const siblings = list ? [...list.children] : [];
        return {
            uid: String(row.getAttribute?.('uid') ?? '').slice(0, 8) || '-',
            index: siblings.indexOf(row),
        };
    } catch { return null; }
}

/**
 * Identity of the whole entry set. A row count alone cannot tell "a row was replaced" from "nothing
 * happened"; the uid hash can.
 * @param {Element | null} list
 * @returns {{ count: number, firstUid: string, lastUid: string, hash: string }}
 */

export function rowSetFingerprint(list) {
    const result = { count: 0, firstUid: '-', lastUid: '-', hash: '-' };
    try {
        if (!(list instanceof Element)) return result;
        const uids = [...list.querySelectorAll('.world_entry')]
            .map((row) => String(row.getAttribute?.('uid') ?? ''));
        result.count = uids.length;
        result.firstUid = uids[0] || '-';
        result.lastUid = uids.length > 0 ? (uids[uids.length - 1] || '-') : '-';
        result.hash = hashDiagLabel(uids.join(','));
    } catch { /* ignore */ }
    return result;
}

/**
 * Pager state next to the entry list. SillyTavern paginates the entry list (25/50/100 per page), so
 * "rows stayed 25" can simply mean "the new entry is on page 2" — a report must say which it is.
 * @param {Element | null} list
 * @returns {Record<string, any>}
 */

function describePager(list) {
    const result = { present: false, page: -1, pageSize: -1, pages: -1, nextDisabled: null };
    try {
        if (typeof document === 'undefined') return result;
        const pager = document.querySelector('.paginationjs, .paginationjs-pages, [class*="pagination" i]');
        const sizeSelect = document.querySelector('.paginationjs-size-changer select, [class*="pagination" i] select');
        const active = document.querySelector('.paginationjs-pages .active, .paginationjs .active');
        const pageItems = document.querySelectorAll('.paginationjs-pages li, .paginationjs-pages a');
        const nextBtn = document.querySelector('.paginationjs-next');
        result.present = Boolean(pager);
        if (sizeSelect instanceof HTMLSelectElement) result.pageSize = Number(sizeSelect.value) || -1;
        if (active) result.page = Number(String(active.textContent || '').trim()) || -1;
        result.pages = pageItems.length > 0 ? pageItems.length : -1;
        if (nextBtn) {
            result.nextDisabled = nextBtn.classList.contains('disabled')
                || nextBtn.getAttribute('aria-disabled') === 'true';
        }
        result.rowsOnPage = list instanceof Element ? list.querySelectorAll('.world_entry').length : 0;
        // Right at the page size with a live "next" page = a duplicate may well be on the next page.
        result.atPageBoundary = Boolean(
            result.pageSize > 0 && result.rowsOnPage === result.pageSize && result.nextDisabled === false,
        );
    } catch { /* ignore */ }
    return result;
}

/**
 * Sizes of the two native selects plus the detached-option count. Sampled before and after a click:
 * the actions read their target book from these selects.
 * @returns {{ editor: number, global: number, detached: number }}
 */

function selectSizes() {
    const size = (id) => {
        const el = document.getElementById(id);
        return el instanceof HTMLSelectElement ? el.options.length : -1;
    };
    return { editor: size('world_editor_select'), global: size('world_info'), detached: getDetachedWorldNames().length };
}

/**
 * Entry count of the native list, using the same three-way fallback as everything else.
 * @returns {number}
 */

export function diagRowCount() {
    const list = document.getElementById('world_popup_entries_list');
    if (!list) return -1;
    const uid = list.querySelectorAll('.world_entry[uid]').length;
    return uid || list.querySelectorAll('.world_entry').length || list.querySelectorAll(':scope > div').length;
}

/** Host popup that the native entry actions open (target picker / delete confirm). */

export function dialogOf(el) {
    try {
        return el instanceof Element ? el.closest('dialog.popup, dialog') : null;
    } catch { return null; }
}

/**
 * The LIVE element for the `<select>` our enhanced control wraps. A host dialog can be re-created
 * while our control still points at the previous element; resolving by id guarantees the change
 * event is dispatched on the element the host actually listens to.
 * @param {HTMLSelectElement | null} selectEl
 * @returns {HTMLSelectElement | null}
 */

export function liveDialogSelectFor(selectEl) {
    try {
        if (!(selectEl instanceof HTMLSelectElement) || !selectEl.id) return null;
        const byId = document.getElementById(selectEl.id);
        return byId instanceof HTMLSelectElement && byId !== selectEl ? byId : null;
    } catch { return null; }
}

/**
 * State of the `<select>`s inside a host dialog at the moment its confirm button is pressed. The
 * move/copy action reads its target book from here, so an empty or out-of-range value explains a
 * silent no-op: the entry lands nowhere. Name-free (hashes only).
 * @param {Element | null} dialogEl
 * @returns {Array<Record<string, any>>}
 */

function dialogSelectsOf(dialogEl) {
    try {
        if (!(dialogEl instanceof Element)) return [];
        const worldCount = Array.isArray(globalThis.world_names) ? globalThis.world_names.length : -1;
        return [...dialogEl.querySelectorAll('select')].slice(0, 4).map((sel) => {
            const value = String(sel.value ?? '');
            const selected = sel.selectedOptions?.[0] || null;
            const numeric = /^\d+$/.test(value);
            return {
                cls: elTagClass(sel, 20),
                options: sel.options?.length ?? 0,
                index: sel.selectedIndex,
                // Hash only: never the book name itself.
                value: value ? hashDiagLabel(value) : '',
                text: selected ? hashDiagLabel(String(selected.textContent || '').trim()) : '',
                numeric,
                inRange: numeric ? (worldCount < 0 || Number(value) < worldCount) : null,
            };
        });
    } catch { return []; }
}

/**
 * Hash of the book currently open in the native editor (no name leaves the page).
 * @returns {string}
 */

function currentEditorBookHash() {
    try {
        const select = document.getElementById('world_editor_select');
        if (!(select instanceof HTMLSelectElement)) return '';
        const opt = select.selectedOptions?.[0];
        const text = String(opt?.textContent || '').trim();
        return text ? hashDiagLabel(text) : '';
    } catch { return ''; }
}

/**
 * The host dialog that is open right now, as the host built it — sampled right after the action
 * click, i.e. BEFORE our own target picker writes anything into it. `trigger > 0` means the plugin
 * enhanced that dialog's select.
 * @returns {Record<string, any> | null}
 */

export function describeOpenDialog() {
    try {
        if (typeof document === 'undefined') return null;
        const candidates = [...document.querySelectorAll('dialog.popup, dialog')];
        const dialog = candidates.find((el) => el.hasAttribute('open') || el.getClientRects().length > 0);
        if (!(dialog instanceof Element)) return null;
        return {
            cls: elTagClass(dialog, 20),
            selects: dialogSelectsOf(dialog),
            enhancedTrigger: dialog.querySelectorAll('.wbo-popup-select-trigger, .wbo-mobile-editor-trigger').length,
            buttons: [...dialog.querySelectorAll('button, .menu_button')].slice(0, 6).map((btn) => elTagClass(btn, 22)),
        };
    } catch { return null; }
}

/**
 * The worldbook element hiding under the topmost hit — i.e. what the user thought they clicked
 * when a layer sits on top of it. Uses the full hit stack, not just the first element.
 * @param {number} x
 * @param {number} y
 * @returns {Element | null}
 */

function findBeneathInArea(x, y) {
    try {
        if (typeof document?.elementsFromPoint !== 'function') return null;
        for (const node of document.elementsFromPoint(x, y) || []) {
            if (node instanceof Element && node.closest?.(NATIVE_WB_AREA_SELECTOR)) return node;
        }
        return null;
    } catch { return null; }
}

/**
 * Cheap geometric pre-check (two rect reads) so the hit stack is only queried when a press could
 * plausibly belong to the worldbook UI.
 * @param {number} x
 * @param {number} y
 * @returns {boolean}
 */

function pointInsideWorldbookArea(x, y) {
    try {
        for (const id of ['world_popup', 'WorldInfo']) {
            const el = document.getElementById(id);
            if (!el || el.getClientRects().length === 0) continue;
            const rect = el.getBoundingClientRect();
            if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return true;
        }
        return false;
    } catch { return false; }
}

/**
 * Does this element look like one of the native row actions? Text is capped so a whole row can
 * never match through its title/body text.
 * @param {Element | null | undefined} el
 * @returns {boolean}
 */

export function nativeActionLike(el) {
    if (!(el instanceof Element)) return false;
    try {
        const cls = String(el.getAttribute?.('class') ?? el.className ?? '');
        if (NATIVE_ACTION_HINT.test(cls)) return true;
        const text = String(el.textContent || '').trim();
        const label = `${text.length > 24 ? '' : text} ${el.getAttribute?.('title') || ''} ${el.getAttribute?.('aria-label') || ''}`;
        return label.trim().length > 0 && NATIVE_ACTION_TEXT.test(label);
    } catch { return false; }
}

/**
 * Resolve the element that carries the action. SillyTavern builds without a `button`/`[title]`
 * wrapper put the handler on a plain span or svg, so the raw target is checked too — but only
 * inside a `.world_entry` row, which keeps ordinary row clicks out of the instrumentation.
 * @param {Element | null} target
 * @returns {Element | null}
 */

export function resolveNativeActionTarget(target) {
    if (!(target instanceof Element)) return null;
    try {
        const direct = target.closest('button, .menu_button, [data-action], .fa-copy, .world_entry_action, i, [title]');
        if (direct && nativeActionLike(direct)) return direct;
        const row = target.closest('.world_entry');
        if (!row) return direct || null;
        let node = target;
        for (let depth = 0; depth < 3 && node instanceof Element && node !== row; depth += 1) {
            if (nativeActionLike(node)) return node;
            node = node.parentElement;
        }
        return direct || null;
    } catch { return null; }
}

/**
 * Computed style of the element and up to `max - 1` ancestors, up to the list. Covers the three
 * silent blockers: a layer on top (position/z-index), a non-interactive tree (pointer-events /
 * visibility / opacity) and an inert subtree (clicks are not even dispatched).
 * @param {Element | null} el
 * @param {Element | null} [stopAt]
 * @param {number} [max]
 * @returns {string[]}
 */

function styleChainOf(el, stopAt = null, max = 4) {
    const out = [];
    let node = el;
    for (let depth = 0; depth < max && node instanceof Element; depth += 1) {
        let style = null;
        try { style = getComputedStyle(node); } catch { style = null; }
        const inertFlag = node.hasAttribute?.('inert') ? 'inert' : '';
        const ariaHidden = node.getAttribute?.('aria-hidden') === 'true' ? 'aria-hidden' : '';
        out.push([
            elTagClass(node, 18),
            `pe=${style?.pointerEvents ?? '?'}`,
            `vis=${style?.visibility ?? '?'}`,
            `op=${style?.opacity ?? '?'}`,
            `z=${style?.zIndex ?? '?'}`,
            `pos=${style?.position ?? '?'}`,
            `of=${style?.overflowY ?? style?.overflow ?? '?'}`,
        ].join(',') + (inertFlag || ariaHidden ? `,${[inertFlag, ariaHidden].filter(Boolean).join('/')}` : ''));
        if (stopAt && node === stopAt) break;
        node = node.parentElement;
    }
    return out;
}

/**
 * Three hit tests on one button: centre, top-left + 8px and bottom-right − 8px (a scrollbar or a
 * right-hand overlay is exactly what the centre test alone misses).
 * @param {Element | null} el
 * @returns {{ points: string[], obscured: boolean }}
 */

function hitPointsOf(el) {
    const report = { points: [], obscured: false, selfOnly: false };
    if (!(el instanceof Element)) return report;
    let rect = null;
    try { rect = el.getBoundingClientRect(); } catch { rect = null; }
    if (!rect) return report;
    const spots = [
        ['c', rect.left + rect.width / 2, rect.top + rect.height / 2],
        ['tl8', rect.left + 8, rect.top + 8],
        ['br8', rect.right - 8, rect.bottom - 8],
    ];
    let foreign = 0;
    let self = 0;
    for (const [name, x, y] of spots) {
        const hit = describeHitAt(x, y, el);
        report.points.push(`${name}=${hit}`);
        if (hit === 'n/a' || hit.endsWith(':own')) continue;
        report.obscured = true;
        if (hit.endsWith(':self')) self += 1;
        else foreign += 1;
    }
    // Obstructed only by the plugin's own panels? Then it is not a host-side blocker.
    report.selfOnly = report.obscured && foreign === 0 && self > 0;
    return report;
}

/**
 * A short, name-free label of the render path currently in charge of the dropdowns.
 * @returns {string}
 */

function nativeRenderPathHint() {
    try {
        if (typeof document === 'undefined') return 'none';
        if (document.querySelector('[data-wbo-popover-role="global"]')) return 'enhanced:global';
        if (document.querySelector('[data-wbo-popover-role="editor"]')) return 'enhanced:editor';
        if (document.querySelector('.select2-dropdown')) return 'select2';
        if (document.querySelector('#gr-global-dropdown-container, .gr-container-enhanced')) return 'enhanced-shell';
        return _diag.lastRenderPath || 'native';
    } catch { return 'err'; }
}

/**
 * Track the two environmental flips that make bug reports hard to compare: the compatible
 * dropdown script being toggled, and the SillyTavern theme being switched mid-session.
 * @param {{ enhancedActive?: boolean, theme?: string }} state
 */

export function trackDiagEnvironment(state) {
    const seconds = ((globalThis.performance?.now?.() || Date.now()) / 1000).toFixed(1);
    if (typeof state.enhancedActive === 'boolean') {
        if (_diag.lastEnhancedActive !== null && _diag.lastEnhancedActive !== state.enhancedActive) {
            _diag.scriptFlips.push(`+${seconds}s ${state.enhancedActive ? 'on' : 'off'}`);
            if (_diag.scriptFlips.length > 10) _diag.scriptFlips.shift();
        }
        _diag.lastEnhancedActive = state.enhancedActive;
    }
    if (typeof state.theme === 'string' && state.theme) {
        if (_diag.lastTheme && _diag.lastTheme !== state.theme) {
            _diag.themeFlips.push(`+${seconds}s ${hashDiagLabel(state.theme)}`);
            if (_diag.themeFlips.length > 10) _diag.themeFlips.shift();
        }
        _diag.lastTheme = state.theme;
    }
}


export function pushDiagUi(kind, target) {
    try {
        // Timestamp every interaction so a report can be read as a timeline ("what happened in
        // the last 10 seconds").
        const seconds = ((globalThis.performance?.now?.() || Date.now()) / 1000).toFixed(1);
        _diag.ui.push(`+${seconds}s ${kind}:${describeDiagTarget(target)}`);
        if (_diag.ui.length > 40) _diag.ui.shift();
    } catch { /* logging must never break the UI */ }
}

/** @type {any | null} The gesture record currently being filled (read-only bookkeeping). */

export let _gestureActive = null;
/** @type {Element | null} */

let _gestureDownEl = null;
/** @type {Element | null} */

let _gestureDownList = null;

let _gestureTailBound = false;
/** @type {any} */

let _gestureWatchdog = null;
/** The event objects whose default we still have to read after the host handlers ran. */

let _gestureDownEvent = null;

let _gestureUpEvent = null;

/**
 * `editor 139→208 / global 138→207 / det 69→0` — reads as "the plugin put 69 options back inside
 * this very click", which is the one thing a host handler can trip over silently.
 * @param {any} record
 * @returns {string}
 */

function gestureSelectText(record) {
    try {
        const before = record?.down?.selects;
        const after = record?.click?.selects || null;
        if (!before) return '-';
        const part = (key) => (after ? `${before[key]}→${after[key]}` : `${before[key]}`);
        return `editor ${part('editor')}/global ${part('global')}/det ${part('detached')}`;
    } catch { return '-' }
}

/**
 * Summarise one gesture for the report. Everything here is structure only: tag/class names,
 * flags and counts.
 * @param {any} record
 * @returns {Record<string, any> | null}
 */

export function gestureSummary(record) {
    if (!record) return null;
    try {
        const sequence = ['down'];
        if (record.up) sequence.push('up');
        if (record.up && record.up.sameAsDown === false) sequence.push('retargeted');
        if (record.click) sequence.push('click');
        if (!record.click && record.miss) sequence.push(record.miss === 'no-click' ? 'NO-CLICK' : 'NO-UP');
        if (record.cancel) sequence.push('cancel');
        return {
            n: record.n,
            at: record.at,
            host: record.host,
            sequence: sequence.join('>'),
            miss: record.miss || '',
            covered: Boolean(record.down?.covers),
            ownOverlay: Boolean(record.down?.ownOverlay),
            // Which entry row (host uid + list index) and whether the select sizes moved under it.
            row: record.row ? `${record.row.uid}@${record.row.index}` : '-',
            clickRow: record.click?.row ? `${record.click.row.uid}@${record.click.row.index}` : '-',
            selects: gestureSelectText(record),
            restores: (record.click?.restores ?? _diag.restoreRuns) - (record.down?.restores ?? 0),
            // Did the two <select>s change size *inside* this gesture? That is the visible flicker
            // of the global list, and on iOS it is also what eats the synthesized click.
            selectsMoved: Boolean(record.down?.selects && record.click?.selects
                && (record.down.selects.editor !== record.click.selects.editor
                    || record.down.selects.global !== record.click.selects.global)),
            // How far the pressed element moved between press and release. A few pixels is enough
            // for iOS/Tauri to drop the synthesized click, which reads as "the button does nothing".
            movedPx: rectDelta(record.down?.rect, record.up?.rect || record.click?.rect),
            dialog: record.down?.dialog || '',
            down: record.down
                ? `${record.down.desc}|hit=${record.down.hit}|conn=${record.down.connected ? 1 : 0}`
                    + `|trusted=${record.down.trusted ? 1 : 0}|path=${record.down.path}`
                    + `|preventedAfter=${record.down.preventedAfter ? 1 : 0}`
                    + (record.down.area === 'by-point' ? '|area=by-point' : '')
                    + (record.down.covers ? `|beneath=${record.down.beneath}` : '')
                : 'none',
            up: record.up
                ? (record.up.error
                    ? `err=${record.up.error}`
                    : `${record.up.desc}|same=${record.up.sameAsDown ? 1 : 0}`
                        + `|downConn=${record.up.downConnected ? 1 : 0}|list=${record.up.listSame}`
                        + `|preventedAfter=${record.up.preventedAfter ? 1 : 0}`)
                : 'none',
            click: record.click
                ? `${record.click.desc}|same=${record.click.sameAsDown ? 1 : 0}`
                    + `|bubble=${record.click.bubble ? 1 : 0}|prevented=${record.click.prevented ? 1 : 0}`
                    + `|trusted=${record.click.trusted ? 1 : 0}|upToClick=${record.click.upToClickMs}`
                : 'none',
            cancel: record.cancel || '',
        };
    } catch { return null; }
}

/**
 * Register the tail of the gesture (pointerup / pointercancel / click). Created lazily on the first
 * pointerdown inside a worldbook container: registering document listeners at boot would shift the
 * host's observer/listener order that the mobile-picker contract depends on.
 */

function ensureGestureTailRecorders() {
    if (_gestureTailBound || typeof document === 'undefined') return;
    _gestureTailBound = true;
    try {
        // Bubble-phase reads: at capture time nobody has run yet, so `defaultPrevented` is always
        // false there. A host that cancels `pointerdown` is exactly what suppresses the click.
        document.addEventListener('pointerdown', recordGestureDownBubble, false);
        document.addEventListener('pointerup', recordGestureUpBubble, false);
        document.addEventListener('pointerup', recordGestureUp, true);
        document.addEventListener('pointercancel', recordGestureCancel, true);
        document.addEventListener('click', recordGestureClick, true);
        // Bubble phase on document is the last stop of the dispatch: only there does
        // `defaultPrevented` already include every handler that ran, and only there does reaching
        // us prove nothing called stopPropagation on the way up.
        document.addEventListener('click', recordGestureClickBubble, false);
    } catch { /* diagnostics must never block the UI */ }
}

/**
 * Read `pointerdown.defaultPrevented` after every handler on the path has run.
 * @param {any} event
 */

function recordGestureDownBubble(event) {
    const record = _gestureActive;
    if (!record?.down || _gestureDownEvent !== event) return;
    try { record.down.preventedAfter = event.defaultPrevented === true; } catch { /* ignore */ }
}

/**
 * Same for `pointerup`.
 * @param {any} event
 */

function recordGestureUpBubble(event) {
    const record = _gestureActive;
    if (!record?.up || _gestureUpEvent !== event) return;
    try { record.up.preventedAfter = event.defaultPrevented === true; } catch { /* ignore */ }
}


function recordGestureUp(event) {
    const record = _gestureActive;
    if (!record || record.up) return;
    // The tail recorders are session-wide once armed; a press from minutes ago must not borrow the
    // release of a later, unrelated click.
    if (diagNow() - record.at > 2500) return;
    try {
        _gestureUpEvent = event;
        const target = event?.target instanceof Element ? event.target : null;
        record.up = {
            at: diagNow(),
            desc: elChainText(target, 3),
            rect: rectText(target),
            sameAsDown: Boolean(target && target === _gestureDownEl),
            // The decisive check behind "the button vanished between press and release".
            downConnected: _gestureDownEl ? _gestureDownEl.isConnected !== false : false,
            upConnected: target ? target.isConnected !== false : false,
            listSame: listIdentitySame(),
            prevented: event?.defaultPrevented === true,
            path: diagPathLength(event),
        };
        pushDiagTrace(`native-gesture:up,n=${record.n},same=${record.up.sameAsDown ? 1 : 0},downConn=${record.up.downConnected ? 1 : 0}`);
    } catch (error) {
        record.up = { error: String(error?.message || error).slice(0, 40) };
    }
}


function recordGestureCancel(event) {
    const record = _gestureActive;
    if (!record || record.cancel) return;
    try {
        record.cancel = `pointercancel|${elChainText(event?.target instanceof Element ? event.target : null, 2)}`;
        pushDiagTrace(`native-gesture:cancel,n=${record.n}`);
    } catch { /* ignore */ }
}


function recordGestureClick(event) {
    const record = _gestureActive;
    if (!record) return;
    if (record.click) return;
    if (diagNow() - record.at > 2500) return;
    try {
        const target = event?.target instanceof Element ? event.target : null;
        record.click = {
            at: diagNow(),
            desc: elChainText(target, 3),
            sameAsDown: Boolean(target && target === _gestureDownEl),
            trusted: event?.isTrusted === true,
            path: diagPathLength(event),
            listSame: listIdentitySame(),
            upToClickMs: record.up ? diagNow() - record.up.at : -1,
            bubble: false,
            prevented: false,
            // The two selects the actions read: did the plugin's restore/re-hide cycle move under
            // the host's handler between the press and the click?
            selects: selectSizes(),
            restores: _diag.restoreRuns,
            row: rowRefOf(target),
        };
        record.miss = '';
    } catch { /* ignore */ }
}


function recordGestureClickBubble(event) {
    const record = _gestureActive;
    if (!record?.click) return;
    try {
        record.click.bubble = true;
        record.click.prevented = event?.defaultPrevented === true;
    } catch { /* ignore */ }
}

/**
 * Is the entries list still the same node we pressed on? A host re-render replaces it, and a click
 * on a detached row can never reach the host's delegated handler.
 * @returns {string}
 */

function listIdentitySame() {
    try {
        const list = document.getElementById('world_popup_entries_list');
        if (!list) return 'none';
        return list === _gestureDownList ? 'same' : 'other';
    } catch { return 'err'; }
}

/**
 * Record one pointerdown inside the worldbook area and arm the rest of the sequence.
 * Reads only: no preventDefault, no stopPropagation, no DOM writes.
 *
 * The area is matched twice: by the event target (normal case) and by the hit point (a layer on top
 * of the list makes the target something else entirely — without the point check that click would
 * leave no trace at all, which is exactly the report we have to explain).
 * @param {any} event
 */

export function noteNativeGestureDown(event) {
    try {
        const target = event?.target instanceof Element ? event.target : null;
        if (!target) return;
        const point = (() => {
            const x = Number(event?.clientX);
            const y = Number(event?.clientY);
            return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
        })();
        _gestureDownEvent = event;
        const pressDialog = dialogOf(target);
        const host = target.closest?.(NATIVE_WB_AREA_SELECTOR);
        // A press inside the host's own dialog (target picker / delete confirm) is aimed at the
        // dialog, not at the list behind it: it must not be reported as "covering" the worldbook UI.
        let pointInArea = Boolean(pressDialog);
        let beneathEl = null;
        if (!host && !pressDialog && point) {
            pointInArea = pointInsideWorldbookArea(point.x, point.y);
            if (pointInArea) beneathEl = findBeneathInArea(point.x, point.y);
        }
        if (!host && !pointInArea) return;
        const areaHost = host || (beneathEl ? beneathEl.closest?.(NATIVE_WB_AREA_SELECTOR) : null);
        // Our own panel over the drawer is expected, not an obstruction: keep the two apart so a
        // report never reports "covered" for something the user did to themselves.
        const topEl = point && typeof document?.elementFromPoint === 'function'
            ? (() => { try { return document.elementFromPoint(point.x, point.y); } catch { return null; } })()
            : null;
        const ownOverlay = isOwnUiElement(topEl);
        const record = {
            n: _diag.gestureSeq + 1,
            at: diagNow(),
            host: areaHost?.id || elTagClass(areaHost, 18),
            row: rowRefOf(target),
            down: {
                desc: elChainText(target, 3),
                connected: target.isConnected !== false,
                trusted: event?.isTrusted === true,
                prevented: event?.defaultPrevented === true,
                path: diagPathLength(event),
                point: point ? `${Math.round(point.x)},${Math.round(point.y)}` : '-',
                rect: rectText(target),
                // `hit` is what the browser really delivered the press to; `beneath` is the worldbook
                // element hidden under it (empty when the press landed on the UI itself).
                hit: point ? describeHitAt(point.x, point.y, host ? target : beneathEl) : 'n/a',
                area: host ? 'by-target' : (pressDialog ? 'dialog' : 'by-point'),
                beneath: beneathEl ? elTagClass(beneathEl, 22) : 'none',
                covers: Boolean(!host && beneathEl && !ownOverlay),
                ownOverlay,
                dialog: dialogOf(target) ? elTagClass(dialogOf(target), 20) : '',
                selects: selectSizes(),
                restores: _diag.restoreRuns,
            },
            up: null,
            click: null,
            cancel: '',
            miss: '',
        };
        _diag.gestureSeq = record.n;
        _diag.nativeGestures.push(record);
        while (_diag.nativeGestures.length > 6) _diag.nativeGestures.shift();
        _gestureActive = record;
        _gestureDownEl = target;
        try { _gestureDownList = document.getElementById('world_popup_entries_list'); } catch { _gestureDownList = null; }
        ensureGestureTailRecorders();
        // A click that never comes is itself evidence (preventDefault, inert subtree, detached node,
        // or a layout shift that made the platform drop it). One timer PER record: a shared timer
        // cleared by the next press would leave fast repeated taps with no verdict at all.
        const watchdog = setTimeout(() => {
            try {
                if (!record.click) record.miss = record.up ? 'no-click' : 'no-up-no-click';
            } catch { /* ignore */ }
        }, 1200);
        if (typeof watchdog?.unref === 'function') watchdog.unref();
        _gestureWatchdog = watchdog;
        pushDiagTrace(`native-gesture:down,n=${record.n},conn=${record.down.connected ? 1 : 0}`
            + `,hit=${record.down.hit},covers=${record.down.covers ? 1 : 0}`
            + (record.down.covers ? `,beneath=${record.down.beneath}` : '')
            + (record.down.ownOverlay ? ',ownOverlay=1' : '')
            + (record.row ? `,row=${record.row.uid}@${record.row.index}` : ''));
    } catch { /* diagnostics only */ }
}

/**
 * A click inside a native entry row that the action matcher could NOT map. Without this, a host
 * build that renames its controls looks identical to "the user did nothing".
 * @param {Element | null} target
 * @param {any} gesture
 */

export function noteUnresolvedRowClick(target, gesture) {
    try {
        if (!(target instanceof Element)) return;
        if (!target.closest('.world_entry')) return;
        // Typing into a field is not a control we could ever map to an action.
        if (target.closest('input, textarea, select, option, label, [contenteditable="true"]')) return;
        if (target.closest('.menu_button, [data-action], [title]')) return;
        // Only small, class-carrying nodes: a click on the row body itself is not a control.
        const tag = target.tagName.toLowerCase();
        const controlish = ['i', 'button', 'span', 'a', 'div', 'svg'].includes(tag)
            && target.childElementCount <= 1
            && Boolean(String(target.getAttribute?.('class') ?? '') || target.getAttribute?.('title'));
        if (!controlish) return;
        const item = {
            at: diagNow(),
            target: elTagClass(target, 24),
            chain: elChainText(target, 3),
            row: gesture?.row?.uid ?? '-',
            gesture: gesture?.n ?? 0,
            covered: Boolean(gesture?.down?.covers),
        };
        _diag.nativeUnresolved.push(item);
        if (_diag.nativeUnresolved.length > 6) _diag.nativeUnresolved.shift();
        pushDiagTrace(`native-entry:rowClick,unresolved=1,cls=${String(target.getAttribute?.('class') ?? '').slice(0, 24)}`);
    } catch { /* diagnostics only */ }
}

/**
 * The native actions finish inside a host `dialog.popup` (target-book picker / delete confirm), and
 * that click is outside the entry area. Sampling it is the only way to answer "确定之后到底删没删".
 * @param {Element | null} dialogEl
 * @param {Element | null} target
 */

export function noteNativeDialogFollowUp(dialogEl, target) {
    try {
        if (!(dialogEl instanceof Element)) return;
        const entries = _diag.nativeActions;
        const dialogCls = elTagClass(dialogEl, 20);
        const recent = (item) => Boolean(item) && !item.dialogArmed && !item.dialog
            && diagNow() - (item.gesture?.at || item.settled?.at || 0) < 30000;
        // Prefer the action that opened THIS dialog (same class, recorded 500ms after the click);
        // otherwise fall back to the newest un-armed action, so a fast confirm still gets sampled.
        const entry = [...entries].reverse().find((item) => recent(item) && item.openDialog?.cls === dialogCls)
            || [...entries].reverse().find(recent);
        if (!entry) return;
        entry.dialogArmed = true;
        const list = document.getElementById('world_popup_entries_list');
        const sample = () => ({
            rows: diagRowCount(),
            uids: rowSetFingerprint(document.getElementById('world_popup_entries_list')),
            selects: selectSizes(),
            // The dialog's own target-book select: empty / out-of-range here is the one field that
            // explains "复制的条目没有出现在目标世界书".
            dialogSelects: dialogSelectsOf(dialogEl),
            currentBook: currentEditorBookHash(),
            toast: document.querySelectorAll('.toast, .toast-body, .toast-title').length,
            errors: _diag.errors.length,
        });
        const start = sample();
        const startAt = diagNow();
        const mutations = { childList: 0, added: 0, removed: 0 };
        let observer = null;
        if (list) {
            try {
                observer = new MutationObserver((records) => {
                    for (const record of records) {
                        mutations.childList += 1;
                        mutations.added += record.addedNodes.length;
                        mutations.removed += record.removedNodes.length;
                    }
                });
                observer.observe(list, { childList: true, subtree: true });
            } catch { observer = null; }
        }
        const button = elTagClass(target, 22);
        // Which button of the dialog was pressed: SillyTavern's move/copy dialog has two custom
        // buttons (Move = 1st, Copy = 2nd), so the index is what tells them apart without text.
        const dialogButtons = [...dialogEl.querySelectorAll('button, .menu_button')];
        const pressed = target?.closest?.('button, .menu_button') || target;
        const buttonIndex = dialogButtons.indexOf(pressed);
        const early = setTimeout(() => {
            try { entry.dialogEarly = sample(); } catch { /* ignore */ }
        }, 600);
        const finalTimer = setTimeout(() => {
            try {
                const end = sample();
                entry.dialog = {
                    at: startAt,
                    dialog: dialogCls,
                    button,
                    buttonIndex,
                    buttonCount: dialogButtons.length,
                    customCount: dialogEl.querySelectorAll('.popup-button-custom').length,
                    // `>0` means the plugin's own picker is mounted in this dialog.
                    enhancedTrigger: dialogEl.querySelectorAll('.wbo-popup-select-trigger, .wbo-mobile-editor-trigger').length,
                    start,
                    after600: entry.dialogEarly || null,
                    end,
                    mutations: { ...mutations },
                    rowsChanged: start.rows !== end.rows,
                    rowSetChanged: start.uids.hash !== end.uids.hash,
                    errorsGained: end.errors - start.errors,
                };
                const targetSelect = (start.dialogSelects || [])[0];
                pushDiagTrace(`native-entry:dialog,btn=${button},i=${buttonIndex}/${dialogButtons.length}`
                    + `,rows=${start.rows}->${end.rows}`
                    + `,set=${entry.dialog.rowSetChanged ? 1 : 0},muts=${mutations.childList},err=${entry.dialog.errorsGained}`
                    + `,tgt=${targetSelect ? `${targetSelect.value || 'EMPTY'}@${targetSelect.index}/${targetSelect.options}` : 'none'}`);
            } catch { /* ignore */ } finally {
                try { observer?.disconnect(); } catch { /* ignore */ }
            }
        }, 1800);
        if (typeof early?.unref === 'function') early.unref();
        if (typeof finalTimer?.unref === 'function') finalTimer.unref();
    } catch { /* diagnostics only */ }
}

/**
 * Watch the worldbook drawer for the whole session: record every open/close with a timestamp, and
 * close orphaned plugin popovers when the drawer goes away (they used to stay floating).
 */

export function installDrawerWatcher() {
    if (typeof document === 'undefined') return;
    const drawer = document.getElementById('WorldInfo');
    if (!drawer || drawer._wboDrawerWatcher) return;
    _diag.lastDrawerOpen = drawer.classList.contains('openDrawer');
    let wasOpen = _diag.lastDrawerOpen;
    const observer = new MutationObserver(() => {
        const open = drawer.classList.contains('openDrawer');
        if (open === wasOpen) return;
        const closedFromOpen = wasOpen && !open;
        wasOpen = open;
        _diag.lastDrawerOpen = open;
        const seconds = ((globalThis.performance?.now?.() || Date.now()) / 1000).toFixed(1);
        pushDiagTrace(`drawer:${open ? 'open' : 'closed'}@+${seconds}s`);
        if (!closedFromOpen) return;
        // Observe only. Closing here killed the popover the user had just opened: the host drops
        // `openDrawer` for a moment on every trigger click.
        setTimeout(() => {
            if (drawer.classList.contains('openDrawer')) return;
            const orphan = document.querySelector('.gr-container-enhanced.open, #gr-global-dropdown-container.open');
            if (orphan) pushDiagTrace('drawer:popover-orphan=1');
        }, 250);
    });
    observer.observe(drawer, { attributes: true, attributeFilter: ['class'] });
    drawer._wboDrawerWatcher = observer;
}



/**
 * The host closes an unpinned drawer on any document click, which fires while the opening click
 * of a worldbook dropdown is still settling — the drawer then disappears on the very first click.
 * Re-open it once per opening, but only when the pointer was actually inside the drawer.
 * @returns {{ dispose: () => void }}
 */

export function installDrawerOpenGuard() {
    const drawer = typeof document === 'undefined' ? null : document.getElementById('WorldInfo');
    const timers = [];
    let observer = null;
    let kept = false;
    let pointerInside = false;
    const onPointer = (event) => {
        const target = event.target instanceof Element ? event.target : null;
        pointerInside = Boolean(target && drawer && drawer.contains(target));
    };
    const isClosed = () => Boolean(drawer) && (drawer.classList.contains('closedDrawer')
        || !drawer.classList.contains('openDrawer'));
    const restore = (stage) => {
        if (kept || !drawer || !drawer.isConnected || !isClosed()) return;
        if (!pointerInside && stage !== 'open') return;
        kept = true;
        drawer.classList.add('openDrawer');
        drawer.classList.remove('closedDrawer');
        pushDiagTrace(`drawer:kept-open@${stage}`);
    };
    if (drawer) {
        document.addEventListener('pointerdown', onPointer, true);
        observer = new MutationObserver(() => restore('mutation'));
        observer.observe(drawer, { attributes: true, attributeFilter: ['class'] });
        for (const delay of [30, 120, 260]) timers.push(setTimeout(() => restore(String(delay)), delay));
    }
    return {
        dispose: () => {
            observer?.disconnect();
            for (const timer of timers.splice(0)) clearTimeout(timer);
            if (typeof document !== 'undefined') document.removeEventListener('pointerdown', onPointer, true);
        },
    };
}

/**
 * Record one breadcrumb for the detailed diagnostic (label only, never user text).
 * @param {string} label
 */

export function pushDiagTrace(label) {
    const text = String(label).slice(0, 120);
    _diag.trace.push(text);
    _diag.traceTotal += 1;
    // Key events must survive the ring buffer: a user may click a native action first and only then
    // open the panel to export, and ordinary breadcrumbs would have pushed it out.
    if (/^(native-(?:entry|gesture)|drawer|ball|enh-sync):/.test(text)) {
        _diag.highlights.push(text);
        if (_diag.highlights.length > 18) _diag.highlights.shift();
    }
    // Gesture lines are numerous; the ring has to hold a whole action sequence plus its context.
    if (_diag.trace.length > 40) _diag.trace.shift();
}

/**
 * Keep the last few measurements of the native entry list. The popup is normally closed by the time
 * a report is exported, so a live read would show zeros; these snapshots carry the evidence.
 * @param {string} stage
 */

export function snapshotNativeEntryState(stage) {
    try {
        const snapshot = collectNativeEntryDiagnostics();
        snapshot.stage = stage;
        // The click that is being explained may be older than the report: carry its sequence along.
        snapshot.gesture = gestureSummary(_gestureActive);
        _diag.nativeSnapshots.push(snapshot);
        // Eight slots: a three-action run (click + after, per action) must not evict the first action.
        if (_diag.nativeSnapshots.length > 8) _diag.nativeSnapshots.shift();
    } catch (error) {
        // A collector that throws must still leave proof it ran and why it gave up.
        _diag.nativeSnapshots.push({
            stage,
            collected: false,
            error: String(error?.message || error).slice(0, 60),
        });
        if (_diag.nativeSnapshots.length > 8) _diag.nativeSnapshots.shift();
    }
}

/**
 * Snapshot of the NATIVE worldbook entry list: whether 条目分组 is on, how many rows exist, which
 * buttons each row carries, and — the decisive part — which element actually receives a click at the
 * centre of the first row's action button. If that is not the button, something covers it.
 *
 * Every section is collected on its own so one hostile DOM cannot empty the whole snapshot: the
 * failures land in `errors[]` (see the per-section notes) instead of losing rows, buttons and the
 * hit test together.
 * @returns {Record<string, any>}
 */

export function collectNativeEntryDiagnostics() {
    const result = { available: false, errors: [] };
    const noteError = (key, error) => {
        if (result.errors.length < 8) {
            result.errors.push(`${key}:${String(error?.message || error || 'error').slice(0, 40)}`);
        }
    };
    const section = (key, fn) => {
        try { fn(); } catch (error) { noteError(key, error); }
    };
    const settings = _latestSettings || {};

    section('clock', () => { result.at = diagNow(); });
    section('groups', () => {
        result.entryGroupsEnabled = settings.entryGroupsEnabled === true;
    });
    section('popup', () => {
        const popup = document.getElementById('world_popup');
        result.popupVisible = Boolean(popup && getComputedStyle(popup).display !== 'none');
        if (!popup) return;
        const rect = popup.getBoundingClientRect();
        result.popupRect = [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)].join(',');
        result.popupDisplay = getComputedStyle(popup).display;
    });
    // Rendering path: which pipeline drew the list, and whether both native selects coexist — the
    // 复制 / 转移 actions read their target list from them.
    section('render', () => {
        result.renderPath = nativeRenderPathHint();
        result.compatDropdownScript = Boolean(hasCompatibleDropdownScript?.());
        result.surfaces = {
            popup: Boolean(document.getElementById('world_popup')),
            entriesList: Boolean(document.getElementById('world_popup_entries_list')),
            worldInfo: Boolean(document.getElementById('WorldInfo')),
            globalSelect: Boolean(document.getElementById('world_info')),
            editorSelect: Boolean(document.getElementById('world_editor_select')),
            bothSelects: Boolean(document.getElementById('world_info') && document.getElementById('world_editor_select')),
            popupAndWorldInfo: Boolean(document.getElementById('world_popup') && document.getElementById('WorldInfo')),
        };
    });
    section('list', () => {
        const list = document.getElementById('world_popup_entries_list');
        result.listPresent = Boolean(list);
        if (!list) return;
        result.listClass = String(list.className || '').slice(0, 64);
        result.decoratedByGroups = /weg-/.test(String(list.className || ''));
        result.stickyHeadings = list.querySelectorAll('.weg-native-list-sticky, .weg-native-sticky-group').length;
        // Row detection must not assume one ST layout: some rows carry `uid`, some are plain
        // `.world_entry`, older builds use direct children of the list.
        const rowCandidates = [
            ...list.querySelectorAll('.world_entry[uid]'),
            ...list.querySelectorAll('.world_entry'),
            ...list.querySelectorAll(':scope > div'),
        ];
        const rows = [...new Set(rowCandidates)].filter((row) => row instanceof HTMLElement);
        result.rowDetection = {
            withUid: list.querySelectorAll('.world_entry[uid]').length,
            worldEntry: list.querySelectorAll('.world_entry').length,
            directChildren: list.querySelectorAll(':scope > div').length,
            listChildTags: [...list.children].slice(0, 6)
                .map((child) => `${child.tagName.toLowerCase()}.${String(child.className || '').slice(0, 24)}`),
        };
        result.rows = rows.length;
        result.visibleRows = rows.filter((row) => row.getClientRects().length > 0).length;
        // Whether any row is expanded right now (the user may or may not have opened an entry).
        result.expandedRows = rows.filter((row) => row.querySelector('textarea, input[type="text"], select')).length;
        result.drawerOpen = Boolean(document.getElementById('WorldInfo')?.classList.contains('openDrawer'));
        const buttonSel = 'button, .menu_button, [data-action], [class*="copy" i], [class*="move" i], [class*="transfer" i], [class*="duplicate" i], i.fa-solid, i.fa-regular, [title]';
        // Structural dump (tag/class only, never text) so an unknown ST version is still readable.
        result.rowShape = rows.slice(0, 2).map((row) => ({
            cls: String(row.className || '').slice(0, 48),
            children: [...row.children].slice(0, 8)
                .map((child) => `${child.tagName.toLowerCase()}.${String(child.className || '').slice(0, 26)}`),
            buttons: [...row.querySelectorAll(buttonSel)].slice(0, 10)
                .map((btn) => `${btn.tagName.toLowerCase()}.${String(btn.className || '').slice(0, 26)}${btn.getAttribute('title') ? '[t]' : ''}`),
        }));
        result.rowButtons = rows.slice(0, 3).map((row) => [...row.querySelectorAll(buttonSel)]
            .map((btn) => `${String(btn.className || btn.tagName).slice(0, 28)}|${String(btn.getAttribute('title') || '').trim().slice(0, 8)}`));
        const allButtons = rows.map((row) => [...row.querySelectorAll(buttonSel)]).flat();
        // Cover all three actions, not "whatever button happens to be first": the probe must be the
        // control the bug report is about (复制 / 转移 / 删除).
        const actionButtons = allButtons.filter((btn) => nativeActionLike(btn));
        const actionVisible = actionButtons.filter((btn) => btn.getClientRects().length > 0);
        result.actionButtons = {
            total: actionButtons.length,
            visible: actionVisible.length,
            hidden: actionButtons.length - actionVisible.length,
            classes: actionButtons.slice(0, 6).map((btn) => elTagClass(btn, 24)),
        };
        const probeBtn = actionVisible[0] || allButtons.find((btn) => btn.getClientRects().length > 0);
        result.probeKind = actionVisible.length > 0 ? 'action' : (probeBtn ? 'any' : 'none');
        if (probeBtn) {
            const rect = probeBtn.getBoundingClientRect();
            const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
            result.probeButton = String(probeBtn.className || '').slice(0, 32);
            result.probeRect = [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)].join(',');
            result.hitTag = hit ? hit.tagName.toLowerCase() : 'none';
            result.hitClass = String(hit?.className || '').slice(0, 48);
            result.hitOwnsButton = Boolean(hit && (hit === probeBtn || probeBtn.contains(hit)));
            result.probePointerEvents = getComputedStyle(probeBtn).pointerEvents;
            result.probeDisabled = Boolean(probeBtn).valueOf() && (probeBtn.disabled === true || probeBtn.getAttribute('aria-disabled') === 'true');
            const chain = [];
            let node = hit;
            for (let depth = 0; depth < 3 && node instanceof Element; depth += 1) {
                chain.push(`${node.tagName.toLowerCase()}.${String(node.className || '').slice(0, 24)}`);
                node = node.parentElement;
            }
            result.hitChain = chain;
            // Read-only interaction audit of the button and its tree (never mutates anything).
            result.probeStyleChain = styleChainOf(probeBtn, list, 4);
            const hits = hitPointsOf(probeBtn);
            result.probeHitPoints = hits.points;
            result.probeObscured = hits.obscured;
            // `self` means the plugin's own panel is in the way — not a host-side obstruction.
            result.probeObscuredBy = hits.obscured ? (hits.selfOnly ? 'self' : 'foreign') : 'none';
            result.probeInert = Boolean(probeBtn.closest?.('[inert]'));
            result.probeRowUid = rowRefOf(probeBtn)?.uid ?? '-';
        }
        // Identity of the entry set: a bare row count cannot tell "one row replaced" from "no change".
        result.rowIds = rowSetFingerprint(list);
        // …and the pager explains "rows stayed at 25" without inventing a bug.
        result.pager = describePager(list);
        // Layout context: a sticky header or a zero-height scroller explains a blocked hit too.
        result.listScrollTop = Math.round(list.scrollTop || 0);
        result.listClientHeight = Math.round(list.clientHeight || 0);
        result.listScrollHeight = Math.round(list.scrollHeight || 0);
        const sticky = list.querySelector('.weg-native-list-sticky, .weg-native-sticky-group');
        if (sticky instanceof HTMLElement) {
            result.stickyPointerEvents = getComputedStyle(sticky).pointerEvents;
            result.stickyZIndex = getComputedStyle(sticky).zIndex;
        }
        const rowHit = (() => {
            const row = rows.find((item) => item.getClientRects().length > 0);
            if (!row) return null;
            const r = row.getBoundingClientRect();
            const hit = document.elementFromPoint(r.left + Math.min(24, r.width / 2), r.top + r.height / 2);
            return hit ? `${hit.tagName.toLowerCase()}.${String(hit.className || '').slice(0, 20)}${row.contains(hit) ? ':row' : ':foreign'}` : 'none';
        })();
        result.rowCenterHit = rowHit;
    });
    // The native actions build their target list from the <select>s. Recorded, never changed.
    section('selects', () => {
        const editorSel = document.getElementById('world_editor_select');
        const globalSel = document.getElementById('world_info');
        result.editorOptions = editorSel instanceof HTMLSelectElement ? editorSel.options.length : -1;
        result.globalOptions = globalSel instanceof HTMLSelectElement ? globalSel.options.length : -1;
        result.detachedOptions = getDetachedWorldNames().length;
        result.detachedGlobal = _globalDetachedMap.size;
        result.detachedEditor = _editorDetachedMap.size;
    });
    section('ctx', () => {
        // ST 1.19 no longer exposes `world_names` on the context; a `-1` here used to be silently
        // meaningless. Fall back to the module-level list and record where the number came from.
        const ctx = getHostContext?.() || {};
        let names = Array.isArray(ctx.world_names) ? ctx.world_names : null;
        let source = 'ctx.world_names';
        if (!names && Array.isArray(globalThis.world_names)) {
            names = globalThis.world_names;
            source = 'global.world_names';
        }
        if (!names) {
            const live = getLiveWorldIndexMap();
            if (live.size > 0) {
                names = [...live.keys()];
                source = 'getWorldInfoNames';
            }
        }
        result.ctxWorlds = names ? names.length : -1;
        result.ctxWorldsSource = names ? source : 'none';
    });
    section('actions', () => { result.recentActions = _diag.nativeActions; });
    section('gestures', () => {
        result.gestures = _diag.nativeGestures.slice(-3).map((record) => gestureSummary(record));
        result.lastGesture = gestureSummary(_diag.nativeGestures[_diag.nativeGestures.length - 1]);
    });
    section('unresolved', () => {
        // Row clicks we could not map to an action: a renamed host build shows up here.
        result.unresolved = _diag.nativeUnresolved.slice(-4);
    });
    // Rendered order of every dropdown head, with whether it lives inside the scrollable results
    // list or outside it. This is what pinpoints 「文风 → 已开启的全局世界书」 style complaints.
    section('order', () => {
        const dropdown = document.querySelector('.select2-dropdown, .wbo-mp-popover, .gr-container-enhanced.open, #gr-global-dropdown-container.open');
        if (!(dropdown instanceof Element)) {
            result.groupOrder = [];
            return;
        }
        result.groupOrder = [...dropdown.querySelectorAll('.select2-results__group, .wbo-dd-group-head, .wbo-pop-section')]
            // Hidden heads (e.g. the outside active-group title we now suppress) are not on screen.
            .filter((el) => el instanceof HTMLElement && el.getClientRects().length > 0)
            .slice(0, 18)
            .map((el) => {
                const section = el.classList.contains('wbo-pop-section') ? el : null;
                const id = el.getAttribute('data-wbo-dd-group')
                    || section?.getAttribute('data-wbo-dd-group')
                    || el.querySelector('[data-wbo-dd-group]')?.getAttribute('data-wbo-dd-group')
                    || '?';
                const label = String(el.textContent || '').replace(/\s+/g, '').slice(0, 10);
                const insideList = Boolean(el.closest('.select2-results__options, .gr-options-container, .wbo-mp-list'));
                return `${id}:${label}${insideList ? '' : ':outside'}`;
            });
    });
    section('picker', () => { result.lastPickerWrite = _diag.lastPickerWrite; });
    result.partial = result.errors.length > 0;
    result.available = true;
    return result;
}

/**
 * Cross-check the numbers a bug report usually disagrees with: pinned vs mounted, books vs rows,
 * groups vs rendered sections, remembered folds vs actual folds.
 * @param {any} cls
 * @param {any} settings
 * @returns {Record<string, any>}
 */

export function diagConsistencyCheck(cls, settings) {
    const result = { mismatches: [] };
    try {
        const byName = cls?.byName;
        const pinned = (settings?.pinnedBooks || []).length;
        let pinnedMounted = 0;
        for (const meta of byName?.values?.() || []) {
            if (meta?.isPinned && meta?.isMounted) pinnedMounted += 1;
        }
        result.pinned = pinned;
        result.pinnedMounted = pinnedMounted;
        const rows = document.querySelectorAll('.gr-option').length;
        result.books = byName?.size || 0;
        result.rows = rows;
        const sections = document.querySelectorAll('.wbo-pop-section').length;
        result.groups = (settings?.groups || []).length;
        result.sections = sections;
        const remembered = Object.keys(settings?.dropdownCollapsed || {}).filter((key) => settings.dropdownCollapsed[key]).length;
        const collapsedNow = document.querySelectorAll('.wbo-pop-section.wbo-dd-collapsed').length;
        result.collapsedMemory = remembered;
        result.collapsedNow = collapsedNow;
        if (rows > 0 && result.books > 0 && rows < result.books) result.mismatches.push('rows<books');
        if (sections > 0 && result.groups > 0 && sections < result.groups) result.mismatches.push('sections<groups');
        if (pinned > 0 && pinnedMounted > pinned) result.mismatches.push('pinnedMounted>pinned');
        // The report is usually exported after the popover closed, when the DOM reads 0. Fall back to
        // the last open-stage snapshot so the numbers are not silently meaningless.
        if (rows === 0 && _diag.stages.length > 0) {
            const lastStage = _diag.stages[_diag.stages.length - 1];
            result.sampledFrom = 'stage:' + lastStage.stage;
            result.rows = lastStage.rows;
            result.sections = lastStage.sections;
            result.collapsedNow = lastStage.collapsedRows;
        } else {
            result.sampledFrom = 'live';
        }
        // A mismatch must carry the numbers, otherwise it is not actionable.
        result.mismatchDetail = {
            pinned,
            pinnedMounted,
            books: result.books,
            rows: result.rows,
            groups: result.groups,
            sections: result.sections,
            collapsedMemory: remembered,
            collapsedNow: result.collapsedNow,
        };
    } catch { /* diagnostics must never throw */ }
    return result;
}

/**
 * Record a snapshot of the live dropdown metrics at a named stage (open / rendered / search /
 * cleared). Cheap, and the only way to see values that vanish once the popover closes.
 * @param {string} stage
 * @param {Element | null} host
 * @param {string} [reason]
 */

export function snapshotDiagStage(stage, host, reason = '') {
    try {
        const listHost = host || document.querySelector('.gr-options, .gr-options-container');
        const rows = listHost ? [...listHost.querySelectorAll('.gr-option')] : [];
        const visibleRows = rows.filter((row) => row.getClientRects().length > 0).length;
        const popover = document.querySelector('[data-wbo-popover-role]');
        const panel = document.querySelector('.wbo-enhanced-search-panel');
        const hiddenCount = (cls) => rows.filter((row) => row.classList.contains(cls)).length;
        _diag.stages.push({
            stage,
            reason,
            at: Math.round(globalThis.performance?.now?.() || 0),
            role: popover?.getAttribute('data-wbo-popover-role') || '',
            rows: rows.length,
            visibleRows,
            hiddenRows: rows.length - visibleRows,
            hiddenBySearch: hiddenCount('wbo-enhanced-search-hidden') + hiddenCount('wbo-pop-search-hidden'),
            hiddenByPin: hiddenCount('wbo-dd-pin-hidden'),
            hiddenByDupe: hiddenCount('wbo-dd-dupe-hidden'),
            collapsedRows: rows.filter((row) => row.closest('.wbo-dd-collapsed')).length,
            popoverH: Math.round(popover?.getBoundingClientRect?.().height || 0),
            listHostH: Math.round(listHost?.getBoundingClientRect?.().height || 0),
            panelH: Math.round(panel?.getBoundingClientRect?.().height || 0),
            scrollTop: Math.round(listHost?.scrollTop || 0),
            pageScroll: Math.round(document.scrollingElement?.scrollTop || 0),
            sections: document.querySelectorAll('.wbo-pop-section').length,
            drawerOpen: Boolean(document.getElementById('WorldInfo')?.classList.contains('openDrawer')),
        });
        if (_diag.stages.length > 8) _diag.stages.shift();
    } catch { /* a snapshot must never break rendering */ }
}

/**
 * Record one user-visible action for the diagnostic report (label only).
 * @param {string} label
 */

export function pushDiagAction(label) {
    _diag.actions.push({ at: Date.now(), label });
    if (_diag.actions.length > 12) _diag.actions.shift();
}

/**
 * Replace every known book / character / group name inside a free-form string.
 * @param {string} text
 * @returns {string}
 */

export function sanitizeDiagText(text) {
    let out = String(text ?? '');
    const byName = _latestClassification?.byName;
    for (const [name, meta] of (byName || [])) {
        if (name) out = out.split(name).join('<book>');
        for (const owner of meta?.charOwners || []) {
            if (owner?.charName) out = out.split(owner.charName).join('<char>');
        }
    }
    for (const section of (_latestClassification?.orderedSections || [])) {
        if (section?.name) out = out.split(section.name).join('<group>');
    }
    return out.length > 240 ? `${out.slice(0, 240)}…` : out;
}

/**
 * Report the runtime facts that decide which rendering path the plugin takes. Deliberately
 * name-free so a user can paste it anywhere.
 * @returns {Record<string, any>}
 */

export function detectDiagnosticEnv() {
    const ua = String(globalThis.navigator?.userAgent || '');
    const browser = /Edg\//.test(ua) ? 'Edge'
        : /Quark\//i.test(ua) ? 'Quark'
            : /Firefox\//.test(ua) ? 'Firefox'
                : /Chrome\//.test(ua) ? 'Chrome'
                    : /Safari\//.test(ua) ? 'Safari'
                        : 'unknown';
    const os = /Windows NT/.test(ua) ? 'Windows'
        : /Android/.test(ua) ? 'Android'
            : /iPhone|iPad|iPod/.test(ua) ? 'iOS'
                : /Mac OS X/.test(ua) ? 'macOS'
                    : /Linux/.test(ua) ? 'Linux'
                        : 'unknown';
    const width = Math.round(globalThis.innerWidth || 0);
    const height = Math.round(globalThis.innerHeight || 0);
    const ctx = getHostContext?.() || null;
    return {
        pluginVersion: PLUGIN_VERSION,
        host: isTauriTavern?.() ? 'TauriTavern' : 'SillyTavern',
        // SillyTavern often leaves `ctx.version` empty; fall back to the visible badge and DOM hints.
        stVersion: String(
            ctx?.version
            || ctx?.versionName
            || globalThis.SillyTavern?.version
            || document.querySelector('#version_display, #versionDisplay')?.textContent?.trim()
            || document.querySelector('.versionDisplay')?.textContent?.trim()
            || 'unknown',
        ),
        tauriVersion: String(globalThis.__TAURITAVERN__?.version || globalThis.__TAURITAVERN_VERSION__ || ''),
        browser,
        os,
        viewport: `${width}×${height}@${globalThis.devicePixelRatio || 1}x`,
        mobileViewport: Boolean(width <= 680),
        renderPath: (() => {
            if (typeof document === 'undefined') return _diag.lastRenderPath || 'none';
            if (document.querySelector('[data-wbo-popover-role="global"]')) return 'enhanced-script:global';
            if (document.querySelector('[data-wbo-popover-role="editor"]')) return 'enhanced-script:editor';
            if (document.querySelector('.select2-dropdown')) return 'select2';
            if (document.querySelector('#gr-global-dropdown-container, .gr-container-enhanced')) return 'enhanced-shell-idle';
            return _diag.lastRenderPath || 'none-open';
        })(),
        compatDropdownScript: Boolean(hasCompatibleDropdownScript?.()),
        theme: (() => {
            const theme = String(getPowerUserSettings?.()?.theme || '');
            trackDiagEnvironment({ theme });
            return theme;
        })(),
        extensionSettingsKeys: Object.keys(ctx?.extensionSettings || {}).length,
    };
}

/**
 * Snapshot of the DOM the dropdown currently uses — counts only, no text.
 * @returns {Record<string, number>}
 */
