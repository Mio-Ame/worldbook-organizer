import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import test, { after, before } from 'node:test';

const suite = process.env.WBO_E2E_SUITE;
if (!suite) throw new Error('Set WBO_E2E_SUITE to the retained browser regression suite');
const load = (name) => import(pathToFileURL(resolve(suite, 'lib', name)).href);
const { createMockStServer } = await load('mock-server.mjs');
const { createDefaultSeed, makeBook, makeEntry } = await load('fixtures.mjs');
const { chromium } = await import(process.env.WBO_PLAYWRIGHT_MODULE
    ? pathToFileURL(resolve(process.env.WBO_PLAYWRIGHT_MODULE)).href : 'playwright');
let browser;
before(async () => {
    browser = await chromium.launch({ channel: 'msedge', headless: true, timeout: 15000,
        args: ['--disable-extensions'] });
});
after(async () => { await browser?.close(); });

async function withPanel(viewport, run, { groupCount = 1 } = {}) {
    const names = Array.from({ length: 30 }, (_, i) => `窗口测试书 ${String(i).padStart(2, '0')}`);
    const server = createMockStServer(createDefaultSeed({
        characters: [], selected_world_info: [],
        worldbooks: Object.fromEntries(names.map((name) => [name, makeBook([makeEntry(0, { comment: '测试条目' })])])),
        pluginSettings: { autoScanNewCharacters: false, groupPanelExpanded: true,
            groups: Array.from({ length: groupCount }, (_, i) => ({
                id: i === 0 ? 'fixture-group' : `fixture-group-${i}`, name: `测试分组 ${i}`, collapsed: false,
            })),
            assignments: groupCount ? Object.fromEntries(names.map((name) => [name, 'fixture-group'])) : {} },
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
        await page.waitForSelector('#wbo-wand-entry', { state: 'attached' });
        await page.locator('#extensionsMenuButton').click();
        await page.locator('#wbo-wand-entry').click();
        await page.evaluate(() => { globalThis.__TAURI_RUNNING__ = true; });
        await run(page, context);
        assert.deepEqual(errors, []);
    } catch (error) {
        const books = await page.locator('.wbo-book-preview').evaluateAll((els) => els.filter((el) => !el.hidden)
            .map((el) => ({ book: el.closest('[data-book]').dataset.book, text: el.innerText.slice(0, 300) })));
        error.message += `\nPage errors: ${JSON.stringify(errors)}\nOpen books: ${JSON.stringify(books)}`;
        await page.screenshot({ path: resolve(tmpdir(), `wbo-floating-group-mobile-${viewport.width}.png`) });
        throw error;
    } finally {
        await context.close();
        await server.stop();
    }
}

const touchSessions = new WeakMap();
async function touchDrag(context, page, start, end) {
    let session = touchSessions.get(page);
    if (!session) {
        session = await context.newCDPSession(page);
        touchSessions.set(page, session);
    }
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...start, id: 1 }] });
    for (let i = 1; i <= 5; i++) {
        // Model a 200ms physical drag, not a near-instant CDP fling. The latter suppresses
        // the following tap's compatibility click even on a standalone page without WBO.
        await page.waitForTimeout(40);
        await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{
            x: start.x + (end.x - start.x) * i / 5,
            y: start.y + (end.y - start.y) * i / 5, id: 1,
        }] });
    }
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

for (const groupCount of [1, 4]) {
    test(`mobile-390: ${groupCount} groups initially fit a centered compact window and content changes do not resize it`, async (t) => {
        await withPanel({ width: 390, height: 844 }, async (page) => {
            const parent = page.locator('.wbo-manager-modal');
            const parentBox = await parent.boundingBox();
            await page.locator('#wbo-mgr-manage-groups-btn').click();
            const modal = page.locator('.wbo-gm-floating-panel');
            const box = await modal.boundingBox();
            t.diagnostic(`${groupCount} groups: ${JSON.stringify(box)}`);
            assert.ok(box.height <= (groupCount === 1 ? 300 : 450), `few groups should not leave a tall empty panel: ${JSON.stringify(box)}`);
            assert.ok(Math.abs(box.x + box.width / 2 - 195) <= 2 && Math.abs(box.y + box.height / 2 - 422) <= 2,
                `initial window should be centered: ${JSON.stringify(box)}`);
            assert.equal(await modal.locator('[data-wbo-fullscreen-btn]').getAttribute('aria-label'), '最大化');
            assert.equal(await modal.getAttribute('data-tt-mobile-surface'), 'free-window');
            assert.equal(await page.evaluate(() => localStorage.getItem('wbo-window-size:group-manager')), null,
                'content sizing must not write a manual size preference');
            await modal.locator('#wbo-gm-new-btn').tap();
            await page.locator('#wbo-group-name-input').fill('新增窗口测试分组');
            await page.locator('#wbo-save-group-btn').tap();
            await modal.locator('.wbo-gm-row').filter({ hasText: '新增窗口测试分组' }).waitFor();
            assert.deepEqual(await modal.boundingBox(), box, 'adding a group must not refit or recenter the open window');
            page.once('dialog', async (dialog) => {
                assert.match(dialog.message(), /世界书本体不会被删除/);
                await dialog.accept();
            });
            await modal.locator('.wbo-gm-row').filter({ hasText: '新增窗口测试分组' })
                .locator('[data-gm-action="delete"]').tap();
            await page.waitForFunction((count) => document.querySelectorAll('.wbo-gm-row').length === count, groupCount);
            assert.deepEqual(await modal.boundingBox(), box, 'deleting a group must not shrink the open window');
            const bookName = await page.evaluate(() => {
                const panel = document.querySelector('.wbo-gm-floating-panel').getBoundingClientRect();
                return [...document.querySelectorAll('#wbo-manager-overlay .wbo-book-main')].find((el) => {
                    const r = el.getBoundingClientRect();
                    return r.top > panel.bottom + 5 && r.bottom < innerHeight
                        && el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
                })?.closest('[data-book]').dataset.book;
            });
            assert.ok(bookName, 'an underlying book must be reachable immediately, without first restoring the window');
            await page.locator('#wbo-manager-overlay .wbo-book-main').filter({ hasText: bookName }).tap();
            await page.locator('.wbo-book-preview:not([hidden]) [data-acc-toggle]').waitFor();
            assert.deepEqual(await modal.boundingBox(), box, 'expanding an underlying book does not refit the group window');
            assert.deepEqual(await parent.boundingBox(), parentBox, 'the main panel must remain unchanged');
            await page.screenshot({ path: resolve(tmpdir(), `wbo-gm-content-${groupCount}-mobile-390.png`) });
        }, { groupCount });
    });
}

for (const viewport of [{ width: 390, height: 844 }, { width: 380, height: 760 }]) {
    test(`mobile-${viewport.width}: many groups use at most 75% height and only the middle list scrolls`, async (t) => {
        await withPanel(viewport, async (page) => {
            await page.locator('#wbo-mgr-manage-groups-btn').click();
            const modal = page.locator('.wbo-gm-floating-panel');
            const box = await modal.boundingBox();
            t.diagnostic(`30 groups: ${JSON.stringify(box)}`);
            assert.ok(box.height <= viewport.height * 0.75 + 2 && box.height >= viewport.height * 0.7,
                `long list should be capped around 75% of the viewport: ${JSON.stringify(box)}`);
            assert.ok(Math.abs(box.y + box.height / 2 - viewport.height / 2) <= 2, 'long panels start centered too');
            const top = await modal.locator('.wbo-pinned-top').boundingBox();
            const footer = await modal.locator('.wbo-pinned-footer').boundingBox();
            const scroll = modal.locator('.wbo-step-scroll');
            assert.ok(await scroll.evaluate((el) => el.scrollHeight > el.clientHeight + 100), 'the middle must own list overflow');
            await modal.locator('.wbo-gm-row').last().scrollIntoViewIfNeeded();
            assert.ok(await scroll.evaluate((el) => el.scrollTop > 100), 'the last group must be reachable in the middle scroller');
            assert.ok(await modal.locator('.wbo-gm-list').evaluate((el) => el.scrollTop === 0), 'avoid a second nested list scroller');
            assert.deepEqual(await modal.locator('.wbo-pinned-top').boundingBox(), top, 'toolbar stays fixed');
            assert.deepEqual(await modal.locator('.wbo-pinned-footer').boundingBox(), footer, 'footer stays fixed');
            assert.deepEqual(await modal.boundingBox(), box, 'scrolling does not move or resize the panel');
            await page.screenshot({ path: resolve(tmpdir(), `wbo-gm-content-many-mobile-${viewport.width}.png`) });
        }, { groupCount: 30 });
    });
}

test('mobile-390: saved manual size takes priority over content sizing and survives resizing, reopening and reload', async () => {
    await withPanel({ width: 390, height: 844 }, async (page, context) => {
        await page.evaluate(() => localStorage.setItem('wbo-window-size:group-manager', JSON.stringify({ width: 330, height: 700 })));
        await page.locator('#wbo-mgr-manage-groups-btn').click();
        const modal = page.locator('.wbo-gm-floating-panel');
        const saved = await modal.boundingBox();
        assert.equal(Math.round(saved.height), 700, 'saved manual size can exceed the initial content cap');
        assert.equal(Math.round(saved.width), 330);
        const grip = await modal.locator('.wbo-resize-se').boundingBox();
        await touchDrag(context, page, { x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 },
            { x: grip.x + grip.width / 2 - 10, y: grip.y + grip.height / 2 - 100 });
        const resized = await modal.boundingBox();
        assert.ok(resized.height < saved.height - 80);
        const restore = modal.locator('[data-wbo-fullscreen-btn]');
        await restore.tap();
        assert.equal(Math.round((await modal.boundingBox()).height), 844, 'maximize stays available');
        await restore.tap();
        assert.deepEqual(await modal.boundingBox(), resized);
        await modal.locator('.wbo-modal-close').tap();
        await page.locator('#wbo-mgr-manage-groups-btn').click();
        assert.deepEqual(await modal.boundingBox(), resized, 'reopening preserves the manual box');
        await page.reload();
        await page.locator('#extensionsMenuButton').click();
        await page.locator('#wbo-wand-entry').click();
        await page.locator('#wbo-mgr-manage-groups-btn').click();
        const reloaded = await modal.boundingBox();
        assert.equal(reloaded.width, resized.width);
        assert.equal(reloaded.height, resized.height, 'persistent dimensions win after reload');
    });
});

for (const viewport of [{ width: 390, height: 844 }, { width: 380, height: 760 }]) {
    test(`mobile-${viewport.width}: group management restores, moves and resizes while the underlying book stays usable`, async () => {
        await withPanel(viewport, async (page, context) => {
            const parent = page.locator('.wbo-manager-modal');
            const beforeBox = await parent.boundingBox();
            await page.locator('#wbo-mgr-manage-groups-btn').click();
            const modal = page.locator('.wbo-gm-floating-panel');
            assert.equal(await modal.locator('.wbo-gm-help').textContent(), '解除分组不会删除世界书，相关世界书将回到「未分组」。');
            const restore = modal.locator('[data-wbo-fullscreen-btn]');
            assert.equal(await restore.count(), 1, 'the promised floating group panel needs a mobile restore control');
            assert.equal(await restore.getAttribute('aria-label'), '最大化');
            const smallBox = await modal.boundingBox();
            assert.ok(smallBox.height < viewport.height - 80 && smallBox.width < viewport.width - 16, JSON.stringify(smallBox));
            assert.equal(await modal.locator('.wbo-gm-help').isVisible(), false, 'narrow windows hide the safety tip');
            assert.equal(await modal.getAttribute('data-tt-mobile-surface'), 'free-window');
            const header = await modal.locator('.wbo-modal-title').boundingBox();
            await touchDrag(context, page, { x: header.x + 15, y: header.y + header.height / 2 },
                { x: header.x + 15, y: 12 });
            const movedBox = await modal.boundingBox();
            assert.ok(movedBox.y < smallBox.y - 20, JSON.stringify({ smallBox, movedBox }));
            const grip = await modal.locator('.wbo-resize-se').boundingBox();
            await touchDrag(context, page, { x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 },
                { x: grip.x + grip.width / 2 - 15, y: grip.y + grip.height / 2 - 260 });
            const resizedBox = await modal.boundingBox();
            assert.ok(resizedBox.height < movedBox.height - 100, JSON.stringify({ movedBox, resizedBox }));
            assert.ok(Math.abs(resizedBox.y - movedBox.y) < 2, 'resizing must keep the top edge in place');
            const target = await page.evaluate(() => {
                const panel = document.querySelector('.wbo-gm-floating-panel').getBoundingClientRect();
                for (const main of document.querySelectorAll('#wbo-manager-overlay .wbo-book-main')) {
                    const r = main.getBoundingClientRect();
                    const x = r.left + r.width / 2;
                    const y = r.top + r.height / 2;
                    if (y <= panel.bottom + 10 || y >= innerHeight - 10 || r.height <= 0) continue;
                    if (main.contains(document.elementFromPoint(x, y))) {
                        return { x, y, book: main.closest('[data-book]').dataset.book };
                    }
                }
                return null;
            });
            assert.ok(target, 'the exposed underlying book list must receive pointer hits');
            await page.locator('#wbo-manager-overlay .wbo-book-main').filter({ hasText: target.book }).tap();
            const book = page.locator('#wbo-manager-overlay .wbo-book-item').filter({ has: page.locator('.wbo-book-main') })
                .filter({ hasText: target.book });
            await book.locator('.wbo-book-preview:not([hidden]) [data-acc-toggle]').waitFor();
            assert.deepEqual(await parent.boundingBox(), beforeBox, 'using the book must not move the parent window');
            await page.screenshot({ path: resolve(tmpdir(), `wbo-floating-group-mobile-${viewport.width}.png`) });
            await restore.click();
            assert.equal(await restore.getAttribute('aria-label'), '还原窗口');
            assert.equal(await modal.getAttribute('data-tt-mobile-surface'), 'fullscreen-window');
            const fullBox = await modal.boundingBox();
            assert.equal(Math.round(fullBox.height), viewport.height);
            await restore.click();
            const remembered = await modal.boundingBox();
            assert.ok(Math.abs(remembered.height - resizedBox.height) < 2, 'restore must remember the manually resized height');
            await page.setViewportSize({ width: viewport.width, height: 520 });
            await page.waitForFunction(() => {
                const r = document.querySelector('.wbo-gm-floating-panel').getBoundingClientRect();
                return r.top >= 0 && r.bottom <= innerHeight;
            });
            await modal.locator('.wbo-modal-close').click();
            assert.equal(await page.locator('.wbo-gm-floating-panel').count(), 0);
            assert.equal(await parent.count(), 1);
        }, { groupCount: 30 });
    });

    for (const [name, action] of [
        ['settings', '[data-action="open-settings-modal"]'],
        ['combos', '[data-action="open-combos-modal"]'],
    ]) {
        test(`mobile-${viewport.width}: floating ${name} exposes the same restore and maximize controls`, async () => {
            await withPanel(viewport, async (page) => {
                await page.locator(action).first().click();
                const modal = page.locator('#wbo-submodal-overlay > .wbo-modal');
                const restore = modal.locator('[data-wbo-fullscreen-btn]');
                assert.equal(await restore.count(), 1, `${name} needs the shared floating-window control`);
                await restore.click();
                assert.equal(await restore.getAttribute('aria-label'), '最大化');
                assert.equal(await modal.getAttribute('data-tt-mobile-surface'), 'free-window');
                const box = await modal.boundingBox();
                assert.ok(box.height < viewport.height - 80, JSON.stringify(box));
                await restore.click();
                assert.equal(await restore.getAttribute('aria-label'), '还原窗口');
                assert.equal(await modal.getAttribute('data-tt-mobile-surface'), 'fullscreen-window');
                await modal.locator('.wbo-modal-close').click();
                assert.equal(await page.locator('#wbo-submodal-overlay').count(), 0);
            });
        });
    }
}

test('desktop: floating windows keep the existing side-panel geometry and hide mobile-only controls', async () => {
    await withPanel({ width: 1280, height: 860 }, async (page) => {
        await page.locator('#wbo-mgr-manage-groups-btn').click();
        const modal = page.locator('.wbo-gm-floating-panel');
        const box = await modal.boundingBox();
        assert.ok(box.width <= 400 && box.height < 860, JSON.stringify(box));
        assert.equal(await modal.locator('[data-wbo-fullscreen-btn]').evaluate((button) => getComputedStyle(button).display), 'none');
        assert.equal(await modal.locator('[data-wbo-fullscreen-btn]:visible').count(), 0);
        const help = modal.locator('.wbo-gm-help');
        assert.equal(await help.isVisible(), false, 'the initial narrow desktop panel hides the tip too');
        const edge = await modal.locator('.wbo-resize-w').boundingBox();
        await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
        await page.mouse.down();
        await page.mouse.move(edge.x - 220, edge.y + edge.height / 2, { steps: 5 });
        await page.mouse.up();
        assert.ok((await modal.boundingBox()).width > 440, 'resize to a genuinely wide window');
        assert.equal(await help.isVisible(), true, 'wide windows show the safety tip');
        assert.equal(await help.textContent(), '解除分组不会删除世界书，相关世界书将回到「未分组」。');
        await modal.locator('.wbo-modal-close').click();
        await page.locator('[data-action="open-settings-modal"]').first().click();
        assert.equal(await page.locator('#wbo-submodal-overlay [data-wbo-fullscreen-btn]:visible').count(), 0);
    });
});
