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
const { getServerState, openManager, resetAndBoot, waitForCondition } = await load('assert-helpers.mjs');

test('scan review, primary replacement and auxiliary bindings use the intended character', async () => {
    const avatarA = 'fixture-a.png';
    const avatarB = 'fixture-b.png';
    const characters = [
        { avatar: avatarA, name: '候选角色甲', data: { extensions: {} } },
        { avatar: avatarB, name: '核对角色乙', data: { extensions: { world: '原主书', keep: true } } },
    ];
    const seed = createDefaultSeed({
        characters,
        worldbooks: Object.fromEntries(['候选角色甲', '原主书', '新主书', '新附加书', '旧附加书'].map((name) => [name, { entries: {} }])),
        selected_world_info: [],
        pluginSettings: { autoScanNewCharacters: false, cachedCharBindings: {}, showCharBooks: true },
    });
    seed.world_info.charLore.push({ name: 'fixture-b', extraBooks: ['旧附加书'] });
    const server = createMockStServer();
    const baseUrl = await server.start();
    let cdp;
    try {
        cdp = await launchEdgeCdp();
        await resetAndBoot(cdp, baseUrl, { seed, viewport: VIEWPORTS.desktopWide });
        await openManager(cdp);
        await cdp.clickSelector('#wbo-mgr-scan-btn');
        await cdp.clickSelector('[data-cov-bind-book="候选角色甲"]');
        await waitForCondition(cdp, () => document.querySelector('[data-bind-current]')?.textContent.includes('无'));
        const review = await cdp.evalFn(() => ({
            avatar: document.querySelector('[data-bind-avatar]').getAttribute('src'),
            reminder: document.querySelector('.wbo-bind-content').textContent.includes('年龄线'),
            disabled: document.querySelector('[data-bind-confirm]').disabled,
        }));
        assert.match(review.avatar, /fixture-a\.png/);
        assert.equal(review.reminder, false);
        assert.equal(review.disabled, true);
        assert.deepEqual((await getServerState(baseUrl)).metrics.charMergeCalls, []);
        await cdp.clickSelector('[data-bind-cancel]');
        await cdp.clickSelector('#wbo-submodal-overlay .wbo-modal-close');

        const wideActions = await cdp.evalFn(() => {
            const row = document.querySelector('.wbo-book-row[data-book="新主书"]');
            return [...row.querySelectorAll('.wbo-book-actions > button')]
                .filter((button) => button.offsetWidth > 0)
                .map((button) => button.dataset.action);
        });
        assert.deepEqual(wideActions, ['toggle-global', 'delete-single-book', 'book-more-menu', 'toggle-pin-book']);

        async function chooseBook(book) {
            await cdp.clickSelector(`.wbo-book-item[data-book="${book}"] [data-action="book-more-menu"]`);
            const actions = await cdp.evalFn(() => [...document.querySelectorAll('.wbo-book-more-popover [data-more-act]')].map((button) => button.dataset.moreAct));
            assert.deepEqual(actions, ['bind-book-to-character', 'edit-book', 'rename-alias', 'move-group']);
            const bind = '[data-more-act="bind-book-to-character"]';
            assert.equal(await cdp.evalFn((selector) => document.activeElement.matches(selector), bind), true);
            await cdp.clickSelector(bind);
            await cdp.typeInto('[data-bind-character-search]', '核对');
            assert.equal(await cdp.evalFn(() => [...document.querySelectorAll('[data-bind-avatar-choice]')].every((node) => node.tabIndex === -1)), true);
            await cdp.pressKey('ArrowDown', 'ArrowDown', 40);
            await cdp.pressKey('Enter', 'Enter', 13);
            await waitForCondition(cdp, () => !document.querySelector('[data-bind-options]')?.disabled);
            assert.equal(await cdp.evalFn(() => document.querySelector('[data-bind-character]').value), avatarB);
            await cdp.clickSelector('[data-bind-picker-toggle]');
            await cdp.pressKey('Escape', 'Escape', 27);
            assert.equal(await cdp.evalFn(() => document.querySelector('[data-bind-choices]').hidden), true);
            await cdp.clickSelector('[data-bind-character-search]');
            await cdp.pressKey('Tab', 'Tab', 9);
            await cdp.pressKey('Tab', 'Tab', 9);
            assert.equal(await cdp.evalFn(() => document.activeElement.matches('[name="wbo-bind-kind"]') && document.querySelector('[data-bind-choices]').hidden), true);
        }
        await chooseBook('新主书');
        await cdp.clickSelector('[name="wbo-bind-kind"][value="primary"]');
        assert.match(await cdp.evalFn(() => document.querySelector('[data-bind-warning]').textContent), /原主书.*新主书/);
        assert.deepEqual(await cdp.evalFn(() => {
            const confirm = document.querySelector('[data-bind-confirm]');
            const cancel = document.querySelector('[data-bind-cancel]');
            return { label: confirm.textContent.trim(), left: confirm.getBoundingClientRect().right <= cancel.getBoundingClientRect().left,
                sameRow: confirm.getBoundingClientRect().top === cancel.getBoundingClientRect().top };
        }), { label: '替换主世界书', left: true, sameRow: true });
        if (process.env.WBO_CAPTURE_UI) await cdp.screenshot('v2358-binding-desktop');
        await cdp.clickSelector('[data-bind-confirm]');
        await waitForCondition(cdp, () => !document.querySelector('[data-bind-confirm]'));
        const saved = await getServerState(baseUrl);
        assert.deepEqual(saved.metrics.charMergeCalls, [{ avatar: avatarB, data: { extensions: { world: '新主书' } } }]);
        assert.deepEqual(saved.characters[1].data.extensions, { world: '新主书', keep: true });

        await chooseBook('新附加书');
        await cdp.clickSelector('[name="wbo-bind-kind"][value="extra"]');
        await cdp.clickSelector('[data-bind-confirm]');
        await waitForCondition(cdp, () => !document.querySelector('[data-bind-confirm]'));
        await waitForCondition(cdp, async () => {
            const state = await fetch('/__test/state').then((res) => res.json());
            return state.world_info.charLore[0].extraBooks.includes('新附加书');
        });
        const final = await getServerState(baseUrl);
        assert.deepEqual(final.world_info.charLore, [{ name: 'fixture-b', extraBooks: ['旧附加书', '新附加书'] }]);
        assert.equal(final.characters[1].data.extensions.world, '新主书');
        assert.equal(final.metrics.charMergeCalls.length, 1);
        assert.deepEqual(cdp.getErrors().runtimeErrors, []);
    } finally {
        await cdp?.close();
        await server.stop();
    }
});

test('mobile keeps binding in the book menu and sizes the expanded sort picker to its label', async () => {
    const avatar = 'fixture-mobile.png';
    const book = '待绑定测试书';
    const seed = createDefaultSeed({
        characters: [
            { avatar, name: '手机测试角色', data: { extensions: { world: '已有主书' } } },
            { avatar: 'fixture-duplicate.png', name: '手机测试角色', data: { extensions: {} } },
            { avatar: 'fixture-other.png', name: '另一个角色', data: { extensions: {} } },
        ],
        worldbooks: { [book]: { entries: {} }, 已有主书: { entries: {} } },
        selected_world_info: [],
        pluginSettings: { autoScanNewCharacters: false },
    });
    const server = createMockStServer();
    const baseUrl = await server.start();
    let cdp;
    try {
        cdp = await launchEdgeCdp();
        await resetAndBoot(cdp, baseUrl, { seed, viewport: VIEWPORTS.mobile });
        await openManager(cdp);
        const row = `.wbo-book-item[data-book="${book}"]`;
        assert.equal(await cdp.evalFn((selector) => document.querySelector(`${selector} [data-action="delete-single-book"]`).offsetWidth, row), 0);
        await cdp.clickSelector(`${row} [data-action="book-more-menu"]`);
        assert.equal(await cdp.evalFn(() => Boolean(document.querySelector('.wbo-book-more-popover [data-more-act="delete-single-book"]'))), true);
        const firstAction = '.wbo-book-more-popover [data-more-act]:first-child';
        assert.equal(await cdp.evalFn((selector) => document.querySelector(selector).textContent.trim(), firstAction), '绑定到角色');
        await cdp.clickSelector(firstAction);
        assert.equal(await cdp.evalFn(() => document.querySelector('[data-bind-confirm]').disabled), true);
        await cdp.clickSelector('[data-bind-cancel]');
        assert.deepEqual((await getServerState(baseUrl)).metrics.charMergeCalls, []);

        await cdp.clickSelector(`${row} .wbo-book-main`);
        const sortWidths = await cdp.evalFn((selector) => {
            const preview = document.querySelector(`${selector} .wbo-book-preview`);
            const sort = preview.querySelector('[data-acc-sort]');
            const sizes = {};
            for (const value of ['custom', 'order', 'title', 'custom']) {
                sort.value = value;
                sort.dispatchEvent(new Event('change', { bubbles: true }));
                const label = preview.querySelector('.wbo-acc-sort-size');
                const range = document.createRange();
                range.selectNodeContents(label);
                sizes[value] = { width: sort.offsetWidth, textWidth: range.getBoundingClientRect().width };
            }
            return { sizes, duplicateBinding: Boolean(preview.querySelector('[data-acc-extra="bind-book-to-character"]')) };
        }, row);
        assert.equal(sortWidths.duplicateBinding, false);
        assert.ok(sortWidths.sizes.custom.width - sortWidths.sizes.title.width > 10);
        for (const { width, textWidth } of Object.values(sortWidths.sizes)) {
            assert.ok(width - textWidth >= 29 && width - textWidth <= 35, `${width} / ${textWidth}`);
        }
        await cdp.clickSelector(`${row} [data-action="book-more-menu"]`);
        await cdp.clickSelector(firstAction);
        const search = '[data-bind-character-search]';
        assert.deepEqual(await cdp.evalFn(() => ({
            selectHidden: getComputedStyle(document.querySelector('[data-bind-character]')).display === 'none',
            role: document.querySelector('[data-bind-character-search]').getAttribute('role'),
            confirmOnLeft: document.querySelector('[data-bind-confirm]').getBoundingClientRect().right <= document.querySelector('[data-bind-cancel]').getBoundingClientRect().left,
            actions: [...document.querySelectorAll('.wbo-bind-content + .wbo-modal-footer button')].map((node) => node.textContent.trim()),
        })), { selectHidden: true, role: 'combobox', confirmOnLeft: true, actions: ['确认绑定', '取消'] });
        await cdp.clickSelector('[data-bind-picker-toggle]');
        if (process.env.WBO_CAPTURE_UI) await cdp.screenshot('v2358-binding-mobile-list');
        assert.equal(await cdp.evalFn(() => document.querySelector('[data-bind-character-search]').getAttribute('aria-expanded')), 'true');
        await cdp.clickSelector('[data-bind-avatar-choice="fixture-other.png"]');
        await waitForCondition(cdp, () => !document.querySelector('[data-bind-options]')?.disabled);
        assert.equal(await cdp.evalFn(() => document.querySelector('[data-bind-character-search]').value), '另一个角色');
        if (process.env.WBO_CAPTURE_UI) await cdp.screenshot('v2358-binding-mobile-selected');
        assert.equal(await cdp.evalFn((selector) => document.querySelector(selector).getAttribute('spellcheck'), search), 'false');
        assert.equal(await cdp.evalFn((selector) => document.activeElement.matches(selector), search), false);
        await cdp.typeInto(search, '手机测试');
        const matched = await cdp.evalFn(() => [...document.querySelectorAll('[data-bind-character] option')].filter((item) => item.value).map((item) => item.value));
        assert.deepEqual(matched, ['fixture-duplicate.png', avatar]);
        const choose = (value) => cdp.evalFn((next) => {
            const select = document.querySelector('[data-bind-character]');
            select.value = next;
            select.dispatchEvent(new Event('change', { bubbles: true }));
        }, value);
        await choose(avatar);
        await waitForCondition(cdp, () => !document.querySelector('[data-bind-options]')?.disabled);
        await cdp.typeInto(search, '没有匹配的名字');
        assert.equal(await cdp.evalFn(() => document.querySelector('[data-bind-character] option').textContent), '没有匹配的角色卡');
        assert.equal(await cdp.evalFn(() => document.querySelector('[data-bind-card]').hidden), true);
        assert.equal(await cdp.evalFn(() => document.querySelector('[data-bind-confirm]').disabled), true);
        await cdp.typeInto(search, '手机测试');
        await choose(avatar);
        await waitForCondition(cdp, () => !document.querySelector('[data-bind-options]')?.disabled);
        assert.match(await cdp.evalFn(() => document.querySelector('[data-bind-avatar]').src), /fixture-mobile\.png/);
        assert.equal(await cdp.evalFn(() => document.querySelector('[data-bind-confirm]').disabled), true);
        await cdp.clickSelector('[name="wbo-bind-kind"][value="extra"]');
        await cdp.clickSelector('[data-bind-confirm]');
        await waitForCondition(cdp, async () => {
            const state = await fetch('/__test/state').then((res) => res.json());
            return state.world_info.charLore.some((item) => item.name === 'fixture-mobile' && item.extraBooks.includes('待绑定测试书'));
        });
        const final = await getServerState(baseUrl);
        assert.equal(final.characters[0].data.extensions.world, '已有主书');
        assert.deepEqual(final.metrics.charMergeCalls, []);
        assert.deepEqual(cdp.getErrors().runtimeErrors, []);
    } finally {
        await cdp?.close();
        await server.stop();
    }
});
