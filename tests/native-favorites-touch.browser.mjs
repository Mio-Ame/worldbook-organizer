import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const suite = process.env.WBO_E2E_SUITE;
if (!suite) throw new Error('Set WBO_E2E_SUITE to the retained browser regression suite');
const load = (name) => import(pathToFileURL(resolve(suite, 'lib', name)).href);
const { createMockStServer } = await load('mock-server.mjs');
const { VIEWPORTS, launchEdgeCdp } = await load('cdp.mjs');
const { createDefaultSeed } = await load('fixtures.mjs');
const { openManager, resetAndBoot, waitForCondition } = await load('assert-helpers.mjs');

async function withHost(verify, viewport = VIEWPORTS.mobile, settings = {}) {
    const server = createMockStServer();
    const baseUrl = await server.start();
    let cdp;
    try {
        cdp = await launchEdgeCdp();
        await resetAndBoot(cdp, baseUrl, { viewport, seed: createDefaultSeed({
            worldbooks: { '测试书甲': { entries: {} }, '测试书乙': { entries: {} } },
            selected_world_info: ['测试书甲'],
            pluginSettings: {
                autoScanNewCharacters: false, pinnedBooks: [],
                groups: [{ id: 'g-a', name: '测试分组甲' }, { id: 'g-b', name: '测试分组乙' }],
                assignments: { '测试书甲': 'g-a', '测试书乙': 'g-b' },
                ...settings,
            },
        }) });
        await verify(cdp, baseUrl);
        assert.deepEqual(cdp.getErrors().runtimeErrors, []);
    } finally {
        await cdp?.close();
        await server.stop();
    }
}

for (const kind of ['mobile-editor', 'desktop-editor', 'native-global', 'enhanced-global']) {
    test(`${kind} favorites use the saved label and can collapse and reopen`, async () => {
        await withHost(async (cdp) => {
            if (kind === 'mobile-editor') {
                await openManager(cdp);
                await cdp.clickSelector('.wbo-manager-modal .wbo-modal-close');
                await cdp.clickSelector('#wbo-mobile-editor-trigger');
            }
            else if (kind === 'desktop-editor') await cdp.evalFn(() => window.jQuery('#world_editor_select').select2('open'));
            else if (kind === 'native-global') await cdp.clickSelector('#WIMultiSelector .select2-container');
            else await cdp.evalFn(() => window.__ST_TEST_HELPERS__.openGrGlobalPopover());
            await waitForCondition(cdp, () => !!document.querySelector('[data-mp-pill="__pinned__"], [data-wbo-pill="__pinned__"]'));
            const pill = kind === 'mobile-editor' ? '[data-mp-pill="__pinned__"]' : '[data-wbo-pill="__pinned__"]';
            const active = await cdp.evalFn((sel) => document.querySelector(sel).classList.contains('is-active'), pill);
            if (!active) await cdp.clickSelector(pill);
            assert.match(await cdp.evalFn((sel) => document.querySelector(sel).textContent, pill), /已收藏/);
            const head = kind === 'mobile-editor' ? '[data-mp-toggle="__pinned__"]'
                : kind === 'desktop-editor' ? 'li:not(.wbo-dd-group-hidden) > .select2-results__group.wbo-dd-group-head'
                    : kind === 'native-global' ? '.wbo-global-group-heading'
                        : '.wbo-pop-section[data-wbo-dd-group="__pinned__"] > .wbo-dd-group-head';
            assert.equal(await cdp.evalFn((sel) => {
                const el = document.querySelector(sel);
                return Boolean(el && !el.hidden && !el.matches('.is-static, .is-isolated'));
            }, head), true, 'favorites heading must be interactive, with the same chevron as other groups');
            const row = kind === 'mobile-editor' ? '[data-mp-world="测试书乙"]'
                : kind === 'enhanced-global' ? '#gr-global-dropdown-container [data-pin-world="测试书乙"]'
                    : '.select2-dropdown [data-pin-world="测试书乙"]';
            await cdp.clickSelector(head);
            assert.equal(await cdp.evalFn((sel) => (document.querySelector(sel)?.getBoundingClientRect().height || 0) > 0, row), false);
            await cdp.clickSelector(head);
            assert.equal(await cdp.evalFn((sel) => document.querySelector(sel)?.getBoundingClientRect().height > 0, row), true);
            if (kind === 'enhanced-global') {
                await cdp.clickSelector('[data-wbo-pill="g-b"]');
                await cdp.clickSelector(head);
                assert.equal(await cdp.evalFn((sel) => document.querySelector(sel)?.getBoundingClientRect().height > 0, row), false,
                    'favorites sub-section also folds when viewing its original group');
                await cdp.clickSelector(head);
                assert.equal(await cdp.evalFn((sel) => document.querySelector(sel)?.getBoundingClientRect().height > 0, row), true);
            }
        }, kind === 'mobile-editor' || kind === 'enhanced-global' ? VIEWPORTS.mobile : VIEWPORTS.desktop,
        { pinnedBooks: ['测试书乙'] });
    });
}

async function tap(cdp, selector, move = 0) {
    const point = await cdp.evalFn((sel) => {
        const el = document.querySelector(sel);
        el.scrollIntoView({ block: 'nearest' });
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, id: 1 };
    }, selector);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    if (move) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...point, y: point.y + move }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

for (const enhanced of [false, true]) {
    test(`mobile ${enhanced ? 'enhanced' : 'native'} global favorite responds once per real touch without selecting the book`, async () => {
        await withHost(async (cdp, baseUrl) => {
            if (enhanced) await cdp.evalFn(() => window.__ST_TEST_HELPERS__.openGrGlobalPopover());
            else {
                await cdp.setViewport(VIEWPORTS.mobile);
                await cdp.clickSelector('#WIMultiSelector .select2-container');
            }
            const root = enhanced ? '#gr-global-dropdown-container' : '.select2-dropdown';
            const pin = `${root} [data-pin-world="测试书乙"]`;
            await waitForCondition(cdp, () => !!document.querySelector('[data-pin-world="测试书乙"]'));
            const favorites = () => cdp.evalFn(() => SillyTavern.getContext().extensionSettings.worldbook_organizer.pinnedBooks);
            const selection = () => cdp.evalFn(() => [...document.getElementById('world_info').selectedOptions].map((o) => o.textContent));
            const before = await selection();
            await tap(cdp, pin);
            assert.deepEqual(await favorites(), ['测试书乙'], 'touch should add favorite');
            assert.deepEqual(await selection(), before, 'favorite must not change enabled global books');
            assert.equal(await cdp.evalFn((sel) => document.querySelector(sel)?.getAttribute('aria-pressed'), pin), 'true');
            await tap(cdp, pin);
            assert.deepEqual(await favorites(), [], 'second touch should remove favorite exactly once');
            await tap(cdp, pin, 45);
            assert.deepEqual(await favorites(), [], 'a drag starting on the star must not favorite');
            await cdp.evalFn((sel) => document.querySelector(sel).click(), pin);
            assert.deepEqual(await favorites(), ['测试书乙'], 'keyboard/programmatic click remains available');
            assert.deepEqual(await selection(), before);
            assert.equal(await cdp.evalFn((sel) => document.querySelector(sel).getBoundingClientRect().height > 0, root), true);
            await waitForCondition(cdp, async () => {
                const saved = await fetch('/__test/state').then((r) => r.json());
                return saved.extension_settings.worldbook_organizer.pinnedBooks.includes('测试书乙');
            });
            await cdp.navigate(baseUrl);
            await waitForCondition(cdp, () => Boolean(document.getElementById('wbo-wand-entry')));
            assert.deepEqual(await favorites(), ['测试书乙'], 'favorite survives a reload');
            assert.deepEqual(await selection(), before);
        }, enhanced ? VIEWPORTS.mobile : VIEWPORTS.desktop);
    });
}
