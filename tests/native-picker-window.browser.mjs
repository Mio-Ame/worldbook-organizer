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

const favorite = '收藏测试书';
const globalBook = '全局测试书';
const other = '普通测试书';
const characterBook = '角色测试书';
const seed = (extraBooks = []) => createDefaultSeed({
    characters: [{ avatar: 'example.png', name: '测试角色', data: { extensions: { world: characterBook } } }],
    worldbooks: Object.fromEntries([favorite, globalBook, other, characterBook, ...extraBooks].map((name) => [name, { entries: {} }])),
    selected_world_info: [globalBook],
    pluginSettings: {
        showCharBooks: true, hideCharBooksByDefault: false, autoScanNewCharacters: false,
        charGroupCollapsed: false, activeFilterGroupId: '__all__',
        groups: [{ id: 'g-a', name: '测试分组甲' }, { id: 'g-b', name: '测试分组乙' }],
        assignments: { [favorite]: 'g-a', [globalBook]: 'g-b', [other]: 'g-b' },
        pinnedBooks: [favorite], globalHiddenGroupIds: [], editorHiddenGroupIds: [],
    },
});

async function withHost(viewport, verify, extraBooks) {
    const server = createMockStServer();
    const baseUrl = await server.start();
    let cdp;
    try {
        cdp = await launchEdgeCdp();
        await resetAndBoot(cdp, baseUrl, { seed: seed(extraBooks), viewport });
        await verify(cdp);
        assert.deepEqual(cdp.getErrors().runtimeErrors, []);
    } finally {
        await cdp?.close();
        await server.stop();
    }
}

test('desktop native global picker keeps its search, filters by group and opens on 收藏', async () => {
    await withHost(VIEWPORTS.desktop, async (cdp) => {
        await cdp.clickSelector('#WIMultiSelector .select2-container');
        await waitForCondition(cdp, () => !!document.querySelector('.wbo-global-dd-bar'));
        const activePill = () => cdp.evalFn(() => document.querySelector('.wbo-global-dd-bar .is-active')?.textContent);
        const visible = () => cdp.evalFn(() => [...document.querySelectorAll('.select2-dropdown [data-wbo-world]')]
            .filter((row) => row.getBoundingClientRect().height > 0).map((row) => row.dataset.wboWorld));
        assert.equal(await activePill(), '收藏 1');
        assert.deepEqual(await visible(), [favorite]);
        await cdp.evalFn(() => { document.querySelector('.select2-dropdown').style.width = '640px'; });
        await waitForCondition(cdp, () => document.querySelector('.wbo-global-dd-bar .wbo-dd-expand-btn').hidden);
        await cdp.clickSelector('.wbo-global-dd-bar [data-wbo-pill="__all__"]');
        assert.equal(await cdp.evalFn(() => document.querySelector('.select2-results__options').firstElementChild.textContent), '收藏');
        assert.equal((await visible())[0], favorite);
        await cdp.clickSelector('.wbo-global-dd-bar [data-wbo-pill="g-b"]');
        assert.deepEqual((await visible()).sort(), [globalBook, other].sort());
        await cdp.typeInto('.select2-dropdown .select2-search__field', '普通');
        assert.deepEqual(await visible(), [other]);
        await cdp.evalFn(() => { window.jQuery('#world_info').select2('close').select2('open'); });
        await waitForCondition(cdp, () => document.querySelector('.wbo-global-dd-bar .is-active')?.textContent === '收藏 1');
        assert.deepEqual(await visible(), [favorite]);
    });
});

test('mobile global dropdown handles direct option rows without native search', async () => {
    await withHost(VIEWPORTS.mobile, async (cdp) => {
        await cdp.evalFn(() => {
            window.__ST_TEST_HELPERS__.openGrGlobalPopover();
            const pop = document.getElementById('gr-global-dropdown-container');
            const rows = [...pop.querySelectorAll('.gr-option')];
            for (const row of rows) {
                const badge = document.createElement('span');
                badge.textContent = '原生标签';
                row.appendChild(badge);
            }
            pop.replaceChildren(...rows);
        });
        const pop = '#gr-global-dropdown-container';
        const bar = `${pop} .wbo-pop-filter-bar`;
        await waitForCondition(cdp, () => !!document.querySelector('#gr-global-dropdown-container .wbo-pop-search'));
        const activePill = () => cdp.evalFn(() => document.querySelector('#gr-global-dropdown-container .wbo-pop-filter-bar .is-active')?.textContent);
        const visible = () => cdp.evalFn(() => [...document.querySelectorAll('#gr-global-dropdown-container .gr-option')]
            .filter((row) => row.getBoundingClientRect().height > 0)
            .map((row) => row.querySelector('[data-pin-world]').getAttribute('data-pin-world')));
        assert.equal(await activePill(), '收藏 1');
        assert.deepEqual(await visible(), [favorite]);
        assert.equal(await cdp.evalFn(() => document.querySelector('.wbo-pop-search').getAttribute('spellcheck')), 'false');
        await cdp.clickSelector(`${bar} [data-wbo-pill="__all__"]`);
        assert.match(await cdp.evalFn(() => document.querySelector('#gr-global-dropdown-container .wbo-dd-group-head').textContent), /收藏/);
        assert.equal((await visible())[0], favorite);
        await cdp.clickSelector(`${bar} [data-wbo-pill="g-b"]`);
        await cdp.typeInto(`${pop} .wbo-pop-search`, '普通');
        await waitForCondition(cdp, () => document.querySelector('.gr-option.wbo-pop-search-hidden'));
        assert.deepEqual(await visible(), [other]);
        await cdp.evalFn(() => {
            const pop = document.getElementById('gr-global-dropdown-container');
            pop.style.width = '185px';
            pop.style.minWidth = '0';
        });
        await waitForCondition(cdp, () => !document.querySelector('.wbo-pop-filter-bar .wbo-dd-expand-btn').hidden);
        await cdp.clickSelector(`${bar} .wbo-dd-expand-btn`);
        await cdp.evalFn(() => { document.getElementById('gr-global-dropdown-container').style.width = '500px'; });
        await waitForCondition(cdp, () => document.querySelector('.wbo-pop-filter-bar .wbo-dd-expand-btn').hidden);
    });
});

test('active global books appear after character books in the manager and return to their group when disabled', async () => {
    await withHost(VIEWPORTS.desktop, async (cdp) => {
        await openManager(cdp);
        const groups = await cdp.evalFn(() => [...document.querySelectorAll('#wbo-mgr-groups-list > .wbo-group')].map((group) => group.dataset.groupId));
        assert.deepEqual(groups.slice(0, 3), ['__char__', '__active_globals__', '__pinned__']);
        const row = `.wbo-book-item[data-book="${globalBook}"]`;
        assert.equal(await cdp.evalFn((selector) => document.querySelectorAll(selector).length, row), 1);
        await cdp.clickSelector(`[data-group-id="__active_globals__"] ${row} [data-action="toggle-global"]`);
        await waitForCondition(cdp, () => !document.querySelector('.wbo-group[data-group-id="__active_globals__"]'));
        assert.ok(await cdp.evalFn((selector) => document.querySelector(selector)?.closest('.wbo-group')?.dataset.groupId === 'g-b', row));
    });
});

test('the native editor moves its 当前编辑 badge when the selected book changes', async () => {
    await withHost(VIEWPORTS.desktop, async (cdp) => {
        const choose = (name) => cdp.evalFn((nextName) => {
            const select = document.getElementById('world_editor_select');
            const option = [...select.options].find((item) => item.textContent === nextName);
            window.jQuery(select).val(option.value).trigger('change');
        }, name);
        await choose(favorite);
        await cdp.evalFn(() => { window.jQuery('#world_editor_select').select2('open'); });
        const badges = () => cdp.evalFn(() => [...document.querySelectorAll('.select2-dropdown [data-wbo-editing-badge]')]
            .map((item) => item.closest('[data-wbo-world]').dataset.wboWorld));
        assert.deepEqual(await badges(), [favorite]);
        await choose(other);
        await waitForCondition(cdp, () => document.querySelector('.select2-dropdown [data-wbo-editing-badge]')?.closest('[data-wbo-world]')?.dataset.wboWorld === '普通测试书');
        assert.deepEqual(await badges(), [other]);
    });
});

test('selecting a book in a long editor list restores its original visible position', async () => {
    const books = Array.from({ length: 38 }, (_, i) => `位置测试书 ${String(i + 1).padStart(2, '0')}`);
    const selected = books[20];
    for (const viewport of [VIEWPORTS.desktop, VIEWPORTS.mobile]) {
        await withHost(viewport, async (cdp) => {
            const open = viewport.mobile
                ? () => cdp.clickSelector('#wbo-mobile-editor-trigger')
                : () => cdp.evalFn(() => { window.jQuery('#world_editor_select').select2('open'); });
            const list = viewport.mobile ? '#wbo-mp-list' : '.select2-dropdown .select2-results__options';
            const row = viewport.mobile ? `[data-mp-world="${selected}"]` : `[data-wbo-world="${selected}"]`;
            const readOffset = (move) => cdp.evalFn((listSelector, rowSelector, shouldMove) => {
                const listEl = document.querySelector(listSelector);
                const rowEl = listEl?.querySelector(rowSelector);
                if (!rowEl) return null;
                let scrollHost = rowEl.parentElement;
                while (scrollHost !== listEl && !(getComputedStyle(scrollHost).overflowY === 'auto' && scrollHost.scrollHeight > scrollHost.clientHeight)) {
                    scrollHost = scrollHost.parentElement;
                }
                if (shouldMove) {
                    if (scrollHost !== listEl) listEl.scrollTop += scrollHost.getBoundingClientRect().top - listEl.getBoundingClientRect().top - 20;
                    scrollHost.scrollTop += rowEl.getBoundingClientRect().top - scrollHost.getBoundingClientRect().top - 100;
                }
                return rowEl.getBoundingClientRect().top - listEl.getBoundingClientRect().top;
            }, list, row, move);
            await open();
            const offset = await readOffset(true);
            assert.ok(typeof offset === 'number' && offset >= 90 && offset <= 155, `${viewport.name} available offset ${offset}`);
            await cdp.clickSelector(`${list} ${row}`, { scroll: false });
            const selectedName = await cdp.evalFn(() => document.getElementById('world_editor_select').selectedOptions[0]?.textContent);
            assert.equal(selectedName, selected);
            await open();
            await cdp.evalFn(() => new Promise((resolve) => setTimeout(resolve, 260)));
            const restored = await readOffset(false);
            const details = await cdp.evalFn((listSelector, rowSelector) => {
                const listEl = document.querySelector(listSelector);
                const rowEl = listEl?.querySelector(rowSelector);
                return [listEl?.scrollTop, listEl?.clientHeight, listEl?.scrollHeight, rowEl?.closest('.wbo-mp-sec')?.className];
            }, list, row);
            assert.ok(typeof restored === 'number' && Math.abs(restored - offset) <= 2, `${viewport.name} restored to ${restored} from ${offset} (${details.join(', ')})`);
        }, books);
    }
});

test('mobile manager can be resized and moved by touch and returned to full screen', async () => {
    await withHost(VIEWPORTS.mobile, async (cdp) => {
        await openManager(cdp);
        const panel = '.wbo-manager-modal';
        const rect = (selector) => cdp.evalFn((target) => document.querySelector(target).getBoundingClientRect().toJSON(), selector);
        const drag = async (selector, dx, dy) => {
            const box = await rect(selector);
            assert.ok(box.width && box.height);
            const x = Math.round(box.left + box.width / 2);
            const y = Math.round(box.top + box.height / 2);
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
            for (let step = 1; step <= 5; step++) {
                await cdp.send('Input.dispatchTouchEvent', {
                    type: 'touchMove', touchPoints: [{ x: x + dx * step / 5, y: y + dy * step / 5, id: 1 }],
                });
            }
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        };
        const full = await rect(panel);
        await drag(`${panel} .wbo-resize-se`, -55, -240);
        const smaller = await rect(panel);
        assert.ok(smaller.width < full.width && smaller.height < full.height);
        await drag(`${panel} .wbo-modal-title`, 20, 75);
        const moved = await rect(panel);
        assert.ok(moved.left > smaller.left && moved.top > smaller.top);
        await cdp.resizeViewport(390, 450);
        await cdp.resizeViewport(390, 844);
        assert.deepEqual(await rect(panel), moved);
        await cdp.clickSelector('[data-wbo-fullscreen-btn]');
        assert.equal((await rect(panel)).height, full.height);
    });
});
