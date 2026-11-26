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

async function openEntryGrouping(cdp, bookRow = '.wbo-book-item') {
    await cdp.clickSelector(`${bookRow} .wbo-book-main`);
    await cdp.clickSelector(`${bookRow} [data-acc-extra="open-entry-groups"]`);
}

async function enableNativeGrouping(cdp) {
    await waitForCondition(cdp, () => document.querySelector('#weg-native-group-enabled:enabled'));
    if (await cdp.evalFn(() => document.getElementById('weg-native-group-enabled').getAttribute('aria-checked') === 'false')) {
        await cdp.clickSelector('#weg-native-group-enabled');
    }
}

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
        assert.equal(await cdp.evalFn(() => document.querySelector('.wbo-book-row [title^="条目分组已配置"]')), null);
        await cdp.clickSelector('[data-action="book-more-menu"]');
        await cdp.pressKey('Escape', 'Escape', 27);
        assert.deepEqual(await cdp.evalFn(() => [
            document.querySelector('[data-action="book-more-menu"]').getAttribute('aria-expanded'),
            Boolean(document.querySelector('.wbo-book-more-popover')),
        ]), ['false', false]);
        await openEntryGrouping(cdp);
        await waitForCondition(cdp, () => Boolean(document.querySelector('[data-weg-group-card="fixture-group"]')));
        const before = await cdp.evalFn(() => ({
            title: document.querySelector('.weg-group-name').textContent.trim(),
            handles: document.querySelectorAll('.weg-modal .wbo-resize-edge').length,
            oldControl: !!document.querySelector('#weg-btn-mini'),
            toolsInline: Math.abs(document.querySelector('.weg-group-tools').getBoundingClientRect().top
                - document.querySelector('.weg-quick-filters').getBoundingClientRect().top) <= 1,
        }));
        assert.deepEqual(before, { title: '已有分组', handles: 8, oldControl: false, toolsInline: true });
        const changeMainTheme = (themePalette, themeMode) => cdp.evalFn(async (palette, mode) => {
            const settings = SillyTavern.getContext().extensionSettings.worldbook_organizer;
            Object.assign(settings, { themePalette: palette, themeMode: mode });
            const { syncAllOpenModalsTheme } = await import('/scripts/extensions/third-party/worldbook-organizer/src/panel-window.js');
            syncAllOpenModalsTheme();
            const modal = document.querySelector('.weg-modal');
            return [modal.dataset.wegPalette, modal.classList.contains('weg-theme-dark') ? 'dark' : 'light'];
        }, themePalette, themeMode);
        assert.deepEqual(await changeMainTheme('warm', 'dark'), ['warm', 'dark']);
        await cdp.clickSelector('#weg-btn-settings');
        assert.deepEqual(await cdp.evalFn(() => [...document.querySelectorAll('.weg-test-feature')].map((label) => label.textContent)),
            ['测试功能', '测试功能']);
        await cdp.evalFn(() => {
            const palette = document.querySelector('#weg-set-palette');
            palette.value = 'paper';
            palette.dispatchEvent(new Event('change', { bubbles: true }));
        });
        assert.deepEqual(await changeMainTheme('sakura', 'light'), ['paper', 'light']);
        await cdp.clickSelector('#weg-submodal-host [data-weg-sub-close]');
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
        await cdp.clickSelector('.wbo-book-row .wbo-book-main');
        assert.equal(await cdp.evalFn(() => !!document.querySelector('[data-acc-extra="open-entry-groups"]')), true);
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

test('entry grouping remembers the selected book position and active group', async () => {
    const books = Array.from({ length: 36 }, (_, index) => `滚动样例 ${String(index).padStart(2, '0')}`);
    const other = '另一组选书样例';
    const charBook = '角色选书样例';
    const selected = books[18];
    const seed = createDefaultSeed({
        characters: [{ avatar: 'picker-fixture.png', name: '选书测试角色', data: { extensions: { world: charBook } } }],
        worldbooks: Object.fromEntries([...books, other, charBook].map((name) => [name, makeBook([makeEntry(0, { comment: name })])])),
        pluginSettings: {
            showCharBooks: true,
            groups: [{ id: 'scroll-fixture', name: '长分组' }, { id: 'other-fixture', name: '另一组' }],
            assignments: { ...Object.fromEntries(books.map((name) => [name, 'scroll-fixture'])), [other]: 'other-fixture' },
        },
    });
    const server = createMockStServer();
    const baseUrl = await server.start();
    let cdp;
    try {
        cdp = await launchEdgeCdp();
        for (const viewport of [VIEWPORTS.desktop, VIEWPORTS.mobile]) {
            await resetAndBoot(cdp, baseUrl, { seed, viewport });
            await openManager(cdp);
            await openEntryGrouping(cdp, `.wbo-book-item[data-book="${books[0]}"]`);
            await waitForCondition(cdp, () => document.querySelector('.weg-book-bar .wbo-popup-select-trigger'));
            const trigger = '.weg-book-bar .wbo-popup-select-trigger';
            const row = `#wbo-pop-list [data-pop-val="${selected}"]`;
            const pill = '[data-pop-pill="scroll-fixture"]';
            const isExpanded = (group) => cdp.evalFn((id) => document.querySelector(`[data-pop-toggle="${id}"]`)?.getAttribute('aria-expanded'), group);
            await cdp.clickSelector(trigger);
            await cdp.clickSelector('[data-pop-toggle="__char__"]');
            assert.equal(await isExpanded('__char__'), 'false');
            await cdp.clickSelector('[data-pop-pill="__char__"]');
            assert.equal(await isExpanded('__char__'), 'true');
            await cdp.clickSelector(`#wbo-pop-list [data-pop-val="${charBook}"]`);
            await waitForCondition(cdp, () => !document.getElementById('wbo-pop-list') && document.querySelector('[data-weg-entry-row="0"]'));
            await cdp.clickSelector(trigger, { scroll: false });
            assert.equal(await cdp.evalFn(() => document.querySelector('[data-pop-pill="__char__"]').classList.contains('is-active')), true);
            await cdp.clickSelector('[data-pop-pill="__all__"]');
            await cdp.clickSelector('[data-pop-toggle="scroll-fixture"]');
            assert.equal(await isExpanded('scroll-fixture'), 'false');
            await cdp.clickSelector(pill);
            assert.equal(await isExpanded('scroll-fixture'), 'true');
            const before = await cdp.evalFn(async (selector) => {
                const list = document.getElementById('wbo-pop-list');
                const item = document.querySelector(selector).closest('.wbo-mp-row');
                list.scrollTop += item.getBoundingClientRect().top - list.getBoundingClientRect().top - 110;
                await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                return { offset: item.getBoundingClientRect().top - list.getBoundingClientRect().top, page: window.scrollY };
            }, row);
            assert.equal((await cdp.clickSelector(row, { scroll: false })).hit, true);
            await waitForCondition(cdp, () => !document.getElementById('wbo-pop-list') && document.querySelector('[data-weg-entry-row="0"]'));
            assert.equal(await cdp.evalFn(() => document.getElementById('weg-book-select').value), selected);
            await cdp.clickSelector(trigger, { scroll: false });
            const after = await cdp.evalFn((selector, group) => {
                const list = document.getElementById('wbo-pop-list');
                return {
                    page: window.scrollY,
                    offset: document.querySelector(selector).closest('.wbo-mp-row').getBoundingClientRect().top - list.getBoundingClientRect().top,
                    correctGroup: document.querySelector(group).classList.contains('is-active'),
                };
            }, row, pill);
            assert.equal(after.correctGroup, true, viewport.name);
            assert.ok(Math.abs(after.offset - before.offset) < 2, JSON.stringify({ viewport: viewport.name, before, after }));
            assert.equal(after.page, before.page);
        }
        assert.deepEqual(cdp.getErrors().runtimeErrors, []);
    } finally {
        await cdp?.close();
        await server.stop();
    }
});

test('collapsing the last group reports when the list must stop at its new bottom', async () => {
    const world = '折叠位置测试书';
    const entries = Array.from({ length: 35 }, (_, index) => makeEntry(index, { disable: index % 2 === 0 }));
    const seed = createDefaultSeed({
        characters: [],
        worldbooks: { [world]: makeBook(entries) },
        extraPluginSettingsKey: { worldbook_entry_groups: { books: { [world]: {
            groups: [{ id: 'first', name: '前面的组' }, { id: 'last', name: '最后一组' }],
            assignments: Object.fromEntries(entries.map((entry, index) => [entry.uid, index >= 26 ? 'last' : 'first'])),
        } } } },
    });
    const server = createMockStServer();
    const baseUrl = await server.start();
    let cdp;
    try {
        cdp = await launchEdgeCdp();
        await resetAndBoot(cdp, baseUrl, { seed, viewport: { ...VIEWPORTS.mobile, height: 520 } });
        await openManager(cdp);
        await openEntryGrouping(cdp);
        const target = '[data-weg-group-header="last"]';
        await waitForCondition(cdp, () => document.querySelector('[data-weg-group-header="last"]'));
        const before = await cdp.evalFn((selector) => {
            const body = document.getElementById('weg-body');
            const header = document.querySelector(selector);
            body.scrollTop += header.getBoundingClientRect().top - body.getBoundingClientRect().top - 6;
            window.toastr.info = (message) => { window.fixtureGroupCollapseNotice = message; };
            return { page: window.scrollY, offset: header.getBoundingClientRect().top - body.getBoundingClientRect().top };
        }, target);
        assert.ok(before.offset < 24);
        await cdp.clickSelector(target, { scroll: false });
        const after = await cdp.evalFn(() => {
            const body = document.getElementById('weg-body');
            return {
                page: window.scrollY,
                atBottom: Math.abs(body.scrollHeight - body.clientHeight - body.scrollTop) <= 1,
                notice: window.fixtureGroupCollapseNotice,
                collapsed: !document.querySelector('[data-weg-entry-row="26"]'),
            };
        });
        assert.deepEqual(after, { page: before.page, atBottom: true, notice: '已折叠「最后一组」', collapsed: true });
        const collapseAll = '.weg-filter-tools #weg-collapse-all';
        for (const filter of ['enabled', 'disabled']) {
            await cdp.clickSelector(`[data-weg-filter="${filter}"]`);
            const snapshot = () => cdp.evalFn(() => ({
                rows: document.querySelectorAll('#weg-body [data-weg-entry-row]').length,
                label: document.querySelector('#weg-collapse-all span').textContent,
            }));
            assert.ok((await snapshot()).rows > 0);
            await cdp.clickSelector(collapseAll);
            assert.deepEqual(await snapshot(), { rows: 0, label: '全部展开' });
            await cdp.clickSelector(collapseAll);
            assert.ok((await snapshot()).rows > 0);
        }
        await cdp.clickSelector('[data-weg-filter="all"]');
        assert.equal(await cdp.evalFn(() => Boolean(document.querySelector('[data-weg-entry-row="26"]'))), false);
    } finally {
        await cdp?.close();
        await server.stop();
    }
});

test('single-book auto grouping completion explains how to dissolve all entry groups', async () => {
    const world = '完成提示测试书';
    const seed = createDefaultSeed({
        characters: [], selected_world_info: [],
        worldbooks: { [world]: makeBook([
            makeEntry(0, { comment: '☯۰•↓多选一·测试身份↓•۰☯', content: '', key: [] }),
            makeEntry(1, { comment: '【身份】样例甲' }),
            makeEntry(2, { comment: '【身份】样例乙' }),
            makeEntry(3, { comment: '【身份】样例丙' }),
        ]) },
    });
    const server = createMockStServer();
    const baseUrl = await server.start();
    let cdp;
    try {
        cdp = await launchEdgeCdp();
        await resetAndBoot(cdp, baseUrl, { seed, viewport: VIEWPORTS.mobile });
        await openManager(cdp);
        await openEntryGrouping(cdp);
        await waitForCondition(cdp, () => document.querySelector('[data-weg-entry-row="0"]'));
        await cdp.evalFn(() => { window.toastr.success = (message) => { window.autoGroupCompletionNotice = message; }; });
        await cdp.clickSelector('#weg-btn-auto-detect');
        await cdp.clickSelector('#weg-detect-apply-btn');
        assert.match(await cdp.evalFn(() => window.autoGroupCompletionNotice), /设置.*「解散全部」.*所有世界书.*未分组/);
        assert.deepEqual(await cdp.evalFn((book) => {
            const config = SillyTavern.getContext().extensionSettings.worldbook_entry_groups.books[book];
            return config.groups.map((group) => ({ name: group.name, mode: group.mode,
                uids: Object.keys(config.assignments).filter((uid) => config.assignments[uid] === group.id) }));
        }, world), [{ name: '测试身份', mode: 'radio', uids: ['1', '2', '3'] }]);
        assert.deepEqual((await getServerState(baseUrl)).worldbooks, seed.worldbooks);
        assert.deepEqual(cdp.getErrors().runtimeErrors, []);
    } finally {
        await cdp?.close();
        await server.stop();
    }
});

test('custom schemes preview across books, stop cleanly and only apply selected entry groups', async () => {
    const bookA = '自动分组甲';
    const bookB = '自动分组乙';
    const seed = createDefaultSeed({
        characters: [],
        worldbooks: {
            [bookA]: makeBook([makeEntry(0, { comment: '约会安排' }), makeEntry(1, { comment: '普通条目', content: '约会' })]),
            [bookB]: makeBook([makeEntry(0, { comment: '约会备选' }), makeEntry(1, { comment: '已分组的约会条目' })]),
            读取失败测试书: { invalid: true },
        },
        selected_world_info: [],
        extraPluginSettingsKey: { worldbook_entry_groups: { books: { [bookB]: {
            groups: [{ id: 'saved', name: '已有分组' }],
            assignments: { 1: 'saved' },
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
        await cdp.clickSelector(`[data-book="${bookA}"] .wbo-book-main`);
        const groupButton = '[data-acc-extra="open-entry-groups"]';
        assert.deepEqual(await cdp.evalFn((selector) => {
            const group = document.querySelector(selector);
            const create = group.nextElementSibling;
            return [group.textContent.trim(), create.textContent.trim(), group.offsetHeight, create.offsetHeight];
        }, groupButton), ['条目分组', '新建条目', 34, 34]);
        await cdp.clickSelector(groupButton);
        await waitForCondition(cdp, () => document.querySelector('[data-weg-entry-row="0"]'));
        await cdp.clickSelector('#weg-btn-auto-detect');
        await waitForCondition(cdp, () => document.querySelector('#weg-detect-only-ungrouped'));
        assert.equal(await cdp.evalFn(() => document.querySelector('#weg-detect-only-ungrouped').checked), true);
        await cdp.clickSelector('#weg-detect-manage-schemes');
        await cdp.typeInto('#weg-scheme-name', '我的测试方案');
        await cdp.typeInto('[data-weg-scheme-keywords]', '约会');
        await cdp.typeInto('[data-weg-scheme-group]', '计划分组');
        await cdp.clickSelector('#weg-scheme-save');
        assert.equal(await cdp.evalFn(() => document.querySelector('#weg-detect-strategy').selectedOptions[0].textContent), '我的测试方案');
        await cdp.evalFn(() => {
            const fetchNow = window.fetch;
            window.fetch = (resource, options) => {
                if (resource === '/api/worldinfo/get' && options?.signal) {
                    window.wegScanFetch = true;
                    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => {
                        window.wegScanAborted = true;
                        window.fetch = fetchNow;
                        reject(options.signal.reason);
                    }, { once: true }));
                }
                return fetchNow(resource, options);
            };
        });
        await cdp.clickSelector('#weg-detect-scan-all');
        await waitForCondition(cdp, () => window.wegScanFetch && !!document.getElementById('weg-detect-progress'));
        await cdp.clickSelector('#weg-detect-back');
        assert.equal(await cdp.evalFn(() => window.wegScanAborted), true);
        await cdp.clickSelector('#weg-detect-scan-all');
        await waitForCondition(cdp, () => document.querySelector('.weg-detect-status[role="status"]')?.textContent.includes('1 本读取失败'));
        await cdp.evalFn(() => { window.toastr.success = (message) => { window.autoGroupCompletionNotice = message; }; });
        const previewed = await cdp.evalFn(() => [...document.querySelector('#weg-detect-preview-book').options].map((option) => option.value));
        assert.deepEqual(new Set(previewed), new Set([bookA, bookB]));
        assert.match(await cdp.evalFn(() => document.querySelector('#weg-detect-preview-book').closest('label').textContent), /点击切换/);
        assert.equal((await getServerState(baseUrl)).extension_settings.worldbook_entry_groups.books[bookA], undefined);
        await cdp.clickSelector('#weg-detect-apply-btn');
        await waitForCondition(cdp, async () => {
            const saved = await fetch('/__test/state').then((res) => res.json());
            const books = saved.extension_settings.worldbook_entry_groups.books;
            return Object.values(books).filter((book) => book.assignments?.['0']).length === 2;
        });
        const saved = (await getServerState(baseUrl)).extension_settings.worldbook_entry_groups;
        assert.match(await cdp.evalFn(() => window.autoGroupCompletionNotice), /设置.*「解散全部」.*所有世界书.*未分组/);
        assert.equal(saved.books[bookA].assignments['1'], undefined);
        assert.equal(saved.books[bookB].assignments['1'], 'saved');
        for (const name of [bookA, bookB]) {
            assert.equal(saved.books[name].groups.find((group) => group.id === saved.books[name].assignments['0']).name, '计划分组');
        }
        assert.equal(saved.autoGroupSchemes[0].name, '我的测试方案');

        await cdp.clickSelector('#weg-btn-auto-detect');
        await waitForCondition(cdp, () => document.querySelector('#weg-detect-only-ungrouped'));
        assert.equal(await cdp.evalFn(() => document.querySelector('#weg-detect-only-ungrouped').checked), true);
        await cdp.evalFn((scheme) => {
            const select = document.querySelector('#weg-detect-strategy');
            select.value = `custom:${scheme}`;
            select.dispatchEvent(new Event('change', { bubbles: true }));
            document.querySelector('#weg-detect-only-ungrouped').click();
        }, saved.autoGroupSchemes[0].id);
        await cdp.clickSelector('#weg-detect-scan-all');
        await waitForCondition(cdp, () => document.querySelector('#weg-detect-apply-btn:enabled'));
        await cdp.clickSelector('#weg-detect-apply-btn');
        await waitForCondition(cdp, () => !document.querySelector('#weg-detect-apply-btn'));
        assert.ok(await cdp.evalFn((secondBook) => {
            const config = SillyTavern.getContext().extensionSettings.worldbook_entry_groups.books[secondBook];
            return config.assignments['1'] === config.assignments['0'] && config.groups.some((group) => group.id === 'saved');
        }, bookB));

        await cdp.clickSelector('#weg-btn-settings');
        await cdp.evalFn(() => {
            window.confirm = (message) => {
                window.wegDissolveMessage = message;
                return Boolean(window.wegAllowDissolve);
            };
        });
        assert.ok((await cdp.clickSelector('.weg-library-danger #weg-dissolve-all-books')).hit);
        assert.match(await cdp.evalFn(() => window.wegDissolveMessage), /2 本世界书/);
        assert.equal(await cdp.evalFn((firstBook) =>
            SillyTavern.getContext().extensionSettings.worldbook_entry_groups.books[firstBook].groups.length, bookA), 1);
        await cdp.evalFn(() => { window.wegAllowDissolve = true; });
        await cdp.clickSelector('#weg-dissolve-all-books');
        const dissolved = await cdp.evalFn(() => SillyTavern.getContext().extensionSettings.worldbook_entry_groups.books);
        assert.deepEqual(dissolved[bookA]?.groups || [], []);
        assert.deepEqual(dissolved[bookA]?.assignments || {}, {});
        assert.deepEqual(dissolved[bookB].groups, []);
        assert.deepEqual(dissolved[bookB].assignments, {});
        assert.deepEqual(dissolved[bookB].pinnedEntryUids, ['1']);
        await cdp.clickSelector('[data-weg-footer-action="undo"]');
        const restored = await cdp.evalFn(() => SillyTavern.getContext().extensionSettings.worldbook_entry_groups.books);
        assert.equal(restored[bookA].groups.length, 1);
        assert.deepEqual(restored[bookB].groups, []);
        assert.deepEqual((await getServerState(baseUrl)).worldbooks, seed.worldbooks);
        assert.deepEqual(cdp.getErrors().runtimeErrors, []);
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
        const bookMore = '[data-action="book-more-menu"]';
        await cdp.clickSelector(bookMore);
        assert.equal(await cdp.evalFn((selector) => document.querySelector(selector).getAttribute('aria-expanded'), bookMore), 'true');
        await cdp.clickSelector(bookMore, { scroll: false });
        assert.equal(await cdp.evalFn((selector) => document.querySelector(selector).getAttribute('aria-expanded'), bookMore), 'false');
        await openEntryGrouping(cdp);
        const source = '[data-weg-group-card="from"]';
        const rows = (selector) => cdp.evalFn((section) => [...document.querySelectorAll(`${section} [data-weg-entry-row]`)].map((row) => row.dataset.wegEntryRow), selector);
        await waitForCondition(cdp, () => !!document.querySelector('[data-weg-entry-row="2"]'));
        assert.deepEqual(await cdp.evalFn(() => {
            const auto = document.getElementById('weg-btn-auto-detect');
            const manual = document.getElementById('weg-btn-new-group');
            const filters = document.querySelector('.weg-quick-filters');
            return {
                label: auto.textContent.trim(),
                sameRow: auto.getBoundingClientRect().top === manual.getBoundingClientRect().top,
                filtersBelow: filters.getBoundingClientRect().top >= auto.getBoundingClientRect().bottom,
                icons: [...auto.parentElement.querySelectorAll('i')].map((icon) => icon.classList[1]),
            };
        }), { label: '自动分组', sameRow: true, filtersBelow: true, icons: ['fa-wand-magic-sparkles', 'fa-folder-plus'] });
        for (const trigger of ['[data-weg-group-menu="from"]', '[data-weg-entry-menu="2"]']) {
            await cdp.clickSelector(trigger);
            assert.deepEqual(await cdp.evalFn((selector) => [
                document.querySelector(selector).getAttribute('aria-expanded'),
                Boolean(document.getElementById('weg-floating-menu')),
            ], trigger), ['true', true]);
            await cdp.clickSelector(trigger, { scroll: false });
            assert.deepEqual(await cdp.evalFn((selector) => [
                document.querySelector(selector).getAttribute('aria-expanded'),
                Boolean(document.getElementById('weg-floating-menu')),
            ], trigger), ['false', false]);
        }
        assert.deepEqual(await rows(source), ['0', '2']);
        await cdp.clickSelector('[data-weg-filter="pinned"]');
        assert.deepEqual(await rows(source), ['2']);
        await cdp.clickSelector('[data-weg-filter="all"]');
        const readMultiButton = () => cdp.evalFn(() => {
            const button = document.querySelector('.weg-filter-bar .weg-batch-toggle');
            const style = getComputedStyle(button);
            return { text: button.textContent.trim(), pressed: button.getAttribute('aria-pressed'), fg: style.color, bg: style.backgroundColor };
        });
        const off = await readMultiButton();
        assert.equal(off.text, '多选');
        assert.equal(off.pressed, 'false');
        await cdp.clickSelector('[data-weg-footer-action="enter-batch"]');
        const on = await readMultiButton();
        assert.equal(on.pressed, 'true');
        assert.equal(on.fg, off.fg);
        assert.notEqual(on.bg, off.bg);
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
        await openEntryGrouping(cdp, `[data-book="${world}"]`);
        await waitForCondition(cdp, () => Boolean(document.querySelector('[data-weg-group-card="__ungrouped__"]')));
        const readList = () => cdp.evalFn(() => {
            const section = document.querySelector('[data-weg-group-card="__ungrouped__"]');
            return {
                icon: section.querySelector('.weg-group-header i')?.classList.contains('fa-list-ul'),
                groupToggle: Boolean(section.querySelector('[data-weg-group-header]')),
                collapseAll: Boolean(document.querySelector('#weg-collapse-all:not([hidden])')),
                rows: section.querySelectorAll('[data-weg-entry-row]').length,
            };
        });
        const expected = { icon: true, groupToggle: false, collapseAll: false, rows: 2 };
        assert.deepEqual(await readList(), expected);
        await cdp.clickSelector('.weg-group-header .weg-group-name');
        assert.deepEqual(await readList(), expected);
        const ungroupedPin = '[data-weg-pin-group="__ungrouped__"]';
        await cdp.clickSelector(ungroupedPin);
        assert.equal(await cdp.evalFn((selector) => document.querySelector(selector).getAttribute('aria-pressed'), ungroupedPin), 'true');
        await cdp.clickSelector('[data-weg-filter="pinned"]');
        assert.equal((await readList()).rows, 2);
        await cdp.clickSelector('[data-weg-filter="all"]');

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

test('inactive native entry survives early events, delayed pagination and shell replacement without loading row enhancement', async () => {
    const world = '入口时序测试书';
    const seed = createDefaultSeed({ characters: [], selected_world_info: [],
        worldbooks: { [world]: makeBook([makeEntry(0)]) },
    });
    const server = createMockStServer();
    const baseUrl = await server.start();
    let cdp;
    try {
        cdp = await launchEdgeCdp();
        for (const viewport of [VIEWPORTS.desktop, VIEWPORTS.mobile]) {
            await resetAndBoot(cdp, baseUrl, { seed, viewport });
            await cdp.evalFn(async (book) => {
                const root = '/scripts/extensions/third-party/worldbook-organizer/src/entry-groups/';
                const lifecycle = await import(`${root}lifecycle.js`);
                lifecycle.stopEntryGrouping();
                window.entryObservers = [];
                const Original = window.MutationObserver;
                window.MutationObserver = class extends Original {
                    constructor(callback) {
                        super(callback);
                        this.entryPoint = new Error().stack.includes('/entry-groups/native-entry-point.js');
                        this.targets = [];
                        if (this.entryPoint) window.entryObservers.push(this);
                    }
                    observe(target, options) {
                        if (this.entryPoint) this.targets.push({ target, options });
                        return super.observe(target, options);
                    }
                    disconnect() { this.targets = []; return super.disconnect(); }
                };
                const query = Element.prototype.querySelectorAll;
                window.entryRowScans = 0;
                Element.prototype.querySelectorAll = function (selector) {
                    if (selector.includes('.world_entry') && /entry-groups\/(?:native-entry-point|lifecycle|native-view)\.js/.test(new Error().stack)) window.entryRowScans++;
                    return query.call(this, selector);
                };
                const getById = Document.prototype.getElementById;
                window.entrySyncReads = 0;
                Document.prototype.getElementById = function (id) {
                    if (id === 'world_info_pagination' && new Error().stack.includes('/entry-groups/native-entry-point.js')) window.entrySyncReads++;
                    return getById.call(this, id);
                };
                await lifecycle.startEntryGrouping('entry-timing-test');
                const select = document.getElementById('world_editor_select');
                select.value = [...select.options].find((option) => option.textContent === book).value;
                const popup = document.getElementById('world_popup');
                document.getElementById('weg-native-entry-controls')?.remove();
                document.getElementById('world_info_pagination')?.remove();
                document.getElementById('world_popup_entries_list').remove();
                const ctx = SillyTavern.getContext();
                await ctx.eventSource.emit(ctx.eventTypes.WORLDINFO_ENTRIES_LOADED, book);
                setTimeout(() => {
                    const list = document.createElement('div');
                    list.id = 'world_popup_entries_list';
                    popup.append(list);
                }, 100);
            }, world);
            await waitForCondition(cdp, () => document.getElementById('weg-native-entry-controls')?.nextElementSibling?.id === 'world_popup_entries_list');
            await cdp.evalFn(() => {
                setTimeout(() => {
                    const pager = document.createElement('div');
                    pager.id = 'world_info_pagination';
                    pager.innerHTML = '<select><option>25</option></select>';
                    document.getElementById('world_popup_entries_list').before(pager);
                }, 100);
            });
            await waitForCondition(cdp, () => document.getElementById('world_info_pagination')?.nextElementSibling?.id === 'weg-native-entry-controls');
            await cdp.evalFn(() => {
                const drawer = document.getElementById('WorldInfo');
                const replacement = drawer.cloneNode(true);
                replacement.querySelector('#world_editor_select').value = drawer.querySelector('#world_editor_select').value;
                replacement.querySelector('#weg-native-entry-controls')?.remove();
                drawer.replaceWith(replacement);
            });
            await waitForCondition(cdp, () => document.getElementById('world_info_pagination')?.nextElementSibling?.id === 'weg-native-entry-controls');
            await cdp.evalFn(() => document.getElementById('weg-native-entry-controls').remove());
            await waitForCondition(cdp, () => document.getElementById('weg-native-entry-controls'));
            const idleReads = await cdp.evalFn(async () => {
                const drawer = document.getElementById('WorldInfo');
                drawer.classList.remove('openDrawer');
                drawer.classList.add('closedDrawer');
                drawer.hidden = true;
                const frames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                await frames();
                window.entrySyncReads = 0;
                const notification = document.createElement('div');
                notification.innerHTML = '<div class="test-notification">测试通知</div>';
                document.body.append(notification);
                await frames();
                notification.remove();
                await frames();
                return window.entrySyncReads;
            });
            assert.equal(idleReads, 0, 'closed drawer ignores unrelated body additions/removals without rechecking the native entry');
            const setPreferences = (patch) => cdp.evalFn(async (patch) => {
                const { getSettings } = await import('/scripts/extensions/third-party/worldbook-organizer/src/entry-groups/host.js');
                Object.assign(getSettings(), patch);
                const ctx = SillyTavern.getContext();
                await ctx.eventSource.emit(ctx.eventTypes.EXTENSION_SETTINGS_LOADED);
                await new Promise((resolve) => setTimeout(resolve, 100));
            }, patch);
            await setPreferences({ showNativeEntryBtn: false });
            assert.equal(await cdp.evalFn(() => document.getElementById('weg-native-entry-controls')), null);
            assert.equal(await cdp.evalFn(() => window.entryObservers.some((observer) => observer.targets.length)), false);
            await cdp.evalFn(() => document.getElementById('world_info_pagination').replaceWith(document.getElementById('world_info_pagination').cloneNode(true)));
            await setPreferences({ showNativeEntryBtn: true, enableNativeGrouping: false });
            await waitForCondition(cdp, () => document.getElementById('weg-native-group-enabled')?.disabled);
            assert.deepEqual(await cdp.evalFn(() => ({
                imports: performance.getEntriesByType('resource').filter((entry) => entry.name.includes('/entry-groups/native-view.js')).length,
                rowScans: window.entryRowScans,
                broadObservers: window.entryObservers.flatMap((observer) => observer.targets).filter(({ target, options }) => options.subtree || target.id === 'world_popup_entries_list' || target.matches('.world_entry')).length,
                controls: document.querySelectorAll('#weg-native-entry-controls').length,
                active: document.getElementById('weg-native-group-enabled').getAttribute('aria-checked'),
            })), { imports: 0, rowScans: 0, broadObservers: 0, controls: 1, active: 'false' });
            await cdp.evalFn(async () => {
                const plugin = await import('/scripts/extensions/third-party/worldbook-organizer/index.js');
                document.getElementById('weg-native-entry-controls').remove();
                await Promise.resolve();
                plugin.onDisable();
                const ctx = SillyTavern.getContext();
                await ctx.eventSource.emit(ctx.eventTypes.WORLDINFO_ENTRIES_LOADED, '入口时序测试书');
                const pager = document.getElementById('world_info_pagination');
                setTimeout(() => pager.replaceWith(pager.cloneNode(true)), 30);
                await new Promise((resolve) => setTimeout(resolve, 120));
            });
            assert.equal(await cdp.evalFn(() => document.getElementById('weg-native-entry-controls')), null);
            assert.equal(await cdp.evalFn(() => window.entryObservers.some((observer) => observer.targets.length)), false);
            assert.deepEqual(cdp.getErrors().runtimeErrors, []);
        }
    } finally {
        await cdp?.close();
        await server.stop();
    }
});

test('native grouping starts dormant until requested and explains once how to hide its entry', async () => {
    const world = '按需分组测试书';
    const seed = createDefaultSeed({ characters: [], selected_world_info: [],
        worldbooks: { [world]: makeBook([makeEntry(0)]) },
    });
    const server = createMockStServer();
    const baseUrl = await server.start();
    let cdp;
    try {
        cdp = await launchEdgeCdp();
        for (const viewport of [VIEWPORTS.desktop, VIEWPORTS.mobile]) {
            await resetAndBoot(cdp, baseUrl, { seed, viewport });
            const selectBook = () => cdp.evalFn((name) => {
                document.getElementById('WorldInfo').style.display = 'block';
                const select = document.getElementById('world_editor_select');
                select.value = [...select.options].find((option) => option.textContent === name).value;
                select.dispatchEvent(new Event('change', { bubbles: true }));
            }, world);
            await selectBook();
            await waitForCondition(cdp, () => document.querySelector('#weg-native-group-enabled'));
            const resourceCount = () => cdp.evalFn(() => performance.getEntriesByType('resource').filter((entry) => entry.name.includes('/entry-groups/native-view.js')).length);
            assert.equal(await resourceCount(), 0, 'the default must not fetch the native enhancement even with its settings permission enabled');
            assert.equal(await cdp.evalFn(() => document.querySelector('#weg-native-group-enabled').getAttribute('aria-checked')), 'false');
            await cdp.evalFn(() => {
                window.nativeEntryTips = [];
                toastr.info = (message) => window.nativeEntryTips.push(message);
            });
            await cdp.clickSelector('#weg-native-group-manager');
            await waitForCondition(cdp, () => document.querySelector('#weg-btn-settings'));
            assert.equal(await resourceCount(), 0, 'the independent manager does not opt into native decoration');
            await cdp.clickSelector('#weg-btn-close');
            await cdp.clickSelector('#weg-native-group-enabled');
            await waitForCondition(cdp, () => document.querySelector('.weg-native-group-heading'));
            assert.equal(await resourceCount(), 1);
            const tips = await cdp.evalFn(() => window.nativeEntryTips);
            assert.equal(tips.length, 1);
            assert.match(tips[0], /条目分组.*设置.*显示原生编辑器分组入口/);
            await cdp.clickSelector('#weg-native-group-enabled');
            await waitForCondition(cdp, () => !document.querySelector('.weg-native-group-heading'));
            await cdp.clickSelector('#weg-native-group-enabled');
            await waitForCondition(cdp, () => document.querySelector('.weg-native-group-heading'));
            assert.equal(await cdp.evalFn(() => window.nativeEntryTips.length), 1, 'repeat clicks must not repeat onboarding');
            await waitForCondition(cdp, async () => (await fetch('/__test/state').then((res) => res.json())).extension_settings.worldbook_entry_groups.nativeEntryHintSeen === true);
            await cdp.reload();
            await waitForCondition(cdp, () => document.getElementById('wbo-wand-entry'));
            await selectBook();
            await waitForCondition(cdp, () => document.querySelector('#weg-native-group-enabled[aria-checked="false"]'));
            assert.equal(await resourceCount(), 0, 'restarting returns to dormant mode without deleting settings');
            await cdp.evalFn(() => {
                window.nativeEntryTips = [];
                toastr.info = (message) => window.nativeEntryTips.push(message);
            });
            await cdp.clickSelector('#weg-native-group-enabled');
            await waitForCondition(cdp, () => document.querySelector('.weg-native-group-heading'));
            assert.equal(await cdp.evalFn(() => window.nativeEntryTips.length), 0, 'the tip is remembered across restarts');
            await cdp.clickSelector('#weg-native-group-manager');
            await cdp.clickSelector('#weg-btn-settings');
            await cdp.clickSelector('#weg-set-native-btn');
            assert.equal(await cdp.evalFn(() => document.querySelector('#weg-native-entry-controls')), null, 'the documented setting removes the entire entry');
            assert.deepEqual(cdp.getErrors().runtimeErrors, []);
        }
    } finally {
        await cdp?.close();
        await server.stop();
    }
});

test('native grouping can stay unloaded, toggles without row observers when off, and preserves the separate panel', async () => {
    const world = '开关测试书';
    const fixture = createDefaultSeed({ characters: [], selected_world_info: [],
        worldbooks: { [world]: makeBook(Array.from({ length: 5 }, (_, uid) => makeEntry(uid, { displayIndex: uid }))) },
        extraPluginSettingsKey: { worldbook_entry_groups: { enableNativeGrouping: false, books: { [world]: {
            groups: [{ id: 'a', name: '甲组' }, { id: 'b', name: '乙组' }], assignments: { 0: 'a', 1: 'b', 2: 'a', 3: 'b' },
        } } } },
    });
    const server = createMockStServer();
    const baseUrl = await server.start();
    let cdp;
    try {
        cdp = await launchEdgeCdp();
        for (const viewport of [VIEWPORTS.desktop, VIEWPORTS.mobile]) {
            await resetAndBoot(cdp, baseUrl, { seed: fixture, viewport });
            await cdp.evalFn((book) => {
                document.getElementById('WorldInfo').style.display = 'block';
                const select = document.getElementById('world_editor_select');
                select.value = [...select.options].find((option) => option.textContent === book).value;
                select.dispatchEvent(new Event('change', { bubbles: true }));
            }, world);
            await waitForCondition(cdp, () => document.querySelectorAll('.world_entry').length === 5);
            const resources = () => cdp.evalFn(() => performance.getEntriesByType('resource').filter((entry) => entry.name.includes('/entry-groups/native-view.js')).length);
            assert.equal(await resources(), 0, 'disabled at boot must not fetch the native list enhancement');
            const nativeNumberWidth = () => cdp.evalFn(() => document.querySelector('.WIEnteryHeaderControls [name="order"]').getBoundingClientRect().width);
            await cdp.evalFn(() => {
                const fields = document.createElement('div');
                fields.className = 'WIEnteryHeaderControls';
                fields.innerHTML = '<input type="number" name="order" value="125" style="width:42px">';
                document.querySelector('.world_entry').append(fields);
            });
            assert.equal(await nativeNumberWidth(), 42, 'disabled grouping must leave native field dimensions alone');
            const toggle = '#weg-native-group-enabled';
            await waitForCondition(cdp, () => document.querySelector('#weg-native-group-enabled[aria-checked="false"]'));
            assert.equal(await cdp.evalFn(() => document.querySelectorAll('.weg-native-group-heading, .weg-native-list-sticky, .weg-native-themed').length), 0);
            await cdp.clickSelector('#weg-native-group-manager');
            await waitForCondition(cdp, () => document.querySelector('[data-weg-group-card="a"]'));
            assert.equal(await resources(), 0, 'opening the standalone panel must not load native enhancement either');
            await cdp.clickSelector('#weg-btn-settings');
            assert.equal(await cdp.evalFn(() => document.querySelector('#weg-set-native-grouping')?.getAttribute('aria-checked')), 'false');
            await cdp.evalFn(() => {
                window.nativeGroupingObservers = [];
                for (const type of ['MutationObserver', 'ResizeObserver']) {
                    const Original = window[type];
                    window[type] = class extends Original {
                        constructor(callback) {
                            super(callback);
                            this.groupingObserver = /entry-groups\/(?:native-view|lifecycle)\.js/.test(new Error().stack);
                        }
                        observe(...args) {
                            if (this.groupingObserver && !window.nativeGroupingObservers.includes(this)) window.nativeGroupingObservers.push(this);
                            this.groupingActive = true;
                            return super.observe(...args);
                        }
                        disconnect() { this.groupingActive = false; return super.disconnect(); }
                    };
                }
            });
            await cdp.clickSelector('#weg-set-native-grouping');
            assert.equal(await resources(), 0, 'granting permission alone must not load the enhancement');
            await cdp.clickSelector('#weg-submodal-host [data-weg-sub-close]');
            await cdp.clickSelector('#weg-btn-close');
            await enableNativeGrouping(cdp);
            await waitForCondition(cdp, () => document.querySelectorAll('.weg-native-group-heading').length === 3);
            assert.ok((await cdp.clickSelector(toggle)).hit);
            await waitForCondition(cdp, () => document.querySelector('#weg-native-group-enabled[aria-checked="false"]'));
            assert.equal(await cdp.evalFn(() => document.querySelectorAll('.weg-native-group-heading, .weg-native-list-sticky, .weg-native-themed, .weg-native-sorted-groups').length), 0);
            assert.equal(await cdp.evalFn(() => window.nativeGroupingObservers.filter((observer) => observer.groupingActive).length), 0);
            assert.equal(await cdp.evalFn(() => [...document.querySelectorAll('.world_entry')].every((row) => !row.style.getPropertyValue('--weg-native-group-rank'))), true);
            assert.equal(await nativeNumberWidth(), 42, 'turning grouping off must remove its numeric-field sizing');
            await cdp.evalFn((book) => window.__ST_HOST_RUNTIME__.reloadEditor(book), world);
            assert.equal(await cdp.evalFn(() => document.querySelectorAll('.weg-native-group-heading').length), 0);
            assert.equal(await cdp.evalFn(() => window.nativeGroupingObservers.filter((observer) => observer.groupingActive).length), 0);
            const geometry = await cdp.evalFn(() => {
                const manager = document.getElementById('weg-native-group-manager').getBoundingClientRect();
                const toggle = document.getElementById('weg-native-group-enabled').getBoundingClientRect();
                const controls = document.getElementById('weg-native-entry-controls');
                return { aligned: Math.abs(manager.top - toggle.top) <= 1 && Math.abs(manager.height - toggle.height) <= 1,
                    inside: toggle.right <= innerWidth && manager.left >= 0, overflow: controls.scrollWidth > controls.clientWidth };
            });
            assert.deepEqual(geometry, { aligned: true, inside: true, overflow: false });
            await cdp.clickSelector(toggle);
            await waitForCondition(cdp, () => document.querySelectorAll('.weg-native-group-heading').length === 3);
            await cdp.clickSelector(toggle);
            await waitForCondition(cdp, () => document.querySelectorAll('.weg-native-group-heading').length === 0);
            await openManager(cdp);
            await cdp.clickSelector('[data-action="open-settings-modal"]');
            await cdp.clickSelector('[data-settings-tab="appearance"]');
            const mainSetting = 'input[data-entry-native-grouping]';
            assert.equal(await cdp.evalFn((selector) => document.querySelector(selector)?.checked, mainSetting), true, 'the runtime switch does not change the settings permission');
            await cdp.clickSelector(mainSetting);
            await waitForCondition(cdp, () => document.querySelectorAll('.weg-native-group-heading').length === 0);
            assert.equal(await cdp.evalFn(() => document.getElementById('weg-native-group-enabled').disabled), true);
            await cdp.clickSelector(mainSetting);
            assert.equal(await cdp.evalFn(() => document.querySelectorAll('.weg-native-group-heading').length), 0, 'restoring permission does not silently activate decoration');
            await cdp.clickSelector(mainSetting);
            await waitForCondition(cdp, async () => (await fetch('/__test/state').then((res) => res.json())).extension_settings.worldbook_entry_groups.enableNativeGrouping === false);
            assert.deepEqual((await getServerState(baseUrl)).worldbooks[world], fixture.worldbooks[world]);
            assert.equal(await cdp.evalFn((book) => SillyTavern.getContext().extensionSettings.worldbook_entry_groups.books[book].assignments['0'], world), 'a');
            await cdp.reload();
            await waitForCondition(cdp, () => !!document.getElementById('wbo-wand-entry'));
            assert.equal(await resources(), 0, 'the persisted off preference must skip the enhancement on restart');
            assert.deepEqual(cdp.getErrors().runtimeErrors, []);
        }
    } finally {
        await cdp?.close();
        await server.stop();
    }
});

test('native group pins and pointer reordering change display only and share undo', async () => {
    const world = '显示排序测试书';
    const fixture = createDefaultSeed({ characters: [], selected_world_info: [],
        worldbooks: { [world]: makeBook(Array.from({ length: 5 }, (_, uid) => makeEntry(uid, { comment: `排序条目 ${uid}`, displayIndex: uid, order: 300 + uid }))) },
        extraPluginSettingsKey: { worldbook_entry_groups: { books: { [world]: {
            groups: [{ id: 'a', name: '甲组', mode: 'if_line' }, { id: 'b', name: '乙组', mode: 'if_line' }], assignments: { 0: 'a', 1: 'b', 2: 'a', 3: 'b' },
        } } } },
    });
    const server = createMockStServer();
    const baseUrl = await server.start();
    let cdp;
    try {
        cdp = await launchEdgeCdp();
        for (const viewport of [VIEWPORTS.desktop, VIEWPORTS.mobile]) {
            await resetAndBoot(cdp, baseUrl, { seed: fixture, viewport });
            await cdp.evalFn((name) => {
                document.getElementById('WorldInfo').style.display = 'block';
                const list = document.getElementById('world_popup_entries_list');
                list.style.cssText = 'height:600px;max-height:600px';
                const select = document.getElementById('world_editor_select');
                select.value = [...select.options].find((option) => option.textContent === name).value;
                select.dispatchEvent(new Event('change', { bubbles: true }));
            }, world);
            await enableNativeGrouping(cdp);
            await waitForCondition(cdp, () => document.querySelectorAll('.weg-native-group-heading').length === 3);
            await cdp.evalFn(() => { window.nativeOriginalRows = [...document.querySelectorAll('.world_entry[uid]')]; });
            const displayOrder = () => cdp.evalFn(() => [...document.querySelectorAll('.world_entry[uid]')]
                .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top).map((row) => row.getAttribute('uid')));
            assert.deepEqual(await displayOrder(), ['0', '2', '1', '3', '4'], 'same-group entries stay together before any pin or drag');
            assert.equal(await cdp.evalFn(() => document.querySelectorAll('.weg-native-group-continuation').length), 0);
            const pin = '.weg-native-group-heading[data-group-id="b"] .weg-native-group-pin';
            await cdp.clickSelector(pin);
            await waitForCondition(cdp, () => document.querySelector('.weg-native-group-heading[data-group-id="b"] .weg-native-group-pin')?.getAttribute('aria-pressed') === 'true');
            assert.deepEqual(await displayOrder(), ['1', '3', '0', '2', '4']);
            await cdp.clickSelector('.weg-native-group-heading[data-group-id="b"] .weg-native-group-undo');
            await waitForCondition(cdp, () => document.querySelector('.weg-native-group-heading[data-group-id="b"] .weg-native-group-pin')?.getAttribute('aria-pressed') === 'false');
            assert.deepEqual(await displayOrder(), ['0', '2', '1', '3', '4']);
            const points = await cdp.evalFn(() => {
                const source = document.querySelector('.weg-native-group-heading[data-group-id="b"] [data-weg-native-group-drag]').getBoundingClientRect();
                const target = document.querySelector('.weg-native-group-heading[data-group-id="a"]').getBoundingClientRect();
                return [source.left + source.width / 2, source.top + source.height / 2, target.left + target.width / 2, target.top + 3];
            });
            await cdp.mouseDrag(...points);
            await waitForCondition(cdp, () => SillyTavern.getContext().extensionSettings.worldbook_entry_groups.books['显示排序测试书'].nativeGroupOrder?.[0] === 'b');
            assert.deepEqual(await displayOrder(), ['1', '3', '0', '2', '4']);
            assert.deepEqual(await cdp.evalFn(async (name) => {
                const { buildInitialProfileFromFloorZero } = await import('/scripts/extensions/third-party/worldbook-organizer/src/entry-groups/core.js');
                const config = SillyTavern.getContext().extensionSettings.worldbook_entry_groups.books[name];
                const profile = buildInitialProfileFromFloorZero({ worldName: name, floorZeroMes: '<!-- lore: 0, 1 -->', bookConfig: config });
                return { businessOrder: config.groups.map((group) => group.id), ifGroup: profile.ifGroupId };
            }, world), { businessOrder: ['a', 'b'], ifGroup: 'a' });
            assert.equal(await cdp.evalFn(() => window.nativeOriginalRows.every((node, index) => node === document.querySelectorAll('.world_entry[uid]')[index])), true);
            await cdp.clickSelector('.weg-native-group-heading[data-group-id="b"] .weg-native-group-undo');
            await waitForCondition(cdp, () => !SillyTavern.getContext().extensionSettings.worldbook_entry_groups.books['显示排序测试书'].nativeGroupOrder?.length);
            assert.deepEqual(await displayOrder(), ['0', '2', '1', '3', '4']);
            assert.deepEqual((await getServerState(baseUrl)).worldbooks[world], fixture.worldbooks[world]);
            assert.deepEqual(cdp.getErrors().runtimeErrors, []);
        }
    } finally {
        await cdp?.close();
        await server.stop();
    }
});

test('native group controls stay reachable while scrolling and undo restores mixed entry states', async () => {
    const world = '长条目分组示例';
    const groups = Array.from({ length: 6 }, (_, index) => ({ id: `g${index}`, name: `分组 ${index + 1}` }));
    const entries = Array.from({ length: 60 }, (_, index) => makeEntry(index, {
        comment: `示例条目 ${index}`, displayIndex: index, order: 200 + index, disable: index % 2 === 1,
    }));
    const assignments = Object.fromEntries(entries.slice(0, 54).map((entry) => [entry.uid, groups[Math.floor(entry.uid / 9)].id]));
    const seed = createDefaultSeed({
        characters: [],
        worldbooks: { [world]: makeBook(entries) },
        extraPluginSettingsKey: { worldbook_entry_groups: { books: { [world]: { groups, assignments } } } },
    });
    const server = createMockStServer();
    const baseUrl = await server.start();
    let cdp;
    try {
        cdp = await launchEdgeCdp();
        for (const viewport of [VIEWPORTS.desktop, VIEWPORTS.mobile]) {
            await resetAndBoot(cdp, baseUrl, { seed, viewport });
            await cdp.evalFn(async (book, simulateRefresh) => {
                const style = document.createElement('style');
                style.textContent = '#world_popup_entries_list { height: 130px; overflow-y: auto } #world_popup_entries_list > .world_entry { min-height: 44px }';
                document.head.append(style);
                const pagination = document.createElement('div');
                pagination.id = 'world_info_pagination';
                const list = document.querySelector('#world_popup_entries_list');
                list.before(pagination);
                if (simulateRefresh) {
                    const runtime = window.__ST_HOST_RUNTIME__;
                    const data = await fetch('/api/worldinfo/get', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ name: book }),
                    }).then((response) => response.json());
                    runtime.worldInfoCache.set(book, data);
                    const $ = window.jQuery;
                    let page = 2;
                    window.jQuery = (element, ...args) => {
                        if (element !== pagination) return $(element, ...args);
                        return {
                            pagination(method, target) {
                                if (method === 'getCurrentPageNum') return page;
                                if (method === 'go') page = target;
                            },
                        };
                    };
                    window.wegReadTestPage = () => page;
                    const reload = runtime.reloadEditor;
                    runtime.reloadEditor = async (name) => {
                        page = 1;
                        for (const node of list.querySelectorAll('div, span, input')) {
                            node.remove();
                        }
                        await reload(name);
                        list.scrollTop = 0;
                    };
                }
                document.querySelector('#WorldInfo').style.display = 'block';
                document.querySelector('#world_info_sort_order').value = '2';
                const pick = document.querySelector('#world_editor_select');
                pick.value = [...pick.options].find((option) => option.textContent === book).value;
                pick.dispatchEvent(new Event('change', { bubbles: true }));
            }, world, viewport === VIEWPORTS.desktop);
            await enableNativeGrouping(cdp);
            await waitForCondition(cdp, () => document.querySelectorAll('.weg-native-group-heading').length === 7);
            await cdp.evalFn(() => {
                for (const row of document.querySelectorAll('#world_popup_entries_list .world_entry[uid]')) {
                    row.classList.toggle('disabledWIEntry', Number(row.getAttribute('uid')) % 2 === 1);
                }
                window.dispatchEvent(new Event('resize'));
            });
            await cdp.evalFn(async () => {
                const panel = await import('/scripts/extensions/third-party/worldbook-organizer/src/entry-groups/panel.js');
                panel.syncAllNativeEntryPoints();
            });
            assert.equal(await cdp.evalFn(() => !!document.getElementById('weg-native-undo')), false, 'no standalone undo above the groups');
            const measureTop = () => cdp.evalFn(() => {
                const list = document.getElementById('world_popup_entries_list');
                return {
                    firstRow: list.querySelector('.world_entry').getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop,
                    stickyHeight: document.querySelector('.weg-native-list-sticky').getBoundingClientRect().height,
                };
            });
            const initialTop = await measureTop();
            assert.equal(initialTop.stickyHeight, 0);
            assert.equal(await cdp.evalFn(() => {
                const group = document.querySelector('.weg-native-group-heading');
                return group.querySelector('.weg-native-group-switch').nextElementSibling.matches('.weg-native-group-undo:disabled')
                    && !!group.querySelector('[data-weg-native-group-drag]') && !!group.querySelector('.weg-native-group-pin');
            }), true);
            const switchGeometry = await cdp.evalFn(() => [...document.querySelectorAll('.weg-native-group-switch > i')].map((node) => {
                const box = node.getBoundingClientRect();
                return [Math.round(box.width), Math.round(box.height)];
            }));
            assert.ok(switchGeometry.filter(([width]) => width > 0).every(([width, height]) => width === 28 && height === 16));
            const sticky = '.weg-native-sticky-group';
            const nativeUndo = `${sticky} .weg-native-group-undo`;
            const scrollTo = (uid) => cdp.evalFn((id) => {
                const list = document.querySelector('#world_popup_entries_list');
                const row = list.querySelector(`.world_entry[uid="${id}"]`);
                list.scrollTop += row.getBoundingClientRect().top - list.getBoundingClientRect().top;
            }, uid);
            await scrollTo(46);
            await waitForCondition(cdp, () => document.querySelector('.weg-native-sticky-group:not([hidden])')?.dataset.groupId === 'g5');
            assert.equal(await cdp.evalFn(() => document.querySelector('.weg-native-sticky-group .weg-native-group-switch').getAttribute('aria-checked')), 'mixed');
            assert.ok(await cdp.evalFn(() => {
                const bar = document.querySelector('.weg-native-list-sticky');
                const list = bar.parentElement;
                return Math.abs(bar.getBoundingClientRect().top - list.getBoundingClientRect().top) < 3
                    && list.scrollTop > 1000;
            }));
            await cdp.evalFn(() => {
                const list = document.querySelector('#world_popup_entries_list');
                const original = list.querySelectorAll;
                list.querySelectorAll = function (selector) {
                    if (selector === '.world_entry[uid]') {
                        list.querySelectorAll = original;
                        throw new Error('测试原生界面刷新中断');
                    }
                    return original.call(this, selector);
                };
            });
            await cdp.clickSelector(`${sticky} .weg-native-group-switch`, { scroll: false });
            await waitForCondition(cdp, () => !!document.querySelector('.weg-native-sticky-group .weg-native-group-switch:enabled'));
            assert.deepEqual((await getServerState(baseUrl)).worldbooks[world], seed.worldbooks[world]);
            assert.ok((await cdp.clickSelector(`${sticky} .weg-native-group-switch`, { scroll: false })).hit);
            await waitForCondition(cdp, () => !!document.querySelector('.weg-native-sticky-group:not([hidden]) .weg-native-group-undo:enabled'));
            assert.equal(await cdp.evalFn(() => {
                const list = document.querySelector('#world_popup_entries_list');
                const button = document.querySelector('.weg-native-sticky-group .weg-native-group-undo');
                return list.contains(button) && list.scrollTop > 1000 && button.getAttribute('aria-label') === '撤销整组开关'
                    && button.previousElementSibling.matches('.weg-native-group-switch') && Boolean(button.querySelector('svg'));
            }), true);
            assert.deepEqual(await measureTop(), initialTop, 'undo history must not insert a toolbar row or shift entries');
            if (viewport === VIEWPORTS.desktop) assert.equal(await cdp.evalFn(() => window.wegReadTestPage()), 2);
            let actual = (await getServerState(baseUrl)).worldbooks[world];
            for (let uid = 0; uid < entries.length; uid++) {
                const expected = uid >= 45 && uid < 54 ? false : uid % 2 === 1;
                assert.equal(Boolean(actual.entries[uid].disable), expected, `entry ${uid}`);
            }
            await scrollTo(56);
            await waitForCondition(cdp, () => document.querySelector('.weg-native-sticky-group:not([hidden])')?.querySelector('span')?.textContent === '未分组');
            assert.ok((await cdp.clickSelector(nativeUndo, { scroll: false })).hit);
            await waitForCondition(cdp, () => !!document.querySelector('.weg-native-sticky-group .weg-native-group-undo:disabled'));
            actual = (await getServerState(baseUrl)).worldbooks[world];
            assert.deepEqual(actual, seed.worldbooks[world]);

            assert.ok((await cdp.clickSelector(`${sticky} .weg-native-group-switch`, { scroll: false })).hit);
            await waitForCondition(cdp, () => !!document.querySelector('.weg-native-sticky-group .weg-native-group-undo:enabled'));
            actual = (await getServerState(baseUrl)).worldbooks[world];
            assert.ok([54, 55, 56, 57, 58, 59].every((uid) => !actual.entries[uid].disable));
            for (let index = 0; index < 4; index++) {
                assert.ok((await cdp.clickSelector(`${sticky} .weg-native-group-switch`, { scroll: false })).hit);
                await waitForCondition(cdp, () => !!document.querySelector('.weg-native-sticky-group .weg-native-group-switch:enabled'));
                const changed = (await getServerState(baseUrl)).worldbooks[world];
                assert.ok([54, 55, 56, 57, 58, 59].every((uid) => changed.entries[uid].disable === (index % 2 === 0)));
            }
            for (let index = 0; index < 4; index++) {
                assert.ok((await cdp.clickSelector(nativeUndo, { scroll: false })).hit);
                await waitForCondition(cdp, () => !!document.querySelector('.weg-native-sticky-group .weg-native-group-undo:enabled'));
            }
            await cdp.evalFn((book) => window.dispatchEvent(new CustomEvent('weg:open-panel', { detail: { worldName: book } })), world);
            await waitForCondition(cdp, () => Boolean(document.querySelector('[data-weg-footer-action="undo"]:not([hidden]):enabled')));
            assert.equal(await cdp.evalFn(() => document.querySelector('[data-weg-footer-action="undo"]').textContent.trim()), '撤销整组开关');
            await cdp.clickSelector('[data-weg-footer-action="undo"]');
            await waitForCondition(cdp, () => document.querySelector('[data-weg-footer-action="undo"]')?.hidden);
            assert.deepEqual((await getServerState(baseUrl)).worldbooks[world], seed.worldbooks[world]);
            assert.deepEqual(cdp.getErrors().runtimeErrors, []);
        }
    } finally {
        await cdp?.close();
        await server.stop();
    }
});

test('mobile native locate clears both panels and native group folding preserves rows and pagination', async (t) => {
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
        await openEntryGrouping(cdp, `.wbo-book-item[data-book="${world}"]`);
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
        await enableNativeGrouping(cdp);
        await waitForCondition(cdp, () => document.querySelectorAll('.weg-native-group-heading').length === 2);
        const continuation = '.world_entry[uid="0"] .weg-native-group-continuation';
        assert.deepEqual(await nativeOrder(), [['1', '第一组'], ['2', '第二组'], ['0', null]]);
        assert.equal(await cdp.evalFn((selector) => document.querySelector(selector), continuation), null);
        assert.deepEqual(await cdp.evalFn(() => [...document.querySelectorAll('.world_entry[uid]')]
            .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top).map((row) => row.getAttribute('uid'))), ['1', '0', '2']);
        assert.equal(await cdp.evalFn(() => document.querySelectorAll('.weg-native-group-heading .weg-native-group-chevron').length), 2);
        const switching = await cdp.evalFn(async (firstBook, secondBook) => {
            const pick = document.getElementById('world_editor_select');
            const idle = window.requestIdleCallback;
            window.requestIdleCallback = (callback) => setTimeout(callback, 1000);
            const results = [];
            try {
                for (const book of [secondBook, firstBook, secondBook, firstBook]) {
                    pick.value = [...pick.options].find((option) => option.textContent === book).value;
                    await window.__ST_HOST_RUNTIME__.reloadEditor(book);
                    const started = performance.now();
                    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                    results.push({
                        count: document.querySelectorAll('.weg-native-group-heading').length,
                        elapsed: Math.round(performance.now() - started),
                    });
                }
            } finally {
                window.requestIdleCallback = idle;
            }
            return results;
        }, world, other);
        assert.deepEqual(switching.map((result) => result.count), [1, 2, 1, 2]);
        t.diagnostic(`Native group rendering after book switch ${JSON.stringify(switching)}`);
        await cdp.evalFn(() => {
            const list = document.querySelector('#world_popup_entries_list');
            const replacementToolbar = document.createElement('div');
            list.before(replacementToolbar);
            replacementToolbar.append(document.querySelector('#world_info_pagination'));
            const form = document.createElement('form');
            form.innerHTML = '<div><select name="$"><option>原生选项</option><option>第二选项</option></select></div>';
            list.querySelector('.world_entry[uid="2"]').append(form);
        });
        await waitForCondition(cdp, () => Boolean(document.querySelector('#world_info_pagination + #weg-native-entry-controls #weg-native-group-manager')));
        assert.equal(await cdp.evalFn(() => document.querySelector('.world_entry[uid="2"] > form > div select[name="$"]').options.length), 2);
        await cdp.clickSelector('.world_entry[uid="1"] .weg-native-group-disclosure');
        assert.deepEqual(await cdp.evalFn(() => [...document.querySelectorAll('.weg-native-group-heading[data-group-id="g1"] .weg-native-group-disclosure')].map((button) => button.getAttribute('aria-expanded'))), ['false']);
        assert.equal(await cdp.evalFn(() => document.querySelector('.world_entry[uid="0"] .we-title').getBoundingClientRect().height), 0);
        await cdp.clickSelector('.world_entry[uid="1"] .weg-native-group-disclosure');
        assert.equal(await cdp.evalFn((selector) => document.querySelector(selector), continuation), null);
        for (let index = 0; index < 4; index++) {
            assert.ok((await cdp.clickSelector('.world_entry[uid="1"] .weg-native-group-disclosure')).hit);
            assert.equal(await cdp.evalFn(() => document.querySelector('.world_entry[uid="1"] .weg-native-group-disclosure').getAttribute('aria-expanded')), String(index % 2 === 1));
        }
        await cdp.clickSelector('#weg-native-group-manager');
        await waitForCondition(cdp, () => !!document.querySelector('[data-weg-footer-action="enter-batch"]:enabled'));
        const mobileWindow = '.weg-modal [data-wbo-fullscreen-btn="entry-groups"]';
        const entryWindowHeight = () => cdp.evalFn(() => document.querySelector('.weg-modal').getBoundingClientRect().height);
        const fullHeight = await entryWindowHeight();
        assert.equal(fullHeight, VIEWPORTS.mobile.height);
        await cdp.clickSelector(mobileWindow);
        assert.ok(await entryWindowHeight() < fullHeight);
        await cdp.clickSelector(mobileWindow);
        assert.equal(await entryWindowHeight(), fullHeight);
        await cdp.evalFn(() => {
            document.getElementById('world_popup').style.backgroundColor = 'rgb(245, 245, 241)';
            document.documentElement.style.setProperty('--SmartThemeBodyColor', 'rgb(38, 45, 50)');
            document.documentElement.style.setProperty('--SmartThemeBlurTintColor', 'rgba(220, 230, 232, 0.6)');
        });
        await waitForCondition(cdp, () => document.querySelector('#world_popup_entries_list.weg-theme-light[data-weg-palette="host"]'));
        const nativeThemeCss = () => cdp.evalFn(() => {
            const heading = document.querySelector('.weg-native-group-heading');
            return {
                background: getComputedStyle(heading).backgroundColor,
                shadow: getComputedStyle(heading).boxShadow,
                chevron: getComputedStyle(heading.querySelector('.weg-native-group-chevron')).borderRightWidth,
                rowColor: getComputedStyle(heading.nextElementSibling).color,
            };
        });
        const hostStyle = await nativeThemeCss();
        assert.notEqual(hostStyle.shadow, 'none');
        assert.equal(hostStyle.chevron, '2px');
        await cdp.clickSelector('#weg-btn-settings');
        const nativeThemeSwitch = '#weg-set-native-theme';
        assert.equal(await cdp.evalFn((selector) => document.querySelector(selector).getAttribute('aria-checked'), nativeThemeSwitch), 'true');
        await cdp.evalFn(() => {
            for (const [id, value] of [['weg-set-palette', 'warm'], ['weg-set-colormode', 'dark']]) {
                const select = document.getElementById(id);
                select.value = value;
                select.dispatchEvent(new Event('change', { bubbles: true }));
            }
        });
        await cdp.clickSelector(nativeThemeSwitch);
        await waitForCondition(cdp, () => document.querySelector('#world_popup_entries_list.weg-theme-dark[data-weg-palette="warm"]'));
        const panelStyle = await nativeThemeCss();
        assert.notEqual(panelStyle.background, hostStyle.background);
        assert.equal(panelStyle.rowColor, hostStyle.rowColor);
        await cdp.clickSelector(nativeThemeSwitch);
        await waitForCondition(cdp, () => document.querySelector('#world_popup_entries_list.weg-theme-light[data-weg-palette="host"]'));
        assert.deepEqual(await nativeThemeCss(), hostStyle);
        await cdp.clickSelector('#weg-submodal-host [data-weg-sub-close]');
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
        await cdp.clickSelector('[data-weg-entry-row="0"] .weg-entry-main');
        const advance = '.weg-acc-advanced';
        await waitForCondition(cdp, () => document.querySelector('.weg-acc-advanced'));
        assert.equal(await cdp.evalFn((selector) => document.querySelector(selector).open, advance), false);
        assert.equal(await cdp.evalFn(() => getComputedStyle(document.querySelector('.weg-acc-find-input')).fontSize), '13px');
        await cdp.clickSelector(`${advance} > summary`);
        assert.equal(await cdp.evalFn((selector) => document.querySelector(selector).open, advance), true);
        await cdp.clickSelector('[data-weg-acc-action="collapse"]');
        await cdp.clickSelector('[data-weg-footer-action="enter-batch"]');
        await cdp.clickSelector('[data-weg-entry-row="0"] .weg-entry-main');
        await cdp.clickSelector('[data-weg-footer-action="batch-move"]');
        await cdp.clickSelector('[data-weg-move-target="g2"]');
        await waitForCondition(cdp, () => !document.querySelector('.world_entry[uid="0"] .weg-native-group-continuation'));
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
            headers.firstElementChild.className = 'flex1';
            const hostStyle = document.createElement('style');
            hostStyle.textContent = '.flex1 { flex: 1; min-width: 0 } #WIEntryHeaderTitlesPC { gap: 10px }';
            document.head.append(hostStyle);
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
                titleOffset: Math.round(offset('Title/Memo', document.querySelector('.inline-drawer-header [name="comment"]'))),
                strategyOffset: Math.round(offset('Strategy', document.querySelector('.inline-drawer-header [name="entryStateSelector"]'))),
                orderOffset: Math.round(offset('Order', order)),
                probabilityOffset: Math.round(offset('Trigger %', probability)),
                orderFits: order.clientWidth > 42,
                probabilityFits: probability.clientWidth > 42,
                font: getComputedStyle(button).fontSize === getComputedStyle(size).fontSize,
                height: Math.abs(button.getBoundingClientRect().height - size.getBoundingClientRect().height) <= 1,
            };
        }), { titleOffset: 0, strategyOffset: 0, orderOffset: 0, probabilityOffset: 0, orderFits: true, probabilityFits: true, font: true, height: true });
        await cdp.evalFn(async () => {
            document.querySelector('.inline-drawer-header [name="depth"]').style.display = 'none';
            const panel = await import('/scripts/extensions/third-party/worldbook-organizer/src/entry-groups/panel.js');
            panel.syncAllNativeEntryPoints();
        });
        assert.equal(await cdp.evalFn(() => document.querySelector('#WIEntryHeaderTitlesPC [data-i18n="Depth"]').getBoundingClientRect().width), 0,
            'a hidden depth input must not align its title to the adjacent order input');
        // A host layout may hide an optional column or split controls into sibling blocks.
        await cdp.evalFn(async () => {
            const row = document.querySelector('.inline-drawer-header');
            row.querySelector('[name="depth"]').style.display = 'none';
            const sibling = document.createElement('div');
            sibling.className = 'WIEnteryHeaderControls';
            sibling.style.cssText = 'display:flex;gap:5px';
            sibling.append(row.querySelector('[name="order"]'), row.querySelector('[name="probability"]'));
            row.after(sibling);
            const panel = await import('/scripts/extensions/third-party/worldbook-organizer/src/entry-groups/panel.js');
            panel.syncAllNativeEntryPoints();
        });
        await waitForCondition(cdp, () => {
            const header = document.getElementById('WIEntryHeaderTitlesPC');
            const row = document.querySelector('.world_entry:has(.inline-drawer-header)');
            return [['Title/Memo', 'comment'], ['Strategy', 'entryStateSelector'], ['Order', 'order'], ['Trigger %', 'probability']].every(([key, name]) => {
                const a = header.querySelector(`[data-i18n="${key}"]`).getBoundingClientRect();
                const b = row.querySelector(`[name="${name}"]`).getBoundingClientRect();
                return Math.abs(a.left + a.width / 2 - b.left - b.width / 2) <= 1;
            });
        });
        for (const zoom of [0.8, 1.25]) {
            await cdp.evalFn((value) => { document.getElementById('world_popup_entries_list').style.zoom = value; }, zoom);
            await waitForCondition(cdp, () => {
                const header = document.getElementById('WIEntryHeaderTitlesPC');
                const row = document.querySelector('.world_entry:has(.inline-drawer-header)');
                return [['Title/Memo', 'comment'], ['Strategy', 'entryStateSelector'], ['Order', 'order']].every(([label, name]) => {
                    const a = header.querySelector(`[data-i18n="${label}"]`).getBoundingClientRect();
                    const b = row.querySelector(`[name="${name}"]`).getBoundingClientRect();
                    return Math.abs(a.left + a.width / 2 - b.left - b.width / 2) <= 1;
                });
            });
        }
        await cdp.evalFn(() => { document.getElementById('world_popup_entries_list').style.removeProperty('zoom'); });
        const drawerGeometry = await cdp.evalFn(() => {
            const list = document.getElementById('world_popup_entries_list');
            const previousStyle = list.getAttribute('style');
            list.style.cssText = 'height:620px;max-height:620px;overflow-y:auto';
            const measure = () => {
                const title = document.querySelector('#WIEntryHeaderTitlesPC [data-i18n="Title/Memo"]').getBoundingClientRect();
                const field = document.querySelector('.inline-drawer-header [name="comment"]').getBoundingClientRect();
                return { width: list.clientWidth, scrolls: list.scrollHeight > list.clientHeight,
                    title: title.left + title.width / 2, field: field.left + field.width / 2 };
            };
            const before = measure();
            const editor = document.createElement('div');
            editor.style.height = '1200px';
            list.querySelector('.world_entry').append(editor);
            const expanded = measure();
            editor.remove();
            const collapsed = measure();
            if (previousStyle === null) list.removeAttribute('style');
            else list.setAttribute('style', previousStyle);
            return { before, expanded, collapsed };
        });
        assert.equal(drawerGeometry.before.scrolls, false);
        assert.equal(drawerGeometry.expanded.scrolls, true);
        assert.equal(drawerGeometry.expanded.width, drawerGeometry.before.width);
        assert.equal(drawerGeometry.expanded.field, drawerGeometry.before.field);
        assert.equal(drawerGeometry.expanded.title, drawerGeometry.before.title);
        assert.deepEqual(drawerGeometry.collapsed, drawerGeometry.before);
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
        await enableNativeGrouping(cdp);
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

test('native numeric fields show three digits beside their spinners and the grouping entry has hover feedback', async (t) => {
    const world = '数字框测试书';
    const seed = createDefaultSeed({ characters: [], selected_world_info: [],
        worldbooks: { [world]: makeBook([makeEntry(0)]) },
        extraPluginSettingsKey: { worldbook_entry_groups: { enableNativeGrouping: true } },
    });
    const server = createMockStServer();
    const baseUrl = await server.start();
    let cdp;
    try {
        cdp = await launchEdgeCdp();
        await resetAndBoot(cdp, baseUrl, { seed, viewport: VIEWPORTS.desktop });
        await cdp.evalFn((book) => {
            document.getElementById('WorldInfo').style.display = 'block';
            const select = document.getElementById('world_editor_select');
            select.value = [...select.options].find((option) => option.textContent === book).value;
            select.dispatchEvent(new Event('change', { bubbles: true }));
        }, world);
        await waitForCondition(cdp, () => document.querySelector('.world_entry'));
        await cdp.evalFn(() => {
            const fields = document.createElement('div');
            fields.className = 'WIEnteryHeaderControls';
            fields.style.cssText = 'display:flex;gap:5px';
            fields.innerHTML = '<input type="number" name="order" value="999" style="width:42px;padding:0 18px;font-size:24px"><input type="number" name="probability" value="100" min="0" max="100" style="width:42px;padding:0 18px;font-size:24px">';
            document.querySelector('.world_entry').append(fields);
            const size = document.createElement('select');
            size.style.cssText = 'height:37px;font-size:17px';
            size.add(new Option('25'));
            const pagination = document.createElement('div');
            pagination.id = 'world_info_pagination';
            pagination.append(size);
            const toolbar = document.createElement('div');
            toolbar.style.cssText = 'display:flex;align-items:center;gap:4px;flex-wrap:nowrap';
            toolbar.append(pagination);
            document.getElementById('world_popup_entries_list').before(toolbar);
        });
        await waitForCondition(cdp, () => document.querySelector('#weg-native-group-enabled[aria-checked="false"]'));
        // The injected pager replaces the old anchor on the next frame. Wait for that move before measuring a click.
        await waitForCondition(cdp, () => document.getElementById('world_info_pagination')?.nextElementSibling?.id === 'weg-native-entry-controls');
        assert.equal((await cdp.clickSelector('#weg-native-group-enabled')).hit, true);
        await waitForCondition(cdp, () => document.querySelector('.weg-native-themed'));
        await waitForCondition(cdp, () => document.querySelector('.WIEnteryHeaderControls [name="order"]').offsetWidth > 42);
        const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
        const descendants = (node) => [node, ...(node.children || []).flatMap(descendants), ...(node.shadowRoots || []).flatMap(descendants)];
        const nodes = descendants(root);
        for (const name of ['order', 'probability']) {
            const input = nodes.find((node) => node.nodeName === 'INPUT' && node.attributes?.some((attr, i, attrs) => attr === 'name' && attrs[i + 1] === name));
            const shadow = descendants(input);
            const editor = shadow.find((node) => node.attributes?.includes('editing-view-port'));
            assert.ok(editor, 'inspect the actual native number editor, including the spinner allocation');
            const { object } = await cdp.send('DOM.resolveNode', { nodeId: editor.nodeId });
            const { result } = await cdp.send('Runtime.callFunctionOn', {
                objectId: object.objectId, returnByValue: true,
                functionDeclaration: `function () {
                    const range = document.createRange();
                    range.selectNodeContents(this);
                    const rect = this.getBoundingClientRect();
                    const container = this.parentElement.getBoundingClientRect();
                    const spinner = this.getRootNode().getElementById('spin').getBoundingClientRect();
                    const right = Math.min(rect.right, container.right, spinner.width ? spinner.left : container.right);
                    return { text: this.textContent, available: right - Math.max(rect.left, container.left),
                        textWidth: range.getBoundingClientRect().width, font: getComputedStyle(this).fontSize };
                }`,
            });
            t.diagnostic(JSON.stringify({ name, measured: result.value }));
            await t.test(`${name} displays three digits`, () => {
                assert.ok(result.value.available >= result.value.textWidth, `${name} must display all three digits: ${JSON.stringify(result.value)}`);
            });
            await cdp.send('Runtime.releaseObject', { objectId: object.objectId });
        }
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
        const button = await cdp.evalFn(() => {
            const node = document.getElementById('weg-native-group-manager');
            node.scrollIntoView({ block: 'nearest' });
            const rect = node.getBoundingClientRect();
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;
            return { x, y, inside: node.contains(document.elementFromPoint(x, y)), background: getComputedStyle(node).backgroundColor };
        });
        assert.equal(button.inside, true, JSON.stringify(button));
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: button.x, y: button.y });
        const hovered = await cdp.evalFn(async () => {
            await new Promise((done) => setTimeout(done, 200));
            const button = document.getElementById('weg-native-group-manager');
            const size = document.querySelector('#world_info_pagination select');
            const style = getComputedStyle(button);
            return { background: style.backgroundColor, hover: button.matches(':hover'), border: parseFloat(style.borderInlineStartWidth),
                sameHeight: Math.abs(button.getBoundingClientRect().height - size.getBoundingClientRect().height) <= 1 };
        });
        await t.test('the entry has a visible hover state beside the pager', () => {
            assert.equal(hovered.hover, true, JSON.stringify(hovered));
            assert.notEqual(hovered.background, button.background, 'the grouping entry must visibly respond to hover');
            assert.ok(hovered.border >= 1);
            assert.equal(hovered.sameHeight, true);
        });
        await cdp.setViewport(VIEWPORTS.mobile);
        const mobile = await cdp.evalFn(() => {
            const button = document.getElementById('weg-native-group-manager');
            const label = button.querySelector('.weg-native-entry-label');
            const pager = document.querySelector('#world_info_pagination select').getBoundingClientRect();
            const rect = button.getBoundingClientRect();
            const undo = document.querySelector('.weg-native-group-heading .weg-native-group-undo').getBoundingClientRect();
            const toggle = document.querySelector('.weg-native-group-heading .weg-native-group-switch').getBoundingClientRect();
            return { label: label.getBoundingClientRect().width, sameRow: Math.abs(rect.top - pager.top) <= 1,
                inside: document.getElementById('weg-native-entry-controls').getBoundingClientRect().right <= innerWidth,
                undo: { width: undo.width, height: undo.height }, toggle: { width: toggle.width, height: toggle.height } };
        });
        await t.test('mobile keeps the entry label and full size group touch targets', () => {
            assert.ok(mobile.label > 0, 'mobile must retain the grouping entry text');
            assert.equal(mobile.sameRow, true);
            assert.equal(mobile.inside, true);
            assert.ok(mobile.undo.width >= 44 && mobile.undo.height >= 44);
            assert.ok(mobile.toggle.width >= 44 && mobile.toggle.height >= 44);
        });
        const nativeBehavior = await cdp.evalFn(() => {
            const order = document.querySelector('.WIEnteryHeaderControls [name="order"]');
            const probability = document.querySelector('.WIEnteryHeaderControls [name="probability"]');
            order.stepDown();
            probability.stepDown();
            return [order.type, order.value, probability.type, probability.value];
        });
        assert.deepEqual(nativeBehavior, ['number', '998', 'number', '99']);
        await cdp.clickSelector('#weg-native-group-enabled');
        await waitForCondition(cdp, () => !document.querySelector('.weg-native-themed'));
        assert.equal(await cdp.evalFn(() => document.querySelector('.WIEnteryHeaderControls [name="order"]').getBoundingClientRect().width), 42,
            'turning native grouping off must restore the host numeric dimensions');
        assert.deepEqual(cdp.getErrors().runtimeErrors, []);
    } finally {
        await cdp?.close();
        await server.stop();
    }
});

test('native editor lets wheel and touch gestures reach the drawer or its outer host when the entries list is not the scroller', async (t) => {
    const world = '原生滚动测试书';
    const seed = createDefaultSeed({ characters: [], selected_world_info: [],
        worldbooks: { [world]: makeBook(Array.from({ length: 32 }, (_, uid) => makeEntry(uid))) },
        extraPluginSettingsKey: { worldbook_entry_groups: { books: { [world]: {
            groups: [{ id: 'a', name: '滚动分组' }], assignments: Object.fromEntries(Array.from({ length: 32 }, (_, uid) => [uid, 'a'])),
        } } } },
    });
    const server = createMockStServer();
    const baseUrl = await server.start();
    let cdp;
    try {
        cdp = await launchEdgeCdp();
        for (const viewport of [VIEWPORTS.desktop, VIEWPORTS.mobile]) {
            for (const outer of [false, true]) for (const enabled of [true, false]) await t.test(`${viewport.name} outer=${outer} enabled=${enabled}`, async () => {
                const fixture = structuredClone(seed);
                fixture.extension_settings.worldbook_entry_groups.enableNativeGrouping = true;
                await resetAndBoot(cdp, baseUrl, { seed: fixture, viewport });
                await cdp.evalFn((book, outer) => {
                    const style = document.createElement('style');
                    style.textContent = '#fixture-world-scroll-host { position: fixed; inset: 12px; overflow-y: auto } #WorldInfo { position: fixed; inset: 12px; margin: 0; overflow-y: auto } #fixture-world-scroll-host > #WorldInfo { position: static; height: auto; max-height: none } #world_popup_entries_list { max-height: none; overflow-y: auto } .world_entry { min-height: 70px; flex-shrink: 0 }';
                    document.head.append(style);
                    if (outer) {
                        const host = document.createElement('div');
                        host.id = 'fixture-world-scroll-host';
                        const drawer = document.getElementById('WorldInfo');
                        drawer.before(host);
                        host.append(drawer);
                    }
                    document.getElementById('WorldInfo').style.display = 'block';
                    const select = document.getElementById('world_editor_select');
                    select.value = [...select.options].find((option) => option.textContent === book).value;
                    select.dispatchEvent(new Event('change', { bubbles: true }));
                }, world, outer);
                await waitForCondition(cdp, () => document.querySelectorAll('.world_entry').length === 32);
                await waitForCondition(cdp, () => document.querySelector('#weg-native-group-enabled[aria-checked="false"]'));
                if (enabled) {
                    await cdp.clickSelector('#weg-native-group-enabled');
                    await waitForCondition(cdp, () => document.querySelector('.weg-native-group-heading'));
                }
                else assert.equal(await cdp.evalFn(() => performance.getEntriesByType('resource').filter((entry) => entry.name.includes('/entry-groups/native-view.js')).length), 0);
                const point = await cdp.evalFn(() => {
                    const drawer = document.getElementById('WorldInfo');
                    const owner = document.getElementById('fixture-world-scroll-host') || drawer;
                    const list = document.getElementById('world_popup_entries_list');
                    owner.scrollTop += list.getBoundingClientRect().top - owner.getBoundingClientRect().top + 90;
                    const rect = owner.getBoundingClientRect();
                    const x = rect.left + rect.width / 2;
                    const y = rect.top + Math.min(280, rect.height / 2);
                    return { x, y, inside: list.contains(document.elementFromPoint(x, y)), top: owner.scrollTop,
                        drawerOverflow: drawer.scrollHeight - drawer.clientHeight,
                        drawerBehavior: getComputedStyle(drawer).overscrollBehaviorY,
                        localOverflow: list.scrollHeight - list.clientHeight, page: window.scrollY };
                });
                assert.equal(point.inside, true, JSON.stringify(point));
                assert.ok(point.localOverflow <= 1, 'the entries list must not scroll independently in this host layout');
                if (outer) assert.ok(point.drawerOverflow <= 1, 'the native drawer must delegate scrolling to its outer host');
                if (viewport.mobile) {
                    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: point.x, y: point.y }] });
                    for (let i = 1; i <= 8; i++) {
                        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x, y: point.y - i * 18 }] });
                    }
                    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
                } else {
                    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY: 220 });
                }
                const after = await cdp.evalFn(async () => {
                    await new Promise((done) => setTimeout(done, 250));
                    return { top: (document.getElementById('fixture-world-scroll-host') || document.getElementById('WorldInfo')).scrollTop, page: window.scrollY };
                });
                t.diagnostic(JSON.stringify({ viewport: viewport.name, outer, enabled, before: point, after }));
                assert.ok(after.top > point.top + 30, 'gestures over entries must scroll the native drawer');
                assert.equal(after.page, point.page);
            });
        }
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
            await cdp.evalFn(() => document.getElementById('world_popup_entries_list').replaceChildren());
            await waitForCondition(cdp, () => getComputedStyle(document.getElementById('world_popup_entries_list')).overscrollBehaviorY === 'auto');
            const outsideScroll = await cdp.evalFn(() => {
                const rect = document.getElementById('world_popup_entries_list').getBoundingClientRect();
                return { x: rect.left + rect.width / 2, y: rect.top + 25 };
            });
            await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...outsideScroll, deltaX: 0, deltaY: 180 });
            await waitForCondition(cdp, () => document.getElementById('WorldInfo').scrollTop > 0);
            await cdp.evalFn((top) => { document.getElementById('WorldInfo').scrollTop = top; }, before.shell);
            const hit = await cdp.clickSelector('#fixture-close-world-drawer', { scroll: false });
            assert.equal(hit.hit, true);
            assert.equal(await cdp.evalFn(() => document.getElementById('WorldInfo').dataset.fixtureClosed), '1');
            const lateNavigation = await cdp.evalFn(async () => {
                const { scrollNativeWorldEntry } = await import('/scripts/extensions/third-party/worldbook-organizer/src/content-scroll.js');
                const { onDisable } = await import('/scripts/extensions/third-party/worldbook-organizer/index.js');
                const list = document.getElementById('world_popup_entries_list');
                const row = document.createElement('div');
                row.style.height = '500px';
                list.append(row);
                const late = new Promise((done) => setTimeout(() => { scrollNativeWorldEntry(row); done(); }, 0));
                onDisable();
                await late;
                return document.querySelectorAll('.wbo-native-scroll-boundary, .wbo-native-contained-scroll').length;
            });
            assert.equal(lateNavigation, 0, 'pending navigation cannot remount content observers after the extension is disabled');
        }
        assert.deepEqual(cdp.getErrors().runtimeErrors, []);
    } finally {
        await cdp?.close();
        await server.stop();
    }
});
