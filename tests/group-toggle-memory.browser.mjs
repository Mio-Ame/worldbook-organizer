import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const suite = process.env.WBO_E2E_SUITE;
if (!suite) throw new Error('Set WBO_E2E_SUITE to the retained browser regression suite');
const load = (name) => import(pathToFileURL(resolve(suite, 'lib', name)).href);
const { createMockStServer } = await load('mock-server.mjs');
const { VIEWPORTS, launchEdgeCdp } = await load('cdp.mjs');
const { createDefaultSeed, makeBook, makeEntry } = await import('./entry-groups-fixtures.mjs');
const { getServerState, resetAndBoot, waitForCondition } = await load('assert-helpers.mjs');
const world = '搭配测试书';
const toggle = '[data-weg-group-toggle="a"]';
const undo = '[data-weg-footer-action="undo"]';

async function openPanel(cdp) {
    await cdp.evalFn(() => window.dispatchEvent(new CustomEvent('weg:open-panel', { detail: { worldName: '搭配测试书' } })));
    await waitForCondition(cdp, () => document.querySelector('[data-weg-group-toggle="a"]:enabled'));
}

async function withHost(device, verify) {
    const server = createMockStServer();
    const baseUrl = await server.start();
    let cdp;
    try {
        cdp = await launchEdgeCdp();
        await resetAndBoot(cdp, baseUrl, { viewport: VIEWPORTS[device], seed: createDefaultSeed({
            characters: [], selected_world_info: [],
            worldbooks: { [world]: makeBook([0, 1, 2].map((uid) => makeEntry(uid, { comment: `测试条目${uid}`, disable: uid === 1 }))) },
            pluginSettings: { autoScanNewCharacters: false },
            extraPluginSettingsKey: { worldbook_entry_groups: {
                nativeEntryChoiceSeen: true, enableNativeGrouping: true,
                books: { [world]: { groups: [{ id: 'a', name: '搭配组' }], assignments: { 0: 'a', 1: 'a', 2: 'a' } } },
            } },
        }) });
        await openPanel(cdp);
        await verify(cdp, baseUrl);
        assert.deepEqual(cdp.getErrors().runtimeErrors, []);
    } finally {
        await cdp?.close();
        await server.stop();
    }
}

async function waitDisabled(cdp, expected, selector = toggle) {
    await cdp.evalFn((expected) => { window.expectedMix = expected; }, expected);
    await waitForCondition(cdp, async () => {
        const state = await fetch('/__test/state').then((res) => res.json());
        const entries = state.worldbooks['搭配测试书'].entries;
        return [0, 1, 2].every((uid) => entries[uid].disable === window.expectedMix[uid]);
    });
    await cdp.evalFn((selector) => { window.memoryToggleSelector = selector; }, selector);
    await waitForCondition(cdp, () => document.querySelector(window.memoryToggleSelector + ':enabled'));
}

async function memory(cdp) {
    return cdp.evalFn(() => SillyTavern.getContext().extensionSettings.worldbook_entry_groups.books['搭配测试书']?.pausedGroupStates || {});
}

async function enableAll(cdp) {
    await cdp.clickSelector('[data-weg-group-menu="a"]');
    const found = await cdp.evalFn(() => {
        const button = [...document.querySelectorAll('.weg-floating-menu button')].find((button) => button.textContent.trim() === '全部开启');
        if (!button) return false;
        button.click();
        return true;
    });
    assert.equal(found, true, 'group actions must expose explicit enable-all');
}

for (const device of ['desktop', 'mobile']) {
    test(`${device} group pause survives reload, restores the mix, supports undo and explicit enable-all`, async () => {
        await withHost(device, async (cdp, baseUrl) => {
            await cdp.clickSelector(toggle);
            await waitDisabled(cdp, [true, true, true]);
            assert.deepEqual(await memory(cdp), { a: { 0: false, 1: true, 2: false } });
            await waitForCondition(cdp, async () => (await fetch('/__test/state').then((res) => res.json()))
                .extension_settings.worldbook_entry_groups.books['搭配测试书'].pausedGroupStates?.a?.['1'] === true);
            await cdp.reload();
            await waitForCondition(cdp, () => document.getElementById('wbo-wand-entry'));
            await openPanel(cdp);
            await cdp.clickSelector(toggle);
            await waitDisabled(cdp, [false, true, false]);
            assert.deepEqual(await memory(cdp), {});
            await cdp.clickSelector(undo);
            await waitDisabled(cdp, [true, true, true]);
            assert.deepEqual(await memory(cdp), { a: { 0: false, 1: true, 2: false } }, 'undo restoration restores its paused mix too');
            await enableAll(cdp);
            await waitDisabled(cdp, [false, false, false]);
            assert.deepEqual(await memory(cdp), {});
            await cdp.clickSelector(undo);
            await waitDisabled(cdp, [true, true, true]);
            await cdp.clickSelector(toggle);
            await waitDisabled(cdp, [false, true, false]);
            await cdp.clickSelector(toggle);
            await waitDisabled(cdp, [true, true, true]);
            await cdp.clickSelector(undo);
            await waitDisabled(cdp, [false, true, false]);
            assert.deepEqual(await memory(cdp), {}, 'undo pause does not retain a stale snapshot');
            const payload = (await getServerState(baseUrl)).worldbooks[world];
            assert.deepEqual(Object.values(payload.entries).map((entry) => entry.displayIndex), [0, 1, 2]);
        });
    });

    test(`${device} failed writes preserve the mix and native controls share pause, restoration and undo`, async () => {
        await withHost(device, async (cdp) => {
            await cdp.clickSelector(toggle);
            await waitDisabled(cdp, [true, true, true]);
            const saved = await memory(cdp);
            await cdp.evalFn(() => {
                window.memoryOriginalFetch = window.fetch;
                window.memoryFailedWrites = 0;
                window.fetch = (url, options) => {
                    if (String(url) === '/api/worldinfo/edit') {
                        window.memoryFailedWrites++;
                        return Promise.resolve(new Response('', { status: 503 }));
                    }
                    return window.memoryOriginalFetch(url, options);
                };
            });
            await cdp.clickSelector(toggle);
            await waitForCondition(cdp, () => window.memoryFailedWrites === 1 && document.querySelector('[data-weg-group-toggle="a"]:enabled'));
            assert.deepEqual(await memory(cdp), saved, 'failed restoration must not consume the mix');
            await cdp.evalFn(() => { window.fetch = window.memoryOriginalFetch; });
            await cdp.clickSelector('#weg-btn-close');
            await cdp.evalFn(() => {
                const drawer = document.getElementById('WorldInfo');
                drawer.classList.remove('closedDrawer');
                drawer.classList.add('openDrawer');
                drawer.style.display = 'block';
                const select = document.getElementById('world_editor_select');
                select.value = [...select.options].find((option) => option.textContent === '搭配测试书').value;
                select.dispatchEvent(new Event('change', { bubbles: true }));
            });
            await waitForCondition(cdp, () => document.querySelector('#weg-native-group-enabled:enabled'));
            await cdp.clickSelector('#weg-native-group-enabled');
            const native = '.weg-native-group-heading[data-group-id="a"] .weg-native-group-switch';
            await waitForCondition(cdp, () => document.querySelector('.weg-native-group-heading[data-group-id="a"] .weg-native-group-switch:enabled'));
            await cdp.clickSelector(native);
            await waitDisabled(cdp, [false, true, false], native);
            await cdp.clickSelector(native);
            await waitDisabled(cdp, [true, true, true], native);
            await cdp.clickSelector('.weg-native-group-heading[data-group-id="a"] .weg-native-group-undo');
            await waitDisabled(cdp, [false, true, false], native);
            assert.deepEqual(await memory(cdp), {});
        });
    });
}

for (const operation of ['toggle', 'undo']) {
    test(`late ${operation} read after disable must not write a book or change paused memory`, async () => {
        await withHost('desktop', async (cdp, baseUrl) => {
            if (operation === 'undo') {
                await cdp.clickSelector(toggle);
                await waitDisabled(cdp, [true, true, true]);
            }
            const before = (await getServerState(baseUrl)).worldbooks;
            const saved = await memory(cdp);
            await cdp.evalFn(() => {
                window.memoryOriginalFetch = window.fetch;
                window.lateMemoryWrites = 0;
                window.fetch = async (url, options) => {
                    if (String(url) === '/api/worldinfo/edit') window.lateMemoryWrites++;
                    const response = await window.memoryOriginalFetch(url, options);
                    if (String(url) === '/api/worldinfo/get') {
                        await new Promise((resolve) => { window.releaseMemoryRead = resolve; });
                        window.memoryReadReleased = true;
                    }
                    return response;
                };
            });
            await cdp.clickSelector(operation === 'toggle' ? toggle : undo);
            await waitForCondition(cdp, () => Boolean(window.releaseMemoryRead));
            await cdp.evalFn(async () => {
                (await import('/scripts/extensions/third-party/worldbook-organizer/index.js')).onDisable();
                window.releaseMemoryRead();
            });
            await waitForCondition(cdp, () => window.memoryReadReleased);
            await cdp.evalFn(() => new Promise((resolve) => setTimeout(resolve, 160)));
            assert.equal(await cdp.evalFn(() => window.lateMemoryWrites), 0, 'a stopped operation must not begin writing after its read completes');
            assert.deepEqual(await memory(cdp), saved);
            assert.deepEqual((await getServerState(baseUrl)).worldbooks, before);
            assert.equal(await cdp.evalFn(() => Boolean(document.querySelector('#weg-modal-backdrop, #weg-native-entry-controls'))), false);
        });
    });
}
