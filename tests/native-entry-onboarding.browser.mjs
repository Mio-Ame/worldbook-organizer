import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const suite = process.env.WBO_E2E_SUITE;
if (!suite) throw new Error('Set WBO_E2E_SUITE to the retained browser regression suite');
const load = (name) => import(pathToFileURL(resolve(suite, 'lib', name)).href);
const { createMockStServer } = await load('mock-server.mjs');
const { VIEWPORTS, launchEdgeCdp } = await load('cdp.mjs');
const { createDefaultSeed, makeBook, makeEntry } = await load('fixtures.mjs');
const { resetAndBoot, waitForCondition } = await load('assert-helpers.mjs');

async function withHost(device, verify) {
    const server = createMockStServer();
    const baseUrl = await server.start();
    let cdp;
    try {
        cdp = await launchEdgeCdp();
        await resetAndBoot(cdp, baseUrl, { viewport: VIEWPORTS[device], seed: createDefaultSeed({
            characters: [], selected_world_info: [],
            worldbooks: { '引导测试书': makeBook([makeEntry(0)]) },
            pluginSettings: { autoScanNewCharacters: false },
            extraPluginSettingsKey: { worldbook_entry_groups: {
                nativeEntryHintSeen: true, enableNativeGrouping: true,
                books: { '引导测试书': { groups: [{ id: 'g1', name: '测试组' }], assignments: { 0: 'g1' } } },
            } },
        }) });
        await selectBook(cdp);
        await verify(cdp);
        assert.deepEqual(cdp.getErrors().runtimeErrors, []);
    } finally {
        await cdp?.close();
        await server.stop();
    }
}

async function selectBook(cdp) {
    await cdp.evalFn(() => {
        const drawer = document.getElementById('WorldInfo');
        drawer.classList.remove('closedDrawer');
        drawer.classList.add('openDrawer');
        drawer.style.display = 'block';
        const select = document.getElementById('world_editor_select');
        select.value = [...select.options].find((option) => option.textContent === '引导测试书').value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await waitForCondition(cdp, () => document.getElementById('weg-native-group-manager'));
}

async function settings(cdp) {
    return cdp.evalFn(() => SillyTavern.getContext().extensionSettings.worldbook_entry_groups);
}

async function assertDormant(cdp) {
    assert.deepEqual(await cdp.evalFn(async () => {
        const { getNativeGroupingPreferences } = await import('/scripts/extensions/third-party/worldbook-organizer/src/entry-groups/host.js');
        return {
            active: getNativeGroupingPreferences().active,
            imports: performance.getEntriesByType('resource').filter((entry) => entry.name.includes('/entry-groups/native-view.js')).length,
        };
    }), { active: false, imports: 0 });
}

async function openChoice(cdp) {
    await cdp.clickSelector('#weg-native-group-manager');
    assert.equal(await cdp.evalFn(() => Boolean(document.querySelector('[data-weg-native-entry-choice="use"]'))), true,
        'the first native manager click must ask for a choice even when the old toast was seen');
    assert.equal(await cdp.evalFn(() => document.getElementById('weg-modal-backdrop')?.hidden === false), false);
}

async function waitSaved(cdp, visible) {
    await cdp.evalFn((visible) => { window.entryExpectedVisible = visible; }, visible);
    await waitForCondition(cdp, async () => {
        const state = await fetch('/__test/state').then((response) => response.json());
        const entry = state.extension_settings.worldbook_entry_groups;
        return entry?.nativeEntryChoiceSeen === true && entry.showNativeEntryBtn === window.entryExpectedVisible;
    });
}

for (const device of ['desktop', 'mobile']) {
    test(`${device} native entry cancellation is not a choice and explicit use persists without activating enhancement`, async () => {
        await withHost(device, async (cdp) => {
            await cdp.evalFn(() => {
                window.entryChoiceFocus = 0;
                const focus = HTMLElement.prototype.focus;
                HTMLElement.prototype.focus = function (...args) {
                    if (this.closest('.wbo-submodal-overlay')) window.entryChoiceFocus++;
                    return focus.apply(this, args);
                };
            });
            await openChoice(cdp);
            const layout = await cdp.evalFn(() => {
                const button = document.querySelector('[data-weg-native-entry-choice="use"]');
                const modal = button.closest('.wbo-modal');
                const text = modal.querySelector('p').getBoundingClientRect();
                const box = button.getBoundingClientRect();
                return { gap: box.top - text.bottom, right: box.right, viewport: innerWidth };
            });
            assert.ok(layout.gap >= 0 && layout.gap <= 32, `choice buttons must sit directly below the text, gap=${layout.gap}`);
            assert.ok(layout.right <= layout.viewport, 'choice buttons stay inside the viewport');
            const png = await cdp.send('Page.captureScreenshot', { format: 'png' });
            const screenshot = resolve(tmpdir(), `wbo-native-entry-onboarding-${device}.png`);
            writeFileSync(screenshot, Buffer.from(png.data, 'base64'));
            console.log(`Onboarding screenshot: ${screenshot}`);
            const labels = await cdp.evalFn(() => [...document.querySelectorAll('[data-weg-native-entry-choice]')].map((button) => button.textContent.trim()));
            assert.deepEqual(labels, ['使用条目分组', '不需要，隐藏入口']);
            await cdp.evalFn(() => {
                document.getElementById('weg-native-group-manager').click();
                document.getElementById('weg-native-group-manager').click();
            });
            assert.equal(await cdp.evalFn(() => document.querySelectorAll('[data-weg-native-entry-choice="use"]').length), 1, 'repeat clicks must not stack the choice');
            if (device === 'mobile') assert.equal(await cdp.evalFn(() => window.entryChoiceFocus), 0, 'mobile onboarding must not auto-focus');
            assert.equal(await cdp.evalFn(() => document.getElementById('WorldInfo').classList.contains('openDrawer')), true, 'body-mounted dialog clicks preserve the host drawer');
            await cdp.clickSelector('.wbo-submodal-overlay .wbo-modal-close');
            assert.equal((await settings(cdp)).nativeEntryChoiceSeen, false, 'closing is not a choice');
            await cdp.reload();
            await waitForCondition(cdp, () => document.getElementById('wbo-wand-entry'));
            await selectBook(cdp);
            await openChoice(cdp);
            await cdp.clickSelector('[data-weg-native-entry-choice="use"]');
            await waitForCondition(cdp, () => document.querySelector('[data-weg-group-card="g1"]'));
            await assertDormant(cdp);
            await waitSaved(cdp, true);
            await cdp.reload();
            await waitForCondition(cdp, () => document.getElementById('wbo-wand-entry'));
            await selectBook(cdp);
            await cdp.clickSelector('#weg-native-group-manager');
            await waitForCondition(cdp, () => document.querySelector('[data-weg-group-card="g1"]'));
            assert.equal(await cdp.evalFn(() => Boolean(document.querySelector('[data-weg-native-entry-choice]'))), false, 'explicit use is remembered after reload');
            await assertDormant(cdp);
        });
    });

    test(`${device} hiding native entry preserves data and plugin access and settings restore it without another question`, async () => {
        await withHost(device, async (cdp) => {
            const before = await settings(cdp);
            await openChoice(cdp);
            await cdp.clickSelector('[data-weg-native-entry-choice="hide"]');
            await waitForCondition(cdp, () => !document.getElementById('weg-native-entry-controls'));
            const after = await settings(cdp);
            assert.equal(after.nativeEntryChoiceSeen, true);
            assert.equal(after.showNativeEntryBtn, false);
            assert.equal(after.enableNativeGrouping, before.enableNativeGrouping);
            assert.deepEqual(after.books, before.books);
            await assertDormant(cdp);
            await waitSaved(cdp, false);
            await cdp.reload();
            await waitForCondition(cdp, () => document.getElementById('wbo-wand-entry'));
            await cdp.evalFn(() => window.dispatchEvent(new CustomEvent('weg:open-panel', { detail: { worldName: '引导测试书' } })));
            await waitForCondition(cdp, () => document.querySelector('[data-weg-group-card="g1"]'));
            assert.equal(await cdp.evalFn(() => Boolean(document.querySelector('[data-weg-native-entry-choice]'))), false, 'plugin entry bypasses native onboarding');
            await cdp.clickSelector('#weg-btn-settings');
            await cdp.clickSelector('#weg-set-native-btn');
            await cdp.clickSelector('#weg-btn-close');
            await selectBook(cdp);
            await cdp.clickSelector('#weg-native-group-manager');
            await waitForCondition(cdp, () => document.querySelector('[data-weg-group-card="g1"]'));
            assert.equal(await cdp.evalFn(() => Boolean(document.querySelector('[data-weg-native-entry-choice]'))), false, 'restoring the entry does not ask again');
            await assertDormant(cdp);
        });
    });
}

test('native onboarding owns only its overlay and stale choice buttons cannot act after disable or restart', async () => {
    await withHost('desktop', async (cdp) => {
        await cdp.evalFn(async () => {
            const { createSubModal } = await import('/scripts/extensions/third-party/worldbook-organizer/src/panel-window.js');
            const { overlay } = createSubModal('测试窗口', '<p>测试内容</p>');
            window.otherEntryTestOverlay = overlay;
        });
        await cdp.evalFn(() => document.getElementById('weg-native-group-manager').click());
        assert.equal(await cdp.evalFn(() => Boolean(document.querySelector('[data-weg-native-entry-choice="use"]'))), true);
        assert.equal(await cdp.evalFn(() => window.otherEntryTestOverlay.isConnected), true, 'opening the entry choice must not replace an unrelated submodal');
        const result = await cdp.evalFn(async () => {
            const root = '/scripts/extensions/third-party/worldbook-organizer/';
            window.staleEntryChoice = document.querySelector('[data-weg-native-entry-choice="use"]');
            const lifecycle = await import(`${root}src/entry-groups/lifecycle.js`);
            lifecycle.stopEntryGrouping();
            const ownedRemoved = !document.querySelector('[data-weg-native-entry-choice]');
            const unrelatedPreserved = window.otherEntryTestOverlay.isConnected;
            await lifecycle.startEntryGrouping('entry-choice-restart');
            window.staleEntryChoice.click();
            const plugin = await import(`${root}index.js`);
            document.getElementById('weg-native-group-manager').click();
            const hide = document.querySelector('[data-weg-native-entry-choice="hide"]');
            plugin.onDisable();
            hide.click();
            window.staleEntryChoice.click();
            await new Promise((resolve) => setTimeout(resolve, 100));
            return {
                ownedRemoved, unrelatedPreserved,
                choice: SillyTavern.getContext().extensionSettings.worldbook_entry_groups.nativeEntryChoiceSeen,
                visibleSetting: SillyTavern.getContext().extensionSettings.worldbook_entry_groups.showNativeEntryBtn,
                controls: Boolean(document.getElementById('weg-native-entry-controls')),
                prompt: Boolean(document.querySelector('[data-weg-native-entry-choice]')),
                panel: Boolean(document.getElementById('weg-modal-backdrop')),
            };
        });
        assert.deepEqual(result, { ownedRemoved: true, unrelatedPreserved: true, choice: false, visibleSetting: true, controls: false, prompt: false, panel: false });
    });
});
