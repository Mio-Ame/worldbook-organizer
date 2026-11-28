/**
 * observer utility helpers for the enhanced popovers.
 *
 * Move-only slice of src/native-filter.js (original lines 8473-8698). Not a single body was
 * rewritten: the declarations are byte-identical and the surrounding wiring is import/export
 * only. The hub re-imports whatever it still calls, so import sites outside did not change.
 */

import { SCRIPT_THEME_PROPERTIES, _observersActive, detectEnhancedPopoverRole, enhanceCustomDropdownPopover, getEnhancedOptionNodes, getEnhancedPopoverOptionText, unbindDrawerSafeBubbleGuard } from '../native-filter.js';

export const _containerObserverMap = new WeakMap();
/** @type {WeakMap<HTMLElement, MutationObserver>} */

export const _hostObserverMap = new WeakMap();
/** @type {Set<HTMLElement>} */

export const _observedContainers = new Set();
/** @type {Set<HTMLElement>} */

export const _observedHosts = new Set();
/** @type {Set<MutationObserver>} */

export const _activeEnhancedObservers = new Set();
/** @type {Set<any>} */

export const _activePopoverRestoreTimers = new Set();
/** @type {Map<HTMLElement, { kind: 'raf' | 'timeout', id: any }>} */

export const _pendingContainerEnhance = new Map();
/** @type {Set<any>} */

export const _activeEnhancedRafs = new Set();

const _borrowedListeners = new WeakMap();

const _borrowedLayouts = new WeakMap();

const _borrowedRowText = new WeakMap();

export function listenOnBorrowed(target, type, listener, options) {
    target.addEventListener(type, listener, options);
    let listeners = _borrowedListeners.get(target);
    if (!listeners) _borrowedListeners.set(target, listeners = []);
    listeners.push([type, listener, options]);
    target.dataset.wboBorrowedListeners = '1';
}


export function rememberBorrowedLayout(host) {
    const rows = new Set(getEnhancedOptionNodes(host));
    const previous = _borrowedLayouts.get(host);
    if (previous && [...rows].every((row) => previous.rows.has(row))) return;
    let children = [...host.childNodes];
    if (previous && [...rows].some((row) => previous.rows.has(row))) {
        const added = children.filter((node) => !previous.children.includes(node)
            && !(node instanceof Element && node.matches('.wbo-pop-section, [data-wbo-ui]')));
        children = [...previous.children.filter((node) => !previous.rows.has(node) || rows.has(node)), ...added];
    }
    _borrowedLayouts.set(host, { rows, children });
    host.dataset.wboBorrowedLayout = '1';
}


export function restoreBorrowedPopover(container) {
    container._wboPopState?.cancelRestore?.();
    for (const host of container.querySelectorAll('[data-wbo-borrowed-layout]')) restoreBorrowedLayout(host);
    if (container.hasAttribute('data-wbo-borrowed-layout')) restoreBorrowedLayout(container);
    container.querySelectorAll('.wbo-pop-filter-bar, .wbo-preset-filter-bar, .wbo-pop-search, .wbo-enhanced-picker-clear, .wbo-s2-right, [data-wbo-editing-badge]').forEach((node) => node.remove());
    container.querySelectorAll('.wbo-enhanced-sticky').forEach((node) => node.replaceWith(...node.children));
    for (const row of getEnhancedOptionNodes(container)) {
        const originalText = _borrowedRowText.get(row);
        if (originalText) {
            row.querySelector('.wbo-gr-world-title')?.replaceWith(...originalText);
            _borrowedRowText.delete(row);
        }
    }
    for (const node of [container, ...container.querySelectorAll('*')]) {
        for (const [type, listener, options] of _borrowedListeners.get(node) || []) node.removeEventListener(type, listener, options);
        _borrowedListeners.delete(node);
        unbindDrawerSafeBubbleGuard(node);
        for (const cls of ['wbo-has-pin', 'wbo-pop-search-hidden', 'wbo-dd-pin-hidden', 'wbo-preset-group-hidden', 'wbo-enhanced-clear-option']) node.classList.remove(cls);
        for (const key of Object.keys(node.dataset || {})) if (key.startsWith('wbo')) delete node.dataset[key];
        for (const key of SCRIPT_THEME_PROPERTIES) node.style?.removeProperty?.(`--wbo-script-${key}`);
        node.style?.removeProperty?.('--wbo-enhanced-toolbar-height');
    }
    delete container._wboPopState;
    delete container._wboOnPinChanged;
}


function restoreBorrowedLayout(host) {
    const layout = _borrowedLayouts.get(host);
    if (!layout) return;
    const live = new Set(getEnhancedOptionNodes(host));
    // Restore only this render generation; never resurrect options removed by the host.
    for (const child of layout.children) {
        if (live.has(child) || (child instanceof Element && child.matches('.gr-group-label') && [...layout.rows].some((row) => live.has(row)))) host.appendChild(child);
    }
    host.querySelectorAll(':scope > .wbo-pop-section').forEach((section) => {
        for (const row of getEnhancedOptionNodes(section)) host.appendChild(row);
        section.remove();
    });
    _borrowedLayouts.delete(host);
}


export function scheduleEnhancedRaf(cb) {
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


export function markIfPersistentPopover(el) {
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


export function scheduleContainerReEnhance(containerEl) {
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


export function handleEnhancedContainerMutations(containerEl, mutations) {
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


export function ensureEnhancedContainerObserver(containerEl) {
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
