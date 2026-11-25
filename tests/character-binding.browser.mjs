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
        await resetAndBoot(cdp, baseUrl, { seed, viewport: VIEWPORTS.desktop });
        await openManager(cdp);
        await cdp.clickSelector('#wbo-mgr-scan-btn');
        await cdp.clickSelector('[data-cov-bind-book="候选角色甲"]');
        await waitForCondition(cdp, () => document.querySelector('[data-bind-current]')?.textContent.includes('无'));
        const review = await cdp.evalFn(() => ({
            avatar: document.querySelector('[data-bind-avatar]').getAttribute('src'),
            warning: document.querySelector('.wbo-bind-reminder').textContent,
            disabled: document.querySelector('[data-bind-confirm]').disabled,
        }));
        assert.match(review.avatar, /fixture-a\.png/);
        assert.match(review.warning, /IF 线.*年龄线/);
        assert.equal(review.disabled, true);
        assert.deepEqual((await getServerState(baseUrl)).metrics.charMergeCalls, []);
        await cdp.clickSelector('[data-bind-cancel]');
        await cdp.clickSelector('#wbo-submodal-overlay .wbo-modal-close');

        async function chooseBook(book) {
            await cdp.clickSelector(`.wbo-book-item[data-book="${book}"] [data-action="bind-book-to-character"]`);
            await cdp.evalFn((avatar) => {
                const select = document.querySelector('[data-bind-character]');
                select.value = avatar;
                select.dispatchEvent(new Event('change', { bubbles: true }));
            }, avatarB);
            await waitForCondition(cdp, () => !document.querySelector('[data-bind-options]')?.disabled);
        }
        assert.equal(await cdp.evalFn(() => document.querySelector('[data-action="bind-book-to-character"]').textContent.trim()), '绑定');
        await chooseBook('新主书');
        await cdp.clickSelector('[name="wbo-bind-kind"][value="primary"]');
        assert.match(await cdp.evalFn(() => document.querySelector('[data-bind-warning]').textContent), /原主书.*新主书/);
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

test('mobile exposes a labeled binding action inside the expanded worldbook and first in its menu', async () => {
    const avatar = 'fixture-mobile.png';
    const book = '待绑定测试书';
    const seed = createDefaultSeed({
        characters: [{ avatar, name: '手机测试角色', data: { extensions: { world: '已有主书' } } }],
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
        await cdp.clickSelector(`${row} [data-action="book-more-menu"]`);
        const firstAction = '.wbo-book-more-popover [data-more-act]:first-child';
        assert.equal(await cdp.evalFn((selector) => document.querySelector(selector).textContent.trim(), firstAction), '绑定到角色');
        await cdp.clickSelector(firstAction);
        assert.equal(await cdp.evalFn(() => document.querySelector('[data-bind-confirm]').disabled), true);
        await cdp.clickSelector('[data-bind-cancel]');
        assert.deepEqual((await getServerState(baseUrl)).metrics.charMergeCalls, []);

        await cdp.clickSelector(`${row} .wbo-book-main`);
        const bind = `${row} .wbo-book-preview [data-acc-extra="bind-book-to-character"]`;
        assert.ok(await cdp.evalFn((selector) => document.querySelector(selector)?.getBoundingClientRect().height, bind));
        assert.equal(await cdp.evalFn((selector) => document.querySelector(selector).textContent.trim(), bind), '绑定世界书到角色');
        await cdp.clickSelector(bind);
        await cdp.evalFn((value) => {
            const select = document.querySelector('[data-bind-character]');
            select.value = value;
            select.dispatchEvent(new Event('change', { bubbles: true }));
        }, avatar);
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
