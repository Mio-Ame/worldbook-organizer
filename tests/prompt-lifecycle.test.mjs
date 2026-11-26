import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inspect } from 'node:util';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../src/panel-window.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
// Execute the real prompt, close path and window-cleanup ownership without a browser.
const lifecycle = source.slice(source.indexOf('function cleanupOverlayWindowControls('),
    source.indexOf('\n/**\n * Create a sub-modal', source.indexOf('function openInlineTextPrompt(')));

class Surface extends EventTarget {
    constructor() {
        super();
        this.children = [];
        this.listeners = new Map();
        this.id = '';
        this.value = '';
        Object.defineProperty(this, 'parentElement', { value: null, writable: true });
    }
    [inspect.custom]() { return `Surface(${this.id})`; }
    addEventListener(type, fn, options) {
        super.addEventListener(type, fn, options);
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type).add(fn);
    }
    removeEventListener(type, fn, options) {
        super.removeEventListener(type, fn, options);
        this.listeners.get(type)?.delete(fn);
    }
    appendChild(node) { node.parentElement = this; this.children.push(node); }
    remove() {
        if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((node) => node !== this);
        this.parentElement = null;
    }
    querySelector(selector) {
        for (const child of this.children) {
            if (selector.startsWith('#') ? child.id === selector.slice(1) : child.selector === selector) return child;
            const nested = child.querySelector(selector);
            if (nested) return nested;
        }
        return null;
    }
    set innerHTML(value) {
        this.children = [];
        // Only prompt elements are doubled; event handlers and cleanup execute production code.
        for (const selector of ['.wbo-modal-header', '.wbo-modal-close', '#wbo-inline-prompt-input',
            '#wbo-inline-prompt-clear', '#wbo-inline-prompt-ok', '#wbo-inline-prompt-cancel']) {
            const node = new Surface();
            node.selector = selector;
            if (selector.startsWith('#')) node.id = selector.slice(1);
            this.appendChild(node);
        }
        this.selector = '.wbo-modal';
    }
}

function host() {
    const doc = new Surface();
    doc.body = new Surface();
    doc.createElement = () => new Surface();
    doc.getElementById = (id) => doc.body.querySelector(`#${id}`);
    doc.querySelectorAll = () => [...doc.body.children];
    const viewport = new Surface();
    const context = vm.createContext({
        document: doc, HTMLElement: Surface, HTMLInputElement: Surface,
        PROMPT_OVERLAY_ID: 'prompt', SUBMODAL_OVERLAY_ID: 'submodal', _subModalStack: [],
        _modalWindowCleanupMap: new WeakMap(),
        applyThemeClass() {}, applyTauriSurface() {}, placeOverlayAboveOpenPanels() {},
        bindDrawerSafeBubbleGuard() {}, prunePreviewCacheAfterSubModal() {},
        esc: String, showToast() {}, bindImeSafeEnter() {}, isDesktopAutoFocusAllowed: () => false,
        attachModalWindowControls() {
            const onResize = () => {};
            viewport.addEventListener('resize', onResize);
            return () => viewport.removeEventListener('resize', onResize);
        },
    });
    vm.runInContext(lifecycle, context);
    return { doc, viewport, open: context.openInlineTextPrompt, close: context.closeSubModal,
        button: (id) => doc.getElementById(id),
        count: (target, type) => target.listeners.get(type)?.size || 0 };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

for (const all of [false, true]) {
    test(`forced prompt close (${all ? 'all windows' : 'current window'}) cancels its promise and releases listeners`, async () => {
        const h = host();
        let settled = false;
        let result = 'pending';
        const promise = h.open().then((value) => { result = value; settled = true; });
        assert.equal(h.count(h.doc, 'keydown'), 1);
        assert.equal(h.count(h.viewport, 'resize'), 1);
        h.close(all ? { all: true } : null);
        await flush();
        assert.equal(settled, true, 'removing the window must cancel the waiting caller, without requiring another Escape');
        assert.equal(result, null);
        assert.equal(h.doc.body.children.length, 0);
        assert.equal(h.count(h.doc, 'keydown'), 0);
        assert.equal(h.count(h.viewport, 'resize'), 0);
        await promise;
        h.close({ all: true });
        assert.equal(h.count(h.doc, 'keydown'), 0, 'closing twice is harmless');
    });
}

test('replacing a prompt cancels the old caller and leaves only the new prompt listeners', async () => {
    const h = host();
    let oldResult = 'pending';
    const old = h.open().then((value) => { oldResult = value; });
    h.button('wbo-inline-prompt-input').value = '旧名称';
    const staleConfirm = h.button('wbo-inline-prompt-ok');
    const current = h.open();
    await flush();
    assert.equal(oldResult, null);
    assert.equal(h.count(h.doc, 'keydown'), 1);
    assert.equal(h.count(h.viewport, 'resize'), 1);
    assert.equal(h.doc.body.children.length, 1);
    staleConfirm.dispatchEvent(new Event('click'));
    assert.equal(h.doc.body.children.length, 1, 'stale handlers must not close the replacement');
    h.button('wbo-inline-prompt-input').value = '  新名称  ';
    h.button('wbo-inline-prompt-ok').dispatchEvent(new Event('click'));
    assert.equal(await current, '新名称');
    await old;
    assert.equal(h.count(h.doc, 'keydown'), 0);
    assert.equal(h.count(h.viewport, 'resize'), 0);
});

test('teardown still cancels and cleans up a prompt whose root was already removed', async () => {
    const h = host();
    let settled = false;
    let result = 'pending';
    const promise = h.open().then((value) => { result = value; settled = true; });
    h.doc.getElementById('prompt').remove();
    h.close({ all: true });
    await flush();
    assert.equal(settled, true, 'teardown cannot depend on finding the detached prompt root');
    assert.equal(result, null);
    assert.equal(h.count(h.doc, 'keydown'), 0);
    assert.equal(h.count(h.viewport, 'resize'), 0);
    await promise;
});

test('confirm, cancel, close and Escape all settle once and release prompt ownership', async () => {
    for (const action of ['confirm', 'cancel', 'close', 'Escape']) {
        const h = host();
        let settlements = 0;
        const promise = h.open().then((value) => { settlements++; return value; });
        h.button('wbo-inline-prompt-input').value = '  测试名称  ';
        if (action === 'Escape') {
            const event = new Event('keydown', { cancelable: true });
            Object.defineProperty(event, 'key', { value: 'Escape' });
            h.doc.dispatchEvent(event);
            assert.equal(event.defaultPrevented, true);
        } else {
            const button = action === 'confirm' ? h.button('wbo-inline-prompt-ok')
                : action === 'cancel' ? h.button('wbo-inline-prompt-cancel')
                    : h.doc.body.querySelector('.wbo-modal-close');
            button.dispatchEvent(new Event('click'));
        }
        assert.equal(await promise, action === 'confirm' ? '测试名称' : null);
        h.close({ all: true });
        await flush();
        assert.equal(settlements, 1);
        assert.equal(h.doc.body.children.length, 0);
        assert.equal(h.count(h.doc, 'keydown'), 0);
        assert.equal(h.count(h.viewport, 'resize'), 0);
    }
});
