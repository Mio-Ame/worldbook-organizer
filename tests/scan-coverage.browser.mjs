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

test('scan compares full text in three columns, confirms deletion, and links to unbound characters', async () => {
    const bound = '已绑定测试书';
    const candidate = '同名候选角色';
    const embedded = '仅有内嵌书';
    const card = (avatar, name, book = '') => ({ avatar, name, data: { extensions: { world: book } } });
    const entries = (content) => Array.from({ length: 14 }, (_, uid) => makeEntry(uid, { comment: `测试条目 ${uid}`, content }));
    const seed = createDefaultSeed({
        characters: [
            card('candidate.png', candidate, bound),
            card('shared.png', '共用角色', bound),
            card('unbound.png', '未绑测试角色'),
            { avatar: 'pending.png', name: '待扫描角色', shallow: true },
            {
                avatar: 'embedded.png', name: '内嵌测试角色',
                data: { character_book: { name: embedded, entries: [{ id: 0, comment: '示例', content: `${'文'.repeat(1600)}甲🙂` }] } },
            },
        ],
        worldbooks: {
            [bound]: makeBook(entries(`${'文'.repeat(1700)}🙂`)),
            [candidate]: makeBook(entries('测试')),
            [embedded]: makeBook([makeEntry(0, { comment: '示例', content: `${'文'.repeat(1600)}乙` })]),
        },
        selected_world_info: [],
        pluginSettings: { autoScanNewCharacters: false, cachedCharBindings: {} },
    });
    const server = createMockStServer();
    const baseUrl = await server.start();
    let cdp;
    try {
        cdp = await launchEdgeCdp();
        await resetAndBoot(cdp, baseUrl, { seed, viewport: VIEWPORTS.mobile });
        await openManager(cdp);
        await cdp.clickSelector('#wbo-mgr-scan-btn');
        const panes = await cdp.evalFn(() => [...document.querySelectorAll('[data-cov-tab]')].map((button) => button.getAttribute('data-cov-tab')));
        assert.equal(panes.indexOf('unbound'), panes.indexOf('shared') + 1);
        await cdp.clickSelector('[data-cov-tab="shared"]');
        assert.equal(await cdp.evalFn(() => document.querySelector('[data-cov-pane="shared"] p')?.textContent), '多张角色卡共用了同一本世界书。');
        await cdp.clickSelector('[data-cov-tab="same_name"]');
        const layout = await cdp.evalFn(() => {
            const rows = [...document.querySelectorAll('.wbo-cov-match-card')];
            return {
                note: document.querySelector('.wbo-cov-same-name-alert').textContent,
                rows: rows.map((row) => {
                    const box = (selector) => row.querySelector(selector).getBoundingClientRect();
                    return [box('.wbo-cov-subject').top, box('.wbo-cov-targets').top, box('[data-cov-assign-char]').left];
                }),
            };
        });
        assert.match(layout.note, /目前暂未自动归入「角色世界书」/);
        assert.equal(layout.rows.length, 2);
        assert.ok(layout.rows.every(([roleTop, bookTop, actionLeft]) => roleTop === bookTop && actionLeft === layout.rows[0][2]));
        await cdp.clickSelector('[data-cov-same-compare]');
        await waitForCondition(cdp, () => !!document.querySelector('.wbo-diff-table'));
        const diff = await cdp.evalFn(() => {
            const t = document.querySelector('.wbo-diff-table');
            return {
                columns: [...t.querySelectorAll('thead th')].map((cell) => cell.textContent),
                rowCount: t.querySelectorAll('tbody tr').length,
                row: [...t.querySelector('tbody tr').children].map((cell) => cell.textContent),
            };
        });
        assert.deepEqual(diff.columns, ['条目名', '角色卡绑定的世界书', '同名的世界书']);
        assert.equal(diff.rowCount, 14);
        assert.deepEqual(diff.row, ['测试条目 0', '1701 字', '2 字']);
        await cdp.clickSelector('[data-cov-emb-diff]');
        await waitForCondition(cdp, () => !!document.querySelector('.wbo-cov-match-card:has([data-cov-emb-diff]) .wbo-diff-table'));
        assert.equal(await cdp.evalFn(() => document.querySelector('.wbo-cov-match-card:has([data-cov-emb-diff]) .wbo-diff-table tbody td').textContent), '1602 字');

        const remove = '[data-cov-delete-book="同名候选角色"]';
        await cdp.clickSelector(remove);
        await cdp.clickSelector('#wbo-cancel-btn');
        assert.deepEqual((await getServerState(baseUrl)).metrics.worldDeleteCalls, []);
        await cdp.clickSelector(remove);
        await cdp.clickSelector('#wbo-confirm-del-btn');
        await waitForCondition(cdp, () => !document.querySelector('[data-cov-delete-book="同名候选角色"]'));
        const afterDelete = await getServerState(baseUrl);
        assert.deepEqual(afterDelete.metrics.worldDeleteCalls, [candidate]);
        assert.ok(afterDelete.worldbooks[bound]);

        await cdp.clickSelector('[data-cov-open-unbound]');
        const listed = await cdp.evalFn(() => [...document.querySelectorAll('.wbo-cov-unbound-table [data-jump-char]')].map((button) => button.textContent));
        assert.deepEqual([...listed].sort(), ['内嵌测试角色', '未绑测试角色'].sort());
        await cdp.clickSelector('.wbo-cov-unbound-table [data-jump-char="unbound.png"]');
        await waitForCondition(cdp, () => window.SillyTavern.getContext().characterId === 2);
        assert.deepEqual(cdp.getErrors().runtimeErrors, []);
    } finally {
        await cdp?.close();
        await server.stop();
    }
});
