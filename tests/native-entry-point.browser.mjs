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

async function withHost(viewport, verify) {
    const server = createMockStServer();
    const baseUrl = await server.start();
    let cdp;
    try {
        cdp = await launchEdgeCdp();
        await resetAndBoot(cdp, baseUrl, { viewport, seed: createDefaultSeed({
            characters: [], selected_world_info: [],
            worldbooks: { '入口测试书': makeBook([makeEntry(0)]) },
            pluginSettings: { autoScanNewCharacters: false },
            extraPluginSettingsKey: { worldbook_entry_groups: { nativeEntryChoiceSeen: true } },
        }) });
        await cdp.evalFn(async () => {
            const root = '/scripts/extensions/third-party/worldbook-organizer/src/entry-groups/';
            const lifecycle = await import(`${root}lifecycle.js`);
            lifecycle.stopEntryGrouping();
            const ctx = SillyTavern.getContext();
            const emit = ctx.eventSource.emit;
            const state = window.entryAudit = { blockedLoads: 0, reads: 0, rowScans: 0, observers: [] };
            // Editor rendering must not depend on the fixture's extra prompt-assembly event.
            ctx.eventSource.emit = function (event, ...args) {
                if (event === ctx.eventTypes.WORLDINFO_ENTRIES_LOADED) {
                    state.blockedLoads++;
                    return Promise.resolve();
                }
                return emit.call(this, event, ...args);
            };
            const list = document.getElementById('world_popup_entries_list');
            const pager = document.createElement('div');
            pager.id = 'world_info_pagination';
            pager.innerHTML = '<select style="height:28px;font-size:14px"><option>25</option></select>';
            list.before(pager);
            state.list = list;
            state.pager = pager;
            const NativeObserver = window.MutationObserver;
            window.MutationObserver = class extends NativeObserver {
                constructor(callback) {
                    super(callback);
                    this.entryOwned = /entry-groups\/(?:native-entry-point|lifecycle)\.js/.test(new Error().stack);
                    this.targets = [];
                    if (this.entryOwned) state.observers.push(this);
                }
                observe(target, options) {
                    if (this.entryOwned) this.targets.push({ target, options });
                    return super.observe(target, options);
                }
                disconnect() { this.targets = []; return super.disconnect(); }
            };
            const query = Element.prototype.querySelectorAll;
            Element.prototype.querySelectorAll = function (selector) {
                if (selector.includes('.world_entry') && /entry-groups\/(?:native-entry-point|lifecycle|native-view)\.js/.test(new Error().stack)) state.rowScans++;
                return query.call(this, selector);
            };
            const getById = Document.prototype.getElementById;
            Document.prototype.getElementById = function (id) {
                if (id === 'world_info_pagination' && new Error().stack.includes('/entry-groups/native-entry-point.js')) state.reads++;
                return getById.call(this, id);
            };
            await lifecycle.startEntryGrouping('entry-selection-test');
            await new Promise((resolve) => setTimeout(resolve, 100));
        });
        await verify(cdp);
        assert.deepEqual(cdp.getErrors().runtimeErrors, []);
    } finally {
        await cdp?.close();
        await server.stop();
    }
}

async function changeSelection(cdp, method, selected = true) {
    await cdp.evalFn(({ method, selected }) => {
        const select = document.getElementById('world_editor_select');
        select.value = selected ? [...select.options].find((option) => option.textContent === '入口测试书').value : '';
        if (method === 'jquery') window.jQuery(select).trigger('change');
        else select.dispatchEvent(new Event('change', { bubbles: true }));
    }, { method, selected });
    if (selected) await waitForCondition(cdp, () => window.entryAudit.blockedLoads > 0 && window.entryAudit.list.querySelector('.world_entry'));
    await cdp.evalFn(() => new Promise((resolve) => setTimeout(resolve, 120)));
}

async function setPreferences(cdp, patch) {
    await cdp.evalFn(async (patch) => {
        const { getSettings } = await import('/scripts/extensions/third-party/worldbook-organizer/src/entry-groups/host.js');
        Object.assign(getSettings(), patch);
        const ctx = SillyTavern.getContext();
        await ctx.eventSource.emit(ctx.eventTypes.EXTENSION_SETTINGS_LOADED);
        await new Promise((resolve) => setTimeout(resolve, 100));
    }, patch);
}

async function assertDormant(cdp) {
    assert.deepEqual(await cdp.evalFn(async () => {
        const { getNativeGroupingPreferences } = await import('/scripts/extensions/third-party/worldbook-organizer/src/entry-groups/host.js');
        const state = window.entryAudit;
        return {
            active: getNativeGroupingPreferences().active,
            imports: performance.getEntriesByType('resource').filter((entry) => entry.name.includes('/entry-groups/native-view.js')).length,
            rowScans: state.rowScans,
            broadObservers: state.observers.flatMap((observer) => observer.targets).filter(({ target, options }) => options.subtree || target === state.list || target.matches?.('.world_entry')).length,
            sameList: document.getElementById('world_popup_entries_list') === state.list,
            samePager: document.getElementById('world_info_pagination') === state.pager,
        };
    }), { active: false, imports: 0, rowScans: 0, broadObservers: 0, sameList: true, samePager: true });
}

for (const device of ['desktop', 'mobile']) {
    test(`${device} page size and grouping stay paired across pagination widths and rerenders`, async () => {
        await withHost(VIEWPORTS[device], async (cdp) => {
            await changeSelection(cdp, 'native');
            for (const width of [540, 360, 320, 540]) {
                await cdp.evalFn((width) => {
                    const pager = window.entryAudit.pager;
                    pager.style.cssText = `width:${width}px;max-width:100%;display:block`;
                    pager.innerHTML = '<div class="paginationjs" style="display:flex;flex-wrap:wrap;gap:8px"><div class="paginationjs-pages" style="flex:1 0 210px;height:28px">1　2　3　4　5</div><div class="paginationjs-size-changer" style="width:70px"><select style="height:28px;font-size:14px;width:60px"><option>25</option><option>50</option></select></div></div>';
                }, width);
                await waitForCondition(cdp, () => document.querySelectorAll('#weg-native-entry-controls').length === 1);
                const layout = await cdp.evalFn(() => {
                    const size = window.entryAudit.pager.querySelector('select').getBoundingClientRect();
                    const manager = document.getElementById('weg-native-group-manager').getBoundingClientRect();
                    const toggle = document.getElementById('weg-native-group-enabled').getBoundingClientRect();
                    return { sizeTop: size.top, top: manager.top, height: manager.height, sizeHeight: size.height,
                        toggleTop: toggle.top, right: toggle.right, viewport: innerWidth };
                });
                assert.ok(Math.abs(layout.sizeTop - layout.top) <= 1, `page size and grouping must share a row: ${JSON.stringify(layout)}`);
                assert.ok(Math.abs(layout.toggleTop - layout.top) <= 1);
                assert.ok(Math.abs(layout.height - layout.sizeHeight) <= 1);
                assert.ok(layout.right <= layout.viewport);
                await assertDormant(cdp);
            }
            const cleanup = await cdp.evalFn(async () => {
                const pager = window.entryAudit.pager;
                const parent = pager.querySelector('.paginationjs-size-changer');
                const select = parent.querySelector('select');
                const { stopEntryGrouping } = await import('/scripts/extensions/third-party/worldbook-organizer/src/entry-groups/lifecycle.js');
                stopEntryGrouping();
                return { sameSelect: select === parent.querySelector('select'), nativeClass: parent.className, width: parent.style.width,
                    entry: Boolean(document.getElementById('weg-native-entry-controls')) };
            });
            assert.deepEqual(cleanup, { sameSelect: true, nativeClass: 'paginationjs-size-changer', width: '70px', entry: false }, 'stop restores the borrowed page-size shell');
        });
    });

    for (const method of ['native', 'jquery']) {
        test(`${device} ${method} selection mounts dormant entry without editor-loaded event and cleans up on disable`, async () => {
            await withHost(VIEWPORTS[device], async (cdp) => {
                assert.equal(await cdp.evalFn(() => Boolean(document.getElementById('weg-native-entry-controls'))), false);
                await changeSelection(cdp, method);
                assert.equal(await cdp.evalFn(() => Boolean(document.getElementById('weg-native-group-manager'))), true,
                    'selection must mount the entry even when list/pager survive and the extra host event is blocked');
                await assertDormant(cdp);
                await cdp.clickSelector('#weg-native-group-manager');
                await waitForCondition(cdp, () => document.getElementById('weg-modal-backdrop')?.hidden === false);
                await assertDormant(cdp);
                await cdp.clickSelector('#weg-btn-close');
                await changeSelection(cdp, method, false);
                assert.equal(await cdp.evalFn(() => Boolean(document.getElementById('weg-native-entry-controls'))), false, 'empty selection removes the entry');
                await setPreferences(cdp, { showNativeEntryBtn: false });
                await changeSelection(cdp, method);
                await cdp.evalFn(() => window.entryAudit.pager.append(document.createElement('span')));
                await cdp.evalFn(() => new Promise((resolve) => setTimeout(resolve, 80)));
                assert.equal(await cdp.evalFn(() => Boolean(document.getElementById('weg-native-entry-controls'))), false, 'hidden entry stays hidden after selection and pagination rendering');
                await setPreferences(cdp, { showNativeEntryBtn: true, enableNativeGrouping: false });
                await waitForCondition(cdp, () => !document.getElementById('weg-native-entry-controls'));
                assert.equal(await cdp.evalFn(() => Boolean(document.getElementById('weg-native-group-manager'))), false, 'the old disabled preference remains off without a stranded entry');
                await assertDormant(cdp);
                const idleReads = await cdp.evalFn(async () => {
                    const drawer = document.getElementById('WorldInfo');
                    drawer.classList.remove('openDrawer');
                    drawer.classList.add('closedDrawer');
                    await new Promise((resolve) => setTimeout(resolve, 60));
                    window.entryAudit.reads = 0;
                    const notice = document.createElement('div');
                    notice.innerHTML = '<span>测试通知</span>';
                    document.body.append(notice);
                    await new Promise((resolve) => setTimeout(resolve, 60));
                    notice.remove();
                    await new Promise((resolve) => setTimeout(resolve, 60));
                    return window.entryAudit.reads;
                });
                assert.equal(idleReads, 0, 'unrelated body mutations do not recheck the closed editor');
                const cleanup = await cdp.evalFn(async () => {
                    const plugin = await import('/scripts/extensions/third-party/worldbook-organizer/index.js');
                    const select = document.getElementById('world_editor_select');
                    select.dispatchEvent(new Event('change', { bubbles: true }));
                    window.entryAudit.pager.append(document.createElement('span'));
                    await Promise.resolve();
                    plugin.onDisable();
                    window.entryAudit.reads = 0;
                    setTimeout(async () => {
                        select.dispatchEvent(new Event('change', { bubbles: true }));
                        window.jQuery(select).trigger('change');
                        window.entryAudit.pager.append(document.createElement('span'));
                        const ctx = SillyTavern.getContext();
                        await ctx.eventSource.emit(ctx.eventTypes.APP_READY);
                        await ctx.eventSource.emit(ctx.eventTypes.WORLDINFO_ENTRIES_LOADED, '入口测试书');
                    }, 20);
                    await new Promise((resolve) => setTimeout(resolve, 160));
                    return {
                        controls: Boolean(document.getElementById('weg-native-entry-controls')),
                        observers: window.entryAudit.observers.some((observer) => observer.targets.length),
                        reads: window.entryAudit.reads,
                    };
                });
                assert.deepEqual(cleanup, { controls: false, observers: false, reads: 0 }, 'disable cancels queued sync and ignores late selection/shell/host events');
            });
        });
    }
    test(`${device} pagination wrapper receives a delayed page-size shell without row enhancement`, async () => {
        await withHost(VIEWPORTS[device], async (cdp) => {
            await changeSelection(cdp, 'native');
            await cdp.evalFn(() => {
                const wrapper = document.createElement('div');
                wrapper.className = 'paginationjs';
                window.entryAudit.pager.replaceChildren(wrapper);
            });
            await cdp.evalFn(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            await cdp.evalFn(() => {
                const shell = document.createElement('div');
                shell.className = 'paginationjs-size-changer';
                shell.innerHTML = '<select style="height:32px;font-size:14px"><option>50</option></select>';
                window.entryAudit.pager.querySelector('.paginationjs').append(shell);
            });
            await waitForCondition(cdp, () => document.querySelector('.paginationjs-size-changer > #weg-native-entry-controls'), 1200);
            await assertDormant(cdp);
        });
    });
    test(`${device} existing pagination observes delayed internal page-size rendering without row enhancement`, async () => {
        await withHost(VIEWPORTS[device], async (cdp) => {
            await changeSelection(cdp, 'native');
            await cdp.evalFn(async () => {
                const ctx = SillyTavern.getContext();
                await ctx.eventSource.emit(ctx.eventTypes.APP_READY);
            });
            await waitForCondition(cdp, () => document.getElementById('weg-native-entry-controls'));
            const before = await cdp.evalFn(() => document.getElementById('weg-native-entry-controls').style.getPropertyValue('--weg-native-page-height'));
            await cdp.evalFn(() => {
                window.entryAudit.pager.replaceChildren();
                setTimeout(() => {
                    const size = document.createElement('select');
                    size.innerHTML = '<option>50</option>';
                    size.style.setProperty('height', '42px', 'important');
                    size.style.setProperty('font-size', '18px', 'important');
                    window.entryAudit.pager.append(size);
                }, 40);
            });
            await cdp.evalFn(() => new Promise((resolve) => setTimeout(resolve, 200)));
            const after = await cdp.evalFn(() => ({
                height: document.getElementById('weg-native-entry-controls').style.getPropertyValue('--weg-native-page-height'),
                font: document.getElementById('weg-native-entry-controls').style.getPropertyValue('--weg-native-page-font'),
                pagerHeight: `${window.entryAudit.pager.querySelector('select').getBoundingClientRect().height}px`,
            }));
            assert.notEqual(after.height, before, 'existing pager internal rendering must refresh the entry control size');
            assert.equal(after.height, after.pagerHeight);
            assert.equal(after.font, '18px');
            await assertDormant(cdp);
        });
    });
}
