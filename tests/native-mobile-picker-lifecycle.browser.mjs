import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const suite = process.env.WBO_E2E_SUITE;
if (!suite) throw new Error('Set WBO_E2E_SUITE to the retained browser regression suite');
const load = name => import(pathToFileURL(resolve(suite, 'lib', name)).href);
const { createMockStServer } = await load('mock-server.mjs');
const { launchEdgeCdp, VIEWPORTS } = await load('cdp.mjs');
const { createDefaultSeed } = await load('fixtures.mjs');
const { resetAndBoot } = await load('assert-helpers.mjs');
const prefix = '/scripts/extensions/third-party/worldbook-organizer/';

async function withPicker(verify) {
    const server = createMockStServer();
    let cdp;
    try {
        const url = await server.start();
        cdp = await launchEdgeCdp();
        await resetAndBoot(cdp, url, { viewport: VIEWPORTS.mobile, query: 'mobile=1', seed: createDefaultSeed({
            characters: [], selected_world_info: [],
            worldbooks: { '测试书甲': { entries: {} }, '测试书乙': { entries: {} } },
            pluginSettings: { autoScanNewCharacters: false, groups: [{ id: 'test-a', name: '测试组' }], assignments: { '测试书甲': 'test-a' }, globalHiddenGroupIds: [], editorHiddenGroupIds: [] },
        }) });
        await cdp.evalFn(() => {
            const add = EventTarget.prototype.addEventListener;
            const remove = EventTarget.prototype.removeEventListener;
            const tracked = [];
            const types = new Set(['pointerdown', 'resize', 'orientationchange', 'scroll']);
            const relevant = target => target === document || target === window || target === visualViewport;
            const capture = opts => typeof opts === 'boolean' ? opts : !!opts?.capture;
            EventTarget.prototype.addEventListener = function(type, callback, options) {
                if (relevant(this) && types.has(type) && !tracked.some(e => e.target === this && e.type === type && e.callback === callback && e.capture === capture(options))) tracked.push({ target: this, type, callback, capture: capture(options) });
                return add.call(this, type, callback, options);
            };
            EventTarget.prototype.removeEventListener = function(type, callback, options) {
                const at = tracked.findIndex(e => e.target === this && e.type === type && e.callback === callback && e.capture === capture(options));
                if (at >= 0) tracked.splice(at, 1);
                return remove.call(this, type, callback, options);
            };
            window.pickerListenerCount = () => tracked.length;
            const NativeObserver = MutationObserver;
            const drawerObservers = new Set();
            let drawerCallbacks = 0;
            window.MutationObserver = class extends NativeObserver {
                constructor(callback) {
                    super((records, observer) => {
                        if (drawerObservers.has(observer)) drawerCallbacks++;
                        callback(records, observer);
                    });
                }
                observe(target, options) {
                    if (target.id === 'WorldInfo') drawerObservers.add(this);
                    return super.observe(target, options);
                }
                disconnect() {
                    drawerObservers.delete(this);
                    return super.disconnect();
                }
            };
            window.pickerDrawerObservers = () => ({ active: drawerObservers.size, callbacks: drawerCallbacks });
        });
        await cdp.clickSelector('#wbo-mobile-editor-trigger');
        assert.deepEqual(await cdp.evalFn(() => {
            const drawer = document.getElementById('WorldInfo');
            const input = document.getElementById('wbo-mp-search');
            return { open: !!input?.isConnected && !!input.getBoundingClientRect().height, drawerOpen: drawer.classList.contains('openDrawer') && !drawer.classList.contains('closedDrawer'), listeners: window.pickerListenerCount() };
        }), { open: true, drawerOpen: true, listeners: 5 }, 'fixture must open a visible picker in an open drawer');
        await verify(cdp);
        assert.deepEqual(cdp.getErrors().runtimeErrors, []);
    } finally { await cdp?.close(); await server.stop(); }
}

test('changing from grouped picker to flat native selector releases listeners and local focus', async () => withPicker(async cdp => {
    const state = await cdp.evalFn(async p => {
        const native = await import(p + 'src/native-filter.js');
        const core = await import(p + 'src/core.js');
        const input = document.getElementById('wbo-mp-search');
        let blurredWhileConnected = false;
        input.addEventListener('blur', () => { blurredWhileConnected = input.isConnected; });
        input.focus();
        const settings = structuredClone(SillyTavern.getContext().extensionSettings.worldbook_organizer);
        settings.showNativeOptgroups = false;
        const worldNames = [...document.getElementById('world_info').options].filter(o => o.value !== '').map(o => o.textContent.trim());
        native.applyAllNativeWorldFilters(core.classifyWorldbooks({ worldNames, settings }), settings, { force: true });
        return { overlay: !!document.getElementById('wbo-mobile-picker-overlay'), listeners: pickerListenerCount(), blurredWhileConnected };
    }, prefix);
    assert.deepEqual(state, { overlay: false, listeners: 0, blurredWhileConnected: true });
}));

for (const event of ['resize', 'dismiss', 'drawer']) {
    test(`externally removed picker cleans up when existing ${event} handler runs`, async () => withPicker(async cdp => {
        await cdp.evalFn(kind => {
            document.getElementById('wbo-mobile-picker-overlay').remove();
            if (kind === 'resize') window.dispatchEvent(new Event('resize'));
            if (kind === 'dismiss') document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
            if (kind === 'drawer') document.getElementById('WorldInfo').classList.toggle('test-style-change');
        }, event);
        await cdp.evalFn(() => new Promise(resolve => setTimeout(resolve, 30)));
        assert.equal(await cdp.evalFn(() => pickerListenerCount()), 0);
    }));
}

test('closing blurs only the local input before removal and tolerates synchronous reentry', async () => withPicker(async cdp => {
    const state = await cdp.evalFn(async p => {
        const native = await import(p + 'src/native-filter.js');
        const input = document.getElementById('wbo-mp-search');
        input.focus();
        let blurCount = 0;
        let connectedOnBlur = false;
        input.addEventListener('blur', () => {
            blurCount++;
            connectedOnBlur = input.isConnected;
            native.closeAllOpenWorldDropdowns();
        });
        native.closeAllOpenWorldDropdowns();
        native.closeAllOpenWorldDropdowns();
        return { blurCount, connectedOnBlur, listeners: pickerListenerCount(), overlay: !!document.getElementById('wbo-mobile-picker-overlay') };
    }, prefix);
    assert.deepEqual(state, { blurCount: 1, connectedOnBlur: true, listeners: 0, overlay: false });
}));

test('closing keeps an outside input focused', async () => withPicker(async cdp => {
    const state = await cdp.evalFn(async p => {
        const outside = document.createElement('input');
        outside.setAttribute('spellcheck', 'false');
        document.body.append(outside);
        outside.focus();
        let blurCount = 0;
        outside.addEventListener('blur', () => { blurCount++; });
        (await import(p + 'src/native-filter.js')).closeAllOpenWorldDropdowns();
        return { sameFocus: document.activeElement === outside, blurCount, listeners: pickerListenerCount() };
    }, prefix);
    assert.deepEqual(state, { sameFocus: true, blurCount: 0, listeners: 0 });
}));

for (const action of ['overlay', 'choose', 'drawer', 'trigger', 'disable']) {
    test(`${action} closes a focused picker and releases its listeners`, async () => withPicker(async cdp => {
        await cdp.evalFn(() => {
            const input = document.getElementById('wbo-mp-search');
            window.pickerBlurCount = 0;
            input.addEventListener('blur', () => { window.pickerBlurCount++; });
            input.focus();
        });
        if (action === 'overlay') await cdp.clickPoint(1, 1);
        if (action === 'choose') await cdp.clickSelector('#wbo-mp-list [data-mp-world]');
        if (action === 'drawer') await cdp.clickSelector('#WI-SP-button .drawer-icon');
        if (action === 'trigger') await cdp.clickSelector('#wbo-mobile-editor-trigger');
        if (action === 'disable') await cdp.evalFn(async p => (await import(p + 'index.js')).onDisable(), prefix);
        await cdp.evalFn(() => new Promise(resolve => setTimeout(resolve, 80)));
        const state = await cdp.evalFn(() => ({ overlay: !!document.getElementById('wbo-mobile-picker-overlay'), blurCount: pickerBlurCount, listeners: pickerListenerCount() }));
        assert.deepEqual(state, { overlay: false, blurCount: 1, listeners: 0 });
    }));
}

test('closing cancels pending search work on the removed list', async () => withPicker(async cdp => {
    const changes = await cdp.evalFn(async p => {
        const native = await import(p + 'src/native-filter.js');
        const input = document.getElementById('wbo-mp-search');
        const list = document.getElementById('wbo-mp-list');
        input.value = '甲';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        native.closeAllOpenWorldDropdowns();
        let changes = 0;
        const observer = new MutationObserver(() => { changes++; });
        observer.observe(list, { childList: true, subtree: true, attributes: true });
        await new Promise(resolve => setTimeout(resolve, 160));
        observer.disconnect();
        return changes;
    }, prefix);
    assert.equal(changes, 0);
}));

test('twenty open and close cycles and final stop release every picker listener', async () => withPicker(async cdp => {
    for (let i = 0; i < 20; i++) {
        await cdp.evalFn(async p => (await import(p + 'src/native-filter.js')).closeAllOpenWorldDropdowns(), prefix);
        assert.equal(await cdp.evalFn(() => pickerListenerCount()), 0);
        await cdp.clickSelector('#wbo-mobile-editor-trigger');
        assert.equal(await cdp.evalFn(() => pickerListenerCount()), 5);
    }
    await cdp.evalFn(async p => (await import(p + 'src/native-filter.js')).stopNativeObservers(), prefix);
    assert.deepEqual(await cdp.evalFn(() => ({ listeners: pickerListenerCount(), overlay: !!document.getElementById('wbo-mobile-picker-overlay') })), { listeners: 0, overlay: false });
}));

for (const activation of ['click', 'keyboard', 'pointer']) {
    test(`detached picker releases its old closer before ${activation} reopening`, async () => withPicker(async cdp => {
        await cdp.evalFn(() => {
            document.getElementById('wbo-mobile-picker-overlay').remove();
            document.getElementById('wbo-mobile-editor-trigger').focus();
        });
        if (activation === 'click') await cdp.evalFn(() => document.getElementById('wbo-mobile-editor-trigger').click());
        if (activation === 'keyboard') {
            await cdp.pressKey('Enter', 'Enter', 13);
        }
        if (activation === 'pointer') await cdp.clickSelector('#wbo-mobile-editor-trigger');
        assert.deepEqual(await cdp.evalFn(() => ({
            listeners: pickerListenerCount(), overlays: document.querySelectorAll('#wbo-mobile-picker-overlay').length,
            observers: pickerDrawerObservers().active,
        })), { listeners: 5, overlays: 1, observers: 1 });
        await cdp.evalFn(() => document.getElementById('wbo-mp-search').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
        assert.equal(await cdp.evalFn(() => document.getElementById('wbo-mobile-editor-trigger').classList.contains('is-open')), true);
    }));
}

test('stale closer stops reopening if its pin flush removes the trigger', async () => withPicker(async cdp => {
    const state = await cdp.evalFn(() => {
        const trigger = document.getElementById('wbo-mobile-editor-trigger');
        document.querySelector('#wbo-mp-list .wbo-mp-pin-btn').click();
        // Close flush mirrors the current setting; do not emit a settings refresh first.
        SillyTavern.getContext().extensionSettings.worldbook_organizer.showNativeOptgroups = false;
        document.getElementById('wbo-mobile-picker-overlay').remove();
        trigger.click();
        return { trigger: trigger.isConnected, overlays: document.querySelectorAll('#wbo-mobile-picker-overlay').length, listeners: pickerListenerCount() };
    });
    assert.deepEqual(state, { trigger: false, overlays: 0, listeners: 0 });
}));

for (const ime of ['synchronous-event', 'cdp-ime']) {
    test(`${ime} composition during close cannot render a detached list`, async () => withPicker(async cdp => {
        await cdp.evalFn(() => {
            const input = document.getElementById('wbo-mp-search');
            input.focus();
            input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'jia' }));
        });
        if (ime === 'cdp-ime') await cdp.send('Input.imeSetComposition', { text: 'jia', selectionStart: 3, selectionEnd: 3 });
        const state = await cdp.evalFn(async p => {
            const input = document.getElementById('wbo-mp-search');
            const list = document.getElementById('wbo-mp-list');
            let changes = 0;
            const observer = new MutationObserver(() => { changes++; });
            observer.observe(list, { childList: true, subtree: true });
            input.addEventListener('blur', () => input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '甲' })));
            (await import(p + 'src/native-filter.js')).closeAllOpenWorldDropdowns();
            input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '甲' }));
            input.dispatchEvent(new Event('input', { bubbles: true }));
            await new Promise(resolve => setTimeout(resolve, 160));
            observer.disconnect();
            return { changes, localFocus: document.activeElement === input, listeners: pickerListenerCount(), observers: pickerDrawerObservers().active };
        }, prefix);
        assert.deepEqual(state, { changes: 0, localFocus: false, listeners: 0, observers: 0 });
    }));
}

test('drawer observer disconnects on close without a late callback', async () => withPicker(async cdp => {
    assert.equal(await cdp.evalFn(() => pickerDrawerObservers().active), 1);
    const state = await cdp.evalFn(async p => {
        (await import(p + 'src/native-filter.js')).closeAllOpenWorldDropdowns();
        const before = pickerDrawerObservers().callbacks;
        document.getElementById('WorldInfo').classList.toggle('test-after-close');
        await new Promise(resolve => setTimeout(resolve, 40));
        return { active: pickerDrawerObservers().active, lateCallbacks: pickerDrawerObservers().callbacks - before };
    }, prefix);
    assert.deepEqual(state, { active: 0, lateCallbacks: 0 });
}));

for (const target of ['overlay', 'trigger']) {
    test(`trusted touch on ${target} closes once and permits reopening after the guard window`, async () => withPicker(async cdp => {
        const point = await cdp.evalFn(target => {
            const input = document.getElementById('wbo-mp-search');
            input.focus();
            window.pickerTouchTrace = [];
            for (const type of ['pointerdown', 'touchstart', 'click']) document.getElementById('wbo-mobile-picker-overlay').addEventListener(type, ev => {
                pickerTouchTrace.push({ type, trusted: ev.isTrusted, pointerType: ev.pointerType || '' });
            }, true);
            document.getElementById('wbo-mobile-editor-trigger').addEventListener('click', ev => {
                pickerTouchTrace.push({ type: 'trigger-click', trusted: ev.isTrusted });
            });
            if (target === 'overlay') return { x: 1, y: 1 };
            const r = document.getElementById('wbo-mobile-editor-trigger').getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }, target);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await cdp.evalFn(() => new Promise(resolve => setTimeout(resolve, 120)));
        assert.deepEqual(await cdp.evalFn(() => ({ overlay: !!document.getElementById('wbo-mobile-picker-overlay'), listeners: pickerListenerCount(), observers: pickerDrawerObservers().active })), { overlay: false, listeners: 0, observers: 0 });
        assert.equal(await cdp.evalFn(() => pickerTouchTrace.some(ev => ev.type === 'pointerdown' && ev.trusted && ev.pointerType === 'touch')), true);
        if (target === 'trigger') {
            assert.equal(await cdp.evalFn(() => pickerTouchTrace.filter(ev => ev.type === 'trigger-click' && ev.trusted).length), 1);
        }
        // A tap on the outside blank can also close the mock host's unpinned drawer.
        // Return through its real drawer button before testing another opening.
        if (await cdp.evalFn(() => document.getElementById('WorldInfo').classList.contains('closedDrawer'))) {
            await cdp.clickSelector('#WI-SP-button .drawer-icon');
        }
        await cdp.evalFn(() => new Promise(resolve => setTimeout(resolve, 650)));
        const reopen = await cdp.evalFn(() => {
            const r = document.getElementById('wbo-mobile-editor-trigger').getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [reopen] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await cdp.evalFn(() => new Promise(resolve => setTimeout(resolve, 120)));
        assert.equal(await cdp.evalFn(() => !!document.getElementById('wbo-mobile-picker-overlay')), true);
    }));
}
