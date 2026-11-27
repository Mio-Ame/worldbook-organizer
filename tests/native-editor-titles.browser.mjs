import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const suite = process.env.WBO_E2E_SUITE;
if (!suite) throw new Error('WBO_E2E_SUITE required');
const load = name => import(pathToFileURL(resolve(suite, 'lib', name)).href);
const { createMockStServer } = await load('mock-server.mjs');
const { VIEWPORTS, launchEdgeCdp } = await load('cdp.mjs');
const { createDefaultSeed } = await load('fixtures.mjs');
const { resetAndBoot, waitForCondition } = await load('assert-helpers.mjs');
const prefix = '/scripts/extensions/third-party/worldbook-organizer/';
const realName = '角色书文件名';
const charName = '中性角色甲';
function seed(extra = {}) {
    return createDefaultSeed({
        characters: [{ avatar: 'neutral-a.png', name: charName, data: { name: charName, extensions: { world: realName } } }],
        worldbooks: { [realName]: { entries: {} }, '普通书乙': { entries: {} } },
        selected_world_info: [],
        pluginSettings: { autoScanNewCharacters: false, showCharBooks: true, hideCharBooksByDefault: false,
            cachedCharBindings: {}, groups: [], assignments: {}, aliases: {}, notes: {},
            charBookOverrides: {}, pinnedBooks: [], globalHiddenGroupIds: [], editorHiddenGroupIds: [],
            charBookTitleMode: 'char_only', pinCurrentChatCharBookInEditor: false, ...extra },
    });
}
async function withHost(viewport, fixture, verify) {
    const server = createMockStServer();
    let cdp;
    try {
        const url = await server.start();
        cdp = await launchEdgeCdp();
        await resetAndBoot(cdp, url, { viewport, query: viewport.mobile ? 'mobile=1' : '', seed: fixture });
        await verify(cdp);
        assert.deepEqual(cdp.getErrors().runtimeErrors, []);
    } finally { await cdp?.close(); await server.stop(); }
}

test('title report contains structure only, never a book or character name', async t => {
    await withHost(VIEWPORTS.desktop, seed({ charBookTitleMode: 'char_with_sub' }), async cdp => {
        await cdp.evalFn(() => jQuery('#world_editor_select').select2('open'));
        await waitForCondition(cdp, () => Boolean(document.querySelector('.select2-dropdown .wbo-s2-title')));
        const result = await cdp.evalFn(name => {
            const text = JSON.stringify(window.wboTitleReport?.() || {});
            const parsed = JSON.parse(text);
            return {
                leaksBook: text.includes(name),
                leaksChar: text.includes('中性角色甲'),
                leaksGroup: text.includes('角色世界书') || text.includes('未分组'),
                titleMode: parsed.titleMode,
                charGroupBooks: parsed.classification?.charGroupBooks,
            };
        }, realName);
        t.diagnostic(JSON.stringify(result));
        assert.equal(result.leaksBook, false);
        assert.equal(result.leaksChar, false);
        assert.equal(result.leaksGroup, false);
        assert.equal(result.titleMode, 'char_with_sub');
        assert.ok(result.charGroupBooks >= 1);
    });
});

test('character-group book without a live binding still reads as the role name', async t => {
    // Shallow characters (SillyTavern's default until a card is loaded) plus include_in_char:
    // the classification has no owner, so without the fallback the row showed the file name.
    const fixture = seed({
        charBookTitleMode: 'char_with_sub',
        charBookOverrides: { [realName]: 'include_in_char' },
    });
    fixture.characters = [{ avatar: 'neutral-a.png', name: charName, shallow: true, data: { name: charName, extensions: { world: realName } } }];
    await withHost(VIEWPORTS.desktop, fixture, async cdp => {
        await cdp.evalFn(() => jQuery('#world_editor_select').select2('open'));
        await waitForCondition(cdp, () => Boolean(document.querySelector('.select2-dropdown .wbo-s2-title')));
        await cdp.evalFn(() => {
            document.querySelector('.select2-dropdown .wbo-dd-pill[data-wbo-pill="__all__"]')
                ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        });
        await waitForCondition(cdp, () => document.querySelector('.select2-dropdown .wbo-s2-title')?.textContent === '中性角色甲');
        const result = await cdp.evalFn(name => {
            const row = document.querySelector(`.select2-dropdown [data-wbo-world="${name}"]`);
            return {
                title: row?.querySelector('.wbo-s2-title')?.textContent,
                subtitle: row?.querySelector('.wbo-s2-sub')?.textContent,
                report: window.wboTitleReport?.() || null,
            };
        }, realName);
        t.diagnostic(JSON.stringify(result));
        assert.equal(result.title, charName);
        assert.equal(result.subtitle, realName);
    });
});

test('desktop ordinary Select2: another character book also uses its role name', async t => {
    const otherBook = '别角书文件名';
    const otherChar = '中性角色乙';
    const fixture = seed({ charBookTitleMode: 'char_with_sub' });
    fixture.characters.push({ avatar: 'neutral-b.png', name: otherChar, data: { name: otherChar, extensions: { world: otherBook } } });
    fixture.worldbooks[otherBook] = { entries: {} };
    await withHost(VIEWPORTS.desktop, fixture, async cdp => {
        await cdp.evalFn(() => jQuery('#world_editor_select').select2('open'));
        await waitForCondition(cdp, () => Boolean(document.querySelector('.select2-dropdown .wbo-dd-pill')));
        const result = await cdp.evalFn(name => {
            const row = document.querySelector(`.select2-dropdown [data-wbo-world="${name}"]`);
            return {
                visible: Boolean(row?.closest('li')?.getBoundingClientRect().height),
                title: row?.querySelector('.wbo-s2-title')?.textContent,
                subtitle: row?.querySelector('.wbo-s2-sub')?.textContent,
                group: row?.closest('li[data-wbo-dd-group]')?.getAttribute('data-wbo-dd-group')
                    || row?.closest('li.select2-results__option--group')?.getAttribute('aria-label'),
            };
        }, otherBook);
        t.diagnostic(JSON.stringify(result));
        assert.equal(result.visible, true);
        assert.equal(result.title, otherChar);
        assert.equal(result.subtitle, otherBook);
        assert.match(String(result.group), /__char__/);
    });
});

test('desktop ordinary Select2: character group uses the requested name', async t => {
    await withHost(VIEWPORTS.desktop, seed(), async cdp => {
        await cdp.evalFn(() => jQuery('#world_editor_select').select2('open'));
        const result = await cdp.evalFn(name => {
            const row = document.querySelector(`.select2-dropdown [data-wbo-world="${name}"]`);
            return { visible: !!row?.getBoundingClientRect().height, title: row?.querySelector('.wbo-s2-title')?.textContent };
        }, realName);
        t.diagnostic(JSON.stringify(result));
        assert.deepEqual(result, { visible: true, title: charName });
    });
});

test('host-rendered rows are upgraded so the role name still shows', async t => {
    await withHost(VIEWPORTS.desktop, seed({ charBookTitleMode: 'char_with_sub' }), async cdp => {
        await cdp.evalFn(() => jQuery('#world_editor_select').select2('open'));
        await waitForCondition(cdp, () => Boolean(document.querySelector('.select2-dropdown .wbo-dd-current-char')));
        // Simulate a host that owns the row markup: plain text plus a decoration (the star),
        // which used to defeat the name lookup and left the file name in place.
        await cdp.evalFn(name => {
            const row = document.querySelector(`.select2-dropdown [data-wbo-world="${name}"]`)?.closest('li');
            row.textContent = `${name} ☆`;
            document.querySelector('.select2-dropdown .wbo-dd-pill[data-wbo-pill="__all__"]')
                ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        }, realName);
        await waitForCondition(cdp, () => Boolean(document.querySelector('.select2-dropdown .wbo-s2-title')));
        const result = await cdp.evalFn(name => {
            const item = document.querySelector(`.select2-dropdown [data-wbo-world="${name}"]`);
            return {
                title: item?.querySelector('.wbo-s2-title')?.textContent,
                subtitle: item?.querySelector('.wbo-s2-sub')?.textContent,
            };
        }, realName);
        t.diagnostic(JSON.stringify(result));
        assert.equal(result.title, charName);
        assert.equal(result.subtitle, realName);
    });
});

test('desktop ordinary Select2: default char_with_sub keeps the role name for a moved book', async t => {
    await withHost(VIEWPORTS.desktop, seed({ charBookTitleMode: 'char_with_sub', groups: [{ id: 'custom-a', name: '自定义组甲' }], assignments: { [realName]: 'custom-a' } }), async cdp => {
        await cdp.evalFn(() => jQuery('#world_editor_select').select2('open'));
        await waitForCondition(cdp, () => Boolean(document.querySelector('.select2-dropdown .wbo-dd-pill')));
        const result = await cdp.evalFn(name => {
            const row = document.querySelector(`.select2-dropdown [data-wbo-world="${name}"]`);
            return {
                title: row?.querySelector('.wbo-s2-title')?.textContent,
                subtitle: row?.querySelector('.wbo-s2-sub')?.textContent,
                currentChar: row?.closest('li')?.classList.contains('wbo-dd-current-char'),
            };
        }, realName);
        t.diagnostic(JSON.stringify(result));
        assert.equal(result.title, charName);
        assert.equal(result.subtitle, realName);
        assert.equal(result.currentChar, true);
    });
});

test('desktop ordinary Select2: bound book moved to a custom group keeps the role name', async t => {
    await withHost(VIEWPORTS.desktop, seed({ groups: [{ id: 'custom-a', name: '自定义组甲' }], assignments: { [realName]: 'custom-a' } }), async cdp => {
        await cdp.evalFn(() => jQuery('#world_editor_select').select2('open'));
        await waitForCondition(cdp, () => Boolean(document.querySelector('.select2-dropdown .wbo-dd-pill')));
        const result = await cdp.evalFn(name => {
            const row = document.querySelector(`.select2-dropdown [data-wbo-world="${name}"]`);
            return {
                visible: !!row?.getBoundingClientRect().height,
                title: row?.querySelector('.wbo-s2-title')?.textContent,
                // Bound books are hoisted to the untitled top row, so they carry no group head.
                currentChar: row?.closest('li')?.classList.contains('wbo-dd-current-char'),
            };
        }, realName);
        t.diagnostic(JSON.stringify(result));
        assert.equal(result.visible, true);
        assert.equal(result.title, charName);
        assert.equal(result.currentChar, true);
    });
});

test('mobile grouped ordinary picker: character group uses the requested name', async t => {
    await withHost(VIEWPORTS.mobile, seed(), async cdp => {
        await cdp.clickSelector('#wbo-mobile-editor-trigger');
        const result = await cdp.evalFn(name => {
            const rows = [...document.querySelectorAll('#wbo-mobile-picker-overlay [data-wbo-world], #wbo-mobile-picker-overlay [data-book]')];
            const titles = [...document.querySelectorAll('#wbo-mobile-picker-overlay .wbo-mp-row-title')].map(el => el.textContent);
            return { visible: !!document.getElementById('wbo-mp-search')?.getBoundingClientRect().height, titles };
        }, realName);
        t.diagnostic(JSON.stringify(result));
        assert.equal(result.visible, true);
        assert.ok(result.titles.includes(charName));
    });
});

test('mobile flat ordinary selector: char_only must also control the visible native option', async t => {
    await withHost(VIEWPORTS.mobile, seed({ showNativeOptgroups: false }), async cdp => {
        const result = await cdp.evalFn(name => {
            const select = document.getElementById('world_editor_select');
            const option = [...select.options].find(el => el.textContent === name);
            return { picker: !!document.getElementById('wbo-mobile-editor-trigger'),
                nativeVisible: !!select.getBoundingClientRect().height && !select.classList.contains('wbo-mobile-select-hidden'),
                optionText: option?.textContent, optionValue: option?.value };
        }, realName);
        t.diagnostic(JSON.stringify(result));
        assert.equal(result.picker, true, 'titled books use the plugin picker instead of the system menu');
        assert.equal(result.nativeVisible, false);
        assert.equal(result.optionText, realName, 'real option text stays the file name for host lookups');
        await cdp.clickSelector('#wbo-mobile-editor-trigger');
        const titles = await cdp.evalFn(() => [...document.querySelectorAll('#wbo-mobile-picker-overlay .wbo-mp-row-title')].map(el => el.textContent));
        assert.ok(titles.includes(charName), JSON.stringify(titles));
        await cdp.clickSelector(`[data-mp-world="${realName}"]`);
        await new Promise(done => setTimeout(done, 300));
        assert.equal(await cdp.evalFn(() => document.getElementById('world_editor_select').selectedOptions[0]?.textContent), realName);
        const label = await cdp.evalFn(() => document.querySelector('#wbo-mobile-editor-trigger .wbo-mobile-trigger-text')?.textContent);
        assert.equal(label, charName);
    });
});

test('ordinary grouped picker: manually grouped bound book must still use the requested role name', async t => {
    await withHost(VIEWPORTS.mobile, seed({ groups: [{ id: 'custom-a', name: '自定义组甲' }], assignments: { [realName]: 'custom-a' } }), async cdp => {
        await cdp.clickSelector('#wbo-mobile-editor-trigger');
        const result = await cdp.evalFn(() => ({
            visible: !!document.getElementById('wbo-mp-search')?.getBoundingClientRect().height,
            titles: [...document.querySelectorAll('#wbo-mobile-picker-overlay .wbo-mp-row-title')].map(el => el.textContent),
        }));
        t.diagnostic(JSON.stringify(result));
        assert.equal(result.visible, true);
        assert.ok(result.titles.includes(charName));
    });
});

test('reused enhanced ordinary picker: original to char_only must update the existing row', async t => {
    await withHost(VIEWPORTS.desktop, seed({ charBookTitleMode: 'original' }), async cdp => {
        await cdp.evalFn(() => {
            const style = document.createElement('style');
            style.setAttribute('data-gr-dropdown-style', '');
            document.head.append(style);
            const select = document.getElementById('world_editor_select');
            select.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            const container = document.createElement('div');
            container.id = 'gr-global-dropdown-container';
            container.className = 'gr-container-enhanced open';
            container.style.cssText = 'position:fixed;top:150px;left:20px;width:400px;z-index:9000;background:white';
            const host = document.createElement('div');
            host.className = 'gr-options-container';
            for (const option of select.options) {
                const row = document.createElement('div');
                row.className = 'gr-option'; row.dataset.value = option.value; row.textContent = option.textContent;
                row.style.minHeight = '29px'; host.append(row);
            }
            container.append(host); document.body.append(container);
        });
        await waitForCondition(cdp, () => document.querySelector('#gr-global-dropdown-container[data-wbo-popover-role="editor"] .wbo-gr-world-title'));
        const result = await cdp.evalFn(async (p, name) => {
            const native = await import(p + 'src/native-filter.js');
            const core = await import(p + 'src/core.js');
            const settings = structuredClone(SillyTavern.getContext().extensionSettings.worldbook_organizer);
            settings.charBookTitleMode = 'char_only';
            const characters = SillyTavern.getContext().characters;
            const worldNames = [name, '普通书乙'];
            const bindingMap = core.buildCharacterBindingIndex({ characters, worldNamesSet: new Set(worldNames) });
            const classification = core.classifyWorldbooks({ worldNames, bindingMap, settings });
            const row = [...document.querySelectorAll('#gr-global-dropdown-container .gr-option')].find(el => el.dataset.wboEnhancedWorld === name);
            const before = row?.querySelector('.wbo-gr-world-title')?.textContent;
            native.applyAllNativeWorldFilters(classification, settings, { force: true });
            await new Promise(done => setTimeout(done, 420));
            // Reopen this same container through a normal opening event; host did not rebuild its children.
            document.getElementById('world_editor_select').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            await new Promise(done => setTimeout(done, 420));
            return { before, expectedMeta: classification.byName.get(name).primaryTitle,
                visible: !!row?.getBoundingClientRect().height, after: row?.querySelector('.wbo-gr-world-title')?.textContent };
        }, prefix, realName);
        t.diagnostic(JSON.stringify(result));
        assert.equal(result.expectedMeta, charName);
        assert.equal(result.visible, true);
        assert.equal(result.after, charName);
    });
});
