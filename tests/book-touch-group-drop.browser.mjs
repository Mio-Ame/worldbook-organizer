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
const { getServerState, openManager, resetAndBoot, waitForCondition } = await load('assert-helpers.mjs');

const book = '触屏拖入测试书';
const seed = createDefaultSeed({
    characters: [], selected_world_info: [],
    worldbooks: { [book]: { entries: {} } },
    pluginSettings: {
        showCharBooks: true, hideCharBooksByDefault: false, autoScanNewCharacters: false,
        activeFilterGroupId: '__all__',
        groups: [
            { id: 'source', name: '来源分组', collapsed: false },
            { id: 'target', name: '目标分组', collapsed: false },
        ],
        assignments: { [book]: 'source' }, pinnedBooks: [],
        globalHiddenGroupIds: [], editorHiddenGroupIds: [], groupPanelExpanded: false,
    },
});

test('mobile can drag a worldbook into a top group pill without selecting row text', async (t) => {
    const server = createMockStServer();
    const baseUrl = await server.start();
    let cdp;
    try {
        cdp = await launchEdgeCdp();
        await resetAndBoot(cdp, baseUrl, { seed, viewport: VIEWPORTS.mobile });
        await openManager(cdp);
        await cdp.evalFn(() => {
            const rail = document.getElementById('wbo-mgr-pills');
            const target = rail.querySelector('[data-group-id="target"]');
            rail.scrollLeft += target.getBoundingClientRect().right - rail.getBoundingClientRect().right;
        });

        const handles = await cdp.evalFn((name) => {
            const handle = document.querySelector(`.wbo-book-row[data-book="${CSS.escape(name)}"] .wbo-drag-handle`);
            const pill = document.querySelector('.wbo-pill[data-group-id="target"]');
            const handleRect = handle?.getBoundingClientRect();
            const pillRect = pill?.getBoundingClientRect();
            return {
                handle: handleRect && { x: handleRect.left + handleRect.width / 2, y: handleRect.top + handleRect.height / 2, width: handleRect.width, height: handleRect.height },
                pill: pillRect && { x: pillRect.left + pillRect.width / 2, y: pillRect.top + pillRect.height / 2 },
            };
        }, book);
        assert.ok(handles.handle?.width >= 24 && handles.handle?.height >= 24, `touch drag handle must be visible and reachable: ${JSON.stringify(handles)}`);
        assert.ok(handles.pill, 'top target group pill must be available');
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: handles.handle.x, y: handles.handle.y, id: 1 }] });
        for (let step = 1; step <= 8; step++) {
            await cdp.send('Input.dispatchTouchEvent', {
                type: 'touchMove',
                touchPoints: [{
                    x: Math.round(handles.handle.x + (handles.pill.x - handles.handle.x) * step / 8),
                    y: Math.round(handles.handle.y + (handles.pill.y - handles.handle.y) * step / 8),
                    id: 1,
                }],
            });
        }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await waitForCondition(cdp, () => Boolean(document.querySelector('.wbo-group[data-group-id="target"] .wbo-book-item[data-book="触屏拖入测试书"]')));

        const result = await cdp.evalFn(() => ({
            moved: Boolean(document.querySelector('.wbo-group[data-group-id="target"] .wbo-book-item[data-book="触屏拖入测试书"]')),
            selectedText: String(window.getSelection?.() || ''),
        }));
        assert.equal(result.moved, true, 'book should be reassigned to the dropped group');
        assert.equal(result.selectedText, '', 'dragging must not select text and expose the iOS selection menu');
        await waitForCondition(cdp, async () => {
            const state = await (await fetch('/__test/state')).json();
            return state.extension_settings.worldbook_organizer.assignments['触屏拖入测试书'] === 'target';
        });
        const saved = await getServerState(baseUrl);
        assert.equal(saved.extension_settings.worldbook_organizer.assignments[book], 'target');
        await cdp.send('Page.reload', { ignoreCache: true });
        await waitForCondition(cdp, () => Boolean(document.querySelector('#wbo-wand-entry')));
        await openManager(cdp);
        await waitForCondition(cdp, () => Boolean(document.querySelector('.wbo-group[data-group-id="target"] .wbo-book-item[data-book="触屏拖入测试书"]')));
        assert.deepEqual(cdp.getErrors().runtimeErrors, []);
    } finally {
        await cdp?.close();
        await server.stop();
    }
});
