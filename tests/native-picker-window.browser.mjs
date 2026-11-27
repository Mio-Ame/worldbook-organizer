import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
        await openManager(cdp);
        assert.deepEqual(await cdp.evalFn(() => [
            document.querySelector('#wbo-mgr-floating-tools-btn'),
            document.querySelector('[data-wbo-fullscreen-btn="manager"]'),
        ].map((button) => getComputedStyle(button).display)), ['none', 'none']);
        await cdp.clickSelector('#wbo-mgr-pills [data-group-id="__pinned__"]');
        assert.equal(await cdp.evalFn(() => {
            const group = document.querySelector('#wbo-mgr-groups-list [data-group-id="__pinned__"]');
            return Boolean(group)
                && Boolean(group.querySelector('.wbo-group-toggle.is-static'))
                && !group.querySelector('.wbo-chevron');
        }), true);
        await cdp.clickSelector('.wbo-manager-modal .wbo-modal-close');
        await cdp.clickSelector('#WIMultiSelector .select2-container');
        await waitForCondition(cdp, () => !!document.querySelector('.wbo-global-dd-bar'));
        const activePill = () => cdp.evalFn(() => document.querySelector('.wbo-global-dd-bar .is-active')?.textContent);
        const visible = () => cdp.evalFn(() => [...document.querySelectorAll('.select2-dropdown [data-wbo-world]')]
            .filter((row) => row.getBoundingClientRect().height > 0).map((row) => row.dataset.wboWorld));
        const groupBadges = () => cdp.evalFn(() => [...document.querySelectorAll('.select2-dropdown .wbo-s2-badge:not(.is-editing)')]
            .filter((badge) => badge.getBoundingClientRect().height > 0).map((badge) => badge.textContent.trim()));
        assert.equal(await activePill(), '已收藏 1');
        assert.deepEqual(await visible(), [favorite]);
        assert.deepEqual(await groupBadges(), ['测试分组甲']);
        await cdp.evalFn(() => { document.querySelector('.select2-dropdown').style.width = '640px'; });
        await waitForCondition(cdp, () => document.querySelector('.wbo-global-dd-bar .wbo-dd-expand-btn').hidden);
        await cdp.clickSelector('.wbo-global-dd-bar [data-wbo-pill="__all__"]');
        const groupHeads = () => cdp.evalFn(() => [...document.querySelectorAll('.select2-results__options > li.wbo-global-group-head')]
            .map((head) => `${head.textContent.trim()}|${head.getAttribute('aria-expanded')}`));
        assert.deepEqual(await groupHeads(), ['已开启的全局世界书 (1)|true', '已收藏 (1)|true', '角色世界书 (1)|true', '测试分组乙 (1)|true']);
        assert.deepEqual(await cdp.evalFn(() => [...document.querySelectorAll('li.wbo-global-group-head')]
            .map((head) => getComputedStyle(head, '::before').width)), ['7px', '7px', '7px', '7px']);
        // Mounted globals open the list, favorites come right after them.
        assert.deepEqual(await visible(), [globalBook, favorite, characterBook, other]);
        const foldHead = (label) => cdp.evalFn((text) => {
            const head = [...document.querySelectorAll('li.wbo-global-group-head')].find((el) => el.textContent.includes(text));
            if (!head) return false;
            head.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
            return true;
        }, label);
        assert.equal(await foldHead('已收藏'), true);
        assert.deepEqual(await visible(), [globalBook, characterBook, other]);
        assert.deepEqual(await groupHeads(), ['已开启的全局世界书 (1)|true', '已收藏 (1)|false', '角色世界书 (1)|true', '测试分组乙 (1)|true']);
        await foldHead('已收藏');
        assert.deepEqual(await visible(), [globalBook, favorite, characterBook, other]);
        await foldHead('测试分组乙');
        assert.deepEqual(await visible(), [globalBook, favorite, characterBook]);
        await foldHead('测试分组乙');
        // Entering the favorites pill opens it expanded, exactly like the other groups.
        await foldHead('已收藏');
        await cdp.clickSelector('.wbo-global-dd-bar [data-wbo-pill="__pinned__"]');
        assert.equal(await cdp.evalFn(() => document.querySelector('.wbo-global-group-heading').getAttribute('aria-expanded')), 'true');
        assert.deepEqual(await visible(), [favorite]);
        await cdp.clickSelector('.wbo-global-dd-bar [data-wbo-pill="__all__"]');
        // The manual fold is remembered instead of reopening expanded.
        assert.equal(await cdp.evalFn(() => [...document.querySelectorAll('li.wbo-global-group-head')].find((el) => el.textContent.includes('已收藏'))?.getAttribute('aria-expanded')), 'false');
        await cdp.clickSelector('.wbo-global-dd-bar [data-wbo-pill="g-b"]');
        assert.deepEqual((await visible()).sort(), [globalBook, other].sort());
        assert.deepEqual(await groupBadges(), []);
        await cdp.clickSelector('.wbo-global-group-heading');
        assert.deepEqual(await visible(), []);
        await cdp.clickSelector('.wbo-global-group-heading');
        assert.deepEqual((await visible()).sort(), [globalBook, other].sort());
        await cdp.typeInto('.select2-dropdown .select2-search__field', '普通');
        assert.deepEqual(await visible(), [other]);
        // v2.35.42: search hits are labelled like the ordinary editor dropdown (U5).
        assert.deepEqual(await groupBadges(), ['搜索匹配到的世界书', '测试分组乙']);
        await cdp.clickSelector('.wbo-global-dd-bar [data-wbo-pill="__all__"]');
        assert.deepEqual(await groupBadges(), ['搜索匹配到的世界书', '测试分组乙']);
        await cdp.evalFn(() => { window.jQuery('#world_info').select2('close').select2('open'); });
        // The last pill chosen in this session is restored instead of resetting to favorites.
        await waitForCondition(cdp, () => document.querySelector('.wbo-global-dd-bar .is-active')?.getAttribute('data-wbo-pill') === '__all__');
        // Favorites stay folded as remembered, so only the open blocks are visible.
        assert.deepEqual(await visible(), [globalBook, characterBook, other]);
        assert.equal(await cdp.evalFn(() => [...document.querySelectorAll('li.wbo-global-group-head')].find((el) => el.textContent.includes('已收藏'))?.getAttribute('aria-expanded')), 'false');
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

test('enhanced editor includes the newly active character before rendering an excluded group', async () => {
    const secondBook = '另一测试角色世界书';
    const fixture = seed([secondBook]);
    fixture.characters.push({ avatar: 'second.png', name: '另一测试角色', data: { extensions: { world: secondBook } } });
    Object.assign(fixture.extension_settings.worldbook_organizer, {
        showCharBooks: false,
        editorHiddenGroupIds: ['__char__'],
        pinCurrentChatCharBookInEditor: true,
    });
    await withHost(VIEWPORTS.desktop, async (cdp) => {
        await cdp.evalFn(() => {
            const style = document.createElement('style');
            style.setAttribute('data-gr-dropdown-style', '');
            document.head.append(style);
            const getContext = SillyTavern.getContext;
            SillyTavern.getContext = () => ({ ...getContext(), characterId: 1 });
            const select = document.getElementById('world_editor_select');
            document.addEventListener('mousedown', (event) => {
                if (event.target !== select) return;
                const menu = document.createElement('div');
                menu.id = 'gr-global-dropdown-container';
                menu.className = 'gr-container-enhanced';
                menu.innerHTML = '<div class="gr-options"><div class="gr-options-container"></div></div>';
                const list = menu.querySelector('.gr-options-container');
                for (const option of select.options) {
                    const row = document.createElement('div');
                    row.className = 'gr-option';
                    row.dataset.value = option.value;
                    row.textContent = option.textContent;
                    list.append(row);
                }
                document.body.append(menu);
                event.stopPropagation();
            }, { capture: true, once: true });
            select.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
        });
        await waitForCondition(cdp, () => document.querySelector('#gr-global-dropdown-container[data-wbo-popover-role="editor"]'));
        assert.deepEqual(await cdp.evalFn((main, old) => {
            const rows = [...document.querySelectorAll('#gr-global-dropdown-container .gr-option[data-wbo-enhanced-world]')];
            return {
                first: rows[0]?.dataset.wboEnhancedWorld,
                grouped: Boolean(rows.find((row) => row.dataset.wboEnhancedWorld === main)?.closest('.wbo-pop-section')),
                oldVisible: rows.some((row) => row.dataset.wboEnhancedWorld === old),
            };
        }, secondBook, characterBook), { first: secondBook, grouped: false, oldVisible: false });
    }, [], fixture);
});

test('shared enhanced dropdown uses the actual opener, friendly role titles and one favorite control', async () => {
    const secondBook = '另一角色原文件名';
    const extras = Array.from({ length: 35 }, (_, index) => `样例长列表 ${index}`);
    const statuses = ['全部状态', '仅已开启', '仅已关闭'];
    const fixture = seed([secondBook, ...extras, ...statuses]);
    fixture.characters.push({ avatar: 'second.png', name: '另一测试角色', data: { extensions: { world: secondBook } } });
    fixture.extension_settings.worldbook_organizer.pinnedBooks = [];
    Object.assign(fixture.extension_settings.worldbook_organizer.assignments, Object.fromEntries(extras.map((name) => [name, 'g-b'])));
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
            scroller.innerHTML = '<div class="gr-search-box" style="position:sticky;bottom:0;padding:4px 8px"><input type="search" spellcheck="false" style="width:100%"></div><div class="gr-options-container"></div>';
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
                    const nativePin = row.querySelector('.gr-option-pin');
                    nativePin.classList.toggle('pinned', option.textContent === '全局测试书');
                    nativePin.addEventListener('mousedown', (event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        nativePin.classList.toggle('pinned');
                    });
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
                placeholderVisible: pop.querySelector('.gr-option[data-value=""]').getBoundingClientRect().height > 0,
                clear: pop.querySelector('button[aria-label="清除当前选择"]')?.textContent,
            };
        }, characterBook, secondBook);
        assert.deepEqual(state, { primaryTitle: '测试角色', secondaryTitle: '另一测试角色', primarySection: null, selected: [characterBook], placeholderVisible: false, clear: '清除' });
        assert.deepEqual(await cdp.evalFn(() => {
            const toolbar = document.querySelector('#gr-global-dropdown-container .wbo-enhanced-sticky');
            const search = toolbar.querySelector('input').getBoundingClientRect();
            const clear = toolbar.querySelector('.wbo-enhanced-picker-clear').getBoundingClientRect();
            const filters = toolbar.querySelector('.wbo-pop-filter-bar').getBoundingClientRect();
            return {
                inline: search.left < clear.left && Math.abs((search.top + search.bottom) - (clear.top + clear.bottom)) < 2,
                compact: filters.top >= search.bottom && filters.top - search.bottom < 10,
            };
        }), { inline: true, compact: true });

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
        const groupHead = '#gr-global-dropdown-container .wbo-pop-section[data-wbo-dd-group="g-b"] > .wbo-dd-group-head';
        const scrollToMiddle = () => cdp.evalFn((selector) => {
            const heading = document.querySelector(selector);
            const scroll = heading.closest('.gr-options');
            const toolbar = scroll.querySelector('.wbo-enhanced-sticky');
            scroll.scrollTop += heading.parentElement.getBoundingClientRect().top - scroll.getBoundingClientRect().top + 240;
            const rect = heading.getBoundingClientRect();
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;
            return { x, y, offset: rect.top - toolbar.getBoundingClientRect().bottom, hit: heading.contains(document.elementFromPoint(x, y)) };
        }, groupHead);
        for (const group of ['__all__', 'g-b']) {
            await cdp.clickSelector(`#gr-global-dropdown-container [data-wbo-pill="${group}"]`, { scroll: false });
            const point = await scrollToMiddle();
            assert.ok(point.hit && Math.abs(point.offset) < 3, JSON.stringify(point));
            await cdp.clickPoint(point.x, point.y);
            assert.equal(await cdp.evalFn((selector) => document.querySelector(selector).parentElement.classList.contains('wbo-dd-collapsed'), groupHead), true);
            const reopened = await cdp.clickSelector(groupHead, { scroll: false });
            assert.equal(reopened.hit, true);
            assert.equal(await cdp.evalFn((selector) => document.querySelector(selector).parentElement.classList.contains('wbo-dd-collapsed'), groupHead), false);
        }
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
        assert.deepEqual(theme.day, ['rgb(40, 57, 75)', 'rgb(40, 57, 75)', 'rgb(255, 255, 255)'], 'headers use the actual script surface, including its opaque parent background');
        assert.deepEqual(theme.night, theme.day, 'a host theme change must not override an unchanged script palette');
        const pin = '#gr-global-dropdown-container [data-pin-world="普通测试书"]';
        assert.equal(await cdp.evalFn(() => document.querySelector('#gr-global-dropdown-container .gr-options-container > .gr-option .wbo-gr-pin-btn')?.getAttribute('data-pin-world')), '全局测试书');
        assert.equal(await cdp.evalFn((selector) => document.querySelector(selector).closest('.gr-option').querySelectorAll('.gr-option-pin').length, pin), 1);
        assert.equal(await cdp.evalFn((selector) => document.querySelector(selector).textContent, pin), '☆');
        assert.equal(await cdp.evalFn((selector) => document.querySelector(selector).closest('.gr-option').querySelector('.gr-option-pin:not(.wbo-gr-pin-btn) svg path')?.getAttribute('d'), pin), 'M0 0H12V12Z');
        await cdp.evalFn((selector) => document.querySelector(selector).closest('.gr-option').querySelector('.gr-option-pin:not(.wbo-gr-pin-btn)').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })), pin);
        assert.equal(await cdp.evalFn((selector) => document.querySelector(selector).closest('.gr-option').querySelector('.gr-option-pin:not(.wbo-gr-pin-btn)')?.classList.contains('pinned'), pin), true);
        const alignment = await cdp.evalFn((selector) => {
            const favorite = document.querySelector(selector).getBoundingClientRect();
            const native = document.querySelector(selector).closest('.gr-option').querySelector('.gr-option-pin:not(.wbo-gr-pin-btn)').getBoundingClientRect();
            return { separate: native.right <= favorite.left, aligned: Math.abs(native.top + native.height / 2 - favorite.top - favorite.height / 2) < 2 };
        }, pin);
        assert.deepEqual(alignment, { separate: true, aligned: true });
        assert.equal(await cdp.evalFn(() => SillyTavern.getContext().extensionSettings.worldbook_organizer.pinnedBooks.includes('普通测试书')), false);
        await cdp.evalFn((selector) => document.querySelector(selector).click(), pin);
        assert.equal(await cdp.evalFn((selector) => document.querySelector(selector).getAttribute('aria-pressed'), pin), 'true');
        assert.equal(await cdp.evalFn((selector) => document.querySelector(selector).closest('.gr-option').querySelector('.gr-option-pin:not(.wbo-gr-pin-btn)')?.classList.contains('pinned'), pin), true);

        await cdp.evalFn(() => {
            const source = document.getElementById('world_editor_select');
            let selection = document.getElementById('select2-world_editor_select-container')?.closest('.select2-selection');
            if (!selection) {
                selection = document.createElement('span');
                selection.className = 'select2-selection';
                selection.innerHTML = '<span id="select2-world_editor_select-container"></span>';
                source.after(selection);
            }
            const clear = document.createElement('button');
            clear.className = 'select2-selection__clear';
            clear.id = 'fixture-native-editor-clear';
            clear.textContent = '×';
            selection.prepend(clear);
        });
        await openShared('world_editor_select');
        await waitForCondition(cdp, () => document.querySelector('#gr-global-dropdown-container[data-wbo-popover-role="editor"] [data-wbo-editing-badge]'));
        assert.equal(await cdp.evalFn(() => Boolean(document.querySelector('#gr-global-dropdown-container .wbo-enhanced-picker-clear'))), false);
        await cdp.evalFn(() => document.getElementById('fixture-native-editor-clear').remove());
        await openShared('world_editor_select');
        await waitForCondition(cdp, () => document.querySelector('#gr-global-dropdown-container .wbo-enhanced-picker-clear'));
        await cdp.clickSelector('#gr-global-dropdown-container .wbo-enhanced-picker-clear', { scroll: false });
        assert.equal(await cdp.evalFn(() => document.getElementById('world_editor_select').value), '');
    }, [], fixture);
});

test('native sort can open and switch repeatedly without dismissing the world editor', async () => {
    const fixture = seed(['排序回归书']);
    fixture.worldbooks['排序回归书'] = { entries: {
        0: { uid: 0, comment: 'Z', order: 100, displayIndex: 0 },
        1: { uid: 1, comment: 'A', order: 50, displayIndex: 1 },
        2: { uid: 2, comment: 'M', order: 0, displayIndex: 2 },
    } };
    for (const viewport of [VIEWPORTS.desktop, VIEWPORTS.mobile]) {
        await withHost(viewport, async (cdp) => {
            await cdp.evalFn(() => {
                const select = document.getElementById('world_editor_select');
                select.value = [...select.options].find((option) => option.textContent === '排序回归书').value;
                select.dispatchEvent(new Event('change', { bubbles: true }));
            });
            await waitForCondition(cdp, () => document.querySelectorAll('#world_popup_entries_list .world_entry').length === 3);
            await cdp.evalFn(() => {
                const style = document.createElement('style');
                style.dataset.grDropdownStyle = '1';
                document.head.append(style);
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
                const expected = [['1', '2', '0'], ['2', '1', '0'], ['0', '1', '2']][index];
                await waitForCondition(cdp, () => [...document.querySelectorAll('#world_popup_entries_list .world_entry')]
                    .map((row) => row.getAttribute('uid')).join(',') === ({ 1: '1,2,0', 0: '2,1,0', 2: '0,1,2' })[document.getElementById('world_info_sort_order').value]);
                assert.deepEqual(await cdp.evalFn(() => [...document.querySelectorAll('#world_popup_entries_list .world_entry')].map((row) => row.getAttribute('uid'))), expected);
            }
            await cdp.clickSelector('#host-outside-blank');
            assert.equal(await cdp.evalFn(() => document.getElementById('WorldInfo').classList.contains('closedDrawer')), true);
        }, [], fixture);
    }
});

test('native sort gestures reach host opening handlers even when compatible styling is active', async () => {
    await withHost(VIEWPORTS.desktop, async (cdp) => {
        const deliveredEvents = await cdp.evalFn(() => {
            const style = document.createElement('style');
            style.dataset.grDropdownStyle = '1';
            document.head.append(style);
            const sort = document.getElementById('world_info_sort_order');
            sort.value = '2';
            const delivered = [];
            for (const type of ['mousedown', 'touchend', 'keydown']) {
                sort.addEventListener(type, (event) => {
                    if (event.target === sort && (event.type !== 'keydown' || ['Enter', ' '].includes(event.key))) {
                        delivered.push(event.type);
                    }
                });
            }
            [
                new MouseEvent('mousedown', { bubbles: true, cancelable: true }),
                new Event('touchend', { bubbles: true, cancelable: true }),
                new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
            ].map((event) => sort.dispatchEvent(event));
            sort.focus({ preventScroll: true });
            return delivered;
        });
        assert.deepEqual(deliveredEvents, ['mousedown', 'touchend', 'keydown']);
        for (const expected of ['1', '0']) {
            await cdp.pressKey('ArrowUp', 'ArrowUp', 38);
            assert.equal(await cdp.evalFn(() => document.getElementById('world_info_sort_order').value), expected);
        }
        await cdp.pressKey('End', 'End', 35);
        assert.equal(await cdp.evalFn(() => document.getElementById('world_info_sort_order').value), '2');
    });
});

test('opening the group manager through the wand still lets the host close and reopen its menu', async () => {
    await withHost(VIEWPORTS.desktop, async (cdp) => {
        await cdp.evalFn(() => {
            const original = document.getElementById('extensionsMenuButton');
            const trigger = original.cloneNode(true);
            original.replaceWith(trigger);
            const menu = document.getElementById('extensionsMenu');
            let open = false;
            const setOpen = (next) => {
                open = next;
                menu.style.display = open ? 'block' : 'none';
            };
            trigger.addEventListener('click', () => setOpen(!open));
            document.documentElement.addEventListener('click', (event) => {
                if (open && !trigger.contains(event.target)) setOpen(false);
            });
        });
        await openManager(cdp);
        await cdp.clickSelector('#wbo-manager-overlay .wbo-modal-close');
        await cdp.clickSelector('#extensionsMenuButton');
        assert.equal(await cdp.evalFn(() => getComputedStyle(document.getElementById('extensionsMenu')).display !== 'none'), true);
    });
});

test('compatible worldbook dropdown style override follows host colors, is reversible and does not style unrelated controls', async () => {
    await withHost(VIEWPORTS.desktop, async (cdp) => {
        const openSettings = async () => {
            await openManager(cdp);
            await cdp.clickSelector('#wbo-manager-overlay [data-action="open-settings-modal"]');
            await cdp.clickSelector('[data-settings-tab="behavior"]');
        };
        const closeSettings = async () => {
            await cdp.clickSelector('#wbo-settings-close-btn');
            await cdp.clickSelector('#wbo-manager-overlay .wbo-modal-close');
        };
        await cdp.evalFn(() => {
            const marker = document.createElement('style');
            marker.dataset.grDropdownStyle = '1';
            marker.textContent = '#gr-global-dropdown-container { background: rgb(190, 90, 170) !important; color: rgb(255, 240, 255) !important }';
            document.head.append(marker);
            document.documentElement.style.setProperty('--SmartThemeBodyColor', 'rgb(24, 35, 46)');
            document.documentElement.style.setProperty('--SmartThemeBlurTintColor', 'rgb(235, 230, 215)');
        });
        const openGlobal = () => cdp.evalFn(() => window.__ST_TEST_HELPERS__.openGrGlobalPopover());
        await openGlobal();
        await waitForCondition(cdp, () => document.querySelector('[data-wbo-popover-role="global"]'));
        const colors = () => cdp.evalFn(() => {
            const pop = document.getElementById('gr-global-dropdown-container');
            return { enabled: pop.hasAttribute('data-wbo-enhanced-host-theme'), foreground: getComputedStyle(pop).color,
                background: getComputedStyle(pop).backgroundImage, groupBar: !!pop.querySelector('.wbo-pop-filter-bar') };
        });
        assert.equal((await colors()).enabled, false);
        await cdp.evalFn(() => document.getElementById('gr-global-dropdown-container').remove());
        await openSettings();
        await cdp.clickSelector('[data-setting="overrideEnhancedDropdownStyle"]');
        await closeSettings();
        await openGlobal();
        await waitForCondition(cdp, () => document.querySelector('[data-wbo-enhanced-host-theme]'));
        let state = await colors();
        assert.equal(state.foreground, 'rgb(24, 35, 46)');
        assert.match(state.background, /rgb\(235, 230, 215\)/);
        assert.equal(state.groupBar, true);
        await cdp.evalFn(() => {
            document.documentElement.style.setProperty('--SmartThemeBodyColor', 'rgb(220, 225, 230)');
            document.documentElement.style.setProperty('--SmartThemeBlurTintColor', 'rgb(30, 35, 40)');
        });
        state = await colors();
        assert.equal(state.foreground, 'rgb(220, 225, 230)');
        assert.match(state.background, /rgb\(30, 35, 40\)/);
        await cdp.evalFn(() => {
            const pop = document.getElementById('gr-global-dropdown-container');
            pop.dataset.wboSourceRole = 'sort';
            pop.innerHTML = '<div class="gr-options"><div class="gr-options-container"><div class="gr-option">自定义排序</div></div></div>';
        });
        await waitForCondition(cdp, () => !document.querySelector('#gr-global-dropdown-container[data-wbo-enhanced-host-theme]'));
        await cdp.evalFn(() => document.getElementById('gr-global-dropdown-container').remove());
        await openSettings();
        await cdp.clickSelector('[data-setting="overrideEnhancedDropdownStyle"]');
        await closeSettings();
        await openGlobal();
        await waitForCondition(cdp, () => document.querySelector('[data-wbo-popover-role="global"]'));
        state = await colors();
        assert.equal(state.enabled, false);
        assert.equal(state.foreground, 'rgb(255, 240, 255)');
        assert.equal(state.background, 'none');
    });
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
        // The card is always visible now, with an explicit detection verdict.
        assert.equal(await cdp.evalFn(() => Boolean(document.querySelector('[data-dropdown-script-settings]'))), true);
        assert.match(await cdp.evalFn(() => document.querySelector('[data-enhanced-script-status]')?.textContent || ''), /未识别/);
        // Diagnostics open a two-choice sheet on tap (no hover needed on touch devices).
        await cdp.clickSelector('#wbo-modal-diag-btn');
        await waitForCondition(cdp, () => Boolean(document.getElementById('wbo-diag-menu')));
        assert.deepEqual(await cdp.evalFn(() => [...document.querySelectorAll('#wbo-diag-menu [data-diag]')]
            .map((btn) => btn.getAttribute('data-diag'))), ['short', 'dev']);
        // Text must stay readable: never the same colour as the panel background.
        assert.equal(await cdp.evalFn(() => {
            const menu = document.getElementById('wbo-diag-menu');
            const style = getComputedStyle(menu);
            return style.color !== style.backgroundColor && style.backgroundColor !== 'rgba(0, 0, 0, 0)';
        }), true);
        await cdp.evalFn(() => document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
        await waitForCondition(cdp, () => !document.getElementById('wbo-diag-menu'));
        assert.equal(await cdp.evalFn((selector) => document.querySelector(selector)?.checked, setting), false);
        assert.equal(await cdp.evalFn(() => document.querySelector('[data-setting="overrideEnhancedDropdownStyle"]')?.checked), false);
        await closeSettings();

        await cdp.evalFn(() => {
            window.TavernHelper = { getScriptTrees: () => [{ type: 'folder', scripts: [{ type: 'script', enabled: true,
                content: 'gr-global-dropdown-container gr-select2-display data-gr-dropdown-style' }] }] };
        });
        await openSettings();
        assert.match(await cdp.evalFn(() => document.querySelector('[data-enhanced-script-status]')?.textContent || ''), /已识别/);
        assert.equal(await cdp.evalFn((selector) => document.querySelector(selector)?.checked, setting), false);
        assert.equal(await cdp.evalFn(() => document.querySelector('[data-setting="overrideEnhancedDropdownStyle"]')?.checked), false);
        assert.deepEqual(await cdp.evalFn(() => {
            const card = document.querySelector('[data-dropdown-script-settings]');
            return { title: card?.querySelector('.wbo-ai-section-head')?.textContent.trim(),
                options: [...(card?.querySelectorAll('input[data-setting]') || [])].map((input) => input.dataset.setting),
                isolated: !card?.querySelector('[data-setting="adaptCharBindPopup"]') };
        }), { title: '下拉框美化酒馆脚本适配', options: ['adaptEnhancedPresetGroups', 'overrideEnhancedDropdownStyle'], isolated: true });
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
        assert.equal(await activePill(), '已收藏 1');
        assert.deepEqual(await visible(), [favorite]);
        assert.equal(await cdp.evalFn(() => document.querySelector('.wbo-pop-search').getAttribute('spellcheck')), 'false');
        await cdp.clickSelector(`${bar} [data-wbo-pill="__all__"]`);
        assert.match(await cdp.evalFn(() => document.querySelector('#gr-global-dropdown-container .wbo-dd-group-head').textContent), /收藏/);
        assert.equal((await visible())[0], favorite);
        await cdp.clickSelector(`${bar} [data-wbo-pill="g-b"]`);
        await cdp.typeInto(`${pop} .wbo-pop-search`, '普通');
        // v2.35.77: the global list also renders the plugin-owned panel instead of filtering rows.
        await waitForCondition(cdp, () => Boolean(document.querySelector('.wbo-enhanced-search-panel')));
        assert.deepEqual(await cdp.evalFn(() => [...document.querySelectorAll('.wbo-esp-row')]
            .map((row) => row.getAttribute('data-wbo-esp'))), [other]);
        // Clear the term again so the width/expand checks work on the normal list.
        await cdp.evalFn(() => {
            const input = document.querySelector('#gr-global-dropdown-container .wbo-pop-search');
            input.value = '';
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await waitForCondition(cdp, () => !document.querySelector('.wbo-enhanced-search-panel'));
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

test('manager pins the current character block above the active globals and still lists globals elsewhere', async () => {
    await withHost(VIEWPORTS.desktop, async (cdp) => {
        await openManager(cdp);
        const groups = await cdp.evalFn(() => [...document.querySelectorAll('#wbo-mgr-groups-list > .wbo-group')].map((group) => group.dataset.groupId));
        assert.deepEqual(groups.slice(0, 4), ['__current_char_book__', '__active_globals__', '__char__', '__pinned__']);
        // The pinned block stays out of the group pills.
        assert.equal(await cdp.evalFn(() => [...document.querySelectorAll('#wbo-mgr-pills [data-group-id]')]
            .some((pill) => pill.getAttribute('data-group-id') === '__current_char_book__')), false);
        // The current character's book leads the character group instead of disappearing from it.
        assert.equal(await cdp.evalFn((name) => {
            const group = document.querySelector('.wbo-group[data-group-id="__char__"]');
            return group?.querySelector('.wbo-book-item')?.getAttribute('data-book') === name;
        }, characterBook), true);
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
            // Real user scrolling cancels the opening restore jobs before choosing a new position.
            const scrollPoint = await cdp.evalFn((selector) => {
                const rect = document.querySelector(selector).getBoundingClientRect();
                return { x: rect.left + rect.width / 2, y: rect.top + Math.min(80, rect.height / 2) };
            }, list);
            await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...scrollPoint, deltaX: 0, deltaY: 1 });
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
    const books = Array.from({ length: 32 }, (_, index) => `小窗滚动示例 ${index}`);
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
        const windowButton = '[data-wbo-fullscreen-btn="manager"]';
        assert.deepEqual(await cdp.evalFn(() => {
            const restore = document.querySelector('[data-wbo-fullscreen-btn="manager"]');
            const minimize = document.querySelector('[data-wbo-minimize-btn]');
            return [restore.getAttribute('aria-label'), restore.offsetHeight, minimize.offsetHeight,
                getComputedStyle(restore).border === getComputedStyle(minimize).border];
        }), ['还原窗口', 30, 30, true]);
        await cdp.clickSelector(windowButton);
        assert.ok((await rect(panel)).height < full.height);
        await cdp.clickSelector(windowButton);
        assert.deepEqual(await rect(panel), full);
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
        await drag(`${panel} .wbo-resize-se`, 0, -360);
        const short = await rect(panel);
        assert.ok(short.height <= 260);
        await cdp.clickSelector('#wbo-mgr-pills [data-group-id="__ungrouped__"]');
        const metrics = await cdp.evalFn(() => {
            const host = document.querySelector('.wbo-mgr-window-scroll');
            const first = document.querySelector('#wbo-mgr-groups-list .wbo-group-header');
            host.scrollTop = 0;
            const bar = document.querySelector('.wbo-modal-header-top');
            const create = document.querySelector('#wbo-mgr-groupbar [data-action="create-group"]');
            const stickyTop = bar.getBoundingClientRect().bottom;
            const limit = Math.round(first.getBoundingClientRect().top - stickyTop);
            const createAbove = create.getBoundingClientRect().top;
            const sizes = [limit - 3, limit, limit + 3, limit + 24].map((top) => {
                host.scrollTop = top;
                return [host.scrollTop, Math.round(first.getBoundingClientRect().top - stickyTop)];
            });
            return { limit, sizes, createAbove, createBelow: create.getBoundingClientRect().top,
                titleStable: Math.abs(bar.getBoundingClientRect().bottom - stickyTop) <= 1 };
        });
        assert.ok(metrics.limit > 0);
        assert.deepEqual(metrics.sizes, [[metrics.limit - 3, 3], [metrics.limit, 0], [metrics.limit + 3, 0], [metrics.limit + 24, 0]]);
        assert.ok(metrics.createBelow < metrics.createAbove && metrics.titleStable);
        const toolsButton = '#wbo-mgr-floating-tools-btn';
        const toolsPanel = '#wbo-mgr-floating-tools';
        await waitForCondition(cdp, () => {
            const button = document.querySelector('#wbo-mgr-floating-tools-btn');
            return !button.hidden && button.getBoundingClientRect().width > 0;
        });
        await cdp.evalFn(() => { window.wboTestSearch = document.querySelector('#wbo-mgr-search-input'); });
        assert.ok((await cdp.clickSelector(toolsButton, { scroll: false })).hit);
        assert.deepEqual(await cdp.evalFn((selector) => {
            const popover = document.querySelector(selector);
            const actions = ['open-ai-organize', 'open-combos-modal', 'open-scan-modal',
                'create-group', 'open-manage-groups', 'select-filter', 'toggle-batch-mode'];
            return {
                visible: !popover.hidden,
                workingControls: actions.every((action) => popover.querySelector(`[data-action="${action}"]`)),
                sameSearch: popover.querySelector('#wbo-mgr-search-input') === window.wboTestSearch,
                listTop: document.querySelector('.wbo-mgr-window-scroll').scrollTop,
                count: document.querySelectorAll('#wbo-mgr-search-input').length,
            };
        }, toolsPanel), { visible: true, workingControls: true, sameSearch: true, listTop: metrics.limit + 24, count: 1 });
        await cdp.clickSelector(toolsButton, { scroll: false });
        assert.deepEqual(await cdp.evalFn(() => [
            document.querySelector('#wbo-mgr-floating-tools').hidden,
            document.querySelector('.wbo-mgr-window-scroll').scrollTop,
        ]), [true, metrics.limit + 24]);
        await cdp.clickSelector(toolsButton, { scroll: false });
        assert.ok((await cdp.clickSelector(`${toolsPanel} #wbo-mgr-groupbar [data-action="create-group"]`, { scroll: false })).hit);
        await cdp.clickSelector('#wbo-submodal-overlay .wbo-modal-close');
        assert.equal(await cdp.evalFn(() => document.querySelector('.wbo-mgr-window-scroll').scrollTop), metrics.limit + 24);
        await cdp.evalFn(() => { document.querySelector('.wbo-mgr-window-scroll').scrollTop = 0; });
        assert.ok((await cdp.clickSelector('#wbo-mgr-groupbar [data-action="create-group"]', { scroll: false })).hit);
        await cdp.clickSelector('#wbo-submodal-overlay .wbo-modal-close');
        await cdp.clickSelector(windowButton);
        assert.equal((await rect(panel)).height, full.height);
        await cdp.navigate(await cdp.evalFn(() => location.href));
        await openManager(cdp);
        assert.deepEqual(await rect(panel), full);
        await cdp.clickSelector(windowButton);
        const restored = await rect(panel);
        assert.deepEqual([restored.width, restored.height], [short.width, short.height]);
    }, books);
});
test('character bind worldbook keeps the native select and only groups its options', async () => {
    await withHost(VIEWPORTS.desktop, async (cdp) => {
        await cdp.evalFn(() => {
            const host = document.createElement('div');
            host.className = 'character_world';
            host.id = 'fixture-char-world';
            host.style.cssText = 'position:fixed;right:0;bottom:120px;width:220px;padding:8px;';
            host.innerHTML = `<select class="character_world_info_selector">
                <option value="">--- 无主世界书 ---</option>
                <option value="收藏测试书">收藏测试书</option>
                <option value="普通测试书">普通测试书</option>
                <option value="全局测试书">全局测试书</option>
            </select>`;
            document.body.appendChild(host);
        });
        await waitForCondition(cdp, () => document.querySelector('#fixture-char-world')?.dataset.wboEnhanced === '1');
        // No plugin popover at all: the host's own Select2 opens right under the select.
        assert.equal(await cdp.evalFn(() => Boolean(document.querySelector('#fixture-char-world .wbo-popup-select-trigger'))), false);
        await cdp.evalFn(() => {
            const sel = document.querySelector('#fixture-char-world .character_world_info_selector');
            jQuery(sel).select2({ width: '100%' });
        });
        await waitForCondition(cdp, () => document.querySelector('#fixture-char-world .character_world_info_selector')?.dataset.wboSingleGrouped === '1');
        assert.equal(await cdp.evalFn(() => document.querySelectorAll('#fixture-char-world .character_world_info_selector optgroup[data-wbo-group]').length > 0), true);
        assert.equal(await cdp.evalFn(() => Boolean(document.querySelector('.wbo-mp-popover'))), false);
        // v2.35.45: the dropdown gets the same group pills as the ordinary picker (U2).
        await cdp.evalFn(() => {
            jQuery(document.querySelector('#fixture-char-world .character_world_info_selector')).select2('open');
        });
        await waitForCondition(cdp, () => Boolean(document.querySelector('.wbo-bind-dd-bar .wbo-dd-pill')));
        const pills = await cdp.evalFn(() => [...document.querySelectorAll('.wbo-bind-dd-bar .wbo-dd-pill')]
            .map((pill) => pill.textContent.trim()));
        assert.deepEqual(pills, ['全部', '测试分组甲', '测试分组乙']);
        const visibleTitles = () => cdp.evalFn(() => [...document.querySelectorAll('.select2-dropdown .select2-results__options li[data-wbo-world], .select2-dropdown .select2-results__options .wbo-s2-item')]
            .map((item) => item.closest('li'))
            .filter((row, index, all) => row && row.getBoundingClientRect().height > 0 && all.indexOf(row) === index)
            .map((row) => row.querySelector('.wbo-s2-title')?.textContent || ''));
        await cdp.evalFn(() => {
            [...document.querySelectorAll('.wbo-bind-dd-bar .wbo-dd-pill')]
                .find((pill) => pill.textContent.trim() === '测试分组甲')?.click();
        });
        await waitForCondition(cdp, () => [...document.querySelectorAll('.select2-dropdown .select2-results__options > li')]
            .filter((row) => row.getBoundingClientRect().height > 0).length <= 2);
        assert.ok((await visibleTitles()).includes('收藏测试书'));
        assert.equal(await cdp.evalFn(() => [...document.querySelectorAll('.select2-dropdown .select2-results__options li')]
            .filter((row) => row.getBoundingClientRect().height > 0)
            .some((row) => (row.textContent || '').includes('普通测试书'))), false);
    });
});
test('editor dropdown pins the current chat character book above every group', async () => {
    await withHost(VIEWPORTS.desktop, async (cdp) => {
        await cdp.evalFn(() => jQuery('#world_editor_select').select2('open'));
        await waitForCondition(cdp, () => Boolean(document.querySelector('.select2-dropdown .wbo-dd-pill[data-wbo-pill="g-b"]')));
        const firstRow = () => cdp.evalFn(() => {
            const row = document.querySelector('.select2-dropdown .select2-results__options > li');
            if (!row) return null;
            return {
                text: (row.textContent || '').trim(),
                pinnedClass: row.classList.contains('wbo-dd-current-char'),
                hidden: row.getBoundingClientRect().height === 0,
            };
        });
        assert.equal((await firstRow()).pinnedClass, true);
        assert.match((await firstRow()).text, /角色测试书/);
        await cdp.clickSelector('.select2-dropdown .wbo-dd-pill[data-wbo-pill="g-b"]');
        const pinned = await firstRow();
        assert.equal(pinned.pinnedClass, true);
        assert.match(pinned.text, /角色测试书/);
        assert.equal(pinned.hidden, false);
    });
});
test('editor dropdown marks mounted globals with an 已全局 badge', async () => {
    await withHost(VIEWPORTS.desktop, async (cdp) => {
        await cdp.evalFn(() => jQuery('#world_editor_select').select2('open'));
        await waitForCondition(cdp, () => Boolean(document.querySelector('.select2-dropdown [data-wbo-global-badge]')));
        assert.deepEqual(await cdp.evalFn(() => [...document.querySelectorAll('.select2-dropdown [data-wbo-global-badge]')]
            .map((badge) => badge.closest('[data-wbo-world]')?.dataset.wboWorld)), [globalBook]);
    });
});

test('manager current character block folds and remembers the choice', async () => {
    await withHost(VIEWPORTS.desktop, async (cdp) => {
        await openManager(cdp);
        const group = '#wbo-mgr-groups-list .wbo-group[data-group-id="__current_char_book__"]';
        const isCollapsed = () => cdp.evalFn((sel) => Boolean(document.querySelector(sel)?.classList.contains('is-collapsed')), group);
        assert.equal(await isCollapsed(), false);
        await cdp.clickSelector(`${group} [data-action="toggle-group-collapse"]`);
        await waitForCondition(cdp, () => document.querySelector('#wbo-mgr-groups-list .wbo-group[data-group-id="__current_char_book__"]')?.classList.contains('is-collapsed'));
        await cdp.clickSelector(`${group} [data-action="toggle-group-collapse"]`);
        await waitForCondition(cdp, () => !document.querySelector('#wbo-mgr-groups-list .wbo-group[data-group-id="__current_char_book__"]')?.classList.contains('is-collapsed'));
    });
});

test('group visibility popover closes on outside press and on a second eye tap', async () => {
    await withHost(VIEWPORTS.desktop, async (cdp) => {
        await openManager(cdp);
        const eye = '#wbo-mgr-groups-list .wbo-group[data-group-id="g-a"] [data-action="open-group-visibility"]';
        await cdp.clickSelector(eye);
        await waitForCondition(cdp, () => Boolean(document.getElementById('wbo-vis-popover-backdrop')));
        await cdp.evalFn(() => document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
        await waitForCondition(cdp, () => !document.getElementById('wbo-vis-popover-backdrop'));
        assert.equal(await cdp.evalFn(() => Boolean(document.getElementById('wbo-vis-popover-backdrop'))), false);
        await cdp.clickSelector(eye);
        await waitForCondition(cdp, () => Boolean(document.getElementById('wbo-vis-popover-backdrop')));
        // Pressing the same eye again closes it (event order independent).
        await cdp.evalFn((selector) => document.querySelector(selector).click(), eye);
        await waitForCondition(cdp, () => !document.getElementById('wbo-vis-popover-backdrop'));
        // A third press opens it again; it must not be swallowed by a stale "just closed" flag.
        await cdp.evalFn((selector) => document.querySelector(selector).click(), eye);
        await waitForCondition(cdp, () => Boolean(document.getElementById('wbo-vis-popover-backdrop')));
    });
});
test('editor dropdown groups 3+ mounted globals into a foldable block above the opened group', async () => {
    const threeGlobals = ['全局甲', '全局乙', '全局丙'];
    const globalsSeed = createDefaultSeed({
        characters: [],
        worldbooks: Object.fromEntries([...threeGlobals, '普通甲', '普通乙'].map((name) => [name, { entries: {} }])),
        selected_world_info: threeGlobals,
        pluginSettings: {
            autoScanNewCharacters: false,
            groups: [{ id: 'g-style', name: '文风' }],
            assignments: { 普通甲: 'g-style', 全局甲: 'g-style' },
            pinnedBooks: [],
        },
    });
    await withHost(VIEWPORTS.desktop, async (cdp) => {
        await cdp.evalFn(() => jQuery('#world_editor_select').select2('open'));
        await waitForCondition(cdp, () => Boolean(document.querySelector('.select2-dropdown li[data-wbo-dd-group="__globals__"]')));
        const info = await cdp.evalFn(() => {
            const group = document.querySelector('.select2-dropdown li[data-wbo-dd-group="__globals__"]');
            return {
                head: group?.querySelector('.select2-results__group')?.textContent || '',
                mirrors: [...group.querySelectorAll('.wbo-dd-global-mirror')].map((row) => row.getAttribute('data-wbo-mirror-of')).sort(),
                pills: [...document.querySelectorAll('.select2-dropdown .wbo-dd-pill')].map((pill) => pill.getAttribute('data-wbo-pill')),
                firstGroup: document.querySelector('.select2-dropdown .select2-results__options > li')?.getAttribute('data-wbo-dd-group'),
            };
        });
        assert.match(info.head, /全局世界书 \(3\)/);
        assert.deepEqual(info.mirrors, [...threeGlobals].sort());
        assert.equal(info.pills[1], '__globals__');
        assert.equal(info.firstGroup, '__globals__');
        // Folding works like any other group.
        await cdp.evalFn(() => {
            const head = document.querySelector('.select2-dropdown li[data-wbo-dd-group="__globals__"] .wbo-dd-group-head');
            head.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        });
        await waitForCondition(cdp, () => document.querySelector('.select2-dropdown li[data-wbo-dd-group="__globals__"]')?.classList.contains('wbo-dd-collapsed'));
        await cdp.clickSelector('.select2-dropdown .wbo-dd-pill[data-wbo-pill="g-style"]');
        await waitForCondition(cdp, () => document.querySelector('.select2-dropdown li[data-wbo-dd-group="g-style"]')?.classList.contains('wbo-dd-collapsed') === false);
        assert.equal(await cdp.evalFn(() => {
            const group = document.querySelector('.select2-dropdown li[data-wbo-dd-group="__globals__"]');
            const styleGroup = document.querySelector('.select2-dropdown li[data-wbo-dd-group="g-style"]');
            const box = group?.getBoundingClientRect();
            return Boolean(box && box.height > 0) && group.getBoundingClientRect().top < styleGroup.getBoundingClientRect().top;
        }), true);
    }, [], globalsSeed);
});
test('manager folds the active global block in overview views', async () => {
    await withHost(VIEWPORTS.desktop, async (cdp) => {
        await openManager(cdp);
        const group = '#wbo-mgr-groups-list .wbo-group[data-group-id="__active_globals__"]';
        assert.equal(await cdp.evalFn(() => Boolean(document.querySelector('#wbo-mgr-groups-list .wbo-group[data-group-id="__active_globals__"]')?.classList.contains('is-collapsed'))), false);
        await cdp.clickSelector(`${group} [data-action="toggle-group-collapse"]`);
        await waitForCondition(cdp, () => document.querySelector('#wbo-mgr-groups-list .wbo-group[data-group-id="__active_globals__"]')?.classList.contains('is-collapsed'));
        await cdp.clickSelector(`${group} [data-action="toggle-group-collapse"]`);
        await waitForCondition(cdp, () => !document.querySelector('#wbo-mgr-groups-list .wbo-group[data-group-id="__active_globals__"]')?.classList.contains('is-collapsed'));
    });
});

test('manager current character block survives its book leaving the character group', async () => {
    const charBook = '角色测试书';
    const seed = createDefaultSeed({
        characters: [{ avatar: 'example.png', name: '测试角色', data: { extensions: { world: charBook } } }],
        worldbooks: { [charBook]: { entries: {} }, 普通测试书: { entries: {} } },
        selected_world_info: [],
        pluginSettings: {
            autoScanNewCharacters: false,
            groups: [{ id: 'g-other', name: '别的组' }],
            assignments: { [charBook]: 'g-other' },
        },
    });
    await withHost(VIEWPORTS.desktop, async (cdp) => {
        await openManager(cdp);
        assert.equal(await cdp.evalFn(() => Boolean(document.querySelector('.wbo-group[data-group-id="__current_char_book__"]'))), true);
        assert.equal(await cdp.evalFn(() => document.querySelector('.wbo-group[data-group-id="__current_char_book__"] .wbo-book-item')?.getAttribute('data-book')), charBook);
        assert.equal(await cdp.evalFn(() => document.querySelector('.wbo-group[data-group-id="g-other"] .wbo-book-item')?.getAttribute('data-book')), charBook);
    }, [], seed);
});
test('global dropdown keeps a pinned+mounted book only in the mounted block and remembers the pill', async () => {
    const seed = createDefaultSeed({
        characters: [],
        worldbooks: { 双标书: { entries: {} }, 普通书: { entries: {} } },
        selected_world_info: ['双标书'],
        pluginSettings: {
            autoScanNewCharacters: false,
            groups: [],
            assignments: {},
            pinnedBooks: ['双标书'],
        },
    });
    await withHost(VIEWPORTS.desktop, async (cdp) => {
        await openManager(cdp);
        await cdp.clickSelector('.wbo-manager-modal .wbo-modal-close');
        await cdp.clickSelector('#WIMultiSelector .select2-container');
        await waitForCondition(cdp, () => !!document.querySelector('.wbo-global-dd-bar'));
        const activePill = () => cdp.evalFn(() => document.querySelector('.wbo-global-dd-bar .is-active')?.getAttribute('data-wbo-pill'));
        assert.equal(await activePill(), '__pinned__');
        await cdp.clickSelector('.wbo-global-dd-bar [data-wbo-pill="__all__"]');
        const heads = await cdp.evalFn(() => [...document.querySelectorAll('li.wbo-global-group-head')].map((head) => head.textContent.trim()));
        assert.deepEqual(heads, ['已开启的全局世界书 (1)', '已收藏 (1)1 本已全局，位于全局分组', '未分组 (1)']);
        assert.equal(await cdp.evalFn(() => Boolean(document.querySelector('.select2-dropdown .wbo-global-search-wrap, .select2-dropdown .select2-search__field'))), true);
        await cdp.evalFn(() => window.jQuery('#world_info').select2('close'));
        await cdp.clickSelector('#WIMultiSelector .select2-container');
        await waitForCondition(cdp, () => !!document.querySelector('.wbo-global-dd-bar'));
        assert.equal(await activePill(), '__all__');
    }, [], seed);
});

test('global dropdown collects search hits into one 搜索匹配到的世界书 block', async () => {
    const searchSeed = createDefaultSeed({
        characters: [],
        worldbooks: Object.fromEntries(['许文风', '许剧情甲', '许剧情乙', '别的书'].map((name) => [name, { entries: {} }])),
        selected_world_info: [],
        pluginSettings: {
            autoScanNewCharacters: false,
            groups: [{ id: 'g-style', name: '文风' }, { id: 'g-plot', name: '剧情' }],
            assignments: { 许文风: 'g-style', 许剧情甲: 'g-plot', 许剧情乙: 'g-plot', 别的书: 'g-plot' },
        },
    });
    await withHost(VIEWPORTS.desktop, async (cdp) => {
        await cdp.clickSelector('#WIMultiSelector .select2-container');
        await waitForCondition(cdp, () => !!document.querySelector('.wbo-global-dd-bar'));
        await cdp.typeInto('.select2-dropdown .select2-search__field', '许文');
        await waitForCondition(cdp, () => !!document.querySelector('.wbo-global-dd-bar') && Boolean(document.querySelector('.select2-dropdown [data-wbo-search-badge], .select2-dropdown li[data-wbo-dd-group="__search_matches__"]')));
        const single = await cdp.evalFn(() => [...document.querySelectorAll('.select2-dropdown .select2-results__options > li')]
            .filter((row) => row.getBoundingClientRect().height > 0)
            .map((row) => row.textContent.replace(/\s+/g, ' ').trim()));
        assert.equal(single.length, 1);
        assert.match(single[0], /许文风/);
        assert.match(single[0], /搜索匹配到的世界书/);
        await cdp.evalFn(() => {
            const field = document.querySelector('.select2-dropdown .select2-search__field');
            field.value = '许';
            field.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await waitForCondition(cdp, () => Boolean(document.querySelector('.select2-dropdown li[data-wbo-dd-group="__search_matches__"]')));
        const block = await cdp.evalFn(() => {
            const head = document.querySelector('.select2-dropdown li[data-wbo-dd-group="__search_matches__"]');
            return {
                head: head?.textContent?.trim(),
                origins: [...document.querySelectorAll('.select2-dropdown .select2-results__options > li .wbo-s2-badge')]
                    .map((badge) => badge.textContent.trim())
                    .filter((text) => text && text !== '搜索匹配到的世界书'),
            };
        });
        assert.match(block.head, /搜索匹配到的世界书 \(3\)/);
        assert.deepEqual([...block.origins].sort(), ['剧情', '剧情', '文风']);
        // Three hits: the block title carries the info, rows carry no 搜索匹配到的世界书 badge.
        assert.equal(await cdp.evalFn(() => document.querySelectorAll('.select2-dropdown [data-wbo-search-badge]').length), 0);
        await cdp.evalFn(() => {
            const field = document.querySelector('.select2-dropdown .select2-search__field');
            field.value = '';
            field.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await waitForCondition(cdp, () => !document.querySelector('.select2-dropdown li[data-wbo-dd-group="__search_matches__"]'));
        assert.equal(await cdp.evalFn(() => document.querySelectorAll('.select2-dropdown .is-search-origin').length), 0);
        // Searching inside a pill still finds books of other groups.
        await cdp.clickSelector('.select2-dropdown .wbo-dd-pill[data-wbo-pill="g-plot"]');
        await cdp.typeInto('.select2-dropdown .select2-search__field', '许文');
        await waitForCondition(cdp, () => Boolean(document.querySelector('.select2-dropdown [data-wbo-search-badge]')));
        const crossPill = await cdp.evalFn(() => {
            const row = [...document.querySelectorAll('.select2-dropdown li.select2-results__option')]
                .find((item) => (item.textContent || '').includes('许文风') && item.getBoundingClientRect().height > 0);
            return {
                found: Boolean(row),
                badges: row ? [...row.querySelectorAll('.wbo-s2-badge')].map((badge) => badge.textContent.trim()) : [],
            };
        });
        assert.equal(crossPill.found, true);
        assert.ok(crossPill.badges.includes('文风'));
    }, [], searchSeed);
});

test('editor search badges never stack when the pill changes', async () => {
    const badgeSeed = createDefaultSeed({
        characters: [],
        worldbooks: Object.fromEntries(['许文风', '许剧情甲', '别的书'].map((name) => [name, { entries: {} }])),
        selected_world_info: [],
        pluginSettings: {
            autoScanNewCharacters: false,
            groups: [{ id: 'g-style', name: '文风' }, { id: 'g-plot', name: '剧情' }],
            assignments: { 许文风: 'g-style', 许剧情甲: 'g-plot', 别的书: 'g-plot' },
        },
    });
    await withHost(VIEWPORTS.desktop, async (cdp) => {
        await cdp.evalFn(() => jQuery('#world_editor_select').select2('open'));
        await waitForCondition(cdp, () => Boolean(document.querySelector('.select2-dropdown .wbo-dd-pill[data-wbo-pill="g-plot"]')));
        await cdp.clickSelector('.select2-dropdown .wbo-dd-pill[data-wbo-pill="g-plot"]');
        await cdp.typeInto('.select2-dropdown .select2-search__field', '文风');
        await waitForCondition(cdp, () => Boolean(document.querySelector('.select2-dropdown [data-wbo-search-badge]')));
        for (const pill of ['g-style', 'g-plot', '__all__', 'g-plot']) {
            await cdp.clickSelector(`.select2-dropdown .wbo-dd-pill[data-wbo-pill="${pill}"]`);
        }
        const badges = await cdp.evalFn(() => {
            const row = [...document.querySelectorAll('.select2-dropdown li.select2-results__option')]
                .find((item) => (item.textContent || '').includes('许文风'));
            return {
                origins: [...row.querySelectorAll('.is-search-origin')].map((badge) => badge.textContent.trim()),
                matches: row.querySelectorAll('.is-search-match').length,
            };
        });
        assert.deepEqual(badges.origins, ['文风']);
        assert.equal(badges.matches, 1);
    }, [], badgeSeed);
});

test('global dropdown re-buckets a book as soon as it is mounted', async () => {
    const mountSeed = createDefaultSeed({
        characters: [],
        worldbooks: Object.fromEntries(['甲书', '乙书', '丙书'].map((name) => [name, { entries: {} }])),
        selected_world_info: [],
        pluginSettings: {
            autoScanNewCharacters: false,
            groups: [{ id: 'g-a', name: '测试分组甲' }, { id: 'g-b', name: '测试分组乙' }],
            assignments: { 甲书: 'g-a', 乙书: 'g-b', 丙书: 'g-b' },
            pinnedBooks: [],
        },
    });
    await withHost(VIEWPORTS.desktop, async (cdp) => {
        await cdp.clickSelector('#WIMultiSelector .select2-container');
        await waitForCondition(cdp, () => !!document.querySelector('.wbo-global-dd-bar'));
        assert.ok(await cdp.evalFn(() => document.querySelectorAll('.select2-dropdown [data-wbo-world]').length) > 0);
        const heads = () => cdp.evalFn(() => [...document.querySelectorAll('.select2-results__options > li.wbo-global-group-head')]
            .map((head) => head.textContent.trim()));
        assert.deepEqual(await heads(), ['测试分组甲 (1)', '测试分组乙 (2)']);
        // Mounting while open must move it into the mounted block immediately.
        await cdp.evalFn((name) => {
            const row = [...document.querySelectorAll('.select2-dropdown li.select2-results__option')]
                .find((item) => item.querySelector('[data-wbo-world]')?.getAttribute('data-wbo-world') === name);
            row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
            row.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
            row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        }, '甲书');
        await waitForCondition(cdp, () => [...document.querySelectorAll('.select2-results__options > li.wbo-global-group-head')]
            .some((head) => head.textContent.includes('已开启的全局世界书 (1)')));
        assert.deepEqual(await heads(), ['已开启的全局世界书 (1)', '测试分组乙 (2)']);
    }, [], mountSeed);
});

test('editor search inside a group shows only the matches', async () => {
    const seed = createDefaultSeed({
        characters: [],
        worldbooks: Object.fromEntries(['许文风', '许剧情甲', '许剧情乙', '别的书'].map((name) => [name, { entries: {} }])),
        selected_world_info: [],
        pluginSettings: {
            autoScanNewCharacters: false,
            groups: [{ id: 'g-style', name: '文风' }, { id: 'g-plot', name: '剧情' }],
            assignments: { 许文风: 'g-style', 许剧情甲: 'g-plot', 许剧情乙: 'g-plot', 别的书: 'g-plot' },
        },
    });
    await withHost(VIEWPORTS.desktop, async (cdp) => {
        await cdp.evalFn(() => jQuery('#world_editor_select').select2('open'));
        await waitForCondition(cdp, () => Boolean(document.querySelector('.select2-dropdown .wbo-dd-pill[data-wbo-pill="g-plot"]')));
        await cdp.clickSelector('.select2-dropdown .wbo-dd-pill[data-wbo-pill="g-plot"]');
        await cdp.typeInto('.select2-dropdown .select2-search__field', '许文');
        await waitForCondition(cdp, () => Boolean(document.querySelector('.select2-dropdown [data-wbo-search-badge]')));
        const single = await cdp.evalFn(() => [...document.querySelectorAll('.select2-dropdown .select2-results__options > li')]
            .filter((row) => row.getBoundingClientRect().height > 0)
            .map((row) => (row.textContent || '').trim()));
        assert.equal(single.length, 1);
        assert.match(single[0], /许文风/);
        assert.match(single[0], /搜索匹配到的世界书/);
        await cdp.evalFn(() => {
            const field = document.querySelector('.select2-dropdown .select2-search__field');
            field.value = '许';
            field.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await waitForCondition(cdp, () => Boolean(document.querySelector('.select2-dropdown li[data-wbo-dd-group="__search_matches__"]')));
        const matches = await cdp.evalFn(() => [...document.querySelectorAll('.select2-dropdown li[data-wbo-dd-group="__search_matches__"] li')]
            .map((row) => (row.textContent || '').trim()));
        assert.equal(matches.length, 3);
        for (const name of ['许文风', '许剧情甲', '许剧情乙']) {
            assert.ok(matches.some((text) => text.includes(name)), name);
        }
        await cdp.evalFn(() => {
            const field = document.querySelector('.select2-dropdown .select2-search__field');
            field.value = '';
            field.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await waitForCondition(cdp, () => !document.querySelector('.select2-dropdown li[data-wbo-dd-group="__search_matches__"]'));
    }, [], seed);
});

test('editor dropdown shows every global book once and folds mounted favorites into the note', async () => {
    const threeGlobals = ['全局甲', '全局乙', '全局丙'];
    const dedupeSeed = createDefaultSeed({
        characters: [],
        worldbooks: Object.fromEntries([...threeGlobals, '普通甲', '普通乙'].map((name) => [name, { entries: {} }])),
        selected_world_info: threeGlobals,
        pluginSettings: {
            autoScanNewCharacters: false,
            groups: [{ id: 'g-style', name: '文风' }],
            assignments: { 普通甲: 'g-style' },
            pinnedBooks: ['全局乙', '普通乙'],
        },
    });
    await withHost(VIEWPORTS.desktop, async (cdp) => {
        await cdp.evalFn(() => jQuery('#world_editor_select').select2('open'));
        await waitForCondition(cdp, () => Boolean(document.querySelector('.select2-dropdown li[data-wbo-dd-group="__globals__"]')));
        const visibleNames = () => cdp.evalFn(() => [...document.querySelectorAll('.select2-dropdown .select2-results__options [data-wbo-world]')]
            .filter((item) => item.closest('li.select2-results__option')?.getBoundingClientRect().height > 0)
            .map((item) => item.getAttribute('data-wbo-world')));
        const names = await visibleNames();
        // Every mounted global is visible exactly once (block + bare row + favorites triple-draw).
        assert.deepEqual(names.filter((name) => threeGlobals.includes(name)).sort(), [...threeGlobals].sort());
        assert.equal(names.filter((name) => name === '普通甲').length, 1);
        assert.ok(names.includes('普通乙'));
        // The mounted favorite is counted in the favorites head but listed under 全局世界书 only.
        const favoritesHead = await cdp.evalFn(() => {
            const group = document.querySelector('.select2-dropdown li[data-wbo-dd-group="__pinned__"]');
            return {
                head: group?.querySelector('.select2-results__group')?.textContent || '',
                rows: [...(group?.querySelectorAll('li.wbo-dd-global-mirror') || [])]
                    .map((row) => row.textContent.replace(/\s+/g, ' ').trim()),
            };
        });
        assert.match(favoritesHead.head, /已收藏 \(2\)1 本已全局，位于全局分组/);
        assert.equal(favoritesHead.rows.length, 1);
        assert.match(favoritesHead.rows[0], /普通乙/);
        // 已收藏 sits right below 全局世界书, same as the global drawer.
        const blockOrder = await cdp.evalFn(() => [...document.querySelectorAll('.select2-dropdown .select2-results__options > li.select2-results__option--group')]
            .map((row) => row.getAttribute('data-wbo-dd-group')));
        assert.deepEqual(blockOrder.slice(0, 2), ['__globals__', '__pinned__']);
        // A mirror row still selects the real book.
        await cdp.evalFn(() => {
            const row = [...document.querySelectorAll('.select2-dropdown li[data-wbo-dd-group="__globals__"] li.wbo-dd-global-mirror')]
                .find((item) => item.getAttribute('data-wbo-mirror-of') === '全局乙');
            row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        });
        await waitForCondition(cdp, () => document.querySelector('#world_editor_select option:checked')?.textContent.trim() === '全局乙');
    }, [], dedupeSeed);
});

test('editor dropdown shows 1-2 globals as untitled top rows without an empty favorites head', async () => {
    const belowThresholdSeed = createDefaultSeed({
        characters: [],
        worldbooks: Object.fromEntries(['全局测试书', '收藏测试书', '普通书'].map((name) => [name, { entries: {} }])),
        selected_world_info: ['全局测试书', '收藏测试书'],
        pluginSettings: {
            autoScanNewCharacters: false,
            groups: [{ id: 'g-a', name: '测试分组甲' }],
            assignments: { 收藏测试书: 'g-a', 普通书: 'g-a' },
            pinnedBooks: ['收藏测试书'],
        },
    });
    await withHost(VIEWPORTS.desktop, async (cdp) => {
        await cdp.evalFn(() => jQuery('#world_editor_select').select2('open'));
        await waitForCondition(cdp, () => Boolean(document.querySelector('.select2-dropdown .wbo-dd-pill')));
        const visibleNames = await cdp.evalFn(() => [...document.querySelectorAll('.select2-dropdown .select2-results__options [data-wbo-world]')]
            .filter((item) => item.closest('li.select2-results__option')?.getBoundingClientRect().height > 0)
            .map((item) => item.getAttribute('data-wbo-world')));
        // Each of the two mounted globals is an untitled top row; the favorited one is not
        // repeated inside a favorites block, and that block is not rendered at all here.
        assert.deepEqual(visibleNames.filter((name) => name === '收藏测试书'), ['收藏测试书']);
        assert.deepEqual(visibleNames.filter((name) => name === '全局测试书'), ['全局测试书']);
        assert.equal(await cdp.evalFn(() => Boolean(document.querySelector('.select2-dropdown li[data-wbo-dd-group="__pinned__"]'))), false);
        assert.equal(await cdp.evalFn(() => Boolean(document.querySelector('.select2-dropdown li[data-wbo-dd-group="__globals__"]'))), false);
        // Both bare rows still advertise their mounted state.
        const badges = await cdp.evalFn(() => Object.fromEntries([...document.querySelectorAll('.select2-dropdown .select2-results__options [data-wbo-world]')]
            .map((item) => [item.getAttribute('data-wbo-world'), Boolean(item.closest('li')?.querySelector('[data-wbo-global-badge]'))])));
        assert.equal(badges['全局测试书'], true);
        assert.equal(badges['收藏测试书'], true);
    }, [], belowThresholdSeed);
});

test('editor dropdown keeps a plain favorite at the top of its own group', async () => {
    const pinnedSeed = createDefaultSeed({
        characters: [],
        worldbooks: Object.fromEntries(['收藏书', '同组书甲', '同组书乙'].map((name) => [name, { entries: {} }])),
        selected_world_info: [],
        pluginSettings: {
            autoScanNewCharacters: false,
            groups: [{ id: 'g-a', name: '测试分组甲' }],
            assignments: { 收藏书: 'g-a', 同组书甲: 'g-a' },
            pinnedBooks: ['收藏书'],
        },
    });
    await withHost(VIEWPORTS.desktop, async (cdp) => {
        await cdp.evalFn(() => jQuery('#world_editor_select').select2('open'));
        await waitForCondition(cdp, () => Boolean(document.querySelector('.select2-dropdown li[data-wbo-dd-group="g-a"]')));
        const groupOrder = await cdp.evalFn(() => [...document.querySelectorAll('.select2-dropdown li[data-wbo-dd-group="g-a"] > ul > li')]
            .map((row) => row.querySelector('[data-wbo-world]')?.getAttribute('data-wbo-world')));
        assert.deepEqual(groupOrder, ['收藏书', '同组书甲']);
        const head = await cdp.evalFn(() => document.querySelector('.select2-dropdown li[data-wbo-dd-group="__pinned__"] .select2-results__group')?.textContent || '');
        assert.match(head, /已收藏 \(1\)/);
        assert.doesNotMatch(head, /已全局/);
    }, [], pinnedSeed);
});

test('editor dropdown puts the two bare globals above the favorites block', async () => {
    const twoGlobalSeed = createDefaultSeed({
        characters: [],
        worldbooks: Object.fromEntries(['全局甲', '全局乙', '收藏普通', '普通书'].map((name) => [name, { entries: {} }])),
        selected_world_info: ['全局甲', '全局乙'],
        pluginSettings: {
            autoScanNewCharacters: false,
            groups: [{ id: 'g-a', name: '测试分组甲' }],
            assignments: { 收藏普通: 'g-a', 普通书: 'g-a' },
            pinnedBooks: ['收藏普通'],
        },
    });
    await withHost(VIEWPORTS.desktop, async (cdp) => {
        await cdp.evalFn(() => jQuery('#world_editor_select').select2('open'));
        await waitForCondition(cdp, () => Boolean(document.querySelector('.select2-dropdown li[data-wbo-dd-group="__pinned__"]')));
        const order = await cdp.evalFn(() => [...document.querySelectorAll('.select2-dropdown .select2-results__options > li')]
            .filter((row) => row.getBoundingClientRect().height > 0)
            .map((row) => row.getAttribute('data-wbo-dd-group')
                || row.querySelector('[data-wbo-world]')?.getAttribute('data-wbo-world') || '?'));
        // Both mounted globals are untitled rows right above the favorites block.
        const firstFavorite = order.indexOf('__pinned__');
        assert.ok(firstFavorite > 0);
        assert.deepEqual(order.slice(0, firstFavorite).sort(), ['全局乙', '全局甲'].sort());
        assert.deepEqual(order.slice(0, 2).sort(), ['全局乙', '全局甲'].sort());
    }, [], twoGlobalSeed);
});

test('editor dropdown expands the globals block when its pill or its head is used', async () => {
    const threeGlobals = ['全局甲', '全局乙', '全局丙'];
    const seedWithGroup = createDefaultSeed({
        characters: [],
        worldbooks: Object.fromEntries([...threeGlobals, '普通甲'].map((name) => [name, { entries: {} }])),
        selected_world_info: threeGlobals,
        pluginSettings: {
            autoScanNewCharacters: false,
            groups: [{ id: 'g-style', name: '文风' }],
            assignments: { 普通甲: 'g-style' },
            pinnedBooks: [],
        },
    });
    await withHost(VIEWPORTS.desktop, async (cdp) => {
        const globalsRowsVisible = () => cdp.evalFn(() => [...document.querySelectorAll('.select2-dropdown li[data-wbo-dd-group="__globals__"] li.wbo-dd-global-mirror')]
            .filter((row) => row.getBoundingClientRect().height > 0).length);
        await cdp.evalFn(() => jQuery('#world_editor_select').select2('open'));
        await waitForCondition(cdp, () => Boolean(document.querySelector('.select2-dropdown .wbo-dd-pill[data-wbo-pill="__globals__"]')));
        // Opening the globals pill shows its rows instead of a folded head.
        await cdp.clickSelector('.select2-dropdown .wbo-dd-pill[data-wbo-pill="__globals__"]');
        await waitForCondition(cdp, () => !document.querySelector('.select2-dropdown li[data-wbo-dd-group="__globals__"]')?.classList.contains('wbo-dd-collapsed'));
        assert.equal(await globalsRowsVisible(), 3);
        // Inside another group's pill it starts folded, but its head still expands it.
        await cdp.clickSelector('.select2-dropdown .wbo-dd-pill[data-wbo-pill="g-style"]');
        await waitForCondition(cdp, () => document.querySelector('.select2-dropdown li[data-wbo-dd-group="__globals__"]')?.classList.contains('wbo-dd-collapsed'));
        assert.equal(await globalsRowsVisible(), 0);
        await cdp.evalFn(() => {
            const head = document.querySelector('.select2-dropdown li[data-wbo-dd-group="__globals__"] .wbo-dd-group-head');
            head.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        });
        await waitForCondition(cdp, () => !document.querySelector('.select2-dropdown li[data-wbo-dd-group="__globals__"]')?.classList.contains('wbo-dd-collapsed'));
        assert.equal(await globalsRowsVisible(), 3);
    }, [], seedWithGroup);
});

test('a disabled dropdown script leaves no stale styles or shells behind', async () => {
    await withHost(VIEWPORTS.desktop, async (cdp) => {
        const result = await cdp.evalFn(async () => {
            const mod = await import('/scripts/extensions/third-party/worldbook-organizer/src/native-filter.js');
            const marker = document.createElement('style');
            marker.dataset.grDropdownStyle = '1';
            marker.textContent = '.wbo-gr-world-title > small { display: block !important; }';
            document.head.append(marker);
            // Another copy of the script may still be alive: never touch foreign DOM then.
            const shell = document.createElement('div');
            shell.className = 'gr-container-enhanced';
            document.body.append(shell);
            window.TavernHelper = {
                getScriptTrees: () => [{ type: 'script', enabled: false,
                    content: 'gr-global-dropdown-container gr-select2-display data-gr-dropdown-style' }],
            };
            const guarded = mod.cleanupStaleEnhancedArtifacts();
            const shellLeftWhileLive = Boolean(document.querySelector('.gr-container-enhanced'));
            const styleLeftWhileLive = Boolean(document.querySelector('style[data-gr-dropdown-style]'));
            shell.remove();
            const cleaned = mod.cleanupStaleEnhancedArtifacts();
            return {
                guarded,
                shellLeftWhileLive,
                styleLeftWhileLive,
                cleaned,
                styleLeft: Boolean(document.querySelector('style[data-gr-dropdown-style]')),
                scriptActive: mod.isEnhancedScriptActive(),
            };
        });
        assert.deepEqual(result, {
            guarded: false,
            shellLeftWhileLive: true,
            styleLeftWhileLive: true,
            cleaned: true,
            styleLeft: false,
            scriptActive: false,
        });
    });
});

test('reference dropdown script and the plugin coexist on the editor dropdown', async (t) => {
    const script = JSON.parse(readFileSync(resolve('..', '参考仓库', '下拉框美化.json'), 'utf8')).content;
    const storageKey = script.match(/const STORAGE_KEY = '([^']+)'/)?.[1];
    const instanceFlag = script.match(/const INSTANCE_FLAG = '([^']+)'/)?.[1];
    assert.ok(storageKey && instanceFlag);
    await withHost(VIEWPORTS.desktop, async (cdp) => {
        await cdp.evalFn((key, code) => {
            localStorage.setItem(key, JSON.stringify({ settings: {}, pinned: {}, meta: { welcomePopupShown: true } }));
            (0, eval)(code);
        }, storageKey, script);
        await cdp.evalFn(() => {
            const select = document.getElementById('world_editor_select');
            select.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            select.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        const opened = await waitForCondition(cdp, () => Boolean(document.querySelector('.gr-container-enhanced, #gr-global-dropdown-container')), 4000).then(() => true).catch(() => false);
        if (!opened) {
            t.skip('参考脚本在这个模拟宿主里没有打开编辑器下拉，U9 需真机核对');
            return;
        }
        await waitForCondition(cdp, () => Boolean(document.querySelector('[data-wbo-popover-role="editor"]')));
        // Our decorations land on the script's DOM instead of fighting it.
        assert.equal(await cdp.evalFn(() => Boolean(document.querySelector('[data-wbo-popover-role="editor"] .wbo-pop-filter-bar'))), true);
        assert.equal(await cdp.evalFn(() => document.querySelectorAll('[data-wbo-popover-role="editor"] .wbo-pop-section').length > 0), true);
        assert.equal(await cdp.evalFn(() => document.querySelectorAll('[data-wbo-popover-role="editor"] .wbo-gr-pin-btn').length > 0), true);
        // Character books render 角色名 + 原名, and the file name stays inline on a wide viewport.
        assert.equal(await cdp.evalFn(() => document.querySelectorAll('[data-wbo-popover-role="editor"] .wbo-gr-world-title small').length > 0), true);
        assert.equal(await cdp.evalFn(() => [...document.querySelectorAll('[data-wbo-popover-role="editor"] .wbo-gr-world-title small')]
            .every((small) => getComputedStyle(small).display === 'inline')), true);
        // No row is duplicated by our grouping.
        const duplicated = await cdp.evalFn(() => {
            const names = [...document.querySelectorAll('[data-wbo-popover-role="editor"] .gr-option')]
                .map((row) => row.dataset.wboEnhancedWorld || (row.textContent || '').trim())
                .filter(Boolean);
            return names.filter((name, index) => names.indexOf(name) !== index);
        });
        assert.deepEqual(duplicated, []);
        assert.deepEqual(cdp.getErrors().runtimeErrors, []);
    });
});

test('enhanced dropdown renders its own search panel over the host list', async (t) => {
    const bookSeed = createDefaultSeed({
        characters: [],
        worldbooks: Object.fromEntries(['许文风', '许剧情甲', '许剧情乙', '别的书'].map((name) => [name, { entries: {} }])),
        selected_world_info: [],
        pluginSettings: {
            autoScanNewCharacters: false,
            groups: [{ id: 'g-style', name: '文风' }, { id: 'g-plot', name: '剧情' }],
            assignments: { 许文风: 'g-style', 许剧情甲: 'g-plot', 许剧情乙: 'g-plot', 别的书: 'g-plot' },
        },
    });
    await withHost(VIEWPORTS.desktop, async (cdp) => {
        await cdp.evalFn(() => {
            document.getElementById('gr-global-dropdown-container')?.remove();
            const select = document.getElementById('world_editor_select');
            select.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            const container = document.createElement('div');
            container.id = 'gr-global-dropdown-container';
            container.className = 'gr-container-enhanced open';
            container.dataset.wboSourceRole = 'editor';
            container.style.cssText = 'position:fixed;top:140px;left:20px;width:420px;z-index:9000;background:white;color:#28394b';
            const scroller = document.createElement('div');
            scroller.className = 'gr-options';
            scroller.style.cssText = 'display:block;max-height:420px;overflow:auto';
            scroller.innerHTML = '<div class="gr-search-box" style="position:sticky;bottom:0;padding:4px 8px"><input type="search" spellcheck="false" style="width:100%"></div><div class="gr-options-container"></div>';
            const options = scroller.querySelector('.gr-options-container');
            for (const [index, option] of [...select.options].entries()) {
                const row = document.createElement('div');
                row.className = 'gr-option';
                row.style.minHeight = '29px';
                row.dataset.index = String(index);
                row.dataset.value = option.value;
                row.textContent = option.textContent;
                options.append(row);
            }
            container.append(scroller);
            document.body.append(container);
        });
        await waitForCondition(cdp, () => Boolean(document.querySelector('#gr-global-dropdown-container[data-wbo-popover-role="editor"] .wbo-pop-filter-bar')));
        const typeSearch = (value) => cdp.evalFn((text) => {
            const pop = document.querySelector('#gr-global-dropdown-container');
            const input = pop.querySelector('input[type="search"]');
            input.value = text;
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }, value);
        await typeSearch('许');
        await waitForCondition(cdp, () => Boolean(document.querySelector('.wbo-enhanced-search-panel')));
        const panel = await cdp.evalFn(() => {
            const el = document.querySelector('.wbo-enhanced-search-panel');
            return {
                head: el?.querySelector('.wbo-esp-head')?.textContent?.trim(),
                rows: el?.querySelectorAll('.wbo-esp-row').length,
                first: el?.querySelector('.wbo-esp-row')?.getAttribute('data-wbo-esp'),
                origins: [...(el?.querySelectorAll('.wbo-esp-origin') || [])].map((chip) => chip.textContent.trim()),
            };
        });
        t.diagnostic(JSON.stringify(panel));
        assert.match(panel.head, /搜索匹配到的世界书 \(3\)/);
        assert.equal(panel.rows, 3);
        assert.ok(panel.origins.includes('文风'));
        // Searching stays global: switching a pill must not drop results from other groups.
        await cdp.evalFn(() => {
            document.querySelector('#gr-global-dropdown-container .wbo-dd-pill[data-wbo-pill="g-plot"]')?.click();
        });
        await new Promise((done) => setTimeout(done, 120));
        assert.equal(await cdp.evalFn(() => document.querySelectorAll('.wbo-esp-row').length), 3);
        await cdp.evalFn(() => {
            document.querySelector('#gr-global-dropdown-container .wbo-dd-pill.is-pinned-all')?.click();
        });
        await new Promise((done) => setTimeout(done, 120));
        // Choosing a hit selects that book through the native select.
        await cdp.evalFn(() => document.querySelector('.wbo-esp-row').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
        await waitForCondition(cdp, () => !document.querySelector('.wbo-enhanced-search-panel'));
        assert.equal(await cdp.evalFn(() => document.getElementById('world_editor_select').selectedIndex > 0), true);
        // A term without hits shows the explicit empty state.
        await typeSearch('zzz-无此世界书');
        await waitForCondition(cdp, () => Boolean(document.querySelector('.wbo-esp-empty')));
        // Clearing the term removes the panel again.
        await typeSearch('');
        await waitForCondition(cdp, () => !document.querySelector('.wbo-enhanced-search-panel'));
    }, [], bookSeed);
});

test('enhanced dropdown gets a globals block and a flat favorites list', async () => {
    const threeGlobals = ['全局甲', '全局乙', '全局丙'];
    const enhancedSeed = createDefaultSeed({
        characters: [{ avatar: 'example.png', name: '测试角色', data: { extensions: { world: '角色测试书' } } }],
        worldbooks: Object.fromEntries([...threeGlobals, '角色测试书', '收藏书', '普通甲'].map((name) => [name, { entries: {} }])),
        selected_world_info: threeGlobals,
        pluginSettings: {
            autoScanNewCharacters: false,
            groups: [{ id: 'g-style', name: '文风' }],
            assignments: { 收藏书: 'g-style', 普通甲: 'g-style', 全局甲: 'g-style' },
            pinnedBooks: ['收藏书'],
        },
    });
    await withHost(VIEWPORTS.desktop, async (cdp) => {
        const openEnhanced = () => cdp.evalFn(() => {
            document.getElementById('gr-global-dropdown-container')?.remove();
            const select = document.getElementById('world_editor_select');
            select.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            const container = document.createElement('div');
            container.id = 'gr-global-dropdown-container';
            container.className = 'gr-container-enhanced open';
            container.dataset.wboSourceRole = 'editor';
            container.style.cssText = 'position:fixed;top:140px;left:20px;width:420px;z-index:9000;background:white;color:#28394b';
            const scroller = document.createElement('div');
            scroller.className = 'gr-options';
            scroller.style.cssText = 'display:block;max-height:420px;overflow:auto';
            scroller.innerHTML = '<div class="gr-search-box" style="position:sticky;bottom:0;padding:4px 8px"><input type="search" spellcheck="false" style="width:100%"></div><div class="gr-options-container"></div>';
            const options = scroller.querySelector('.gr-options-container');
            for (const [index, option] of [...select.options].entries()) {
                const row = document.createElement('div');
                row.className = 'gr-option';
                row.style.minHeight = '29px';
                row.dataset.index = String(index);
                row.dataset.value = option.value;
                row.textContent = option.textContent;
                row.classList.toggle('selected', option.value === '');
                options.append(row);
            }
            container.append(scroller);
            document.body.append(container);
        });
        await cdp.evalFn(() => {
            const select = document.getElementById('world_editor_select');
            const chosen = [...select.options].find((item) => item.textContent === '角色测试书');
            window.jQuery(select).val(chosen.value).trigger('change');
        });
        await openEnhanced();
        await waitForCondition(cdp, () => Boolean(document.querySelector('#gr-global-dropdown-container[data-wbo-popover-role="editor"] .wbo-dd-pill[data-wbo-pill="__globals__"]')));
        const globalsSection = await cdp.evalFn((names) => {
            const section = document.querySelector('#gr-global-dropdown-container .wbo-pop-section[data-wbo-dd-group="__globals__"]');
            return {
                head: section?.querySelector(':scope > .wbo-dd-group-head')?.textContent?.trim(),
                rows: [...(section?.querySelectorAll('.gr-option') || [])]
                    .map((row) => names.find((name) => (row.textContent || '').includes(name)) || null),
                firstSection: document.querySelector('#gr-global-dropdown-container .wbo-pop-section')?.getAttribute('data-wbo-dd-group'),
            };
        }, threeGlobals);
        assert.match(globalsSection.head, /全局世界书 \(3\)/);
        assert.deepEqual([...globalsSection.rows].sort(), [...threeGlobals].sort());
        assert.equal(globalsSection.firstSection, '__globals__');
        // The favorites pill is one flat list with an origin badge instead of per-group sections.
        await cdp.evalFn(() => {
            document.querySelector('#gr-global-dropdown-container .wbo-dd-pill[data-wbo-pill="__pinned__"]').click();
        });
        await waitForCondition(cdp, () => {
            const section = document.querySelector('#gr-global-dropdown-container .wbo-pop-section[data-wbo-dd-group="__pinned__"]');
            return Boolean(section && !section.classList.contains('wbo-dd-group-hidden'));
        });
        const flat = await cdp.evalFn(() => {
            const section = document.querySelector('#gr-global-dropdown-container .wbo-pop-section[data-wbo-dd-group="__pinned__"]');
            const row = section?.querySelector('.gr-option');
            return {
                rows: [...(section?.querySelectorAll('.gr-option') || [])].map((item) => (item.textContent || '').includes('收藏书')),
                origin: row?.querySelector('.is-origin')?.textContent?.trim(),
                groupSectionsVisible: [...document.querySelectorAll('#gr-global-dropdown-container .wbo-pop-section[data-wbo-dd-group="g-style"]')]
                    .filter((item) => item.getBoundingClientRect().height > 0).length,
            };
        });
        assert.deepEqual(flat.rows, [true]);
        assert.equal(flat.origin, '文风');
        assert.equal(flat.groupSectionsVisible, 0);
        // Above another group's pill the globals block folds, but its head still opens it.
        await cdp.evalFn(() => {
            document.querySelector('#gr-global-dropdown-container .wbo-dd-pill[data-wbo-pill="g-style"]').click();
        });
        await waitForCondition(cdp, () => document.querySelector('#gr-global-dropdown-container .wbo-pop-section[data-wbo-dd-group="__globals__"]')?.classList.contains('wbo-dd-collapsed'));
        await cdp.evalFn(() => {
            const head = document.querySelector('#gr-global-dropdown-container .wbo-pop-section[data-wbo-dd-group="__globals__"] .wbo-dd-group-head');
            head.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            head.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        });
        await waitForCondition(cdp, () => !document.querySelector('#gr-global-dropdown-container .wbo-pop-section[data-wbo-dd-group="__globals__"]')?.classList.contains('wbo-dd-collapsed'));
    }, [], enhancedSeed);
});
