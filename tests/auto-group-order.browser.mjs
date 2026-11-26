import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { isBookConfigEmpty } from '../src/entry-groups/core.js';

const suite = process.env.WBO_E2E_SUITE;
if (!suite) throw new Error('Set WBO_E2E_SUITE to the retained browser regression suite');
const load = (name) => import(pathToFileURL(resolve(suite, 'lib', name)).href);
const { createMockStServer } = await load('mock-server.mjs');
const { VIEWPORTS, launchEdgeCdp } = await load('cdp.mjs');
const { createDefaultSeed, makeBook, makeEntry } = await import('./entry-groups-fixtures.mjs');
const { getServerState, openManager, resetAndBoot, waitForCondition } = await load('assert-helpers.mjs');

const world = '自动顺序测试书';
const expected = [
    { name: 'IF·甲', mode: 'if_line' },
    { name: 'IF·乙', mode: 'if_line' },
    { name: 'NSFW', mode: 'scene' },
    { name: '背景', mode: 'normal' },
    { name: '小手机', mode: 'normal' },
];

function makeSeed() {
    const titles = ['=== 小手机 ===', '消息界面', '=== IF·甲 ===', '甲路线资料',
        '=== 背景 ===', '环境资料', '=== IF·乙 ===', '乙路线资料', '=== NSFW ===', '中性测试选项'];
    return createDefaultSeed({
        characters: [], selected_world_info: [],
        worldbooks: { [world]: makeBook(titles.map((comment, uid) => makeEntry(uid, {
            comment, displayIndex: uid, key: uid % 2 ? [`关键词${uid}`] : [],
            content: uid % 2 ? `中性测试正文 ${uid}` : '', disable: uid === 3,
        }))) },
        pluginSettings: { autoScanNewCharacters: false },
        extraPluginSettingsKey: { worldbook_entry_groups: { books: {} } },
    });
}

async function click(cdp, selector) {
    const result = await cdp.clickSelector(selector);
    assert.equal(result.hit, true, `control is reachable: ${selector}`);
}

async function readConfig(cdp) {
    return cdp.evalFn((name) => structuredClone(
        SillyTavern.getContext().extensionSettings.worldbook_entry_groups.books[name] ?? null,
    ), world);
}

function assertConfigUnchanged(actual, expected, message) {
    // normalizeSettings removes an empty temporary shell; nonempty records remain strict.
    const canonical = (config) => config == null || isBookConfigEmpty(config) ? null : config;
    assert.deepEqual(canonical(actual), canonical(expected), message);
}

async function openPreview(cdp) {
    await click(cdp, '#weg-btn-auto-detect');
    await waitForCondition(cdp, () => document.querySelectorAll('#weg-submodal-host .weg-detect-row').length === 5);
    const rows = await cdp.evalFn(() => [...document.querySelectorAll('#weg-submodal-host .weg-detect-row')].map((row) => ({
        name: row.querySelector('.weg-detect-name').textContent.trim(),
        mode: row.querySelector('[data-weg-detect-mode]').value,
        checked: row.querySelector('[data-weg-detect-idx]').checked,
    })));
    assert.deepEqual(rows, expected.map((group) => ({ ...group, checked: true })),
        'preview already places IF routes first, NSFW next, ordinary groups next, helpers last');
}

function assertOriginalBook(state, original) {
    assert.deepEqual(state.worldbooks, original, 'grouping never changes any field of the original book payload');
    assert.deepEqual(state.metrics.worldEditCalls, [], 'no worldbook write is sent');
}

for (const device of ['desktop', 'mobile']) {
    test(`${device}: automatic preview and applied groups share default order without editing the book`, { timeout: 45000 }, async () => {
        const seed = makeSeed();
        const original = structuredClone(seed.worldbooks);
        const server = createMockStServer();
        const baseUrl = await server.start();
        let cdp;
        try {
            cdp = await launchEdgeCdp();
            await resetAndBoot(cdp, baseUrl, { viewport: VIEWPORTS[device], seed });
            await openManager(cdp);
            await click(cdp, '.wbo-book-item .wbo-book-main');
            await click(cdp, '[data-acc-extra="open-entry-groups"]');
            await waitForCondition(cdp, () => document.querySelector('#weg-body .weg-entry-row'));

            const beforeCancel = await readConfig(cdp);
            await openPreview(cdp);
            assertConfigUnchanged(await readConfig(cdp), beforeCancel, 'preview is read-only');
            await click(cdp, '#weg-submodal-host .weg-submodal-footer [data-weg-sub-close="1"]');
            await waitForCondition(cdp, () => document.querySelector('#weg-submodal-host').hidden);
            assertConfigUnchanged(await readConfig(cdp), beforeCancel, 'cancel leaves the grouping config unchanged');
            assertOriginalBook(await getServerState(baseUrl), original);

            await openPreview(cdp);
            await click(cdp, '#weg-detect-apply-btn');
            await waitForCondition(cdp, () => document.querySelector('#weg-submodal-host').hidden);
            const applied = await readConfig(cdp);
            assert.deepEqual(applied.groups.map(({ name, mode }) => ({ name, mode })), expected);
            const ids = applied.groups.map(({ id }) => id);
            const rendered = await cdp.evalFn((ids) => [...document.querySelectorAll('#weg-body [data-weg-group-card]')]
                .filter((card) => ids.includes(card.dataset.wegGroupCard))
                .map((card) => card.querySelector('.weg-group-name').textContent.trim()), ids);
            assert.deepEqual(rendered, expected.map(({ name }) => name), 'visible order matches the preview');
            assert.equal(new Set(ids).size, 5);
            assert.deepEqual(['3', '7', '9', '5', '1'].map((uid) => applied.assignments[uid]), ids,
                'each proposed range keeps the correct member');

            await waitForCondition(cdp, async () => {
                const saved = await fetch('/__test/state').then((response) => response.json());
                return saved.extension_settings.worldbook_entry_groups?.books['自动顺序测试书']?.groups?.length === 5;
            });
            const after = await getServerState(baseUrl);
            assert.deepEqual(after.extension_settings.worldbook_entry_groups.books[world], applied,
                'saved grouping order and assignments match the applied config');
            assertOriginalBook(after, original);

            // Also exercise a genuinely nonempty saved config: no canonical-empty exception applies.
            await click(cdp, '#weg-btn-auto-detect');
            await waitForCondition(cdp, () => document.querySelector('#weg-detect-strategy'));
            assert.deepEqual(await readConfig(cdp), applied, 'reopening preview preserves the complete nonempty config');
            await click(cdp, '#weg-submodal-host .weg-submodal-footer [data-weg-sub-close="1"]');
            await waitForCondition(cdp, () => document.querySelector('#weg-submodal-host').hidden);
            assert.deepEqual(await readConfig(cdp), applied, 'cancelling preserves the complete nonempty config');
            assertOriginalBook(await getServerState(baseUrl), original);
            assert.deepEqual(cdp.getErrors().runtimeErrors, []);
        } finally {
            await cdp?.close();
            await server.stop();
        }
    });
}
