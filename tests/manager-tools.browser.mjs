import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inspect } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../src/panel-manager.js', import.meta.url), 'utf8');
const binding = source.slice(source.indexOf('function bindFloatingManagerTools('), source.indexOf('\nfunction minimizeManagerModal('));

// Execute the production binding; geometry and event delivery are the only host doubles.
class Surface {
    constructor(rect = { left: 0, top: 0, right: 390, bottom: 700 }) {
        this.rect = rect;
        this.hidden = false;
        this.isConnected = true;
        this.style = { display: '' };
        this.listeners = new Map();
        this.attrs = new Map();
        this.scrollTop = 0;
        this.clientTop = 0;
        this.clientLeft = 0;
        this.clientWidth = rect.right - rect.left;
        this.clientHeight = rect.bottom - rect.top;
        Object.defineProperties(this, {
            parentElement: { value: null, writable: true },
            parentNode: { get: () => this.parentElement },
        });
    }
    [inspect.custom]() { return 'Surface'; }
    toJSON() { return { hidden: this.hidden, scrollTop: this.scrollTop }; }
    addEventListener(name, fn) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(fn); }
    removeEventListener(name, fn) { this.listeners.get(name)?.delete(fn); }
    fire(name, props = {}) { for (const fn of this.listeners.get(name) || []) fn({ target: this, ...props }); }
    setAttribute(name, value) { this.attrs.set(name, value); }
    getBoundingClientRect() { return { ...this.rect, width: this.rect.right - this.rect.left, height: this.rect.bottom - this.rect.top }; }
    getClientRects() { return this.hidden ? [] : [this.getBoundingClientRect()]; }
    contains(node) { return node === this || node.parentElement === this; }
    append(node) { node.parentElement = this; }
    replaceWith(node) { node.parentElement = this.parentElement; node.rect = { ...this.rect }; this.parentElement = null; }
}

function host({ touch = true, resized = true } = {}) {
    const modal = new Surface();
    modal.touch = touch;
    modal.matches = (selector) => selector.includes('wbo-touch-window') && modal.touch
        && (!selector.includes('.is-resized') || resized);
    const overlay = new Surface();
    modal.parentElement = overlay;
    const toggle = new Surface();
    const flyout = new Surface();
    flyout.hidden = true;
    const scroll = new Surface();
    const title = new Surface({ left: 0, top: 0, right: 390, bottom: 44 });
    const tools = [new Surface({ left: 0, top: 44, right: 390, bottom: 100 }), new Surface({ left: 0, top: 100, right: 390, bottom: 240 })];
    for (const node of tools) node.parentElement = scroll;
    scroll.parentElement = modal;
    const nodes = { '#wbo-mgr-floating-tools-btn': toggle, '#wbo-mgr-floating-tools': flyout, '.wbo-mgr-window-scroll': scroll, '.wbo-modal-header-top': title, '.wbo-mgr-header-tools': tools[0], '.wbo-mgr-subbar': tools[1] };
    modal.querySelector = (selector) => nodes[selector] || null;
    const observers = [];
    class Observer {
        constructor(fn) { this.fn = fn; this.targets = new Set(); observers.push(this); }
        observe(node) { this.targets.add(node); }
        disconnect() { this.targets.clear(); }
    }
    const frames = new Map();
    let frameId = 0;
    const win = new Surface();
    win.innerWidth = 390;
    win.innerHeight = 844;
    win.visualViewport = new Surface();
    Object.assign(win.visualViewport, { offsetTop: 0, offsetLeft: 0, width: 390, height: 844 });
    const doc = new Surface();
    doc.hidden = false;
    doc.createElement = () => new Surface();
    const context = vm.createContext({
        window: win, document: doc, HTMLElement: Surface, Element: Surface,
        ResizeObserver: Observer, MutationObserver: Observer, _isComposing: false,
        getComputedStyle: (node) => ({ display: 'block', visibility: 'visible', overflowX: 'visible', overflowY: node === scroll ? 'auto' : 'visible', position: 'static', ...node.css }),
        requestAnimationFrame: (fn) => { frames.set(++frameId, fn); return frameId; },
        cancelAnimationFrame: (id) => frames.delete(id),
    });
    const close = vm.runInContext(`(${binding})(globalThis.modal)`, Object.assign(context, { modal }));
    function flush() { for (let i = 0; frames.size && i < 10; i++) { const pending = [...frames.values()]; frames.clear(); pending.forEach((fn) => fn()); } }
    function changed() { observers.filter((o) => o.targets.size).forEach((o) => o.fn([])); flush(); }
    flush();
    return { modal, overlay, toggle, flyout, scroll, tools, win, doc, frames, observers, close, flush, changed };
}

test('binding: top tools fully visible suppress the toolbox even in a resized touch window', () => {
    const h = host();
    assert.equal(h.toggle.hidden, true);
});

test('binding: actual clipping enables the toolbox without requiring is-resized; fixed tools do not', () => {
    const h = host({ resized: false });
    h.tools[0].rect = { left: 0, top: -90, right: 390, bottom: -34 };
    h.scroll.fire('scroll'); h.flush();
    assert.equal(h.toggle.hidden, false);
    h.toggle.fire('click'); h.flush();
    assert.equal(h.flyout.hidden, false);
    h.toggle.fire('click'); h.flush();
    h.tools[0].rect = { left: 0, top: 44, right: 390, bottom: 100 };
    h.tools[0].css = { position: 'fixed' };
    h.scroll.scrollTop = 2000;
    h.scroll.fire('scroll'); h.flush();
    assert.equal(h.toggle.hidden, true);
});

test('binding: clipped subbar, horizontal clipping and sticky-title occlusion count as unavailable', () => {
    const h = host();
    for (const rect of [
        { left: 0, top: 650, right: 390, bottom: 790 },
        { left: -40, top: 100, right: 350, bottom: 240 },
        { left: 0, top: 20, right: 390, bottom: 160 },
    ]) {
        h.tools[1].rect = rect;
        h.scroll.fire('scroll'); h.flush();
        assert.equal(h.toggle.hidden, false, JSON.stringify(rect));
    }
});

test('binding: second click closes, restores original controls and preserves scroll', () => {
    const h = host();
    h.tools[0].rect = { left: 0, top: -90, right: 390, bottom: -34 };
    h.scroll.scrollTop = 500;
    h.scroll.fire('scroll'); h.flush();
    h.toggle.fire('click'); h.flush();
    assert.equal(h.flyout.hidden, false);
    assert.equal(h.toggle.hidden, false, 'portal contents must not hide their own toggle');
    h.toggle.fire('click'); h.flush();
    assert.equal(h.flyout.hidden, true);
    assert.equal(h.tools[0].parentElement === h.scroll, true);
    assert.equal(h.scroll.scrollTop, 500);
});

test('binding: minimize/touch exit suspend geometry work; dispose removes all owned listeners', () => {
    const h = host();
    h.overlay.hidden = true; h.changed();
    assert.equal(h.toggle.hidden, true);
    assert.equal([...h.scroll.listeners.values()].reduce((n, set) => n + set.size, 0), 0);
    h.overlay.hidden = false; h.changed();
    h.tools[1].rect.bottom = 800;
    h.scroll.fire('scroll'); h.flush();
    assert.equal(h.toggle.hidden, false);
    h.modal.touch = false; h.changed();
    assert.equal(h.toggle.hidden, true);
    assert.equal(typeof h.close.dispose, 'function');
    h.close.dispose();
    assert.equal(h.observers.every((o) => o.targets.size === 0), true);
    for (const node of [h.modal, h.scroll, h.toggle, h.win, h.win.visualViewport, h.doc]) {
        assert.equal([...node.listeners.values()].reduce((n, set) => n + set.size, 0), 0);
    }
    assert.equal(h.frames.size, 0);
});

test('binding: backgrounding closes the flyout; disposal restores portalled tools', () => {
    const h = host();
    h.tools[0].rect = { left: 0, top: -90, right: 390, bottom: -34 };
    h.scroll.fire('scroll'); h.flush();
    h.toggle.fire('click'); h.flush();
    assert.equal(h.flyout.hidden, false);
    h.doc.hidden = true; h.doc.fire('visibilitychange'); h.flush();
    assert.equal(h.flyout.hidden, true);
    assert.equal(h.toggle.hidden, true);
    h.doc.hidden = false; h.doc.fire('visibilitychange'); h.flush();
    h.toggle.fire('click'); h.flush();
    assert.equal(h.flyout.hidden, false);
    h.close.dispose();
    assert.equal(h.flyout.hidden, true);
    assert.equal(h.tools.every((el) => el.parentElement === h.scroll), true);
});

test('browser: real touch manager top/bottom visibility, toggle-close and stable window', { skip: !process.env.WBO_E2E_SUITE }, async (t) => {
    const load = (name) => import(pathToFileURL(resolve(process.env.WBO_E2E_SUITE, 'lib', name)).href);
    const { createMockStServer } = await load('mock-server.mjs');
    const { launchEdgeCdp, VIEWPORTS } = await load('cdp.mjs');
    const { createDefaultSeed } = await load('fixtures.mjs');
    const { resetAndBoot, openManager } = await load('assert-helpers.mjs');
    const server = createMockStServer();
    let cdp;
    try {
        const url = await server.start();
        cdp = await launchEdgeCdp();
        await resetAndBoot(cdp, url, { viewport: VIEWPORTS.mobile, seed: createDefaultSeed({
            characters: [], worldbooks: Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`示例书 ${i}`, { entries: {} }])),
            pluginSettings: { autoScanNewCharacters: false, activeFilterGroupId: '__all__' },
        }) });
        await openManager(cdp);
        const settle = () => cdp.evalFn(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
        const read = () => cdp.evalFn(() => {
            const modal = document.querySelector('.wbo-manager-modal');
            const button = modal.querySelector('#wbo-mgr-floating-tools-btn');
            const flyout = modal.querySelector('#wbo-mgr-floating-tools');
            return { hidden: button.hidden, display: getComputedStyle(button).display, open: !flyout.hidden,
                top: modal.getBoundingClientRect().top, height: modal.getBoundingClientRect().height,
                scroll: modal.querySelector('.wbo-mgr-window-scroll').scrollTop, page: window.scrollY };
        });
        await settle();
        assert.equal((await read()).hidden, true);
        await cdp.evalFn(() => { const list = document.querySelector('#wbo-mgr-groups-list'); list.scrollTop = list.scrollHeight; });
        await settle();
        assert.equal((await read()).hidden, true, 'maximized fixed tools stay available at the list bottom');
        await cdp.evalFn(() => {
            const modal = document.querySelector('.wbo-manager-modal');
            modal.querySelector('#wbo-mgr-groups-list').scrollTop = 0;
            modal.classList.add('is-resized');
            modal.style.height = '650px';
        });
        await settle();
        const top = await read();
        assert.equal(top.hidden, true);
        await cdp.evalFn(() => { const el = document.querySelector('.wbo-mgr-window-scroll'); el.scrollTop = el.scrollHeight; });
        await settle();
        const bottom = await read();
        assert.equal(bottom.hidden, false);
        await cdp.clickSelector('#wbo-mgr-floating-tools-btn', { scroll: false });
        await settle();
        assert.equal((await read()).open, true);
        await cdp.clickSelector('#wbo-mgr-floating-tools-btn', { scroll: false });
        await settle();
        const closed = await read();
        assert.equal(closed.open, false);
        assert.equal(closed.scroll, bottom.scroll);
        for (const key of ['top', 'height', 'page']) assert.equal(closed[key], top[key]);
        assert.deepEqual(cdp.getErrors().runtimeErrors, []);
        t.diagnostic(JSON.stringify({ top, bottom, closed }));
        assert.equal(top.display, 'none', 'stylesheet must honor the toolbox hidden attribute');
        for (const width of [310, 390]) {
            await cdp.evalFn((value) => { document.querySelector('.wbo-manager-modal').style.width = `${value}px`; }, width);
            await settle();
            const layout = await cdp.evalFn(() => {
                const modal = document.querySelector('.wbo-manager-modal');
                const rect = (selector) => modal.querySelector(selector).getBoundingClientRect().toJSON();
                const button = modal.querySelector('#wbo-mgr-floating-tools-btn');
                const label = button.querySelector('span');
                const close = modal.querySelector('.wbo-modal-close');
                const box = close.getBoundingClientRect();
                return { modal: modal.getBoundingClientRect().toJSON(), title: rect('.wbo-modal-title'),
                    button: rect('#wbo-mgr-floating-tools-btn'), close: box.toJSON(),
                    labelVisible: !!label && getComputedStyle(label).display !== 'none' && label.getBoundingClientRect().width > 0,
                    closeHittable: close.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)) };
            });
            assert.equal(layout.labelVisible, false, `narrow ${width}px must keep the toolbox icon only`);
            assert.ok(layout.button.width <= 32 && layout.button.width >= 28, JSON.stringify(layout));
            assert.ok(layout.title.width >= 50 && layout.title.right <= layout.button.left, JSON.stringify(layout));
            assert.ok(Math.abs(layout.button.top - layout.close.top) <= 1, JSON.stringify(layout));
            assert.ok(layout.close.right <= layout.modal.right && layout.closeHittable, JSON.stringify(layout));
        }
    } finally {
        await cdp?.close();
        await server.stop();
    }
});

test('browser: maximized touch toolbox stays inside a short viewport with many expanded pills', { skip: !process.env.WBO_E2E_SUITE }, async (t) => {
    const load = (name) => import(pathToFileURL(resolve(process.env.WBO_E2E_SUITE, 'lib', name)).href);
    const { createMockStServer } = await load('mock-server.mjs');
    const { createDefaultSeed } = await load('fixtures.mjs');
    const { chromium } = await import(process.env.WBO_PLAYWRIGHT_MODULE
        ? pathToFileURL(resolve(process.env.WBO_PLAYWRIGHT_MODULE)).href : 'playwright');
    const groups = Array.from({ length: 40 }, (_, i) => ({ id: `tools-${i}`, name: `工具箱测试分组 ${i}`, collapsed: false }));
    const books = groups.map((group, i) => [`工具箱测试书 ${i}`, { entries: {} }]);
    const server = createMockStServer(createDefaultSeed({ characters: [], selected_world_info: [],
        worldbooks: Object.fromEntries(books), pluginSettings: {
            autoScanNewCharacters: false, activeFilterGroupId: '__all__', groupPanelExpanded: true,
            groups, assignments: Object.fromEntries(books.map(([name], i) => [name, groups[i].id])),
        },
    }));
    let browser;
    try {
        const url = await server.start();
        browser = await chromium.launch({ channel: 'msedge', headless: true, timeout: 15000,
            args: ['--disable-extensions', '--js-flags=--max-old-space-size=1024'] });
        const context = await browser.newContext({ viewport: { width: 390, height: 320 }, isMobile: true, hasTouch: true });
        const page = await context.newPage();
        page.setDefaultTimeout(6000);
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(url);
        await page.locator('#wbo-wand-entry').waitFor({ state: 'attached' });
        await page.evaluate(async () => {
            (await import('/scripts/extensions/third-party/worldbook-organizer/src/panel-manager.js')).openManagerModal();
        });
        const modal = page.locator('.wbo-manager-modal');
        const toolbox = page.locator('#wbo-mgr-floating-tools-btn');
        await toolbox.waitFor({ state: 'visible' });
        assert.equal(await modal.evaluate((el) => el.classList.contains('wbo-touch-window') && !el.classList.contains('is-resized')), true,
            'exercise the maximized route, not the already-covered resized window');
        assert.equal(await page.locator('#wbo-mgr-pills').evaluate((el) => el.classList.contains('is-expanded') && el.children.length >= 40), true);
        const before = await modal.evaluate((el) => ({ top: el.getBoundingClientRect().top, page: scrollY }));
        await toolbox.click();
        const metrics = await page.locator('#wbo-mgr-floating-tools').evaluate((el) => {
            const box = el.getBoundingClientRect();
            const title = document.querySelector('.wbo-modal-header-top').getBoundingClientRect();
            const style = getComputedStyle(el);
            return { top: box.top, bottom: box.bottom, height: box.height, titleBottom: title.bottom,
                viewport: innerHeight, overflow: style.overflowY, maxHeight: style.maxHeight,
                clientHeight: el.clientHeight, scrollHeight: el.scrollHeight };
        });
        t.diagnostic(JSON.stringify(metrics));
        assert.notEqual(metrics.maxHeight, 'none', 'maximized toolbox must retain a finite scrolling constraint');
        assert.ok(metrics.top >= metrics.titleBottom - 1, 'toolbox must not cover its own close/toggle controls');
        assert.ok(metrics.top >= 0 && metrics.bottom <= metrics.viewport + 1, JSON.stringify(metrics));
        assert.ok(metrics.height > 0 && metrics.scrollHeight > metrics.clientHeight, 'overflowing tools must scroll inside the flyout');
        assert.equal(metrics.overflow, 'auto');
        await page.locator('#wbo-mgr-floating-tools').evaluate((el) => { el.scrollTop = el.scrollHeight; });
        assert.ok(await page.locator('#wbo-mgr-floating-tools').evaluate((el) => el.scrollTop) > 0);
        assert.deepEqual(await modal.evaluate((el) => ({ top: el.getBoundingClientRect().top, page: scrollY })), before,
            'only the toolbox content may scroll');
        await toolbox.click();
        assert.equal(await page.locator('#wbo-mgr-floating-tools').evaluate((el) => el.hidden), true);
        assert.equal(await page.locator('.wbo-mgr-window-scroll #wbo-mgr-pills').count(), 1, 'closing restores the original tools');
        await modal.locator('.wbo-modal-close').click();
        assert.equal(await modal.count(), 0);
        assert.deepEqual(errors, []);
    } finally {
        await browser?.close();
        await server.stop();
    }
});
