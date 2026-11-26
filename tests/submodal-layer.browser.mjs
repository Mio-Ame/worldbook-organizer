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
const { openManager, resetAndBoot, waitForCondition } = await load('assert-helpers.mjs');

async function withPanel(device, verify) {
    const server = createMockStServer();
    const baseUrl = await server.start();
    let cdp;
    try {
        cdp = await launchEdgeCdp();
        await resetAndBoot(cdp, baseUrl, { viewport: VIEWPORTS[device], seed: createDefaultSeed({
            characters: [], selected_world_info: [],
            worldbooks: { '层级测试书': makeBook(Array.from({ length: 24 }, (_, uid) => makeEntry(uid, { comment: `【测试】条目 ${uid}` }))) },
            pluginSettings: { autoScanNewCharacters: false },
        }) });
        await openManager(cdp);
        await cdp.clickSelector('.wbo-book-item .wbo-book-main');
        await cdp.clickSelector('[data-acc-extra="open-entry-groups"]');
        await waitForCondition(cdp, () => document.querySelector('#weg-body .weg-entry-row'));
        await verify(cdp);
        assert.deepEqual(cdp.getErrors().runtimeErrors, []);
    } finally {
        await cdp?.close();
        await server.stop();
    }
}

async function assertOnTop(cdp, selector) {
    const result = await cdp.evalFn((selector) => {
        const target = document.querySelector(selector);
        if (!target) return { missing: selector };
        const r = target.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        const chain = (el) => {
            const result = [];
            for (; el; el = el.parentElement) {
                const css = getComputedStyle(el);
                result.push({ tag: el.tagName, id: el.id, cls: el.className, position: css.position,
                    z: css.zIndex, container: css.containerType, isolation: css.isolation });
            }
            return result;
        };
        return { hit: Boolean(hit && (hit === target || target.contains(hit))), rect: r.toJSON(),
            target: chain(target), above: chain(hit) };
    }, selector);
    assert.equal(result.hit, true, JSON.stringify(result));
}

for (const device of ['desktop', 'mobile', 'mobileCompact']) {
    test(`${device}: entry grouping subwindows stay above their parent from the main panel`, async () => {
        await withPanel(device, async (cdp) => {
            const position = () => cdp.evalFn(() => ({
                page: scrollY, top: document.querySelector('.weg-modal').getBoundingClientRect().top,
                close: document.querySelector('#weg-btn-close').getBoundingClientRect().top,
                scroll: document.querySelector('#weg-body').scrollTop,
                book: document.querySelector('#weg-book-select').value,
            }));
            const before = await position();
            for (const button of ['#weg-btn-auto-detect', '#weg-btn-settings', '#weg-btn-new-group']) {
                assert.ok((await cdp.clickSelector(button, { scroll: false })).hit, button);
                await waitForCondition(cdp, () => !document.querySelector('#weg-submodal-host').hidden);
                await assertOnTop(cdp, '#weg-submodal-host .weg-submodal-title');
                await assertOnTop(cdp, '#weg-submodal-host .weg-submodal-footer button');
                await assertOnTop(cdp, '#weg-submodal-host [aria-label="返回"]');
                if (button === '#weg-btn-auto-detect') {
                    await cdp.clickSelector('#weg-detect-manage-schemes', { scroll: false });
                    await assertOnTop(cdp, '#weg-scheme-name');
                    await assertOnTop(cdp, '#weg-scheme-save');
                    await cdp.clickSelector('[data-weg-scheme-back]', { scroll: false });
                    await assertOnTop(cdp, '#weg-detect-scan-all');
                }
                await cdp.clickSelector('#weg-submodal-host [aria-label="返回"]', { scroll: false });
                assert.equal(await cdp.evalFn(() => document.querySelector('#weg-submodal-host').hidden), true);
                assert.deepEqual(await position(), before, 'closing only the child preserves book, scroll and window position');
            }
            if (device !== 'desktop') {
                await cdp.clickSelector('[data-wbo-fullscreen-btn="entry-groups"]', { scroll: false });
            }
            const start = await cdp.evalFn(() => {
                const r = document.querySelector('.weg-header-title').getBoundingClientRect();
                return { x: Math.round(r.left + 30), y: Math.round(r.top + r.height / 2) };
            });
            await cdp.mouseDrag(start.x, start.y, start.x + 12, start.y + 35);
            const moved = await position();
            await cdp.clickSelector('#weg-btn-auto-detect', { scroll: false });
            await waitForCondition(cdp, () => !document.querySelector('#weg-submodal-host').hidden);
            await assertOnTop(cdp, '#weg-detect-strategy');
            await assertOnTop(cdp, '#weg-submodal-host [aria-label="返回"]');
            await cdp.clickSelector('#weg-submodal-host [aria-label="返回"]', { scroll: false });
            assert.deepEqual(await position(), moved, 'moving/restoring the parent does not change child stacking or parent scroll');
            assert.equal(await cdp.evalFn(() => document.querySelectorAll('#weg-modal-backdrop, #weg-submodal-host').length), 2);
        });
    });

    test(`${device}: shared child windows opened above entry grouping remain clickable`, async () => {
        await withPanel(device, async (cdp) => {
            await cdp.evalFn(async () => {
                const { createSubModal } = await import('/scripts/extensions/third-party/worldbook-organizer/src/panel-window.js');
                createSubModal('层级提示', '<p>测试提示</p><button type="button" id="layer-test-confirm">确定</button>', { stack: true, prompt: true });
            });
            await assertOnTop(cdp, '#layer-test-confirm');
            await assertOnTop(cdp, '.wbo-prompt-overlay .wbo-modal-close');
            await cdp.evalFn(async () => {
                const { createSubModal } = await import('/scripts/extensions/third-party/worldbook-organizer/src/panel-window.js');
                createSubModal('第二层提示', '<button type="button" id="layer-test-nested">返回</button>', { stack: true });
            });
            await assertOnTop(cdp, '#layer-test-nested');
            await cdp.clickSelector('#wbo-submodal-overlay-1 .wbo-modal-close', { scroll: false });
            await assertOnTop(cdp, '#layer-test-confirm');
            await cdp.clickSelector('.wbo-prompt-overlay .wbo-modal-close', { scroll: false });
            assert.equal(await cdp.evalFn(() => Boolean(document.querySelector('#layer-test-confirm'))), false);
            assert.equal(await cdp.evalFn(() => document.querySelector('#weg-modal-backdrop').hidden), false);
            await cdp.evalFn(async () => {
                const { openInlineTextPrompt } = await import('/scripts/extensions/third-party/worldbook-organizer/src/panel-window.js');
                void openInlineTextPrompt({ title: '输入测试', value: '示例名称' });
            });
            await assertOnTop(cdp, '#wbo-inline-prompt-input');
            await assertOnTop(cdp, '#wbo-inline-prompt-cancel');
            await cdp.clickSelector('#wbo-inline-prompt-cancel', { scroll: false });
            assert.equal(await cdp.evalFn(() => Boolean(document.querySelector('#wbo-inline-prompt-input'))), false);
        });
    });
}
