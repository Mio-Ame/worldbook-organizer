/**
 * runtime refresh/dropdown regressions (M4).
 *
 * Split out of tests/core.test.mjs without touching a single test body: names and order within
 * this file are unchanged, and the shared helpers live in ./core-prelude.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SPECIAL_GROUPS, buildCharacterBindingIndex, classifyWorldbooks, installMockNativeFilterDom, normalizeSettings } from './core-prelude.mjs';

test('M4 P1 regression: renderEmbeddedPanel({ backgroundCatchUp: true }) preserves open .wbo-book-preview and flushes on collapse', async () => {
    const dom = installMockNativeFilterDom({ innerWidth: 1280, innerHeight: 800 });
    const prevConfirm = globalThis.confirm;
    const prevFetch = globalThis.fetch;
    const prevSetTimeout = globalThis.setTimeout;
    const panelMod = await import('../src/panel.js');

    const settings = normalizeSettings({
        showCharBooks: false,
        activeFilterGroupId: SPECIAL_GROUPS.DEFAULT,
        autoScanNewCharacters: true,
    });
    const characters = [
        { name: '新角色', avatar: 'new.png', shallow: true },
    ];
    let worldNames = ['通用书', '新角色专属书'];

    globalThis.SillyTavern = {
        getContext: () => ({
            characters,
            extensionSettings: {},
            saveSettingsDebounced: () => {},
            getWorldInfoNames: () => [...worldNames],
            world_names: [...worldNames],
            getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        }),
    };
    globalThis.fetch = async (url) => {
        if (String(url).includes('/api/worldinfo/get')) {
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    entries: {
                        0: { uid: 0, comment: '条目1', key: ['k1'], content: '正文1', order: 100, displayIndex: 0 },
                    },
                }),
            };
        }
        return { ok: true, status: 200, json: async () => ({}) };
    };

    const recomputeState = () => {
        const bindingMap = buildCharacterBindingIndex({
            characters,
            charLore: [],
            cachedCharBindings: settings.cachedCharBindings,
            worldNamesSet: new Set(worldNames),
            includeExtraCharBooks: true,
            includeEmbeddedNameMatch: true,
        });
        const classification = classifyWorldbooks({
            worldNames,
            bindingMap,
            personaMap: new Map(),
            settings,
        });
        return { settings, bindingMap, classification };
    };

    try {
        globalThis.confirm = () => true;
        let state = recomputeState();
        panelMod.bindPanelCallbacks({
            getState: () => state,
            onMutation: async () => {
                state = recomputeState();
                panelMod.renderEmbeddedPanel();
            },
            onRescan: async () => {
                state = recomputeState();
                panelMod.renderEmbeddedPanel();
            },
        });

        panelMod.openManagerModal();
        const bookMain = dom.doc.querySelector('.wbo-book-item[data-book="通用书"] .wbo-book-main');
        assert.ok(bookMain);
        bookMain.click();
        await new Promise((r) => prevSetTimeout(r, 20));

        const previewEl = dom.doc.querySelector('.wbo-book-item[data-book="通用书"] .wbo-book-preview');
        assert.ok(previewEl && !previewEl.hidden, 'preview should be open before catch-up');
        assert.ok(previewEl.querySelector('.wbo-acc-item'), 'entries should be mounted inside preview');

        // Simulate background catch-up finishing and discovering 新角色专属书 -> 角色世界书
        characters[0] = {
            name: '新角色',
            avatar: 'new.png',
            shallow: false,
            data: { name: '新角色', extensions: { world: '新角色专属书' } },
        };
        settings.cachedCharBindings['new.png'] = {
            avatar: 'new.png',
            name: '新角色',
            primary: '新角色专属书',
            embedded: null,
            embeddedEntryCount: 0,
        };
        state = recomputeState();
        panelMod.renderEmbeddedPanel({ backgroundCatchUp: true });

        // Header badges update immediately, while open preview remains intact
        assert.equal(dom.doc.getElementById('wbo-mgr-char-label')?.textContent?.trim(), '角色书 1');
        assert.equal(dom.doc.getElementById('wbo-mgr-scan-label')?.textContent?.trim(), '扫描');
        assert.equal(previewEl.isConnected, true, 'open preview DOM must NOT be destroyed by backgroundCatchUp');
        assert.equal(previewEl.hidden, false, 'open preview must stay expanded during backgroundCatchUp');
        assert.ok(dom.doc.querySelector('.wbo-book-item[data-book="新角色专属书"]'), 'deferred list rebuild waits until preview closes');

        // Closing preview flushes deferred list sync so 新角色专属书 moves out of visible 未分组
        bookMain.click();
        await new Promise((r) => prevSetTimeout(r, 10));
        assert.equal(dom.doc.querySelector('.wbo-book-item[data-book="新角色专属书"]'), null, 'deferred list sync runs once last preview collapses');
    } finally {
        panelMod.teardownPanels();
        globalThis.confirm = prevConfirm;
        globalThis.fetch = prevFetch;
        dom.restore();
    }
});

test('M4 P2 regression (Bug 1): buildCharacterBindingIndex filters out bindings when worldNamesSet is an empty Set', () => {
    const characters = [
        {
            avatar: 'Ghost.png',
            name: '幽灵角色',
            shallow: false,
            data: {
                extensions: { world: 'DeletedPrimaryBook' },
                character_book: { name: 'UnimportedEmbeddedBook' },
            },
        },
    ];
    const charLore = [{ name: 'Ghost', extraBooks: ['DeletedExtraBook'] }];

    const filteredEmpty = buildCharacterBindingIndex({
        characters,
        charLore,
        cachedCharBindings: {},
        worldNamesSet: new Set(),
        includeExtraCharBooks: true,
        includeEmbeddedNameMatch: true,
    });
    assert.equal(filteredEmpty.size, 0, 'Empty worldNamesSet must filter out non-existent books instead of leaking all bindings');

    const unfilteredNull = buildCharacterBindingIndex({
        characters,
        charLore,
        cachedCharBindings: {},
        worldNamesSet: null,
        includeExtraCharBooks: true,
        includeEmbeddedNameMatch: true,
    });
    assert.equal(unfilteredNull.size, 3, 'null worldNamesSet remains unfiltered');
});

test('M4 P2 regression (Bug 2): saveWorldbookEntriesOrderDirect prefers explicit uid:0 over ID-less slot 0 in Object originalData.entries', async () => {
    const prevFetch = globalThis.fetch;
    const prevST = globalThis.SillyTavern;
    const hostMod = await import('../src/host.js');

    let savedPayload = null;
    const serverBook = {
        entries: [
            { uid: 0, comment: 'real-uid-0', content: 'A', key: ['a'], order: 100, displayIndex: 5, extensions: { display_index: 5 } },
            { uid: 1, comment: 'real-uid-1', content: 'B', key: ['b'], order: 200, displayIndex: 1, extensions: { display_index: 1 } },
        ],
        originalData: {
            entries: {
                0: { comment: 'idless-slot-0', extensions: { display_index: 99 } },
                1: { uid: 0, comment: 'real-uid-0', extensions: { display_index: 5 } },
                2: { uid: 1, comment: 'real-uid-1', extensions: { display_index: 1 } },
            },
        },
    };

    globalThis.SillyTavern = {
        getContext: () => ({
            getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
            eventSource: { emit: async () => {} },
            eventTypes: {},
        }),
    };
    globalThis.fetch = async (url, init) => {
        if (String(url).includes('/api/worldinfo/get')) {
            return { ok: true, status: 200, json: async () => structuredClone(serverBook) };
        }
        if (String(url).includes('/api/worldinfo/edit')) {
            savedPayload = JSON.parse(init.body);
            return { ok: true, status: 200, json: async () => ({ ok: true }) };
        }
        return { ok: true, status: 200, json: async () => ({}) };
    };

    try {
        const res = await hostMod.saveWorldbookEntriesOrderDirect('MixedOrigBook', ['0', '1'], { syncOrder: false });
        assert.equal(res.ok, true);
        // minDisplayIndex across [5, 1] is 1, so new sequential displayIndex values are 1 (uid 0) and 2 (uid 1)
        assert.equal(savedPayload.data.originalData.entries['1'].extensions.display_index, 1, 'Slot 1 (explicit uid: 0) must receive display_index=1');
        assert.equal(savedPayload.data.originalData.entries['0'].extensions.display_index, 99, 'ID-less slot 0 must NOT steal explicit uid: 0');
        assert.equal(savedPayload.data.originalData.entries['2'].extensions.display_index, 2);
    } finally {
        globalThis.fetch = prevFetch;
        globalThis.SillyTavern = prevST;
    }
});

test('M4 P2 regression (Bug 3): closeAllOpenWorldDropdowns hides persistent #gr-editor-dropdown-container without .remove()', async () => {
    const dom = installMockNativeFilterDom({ innerWidth: 1280, innerHeight: 800 });
    const nativeMod = await import('../src/native-filter.js');
    try {
        const sortSelect = dom.doc.createElement('select');
        sortSelect.id = 'world_info_sort_order';
        const sortDisplay = dom.doc.createElement('div');
        sortDisplay.id = 'gr-sort-order-display';
        sortDisplay.className = 'gr-select2-display';

        const worldPopup = dom.doc.createElement('div');
        worldPopup.id = 'world_popup';
        const editorSel = dom.doc.createElement('select');
        editorSel.id = 'world_editor_select';
        for (const [v, t] of [['', '--- 选择以编辑 ---'], ['0', '通用书A'], ['1', '通用书B']]) {
            const o = dom.doc.createElement('option');
            o.value = v;
            o.textContent = t;
            editorSel.appendChild(o);
        }
        const edDisplay = dom.doc.createElement('div');
        edDisplay.id = 'gr-editor-display';
        edDisplay.className = 'gr-select2-display';
        worldPopup.append(sortSelect, sortDisplay, editorSel, edDisplay);
        dom.doc.body.appendChild(worldPopup);

        // Persistent editor popover mounted at rest with style.display = 'none'
        const edPop = dom.doc.createElement('div');
        edPop.id = 'gr-editor-dropdown-container';
        edPop.className = 'gr-container-enhanced';
        edPop.style.display = 'none';
        const optHost = dom.doc.createElement('div');
        optHost.className = 'gr-options-list';
        for (const [v, t] of [['0', '通用书A'], ['1', '通用书B']]) {
            const opt = dom.doc.createElement('div');
            opt.className = 'gr-option';
            opt.dataset.value = v;
            opt.textContent = t;
            optHost.appendChild(opt);
        }
        edPop.appendChild(optHost);
        dom.doc.body.appendChild(edPop);

        const settings = normalizeSettings({ showCharBooks: false });
        const cls = classifyWorldbooks({ worldNames: ['通用书A', '通用书B'], bindingMap: new Map(), settings });
        nativeMod.applyAllNativeWorldFilters(cls, settings, { force: true });
        nativeMod.startNativeObservers(() => {});

        // Open persistent editor popover, then click #gr-sort-order-display
        edPop.style.display = 'block';
        sortDisplay.dispatchEvent(new dom.MockEvent('pointerdown', { bubbles: true, cancelable: true }));

        assert.equal(edPop.isConnected, true, 'Persistent #gr-editor-dropdown-container must remain connected in document.body');
        assert.equal(edPop.style.display, 'none', 'Persistent #gr-editor-dropdown-container must be closed via display:none');

        // Reopen succeeds because container stayed connected
        edPop.style.display = 'block';
        assert.equal(edPop.isConnected && edPop.style.display === 'block', true);
    } finally {
        nativeMod.teardownNativeFilters();
        dom.restore();
    }
});

test('M4 P2 regression (Bug 4): applyEditorWorldSelectFilter flushes _pendingClearedEditingWorld even when signature matches', async () => {
    const dom = installMockNativeFilterDom({ innerWidth: 1280, innerHeight: 800 });
    const nativeMod = await import('../src/native-filter.js');
    try {
        let liveWorldNames = ['待删书', '保留书'];
        const jqWinHandlers = new Map();
        globalThis.SillyTavern = {
            getContext: () => ({
                characters: [],
                extensionSettings: {},
                saveSettingsDebounced: () => {},
                getWorldInfoNames: () => liveWorldNames,
            }),
        };

        const editorSel = dom.doc.createElement('select');
        editorSel.id = 'world_editor_select';
        for (const [v, t] of [['', '--- 选择以编辑 ---'], ['0', '待删书'], ['1', '保留书']]) {
            const o = dom.doc.createElement('option');
            o.value = v;
            o.textContent = t;
            if (v === '0') o.selected = true;
            editorSel.appendChild(o);
        }
        editorSel.value = '0';
        dom.doc.body.appendChild(editorSel);

        let changeCount = 0;
        editorSel.addEventListener('change', () => { changeCount += 1; });

        globalThis.jQuery = (target) => ({
            on: (evt, fn) => {
                if (target === globalThis.window) {
                    if (!jqWinHandlers.has(evt)) jqWinHandlers.set(evt, []);
                    jqWinHandlers.get(evt).push(fn);
                }
            },
            off: (evt, fn) => {
                if (target === globalThis.window && jqWinHandlers.has(evt)) {
                    const arr = jqWinHandlers.get(evt);
                    const idx = arr.indexOf(fn);
                    if (idx >= 0) arr.splice(idx, 1);
                }
            },
            data: () => null,
            hasClass: () => false,
            trigger: (evt) => {
                if (target === editorSel && evt === 'change') {
                    changeCount += 1;
                }
            },
        });

        const settings = normalizeSettings({ showCharBooks: true });
        const cls1 = classifyWorldbooks({ worldNames: ['待删书', '保留书'], bindingMap: new Map(), settings });
        nativeMod.setCurrentlyEditingWorld('待删书');
        nativeMod.applyAllNativeWorldFilters(cls1, settings, { force: true });
        nativeMod.startNativeObservers(() => {});
        changeCount = 0;

        // Simulate upstream deletion + Select2 opening pass twice before normal filter pass
        liveWorldNames = ['保留书'];
        editorSel.innerHTML = '';
        for (const [v, t] of [['', '--- 选择以编辑 ---'], ['0', '保留书']]) {
            const o = dom.doc.createElement('option');
            o.value = v;
            o.textContent = t;
            editorSel.appendChild(o);
        }
        editorSel.value = '';
        nativeMod.setCurrentlyEditingWorld('待删书');
        const cls2 = classifyWorldbooks({ worldNames: ['保留书'], bindingMap: new Map(), settings });

        const openingHandlers = jqWinHandlers.get('select2:opening.wboEditorOpen') || [];
        assert.ok(openingHandlers.length > 0, 'select2:opening.wboEditorOpen handler must be registered');

        // Pass 1 & Pass 2 via select2:opening (skipSelectionSync: true)
        openingHandlers.forEach((fn) => fn({ target: editorSel }));
        openingHandlers.forEach((fn) => fn({ target: editorSel }));
        assert.equal(changeCount, 0, 'skipSelectionSync passes must defer change event');

        // Pass 3 normal applyAllNativeWorldFilters (signature now matches Pass 2!) must flush _pendingClearedEditingWorld
        nativeMod.applyAllNativeWorldFilters(cls2, settings);
        assert.equal(changeCount, 1, 'Pending cleared-editing-world change event must NOT be swallowed when sig === _lastEditorSignature');
    } finally {
        delete globalThis.jQuery;
        nativeMod.teardownNativeFilters();
        dom.restore();
    }
});

test('M4 P2 regression (Bug 5): scheduleRefresh cancels stale requestIdleCallback on urgent refresh and onDisable', async () => {
    const dom = installMockNativeFilterDom({ innerWidth: 1280, innerHeight: 800 });
    const prevRIC = globalThis.requestIdleCallback;
    const prevCIC = globalThis.cancelIdleCallback;
    const prevSetTimeout = globalThis.setTimeout;
    const prevClearTimeout = globalThis.clearTimeout;
    const prevFetch = globalThis.fetch;

    const scheduledTimeouts = new Map();
    const scheduledIdles = new Map();
    const cancelledIdles = [];
    let nextTimerId = 1;
    let nextIdleId = 100;

    const eventHandlers = new Map();
    const onceHandlers = new Map();
    const settingsStore = { worldbook_organizer: normalizeSettings({ autoScanNewCharacters: false }) };

    globalThis.setTimeout = (fn, ms) => {
        const id = nextTimerId++;
        scheduledTimeouts.set(id, { fn, ms });
        return id;
    };
    globalThis.clearTimeout = (id) => {
        scheduledTimeouts.delete(id);
    };
    globalThis.requestIdleCallback = (fn) => {
        const id = nextIdleId++;
        scheduledIdles.set(id, fn);
        return id;
    };
    globalThis.cancelIdleCallback = (id) => {
        cancelledIdles.push(id);
        scheduledIdles.delete(id);
    };
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ entries: {} }) });
    globalThis.SillyTavern = {
        getContext: () => ({
            extensionSettings: settingsStore,
            saveSettingsDebounced: () => {},
            characters: [{ name: 'Alice', avatar: 'Alice.png', shallow: false, data: { extensions: { world: 'AliceBook' } } }],
            powerUserSettings: {},
            getWorldInfoNames: () => ['AliceBook'],
            world_names: ['AliceBook'],
            getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
            eventSource: {
                on: (evt, fn) => {
                    if (!eventHandlers.has(evt)) eventHandlers.set(evt, []);
                    eventHandlers.get(evt).push(fn);
                },
                once: (evt, fn) => {
                    if (!onceHandlers.has(evt)) onceHandlers.set(evt, []);
                    onceHandlers.get(evt).push(fn);
                },
                removeListener: (evt, fn) => {
                    const list = eventHandlers.get(evt) || [];
                    const idx = list.indexOf(fn);
                    if (idx >= 0) list.splice(idx, 1);
                },
            },
            eventTypes: {
                APP_READY: 'APP_READY',
                CHARACTER_EDITED: 'CHARACTER_EDITED',
                WORLDINFO_SETTINGS_UPDATED: 'WORLDINFO_SETTINGS_UPDATED',
            },
        }),
    };

    // Import fresh index.js with cache-bust query so boot() binds against our mocked SillyTavern & timers
    const indexMod = await import(`../index.js?bug5test=${Date.now()}`);
    try {
        // Trigger boot's APP_READY -> requestIdleCallback -> init()
        const readyList = onceHandlers.get('APP_READY') || [];
        readyList.forEach((fn) => fn());
        for (const [id, fn] of [...scheduledIdles.entries()]) {
            scheduledIdles.delete(id);
            await fn();
        }
        // Wait microtasks for async init()
        await new Promise((r) => prevSetTimeout(r, 20));
        scheduledTimeouts.clear();
        scheduledIdles.clear();
        cancelledIdles.length = 0;

        // 1. Trigger CHARACTER_EDITED (700ms -> queues requestIdleCallback)
        const charHandlers = eventHandlers.get('CHARACTER_EDITED') || [];
        assert.ok(charHandlers.length > 0, 'CHARACTER_EDITED handler should be bound after init()');
        charHandlers.forEach((fn) => fn());
        const editTimer = [...scheduledTimeouts.entries()].find(([, v]) => v.ms === 700);
        assert.ok(editTimer, 'CHARACTER_EDITED should schedule 700ms debounce timer');
        scheduledTimeouts.delete(editTimer[0]);
        editTimer[1].fn();
        assert.equal(scheduledIdles.size, 1, '700ms timer should queue 1 requestIdleCallback');
        const firstIdleId = [...scheduledIdles.keys()][0];

        // 2. Trigger urgent WORLDINFO_SETTINGS_UPDATED (80ms) before idle fires -> must cancel firstIdleId!
        const wiHandlers = eventHandlers.get('WORLDINFO_SETTINGS_UPDATED') || [];
        assert.ok(wiHandlers.length > 0, 'WORLDINFO_SETTINGS_UPDATED handler should be bound');
        wiHandlers.forEach((fn) => fn());
        assert.ok(cancelledIdles.includes(firstIdleId), 'Urgent scheduleRefresh(80) must cancel prior pending idle callback');
        assert.equal(scheduledIdles.size, 0, 'Prior idle callback must be removed from queue');

        // 3. Queue another idle callback, then verify onDisable() cancels it too
        charHandlers.forEach((fn) => fn());
        const editTimer2 = [...scheduledTimeouts.entries()].find(([, v]) => v.ms === 700);
        assert.ok(editTimer2);
        scheduledTimeouts.delete(editTimer2[0]);
        editTimer2[1].fn();
        assert.equal(scheduledIdles.size, 1);
        const secondIdleId = [...scheduledIdles.keys()][0];

        indexMod.onDisable();
        assert.ok(cancelledIdles.includes(secondIdleId), 'onDisable() must cancel pending idle refresh');
        assert.equal(scheduledIdles.size, 0);
    } finally {
        try { indexMod.onDisable(); } catch { /* ignore */ }
        globalThis.requestIdleCallback = prevRIC;
        globalThis.cancelIdleCallback = prevCIC;
        globalThis.setTimeout = prevSetTimeout;
        globalThis.clearTimeout = prevClearTimeout;
        globalThis.fetch = prevFetch;
        dom.restore();
    }
});

test('M4 P2 regression (Bug 6): #wbo-api-key renders with spellcheck="false" even when toggled to text', async () => {
    const dom = installMockNativeFilterDom({ innerWidth: 1280, innerHeight: 800 });
    const panelMod = await import('../src/panel.js');
    const settings = normalizeSettings({ apiProvider: 'custom' });
    const cls = classifyWorldbooks({ worldNames: ['通用书'], bindingMap: new Map(), settings });
    const state = { settings, bindingMap: new Map(), classification: cls };
    try {
        panelMod.bindPanelCallbacks({
            getState: () => state,
            onMutation: async () => {},
            onRescan: async () => {},
        });
        panelMod.openManagerModal();
        dom.doc.querySelector('[data-action="open-ai-organize"]')?.click();
        dom.doc.getElementById('wbo-goto-api-tab')?.click();
        const apiKeyInput = dom.doc.getElementById('wbo-api-key');
        assert.ok(apiKeyInput, '#wbo-api-key should render in API config view');
        assert.equal(apiKeyInput.getAttribute('spellcheck'), 'false', '#wbo-api-key must carry spellcheck="false"');
        dom.doc.getElementById('wbo-toggle-key-btn')?.click();
        assert.equal(apiKeyInput.type, 'text');
        assert.equal(apiKeyInput.getAttribute('spellcheck'), 'false', '#wbo-api-key must keep spellcheck="false" when toggled to text');
    } finally {
        panelMod.teardownPanels();
        dom.restore();
    }
});
