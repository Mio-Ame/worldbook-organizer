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
const { openManager, resetAndBoot } = await load('assert-helpers.mjs');

function seed(groupCount = 2, booksPerGroup = 24) {
    const groups = Array.from({ length: groupCount }, (_, i) => ({
        id: `g-${i}`, name: `滚动测试分组 ${i + 1}`, collapsed: false,
    }));
    const assignments = Object.fromEntries(groups.flatMap((group) =>
        Array.from({ length: booksPerGroup }, (_, i) => [`示例书 ${group.id}-${i}`, group.id])));
    return createDefaultSeed({
        characters: [], selected_world_info: [],
        worldbooks: Object.fromEntries(Object.keys(assignments).map((name) => [name, { entries: {} }])),
        pluginSettings: {
            showCharBooks: true, hideCharBooksByDefault: false, autoScanNewCharacters: false,
            activeFilterGroupId: '__all__', groups, assignments, pinnedBooks: [],
            globalHiddenGroupIds: [], editorHiddenGroupIds: [], groupPanelExpanded: false,
        },
    });
}

async function withHost(viewport, fixture, verify) {
    const server = createMockStServer();
    const baseUrl = await server.start();
    let cdp;
    try {
        cdp = await launchEdgeCdp();
        await resetAndBoot(cdp, baseUrl, { seed: fixture, viewport });
        await openManager(cdp);
        await verify(cdp);
        assert.deepEqual(cdp.getErrors().runtimeErrors, []);
    } finally {
        await cdp?.close();
        await server.stop();
    }
}

async function settle(cdp) {
    await cdp.evalFn(() => new Promise((resolve) => setTimeout(resolve, 180)));
}

async function smallWindow(cdp) {
    await cdp.clickSelector('[data-wbo-fullscreen-btn="manager"]', { scroll: false });
    const box = await cdp.evalFn(() => document.querySelector('.wbo-manager-modal .wbo-resize-se')
        .getBoundingClientRect().toJSON());
    const x = Math.round(box.left + box.width / 2);
    const y = Math.round(box.top + box.height / 2);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
    for (let step = 1; step <= 5; step++) {
        await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchMove', touchPoints: [{ x, y: y - 250 * step / 5, id: 1 }],
        });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await settle(cdp);
    assert.equal(await cdp.evalFn(() => document.querySelector('.wbo-manager-modal')
        .matches('.wbo-touch-window.is-resized')), true);
}

async function readCoordinates(cdp) {
    return cdp.evalFn(() => {
        const modal = document.querySelector('.wbo-manager-modal');
        const host = modal.matches('.wbo-touch-window.is-resized')
            ? modal.querySelector('.wbo-mgr-window-scroll') : modal.querySelector('#wbo-mgr-groups-list');
        const group = host.querySelector('.wbo-group[data-group-id="g-0"]');
        const header = group.querySelector('.wbo-group-header');
        const box = host.getBoundingClientRect();
        return {
            scroll: host.scrollTop, maxScroll: host.scrollHeight - host.clientHeight,
            headerTop: header.getBoundingClientRect().top,
            stickyInset: getComputedStyle(header).top, hostPadding: getComputedStyle(host).paddingTop,
            clipTop: modal.matches('.wbo-touch-window.is-resized')
                ? modal.querySelector('.wbo-modal-header-top').getBoundingClientRect().bottom : box.top + host.clientTop,
            rowTop: group.querySelector('.wbo-book-row').getBoundingClientRect().top,
            windowY: window.scrollY, overlayTop: modal.parentElement.getBoundingClientRect().top,
            modalTop: modal.getBoundingClientRect().top,
            closeTop: modal.querySelector('.wbo-modal-close').getBoundingClientRect().top,
            x: Math.round(box.left + box.width / 2), y: Math.round(box.bottom - 30),
        };
    });
}

for (const scenario of [
    { name: 'desktop', viewport: VIEWPORTS.desktop },
    { name: 'mobile maximized', viewport: VIEWPORTS.mobile },
    { name: 'mobile small window', viewport: VIEWPORTS.mobile, small: true },
]) {
    test(`${scenario.name}: group header enters sticky without clipping its top or jumping the scroll position`, async (t) => {
        await withHost(scenario.viewport, seed(), async (cdp) => {
            if (scenario.small) await smallWindow(cdp);
            // Give the background a real scroll offset: only the panel content may move.
            await cdp.evalFn(() => {
                document.documentElement.style.cssText += ';overflow:auto;height:auto';
                document.body.style.cssText += ';overflow:visible;height:2400px';
                window.scrollTo(0, 300);
            });
            await settle(cdp);
            const initial = await readCoordinates(cdp);
            assert.equal(initial.windowY, 300);
            const threshold = initial.headerTop - initial.clipTop;
            assert.ok(threshold >= 8, JSON.stringify(initial));
            await cdp.evalFn((top) => {
                const modal = document.querySelector('.wbo-manager-modal');
                const host = modal.matches('.wbo-touch-window.is-resized')
                    ? modal.querySelector('.wbo-mgr-window-scroll') : modal.querySelector('#wbo-mgr-groups-list');
                host.scrollTop = top;
            }, threshold - 4);
            await settle(cdp);
            const samples = [await readCoordinates(cdp)];
            for (const deltaY of [8, 16]) {
                const before = samples.at(-1);
                await cdp.send('Input.dispatchMouseEvent', {
                    type: 'mouseWheel', x: before.x, y: before.y, deltaX: 0, deltaY,
                });
                await settle(cdp);
                const after = await readCoordinates(cdp);
                samples.push(after);
                assert.ok(Math.abs(after.scroll - before.scroll - deltaY) <= 1, JSON.stringify(samples));
                assert.ok(Math.abs(after.rowTop - before.rowTop + deltaY) <= 1, JSON.stringify(samples));
                for (const key of ['windowY', 'overlayTop', 'modalTop', 'closeTop']) {
                    assert.ok(Math.abs(after[key] - initial[key]) <= 1, `${key}: ${JSON.stringify(samples)}`);
                }
            }
            t.diagnostic(JSON.stringify(samples));
            assert.ok(Math.abs(samples[0].headerTop - initial.clipTop - 4) <= 1);
            for (const sample of samples.slice(1)) {
                assert.ok(Math.abs(sample.headerTop - sample.clipTop) <= 1,
                    `sticky header must remain fully inside the content viewport: ${JSON.stringify(sample)}`);
            }
        });
    });
}

test('mobile small window: measuring expanded group pills near the bottom preserves the outer scroll', async (t) => {
    await withHost(VIEWPORTS.mobile, seed(18, 1), async (cdp) => {
        await smallWindow(cdp);
        await cdp.clickSelector('#wbo-mgr-pills-expand', { scroll: false });
        assert.equal(await cdp.evalFn(() => document.querySelector('#wbo-mgr-pills').classList.contains('is-expanded')), true);
        await cdp.evalFn(() => {
            const host = document.querySelector('.wbo-mgr-window-scroll');
            host.scrollTop = host.scrollHeight - host.clientHeight - 2;
        });
        await settle(cdp);
        const before = await readCoordinates(cdp);
        // Change the actual panel width, not just the viewport around an unchanged small window.
        // This invokes the production ResizeObserver without replacing its callback with a stub.
        const widths = await cdp.evalFn(() => {
            const modal = document.querySelector('.wbo-manager-modal');
            const width = modal.getBoundingClientRect().width;
            modal.style.width = `${width - 2}px`;
            return [width, modal.getBoundingClientRect().width];
        });
        assert.equal(widths[1], widths[0] - 2);
        await settle(cdp);
        const after = await readCoordinates(cdp);
        t.diagnostic(JSON.stringify({ before, after }));
        assert.ok(Math.abs(after.scroll - before.scroll) <= 1, 'temporary pill measurement must not clamp the outer scroll');
        assert.ok(Math.abs(after.rowTop - before.rowTop) <= 1, 'visible rows must stay in place');
    });
});
