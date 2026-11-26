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
const { openManager, resetAndBoot, waitForCondition } = await load('assert-helpers.mjs');

const favorite = '收藏测试书';
const globalBook = '全局测试书';
const other = '普通测试书';
const characterBook = '角色测试书';
const seed = (extraBooks = []) => createDefaultSeed({
    characters: [{ avatar: 'example.png', name: '测试角色', data: { extensions: { world: characterBook } } }],
    worldbooks: Object.fromEntries([favorite, globalBook, other, characterBook, ...extraBooks].map((name) => [name, { entries: {} }])),
    selected_world_info: [globalBook],
    pluginSettings: {
        showCharBooks: true, hideCharBooksByDefault: false, autoScanNewCharacters: false,
        charGroupCollapsed: false, activeFilterGroupId: '__all__',
        groups: [{ id: 'g-a', name: '测试分组甲' }, { id: 'g-b', name: '测试分组乙' }],
        assignments: { [favorite]: 'g-a', [globalBook]: 'g-b', [other]: 'g-b' },
        pinnedBooks: [favorite], globalHiddenGroupIds: [], editorHiddenGroupIds: [],
    },
});

async function withHost(viewport, verify, extraBooks, fixture = seed(extraBooks)) {
    const server = createMockStServer();
    const baseUrl = await server.start();
    let cdp;
    try {
        cdp = await launchEdgeCdp();
        await resetAndBoot(cdp, baseUrl, { seed: fixture, viewport });
        await verify(cdp);
        assert.deepEqual(cdp.getErrors().runtimeErrors, []);
    } finally {
        await cdp?.close();
        await server.stop();
    }
}

test('desktop native global picker keeps its search, filters by group and opens on 收藏', async () => {
    await withHost(VIEWPORTS.desktop, async (cdp) => {
        await cdp.clickSelector('#WIMultiSelector .select2-container');
        await waitForCondition(cdp, () => !!document.querySelector('.wbo-global-dd-bar'));
        const activePill = () => cdp.evalFn(() => document.querySelector('.wbo-global-dd-bar .is-active')?.textContent);
        const visible = () => cdp.evalFn(() => [...document.querySelectorAll('.select2-dropdown [data-wbo-world]')]
            .filter((row) => row.getBoundingClientRect().height > 0).map((row) => row.dataset.wboWorld));
        const groupBadges = () => cdp.evalFn(() => [...document.querySelectorAll('.select2-dropdown .wbo-s2-badge:not(.is-editing)')]
            .filter((badge) => badge.getBoundingClientRect().height > 0).map((badge) => badge.textContent.trim()));
        assert.equal(await activePill(), '收藏 1');
        assert.deepEqual(await visible(), [favorite]);
        assert.deepEqual(await groupBadges(), ['测试分组甲']);
        await cdp.evalFn(() => { document.querySelector('.select2-dropdown').style.width = '640px'; });
        await waitForCondition(cdp, () => document.querySelector('.wbo-global-dd-bar .wbo-dd-expand-btn').hidden);
        await cdp.clickSelector('.wbo-global-dd-bar [data-wbo-pill="__all__"]');
        assert.equal(await cdp.evalFn(() => document.querySelector('.select2-results__options').firstElementChild.textContent), '收藏');
        assert.equal((await visible())[0], favorite);
        await cdp.clickSelector('.wbo-global-dd-bar [data-wbo-pill="g-b"]');
        assert.deepEqual((await visible()).sort(), [globalBook, other].sort());
        assert.deepEqual(await groupBadges(), []);
        await cdp.typeInto('.select2-dropdown .select2-search__field', '普通');
        assert.deepEqual(await visible(), [other]);
        assert.deepEqual(await groupBadges(), []);
        await cdp.clickSelector('.wbo-global-dd-bar [data-wbo-pill="__all__"]');
        assert.deepEqual(await groupBadges(), ['测试分组乙']);
        await cdp.evalFn(() => { window.jQuery('#world_info').select2('close').select2('open'); });
        await waitForCondition(cdp, () => document.querySelector('.wbo-global-dd-bar .is-active')?.textContent === '收藏 1');
        assert.deepEqual(await visible(), [favorite]);
    });
});

test('global picker recovers from an abandoned display without refreshing', async () => {
    await withHost(VIEWPORTS.desktop, async (cdp) => {
        const installStaleDisplay = () => cdp.evalFn(() => {
            const style = document.createElement('style');
            style.dataset.grDropdownStyle = '1';
            document.head.append(style);
            const native = document.querySelector('#WIMultiSelector .select2-container');
            native.style.display = 'none';
            const display = document.createElement('div');
            display.className = 'gr-select2-display';
            display.style.cssText = 'cursor:pointer;min-height:30px';
            display.dataset.grSelectId = 'world_info';
            const chip = document.createElement('span');
            chip.className = 'gr-select2-chip';
            chip.dataset.value = document.getElementById('world_info').selectedOptions[0].value;
            chip.innerHTML = '<span>已选世界书</span><button type="button" class="gr-select2-chip-remove">×</button>';
            display.append(chip);
            native.before(display);
        });
        await installStaleDisplay();
        await cdp.evalFn(() => document.querySelector('style[data-gr-dropdown-style]').remove());
        await waitForCondition(cdp, () => !document.querySelector('#WIMultiSelector .gr-select2-display'));
        await cdp.clickSelector('#WIMultiSelector .select2-container');
        await waitForCondition(cdp, () => Boolean(document.querySelector('.wbo-global-dd-bar')));
        await cdp.evalFn(() => window.jQuery('#world_info').select2('close'));

        await installStaleDisplay();
        await cdp.clickSelector('#WIMultiSelector .gr-select2-display');
        await waitForCondition(cdp, () => !document.querySelector('#WIMultiSelector .gr-select2-display') && Boolean(document.querySelector('.wbo-global-dd-bar')));
        assert.deepEqual(await cdp.evalFn(() => [...document.getElementById('world_info').selectedOptions].map((option) => option.textContent)), [globalBook]);
        await cdp.evalFn(() => window.jQuery('#world_info').select2('close'));
        await installStaleDisplay();
        await cdp.evalFn(() => window.__ST_TEST_HELPERS__.openGrGlobalPopover());
        await waitForCondition(cdp, () => document.querySelector('#gr-global-dropdown-container .wbo-pop-filter-bar'));
        await cdp.evalFn(() => {
            const display = document.querySelector('#WIMultiSelector .gr-select2-display');
            display.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
            display.click();
        });
        await waitForCondition(cdp, () => !document.getElementById('gr-global-dropdown-container') && !document.querySelector('#WIMultiSelector .gr-select2-display'));
        await installStaleDisplay();
        await cdp.clickSelector('#WIMultiSelector .gr-select2-chip-remove');
        await waitForCondition(cdp, () => !document.querySelector('#WIMultiSelector .gr-select2-display') && document.getElementById('world_info').selectedOptions.length === 0);
    });
});

test('shared enhanced dropdown uses the actual opener, friendly role titles and one favorite control', async () => {
    const secondBook = '另一角色原文件名';
    const extras = Array.from({ length: 35 }, (_, index) => `样例长列表 ${index}`);
    const statuses = ['全部状态', '仅已开启', '仅已关闭'];
    const fixture = seed([secondBook, ...extras, ...statuses]);
    fixture.characters.push({ avatar: 'second.png', name: '另一测试角色', data: { extensions: { world: secondBook } } });
    fixture.extension_settings.worldbook_organizer.pinnedBooks = [];
    await withHost(VIEWPORTS.desktop, async (cdp) => {
        const openShared = (id) => cdp.evalFn((selectId, primary) => {
            document.getElementById('gr-global-dropdown-container')?.remove();
            const select = document.getElementById(selectId);
            select.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            const container = document.createElement('div');
            container.id = 'gr-global-dropdown-container';
            container.className = 'gr-container-enhanced open';
            container.style.cssText = 'position:fixed;top:150px;left:20px;width:400px;z-index:9000;background:white;color:#28394b';
            const scroller = document.createElement('div');
            scroller.className = 'gr-options';
            scroller.style.cssText = 'display:block;max-height:160px;overflow:auto';
            scroller.innerHTML = '<input type="search" spellcheck="false"><div class="gr-options-container"></div>';
            const options = scroller.querySelector('.gr-options-container');
            for (const [index, option] of [...select.options].entries()) {
                if (selectId === 'world_editor_select' && option.textContent === primary) {
                    const head = document.createElement('div');
                    head.className = 'gr-group-label';
                    head.textContent = '角色世界书';
                    options.append(head);
                }
                const row = document.createElement('div');
                row.className = 'gr-option';
                row.style.minHeight = '29px';
                row.dataset.index = String(index);
                row.dataset.value = option.value;
                row.textContent = option.textContent;
                row.classList.toggle('selected', selectId === 'world_editor_select' ? option.value === '' : option.selected);
                if (selectId === 'world_info') {
                    row.classList.add('has-pin');
                    row.insertAdjacentHTML('beforeend', '<span class="gr-option-pin"><svg viewBox="0 0 12 12"><path d="M0 0H12V12Z"/></svg></span>');
                }
                options.append(row);
            }
            container.append(scroller);
            document.body.append(container);
            if (selectId === 'world_info') {
                setTimeout(() => {
                    scroller.scrollTop = 600;
                    container.dataset.hostAutoScroll = String(scroller.scrollTop);
                }, 65);
            }
        }, id, characterBook);

        await cdp.evalFn((name) => {
            const select = document.getElementById('world_editor_select');
            const chosen = [...select.options].find((item) => item.textContent === name);
            window.jQuery(select).val(chosen.value).trigger('change');
        }, characterBook);
        await openShared('world_editor_select');
        await waitForCondition(cdp, () => document.querySelector('#gr-global-dropdown-container[data-wbo-popover-role="editor"] [data-wbo-editing-badge]'));
        const state = await cdp.evalFn((primary, secondary) => {
            const pop = document.querySelector('#gr-global-dropdown-container');
            const row = (name) => [...pop.querySelectorAll('.gr-option')].find((item) => item.dataset.wboEnhancedWorld === name);
            return {
                primaryTitle: row(primary)?.querySelector('.wbo-gr-world-title')?.firstChild.textContent,
                secondaryTitle: row(secondary)?.querySelector('.wbo-gr-world-title')?.firstChild.textContent,
                primarySection: row(primary)?.closest('.wbo-pop-section')?.dataset.wboDdGroup ?? null,
                selected: [...pop.querySelectorAll('.gr-option.selected')].map((item) => item.dataset.wboEnhancedWorld),
                placeholder: pop.querySelector('.gr-option[data-value=""]').textContent,
            };
        }, characterBook, secondBook);
        assert.deepEqual(state, { primaryTitle: '测试角色', secondaryTitle: '另一测试角色', primarySection: null, selected: [characterBook], placeholder: '清除当前选择' });

        await openShared('world_info_sort_order');
        assert.equal(await cdp.evalFn(() => Boolean(document.querySelector('#gr-global-dropdown-container .wbo-pop-filter-bar, #gr-global-dropdown-container .wbo-gr-pin-btn'))), false);

        await cdp.evalFn((name) => {
            const select = document.createElement('select');
            select.id = 'fixture-preset-dropdown';
            const option = document.createElement('option');
            option.value = '0';
            option.textContent = name;
            select.append(option);
            document.body.append(select);
        }, characterBook);
        await openShared('fixture-preset-dropdown');
        await waitForCondition(cdp, () => document.querySelector('#gr-global-dropdown-container[data-wbo-source-role="other"]'));
        assert.equal(await cdp.evalFn(() => Boolean(document.querySelector('#gr-global-dropdown-container .wbo-pop-filter-bar, #gr-global-dropdown-container .wbo-gr-pin-btn, #gr-global-dropdown-container .wbo-enhanced-sticky'))), false);

        await cdp.evalFn(async (labels) => {
            document.getElementById('gr-global-dropdown-container').remove();
            await new Promise((resolve) => setTimeout(resolve, 780));
            const menu = document.createElement('div');
            menu.id = 'gr-global-dropdown-container';
            menu.className = 'gr-container-enhanced open';
            menu.innerHTML = '<div class="gr-options"><div class="gr-options-container"><div class="gr-option gr-theme-toggle">切换到黑夜主题</div><div class="gr-option gr-filter-toggle">开启选中项置顶</div></div></div>';
            const list = menu.querySelector('.gr-options-container');
            for (const [index, label] of labels.entries()) {
                const row = document.createElement('div');
                row.className = 'gr-option';
                row.dataset.value = ['all', 'enabled', 'disabled'][index];
                row.textContent = label;
                list.append(row);
            }
            document.body.append(menu);
            await new Promise(requestAnimationFrame);
        }, statuses);
        assert.deepEqual(await cdp.evalFn(() => {
            const menu = document.getElementById('gr-global-dropdown-container');
            return {
                decorated: Boolean(menu.querySelector('.wbo-dd-filter-bar, .wbo-gr-pin-btn, .wbo-pop-section')),
                commands: [...menu.querySelectorAll('.gr-theme-toggle, .gr-filter-toggle')].map((row) => row.textContent),
            };
        }), { decorated: false, commands: ['切换到黑夜主题', '开启选中项置顶'] });

        await openShared('world_info');
        await waitForCondition(cdp, () => {
            const pop = document.querySelector('#gr-global-dropdown-container[data-wbo-popover-role="global"]');
            return Number(pop?.dataset.hostAutoScroll) > 0 && pop.querySelector('.gr-options').scrollTop === 0;
        });
        const sticking = await cdp.evalFn(async () => {
            await new Promise((resolve) => setTimeout(resolve, 220));
            const scroll = document.querySelector('#gr-global-dropdown-container .gr-options');
            const header = scroll.querySelector('.wbo-enhanced-sticky');
            const before = header.getBoundingClientRect().top;
            scroll.scrollTop = 200;
            return { scrollTop: scroll.scrollTop, retained: Math.abs(header.getBoundingClientRect().top - before) < 2 };
        });
        assert.ok(sticking.scrollTop > 0);
        assert.equal(sticking.retained, true);
        const theme = await cdp.evalFn(async () => {
            const sticky = document.querySelector('.wbo-enhanced-sticky');
            const idle = sticky.querySelector('.wbo-dd-pill:not(.is-active)');
            const active = sticky.querySelector('.wbo-dd-pill.is-active');
            const heading = document.querySelector('.wbo-pop-section .wbo-dd-group-head');
            const colors = () => [getComputedStyle(idle).color, getComputedStyle(active).color, getComputedStyle(heading).backgroundColor];
            const day = colors();
            document.body.classList.add('dark-mode');
            await new Promise((resolve) => setTimeout(resolve, 150));
            const night = colors();
            document.body.classList.remove('dark-mode');
            return { day, night };
        });
        assert.ok(theme.day.every((color, index) => color !== theme.night[index]), JSON.stringify(theme));
        const pin = '#gr-global-dropdown-container [data-pin-world="普通测试书"]';
        assert.equal(await cdp.evalFn((selector) => document.querySelector(selector).closest('.gr-option').querySelectorAll('.gr-option-pin').length, pin), 1);
        assert.equal(await cdp.evalFn((selector) => document.querySelector(`${selector} svg path`).getAttribute('d'), pin), 'M0 0H12V12Z');
        await cdp.evalFn((selector) => document.querySelector(selector).click(), pin);
        assert.equal(await cdp.evalFn((selector) => document.querySelector(selector).getAttribute('aria-pressed'), pin), 'true');

    }, [], fixture);
});

test('native sort can open and switch repeatedly without dismissing the world editor', async () => {
    for (const viewport of [VIEWPORTS.desktop, VIEWPORTS.mobile]) {
        await withHost(viewport, async (cdp) => {
            await cdp.evalFn(() => {
                const drawer = document.getElementById('WorldInfo');
                drawer.classList.add('openDrawer');
                drawer.classList.remove('closedDrawer');
                document.getElementById('WI_panel_pin').checked = false;
                const select = document.getElementById('world_info_sort_order');
                select.options[0].textContent = '优先级';
                select.options[1].textContent = '标题升序';
                select.options[2].textContent = '自定义排序';
                select.value = '2';
                window.fixtureSortChanges = 0;
                select.addEventListener('change', () => window.fixtureSortChanges++);
                document.addEventListener('mousedown', (event) => {
                    if (event.target !== select) return;
                    event.preventDefault();
                    const openMenu = document.getElementById('gr-global-dropdown-container');
                    if (openMenu) {
                        openMenu.remove();
                        return;
                    }
                    const menu = document.createElement('div');
                    menu.id = 'gr-global-dropdown-container';
                    menu.className = 'gr-container-enhanced open';
                    const { left, top, height } = select.getBoundingClientRect();
                    menu.style.cssText = `position:fixed;left:${Math.min(left, innerWidth - 160)}px;top:${Math.min(top, innerHeight - 200)}px;width:150px;min-width:0;height:${height}px;overflow:visible;padding:0;border:0;z-index:20000;background:white;color:black`;
                    const options = document.createElement('div');
                    options.className = 'gr-options-container';
                    options.style.cssText = `position:absolute;top:${height}px;width:100%;background:white`;
                    for (const option of select.options) {
                        const row = document.createElement('div');
                        row.className = 'gr-option';
                        row.dataset.value = option.value;
                        row.textContent = option.textContent;
                        row.style.minHeight = '28px';
                        row.addEventListener('mousedown', (press) => {
                            press.preventDefault();
                            option.selected = true;
                            select.dispatchEvent(new Event('change', { bubbles: true }));
                            menu.remove();
                        });
                        options.append(row);
                    }
                    menu.append(options);
                    document.body.append(menu);
                    document.addEventListener('click', (click) => click.stopImmediatePropagation(), { capture: true, once: true });
                }, true);
            });

            for (const [index, value] of ['1', '0', '2'].entries()) {
                await cdp.clickSelector('#world_info_sort_order');
                await waitForCondition(cdp, () => document.querySelector('#gr-global-dropdown-container .gr-option'));
                assert.equal(await cdp.evalFn(() => Boolean(document.querySelector('#gr-global-dropdown-container .wbo-pop-filter-bar, #gr-global-dropdown-container .wbo-gr-pin-btn'))), false);
                const hit = await cdp.clickSelector(`#gr-global-dropdown-container .gr-option[data-value="${value}"]`, { scroll: false });
                assert.equal(hit.hit, true, `Sort option click at ${hit.cx},${hit.cy} hit ${hit.topTag} ${hit.topCls}`);
                // A detached popup row can leave the click on the body, outside the drawer.
                await cdp.evalFn(() => document.body.click());
                assert.deepEqual(await cdp.evalFn(() => ({
                    open: document.getElementById('WorldInfo').classList.contains('openDrawer'),
                    value: document.getElementById('world_info_sort_order').value,
                    changes: window.fixtureSortChanges,
                })), { open: true, value, changes: index + 1 });
            }
            await cdp.clickSelector('#host-outside-blank');
            assert.equal(await cdp.evalFn(() => document.getElementById('WorldInfo').classList.contains('closedDrawer')), true);
        });
    }
});

test('preset group switching is offered only when the compatible script is detected and stays opt-in', async () => {
    await withHost(VIEWPORTS.desktop, async (cdp) => {
        const setting = '[data-setting="adaptEnhancedPresetGroups"]';
        const openSettings = async () => {
            await openManager(cdp);
            await cdp.clickSelector('#wbo-manager-overlay [data-action="open-settings-modal"]');
            await cdp.clickSelector('[data-settings-tab="behavior"]');
        };
        const closeSettings = async () => {
            await cdp.clickSelector('#wbo-settings-close-btn');
            await cdp.clickSelector('#wbo-manager-overlay .wbo-modal-close');
        };
        await openSettings();
        assert.equal(await cdp.evalFn((selector) => Boolean(document.querySelector(selector)), setting), false);
        await closeSettings();

        await cdp.evalFn(() => {
            window.TavernHelper = { getScriptTrees: () => [{ type: 'folder', scripts: [{ type: 'script', enabled: false,
                content: 'gr-global-dropdown-container gr-select2-display data-gr-dropdown-style' }] }] };
        });
        await openSettings();
        assert.equal(await cdp.evalFn((selector) => document.querySelector(selector)?.checked, setting), false);
        await closeSettings();

        const openPreset = () => cdp.evalFn(() => {
            document.getElementById('gr-global-dropdown-container')?.remove();
            if (!document.querySelector('style[data-gr-dropdown-style]')) {
                const marker = document.createElement('style');
                marker.dataset.grDropdownStyle = '1';
                document.head.append(marker);
            }
            let select = document.getElementById('settings_preset_openai');
            if (!select) {
                select = document.createElement('select');
                select.id = 'settings_preset_openai';
                select.innerHTML = '<option value="1">测试方案甲</option><option value="2">测试方案乙</option>';
                document.body.append(select);
            }
            select.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            const pop = document.createElement('div');
            pop.id = 'gr-global-dropdown-container';
            pop.className = 'gr-container-enhanced open';
            pop.style.cssText = 'position:fixed;top:120px;left:20px;width:320px;z-index:9000;background:white';
            pop.innerHTML = `<div class="gr-options"><div class="gr-search-box"><input type="search" placeholder="搜索选项" spellcheck="false"></div>
                <div class="gr-options-container">
                    <div class="gr-group-label">预设测试组甲</div><div class="gr-option">测试方案甲<span class="gr-option-pin"></span></div>
                    <div class="gr-group-label">预设测试组乙</div><div class="gr-option">测试方案乙<span class="gr-option-pin"></span></div>
                </div></div>`;
            document.body.append(pop);
        });
        await openPreset();
        await waitForCondition(cdp, () => document.querySelector('[data-wbo-source-role="preset"]'));
        assert.equal(await cdp.evalFn(() => Boolean(document.querySelector('.wbo-preset-filter-bar'))), false);
        await cdp.evalFn(() => document.getElementById('gr-global-dropdown-container').remove());
        await openSettings();
        await cdp.clickSelector(setting);
        await closeSettings();
        await openPreset();
        await waitForCondition(cdp, () => document.querySelector('.wbo-preset-filter-bar'));
        await cdp.clickSelector('.wbo-preset-filter-bar [data-wbo-pill="2"]');
        const state = await cdp.evalFn(() => {
            const pop = document.querySelector('#gr-global-dropdown-container');
            return {
                visible: [...pop.querySelectorAll('.gr-option:not(.wbo-preset-group-hidden)')].map((row) => row.textContent.trim()),
                nativePins: pop.querySelectorAll('.gr-option-pin:not(.wbo-gr-pin-btn)').length,
                search: pop.querySelector('.gr-search-box input').placeholder,
                selection: document.getElementById('settings_preset_openai').value,
            };
        });
        assert.deepEqual(state, { visible: ['测试方案乙'], nativePins: 2, search: '搜索选项', selection: '1' });
        await cdp.evalFn(() => document.querySelector('style[data-gr-dropdown-style]').remove());
        await waitForCondition(cdp, () => !document.querySelector('.wbo-preset-filter-bar, .wbo-preset-group-hidden'));
    });
});

test('mobile global dropdown handles direct option rows without native search', async () => {
    await withHost(VIEWPORTS.mobile, async (cdp) => {
        await cdp.evalFn(() => {
            window.__ST_TEST_HELPERS__.openGrGlobalPopover();
            const pop = document.getElementById('gr-global-dropdown-container');
            const rows = [...pop.querySelectorAll('.gr-option')];
            for (const row of rows) {
                const badge = document.createElement('span');
                badge.textContent = '原生标签';
                row.appendChild(badge);
            }
            pop.replaceChildren(...rows);
        });
        const pop = '#gr-global-dropdown-container';
        const bar = `${pop} .wbo-pop-filter-bar`;
        await waitForCondition(cdp, () => !!document.querySelector('#gr-global-dropdown-container .wbo-pop-search'));
        const activePill = () => cdp.evalFn(() => document.querySelector('#gr-global-dropdown-container .wbo-pop-filter-bar .is-active')?.textContent);
        const visible = () => cdp.evalFn(() => [...document.querySelectorAll('#gr-global-dropdown-container .gr-option')]
            .filter((row) => row.getBoundingClientRect().height > 0)
            .map((row) => row.querySelector('[data-pin-world]').getAttribute('data-pin-world')));
        assert.equal(await activePill(), '收藏 1');
        assert.deepEqual(await visible(), [favorite]);
        assert.equal(await cdp.evalFn(() => document.querySelector('.wbo-pop-search').getAttribute('spellcheck')), 'false');
        await cdp.clickSelector(`${bar} [data-wbo-pill="__all__"]`);
        assert.match(await cdp.evalFn(() => document.querySelector('#gr-global-dropdown-container .wbo-dd-group-head').textContent), /收藏/);
        assert.equal((await visible())[0], favorite);
        await cdp.clickSelector(`${bar} [data-wbo-pill="g-b"]`);
        await cdp.typeInto(`${pop} .wbo-pop-search`, '普通');
        await waitForCondition(cdp, () => document.querySelector('.gr-option.wbo-pop-search-hidden'));
        assert.deepEqual(await visible(), [other]);
        await cdp.evalFn(() => {
            const pop = document.getElementById('gr-global-dropdown-container');
            pop.style.width = '185px';
            pop.style.minWidth = '0';
        });
        await waitForCondition(cdp, () => !document.querySelector('.wbo-pop-filter-bar .wbo-dd-expand-btn').hidden);
        await cdp.clickSelector(`${bar} .wbo-dd-expand-btn`);
        await cdp.evalFn(() => { document.getElementById('gr-global-dropdown-container').style.width = '500px'; });
        await waitForCondition(cdp, () => document.querySelector('.wbo-pop-filter-bar .wbo-dd-expand-btn').hidden);
    });
});

test('active global books appear after character books in the manager and return to their group when disabled', async () => {
    await withHost(VIEWPORTS.desktop, async (cdp) => {
        await openManager(cdp);
        const groups = await cdp.evalFn(() => [...document.querySelectorAll('#wbo-mgr-groups-list > .wbo-group')].map((group) => group.dataset.groupId));
        assert.deepEqual(groups.slice(0, 3), ['__char__', '__active_globals__', '__pinned__']);
        const row = `.wbo-book-item[data-book="${globalBook}"]`;
        assert.equal(await cdp.evalFn((selector) => document.querySelectorAll(selector).length, row), 1);
        await cdp.clickSelector(`[data-group-id="__active_globals__"] ${row} [data-action="toggle-global"]`);
        await waitForCondition(cdp, () => !document.querySelector('.wbo-group[data-group-id="__active_globals__"]'));
        assert.ok(await cdp.evalFn((selector) => document.querySelector(selector)?.closest('.wbo-group')?.dataset.groupId === 'g-b', row));
    });
});

test('the native editor moves its 当前编辑 badge when the selected book changes', async () => {
    await withHost(VIEWPORTS.desktop, async (cdp) => {
        const choose = (name) => cdp.evalFn((nextName) => {
            const select = document.getElementById('world_editor_select');
            const option = [...select.options].find((item) => item.textContent === nextName);
            window.jQuery(select).val(option.value).trigger('change');
        }, name);
        await choose(favorite);
        await cdp.evalFn(() => { window.jQuery('#world_editor_select').select2('open'); });
        const badges = () => cdp.evalFn(() => [...document.querySelectorAll('.select2-dropdown [data-wbo-editing-badge]')]
            .map((item) => item.closest('[data-wbo-world]').dataset.wboWorld));
        assert.deepEqual(await badges(), [favorite]);
        await choose(other);
        await waitForCondition(cdp, () => document.querySelector('.select2-dropdown [data-wbo-editing-badge]')?.closest('[data-wbo-world]')?.dataset.wboWorld === '普通测试书');
        assert.deepEqual(await badges(), [other]);
    });
});

test('selecting a book in a long editor list restores its original visible position', async () => {
    const books = Array.from({ length: 38 }, (_, i) => `位置测试书 ${String(i + 1).padStart(2, '0')}`);
    const selected = books[20];
    for (const viewport of [VIEWPORTS.desktop, VIEWPORTS.mobile]) {
        await withHost(viewport, async (cdp) => {
            const open = viewport.mobile
                ? () => cdp.clickSelector('#wbo-mobile-editor-trigger')
                : () => cdp.evalFn(() => { window.jQuery('#world_editor_select').select2('open'); });
            const list = viewport.mobile ? '#wbo-mp-list' : '.select2-dropdown .select2-results__options';
            const row = viewport.mobile ? `[data-mp-world="${selected}"]` : `[data-wbo-world="${selected}"]`;
            const readOffset = (move) => cdp.evalFn((listSelector, rowSelector, shouldMove) => {
                const listEl = document.querySelector(listSelector);
                const rowEl = listEl?.querySelector(rowSelector);
                if (!rowEl) return null;
                let scrollHost = rowEl.parentElement;
                while (scrollHost !== listEl && !(getComputedStyle(scrollHost).overflowY === 'auto' && scrollHost.scrollHeight > scrollHost.clientHeight)) {
                    scrollHost = scrollHost.parentElement;
                }
                if (shouldMove) {
                    if (scrollHost !== listEl) listEl.scrollTop += scrollHost.getBoundingClientRect().top - listEl.getBoundingClientRect().top - 20;
                    scrollHost.scrollTop += rowEl.getBoundingClientRect().top - scrollHost.getBoundingClientRect().top - 100;
                }
                return rowEl.getBoundingClientRect().top - listEl.getBoundingClientRect().top;
            }, list, row, move);
            await open();
            const offset = await readOffset(true);
            assert.ok(typeof offset === 'number' && offset >= 90 && offset <= 155, `${viewport.name} available offset ${offset}`);
            await cdp.clickSelector(`${list} ${row}`, { scroll: false });
            const selectedName = await cdp.evalFn(() => document.getElementById('world_editor_select').selectedOptions[0]?.textContent);
            assert.equal(selectedName, selected);
            await open();
            await cdp.evalFn(() => new Promise((resolve) => setTimeout(resolve, 260)));
            const restored = await readOffset(false);
            const details = await cdp.evalFn((listSelector, rowSelector) => {
                const listEl = document.querySelector(listSelector);
                const rowEl = listEl?.querySelector(rowSelector);
                return [listEl?.scrollTop, listEl?.clientHeight, listEl?.scrollHeight, rowEl?.closest('.wbo-mp-sec')?.className];
            }, list, row);
            assert.ok(typeof restored === 'number' && Math.abs(restored - offset) <= 2, `${viewport.name} restored to ${restored} from ${offset} (${details.join(', ')})`);
        }, books);
    }
});

test('mobile manager can be resized and moved by touch and returned to full screen', async () => {
    await withHost(VIEWPORTS.mobile, async (cdp) => {
        await openManager(cdp);
        const panel = '.wbo-manager-modal';
        const rect = (selector) => cdp.evalFn((target) => document.querySelector(target).getBoundingClientRect().toJSON(), selector);
        const drag = async (selector, dx, dy) => {
            const box = await rect(selector);
            assert.ok(box.width && box.height);
            const x = Math.round(box.left + box.width / 2);
            const y = Math.round(box.top + box.height / 2);
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
            for (let step = 1; step <= 5; step++) {
                await cdp.send('Input.dispatchTouchEvent', {
                    type: 'touchMove', touchPoints: [{ x: x + dx * step / 5, y: y + dy * step / 5, id: 1 }],
                });
            }
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        };
        const full = await rect(panel);
        await drag(`${panel} .wbo-resize-se`, -55, -240);
        const smaller = await rect(panel);
        assert.ok(smaller.width < full.width && smaller.height < full.height);
        await drag(`${panel} .wbo-modal-title`, 65, 270);
        const moved = await rect(panel);
        assert.ok(moved.left > smaller.left && moved.top > smaller.top);
        assert.ok(moved.right >= 376 && moved.bottom >= 830);
        await cdp.clickSelector('#wbo-mgr-search-input', { scroll: false });
        assert.equal(await cdp.evalFn(() => document.activeElement?.id), 'wbo-mgr-search-input');
        await cdp.resizeViewport(390, 450);
        const closeBtn = await rect(`${panel} .wbo-modal-close`);
        assert.ok(closeBtn.top >= 0 && closeBtn.bottom <= 450);
        assert.equal(await cdp.evalFn(() => document.activeElement?.id), 'wbo-mgr-search-input');
        await cdp.resizeViewport(390, 844);
        assert.deepEqual(await rect(panel), moved);
        await cdp.clickSelector('[data-wbo-fullscreen-btn]');
        assert.equal((await rect(panel)).height, full.height);
    });
});
