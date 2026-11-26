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
const { resetAndBoot, waitForCondition } = await load('assert-helpers.mjs');
const characterBook = '角色原始文件名';
const aliasBook = '普通原始文件名';

for (const viewport of [VIEWPORTS.desktop, VIEWPORTS.mobile]) {
    for (const mode of ['char_only', 'char_with_sub', 'original']) {
        test(`${viewport.width}: enhanced global titles follow ${mode} and aliases without changing native book identity`, async () => {
            const server = createMockStServer();
            const baseUrl = await server.start();
            let cdp;
            try {
                cdp = await launchEdgeCdp();
                await resetAndBoot(cdp, baseUrl, { viewport, seed: createDefaultSeed({
                    characters: [{ avatar: 'sample.png', name: '测试角色名', data: { extensions: { world: characterBook } } }],
                    worldbooks: { [characterBook]: { entries: {} }, [aliasBook]: { entries: {} } },
                    selected_world_info: [aliasBook],
                    pluginSettings: {
                        autoScanNewCharacters: false, showCharBooks: true, globalHiddenGroupIds: [],
                        charBookTitleMode: mode, aliasTitleMode: 'alias_only', aliases: { [aliasBook]: '用户自定别名' },
                        overrideEnhancedDropdownStyle: mode === 'original', pinnedBooks: [],
                    },
                }) });
                await cdp.evalFn(() => {
                    const style = document.createElement('style');
                    style.setAttribute('data-gr-dropdown-style', '');
                    document.head.append(style);
                    window.__ST_TEST_HELPERS__.openGrGlobalPopover();
                    const host = document.querySelector('#gr-global-dropdown-container .gr-options-list');
                    host.className = 'gr-options-container';
                    for (const row of host.querySelectorAll('.gr-option')) {
                        const pin = document.createElement('button');
                        pin.type = 'button';
                        pin.className = 'gr-option-pin';
                        pin.textContent = '⌖';
                        row.append(pin);
                    }
                });
                await waitForCondition(cdp, () => document.querySelector('#gr-global-dropdown-container[data-wbo-popover-ready="1"] .wbo-gr-pin-btn'));
                const result = await cdp.evalFn((names) => names.map((name) => {
                    const row = [...document.querySelectorAll('#gr-global-dropdown-container .gr-option')]
                        .find((item) => item.querySelector('[data-pin-world]')?.getAttribute('data-pin-world') === name);
                    const label = row.querySelector('.wbo-gr-world-title');
                    return { title: label?.firstChild?.textContent ?? null, sub: label?.querySelector('small')?.textContent ?? '',
                        originalPins: row.querySelectorAll('.gr-option-pin').length,
                        favorites: row.querySelectorAll('.wbo-gr-pin-btn').length,
                        editing: row.querySelectorAll('[data-wbo-editing-badge]').length };
                }), [characterBook, aliasBook]);
                assert.deepEqual(result, [
                    { title: mode === 'original' ? characterBook : '测试角色名',
                        sub: mode === 'char_with_sub' ? characterBook : '', originalPins: 1, favorites: 1, editing: 0 },
                    { title: '用户自定别名', sub: '', originalPins: 1, favorites: 1, editing: 0 },
                ]);
                assert.deepEqual(await cdp.evalFn(() => [...document.getElementById('world_info').selectedOptions].map((item) => item.textContent)), [aliasBook]);
                await cdp.evalFn(async () => (await import('/scripts/extensions/third-party/worldbook-organizer/index.js')).onDisable());
                assert.deepEqual(await cdp.evalFn(() => [...document.querySelectorAll('#gr-global-dropdown-container .gr-option')].map((row) => ({
                    text: [...row.childNodes].filter((node) => node.nodeType === 3).map((node) => node.textContent).join('').trim(),
                    label: Boolean(row.querySelector('.wbo-gr-world-title')), pins: row.querySelectorAll('.gr-option-pin').length,
                })).sort((a, b) => a.text.localeCompare(b.text, 'zh-CN'))), [characterBook, aliasBook].sort((a, b) => a.localeCompare(b, 'zh-CN'))
                    .map((text) => ({ text, label: false, pins: 1 })));
                assert.deepEqual(cdp.getErrors().runtimeErrors, []);
            } finally {
                await cdp?.close();
                await server.stop();
            }
        });
    }
}
