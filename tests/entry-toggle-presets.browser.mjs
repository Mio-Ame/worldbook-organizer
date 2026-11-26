import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const suite = process.env.WBO_E2E_SUITE;
if (!suite) throw new Error('Set WBO_E2E_SUITE');
const load = (name) => import(pathToFileURL(resolve(suite, 'lib', name)).href);
const { createMockStServer } = await load('mock-server.mjs');
const { VIEWPORTS, launchEdgeCdp } = await load('cdp.mjs');
const { createDefaultSeed, makeBook, makeEntry } = await import('./entry-groups-fixtures.mjs');
const { getServerState, resetAndBoot, waitForCondition } = await load('assert-helpers.mjs');
const world = '方案测试书';

for (const device of ['desktop', 'mobile']) {
    test(`${device}: named switch presets have a separate page, compact diff and nearby undo`, async () => {
        const server = createMockStServer();
        const baseUrl = await server.start();
        let cdp;
        try {
            cdp = await launchEdgeCdp();
            await resetAndBoot(cdp, baseUrl, { viewport: device === 'mobile' ? { ...VIEWPORTS.mobile, width: 320, height: 640 } : VIEWPORTS.desktop,
                seed: createDefaultSeed({ characters: [], selected_world_info: [],
                    worldbooks: { [world]: makeBook([makeEntry(0, { comment: '基础资料', content: '正文保留' }),
                        makeEntry(1, { comment: '支线资料', disable: true }), makeEntry(2, { comment: '新资料' })]) },
                    pluginSettings: { autoScanNewCharacters: false },
                    extraPluginSettingsKey: { worldbook_entry_groups: { books: { [world]: {
                        togglePresets: [{ id: 'p1', name: '支线方案', states: { 0: true, 1: false, 99: false } }],
                    } } } },
                }) });
            await cdp.evalFn((worldName) => window.dispatchEvent(new CustomEvent('weg:open-panel', { detail: { worldName } })), world);
            await waitForCondition(cdp, () => document.querySelector('#weg-body .weg-entry-row'));
            const frame = () => cdp.evalFn(() => { const r = document.querySelector('.weg-modal').getBoundingClientRect(); return [r.x, r.y, r.width, r.height, scrollY]; });
            const initial = await frame();
            assert.equal(await cdp.evalFn(() => Boolean(document.querySelector('[data-weg-page="presets"]'))), true, 'switch plans need their own page');
            assert.equal(await cdp.evalFn(() => getComputedStyle(document.getElementById('weg-save-bar')).display), 'none');
            const before = await getServerState(baseUrl);
            await cdp.clickSelector('[data-weg-page="presets"]');
            assert.deepEqual(await frame(), initial);
            assert.equal(await cdp.evalFn(() => document.getElementById('weg-body').hidden), true);
            assert.match(await cdp.evalFn(() => document.getElementById('weg-save-bar').textContent), /我的方案/);
            await cdp.clickSelector('[data-weg-preset-action="apply"][data-preset-id="p1"]');
            await waitForCondition(cdp, () => document.querySelector('#weg-preset-result [data-weg-preset-action="undo"]:not(:disabled)'));
            const result = await cdp.evalFn(() => ({ text: document.getElementById('weg-preset-result').textContent,
                expanded: document.querySelector('#weg-preset-result details').open,
                undo: document.querySelector('#weg-preset-result [data-weg-preset-action="undo"]').textContent.trim() }));
            assert.match(result.text, /开启 1 条.*关闭 1 条/s);
            assert.equal(result.expanded, false, 'do not dump a long list by default');
            assert.equal(result.undo, '撤回切换');
            writeFileSync(resolve(tmpdir(), `wbo-toggle-presets-${device}.png`), Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
            await cdp.clickSelector('#weg-preset-result details summary');
            assert.match(await cdp.evalFn(() => document.querySelector('#weg-preset-result [data-weg-change-list]').textContent), /支线资料/);
            await cdp.clickSelector('[data-weg-change-filter="disabled"]');
            assert.match(await cdp.evalFn(() => document.querySelector('#weg-preset-result [data-weg-change-list]').textContent), /基础资料/);
            const applied = await getServerState(baseUrl);
            assert.equal(applied.worldbooks[world].entries[0].disable, true);
            assert.equal(applied.worldbooks[world].entries[1].disable, false);
            assert.deepEqual(applied.worldbooks[world].entries[2], before.worldbooks[world].entries[2], 'new entries not in snapshot stay untouched');
            assert.equal(applied.worldbooks[world].entries[0].content, '正文保留');
            await cdp.clickSelector('#weg-preset-result [data-weg-preset-action="undo"]');
            await waitForCondition(cdp, () => document.getElementById('weg-preset-result').textContent.includes('已撤回'));
            assert.deepEqual((await getServerState(baseUrl)).worldbooks, before.worldbooks);
            assert.deepEqual(await frame(), initial);
            const overflow = await cdp.evalFn(() => [...document.querySelectorAll('.weg-preset-card, .weg-preset-actions, .weg-page-tabs')]
                .filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.className));
            assert.deepEqual(overflow, []);
            await cdp.evalFn(() => {
                const input = document.getElementById('weg-preset-name'); input.value = '我的日常'; input.dispatchEvent(new Event('input', { bubbles: true }));
            });
            const edits = (await getServerState(baseUrl)).metrics.worldEditCalls.length;
            await cdp.clickSelector('[data-weg-preset-action="save-new"]');
            await waitForCondition(cdp, () => document.querySelectorAll('[data-weg-preset-action="apply"]').length === 2);
            const saved = await cdp.evalFn((name) => SillyTavern.getContext().extensionSettings.worldbook_entry_groups.books[name].togglePresets, world);
            assert.equal(saved[1].name, '我的日常');
            assert.deepEqual(saved[1].states, { 0: false, 1: true, 2: false });
            assert.equal(JSON.stringify(saved).includes('正文保留'), false);
            assert.equal((await getServerState(baseUrl)).metrics.worldEditCalls.length, edits, 'saving a preset never rewrites the book');
            await cdp.clickSelector('[data-weg-page="entries"]');
            assert.equal(await cdp.evalFn(() => document.getElementById('weg-body').hidden), false);
            assert.deepEqual(await frame(), initial);
            assert.deepEqual(cdp.getErrors().runtimeErrors, []);
        } finally { await cdp?.close(); await server.stop(); }
    });
}

test('switch backup survives repeated actions and reload; restoring it can itself be undone', async () => {
    const server = createMockStServer();
    const baseUrl = await server.start();
    let cdp;
    try {
        cdp = await launchEdgeCdp();
        const seed = createDefaultSeed({ characters: [], selected_world_info: [],
            worldbooks: { [world]: makeBook([makeEntry(0), makeEntry(1, { disable: true })]) },
            pluginSettings: { autoScanNewCharacters: false },
            extraPluginSettingsKey: { worldbook_entry_groups: { books: { [world]: { togglePresets: [
                { id: 'off', name: '全部关闭', states: { 0: true, 1: true } },
                { id: 'on', name: '全部开启', states: { 0: false, 1: false } },
            ] } } } },
        });
        await resetAndBoot(cdp, baseUrl, { viewport: VIEWPORTS.desktop, seed });
        const open = async () => {
            await cdp.evalFn(name => window.dispatchEvent(new CustomEvent('weg:open-panel', { detail: { worldName: name } })), world);
            await waitForCondition(cdp, () => document.querySelector('#weg-body .weg-entry-row'));
            await cdp.clickSelector('[data-weg-page="presets"]');
        };
        await open();
        const states = async () => Object.values((await getServerState(baseUrl)).worldbooks[world].entries).map(entry => entry.disable);
        const backup = () => cdp.evalFn(name => structuredClone(SillyTavern.getContext().extensionSettings.worldbook_entry_groups.books[name].toggleBackup), world);
        const apply = async id => {
            await cdp.clickSelector(`[data-weg-preset-action="apply"][data-preset-id="${id}"]`);
            await waitForCondition(cdp, () => !!document.querySelector('#weg-preset-result') && !document.querySelector('[data-weg-preset-action="apply"]').disabled);
        };
        await apply('off');
        const original = await backup();
        assert.deepEqual(original.states, { 0: false, 1: true });
        await apply('on');
        assert.deepEqual(await backup(), original, 'later actions cannot overwrite the original backup');
        const undoCount = await cdp.evalFn(() => document.querySelector('[data-undo-count]').dataset.undoCount);
        await apply('on');
        assert.equal(await cdp.evalFn(() => document.querySelector('[data-undo-count]').dataset.undoCount), undoCount, 'a no-op is not another undo step');
        await cdp.clickSelector('[data-weg-preset-action="restore-backup"]');
        await waitForCondition(cdp, () => !document.querySelector('[data-weg-preset-action="restore-backup"]').disabled);
        assert.deepEqual(await states(), [false, true]);
        await cdp.clickSelector('#weg-preset-result [data-weg-preset-action="undo"]');
        await waitForCondition(cdp, () => document.getElementById('weg-preset-result').textContent.includes('已撤回'));
        assert.deepEqual(await states(), [false, false]);
        assert.deepEqual(await backup(), original);
        const restored = { ...seed, extension_settings: await cdp.evalFn(() => structuredClone(SillyTavern.getContext().extensionSettings)),
            worldbooks: (await getServerState(baseUrl)).worldbooks };
        await resetAndBoot(cdp, baseUrl, { viewport: VIEWPORTS.desktop, seed: restored });
        await open();
        assert.deepEqual(await backup(), original, 'restarting does not lose the backup');
        await cdp.clickSelector('[data-weg-preset-action="restore-backup"]');
        await waitForCondition(cdp, () => !document.querySelector('[data-weg-preset-action="restore-backup"]').disabled);
        assert.deepEqual(await states(), [false, true]);
        assert.deepEqual(cdp.getErrors().runtimeErrors, []);
    } finally { await cdp?.close(); await server.stop(); }
});
