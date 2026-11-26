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
const { createDefaultSeed, makeBook, makeEntry } = await import('./entry-groups-fixtures.mjs');
const { openManager, resetAndBoot, waitForCondition } = await load('assert-helpers.mjs');

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

async function assertActive(cdp) {
    await waitForCondition(cdp, () => document.getElementById('weg-native-group-enabled')?.getAttribute('aria-checked') === 'true'
        && document.querySelector('.weg-native-group-heading'));
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
    test(`${device} one settings switch restores and activates native grouping without a second permission`, async () => {
        await withHost(device, async (cdp) => {
            await cdp.evalFn(async () => {
                const settings = SillyTavern.getContext().extensionSettings.worldbook_entry_groups;
                settings.enableNativeGrouping = false;
                settings.showNativeEntryBtn = false;
                const ctx = SillyTavern.getContext();
                await ctx.eventSource.emit(ctx.eventTypes.EXTENSION_SETTINGS_LOADED);
            });
            const before = (await settings(cdp)).books;
            await assertDormant(cdp);
            await openManager(cdp);
            await cdp.clickSelector('[data-action="open-settings-modal"]');
            await cdp.clickSelector('[data-settings-tab="appearance"]');
            assert.equal(await cdp.evalFn(() => Boolean(document.querySelector('input[data-entry-native-grouping]'))), false,
                'main settings must not expose a second permission switch');
            const toggle = 'input[data-entry-native-button]';
            assert.equal(await cdp.evalFn((selector) => document.querySelector(selector).checked, toggle), false);
            await cdp.clickSelector(toggle);
            await waitForCondition(cdp, () => document.getElementById('weg-native-group-enabled')?.getAttribute('aria-checked') === 'true'
                && document.querySelector('.weg-native-group-heading'));
            assert.equal(await cdp.evalFn(() => Boolean(document.querySelector('[data-weg-native-entry-choice]'))), false);
            assert.deepEqual((await settings(cdp)).books, before);
            await cdp.clickSelector(toggle);
            await waitForCondition(cdp, () => !document.getElementById('weg-native-entry-controls') && !document.querySelector('.weg-native-group-heading'));
            await cdp.clickSelector('#wbo-settings-close-btn');
            await cdp.clickSelector('#wbo-manager-overlay .wbo-modal-close');
            await cdp.evalFn(() => window.dispatchEvent(new CustomEvent('weg:open-panel', { detail: { worldName: '引导测试书' } })));
            await waitForCondition(cdp, () => document.getElementById('weg-btn-settings'));
            await cdp.clickSelector('#weg-btn-settings');
            await cdp.clickSelector('[data-weg-settings-tab="native"]');
            assert.equal(await cdp.evalFn(() => Boolean(document.getElementById('weg-set-native-grouping'))), false,
                'entry settings must not expose the removed permission switch either');
            await cdp.clickSelector('#weg-set-native-btn');
            await waitForCondition(cdp, () => document.getElementById('weg-native-group-enabled')?.getAttribute('aria-checked') === 'true'
                && document.querySelector('.weg-native-group-heading'));
            await cdp.clickSelector('#weg-set-native-btn');
            await waitForCondition(cdp, () => !document.getElementById('weg-native-entry-controls') && !document.querySelector('.weg-native-group-heading'));
            assert.deepEqual((await settings(cdp)).books, before);
        });
    });
    test(`${device} native entry cancellation is not a choice and explicit use activates enhancement immediately`, async () => {
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
                const text = button.parentElement.previousElementSibling.getBoundingClientRect();
                const box = button.getBoundingClientRect();
                return { gap: box.top - text.bottom, right: box.right, viewport: innerWidth, height: modal.getBoundingClientRect().height, viewportHeight: innerHeight };
            });
            assert.ok(layout.gap >= 0 && layout.gap <= 32, `choice buttons must sit directly below the text, gap=${layout.gap}`);
            assert.ok(layout.right <= layout.viewport, 'choice buttons stay inside the viewport');
            assert.ok(layout.height < layout.viewportHeight * 0.6, `a short choice must not fill the viewport: ${layout.height}/${layout.viewportHeight}`);
            const png = await cdp.send('Page.captureScreenshot', { format: 'png' });
            const screenshot = resolve(tmpdir(), `wbo-native-entry-onboarding-${device}.png`);
            writeFileSync(screenshot, Buffer.from(png.data, 'base64'));
            console.log(`Onboarding screenshot: ${screenshot}`);
            const labels = await cdp.evalFn(() => [...document.querySelectorAll('[data-weg-native-entry-choice]')].map((button) => button.textContent.trim()));
            assert.deepEqual(labels, ['确定使用', '不需要，隐藏入口']);
            assert.equal(await cdp.evalFn(() => document.querySelector('.wbo-native-entry-choice p').textContent.trim()), '是否使用条目分组功能？');
            assert.match(await cdp.evalFn(() => document.querySelector('.wbo-native-entry-choice').textContent), /插件面板 → 设置 → 外观与入口 → 条目分组/, 'explain the recovery path before hiding');
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
            await assertActive(cdp);
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
            assert.equal(after.enableNativeGrouping, false);
            assert.deepEqual(after.books, before.books);
            await assertDormant(cdp);
            await waitSaved(cdp, false);
            await cdp.reload();
            await waitForCondition(cdp, () => document.getElementById('wbo-wand-entry'));
            await cdp.evalFn(() => window.dispatchEvent(new CustomEvent('weg:open-panel', { detail: { worldName: '引导测试书' } })));
            await waitForCondition(cdp, () => document.querySelector('[data-weg-group-card="g1"]'));
            assert.equal(await cdp.evalFn(() => Boolean(document.querySelector('[data-weg-native-entry-choice]'))), false, 'plugin entry bypasses native onboarding');
            await cdp.clickSelector('#weg-btn-settings');
            await cdp.clickSelector('[data-weg-settings-tab="native"]');
            await cdp.clickSelector('#weg-set-native-btn');
            await cdp.clickSelector('#weg-btn-close');
            await selectBook(cdp);
            await cdp.clickSelector('#weg-native-group-manager');
            await waitForCondition(cdp, () => document.querySelector('[data-weg-group-card="g1"]'));
            assert.equal(await cdp.evalFn(() => Boolean(document.querySelector('[data-weg-native-entry-choice]'))), false, 'restoring the entry does not ask again');
            await assertActive(cdp);
        });
    });
}

for (const device of ['desktop', 'mobile']) {
    test(`${device} first native switch click shares onboarding and confirms the requested action`, async () => {
        await withHost(device, async (cdp) => {
            await cdp.clickSelector('#weg-native-group-enabled');
            assert.equal(await cdp.evalFn(() => Boolean(document.querySelector('[data-weg-native-entry-choice="use"]'))), true, 'the switch must show the same first-use prompt');
            await assertDormant(cdp);
            await cdp.clickSelector('.wbo-native-entry-choice .wbo-modal-close');
            assert.equal((await settings(cdp)).nativeEntryChoiceSeen, false);
            await cdp.clickSelector('#weg-native-group-enabled');
            await cdp.clickSelector('[data-weg-native-entry-choice="use"]');
            await waitForCondition(cdp, () => document.getElementById('weg-native-group-enabled')?.getAttribute('aria-checked') === 'true');
            assert.equal(await cdp.evalFn(() => document.getElementById('weg-modal-backdrop')?.hidden === false), false, 'confirming the switch displays groups, not a second management window');
            await cdp.clickSelector('#weg-native-group-enabled');
            await waitForCondition(cdp, () => document.getElementById('weg-native-group-enabled')?.getAttribute('aria-checked') === 'false');
            assert.equal(await cdp.evalFn(() => Boolean(document.querySelector('[data-weg-native-entry-choice]'))), false, 'subsequent switching is direct');
            assert.equal((await settings(cdp)).nativeEntryChoiceSeen, true);
        });
    });

    test(`${device} main settings restore hidden native grouping in one action and preserve group data`, async () => {
        await withHost(device, async (cdp) => {
            await openChoice(cdp);
            await cdp.clickSelector('[data-weg-native-entry-choice="hide"]');
            await waitSaved(cdp, false);
            await cdp.reload();
            await waitForCondition(cdp, () => document.getElementById('wbo-wand-entry'));
            await selectBookWithoutEntry(cdp);
            const before = await settings(cdp);
            await openManager(cdp);
            await cdp.clickSelector('[data-action="open-settings-modal"]');
            await cdp.clickSelector('[data-settings-tab="appearance"]');
            const recovery = 'input[data-entry-native-button]';
            assert.equal(await cdp.evalFn((selector) => document.querySelector(selector)?.checked, recovery), false, 'main settings must offer the hidden entry switch');
            assert.equal(await cdp.evalFn((selector) => document.querySelector(selector).closest('.wbo-card') === document.querySelector('[data-settings-pane="appearance"] > .wbo-card'), recovery), true, 'recovery must be in the first card, above secondary settings');
            assert.ok((await cdp.clickSelector(recovery)).hit);
            await waitForCondition(cdp, () => document.getElementById('weg-native-group-manager'));
            const after = await settings(cdp);
            assert.equal(after.showNativeEntryBtn, true);
            assert.equal(after.enableNativeGrouping, true);
            assert.equal(after.nativeEntryChoiceSeen, true);
            assert.deepEqual(after.books, before.books);
            await assertActive(cdp);
            await cdp.clickSelector('#wbo-settings-close-btn');
            await cdp.clickSelector('#wbo-manager-overlay .wbo-modal-close');
            await waitSaved(cdp, true);
            await cdp.reload();
            await waitForCondition(cdp, () => document.getElementById('wbo-wand-entry'));
            await selectBook(cdp);
            await cdp.clickSelector('#weg-native-group-manager');
            await waitForCondition(cdp, () => document.querySelector('[data-weg-group-card="g1"]'));
            assert.equal(await cdp.evalFn(() => Boolean(document.querySelector('[data-weg-native-entry-choice]'))), false);
            await assertDormant(cdp);
        });
    });
}

test('mobile onboarding is compact under fullscreen host surface rules and remains usable after viewport resize', async () => {
    await withHost('mobile', async (cdp) => {
        await cdp.evalFn(() => {
            window.__TAURITAVERN__ = {};
            const style = document.createElement('style');
            style.textContent = '[data-tt-mobile-surface="fullscreen-window"] { height: 100dvh !important; min-height: 100dvh !important; max-height: none !important; }';
            document.head.append(style);
        });
        await openChoice(cdp);
        for (const height of [844, 460]) {
            await cdp.setViewport({ ...VIEWPORTS.mobile, height });
            const rect = await cdp.evalFn(() => {
                const modal = document.querySelector('.wbo-native-entry-choice');
                const box = modal.getBoundingClientRect();
                return { top: box.top, bottom: box.bottom, height: box.height, limit: innerHeight, surface: modal.dataset.ttMobileSurface };
            });
            assert.notEqual(rect.surface, 'fullscreen-window', 'a short confirmation is not a fullscreen window');
            assert.ok(rect.height < rect.limit * 0.6, JSON.stringify(rect));
            assert.ok(rect.top >= 0 && rect.bottom <= rect.limit, JSON.stringify(rect));
        }
        assert.ok((await cdp.clickSelector('[data-weg-native-entry-choice="hide"]')).hit);
        assert.equal((await settings(cdp)).showNativeEntryBtn, false);
    });
});

async function selectBookWithoutEntry(cdp) {
    await cdp.evalFn(() => {
        const drawer = document.getElementById('WorldInfo');
        drawer.classList.remove('closedDrawer');
        drawer.classList.add('openDrawer');
        drawer.style.display = 'block';
        const select = document.getElementById('world_editor_select');
        select.value = [...select.options].find((option) => option.textContent === '引导测试书').value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await waitForCondition(cdp, () => document.querySelector('.world_entry'));
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
