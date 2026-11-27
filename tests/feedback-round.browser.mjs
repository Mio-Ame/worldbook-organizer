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
const { resetAndBoot, openManager, waitForCondition } = await load('assert-helpers.mjs');
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

async function withHost(viewport, seedOptions, run, query = '') {
    const server = createMockStServer();
    const baseUrl = await server.start();
    let cdp;
    try {
        cdp = await launchEdgeCdp();
        await resetAndBoot(cdp, baseUrl, { viewport, query, seed: createDefaultSeed(seedOptions) });
        await run(cdp);
        assert.deepEqual(cdp.getErrors().runtimeErrors, []);
    } finally {
        await cdp?.close();
        await server.stop();
    }
}

const manyBooks = ['全局测试书', ...Array.from({ length: 36 }, (_, i) => `普通测试书${i + 1}`)];
const comboSeed = {
    characters: [], selected_world_info: ['全局测试书'],
    worldbooks: Object.fromEntries(manyBooks.map((n) => [n, { entries: {} }])),
    pluginSettings: {
        autoScanNewCharacters: false, groups: [{ id: 'test-a', name: '测试分组' }],
        assignments: { '全局测试书': 'test-a' }, showCharBooks: true, globalHiddenGroupIds: [], editorHiddenGroupIds: [],
    },
};
const tabletSeed = {
    ...comboSeed,
    selected_world_info: [],
    pluginSettings: {
        ...comboSeed.pluginSettings, showNativeOptgroups: true,
        groups: [{ id: 'test-a', name: '测试分组' }, { id: 'test-b', name: '古风设定' }],
        assignments: { '全局测试书': 'test-a', '普通测试书1': 'test-b' },
    },
};

const globalSeed = (selected) => ({
    characters: [{ avatar: 'neutral.png', name: '中性角色', data: { extensions: { world: '角色书' } } }],
    characterId: 0,
    selected_world_info: selected,
    worldbooks: Object.fromEntries(['角色书', '已开全局书', '隐藏组全局书', '普通书甲', '普通书乙'].map((n) => [n, { entries: {} }])),
    pluginSettings: {
        autoScanNewCharacters: false, showCharBooks: false, hideCharBooksByDefault: true, showNativeOptgroups: true,
        pinCurrentChatCharBookInEditor: true, charBookTitleMode: 'original', cachedCharBindings: {},
        groups: [{ id: 'g-a', name: '测试分组甲' }, { id: 'g-b', name: '测试分组乙' }, { id: 'g-hidden', name: '隐藏分组' }],
        assignments: { '已开全局书': 'g-a', '普通书甲': 'g-a', '隐藏组全局书': 'g-hidden', '普通书乙': 'g-b' },
        editorHiddenGroupIds: ['__char__', 'g-hidden'], globalHiddenGroupIds: [], pinnedBooks: [],
    },
});

async function readEditorOrder(cdp, mobile) {
    if (mobile) {
        await cdp.clickSelector('#wbo-mobile-editor-trigger');
        await pause(150);
        const out = await cdp.evalFn(() => ({
            bare: [...document.querySelectorAll('#wbo-mp-list .wbo-mp-bare-sec [data-mp-world]')].map((el) => el.dataset.mpWorld),
            all: [...document.querySelectorAll('#wbo-mp-list [data-mp-world]')].map((el) => el.dataset.mpWorld),
        }));
        await cdp.evalFn(() => document.querySelector('.wbo-mp-backdrop')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
        await pause(100);
        return out;
    }
    return cdp.evalFn(() => {
        const select = document.getElementById('world_editor_select');
        const flat = [...select.children].filter((el) => el.tagName === 'OPTION' && el.value !== '').map((el) => el.textContent);
        if (!select.querySelector('optgroup')) throw new Error('expected optgroups with two visible groups');
        const all = [...select.querySelectorAll('option')].filter((el) => el.value !== '').map((el) => el.textContent);
        return { bare: flat, all };
    });
}

for (const viewport of [VIEWPORTS.mobile, VIEWPORTS.desktop]) {
    test(`${viewport.name}: ordinary picker lists current role book, then active globals, then groups`, async () => {
        await withHost(viewport, globalSeed(['已开全局书', '隐藏组全局书']), async (cdp) => {
            await cdp.evalFn(() => window.__ST_TEST_HELPERS__.setActiveCharacter(0));
            await pause(800);
            const on = await readEditorOrder(cdp, viewport.mobile);
            assert.deepEqual(on.bare.slice(0, 3), ['角色书', '已开全局书', '隐藏组全局书'], JSON.stringify(on));
            assert.equal(on.all.filter((n) => n === '已开全局书').length, 1, 'no duplicate rows');
            assert.ok(on.all.includes('隐藏组全局书'), 'active book from a hidden group stays selectable');
            await cdp.evalFn(() => {
                const select = document.getElementById('world_info');
                for (const opt of select.options) if (opt.textContent === '已开全局书' || opt.textContent === '隐藏组全局书') opt.selected = false;
                jQuery(select).trigger('change');
            });
            await pause(200);
            const off = await readEditorOrder(cdp, viewport.mobile);
            assert.ok(!off.bare.includes('已开全局书'), `turned-off book returns to its group: ${JSON.stringify(off)}`);
            assert.ok(off.all.includes('已开全局书'));
            assert.ok(!off.all.includes('隐藏组全局书'), 'hidden-group book is hidden again once it is off');
            const globals = await cdp.evalFn(() => [...document.getElementById('world_info').selectedOptions].map((o) => o.textContent));
            assert.deepEqual(globals, []);
        }, viewport.mobile ? 'mobile=1' : '');
    });
}

const foldSeed = {
    characters: [], selected_world_info: [],
    worldbooks: Object.fromEntries(['甲组书一', '甲组书二', '乙组书一'].map((n) => [n, { entries: {} }])),
    pluginSettings: {
        autoScanNewCharacters: false, showCharBooks: true, showNativeOptgroups: true,
        groups: [{ id: 'g-a', name: '测试分组甲' }, { id: 'g-b', name: '测试分组乙' }],
        assignments: { '甲组书一': 'g-a', '甲组书二': 'g-a', '乙组书一': 'g-b' },
        dropdownCollapsed: { 'g-a': true }, editorHiddenGroupIds: [], globalHiddenGroupIds: [], pinnedBooks: [],
    },
};

test('390x844: entering a folded group from its pill shows it expanded without changing the saved fold', async () => {
    await withHost(VIEWPORTS.mobile, foldSeed, async (cdp) => {
        const rows = () => cdp.evalFn(() => [...document.querySelectorAll('#wbo-mp-list [data-mp-world]')].map((el) => el.dataset.mpWorld));
        await cdp.clickSelector('#wbo-mobile-editor-trigger');
        assert.ok(!(await rows()).includes('甲组书一'), 'folded in the all view');
        await cdp.clickSelector('#wbo-mp-pills [data-mp-pill="g-a"]');
        assert.deepEqual((await rows()).sort(), ['甲组书一', '甲组书二'].sort(), 'entered group is expanded');
        await cdp.clickSelector('#wbo-mp-list [data-mp-toggle="g-a"]');
        assert.deepEqual(await rows(), [], 'can still fold inside the group');
        await cdp.clickSelector('#wbo-mp-list [data-mp-toggle="g-a"]');
        await cdp.clickSelector('#wbo-mp-pills [data-mp-pill="__all__"]');
        assert.ok(!(await rows()).includes('甲组书一'), 'all view keeps the saved fold');
        const saved = await cdp.evalFn(() => SillyTavern.getContext().extensionSettings.worldbook_organizer.dropdownCollapsed);
        assert.equal(saved['g-a'], true);
    }, 'mobile=1');
});

test('1280x860: Select2 picker expands an entered folded group only while it is isolated', async () => {
    await withHost(VIEWPORTS.desktop, foldSeed, async (cdp) => {
        await cdp.evalFn(() => jQuery('#world_editor_select').select2('open'));
        await waitForCondition(cdp, () => document.querySelector('.select2-dropdown .wbo-dd-pill[data-wbo-pill="g-a"]'));
        const collapsed = () => cdp.evalFn(() => document.querySelector('.select2-dropdown li[data-wbo-dd-group="g-a"]')?.classList.contains('wbo-dd-collapsed'));
        assert.equal(await collapsed(), true);
        await cdp.clickSelector('.select2-dropdown .wbo-dd-pill[data-wbo-pill="g-a"]');
        assert.equal(await collapsed(), false, 'entered group is expanded');
        await cdp.clickSelector('.select2-dropdown .wbo-dd-pill[data-wbo-pill="g-a"]');
        assert.equal(await collapsed(), true, 'back to all keeps the saved fold');
    });
});

const prefix = '/scripts/extensions/third-party/worldbook-organizer/';

async function footerOrder(cdp, confirmSel, cancelSel) {
    return cdp.evalFn((ok, no) => {
        const a = document.querySelector(ok);
        const b = document.querySelector(no);
        if (!a || !b) return { missing: [!a && ok, !b && no].filter(Boolean) };
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        const hit = (el, r) => el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
        return { confirmLeft: ra.left < rb.left, confirmHit: hit(a, ra), cancelHit: hit(b, rb), inView: rb.right <= innerWidth + 1 };
    }, confirmSel, cancelSel);
}

for (const viewport of [VIEWPORTS.mobile, VIEWPORTS.desktop]) {
    test(`${viewport.name}: dialogs put confirm on the left and cancel on the right`, async () => {
        await withHost(viewport, comboSeed, async (cdp) => {
            await openManager(cdp);
            await cdp.clickSelector('[data-action="open-combos-modal"]');
            await cdp.clickSelector('#wbo-cmb-free-new-btn');
            const combo = await footerOrder(cdp, '#wbo-cmb-save-apply-btn', '#wbo-cmb-cancel-edit-btn');
            assert.deepEqual(combo, { confirmLeft: true, confirmHit: true, cancelHit: true, inView: true }, `combo: ${JSON.stringify(combo)}`);
            const only = await footerOrder(cdp, '#wbo-cmb-save-only-btn', '#wbo-cmb-cancel-edit-btn');
            assert.equal(only.confirmLeft, true);
            await cdp.clickSelector('#wbo-cmb-cancel-edit-btn');
            await waitForCondition(cdp, () => !document.getElementById('wbo-cmb-step-list').hidden);
            await cdp.clickSelector('#wbo-cmb-close-btn');
            await waitForCondition(cdp, () => !document.getElementById('wbo-cmb-close-btn'));

            await cdp.evalFn((p) => import(p + 'src/panel-import-rules.js').then((m) => m.openImportRulesModal({ stack: true })), prefix);
            await waitForCondition(cdp, () => document.querySelector('[data-import-rules-save]'));
            const rules = await footerOrder(cdp, '[data-import-rules-save]', '[data-import-rules-cancel]');
            assert.deepEqual(rules, { confirmLeft: true, confirmHit: true, cancelHit: true, inView: true }, `import rules: ${JSON.stringify(rules)}`);
            await cdp.clickSelector('[data-import-rules-cancel]');
        }, viewport.mobile ? 'mobile=1' : '');
    });
}

const excludeSeed = {
    characters: [], selected_world_info: [],
    worldbooks: { '甲组书一': { entries: {} }, '乙组书一': { entries: {} } },
    pluginSettings: {
        autoScanNewCharacters: false, showCharBooks: false,
        groups: [{ id: 'g-a', name: '测试分组甲' }, { id: 'g-b', name: '测试分组乙' }],
        assignments: { '甲组书一': 'g-a', '乙组书一': 'g-b' },
        globalHiddenGroupIds: ['g-b'], editorHiddenGroupIds: [],
    },
};

for (const viewport of [VIEWPORTS.mobile, VIEWPORTS.desktop]) {
    test(`${viewport.name}: exclusion chips read checked as shown and struck through as excluded`, async () => {
        await withHost(viewport, excludeSeed, async (cdp) => {
            await cdp.clickSelector('#wbo-wi-merged-btn');
            await cdp.clickSelector('[data-qhub-tab="exclude"]');
            const chip = (gid) => cdp.evalFn((id) => {
                const btn = document.querySelector(`[data-qe-target="globalHiddenGroupIds"][data-qe-gid="${id}"]`);
                const name = btn.querySelector('.wbo-exclude-chip-name');
                return {
                    checked: Boolean(btn.querySelector('.wbo-local-cat-mark i')),
                    struck: getComputedStyle(name).textDecorationLine.includes('line-through'),
                    state: btn.querySelector('.wbo-exclude-chip-state')?.textContent || '',
                    pressed: btn.getAttribute('aria-pressed'),
                    label: btn.getAttribute('aria-label'),
                };
            }, gid);
            const saved = () => cdp.evalFn(() => [...SillyTavern.getContext().extensionSettings.worldbook_organizer.globalHiddenGroupIds].sort());
            assert.deepEqual(await chip('g-a'), { checked: true, struck: false, state: '', pressed: 'true', label: '测试分组甲：显示中，点击排除' });
            assert.deepEqual(await chip('g-b'), { checked: false, struck: true, state: '已排除', pressed: 'false', label: '测试分组乙：已排除，点击恢复显示' });
            assert.deepEqual(await saved(), ['g-b'], 'old saved setting loads unchanged');
            await cdp.clickSelector('[data-qe-target="globalHiddenGroupIds"][data-qe-gid="g-a"]');
            await pause(150);
            assert.equal((await chip('g-a')).struck, true);
            assert.deepEqual(await saved(), ['g-a', 'g-b']);
            await cdp.clickSelector('[data-qe-preset="clear"][data-qe-scope="globalHiddenGroupIds"]');
            await pause(150);
            assert.deepEqual(await saved(), [], '全部显示 clears exclusions');
            assert.equal((await chip('g-b')).checked, true);
            const count = await cdp.evalFn(() => document.querySelector('[data-qe-count="globalHiddenGroupIds"]').textContent);
            assert.equal(count, '显示 4 组 · 排除 0 组');
        }, viewport.mobile ? 'mobile=1' : '');
    });
}

for (const focused of [false, true]) {
    test(`390x844: outside tap closes the book picker but keeps the unpinned drawer open (search ${focused ? 'focused' : 'idle'})`, async () => {
        await withHost(VIEWPORTS.mobile, foldSeed, async (cdp) => {
            const state = () => cdp.evalFn(() => ({
                picker: Boolean(document.getElementById('wbo-mobile-picker-overlay')),
                drawerOpen: document.getElementById('WorldInfo').classList.contains('openDrawer'),
                pinned: Boolean(document.getElementById('WI_panel_pin')?.checked),
            }));
            const tap = async (x, y) => {
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
                await pause(150);
            };
            for (let round = 0; round < 5; round += 1) {
                await cdp.clickSelector('#wbo-mobile-editor-trigger');
                if (focused) await cdp.evalFn(() => document.getElementById('wbo-mp-search').focus());
                assert.deepEqual(await state(), { picker: true, drawerOpen: true, pinned: false });
                await tap(195, 830);
                assert.deepEqual(await state(), { picker: false, drawerOpen: true, pinned: false }, `round ${round + 1}`);
                await pause(650);
            }
            await tap(195, 830);
            assert.equal((await state()).drawerOpen, false, 'a plain outside tap still closes the unpinned drawer');
        }, 'mobile=1');
    });
}

const IPAD_PORTRAIT = [
    { name: '768x1024', width: 768, height: 1024, deviceScaleFactor: 2, mobile: true },
    { name: '820x1180', width: 820, height: 1180, deviceScaleFactor: 2, mobile: true },
];

for (const viewport of IPAD_PORTRAIT) {
    test(`${viewport.name} iPad portrait: windows and picker use the tall screen and stay inside it`, async () => {
        await withHost(viewport, tabletSeed, async (cdp) => {
            await cdp.clickSelector('#wbo-mobile-editor-trigger');
            const picker = await cdp.evalFn(() => {
                const r = document.querySelector('.wbo-mp-popover').getBoundingClientRect();
                return { height: r.height, left: r.left, right: r.right, bottom: r.bottom, vw: innerWidth, vh: innerHeight };
            });
            assert.ok(picker.height > 430, `picker uses more height: ${JSON.stringify(picker)}`);
            assert.ok(picker.left >= 0 && picker.right <= picker.vw && picker.bottom <= picker.vh, JSON.stringify(picker));
            await cdp.evalFn(() => document.querySelector('.wbo-mp-backdrop')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
            await pause(100);
            await openManager(cdp);
            const mgr = await cdp.evalFn(() => {
                const r = document.querySelector('.wbo-manager-modal').getBoundingClientRect();
                return { height: r.height, top: r.top, bottom: r.bottom, vh: innerHeight };
            });
            assert.ok(mgr.height > 0.8 * mgr.vh, `manager fills the portrait screen: ${JSON.stringify(mgr)}`);
            assert.ok(mgr.top >= 0 && mgr.bottom <= mgr.vh, JSON.stringify(mgr));
            await cdp.clickSelector('[data-action="open-combos-modal"]');
            await cdp.clickSelector('#wbo-cmb-free-new-btn');
            const combo = await footerOrder(cdp, '#wbo-cmb-save-apply-btn', '#wbo-cmb-cancel-edit-btn');
            assert.deepEqual(combo, { confirmLeft: true, confirmHit: true, cancelHit: true, inView: true }, JSON.stringify(combo));
        }, 'mobile=1');
    });
}

test('1280x860 desktop: window heights keep their original caps', async () => {
    await withHost(VIEWPORTS.desktop, comboSeed, async (cdp) => {
        await openManager(cdp);
        const h = await cdp.evalFn(() => document.querySelector('.wbo-manager-modal').style.getPropertyValue('--wbo-stable-h'));
        assert.equal(h, `${Math.round(Math.min(860 * 0.84, 720))}px`);
    });
});

for (const viewport of [VIEWPORTS.mobile, VIEWPORTS.desktop]) {
    test(`${viewport.name}: combo book list fills the step and keeps status and footer reachable`, async () => {
        await withHost(viewport, comboSeed, async (cdp) => {
            await openManager(cdp);
            await cdp.clickSelector('[data-action="open-combos-modal"]');
            await cdp.clickSelector('#wbo-cmb-free-new-btn');
            const measure = () => cdp.evalFn(() => {
                const list = document.querySelector('#wbo-cmb-pick-list');
                const scroll = list.closest('.wbo-step-scroll');
                const footer = document.querySelector('#wbo-cmb-step-edit .wbo-modal-footer');
                const status = document.querySelector('#wbo-cmb-edit-status');
                const l = list.getBoundingClientRect();
                const s = scroll.getBoundingClientRect();
                const f = footer.getBoundingClientRect();
                return {
                    listScrolls: list.scrollHeight > list.clientHeight,
                    blankBelow: s.bottom - Math.max(l.bottom, status.getBoundingClientRect().bottom),
                    statusVisible: status.getBoundingClientRect().bottom <= f.top + 1,
                    footerInView: f.bottom <= innerHeight + 1,
                };
            });
            const long = await measure();
            assert.ok(long.listScrolls, 'long list scrolls inside itself');
            assert.ok(long.blankBelow < 40, `no large blank under the list: ${JSON.stringify(long)}`);
            assert.ok(long.statusVisible && long.footerInView, JSON.stringify(long));
            await cdp.evalFn(() => {
                const input = document.querySelector('#wbo-cmb-book-filter');
                input.value = '普通测试书1';
                input.dispatchEvent(new Event('input', { bubbles: true }));
            });
            await pause(250);
            const short = await measure();
            assert.ok(short.statusVisible && short.footerInView, JSON.stringify(short));
            await cdp.evalFn(() => { document.querySelector('#wbo-cmb-save-only-btn').click(); });
            await pause(150);
            const status = await cdp.evalFn(() => {
                const s = document.querySelector('#wbo-cmb-edit-status');
                const r = s.getBoundingClientRect();
                const f = document.querySelector('#wbo-cmb-step-edit .wbo-modal-footer').getBoundingClientRect();
                return { text: s.textContent.trim(), visible: r.height > 0 && r.bottom <= f.top + 1 };
            });
            assert.ok(status.text.length > 0 && status.visible, `validation message visible: ${JSON.stringify(status)}`);
        }, viewport.mobile ? 'mobile=1' : '');
    });
}
