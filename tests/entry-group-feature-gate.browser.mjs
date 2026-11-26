import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeSettings } from '../src/core.js';
import {
    ENTRY_GROUPING_STATE_CHANGED,
    configureEntryGroupingFeatureGate,
    isEntryGroupingEnabled,
    syncEntryGroupingFeatureGate,
} from '../src/entry-groups/feature-gate.js';

test('feature gate unit: only literal true opts in, including existing users with saved groups', () => {
    for (const value of [undefined, null, false, 0, 1, '', 'true', [], {}]) {
        const settings = { entryGroupsEnabled: value, books: { saved: { groups: [{ id: 'g' }] } } };
        const before = JSON.stringify(settings);
        assert.equal(isEntryGroupingEnabled(settings), false);
        assert.equal(JSON.stringify(settings), before);
    }
    assert.equal(isEntryGroupingEnabled(), false);
    assert.equal(isEntryGroupingEnabled({ entryGroupsEnabled: true }), true);
    assert.equal(ENTRY_GROUPING_STATE_CHANGED, 'wbo:entry-grouping-state-changed');
});

test('feature gate unit: default off stops without starting and does not modify records', async () => {
    const settings = { books: { saved: { assignments: { 0: 'g' } } } };
    const before = JSON.stringify(settings);
    let starts = 0;
    let stops = 0;
    const changes = [];
    const gate = configureEntryGroupingFeatureGate({ getSettings: () => settings,
        start: () => { starts++; }, stop: () => { stops++; }, onStateChanged: value => changes.push(value) });
    await syncEntryGroupingFeatureGate();
    assert.equal(starts, 0);
    assert.equal(stops, 1);
    assert.deepEqual(changes, [false]);
    assert.equal(JSON.stringify(settings), before);
    gate.dispose();
});

test('feature gate unit: normalized and reloaded settings preserve strict opt-in without migrating old users on', () => {
    const old = normalizeSettings({ groups: [{ id: 'saved', name: '已有分组' }] });
    assert.equal(isEntryGroupingEnabled(old), false);
    assert.equal(isEntryGroupingEnabled(normalizeSettings(JSON.parse(JSON.stringify(old)))), false);
    for (const enabled of [true, false]) {
        const saved = normalizeSettings({ ...old, entryGroupsEnabled: enabled });
        const restored = normalizeSettings(JSON.parse(JSON.stringify(saved)));
        assert.equal(restored.entryGroupsEnabled, enabled);
        assert.equal(isEntryGroupingEnabled(restored), enabled);
    }
});

test('feature gate unit: a cold controller restores the saved switch and can be enabled again without touching records', async () => {
    const saved = { books: { saved: { assignments: { 0: 'g' } } }, entryGroupsEnabled: false };
    const records = JSON.stringify(saved.books);
    const actions = [];
    let settings = JSON.parse(JSON.stringify(saved));
    const configure = () => configureEntryGroupingFeatureGate({ getSettings: () => settings,
        start: () => actions.push('start'), stop: () => actions.push('stop'), onStateChanged() {} });
    let gate = configure();
    await gate.sync();
    assert.deepEqual(actions, ['stop']);
    settings.entryGroupsEnabled = true;
    await gate.sync();
    assert.deepEqual(actions, ['stop', 'start']);
    const persisted = JSON.stringify(settings);
    gate.dispose();
    actions.length = 0;
    settings = JSON.parse(persisted);
    gate = configure();
    await gate.sync();
    assert.deepEqual(actions, ['start']);
    assert.equal(JSON.stringify(settings.books), records);
    gate.dispose();
});

test('feature gate unit: enable preserves startup arguments and disable cleans up immediately', async () => {
    const settings = { entryGroupsEnabled: true };
    const onRevealNativeEditor = () => {};
    const calls = [];
    const gate = configureEntryGroupingFeatureGate({ getSettings: () => settings, styleVersion: 'test-version', onRevealNativeEditor,
        start: async (...args) => calls.push(['start', ...args]), stop: () => calls.push(['stop']),
        onStateChanged: enabled => calls.push(['changed', enabled]) });
    await gate.sync();
    assert.deepEqual(calls, [['start', 'test-version', { onRevealNativeEditor }], ['changed', true]]);
    settings.entryGroupsEnabled = false;
    const pending = gate.sync();
    assert.deepEqual(calls.at(-2), ['stop']);
    await pending;
    assert.deepEqual(calls.at(-1), ['changed', false]);
    settings.entryGroupsEnabled = true;
    await gate.sync();
    assert.equal(calls.filter(([action]) => action === 'start').length, 2);
    gate.dispose();
});

test('feature gate unit: disabling during pending startup cannot announce a stale enabled state', async () => {
    const settings = { entryGroupsEnabled: true };
    let finishStart;
    let stops = 0;
    const changes = [];
    const gate = configureEntryGroupingFeatureGate({ getSettings: () => settings,
        start: () => new Promise(resolve => { finishStart = resolve; }), stop: () => { stops++; },
        onStateChanged: enabled => changes.push(enabled) });
    const enabling = gate.sync();
    settings.entryGroupsEnabled = false;
    await gate.sync();
    finishStart();
    await enabling;
    assert.equal(stops, 1);
    assert.deepEqual(changes, [false]);
    gate.dispose();
});

test('feature gate unit: disposal cancels late notifications and unbinds settings dispatch', async () => {
    const settings = { entryGroupsEnabled: true };
    let finishStart;
    let starts = 0;
    let stops = 0;
    const changes = [];
    const gate = configureEntryGroupingFeatureGate({ getSettings: () => settings,
        start: () => { starts++; return new Promise(resolve => { finishStart = resolve; }); },
        stop: () => { stops++; }, onStateChanged: value => changes.push(value) });
    const pending = gate.sync();
    gate.dispose();
    gate.dispose();
    finishStart();
    await pending;
    await gate.sync();
    await syncEntryGroupingFeatureGate();
    assert.equal(starts, 1);
    assert.equal(stops, 1);
    assert.deepEqual(changes, []);
});

test('feature gate unit: startup failure cleans partial work and remains retryable', async () => {
    let fail = true;
    let stops = 0;
    const changes = [];
    const gate = configureEntryGroupingFeatureGate({ getSettings: () => ({ entryGroupsEnabled: true }),
        start: async () => { if (fail) throw new Error('startup failed'); }, stop: () => { stops++; },
        onStateChanged: enabled => changes.push(enabled) });
    await assert.rejects(gate.sync(), /startup failed/);
    assert.equal(stops, 1);
    assert.deepEqual(changes, [false]);
    fail = false;
    await gate.sync();
    assert.deepEqual(changes, [false, true]);
    gate.dispose();
});

test('feature gate unit: default notification carries the owned event and boolean detail', async () => {
    const previousWindow = globalThis.window;
    const previousEvent = globalThis.CustomEvent;
    const target = new EventTarget();
    const details = [];
    globalThis.window = target;
    globalThis.CustomEvent = class extends Event {
        constructor(name, options) { super(name); this.detail = options.detail; }
    };
    target.addEventListener(ENTRY_GROUPING_STATE_CHANGED, event => details.push(event.detail));
    let gate;
    try {
        const settings = {};
        gate = configureEntryGroupingFeatureGate({ getSettings: () => settings, start() {}, stop() {} });
        await gate.sync();
        settings.entryGroupsEnabled = true;
        await gate.sync();
        settings.entryGroupsEnabled = false;
        await gate.sync();
        assert.deepEqual(details, [{ enabled: false }, { enabled: true }, { enabled: false }]);
    } finally {
        gate?.dispose();
        if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
        if (previousEvent === undefined) delete globalThis.CustomEvent; else globalThis.CustomEvent = previousEvent;
    }
});

test('feature gate unit: replacing a pending controller cannot stop its replacement on late rejection', async () => {
    let rejectStart;
    let oldStops = 0;
    let newStops = 0;
    const changes = [];
    const old = configureEntryGroupingFeatureGate({ getSettings: () => ({ entryGroupsEnabled: true }),
        start: () => new Promise((_, reject) => { rejectStart = reject; }),
        stop: () => { oldStops++; }, onStateChanged: value => changes.push(['old', value]) });
    const oldPending = old.sync();
    const replacement = configureEntryGroupingFeatureGate({ getSettings: () => ({ entryGroupsEnabled: true }),
        start() {}, stop: () => { newStops++; }, onStateChanged: value => changes.push(['new', value]) });
    await syncEntryGroupingFeatureGate();
    rejectStart(new Error('obsolete failure'));
    await assert.rejects(oldPending, /obsolete failure/);
    assert.equal(oldStops, 1);
    assert.equal(newStops, 0);
    assert.deepEqual(changes, [['new', true]]);
    replacement.dispose();
});

test('feature gate unit: lifecycle ignores direct starts and legacy availability when opted out', async () => {
    const previousHost = globalThis.SillyTavern;
    const previousDocument = globalThis.document;
    const records = { books: { saved: { groups: [{ id: 'g' }], assignments: { 0: 'g' } } } };
    globalThis.SillyTavern = { getContext: () => ({ extensionSettings: {
        worldbook_organizer: {}, worldbook_entry_groups: records,
    } }) };
    globalThis.document = { querySelector() { throw new Error('disabled gate queried native DOM'); },
        getElementById() { throw new Error('disabled gate queried native DOM'); } };
    try {
        const lifecycle = await import('../src/entry-groups/lifecycle.js');
        assert.equal(lifecycle.isEntryGroupingAvailable(), false);
        await lifecycle.startEntryGrouping('must-not-start');
        assert.deepEqual(records, { books: { saved: { groups: [{ id: 'g' }], assignments: { 0: 'g' } } } });
    } finally {
        if (previousHost === undefined) delete globalThis.SillyTavern; else globalThis.SillyTavern = previousHost;
        if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
    }
});

test('feature gate unit: real lifecycle cancels before style and listener setup after an awaited startup check', async () => {
    const previousHost = globalThis.SillyTavern;
    const previousDocument = globalThis.document;
    const settings = { entryGroupsEnabled: true };
    globalThis.SillyTavern = { getContext: () => ({ extensionSettings: { worldbook_organizer: settings } }) };
    globalThis.document = {
        querySelector() { return null; }, getElementById() { return null; },
        get head() { throw new Error('cancelled startup tried to install styles'); },
        addEventListener() { throw new Error('cancelled startup tried to bind listeners'); },
    };
    try {
        const lifecycle = await import('../src/entry-groups/lifecycle.js');
        const flagCancelled = lifecycle.startEntryGrouping('cancelled-by-flag');
        settings.entryGroupsEnabled = false;
        await flagCancelled;
        assert.equal(lifecycle.isEntryGroupingAvailable(), false);
        settings.entryGroupsEnabled = true;
        const stopCancelled = lifecycle.startEntryGrouping('cancelled-by-stop');
        lifecycle.stopEntryGrouping();
        await stopCancelled;
        assert.equal(lifecycle.isEntryGroupingAvailable(), false);
    } finally {
        if (previousHost === undefined) delete globalThis.SillyTavern; else globalThis.SillyTavern = previousHost;
        if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
    }
});

const suite = process.env.WBO_E2E_SUITE;
for (const device of ['desktop', 'mobile']) {
    test(`feature gate browser: ${device} defaults off and toggles both native and manager entries without refresh`, { skip: !suite }, async () => {
        const load = name => import(pathToFileURL(resolve(suite, 'lib', name)).href);
        const { createMockStServer } = await load('mock-server.mjs');
        const { VIEWPORTS, launchEdgeCdp } = await load('cdp.mjs');
        const { createDefaultSeed, makeBook, makeEntry } = await load('fixtures.mjs');
        const { openManager, resetAndBoot, waitForCondition } = await load('assert-helpers.mjs');
        const world = '总开关测试书';
        const savedBook = { groups: [{ id: 'g', name: '测试组', mode: 'normal' }], assignments: { 0: 'g' } };
        const server = createMockStServer();
        const baseUrl = await server.start();
        let cdp;
        try {
            cdp = await launchEdgeCdp();
            const seed = createDefaultSeed({
                characters: [], selected_world_info: [], worldbooks: { [world]: makeBook([makeEntry(0), makeEntry(1)]) },
                pluginSettings: { autoScanNewCharacters: false, settingsLastTab: 'appearance', activeFilterGroupId: '__all__' },
                extraPluginSettingsKey: { worldbook_entry_groups: { nativeEntryChoiceSeen: true, books: { [world]: savedBook } } },
            });
            delete seed.extension_settings.worldbook_organizer.entryGroupsEnabled;
            await resetAndBoot(cdp, baseUrl, { viewport: VIEWPORTS[device], seed });
            const read = () => cdp.evalFn(async () => {
                const { isEntryGroupingAvailable } = await import('/scripts/extensions/third-party/worldbook-organizer/src/entry-groups/lifecycle.js');
                return { available: isEntryGroupingAvailable(), native: !!document.getElementById('weg-native-entry-controls'),
                    stylesheet: [...document.querySelectorAll('link[rel="stylesheet"]')].some(link => link.href.includes('/entry-groups/style.css')),
                    entryButtons: document.querySelectorAll('[data-acc-extra="open-entry-groups"], [data-more-act="entry-groups"]').length };
            });
            assert.deepEqual(await read(), { available: false, native: false, stylesheet: false, entryButtons: 0 });
            assert.deepEqual(await cdp.evalFn(world => SillyTavern.getContext().extensionSettings.worldbook_entry_groups.books[world], world), savedBook);
            await cdp.evalFn(async () => {
                const legacy = document.createElement('div'); legacy.id = 'weg-native-entry-btn'; document.body.append(legacy);
                const lifecycle = await import('/scripts/extensions/third-party/worldbook-organizer/src/entry-groups/lifecycle.js');
                window.gateLegacyAvailable = lifecycle.isEntryGroupingAvailable();
                await lifecycle.startEntryGrouping('disabled-start'); legacy.remove();
            });
            assert.equal(await cdp.evalFn(() => window.gateLegacyAvailable), false);
            await cdp.evalFn(world => {
                const select = document.getElementById('world_editor_select');
                const option = [...select.options].find(item => item.textContent === world);
                if (!option) throw new Error('fixture book missing from native editor');
                select.value = option.value;
                select.dispatchEvent(new Event('change', { bubbles: true }));
            }, world);
            await waitForCondition(cdp, () => document.querySelector('#world_popup_entries_list .world_entry'));
            assert.equal((await read()).native, false);
            await openManager(cdp);
            await cdp.clickSelector('.wbo-book-item .wbo-book-main');
            await waitForCondition(cdp, () => document.querySelector('.wbo-book-row.is-preview-open + .wbo-book-preview .wbo-acc-shell'));
            assert.equal((await read()).entryButtons, 0);
            const openSettings = () => cdp.evalFn(async () => {
                (await import('/scripts/extensions/third-party/worldbook-organizer/src/panel-settings.js')).openSettingsModal();
            });
            await openSettings();
            assert.equal(await cdp.evalFn(() => document.querySelector('[data-settings-pane="appearance"] > .wbo-card .wbo-ai-section-head').textContent.trim()), '条目分组（测试）');
            const selector = 'input[data-setting="entryGroupsEnabled"]';
            assert.equal(await cdp.evalFn(() => document.querySelector('input[data-setting="entryGroupsEnabled"]').checked), false);
            writeFileSync(resolve(tmpdir(), `wbo-feature-gate-${device}.png`), Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
            await cdp.clickSelector(selector);
            await waitForCondition(cdp, async () => {
                const lifecycle = await import('/scripts/extensions/third-party/worldbook-organizer/src/entry-groups/lifecycle.js');
                return lifecycle.isEntryGroupingAvailable() && !document.querySelector('input[data-setting="entryGroupsEnabled"]').disabled;
            });
            assert.equal((await read()).stylesheet, true);
            await waitForCondition(cdp, () => document.getElementById('weg-native-entry-controls'));
            await cdp.clickSelector('#wbo-settings-close-btn');
            if (!await cdp.evalFn(() => document.querySelector('.wbo-book-row.is-preview-open'))) {
                await cdp.clickSelector('.wbo-book-item .wbo-book-main');
            }
            await waitForCondition(cdp, () => document.querySelector('[data-acc-extra="open-entry-groups"]'));
            await cdp.clickSelector('[data-acc-toggle="0"]');
            await waitForCondition(cdp, () => document.querySelector('.wbo-acc-editor textarea[data-acc-field="content"]'));
            const draft = '尚未保存的正文测试草稿';
            await cdp.evalFn(draft => {
                window.featureGateDraftNode = document.querySelector('.wbo-acc-editor textarea[data-acc-field="content"]');
                window.featureGateAccordion = document.querySelector('.wbo-book-preview .wbo-acc-shell');
                const textarea = window.featureGateDraftNode;
                textarea.value = draft;
                textarea.selectionStart = 2;
                textarea.selectionEnd = 5;
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
            }, draft);
            const assertDraft = async () => assert.deepEqual(await cdp.evalFn(() => {
                const node = document.querySelector('.wbo-acc-editor textarea[data-acc-field="content"]');
                return { sameNode: node === window.featureGateDraftNode,
                    sameAccordion: document.querySelector('.wbo-book-preview .wbo-acc-shell') === window.featureGateAccordion,
                    value: node?.value, selection: node ? [node.selectionStart, node.selectionEnd] : null };
            }), { sameNode: true, sameAccordion: true, value: draft, selection: [2, 5] },
            'switching the beta must update only its entry button, never replace an open editor or its draft');
            const records = await cdp.evalFn(world => structuredClone(SillyTavern.getContext().extensionSettings.worldbook_entry_groups.books[world]), world);
            await openSettings();
            await cdp.clickSelector(selector);
            await waitForCondition(cdp, () => !document.querySelector('input[data-setting="entryGroupsEnabled"]').disabled);
            assert.equal(await cdp.evalFn(() => document.querySelectorAll('[data-acc-extra="open-entry-groups"], [data-more-act="entry-groups"]').length), 0,
                'existing accordion entry buttons disappear immediately, without closing or reopening the book');
            await assertDraft();
            assert.deepEqual(await cdp.evalFn(() => {
                const actions = document.querySelector('.wbo-acc-toolbar-actions');
                const button = actions.querySelector('.wbo-acc-new-btn');
                const a = actions.getBoundingClientRect();
                const b = button.getBoundingClientRect();
                const style = getComputedStyle(actions);
                return { children: [...actions.children].map(node => node.className),
                    noLeftSlot: Math.abs(b.left - a.left - parseFloat(style.paddingLeft || 0)) < 2,
                    noRightSlot: Math.abs(a.right - b.right - parseFloat(style.paddingRight || 0)) < 2 };
            }), { children: ['wbo-btn wbo-btn-primary wbo-acc-new-btn'], noLeftSlot: true, noRightSlot: true },
            'removing the grouping button leaves only the create button, with no reserved empty slot');
            assert.deepEqual(await read(), { available: false, native: false, stylesheet: false, entryButtons: 0 });
            assert.equal(await cdp.evalFn(() => !!document.querySelector('.weg-native-page-size')), false,
                'native pagination layout classes are removed with the feature');
            assert.deepEqual(await cdp.evalFn(world => SillyTavern.getContext().extensionSettings.worldbook_entry_groups.books[world], world), records);
            await cdp.evalFn(() => window.dispatchEvent(new CustomEvent('weg:open-panel')));
            assert.equal(await cdp.evalFn(() => !!document.getElementById('weg-modal-backdrop')), false);
            await cdp.clickSelector('#wbo-settings-close-btn');
            await openSettings();
            assert.equal(await cdp.evalFn(() => document.querySelector('input[data-setting="entryGroupsEnabled"]').checked), false);
            await cdp.clickSelector(selector);
            await waitForCondition(cdp, () => !document.querySelector('input[data-setting="entryGroupsEnabled"]').disabled);
            await assertDraft();
            assert.equal(await cdp.evalFn(() => document.querySelectorAll('[data-acc-extra="open-entry-groups"]').length), 1,
                'the same open accordion regains one entry button when re-enabled');
            const restoredSeed = { ...seed, extension_settings: await cdp.evalFn(() => structuredClone(SillyTavern.getContext().extensionSettings)) };
            await resetAndBoot(cdp, baseUrl, { viewport: VIEWPORTS[device], seed: restoredSeed });
            await waitForCondition(cdp, async () => {
                const { isEntryGroupingAvailable } = await import('/scripts/extensions/third-party/worldbook-organizer/src/entry-groups/lifecycle.js');
                return isEntryGroupingAvailable();
            });
            assert.equal((await read()).stylesheet, true, 'cold boot restores the explicit saved opt-in');
            await openManager(cdp);
            await openSettings();
            assert.equal(await cdp.evalFn(() => document.querySelector('input[data-setting="entryGroupsEnabled"]').checked), true);
            await cdp.clickSelector(selector);
            await waitForCondition(cdp, () => !document.querySelector('input[data-setting="entryGroupsEnabled"]').disabled);
            restoredSeed.extension_settings = await cdp.evalFn(() => structuredClone(SillyTavern.getContext().extensionSettings));
            await resetAndBoot(cdp, baseUrl, { viewport: VIEWPORTS[device], seed: restoredSeed });
            assert.deepEqual(await read(), { available: false, native: false, stylesheet: false, entryButtons: 0 },
                'cold boot preserves a saved disabled switch without removing grouping records');
            await openManager(cdp);
            await openSettings();
            assert.equal(await cdp.evalFn(() => document.querySelector('input[data-setting="entryGroupsEnabled"]').checked), false);
            assert.deepEqual(await cdp.evalFn(world => SillyTavern.getContext().extensionSettings.worldbook_entry_groups.books[world], world), records);
            assert.deepEqual(cdp.getErrors().runtimeErrors, []);
        } finally {
            await cdp?.close();
            await server.stop();
        }
    });
}
