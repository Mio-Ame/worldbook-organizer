/**
 * row-attribute self-healing and dropdown group-order enforcement.
 *
 * Move-only slice of src/native-filter.js (original lines 1331-1537). Not a single body was
 * rewritten: the declarations are byte-identical and the surrounding wiring is import/export
 * only. The hub re-imports whatever it still calls, so import sites outside did not change.
 */

import { pushDiagTrace } from './diagnostics.js';
import { ACTIVE_GLOBAL_SECTION_ID, EDITOR_GLOBALS_GROUP_ID, SPECIAL_GROUPS, _currentlyEditingWorld, _latestClassification, getCurrentEditorWorldName, orderSectionsForExternalDropdown } from '../native-filter.js';

export function repairNativeRowActionAttrs(scope = null) {
    try {
        const list = scope instanceof Element ? scope : document.getElementById('world_popup_entries_list');
        if (!(list instanceof Element)) return 0;
        const bookName = String(getCurrentEditorWorldName?.() || _currentlyEditingWorld || '');
        const $ = globalThis.jQuery;
        let repaired = 0;
        for (const row of list.querySelectorAll('.world_entry')) {
            const uid = String(row.getAttribute('uid') || '');
            if (!uid) continue;
            const move = row.querySelector('.move_entry_button');
            if (move instanceof HTMLElement) {
                if (move.getAttribute('data-uid') !== uid) {
                    move.setAttribute('data-uid', uid);
                    repaired += 1;
                }
                if (bookName && move.getAttribute('data-current-world') !== bookName) {
                    move.setAttribute('data-current-world', bookName);
                    repaired += 1;
                }
            }
            for (const selector of ['.duplicate_entry_button', '.delete_entry_button']) {
                const btn = row.querySelector(selector);
                if (!(btn instanceof HTMLElement) || !$) continue;
                if (String($(btn).data('uid') ?? '') !== uid) {
                    $(btn).data('uid', uid);
                    repaired += 1;
                }
            }
        }
        if (repaired > 0) pushDiagTrace(`native-entry:row-attrs-repaired=${repaired}`);
        return repaired;
    } catch { return 0; }
}

/**
 * Desired order of the dropdown groups: 已开启的全局世界书 → 已收藏 → 用户设置里的分组顺序 → 未分组最后。
 * Derived from the same classification the settings panel shows, so the dropdown cannot disagree
 * with the panel ("diff 里顺序是对的，下拉里不是").
 * @returns {string[]}
 */

function dropdownGroupOrder() {
    const order = [ACTIVE_GLOBAL_SECTION_ID, EDITOR_GLOBALS_GROUP_ID, SPECIAL_GROUPS.PINNED];
    try {
        for (const sec of orderSectionsForExternalDropdown(_latestClassification?.orderedSections || [])) {
            const id = typeof sec === 'string' ? sec : sec?.id;
            if (id && !order.includes(id)) order.push(id);
        }
    } catch { /* ignore */ }
    if (!order.includes(SPECIAL_GROUPS.UNGROUPED)) order.push(SPECIAL_GROUPS.UNGROUPED);
    return order;
}

/**
 * @param {string} id
 * @param {string[]} order
 * @returns {number}
 */

function groupOrderRank(id, order) {
    const index = order.indexOf(String(id || ''));
    return index >= 0 ? index : order.length + 1;
}

/**
 * Re-assert the group order inside a Select2 results list. Handles both shapes: a bare
 * `li.select2-results__group` head followed by its rows, and Select2's optgroup wrappers.
 * @param {Element | null} list
 * @returns {boolean} whether anything moved
 */

export function enforceSelect2GroupOrder(list) {
    try {
        if (!(list instanceof Element)) return false;
        const isGroupNode = (el) => el instanceof HTMLElement && (
            el.classList.contains('select2-results__group')
            || el.hasAttribute('data-wbo-dd-group')
            || el.classList.contains('select2-results__option--group'));
        const nodes = [...list.children].filter(isGroupNode);
        if (nodes.length < 2) return false;
        const order = dropdownGroupOrder();
        const sectionNameToId = new Map();
        for (const sec of orderSectionsForExternalDropdown(_latestClassification?.orderedSections || [])) {
            const id = typeof sec === 'string' ? sec : sec?.id;
            const name = typeof sec === 'string' ? sec : sec?.name;
            if (id && name) sectionNameToId.set(String(name), id);
        }
        const idOf = (el) => {
            const own = el.getAttribute('data-wbo-dd-group');
            if (own) return own;
            const head = el.querySelector('.select2-results__group');
            const fromHead = head?.getAttribute('data-wbo-dd-group');
            if (fromHead) return fromHead;
            const label = String(head?.textContent || el.textContent || '')
                .replace(/\s*\(\d+\)\s*$/, '').trim();
            return sectionNameToId.get(label) || '';
        };
        const blocks = nodes.map((el) => {
            if (el.classList.contains('select2-results__group')) {
                const block = [el];
                for (let next = el.nextElementSibling; next && !isGroupNode(next); next = next.nextElementSibling) {
                    block.push(next);
                }
                return block;
            }
            return [el];
        });
        const ranked = blocks.map((block, index) => ({ block, index, rank: groupOrderRank(idOf(block[0]), order) }));
        const sorted = [...ranked].sort((a, b) => (a.rank === b.rank ? a.index - b.index : a.rank - b.rank));
        if (sorted.every((item, index) => item.index === index)) return false;
        // Inserting every block (in order) before the first current block keeps them contiguous.
        const marker = nodes[0];
        for (const item of sorted) {
            for (const el of item.block) list.insertBefore(el, marker);
        }
        pushDiagTrace(`enh-order:enforced=${sorted.map((item) => idOf(item.block[0]) || '?').join('>')}`);
        return true;
    } catch { return false; }
}

/**
 * Same rule for the plugin's own dropdown shell (`.wbo-pop-section` children).
 * @param {Element | null} optionsHost
 * @returns {boolean}
 */

export function enforceShellGroupOrder(optionsHost) {
    try {
        if (!(optionsHost instanceof Element)) return false;
        const sections = [...optionsHost.children].filter((el) => el.classList.contains('wbo-pop-section'));
        if (sections.length < 2) return false;
        const order = dropdownGroupOrder();
        const ranked = sections.map((el, index) => ({
            el,
            index,
            rank: groupOrderRank(el.getAttribute('data-wbo-dd-group') || '', order),
        }));
        const sorted = [...ranked].sort((a, b) => (a.rank === b.rank ? a.index - b.index : a.rank - b.rank));
        if (sorted.every((item, index) => item.index === index)) return false;
        const marker = sections[0];
        for (const item of sorted) optionsHost.insertBefore(item.el, marker);
        pushDiagTrace(`enh-order:shell=${sorted.map((item) => item.el.getAttribute('data-wbo-dd-group') || '?').join('>')}`);
        return true;
    } catch { return false; }
}

/**
 * The 「已开启的全局世界书」 block must be the FIRST group of a dropdown: mounted books are pinned to
 * the top by the host, so a normal section head above it reads as
 * 「文风 → 已开启的全局世界书 → 全局那几本 → 文风那几本」. Select2 rebuilds and pill switches can
 * re-insert a section head above it, so the order is enforced (idempotently) after every rebuild.
 * @param {Element | null} resultsList
 * @returns {boolean} whether anything had to move
 */

function hoistSelect2GlobalsBlock(resultsList) {
    try {
        if (!(resultsList instanceof Element)) return false;
        const heads = [...resultsList.children].filter((el) => el.classList.contains('select2-results__group'));
        const globalsHead = heads.find((el) => el.getAttribute('data-wbo-dd-group') === ACTIVE_GLOBAL_SECTION_ID);
        if (!globalsHead || heads[0] === globalsHead) return false;
        const block = [globalsHead];
        for (let node = globalsHead.nextElementSibling;
            node && !node.classList.contains('select2-results__group');
            node = node.nextElementSibling) {
            block.push(node);
        }
        const anchor = resultsList.firstElementChild;
        for (const el of block) resultsList.insertBefore(el, anchor);
        return true;
    } catch { return false; }
}

/**
 * Same rule for the plugin's own dropdown shell (`.wbo-pop-section` children).
 * @param {Element | null} optionsHost
 * @returns {boolean}
 */

function hoistEnhancedGlobalsBlock(optionsHost) {
    try {
        if (!(optionsHost instanceof Element)) return false;
        const sections = [...optionsHost.children].filter((el) => el.classList.contains('wbo-pop-section'));
        if (sections.length < 2) return false;
        const globals = sections.find((el) => el.getAttribute('data-wbo-dd-group') === EDITOR_GLOBALS_GROUP_ID);
        if (!globals || sections[0] === globals) return false;
        optionsHost.insertBefore(globals, sections[0]);
        return true;
    } catch { return false; }
}

/**
 * Length of the event path (capture/target/bubble nodes). `-1` when the platform hides it.
 * @param {any} event
 * @returns {number}
 */
