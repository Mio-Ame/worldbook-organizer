import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const suite = process.env.WBO_E2E_SUITE;
if (!suite) throw new Error('Set WBO_E2E_SUITE to the retained browser regression suite');
const load = (name) => import(pathToFileURL(resolve(suite, 'lib', name)).href);
const { createMockStServer } = await load('mock-server.mjs');
const { VIEWPORTS, launchEdgeCdp } = await load('cdp.mjs');
const { createDefaultSeed } = await load('fixtures.mjs');
const { resetAndBoot, waitForCondition } = await load('assert-helpers.mjs');
const enhancement = JSON.parse(readFileSync(resolve('..', '参考仓库', '下拉框美化.json'), 'utf8')).content;
const storageKey = enhancement.match(/const STORAGE_KEY = '([^']+)'/)?.[1];
const instanceFlag = enhancement.match(/const INSTANCE_FLAG = '([^']+)'/)?.[1];
assert.ok(storageKey && instanceFlag);
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const nativeModule = '/scripts/extensions/third-party/worldbook-organizer/src/native-filter.js';
const entryModule = '/scripts/extensions/third-party/worldbook-organizer/index.js';
const nativeTrigger = '#WIMultiSelector .select2-selection';
const enhancedTrigger = '#WIMultiSelector .gr-select2-display[data-gr-select-id="world_info"]';

const seed = () => createDefaultSeed({
    characters: [], selected_world_info: ['测试书甲'],
    worldbooks: { '测试书甲': { entries: {} }, '测试书乙': { entries: {} } },
    pluginSettings: {
        autoScanNewCharacters: false, globalHiddenGroupIds: [], editorHiddenGroupIds: [],
        groups: [{ id: 'drawer-a', name: '测试分组甲' }, { id: 'drawer-b', name: '测试分组乙' }],
        assignments: { '测试书甲': 'drawer-a', '测试书乙': 'drawer-b' },
    },
});

async function withHost(viewport, verify) {
    const server = createMockStServer();
    const baseUrl = await server.start();
    let cdp;
    try {
        cdp = await launchEdgeCdp();
        await resetAndBoot(cdp, baseUrl, { viewport, seed: seed() });
        // Match the native multi-select wrapper expected by the unmodified reference script.
        await cdp.evalFn(() => {
            const wrapper = document.createElement('div');
            wrapper.className = 'range-block-range';
            const host = document.getElementById('WIMultiSelector');
            while (host.firstChild) wrapper.append(host.firstChild);
            host.append(wrapper);
            if (!jQuery('#world_info').data('select2')) {
                // Mobile comparison uses the same DOM picker, not a platform-native OS menu.
                jQuery('#world_info').select2({ width: '100%', closeOnSelect: false });
            }
            const drawer = document.getElementById('WorldInfo');
            document.getElementById('WI_panel_pin').checked = false;
            window.drawerProbe = { deliveries: [], closes: [] };
            window.reopenProbeDrawer = () => {
                drawer.classList.remove('closedDrawer');
                drawer.classList.add('openDrawer');
            };
            // The retained host already has a document auto-closer. Also exercise
            // html-level closing, which runs before document and must be guarded too.
            const closeOutside = (event) => {
                const target = event.target;
                const record = {
                    target: target.id || target.tagName, connected: target.isConnected,
                    path: event.composedPath().filter((node) => node instanceof Element)
                        .map((node) => node.id || node.tagName),
                };
                window.drawerProbe.deliveries.push(record);
                if (!drawer.classList.contains('openDrawer') || drawer.contains(target)
                    || target.closest('#WI-SP-button')) return;
                window.drawerProbe.closes.push(record);
                drawer.classList.remove('openDrawer');
                drawer.classList.add('closedDrawer');
            };
            document.documentElement.addEventListener('click', closeOutside);
            window.reopenProbeDrawer();
        });
        await verify(cdp);
        assert.deepEqual(cdp.getErrors().runtimeErrors, []);
    } finally {
        await cdp?.close();
        await server.stop();
    }
}

async function setScript(cdp, enabled) {
    await cdp.evalFn((flag) => window[flag]?.(), instanceFlag);
    if (!enabled) return;
    await cdp.evalFn((key, code) => {
        localStorage.setItem(key, JSON.stringify({ settings: {}, pinned: {}, meta: { welcomePopupShown: true } }));
        (0, eval)(code);
    }, storageKey, enhancement);
    await waitForCondition(cdp, () => Boolean(document.querySelector('#WIMultiSelector .gr-select2-display')));
}

async function drawerState(cdp) {
    return cdp.evalFn(() => ({
        open: document.getElementById('WorldInfo').classList.contains('openDrawer'),
        ...window.drawerProbe,
    }));
}

async function activate(cdp, selector, viewport) {
    const point = await cdp.evalFn((selector) => {
        const el = document.querySelector(selector);
        if (!el) throw new Error(`Missing tap target: ${selector}`);
        const r = el.getBoundingClientRect();
        // The compact mock layout can let the reference popover overlap the
        // trigger's center. Use a genuinely exposed part, never click through it.
        for (const fy of [0.5, 0.1, 0.9]) for (const fx of [0.5, 0.1, 0.9]) {
            const x = r.left + r.width * fx;
            const y = r.top + r.height * fy;
            const top = document.elementFromPoint(x, y);
            if (r.height > 0 && top && (top === el || el.contains(top))) return { x, y, hit: true };
        }
        return { hit: false, box: { x: r.x, y: r.y, width: r.width, height: r.height } };
    }, selector);
    assert.equal(point.hit, true, `${selector}: ${JSON.stringify(point)}`);
    if (viewport.mobile) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: point.x, y: point.y }] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    }
    return point;
}

for (const viewport of [VIEWPORTS.desktop, VIEWPORTS.mobile]) {
    test(`${viewport.name}: repeated global opening/closing survives script enable/disable and idle gaps`, async (t) => {
        await withHost(viewport, async (cdp) => {
            await cdp.evalFn(() => {
                // The retained host places the trigger at y=107. Reserve a
                // separate lower lane for this physical-click fixture only;
                // keep hit testing, pointer events and script handlers intact.
                const layout = document.createElement('style');
                layout.dataset.drawerPhysicalFixture = '1';
                layout.textContent = `#gr-global-dropdown-container {
                    top: 210px !important;
                    left: 16px !important;
                    max-height: calc(100dvh - 230px) !important;
                }`;
                document.head.append(layout);
            });
            const observations = [];
            for (const enabled of [false, true, false, true, false]) {
                await setScript(cdp, enabled);
                await cdp.evalFn(() => window.reopenProbeDrawer());
                const trigger = enabled ? enhancedTrigger : nativeTrigger;
                for (let round = 0; round < 3; round++) {
                    await pause(650);
                    for (const opening of [true, false]) {
                        const hit = await activate(cdp, trigger, viewport);
                        assert.equal(hit.hit, true, JSON.stringify({ enabled, round, opening, hit, state: await drawerState(cdp) }));
                        await pause(200);
                        const state = await drawerState(cdp);
                        observations.push({ enabled, round, opening, drawerOpen: state.open });
                        const pickerOpen = await cdp.evalFn(() => Boolean(
                            document.querySelector('#gr-global-dropdown-container')
                            || jQuery('#world_info').data('select2')?.isOpen?.(),
                        ));
                        assert.equal(pickerOpen, opening, JSON.stringify({ enabled, round, opening, state }));
                        assert.equal(state.open, true, JSON.stringify({ enabled, round, opening, state }));
                    }
                }
            }
            t.diagnostic(JSON.stringify(observations));
            await cdp.clickSelector('#host-outside-blank', { scroll: false });
            assert.equal((await drawerState(cdp)).open, false, 'a genuine outside click must still close');
        });
    });
}

for (const enhanced of [false, true]) {
    for (const scenario of ['html-retarget', 'detached-click-after-hold']) {
        test(`${enhanced ? 'enhanced' : 'native'} global ${scenario} preserves the drawer on every opening`, async (t) => {
            await withHost(VIEWPORTS.desktop, async (cdp) => {
                await setScript(cdp, enhanced);
                const observations = [];
                for (let round = 0; round < 3; round++) {
                    await pause(650);
                    const result = await cdp.evalFn(async (selector, scenario) => {
                        window.reopenProbeDrawer();
                        const trigger = document.querySelector(selector);
                        if (!trigger) throw new Error(`Missing trigger: ${selector}`);
                        const start = performance.now();
                        // This is an explicit event-path probe, not a claim that the
                        // browser always retargets the same way on physical input.
                        trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'mouse' }));
                        trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
                        if (scenario === 'html-retarget') {
                            document.documentElement.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                        } else {
                            await new Promise((done) => setTimeout(done, 650));
                            // The old target remains in the dispatch path while a
                            // host click listener replaces it before the body guard.
                            trigger.addEventListener('click', () => trigger.replaceWith(trigger.cloneNode(true)), { once: true });
                            trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                        }
                        return {
                            elapsed: performance.now() - start,
                            open: document.getElementById('WorldInfo').classList.contains('openDrawer'),
                            trace: structuredClone(window.drawerProbe),
                        };
                    }, enhanced ? enhancedTrigger : nativeTrigger, scenario);
                    observations.push({ round, ...result });
                    // Restore only the isolated fixture between trials, so all
                    // three failures can be captured instead of stopping at one.
                    await cdp.evalFn(async (url) => {
                        const native = await import(url);
                        native.closeAllOpenWorldDropdowns();
                    }, nativeModule);
                }
                t.diagnostic(JSON.stringify(observations));
                assert.equal(observations.every((result) => result.open), true, JSON.stringify(observations));
            });
        });
    }
}

for (const viewport of [VIEWPORTS.desktop, VIEWPORTS.mobile]) {
    test(`${viewport.name}: real script drawer-close cleanup A/B with adaptation on/off`, async (t) => {
        await withHost(viewport, async (cdp) => {
            const samples = [];
            for (const adaptation of [true, false]) {
                await setScript(cdp, false);
                if (!adaptation) await cdp.evalFn(async (url) => (await import(url)).onDisable(), entryModule);
                await setScript(cdp, true);
                for (let round = 0; round < 2; round++) {
                    await cdp.evalFn(() => window.reopenProbeDrawer());
                    const hit = await activate(cdp, enhancedTrigger, viewport);
                    assert.equal(hit.hit, true);
                    await waitForCondition(cdp, () => Boolean(document.getElementById('gr-global-dropdown-container')));
                    await pause(250);
                    const sample = await cdp.evalFn(async () => {
                        const visible = () => {
                            const el = document.getElementById('gr-global-dropdown-container');
                            return Boolean(el && el.getBoundingClientRect().height > 0 && getComputedStyle(el).display !== 'none');
                        };
                        const wasOpenAfterTrigger = document.getElementById('WorldInfo').classList.contains('openDrawer');
                        // Keep this cleanup measurement independent of whether the
                        // opening click itself already dismissed an unguarded drawer.
                        window.reopenProbeDrawer();
                        const start = performance.now();
                        // The actual host icon stops propagation; closing by the
                        // icon must not depend on a later document outside-click.
                        document.querySelector('#WI-SP-button .drawer-icon').click();
                        const frames = [{ dt: performance.now() - start, visible: visible() }];
                        await new Promise(requestAnimationFrame);
                        frames.push({ dt: performance.now() - start, visible: visible() });
                        await new Promise((done) => setTimeout(done, 250));
                        frames.push({ dt: performance.now() - start, visible: visible() });
                        return { wasOpenAfterTrigger, drawerClosed: document.getElementById('WorldInfo').classList.contains('closedDrawer'), frames };
                    });
                    samples.push({ adaptation, round, ...sample });
                    await cdp.evalFn(() => document.getElementById('gr-global-dropdown-container')?.remove());
                    await pause(650);
                }
            }
            t.diagnostic(JSON.stringify(samples));
            assert.equal(samples.every((sample) => sample.drawerClosed), true);
            // Off samples identify the script's own behavior; only the enabled
            // adaptation is held to our no-orphan-overlay acceptance contract.
            assert.equal(samples.filter((sample) => sample.adaptation)
                .every((sample) => !sample.frames[1].visible), true, JSON.stringify(samples));
        });
    });
}
