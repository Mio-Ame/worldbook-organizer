import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const suite = process.env.WBO_E2E_SUITE;
if (!suite) throw new Error('Set WBO_E2E_SUITE to the retained browser regression suite');
const load = (name) => import(pathToFileURL(resolve(suite, 'lib', name)).href);
const { createMockStServer } = await load('mock-server.mjs');
const { VIEWPORTS, launchEdgeCdp } = await load('cdp.mjs');
const { createDefaultSeed, createManyGroupsSeed } = await load('fixtures.mjs');
const { getServerState, openManager, resetAndBoot, waitForCondition } = await load('assert-helpers.mjs');

async function withMockHost(seed, workflow, viewport = VIEWPORTS.desktop) {
    const server = createMockStServer();
    const baseUrl = await server.start();
    let cdp;
    try {
        cdp = await launchEdgeCdp();
        await resetAndBoot(cdp, baseUrl, { seed, viewport });
        await workflow(cdp, baseUrl);
        assert.deepEqual(cdp.getErrors().runtimeErrors, []);
    } finally {
        await cdp?.close();
        await server.stop();
    }
}

test('AI picks can be restored in bulk, switched by category, grouped explicitly and undone', async () => {
    const sensitive = '成人向测试书';
    const seed = createDefaultSeed({
        characters: [],
        worldbooks: { 普通测试书: { entries: {} }, [sensitive]: { entries: {} } },
        selected_world_info: [],
        pluginSettings: {
            organizeLastTab: 'organize',
            autoScanNewCharacters: false,
            groups: [{ id: 'fixture-destination', name: '测试归档', color: '#6b7a8c' }],
            assignments: {},
        },
    });
    await withMockHost(seed, async (cdp, baseUrl) => {
        await openManager(cdp);
        await cdp.clickSelector('[data-action="open-ai-organize"]');
        const safetyText = await cdp.evalFn(() => document.querySelector('#wbo-sens-banner-text').textContent);
        assert.equal(safetyText, '有疑似敏感世界书，发送可能会触发AI拒绝回答。');
        assert.equal(await cdp.evalFn(() => document.querySelector('[data-ai-section="sensitive"]').hidden), true);
        assert.equal(await cdp.evalFn(() => document.querySelector('#wbo-pick-none').textContent), '全选');
        await cdp.clickSelector('#wbo-pick-none');
        assert.equal(await cdp.evalFn(() => document.querySelectorAll('.wbo-ai-book-check:checked').length), 2);
        assert.equal(await cdp.evalFn(() => document.querySelector('#wbo-pick-none').textContent), '取消全选');
        await cdp.clickSelector('#wbo-pick-none');
        assert.equal(await cdp.evalFn(() => document.querySelectorAll('.wbo-ai-book-check:checked').length), 0);
        await cdp.clickSelector('[data-ai-book-tab="sensitive"]');
        assert.equal(await cdp.evalFn(() => document.querySelector('[data-ai-section="normal"]').hidden), true);
        await cdp.clickSelector('#wbo-pick-toggle-sens');
        await cdp.evalFn(() => {
            const target = document.querySelector('#wbo-sens-target-group');
            target.value = 'fixture-destination';
            target.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await cdp.clickSelector('#wbo-sens-move-nsfw-btn');
        const before = await getServerState(baseUrl);
        assert.equal(before.extension_settings.worldbook_organizer.assignments[sensitive], undefined);
        await cdp.clickSelector('#wbo-sens-confirm-ok');
        await waitForCondition(cdp, () => document.querySelector('#wbo-sens-result-text')?.textContent.includes('测试归档'));
        await waitForCondition(cdp, async () => {
            const state = await fetch('/__test/state').then((res) => res.json());
            return state.extension_settings.worldbook_organizer.assignments['成人向测试书'] === 'fixture-destination';
        });
        await cdp.clickSelector('#wbo-sens-inline-undo');
        await waitForCondition(cdp, async () => {
            const state = await fetch('/__test/state').then((res) => res.json());
            return !state.extension_settings.worldbook_organizer.assignments['成人向测试书'];
        });
    });
});

test('global combo names are safe to select and their editors can jump directly to a group', async () => {
    const seed = createDefaultSeed({
        characters: [],
        worldbooks: { 原全局书: { entries: {} }, 组合测试书: { entries: {} }, 分组外书: { entries: {} } },
        selected_world_info: ['原全局书'],
        pluginSettings: {
            nativeQuickActionsMode: 'merged',
            quickHubLastTab: 'presets',
            groups: [{ id: 'fixture-quick-group', name: '组合测试组', color: '#6b7a8c' }],
            assignments: { 组合测试书: 'fixture-quick-group' },
            globalPresets: [{ id: 'fixture-combo', name: '测试组合', books: ['组合测试书'] }],
            autoScanNewCharacters: false,
        },
    });
    await withMockHost(seed, async (cdp) => {
        const readActive = () => cdp.evalFn(() => [...document.querySelectorAll('#world_info option:checked')].map((item) => item.textContent.trim()));
        await cdp.clickSelector('#wbo-wi-merged-btn');
        await cdp.clickSelector('[data-qhub-select="fixture-combo"]');
        assert.deepEqual(await readActive(), ['原全局书']);
        assert.equal(await cdp.evalFn(() => document.querySelector('[data-qhub-select]').getAttribute('aria-pressed')), 'true');
        assert.equal(await cdp.evalFn(() => document.querySelector('#wbo-qhub-clear-all').textContent), '关闭所有全局');
        await cdp.clickSelector('[data-qhub-apply="fixture-combo"]');
        assert.deepEqual(await readActive(), ['组合测试书']);

        await cdp.clickSelector('#wbo-qhub-free-new');
        assert.equal(await cdp.evalFn(() => document.querySelector('#wbo-cmb-seed-active-btn').textContent), '加入已开启的全局世界书');
        await cdp.clickSelector('#wbo-cmb-seed-active-btn');
        assert.match(await cdp.evalFn(() => document.querySelector('#wbo-cmb-pick-feedback').textContent), /已勾选 1 本/);
        await cdp.clickSelector('[data-cmb-pill="fixture-quick-group"]');
        const result = await cdp.evalFn(() =>
            [...document.querySelectorAll('.wbo-cmb-pick-row:not([hidden]) .wbo-cmb-book-check')].map((item) => [item.value, item.checked]),
        );
        assert.deepEqual(result, [['组合测试书', true]]);
        await cdp.clickSelector('#wbo-submodal-overlay .wbo-modal-close');
        await openManager(cdp);
        await cdp.clickSelector('#wbo-manager-overlay [data-action="create-group"]:not([hidden])');
        await cdp.clickSelector('[data-gp-pill="group:fixture-quick-group"]');
        const groupResult = await cdp.evalFn(() =>
            [...document.querySelectorAll('.wbo-gp-row:not([hidden]) .wbo-group-pick-check')].map((item) => item.value),
        );
        assert.deepEqual(groupResult, ['组合测试书']);
    });
});

test('mobile worldbook search stays compact and group creation toggles the filtered ungrouped books', async () => {
    const seed = createDefaultSeed({
        characters: [],
        worldbooks: { 测试甲书: { entries: {} }, 测试乙书: { entries: {} } },
        selected_world_info: [],
        pluginSettings: { groups: [], assignments: {}, autoScanNewCharacters: false },
    });
    await withMockHost(seed, async (cdp) => {
        await openManager(cdp);
        const readSize = (selector) => cdp.evalFn((target) => {
            const input = document.querySelector(target);
            return [getComputedStyle(input).fontSize, input.getBoundingClientRect().height];
        }, selector);
        assert.deepEqual(await readSize('#wbo-mgr-search-input'), ['12.5px', 28]);
        await cdp.clickSelector('#wbo-mgr-list-create-btn');
        assert.deepEqual(await readSize('#wbo-group-pick-filter'), ['12px', 26]);
        await cdp.evalFn(() => {
            const input = document.querySelector('#wbo-group-pick-filter');
            input.value = '甲';
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        const toggle = '#wbo-gp-select-ungrouped-btn';
        const readLabel = () => cdp.evalFn((target) => document.querySelector(target).textContent, toggle);
        const readChecked = () => cdp.evalFn(() =>
            [...document.querySelectorAll('.wbo-group-pick-check:checked')].map((item) => item.value),
        );
        assert.equal(await readLabel(), '全选当前所有未分组');
        await cdp.clickSelector(toggle);
        assert.deepEqual(await readChecked(), ['测试甲书']);
        assert.equal(await readLabel(), '取消全选当前未分组');
        await cdp.clickSelector(toggle);
        assert.deepEqual(await readChecked(), []);
        assert.equal(await readLabel(), '全选当前所有未分组');
    }, VIEWPORTS.mobile);
});

test('two short groups stay in one row even with a saved expanded preference', async () => {
    const seed = createDefaultSeed({
        characters: [],
        worldbooks: { 测试甲书: { entries: {} }, 测试乙书: { entries: {} } },
        selected_world_info: [],
        pluginSettings: {
            groups: [{ id: 'fixture-a', name: '甲', color: '#6b7a8c' }, { id: 'fixture-b', name: '乙', color: '#6b7a8c' }],
            assignments: { 测试甲书: 'fixture-a', 测试乙书: 'fixture-b' },
            autoScanNewCharacters: false,
            groupPanelExpanded: true,
        },
    });
    await withMockHost(seed, async (cdp) => {
        await openManager(cdp);
        const view = await cdp.evalFn(() => {
            const pills = document.querySelector('#wbo-mgr-pills');
            return {
                fits: pills.scrollWidth === pills.clientWidth,
                expanded: pills.classList.contains('is-expanded'),
                hidden: document.querySelector('#wbo-mgr-pills-expand').hidden,
            };
        });
        assert.deepEqual(view, { fits: true, expanded: false, hidden: true });
    }, VIEWPORTS.mobile);
});

test('the group pill toggle follows available width and preserves the expanded preference', async () => {
    await withMockHost(createManyGroupsSeed(3), async (cdp) => {
        await openManager(cdp);
        await waitForCondition(cdp, () => !document.querySelector('#wbo-mgr-pills-expand').hidden);
        await cdp.clickSelector('#wbo-mgr-pills-expand');
        await waitForCondition(cdp, () => {
            const rows = [...document.querySelectorAll('#wbo-mgr-pills .wbo-pill')].map((p) => p.offsetTop);
            return new Set(rows).size > 1;
        });
        await cdp.setViewport(VIEWPORTS.desktop);
        await waitForCondition(cdp, () => {
            const pills = document.querySelector('#wbo-mgr-pills');
            return document.querySelector('#wbo-mgr-pills-expand').hidden && !pills.classList.contains('is-expanded');
        });
        await waitForCondition(cdp, async () => {
            const state = await fetch('/__test/state').then((res) => res.json());
            return state.extension_settings.worldbook_organizer.groupPanelExpanded === true;
        });
        await cdp.setViewport(VIEWPORTS.mobile);
        await waitForCondition(cdp, () => {
            const toggle = document.querySelector('#wbo-mgr-pills-expand');
            return !toggle.hidden && toggle.getAttribute('aria-expanded') === 'true';
        });
        await cdp.clickSelector('#wbo-mgr-pills-expand');
        assert.equal(await cdp.evalFn(() => document.querySelector('#wbo-mgr-pills-expand').getAttribute('aria-expanded')), 'false');
    }, VIEWPORTS.mobile);
});
