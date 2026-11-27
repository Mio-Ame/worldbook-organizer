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

test('AI sensitive grouping uses the requested new-group label', async () => {
    await withMockHost(createDefaultSeed({
        characters: [], selected_world_info: [], worldbooks: { '成人向测试书': { entries: {} } },
        pluginSettings: { organizeLastTab: 'organize', autoScanNewCharacters: false, groups: [], assignments: {} },
    }), async (cdp) => {
        await openManager(cdp);
        await cdp.clickSelector('[data-action="open-ai-organize"]');
        await cdp.clickSelector('[data-ai-book-tab="sensitive"]');
        assert.equal(await cdp.evalFn(() => document.querySelector('#wbo-sens-target-group option[value="__new_nsfw__"]').textContent), '新建：「NSFW」分组');
    }, VIEWPORTS.mobile);
});

test('AI picks can be restored in bulk, switched by category, grouped explicitly and undone', async () => {
    const sensitive = '成人向测试书';
    const warning = '已勾选了疑似敏感世界书，发送可能会触发AI拒绝回答。';
    const defaultWarning = '有疑似敏感世界书，发送可能会触发AI拒绝回答，因此已默认移除选中。';
    const seed = createDefaultSeed({
        characters: [],
        worldbooks: { 普通测试书: { entries: {} }, 已分组测试书: { entries: {} }, [sensitive]: { entries: {} } },
        selected_world_info: [],
        pluginSettings: {
            organizeLastTab: 'organize',
            aiOrganizeScope: 'nonchar',
            autoScanNewCharacters: false,
            groups: [
                { id: 'fixture-destination', name: '测试归档', color: '#6b7a8c' },
                { id: 'fixture-sensitive-group', name: '成人向世界书测试归档', color: '#a55751' },
            ],
            assignments: { 已分组测试书: 'fixture-destination' },
        },
    });
    await withMockHost(seed, async (cdp, baseUrl) => {
        await openManager(cdp);
        await cdp.clickSelector('[data-action="open-ai-organize"]');
        const safetyText = () => cdp.evalFn(() => document.querySelector('#wbo-sens-banner-text').textContent);
        const picks = () => cdp.evalFn(() => document.querySelector('#wbo-ai-selected-count').textContent);
        assert.equal(await cdp.evalFn(() => document.querySelector('#wbo-ai-pick-default-hint')?.textContent), '默认只勾选未分组的世界书，可手动调整。');
        assert.equal(await safetyText(), defaultWarning);
        assert.equal(await picks(), '已勾选 1 本世界书');
        assert.equal(await cdp.evalFn(() => {
            const count = document.querySelector('#wbo-ai-selected-count');
            const value = count.querySelector('strong');
            const style = getComputedStyle(count);
            return value.textContent === '1'
                && parseFloat(getComputedStyle(value).fontSize) > parseFloat(style.fontSize)
                && style.backgroundColor !== 'rgba(0, 0, 0, 0)';
        }), true);
        assert.deepEqual(await cdp.evalFn(() => [...document.querySelectorAll('.wbo-ai-book-check:checked')].map((box) => box.value)), ['普通测试书']);
        assert.match(await cdp.evalFn(() => document.querySelector('#wbo-ai-book-groups [aria-pressed="true"]').textContent), /未分组/);
        assert.equal(await cdp.evalFn(() => document.querySelector('[data-ai-section="sensitive"]').hidden), true);
        assert.equal(await cdp.evalFn(() => document.querySelector('#wbo-ai-sensitive-actions').hidden), true);
        assert.equal(await cdp.evalFn(() => document.querySelector('#wbo-pick-none').textContent), '全选');
        await cdp.clickSelector('#wbo-pick-none');
        assert.equal(await picks(), '已勾选 3 本世界书');
        assert.equal(await safetyText(), warning);
        assert.equal(await cdp.evalFn(() => document.querySelector('#wbo-pick-none').textContent), '取消全选');
        await cdp.clickSelector('#wbo-pick-none');
        assert.equal(await picks(), '已勾选 0 本世界书');
        assert.equal(await safetyText(), defaultWarning);
        await cdp.clickSelector('[data-ai-book-tab="sensitive"]');
        assert.equal(await cdp.evalFn(() => document.querySelector('[data-ai-section="normal"]').hidden), true);
        await cdp.setViewport(VIEWPORTS.mobile);
        const readLayout = () => cdp.evalFn(() => {
            const field = document.querySelector('#wbo-sens-target-group');
            const select = field.getBoundingClientRect();
            const button = document.querySelector('#wbo-sens-move-nsfw-btn').getBoundingClientRect();
            const arrow = field.parentElement.querySelector('.fa-chevron-down');
            const style = getComputedStyle(field);
            const canvas = document.createElement('canvas').getContext('2d');
            canvas.font = `${style.fontSize} ${style.fontFamily}`;
            const textWidth = canvas.measureText(field.selectedOptions[0].textContent).width;
            return {
                aligned: Math.abs(select.top + select.height / 2 - button.top - button.height / 2) < 1,
                adjacent: select.right <= button.left,
                labelFits: select.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 2 > textWidth,
                arrow: Boolean(arrow && arrow.getBoundingClientRect().width > 0 && getComputedStyle(arrow).pointerEvents === 'none'),
                width: select.width,
            };
        });
        const { width, ...layout } = await readLayout();
        assert.deepEqual(layout, { aligned: true, adjacent: true, labelFits: true, arrow: true });
        await cdp.clickSelector('#wbo-pick-toggle-sens');
        assert.deepEqual(await readLayout(), { ...layout, width });
        assert.equal(await picks(), '已勾选 1 本世界书');
        assert.equal(await safetyText(), warning);
        assert.equal(await cdp.evalFn(() => document.querySelector('#wbo-sens-move-nsfw-btn').matches('.wbo-btn-primary:enabled')), true);
        const selectTarget = (label) => cdp.evalFn((name) => {
            const target = document.querySelector('#wbo-sens-target-group');
            const option = [...target.options].find((item) => item.textContent.includes(name));
            if (!option) return false;
            target.value = option.value;
            target.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        }, label);
        assert.equal(await selectTarget('测试归档'), true);
        await cdp.clickSelector('#wbo-sens-move-nsfw-btn');
        const before = await getServerState(baseUrl);
        assert.equal(before.extension_settings.worldbook_organizer.assignments[sensitive], undefined);
        await cdp.clickSelector('#wbo-sens-confirm-ok');
        await waitForCondition(cdp, () => document.querySelector('#wbo-sens-result-text')?.textContent.includes('测试归档'));
        assert.equal(await picks(), '已勾选 0 本世界书');
        await waitForCondition(cdp, async () => {
            const state = await fetch('/__test/state').then((res) => res.json());
            return state.extension_settings.worldbook_organizer.assignments['成人向测试书'] === 'fixture-destination';
        });
        await cdp.clickSelector('#wbo-sens-inline-undo');
        await waitForCondition(cdp, async () => {
            const state = await fetch('/__test/state').then((res) => res.json());
            return !state.extension_settings.worldbook_organizer.assignments['成人向测试书'];
        });

        await cdp.clickSelector('#wbo-pick-toggle-sens');
        assert.equal(await selectTarget('新建分组'), true);
        await cdp.clickSelector('#wbo-sens-move-nsfw-btn');
        assert.equal(await cdp.evalFn(() => document.activeElement.id === 'wbo-inline-prompt-input'), false);
        await cdp.clickSelector('#wbo-inline-prompt-cancel');
        assert.equal(await cdp.evalFn(() => document.querySelector('#wbo-sens-confirm-bar').hidden), true);
        assert.equal(await picks(), '已勾选 1 本世界书');
        await cdp.clickSelector('#wbo-sens-move-nsfw-btn');
        await cdp.typeInto('#wbo-inline-prompt-input', '新建测试分组');
        await cdp.clickSelector('#wbo-inline-prompt-ok');
        await waitForCondition(cdp, () => document.querySelector('#wbo-sens-confirm-text')?.textContent.includes('新建分组「新建测试分组」'));
        const beforeNew = (await getServerState(baseUrl)).extension_settings.worldbook_organizer;
        assert.equal(beforeNew.groups.some((group) => group.name === '新建测试分组'), false);
        await cdp.clickSelector('#wbo-sens-confirm-ok');
        await waitForCondition(cdp, async () => {
            const state = await fetch('/__test/state').then((res) => res.json());
            const { groups, assignments } = state.extension_settings.worldbook_organizer;
            return groups.some((group) => group.name === '新建测试分组' && assignments['成人向测试书'] === group.id);
        });
        await cdp.clickSelector('#wbo-sens-inline-undo');
        await waitForCondition(cdp, async () => {
            const state = await fetch('/__test/state').then((res) => res.json());
            const { groups, assignments } = state.extension_settings.worldbook_organizer;
            return !groups.some((group) => group.name === '新建测试分组') && !assignments['成人向测试书'];
        });
    });
});

test('AI organize starts with no picks when all worldbooks are already grouped', async () => {
    const seed = createDefaultSeed({
        characters: [],
        worldbooks: { 已分组测试书: { entries: {} } },
        selected_world_info: [],
        pluginSettings: {
            organizeLastTab: 'organize',
            autoScanNewCharacters: false,
            groups: [{ id: 'fixture-existing', name: '测试归档', color: '#6b7a8c' }],
            assignments: { 已分组测试书: 'fixture-existing' },
        },
    });
    await withMockHost(seed, async (cdp) => {
        await openManager(cdp);
        await cdp.clickSelector('[data-action="open-ai-organize"]');
        const picks = () => cdp.evalFn(() => document.querySelector('#wbo-ai-selected-count').textContent);
        assert.equal(await picks(), '已勾选 0 本世界书');
        await cdp.clickSelector('#wbo-pick-nonchar');
        assert.equal(await picks(), '已勾选 1 本世界书');
        await cdp.clickSelector('#wbo-submodal-overlay .wbo-modal-close');
        await cdp.clickSelector('[data-action="open-ai-organize"]');
        assert.equal(await picks(), '已勾选 0 本世界书');
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
        const comboTags = () => cdp.evalFn(() => [...document.querySelectorAll('[data-cmb-gid="fixture-quick-group"]:not([hidden]) .wbo-tag')]
            .filter((tag) => tag.getBoundingClientRect().height > 0).map((tag) => tag.textContent.trim()));
        assert.deepEqual(await comboTags(), ['已全局', '组合测试组']);
        await cdp.clickSelector('[data-cmb-pill="fixture-quick-group"]');
        // A mounted global book stays out of the group list; the character rule never applies to it.
        assert.deepEqual(await cdp.evalFn(() =>
            [...document.querySelectorAll('.wbo-cmb-pick-row:not([hidden]) .wbo-cmb-book-check')].map((item) => item.value),
        ), []);
        assert.equal(await cdp.evalFn(() => {
            const row = document.querySelector('.wbo-cmb-pick-row[data-cmb-gid="fixture-quick-group"]');
            return Boolean(row?.hidden) && row.getAttribute('data-cmb-global') === '1';
        }), true);
        await cdp.clickSelector('[data-cmb-pill="__global__"]');
        assert.deepEqual(await cdp.evalFn(() =>
            [...document.querySelectorAll('.wbo-cmb-pick-row:not([hidden]) .wbo-cmb-book-check')].map((item) => [item.value, item.checked]),
        ), [['组合测试书', true]]);
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

test('global combo editor splits group pills from scope pills, emphasizes picked and remembers per-pill scroll', async () => {
    const many = Array.from({ length: 40 }, (_, i) => `批量书${String(i).padStart(2, '0')}`);
    const seed = createDefaultSeed({
        characters: [{ avatar: 'example.png', name: '测试角色', data: { extensions: { world: '角色书' } } }],
        worldbooks: Object.fromEntries([...many, '收藏书', '角色书'].map((name) => [name, { entries: {} }])),
        selected_world_info: [many[0]],
        pluginSettings: {
            nativeQuickActionsMode: 'merged',
            quickHubLastTab: 'presets',
            groups: [{ id: 'fixture-scroll-group', name: '滚动测试组', color: '#6b7a8c' }],
            assignments: Object.fromEntries(many.slice(0, 20).map((name) => [name, 'fixture-scroll-group'])),
            pinnedBooks: ['收藏书'],
            autoScanNewCharacters: false,
        },
    });
    await withMockHost(seed, async (cdp) => {
        await cdp.clickSelector('#wbo-wi-merged-btn');
        await cdp.clickSelector('#wbo-qhub-free-new');
        await waitForCondition(cdp, () => Boolean(document.querySelector('#wbo-cmb-pick-list')));

        const pillOrder = (selector) => cdp.evalFn((sel) =>
            [...document.querySelectorAll(`${sel} [data-cmb-pill]`)].map((btn) => btn.getAttribute('data-cmb-pill')), selector);
        assert.deepEqual(await pillOrder('#wbo-cmb-group-pills'), ['__pinned__', 'fixture-scroll-group', '__ungrouped__']);
        assert.deepEqual(await pillOrder('#wbo-cmb-pills'), ['__selected__', '__all__', '__global__', '__nonchar__', '__char__']);
        assert.equal(await cdp.evalFn(() => {
            const pill = document.querySelector('[data-cmb-pill="__selected__"]');
            const style = getComputedStyle(pill);
            return `${style.backgroundColor}|${style.color}|${pill.className.includes('is-emphasis')}`;
        }), 'rgb(22, 24, 29)|rgb(255, 255, 255)|true');

        const scrollState = () => cdp.evalFn(() => {
            const host = document.querySelector('#wbo-cmb-pick-list');
            if (!host) return null;
            return { top: Math.round(host.scrollTop), max: Math.round(host.scrollHeight), client: Math.round(host.clientHeight) };
        });
        const scrollToBottom = () => cdp.evalFn(() => {
            const host = document.querySelector('#wbo-cmb-pick-list');
            host.scrollTop = host.scrollHeight;
        });

        await cdp.clickSelector('[data-cmb-pill="fixture-scroll-group"]');
        assert.ok((await scrollState()).max > (await scrollState()).client, 'group pill view must be scrollable');
        // A never-visited pill starts at the top.
        await cdp.clickSelector('[data-cmb-pill="__all__"]');
        assert.equal((await scrollState()).top, 0);
        await cdp.evalFn(() => {
            const host = document.querySelector('#wbo-cmb-pick-list');
            host.scrollTop = 120;
        });
        await cdp.clickSelector('[data-cmb-pill="__nonchar__"]');
        assert.equal((await scrollState()).top, 0, 'a different pill keeps its own position');
        await cdp.clickSelector('[data-cmb-pill="__all__"]');
        assert.equal((await scrollState()).top, 120, 'mid-list positions are remembered too');

        await scrollToBottom();
        await cdp.clickSelector('[data-cmb-pill="__nonchar__"]');
        await cdp.clickSelector('[data-cmb-pill="__all__"]');
        const restored = await scrollState();
        assert.ok(restored.top > 120, `the bottom-most position is kept as-is, got ${JSON.stringify(restored)}`);
    });
});
