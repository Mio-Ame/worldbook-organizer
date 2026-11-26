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
const { getServerState, resetAndBoot, waitForCondition } = await load('assert-helpers.mjs');

for (const device of ['desktop', 'mobile']) {
    test(`${device} native editor omits ungrouped chrome only when the book has no custom entry groups`, async () => {
        const world = '空分组测试书';
        const server = createMockStServer();
        const baseUrl = await server.start();
        let cdp;
        try {
            cdp = await launchEdgeCdp();
            await resetAndBoot(cdp, baseUrl, { viewport: VIEWPORTS[device], seed: createDefaultSeed({
                characters: [], selected_world_info: [],
                worldbooks: { [world]: makeBook([makeEntry(0), makeEntry(1, { disable: true }), makeEntry(2)]) },
                pluginSettings: { autoScanNewCharacters: false },
                extraPluginSettingsKey: { worldbook_entry_groups: { books: { [world]: { pinnedEntryUids: ['1'] } } } },
            }) });
            const before = (await getServerState(baseUrl)).worldbooks;
            await cdp.evalFn((world) => {
                const select = document.getElementById('world_editor_select');
                select.value = [...select.options].find((option) => option.textContent === world).value;
                select.dispatchEvent(new Event('change', { bubbles: true }));
            }, world);
            await waitForCondition(cdp, () => document.querySelector('#weg-native-group-enabled:enabled'));
            await cdp.clickSelector('#weg-native-group-enabled');
            await waitForCondition(cdp, () => document.querySelector('#weg-native-pinned-entries button'));
            const read = () => cdp.evalFn(() => ({
                headings: document.querySelectorAll('.weg-native-group-heading, .weg-native-list-sticky').length,
                rows: [...document.querySelectorAll('.world_entry[uid]')].map((row) => ({
                    uid: row.getAttribute('uid'), visible: getComputedStyle(row).display !== 'none',
                })),
                collapsed: document.querySelectorAll('.weg-native-group-collapsed, .weg-native-group-start').length,
                entry: Boolean(document.getElementById('weg-native-group-manager')),
                pinned: Boolean(document.querySelector('#weg-native-pinned-entries button')),
            }));
            assert.deepEqual(await read(), { headings: 0, rows: [{ uid: '0', visible: true }, { uid: '1', visible: true }, { uid: '2', visible: true }],
                collapsed: 0, entry: true, pinned: true }, 'an ungrouped book must keep all rows and pins without a redundant group header');
            const setConfig = (grouped) => cdp.evalFn(async ({ world, grouped }) => {
                const root = '/scripts/extensions/third-party/worldbook-organizer/src/entry-groups/';
                const host = await import(`${root}host.js`);
                const config = host.getSettings().books[world];
                config.groups = grouped ? [{ id: 'g1', name: '测试分组', mode: 'normal' }] : [];
                config.assignments = grouped ? { 0: 'g1' } : {};
                host.saveSettings();
                (await import(`${root}panel.js`)).syncAllNativeEntryPoints();
            }, { world, grouped });
            await setConfig(true);
            await waitForCondition(cdp, () => document.querySelectorAll('.weg-native-group-heading').length === 2);
            assert.deepEqual(await cdp.evalFn(() => [...document.querySelectorAll('.weg-native-group-heading .weg-native-group-disclosure > span')].map((el) => el.textContent)),
                ['测试分组', '未分组'], 'a partially grouped book must still expose its unassigned entries');
            await setConfig(false);
            assert.equal((await read()).headings, 0, 'dissolving the last group must clear both heading and sticky bar');
            assert.equal((await read()).collapsed, 0);
            await cdp.evalFn((world) => window.dispatchEvent(new CustomEvent('weg:open-panel', { detail: { worldName: world } })), world);
            await waitForCondition(cdp, () => document.querySelector('[data-weg-group-card="__ungrouped__"]'));
            assert.deepEqual((await getServerState(baseUrl)).worldbooks, before, 'display-only changes must not alter worldbook data or entry states');
            assert.deepEqual(cdp.getErrors().runtimeErrors, []);
        } finally {
            await cdp?.close();
            await server.stop();
        }
    });
}
