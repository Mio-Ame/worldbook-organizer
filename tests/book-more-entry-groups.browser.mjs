import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const suite = process.env.WBO_E2E_SUITE;
if (!suite) throw new Error('Set WBO_E2E_SUITE to the retained browser regression suite');
const load = (name) => import(pathToFileURL(resolve(suite, 'lib', name)).href);
const { createMockStServer } = await load('mock-server.mjs');
const { VIEWPORTS, launchEdgeCdp } = await load('cdp.mjs');
const { createDefaultSeed, makeBook, makeEntry } = await import('./entry-groups-fixtures.mjs');
const { getServerState, openManager, resetAndBoot, waitForCondition } = await load('assert-helpers.mjs');

for (const device of ['desktop', 'mobile']) {
    test(`${device} book more menu opens entry grouping for that book without expanding it or enabling native enhancement`, async () => {
        const world = '菜单目标测试书';
        const row = `.wbo-book-item[data-book="${world}"]`;
        const entry = '[data-more-act="entry-groups"]';
        const server = createMockStServer();
        const baseUrl = await server.start();
        let cdp;
        try {
            cdp = await launchEdgeCdp();
            await resetAndBoot(cdp, baseUrl, { viewport: VIEWPORTS[device], seed: createDefaultSeed({
                characters: [], selected_world_info: [],
                worldbooks: { '其他测试书': makeBook([makeEntry(0)]), [world]: makeBook([makeEntry(0, { comment: '目标条目' })]) },
                pluginSettings: { autoScanNewCharacters: false },
                extraPluginSettingsKey: { worldbook_entry_groups: { showNativeEntryBtn: false, enableNativeGrouping: false } },
            }) });
            const before = (await getServerState(baseUrl)).worldbooks;
            await openManager(cdp);
            await cdp.clickSelector(`${row} [data-action="book-more-menu"]`);
            assert.equal(await cdp.evalFn((selector) => document.querySelector(selector)?.textContent.trim(), entry), '条目分组',
                'a collapsed book must expose entry grouping in its more menu');
            await cdp.clickSelector(`${row} [data-action="book-more-menu"]`);
            assert.equal(await cdp.evalFn(() => Boolean(document.querySelector('.wbo-book-more-popover'))), false, 'clicking the same more button closes it');
            await cdp.clickSelector(`${row} [data-action="book-more-menu"]`);
            await cdp.clickSelector(entry);
            await waitForCondition(cdp, () => document.querySelector('#weg-book-select')?.value === '菜单目标测试书');
            assert.deepEqual(await cdp.evalFn(() => ({
                main: Boolean(document.querySelector('#wbo-manager-overlay .wbo-manager-modal')),
                more: Boolean(document.querySelector('.wbo-book-more-popover')),
                onboarding: Boolean(document.querySelector('[data-weg-native-entry-choice]')),
                panels: document.querySelectorAll('#weg-modal-backdrop').length,
            })), { main: true, more: false, onboarding: false, panels: 1 });
            assert.deepEqual(await cdp.evalFn(async () => {
                const host = await import('/scripts/extensions/third-party/worldbook-organizer/src/entry-groups/host.js');
                return { active: host.getNativeGroupingPreferences().active, show: host.getSettings().showNativeEntryBtn,
                    enabled: host.getSettings().enableNativeGrouping };
            }), { active: false, show: false, enabled: false }, 'the plugin menu must not change native display preferences');
            await cdp.clickSelector('#weg-btn-close');
            await cdp.clickSelector(`${row} .wbo-book-main`);
            await waitForCondition(cdp, () => document.querySelector('[data-acc-extra="open-entry-groups"]'));
            await cdp.clickSelector('[data-acc-extra="open-entry-groups"]');
            await waitForCondition(cdp, () => document.querySelector('#weg-book-select')?.value === '菜单目标测试书');
            await cdp.clickSelector('#weg-btn-close');
            await cdp.evalFn(async () => (await import('/scripts/extensions/third-party/worldbook-organizer/src/entry-groups/lifecycle.js')).stopEntryGrouping());
            await cdp.clickSelector(`${row} [data-action="book-more-menu"]`);
            assert.equal(await cdp.evalFn((selector) => Boolean(document.querySelector(selector)), entry), false,
                'unavailable grouping must not leave a dead menu action');
            assert.deepEqual((await getServerState(baseUrl)).worldbooks, before, 'opening either entry must not write worldbook data');
            assert.deepEqual(cdp.getErrors().runtimeErrors, []);
        } finally {
            await cdp?.close();
            await server.stop();
        }
    });
}
