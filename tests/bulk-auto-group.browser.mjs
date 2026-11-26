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

async function withScan(viewport, run) {
    const server = createMockStServer();
    const baseUrl = await server.start();
    let cdp;
    const worlds = Array.from({ length: 12 }, (_, i) => `分批测试书${String(i).padStart(2, '0')}`);
    const worldbooks = Object.fromEntries(worlds.map((world) => [world, makeBook([0, 1, 2, 3].map((uid) =>
        makeEntry(uid, { comment: `【背景】资料${uid}`, displayIndex: uid }))) ]));
    try {
        cdp = await launchEdgeCdp();
        await resetAndBoot(cdp, baseUrl, { viewport, seed: createDefaultSeed({
            characters: [], selected_world_info: [], worldbooks,
            pluginSettings: { autoScanNewCharacters: false },
            extraPluginSettingsKey: { worldbook_entry_groups: { books: {} } },
        }) });
        await cdp.evalFn((worldName) => window.dispatchEvent(new CustomEvent('weg:open-panel', { detail: { worldName } })), worlds[0]);
        await waitForCondition(cdp, () => !!document.querySelector('#weg-body .weg-entry-row'));
        await cdp.clickSelector('#weg-btn-auto-detect');
        await waitForCondition(cdp, () => !!document.getElementById('weg-detect-strategy'));
        await cdp.evalFn(() => {
            window.__batchReads = [];
            const original = window.fetch;
            window.fetch = (resource, options) => {
                if (resource === '/api/worldinfo/get' && options?.signal) window.__batchReads.push(JSON.parse(options.body).name);
                return original(resource, options);
            };
        });
        await run({ cdp, baseUrl, worlds });
        assert.deepEqual((await getServerState(baseUrl)).worldbooks, worldbooks, 'scanning and grouping leave original entries untouched');
        assert.deepEqual(cdp.getErrors().runtimeErrors, []);
    } finally {
        await cdp?.close();
        await server.stop();
    }
}

async function configure(cdp, autoContinue) {
    const hasControls = await cdp.evalFn(() => Boolean(document.getElementById('weg-detect-batch-size')
        && document.getElementById('weg-detect-auto-continue')));
    assert.equal(hasControls, true, 'batch size and automatic continuation must be explicit controls');
    await cdp.evalFn((auto) => {
        const size = document.getElementById('weg-detect-batch-size');
        size.value = '5';
        size.dispatchEvent(new Event('change', { bubbles: true }));
        const toggle = document.getElementById('weg-detect-auto-continue');
        toggle.checked = auto;
        toggle.dispatchEvent(new Event('change', { bubbles: true }));
    }, autoContinue);
}

for (const device of ['desktop', 'mobile']) {
    test(`${device}: manual batches pause, clearly show groups and examples, and continue without duplicate reads`, { timeout: 45000 }, async () => {
        await withScan(VIEWPORTS[device], async ({ cdp, baseUrl, worlds }) => {
            await configure(cdp, false);
            await cdp.clickSelector('#weg-detect-scan-all');
            await waitForCondition(cdp, () => !!document.querySelector('#weg-detect-continue:enabled'));
            assert.equal(await cdp.evalFn(() => window.__batchReads.length), 5);
            await cdp.evalFn(() => new Promise((resolve) => setTimeout(resolve, 200)));
            assert.equal(await cdp.evalFn(() => window.__batchReads.length), 5, 'paused batches do not silently continue');
            assert.match(await cdp.evalFn(() => document.getElementById('weg-detect-preview-book').closest('label').textContent), /查看哪本书的分组建议/);
            assert.match(await cdp.evalFn(() => document.querySelector('.weg-detect-results').textContent), /5.*12.*5.*5/s);
            assert.match(await cdp.evalFn(() => document.querySelector('.weg-detect-result-heading').textContent), /分组建议/);
            assert.equal(await cdp.evalFn(() => document.querySelectorAll('.weg-detect-examples li').length), 3);
            assert.match(await cdp.evalFn(() => document.querySelector('.weg-detect-examples').textContent), /资料0/);
            assert.match(await cdp.evalFn(() => document.querySelector('.weg-detect-preview-note').textContent), /应用所选分组.*生效/);
            assert.equal(await cdp.evalFn(() => Object.keys(SillyTavern.getContext().extensionSettings.worldbook_entry_groups.books).length), 0);
            await cdp.clickSelector('#weg-detect-continue');
            await waitForCondition(cdp, () => window.__batchReads.length === 10 && !!document.querySelector('#weg-detect-continue:enabled'));
            await cdp.clickSelector('#weg-detect-continue');
            await waitForCondition(cdp, () => document.querySelector('#weg-detect-preview-book')?.options.length === 12);
            assert.equal(await cdp.evalFn(() => !!document.getElementById('weg-detect-continue')), false);
            const reads = await cdp.evalFn(() => window.__batchReads);
            assert.deepEqual(reads, worlds);
            const result = await cdp.evalFn(() => {
                const body = document.querySelector('#weg-submodal-host .weg-submodal-body');
                const heading = document.querySelector('.weg-detect-result-heading');
                const modal = document.querySelector('#weg-submodal-host .weg-submodal-card');
                const rect = modal.getBoundingClientRect();
                return { heading: heading.getBoundingClientRect().top, top: body.getBoundingClientRect().top,
                    bottom: body.getBoundingClientRect().bottom, fits: rect.left >= 0 && rect.right <= innerWidth };
            });
            assert.equal(result.fits, true);
            assert.ok(result.heading >= result.top && result.heading < result.bottom, JSON.stringify(result));
            await cdp.clickSelector('#weg-detect-apply-btn');
            await waitForCondition(cdp, () => !document.getElementById('weg-detect-apply-btn'));
            assert.equal(await cdp.evalFn(() => Object.values(SillyTavern.getContext().extensionSettings.worldbook_entry_groups.books)
                .filter((book) => book.groups.length).length), 12);
            assert.deepEqual((await getServerState(baseUrl)).metrics.worldEditCalls, []);
        });
    });
}

test('automatic batches need only one start; stopping an in-flight continuation preserves completed results', { timeout: 45000 }, async () => {
    await withScan(VIEWPORTS.mobile, async ({ cdp }) => {
        await configure(cdp, true);
        await cdp.evalFn(() => {
            const original = window.fetch;
            let count = 0;
            window.fetch = (resource, options) => {
                if (resource === '/api/worldinfo/get' && options?.signal && ++count === 7) {
                    window.__batchHeld = true;
                    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => {
                        window.__batchAborted = true;
                        window.fetch = original;
                        reject(options.signal.reason);
                    }, { once: true }));
                }
                return original(resource, options);
            };
        });
        await cdp.clickSelector('#weg-detect-scan-all');
        await waitForCondition(cdp, () => window.__batchHeld === true);
        assert.equal(await cdp.evalFn(() => !!document.querySelector('#weg-detect-stop')), true);
        await cdp.clickSelector('#weg-detect-stop');
        await waitForCondition(cdp, () => window.__batchAborted === true && !!document.getElementById('weg-detect-preview-book'));
        assert.equal(await cdp.evalFn(() => document.getElementById('weg-detect-preview-book').options.length), 6);
        assert.equal(await cdp.evalFn(() => Object.keys(SillyTavern.getContext().extensionSettings.worldbook_entry_groups.books).length), 0);
        await cdp.clickSelector('#weg-detect-continue');
        await waitForCondition(cdp, () => document.getElementById('weg-detect-preview-book')?.options.length === 12);
        assert.equal(await cdp.evalFn(() => !!document.getElementById('weg-detect-continue')), false);
    });
});

test('closing a scan ignores a late response even when the host transport does not honor cancellation', { timeout: 45000 }, async () => {
    await withScan(VIEWPORTS.mobile, async ({ cdp }) => {
        await configure(cdp, true);
        await cdp.evalFn(() => {
            const original = window.fetch;
            window.fetch = (resource, options) => {
                if (resource === '/api/worldinfo/get' && options?.signal) {
                    window.__batchReads.push(JSON.parse(options.body).name);
                    window.fetch = original;
                    return new Promise((resolve) => {
                        window.__releaseLateScan = async () => {
                            resolve(await original(resource, { ...options, signal: undefined }));
                            window.__lateScanReleased = true;
                        };
                    });
                }
                return original(resource, options);
            };
        });
        await cdp.clickSelector('#weg-detect-scan-all');
        await waitForCondition(cdp, () => typeof window.__releaseLateScan === 'function');
        await cdp.clickSelector('#weg-submodal-host [data-weg-sub-close="1"]');
        assert.equal(await cdp.evalFn(() => document.getElementById('weg-submodal-host').hidden), true);
        await cdp.evalFn(() => window.__releaseLateScan());
        await waitForCondition(cdp, () => window.__lateScanReleased === true);
        await cdp.evalFn(() => new Promise((resolve) => setTimeout(resolve, 120)));
        assert.equal(await cdp.evalFn(() => document.getElementById('weg-submodal-host').hidden), true);
        assert.equal(await cdp.evalFn(() => document.querySelectorAll('#weg-detect-preview-book').length), 0);
        assert.equal(await cdp.evalFn(() => Object.keys(SillyTavern.getContext().extensionSettings.worldbook_entry_groups.books).length), 0);
        assert.equal(await cdp.evalFn(() => window.__batchReads.length), 1);
    });
});
