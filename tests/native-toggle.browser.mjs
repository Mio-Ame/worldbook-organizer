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
const { getServerState, resetAndBoot, waitForCondition } = await load('assert-helpers.mjs');

const enhancement = JSON.parse(readFileSync(resolve('..', '参考仓库', '下拉框美化.json'), 'utf8')).content;
const storageKey = enhancement.match(/const STORAGE_KEY = '([^']+)'/)?.[1];
const instanceFlag = enhancement.match(/const INSTANCE_FLAG = '([^']+)'/)?.[1];
assert.ok(storageKey && instanceFlag, 'the checked-in reference fixture must expose its lifecycle keys');

const runnerKey = 'wbo-test-dropdown-runner-enabled';

test('mobile fallback is available after an already-running enhancement is disabled without reload', async () => {
    const server = createMockStServer();
    const baseUrl = await server.start();
    let cdp;
    try {
        cdp = await launchEdgeCdp();
        await resetAndBoot(cdp, baseUrl, { viewport: VIEWPORTS.mobile, seed: createDefaultSeed({
            characters: [], selected_world_info: [], worldbooks: { 测试书甲: { entries: {} } },
            pluginSettings: { autoScanNewCharacters: false, globalHiddenGroupIds: [], editorHiddenGroupIds: [] },
        }) });
        await cdp.evalFn(async (code, key) => {
            const root = '/scripts/extensions/third-party/worldbook-organizer/src/';
            const native = await import(`${root}native-filter.js`);
            native.teardownNativeFilters();
            const select = document.getElementById('world_info');
            const range = document.createElement('div');
            range.className = 'range-block-range';
            select.before(range);
            range.append(select);
            localStorage.setItem(key, JSON.stringify({ settings: {}, pinned: {}, meta: { welcomePopupShown: true } }));
            (0, eval)(code);
            const settings = SillyTavern.getContext().extensionSettings.worldbook_organizer;
            const core = await import(`${root}core.js`);
            const classification = core.classifyWorldbooks({ worldNames: ['测试书甲'], bindingMap: new Map(), settings });
            native.startNativeObservers(() => native.applyAllNativeWorldFilters(classification, settings));
            native.applyAllNativeWorldFilters(classification, settings, { force: true });
        }, enhancement, storageKey);
        await waitForCondition(cdp, () => document.querySelector('#WIMultiSelector .gr-select2-display'));
        assert.equal(await cdp.evalFn(() => [...document.querySelectorAll('#WIMultiSelector .wbo-popup-select-trigger')]
            .filter((el) => el.getBoundingClientRect().height > 0).length), 0, 'fallback must not duplicate the active script display');
        await cdp.evalFn((flag) => window[flag]?.(), instanceFlag);
        await waitForCondition(cdp, () => {
            const button = document.querySelector('#WIMultiSelector .wbo-popup-select-trigger');
            return button && button.getBoundingClientRect().height > 0;
        });
        await cdp.clickSelector('#WIMultiSelector .wbo-popup-select-trigger');
        await waitForCondition(cdp, () => document.getElementById('wbo-pop-search'));
        await cdp.clickSelector('#WIMultiSelector .wbo-popup-select-trigger', { scroll: false });
        assert.equal(await cdp.evalFn(() => document.getElementById('wbo-pop-search')), null, 'clicking the fallback again closes it');
        await cdp.evalFn(async () => (await import('/scripts/extensions/third-party/worldbook-organizer/index.js')).onDisable());
        assert.equal(await cdp.evalFn(() => document.querySelectorAll('.wbo-popup-select-trigger, [data-wbo-grouped-control]').length), 0);
        assert.deepEqual(cdp.getErrors().runtimeErrors, []);
    } finally {
        await cdp?.close();
        await server.stop();
    }
});

function prepareGlobalHost() {
    const select = document.getElementById('world_info');
    const inst = jQuery(select).data('select2');
    if (!select.parentElement.classList.contains('range-block-range')) {
        const display = inst?.$container?.[0]
            || (select.nextElementSibling?.matches('.wbo-popup-select-trigger') ? select.nextElementSibling : null);
        const range = document.createElement('div');
        range.className = 'range-block-range';
        select.before(range);
        range.append(select);
        if (display) range.append(display);
    }
    if (!inst) return;
    inst.options.options.placeholder = '没有激活的世界书。点击这里选择。';
    if (!inst.$container[0].querySelector('.select2-search__field')) {
        const search = document.createElement('textarea');
        search.className = 'select2-search__field';
        search.setAttribute('spellcheck', 'false');
        search.placeholder = inst.options.options.placeholder;
        inst.$container[0].append(search);
    }
}

test('global worldbook picker remains interactive after three enhancement restarts', async () => {
    const seed = createDefaultSeed({
        characters: [],
        selected_world_info: [],
        worldbooks: { '测试书甲': { entries: {} }, '测试书乙': { entries: {} } },
        pluginSettings: {
            autoScanNewCharacters: false,
            globalHiddenGroupIds: [],
            groups: [{ id: 'test-group', name: '测试分组' }],
            assignments: { '测试书甲': 'test-group', '测试书乙': 'test-group' },
        },
    });
    const server = createMockStServer();
    const baseUrl = await server.start();
    let cdp;
    try {
        cdp = await launchEdgeCdp();
        await resetAndBoot(cdp, baseUrl, { seed, viewport: VIEWPORTS.desktop });
        await cdp.evalFn((key) => {
            const select = document.getElementById('world_info');
            const native = select.nextElementSibling;
            const range = document.createElement('div');
            range.className = 'range-block-range';
            select.before(range);
            range.append(select, native);
            const instance = jQuery(select).data('select2');
            instance.options.options.placeholder = '没有激活的世界书。点击这里选择。';
            const search = document.createElement('textarea');
            search.className = 'select2-search__field';
            search.setAttribute('spellcheck', 'false');
            search.placeholder = instance.options.options.placeholder;
            native.append(search);
            localStorage.setItem(key, JSON.stringify({ settings: {}, pinned: {}, meta: { welcomePopupShown: true } }));
        }, storageKey);

        const install = () => cdp.evalFn((code) => (0, eval)(code), enhancement);
        for (let cycle = 0; cycle < 3; cycle++) {
            await install();
            await waitForCondition(cdp, () => Boolean(document.querySelector('#WIMultiSelector .gr-select2-display')));
            assert.equal(await cdp.evalFn(() => document.querySelectorAll('#WIMultiSelector .gr-select2-display').length), 1);
            await cdp.clickSelector('#WIMultiSelector .gr-select2-display');
            await waitForCondition(cdp, () => Boolean(document.querySelector('#gr-global-dropdown-container')));
            assert.equal(await cdp.evalFn(() => Boolean(document.querySelector('#gr-global-dropdown-container .wbo-pop-filter-bar'))), true,
                `global grouped picker should open in cycle ${cycle + 1}`);
            await cdp.evalFn((flag) => window[flag]?.(), instanceFlag);
            await waitForCondition(cdp, () => !document.querySelector('#gr-global-dropdown-container'));
            assert.equal(await cdp.evalFn(() => document.getElementById('world_info').selectedOptions.length), 0);
        }
        assert.deepEqual(cdp.getErrors().runtimeErrors, []);
    } finally {
        await cdp?.close();
        await server.stop();
    }
});

for (const viewport of [VIEWPORTS.desktop, VIEWPORTS.mobile]) {
test(`global native ${viewport.mobile ? 'mobile fallback' : 'Select2'} retains groups after persisted enhancement disable and full reload three times at ${viewport.name}`, async (t) => {
    const seed = createDefaultSeed({
        characters: [], characterId: null, selected_world_info: [],
        worldbooks: { '测试书甲': { entries: {} }, '测试书乙': { entries: {} } },
        pluginSettings: {
            autoScanNewCharacters: false, hideCharBooksByDefault: false,
            cachedCharBindings: {}, globalPresets: [],
            globalHiddenGroupIds: [], editorHiddenGroupIds: [],
            groups: [{ id: 'test-a', name: '测试分组甲', color: '#5b8def', collapsed: false }, { id: 'test-b', name: '测试分组乙', color: '#4caf84', collapsed: false }],
            assignments: { '测试书甲': 'test-a', '测试书乙': 'test-b' },
        },
    });
    const server = createMockStServer();
    const baseUrl = await server.start();
    let cdp;
    try {
        cdp = await launchEdgeCdp();
        await resetAndBoot(cdp, baseUrl, { seed, viewport });
        await cdp.evalFn(prepareGlobalHost);
        // This isolated runner flag models script activation separately from its own preferences.
        // Neither flag nor the reference script is copied into the host's organizer settings.
        await cdp.evalFn((key, runner) => {
            localStorage.setItem(key, JSON.stringify({ settings: {}, pinned: {}, meta: { welcomePopupShown: true } }));
            localStorage.setItem(runner, 'false');
        }, storageKey, runnerKey);
        await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
            window.addEventListener('load', () => {
                (${prepareGlobalHost.toString()})();
                const enabled = localStorage.getItem(${JSON.stringify(runnerKey)}) === 'true';
                if (enabled) (0, eval)(${JSON.stringify(enhancement)});
                window.__WBO_TOGGLE_BOOT__ = { enabled, timeOrigin: performance.timeOrigin };
            }, { once: true });
        ` });

        const snapshot = () => cdp.evalFn(() => {
            const settings = SillyTavern.getContext().extensionSettings.worldbook_organizer;
            return {
                groups: settings.groups, assignments: settings.assignments,
                hidden: settings.globalHiddenGroupIds,
                options: [...document.getElementById('world_info').options].map((opt) => ({
                    value: opt.value, text: opt.textContent, selected: opt.selected,
                })),
            };
        });
        let expected = await snapshot();
        const stored = await getServerState(baseUrl);
        const activate = async (selector) => {
            if (!viewport.mobile) return cdp.clickSelector(selector);
            const point = await cdp.evalFn((selector) => {
                const el = document.querySelector(selector);
                if (!el) return null;
                const rect = el.getBoundingClientRect();
                return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: rect.width, height: rect.height };
            }, selector);
            assert.ok(point?.width > 0 && point?.height > 0, `touch target must be visible: ${selector}`);
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: point.x, y: point.y }] });
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        };
        const nativeTrigger = viewport.mobile
            ? '#WIMultiSelector .wbo-popup-select-trigger'
            : '#WIMultiSelector .select2-container:not(.select2-container--open)';
        const closeNative = () => viewport.mobile
            ? activate(nativeTrigger)
            : cdp.evalFn(() => jQuery('#world_info').select2('close'));
        const assertNativeGroups = async (label) => {
            if (viewport.mobile) assert.equal(await cdp.evalFn(() => Boolean(jQuery('#world_info').data('select2'))), false,
                'mobile must exercise the actual native fallback, never a fabricated Select2');
            await activate(nativeTrigger);
            if (viewport.mobile) await waitForCondition(cdp, () => Boolean(document.querySelector('#wbo-pop-pills')));
            else await waitForCondition(cdp, () => Boolean(document.querySelector('.select2-dropdown')));
            await cdp.evalFn(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            const dom = await cdp.evalFn((mobile) => ({
                enhanced: Boolean(document.querySelector('#WIMultiSelector .gr-select2-display, style[data-gr-dropdown-style]')),
                pills: [...document.querySelectorAll(mobile ? '#wbo-pop-pills [data-pop-pill]' : '.wbo-global-dd-bar [data-wbo-pill]')]
                    .map((el) => mobile ? el.dataset.popPill : el.dataset.wboPill),
                rows: [...document.querySelectorAll(mobile ? '#wbo-pop-list .wbo-mp-row-title' : '.select2-dropdown [data-wbo-world]')]
                    .map((el) => mobile ? el.textContent.trim() : el.dataset.wboWorld),
            }), viewport.mobile);
            t.diagnostic(`${label}: ${JSON.stringify(dom)}`);
            assert.equal(dom.enhanced, false, `${label}: the script must remain disabled`);
            assert.ok(dom.pills.includes('test-a') && dom.pills.includes('test-b'), `${label}: native category DOM missing`);
            assert.deepEqual(dom.rows.sort(), ['测试书乙', '测试书甲'].sort(), `${label}: native books missing`);
            if (viewport.mobile) {
                const selected = await cdp.evalFn(() => [...document.getElementById('world_info').selectedOptions].map((opt) => opt.textContent.trim()));
                const text = await cdp.evalFn(() => document.querySelector('#WIMultiSelector .wbo-popup-select-trigger').textContent);
                for (const name of selected) assert.ok(text.includes(name), `${label}: trigger must reflect restored selection`);
                await cdp.typeInto('#wbo-pop-search', '测试书甲');
                await waitForCondition(cdp, () => {
                    const rows = [...document.querySelectorAll('#wbo-pop-list .wbo-mp-row-title')];
                    return rows.length === 1 && rows[0].textContent.trim() === '测试书甲';
                });
            }
            await closeNative();
        };
        await assertNativeGroups('baseline');

        for (let cycle = 1; cycle <= 3; cycle++) {
            if (viewport.mobile) {
                await activate(nativeTrigger);
                await waitForCondition(cdp, () => Boolean(document.querySelector('#wbo-pop-pills')));
                if (await cdp.evalFn(() => document.getElementById('world_info').selectedOptions.length > 0)) {
                    await activate('#wbo-pop-clear');
                }
                await activate('#wbo-pop-pills [data-pop-pill="test-b"]');
                await waitForCondition(cdp, () => {
                    const rows = [...document.querySelectorAll('#wbo-pop-list .wbo-mp-row-title')];
                    return rows.length === 1 && rows[0].textContent.trim() === '测试书乙';
                });
                const book = cycle % 2 ? '测试书甲' : '测试书乙';
                // Search must cross the active group, not leave the user trapped in its filter.
                await cdp.typeInto('#wbo-pop-search', book);
                await waitForCondition(cdp, () => {
                    const rows = [...document.querySelectorAll('#wbo-pop-list .wbo-mp-row-title')];
                    return rows.length === 1 && rows[0].textContent.trim() === document.getElementById('wbo-pop-search').value;
                });
                assert.equal(await cdp.evalFn(() => document.querySelector('#wbo-pop-list .wbo-mp-row-title')?.textContent.trim()), book);
                await activate('#wbo-pop-list [data-pop-toggle-val]');
                assert.deepEqual(await cdp.evalFn(() => [...document.getElementById('world_info').selectedOptions].map((opt) => opt.textContent.trim())), [book]);
                assert.deepEqual(await cdp.evalFn(() => [...window.__ST_HOST_RUNTIME__.selected_world_info]), [book], 'fallback must notify the host change handler');
                await closeNative();
                // The mock change handler updates memory only; explicitly flush the host save boundary before reload.
                await cdp.evalFn(() => window.__ST_TEST_HELPERS__.flushSaveSettingsNow());
                expected = await snapshot();
            }
            await cdp.evalFn((runner, code) => {
                localStorage.setItem(runner, 'true');
                (0, eval)(code);
            }, runnerKey, enhancement);
            await waitForCondition(cdp, () => Boolean(document.querySelector('#WIMultiSelector .gr-select2-display')));
            await activate('#WIMultiSelector .gr-select2-display');
            await waitForCondition(cdp, () => Boolean(document.querySelector('#gr-global-dropdown-container .wbo-pop-filter-bar')));
            assert.deepEqual(await snapshot(), expected, 'running the script must not alter classification or selection');
            const beforeReload = await cdp.evalFn((runner, flag, key) => {
                localStorage.setItem(runner, 'false');
                window[flag]?.();
                return { timeOrigin: performance.timeOrigin, preferences: localStorage.getItem(key) };
            }, runnerKey, instanceFlag, storageKey);

            // Keep both storage and the server settings. No resetAndBoot/resetServer on this path.
            await cdp.reload();
            await waitForCondition(cdp, () => Boolean(window.__WBO_TOGGLE_BOOT__));
            const boot = await cdp.evalFn((runner, flag, key) => ({
                ...window.__WBO_TOGGLE_BOOT__, runner: localStorage.getItem(runner),
                preferences: localStorage.getItem(key), active: typeof window[flag] === 'function',
            }), runnerKey, instanceFlag, storageKey);
            assert.notEqual(boot.timeOrigin, beforeReload.timeOrigin, 'the entire document must have reloaded');
            assert.equal(boot.enabled, false);
            assert.equal(boot.runner, 'false');
            assert.equal(boot.active, false);
            assert.equal(boot.preferences, beforeReload.preferences, 'script preferences must survive full reload unchanged');
            assert.deepEqual(await snapshot(), expected, `cycle ${cycle}: host settings/options changed`);
            const after = await getServerState(baseUrl);
            assert.deepEqual(after.extension_settings.worldbook_organizer.groups, stored.extension_settings.worldbook_organizer.groups);
            assert.deepEqual(after.extension_settings.worldbook_organizer.assignments, stored.extension_settings.worldbook_organizer.assignments);
            assert.deepEqual(after.selected_world_info, expected.options.filter((opt) => opt.selected).map((opt) => opt.text));
            assert.deepEqual(after.world_names, stored.world_names);
            await assertNativeGroups(`disabled reload ${cycle}`);
        }
        assert.deepEqual(cdp.getErrors().runtimeErrors, []);
    } finally {
        await cdp?.close();
        await server.stop();
    }
});
}
