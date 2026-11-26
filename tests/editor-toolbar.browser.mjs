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

test('switching editor font preserves toolbar rows across panel widths and leaves the mobile height action available', async () => {
    const world = '编辑工具栏测试书';
    const content = '测试正文。\n'.repeat(48);
    const seed = createDefaultSeed({ characters: [], selected_world_info: [],
        worldbooks: { [world]: makeBook([makeEntry(0, { comment: '工具栏测试条目', content })]) },
        pluginSettings: { autoScanNewCharacters: false, entryEditorMonoFont: false },
    });
    const server = createMockStServer();
    const baseUrl = await server.start();
    let cdp;
    try {
        cdp = await launchEdgeCdp();
        await resetAndBoot(cdp, baseUrl, { seed, viewport: VIEWPORTS.desktop });
        await openManager(cdp);
        await cdp.clickSelector('.wbo-book-item .wbo-book-main');
        await waitForCondition(cdp, () => document.querySelector('[data-acc-toggle]'));
        await cdp.clickSelector('[data-acc-toggle]');
        await waitForCondition(cdp, () => document.querySelector('[data-acc-mono]'));
        const measurements = await cdp.evalFn(async () => {
            await document.fonts.ready;
            const modal = document.querySelector('.wbo-modal');
            const editor = document.querySelector('.wbo-acc-editor');
            const button = editor.querySelector('[data-acc-mono]');
            const area = editor.querySelector('[data-acc-field="content"]');
            const stats = editor.querySelector('[data-acc-stats]');
            const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
            const read = () => {
                const root = editor.getBoundingClientRect();
                const positions = [...editor.querySelectorAll('.wbo-acc-toolbar-right button')].map((node) => {
                    const rect = node.getBoundingClientRect();
                    return { top: rect.top - root.top, left: rect.left - root.left, width: rect.width };
                });
                return { positions, areaTop: area.getBoundingClientRect().top - root.top,
                    mono: area.classList.contains('is-mono'), text: area.value, stats: stats.textContent };
            };
            const changed = [];
            modal.style.setProperty('max-width', 'none', 'important');
            for (let width = 440; width <= 1104; width += 8) {
                modal.style.setProperty('width', `${width}px`, 'important');
                if (button.getAttribute('aria-pressed') === 'true') button.click();
                await frame();
                const before = read();
                button.click();
                await frame();
                const after = read();
                const unstable = before.positions.some((rect, index) => {
                    const next = after.positions[index];
                    return Math.abs(rect.top - next.top) > 1 || Math.abs(rect.left - next.left) > 1 || Math.abs(rect.width - next.width) > 1;
                }) || Math.abs(before.areaTop - after.areaTop) > 1;
                if (unstable) changed.push({ width, before: before.positions, after: after.positions,
                    areaTopBefore: before.areaTop, areaTopAfter: after.areaTop });
                if (before.mono || !after.mono || before.text !== after.text || before.stats !== after.stats) {
                    throw new Error('font switching changed content/counters or failed to switch the textarea font');
                }
            }
            return { samples: 84, changed: changed.slice(0, 4), changedCount: changed.length };
        });
        assert.equal(measurements.changedCount, 0, `font switching must not move toolbar controls: ${JSON.stringify(measurements)}`);
        await cdp.setViewport(VIEWPORTS.mobile);
        await cdp.evalFn(() => {
            const modal = document.querySelector('.wbo-modal');
            modal.style.removeProperty('width');
            modal.style.removeProperty('max-width');
        });
        const mobile = await cdp.evalFn(() => {
            const editor = document.querySelector('.wbo-acc-editor');
            const mono = editor.querySelector('[data-acc-mono]');
            const tall = editor.querySelector('[data-acc-tall]');
            const area = editor.querySelector('[data-acc-field="content"]');
            const rect = tall.getBoundingClientRect();
            const before = area.getBoundingClientRect().height;
            tall.click();
            return { monoHidden: getComputedStyle(mono).display === 'none',
                tallVisible: rect.width > 0 && rect.left >= 0 && rect.right <= innerWidth,
                before, after: area.getBoundingClientRect().height };
        });
        assert.equal(mobile.monoHidden, true);
        assert.equal(mobile.tallVisible, true);
        assert.ok(mobile.after >= mobile.before + 80, 'the mobile height action must still increase the editable area');
        assert.equal((await getServerState(baseUrl)).worldbooks[world].entries['0'].content, content);
        assert.deepEqual(cdp.getErrors().runtimeErrors, []);
    } finally {
        await cdp?.close();
        await server.stop();
    }
});
