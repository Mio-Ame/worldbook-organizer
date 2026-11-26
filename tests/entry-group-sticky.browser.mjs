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

const world = '分组吸顶测试书';
const groups = ['a', 'b', 'c'].map((id) => ({ id, name: `测试分组 ${id.toUpperCase()}`, mode: 'normal', collapsed: false }));
const fixture = () => createDefaultSeed({
    characters: [], selected_world_info: [],
    worldbooks: { [world]: makeBook(Array.from({ length: 45 }, (_, uid) => makeEntry(uid, {
        comment: `测试条目 ${uid}`, displayIndex: uid, disable: uid % 2 === 0,
    }))) },
    pluginSettings: { autoScanNewCharacters: false },
    extraPluginSettingsKey: { worldbook_entry_groups: { books: { [world]: {
        groups, assignments: Object.fromEntries(Array.from({ length: 45 }, (_, uid) => [uid, groups[Math.floor(uid / 15)].id])),
    } } } },
});

const settle = (cdp) => cdp.evalFn(() => new Promise((resolve) => setTimeout(resolve, 180)));

async function withPanel(viewport, verify) {
    const server = createMockStServer();
    const baseUrl = await server.start();
    let cdp;
    try {
        cdp = await launchEdgeCdp();
        await resetAndBoot(cdp, baseUrl, { viewport, seed: fixture() });
        await openManager(cdp);
        await cdp.clickSelector('.wbo-book-item .wbo-book-main');
        await cdp.clickSelector('[data-acc-extra="open-entry-groups"]');
        await waitForCondition(cdp, () => document.querySelectorAll('#weg-body .weg-entry-row').length === 45);
        await verify(cdp);
        assert.deepEqual(cdp.getErrors().runtimeErrors, []);
    } finally {
        await cdp?.close();
        await server.stop();
    }
}

async function shrinkByTouch(cdp) {
    const box = await cdp.evalFn(() => document.querySelector('.weg-modal .wbo-resize-se').getBoundingClientRect().toJSON());
    const x = Math.round(box.left + box.width / 2);
    const y = Math.round(box.top + box.height / 2);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
    for (let step = 1; step <= 5; step++) {
        await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchMove', touchPoints: [{ x: x - 25 * step / 5, y: y - 200 * step / 5, id: 1 }],
        });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await settle(cdp);
    assert.equal(await cdp.evalFn(() => document.querySelector('.weg-modal').matches('.wbo-touch-window.is-resized')), true);
}

async function metrics(cdp, groupId = 'a') {
    return cdp.evalFn((id) => {
        const host = document.getElementById('weg-body');
        const card = host.querySelector(`[data-weg-group-card="${id}"]`);
        const header = card.querySelector('.weg-group-header');
        const box = host.getBoundingClientRect();
        const rect = header.getBoundingClientRect();
        return {
            windowY: window.scrollY, overlayTop: document.getElementById('weg-modal-backdrop').getBoundingClientRect().top,
            closeTop: document.getElementById('weg-btn-close').getBoundingClientRect().top,
            modalTop: document.querySelector('.weg-modal').getBoundingClientRect().top,
            hostTop: box.top, stickyTop: box.top + host.clientTop + parseFloat(getComputedStyle(host).paddingTop),
            scroll: host.scrollTop, maxScroll: host.scrollHeight - host.clientHeight,
            headerTop: rect.top, headerBottom: rect.bottom, headerHeight: rect.height,
            cardTop: card.getBoundingClientRect().top, cardBottom: card.getBoundingClientRect().bottom,
            firstRowTop: card.querySelector('.weg-entry-row')?.getBoundingClientRect().top ?? null,
            bodyBottom: box.bottom, x: Math.round(box.left + box.width / 2), y: Math.round(box.bottom - 20),
        };
    }, groupId);
}

function assertShellStable(actual, expected) {
    for (const key of ['windowY', 'overlayTop', 'closeTop', 'modalTop', 'hostTop']) {
        assert.ok(Math.abs(actual[key] - expected[key]) <= 1, `${key}: ${JSON.stringify({ actual, expected })}`);
    }
}

async function setScroll(cdp, top) {
    await cdp.evalFn((value) => { document.getElementById('weg-body').scrollTop = value; }, top);
    await settle(cdp);
}

async function assertHit(cdp, selector) {
    const result = await cdp.evalFn((selector) => {
        const target = document.querySelector(selector);
        const rect = target.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return { hit: hit === target || target.contains(hit), rect: rect.toJSON() };
    }, selector);
    assert.equal(result.hit, true, `${selector}: ${JSON.stringify(result)}`);
}

for (const scenario of [
    { name: 'desktop', viewport: VIEWPORTS.desktop },
    { name: 'mobile maximized', viewport: VIEWPORTS.mobile },
    { name: 'mobile small window', viewport: VIEWPORTS.mobile, small: true },
]) {
    test(`${scenario.name}: entry group headings stick inside their own cards and stay usable without moving the page`, async (t) => {
        await withPanel(scenario.viewport, async (cdp) => {
            if (scenario.small) await shrinkByTouch(cdp);
            await cdp.evalFn(() => {
                document.documentElement.style.cssText += ';overflow:auto;height:auto';
                document.body.style.cssText += ';overflow:visible;height:2400px';
                window.scrollTo(0, 300);
            });
            await settle(cdp);
            const initial = await metrics(cdp);
            assert.equal(initial.windowY, 300);
            const samples = [];
            // A sticky transition is driven by actual wheel input, with content prepositioned just before it.
            await setScroll(cdp, initial.headerTop - initial.stickyTop + 1);
            samples.push(await metrics(cdp));
            for (const deltaY of [8, 16, 40]) {
                const before = samples.at(-1);
                await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: before.x, y: before.y, deltaX: 0, deltaY });
                await settle(cdp);
                const after = await metrics(cdp);
                samples.push(after);
                assertShellStable(after, initial);
                assert.ok(Math.abs(after.scroll - before.scroll - deltaY) <= 1, JSON.stringify(samples));
                assert.ok(Math.abs(after.firstRowTop - before.firstRowTop + deltaY) <= 1, JSON.stringify(samples));
            }
            t.diagnostic(JSON.stringify({ phase: 'first-group', samples }));
            for (const sample of samples.slice(1)) {
                assert.ok(Math.abs(sample.headerTop - sample.stickyTop) <= 1,
                    `group title must remain visible at the scrollport top: ${JSON.stringify(sample)}`);
            }
            const header = '[data-weg-group-header="a"]';
            for (const selector of [`${header} .weg-group-name`, `${header} [data-weg-group-toggle]`, `${header} [data-weg-group-menu]`, `${header} [data-weg-pin-group]`]) {
                await assertHit(cdp, selector);
            }
            await cdp.clickSelector(`${header} [data-weg-group-menu]`, { scroll: false });
            await waitForCondition(cdp, () => document.querySelector('.weg-floating-menu'));
            await cdp.clickSelector(`${header} [data-weg-group-menu]`, { scroll: false });
            await waitForCondition(cdp, () => !document.querySelector('.weg-floating-menu'));
            // Switch and undo remain independently clickable while the group heading is stuck.
            await cdp.clickSelector(`${header} [data-weg-group-toggle]`, { scroll: false });
            await waitForCondition(cdp, () => document.querySelector('[data-weg-footer-action="undo"]:not([hidden]):not(:disabled)'));
            await assertHit(cdp, '[data-weg-footer-action="undo"]');
            await cdp.clickSelector('[data-weg-footer-action="undo"]', { scroll: false });
            await waitForCondition(cdp, () => document.querySelector('[data-weg-group-toggle="a"]').classList.contains('is-partial'));
            assertShellStable(await metrics(cdp), initial);
            await cdp.clickSelector(`${header} [data-weg-pin-group]`, { scroll: false });
            await waitForCondition(cdp, () => document.querySelector('[data-weg-pin-group="a"]').getAttribute('aria-pressed') === 'true');
            await cdp.clickSelector(`${header} [data-weg-pin-group]`, { scroll: false });
            await waitForCondition(cdp, () => document.querySelector('[data-weg-pin-group="a"]').getAttribute('aria-pressed') === 'false');
            const beforeCollapse = await metrics(cdp);
            await cdp.clickSelector(`${header} .weg-group-name`, { scroll: false });
            await waitForCondition(cdp, () => !document.querySelector('[data-weg-group-card="a"] .weg-entry-row'));
            const firstCollapsed = await metrics(cdp);
            assertShellStable(firstCollapsed, initial);
            assert.ok(Math.abs(firstCollapsed.headerTop - beforeCollapse.headerTop) <= 1,
                JSON.stringify({ beforeCollapse, firstCollapsed }));
            await cdp.clickSelector(`${header} .weg-group-name`, { scroll: false });
            await waitForCondition(cdp, () => document.querySelectorAll('[data-weg-group-card="a"] .weg-entry-row').length === 15);
            assert.ok(Math.abs((await metrics(cdp)).headerTop - firstCollapsed.headerTop) <= 1);

            // At the boundary, the outgoing heading cannot escape its card or cover the next heading.
            const second = await metrics(cdp, 'b');
            await setScroll(cdp, second.scroll + second.headerTop - second.stickyTop - 12);
            const outgoing = await metrics(cdp, 'a');
            const entering = await metrics(cdp, 'b');
            assert.ok(outgoing.headerBottom <= outgoing.cardBottom + 1, JSON.stringify(outgoing));
            assert.ok(outgoing.headerBottom <= entering.headerTop + 1, JSON.stringify({ outgoing, entering }));
            await setScroll(cdp, entering.scroll + 32);
            const handoff = await metrics(cdp, 'b');
            assert.ok(Math.abs(handoff.headerTop - handoff.stickyTop) <= 1, JSON.stringify(handoff));
            assertShellStable(handoff, initial);
            await assertHit(cdp, '[data-weg-group-header="b"] .weg-group-name');

            // The last card can be collapsed from its stuck heading without artificial blank space.
            const last = await metrics(cdp, 'c');
            await setScroll(cdp, last.scroll + last.headerTop - last.stickyTop + 50);
            const stuckLast = await metrics(cdp, 'c');
            assert.ok(Math.abs(stuckLast.headerTop - stuckLast.stickyTop) <= 1, JSON.stringify(stuckLast));
            await cdp.clickSelector('[data-weg-group-header="c"] .weg-group-name', { scroll: false });
            await waitForCondition(cdp, () => !document.querySelector('[data-weg-group-card="c"] .weg-entry-row'));
            const collapsed = await metrics(cdp, 'c');
            assertShellStable(collapsed, initial);
            assert.ok(collapsed.headerTop >= collapsed.hostTop && collapsed.headerBottom <= collapsed.bodyBottom + 1,
                JSON.stringify(collapsed));
            assert.ok(collapsed.bodyBottom - collapsed.cardBottom <= 18, 'do not insert a viewport of empty space below the last group');
            await assertHit(cdp, '[data-weg-group-header="c"] .weg-group-name');
            await cdp.clickSelector('[data-weg-group-header="c"] .weg-group-name', { scroll: false });
            await waitForCondition(cdp, () => document.querySelectorAll('[data-weg-group-card="c"] .weg-entry-row').length === 15);
            const reopened = await metrics(cdp, 'c');
            assertShellStable(reopened, initial);
            assert.ok(Math.abs(reopened.headerTop - collapsed.headerTop) <= 1, JSON.stringify({ collapsed, reopened }));
            t.diagnostic(JSON.stringify({ phase: 'handoff-collapse', outgoing, entering, handoff, stuckLast, collapsed, reopened }));
        });
    });
}
