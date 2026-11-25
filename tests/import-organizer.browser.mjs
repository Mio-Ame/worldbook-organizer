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
const { getServerState, mutateServer, openManager, resetAndBoot, waitForCondition } = await load('assert-helpers.mjs');

async function run(seed, action) {
    const server = createMockStServer();
    const baseUrl = await server.start();
    let cdp;
    try {
        cdp = await launchEdgeCdp();
        await resetAndBoot(cdp, baseUrl, { seed, viewport: VIEWPORTS.desktop });
        await action(cdp, baseUrl);
        assert.deepEqual(cdp.getErrors().runtimeErrors, []);
    } finally {
        await cdp?.close();
        await server.stop();
    }
}

test('an existing user with no destination can create one, opt in and see the prompt only once', async () => {
    const seed = createDefaultSeed({
        characters: [],
        worldbooks: { 成人向测试书: { entries: {} }, 普通测试书: { entries: {} } },
        selected_world_info: [],
        pluginSettings: { groups: [], assignments: {}, autoScanNewCharacters: false, organizeLastTab: 'organize' },
    });
    await run(seed, async (cdp, baseUrl) => {
        await openManager(cdp);
        assert.deepEqual((await getServerState(baseUrl)).extension_settings.worldbook_organizer.assignments, {});
        assert.equal(await cdp.evalFn(() => Boolean(document.querySelector('#wbo-mgr-import-prompt'))), false);
        await cdp.clickSelector('[data-action="open-ai-organize"]');
        assert.equal(await cdp.evalFn(() => document.querySelector('#wbo-ai-import-prompt').hidden), true);
        await cdp.clickSelector('[data-ai-book-tab="sensitive"]');
        const promptLayout = await cdp.evalFn(() => {
            const list = document.querySelector('#wbo-ai-book-list').getBoundingClientRect();
            const setup = document.querySelector('[data-open-import-rules-intro]').getBoundingClientRect();
            const skip = document.querySelector('[data-skip-import-rules-intro]').getBoundingClientRect();
            return { belowList: setup.top >= list.bottom, sameRow: setup.top === skip.top, gap: skip.left - setup.right };
        });
        assert.deepEqual(promptLayout, { belowList: true, sameRow: true, gap: 6 });
        await cdp.clickSelector('[data-open-import-rules-intro]');
        assert.equal(await cdp.evalFn(() => document.querySelector('[data-import-group-name]').value), 'NSFW');
        await cdp.clickSelector('[data-import-apply-existing]');
        await cdp.clickSelector('[data-import-rules-save]');
        await waitForCondition(cdp, async () => {
            const config = (await fetch('/__test/state').then((res) => res.json())).extension_settings.worldbook_organizer;
            return config.importOrganize?.sensitivePromptSeen && config.assignments['成人向测试书'];
        });
        const { groups, assignments, importOrganize } = (await getServerState(baseUrl)).extension_settings.worldbook_organizer;
        assert.equal(groups.find((group) => group.id === importOrganize.sensitiveGroupId).name, 'NSFW');
        assert.equal(assignments['成人向测试书'], importOrganize.sensitiveGroupId);
        await waitForCondition(cdp, () => document.querySelector('#wbo-ai-import-prompt').hidden && !document.querySelector('[data-import-rules-save]'));
        assert.equal(await cdp.evalFn(() => document.querySelector('#wbo-sens-target-group option:checked').textContent), 'NSFW');
        await cdp.reload();
        await openManager(cdp);
        await cdp.clickSelector('[data-action="open-ai-organize"]');
        await cdp.clickSelector('[data-ai-book-tab="sensitive"]');
        assert.equal(await cdp.evalFn(() => document.querySelector('#wbo-ai-import-prompt').hidden), true);
    });
});

test('skipping the sensitive import prompt persists without applying a rule', async () => {
    const seed = createDefaultSeed({
        characters: [],
        worldbooks: { 成人向测试书: { entries: {} } },
        selected_world_info: [],
        pluginSettings: { groups: [], assignments: {}, autoScanNewCharacters: false, organizeLastTab: 'organize' },
    });
    await run(seed, async (cdp, baseUrl) => {
        await openManager(cdp);
        await cdp.clickSelector('[data-action="open-ai-organize"]');
        await cdp.clickSelector('[data-skip-import-rules-intro]');
        assert.equal(await cdp.evalFn(() => document.querySelector('#wbo-ai-import-prompt').hidden), true);
        await waitForCondition(cdp, async () => {
            const config = (await fetch('/__test/state').then((res) => res.json())).extension_settings.worldbook_organizer;
            return config.importOrganize?.sensitivePromptSeen;
        });
        const { groups, assignments, importOrganize } = (await getServerState(baseUrl)).extension_settings.worldbook_organizer;
        assert.deepEqual(groups, []);
        assert.deepEqual(assignments, {});
        assert.equal(importOrganize.sensitiveGroupId, '');
    });
});

test('saved title rules handle a native import batch without treating new, bound or entry-only matches as candidates', async () => {
    const seed = createDefaultSeed({
        characters: [{ name: '示例角色', avatar: 'fixture.png', data: { extensions: { world: '特征角色书' } } }],
        worldbooks: { 既有普通书: { entries: {} } },
        selected_world_info: [],
        pluginSettings: {
            groups: [{ id: 'title-match', name: '测试归类组' }, { id: 'adult', name: '成人向' }],
            assignments: {},
            autoScanNewCharacters: false,
            importOrganize: { sensitivePromptSeen: true, sensitiveGroupId: 'adult', rules: [] },
        },
    });
    await run(seed, async (cdp, baseUrl) => {
        await openManager(cdp);
        await cdp.clickSelector('[data-action="open-settings-modal"]');
        await cdp.clickSelector('[data-settings-tab="behavior"]');
        await cdp.clickSelector('[data-open-import-rules]');
        await cdp.clickSelector('[data-import-add-rule]');
        await cdp.evalFn(() => {
            const keyword = document.querySelector('[data-import-keyword]');
            keyword.value = '特征';
            keyword.dispatchEvent(new Event('input', { bubbles: true }));
            const destination = document.querySelector('[data-import-rule-target]');
            destination.value = 'title-match';
            destination.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await cdp.clickSelector('[data-import-rules-save]');
        await waitForCondition(cdp, () => !document.querySelector('[data-import-rules-save]'));
        await cdp.clickSelector('#wbo-settings-close-btn');
        await cdp.evalFn(() => {
            const input = document.createElement('input');
            input.type = 'file';
            input.id = 'world_import_file';
            const selection = new DataTransfer();
            for (const name of ['特征导入书', '成人向导入书', '特征角色书', '正文命中而标题无关']) {
                selection.items.add(new File(['{}'], name + '.json'));
            }
            input.files = selection.files;
            document.body.append(input);
            input.dispatchEvent(new Event('change', { bubbles: true }));
            input.remove();
        });
        for (const name of ['特征导入书', '成人向导入书', '特征角色书', '特征新建书', '正文命中而标题无关']) {
            await mutateServer(baseUrl, {
                addWorldbook: { name, data: { entries: { 0: { uid: 0, comment: '特征条目', content: '成人向测试正文' } } } },
            });
        }
        await cdp.evalFn(() => window.__ST_HOST_RUNTIME__.updateWorldInfoList());
        await waitForCondition(cdp, async () => {
            const config = (await fetch('/__test/state').then((res) => res.json())).extension_settings.worldbook_organizer;
            return config.assignments['特征导入书'] === 'title-match' && config.assignments['成人向导入书'] === 'adult';
        });
        const state = await getServerState(baseUrl);
        assert.deepEqual(state.extension_settings.worldbook_organizer.assignments, { 特征导入书: 'title-match', 成人向导入书: 'adult' });
        assert.equal(state.worldbooks['正文命中而标题无关'].entries['0'].content, '成人向测试正文');
        assert.deepEqual(state.metrics.worldEditCalls, []);
    });
});
