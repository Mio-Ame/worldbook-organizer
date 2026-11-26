import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { after, before } from 'node:test';

const suite = process.env.WBO_E2E_SUITE;
if (!suite) throw new Error('Set WBO_E2E_SUITE to the retained browser regression suite');
const load = (name) => import(pathToFileURL(resolve(suite, 'lib', name)).href);
const { createMockStServer } = await load('mock-server.mjs');
const { createDefaultSeed } = await load('fixtures.mjs');
const { chromium } = await import(process.env.WBO_PLAYWRIGHT_MODULE
    ? pathToFileURL(resolve(process.env.WBO_PLAYWRIGHT_MODULE)).href : 'playwright');
let browser;
before(async () => {
    browser = await chromium.launch({ channel: 'msedge', headless: true, timeout: 15000,
        args: ['--disable-extensions'] });
});
after(async () => { await browser?.close(); });

const favoritePill = '#wbo-mgr-pills [data-group-id="__pinned__"]';
const defaultPill = '#wbo-mgr-pills [data-group-id="__default__"]';
const section = '#wbo-mgr-groups-list .wbo-group[data-group-id="__pinned__"]';
const star = '#wbo-mgr-groups-list .wbo-book-item[data-book="收藏测试书甲"] .wbo-star-btn';

async function openPanel(page) {
    await page.locator('#wbo-wand-entry').waitFor({ state: 'attached' });
    await page.locator('#extensionsMenuButton').click();
    await page.locator('#wbo-wand-entry').click();
}

async function withPanel(viewport, run, pinnedBooks = ['收藏测试书甲']) {
    const server = createMockStServer(createDefaultSeed({
        characters: [], selected_world_info: [],
        worldbooks: { '收藏测试书甲': { entries: {} }, '收藏测试书乙': { entries: {} } },
        pluginSettings: {
            autoScanNewCharacters: false, showCharBooks: true, hideCharBooksByDefault: false, activeFilterGroupId: '__default__',
            globalHiddenGroupIds: [], editorHiddenGroupIds: [],
            groupPanelExpanded: true, pinnedBooks, pinnedGroupCollapsed: false,
            groups: [{ id: 'fixture-group', name: '测试分组', collapsed: false }],
            assignments: { '收藏测试书甲': 'fixture-group', '收藏测试书乙': 'fixture-group' },
        },
    }));
    const baseUrl = await server.start();
    const mobile = viewport.width <= 680;
    const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile });
    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
        await page.goto(baseUrl);
        await openPanel(page);
        const activate = (selector) => mobile ? page.locator(selector).tap() : page.locator(selector).click();
        await run(page, activate);
        assert.deepEqual(errors, []);
    } finally {
        await context.close();
        await server.stop();
    }
}

for (const viewport of [{ width: 1280, height: 860 }, { width: 390, height: 844 }]) {
    test(`${viewport.width}: main worldbook favorites use collection wording in initial and in-place UI`, async () => {
        await withPanel(viewport, async (page, activate) => {
            assert.equal(await page.locator(star).getAttribute('title'), '收藏此世界书');
            const favoriteSaved = page.waitForResponse((response) => response.url().endsWith('/api/settings/save')
                && response.request().postDataJSON()?.extension_settings?.worldbook_organizer?.pinnedBooks?.includes('收藏测试书甲'));
            await activate(star);
            await page.waitForFunction(() => document.querySelector('.wbo-star-btn[aria-pressed="true"]'));
            assert.equal(await page.locator(star).getAttribute('title'), '取消收藏');
            assert.match(await page.locator(favoritePill).innerText(), /★ 已收藏/);
            await page.locator('#toast-container .toast').filter({ hasText: '已收藏「收藏测试书甲」' }).waitFor();

            // Reload also checks initial templates rather than only the in-place update path.
            await favoriteSaved;
            await page.reload();
            await openPanel(page);
            assert.match(await page.locator(favoritePill).innerText(), /★ 已收藏/);
            assert.equal(await page.locator(star).first().getAttribute('title'), '取消收藏');
            assert.equal(await page.locator(`${section} .wbo-group-name`).innerText(), '★ 已收藏');
            await activate(favoritePill);
            assert.equal(await page.locator(`${section} .wbo-group-name`).innerText(), '★ 已收藏');
            await page.locator('#wbo-mgr-search-input').fill('无匹配测试词');
            await page.locator('#wbo-mgr-groups-list .wbo-empty-hint').filter({ hasText: '已收藏中无匹配世界书' }).waitFor();
            await page.locator('#wbo-mgr-search-input').fill('');
            await page.locator(star).waitFor();
            await activate(star);
            assert.equal(await page.locator(star).getAttribute('title'), '收藏此世界书');
            await page.locator('#toast-container .toast').filter({ hasText: '已取消收藏' }).waitFor();
            await page.locator('#wbo-mgr-search-input').fill('收藏测试书');
            await page.locator('#wbo-mgr-groups-list .wbo-empty-hint').filter({ hasText: '已收藏中无匹配世界书' }).waitFor();
            await page.locator('#wbo-mgr-search-input').fill('');
            await page.locator('#wbo-mgr-groups-list .wbo-empty-hint').filter({ hasText: '暂无已收藏的世界书，点击书行右侧 ★ 即可收藏' }).waitFor();
            assert.doesNotMatch(await page.locator('.wbo-manager-modal').innerText(), /已置顶|取消置顶|即可置顶/);
        }, []);
    });

    test(`${viewport.width}: favorites in all-books view already support collapse without reordering`, async () => {
        await withPanel(viewport, async (page, activate) => {
            const toggle = `${section} button[data-action="toggle-group-collapse"]`;
            assert.equal(await page.locator(toggle).count(), 1);
            assert.equal(await page.locator(`${toggle} .wbo-chevron.fa-chevron-down`).count(), 1);
            await activate(toggle);
            assert.equal(await page.locator(toggle).getAttribute('aria-expanded'), 'false');
            assert.equal(await page.locator(`${section} .wbo-group-body`).count(), 0);
            await activate(toggle);
            assert.equal(await page.locator(toggle).getAttribute('aria-expanded'), 'true');
            assert.equal(await page.locator(`${section} .wbo-book-item`).count(), 1);
            assert.equal(await page.locator(`${section} .wbo-group-drag-handle, ${section} [data-action^="move-section-"]`).count(), 0);
        });
    });

    test(`${viewport.width}: selected favorites have the same collapse arrow and preserve collapse through switching, reload and search`, async () => {
        await withPanel(viewport, async (page, activate) => {
            await activate(favoritePill);
            const toggle = `${section} button[data-action="toggle-group-collapse"]`;
            assert.equal(await page.locator(toggle).count(), 1, 'selected favorites must not turn the header into a static colored dot');
            assert.equal(await page.locator(`${toggle} .wbo-chevron.fa-chevron-down`).count(), 1);
            await activate(toggle);
            assert.equal(await page.locator(toggle).getAttribute('aria-expanded'), 'false');
            assert.equal(await page.locator(`${toggle} .wbo-chevron.fa-chevron-right`).count(), 1);
            assert.equal(await page.locator(`${section} .wbo-group-body`).count(), 0);
            await page.waitForFunction(() => SillyTavern.getContext().extensionSettings.worldbook_organizer.pinnedGroupCollapsed === true);
            await activate(defaultPill);
            assert.equal(await page.locator(toggle).getAttribute('aria-expanded'), 'false');
            await activate(favoritePill);
            assert.equal(await page.locator(toggle).getAttribute('aria-expanded'), 'false');
            await page.reload();
            await openPanel(page);
            assert.equal(await page.locator(toggle).getAttribute('aria-expanded'), 'false');

            await page.locator('#wbo-mgr-search-input').fill('收藏测试书甲');
            await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute('aria-expanded') === 'true', toggle);
            assert.equal(await page.locator(`${section} .wbo-book-item`).count(), 1, 'search temporarily reveals matching favorites');
            await page.locator('#wbo-mgr-search-input').fill('');
            await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute('aria-expanded') === 'false', toggle);
            assert.equal(await page.locator(`${section} .wbo-group-body`).count(), 0, 'clearing search restores the saved collapse');
            assert.equal(await page.locator(`${section} .wbo-group-drag-handle, ${section} [data-action^="move-section-"]`).count(), 0);
            await activate(toggle);
            assert.equal(await page.locator(`${section} .wbo-book-item`).count(), 1);
        });
    });
}
