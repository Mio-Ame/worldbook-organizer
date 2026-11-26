import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { after, before } from 'node:test';

const suite = process.env.WBO_E2E_SUITE;
if (!suite) throw new Error('Set WBO_E2E_SUITE to the retained browser regression suite');
const load = (name) => import(pathToFileURL(resolve(suite, 'lib', name)).href);
const { createMockStServer } = await load('mock-server.mjs');
const { createDefaultSeed } = await load('fixtures.mjs');
// The pipe transport also runs when the retained suite's WebSocket Page.enable stalls.
const { chromium } = await import(process.env.WBO_PLAYWRIGHT_MODULE
    ? pathToFileURL(resolve(process.env.WBO_PLAYWRIGHT_MODULE)).href : 'playwright');
const plugin = '/scripts/extensions/third-party/worldbook-organizer/src/panel-window.js';
let browser;
before(async () => {
    browser = await chromium.launch({ channel: 'msedge', headless: true, timeout: 15000,
        args: ['--disable-extensions'] });
});
after(async () => { await browser?.close(); });

async function withPage(viewport, run) {
    const server = createMockStServer(createDefaultSeed({
        characters: [], selected_world_info: [],
        worldbooks: { '测试书甲': { entries: {} }, '测试书乙': { entries: {} }, '测试书丙': { entries: {} } },
        pluginSettings: { organizeLastTab: 'organize', autoScanNewCharacters: false, groups: [], assignments: {} },
    }));
    const baseUrl = await server.start();
    const context = await browser.newContext({ viewport, isMobile: viewport.width <= 680, hasTouch: viewport.width <= 680 });
    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
        await page.goto(baseUrl);
        await page.waitForSelector('#wbo-wand-entry', { state: 'attached' });
        await run(page);
        assert.deepEqual(errors, []);
    } catch (error) {
        error.message += `\nPage errors: ${JSON.stringify(errors)}\nURL: ${page.url()}`;
        throw error;
    } finally {
        await context.close();
        await server.stop();
    }
}

async function openPreview(page) {
    await page.locator('#extensionsMenuButton').click();
    await page.locator('#wbo-wand-entry').click();
    await page.locator('[data-action="open-ai-organize"]').click();
    await page.locator('#wbo-toggle-external-ai-btn').click();
    await page.locator('#wbo-ai-json-input').fill(JSON.stringify({ items: [
        { realName: '测试书甲', alias: '测试书甲', group: '分组甲', note: '' },
        { realName: '测试书乙', alias: '测试书乙', group: '分组乙', note: '' },
        { realName: '测试书丙', alias: '测试书丙', group: '分组甲', note: '' },
    ] }));
    await page.locator('#wbo-ai-parse-paste-btn').click();
    await page.locator('#wbo-ai-preview-list .wbo-preview-group-sec').first().waitFor();
}

async function promptMetrics(page) {
    return page.locator('.wbo-prompt-overlay').evaluate((overlay) => {
        const modal = overlay.querySelector('.wbo-modal');
        const input = modal.querySelector('input');
        const button = modal.querySelector('.wbo-modal-footer button');
        const r = modal.getBoundingClientRect();
        return {
            align: getComputedStyle(overlay).alignItems,
            centerDelta: Math.abs(r.top + r.height / 2 - innerHeight / 2),
            height: r.height, width: r.width, left: r.left, right: r.right, top: r.top, bottom: r.bottom,
            gap: button.getBoundingClientRect().top - input.getBoundingClientRect().bottom,
            surface: modal.getAttribute('data-tt-mobile-surface'),
            autoFocused: document.activeElement === input,
            fontSize: parseFloat(getComputedStyle(input).fontSize),
        };
    });
}

for (const viewport of [{ width: 1280, height: 860 }, { width: 390, height: 844 }, { width: 380, height: 760 }]) {
    const device = viewport.width > 680 ? 'desktop' : `mobile-${viewport.width}`;
    test(`${device}: rename prompt stays compact and returns its value without moving its parent`, async () => {
        await withPage(viewport, async (page) => {
            await openPreview(page);
            const parent = page.locator('#wbo-submodal-overlay > .wbo-modal');
            const beforeBox = await parent.boundingBox();
            await page.evaluate(() => { globalThis.__TAURI_RUNNING__ = true; });
            await page.locator('[data-action="rename-preview-group"][data-group-name="分组甲"]').click();
            const metrics = await promptMetrics(page);
            assert.equal(metrics.align, 'center', JSON.stringify(metrics));
            assert.ok(metrics.height < 320 && metrics.centerDelta < 2, JSON.stringify(metrics));
            assert.ok(metrics.gap >= 0 && metrics.gap < 48, JSON.stringify(metrics));
            assert.notEqual(metrics.surface, 'fullscreen-window', 'a text prompt must not request a fullscreen host surface');
            assert.ok(metrics.left >= 0 && metrics.right <= viewport.width && metrics.top >= 0 && metrics.bottom <= viewport.height);
            if (viewport.width <= 680) {
                assert.equal(metrics.autoFocused, false, 'opening a mobile prompt must not summon the keyboard');
                assert.ok(metrics.fontSize >= 16);
            }
            assert.equal(await page.locator('#wbo-inline-prompt-input').inputValue(), '分组甲');
            await page.locator('#wbo-inline-prompt-clear').click();
            assert.equal(await page.locator('#wbo-inline-prompt-input').inputValue(), '');
            await page.locator('#wbo-inline-prompt-input').fill('分组丙');
            await page.locator('#wbo-inline-prompt-ok').click();
            await page.locator('[data-preview-filter="分组丙"]').waitFor();
            assert.equal(await page.locator('[data-preview-filter="分组甲"]').count(), 0);
            assert.deepEqual(await parent.boundingBox(), beforeBox);
            await page.locator('[data-action="rename-preview-group"][data-group-name="分组丙"]').click();
            await page.locator('#wbo-inline-prompt-cancel').click();
            assert.equal(await page.locator('[data-preview-filter="分组丙"]').count(), 1);
        });
    });

    test(`${device}: shared prompt submodal keeps actions immediately below its input`, async () => {
        await withPage(viewport, async (page) => {
            await page.evaluate(async (url) => {
                globalThis.__TAURI_RUNNING__ = true;
                const { createSubModal } = await import(url);
                createSubModal('输入测试', '<label>名称<input type="text" class="wbo-input" spellcheck="false" value="示例"></label><div class="wbo-modal-footer"><button type="button" class="wbo-btn">确定</button></div>', { prompt: true });
            }, plugin);
            const metrics = await promptMetrics(page);
            assert.notEqual(metrics.surface, 'fullscreen-window');
            assert.equal(metrics.align, 'center');
            assert.ok(metrics.height < 320 && metrics.centerDelta < 2, JSON.stringify(metrics));
            assert.ok(metrics.gap >= 0 && metrics.gap < 48, JSON.stringify(metrics));
            await page.locator('.wbo-prompt-overlay .wbo-modal-close').click();
            assert.equal(await page.locator('.wbo-prompt-overlay').count(), 0);
        });
    });

    test(`${device}: preview pills expose their selected filter and switch visible groups without losing selections`, async () => {
        await withPage(viewport, async (page) => {
            await openPreview(page);
            const pills = page.locator('#wbo-preview-group-pills');
            assert.match(await page.locator('#wbo-ai-step-preview .wbo-ai-section-head').innerText(), /点击分组查看/);
            assert.equal(await pills.locator('[data-preview-filter="__all__"]').getAttribute('aria-pressed'), 'true');
            assert.equal(await pills.locator('[aria-pressed="false"]').count(), 2);
            await pills.locator('[data-preview-filter="分组甲"] span').click();
            assert.deepEqual(await page.locator('[data-preview-group]').evaluateAll((els) => els.map((el) => el.dataset.previewGroup)), ['分组甲']);
            assert.equal(await pills.locator('[aria-pressed="true"]').getAttribute('data-preview-filter'), '分组甲');
            assert.equal(await page.locator('#wbo-ai-preview-list .wbo-ai-prop-row').count(), 2);
            const selection = await page.locator('#wbo-preview-sel-count').innerText();
            await pills.locator('[data-preview-filter="分组乙"]').click();
            assert.deepEqual(await page.locator('[data-preview-group]').evaluateAll((els) => els.map((el) => el.dataset.previewGroup)), ['分组乙']);
            assert.equal(await pills.locator('[aria-pressed="true"]').getAttribute('data-preview-filter'), '分组乙');
            assert.equal(await page.locator('#wbo-ai-preview-list .wbo-ai-prop-row').count(), 1);
            await pills.locator('[data-preview-filter="__all__"]').click();
            assert.equal(await page.locator('[data-preview-group]').count(), 2);
            assert.equal(await pills.locator('[aria-pressed="true"]').count(), 1);
            assert.equal(await page.locator('#wbo-preview-sel-count').innerText(), selection);
        });
    });
}
