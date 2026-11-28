import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const suite = process.env.WBO_E2E_SUITE;
if (!suite) throw new Error('Set WBO_E2E_SUITE to the retained browser regression suite');
const load = (name) => import(pathToFileURL(resolve(suite, 'lib', name)).href);
const { createMockStServer } = await load('mock-server.mjs');
const { VIEWPORTS, launchEdgeCdp } = await load('cdp.mjs');
const { createDefaultSeed } = await load('fixtures.mjs');
const { resetAndBoot, waitForCondition } = await load('assert-helpers.mjs');
const enhancement = JSON.parse(readFileSync(resolve('..', '参考仓库', '下拉框美化.json'), 'utf8')).content;
const storageKey = enhancement.match(/const STORAGE_KEY = '([^']+)'/)?.[1];
assert.ok(storageKey);
const root = '#gr-global-dropdown-container';
const favorite = `${root} [data-pin-world="测试书乙"]`;
const bookRow = `${root} .gr-option:has([data-pin-world="测试书乙"])`;
const scriptPin = `${bookRow} .gr-option-pin`;
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

async function withScript(viewport, run, extras = {}) {
    const server = createMockStServer();
    const baseUrl = await server.start();
    let cdp;
    try {
        cdp = await launchEdgeCdp();
        await resetAndBoot(cdp, baseUrl, { viewport, seed: createDefaultSeed({
            characters: [], selected_world_info: ['测试书甲'],
            worldbooks: { '测试书甲': { entries: {} }, '测试书乙': { entries: {} } },
            pluginSettings: {
                autoScanNewCharacters: false, pinnedBooks: [], globalHiddenGroupIds: [],
                groups: [{ id: 'test-a', name: '测试分组甲' }, { id: 'test-b', name: '测试分组乙' }],
                assignments: { '测试书甲': 'test-a', '测试书乙': 'test-b' },
            },
            ...extras,
        }) });
        await cdp.evalFn((key, code) => {
            // Preserve the native wrapper that enables the reference script's own pin.
            const host = document.getElementById('WIMultiSelector');
            const wrapper = document.createElement('div');
            wrapper.className = 'range-block-range';
            while (host.firstChild) wrapper.append(host.firstChild);
            host.append(wrapper);
            // The mock's flat picker has overflow:auto on its shell. The real
            // script scrolls .gr-options and leaves that absolute shell unclipped.
            const layout = document.createElement('style');
            layout.textContent = '#gr-global-dropdown-container { overflow: visible; max-height: none; }';
            document.head.append(layout);
            if (!jQuery('#world_info').data('select2')) jQuery('#world_info').select2({ width: '100%', closeOnSelect: false });
            localStorage.setItem(key, JSON.stringify({ settings: {}, pinned: {}, meta: { welcomePopupShown: true } }));
            (0, eval)(code);
        }, storageKey, enhancement);
        await waitForCondition(cdp, () => document.querySelector('#WIMultiSelector .gr-select2-display'));
        await cdp.clickSelector('#WIMultiSelector .gr-select2-display');
        await waitForCondition(cdp, () => document.querySelector('#gr-global-dropdown-container[data-wbo-popover-ready="1"] .wbo-gr-pin-btn'));
        await run(cdp);
        assert.deepEqual(cdp.getErrors().runtimeErrors, []);
    } finally {
        await cdp?.close();
        await server.stop();
    }
}

async function activate(cdp, selector, viewport, move = 0) {
    await waitForCondition(cdp, () => !document.getAnimations().some((animation) =>
        animation.playState === 'running' && animation.effect?.target?.closest?.('#gr-global-dropdown-container')));
    await cdp.evalFn((sel) => {
        const el = document.querySelector(sel);
        if (!el) throw new Error(`Missing action target: ${sel}`);
        const pills = el.closest('.wbo-dd-pill-scroll');
        if (pills) {
            const r = el.getBoundingClientRect(), h = pills.getBoundingClientRect();
            if (r.right > h.right) pills.scrollLeft += r.right - h.right + 4;
            else if (r.left < h.left) pills.scrollLeft += r.left - h.left - 4;
        }
        const host = el.closest('.gr-options');
        const r = el.getBoundingClientRect();
        const h = host.getBoundingClientRect();
        if (r.bottom > h.bottom) host.scrollTop += r.bottom - h.bottom + 4;
        else if (r.top < h.top) host.scrollTop += r.top - h.top - 4;
    }, selector);
    const point = await cdp.evalFn((sel) => {
        const el = document.querySelector(sel);
        const r = el.getBoundingClientRect();
        const x = r.x + r.width / 2;
        const y = r.y + r.height / 2;
        const top = document.elementFromPoint(x, y);
        const chain = [];
        for (let p = el; p && p !== document.body; p = p.parentElement) {
            const cs = getComputedStyle(p), box = p.getBoundingClientRect();
            chain.push({ tag: p.tagName, cls: p.className, x: box.x, y: box.y, w: box.width, h: box.height,
                display: cs.display, visibility: cs.visibility, pointer: cs.pointerEvents, overflow: cs.overflowY,
                scroll: p.scrollTop, height: p.scrollHeight, maxHeight: cs.maxHeight });
        }
        return { x, y, hit: top === el || el.contains(top), top: top?.outerHTML.slice(0, 180), chain };
    }, selector);
    assert.equal(point.hit, true, `${selector}: ${JSON.stringify(point)}`);
    if (viewport.mobile) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: point.x, y: point.y }] });
        if (move) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x, y: point.y + move }] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
        const hit = await cdp.clickSelector(selector, { scroll: false });
        assert.equal(hit.hit, true);
    }
    // The unmodified script defers selection by 50ms on touchend.
    await pause(100);
}

async function state(cdp) {
    return cdp.evalFn((key) => ({
        favorites: [...SillyTavern.getContext().extensionSettings.worldbook_organizer.pinnedBooks],
        globals: [...document.getElementById('world_info').selectedOptions].map((option) => option.textContent),
        pins: JSON.parse(localStorage.getItem(key)).pinned,
        favoritePill: document.querySelector('#gr-global-dropdown-container [data-wbo-pill="__pinned__"]')?.textContent ?? '',
        open: Boolean(document.querySelector('#gr-global-dropdown-container')),
    }), storageKey);
}

for (const viewport of [VIEWPORTS.mobile, VIEWPORTS.desktop]) {
    test(`${viewport.name}: script search requires explicit focus and keeps keyboard navigation`, async () => {
        await withScript(viewport, async (cdp) => {
            assert.equal(await cdp.evalFn(() => document.activeElement?.matches('input,textarea')), false);
            const search = `${root} .gr-search-input`;
            await cdp.clickSelector(search);
            assert.equal(await cdp.evalFn(() => document.activeElement?.matches('#gr-global-dropdown-container .gr-search-input')), true);
            await cdp.evalFn(() => {
                const search = document.querySelector('#gr-global-dropdown-container .gr-search-input');
                search.blur();
                const before = document.createElement('button');
                before.id = 'before-script-search'; before.textContent = 'Search next';
                search.before(before); before.focus();
            });
            await cdp.pressKey('Tab', 'Tab', 9);
            assert.equal(await cdp.evalFn(() => document.activeElement?.matches('#gr-global-dropdown-container .gr-search-input')), true,
                'Tab must enter search without requiring a pointer');
            await cdp.screenshot(`pin-favorite-headings-${viewport.name}`);
        }, { worldbooks: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`测试书${i}`, { entries: {} }])) });
    });

    test(`${viewport.name}: regression all retains favorites and the current pill after favorite and host rebuild`, async () => {
        await withScript(viewport, async (cdp) => {
            await activate(cdp, `${root} [data-wbo-pill="__all__"]`, viewport);
            await activate(cdp, favorite, viewport);
            assert.equal(await cdp.evalFn(() => document.querySelector('#gr-global-dropdown-container .wbo-dd-pill.is-active')?.dataset.wboPill), '__all__');
            const visibleFavorite = () => cdp.evalFn(() => {
                const section = document.querySelector('#gr-global-dropdown-container .wbo-pop-section[data-wbo-dd-group="__pinned__"]');
                return Boolean(section?.getBoundingClientRect().height && section.querySelector('[data-pin-world="测试书乙"]')?.getBoundingClientRect().height);
            });
            assert.equal(await visibleFavorite(), true, 'All must show the favorite instead of hiding its only home');
            await cdp.screenshot(`pin-favorite-all-${viewport.name}`);
            await activate(cdp, `${root} [data-wbo-pill="test-b"]`, viewport);
            assert.equal(await cdp.evalFn(() => document.querySelector('#gr-global-dropdown-container [data-pin-world="测试书乙"]')?.getBoundingClientRect().height > 0), true,
                'moving favorites back to their group must clear stale hidden flags');
            await activate(cdp, `${root} [data-wbo-pill="__all__"]`, viewport);
            await activate(cdp, `${scriptPin} svg`, viewport);
            await waitForCondition(cdp, () => document.querySelector('#gr-global-dropdown-container .gr-option-pin.pinned'));
            assert.equal(await cdp.evalFn(() => document.querySelector('#gr-global-dropdown-container .wbo-dd-pill.is-active')?.dataset.wboPill), '__all__');
            assert.equal(await cdp.evalFn(() => document.querySelector('#gr-global-dropdown-container [data-pin-world="测试书乙"]').closest('.gr-option').parentElement.classList.contains('gr-options-container')), true,
                'host pin wins over favorite placement');
            await activate(cdp, `${root} [data-wbo-pill="__pinned__"]`, viewport);
            assert.equal(await cdp.evalFn(() => document.querySelector('#gr-global-dropdown-container [data-pin-world="测试书乙"]').getBoundingClientRect().height > 0), true);
            await activate(cdp, `${root} [data-wbo-pill="__all__"]`, viewport);
            await cdp.clickSelector('#host-outside-blank');
            await waitForCondition(cdp, () => !document.querySelector('#gr-global-dropdown-container'));
            await cdp.clickSelector('#WI-SP-button .drawer-icon');
            if (viewport.mobile) {
                const point = await cdp.evalFn(() => {
                    const r = document.querySelector('#WIMultiSelector .gr-select2-display').getBoundingClientRect();
                    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
                });
                // Continue the same touch gesture path used by the favorite and pin actions.
                // Switching to mouse here falls into the script's synthetic-mouse suppression.
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            } else await cdp.clickSelector('#WIMultiSelector .gr-select2-display');
            await waitForCondition(cdp, () => document.querySelector('#gr-global-dropdown-container[data-wbo-popover-ready="1"] .wbo-dd-pill.is-active'));
            assert.equal(await cdp.evalFn(() => document.querySelector('#gr-global-dropdown-container .wbo-dd-pill.is-active')?.dataset.wboPill), '__all__');
        });
    });

    test(`${viewport.name}: regression mounted host pin survives replacement without row flags and unpins cleanly`, async () => {
        await withScript(viewport, async (cdp) => {
            await activate(cdp, `${root} [data-wbo-pill="__all__"]`, viewport);
            await activate(cdp, `${root} .gr-option:has([data-pin-world="测试书甲"]) .gr-option-pin svg`, viewport);
            await waitForCondition(cdp, () => document.querySelector('#gr-global-dropdown-container .gr-option-pin.pinned'));
            await cdp.evalFn(() => {
                const pop = document.querySelector('#gr-global-dropdown-container');
                const old = pop.querySelector('[data-pin-world="测试书甲"]').closest('.gr-option');
                window.__wboOldPinnedRow = old;
                const row = document.createElement('div');
                row.className = 'gr-option has-pin';
                row.dataset.value = old.dataset.value;
                row.textContent = '测试书甲';
                row.insertAdjacentHTML('beforeend', '<span class="gr-option-pin"></span>');
                old.replaceWith(row);
            });
            await waitForCondition(cdp, () => document.querySelector('#gr-global-dropdown-container [data-pin-world="测试书甲"]'));
            assert.equal(await cdp.evalFn(() => {
                const row = document.querySelector('#gr-global-dropdown-container [data-pin-world="测试书甲"]').closest('.gr-option');
                return row !== window.__wboOldPinnedRow && row.parentElement.classList.contains('gr-options-container');
            }), true, 'storage identity must survive a fresh row with no pin class or WBO dataset');
            await cdp.evalFn((key) => {
                const data = JSON.parse(localStorage.getItem(key));
                data.pinned.world_info = [];
                localStorage.setItem(key, JSON.stringify(data));
                const pop = document.querySelector('#gr-global-dropdown-container');
                const row = pop.querySelector('[data-pin-world="测试书甲"]').closest('.gr-option');
                const fresh = document.createElement('div');
                fresh.className = 'gr-option'; fresh.dataset.value = row.dataset.value; fresh.textContent = '测试书甲';
                row.replaceWith(fresh);
            }, storageKey);
            await waitForCondition(cdp, () => document.querySelector('#gr-global-dropdown-container .wbo-pop-section[data-wbo-dd-group="__globals__"] [data-pin-world="测试书甲"]'));
            assert.equal(await cdp.evalFn(() => document.querySelector('#gr-global-dropdown-container .wbo-dd-pill.is-active')?.dataset.wboPill), '__all__');
        });
    });

    test(`${viewport.name}: real script favorite creates its filter without enabling a global book or pinning it`, async (t) => {
        await withScript(viewport, async (cdp) => {
            await activate(cdp, favorite, viewport);
            const result = await state(cdp);
            t.diagnostic(JSON.stringify(result));
            assert.deepEqual(result.globals, ['测试书甲'], 'star must never select the underlying global option');
            assert.deepEqual(result.favorites, ['测试书乙']);
            assert.deepEqual(result.pins, {}, 'star must not write the script pin store');
            assert.match(result.favoritePill, /已收藏.*1/);
            assert.equal(result.open, true);
            await waitForCondition(cdp, async () => {
                const saved = await fetch('/__test/state').then((response) => response.json());
                return saved.extension_settings.worldbook_organizer.pinnedBooks.includes('测试书乙');
            });
            await activate(cdp, `${root} [data-wbo-pill="__pinned__"]`, viewport);
            assert.deepEqual(await cdp.evalFn(() => [...document.querySelectorAll('#gr-global-dropdown-container .wbo-gr-pin-btn')]
                .filter((el) => el.getBoundingClientRect().height > 0).map((el) => el.dataset.pinWorld)), ['测试书甲', '测试书乙']);
            await activate(cdp, favorite, viewport);
            assert.deepEqual((await state(cdp)).favorites, [], 'second tap must cancel only once');
            assert.deepEqual((await state(cdp)).globals, ['测试书甲']);
        });
    });

    test(`${viewport.name}: favoriting an already enabled global book leaves it enabled`, async () => {
        await withScript(viewport, async (cdp) => {
            const selectedStar = `${root} [data-pin-world="测试书甲"]`;
            await activate(cdp, selectedStar, viewport);
            assert.deepEqual((await state(cdp)).favorites, ['测试书甲']);
            assert.deepEqual((await state(cdp)).globals, ['测试书甲']);
            await activate(cdp, selectedStar, viewport);
            assert.deepEqual((await state(cdp)).favorites, []);
            assert.deepEqual((await state(cdp)).globals, ['测试书甲']);
            assert.deepEqual((await state(cdp)).pins, {});
            assert.equal((await state(cdp)).open, true, 'canceling a favorite must leave the picker open');
        });
    });

    test(`${viewport.name}: real script pin and favorite remain separate through pin rebuild and row selection`, async (t) => {
        await withScript(viewport, async (cdp) => {
            await activate(cdp, `${scriptPin} svg`, viewport);
            await waitForCondition(cdp, () => document.querySelector('#gr-global-dropdown-container .gr-option-pin.pinned'));
            const pinned = await state(cdp);
            t.diagnostic(JSON.stringify(pinned));
            assert.deepEqual(pinned.favorites, []);
            assert.deepEqual(pinned.globals, ['测试书甲']);
            assert.equal(pinned.pins.world_info?.length, 1);
            assert.equal(pinned.favoritePill, '', 'a script pin must not create our favorites group');
            await waitForCondition(cdp, () => document.querySelector('#gr-global-dropdown-container .wbo-gr-pin-btn'));
            await activate(cdp, favorite, viewport);
            assert.deepEqual((await state(cdp)).favorites, ['测试书乙']);
            assert.deepEqual((await state(cdp)).pins, pinned.pins);
            assert.deepEqual((await state(cdp)).globals, ['测试书甲']);
            assert.match((await state(cdp)).favoritePill, /已收藏.*1/);
            await activate(cdp, `${root} [data-wbo-pill="__pinned__"]`, viewport);
            assert.deepEqual(await cdp.evalFn(() => [...document.querySelectorAll('#gr-global-dropdown-container .wbo-gr-pin-btn')]
                .filter((el) => el.getBoundingClientRect().height > 0).map((el) => el.dataset.pinWorld)), ['测试书乙', '测试书甲'],
            'a script-pinned book must still appear in our favorites filter');
            await activate(cdp, `${scriptPin} svg`, viewport);
            await waitForCondition(cdp, () => !document.querySelector('#gr-global-dropdown-container .gr-option-pin.pinned'));
            assert.deepEqual((await state(cdp)).favorites, ['测试书乙'], 'unpinning must not remove a favorite');
            await activate(cdp, favorite, viewport);
            assert.deepEqual((await state(cdp)).favorites, []);
            assert.deepEqual((await state(cdp)).globals, ['测试书甲']);
            if (viewport.mobile) {
                await activate(cdp, favorite, viewport, 45);
                assert.deepEqual((await state(cdp)).favorites, [], 'scrolling from a star is not a favorite action');
                assert.deepEqual((await state(cdp)).globals, ['测试书甲']);
            }
            await activate(cdp, bookRow, viewport);
            assert.deepEqual((await state(cdp)).globals.sort(), ['测试书乙', '测试书甲'].sort(), 'only tapping the row enables a global book');
        });
    });
}
