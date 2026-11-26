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
const { resetAndBoot, waitForCondition } = await load('assert-helpers.mjs');
const world = '导航测试书';
const settle = (cdp) => cdp.evalFn(() => new Promise((resolve) => setTimeout(resolve, 150)));

async function withPanel(viewport, verify, { count = 8, short = false } = {}) {
    const server = createMockStServer();
    const baseUrl = await server.start();
    let cdp;
    try {
        cdp = await launchEdgeCdp();
        const groups = Array.from({ length: count }, (_, i) => ({ id: `g${i}`,
            name: short ? `分组${i}` : `资料分类 ${i} · 世界设定`, collapsed: i === count - 1, mode: 'normal' }));
        const entries = Array.from({ length: count * 12 + 3 }, (_, uid) => makeEntry(uid, {
            comment: uid < count * 12 ? `分类${Math.floor(uid / 12)} 资料${uid}` : `【新增主题】资料${uid}`, displayIndex: uid,
        }));
        await resetAndBoot(cdp, baseUrl, { viewport, seed: createDefaultSeed({
            characters: [], selected_world_info: [], worldbooks: { [world]: makeBook(entries) },
            pluginSettings: { autoScanNewCharacters: false },
            extraPluginSettingsKey: { worldbook_entry_groups: { books: { [world]: {
                groups: [...groups, { id: 'empty', name: '空组', mode: 'normal' }],
                assignments: Object.fromEntries(entries.slice(0, count * 12).map((_, uid) => [uid, `g${Math.floor(uid / 12)}`])),
            } } } },
        }) });
        await cdp.evalFn(() => {
            window.__navObservers = new Set();
            const OriginalResizeObserver = window.ResizeObserver;
            window.ResizeObserver = class extends OriginalResizeObserver {
                observe(target, options) {
                    if (target.id === 'weg-group-navigation') window.__navObservers.add(this);
                    return super.observe(target, options);
                }
                disconnect() { window.__navObservers.delete(this); return super.disconnect(); }
            };
        });
        await cdp.evalFn((worldName) => window.dispatchEvent(new CustomEvent('weg:open-panel', { detail: { worldName } })), world);
        await waitForCondition(cdp, () => document.querySelector('#weg-body .weg-entry-row'));
        await verify(cdp);
        assert.deepEqual(cdp.getErrors().runtimeErrors, []);
    } finally {
        await cdp?.close();
        await server.stop();
    }
}

async function frame(cdp, id = 'g0') {
    return cdp.evalFn((id) => {
        const body = document.getElementById('weg-body');
        const header = body.querySelector(`[data-weg-group-header="${id}"]`);
        const nav = document.getElementById('weg-group-navigation');
        return { windowY: scrollY, overlay: document.getElementById('weg-modal-backdrop').getBoundingClientRect().top,
            close: document.getElementById('weg-btn-close').getBoundingClientRect().top,
            modal: document.querySelector('.weg-modal').getBoundingClientRect().top,
            body: body.getBoundingClientRect().toJSON(), scroll: body.scrollTop,
            header: header?.getBoundingClientRect().toJSON(),
            navHeight: nav.getBoundingClientRect().height,
            cards: [...body.querySelectorAll('[data-weg-group-card]')].map((el) => el.dataset.wegGroupCard),
        };
    }, id);
}

function stable(actual, expected) {
    for (const key of ['windowY', 'overlay', 'close', 'modal']) assert.ok(Math.abs(actual[key] - expected[key]) <= 1,
        `${key}: ${JSON.stringify({ actual, expected })}`);
}

async function search(cdp, value) {
    await cdp.evalFn((value) => {
        const input = document.getElementById('weg-search-input');
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
    await settle(cdp);
}

for (const scenario of [
    { name: 'desktop', viewport: VIEWPORTS.desktop },
    { name: 'mobile maximized', viewport: VIEWPORTS.mobile },
    { name: 'mobile small window', viewport: VIEWPORTS.mobile, small: true },
]) {
    test(`${scenario.name}: group capsules navigate without filtering, page movement or collapse notices`, async (t) => {
        await withPanel(scenario.viewport, async (cdp) => {
            if (scenario.small) {
                const box = await cdp.evalFn(() => document.querySelector('.weg-modal .wbo-resize-se').getBoundingClientRect().toJSON());
                const x = Math.round(box.left + box.width / 2), y = Math.round(box.top + box.height / 2);
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
                for (let step = 1; step <= 5; step++) {
                    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - 25 * step / 5, y: y - 200 * step / 5, id: 1 }] });
                }
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            }
            await cdp.evalFn(() => {
                document.documentElement.style.cssText += ';overflow:auto;height:auto';
                document.body.style.cssText += ';overflow:visible;height:2400px';
                window.scrollTo(0, 300);
                window.__navToasts = [];
                for (const level of ['info', 'warning', 'error', 'success']) {
                    const previous = window.toastr[level];
                    window.toastr[level] = (...args) => { window.__navToasts.push({ level, args }); return previous?.(...args); };
                }
            });
            await settle(cdp);
            assert.equal(await cdp.evalFn(() => document.querySelectorAll('[data-weg-group-nav]').length), 9,
                'all nonempty groups, including ungrouped, must have navigation buttons');
            assert.equal(await cdp.evalFn(() => window.__navObservers.size), 1, 'one navigation observer, not one per row');
            assert.equal(await cdp.evalFn(() => !!document.querySelector('[data-weg-group-nav="empty"]')), false);
            const initial = await frame(cdp);
            assert.equal(initial.windowY, 300);
            assert.ok(initial.navHeight <= 40, JSON.stringify(initial));
            assert.ok(initial.body.height >= 100, JSON.stringify(initial));
            assert.equal(await cdp.evalFn(() => !document.getElementById('weg-group-nav-expand').hidden), true);
            await cdp.clickSelector('#weg-group-nav-expand', { scroll: false });
            const expanded = await frame(cdp);
            assert.ok(expanded.navHeight <= 90, JSON.stringify(expanded));
            await cdp.evalFn(() => {
                const list = document.getElementById('weg-group-nav-list');
                const pill = list.querySelector('[data-weg-group-nav="g7"]');
                list.scrollTop += pill.getBoundingClientRect().top - list.getBoundingClientRect().top;
            });
            assert.equal((await cdp.clickSelector('[data-weg-group-nav="g7"]', { scroll: false })).hit, true);
            await settle(cdp);
            const target = await frame(cdp, 'g7');
            stable(target, initial);
            assert.ok(target.scroll > initial.scroll, JSON.stringify(target));
            assert.ok(target.header.top >= target.body.top && target.header.bottom <= target.body.bottom, JSON.stringify(target));
            assert.equal(await cdp.evalFn(() => document.querySelectorAll('[data-weg-group-card="g7"] .weg-entry-row').length), 12);
            assert.ok(target.cards.includes('g0') && target.cards.includes('g7'), 'navigation must not filter away other groups');
            assert.equal(await cdp.evalFn(() => document.getElementById('weg-group-nav-expand').getAttribute('aria-expanded')), 'false');
            assert.equal(await cdp.evalFn(() => document.querySelector('[data-weg-group-nav="g7"]').getAttribute('aria-current')), 'true');
            assert.ok(target.navHeight <= 40);
            // Collapse the last group at the bottom: browser clamping must not emit a routine toast.
            await cdp.evalFn(() => { const body = document.getElementById('weg-body'); body.scrollTop = body.scrollHeight; });
            await cdp.clickSelector('[data-weg-group-header="g7"] .weg-group-name', { scroll: false });
            await settle(cdp);
            for (const id of ['g0', '__ungrouped__']) {
                await cdp.evalFn((id) => document.querySelector(`[data-weg-group-nav="${id}"]`).click(), id);
                await settle(cdp);
                await cdp.clickSelector(`[data-weg-group-header="${id}"] .weg-group-name`, { scroll: false });
                await cdp.evalFn((id) => document.querySelector(`[data-weg-group-nav="${id}"]`).click(), id);
                await settle(cdp);
            }
            assert.deepEqual(await cdp.evalFn(() => window.__navToasts), [], 'normal navigation and group collapse must remain silent');
            stable(await frame(cdp), initial);
            await search(cdp, '分类3');
            assert.deepEqual(await cdp.evalFn(() => [...document.querySelectorAll('[data-weg-group-nav]')].map((el) => el.dataset.wegGroupNav)), ['g3']);
            assert.equal(await cdp.evalFn(() => document.getElementById('weg-group-navigation').hidden), true, 'one visible group needs no navigation row');
            await search(cdp, 'not-found');
            assert.equal(await cdp.evalFn(() => document.querySelectorAll('[data-weg-group-nav]').length), 0);
            await search(cdp, '');
            assert.equal(await cdp.evalFn(() => document.querySelectorAll('[data-weg-group-nav]').length), 9);
            t.diagnostic(JSON.stringify({ initial, expanded, target }));
            await cdp.clickSelector('#weg-btn-close', { scroll: false });
            assert.equal(await cdp.evalFn(() => document.getElementById('weg-modal-backdrop').hidden), true);
            assert.equal(await cdp.evalFn(() => window.__navObservers.size), 0, 'closing stops navigation observation');
        });
    });
}

test('few groups hide the expansion arrow; renaming, dissolving and automatic grouping refresh navigation', async () => {
    await withPanel(VIEWPORTS.mobile, async (cdp) => {
        assert.equal(await cdp.evalFn(() => document.querySelectorAll('[data-weg-group-nav]').length), 3);
        assert.equal(await cdp.evalFn(() => document.getElementById('weg-group-nav-expand')?.hidden), true);
        await cdp.clickSelector('[data-weg-group-menu="g0"]', { scroll: false });
        await cdp.evalFn(() => [...document.querySelectorAll('.weg-floating-menu button')].find((el) => el.textContent.includes('编辑名称')).click());
        await cdp.evalFn(() => { document.getElementById('weg-group-name-input').value = '新名称'; });
        await cdp.clickSelector('#weg-group-save-btn');
        assert.equal(await cdp.evalFn(() => document.querySelector('[data-weg-group-nav="g0"]').textContent.trim()), '新名称');
        await cdp.clickSelector('[data-weg-group-menu="g0"]', { scroll: false });
        await cdp.evalFn(() => [...document.querySelectorAll('.weg-floating-menu button')].find((el) => el.textContent.includes('解散分组')).click());
        assert.equal(await cdp.evalFn(() => !!document.querySelector('[data-weg-group-nav="g0"]')), false);
        await cdp.clickSelector('#weg-btn-auto-detect');
        await waitForCondition(cdp, () => document.getElementById('weg-detect-strategy'));
        const select = await cdp.evalFn(() => {
            const el = document.getElementById('weg-detect-strategy');
            const label = document.querySelector(`label[for="${el.id}"]`);
            const desc = document.getElementById(el.getAttribute('aria-describedby'));
            return { native: el instanceof HTMLSelectElement, label: label?.textContent.trim(), hint: desc?.textContent.trim(),
                appearance: getComputedStyle(el).appearance,
                fits: el.getBoundingClientRect().right <= el.closest('.weg-submodal-body').getBoundingClientRect().right };
        });
        assert.equal(select.native, true);
        assert.equal(select.label, '识别方案');
        assert.equal(select.hint, '点击切换');
        assert.notEqual(select.appearance, 'none', 'keep the native arrow rather than hiding both arrows');
        assert.equal(select.fits, true);
        await cdp.clickSelector('#weg-detect-apply-btn');
        await waitForCondition(cdp, () => !document.getElementById('weg-detect-apply-btn'));
        assert.equal(await cdp.evalFn(() => [...document.querySelectorAll('[data-weg-group-nav]')].some((el) => el.textContent.trim() === '新增主题')), true);
        await cdp.clickSelector('#weg-btn-new-group');
        await cdp.evalFn(() => { document.getElementById('weg-group-name-input').value = '空的新分组'; });
        await cdp.clickSelector('#weg-group-save-btn');
        assert.equal(await cdp.evalFn(() => [...document.querySelectorAll('[data-weg-group-nav]')].some((el) => el.textContent.includes('空的新分组'))), false,
            'a newly created empty group does not consume navigation space');
    }, { count: 2, short: true });
});

test('routine first, last and ungrouped collapse stays silent even when scroll restoration is clamped', async () => {
    await withPanel(VIEWPORTS.mobile, async (cdp) => {
        await cdp.evalFn(() => {
            window.__collapseToasts = [];
            for (const level of ['info', 'warning', 'error', 'success']) {
                window.toastr[level] = (...args) => window.__collapseToasts.push({ level, args });
            }
        });
        const sequence = ['__ungrouped__', 'g0', 'g1'];
        for (const id of sequence) {
            await cdp.evalFn((id) => {
                const body = document.getElementById('weg-body');
                const card = body.querySelector(`[data-weg-group-card="${id}"]`);
                body.scrollTop += card.getBoundingClientRect().top - body.getBoundingClientRect().top - 10;
            }, id);
            await cdp.clickSelector(`[data-weg-group-header="${id}"] .weg-group-name`, { scroll: false });
            await settle(cdp);
            if (id === 'g1') {
                await cdp.evalFn(() => { const body = document.getElementById('weg-body'); body.scrollTop = body.scrollHeight; });
                await cdp.clickSelector('[data-weg-group-header="g1"] .weg-group-name', { scroll: false });
            }
        }
        assert.deepEqual(await cdp.evalFn(() => window.__collapseToasts), []);
    }, { count: 2, short: true });
});

test('recognition strategy is a labeled native select with a visible switching hint', async () => {
    await withPanel(VIEWPORTS.mobile, async (cdp) => {
        await cdp.clickSelector('#weg-btn-auto-detect');
        await waitForCondition(cdp, () => document.getElementById('weg-detect-strategy'));
        const result = await cdp.evalFn(() => {
            const select = document.getElementById('weg-detect-strategy');
            return { label: document.querySelector(`label[for="${select.id}"]`)?.textContent.trim(),
                hint: document.getElementById(select.getAttribute('aria-describedby'))?.textContent.trim() };
        });
        assert.deepEqual(result, { label: '识别方案', hint: '点击切换' });
    }, { count: 2, short: true });
});

test('jumping to a far group keeps the render budget bounded instead of mounting every preceding entry', async () => {
    await withPanel(VIEWPORTS.mobile, async (cdp) => {
        assert.ok(await cdp.evalFn(() => document.querySelectorAll('#weg-body .weg-entry-row').length <= 60));
        await cdp.evalFn(() => document.querySelector('[data-weg-group-nav="g179"]').click());
        await settle(cdp);
        assert.equal(await cdp.evalFn(() => document.querySelectorAll('[data-weg-group-card="g179"] .weg-entry-row').length), 12);
        assert.ok(await cdp.evalFn(() => document.querySelectorAll('#weg-body .weg-entry-row').length <= 120),
            'a distant jump must not turn a 60-row initial render into a whole-book render');
        assert.equal(await cdp.evalFn(() => !!document.querySelector('[data-weg-group-card="g0"]')), true,
            'navigation is not a filter and must retain the initially rendered groups');
    }, { count: 180, short: true });
});
