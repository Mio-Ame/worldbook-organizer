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
const { getServerState, openManager, resetAndBoot, waitForCondition } = await load('assert-helpers.mjs');

test('integrated grouping restores existing settings and only one runtime owns the native entry points', async () => {
    const world = '分组测试书';
    const seed = createDefaultSeed({
        characters: [],
        worldbooks: { [world]: makeBook([makeEntry(0, { comment: '样例条目' })]) },
        selected_world_info: [],
        pluginSettings: { autoScanNewCharacters: false },
        extraPluginSettingsKey: {
            worldbook_entry_groups: {
                books: {
                    [world]: {
                        groups: [{ id: 'fixture-group', name: '已有分组', mode: 'normal' }],
                        assignments: { 0: 'fixture-group' },
                    },
                },
            },
        },
    });
    seed.worldbooks[world].entries['0'].group = '宿主包含组';
    const server = createMockStServer();
    const baseUrl = await server.start();
    let cdp;
    try {
        cdp = await launchEdgeCdp();
        await resetAndBoot(cdp, baseUrl, { seed, viewport: VIEWPORTS.desktop });
        await waitForCondition(cdp, () => !!document.querySelector('link[href*="/src/entry-groups/style.css"]'));
        assert.equal(await cdp.evalFn(() => Boolean(document.querySelector('#weg-wand-entry, #weg-extension-settings'))), false);
        await openManager(cdp);
        await cdp.clickSelector('[data-action="book-more-menu"]');
        await cdp.clickSelector('.wbo-book-more-popover [data-more-act="open-entry-groups"]');
        await waitForCondition(cdp, () => Boolean(document.querySelector('[data-weg-group-card="fixture-group"]')));
        const before = await cdp.evalFn(() => ({
            title: document.querySelector('.weg-group-name').textContent.trim(),
            handles: document.querySelectorAll('.weg-modal .wbo-resize-edge').length,
            oldControl: !!document.querySelector('#weg-btn-mini'),
        }));
        assert.deepEqual(before, { title: '已有分组', handles: 8, oldControl: false });
        await cdp.clickSelector('[data-weg-group-toggle="fixture-group"]');
        await waitForCondition(cdp, async () => {
            const data = await fetch('/__test/state').then((res) => res.json());
            return data.worldbooks['分组测试书'].entries['0'].disable === true;
        });
        const entry = (await getServerState(baseUrl)).worldbooks[world].entries['0'];
        assert.equal(entry.group, '宿主包含组');
        assert.equal(entry.comment, '样例条目');
        assert.deepEqual(cdp.getErrors().runtimeErrors, []);

        await resetAndBoot(cdp, baseUrl, { seed: { ...seed, entryGroupsInstalled: true }, viewport: VIEWPORTS.desktop });
        await openManager(cdp);
        assert.equal(await cdp.evalFn(() => !!document.querySelector('link[href*="/src/entry-groups/style.css"]')), false);
        await cdp.clickSelector('[data-action="book-more-menu"]');
        assert.equal(await cdp.evalFn(() => !!document.querySelector('.wbo-book-more-popover [data-more-act="open-entry-groups"]')), true);
        await cdp.evalFn(async () => {
            const runtime = await import('/scripts/extensions/third-party/worldbook-organizer/index.js');
            runtime.onDisable();
        });
        assert.equal(await cdp.evalFn(() => !!document.querySelector('link[data-weg-style-ver]')), true);
    } finally {
        await cdp?.close();
        await server.stop();
    }
});

test('batch group checkboxes preserve multiselect after moving and pinned entries stay in source order', async () => {
    const world = '批量测试书';
    const seed = createDefaultSeed({
        characters: [],
        worldbooks: { [world]: makeBook([makeEntry(0), makeEntry(1), makeEntry(2)]) },
        selected_world_info: [],
        extraPluginSettingsKey: { worldbook_entry_groups: { books: { [world]: {
            groups: [{ id: 'from', name: '来源组' }, { id: 'to', name: '目标组' }],
            assignments: { 0: 'from', 2: 'from' },
            pinnedEntryUids: ['2'],
        } } } },
    });
    const server = createMockStServer();
    const baseUrl = await server.start();
    let cdp;
    try {
        cdp = await launchEdgeCdp();
        await resetAndBoot(cdp, baseUrl, { seed, viewport: VIEWPORTS.mobile });
        await openManager(cdp);
        await cdp.clickSelector('[data-action="book-more-menu"]');
        await cdp.clickSelector('[data-more-act="open-entry-groups"]');
        const source = '[data-weg-group-card="from"]';
        const rows = (selector) => cdp.evalFn((section) => [...document.querySelectorAll(`${section} [data-weg-entry-row]`)].map((row) => row.dataset.wegEntryRow), selector);
        await waitForCondition(cdp, () => !!document.querySelector('[data-weg-entry-row="2"]'));
        assert.deepEqual(await rows(source), ['0', '2']);
        await cdp.clickSelector('[data-weg-filter="pinned"]');
        assert.deepEqual(await rows(source), ['2']);
        await cdp.clickSelector('[data-weg-filter="all"]');
        assert.equal(await cdp.evalFn(() => Boolean(document.querySelector('.weg-filter-bar .weg-batch-toggle'))), true);
        await cdp.clickSelector('[data-weg-footer-action="enter-batch"]');
        await cdp.clickSelector('[data-weg-entry-row="0"] .weg-entry-main');
        const sourceCheck = '[data-weg-group-batch="from"]';
        assert.equal(await cdp.evalFn((selector) => document.querySelector(selector)?.indeterminate, sourceCheck), true);
        await cdp.clickSelector(sourceCheck);
        const count = () => cdp.evalFn(() => document.querySelector('#weg-footer .weg-footer-status strong')?.textContent);
        assert.equal(await count(), '2');
        assert.deepEqual(await rows(source), ['0', '2']);
        await cdp.clickSelector(sourceCheck);
        assert.equal(await count(), '0');
        await cdp.clickSelector(sourceCheck);
        await cdp.clickSelector('[data-weg-footer-action="batch-move"]');
        await cdp.clickSelector('[data-weg-move-target="to"]');
        assert.equal(await count(), '0');
        assert.deepEqual(await rows('[data-weg-group-card="to"]'), ['0', '2']);
        const undoCount = () => cdp.evalFn(() => document.querySelector('.weg-footer-status-wrap [data-undo-count]').dataset.undoCount);
        const moves = await undoCount();
        await cdp.clickSelector('[data-weg-group-batch="to"]');
        await cdp.clickSelector('[data-weg-footer-action="batch-move"]');
        const uniform = await cdp.evalFn(() => {
            const card = document.querySelector('.weg-move-card');
            const controls = [...card.querySelectorAll('.weg-move-target-btn, #weg-quick-new-move-btn, #weg-quick-new-group-input, .weg-submodal-footer .weg-btn')];
            return controls.map((control) => [control.getBoundingClientRect().height, getComputedStyle(control).fontSize]);
        });
        assert.ok(uniform.length > 0);
        for (const size of uniform) assert.deepEqual(size, [36, '16px']);
        await cdp.clickSelector('[data-weg-move-target="to"]');
        assert.equal(await undoCount(), moves);
        assert.equal(await count(), '2');
        await cdp.clickSelector('[data-weg-group-batch="to"]');
        await cdp.clickSelector('[data-weg-entry-row="1"] .weg-entry-main');
        await cdp.clickSelector('[data-weg-footer-action="batch-move"]');
        await cdp.typeInto('#weg-quick-new-group-input', '新建测试组');
        await cdp.clickSelector('#weg-quick-new-move-btn');
        assert.equal(await count(), '0');
        await cdp.clickSelector('[data-weg-footer-action="exit-batch"]');
        assert.equal(await count(), undefined);
        const point = await cdp.evalFn(() => {
            const handle = document.querySelector('[data-weg-entry-row="2"] [data-weg-entry-drag]');
            const target = document.querySelector('[data-weg-entry-row="0"]');
            const a = handle.getBoundingClientRect();
            const b = target.getBoundingClientRect();
            return [a.left + a.width / 2, a.top + a.height / 2, b.left + b.width / 2, b.top + b.height / 4];
        });
        await cdp.mouseDrag(...point);
        await waitForCondition(cdp, () => [...document.querySelectorAll('[data-weg-group-card="to"] [data-weg-entry-row]')].map((row) => row.dataset.wegEntryRow).join(',') === '2,0');
        const saved = (await getServerState(baseUrl)).worldbooks[world].entries;
        assert.deepEqual(Object.values(saved).sort((a, b) => a.displayIndex - b.displayIndex).map((item) => item.uid), [2, 1, 0]);
        assert.deepEqual(Object.values(saved).map((item) => item.order), Object.values(seed.worldbooks[world].entries).map((item) => item.order));
        assert.deepEqual(cdp.getErrors().runtimeErrors, []);
    } finally {
        await cdp?.close();
        await server.stop();
    }
});

test('an ungrouped-only book starts expanded with a static list header and an independent detection selector', async () => {
    const world = '无分组测试书';
    const books = Array.from({ length: 28 }, (_, idx) => `候选世界书 ${idx}`);
    const seed = createDefaultSeed({
        characters: [],
        worldbooks: {
            [world]: makeBook([makeEntry(0, { comment: '样例：第一条' }), makeEntry(1, { comment: '样例：第二条' })]),
            ...Object.fromEntries(books.map((book) => [book, makeBook([makeEntry(0, { comment: '切换后的条目' })])])),
        },
        pluginSettings: {
            groups: [{ id: 'sample', name: '候选分组' }],
            assignments: Object.fromEntries(books.map((book) => [book, 'sample'])),
        },
        selected_world_info: [],
        extraPluginSettingsKey: { worldbook_entry_groups: { books: { [world]: { ungroupedCollapsed: true } } } },
    });
    const server = createMockStServer();
    const baseUrl = await server.start();
    let cdp;
    try {
        cdp = await launchEdgeCdp();
        await resetAndBoot(cdp, baseUrl, { seed, viewport: VIEWPORTS.mobile });
        await openManager(cdp);
        await cdp.clickSelector(`[data-book="${world}"] [data-action="book-more-menu"]`);
        await cdp.clickSelector('[data-more-act="open-entry-groups"]');
        await waitForCondition(cdp, () => Boolean(document.querySelector('[data-weg-group-card="__ungrouped__"]')));
        const readList = () => cdp.evalFn(() => {
            const section = document.querySelector('[data-weg-group-card="__ungrouped__"]');
            return {
                icon: section.querySelector('.weg-group-header i')?.classList.contains('fa-list-ul'),
                groupToggle: Boolean(section.querySelector('[data-weg-group-header]')),
                collapseAll: Boolean(document.querySelector('[data-weg-footer-action="toggle-collapse-all"]')),
                rows: section.querySelectorAll('[data-weg-entry-row]').length,
            };
        });
        const expected = { icon: true, groupToggle: false, collapseAll: false, rows: 2 };
        assert.deepEqual(await readList(), expected);
        await cdp.clickSelector('.weg-group-header .weg-group-name');
        assert.deepEqual(await readList(), expected);

        await cdp.clickSelector('#weg-btn-auto-detect');
        await waitForCondition(cdp, () => Boolean(document.getElementById('weg-detect-strategy')));
        const strategy = await cdp.evalFn(async () => {
            const select = document.getElementById('weg-detect-strategy');
            const style = document.createElement('style');
            style.dataset.grDropdownStyle = '1';
            document.head.append(style);
            const intercepted = [];
            const intercept = (event) => {
                if (event.target instanceof HTMLSelectElement) {
                    event.preventDefault();
                    intercepted.push(event.type);
                }
            };
            for (const event of ['mousedown', 'touchend', 'keydown']) {
                document.addEventListener(event, intercept, true);
            }
            const prevented = [
                new MouseEvent('mousedown', { bubbles: true, cancelable: true }),
                new Event('touchend', { bubbles: true, cancelable: true }),
                new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
            ].some((event) => !select.dispatchEvent(event));
            document.getElementById('world_info').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
            return {
                labels: [...select.options].map((option) => option.textContent),
                intercepted,
                prevented,
            };
        });
        assert.ok(strategy.labels.some((label) => label.includes('智能综合识别')));
        assert.deepEqual(strategy.intercepted, ['mousedown']);
        assert.equal(strategy.prevented, false);
        await cdp.clickSelector('#weg-submodal-host .weg-submodal-footer [data-weg-sub-close]');
        await cdp.clickSelector('.weg-book-bar .wbo-popup-select-trigger');
        await waitForCondition(cdp, () => Boolean(document.getElementById('wbo-pop-list')));
        const picker = await cdp.evalFn(() => {
            const list = document.getElementById('wbo-pop-list');
            const pills = document.getElementById('wbo-pop-pills');
            const top = pills.getBoundingClientRect().top;
            list.scrollTop = 240;
            return { pinned: list.scrollTop > 0 && Math.abs(pills.getBoundingClientRect().top - top) < 2, external: Boolean(document.getElementById('gr-global-dropdown-container')) };
        });
        assert.deepEqual(picker, { pinned: true, external: false });
        await cdp.typeInto('#wbo-pop-search', books.at(-1));
        const search = await cdp.evalFn(async () => {
            await new Promise((done) => setTimeout(done, 160));
            return { value: document.getElementById('wbo-pop-search')?.value, rows: [...document.querySelectorAll('#wbo-pop-list [data-pop-val]')].map((row) => row.dataset.popVal) };
        });
        assert.deepEqual(search, { value: books.at(-1), rows: [books.at(-1)] });
        await cdp.clickSelector('#wbo-pop-list [data-pop-val]');
        await waitForCondition(cdp, () => document.querySelector('.weg-entry-title')?.textContent.includes('切换后的条目'));
        assert.deepEqual(cdp.getErrors().runtimeErrors, []);
    } finally {
        await cdp?.close();
        await server.stop();
    }
});

test('mobile native locate clears both panels and native group folding preserves rows and pagination', async () => {
    const world = '原生分组测试书';
    const other = '第二本测试书';
    const seed = createDefaultSeed({
        characters: [],
        worldbooks: {
            [world]: makeBook([makeEntry(0, { displayIndex: 10 }), makeEntry(1, { displayIndex: 0 }), makeEntry(2, { displayIndex: 5 })]),
            [other]: makeBook([makeEntry(0)]),
        },
        selected_world_info: [],
        extraPluginSettingsKey: { worldbook_entry_groups: { closeOnLocate: false, books: { [world]: {
            groups: [{ id: 'g1', name: '第一组' }, { id: 'g2', name: '第二组' }],
            assignments: { 0: 'g1', 1: 'g1', 2: 'g2' },
            pinnedEntryUids: ['1'],
        } } } },
    });
    const server = createMockStServer();
    const baseUrl = await server.start();
    let cdp;
    try {
        cdp = await launchEdgeCdp();
        await resetAndBoot(cdp, baseUrl, { seed, viewport: VIEWPORTS.mobile });
        await openManager(cdp);
        await cdp.evalFn(() => {
            document.querySelector('#world_info_sort_order').value = '2';
            const pagination = document.createElement('div');
            pagination.id = 'world_info_pagination';
            document.querySelector('#world_popup_entries_list').before(pagination);
        });
        await cdp.clickSelector(`.wbo-book-row[data-book="${world}"] [data-action="book-more-menu"]`);
        await cdp.clickSelector('[data-more-act="open-entry-groups"]');
        await waitForCondition(cdp, () => !!document.querySelector('[data-weg-entry-menu="0"]'));
        await cdp.clickSelector('[data-weg-entry-menu="0"]');
        const menuItems = await cdp.evalFn(() => [...document.querySelectorAll('#weg-floating-menu [role="menuitem"]')].map((item) => item.textContent.trim()));
        const item = menuItems.indexOf('在酒馆原生编辑器中定位');
        assert.ok(item >= 0);
        await cdp.clickSelector(`#weg-floating-menu [role="menuitem"]:nth-child(${item + 1})`);
        await waitForCondition(cdp, () => Boolean(document.querySelector('.world_entry[uid="0"].weg-entry-locate-flash')));
        assert.equal(await cdp.evalFn(() => document.querySelector('#weg-modal-backdrop').hidden && !document.querySelector('#wbo-manager-overlay')), true);
        assert.equal(await cdp.evalFn(() => Boolean(document.querySelector('#weg-wand-entry, #weg-extension-settings, #weg-native-entry-btn'))), false);
        const nativeOrder = () => cdp.evalFn(() => [...document.querySelectorAll('#world_popup_entries_list > .world_entry')]
            .map((row) => [row.getAttribute('uid'), row.querySelector('.weg-native-group-heading')?.textContent.trim() || null]));
        await waitForCondition(cdp, () => document.querySelectorAll('.weg-native-group-heading').length === 3);
        assert.deepEqual(await nativeOrder(), [['1', '第一组'], ['2', '第二组'], ['0', '第一组']]);
        await cdp.evalFn(() => {
            const list = document.querySelector('#world_popup_entries_list');
            const replacementToolbar = document.createElement('div');
            list.before(replacementToolbar);
            replacementToolbar.append(document.querySelector('#world_info_pagination'));
            const form = document.createElement('form');
            form.innerHTML = '<div><select name="$"><option>原生选项</option><option>第二选项</option></select></div>';
            list.children[1].append(form);
        });
        await waitForCondition(cdp, () => Boolean(document.querySelector('#world_info_pagination + #weg-native-group-manager')));
        assert.equal(await cdp.evalFn(() => document.querySelector('#world_popup_entries_list div:nth-child(2) > form > div select[name="$"]').options.length), 2);
        await cdp.clickSelector('.world_entry[uid="1"] .weg-native-group-heading > button');
        assert.deepEqual(await cdp.evalFn(() => [...document.querySelectorAll('.weg-native-group-heading[data-group-id="g1"] button')].map((button) => button.getAttribute('aria-expanded'))), ['false', 'false']);
        assert.equal(await cdp.evalFn(() => getComputedStyle(document.querySelector('.world_entry[uid="0"] .we-title')).display), 'none');
        await cdp.clickSelector('.world_entry[uid="0"] .weg-native-group-heading > button');
        assert.deepEqual(await nativeOrder(), [['1', '第一组'], ['2', '第二组'], ['0', '第一组']]);
        await cdp.clickSelector('#weg-native-group-manager');
        await waitForCondition(cdp, () => !!document.querySelector('[data-weg-footer-action="enter-batch"]:enabled'));
        const separatedSearch = await cdp.evalFn(() => {
            const hostTheme = document.createElement('style');
            hostTheme.textContent = 'input[type="search"], input[type="text"] { padding: 0 !important } .weg-search-icon { inline-size: 12px }';
            document.head.append(hostTheme);
            const icon = document.querySelector('.weg-search-icon').getBoundingClientRect();
            const field = document.getElementById('weg-search-input').getBoundingClientRect();
            hostTheme.remove();
            return field.left > icon.right;
        });
        assert.equal(separatedSearch, true);
        await cdp.clickSelector('[data-weg-footer-action="enter-batch"]');
        await cdp.clickSelector('[data-weg-entry-row="0"] .weg-entry-main');
        await cdp.clickSelector('[data-weg-footer-action="batch-move"]');
        await cdp.clickSelector('[data-weg-move-target="g2"]');
        await waitForCondition(cdp, () => document.querySelectorAll('.weg-native-group-heading').length === 2);
        assert.deepEqual(await nativeOrder(), [['1', '第一组'], ['2', '第二组'], ['0', null]]);
        assert.deepEqual((await getServerState(baseUrl)).worldbooks[world], seed.worldbooks[world]);

        await cdp.clickSelector('[data-weg-footer-action="exit-batch"]');
        await cdp.setViewport(VIEWPORTS.desktopWide);
        await cdp.evalFn(() => {
            window.__TAURITAVERN_HOST__ = { kind: 'mobile', platform: 'ios' };
            window.__TAURITAVERN__ = { api: { worldInfo: {
                async openEntry(ref) {
                    window.wegTestNativeEntry = { ...ref, unobstructed: document.querySelector('#weg-modal-backdrop').hidden };
                    return { opened: true };
                },
            } } };
        });
        await cdp.clickSelector('[data-weg-entry-menu="0"]');
        await cdp.clickSelector(`#weg-floating-menu [role="menuitem"]:nth-child(${item + 1})`);
        await waitForCondition(cdp, () => Boolean(window.wegTestNativeEntry));
        assert.deepEqual(await cdp.evalFn(() => window.wegTestNativeEntry), { world, uid: '0', unobstructed: true });

        const nativeFields = await cdp.evalFn(() => {
            const list = document.querySelector('#world_popup_entries_list');
            const row = list.querySelector('.world_entry');
            const fields = document.createElement('div');
            fields.className = 'inline-drawer-header WIEnteryHeaderControls';
            fields.style.cssText = 'display:flex;gap:5px;width:100%';
            fields.innerHTML = '<textarea name="comment" spellcheck="false" style="width:180px"></textarea><select name="entryStateSelector" style="width:60px"><option>状态</option></select><select name="position" style="width:140px"><option>位置</option></select><input type="number" name="depth" style="width:65px"><input type="number" name="order" value="895" style="width:42px;padding:0 18px"><input type="number" name="probability" value="100" style="width:42px;padding:0 18px">';
            row.append(fields);
            const headers = document.createElement('div');
            headers.id = 'WIEntryHeaderTitlesPC';
            headers.style.cssText = 'padding:0 7em;display:flex;justify-content:space-between';
            for (const key of ['Title/Memo', 'Strategy', 'Position', 'Depth', 'Order', 'Trigger %']) {
                const label = document.createElement('small');
                label.textContent = key;
                label.setAttribute('data-i18n', key);
                headers.append(label);
            }
            list.prepend(headers);
            const pageSize = document.createElement('select');
            pageSize.style.cssText = 'height:37px;font-size:17px';
            pageSize.add(new Option('25 / page'));
            document.getElementById('world_info_pagination').append(pageSize);
            return fields.children.length;
        });
        assert.equal(nativeFields, 6);
        await waitForCondition(cdp, () => document.querySelector('.weg-native-aligned-columns'));
        assert.deepEqual(await cdp.evalFn(() => {
            const center = (node) => { const rect = node.getBoundingClientRect(); return rect.left + rect.width / 2; };
            const order = document.querySelector('.WIEnteryHeaderControls [name="order"]');
            const probability = document.querySelector('.WIEnteryHeaderControls [name="probability"]');
            const header = document.getElementById('WIEntryHeaderTitlesPC');
            const offset = (key, field) => Math.abs(center(header.querySelector(`[data-i18n="${key}"]`)) - center(field));
            const button = document.getElementById('weg-native-group-manager');
            const size = document.querySelector('#world_info_pagination select');
            return {
                orderOffset: Math.round(offset('Order', order)),
                probabilityOffset: Math.round(offset('Trigger %', probability)),
                orderFits: order.clientWidth > 42,
                probabilityFits: probability.clientWidth > 42,
                font: getComputedStyle(button).fontSize === getComputedStyle(size).fontSize,
                height: Math.abs(button.getBoundingClientRect().height - size.getBoundingClientRect().height) <= 1,
            };
        }), { orderOffset: 0, probabilityOffset: 0, orderFits: true, probabilityFits: true, font: true, height: true });
        await cdp.clickSelector('#weg-native-pinned-entries summary');
        await cdp.clickSelector('#weg-native-pinned-entries button');
        await waitForCondition(cdp, () => window.wegTestNativeEntry?.uid === '1');
        assert.deepEqual(await nativeOrder(), [['1', '第一组'], ['2', '第二组'], ['0', null]]);

        await cdp.setViewport(VIEWPORTS.mobile);
        await cdp.evalFn((bookName) => {
            const settings = window.SillyTavern.getContext().extensionSettings.worldbook_entry_groups;
            const originalBooks = settings.books;
            const originalFetch = window.fetch;
            const stats = { wholeStoreReads: 0, currentBookReads: 0, requests: 0, groupWrites: 0 };
            settings.books = new Proxy(originalBooks, {
                ownKeys(target) { stats.wholeStoreReads++; return Reflect.ownKeys(target); },
                get(target, key) {
                    if (key === bookName) stats.currentBookReads++;
                    return Reflect.get(target, key);
                },
            });
            window.fetch = (resource, ...args) => {
                if (String(resource?.url ?? resource).includes('/api/worldinfo/')) stats.requests++;
                return originalFetch.call(window, resource, ...args);
            };
            const oldPopup = document.querySelector('#world_popup');
            const replacement = oldPopup.cloneNode(false);
            replacement.append(...oldPopup.childNodes);
            oldPopup.replaceWith(replacement);
            const list = document.querySelector('#world_popup_entries_list');
            list.replaceChildren();
            for (const uid of ['1', '2', '0', ...Array.from({ length: 247 }, (_, index) => String(index + 10))]) {
                const row = document.createElement('div');
                row.className = 'world_entry';
                row.setAttribute('uid', uid);
                row.innerHTML = '<form><input type="text" name="comment" spellcheck="false"></form>';
                list.append(row);
            }
            const observer = new MutationObserver((records) => {
                stats.groupWrites += records.filter((record) => record.target.closest?.('.weg-native-group-heading')).length;
            });
            observer.observe(list, { attributes: true, childList: true, subtree: true });
            window.wegTestNativePerformance = {
                stats,
                restore() { observer.disconnect(); window.fetch = originalFetch; settings.books = originalBooks; },
            };
        }, world);
        await waitForCondition(cdp, () => document.querySelectorAll('.weg-native-group-heading').length === 3);
        const editor = '.world_entry[uid="1"] input';
        await cdp.clickSelector(editor);
        const performance = await cdp.evalFn(async (selector) => {
            const native = window.wegTestNativePerformance;
            const field = document.querySelector(selector);
            const before = { ...native.stats };
            for (let index = 0; index < 200; index++) {
                field.value = String(index);
                field.dispatchEvent(new Event('input', { bubbles: true }));
                field.parentElement.append(document.createElement('span'));
            }
            await new Promise((resolve) => setTimeout(resolve, 350));
            const result = { before, after: { ...native.stats }, keptFocus: document.activeElement === field };
            native.restore();
            return result;
        }, editor);
        assert.equal(performance.before.wholeStoreReads, 0);
        assert.ok(performance.before.currentBookReads >= 1 && performance.before.currentBookReads <= 2);
        assert.equal(performance.before.requests, 0);
        assert.deepEqual(performance.after, performance.before);
        assert.equal(performance.keptFocus, true);

        await cdp.evalFn(async () => (await import('/scripts/extensions/third-party/worldbook-organizer/index.js')).onDisable());
        assert.equal(await cdp.evalFn(() => document.querySelectorAll('#weg-native-group-manager, .weg-native-group-heading, .weg-native-group-collapsed').length), 0);
        assert.deepEqual(cdp.getErrors().runtimeErrors, []);
    } finally {
        await cdp?.close();
        await server.stop();
    }
});

test('native entry jump scrolls the nested entries list while the page and drawer controls stay put', async (t) => {
    const world = '定位测试书';
    const seed = createDefaultSeed({
        characters: [],
        worldbooks: { [world]: makeBook(Array.from({ length: 20 }, (_, index) => makeEntry(index))) },
        selected_world_info: [],
    });
    const server = createMockStServer();
    const baseUrl = await server.start();
    let cdp;
    try {
        cdp = await launchEdgeCdp();
        for (const viewport of [{ ...VIEWPORTS.desktop, height: 460 }, { ...VIEWPORTS.mobile, height: 460 }]) {
            await resetAndBoot(cdp, baseUrl, { seed, viewport });
            await cdp.evalFn((book) => {
                const style = document.createElement('style');
                style.textContent = 'body { min-height: 1800px } #WorldInfo { position: fixed; inset: 35px 10px auto; margin: 0; height: 370px; overflow-y: auto } #world_popup_entries_list { height: 125px; margin-bottom: 480px; overflow-y: auto } .world_entry[uid="9"] { min-height: 260px }';
                document.head.append(style);
                const drawer = document.getElementById('WorldInfo');
                drawer.classList.remove('closedDrawer');
                drawer.classList.add('openDrawer');
                const close = document.createElement('button');
                close.type = 'button';
                close.id = 'fixture-close-world-drawer';
                close.textContent = '关闭';
                close.addEventListener('click', () => { drawer.dataset.fixtureClosed = '1'; });
                drawer.prepend(close);
                const select = document.getElementById('world_editor_select');
                const choice = [...select.options].find((option) => option.textContent === book);
                window.jQuery(select).val(choice.value).trigger('change');
                window.scrollTo(0, 480);
            }, world);
            await waitForCondition(cdp, () => document.querySelector('.world_entry[uid="9"]'));
            const positions = await cdp.evalFn(async (book) => {
                const { locateEntryInNativeEditor } = await import('/scripts/extensions/third-party/worldbook-organizer/src/entry-groups/host.js');
                const { openWorldInNativeEditor } = await import('/scripts/extensions/third-party/worldbook-organizer/src/native-filter.js');
                const list = document.getElementById('world_popup_entries_list');
                const drawer = document.getElementById('WorldInfo');
                const close = document.getElementById('fixture-close-world-drawer');
                const read = () => ({
                    page: window.scrollY,
                    overlay: drawer.getBoundingClientRect().top,
                    close: close.getBoundingClientRect().top,
                    shell: drawer.scrollTop,
                    content: list.scrollTop,
                    titleOffset: list.querySelector('.world_entry[uid="9"]').getBoundingClientRect().top - list.getBoundingClientRect().top,
                });
                const before = read();
                const located = await locateEntryInNativeEditor(book, '9', '', { initialWaitMs: 0 });
                const after = read();
                list.scrollTop = 0;
                const openedFromSearch = openWorldInNativeEditor(book, { focusUid: '9' });
                for (let tries = 0; tries < 20 && !list.querySelector('.wbo-entry-locate-flash'); tries++) {
                    await new Promise((done) => setTimeout(done, 80));
                }
                const afterSearch = read();
                list.scrollTop = 0;
                window.__TAURITAVERN__ = { api: { worldInfo: { openEntry: async () => {
                    window.scrollTo(0, 720);
                    drawer.scrollTop = 150;
                    return { opened: true };
                } } } };
                const openedByBridge = await locateEntryInNativeEditor(book, '9');
                delete window.__TAURITAVERN__;
                return { located, openedFromSearch, openedByBridge, before, after, afterSearch, afterBridge: read() };
            }, world);
            const { before, after, afterSearch } = positions;
            t.diagnostic(`${viewport.name} shortened to 460px: ${JSON.stringify({ before, after, afterSearch, afterBridge: positions.afterBridge })}`);
            assert.equal(positions.located, true);
            assert.equal(positions.openedFromSearch, true);
            assert.ok(before.page > 0, JSON.stringify(positions));
            assert.equal(positions.openedByBridge, true);
            for (const measured of [after, afterSearch, positions.afterBridge]) {
                assert.deepEqual(
                    [measured.page, measured.overlay, measured.close, measured.shell],
                    [before.page, before.overlay, before.close, before.shell],
                    JSON.stringify(positions),
                );
                assert.ok(measured.content > before.content && Math.abs(measured.titleOffset) <= 16, JSON.stringify(positions));
            }
            for (const deltaY of [-380, 380]) {
                const point = await cdp.evalFn((delta) => {
                    const list = document.getElementById('world_popup_entries_list');
                    list.scrollTop = delta < 0 ? 0 : list.scrollHeight;
                    const { left, top, width } = list.getBoundingClientRect();
                    const x = left + width / 2;
                    const y = top + 25;
                    return { x, y, inside: list.contains(document.elementFromPoint(x, y)), behavior: getComputedStyle(list).overscrollBehaviorY };
                }, deltaY);
                assert.equal(point.inside, true, JSON.stringify(point));
                assert.equal(point.behavior, 'contain');
                await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY });
                const stable = await cdp.evalFn(async () => {
                    await new Promise((done) => setTimeout(done, 100));
                    return [window.scrollY, document.getElementById('WorldInfo').scrollTop];
                });
                assert.deepEqual(stable, [before.page, before.shell], JSON.stringify(point));
            }
            const hit = await cdp.clickSelector('#fixture-close-world-drawer', { scroll: false });
            assert.equal(hit.hit, true);
            assert.equal(await cdp.evalFn(() => document.getElementById('WorldInfo').dataset.fixtureClosed), '1');
        }
        assert.deepEqual(cdp.getErrors().runtimeErrors, []);
    } finally {
        await cdp?.close();
        await server.stop();
    }
});
