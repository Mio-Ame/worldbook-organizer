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

const expectedSections = [
    { title: '外观', ids: ['weg-set-palette', 'weg-set-colormode'] },
    { title: '原生编辑器', ids: ['weg-set-native-grouping', 'weg-set-native-btn', 'weg-set-native-theme', 'weg-set-close-locate'] },
    { title: '聊天联动', ids: ['weg-set-auto-chat-switch', 'weg-set-scene-auto'] },
    { title: '重置与清理', ids: ['weg-set-clear-book', 'weg-dissolve-all-books'] },
];

for (const device of ['desktop', 'mobile']) {
    test(`${device} entry group settings keep values and actions in four bounded sections`, async () => {
        const server = createMockStServer();
        const baseUrl = await server.start();
        let cdp;
        try {
            cdp = await launchEdgeCdp();
            await resetAndBoot(cdp, baseUrl, { viewport: VIEWPORTS[device], seed: createDefaultSeed({
                characters: [], selected_world_info: [],
                worldbooks: { '设置测试书': makeBook([makeEntry(0)]) },
                pluginSettings: { autoScanNewCharacters: false },
                extraPluginSettingsKey: { worldbook_entry_groups: {
                    version: 2, palette: 'warm', colorMode: 'light', followMainPalette: false, followMainColorMode: false,
                    enableNativeGrouping: false, showNativeEntryBtn: false, followNativeTheme: true, closeOnLocate: false,
                    autoSwitchOnChatChange: true, enableSceneAutoToggle: false,
                    books: { '设置测试书': { groups: [{ id: 'g1', name: '测试组' }], assignments: { 0: 'g1' } } },
                } },
            }) });
            await cdp.evalFn(() => window.dispatchEvent(new CustomEvent('weg:open-panel', { detail: { worldName: '设置测试书' } })));
            await waitForCondition(cdp, () => document.querySelector('[data-weg-group-card="g1"]'));
            await cdp.clickSelector('#weg-btn-settings');
            await waitForCondition(cdp, () => document.getElementById('weg-set-palette'));
            assert.deepEqual(await cdp.evalFn(() => [...document.querySelectorAll('#weg-submodal-host .weg-settings-section')].map((section) => ({
                title: section.querySelector('.weg-settings-section-title')?.textContent.trim(),
                ids: [...section.querySelectorAll('button[id], select[id]')].map((control) => control.id),
            }))), expectedSections, 'settings must expose four headings and preserve each control in its intended section');
            const before = await cdp.evalFn(() => {
                const host = document.getElementById('weg-submodal-host');
                const values = Object.fromEntries([...host.querySelectorAll('button[id], select[id]')].map((control) => [control.id,
                    control instanceof HTMLSelectElement ? control.value : control.getAttribute('aria-checked') ?? String(control.disabled)]));
                return {
                    values,
                    badges: [...host.querySelectorAll('.weg-test-feature')].map((badge) => ({
                        text: badge.textContent.trim(), section: badge.closest('.weg-settings-section').querySelector('h3').textContent.trim(),
                        red: getComputedStyle(badge).color,
                    })),
                    danger: host.querySelector('.weg-library-danger')?.contains(host.querySelector('#weg-dissolve-all-books')),
                    dangerBorder: getComputedStyle(host.querySelector('.weg-library-danger')).borderTopWidth,
                    dangerColor: getComputedStyle(host.querySelector('.weg-library-danger')).borderTopColor,
                    resetColor: getComputedStyle(host.querySelector('#weg-dissolve-all-books')).color,
                };
            });
            assert.deepEqual(before.values, {
                'weg-set-palette': 'warm', 'weg-set-colormode': 'light',
                'weg-set-native-grouping': 'false', 'weg-set-native-btn': 'false', 'weg-set-native-theme': 'true', 'weg-set-close-locate': 'false',
                'weg-set-auto-chat-switch': 'true', 'weg-set-scene-auto': 'false',
                'weg-set-clear-book': 'false', 'weg-dissolve-all-books': 'false',
            });
            assert.deepEqual(before.badges.map(({ text, section }) => ({ text, section })), [
                { text: '测试功能', section: '聊天联动' }, { text: '测试功能', section: '聊天联动' },
            ]);
            assert.equal(before.badges.every(({ red }) => {
                const channels = red.match(/[\d.]+/g).map(Number);
                return channels[0] > channels[1] && channels[0] > channels[2];
            }), true, 'experimental feature labels stay red');
            assert.equal(before.danger, true);
            assert.equal(before.dangerBorder, '1px');
            assert.equal(before.dangerColor, before.resetColor, 'library cleanup keeps its red danger frame');
            const overflow = await cdp.evalFn(() => [...document.querySelectorAll('#weg-submodal-host .weg-submodal-card, #weg-submodal-host .weg-submodal-body, #weg-submodal-host .weg-settings-section, #weg-submodal-host .weg-setting-row')]
                .filter((element) => element.scrollWidth > element.clientWidth + 1).map((element) => element.className));
            assert.deepEqual(overflow, [], 'settings and controls stay within the desktop/mobile content width');
            const screenshot = resolve(tmpdir(), `wbo-entry-group-settings-${device}.png`);
            writeFileSync(screenshot, Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
            console.log(`Settings screenshot: ${screenshot}`);
            await cdp.clickSelector('#weg-set-native-btn');
            await cdp.clickSelector('#weg-set-auto-chat-switch');
            await cdp.evalFn(() => {
                const palette = document.getElementById('weg-set-palette');
                palette.value = 'ink';
                palette.dispatchEvent(new Event('change', { bubbles: true }));
            });
            await cdp.clickSelector('#weg-submodal-host .weg-submodal-footer [data-weg-sub-close]');
            await cdp.clickSelector('#weg-btn-settings');
            assert.deepEqual(await cdp.evalFn(() => ({
                palette: document.getElementById('weg-set-palette').value,
                showButton: document.getElementById('weg-set-native-btn').getAttribute('aria-checked'),
                chat: document.getElementById('weg-set-auto-chat-switch').getAttribute('aria-checked'),
                groups: SillyTavern.getContext().extensionSettings.worldbook_entry_groups.books['设置测试书'].groups.map((group) => group.id),
            })), { palette: 'ink', showButton: 'true', chat: 'false', groups: ['g1'] }, 'existing settings handlers and stored grouping are unchanged');
            assert.deepEqual(cdp.getErrors().runtimeErrors, []);
        } finally {
            await cdp?.close();
            await server.stop();
        }
    });
}
