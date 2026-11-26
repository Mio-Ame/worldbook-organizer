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
const { resetAndBoot, waitForCondition } = await load('assert-helpers.mjs');
const prefix = '/scripts/extensions/third-party/worldbook-organizer/';
const extrasSelector = '#mock-char-world-dialog .character_extra_world_info_selector';

async function withHost(verify) {
    const server = createMockStServer();
    const baseUrl = await server.start();
    let cdp;
    try {
        cdp = await launchEdgeCdp();
        await resetAndBoot(cdp, baseUrl, { viewport: VIEWPORTS.desktop, seed: createDefaultSeed({
            characters: [{ avatar: 'test-extras.png', name: '测试角色', data: { extensions: {} } }],
            characterId: 0, selected_world_info: [],
            worldbooks: { '测试书甲': { entries: {} }, '测试书乙': { entries: {} } },
            pluginSettings: {
                autoScanNewCharacters: false, showCharBooks: true, adaptCharBindPopup: true,
                groups: [{ id: 'test-a', name: '测试组甲' }, { id: 'test-b', name: '测试组乙' }],
                assignments: { '测试书甲': 'test-a', '测试书乙': 'test-b' },
                globalHiddenGroupIds: [], editorHiddenGroupIds: [], pinnedBooks: [],
            },
        }) });
        await verify(cdp);
        assert.deepEqual(cdp.getErrors().runtimeErrors, []);
    } finally {
        await cdp?.close();
        await server.stop();
    }
}

async function trackExtrasResources(cdp) {
    await cdp.evalFn((selector) => {
        const state = window.extrasAudit = { disabled: false, events: [], observers: [], inputs: [], late: { events: 0, observers: 0, inputs: 0 } };
        const originalJquery = window.jQuery;
        const specs = (value) => String(value || '').split(/\s+/).filter(Boolean);
        const matches = (filter, actual) => {
            const [type, ...ns] = filter.split('.');
            const [actualType, ...actualNs] = actual.split('.');
            return (!type || type === actualType) && ns.every((part) => actualNs.includes(part));
        };
        const trackedJquery = (...args) => {
            const jq = originalJquery(...args);
            if (!jq[0]?.matches?.(selector)) return jq;
            const on = jq.on;
            const off = jq.off;
            jq.on = function (names, listener, ...rest) {
                if (typeof listener !== 'function' || !specs(names).some((name) => name.split('.').includes('wboExtras'))) {
                    return on.call(this, names, listener, ...rest);
                }
                const wrapped = function (...eventArgs) {
                    if (state.disabled) state.late.events++;
                    return listener.apply(this, eventArgs);
                };
                state.events.push({ names: specs(names), listener, wrapped, active: true });
                return on.call(this, names, wrapped, ...rest);
            };
            jq.off = function (names, listener) {
                const filters = specs(names);
                for (const entry of state.events) {
                    if (!entry.active || (listener && listener !== entry.listener && listener !== entry.wrapped)) continue;
                    const removed = entry.names.filter((name) => !filters.length || filters.some((filter) => matches(filter, name)));
                    for (const name of removed) off.call(this, name, entry.wrapped);
                    entry.names = entry.names.filter((name) => !removed.includes(name));
                    entry.active = entry.names.length > 0;
                }
                return off.call(this, names, listener);
            };
            return jq;
        };
        Object.assign(trackedJquery, originalJquery);
        window.jQuery = trackedJquery;

        const NativeObserver = window.MutationObserver;
        window.MutationObserver = class extends NativeObserver {
            constructor(callback) {
                const entry = { active: false, calls: 0, disconnects: 0 };
                super((records, observer) => {
                    if (entry.active) {
                        entry.calls++;
                        if (state.disabled) state.late.observers++;
                    }
                    callback(records, observer);
                });
                this.auditEntry = entry;
            }
            observe(target, options) {
                const select = document.querySelector(selector);
                const dropdown = select && originalJquery(select).data('select2')?.$dropdown?.[0];
                if (target.matches?.('.select2-results__options') && dropdown?.contains(target)) {
                    this.auditEntry.active = true;
                    if (!state.observers.includes(this.auditEntry)) state.observers.push(this.auditEntry);
                }
                return super.observe(target, options);
            }
            disconnect() {
                this.auditEntry.active = false;
                this.auditEntry.disconnects++;
                return super.disconnect();
            }
        };

        const add = EventTarget.prototype.addEventListener;
        const remove = EventTarget.prototype.removeEventListener;
        const capture = (options) => typeof options === 'boolean' ? options : Boolean(options?.capture);
        EventTarget.prototype.addEventListener = function (type, listener, options) {
            if (type !== 'input' || this.id !== 'test-extras-inline-search' || typeof listener !== 'function') {
                return add.call(this, type, listener, options);
            }
            const entry = { target: this, listener, capture: capture(options), active: true, calls: 0 };
            entry.wrapped = function (...args) {
                entry.calls++;
                if (state.disabled) state.late.inputs++;
                return listener.apply(this, args);
            };
            state.inputs.push(entry);
            return add.call(this, type, entry.wrapped, options);
        };
        EventTarget.prototype.removeEventListener = function (type, listener, options) {
            for (const entry of state.inputs) {
                if (type === 'input' && entry.target === this && entry.listener === listener && entry.capture === capture(options)) {
                    entry.active = false;
                    remove.call(this, type, entry.wrapped, options);
                }
            }
            return remove.call(this, type, listener, options);
        };
    }, extrasSelector);
}

test('desktop extras stop events, result observers and inline search work after disable', async () => {
    await withHost(async (cdp) => {
        await trackExtrasResources(cdp);
        await cdp.evalFn(() => {
            const popup = window.__ST_TEST_HELPERS__.openCharacterWorldPopup(0);
            // The retained host omits the inline search field of a desktop multi-select.
            const input = document.createElement('input');
            input.id = 'test-extras-inline-search';
            input.className = 'select2-search__field';
            input.type = 'search';
            input.spellcheck = false;
            popup.querySelector('.character_extra_world_info_selector').parentElement.append(input);
        });
        await waitForCondition(cdp, () => window.extrasAudit.events.some((entry) => entry.active));
        await cdp.evalFn((selector) => { jQuery(selector).select2('open'); }, extrasSelector);
        await waitForCondition(cdp, () => Boolean(document.querySelector('.select2-dropdown .wbo-dd-filter-bar')));
        const before = await cdp.evalFn(async (selector) => {
            const select = document.querySelector(selector);
            const inst = jQuery(select).data('select2');
            window.extrasAudit.results = inst.$dropdown[0].querySelector('.select2-results__options');
            const input = document.getElementById('test-extras-inline-search');
            input.value = '测试';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            return {
                events: window.extrasAudit.events.filter((entry) => entry.active).length,
                observers: window.extrasAudit.observers.filter((entry) => entry.active).length,
                inputs: window.extrasAudit.inputs.reduce((count, entry) => count + entry.calls, 0),
            };
        }, extrasSelector);
        assert.ok(before.events >= 1 && before.observers >= 1 && before.inputs >= 1,
            `fixture must exercise all three resources: ${JSON.stringify(before)}`);

        const after = await cdp.evalFn(async (base, selector) => {
            const audit = window.extrasAudit;
            (await import(`${base}index.js`)).onDisable();
            audit.disabled = true;
            const select = document.querySelector(selector);
            const results = audit.results;
            const row = document.createElement('li');
            row.className = 'select2-results__option';
            row.textContent = '测试书甲';
            results.append(row);
            document.getElementById('test-extras-inline-search').dispatchEvent(new Event('input', { bubbles: true }));
            jQuery(select).select2('close').select2('open');
            await new Promise((resolve) => setTimeout(resolve, 150));
            return {
                handlers: audit.events.filter((entry) => entry.active).length,
                observers: audit.observers.filter((entry) => entry.active).length,
                inputs: audit.inputs.filter((entry) => entry.active).length,
                late: { ...audit.late },
                injectedPin: Boolean(row.querySelector('.wbo-s2-pin-btn')),
                revivedBar: Boolean(document.querySelector('.select2-dropdown .wbo-dd-filter-bar')),
                nativeStillOpen: Boolean(jQuery(select).data('select2')?.isOpen()),
            };
        }, prefix, extrasSelector);
        assert.deepEqual(after, {
            handlers: 0, observers: 0, inputs: 0, late: { events: 0, observers: 0, inputs: 0 },
            injectedPin: false, revivedBar: false, nativeStillOpen: true,
        });
    });
});

test('desktop extras cannot attach after disable wins delayed Select2 initialization', async () => {
    await withHost(async (cdp) => {
        await trackExtrasResources(cdp);
        const result = await cdp.evalFn(async (base, selector) => {
            const popup = window.__ST_TEST_HELPERS__.openCharacterWorldPopup(0);
            const select = popup.querySelector('.character_extra_world_info_selector');
            // Remove the fixture's immediate widget before the popup observer runs.
            jQuery(select).select2('destroy');
            await new Promise((resolve) => setTimeout(resolve, 0));
            const popupObserved = Boolean(popup.querySelector('.wbo-popup-select-trigger'));
            const readyBeforeDisable = Boolean(jQuery(select).data('select2'));
            const plugin = await import(`${base}index.js`);
            plugin.onDisable();
            window.extrasAudit.disabled = true;
            // Host onOpen initializes its widget only after extension teardown.
            jQuery(select).select2({ width: '100%', placeholder: '选择附加世界书', closeOnSelect: false });
            await new Promise((resolve) => setTimeout(resolve, 750));
            jQuery(selector).select2('open');
            await new Promise((resolve) => setTimeout(resolve, 100));
            return {
                popupObserved, readyBeforeDisable,
                handlers: window.extrasAudit.events.filter((entry) => entry.active).length,
                observers: window.extrasAudit.observers.filter((entry) => entry.active).length,
                late: { ...window.extrasAudit.late },
                groups: select.querySelectorAll('optgroup[data-wbo-group]').length,
                bar: Boolean(document.querySelector('.select2-dropdown .wbo-dd-filter-bar')),
                pins: document.querySelectorAll('.select2-dropdown .wbo-s2-pin-btn').length,
                nativeStillOpen: Boolean(jQuery(select).data('select2')?.isOpen()),
            };
        }, prefix, extrasSelector);
        assert.deepEqual(result, {
            popupObserved: true, readyBeforeDisable: false, handlers: 0, observers: 0,
            late: { events: 0, observers: 0, inputs: 0 }, groups: 0, bar: false, pins: 0, nativeStillOpen: true,
        });
    });
});
