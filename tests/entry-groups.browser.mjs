import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const suite = process.env.WBO_E2E_SUITE;
if (!suite) throw new Error('Set WBO_E2E_SUITE to the retained browser regression suite');
const load = (name) => import(pathToFileURL(resolve(suite, 'lib', name)).href);
const { createMockStServer } = await load('mock-server.mjs');
const { VIEWPORTS, launchEdgeCdp } = await load('cdp.mjs');
const { createDefaultSeed, makeBook, makeEntry } = await load('fixtures.mjs');
const { getServerState, openManager, resetAndBoot, waitForCondition } = await load('assert-helpers.mjs');

test('integrated grouping restores existing settings and only one runtime owns the native entry points', async () => {
    const world = '分组测试书';
    const seed = createDefaultSeed({
        characters: [],
        worldbooks: { [world]: makeBook([makeEntry(0, { comment: '样例条目' })]) },
        selected_world_info: [],
        pluginSettings: { autoScanNewCharacters: false },
        extraPluginSettingsKey: {
            worldbook_entry_groups: {
                books: {
                    [world]: {
                        groups: [{ id: 'fixture-group', name: '已有分组', mode: 'normal' }],
                        assignments: { 0: 'fixture-group' },
                    },
                },
            },
        },
    });
    seed.worldbooks[world].entries['0'].group = '宿主包含组';
    const server = createMockStServer();
    const baseUrl = await server.start();
    let cdp;
    try {
        cdp = await launchEdgeCdp();
        await resetAndBoot(cdp, baseUrl, { seed, viewport: VIEWPORTS.desktop });
        await waitForCondition(cdp, () => !!document.querySelector('#weg-wand-entry'));
        await openManager(cdp);
        await cdp.clickSelector('[data-action="open-entry-groups"]');
        await waitForCondition(cdp, () => Boolean(document.querySelector('[data-weg-group-card="fixture-group"]')));
        const before = await cdp.evalFn(() => ({
            title: document.querySelector('.weg-group-name').textContent.trim(),
            handles: document.querySelectorAll('.weg-modal .wbo-resize-edge').length,
            oldControl: !!document.querySelector('#weg-btn-mini'),
        }));
        assert.deepEqual(before, { title: '已有分组', handles: 8, oldControl: false });
        await cdp.clickSelector('[data-weg-group-toggle="fixture-group"]');
        await waitForCondition(cdp, async () => {
            const data = await fetch('/__test/state').then((res) => res.json());
            return data.worldbooks['分组测试书'].entries['0'].disable === true;
        });
        const entry = (await getServerState(baseUrl)).worldbooks[world].entries['0'];
        assert.equal(entry.group, '宿主包含组');
        assert.equal(entry.comment, '样例条目');
        assert.deepEqual(cdp.getErrors().runtimeErrors, []);

        await resetAndBoot(cdp, baseUrl, { seed: { ...seed, entryGroupsInstalled: true }, viewport: VIEWPORTS.desktop });
        await openManager(cdp);
        assert.equal(await cdp.evalFn(() => !!document.querySelector('link[href*="/src/entry-groups/style.css"]')), false);
        assert.equal(await cdp.evalFn(() => !!document.querySelector('[data-action="open-entry-groups"]')), true);
        await cdp.evalFn(async () => {
            const runtime = await import('/scripts/extensions/third-party/worldbook-organizer/index.js');
            runtime.onDisable();
        });
        assert.equal(await cdp.evalFn(() => !!document.querySelector('link[data-weg-style-ver]')), true);
    } finally {
        await cdp?.close();
        await server.stop();
    }
});
