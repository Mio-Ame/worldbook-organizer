import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const suite = process.env.WBO_E2E_SUITE;
if (!suite) throw new Error('Set WBO_E2E_SUITE to the retained browser regression suite');
// Read-only upstream asset snapshot, kept outside the extension and host installation.
const assets = process.env.WBO_NATIVE_DRAG_ASSETS || resolve(tmpdir(), 'wbo-native-drag-assets');
const jquerySource = readFileSync(resolve(assets, 'lib-jquery-3.5.1.min.js'), 'utf8');
const sortableSource = readFileSync(resolve(assets, 'lib-jquery-ui.min.js'), 'utf8');
const touchSource = readFileSync(resolve(assets, 'lib-jquery.ui.touch-punch.min.js'), 'utf8');
assert.match(sortableSource, /jQuery UI - v1\.13\.2/);
const load = (name) => import(pathToFileURL(resolve(suite, 'lib', name)).href);
const { createMockStServer } = await load('mock-server.mjs');
const { VIEWPORTS, launchEdgeCdp } = await load('cdp.mjs');
const { createDefaultSeed, makeBook, makeEntry } = await import('./entry-groups-fixtures.mjs');
const { getServerState, resetAndBoot, waitForCondition } = await load('assert-helpers.mjs');

const world = '原生拖动测试书';
const seed = () => createDefaultSeed({
    characters: [], selected_world_info: [],
    worldbooks: { [world]: makeBook(Array.from({ length: 6 }, (_, uid) => makeEntry(uid, {
        comment: `拖动条目 ${uid}`, displayIndex: uid, order: 300 + uid,
    }))) },
    pluginSettings: { autoScanNewCharacters: false },
    extraPluginSettingsKey: { worldbook_entry_groups: { books: { [world]: {
        groups: [{ id: 'a', name: '测试甲组' }, { id: 'b', name: '测试乙组' }],
        assignments: { 0: 'a', 1: 'b', 2: 'a', 3: 'b', 4: 'a', 5: 'b' },
    } } } },
});
const settle = (cdp) => cdp.evalFn(() => new Promise((resolve) => setTimeout(resolve, 100)));

async function withNative(device, run) {
    const server = createMockStServer();
    const baseUrl = await server.start();
    let cdp;
    try {
        cdp = await launchEdgeCdp();
        await resetAndBoot(cdp, baseUrl, { viewport: VIEWPORTS[device], seed: seed() });
        await cdp.evalFn((name) => {
            document.getElementById('WorldInfo').style.display = 'block';
            const pager = document.createElement('div');
            pager.id = 'world_info_pagination';
            pager.style.cssText = 'position:fixed;top:45px;left:12px;z-index:10';
            pager.innerHTML = '<select style="height:28px"><option>25</option></select>';
            document.getElementById('world_popup_entries_list').before(pager);
            const style = document.createElement('style');
            style.textContent = `body{min-height:1600px} #world_popup_entries_list{position:fixed;inset:100px 12px 12px;height:auto;max-height:none;overflow:auto}
                #world_popup_entries_list>.world_entry{min-height:50px;box-sizing:border-box}
                .drag-handle{display:inline-flex;align-items:center;justify-content:center;width:24px;height:28px;cursor:grab;touch-action:none}`;
            document.head.append(style);
            const select = document.getElementById('world_editor_select');
            select.value = [...select.options].find((option) => option.textContent === name).value;
            select.dispatchEvent(new Event('change', { bubbles: true }));
        }, world);
        await waitForCondition(cdp, () => !!document.querySelector('#weg-native-group-enabled:enabled'));
        assert.equal((await cdp.clickSelector('#weg-native-group-enabled')).hit, true, 'native grouping switch must be reachable before scrolling the page');
        if (await cdp.evalFn(() => !!document.querySelector('[data-weg-native-entry-choice="use"]'))) {
            await cdp.clickSelector('[data-weg-native-entry-choice="use"]');
        }
        await waitForCondition(cdp, () => document.querySelectorAll('.weg-native-group-heading').length === 2);
        await cdp.evalFn(() => window.scrollTo(0, 300));
        await cdp.evalFn((jqCode, uiCode, touchCode, mobile) => {
            const mockJquery = window.jQuery;
            const mockDollar = window.$;
            (0, eval)(jqCode);
            (0, eval)(uiCode);
            if (mobile) (0, eval)(touchCode);
            const real = window.jQuery.noConflict(true);
            window.jQuery = mockJquery;
            window.$ = mockDollar;
            window.__nativeRealJquery = real;
            const list = document.getElementById('world_popup_entries_list');
            for (const row of list.querySelectorAll('.world_entry[uid]')) {
                const handle = document.createElement('span');
                handle.className = 'drag-handle';
                handle.textContent = '↕';
                row.append(handle);
            }
            window.__hostSortStarts = 0;
            window.__hostSortStops = 0;
            // Same items/handle contract as the upstream world-info sortable.
            real(list).sortable({ items: '.world_entry', handle: '.drag-handle', delay: 0,
                start() { window.__hostSortStarts++; }, stop() { window.__hostSortStops++; } });
        }, jquerySource, sortableSource, touchSource, device === 'mobile');
        await settle(cdp);
        await run(cdp, baseUrl);
        assert.deepEqual(cdp.getErrors().runtimeErrors, []);
    } finally {
        await cdp?.close();
        await server.stop();
    }
}

async function point(cdp, selector, dy = null) {
    return cdp.evalFn((sel, offset) => {
        const rect = document.querySelector(sel).getBoundingClientRect();
        return { x: Math.round(rect.left + rect.width / 2), y: Math.round(offset === null ? rect.top + rect.height / 2 : rect.top + offset) };
    }, selector, dy);
}

async function snapshot(cdp) {
    return cdp.evalFn(() => {
        const list = document.getElementById('world_popup_entries_list');
        return {
            page: scrollY, scroll: list.scrollTop, top: list.getBoundingClientRect().top,
            rows: [...list.querySelectorAll('.world_entry[uid]:not(.ui-sortable-helper)')].map((row) => ({
                uid: row.getAttribute('uid'), top: row.getBoundingClientRect().top, height: row.getBoundingClientRect().height,
                order: getComputedStyle(row).order,
            })),
            placeholders: [...list.querySelectorAll('.ui-sortable-placeholder')].map((row) => ({
                uid: row.getAttribute('uid'), top: row.getBoundingClientRect().top, height: row.getBoundingClientRect().height,
                order: getComputedStyle(row).order,
            })), starts: window.__hostSortStarts, stops: window.__hostSortStops,
        };
    });
}

async function mouseStart(cdp, p, dx = 10, dy = 5) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x + dx, y: p.y + dy, button: 'left' });
    await settle(cdp);
}
const mouseEnd = (cdp, p) => cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p, button: 'left', clickCount: 1 });
const visualOrder = (cdp) => cdp.evalFn(() => [...document.querySelectorAll('#world_popup_entries_list > .world_entry[uid]')]
    .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top).map((row) => Number(row.getAttribute('uid'))));

async function drag(cdp, device, from, to) {
    if (device !== 'mobile') return cdp.mouseDrag(from.x, from.y, to.x, to.y);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...from, id: 1 }] });
    for (let i = 1; i <= 8; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{
        x: Math.round(from.x + (to.x - from.x) * i / 8), y: Math.round(from.y + (to.y - from.y) * i / 8), id: 1,
    }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

test('native entry drag keeps other groups stationary while held, not merely after release', async () => {
    await withNative('desktop', async (cdp) => {
        const before = await snapshot(cdp);
        const from = await point(cdp, '.world_entry[uid="1"] .drag-handle');
        await mouseStart(cdp, from);
        const held = await snapshot(cdp);
        await mouseEnd(cdp, { x: from.x + 10, y: from.y + 5 });
        const after = await snapshot(cdp);
        for (const uid of ['0', '2', '4']) {
            const initial = before.rows.find((row) => row.uid === uid);
            const current = held.rows.find((row) => row.uid === uid);
            assert.ok(Math.abs(current.top - initial.top) <= 1, `another group moved during drag: ${JSON.stringify({ before, held, after })}`);
        }
        assert.equal(held.page, before.page);
        assert.equal(held.scroll, before.scroll);
        assert.equal(held.top, before.top);
    });
});

for (const device of ['desktop', 'mobile']) {
    test(`${device}: native entry drop reports row or group-tail target exactly once`, async () => {
        await withNative(device, async (cdp) => {
            await cdp.evalFn(async () => {
                const view = await import('/scripts/extensions/third-party/worldbook-organizer/src/entry-groups/native-view.js');
                window.nativeMoves = [];
                view.syncNativeEntryGroups({ undoLabel: () => '', moveEntry: (...args) => window.nativeMoves.push(args) });
            });
            await drag(cdp, device, await point(cdp, '.world_entry[uid="2"] .drag-handle'), await point(cdp, '.world_entry[uid="3"]', 45));
            assert.deepEqual(await cdp.evalFn(() => window.nativeMoves), [[world, '2', 'b', '3', true]]);
            await drag(cdp, device, await point(cdp, '.world_entry[uid="2"] .drag-handle'), await point(cdp, '[data-group-id="b"] .weg-native-group-disclosure'));
            assert.deepEqual(await cdp.evalFn(() => window.nativeMoves), [[world, '2', 'b', '3', true], [world, '2', 'b', null, true]]);
            await drag(cdp, device, await point(cdp, '.world_entry[uid="4"] .drag-handle'), await point(cdp, '.world_entry[uid="2"]', 4));
            assert.deepEqual(await cdp.evalFn(() => window.nativeMoves), [
                [world, '2', 'b', '3', true], [world, '2', 'b', null, true], [world, '4', 'a', '2', false],
            ], 'same-group reorder uses the same row-target contract');
            assert.equal(await cdp.evalFn(() => window.__hostSortStarts), 0);
        });
    });

    test(`${device}: group drag accepts a row inside the target group without starting host sorting`, async () => {
        await withNative(device, async (cdp, baseUrl) => {
            const before = await getServerState(baseUrl);
            const from = await point(cdp, '[data-group-id="b"] [data-weg-native-group-drag]');
            const to = await point(cdp, '.world_entry[uid="2"] .we-title');
            await drag(cdp, device, from, to);
            await settle(cdp);
            const config = await cdp.evalFn((name) => SillyTavern.getContext().extensionSettings.worldbook_entry_groups.books[name], world);
            assert.equal(config.nativeGroupOrder?.[0], 'b', 'a whole target group is a drop target, not just its narrow heading');
            assert.equal(await cdp.evalFn(() => window.__hostSortStarts), 0);
            assert.deepEqual((await getServerState(baseUrl)).worldbooks, before.worldbooks);
        });
    });

    test(`${device}: native entry can move across groups, preserve insertion order and undo`, async () => {
        await withNative(device, async (cdp, baseUrl) => {
            const before = await getServerState(baseUrl);
            const from = await point(cdp, '.world_entry[uid="2"] .drag-handle');
            const to = await point(cdp, '.world_entry[uid="3"]', 45);
            await drag(cdp, device, from, to);
            await waitForCondition(cdp, () => SillyTavern.getContext().extensionSettings.worldbook_entry_groups.books['原生拖动测试书'].assignments['2'] === 'b');
            const state = await getServerState(baseUrl);
            const entries = state.worldbooks[world].entries;
            assert.ok(entries['3'].displayIndex < entries['2'].displayIndex && entries['2'].displayIndex < entries['5'].displayIndex,
                'drop after a member preserves its position within the destination group');
            await settle(cdp);
            assert.deepEqual((await visualOrder(cdp)).filter((uid) => [1, 2, 3, 5].includes(uid)), [1, 3, 2, 5], 'successful save must immediately update visible destination order without a host rerender');
            for (const uid of Object.keys(entries)) assert.equal(entries[uid].order, before.worldbooks[world].entries[uid].order);
            assert.equal(await cdp.evalFn(() => window.__hostSortStarts), 0, 'grouped pointer drag must not also run the host DOM-order writer');
            await cdp.clickSelector('[data-group-id="b"] .weg-native-group-undo');
            await waitForCondition(cdp, () => SillyTavern.getContext().extensionSettings.worldbook_entry_groups.books['原生拖动测试书'].assignments['2'] === 'a');
            assert.deepEqual((await getServerState(baseUrl)).worldbooks[world], before.worldbooks[world]);
            await settle(cdp);
            assert.deepEqual(await visualOrder(cdp), [0, 2, 4, 1, 3, 5], 'undo must immediately restore the visible order as well as the saved data');
        });
    });

    test(`${device}: native entry can reorder within its group and preserve unrelated order`, async () => {
        await withNative(device, async (cdp, baseUrl) => {
            const before = await getServerState(baseUrl);
            await drag(cdp, device, await point(cdp, '.world_entry[uid="4"] .drag-handle'), await point(cdp, '.world_entry[uid="2"]', 4));
            await waitForCondition(cdp, async () => {
                const data = await fetch('/__test/state').then((response) => response.json());
                const entries = data.worldbooks['原生拖动测试书'].entries;
                return entries['4'].displayIndex < entries['2'].displayIndex;
            });
            const state = await getServerState(baseUrl);
            assert.deepEqual(state.extension_settings.worldbook_entry_groups.books[world].assignments,
                before.extension_settings.worldbook_entry_groups.books[world].assignments);
            const entries = Object.values(state.worldbooks[world].entries).sort((a, b) => a.displayIndex - b.displayIndex);
            assert.deepEqual(entries.filter((entry) => [0, 2, 4].includes(entry.uid)).map((entry) => entry.uid), [0, 4, 2]);
            assert.deepEqual(entries.filter((entry) => [1, 3, 5].includes(entry.uid)).map((entry) => entry.uid), [1, 3, 5]);
            await settle(cdp);
            assert.deepEqual((await visualOrder(cdp)).filter((uid) => [0, 2, 4].includes(uid)), [0, 4, 2], 'same-group drag must visibly move the row after saving');
            for (const entry of entries) assert.equal(entry.order, before.worldbooks[world].entries[entry.uid].order);
            await cdp.clickSelector('[data-group-id="a"] .weg-native-group-undo');
            await waitForCondition(cdp, async () => {
                const data = await fetch('/__test/state').then((response) => response.json());
                return data.worldbooks['原生拖动测试书'].entries['4'].displayIndex === 4;
            });
            assert.deepEqual((await getServerState(baseUrl)).worldbooks[world], before.worldbooks[world]);
            await settle(cdp);
            assert.deepEqual(await visualOrder(cdp), [0, 2, 4, 1, 3, 5], 'same-group undo must visibly restore the old position');
        });
    });
}

test('cancel and disable clear drag decoration; disabled native grouping leaves host sortable usable', async () => {
    await withNative('desktop', async (cdp, baseUrl) => {
        const before = await getServerState(baseUrl);
        await cdp.evalFn(async () => {
            window.nativeView = await import('/scripts/extensions/third-party/worldbook-organizer/src/entry-groups/native-view.js');
            window.nativeMoves = [];
            nativeView.syncNativeEntryGroups({ undoLabel: () => '', moveEntry: (...args) => nativeMoves.push(args) });
        });
        const from = await point(cdp, '.world_entry[uid="4"] .drag-handle');
        const to = await point(cdp, '.world_entry[uid="2"]', 4);
        await mouseStart(cdp, from, to.x - from.x, to.y - from.y);
        await cdp.evalFn(() => document.querySelector('.world_entry[uid="4"]').dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 1 })));
        await mouseEnd(cdp, to);
        assert.deepEqual(await cdp.evalFn(() => nativeMoves), []);
        assert.equal(await cdp.evalFn(() => document.querySelectorAll('.weg-native-group-dragging, .weg-native-drop-before, .weg-native-drop-after').length), 0);
        await mouseStart(cdp, from, to.x - from.x, to.y - from.y);
        await cdp.evalFn(() => nativeView.removeNativeEntryGroups());
        await mouseEnd(cdp, to);
        assert.deepEqual(await cdp.evalFn(() => nativeMoves), []);
        assert.equal(await cdp.evalFn(() => document.querySelectorAll('.weg-native-group-dragging, .weg-native-drop-before, .weg-native-drop-after, .weg-native-group-heading').length), 0);
        const nativeFrom = await point(cdp, '.world_entry[uid="1"] .drag-handle');
        await mouseStart(cdp, nativeFrom);
        const held = await snapshot(cdp);
        assert.equal(held.starts, 1, 'disabled grouping must release the native sortable handle');
        assert.equal(held.placeholders.length, 1);
        await mouseEnd(cdp, { x: nativeFrom.x + 10, y: nativeFrom.y + 5 });
        assert.deepEqual((await getServerState(baseUrl)).worldbooks, before.worldbooks);
    });
});

test('native group actions explain partial, paused and empty states with counts and exact undo label', async () => {
    await withNative('mobile', async (cdp) => {
        const controls = () => cdp.evalFn(() => {
            const heading = document.querySelector('[data-group-id="a"].weg-native-group-heading');
            return { action: heading.querySelector('[data-weg-native-group-toggle]')?.textContent,
                count: heading.querySelector('.weg-native-group-count')?.textContent,
                undo: heading.querySelector('.weg-native-group-undo').getAttribute('aria-label') };
        });
        await cdp.evalFn(async () => {
            window.nativeView = await import('/scripts/extensions/third-party/worldbook-organizer/src/entry-groups/native-view.js');
            window.nativeTextActions = { undoLabel: () => '撤回切换' };
            document.querySelector('.world_entry[uid="2"]').classList.add('disabledWIEntry');
            nativeView.syncNativeEntryGroups(nativeTextActions);
        });
        assert.deepEqual(await controls(), { action: '关闭本组', count: '已开 2/3 条', undo: '撤回切换' });
        await cdp.evalFn(() => {
            for (const uid of ['0', '4']) document.querySelector(`.world_entry[uid="${uid}"]`).classList.add('disabledWIEntry');
            nativeView.syncNativeEntryGroups(nativeTextActions);
        });
        assert.deepEqual(await controls(), { action: '开启本组', count: '已开 0/3 条', undo: '撤回切换' });
        await cdp.evalFn(() => {
            SillyTavern.getContext().extensionSettings.worldbook_entry_groups.books['原生拖动测试书'].pausedGroupStates = { a: { 0: false, 2: true, 4: false } };
            nativeView.syncNativeEntryGroups(nativeTextActions);
        });
        assert.deepEqual(await controls(), { action: '恢复本组', count: '已开 0/3 条', undo: '撤回切换' });
    });
});

test('native group overflow keeps backup text out of the toolbar and restores only on explicit action', async () => {
    await withNative('mobile', async (cdp) => {
        await cdp.evalFn(async () => {
            const view = await import('/scripts/extensions/third-party/worldbook-organizer/src/entry-groups/native-view.js');
            window.backupCalls = [];
            view.syncNativeEntryGroups({ undoLabel: () => '撤回上一步',
                backupLabel: () => '恢复操作前状态（测试时间）', restoreBackup: (...args) => backupCalls.push(args) });
        });
        const menu = '.weg-native-group-heading[data-group-id="a"] .weg-native-group-menu';
        assert.equal(await cdp.evalFn((sel) => !!document.querySelector(sel), menu), true, 'group actions need an expandable overflow menu');
        assert.equal(await cdp.evalFn((sel) => document.querySelector(sel).open, menu), false);
        const closed = await cdp.evalFn((sel) => {
            const button = document.querySelector(`${sel} .weg-native-restore-backup`);
            const rect = button.getBoundingClientRect();
            return { visible: button.checkVisibility(), hit: button.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)) };
        }, menu);
        assert.deepEqual(closed, { visible: false, hit: false }, 'closed details content must neither render nor intercept a click');
        assert.deepEqual(await cdp.evalFn(() => backupCalls), []);
        await cdp.clickSelector(`${menu} > summary`);
        assert.equal(await cdp.evalFn((sel) => document.querySelector(sel).open, menu), true);
        assert.equal(await cdp.evalFn((sel) => document.querySelector(`${sel} .weg-native-restore-backup`).title, menu), '恢复操作前状态（测试时间）');
        await cdp.clickSelector(`${menu} > summary`);
        assert.equal(await cdp.evalFn((sel) => document.querySelector(sel).open, menu), false, 'the same ellipsis closes the menu');
        await cdp.clickSelector(`${menu} > summary`);
        await cdp.clickSelector(`${menu} .weg-native-restore-backup`);
        assert.deepEqual(await cdp.evalFn(() => backupCalls), [[world]]);
        assert.equal(await cdp.evalFn((sel) => document.querySelector(sel).open, menu), false);
    });
});

test('native drag waits for success and ignores late results from a disabled grouping session', async () => {
    await withNative('desktop', async (cdp) => {
        await cdp.evalFn(async () => {
            window.nativeView = await import('/scripts/extensions/third-party/worldbook-organizer/src/entry-groups/native-view.js');
            window.delayedActions = { undoLabel: () => '', moveEntry: () => new Promise((resolve) => { window.finishMove = resolve; }) };
            nativeView.syncNativeEntryGroups(delayedActions);
        });
        const before = await visualOrder(cdp);
        await drag(cdp, 'desktop', await point(cdp, '.world_entry[uid="4"] .drag-handle'), await point(cdp, '.world_entry[uid="2"]', 4));
        assert.deepEqual(await visualOrder(cdp), before, 'do not visually commit before the save succeeds');
        await cdp.evalFn(() => finishMove(undefined));
        await settle(cdp);
        assert.deepEqual(await visualOrder(cdp), before, 'a failed save cannot change visible order');
        await drag(cdp, 'desktop', await point(cdp, '.world_entry[uid="4"] .drag-handle'), await point(cdp, '.world_entry[uid="2"]', 4));
        await cdp.evalFn(() => {
            nativeView.removeNativeEntryGroups();
            nativeView.syncNativeEntryGroups(delayedActions);
            finishMove({ orderedUids: ['0', '1', '4', '3', '2', '5'] });
        });
        await settle(cdp);
        assert.deepEqual(await visualOrder(cdp), before, 'a result from the old disabled session must not reorder the newly enabled view');
    });
});

test('native text actions and overflow menu fit 320px and 390px without growing the group heading', async () => {
    await withNative('mobile', async (cdp) => {
        await cdp.evalFn(async () => {
            const view = await import('/scripts/extensions/third-party/worldbook-organizer/src/entry-groups/native-view.js');
            SillyTavern.getContext().extensionSettings.worldbook_entry_groups.books['原生拖动测试书'].groups[0].name = '用于验证窄屏不挤占操作按钮的较长分组标题';
            view.syncNativeEntryGroups({ undoLabel: () => '撤回上一步', backupLabel: () => '恢复操作前状态（2026/11/26 12:34:56）' });
        });
        for (const width of [320, 390]) {
            await cdp.resizeViewport(width, 844);
            await settle(cdp);
            const measure = () => cdp.evalFn(() => {
                const group = document.querySelector('.weg-native-group-heading[data-group-id="a"]');
                const bounds = group.getBoundingClientRect();
                const menu = group.querySelector('.weg-native-group-menu');
                const popup = menu.querySelector('.weg-native-group-menu-items').getBoundingClientRect();
                return { width: innerWidth, height: bounds.height, client: group.clientWidth, scroll: group.scrollWidth,
                    popup: { left: popup.left, right: popup.right },
                    actions: [...group.querySelectorAll('[data-weg-native-group-toggle], .weg-native-group-undo, .weg-native-group-menu > summary')]
                        .map((button) => { const r = button.getBoundingClientRect(); return { left: r.left, right: r.right, height: r.height, client: button.clientWidth, scroll: button.scrollWidth }; }),
                    left: bounds.left, right: bounds.right };
            });
            const before = await measure();
            assert.ok(before.scroll <= before.client + 1, `group toolbar overflow at ${width}px: ${JSON.stringify(before)}`);
            for (const action of before.actions) {
                assert.ok(action.left >= before.left && action.right <= before.right + 1, JSON.stringify(before));
                assert.ok(action.scroll <= action.client + 1, 'action text must fit its own button');
                assert.ok(action.height >= 44, 'mobile actions must retain touch height');
            }
            await cdp.clickSelector('.weg-native-group-heading[data-group-id="a"] .weg-native-group-menu > summary');
            const open = await measure();
            assert.equal(open.height, before.height, 'opening the menu must not push entries downward');
            assert.ok(open.popup.left >= 0 && open.popup.right <= open.width, `menu must stay inside ${width}px viewport`);
            await cdp.clickSelector('.weg-native-group-heading[data-group-id="a"] .weg-native-group-menu > summary');
        }
    });
});
