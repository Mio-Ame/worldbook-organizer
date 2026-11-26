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
const prefix = '/scripts/extensions/third-party/worldbook-organizer/';
const prompt = '没有激活的世界书。点击这里选择。';

async function withHost(viewport, verify) {
    const server = createMockStServer();
    const baseUrl = await server.start();
    let cdp;
    try {
        cdp = await launchEdgeCdp();
        await resetAndBoot(cdp, baseUrl, { viewport, seed: createDefaultSeed({
            characters: [], selected_world_info: [],
            worldbooks: { '测试书甲': { entries: {} }, '测试书乙': { entries: {} } },
            pluginSettings: { autoScanNewCharacters: false, globalHiddenGroupIds: [], editorHiddenGroupIds: [] },
        }) });
        await verify(cdp, server);
        assert.deepEqual(cdp.getErrors().runtimeErrors, []);
    } finally {
        await cdp?.close();
        await server.stop();
    }
}

test('closed panels stay idle without reading books or rebuilding controls for unrelated page changes', async () => {
    await withHost(VIEWPORTS.mobile, async (cdp, server) => {
        await cdp.evalFn(async () => {
            const drawer = document.getElementById('WorldInfo');
            drawer.hidden = true;
            drawer.classList.remove('openDrawer');
            drawer.classList.add('closedDrawer');
            await new Promise((resolve) => setTimeout(resolve, 800));
            const controls = document.getElementById('weg-native-entry-controls');
            let changes = 0;
            const observer = new MutationObserver(() => changes++);
            if (controls) observer.observe(controls, { childList: true, subtree: true, attributes: true });
            window.idleFixture = { controls, changes: () => changes, observer };
        });
        const before = structuredClone(server.getStateSnapshot().metrics);
        await cdp.evalFn(async () => {
            for (let i = 0; i < 8; i++) {
                const notice = document.createElement('div');
                notice.textContent = '测试通知';
                document.body.append(notice);
                await new Promise((resolve) => requestAnimationFrame(resolve));
                notice.remove();
            }
            await new Promise((resolve) => setTimeout(resolve, 2000));
        });
        assert.deepEqual(server.getStateSnapshot().metrics, before, 'no worldbook, character or settings requests while idle');
        assert.deepEqual(await cdp.evalFn(() => ({
            sameEntry: document.getElementById('weg-native-entry-controls') === window.idleFixture.controls,
            changes: window.idleFixture.changes(),
            enhancedLoads: performance.getEntriesByType('resource').filter((entry) => entry.name.includes('/entry-groups/native-view.js')).length,
        })), { sameEntry: true, changes: 0, enhancedLoads: 0 });
    });
});

test('disable cancels chat-triggered embedded imports before their delayed work begins', async () => {
    await withHost(VIEWPORTS.desktop, async (cdp, server) => {
        await cdp.evalFn(async (prefix) => {
            const ctx = SillyTavern.getContext();
            ctx.characters.push({ name: '测试角色', avatar: 'test-role.png', shallow: false,
                data: { extensions: { world: '' }, character_book: { name: '测试内嵌书', entries: [
                    { id: 0, comment: '测试条目', content: '测试正文', keys: [], enabled: true },
                ] } } });
            ctx.characterId = 0;
            ctx.extensionSettings.worldbook_organizer.autoImportMissingCharBook = true;
            await ctx.eventSource.emit(ctx.eventTypes.CHAT_CHANGED);
            (await import(`${prefix}index.js`)).onDisable();
        }, prefix);
        const before = structuredClone(server.getStateSnapshot().metrics);
        await cdp.evalFn(() => new Promise((resolve) => setTimeout(resolve, 1300)));
        assert.deepEqual(server.getStateSnapshot().metrics, before, 'disabled extension must not begin a queued import');
        assert.equal(await cdp.evalFn(() => document.querySelectorAll('#weg-native-entry-controls, #wbo-wand-entry').length), 0);
    });
});

for (const viewport of [VIEWPORTS.desktop, VIEWPORTS.mobile]) {
    test(`empty global prompt survives asynchronous enhanced display refresh at ${viewport.name}`, async () => {
        await withHost(viewport, async (cdp) => {
            await cdp.evalFn((prompt) => {
                const select = document.getElementById('world_info');
                if (!jQuery(select).data('select2')) jQuery(select).select2({ placeholder: prompt });
                const inst = jQuery(select).data('select2');
                inst.options.options.placeholder = { id: '', text: prompt };
                const source = document.createElement('textarea');
                source.className = 'select2-search__field';
                source.setAttribute('spellcheck', 'false');
                source.placeholder = prompt;
                inst.$container[0].append(source);
                const display = document.createElement('div');
                display.className = 'gr-select2-display';
                display.dataset.grSelectId = 'world_info';
                inst.$container[0].before(display);
                const refresh = () => {
                    display.replaceChildren();
                    if (select.selectedOptions.length) {
                        const chip = document.createElement('span');
                        chip.className = 'gr-select2-chip';
                        chip.textContent = select.selectedOptions[0].textContent;
                        display.append(chip);
                    } else {
                        const span = document.createElement('span');
                        span.className = 'gr-select2-placeholder';
                        span.textContent = source.placeholder;
                        display.append(span);
                    }
                };
                new MutationObserver(refresh).observe(select, { childList: true });
                select.addEventListener('change', refresh);
                window.promptFixture = { source, display, select, inst, refresh };
                refresh();
            }, prompt);
            const read = () => cdp.evalFn(() => document.querySelector('.gr-select2-placeholder')?.textContent);
            assert.equal(await read(), prompt);
            await cdp.evalFn(async (prefix) => {
                const { source } = window.promptFixture;
                source.placeholder = '';
                const core = await import(`${prefix}src/core.js`);
                const native = await import(`${prefix}src/native-filter.js`);
                const settings = SillyTavern.getContext().extensionSettings.worldbook_organizer;
                native.applyAllNativeWorldFilters(core.classifyWorldbooks({ worldNames: ['测试书甲', '测试书乙'], bindingMap: new Map(), settings }), settings, { force: true });
                await new Promise((resolve) => setTimeout(resolve, 60));
            }, prefix);
            assert.equal(await read(), prompt, 'a transient empty native search prompt must not blank the enhanced display');
            assert.equal(await cdp.evalFn(() => window.promptFixture.source.placeholder), '', 'do not rewrite the host search input');
            for (let i = 0; i < 3; i++) {
                await cdp.evalFn(async () => {
                    const { select } = window.promptFixture;
                    select.options[0].selected = true;
                    jQuery(select).trigger('change');
                    await new Promise((resolve) => setTimeout(resolve, 40));
                });
                assert.deepEqual(await cdp.evalFn(() => [
                    window.promptFixture.select.selectedOptions.length,
                    document.querySelectorAll('.gr-select2-placeholder').length,
                    document.querySelectorAll('.gr-select2-chip').length,
                ]), [1, 0, 1]);
                await cdp.evalFn(async () => {
                    for (const option of window.promptFixture.select.options) option.selected = false;
                    jQuery(window.promptFixture.select).trigger('change');
                    await new Promise((resolve) => setTimeout(resolve, 40));
                });
                assert.equal(await read(), prompt);
            }
            await cdp.evalFn(async (prefix) => {
                (await import(`${prefix}index.js`)).onDisable();
                window.promptFixture.refresh();
                await new Promise((resolve) => setTimeout(resolve, 250));
            }, prefix);
            assert.equal(await read(), '', 'after disable, the display belongs to its original renderer again');
            assert.equal(await cdp.evalFn(() => document.querySelectorAll('#weg-native-entry-controls, .wbo-global-dd-bar, [data-wbo-enhanced-host-theme]').length), 0);
        });
    });
}

test('disable returns an open borrowed popover to its original nodes and releases its listeners', async () => {
    await withHost(VIEWPORTS.desktop, async (cdp) => {
        await cdp.evalFn(() => {
            window.__ST_TEST_HELPERS__.openGrGlobalPopover();
            const pop = document.getElementById('gr-global-dropdown-container');
            pop.dataset.wboSourceRole = 'global';
            const rows = [...pop.querySelectorAll('.gr-option')];
            const label = document.createElement('div');
            label.className = 'gr-group-label';
            label.textContent = '原始分组';
            const surface = document.createElement('div');
            surface.className = 'gr-options';
            const searchBox = document.createElement('div');
            searchBox.className = 'gr-search-box';
            searchBox.innerHTML = '<input type="search" class="gr-search-input" spellcheck="false">';
            const host = document.createElement('div');
            host.className = 'gr-options-container';
            host.append(label, ...rows);
            surface.append(searchBox, host);
            pop.replaceChildren(surface);
            let clicks = 0;
            rows[0].addEventListener('click', () => clicks++);
            const bindings = new Map();
            for (const target of [pop, host, surface, searchBox.firstElementChild]) {
                const live = new Set();
                bindings.set(target, live);
                const add = target.addEventListener.bind(target);
                const remove = target.removeEventListener.bind(target);
                target.addEventListener = (type, fn, options) => { live.add(fn); add(type, fn, options); };
                target.removeEventListener = (type, fn, options) => { live.delete(fn); remove(type, fn, options); };
            }
            window.borrowedFixture = { pop, host, rows, label, searchBox, bindings, clicks: () => clicks };
        });
        await waitForCondition(cdp, () => document.querySelector('#gr-global-dropdown-container .wbo-pop-filter-bar'));
        await cdp.evalFn(() => {
            const { host, rows } = window.borrowedFixture;
            const added = document.createElement('div');
            added.className = 'gr-option';
            added.dataset.value = 'extra-test';
            added.textContent = '测试书甲';
            rows.push(added);
            host.appendChild(added);
        });
        await waitForCondition(cdp, () => document.querySelector('.gr-option[data-value="extra-test"] .wbo-gr-pin-btn'));
        await cdp.evalFn(() => document.querySelector('#gr-global-dropdown-container .gr-search-input').dispatchEvent(new Event('input', { bubbles: true })));
        await cdp.evalFn(async (prefix) => (await import(`${prefix}index.js`)).onDisable(), prefix);
        assert.deepEqual(await cdp.evalFn(() => {
            const { pop, host, rows, label, searchBox, bindings } = window.borrowedFixture;
            return {
                originalRows: rows.every((row) => row.parentElement === host),
                originalLabel: label.parentElement === host && host.firstElementChild === label,
                originalSearch: searchBox.parentElement === host.parentElement,
                addedUi: pop.querySelectorAll('.wbo-pop-section, .wbo-pop-filter-bar, .wbo-s2-right, .wbo-enhanced-sticky').length,
                bindings: [...bindings.values()].reduce((n, set) => n + set.size, 0),
            };
        }), { originalRows: true, originalLabel: true, originalSearch: true, addedUi: 0, bindings: 0 });
        await cdp.evalFn(() => window.borrowedFixture.rows[0].click());
        assert.equal(await cdp.evalFn(() => window.borrowedFixture.clicks()), 1);
    });
});

test('disable restores borrowed selector options and localized prompt without replacing native widgets', async () => {
    await withHost(VIEWPORTS.desktop, async (cdp) => {
        await cdp.evalFn(async (prefix, prompt) => {
            const global = document.getElementById('world_info');
            const editor = document.getElementById('world_editor_select');
            const matcher = (_params, data) => data;
            const templateResult = (data) => data.text;
            const templateSelection = (data) => data.text;
            const parent = document.getElementById('WorldInfo');
            for (const select of [global, editor]) {
                jQuery(select).select2('destroy').select2({ placeholder: prompt, matcher, templateResult, templateSelection, dropdownParent: jQuery(parent), closeOnSelect: false });
            }
            window.originalSelectors = [global, editor].map((select) => ({ select, instance: jQuery(select).data('select2') }));
            window.originalOptions = { matcher, templateResult, templateSelection, parent };
            global.options[0].selected = true;
            jQuery(global).trigger('change');
            editor.value = '';
            jQuery(editor).trigger('change');
            const settings = SillyTavern.getContext().extensionSettings.worldbook_organizer;
            const core = await import(`${prefix}src/core.js`);
            (await import(`${prefix}src/native-filter.js`)).applyAllNativeWorldFilters(core.classifyWorldbooks({ worldNames: ['测试书甲', '测试书乙'], bindingMap: new Map(), settings }), settings, { force: true });
            (await import(`${prefix}index.js`)).onDisable();
        }, prefix, prompt);
        assert.deepEqual(await cdp.evalFn((prompt) => window.originalSelectors.map(({ select, instance }) => {
            const current = jQuery(select).data('select2');
            const options = current.options.options;
            return {
                same: current === instance,
                prompt: options.placeholder === prompt,
                matcher: options.matcher === window.originalOptions.matcher,
                result: options.templateResult === window.originalOptions.templateResult,
                selection: options.templateSelection === window.originalOptions.templateSelection,
                parent: options.dropdownParent?.[0] === window.originalOptions.parent,
                close: options.closeOnSelect,
                selected: [...select.selectedOptions].map((option) => option.value),
            };
        }), prompt), [
            { same: true, prompt: true, matcher: true, result: true, selection: true, parent: true, close: false, selected: ['0'] },
            { same: true, prompt: true, matcher: true, result: true, selection: true, parent: true, close: false, selected: [''] },
        ]);
        assert.equal(await cdp.evalFn(() => [...document.querySelectorAll('link[rel="stylesheet"]')].filter((link) => link.href.includes('/worldbook-organizer/')).length), 0);
        await cdp.evalFn(async () => {
            const select = document.getElementById('world_info');
            for (const option of select.options) option.selected = false;
            jQuery(select).trigger('change').select2('open');
            select.append(select.firstElementChild);
            await new Promise((resolve) => setTimeout(resolve, 300));
        });
        assert.equal(await cdp.evalFn(() => document.querySelector('#WIMultiSelector .select2-selection__placeholder')?.textContent), prompt);
        assert.equal(await cdp.evalFn(() => document.querySelectorAll('.wbo-global-dd-bar, .wbo-dd-filter-bar, .wbo-s2-item, #weg-native-entry-controls').length), 0);
    });
});

test('disable cancels deferred startup instead of remounting the extension later', async () => {
    await withHost(VIEWPORTS.desktop, async (cdp) => {
        await cdp.evalFn(async (prefix) => {
            (await import(`${prefix}index.js`)).onDisable();
            const pending = await import(`${prefix}index.js?cleanup-startup-test`);
            pending.onDisable();
            await new Promise((resolve) => setTimeout(resolve, 1400));
        }, prefix);
        assert.equal(await cdp.evalFn(() => document.querySelectorAll('#wbo-wand-entry, #weg-native-entry-controls, link[data-wbo-style-ver]').length), 0);
    });
});

test('disable cancels editor search repaint queued for the next frame', async () => {
    await withHost(VIEWPORTS.desktop, async (cdp) => {
        await cdp.evalFn(async (prefix) => {
            const settings = SillyTavern.getContext().extensionSettings.worldbook_organizer;
            Object.assign(settings, { groups: [{ id: 'sample', name: '测试分类' }], assignments: { 测试书甲: 'sample' } });
            const core = await import(`${prefix}src/core.js`);
            (await import(`${prefix}src/native-filter.js`)).applyAllNativeWorldFilters(core.classifyWorldbooks({ worldNames: ['测试书甲', '测试书乙'], bindingMap: new Map(), settings }), settings, { force: true });
        }, prefix);
        await cdp.evalFn(() => jQuery('#world_editor_select').select2('open'));
        await waitForCondition(cdp, () => document.querySelector('.wbo-dd-filter-bar'));
        await cdp.evalFn(async (prefix) => {
            document.querySelector('.select2-dropdown .select2-search__field').dispatchEvent(new Event('input', { bubbles: true }));
            (await import(`${prefix}index.js`)).onDisable();
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        }, prefix);
        assert.equal(await cdp.evalFn(() => document.querySelectorAll('.wbo-dd-filter-bar, .wbo-global-dd-bar').length), 0);
    });
});

test('sorting keyboard gestures are left to the host without a dedicated dropdown intervention', async () => {
    await withHost(VIEWPORTS.desktop, async (cdp) => {
        const result = await cdp.evalFn(() => {
            const marker = document.createElement('style');
            marker.dataset.grDropdownStyle = '1';
            document.head.append(marker);
            const sort = document.getElementById('world_info_sort_order');
            let delivered = 0;
            sort.addEventListener('keydown', () => delivered++);
            jQuery('#world_info').select2('open');
            sort.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            return { delivered, open: jQuery('#world_info').data('select2').isOpen() };
        });
        assert.deepEqual(result, { delivered: 1, open: true });
    });
});

test('enhanced group headings and pills follow the script colors unless its separate override is enabled', async () => {
    await withHost(VIEWPORTS.desktop, async (cdp) => {
        await cdp.evalFn(async (prefix) => {
            const style = document.createElement('style');
            style.dataset.grDropdownStyle = '1';
            style.textContent = `
                .gr-options { background-color: rgb(252, 250, 247) !important; }
                .gr-option { color: rgb(33, 46, 58) !important; }
                .gr-option.selected { color: rgb(20, 80, 140) !important; background-color: rgb(215, 235, 255) !important; }
                .gr-group-label { color: rgb(88, 108, 118); font-size: 15px; }
                body.dark-mode .gr-options { background-color: rgb(30, 29, 35) !important; }
                body.dark-mode .gr-option { color: rgb(230, 225, 238) !important; }
                body.dark-mode .gr-option.selected { color: rgb(220, 180, 240) !important; background-color: rgb(65, 45, 75) !important; }
                body.dark-mode .gr-group-label { color: rgb(180, 170, 195); }
            `;
            document.head.append(style);
            document.body.classList.remove('dark-mode');
            document.body.style.setProperty('--SmartThemeBlurTintColor', 'rgb(140, 160, 130)');
            const settings = SillyTavern.getContext().extensionSettings.worldbook_organizer;
            Object.assign(settings, {
                groups: [{ id: 'sample', name: '测试分类' }], assignments: { '测试书甲': 'sample' },
                outsideDropdownFollowHostTheme: true, overrideEnhancedDropdownStyle: false,
            });
            const core = await import(`${prefix}src/core.js`);
            (await import(`${prefix}src/native-filter.js`)).applyAllNativeWorldFilters(core.classifyWorldbooks({ worldNames: ['测试书甲', '测试书乙'], bindingMap: new Map(), settings }), settings, { force: true });
            window.__ST_TEST_HELPERS__.openGrGlobalPopover();
            const pop = document.getElementById('gr-global-dropdown-container');
            const rows = [...pop.querySelectorAll('.gr-option')];
            pop.innerHTML = '<div class="gr-options"><div class="gr-search-box"><input type="search" class="gr-search-input" spellcheck="false"></div><div class="gr-options-container"></div></div>';
            pop.querySelector('.gr-options-container').append(...rows);
        }, prefix);
        await waitForCondition(cdp, () => document.querySelector('#gr-global-dropdown-container .wbo-pop-filter-bar'));
        const colors = () => cdp.evalFn(() => {
            const pop = document.getElementById('gr-global-dropdown-container');
            const heading = getComputedStyle(pop.querySelector('.wbo-dd-group-head'));
            const pill = getComputedStyle(pop.querySelector('.wbo-dd-pill.is-active'));
            return { background: heading.backgroundColor, heading: heading.color, activeBackground: pill.backgroundColor, active: pill.color };
        });
        assert.deepEqual(await colors(), { background: 'rgb(252, 250, 247)', heading: 'rgb(88, 108, 118)', activeBackground: 'rgb(215, 235, 255)', active: 'rgb(20, 80, 140)' });
        assert.deepEqual(await cdp.evalFn(() => [
            getComputedStyle(document.querySelector('#gr-global-dropdown-container .wbo-dd-group-head')).fontSize,
            getComputedStyle(document.querySelector('#gr-global-dropdown-container .wbo-dd-pill')).fontSize,
        ]), ['15px', '11.5px']);
        await cdp.evalFn(() => document.body.classList.add('dark-mode'));
        // The borrowed surface may animate its theme change; compare settled colors.
        await new Promise((resolve) => setTimeout(resolve, 400));
        assert.deepEqual(await colors(), { background: 'rgb(30, 29, 35)', heading: 'rgb(180, 170, 195)', activeBackground: 'rgb(65, 45, 75)', active: 'rgb(220, 180, 240)' });
        await cdp.evalFn(async (prefix) => {
            const settings = SillyTavern.getContext().extensionSettings.worldbook_organizer;
            settings.overrideEnhancedDropdownStyle = true;
            const core = await import(`${prefix}src/core.js`);
            (await import(`${prefix}src/native-filter.js`)).applyAllNativeWorldFilters(core.classifyWorldbooks({ worldNames: ['测试书甲', '测试书乙'], bindingMap: new Map(), settings }), settings);
        }, prefix);
        assert.equal(await cdp.evalFn(() => document.getElementById('gr-global-dropdown-container').hasAttribute('data-wbo-enhanced-host-theme')), true);
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.notEqual((await colors()).background, 'rgb(30, 29, 35)');
    });
});

for (const viewport of [VIEWPORTS.desktop, VIEWPORTS.mobile]) {
    test(`group expansion tracks available width and changed captions at ${viewport.name}`, async (t) => {
        await withHost(viewport, async (cdp) => {
            await cdp.evalFn(async (prefix) => {
                const settings = SillyTavern.getContext().extensionSettings.worldbook_organizer;
                Object.assign(settings, {
                    groups: [{ id: 'sample', name: '分类' }], assignments: { '测试书甲': 'sample' },
                });
                const core = await import(`${prefix}src/core.js`);
                (await import(`${prefix}src/native-filter.js`)).applyAllNativeWorldFilters(core.classifyWorldbooks({ worldNames: ['测试书甲', '测试书乙'], bindingMap: new Map(), settings }), settings, { force: true });
                // Exercise the common strip with Select2 on both emulated input types.
                if (!jQuery('#world_info').data('select2')) jQuery('#world_info').select2({ closeOnSelect: false });
                jQuery('#world_info').select2('open');
            }, prefix);
            await waitForCondition(cdp, () => document.querySelector('.wbo-global-dd-bar'));
            const resize = (width) => cdp.evalFn((width) => {
                const dropdown = document.querySelector('.select2-dropdown');
                dropdown.style.setProperty('min-width', '0', 'important');
                dropdown.style.setProperty('width', `${width}px`, 'important');
            }, width);
            await resize(600);
            await waitForCondition(cdp, () => document.querySelector('.wbo-global-dd-bar .wbo-dd-expand-btn').hidden);
            await cdp.evalFn(() => {
                document.querySelector('.wbo-global-dd-bar [data-wbo-pill="sample"]').textContent = '用于验证容器实际可用宽度的较长分组名称'.repeat(4);
            });
            await waitForCondition(cdp, () => !document.querySelector('.wbo-global-dd-bar .wbo-dd-expand-btn').hidden);
            await cdp.evalFn(() => document.querySelector('.wbo-global-dd-bar .wbo-dd-expand-btn').click());
            assert.equal(await cdp.evalFn(() => document.querySelector('.wbo-global-dd-bar .wbo-dd-expand-btn').getAttribute('aria-expanded')), 'true');
            await cdp.evalFn(() => {
                document.querySelector('.wbo-global-dd-bar [data-wbo-pill="sample"]').textContent = '分类';
            });
            await waitForCondition(cdp, () => document.querySelector('.wbo-global-dd-bar .wbo-dd-expand-btn').hidden);
            for (const width of [110, 600, 110, 600]) {
                await resize(width);
                await new Promise((resolve) => setTimeout(resolve, 100));
                t.diagnostic(JSON.stringify(await cdp.evalFn(() => {
                    const pills = document.querySelector('.wbo-global-dd-bar .wbo-dd-pill-scroll');
                    return { width: pills.clientWidth, total: pills.scrollWidth, hidden: document.querySelector('.wbo-global-dd-bar .wbo-dd-expand-btn').hidden };
                })));
                if (width === 600) await waitForCondition(cdp, () => document.querySelector('.wbo-global-dd-bar .wbo-dd-expand-btn').hidden);
                else await waitForCondition(cdp, () => !document.querySelector('.wbo-global-dd-bar .wbo-dd-expand-btn').hidden);
            }
        });
    });
}
