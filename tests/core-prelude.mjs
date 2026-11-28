/**
 * Shared prelude for the split core test suite (formerly the top of tests/core.test.mjs).
 *
 * Everything here is a verbatim move: the helper functions and the single `../src/core.js`
 * import list were simply lifted out so that the focused test files can share them. The
 * re-export block keeps the same names visible to the split files without rewriting any
 * test body.
 */

import test from 'node:test';

import assert from 'node:assert/strict';

import { readdirSync, readFileSync } from 'node:fs';

import util from 'node:util';

import { STYLE_SOURCE_FILES, readStyleSource } from './style-source.mjs';

export function getPanelSourcePaths() {
    const panelSources = readdirSync(new URL('../src/', import.meta.url))
        .filter((name) => /^panel(?:-[a-z-]+)?\.js$/.test(name))
        .map((name) => `../src/${name}`);
    return [...panelSources, '../src/entry-groups/panel.js'];
}

export function readPanelSource() {
    return getPanelSourcePaths()
        .map((file) => readFileSync(new URL(file, import.meta.url), 'utf8'))
        .join('\n');
}

/**
 * Every source file of the native-filter layer: the hub plus the focus modules it was split into
 * (src/native-filter/*.js). The static guards scan the whole set, so a rule moved into a submodule
 * is still covered by them.
 */
export function getNativeFilterSourcePaths() {
    const focused = readdirSync(new URL('../src/native-filter/', import.meta.url))
        .filter((name) => name.endsWith('.js'))
        .sort()
        .map((name) => `../src/native-filter/${name}`);
    return ['../src/native-filter.js', ...focused];
}

import {
    AI_ORGANIZE_CATEGORY_PRESETS,
    AI_ORGANIZE_NAMING_PRESETS,
    DEFAULT_LOCAL_ORGANIZE_CATEGORY_IDS,
    DEFAULT_SETTINGS,
    GROUP_COLOR_PALETTE,
    LOCAL_ORGANIZE_CATEGORIES,
    MODULE_NAME,
    SECTION_ORDER_VERSION,
    SPECIAL_GROUPS,
    WORLD_ENTRY_POSITIONS,
    addCustomGroup,
    analyzeSensitiveOrganizeState,
    applyAiOrganizeProposals,
    buildAiOrganizePrompt,
    buildCharBooksCountMap,
    buildLocalOrganizeProposals,
    buildCharacterBindingIndex,
    buildPersonaBindingIndex,
    charaFileName,
    classifyWorldbooks,
    cleanupDeletedWorldSettings,
    compareWorldbookEntries,
    compareZhCn,
    computeReorderedEntries,
    computeScanPromptState,
    createApiChannelId,
    createGlobalPresetId,
    createGroupId,
    createNewRawWorldEntry,
    deepClone,
    deleteAiOrganizePreset,
    deleteGlobalPreset,
    detectAiRefusal,
    estimateEntryTokens,
    exportConfigData,
    extractEmbeddedCharacterBookPreview,
    extractEntryListItems,
    extractSingleEntryForEdit,
    findCardsWithUnimportedBooks,
    findMatchingGlobalPreset,
    findSensitiveTargetGroup,
    findUnboundCharacterNameMatches,
    findUnscannedShallowCharacters,
    formatCharacterDisplayTitle,
    getEffectiveAiOrganizePresets,
    getVisibleSectionMoveBounds,
    importConfigData,
    isBookPinned,
    isBookVisibleInCharBindPopup,
    isBookVisibleInSelector,
    isPotentiallySensitiveTitle,
    matchesSearch,
    mergeEntryPatchOntoRaw,
    migrateSettingsOnWorldRename,
    moveBooksToNamedGroup,
    moveGlobalPreset,
    moveSectionOrder,
    normalizeEntryKeywordsInput,
    normalizeMatchName,
    normalizeSettings,
    orderSectionsForExternalDropdown,
    parseAiOrganizeResponse,
    parseOptionalFiniteNumber,
    partitionGroupPickerBooks,
    promoteSectionToTop,
    pruneStaleWorldbookSettings,
    pushUndoSnapshot,
    reorderBookInGroup,
    reorderEntryUids,
    reorderSection,
    resetAiOrganizePresets,
    restoreOrganizeSnapshot,
    searchEntriesInPayload,
    sortEntryListItems,
    summarizeCharacterWorldCoverage,
    summarizePersonaWorldBindings,
    togglePinnedBook,
    undoLastAiOrganize,
    updateCachedCharBindings,
    upsertAiOrganizePreset,
    upsertGlobalPreset,
} from '../src/core.js';

export function installMockNativeFilterDom({ innerWidth = 390, innerHeight = 844 } = {}) {
    const saved = {
        window: globalThis.window,
        document: globalThis.document,
        Element: globalThis.Element,
        HTMLElement: globalThis.HTMLElement,
        HTMLInputElement: globalThis.HTMLInputElement,
        HTMLTextAreaElement: globalThis.HTMLTextAreaElement,
        HTMLButtonElement: globalThis.HTMLButtonElement,
        HTMLSelectElement: globalThis.HTMLSelectElement,
        HTMLOptionElement: globalThis.HTMLOptionElement,
        HTMLOptGroupElement: globalThis.HTMLOptGroupElement,
        Event: globalThis.Event,
        PointerEvent: globalThis.PointerEvent,
        CustomEvent: globalThis.CustomEvent,
        KeyboardEvent: globalThis.KeyboardEvent,
        confirm: globalThis.confirm,
        MutationObserver: globalThis.MutationObserver,
        CSS: globalThis.CSS,
        jQuery: globalThis.jQuery,
        SillyTavern: globalThis.SillyTavern,
        requestAnimationFrame: globalThis.requestAnimationFrame,
        getComputedStyle: globalThis.getComputedStyle,
        visualViewport: globalThis.visualViewport,
        innerWidth: globalThis.innerWidth,
        innerHeight: globalThis.innerHeight,
        addEventListener: globalThis.addEventListener,
        removeEventListener: globalThis.removeEventListener,
        dispatchEvent: globalThis.dispatchEvent,
    };

    const winListeners = new Map();
    const vvListeners = new Map();
    const observerInstances = [];

    class MockEvent {
        constructor(type, init = {}) {
            this.type = type;
            this.bubbles = Boolean(init.bubbles);
            this.cancelable = Boolean(init.cancelable);
            this.defaultPrevented = false;
            this.cancelBubble = false;
            this.target = init.target || null;
            this.currentTarget = null;
            this.key = init.key || '';
            this.code = init.code || '';
            this.keyCode = init.keyCode || 0;
            this.clientX = init.clientX ?? 0;
            this.clientY = init.clientY ?? 0;
            this.pointerId = init.pointerId ?? 1;
            this.pointerType = init.pointerType ?? 'mouse';
            this.button = init.button ?? 0;
        }
        preventDefault() {
            this.defaultPrevented = true;
        }
        stopPropagation() {
            this.cancelBubble = true;
        }
        stopImmediatePropagation() {
            this.cancelBubble = true;
            this._stopImmediate = true;
        }
    }

    class MockClassList {
        constructor(el) {
            Object.defineProperty(this, '_el', {
                value: el,
                writable: true,
                configurable: true,
                enumerable: false,
            });
            this._set = new Set();
        }
        [util.inspect.custom]() {
            return `MockClassList(${[...this._set].join(' ')})`;
        }
        _syncFromString(str) {
            this._set = new Set(String(str || '').split(/\s+/).filter(Boolean));
        }
        _syncToAttr() {
            this._el._attrs.set('class', [...this._set].join(' '));
        }
        add(...names) {
            for (const n of names) if (n) this._set.add(n);
            this._syncToAttr();
        }
        remove(...names) {
            for (const n of names) this._set.delete(n);
            this._syncToAttr();
        }
        toggle(name, force) {
            if (force === undefined) {
                if (this._set.has(name)) this._set.delete(name);
                else this._set.add(name);
            } else if (force) {
                this._set.add(name);
            } else {
                this._set.delete(name);
            }
            this._syncToAttr();
            return this._set.has(name);
        }
        contains(name) {
            return this._set.has(name);
        }
    }

    function parseAttrs(rawAttrs) {
        const attrs = new Map();
        const re = /([a-zA-Z0-9_:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
        let m;
        while ((m = re.exec(rawAttrs)) !== null) {
            attrs.set(m[1], m[2] ?? m[3] ?? m[4] ?? '');
        }
        return attrs;
    }

    function matchesCompound(el, compound) {
        if (!(el instanceof MockElement)) return false;
        let clean = compound.replace(/^:scope\s*>\s*/, '').trim();
        if (!clean) return false;
        const notClauses = [];
        clean = clean.replace(/:not\(([^)]+)\)/g, (_, inner) => {
            notClauses.push(inner.trim());
            return '';
        });
        let requireChecked = false;
        if (clean.includes(':checked')) {
            requireChecked = true;
            clean = clean.replace(/:checked/g, '');
        }
        if (clean) {
            const tokens = clean.match(/([#.][^\s#.[\]:]+|\[[^\]]+\]|^[a-zA-Z0-9_-]+)/g);
            if (!tokens || tokens.join('') !== clean) return false;
            for (const tok of tokens) {
                if (tok.startsWith('#')) {
                    if (el.id !== tok.slice(1)) return false;
                } else if (tok.startsWith('.')) {
                    if (!el.classList.contains(tok.slice(1))) return false;
                } else if (tok.startsWith('[')) {
                    const m = tok.match(/^\[([a-zA-Z0-9_:-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]$/);
                    if (!m) return false;
                    const attrName = m[1];
                    if (!el.hasAttribute(attrName)) return false;
                    const expected = m[2] ?? m[3] ?? m[4];
                    if (expected !== undefined && el.getAttribute(attrName) !== expected) return false;
                } else if (el.tagName !== tok.toUpperCase()) {
                    return false;
                }
            }
        }
        if (requireChecked) {
            if (el.tagName === 'OPTION') {
                if (!el.selected) return false;
            } else if (!el.checked) {
                return false;
            }
        }
        for (const inner of notClauses) {
            if (matchesCompound(el, inner)) return false;
        }
        return true;
    }

    function matchesSelector(el, selector, scopeEl = null) {
        if (!(el instanceof MockElement)) return false;
        const groups = String(selector || '').split(',').map((s) => s.trim()).filter(Boolean);
        return groups.some((grp) => {
            if (scopeEl && grp.startsWith(':scope')) {
                const rest = grp.replace(/^:scope\s*>\s*/, '').trim();
                if (grp.includes('>')) {
                    return el.parentElement === scopeEl && matchesCompound(el, rest);
                }
            }
            const parts = grp.replace(/>/g, ' ').trim().split(/\s+/).filter(Boolean);
            if (parts.length === 0) return false;
            if (!matchesCompound(el, parts[parts.length - 1])) return false;
            let cur = el.parentElement;
            for (let i = parts.length - 2; i >= 0; i -= 1) {
                while (cur && !matchesCompound(cur, parts[i])) {
                    cur = cur.parentElement;
                }
                if (!cur) return false;
                cur = cur.parentElement;
            }
            return true;
        });
    }

    class MockNode {
        constructor(nodeType, textContent = '') {
            this.nodeType = nodeType;
            Object.defineProperty(this, 'parentNode', {
                value: null,
                writable: true,
                configurable: true,
                enumerable: false,
            });
            this._textContent = textContent;
        }
        [util.inspect.custom]() {
            return `MockNode(type=${this.nodeType})`;
        }
        get parentElement() {
            return this.parentNode instanceof MockElement ? this.parentNode : null;
        }
        get textContent() {
            return this._textContent;
        }
        set textContent(v) {
            this._textContent = String(v ?? '');
        }
        remove() {
            if (this.parentNode) {
                const idx = this.parentNode.childNodes.indexOf(this);
                if (idx >= 0) this.parentNode.childNodes.splice(idx, 1);
                this.parentNode = null;
            }
        }
    }

    class MockElement extends MockNode {
        constructor(tagName) {
            super(1, '');
            this.tagName = String(tagName || 'div').toUpperCase();
            this.childNodes = [];
            this._attrs = new Map();
            this.classList = new MockClassList(this);
            this.style = {
                setProperty(k, v) { this[k] = String(v ?? ''); },
                removeProperty(k) { delete this[k]; },
                getPropertyValue(k) { return this[k] ?? ''; },
            };
            this._listeners = new Map();
            this._rect = { left: 10, top: 100, right: 250, bottom: 136, width: 240, height: 36 };
            this.scrollTop = 0;
            this.scrollLeft = 0;
            this.scrollWidth = 200;
            this.clientWidth = 200;
            this.scrollHeight = 200;
            this.clientHeight = 200;
            this.disabled = false;
            this.dataset = new Proxy({}, {
                get: (_, prop) => {
                    const attr = `data-${String(prop).replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`;
                    return this._attrs.has(attr) ? this._attrs.get(attr) : undefined;
                },
                set: (_, prop, val) => {
                    const attr = `data-${String(prop).replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`;
                    this._attrs.set(attr, String(val));
                    return true;
                },
                deleteProperty: (_, prop) => {
                    const attr = `data-${String(prop).replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`;
                    this._attrs.delete(attr);
                    return true;
                },
            });
        }
        get hidden() {
            return this._attrs.has('hidden');
        }
        set hidden(v) {
            if (v) this._attrs.set('hidden', '');
            else this._attrs.delete('hidden');
        }
        get isConnected() {
            let cur = this;
            while (cur) {
                if (cur === doc.documentElement || cur === doc.body) return true;
                cur = cur.parentNode;
            }
            return false;
        }
        get id() {
            return this._attrs.get('id') || '';
        }
        set id(val) {
            this._attrs.set('id', String(val ?? ''));
        }
        get className() {
            return this._attrs.get('class') || '';
        }
        set className(val) {
            this._attrs.set('class', String(val ?? ''));
            this.classList._syncFromString(val);
        }
        get children() {
            return this.childNodes.filter((c) => c instanceof MockElement);
        }
        get firstChild() {
            return this.childNodes[0] || null;
        }
        get previousElementSibling() {
            if (!this.parentNode) return null;
            const siblings = this.parentNode.children || [];
            const idx = siblings.indexOf(this);
            return idx > 0 ? siblings[idx - 1] : null;
        }
        get nextElementSibling() {
            if (!this.parentNode) return null;
            const siblings = this.parentNode.children || [];
            const idx = siblings.indexOf(this);
            return idx >= 0 && idx < siblings.length - 1 ? siblings[idx + 1] : null;
        }
        get textContent() {
            if (this.childNodes.length === 0) return this._textContent;
            return this.childNodes.map((c) => c.textContent).join('');
        }
        set textContent(val) {
            this.childNodes = [];
            this._textContent = String(val ?? '');
            if (this._textContent) {
                const tn = new MockNode(3, this._textContent);
                tn.parentNode = this;
                this.childNodes.push(tn);
            }
        }
        setAttribute(name, value) {
            const val = String(value ?? '');
            this._attrs.set(name, val);
            if (name === 'class') this.classList._syncFromString(val);
            if (name === 'hidden') this._attrs.set('hidden', '');
            if (name === 'disabled') this.disabled = true;
            if (name === 'checked') this.checked = true;
            if (name === 'selected') this.selected = true;
            if (name === 'value' && ('value' in this)) this.value = val;
        }
        removeAttribute(name) {
            this._attrs.delete(name);
            if (name === 'class') this.classList._syncFromString('');
            if (name === 'disabled') this.disabled = false;
            if (name === 'checked') this.checked = false;
            if (name === 'selected') this.selected = false;
        }
        getAttribute(name) {
            return this._attrs.has(name) ? this._attrs.get(name) : null;
        }
        hasAttribute(name) {
            return this._attrs.has(name);
        }
        appendChild(node) {
            if (node instanceof MockFragment) {
                for (const c of [...node.childNodes]) this.appendChild(c);
                return node;
            }
            node.remove();
            node.parentNode = this;
            this.childNodes.push(node);
            return node;
        }
        append(...nodes) {
            for (const n of nodes) {
                if (typeof n === 'string') {
                    const tn = new MockNode(3, n);
                    tn.parentNode = this;
                    this.childNodes.push(tn);
                } else if (n) {
                    this.appendChild(n);
                }
            }
        }
        prepend(...nodes) {
            for (const node of [...nodes].reverse()) {
                this.insertBefore(typeof node === 'string' ? new MockNode(3, node) : node, this.firstChild);
            }
        }
        replaceWith(...nodes) {
            const parent = this.parentNode;
            if (!parent) return;
            for (const node of nodes) parent.insertBefore(typeof node === 'string' ? new MockNode(3, node) : node, this);
            this.remove();
        }
        insertBefore(newNode, refNode) {
            if (!refNode) return this.appendChild(newNode);
            newNode.remove();
            newNode.parentNode = this;
            const idx = this.childNodes.indexOf(refNode);
            if (idx >= 0) {
                this.childNodes.splice(idx, 0, newNode);
            } else {
                this.childNodes.push(newNode);
            }
            return newNode;
        }
        insertAdjacentElement(pos, node) {
            if (pos === 'afterend' && this.parentNode) {
                node.remove();
                node.parentNode = this.parentNode;
                const idx = this.parentNode.childNodes.indexOf(this);
                this.parentNode.childNodes.splice(idx + 1, 0, node);
            }
            return node;
        }
        set innerHTML(html) {
            this.childNodes = [];
            const voidTags = new Set(['input', 'br', 'hr', 'img', 'meta', 'link']);
            const stack = [this];
            const tokenRe = /<\/?([a-zA-Z0-9_-]+)([^>]*)>|([^<]+)/g;
            let m;
            while ((m = tokenRe.exec(String(html || ''))) !== null) {
                const parent = stack[stack.length - 1];
                if (m[3] !== undefined) {
                    if (m[3]) {
                        const tn = new MockNode(3, m[3]);
                        tn.parentNode = parent;
                        parent.childNodes.push(tn);
                    }
                    continue;
                }
                const full = m[0];
                const tag = m[1].toLowerCase();
                if (full.startsWith('</')) {
                    while (stack.length > 1 && stack[stack.length - 1].tagName.toLowerCase() !== tag) {
                        stack.pop();
                    }
                    if (stack.length > 1) stack.pop();
                } else {
                    const child = doc.createElement(tag);
                    const attrs = parseAttrs(m[2] || '');
                    for (const [k, v] of attrs.entries()) child.setAttribute(k, v);
                    parent.appendChild(child);
                    if (!voidTags.has(tag) && !full.endsWith('/>')) {
                        stack.push(child);
                    }
                }
            }
        }
        contains(other) {
            let cur = other;
            while (cur) {
                if (cur === this) return true;
                cur = cur.parentNode;
            }
            return false;
        }
        matches(sel) {
            return matchesSelector(this, sel);
        }
        closest(sel) {
            let cur = this;
            while (cur) {
                if (cur instanceof MockElement && matchesSelector(cur, sel)) return cur;
                cur = cur.parentElement;
            }
            return null;
        }
        querySelectorAll(sel) {
            const out = [];
            const walk = (node) => {
                for (const c of node.children || []) {
                    if (matchesSelector(c, sel, this)) out.push(c);
                    walk(c);
                }
            };
            walk(this);
            return out;
        }
        querySelector(sel) {
            return this.querySelectorAll(sel)[0] || null;
        }
        getBoundingClientRect() {
            return { ...this._rect };
        }
        getClientRects() {
            for (let node = this; node; node = node.parentElement) {
                if (node.hidden || node.style?.display === 'none') return [];
            }
            return this.isConnected ? [this.getBoundingClientRect()] : [];
        }
        addEventListener(type, fn, opts) {
            const capture = typeof opts === 'boolean' ? opts : Boolean(opts?.capture);
            if (!this._listeners.has(type)) this._listeners.set(type, []);
            this._listeners.get(type).push({ fn, capture });
        }
        removeEventListener(type, fn, opts) {
            const capture = typeof opts === 'boolean' ? opts : Boolean(opts?.capture);
            const arr = this._listeners.get(type);
            if (!arr) return;
            this._listeners.set(
                type,
                arr.filter((entry) => entry.fn !== fn || entry.capture !== capture),
            );
        }
        dispatchEvent(ev) {
            if (!ev.target) ev.target = this;
            const path = [];
            let cur = this;
            while (cur) {
                path.push(cur);
                cur = cur.parentNode;
            }
            for (let i = path.length - 1; i >= 0; i -= 1) {
                if (ev.cancelBubble) break;
                const node = path[i];
                const list = [...(node._listeners?.get(ev.type) || [])].filter((e) => e.capture);
                ev.currentTarget = node;
                for (const entry of list) {
                    entry.fn(ev);
                    if (ev._stopImmediate) break;
                }
            }
            for (let i = 0; i < path.length; i += 1) {
                if (ev.cancelBubble && (ev.bubbles || i > 0)) break;
                if (!ev.bubbles && i > 0) break;
                const node = path[i];
                const list = [...(node._listeners?.get(ev.type) || [])].filter((e) => !e.capture);
                ev.currentTarget = node;
                for (const entry of list) {
                    entry.fn(ev);
                    if (ev._stopImmediate) break;
                }
            }
            return !ev.defaultPrevented;
        }
        focus() {
            doc.activeElement = this;
        }
        blur() {
            if (doc.activeElement === this) doc.activeElement = doc.body;
        }
        click() {
            this.dispatchEvent(new MockEvent('click', { bubbles: true, cancelable: true }));
        }
        scrollIntoView() {}
        setPointerCapture() {}
        releasePointerCapture() {}
    }

    class MockInputElement extends MockElement {
        constructor() {
            super('input');
            this.value = '';
            this.checked = false;
        }
        get type() {
            return this._attrs.get('type') || 'text';
        }
        set type(v) {
            this._attrs.set('type', String(v ?? 'text'));
        }
    }
    class MockTextAreaElement extends MockElement {
        constructor() {
            super('textarea');
            this.value = '';
            this.selectionStart = 0;
            this.selectionEnd = 0;
        }
    }
    class MockButtonElement extends MockElement {
        constructor() {
            super('button');
        }
        get type() {
            return this._attrs.get('type') || 'submit';
        }
        set type(v) {
            this._attrs.set('type', String(v ?? 'button'));
        }
    }
    class MockOptionElement extends MockElement {
        constructor() {
            super('option');
            this._selected = false;
        }
        get selected() {
            return this._selected;
        }
        set selected(v) {
            const next = Boolean(v);
            this._selected = next;
            if (next) {
                const sel = this.closest?.('select');
                if (sel && !sel.multiple) {
                    for (const o of sel.options) {
                        if (o !== this) o._selected = false;
                    }
                }
            }
        }
        get value() {
            return this._attrs.has('value') ? this._attrs.get('value') : this.textContent;
        }
        set value(v) {
            this._attrs.set('value', String(v ?? ''));
        }
    }
    class MockOptGroupElement extends MockElement {
        constructor() {
            super('optgroup');
        }
        get label() {
            return this._attrs.get('label') || '';
        }
        set label(v) {
            this._attrs.set('label', String(v ?? ''));
        }
    }
    class MockSelectElement extends MockElement {
        constructor() {
            super('select');
            this.multiple = false;
        }
        get options() {
            return this.querySelectorAll('option');
        }
        get selectedOptions() {
            return this.options.filter((o) => o.selected);
        }
        get value() {
            return this.selectedOptions[0]?.value ?? '';
        }
        set value(v) {
            const s = String(v ?? '');
            for (const o of this.options) {
                o.selected = o.value === s;
            }
        }
    }
    class MockFragment {
        constructor() {
            this.childNodes = [];
        }
        appendChild(node) {
            node.remove?.();
            node.parentNode = null;
            this.childNodes.push(node);
            return node;
        }
    }

    const doc = {
        readyState: 'complete',
        _listeners: new Map(),
        documentElement: null,
        body: null,
        activeElement: null,
        createElement(tag) {
            const t = String(tag).toLowerCase();
            if (t === 'input') return new MockInputElement();
            if (t === 'textarea') return new MockTextAreaElement();
            if (t === 'button') return new MockButtonElement();
            if (t === 'select') return new MockSelectElement();
            if (t === 'option') return new MockOptionElement();
            if (t === 'optgroup') return new MockOptGroupElement();
            return new MockElement(t);
        },
        createDocumentFragment() {
            return new MockFragment();
        },
        getElementById(id) {
            return this.documentElement.querySelector(`#${id}`);
        },
        querySelector(sel) {
            return this.documentElement.querySelector(sel);
        },
        querySelectorAll(sel) {
            return this.documentElement.querySelectorAll(sel);
        },
        addEventListener(type, fn, opts) {
            this.documentElement.addEventListener(type, fn, opts);
        },
        removeEventListener(type, fn, opts) {
            this.documentElement.removeEventListener(type, fn, opts);
        },
    };
    doc.documentElement = new MockElement('html');
    doc.body = new MockElement('body');
    doc.documentElement.appendChild(doc.body);
    doc.activeElement = doc.body;

    const vv = {
        height: innerHeight,
        offsetTop: 0,
        addEventListener(type, fn) {
            if (!vvListeners.has(type)) vvListeners.set(type, new Set());
            vvListeners.get(type).add(fn);
        },
        removeEventListener(type, fn) {
            vvListeners.get(type)?.delete(fn);
        },
        dispatchEvent(ev) {
            for (const fn of [...(vvListeners.get(ev.type) || [])]) fn(ev);
            return true;
        },
    };

    globalThis.Element = MockElement;
    globalThis.HTMLElement = MockElement;
    globalThis.HTMLInputElement = MockInputElement;
    globalThis.HTMLTextAreaElement = MockTextAreaElement;
    globalThis.HTMLButtonElement = MockButtonElement;
    globalThis.HTMLSelectElement = MockSelectElement;
    globalThis.HTMLOptionElement = MockOptionElement;
    globalThis.HTMLOptGroupElement = MockOptGroupElement;
    globalThis.Event = MockEvent;
    globalThis.PointerEvent = MockEvent;
    globalThis.CustomEvent = class MockCustomEvent extends MockEvent {
        constructor(type, init = {}) {
            super(type, init);
            this.detail = init.detail;
        }
    };
    globalThis.KeyboardEvent = MockEvent;
    globalThis.document = doc;
    globalThis.innerWidth = innerWidth;
    globalThis.innerHeight = innerHeight;
    globalThis.visualViewport = vv;
    globalThis.addEventListener = (type, fn) => {
        if (!winListeners.has(type)) winListeners.set(type, new Set());
        winListeners.get(type).add(fn);
    };
    globalThis.removeEventListener = (type, fn) => {
        winListeners.get(type)?.delete(fn);
    };
    globalThis.dispatchEvent = (ev) => {
        for (const fn of [...(winListeners.get(ev.type) || [])]) fn(ev);
        return true;
    };
    globalThis.window = {
        dispatchEvent: globalThis.dispatchEvent,
        addEventListener: globalThis.addEventListener,
        removeEventListener: globalThis.removeEventListener,
    };
    globalThis.CSS = { escape: (s) => String(s) };
    globalThis.requestAnimationFrame = (cb) => {
        cb();
        return 1;
    };
    globalThis.getComputedStyle = () => ({
        color: 'rgb(220, 220, 220)',
        height: '32px',
        paddingLeft: '10px',
        borderRadius: '6px',
        borderTopWidth: '1px',
        borderTopStyle: 'solid',
        borderTopColor: 'rgb(80, 80, 80)',
        backgroundColor: 'rgb(30, 30, 30)',
        fontSize: '13px',
        fontFamily: 'sans-serif',
        fontWeight: '400',
        boxShadow: 'none',
        marginTop: '0px',
        marginRight: '0px',
        marginBottom: '0px',
        marginLeft: '0px',
        alignSelf: 'auto',
        verticalAlign: 'middle',
    });
    globalThis.MutationObserver = class MockMutationObserver {
        constructor(cb) {
            this.cb = cb;
            this.target = null;
            observerInstances.push(this);
        }
        observe(target, options) {
            this.target = target;
            this.options = options;
        }
        disconnect() {
            this.target = null;
        }
        takeRecords() {
            return [];
        }
    };
    delete globalThis.jQuery;
    globalThis.SillyTavern = {
        getContext: () => ({
            characters: [],
            extensionSettings: {},
            saveSettingsDebounced: () => {},
        }),
    };

    const restore = () => {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete globalThis[k];
            else globalThis[k] = v;
        }
    };

    return { doc, vv, MockEvent, observerInstances, winListeners, vvListeners, restore };
}

export { AI_ORGANIZE_CATEGORY_PRESETS, AI_ORGANIZE_NAMING_PRESETS, DEFAULT_LOCAL_ORGANIZE_CATEGORY_IDS, DEFAULT_SETTINGS, GROUP_COLOR_PALETTE, LOCAL_ORGANIZE_CATEGORIES, MODULE_NAME, SECTION_ORDER_VERSION, SPECIAL_GROUPS, STYLE_SOURCE_FILES, WORLD_ENTRY_POSITIONS, addCustomGroup, analyzeSensitiveOrganizeState, applyAiOrganizeProposals, buildAiOrganizePrompt, buildCharBooksCountMap, buildCharacterBindingIndex, buildLocalOrganizeProposals, buildPersonaBindingIndex, charaFileName, classifyWorldbooks, cleanupDeletedWorldSettings, compareWorldbookEntries, compareZhCn, computeReorderedEntries, computeScanPromptState, createApiChannelId, createGlobalPresetId, createGroupId, createNewRawWorldEntry, deepClone, deleteAiOrganizePreset, deleteGlobalPreset, detectAiRefusal, estimateEntryTokens, exportConfigData, extractEmbeddedCharacterBookPreview, extractEntryListItems, extractSingleEntryForEdit, findCardsWithUnimportedBooks, findMatchingGlobalPreset, findSensitiveTargetGroup, findUnboundCharacterNameMatches, findUnscannedShallowCharacters, formatCharacterDisplayTitle, getEffectiveAiOrganizePresets, getVisibleSectionMoveBounds, importConfigData, isBookPinned, isBookVisibleInCharBindPopup, isBookVisibleInSelector, isPotentiallySensitiveTitle, matchesSearch, mergeEntryPatchOntoRaw, migrateSettingsOnWorldRename, moveBooksToNamedGroup, moveGlobalPreset, moveSectionOrder, normalizeEntryKeywordsInput, normalizeMatchName, normalizeSettings, orderSectionsForExternalDropdown, parseAiOrganizeResponse, parseOptionalFiniteNumber, partitionGroupPickerBooks, promoteSectionToTop, pruneStaleWorldbookSettings, pushUndoSnapshot, readStyleSource, reorderBookInGroup, reorderEntryUids, reorderSection, resetAiOrganizePresets, restoreOrganizeSnapshot, searchEntriesInPayload, sortEntryListItems, summarizeCharacterWorldCoverage, summarizePersonaWorldBindings, togglePinnedBook, undoLastAiOrganize, updateCachedCharBindings, upsertAiOrganizePreset, upsertGlobalPreset };
