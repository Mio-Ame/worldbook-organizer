/**
 * panel/host integration and M1/M2 regressions.
 *
 * Split out of tests/core.test.mjs without touching a single test body: names and order within
 * this file are unchanged, and the shared helpers live in ./core-prelude.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, SPECIAL_GROUPS, applyAiOrganizeProposals, classifyWorldbooks, computeReorderedEntries, computeScanPromptState, deepClone, exportConfigData, extractEntryListItems, extractSingleEntryForEdit, findUnboundCharacterNameMatches, getVisibleSectionMoveBounds, importConfigData, installMockNativeFilterDom, migrateSettingsOnWorldRename, moveBooksToNamedGroup, moveSectionOrder, normalizeMatchName, normalizeSettings, orderSectionsForExternalDropdown, pruneStaleWorldbookSettings, reorderEntryUids, sortEntryListItems, summarizeCharacterWorldCoverage } from './core-prelude.mjs';

test('M1 R2: sectionOrder v3 migration, custom order preservation, external dropdown order, and visibility-aware move bounds', () => {
    // 1. v2 promoted-character default [__char__, g1, g2, __ungrouped__] migrates to [__char__, __ungrouped__, g1, g2]
    const promotedV2 = normalizeSettings({
        sectionOrderVersion: 2,
        groups: [{ id: 'g1', name: '文风' }, { id: 'g2', name: '世界观' }],
        sectionOrder: [SPECIAL_GROUPS.CHARACTER, 'g1', 'g2', SPECIAL_GROUPS.UNGROUPED],
    });
    assert.equal(promotedV2.sectionOrderVersion, 3);
    assert.deepEqual(promotedV2.sectionOrder, [SPECIAL_GROUPS.CHARACTER, SPECIAL_GROUPS.UNGROUPED, 'g1', 'g2']);

    // 2. Explicit v2 custom order [g1, __ungrouped__, g2, __char__] is preserved without forced reset
    const explicitV2 = normalizeSettings({
        sectionOrderVersion: 2,
        groups: [{ id: 'g1', name: '文风' }, { id: 'g2', name: '世界观' }],
        sectionOrder: ['g1', SPECIAL_GROUPS.UNGROUPED, 'g2', SPECIAL_GROUPS.CHARACTER],
    });
    assert.deepEqual(explicitV2.sectionOrder, ['g1', SPECIAL_GROUPS.UNGROUPED, 'g2', SPECIAL_GROUPS.CHARACTER]);

    // 3. Export/import preserves sectionOrderVersion & custom sectionOrder
    const exported = exportConfigData(explicitV2);
    assert.equal(exported.data.sectionOrderVersion, 3);
    const imported = normalizeSettings(null);
    assert.equal(importConfigData(imported, exported).ok, true);
    assert.deepEqual(imported.sectionOrder, ['g1', SPECIAL_GROUPS.UNGROUPED, 'g2', SPECIAL_GROUPS.CHARACTER]);

    // 4. orderSectionsForExternalDropdown puts UNGROUPED last without mutating input
    const cls = classifyWorldbooks({
        worldNames: ['书A', '书B'],
        bindingMap: new Map([['书A', [{ avatar: 'A.png', charName: '角色A', source: 'primary' }]]]),
        settings: normalizeSettings({
            groups: [{ id: 'g1', name: '文风' }, { id: 'g2', name: '剧情' }],
        }),
    });
    assert.deepEqual(
        cls.orderedSections.map((s) => s.id),
        [SPECIAL_GROUPS.CHARACTER, SPECIAL_GROUPS.UNGROUPED, 'g1', 'g2'],
    );
    const extInputSnapshot = cls.orderedSections.map((s) => s.id);
    const extOrdered = orderSectionsForExternalDropdown(cls.orderedSections);
    assert.deepEqual(
        extOrdered.map((s) => s.id),
        [SPECIAL_GROUPS.CHARACTER, 'g1', 'g2', SPECIAL_GROUPS.UNGROUPED],
    );
    assert.deepEqual(cls.orderedSections.map((s) => s.id), extInputSnapshot, 'input array must not be mutated');

    // 5. moveSectionOrder skips hidden system sections when visibleSectionIds is provided
    const visSettings = normalizeSettings({
        groups: [{ id: 'g1', name: '文风' }, { id: 'g2', name: '剧情' }],
    });
    // Full order: [__char__, __ungrouped__, g1, g2]
    // Suppose both __char__ and __ungrouped__ are hidden; visible list is ['g1', 'g2']
    const visibleIds = ['g1', 'g2'];
    const bounds = getVisibleSectionMoveBounds(visibleIds);
    assert.equal(bounds.get('g1')?.canMoveUp, false);
    assert.equal(bounds.get('g1')?.canMoveDown, true);
    assert.equal(bounds.get('g2')?.canMoveUp, true);
    assert.equal(bounds.get('g2')?.canMoveDown, false);

    assert.equal(moveSectionOrder(visSettings, 'g1', -1, visibleIds), false, 'cannot move visible top item up');
    assert.equal(moveSectionOrder(visSettings, 'g2', 1, visibleIds), false, 'cannot move visible bottom item down');
    assert.equal(moveSectionOrder(visSettings, 'g2', -1, visibleIds), true, 'single click moves g2 above g1');
    assert.deepEqual(visSettings.groups.map((g) => g.id), ['g2', 'g1']);

    // Now test skipping hidden __ungrouped__ between __char__ and g2:
    // Visible list: [__char__, g2, g1]
    assert.equal(moveSectionOrder(visSettings, 'g2', -1, [SPECIAL_GROUPS.CHARACTER, 'g2', 'g1']), true);
    assert.equal(visSettings.sectionOrder[0], 'g2', 'g2 jumps directly past hidden __ungrouped__ to top');
});

test('M1 R3: include_in_char override, similar-name scan matching, coverage, and F3.3 computeScanPromptState', () => {
    // 1. charBookOverrides === 'include_in_char' classifies unbound book into 角色世界书
    const settings = normalizeSettings({
        groups: [{ id: 'g1', name: '文风' }],
        charBookOverrides: { '同名角色甲': 'include_in_char' },
    });
    const cls = classifyWorldbooks({
        worldNames: ['同名角色甲', '普通书'],
        bindingMap: new Map(),
        settings,
    });
    const hanMeta = cls.byName.get('同名角色甲');
    assert.equal(hanMeta?.groupId, SPECIAL_GROUPS.CHARACTER);
    assert.equal(hanMeta?.isInCharGroup, true);
    assert.equal(hanMeta?.isCharIncluded, true);
    assert.equal(hanMeta?.isCharManualOverride, true);
    assert.equal(hanMeta?.isCharBound, false);
    assert.equal(hanMeta?.primaryTitle, '同名角色甲');

    // Moving an include_in_char book back to 未分组 or custom group clears the override cleanly
    const sCopy = deepClone(settings);
    applyAiOrganizeProposals(sCopy, [{ realName: '同名角色甲', group: '未分组' }]);
    assert.equal(sCopy.charBookOverrides['同名角色甲'], undefined);

    const sMove = deepClone(settings);
    moveBooksToNamedGroup(sMove, ['同名角色甲'], '文风', { targetGroupId: 'g1' });
    assert.equal(sMove.assignments['同名角色甲'], 'g1');
    assert.equal(sMove.charBookOverrides['同名角色甲'], undefined);

    // Rename migration, prune, and export/import round-trip preserve include_in_char
    migrateSettingsOnWorldRename(settings, '同名角色甲', '同名角色甲_新');
    assert.equal(settings.charBookOverrides['同名角色甲_新'], 'include_in_char');
    const exp = exportConfigData(settings);
    const imp = normalizeSettings(null);
    assert.equal(importConfigData(imp, exp).ok, true);
    assert.equal(imp.charBookOverrides['同名角色甲_新'], 'include_in_char');
    assert.equal(pruneStaleWorldbookSettings(imp, new Set(['普通书'])), true);
    assert.equal(imp.charBookOverrides['同名角色甲_新'], undefined);

    // 2. normalizeMatchName & findUnboundCharacterNameMatches
    assert.equal(normalizeMatchName('带有较长标题的山景测试角色⛰️ (1)'), '带有较长标题的山景测试角色');
    assert.equal(normalizeMatchName('副本角色丙（2）'), '副本角色丙');

    const chars = [
        { avatar: '同名角色甲.png', name: '同名角色甲', shallow: false, data: { extensions: { world: '' } } },
        { avatar: 'pei_card.png', name: '副本角色丙 (1)', shallow: false, data: { extensions: { world: '' } } },
        { avatar: '浅加载角色丁.png', name: '未知代号', shallow: true },
        { avatar: 'Mountain.png', name: '带有较长标题的山景测试角色', shallow: false, data: { extensions: { world: '' } } },
        { avatar: 'Bound.png', name: '已绑定角色', shallow: false, data: { extensions: { world: '已绑定世界书' } } },
        { avatar: 'Short.png', name: 'A', shallow: false, data: { extensions: { world: '' } } },
        { avatar: 'Digits.png', name: '123', shallow: false, data: { extensions: { world: '' } } },
        { avatar: 'Latin2.png', name: 'ab', shallow: false, data: { extensions: { world: '' } } },
    ];
    const bindingMap = new Map([
        ['已绑定世界书', [{ avatar: 'Bound.png', charName: '已绑定角色', source: 'primary' }]],
    ]);
    const matches = findUnboundCharacterNameMatches(
        [
            '同名角色甲',
            '副本角色丙',
            '浅加载角色丁',
            '带有较长标题的山景测试角色⛰️',
            '已绑定世界书',
            'A',
            '123',
            'ab!',
            '排除测试',
        ],
        chars,
        bindingMap,
        { charBookOverrides: { 排除测试: 'exclude_from_char' }, cachedCharBindings: {} },
    );
    const byWorld = new Map(matches.map((m) => [m.worldName, m]));
    assert.equal(byWorld.get('同名角色甲')?.reason, 'exact_name');
    assert.equal(byWorld.get('副本角色丙')?.reason, 'normalized_name');
    assert.equal(byWorld.get('浅加载角色丁')?.reason, 'unscanned_card_name');
    assert.equal(byWorld.get('浅加载角色丁')?.hasUnscanned, true);
    assert.equal(byWorld.get('带有较长标题的山景测试角色⛰️')?.reason, 'normalized_name');
    assert.equal(byWorld.has('已绑定世界书'), false);
    assert.equal(byWorld.has('A'), false);
    assert.equal(byWorld.has('123'), false);
    assert.equal(byWorld.has('ab!'), false);

    // 3. summarizeCharacterWorldCoverage surfaces embeddedNameMatches even without primary/extra + unboundNameMatches
    const embOnlyChars = [
        { avatar: 'EmbOnly.png', name: '孤立内嵌', shallow: false, data: {} },
        { avatar: 'Han.png', name: '同名角色甲', shallow: false, data: {} },
    ];
    const embCov = summarizeCharacterWorldCoverage({
        characters: embOnlyChars,
        bindingMap: new Map([
            ['孤立内嵌书', [{ avatar: 'EmbOnly.png', charName: '孤立内嵌', source: 'embedded' }]],
        ]),
        worldNamesSet: new Set(['孤立内嵌书', '同名角色甲']),
    });
    assert.equal(embCov.embeddedNameMatches.length, 1);
    assert.equal(embCov.embeddedNameMatches[0].hasRealBinding, false);
    assert.equal(embCov.unboundNameMatches.length, 1);
    assert.equal(embCov.unboundNameMatches[0].worldName, '同名角色甲');

    // 4. F3.3 computeScanPromptState: autoScan ON vs OFF + confirmation dismissal
    assert.equal(DEFAULT_SETTINGS.autoScanNewCharacters, true);

    // Case A: autoScan ON, unscanned shallow cards exist, 0 same-name books -> silent (shouldShowPrompt === false)
    const silentState = computeScanPromptState({
        worldNames: ['通用设定'],
        characters: [{ avatar: 'Lazy.png', name: '新角色', shallow: true }],
        bindingMap: new Map(),
        settings: normalizeSettings({ autoScanNewCharacters: true }),
    });
    assert.equal(silentState.unscannedShallowCount, 1);
    assert.equal(silentState.manualScanRequiredCount, 0);
    assert.equal(silentState.shouldShowPrompt, false);
    assert.equal(silentState.promptKind, 'none');

    // Case B: autoScan ON, unbound same-name book exists -> prompts user for confirmation
    const sameNameState = computeScanPromptState({
        worldNames: ['同名角色甲'],
        characters: [{ avatar: 'Han.png', name: '同名角色甲', shallow: false, data: {} }],
        bindingMap: new Map(),
        settings: normalizeSettings({ autoScanNewCharacters: true }),
    });
    assert.equal(sameNameState.shouldShowPrompt, true);
    assert.equal(sameNameState.promptKind, 'same_name');
    assert.equal(sameNameState.sameNameNeedConfirmCount, 1);
    assert.equal(sameNameState.badgeCount, 0);

    // After user confirms include_in_char -> prompt disappears
    const confirmedState = computeScanPromptState({
        worldNames: ['同名角色甲'],
        characters: [{ avatar: 'Han.png', name: '同名角色甲', shallow: false, data: {} }],
        bindingMap: new Map(),
        settings: normalizeSettings({
            autoScanNewCharacters: true,
            charBookOverrides: { 同名角色甲: 'include_in_char' },
        }),
    });
    assert.equal(confirmedState.shouldShowPrompt, false);
    assert.equal(confirmedState.sameNameNeedConfirmCount, 0);

    // Case C: autoScan explicitly OFF and unscanned shallow cards > 0 -> manual scan prompt
    const manualOffState = computeScanPromptState({
        worldNames: ['通用设定'],
        characters: [{ avatar: 'Lazy.png', name: '新角色', shallow: true }],
        bindingMap: new Map(),
        settings: normalizeSettings({ autoScanNewCharacters: false }),
    });
    assert.equal(manualOffState.shouldShowPrompt, true);
    assert.equal(manualOffState.promptKind, 'manual_scan');
    assert.equal(manualOffState.manualScanRequiredCount, 1);
    assert.equal(manualOffState.badgeCount, 1);
});

test('M1 F3.3 index.js catch-up batch extracts { scanned } object and updates cachedCharBindings', async () => {
    const prevDoc = globalThis.document;
    globalThis.document = { readyState: 'loading', addEventListener() {} };
    try {
        const indexMod = await import('../index.js');
        assert.deepEqual(
            indexMod.extractScannedCharacters({ scanned: [{ avatar: 'A.png' }], done: 1, cancelled: false }),
            [{ avatar: 'A.png' }],
        );
        assert.deepEqual(indexMod.extractScannedCharacters([{ avatar: 'B.png' }]), [{ avatar: 'B.png' }]);

        const settings = normalizeSettings({ autoScanNewCharacters: true, hasDoneInitialAutoScan: false });
        const attempted = new Set();
        const res = await indexMod.runSilentAutoScanBatch({
            targets: [{ chid: 0, avatar: 'Lazy1.png', name: '懒加载角色1' }],
            batchSize: 1,
            yieldMs: 20,
            scanFn: async () => ({
                scanned: [
                    {
                        avatar: 'Lazy1.png',
                        name: '懒加载角色1',
                        shallow: false,
                        wboCompactSummary: true,
                        primary: '懒加载世界书',
                        embedded: null,
                        embeddedEntryCount: 0,
                    },
                ],
                done: 1,
                cancelled: false,
            }),
            getSettingsFn: () => settings,
            saveSettingsFn: () => {},
            attemptedSet: attempted,
            markInitialDone: true,
            checkInitialized: () => true,
        });
        assert.equal(res.scannedCount, 1);
        assert.equal(res.changed, true);
        assert.equal(settings.hasDoneInitialAutoScan, true);
        assert.equal(settings.cachedCharBindings['Lazy1.png']?.primary, '懒加载世界书');
        assert.equal(settings.cachedCharBindings['Lazy1.png']?.scanned, true);
        assert.equal(attempted.has('Lazy1.png'), true);

        // When autoScanNewCharacters is false, catch-up skips without calling scanFn
        const offSettings = normalizeSettings({ autoScanNewCharacters: false });
        let called = false;
        const skippedRes = await indexMod.runSilentAutoScanBatch({
            targets: [{ chid: 0, avatar: 'Lazy2.png', name: '懒加载角色2' }],
            scanFn: async () => {
                called = true;
                return { scanned: [], done: 0, cancelled: false };
            },
            getSettingsFn: () => offSettings,
            saveSettingsFn: () => {},
            attemptedSet: new Set(),
            checkInitialized: () => true,
        });
        assert.equal(called, false);
        assert.equal(skippedRes.skipped, true);

        // Cancelled batch must NOT mark hasDoneInitialAutoScan or poison remaining avatars
        const cancelSettings = normalizeSettings({ autoScanNewCharacters: true, hasDoneInitialAutoScan: false });
        const cancelAttempted = new Set();
        const cancelRes = await indexMod.runSilentAutoScanBatch({
            targets: [
                { chid: 0, avatar: 'C1.png', name: 'C1' },
                { chid: 1, avatar: 'C2.png', name: 'C2' },
            ],
            scanFn: async () => ({
                scanned: [{ avatar: 'C1.png', name: 'C1', shallow: false, wboCompactSummary: true, primary: '书C1', embedded: null, embeddedEntryCount: 0 }],
                done: 1,
                cancelled: true,
            }),
            getSettingsFn: () => cancelSettings,
            saveSettingsFn: () => {},
            attemptedSet: cancelAttempted,
            markInitialDone: true,
            checkInitialized: () => true,
        });
        assert.equal(cancelRes.cancelled, true);
        assert.equal(cancelSettings.hasDoneInitialAutoScan, false);
        assert.equal(cancelAttempted.has('C1.png'), true);
        assert.equal(cancelAttempted.has('C2.png'), false);
    } finally {
        if (prevDoc === undefined) delete globalThis.document;
        else globalThis.document = prevDoc;
    }
});

test('M1 R4: entry displayIndex projection, sortEntryListItems, computeReorderedEntries, reorderEntryUids & syncEntryOrderOnDrag', () => {
    // 1. DEFAULT_SETTINGS.syncEntryOrderOnDrag & round-trip
    assert.equal(DEFAULT_SETTINGS.syncEntryOrderOnDrag, false);
    const cfg = normalizeSettings({ syncEntryOrderOnDrag: true });
    assert.equal(cfg.syncEntryOrderOnDrag, true);
    const exp = exportConfigData(cfg);
    assert.equal(exp.data.syncEntryOrderOnDrag, true);
    const imp = normalizeSettings(null);
    importConfigData(imp, exp);
    assert.equal(imp.syncEntryOrderOnDrag, true);

    // 2. extractEntryListItems projects displayIndex safely (never null -> 0, keeps 0, respects extensions.display_index)
    const payload = {
        entries: {
            0: { uid: 0, comment: '显式零', displayIndex: 0, order: 300 },
            1: { uid: 1, comment: '扩展排序', displayIndex: null, extensions: { display_index: 5 }, order: 50 },
            2: { uid: 2, comment: '空串回退UID', displayIndex: '', order: 10 },
        },
    };
    const listRes = extractEntryListItems(payload);
    assert.deepEqual(
        listRes.items.map((x) => [x.uid, x.displayIndex]),
        [['0', 0], ['2', 2], ['1', 5]],
    );

    // 3. sortEntryListItems non-mutating across modes
    const snapshotUids = listRes.items.map((x) => x.uid);
    assert.deepEqual(sortEntryListItems(listRes.items, 'order').map((x) => x.uid), ['2', '1', '0']);
    assert.deepEqual(sortEntryListItems(listRes.items, 'title').map((x) => x.title), ['空串回退UID', '扩展排序', '显式零']);
    assert.deepEqual(sortEntryListItems(listRes.items, 'unknown_mode').map((x) => x.uid), ['0', '2', '1']);
    assert.deepEqual(listRes.items.map((x) => x.uid), snapshotUids, 'sortEntryListItems must not mutate input');

    // 4. computeReorderedEntries: full + partial slot-preserving merge + minDisplayIndex + syncOrder
    const fullEntries = {
        0: { uid: 0, displayIndex: 10, order: 200, comment: 'A' },
        1: { uid: 1, displayIndex: 11, order: 150, comment: 'B' },
        2: { uid: 2, displayIndex: 12, order: 300, comment: 'C' },
    };
    const partialPlan = computeReorderedEntries(fullEntries, ['2', '0'], { syncOrder: false });
    // Slot 0 ('0') and Slot 2 ('2') swap while middle Slot 1 ('1') stays in place; minDisplayIndex 10 preserved
    assert.deepEqual(partialPlan.orderedUids, ['2', '1', '0']);
    assert.equal(partialPlan.updatesByUid['2'].displayIndex, 10);
    assert.equal(partialPlan.updatesByUid['1'].displayIndex, 11);
    assert.equal(partialPlan.updatesByUid['0'].displayIndex, 12);
    assert.equal(partialPlan.updatesByUid['2'].order, undefined);

    const syncedPlan = computeReorderedEntries(fullEntries, ['2', '1', '0'], { syncOrder: true });
    assert.equal(syncedPlan.updatesByUid['2'].order, 150);
    assert.equal(syncedPlan.updatesByUid['1'].order, 151);
    assert.equal(syncedPlan.updatesByUid['0'].order, 152);

    // 5. reorderEntryUids on objects & string[]
    const dragRes = reorderEntryUids(fullEntries, '2', '0', false, { syncOrder: true });
    assert.equal(dragRes.changed, true);
    assert.deepEqual(dragRes.orderedUids, ['2', '0', '1']);
    assert.deepEqual(dragRes.displayIndexMap, { 2: 10, 0: 11, 1: 12 });
    assert.deepEqual(dragRes.orderMap, { 2: 150, 0: 151, 1: 152 });

    const strDrag = reorderEntryUids(['u1', 'u2', 'u3'], 'u1', 'u3', 'after');
    assert.equal(strDrag.changed, true);
    assert.deepEqual(strDrag.orderedUids, ['u2', 'u3', 'u1']);
    assert.deepEqual(strDrag.displayIndexMap, { u2: 0, u3: 1, u1: 2 });
});

test('M1 R4 host: saveWorldbookEntriesOrderDirect updates displayIndex, extensions.display_index, originalData, optional order, cache & events', async () => {
    const hostMod = await import('../src/host.js');
    const prevST = globalThis.SillyTavern;
    const prevFetch = globalThis.fetch;
    const prevWin = globalThis.window;
    const prevCustomEvent = globalThis.CustomEvent;

    const emittedHost = [];
    const emittedBridge = [];
    let savedBodies = [];

    const makeBook = (arrayOrig = true) => ({
        entries: {
            0: { uid: 0, displayIndex: 0, order: 200, comment: '甲', content: 'body0', unknownProp: 'keep0', extensions: { display_index: 0, custom: 1 } },
            1: { uid: 1, displayIndex: 1, order: 100, comment: '乙', content: 'body1', extensions: { display_index: 1 } },
            2: { uid: 2, displayIndex: 2, order: 300, comment: '丙', content: 'body2', extensions: { display_index: 2 } },
        },
        originalData: {
            entries: arrayOrig
                ? [
                    { uid: 0, insertion_order: 200, extensions: { display_index: 0, keep: 'a' } },
                    { uid: 1, insertion_order: 100, extensions: { display_index: 1 } },
                    { uid: 2, insertion_order: 300, extensions: { display_index: 2 } },
                ]
                : {
                    0: { uid: 0, order: 200, extensions: { display_index: 0 } },
                    1: { uid: 1, order: 100, extensions: { display_index: 1 } },
                    2: { uid: 2, order: 300, extensions: { display_index: 2 } },
                },
        },
    });

    let currentMockBook = makeBook(true);
    let editShouldFail = false;

    globalThis.SillyTavern = {
        getContext: () => ({
            getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
            extensionSettings: {},
            eventTypes: { WORLDINFO_UPDATED: 'worldinfo_updated' },
            eventSource: {
                emit: async (ev, name) => {
                    emittedHost.push({ ev, name });
                },
            },
        }),
    };
    globalThis.CustomEvent = class MockCustomEvent {
        constructor(type, init = {}) {
            this.type = type;
            this.detail = init.detail;
        }
    };
    globalThis.window = {
        dispatchEvent: (ev) => {
            emittedBridge.push(ev);
        },
    };
    globalThis.fetch = async (url, init) => {
        const u = String(url);
        if (u.includes('/api/worldinfo/get')) {
            return { ok: true, json: async () => deepClone(currentMockBook) };
        }
        if (u.includes('/api/worldinfo/edit')) {
            if (editShouldFail) return { ok: false, status: 500 };
            savedBodies.push(JSON.parse(init.body));
            return { ok: true, json: async () => ({ ok: true }) };
        }
        return { ok: false, status: 404 };
    };

    try {
        // 1. syncOrder: false preserves original order & unknown fields, updates displayIndex + extensions.display_index + array originalData
        const res1 = await hostMod.saveWorldbookEntriesOrderDirect('顺序测试书', ['2', '0', '1'], { syncOrder: false });
        assert.equal(res1.ok, true);
        assert.equal(res1.updatedCount, 3);
        const body1 = savedBodies[0];
        assert.equal(body1.name, '顺序测试书');
        assert.equal(body1.data.entries['2'].displayIndex, 0);
        assert.equal(body1.data.entries['2'].extensions.display_index, 0);
        assert.equal(body1.data.entries['2'].order, 300, 'order untouched when syncOrder is false');
        assert.equal(body1.data.entries['0'].displayIndex, 1);
        assert.equal(body1.data.entries['0'].unknownProp, 'keep0');
        assert.equal(body1.data.entries['0'].extensions.custom, 1);
        assert.equal(body1.data.originalData.entries[0].extensions.display_index, 1);
        assert.equal(body1.data.originalData.entries[0].extensions.keep, 'a');
        assert.equal(body1.data.originalData.entries[0].insertion_order, 200);
        assert.equal(emittedHost.length, 1);
        assert.equal(emittedBridge.some((e) => e.type === 'wbo:entries-updated'), true);

        // 2. syncOrder: true with Object-style originalData.entries updates order sequentially
        currentMockBook = makeBook(false);
        const res2 = await hostMod.saveWorldbookEntriesOrderDirect('顺序测试书', ['2', '1', '0'], { syncOrder: true });
        assert.equal(res2.ok, true);
        const body2 = savedBodies[1];
        assert.equal(body2.data.entries['2'].displayIndex, 0);
        assert.equal(body2.data.entries['2'].order, 100);
        assert.equal(body2.data.entries['1'].order, 101);
        assert.equal(body2.data.entries['0'].order, 102);
        assert.equal(body2.data.originalData.entries['2'].order, 100);
        assert.equal(body2.data.originalData.entries['2'].extensions.display_index, 0);

        // 3. Error paths
        assert.equal((await hostMod.saveWorldbookEntriesOrderDirect('', ['0'])).ok, false);
        assert.equal((await hostMod.saveWorldbookEntriesOrderDirect('顺序测试书', [])).ok, false);
        assert.equal((await hostMod.saveWorldbookEntriesOrderDirect('顺序测试书', ['999'])).ok, false);
        editShouldFail = true;
        const failRes = await hostMod.saveWorldbookEntriesOrderDirect('顺序测试书', ['0', '1', '2']);
        assert.equal(failRes.ok, false);
        assert.equal(failRes.updatedCount, 0);
    } finally {
        if (prevST === undefined) delete globalThis.SillyTavern; else globalThis.SillyTavern = prevST;
        if (prevFetch === undefined) delete globalThis.fetch; else globalThis.fetch = prevFetch;
        if (prevWin === undefined) delete globalThis.window; else globalThis.window = prevWin;
        if (prevCustomEvent === undefined) delete globalThis.CustomEvent; else globalThis.CustomEvent = prevCustomEvent;
    }
});

test('M1 R2 regression: Array-backed entries computeReorderedEntries, extractSingleEntryForEdit & saveWorldbookEntriesOrderDirect', async () => {
    // 1. computeReorderedEntries on Array-backed entries uses real array index as `key`, not `uid`
    const nonContiguousArr = [
        { uid: 10, displayIndex: 0, order: 200, comment: '甲' },
        { uid: 20, displayIndex: 1, order: 100, comment: '乙' },
    ];
    const arrPlan = computeReorderedEntries(nonContiguousArr, ['20', '10'], { syncOrder: false });
    assert.deepEqual(arrPlan.orderedUids, ['20', '10']);
    assert.equal(arrPlan.updatesByUid['20'].key, '1');
    assert.equal(arrPlan.updatesByUid['20'].displayIndex, 0);
    assert.equal(arrPlan.updatesByUid['10'].key, '0');
    assert.equal(arrPlan.updatesByUid['10'].displayIndex, 1);

    // extractSingleEntryForEdit also resolves swapped-UID Array entries accurately
    const swappedPayload = {
        entries: [
            { uid: 1, comment: 'FirstSlotIsUid1', content: 'C1' },
            { uid: 0, comment: 'SecondSlotIsUid0', content: 'C0' },
        ],
    };
    assert.equal(extractSingleEntryForEdit(swappedPayload, '0')?.comment, 'SecondSlotIsUid0');
    assert.equal(extractSingleEntryForEdit(swappedPayload, '1')?.comment, 'FirstSlotIsUid1');

    // 2. saveWorldbookEntriesOrderDirect on Array-backed data.entries (non-contiguous & swapped UIDs)
    const hostMod = await import('../src/host.js');
    const prevST = globalThis.SillyTavern;
    const prevFetch = globalThis.fetch;
    const prevWin = globalThis.window;
    const prevCustomEvent = globalThis.CustomEvent;

    let currentBook = null;
    const savedBodies = [];

    globalThis.SillyTavern = {
        getContext: () => ({
            getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
            extensionSettings: {},
            eventTypes: {},
            eventSource: null,
        }),
    };
    globalThis.CustomEvent = class MockCustomEvent {
        constructor(type, init = {}) {
            this.type = type;
            this.detail = init.detail;
        }
    };
    globalThis.window = { dispatchEvent() {} };
    globalThis.fetch = async (url, init) => {
        const u = String(url);
        if (u.includes('/api/worldinfo/get')) {
            return { ok: true, json: async () => deepClone(currentBook) };
        }
        if (u.includes('/api/worldinfo/edit')) {
            savedBodies.push(JSON.parse(init.body));
            return { ok: true, json: async () => ({ ok: true }) };
        }
        return { ok: false, status: 404 };
    };

    try {
        // Case A: Non-contiguous UIDs [{uid:10},{uid:20}] with syncOrder: false & syncOrder: true
        currentBook = {
            entries: [
                { uid: 10, displayIndex: 0, order: 200, comment: 'A' },
                { uid: 20, displayIndex: 1, order: 100, comment: 'B' },
            ],
        };
        const resA = await hostMod.saveWorldbookEntriesOrderDirect('数组非连续', ['20', '10'], { syncOrder: false });
        assert.equal(resA.ok, true);
        assert.equal(resA.updatedCount, 2);
        const savedA = savedBodies[0].data.entries;
        assert.equal(savedA[0].uid, 10);
        assert.equal(savedA[0].displayIndex, 1);
        assert.equal(savedA[0].extensions.display_index, 1);
        assert.equal(savedA[0].order, 200);
        assert.equal(savedA[1].uid, 20);
        assert.equal(savedA[1].displayIndex, 0);
        assert.equal(savedA[1].extensions.display_index, 0);
        assert.equal(savedA[1].order, 100);

        const resASync = await hostMod.saveWorldbookEntriesOrderDirect('数组非连续', ['20', '10'], { syncOrder: true });
        assert.equal(resASync.ok, true);
        const savedASync = savedBodies[1].data.entries;
        assert.equal(savedASync[1].displayIndex, 0);
        assert.equal(savedASync[1].order, 100);
        assert.equal(savedASync[0].displayIndex, 1);
        assert.equal(savedASync[0].order, 101);

        // Case B: Swapped UIDs [{uid:1},{uid:0}] (no cross-entry corruption)
        currentBook = {
            entries: [
                { uid: 1, displayIndex: 0, order: 300, comment: 'Keep1' },
                { uid: 0, displayIndex: 1, order: 150, comment: 'Keep0' },
            ],
        };
        const resB = await hostMod.saveWorldbookEntriesOrderDirect('数组错位UID', ['0', '1'], { syncOrder: true });
        assert.equal(resB.ok, true);
        const savedB = savedBodies[2].data.entries;
        assert.equal(savedB[0].uid, 1);
        assert.equal(savedB[0].comment, 'Keep1');
        assert.equal(savedB[0].displayIndex, 1);
        assert.equal(savedB[0].extensions.display_index, 1);
        assert.equal(savedB[0].order, 151);
        assert.equal(savedB[1].uid, 0);
        assert.equal(savedB[1].comment, 'Keep0');
        assert.equal(savedB[1].displayIndex, 0);
        assert.equal(savedB[1].extensions.display_index, 0);
        assert.equal(savedB[1].order, 150);
    } finally {
        if (prevST === undefined) delete globalThis.SillyTavern; else globalThis.SillyTavern = prevST;
        if (prevFetch === undefined) delete globalThis.fetch; else globalThis.fetch = prevFetch;
        if (prevWin === undefined) delete globalThis.window; else globalThis.window = prevWin;
        if (prevCustomEvent === undefined) delete globalThis.CustomEvent; else globalThis.CustomEvent = prevCustomEvent;
    }
});

test('M1 R2 regression: importConfigData migrates pre-v3 backups omitting sectionOrderVersion while preserving custom orders', () => {
    // 1. Legacy v2 default backup omitting sectionOrderVersion migrates into active v3 settings
    const s1 = normalizeSettings(null);
    assert.equal(s1.sectionOrderVersion, 3);
    const legacyV2Backup = {
        format: 'worldbook-organizer-backup',
        version: 1,
        data: {
            groups: [{ id: 'g1', name: '文风' }, { id: 'g2', name: '剧情' }],
            sectionOrder: ['g1', 'g2', SPECIAL_GROUPS.UNGROUPED, SPECIAL_GROUPS.CHARACTER],
            assignments: {},
            aliases: {},
        },
    };
    assert.equal(importConfigData(s1, legacyV2Backup).ok, true);
    assert.equal(s1.sectionOrderVersion, 3);
    assert.deepEqual(s1.sectionOrder, [SPECIAL_GROUPS.CHARACTER, SPECIAL_GROUPS.UNGROUPED, 'g1', 'g2']);

    // 2. Legacy v1 default backup [g1, g2, __char__, __ungrouped__] omitting sectionOrderVersion also migrates to v3
    const s2 = normalizeSettings(null);
    const legacyV1Backup = {
        format: 'worldbook-organizer-backup',
        version: 1,
        data: {
            groups: [{ id: 'g1', name: '文风' }, { id: 'g2', name: '剧情' }],
            sectionOrder: ['g1', 'g2', SPECIAL_GROUPS.CHARACTER, SPECIAL_GROUPS.UNGROUPED],
            assignments: {},
            aliases: {},
        },
    };
    assert.equal(importConfigData(s2, legacyV1Backup).ok, true);
    assert.deepEqual(s2.sectionOrder, [SPECIAL_GROUPS.CHARACTER, SPECIAL_GROUPS.UNGROUPED, 'g1', 'g2']);

    // 3. Explicit custom order omitting sectionOrderVersion is preserved
    const s3 = normalizeSettings(null);
    const customLegacyBackup = {
        format: 'worldbook-organizer-backup',
        version: 1,
        data: {
            groups: [{ id: 'g1', name: '文风' }, { id: 'g2', name: '剧情' }],
            sectionOrder: ['g2', SPECIAL_GROUPS.UNGROUPED, 'g1', SPECIAL_GROUPS.CHARACTER],
            assignments: {},
            aliases: {},
        },
    };
    assert.equal(importConfigData(s3, customLegacyBackup).ok, true);
    assert.deepEqual(s3.sectionOrder, ['g2', SPECIAL_GROUPS.UNGROUPED, 'g1', SPECIAL_GROUPS.CHARACTER]);

    // 4. Backup omitting BOTH sectionOrder and sectionOrderVersion keeps v3 ordering
    const s4 = normalizeSettings(null);
    const noOrderBackup = {
        format: 'worldbook-organizer-backup',
        version: 1,
        data: {
            groups: [{ id: 'g1', name: '文风' }],
            assignments: {},
            aliases: {},
        },
    };
    assert.equal(importConfigData(s4, noOrderBackup).ok, true);
    assert.equal(s4.sectionOrderVersion, 3);
    assert.deepEqual(s4.sectionOrder, [SPECIAL_GROUPS.CHARACTER, SPECIAL_GROUPS.UNGROUPED, 'g1']);
});

test('M1 R2 regression: applyAiOrganizeProposals assigns unbound books to 角色世界书 via include_in_char and respects isCharBoundFn', () => {
    // 1. Without isCharBoundFn: unbound book gets include_in_char and classifies into CHARACTER
    const s1 = normalizeSettings({
        groups: [{ id: 'g1', name: '旧组' }],
        assignments: { UnboundTarget: 'g1' },
    });
    const res1 = applyAiOrganizeProposals(s1, [{ realName: 'UnboundTarget', group: '角色世界书' }]);
    assert.equal(res1.appliedCount, 1);
    assert.equal(s1.assignments.UnboundTarget, undefined);
    assert.equal(s1.charBookOverrides.UnboundTarget, 'include_in_char');
    const cls1 = classifyWorldbooks({
        worldNames: ['UnboundTarget'],
        bindingMap: new Map(),
        settings: s1,
    });
    assert.equal(cls1.byName.get('UnboundTarget')?.groupId, SPECIAL_GROUPS.CHARACTER);
    assert.equal(cls1.byName.get('UnboundTarget')?.isInCharGroup, true);

    // 2. With isCharBoundFn (3rd fn arg or options.isCharBoundFn): bound clears override, unbound gets include_in_char
    const s2 = normalizeSettings({
        groups: [{ id: 'g1', name: '旧组' }],
        assignments: { BoundBook: 'g1', UnboundBook: 'g1' },
        charBookOverrides: { BoundBook: 'exclude_from_char', UnboundBook: 'exclude_from_char' },
    });
    const isBound = (name) => name === 'BoundBook';
    applyAiOrganizeProposals(
        s2,
        [
            { realName: 'BoundBook', group: '角色世界书' },
            { realName: 'UnboundBook', group: '角色世界书' },
        ],
        { label: '回归测试', isCharBoundFn: isBound },
    );
    assert.equal(s2.charBookOverrides.BoundBook, undefined);
    assert.equal(s2.charBookOverrides.UnboundBook, 'include_in_char');

    // Direct function as 3rd parameter also supported
    const s3 = normalizeSettings({ charBookOverrides: { BoundDirect: 'exclude_from_char' } });
    applyAiOrganizeProposals(
        s3,
        [
            { realName: 'BoundDirect', group: '角色世界书' },
            { realName: 'UnboundDirect', group: '角色世界书' },
        ],
        (name) => name === 'BoundDirect',
    );
    assert.equal(s3.charBookOverrides.BoundDirect, undefined);
    assert.equal(s3.charBookOverrides.UnboundDirect, 'include_in_char');
});

test('M1 R2 regression: normalizeMatchName & findUnboundCharacterNameMatches handle copy suffixes with trailing extensions/emoji/keycaps without stripping 2.0', () => {
    assert.equal(normalizeMatchName('带有较长标题的山景测试角色 (2).png'), '带有较长标题的山景测试角色');
    assert.equal(normalizeMatchName('带有较长标题的山景测试角色 (1)⛰️'), '带有较长标题的山景测试角色');
    assert.equal(normalizeMatchName('测试角色（1）'), '测试角色');
    assert.equal(normalizeMatchName('测试1️⃣'), '测试');
    assert.equal(normalizeMatchName('版本测试角色2.0'), '版本测试角色20');
    assert.equal(normalizeMatchName('版本测试角色 2.0 (1).png'), '版本测试角色20');
    assert.notEqual(normalizeMatchName('版本测试角色2.0'), '版本测试角色');

    const matches = findUnboundCharacterNameMatches(
        [
            '带有较长标题的山景测试角色 (2).png',
            '带有较长标题的山景测试角色 (1)⛰️',
            '测试角色（1）',
            '测试1️⃣',
            '版本测试角色 2.0 (1).png',
            '版本测试角色',
        ],
        [
            { avatar: 'mountain.png', name: '带有较长标题的山景测试角色⛰️', shallow: false, data: {} },
            { avatar: 'testrole.png', name: '测试角色', shallow: true },
            { avatar: 'keycap.png', name: '测试', shallow: false, data: {} },
            { avatar: 'float2.png', name: '版本测试角色2.0', shallow: false, data: {} },
        ],
        new Map(),
        {},
    );
    const byWorld = new Map(matches.map((m) => [m.worldName, m]));
    assert.equal(byWorld.get('带有较长标题的山景测试角色 (2).png')?.avatar, 'mountain.png');
    assert.equal(byWorld.get('带有较长标题的山景测试角色 (1)⛰️')?.avatar, 'mountain.png');
    assert.equal(byWorld.get('测试角色（1）')?.avatar, 'testrole.png');
    assert.equal(byWorld.get('测试1️⃣')?.avatar, 'keycap.png');
    assert.equal(byWorld.get('版本测试角色 2.0 (1).png')?.avatar, 'float2.png');
    assert.equal(byWorld.has('版本测试角色'), false, '版本测试角色 must NOT falsely match 版本测试角色2.0');
});

test('M1 R3 regression: saveWorldbookEntriesOrderDirect hybrid Array entries + Object originalData.entries and swapped-UID Array CRUD', async () => {
    const hostMod = await import('../src/host.js');
    const prevST = globalThis.SillyTavern;
    const prevFetch = globalThis.fetch;
    const prevWin = globalThis.window;
    const prevCustomEvent = globalThis.CustomEvent;

    const books = new Map();
    const emitted = [];

    globalThis.SillyTavern = {
        getContext: () => ({
            getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
            extensionSettings: {},
            eventTypes: {},
            eventSource: null,
        }),
    };
    globalThis.CustomEvent = class MockCustomEvent {
        constructor(type, init = {}) {
            this.type = type;
            this.detail = init.detail;
        }
    };
    globalThis.window = {
        dispatchEvent: (ev) => {
            emitted.push(ev);
            return true;
        },
    };
    globalThis.fetch = async (url, init) => {
        const u = String(url);
        const body = init?.body ? JSON.parse(init.body) : {};
        if (u.includes('/api/worldinfo/get')) {
            const payload = books.get(body.name);
            return payload ? { ok: true, json: async () => deepClone(payload) } : { ok: false, status: 404, json: async () => ({}) };
        }
        if (u.includes('/api/worldinfo/edit')) {
            books.set(body.name, deepClone(body.data));
            return { ok: true, json: async () => ({ ok: true }) };
        }
        return { ok: false, status: 404, json: async () => ({}) };
    };

    try {
        // 1. Hybrid: swapped-UID Array data.entries + UID-keyed Object originalData.entries
        books.set('HybridBook', {
            entries: [
                { uid: 1, displayIndex: 0, order: 300, comment: 'Entry1' },
                { uid: 0, displayIndex: 1, order: 150, comment: 'Entry0' },
            ],
            originalData: {
                entries: {
                    '0': { uid: 0, insertion_order: 150, extensions: { display_index: 1 } },
                    '1': { uid: 1, insertion_order: 300, extensions: { display_index: 0 } },
                },
            },
        });
        const orderRes = await hostMod.saveWorldbookEntriesOrderDirect('HybridBook', ['0', '1'], { syncOrder: true });
        assert.equal(orderRes.ok, true);
        assert.equal(orderRes.updatedCount, 2);
        const hybridSaved = books.get('HybridBook');
        assert.equal(hybridSaved.entries[0].uid, 1);
        assert.equal(hybridSaved.entries[0].displayIndex, 1);
        assert.equal(hybridSaved.entries[0].order, 151);
        assert.equal(hybridSaved.entries[1].uid, 0);
        assert.equal(hybridSaved.entries[1].displayIndex, 0);
        assert.equal(hybridSaved.entries[1].order, 150);
        assert.equal(hybridSaved.originalData.entries['0'].uid, 0);
        assert.equal(hybridSaved.originalData.entries['0'].extensions.display_index, 0);
        assert.equal(hybridSaved.originalData.entries['0'].insertion_order, 150);
        assert.equal(hybridSaved.originalData.entries['1'].uid, 1);
        assert.equal(hybridSaved.originalData.entries['1'].extensions.display_index, 1);
        assert.equal(hybridSaved.originalData.entries['1'].insertion_order, 151);

        // 1b. Hybrid where originalData.entries is keyed by array index or custom keys with `id`
        books.set('HybridIndexOrig', {
            entries: [
                { uid: 1, displayIndex: 0, order: 300 },
                { uid: 0, displayIndex: 1, order: 150 },
            ],
            originalData: {
                entries: {
                    '0': { uid: 1, insertion_order: 300, extensions: { display_index: 0 } },
                    customKey: { id: 0, insertion_order: 150, extensions: { display_index: 1 } },
                },
            },
        });
        const idxOrigRes = await hostMod.saveWorldbookEntriesOrderDirect('HybridIndexOrig', ['0', '1'], { syncOrder: true });
        assert.equal(idxOrigRes.ok, true);
        const idxOrigSaved = books.get('HybridIndexOrig');
        assert.equal(idxOrigSaved.originalData.entries['0'].extensions.display_index, 1);
        assert.equal(idxOrigSaved.originalData.entries['0'].insertion_order, 151);
        assert.equal(idxOrigSaved.originalData.entries.customKey.extensions.display_index, 0);
        assert.equal(idxOrigSaved.originalData.entries.customKey.insertion_order, 150);

        // 1c. Hybrid where originalData.entries['0'] lacks uid/id must NOT be mutated by upd for uid: 1 (key: '0')
        books.set('HybridNoIdOrig', {
            entries: [
                { uid: 1, displayIndex: 0, order: 300 },
                { uid: 0, displayIndex: 1, order: 150 },
            ],
            originalData: {
                entries: {
                    '0': { insertion_order: 999, extensions: { display_index: 9 } },
                },
            },
        });
        const noIdRes = await hostMod.saveWorldbookEntriesOrderDirect('HybridNoIdOrig', ['0', '1'], { syncOrder: true });
        assert.equal(noIdRes.ok, true);
        const noIdSaved = books.get('HybridNoIdOrig');
        assert.equal(noIdSaved.originalData.entries['0'].extensions.display_index, 0);
        assert.equal(noIdSaved.originalData.entries['0'].insertion_order, 150);

        // 2. Swapped-UID Array CRUD: saveWorldbookEntryPatch & deleteWorldbookEntryDirect
        books.set('SwappedCrud', {
            entries: [
                { uid: 1, comment: 'Slot0_Uid1', content: 'C1', key: ['k1'], order: 200 },
                { uid: 0, comment: 'Slot1_Uid0', content: 'C0', key: ['k0'], order: 100 },
            ],
        });
        const patchRes = await hostMod.saveWorldbookEntryPatch('SwappedCrud', '0', { comment: 'Edited_Uid0', content: 'C0_new' });
        assert.equal(patchRes.ok, true);
        assert.equal(patchRes.entry?.uid, '0');
        assert.equal(patchRes.entry?.comment, 'Edited_Uid0');
        const afterPatch = books.get('SwappedCrud');
        assert.equal(afterPatch.entries[0].uid, 1);
        assert.equal(afterPatch.entries[0].comment, 'Slot0_Uid1');
        assert.equal(afterPatch.entries[1].uid, 0);
        assert.equal(afterPatch.entries[1].comment, 'Edited_Uid0');
        assert.equal(afterPatch.entries[1].content, 'C0_new');

        const delRes = await hostMod.deleteWorldbookEntryDirect('SwappedCrud', '0');
        assert.equal(delRes.ok, true);
        assert.equal(delRes.uid, '0');
        const afterDel = books.get('SwappedCrud');
        assert.equal(Array.isArray(afterDel.entries), true);
        assert.equal(afterDel.entries.length, 1);
        assert.equal(afterDel.entries[0]?.uid, 1);
        assert.equal(afterDel.entries[0]?.comment, 'Slot0_Uid1');

        // 3. Object-backed CRUD preserves existing behavior (including entries omitting explicit `uid`)
        books.set('ObjCrud', {
            entries: {
                '0': { comment: 'Obj0', content: 'OC0' },
                '1': { uid: 1, comment: 'Obj1', content: 'OC1' },
            },
        });
        const objPatchRes = await hostMod.saveWorldbookEntryPatch('ObjCrud', '0', { comment: 'Obj0_Edited' });
        assert.equal(objPatchRes.ok, true);
        assert.equal(objPatchRes.entry?.comment, 'Obj0_Edited');
        assert.equal(books.get('ObjCrud').entries['1'].comment, 'Obj1');

        const objDelRes = await hostMod.deleteWorldbookEntryDirect('ObjCrud', '0');
        assert.equal(objDelRes.ok, true);
        assert.equal(Object.hasOwn(books.get('ObjCrud').entries, '0'), false);
        assert.equal(books.get('ObjCrud').entries['1'].comment, 'Obj1');
    } finally {
        if (prevST === undefined) delete globalThis.SillyTavern; else globalThis.SillyTavern = prevST;
        if (prevFetch === undefined) delete globalThis.fetch; else globalThis.fetch = prevFetch;
        if (prevWin === undefined) delete globalThis.window; else globalThis.window = prevWin;
        if (prevCustomEvent === undefined) delete globalThis.CustomEvent; else globalThis.CustomEvent = prevCustomEvent;
    }
});

test('M2 F4.2: #world_info_sort_order & non-worldbook .gr-container-enhanced (fresh and reused) + #world_popup_entries_list isolation', async () => {
    const dom = installMockNativeFilterDom({ innerWidth: 1280, innerHeight: 800 });
    const nativeMod = await import('../src/native-filter.js');
    try {
        const wiDrawer = dom.doc.createElement('div');
        wiDrawer.id = 'WorldInfo';
        const multiSel = dom.doc.createElement('div');
        multiSel.id = 'WIMultiSelector';
        const globalSel = dom.doc.createElement('select');
        globalSel.id = 'world_info';
        globalSel.multiple = true;
        multiSel.appendChild(globalSel);

        const worldPopup = dom.doc.createElement('div');
        worldPopup.id = 'world_popup';

        const editorRow = dom.doc.createElement('div');
        editorRow.className = 'flex-container';
        const editorSel = dom.doc.createElement('select');
        editorSel.id = 'world_editor_select';
        for (const [val, txt] of [['', '--- Pick to Edit ---'], ['0', '书A'], ['1', '书B'], ['2', '书C']]) {
            const opt = dom.doc.createElement('option');
            opt.value = val;
            opt.textContent = txt;
            editorSel.appendChild(opt);
        }
        const editorGrDisplay = dom.doc.createElement('div');
        editorGrDisplay.className = 'gr-select2-display';
        editorRow.appendChild(editorSel);
        editorRow.appendChild(editorGrDisplay);

        const sortRow = dom.doc.createElement('div');
        sortRow.className = 'flex-container';
        const sortSel = dom.doc.createElement('select');
        sortSel.id = 'world_info_sort_order';
        for (const [val, txt] of [['0', 'Search'], ['1', 'Priority'], ['2', 'Custom'], ['3', 'Title A-Z']]) {
            const opt = dom.doc.createElement('option');
            opt.value = val;
            opt.textContent = txt;
            sortSel.appendChild(opt);
        }
        const sortGrDisplay = dom.doc.createElement('div');
        sortGrDisplay.className = 'gr-select2-display';
        const sortS2Container = dom.doc.createElement('span');
        sortS2Container.className = 'select2-container';
        const sortS2Rendered = dom.doc.createElement('span');
        sortS2Rendered.id = 'select2-world_info_sort_order-container';
        sortS2Container.appendChild(sortS2Rendered);
        sortRow.appendChild(sortSel);
        sortRow.appendChild(sortGrDisplay);
        sortRow.appendChild(sortS2Container);

        const entriesList = dom.doc.createElement('div');
        entriesList.id = 'world_popup_entries_list';
        const entryGrDisplay = dom.doc.createElement('div');
        entryGrDisplay.className = 'gr-select2-display';
        entriesList.appendChild(entryGrDisplay);

        worldPopup.appendChild(editorRow);
        worldPopup.appendChild(sortRow);
        worldPopup.appendChild(entriesList);
        wiDrawer.appendChild(multiSel);
        wiDrawer.appendChild(worldPopup);
        dom.doc.body.appendChild(wiDrawer);

        const settings = normalizeSettings({
            groups: [{ id: 'g1', name: '文风', color: '#5b8def', collapsed: false }],
            assignments: { 书A: 'g1' },
            showNativeOptgroups: true,
        });
        const cls = classifyWorldbooks({
            worldNames: ['书A', '书B', '书C'],
            bindingMap: new Map(),
            settings,
        });

        nativeMod.applyAllNativeWorldFilters(cls, settings, { force: true });
        nativeMod.startNativeObservers(() => {});

        // 1. Fresh #world_info_sort_order .gr-container-enhanced is NEVER guarded, enhanced, or closed
        const sortPopover = dom.doc.createElement('div');
        sortPopover.className = 'gr-container-enhanced';
        const sortOptsHost = dom.doc.createElement('div');
        sortOptsHost.className = 'gr-options-list';
        for (const [v, t] of [['0', 'Search'], ['1', 'Priority'], ['2', 'Custom'], ['3', 'Title A-Z']]) {
            const opt = dom.doc.createElement('div');
            opt.className = 'gr-option';
            opt.dataset.value = v;
            opt.textContent = t;
            sortOptsHost.appendChild(opt);
        }
        sortPopover.appendChild(sortOptsHost);
        dom.doc.body.appendChild(sortPopover);

        const bodyObserver = dom.observerInstances.find((o) => o.target === dom.doc.body && o.options?.childList);
        assert.ok(bodyObserver);
        bodyObserver.cb([{ addedNodes: [sortPopover] }]);

        assert.equal(sortPopover.dataset.wboPopoverRole, undefined, 'sort popover must not receive a worldbook role');
        assert.equal(sortPopover.dataset.wboBubbleGuarded, undefined, 'sort popover must not receive bubble guard');
        assert.equal(sortPopover.querySelector('.wbo-gr-pin-btn'), null, 'sort options must not get pin buttons');
        assert.equal(sortPopover.querySelector('.wbo-pop-filter-bar'), null, 'sort popover must not get filter bar');

        // Clicking sort popover option MUST bubble up to documentElement (not stopped by _docDrawerGuardClick)
        let reachedDocClick = false;
        const onDocClick = () => { reachedDocClick = true; };
        dom.doc.addEventListener('click', onDocClick);
        sortOptsHost.firstChild.dispatchEvent(new dom.MockEvent('click', { bubbles: true, cancelable: true }));
        dom.doc.removeEventListener('click', onDocClick);
        assert.equal(reachedDocClick, true, 'clicks inside sort popover must propagate cleanly to host');

        // Clicking sortGrDisplay / sortS2Container / entryGrDisplay must NOT close an open global popover
        const globalEnhanced = dom.doc.createElement('div');
        globalEnhanced.id = 'gr-global-dropdown-container';
        globalEnhanced.className = 'gr-container-enhanced';
        dom.doc.body.appendChild(globalEnhanced);
        sortGrDisplay.dispatchEvent(new dom.MockEvent('pointerdown', { bubbles: true, cancelable: true }));
        sortS2Container.dispatchEvent(new dom.MockEvent('pointerdown', { bubbles: true, cancelable: true }));
        entryGrDisplay.dispatchEvent(new dom.MockEvent('pointerdown', { bubbles: true, cancelable: true }));
        assert.equal(globalEnhanced.isConnected, true, 'clicking sort or entry selectors must not close global worldbook dropdown');

        nativeMod.closeAllOpenWorldDropdowns({ except: 'editor' });
        assert.equal(sortPopover.isConnected, true, 'closeAllOpenWorldDropdowns must preserve sortPopover');

        // Clicking actual editorGrDisplay STILL closes globalEnhanced!
        editorGrDisplay.dispatchEvent(new dom.MockEvent('pointerdown', { bubbles: true, cancelable: true }));
        assert.equal(globalEnhanced.isConnected, false, 'clicking #world_editor_select .gr-select2-display closes global dropdown');

        // 2. Reused container: first enhanced for editor worldbooks, then repurposed for #world_info_sort_order
        const reusedPopover = dom.doc.createElement('div');
        reusedPopover.className = 'gr-container-enhanced';
        const reusedHost = dom.doc.createElement('div');
        reusedHost.className = 'gr-options-list';
        for (const [v, t] of [['0', '书A'], ['1', '书B'], ['2', '书C']]) {
            const opt = dom.doc.createElement('div');
            opt.className = 'gr-option';
            opt.dataset.value = v;
            opt.textContent = t;
            reusedHost.appendChild(opt);
        }
        reusedPopover.appendChild(reusedHost);
        dom.doc.body.appendChild(reusedPopover);
        bodyObserver.cb([{ addedNodes: [reusedPopover] }]);
        assert.equal(reusedPopover.dataset.wboPopoverRole, 'editor');
        assert.equal(reusedPopover.dataset.wboBubbleGuarded, '1');
        assert.ok(reusedPopover.querySelector('.wbo-pop-filter-bar'));

        // Now host reuses the SAME container DOM for #world_info_sort_order!
        reusedHost.innerHTML = '';
        for (const [v, t] of [['0', 'Search'], ['1', 'Priority'], ['2', 'Custom'], ['3', 'Title A-Z']]) {
            const opt = dom.doc.createElement('div');
            opt.className = 'gr-option';
            opt.dataset.value = v;
            opt.textContent = t;
            reusedHost.appendChild(opt);
        }
        const hostObs = dom.observerInstances.find((o) => o.target === reusedHost);
        assert.ok(hostObs, 'optionsHost MutationObserver should be registered');
        hostObs.cb([{ type: 'childList' }]);

        assert.equal(reusedPopover.dataset.wboPopoverRole, undefined, 'reused sort container must clear stale wboPopoverRole');
        assert.equal(reusedPopover.dataset.wboBubbleGuarded, undefined, 'reused sort container must unbind bubble guard');
        assert.equal(reusedPopover.querySelector('.wbo-pop-filter-bar'), null, 'reused sort container must remove filter bar');
        nativeMod.closeAllOpenWorldDropdowns({ except: 'global' });
        assert.equal(reusedPopover.isConnected, true, 'reused sort container must survive closeAllOpenWorldDropdowns');
    } finally {
        nativeMod.teardownNativeFilters();
        dom.restore();
    }
});

test('M2 F4.3: live world_names index sync for _editorDetachedMap, #WIMultiSelector choice pre-attach, and deleted book change sync', async () => {
    const dom = installMockNativeFilterDom({ innerWidth: 1280, innerHeight: 800 });
    const nativeMod = await import('../src/native-filter.js');
    try {
        let liveWorldNames = ['隐藏角色书', '普通书A', '普通书B'];
        globalThis.SillyTavern = {
            getContext: () => ({
                characters: [{ avatar: 'Char.png', name: '测试角色', data: { extensions: { world: '隐藏角色书' } } }],
                characterId: 0,
                extensionSettings: {},
                saveSettingsDebounced: () => {},
                getWorldInfoNames: () => liveWorldNames,
            }),
        };

        const wiDrawer = dom.doc.createElement('div');
        wiDrawer.id = 'WorldInfo';
        const multiSel = dom.doc.createElement('div');
        multiSel.id = 'WIMultiSelector';
        const globalSel = dom.doc.createElement('select');
        globalSel.id = 'world_info';
        globalSel.multiple = true;
        const s2ChoicesWrap = dom.doc.createElement('ul');
        s2ChoicesWrap.className = 'select2-selection__rendered';
        const choiceLi = dom.doc.createElement('li');
        choiceLi.className = 'select2-selection__choice';
        choiceLi.setAttribute('title', '隐藏角色书');
        const choiceDisp = dom.doc.createElement('span');
        choiceDisp.className = 'select2-selection__choice__display';
        choiceDisp.textContent = '隐藏角色书';
        choiceLi.appendChild(choiceDisp);
        s2ChoicesWrap.appendChild(choiceLi);
        multiSel.appendChild(globalSel);
        multiSel.appendChild(s2ChoicesWrap);

        const worldPopup = dom.doc.createElement('div');
        worldPopup.id = 'world_popup';
        const editorSel = dom.doc.createElement('select');
        editorSel.id = 'world_editor_select';
        for (const [val, txt] of [['', '--- Pick to Edit ---'], ['0', '隐藏角色书'], ['1', '普通书A'], ['2', '普通书B']]) {
            const opt = dom.doc.createElement('option');
            opt.value = val;
            opt.textContent = txt;
            editorSel.appendChild(opt);
        }
        worldPopup.appendChild(editorSel);
        wiDrawer.appendChild(multiSel);
        wiDrawer.appendChild(worldPopup);
        dom.doc.body.appendChild(wiDrawer);

        const bindingMap = new Map([['隐藏角色书', [{ avatar: 'Char.png', charName: '测试角色', source: 'primary' }]]]);
        const settings = normalizeSettings({ showCharBooks: false, hideCharBooksByDefault: true, pinCurrentChatCharBookInEditor: false });
        const cls = classifyWorldbooks({ worldNames: liveWorldNames, bindingMap, settings });

        nativeMod.applyAllNativeWorldFilters(cls, settings, { force: true });
        nativeMod.startNativeObservers(() => {});

        // '隐藏角色书' is detached into _editorDetachedMap with initial value '0'
        assert.equal(editorSel.querySelectorAll('option').some((o) => o.textContent === '隐藏角色书'), false);

        // Now live world_names shifts: a new book is inserted at index 0 -> '隐藏角色书' moves from 0 to 1!
        liveWorldNames = ['前置新书', '隐藏角色书', '普通书A', '普通书B'];
        // Clicking #WIMultiSelector .select2-selection__choice must pre-attach '隐藏角色书' with LIVE index '1' (not stale '0')!
        choiceDisp.dispatchEvent(new dom.MockEvent('click', { bubbles: true, cancelable: true }));
        const attachedHiddenOpts = editorSel.querySelectorAll('option').filter((o) => o.textContent === '隐藏角色书');
        assert.equal(attachedHiddenOpts.length, 1, 'must attach exactly 1 option with no duplicates');
        assert.equal(attachedHiddenOpts[0].value, '1', 'pre-attached option must resolve live world_names index 1');

        // Selecting '普通书A', then shifting liveWorldNames -> filter preserves '普通书A' by name with live index '3'
        const optA = editorSel.querySelectorAll('option').find((o) => o.textContent === '普通书A');
        assert.ok(optA);
        optA.selected = true;
        nativeMod.setCurrentlyEditingWorld('普通书A');
        const optPre = dom.doc.createElement('option');
        optPre.value = '0';
        optPre.textContent = '前置新书';
        editorSel.appendChild(optPre);
        liveWorldNames = ['更前新书', '前置新书', '隐藏角色书', '普通书A', '普通书B'];
        const cls2 = classifyWorldbooks({ worldNames: liveWorldNames, bindingMap, settings });
        nativeMod.applyAllNativeWorldFilters(cls2, settings, { force: true });
        assert.equal(editorSel.selectedOptions[0]?.textContent, '普通书A');
        assert.equal(editorSel.value, '3', 'selected option must follow shifted live world_names index 3');

        // Deleting selected '普通书A' from editorSel & world_names clears selection and fires `change` so ST hides stale entries
        let changeFired = 0;
        editorSel.addEventListener('change', () => { changeFired += 1; });
        editorSel.querySelectorAll('option').find((o) => o.textContent === '普通书A')?.remove();
        liveWorldNames = ['更前新书', '前置新书', '隐藏角色书', '普通书B'];
        const cls3 = classifyWorldbooks({ worldNames: liveWorldNames, bindingMap, settings });
        nativeMod.applyAllNativeWorldFilters(cls3, settings, { force: true });
        assert.equal(editorSel.value, '', 'deleted selected book must clear editorSel.value');
        assert.equal(changeFired, 1, 'clearing deleted selected book must fire change event');

        // openWorldInNativeEditor loads hidden book at live index and fires change
        const opened = nativeMod.openWorldInNativeEditor('隐藏角色书');
        assert.equal(opened, true);
        assert.equal(editorSel.selectedOptions[0]?.textContent, '隐藏角色书');
        assert.equal(editorSel.value, '2');
        assert.equal(changeFired, 2);
    } finally {
        nativeMod.teardownNativeFilters();
        dom.restore();
    }
});

test('M2 F2.2, F2.4, F2.5 & v2.35.1: UNGROUPED last across 5 surfaces, zero 当前角色, 当前编辑 bare top + inline badge, ST text() & pin stars preserved', async () => {
    const dom = installMockNativeFilterDom({ innerWidth: 390, innerHeight: 844 });
    const nativeMod = await import('../src/native-filter.js');
    try {
        let currentCharId = 0;
        const characters = [
            { avatar: 'Hero.png', name: '主角', data: { extensions: { world: '当前角色书' } } },
            { avatar: 'Other.png', name: '配角', data: { extensions: { world: '隐藏他角书' } } },
        ];
        globalThis.SillyTavern = {
            getContext: () => ({
                characters,
                characterId: currentCharId,
                extensionSettings: {},
                saveSettingsDebounced: () => {},
            }),
        };

        const wiDrawer = dom.doc.createElement('div');
        wiDrawer.id = 'WorldInfo';
        const multiSel = dom.doc.createElement('div');
        multiSel.id = 'WIMultiSelector';
        const globalSel = dom.doc.createElement('select');
        globalSel.id = 'world_info';
        globalSel.multiple = true;
        const worldNames = ['当前角色书', '隐藏他角书', '未分组书', '文风书', '剧情书'];
        worldNames.forEach((name, idx) => {
            const gOpt = dom.doc.createElement('option');
            gOpt.value = String(idx);
            gOpt.textContent = name;
            globalSel.appendChild(gOpt);
        });
        multiSel.appendChild(globalSel);

        const worldPopup = dom.doc.createElement('div');
        worldPopup.id = 'world_popup';
        const editorSel = dom.doc.createElement('select');
        editorSel.id = 'world_editor_select';
        const ph = dom.doc.createElement('option');
        ph.value = '';
        ph.textContent = '--- Pick to Edit ---';
        editorSel.appendChild(ph);
        worldNames.forEach((name, idx) => {
            const eOpt = dom.doc.createElement('option');
            eOpt.value = String(idx);
            eOpt.textContent = name;
            editorSel.appendChild(eOpt);
        });
        worldPopup.appendChild(editorSel);
        wiDrawer.appendChild(multiSel);
        wiDrawer.appendChild(worldPopup);
        dom.doc.body.appendChild(wiDrawer);

        const bindingMap = new Map([
            ['当前角色书', [{ avatar: 'Hero.png', charName: '主角', source: 'primary' }]],
            ['隐藏他角书', [{ avatar: 'Other.png', charName: '配角', source: 'primary' }]],
        ]);
        // Default v3 sectionOrder: [__char__, __ungrouped__, g1, g2] -> external dropdowns must put __ungrouped__ LAST!
        const settings = normalizeSettings({
            groups: [
                { id: 'g1', name: '文风', color: '#5b8def', collapsed: false },
                { id: 'g2', name: '剧情', color: '#2b8a3e', collapsed: false },
            ],
            assignments: { 文风书: 'g1', 剧情书: 'g2' },
            pinnedBooks: ['剧情书'],
            showCharBooks: false,
            hideCharBooksByDefault: true,
            showNativeOptgroups: true,
            adaptCharBindPopup: true,
        });
        const cls = classifyWorldbooks({ worldNames, bindingMap, settings });

        // Surface 1 & 2: #world_info & #world_editor_select (in Hero.png chat)
        nativeMod.applyAllNativeWorldFilters(cls, settings, { force: true });

        const globalOrder = globalSel.querySelectorAll('option').map((o) => o.textContent);
        assert.deepEqual(globalOrder, ['剧情书', '文风书', '未分组书'], 'global #world_info must put pinned first and UNGROUPED last');

        const editorChildren = editorSel.children;
        assert.equal(editorChildren[0].tagName, 'OPTION', 'placeholder first');
        assert.equal(editorChildren[1].tagName, 'OPTION', 'current-chat char book must be bare top OPTION');
        assert.equal(editorChildren[1].textContent, '当前角色书');
        const editorOptgroups = editorSel.querySelectorAll('optgroup');
        assert.equal(editorOptgroups.some((og) => og.getAttribute('data-wbo-group') === '__current_char__' || og.label.includes('当前角色')), false, 'must NOT wrap in 当前角色 optgroup');
        assert.deepEqual(
            editorOptgroups.map((og) => og.getAttribute('data-wbo-group')),
            ['g1', 'g2', SPECIAL_GROUPS.UNGROUPED],
            'editor optgroups must place custom groups before UNGROUPED',
        );

        // Surface 3: Mobile editor picker (in Hero.png chat)
        const mobileTrigger = dom.doc.getElementById('wbo-mobile-editor-trigger');
        assert.ok(mobileTrigger);
        mobileTrigger.dispatchEvent(new dom.MockEvent('click', { bubbles: true, cancelable: true }));
        const mpOverlay = dom.doc.getElementById('wbo-mobile-picker-overlay');
        assert.ok(mpOverlay);
        const mpPills = mpOverlay.querySelectorAll('.wbo-pill').map((p) => p.getAttribute('data-mp-pill'));
        assert.equal(mpPills.includes('__current_char__'), false, 'mobile pills must not include 当前角色');
        assert.deepEqual(
            mpPills.filter((id) => ['g1', 'g2', SPECIAL_GROUPS.UNGROUPED].includes(id)),
            ['g1', 'g2', SPECIAL_GROUPS.UNGROUPED],
        );
        const mpSecList = mpOverlay.querySelectorAll('#wbo-mp-list > .wbo-mp-sec');
        assert.equal(mpSecList[0].classList.contains('wbo-mp-bare-sec'), true, 'current-chat book renders bare at top');
        assert.equal(mpSecList[0].querySelector('.wbo-mp-sec-head'), null, 'bare top section has no header');
        assert.match(mpSecList[0].querySelector('.wbo-mp-row-title')?.textContent || '', /主角/);
        // Close mobile picker
        mobileTrigger.dispatchEvent(new dom.MockEvent('click', { bubbles: true, cancelable: true }));

        // Surface 4: .character_world primary popup (prioritizeCharGroup: true, no 当前角色)
        const dialog = dom.doc.createElement('dialog');
        const charWorldPopup = dom.doc.createElement('div');
        charWorldPopup.className = 'character_world';
        const primarySel = dom.doc.createElement('select');
        primarySel.className = 'character_world_info_selector';
        for (const [val, txt] of [['', '--- 无主世界书 ---'], ...worldNames.map((n, i) => [String(i), n])]) {
            const opt = dom.doc.createElement('option');
            opt.value = val;
            opt.textContent = txt;
            primarySel.appendChild(opt);
        }
        charWorldPopup.appendChild(primarySel);
        dialog.appendChild(charWorldPopup);
        dom.doc.body.appendChild(dialog);

        nativeMod.startNativeObservers(() => {});
        const bodyObserver = dom.observerInstances.find((o) => o.target === dom.doc.body && o.options?.childList);
        bodyObserver.cb([{ addedNodes: [dialog] }]);
        const popTrigger = charWorldPopup.querySelector('.wbo-popup-select-trigger');
        assert.ok(popTrigger);
        popTrigger.dispatchEvent(new dom.MockEvent('click', { bubbles: true, cancelable: true }));
        const popOverlay = dialog.querySelector('.wbo-mp-backdrop');
        assert.ok(popOverlay);
        const popPills = popOverlay.querySelectorAll('.wbo-pill').map((p) => p.getAttribute('data-pop-pill'));
        assert.equal(popPills.includes('__current_char__'), false, 'popup pills must not include 当前角色');
        assert.deepEqual(
            popPills.filter((id) => [SPECIAL_GROUPS.CHARACTER, 'g1', 'g2', SPECIAL_GROUPS.UNGROUPED].includes(id)),
            [SPECIAL_GROUPS.CHARACTER, 'g1', 'g2', SPECIAL_GROUPS.UNGROUPED],
            'primary popup must put CHARACTER first and UNGROUPED last',
        );
        const popSecs = popOverlay.querySelectorAll('#wbo-pop-list > .wbo-mp-sec');
        assert.equal(popSecs[0].classList.contains('wbo-mp-bare-sec'), true, 'current-chat book renders bare at top in popup');
        popTrigger.dispatchEvent(new dom.MockEvent('click', { bubbles: true, cancelable: true }));

        // F2.5: Switch OUTSIDE Other.png's chat (currentCharId = 0 -> Hero.png) and edit '隐藏他角书'
        const hiddenOpt = editorSel.querySelectorAll('option').find((o) => o.textContent === '隐藏他角书');
        assert.equal(hiddenOpt, undefined);
        nativeMod.openWorldInNativeEditor('隐藏他角书');
        // Now '隐藏他角书' is selected & currently editing while showCharBooks is false and NOT in Other.png's chat
        assert.equal(editorSel.selectedOptions[0]?.textContent, '隐藏他角书', 'ST <option>.textContent must stay exact realName');
        const editingOptEl = editorSel.selectedOptions[0];
        assert.equal(editingOptEl.parentElement, editorSel, 'currently edited hidden char book must be direct child of #world_editor_select (NO 角色世界书 (1) optgroup!)');
        assert.equal(
            editorSel.querySelectorAll('optgroup').some((og) => og.getAttribute('data-wbo-group') === SPECIAL_GROUPS.CHARACTER),
            false,
            'must NEVER wrap currently edited hidden char book inside 角色世界书 (1)',
        );

        // Verify mobile picker shows '隐藏他角书' bare at top with '当前编辑' badge and NO 角色世界书 1 section
        mobileTrigger.dispatchEvent(new dom.MockEvent('click', { bubbles: true, cancelable: true }));
        const mpOverlay2 = dom.doc.getElementById('wbo-mobile-picker-overlay');
        assert.ok(mpOverlay2);
        const mpPills2 = mpOverlay2.querySelectorAll('.wbo-pill').map((p) => p.getAttribute('data-mp-pill'));
        assert.equal(mpPills2.includes(SPECIAL_GROUPS.CHARACTER), false, 'mobile picker must not show 角色世界书 1 pill for bare 当前编辑 book');
        const bareTexts = mpOverlay2.querySelectorAll('.wbo-mp-bare-sec .wbo-mp-row').map((r) => r.textContent);
        assert.equal(bareTexts.some((t) => t.includes('配角') && t.includes('当前编辑')), true, 'mobile bare row must display 当前编辑 badge');
        mobileTrigger.dispatchEvent(new dom.MockEvent('click', { bubbles: true, cancelable: true }));

        // Surface 5: Editor .gr-container-enhanced with '隐藏他角书' currently editing + v2.35.1 .wbo-gr-pin-btn
        const editorEnhanced = dom.doc.createElement('div');
        editorEnhanced.className = 'gr-container-enhanced';
        const editorOptsHost = dom.doc.createElement('div');
        editorOptsHost.className = 'gr-options-list';
        for (const [v, t] of [['', '--- Pick to Edit ---'], ['1', '隐藏他角书'], ['0', '当前角色书'], ['2', '未分组书'], ['3', '文风书'], ['4', '剧情书']]) {
            const opt = dom.doc.createElement('div');
            opt.className = 'gr-option';
            opt.dataset.value = v;
            opt.textContent = t;
            editorOptsHost.appendChild(opt);
        }
        editorEnhanced.appendChild(editorOptsHost);
        dom.doc.body.appendChild(editorEnhanced);
        bodyObserver.cb([{ addedNodes: [editorEnhanced] }]);

        assert.equal(editorEnhanced.dataset.wboPopoverRole, 'editor');
        assert.equal(editorEnhanced.querySelector('[data-wbo-dd-group="__current_char__"]'), null, 'no 当前角色 section in popover');
        assert.equal(editorEnhanced.querySelector(`[data-wbo-dd-group="${SPECIAL_GROUPS.CHARACTER}"]`), null, 'no 角色世界书 (1) section in popover');

        const hostDirectChildren = editorOptsHost.children;
        // Direct children: placeholder, '隐藏他角书', '当前角色书', then .wbo-pop-section[g1], [g2], [__ungrouped__]
        const barePopoverRows = hostDirectChildren.filter((el) => el.classList.contains('gr-option') && el.dataset.value !== '');
        assert.equal(barePopoverRows.length, 2, 'editing hidden char book + current chat char book render bare before sections');
        const editingPopoverRow = barePopoverRows.find((el) => el.dataset.value === '1');
        assert.ok(editingPopoverRow);
        assert.equal(editingPopoverRow.querySelector('.wbo-s2-badge.is-editing')?.textContent, '当前编辑', 'editor popover row carries inline 当前编辑 badge');
        const pinBtn = editingPopoverRow.querySelector('.wbo-gr-pin-btn');
        assert.ok(pinBtn, 'v2.35.1 .wbo-gr-pin-btn must be present on bare row');
        assert.equal(pinBtn.textContent, '☆');
        pinBtn.dispatchEvent(new dom.MockEvent('click', { bubbles: true, cancelable: true }));
        assert.equal(pinBtn.textContent, '★', 'clicking .wbo-gr-pin-btn must toggle pin in place');
        assert.equal(settings.pinnedBooks.includes('隐藏他角书'), true);

        const popSecs2 = editorOptsHost.querySelectorAll(':scope > .wbo-pop-section');
        assert.deepEqual(
            popSecs2.map((s) => s.getAttribute('data-wbo-dd-group')),
            // v2.35.40: the flat favorites section leads, then custom groups, UNGROUPED last.
            [SPECIAL_GROUPS.PINNED, 'g1', 'g2', SPECIAL_GROUPS.UNGROUPED],
            'editor popover sections must put custom groups before UNGROUPED',
        );

        // Verify Select2 templateResult & templateSelection with mocked jQuery
        let capturedS2Patch = null;
        delete editorSel.dataset.wboS2Ready;
        globalThis.jQuery = (sel) => ({
            data: (k) => (k === 'select2' ? { options: { options: (capturedS2Patch ||= {}) } } : null),
            hasClass: () => true,
            trigger: () => {},
            off: () => ({ on: () => {} }),
            on: () => {},
            val: () => ({ trigger: () => {} }),
        });
        nativeMod.applyAllNativeWorldFilters(cls, settings, { force: true });
        assert.equal(typeof capturedS2Patch.templateResult, 'function');
        assert.equal(typeof capturedS2Patch.templateSelection, 'function');
        let renderedHtml = '';
        globalThis.jQuery = (arg) => {
            if (typeof arg === 'string') {
                renderedHtml = arg;
                return arg;
            }
            return { data: () => null, hasClass: () => true, trigger: () => {} };
        };
        capturedS2Patch.templateResult({ id: '1', text: '隐藏他角书', selected: true, element: editingOptEl });
        assert.match(renderedHtml, /wbo-s2-badge is-editing[^>]*>当前编辑<\/span>/, 'Select2 templateResult must render 当前编辑 inline badge');
        assert.equal(capturedS2Patch.templateSelection({ id: '1', text: '隐藏他角书' }), '配角', 'Select2 templateSelection keeps clean primaryTitle');
    } finally {
        delete globalThis.jQuery;
        nativeMod.teardownNativeFilters();
        dom.restore();
    }
});

test('M2 R2 regression F4.3: pruneDetachedWorldNames -> applyAllNativeWorldFilters deletion change sync, #WIMultiSelector sibling sync, pre-classification openWorldInNativeEditor, and mobile sheet mid-open mutation', async () => {
    const dom = installMockNativeFilterDom({ innerWidth: 390, innerHeight: 844 });
    const nativeMod = await import('../src/native-filter.js');
    try {
        let liveWorldNames = ['隐藏角色书', '普通书A', '普通书B'];
        globalThis.SillyTavern = {
            getContext: () => ({
                characters: [{ avatar: 'Char.png', name: '测试角色', data: { extensions: { world: '隐藏角色书' } } }],
                characterId: 0,
                extensionSettings: {},
                saveSettingsDebounced: () => {},
                getWorldInfoNames: () => liveWorldNames,
            }),
        };

        const wiDrawer = dom.doc.createElement('div');
        wiDrawer.id = 'WorldInfo';
        const multiSel = dom.doc.createElement('div');
        multiSel.id = 'WIMultiSelector';
        const globalSel = dom.doc.createElement('select');
        globalSel.id = 'world_info';
        globalSel.multiple = true;
        const s2ChoicesWrap = dom.doc.createElement('ul');
        s2ChoicesWrap.className = 'select2-selection__rendered';
        const choiceLi = dom.doc.createElement('li');
        choiceLi.className = 'select2-selection__choice';
        choiceLi.setAttribute('title', '隐藏角色书');
        const choiceDisp = dom.doc.createElement('span');
        choiceDisp.className = 'select2-selection__choice__display';
        choiceDisp.textContent = '隐藏角色书';
        choiceLi.appendChild(choiceDisp);
        s2ChoicesWrap.appendChild(choiceLi);
        multiSel.appendChild(globalSel);
        multiSel.appendChild(s2ChoicesWrap);

        const worldPopup = dom.doc.createElement('div');
        worldPopup.id = 'world_popup';
        const editorSel = dom.doc.createElement('select');
        editorSel.id = 'world_editor_select';
        for (const [val, txt] of [['', '--- Pick to Edit ---'], ['0', '隐藏角色书'], ['1', '普通书A'], ['2', '普通书B']]) {
            const opt = dom.doc.createElement('option');
            opt.value = val;
            opt.textContent = txt;
            editorSel.appendChild(opt);
        }
        worldPopup.appendChild(editorSel);
        wiDrawer.appendChild(multiSel);
        wiDrawer.appendChild(worldPopup);
        dom.doc.body.appendChild(wiDrawer);

        const bindingMap = new Map([['隐藏角色书', [{ avatar: 'Char.png', charName: '测试角色', source: 'primary' }]]]);
        const settings = normalizeSettings({
            groups: [{ id: 'g1', name: '文风', color: '#5b8def', collapsed: false }],
            assignments: { 普通书A: 'g1' },
            showCharBooks: false,
            hideCharBooksByDefault: true,
            pinCurrentChatCharBookInEditor: false,
            showNativeOptgroups: true,
        });

        nativeMod.startNativeObservers(() => {});

        // 0. Pre-classification openWorldInNativeEditor (before applyAllNativeWorldFilters initializes _latestClassification)
        // Shift liveWorldNames insert-at-0 so '隐藏角色书' moves from 0 -> 1 while '普通书A' still had stale value '1'
        liveWorldNames = ['前置新书', '隐藏角色书', '普通书A', '普通书B'];
        let changeFired = 0;
        editorSel.addEventListener('change', () => { changeFired += 1; });
        const preOpened = nativeMod.openWorldInNativeEditor('隐藏角色书');
        assert.equal(preOpened, true);
        assert.equal(editorSel.selectedOptions[0]?.textContent, '隐藏角色书', 'pre-classification openWorldInNativeEditor must not match stale sibling 普通书A');
        assert.equal(editorSel.value, '1');
        assert.equal(changeFired, 1);

        // Reset editor options & run full classification
        nativeMod.setCurrentlyEditingWorld(null);
        editorSel.innerHTML = '';
        for (const [val, txt] of [['', '--- Pick to Edit ---'], ['0', '隐藏角色书'], ['1', '普通书A'], ['2', '普通书B']]) {
            const opt = dom.doc.createElement('option');
            opt.value = val;
            opt.textContent = txt;
            editorSel.appendChild(opt);
        }
        liveWorldNames = ['隐藏角色书', '普通书A', '普通书B'];
        const cls = classifyWorldbooks({ worldNames: liveWorldNames, bindingMap, settings });
        nativeMod.applyAllNativeWorldFilters(cls, settings, { force: true });

        // 1. Case 2A: '隐藏角色书' is detached, then liveWorldNames inserts at index 0 -> '隐藏角色书' is index 1 while sibling '普通书A' still has value '1'
        assert.equal(editorSel.querySelectorAll('option').some((o) => o.textContent === '隐藏角色书'), false);
        liveWorldNames = ['前置新书', '隐藏角色书', '普通书A', '普通书B'];
        choiceDisp.dispatchEvent(new dom.MockEvent('click', { bubbles: true, cancelable: true }));
        // Simulate ST's select2ChoiceClickSubscribe: $('#world_editor_select').val(world_names.indexOf('隐藏角色书'))
        editorSel.value = String(liveWorldNames.indexOf('隐藏角色书'));
        assert.equal(editorSel.selectedOptions[0]?.textContent, '隐藏角色书', 'sibling options must be synced before ST sets .val(liveIdx)');
        assert.equal(editorSel.value, '1');

        // 2. Case 2C: Production recomputeAndRender sequence when ST updateWorldInfoList() deletes active book without firing change
        // Select '普通书B' (now at live index 3)
        liveWorldNames = ['前置新书', '隐藏角色书', '普通书A', '普通书B'];
        const clsFull = classifyWorldbooks({ worldNames: liveWorldNames, bindingMap, settings });
        nativeMod.applyAllNativeWorldFilters(clsFull, settings, { force: true });
        editorSel.value = '3';
        nativeMod.setCurrentlyEditingWorld('普通书B');

        // ST updateWorldInfoList() strips <option>s and rebuilds unselected ['前置新书', '普通书A'] (no native change fired!)
        liveWorldNames = ['前置新书', '普通书A'];
        editorSel.innerHTML = '';
        for (const [val, txt] of [['', '--- Pick to Edit ---'], ['0', '前置新书'], ['1', '普通书A']]) {
            const opt = dom.doc.createElement('option');
            opt.value = val;
            opt.textContent = txt;
            editorSel.appendChild(opt);
        }
        assert.equal(editorSel.value, '', 'updateWorldInfoList resets selectEl.value without firing change');
        const beforeDeleteChanges = changeFired;
        // Exact index.js:279-317 production order: pruneDetachedWorldNames BEFORE applyAllNativeWorldFilters!
        nativeMod.pruneDetachedWorldNames(new Set(liveWorldNames));
        const clsAfterDel = classifyWorldbooks({ worldNames: liveWorldNames, bindingMap, settings });
        nativeMod.applyAllNativeWorldFilters(clsAfterDel, settings, { force: true });
        assert.equal(changeFired, beforeDeleteChanges + 1, 'pruneDetachedWorldNames + applyAllNativeWorldFilters MUST fire change so ST runs hideWorldEditor()');
        // Second call must NOT refire spuriously
        nativeMod.applyAllNativeWorldFilters(clsAfterDel, settings, { force: true });
        assert.equal(changeFired, beforeDeleteChanges + 1, 'pending cleared editing flag must only fire change once');

        // 3. Mid-open world_names mutation in openMobileEditorPickerSheet
        liveWorldNames = ['普通书A', '普通书B'];
        editorSel.innerHTML = '';
        for (const [val, txt] of [['', '--- Pick to Edit ---'], ['0', '普通书A'], ['1', '普通书B']]) {
            const opt = dom.doc.createElement('option');
            opt.value = val;
            opt.textContent = txt;
            editorSel.appendChild(opt);
        }
        const clsMobile = classifyWorldbooks({ worldNames: liveWorldNames, bindingMap, settings });
        nativeMod.applyAllNativeWorldFilters(clsMobile, settings, { force: true });
        const trigger = dom.doc.getElementById('wbo-mobile-editor-trigger');
        assert.ok(trigger);
        trigger.dispatchEvent(new dom.MockEvent('click', { bubbles: true, cancelable: true }));
        const mpOverlay = dom.doc.getElementById('wbo-mobile-picker-overlay');
        assert.ok(mpOverlay);

        // Mutate liveWorldNames while mobile sheet is open (insert-at-0 shifts 普通书B from 1 -> 2, 普通书A from 0 -> 1)
        liveWorldNames = ['新插书', '普通书A', '普通书B'];
        const rowB = mpOverlay.querySelectorAll('.wbo-mp-row-main').find((btn) => btn.getAttribute('data-mp-world') === '普通书B');
        assert.ok(rowB);
        rowB.dispatchEvent(new dom.MockEvent('click', { bubbles: true, cancelable: true }));
        assert.equal(editorSel.selectedOptions[0]?.textContent, '普通书B', 'mobile click must resolve live option after mid-open mutation');
        assert.equal(editorSel.value, '2', 'mobile click must select live world_names index 2');
    } finally {
        nativeMod.teardownNativeFilters();
        dom.restore();
    }
});

test('M2 R2 regression F4.2: container innerHTML reset cleanup (1C), 150ms slow-populated popovers (1D), _wboPopState & scroll memory isolation (4A), and shared-parent .select2-container sibling traversal (4B)', async () => {
    const dom = installMockNativeFilterDom({ innerWidth: 1280, innerHeight: 800 });
    const nativeMod = await import('../src/native-filter.js');
    try {
        const wiDrawer = dom.doc.createElement('div');
        wiDrawer.id = 'WorldInfo';
        const multiSel = dom.doc.createElement('div');
        multiSel.id = 'WIMultiSelector';
        const globalSel = dom.doc.createElement('select');
        globalSel.id = 'world_info';
        globalSel.multiple = true;
        multiSel.appendChild(globalSel);

        const worldPopup = dom.doc.createElement('div');
        worldPopup.id = 'world_popup';
        // Shared parent with .select2-container sitting between #world_editor_select and .gr-select2-display (Probe 4B)
        const sharedRow = dom.doc.createElement('div');
        sharedRow.className = 'shared-row';
        const editorSel = dom.doc.createElement('select');
        editorSel.id = 'world_editor_select';
        for (const [val, txt] of [['', '--- Pick to Edit ---'], ['0', '书A'], ['1', '书B'], ['2', '书C']]) {
            const opt = dom.doc.createElement('option');
            opt.value = val;
            opt.textContent = txt;
            editorSel.appendChild(opt);
        }
        const editorS2 = dom.doc.createElement('span');
        editorS2.className = 'select2-container';
        const editorDisp = dom.doc.createElement('div');
        editorDisp.className = 'gr-select2-display';

        const sortSel = dom.doc.createElement('select');
        sortSel.id = 'world_info_sort_order';
        for (const [val, txt] of [['0', 'Search'], ['1', 'Priority'], ['2', 'Custom'], ['3', 'Title A-Z']]) {
            const opt = dom.doc.createElement('option');
            opt.value = val;
            opt.textContent = txt;
            sortSel.appendChild(opt);
        }
        const sortS2 = dom.doc.createElement('span');
        sortS2.className = 'select2-container';
        const sortDisp = dom.doc.createElement('div');
        sortDisp.className = 'gr-select2-display';

        sharedRow.append(editorSel, editorS2, editorDisp, sortSel, sortS2, sortDisp);
        worldPopup.appendChild(sharedRow);
        wiDrawer.append(multiSel, worldPopup);
        dom.doc.body.appendChild(wiDrawer);

        const settings = normalizeSettings({
            groups: [{ id: 'g1', name: '文风', color: '#5b8def', collapsed: false }],
            assignments: { 书A: 'g1' },
            showNativeOptgroups: true,
        });
        const cls = classifyWorldbooks({ worldNames: ['书A', '书B', '书C'], bindingMap: new Map(), settings });
        nativeMod.applyAllNativeWorldFilters(cls, settings, { force: true });
        nativeMod.startNativeObservers(() => {});
        const bodyObserver = dom.observerInstances.find((o) => o.target === dom.doc.body && o.options?.childList);
        assert.ok(bodyObserver);

        // Probe 4B: shared parent with intermediate .select2-container recognizes editorDisp while excluding sortDisp
        const globalPop = dom.doc.createElement('div');
        globalPop.id = 'gr-global-dropdown-container';
        globalPop.className = 'gr-container-enhanced';
        dom.doc.body.appendChild(globalPop);
        sortDisp.dispatchEvent(new dom.MockEvent('pointerdown', { bubbles: true, cancelable: true }));
        assert.equal(globalPop.isConnected, true, 'sortDisp in shared parent must NOT close global popover');
        editorDisp.dispatchEvent(new dom.MockEvent('pointerdown', { bubbles: true, cancelable: true }));
        assert.equal(globalPop.isConnected, false, 'editorDisp past .select2-container in shared parent MUST close global popover');

        // Probe 1C + 4A: containerEl.innerHTML = '' reuse ('editor' -> '#world_info_sort_order') cleans _wboPopState and guards scroll/pointerdown
        const reusedPop = dom.doc.createElement('div');
        reusedPop.className = 'gr-container-enhanced';
        const host1 = dom.doc.createElement('div');
        host1.className = 'gr-options-list';
        host1.scrollHeight = 500;
        host1.clientHeight = 200;
        for (const [v, t] of [['0', '书A'], ['1', '书B'], ['2', '书C']]) {
            const opt = dom.doc.createElement('div');
            opt.className = 'gr-option';
            opt.dataset.value = v;
            opt.textContent = t;
            host1.appendChild(opt);
        }
        reusedPop.appendChild(host1);
        dom.doc.body.appendChild(reusedPop);
        bodyObserver.cb([{ addedNodes: [reusedPop] }]);

        assert.equal(reusedPop.dataset.wboPopoverRole, 'editor');
        assert.equal(reusedPop.dataset.wboBubbleGuarded, '1');
        assert.ok(reusedPop._wboPopState, 'editor popover must attach _wboPopState');

        // Cancel restore timers by interacting with an option, then scroll host1 to 120 to record _dropdownMemory
        host1.querySelector('.gr-option').dispatchEvent(new dom.MockEvent('pointerdown', { bubbles: true, cancelable: true }));
        host1.scrollTop = 120;
        host1.dispatchEvent(new dom.MockEvent('scroll', { bubbles: false }));

        // Reuse reusedPop via innerHTML = '' + new host2 with #world_info_sort_order options
        reusedPop.innerHTML = '';
        const host2 = dom.doc.createElement('div');
        host2.className = 'gr-options-list';
        host2.scrollHeight = 500;
        host2.clientHeight = 200;
        for (const [v, t] of [['0', 'Search'], ['1', 'Priority'], ['2', 'Custom'], ['3', 'Title A-Z']]) {
            const opt = dom.doc.createElement('div');
            opt.className = 'gr-option';
            opt.dataset.value = v;
            opt.textContent = t;
            host2.appendChild(opt);
        }
        reusedPop.appendChild(host2);
        const containerObs = dom.observerInstances.find((o) => o.target === reusedPop);
        assert.ok(containerObs, 'container-level MutationObserver must be registered on reusedPop');
        containerObs.cb([{ type: 'childList', addedNodes: [host2], removedNodes: [host1] }]);

        assert.equal(reusedPop.dataset.wboPopoverRole, undefined, '1C: innerHTML reset must clear wboPopoverRole');
        assert.equal(reusedPop.dataset.wboBubbleGuarded, undefined, '1C: innerHTML reset must unbind bubble guard');
        assert.equal(reusedPop._wboPopState, undefined, '4A: innerHTML reset must delete _wboPopState');
        assert.equal(reusedPop.querySelector('.wbo-pop-filter-bar'), null, '1C: innerHTML reset must remove filter bar');

        // Verify reused sort container scroll/pointerdown does NOT overwrite _dropdownMemory (kept at 120)
        // Check same-host reuse too: host1 scroll & pointerdown after role cleared
        host1.scrollTop = 42;
        host1.dispatchEvent(new dom.MockEvent('scroll', { bubbles: false }));
        host1.querySelector('.gr-option')?.dispatchEvent(new dom.MockEvent('pointerdown', { bubbles: true, cancelable: true }));

        const freshEditorPop = dom.doc.createElement('div');
        freshEditorPop.className = 'gr-container-enhanced';
        const freshHost = dom.doc.createElement('div');
        freshHost.className = 'gr-options-list';
        freshHost.scrollHeight = 500;
        freshHost.clientHeight = 200;
        for (const [v, t] of [['0', '书A'], ['1', '书B'], ['2', '书C']]) {
            const opt = dom.doc.createElement('div');
            opt.className = 'gr-option';
            opt.dataset.value = v;
            opt.textContent = t;
            freshHost.appendChild(opt);
        }
        freshEditorPop.appendChild(freshHost);
        dom.doc.body.appendChild(freshEditorPop);
        bodyObserver.cb([{ addedNodes: [freshEditorPop] }]);
        assert.equal(freshHost.scrollTop, 120, '4A: sort popover scroll/pointerdown must NOT mutate _dropdownMemory (120 preserved)');

        // Probe 1D: Slow (>110ms) empty worldbook popover population enhances cleanly once options appear,
        // while slow-populating sort popover remains untouched
        const slowEdPop = dom.doc.createElement('div');
        slowEdPop.className = 'gr-container-enhanced';
        const slowEdHost = dom.doc.createElement('div');
        slowEdHost.className = 'gr-options-list';
        slowEdPop.appendChild(slowEdHost);
        dom.doc.body.appendChild(slowEdPop);
        bodyObserver.cb([{ addedNodes: [slowEdPop] }]);
        assert.equal(slowEdPop.dataset.wboPopoverRole, undefined);

        const slowSortPop = dom.doc.createElement('div');
        slowSortPop.className = 'gr-container-enhanced';
        const slowSortHost = dom.doc.createElement('div');
        slowSortHost.className = 'gr-options-list';
        slowSortPop.appendChild(slowSortHost);
        dom.doc.body.appendChild(slowSortPop);
        bodyObserver.cb([{ addedNodes: [slowSortPop] }]);

        // Wait >110ms (150ms) before populating options
        await new Promise((r) => setTimeout(r, 150));

        const addedEdNodes = [];
        for (const [v, t] of [['0', '书A'], ['1', '书B'], ['2', '书C']]) {
            const opt = dom.doc.createElement('div');
            opt.className = 'gr-option';
            opt.dataset.value = v;
            opt.textContent = t;
            slowEdHost.appendChild(opt);
            addedEdNodes.push(opt);
        }
        const slowEdObs = dom.observerInstances.find((o) => o.target === slowEdPop);
        assert.ok(slowEdObs);
        slowEdObs.cb([{ type: 'childList', addedNodes: addedEdNodes, removedNodes: [] }]);
        assert.equal(slowEdPop.dataset.wboPopoverRole, 'editor', '1D: 150ms slow-populated editor popover must enhance');
        assert.equal(slowEdPop.dataset.wboBubbleGuarded, '1');
        assert.ok(slowEdPop.querySelector('.wbo-gr-pin-btn'));
        assert.ok(slowEdPop.querySelector('.wbo-pop-filter-bar'));

        const addedSortNodes = [];
        for (const [v, t] of [['0', 'Search'], ['1', 'Priority'], ['2', 'Custom'], ['3', 'Title A-Z']]) {
            const opt = dom.doc.createElement('div');
            opt.className = 'gr-option';
            opt.dataset.value = v;
            opt.textContent = t;
            slowSortHost.appendChild(opt);
            addedSortNodes.push(opt);
        }
        const slowSortObs = dom.observerInstances.find((o) => o.target === slowSortPop);
        assert.ok(slowSortObs);
        slowSortObs.cb([{ type: 'childList', addedNodes: addedSortNodes, removedNodes: [] }]);
        assert.equal(slowSortPop.dataset.wboPopoverRole, undefined, '1D: 150ms slow-populated sort popover must remain untouched');
        assert.equal(slowSortPop.dataset.wboBubbleGuarded, undefined);
        assert.equal(slowSortPop.querySelector('.wbo-gr-pin-btn'), null);
        assert.equal(slowSortPop.querySelector('.wbo-pop-filter-bar'), null);
    } finally {
        nativeMod.teardownNativeFilters();
        dom.restore();
    }
});

test('M2 R3 regression F4.3: mid-open deletion before select rebuild clears selection (R2_1B) and earlier-book deletion purges stale <option>s without index collision across mobile, pre-classification openWorldInNativeEditor, and #WIMultiSelector (R2_1C, R2_2B, 3_1)', async () => {
    const dom = installMockNativeFilterDom({ innerWidth: 390, innerHeight: 844 });
    const nativeMod = await import('../src/native-filter.js');
    try {
        let liveWorldNames = ['普通书A', '隐藏角色书', '普通书B'];
        globalThis.SillyTavern = {
            getContext: () => ({
                characters: [{ avatar: 'Char.png', name: '测试角色', data: { extensions: { world: '隐藏角色书' } } }],
                characterId: 0,
                extensionSettings: {},
                saveSettingsDebounced: () => {},
                getWorldInfoNames: () => liveWorldNames,
            }),
        };

        const wiDrawer = dom.doc.createElement('div');
        wiDrawer.id = 'WorldInfo';
        const multiSel = dom.doc.createElement('div');
        multiSel.id = 'WIMultiSelector';
        const globalSel = dom.doc.createElement('select');
        globalSel.id = 'world_info';
        globalSel.multiple = true;
        const s2ChoicesWrap = dom.doc.createElement('ul');
        s2ChoicesWrap.className = 'select2-selection__rendered';
        const choiceLi = dom.doc.createElement('li');
        choiceLi.className = 'select2-selection__choice';
        choiceLi.setAttribute('title', '隐藏角色书');
        const choiceDisp = dom.doc.createElement('span');
        choiceDisp.className = 'select2-selection__choice__display';
        choiceDisp.textContent = '隐藏角色书';
        choiceLi.appendChild(choiceDisp);
        s2ChoicesWrap.appendChild(choiceLi);
        multiSel.append(globalSel, s2ChoicesWrap);

        const worldPopup = dom.doc.createElement('div');
        worldPopup.id = 'world_popup';
        const editorSel = dom.doc.createElement('select');
        editorSel.id = 'world_editor_select';
        const resetEditorOptions = (entries) => {
            editorSel.innerHTML = '';
            for (const [val, txt] of entries) {
                const opt = dom.doc.createElement('option');
                opt.value = val;
                opt.textContent = txt;
                editorSel.appendChild(opt);
            }
        };
        resetEditorOptions([['', '--- Pick to Edit ---'], ['0', '普通书A'], ['1', '隐藏角色书'], ['2', '普通书B']]);
        worldPopup.appendChild(editorSel);
        wiDrawer.append(multiSel, worldPopup);
        dom.doc.body.appendChild(wiDrawer);

        let changeFired = 0;
        editorSel.addEventListener('change', () => { changeFired += 1; });

        nativeMod.startNativeObservers(() => {});

        // 1. R2_2B: Pre-classification openWorldInNativeEditor after earlier book '普通书A' is deleted before select rebuild
        // '隐藏角色书' shifts 1 -> 0 while stale <option value="0">普通书A</option> is still in editorSel!
        liveWorldNames = ['隐藏角色书', '普通书B'];
        const r22bOk = nativeMod.openWorldInNativeEditor('隐藏角色书');
        assert.equal(r22bOk, true);
        assert.equal(editorSel.selectedOptions[0]?.textContent, '隐藏角色书', 'R2_2B: pre-classification openWorldInNativeEditor must purge stale 普通书A and select 隐藏角色书');
        assert.equal(editorSel.value, '0');
        assert.equal(editorSel.options.some((o) => o.textContent === '普通书A'), false, 'R2_2B: stale deleted <option> must be purged');

        // 2. 3_1: #WIMultiSelector jump after earlier book deleted before updateWorldInfoList() rebuilds #world_editor_select
        nativeMod.setCurrentlyEditingWorld(null);
        liveWorldNames = ['普通书A', '隐藏角色书', '普通书B'];
        resetEditorOptions([['', '--- Pick to Edit ---'], ['0', '普通书A'], ['1', '隐藏角色书'], ['2', '普通书B']]);
        const bindingMap = new Map([['隐藏角色书', [{ avatar: 'Char.png', charName: '测试角色', source: 'primary' }]]]);
        const settings = normalizeSettings({
            groups: [{ id: 'g1', name: '文风', color: '#5b8def', collapsed: false }],
            assignments: { 普通书A: 'g1' },
            showCharBooks: false,
            hideCharBooksByDefault: true,
            pinCurrentChatCharBookInEditor: false,
            showNativeOptgroups: true,
        });
        const cls = classifyWorldbooks({ worldNames: liveWorldNames, bindingMap, settings });
        nativeMod.applyAllNativeWorldFilters(cls, settings, { force: true });
        // Delete '普通书A' from world_names before updateWorldInfoList() runs
        liveWorldNames = ['隐藏角色书', '普通书B'];
        choiceDisp.dispatchEvent(new dom.MockEvent('click', { bubbles: true, cancelable: true }));
        editorSel.value = String(liveWorldNames.indexOf('隐藏角色书'));
        assert.equal(editorSel.selectedOptions[0]?.textContent, '隐藏角色书', '3_1: #WIMultiSelector jump after earlier deletion must select 隐藏角色书, not stale 普通书A');
        assert.equal(editorSel.value, '0');
        assert.equal(editorSel.options.some((o) => o.textContent === '普通书A'), false, '3_1: stale deleted <option> must be purged');

        // 3. R2_1B: Mobile sheet open -> tapped book deleted mid-open before #world_editor_select rebuild -> clears selection ('')
        nativeMod.setCurrentlyEditingWorld(null);
        liveWorldNames = ['普通书A', '普通书B', '普通书C'];
        resetEditorOptions([['', '--- Pick to Edit ---'], ['0', '普通书A'], ['1', '普通书B'], ['2', '普通书C']]);
        editorSel.value = '1';
        nativeMod.setCurrentlyEditingWorld('普通书B');
        const clsMobile = classifyWorldbooks({ worldNames: liveWorldNames, bindingMap: new Map(), settings });
        nativeMod.applyAllNativeWorldFilters(clsMobile, settings, { force: true });

        const trigger = dom.doc.getElementById('wbo-mobile-editor-trigger');
        assert.ok(trigger);
        trigger.dispatchEvent(new dom.MockEvent('click', { bubbles: true, cancelable: true }));
        let mpOverlay = dom.doc.getElementById('wbo-mobile-picker-overlay');
        assert.ok(mpOverlay);

        // Delete '普通书B' mid-open before select rebuild, then click '普通书B'
        liveWorldNames = ['普通书A', '普通书C'];
        const beforeR21bChanges = changeFired;
        const deletedRow = mpOverlay.querySelectorAll('.wbo-mp-row-main').find((btn) => btn.getAttribute('data-mp-world') === '普通书B');
        assert.ok(deletedRow);
        deletedRow.dispatchEvent(new dom.MockEvent('click', { bubbles: true, cancelable: true }));
        assert.equal(editorSel.value, '', 'R2_1B: tapping deleted book mid-open before select rebuild MUST clear selection');
        assert.equal(changeFired, beforeR21bChanges + 1, 'R2_1B: clearing selection must fire change');

        // 4. R2_1C: Mobile sheet open -> earlier book deleted mid-open before select rebuild -> shifts '普通书B' from 1 -> 0 without collision
        nativeMod.setCurrentlyEditingWorld(null);
        liveWorldNames = ['普通书A', '普通书B', '普通书C'];
        resetEditorOptions([['', '--- Pick to Edit ---'], ['0', '普通书A'], ['1', '普通书B'], ['2', '普通书C']]);
        const clsMobileC = classifyWorldbooks({ worldNames: liveWorldNames, bindingMap: new Map(), settings });
        nativeMod.applyAllNativeWorldFilters(clsMobileC, settings, { force: true });
        trigger.dispatchEvent(new dom.MockEvent('click', { bubbles: true, cancelable: true }));
        mpOverlay = dom.doc.getElementById('wbo-mobile-picker-overlay');
        assert.ok(mpOverlay);

        liveWorldNames = ['普通书B', '普通书C'];
        const rowB = mpOverlay.querySelectorAll('.wbo-mp-row-main').find((btn) => btn.getAttribute('data-mp-world') === '普通书B');
        assert.ok(rowB);
        rowB.dispatchEvent(new dom.MockEvent('click', { bubbles: true, cancelable: true }));
        assert.equal(editorSel.selectedOptions[0]?.textContent, '普通书B', 'R2_1C: clicking 普通书B after 普通书A deleted must select 普通书B, not stale 普通书A');
        assert.equal(editorSel.value, '0');
        assert.equal(editorSel.options.some((o) => o.textContent === '普通书A'), false, 'R2_1C: stale deleted <option> must be purged');
    } finally {
        nativeMod.teardownNativeFilters();
        dom.restore();
    }
});

test('M2 R3 regression F4.2 & F1.1/F2.5: persistent container re-observes across stop/startNativeObservers (R2_4B), cancels pending scheduleContainerReEnhance on stop, and keeps 当前编辑 badge before pin button on re-enhance (R2_5)', async () => {
    const dom = installMockNativeFilterDom({ innerWidth: 1280, innerHeight: 800 });
    const nativeMod = await import('../src/native-filter.js');
    const origRaf = globalThis.requestAnimationFrame;
    const origCancelRaf = globalThis.cancelAnimationFrame;
    try {
        globalThis.SillyTavern = {
            getContext: () => ({
                characters: [{ avatar: 'Char.png', name: '测试角色', data: { extensions: { world: '当前角色书' } } }],
                characterId: 0,
                extensionSettings: {},
                saveSettingsDebounced: () => {},
            }),
        };

        const wiDrawer = dom.doc.createElement('div');
        wiDrawer.id = 'WorldInfo';
        const multiSel = dom.doc.createElement('div');
        multiSel.id = 'WIMultiSelector';
        const globalSel = dom.doc.createElement('select');
        globalSel.id = 'world_info';
        globalSel.multiple = true;
        multiSel.appendChild(globalSel);

        const worldPopup = dom.doc.createElement('div');
        worldPopup.id = 'world_popup';
        const editorSel = dom.doc.createElement('select');
        editorSel.id = 'world_editor_select';
        for (const [val, txt] of [['', '--- Pick to Edit ---'], ['0', '当前角色书'], ['1', '隐藏他角书'], ['2', '普通书']]) {
            const opt = dom.doc.createElement('option');
            opt.value = val;
            opt.textContent = txt;
            editorSel.appendChild(opt);
        }
        worldPopup.appendChild(editorSel);
        wiDrawer.append(multiSel, worldPopup);
        dom.doc.body.appendChild(wiDrawer);

        const bindingMap = new Map([
            ['当前角色书', [{ avatar: 'Char.png', charName: '测试角色', source: 'primary' }]],
            ['隐藏他角书', [{ avatar: 'Other.png', charName: '配角', source: 'primary' }]],
        ]);
        const settings = normalizeSettings({
            groups: [{ id: 'g1', name: '文风', color: '#5b8def', collapsed: false }],
            assignments: { 普通书: 'g1' },
            showCharBooks: false,
            hideCharBooksByDefault: true,
            pinCurrentChatCharBookInEditor: true,
        });

        editorSel.value = '1';
        nativeMod.setCurrentlyEditingWorld('隐藏他角书');
        const cls = classifyWorldbooks({ worldNames: ['当前角色书', '隐藏他角书', '普通书'], bindingMap, settings });
        nativeMod.applyAllNativeWorldFilters(cls, settings, { force: true });
        nativeMod.startNativeObservers(() => {});
        const bodyObserver = dom.observerInstances.find((o) => o.target === dom.doc.body && o.options?.childList);
        assert.ok(bodyObserver);

        // R2_5: Mount & enhance persistent editor container with active = '隐藏他角书'
        const persistentPop = dom.doc.createElement('div');
        persistentPop.className = 'gr-container-enhanced';
        const host = dom.doc.createElement('div');
        host.className = 'gr-options-list';
        for (const [v, t] of [['0', '当前角色书'], ['1', '隐藏他角书'], ['2', '普通书']]) {
            const opt = dom.doc.createElement('div');
            opt.className = 'gr-option';
            opt.dataset.value = v;
            opt.textContent = t;
            host.appendChild(opt);
        }
        persistentPop.appendChild(host);
        dom.doc.body.appendChild(persistentPop);
        bodyObserver.cb([{ addedNodes: [persistentPop] }]);
        assert.equal(persistentPop.dataset.wboPopoverRole, 'editor');
        assert.equal(host.dataset.wboOptObserved, '1');

        // Switch active editing world -> '当前角色书' and re-enhance via host observer mutation
        editorSel.value = '0';
        nativeMod.setCurrentlyEditingWorld('当前角色书');
        const hostObsBeforeStop = dom.observerInstances.find((o) => o.target === host);
        assert.ok(hostObsBeforeStop);
        const tempOpt = dom.doc.createElement('div');
        tempOpt.className = 'gr-option';
        tempOpt.dataset.value = '2';
        tempOpt.textContent = '普通书';
        host.appendChild(tempOpt);
        hostObsBeforeStop.cb([{ type: 'childList', addedNodes: [tempOpt], removedNodes: [] }]);

        const currentRow = host.querySelectorAll('.gr-option').find((o) => o.textContent.includes('当前角色书'));
        assert.ok(currentRow);
        const rightWrap = currentRow.querySelector(':scope > .wbo-s2-right');
        assert.ok(rightWrap);
        const rightChildren = rightWrap.children;
        const badgeIdx = rightChildren.findIndex((c) => c.hasAttribute('data-wbo-editing-badge'));
        const pinIdx = rightChildren.findIndex((c) => c.classList.contains('wbo-gr-pin-btn'));
        assert.ok(badgeIdx >= 0 && pinIdx >= 0, 'R2_5: both 当前编辑 badge and pin button must exist');
        assert.ok(badgeIdx < pinIdx, `R2_5: 当前编辑 badge (${badgeIdx}) MUST precede pin button (${pinIdx}) inside .wbo-s2-right`);

        // R2_4B: stopNativeObservers() -> startNativeObservers() keeps persistent container re-observed & cleans up on sort reuse
        nativeMod.stopNativeObservers();
        assert.equal(host.dataset.wboOptObserved, undefined, 'R2_4B: stopNativeObservers must clear wboOptObserved');
        nativeMod.startNativeObservers(() => {});
        const activeContainerObs = [...dom.observerInstances].reverse().find((o) => o.target === persistentPop);
        assert.ok(activeContainerObs, 'R2_4B: startNativeObservers must re-attach MutationObserver to persistent container');

        persistentPop.innerHTML = '';
        const sortHost = dom.doc.createElement('div');
        sortHost.className = 'gr-options-list';
        for (const [v, t] of [['0', 'Search'], ['1', 'Priority'], ['2', 'Custom'], ['3', 'Title A-Z']]) {
            const opt = dom.doc.createElement('div');
            opt.className = 'gr-option';
            opt.dataset.value = v;
            opt.textContent = t;
            sortHost.appendChild(opt);
        }
        persistentPop.appendChild(sortHost);
        activeContainerObs.cb([{ type: 'childList', addedNodes: [sortHost], removedNodes: [host] }]);
        assert.equal(persistentPop.dataset.wboPopoverRole, undefined, 'R2_4B: after stop+restart, persistent container MUST clean up on sort reuse');
        assert.equal(persistentPop.dataset.wboBubbleGuarded, undefined);
        assert.equal(persistentPop._wboPopState, undefined);

        // Teardown timer safety: pending async rAF in scheduleContainerReEnhance MUST cancel on stopNativeObservers()
        const queuedRafs = new Map();
        let nextRafId = 100;
        globalThis.requestAnimationFrame = (fn) => {
            const id = nextRafId++;
            queuedRafs.set(id, fn);
            return id;
        };
        globalThis.cancelAnimationFrame = (id) => {
            queuedRafs.delete(id);
        };
        nativeMod.startNativeObservers(() => {});
        const asyncPop = dom.doc.createElement('div');
        asyncPop.className = 'gr-container-enhanced';
        const asyncHost = dom.doc.createElement('div');
        asyncHost.className = 'gr-options-list';
        for (const [v, t] of [['0', '当前角色书'], ['2', '普通书']]) {
            const opt = dom.doc.createElement('div');
            opt.className = 'gr-option';
            opt.dataset.value = v;
            opt.textContent = t;
            asyncHost.appendChild(opt);
        }
        asyncPop.appendChild(asyncHost);
        dom.doc.body.appendChild(asyncPop);
        const asyncBodyObs = [...dom.observerInstances].reverse().find((o) => o.target === dom.doc.body);
        asyncBodyObs.cb([{ addedNodes: [asyncPop] }]);
        const snapshotCallbacks = [...queuedRafs.values()];
        assert.ok(snapshotCallbacks.length > 0, 'async rAF should be queued before stop');

        nativeMod.stopNativeObservers();
        assert.equal(queuedRafs.size, 0, 'stopNativeObservers MUST cancel pending rAF callbacks');
        // Even if a browser fires a snapshot callback anyway, _observersActive guard prevents mutation
        for (const fn of snapshotCallbacks) fn();
        assert.equal(asyncPop.dataset.wboPopoverReady, undefined, 'canceled rAF callback MUST NOT mutate DOM after stopNativeObservers');

        // Also verify scheduleContainerReEnhance pending handle in _pendingContainerEnhance cancels on stopNativeObservers()
        globalThis.requestAnimationFrame = origRaf;
        nativeMod.startNativeObservers(() => {});
        const reEnhancePop = dom.doc.createElement('div');
        reEnhancePop.className = 'gr-container-enhanced';
        const reEnhanceHost = dom.doc.createElement('div');
        reEnhanceHost.className = 'gr-options-list';
        for (const [v, t] of [['0', '当前角色书'], ['2', '普通书']]) {
            const opt = dom.doc.createElement('div');
            opt.className = 'gr-option';
            opt.dataset.value = v;
            opt.textContent = t;
            reEnhanceHost.appendChild(opt);
        }
        reEnhancePop.appendChild(reEnhanceHost);
        dom.doc.body.appendChild(reEnhancePop);
        const syncBodyObs = [...dom.observerInstances].reverse().find((o) => o.target === dom.doc.body);
        syncBodyObs.cb([{ addedNodes: [reEnhancePop] }]);
        assert.equal(reEnhancePop.dataset.wboPopoverReady, '1');

        // Switch to async rAF, inject new unpinned option to trigger scheduleContainerReEnhance, then stopNativeObservers()
        globalThis.requestAnimationFrame = (fn) => {
            const id = nextRafId++;
            queuedRafs.set(id, fn);
            return id;
        };
        const lateOpt = dom.doc.createElement('div');
        lateOpt.className = 'gr-option';
        lateOpt.dataset.value = '1';
        lateOpt.textContent = '隐藏他角书';
        reEnhanceHost.appendChild(lateOpt);
        const reEnhanceObs = [...dom.observerInstances].reverse().find((o) => o.target === reEnhancePop);
        assert.ok(reEnhanceObs);
        reEnhanceObs.cb([{ type: 'childList', addedNodes: [lateOpt], removedNodes: [] }]);
        const reEnhanceSnapshots = [...queuedRafs.values()];
        assert.ok(reEnhanceSnapshots.length > 0, 'scheduleContainerReEnhance should queue async rAF');
        nativeMod.stopNativeObservers();
        assert.equal(queuedRafs.size, 0, 'stopNativeObservers MUST cancel pending scheduleContainerReEnhance rAF');
        for (const fn of reEnhanceSnapshots) fn();
        assert.equal(lateOpt.querySelector('.wbo-gr-pin-btn'), null, 'canceled scheduleContainerReEnhance MUST NOT enhance after stopNativeObservers');
    } finally {
        globalThis.requestAnimationFrame = origRaf;
        globalThis.cancelAnimationFrame = origCancelRaf;
        nativeMod.teardownNativeFilters();
        dom.restore();
    }
});

test('M3 R4: mountEntryAccordion supports custom/order/title sort, DOM reconciliation, collapsed & expanded pointer drag-reorder, syncOrder & API rollback', async () => {
    const dom = installMockNativeFilterDom({ innerWidth: 1280, innerHeight: 800 });
    const prevFetch = globalThis.fetch;
    const prevConfirm = globalThis.confirm;
    const prevSetTimeout = globalThis.setTimeout;

    let worldPayload = {
        entries: {
            '10': { uid: 10, comment: 'Beta 条目', key: ['b'], content: 'Body B', order: 300, displayIndex: 1, disable: false, constant: false, position: 0, depth: 4, extensions: { display_index: 1 } },
            '20': { uid: 20, comment: 'Alpha 条目', key: ['a'], content: 'Body A', order: 200, displayIndex: 0, disable: false, constant: false, position: 0, depth: 4, extensions: { display_index: 0 } },
            '30': { uid: 30, comment: 'Gamma 条目', key: ['g'], content: 'Body G', order: 100, displayIndex: 2, disable: false, constant: false, position: 0, depth: 4, extensions: { display_index: 2 } },
        },
    };
    let failNextSave = false;
    let syncOrderFlag = false;
    let editPayloads = [];
    const mutatedEvents = [];

    try {
        globalThis.confirm = () => true;
        globalThis.fetch = async (url, init) => {
            const u = String(url);
            if (u.includes('/api/worldinfo/get')) {
                return { ok: true, json: async () => structuredClone(worldPayload) };
            }
            if (u.includes('/api/worldinfo/edit')) {
                if (failNextSave) {
                    return { ok: false, status: 500 };
                }
                const parsed = JSON.parse(init.body);
                editPayloads.push(parsed);
                worldPayload = parsed.data;
                return { ok: true, json: async () => ({ ok: true }) };
            }
            return { ok: false, status: 404 };
        };

        const { mountEntryAccordion } = await import('../src/entry-accordion.js');
        const hostEl = dom.doc.createElement('div');
        dom.doc.body.appendChild(hostEl);

        const ctrl = mountEntryAccordion(hostEl, {
            worldName: '排序测试书',
            getSyncOrder: () => syncOrderFlag,
            onEntryMutated: (info) => mutatedEvents.push(info),
        });
        await ctrl.ready;

        const getDomUids = () => hostEl.querySelectorAll('.wbo-acc-item').map((el) => el.getAttribute('data-acc-uid'));
        assert.deepEqual(getDomUids(), ['20', '10', '30'], 'default custom sort follows displayIndex (0, 1, 2)');

        // Switch sort to order (100 -> 200 -> 300 => uid 30, 20, 10)
        const sortSelect = hostEl.querySelector('[data-acc-sort]');
        assert.ok(sortSelect);
        sortSelect.value = 'order';
        sortSelect.dispatchEvent(new dom.MockEvent('change', { bubbles: true }));
        assert.deepEqual(getDomUids(), ['30', '20', '10'], 'order sort reorders DOM nodes');
        assert.ok(hostEl.querySelector('[data-acc-drag-handle]')?.classList.contains('is-sort-locked'), 'drag handle locked outside custom mode');

        // Pointer drag while not in custom mode must not reorder
        const lockedHandle = hostEl.querySelector('.wbo-acc-item[data-acc-uid="30"] [data-acc-drag-handle]');
        lockedHandle.dispatchEvent(new dom.MockEvent('pointerdown', { bubbles: true, cancelable: true, clientY: 10 }));
        globalThis.dispatchEvent(new dom.MockEvent('pointermove', { clientY: 100 }));
        globalThis.dispatchEvent(new dom.MockEvent('pointerup', { clientY: 100 }));
        assert.equal(editPayloads.length, 0, 'must not persist drag when not in custom sort');

        // Switch to title sort (Alpha, Beta, Gamma => uid 20, 10, 30)
        sortSelect.value = 'title';
        sortSelect.dispatchEvent(new dom.MockEvent('change', { bubbles: true }));
        assert.deepEqual(getDomUids(), ['20', '10', '30']);

        // Switch back to custom and expand entry 20 to verify drag works even while expanded
        sortSelect.value = 'custom';
        sortSelect.dispatchEvent(new dom.MockEvent('change', { bubbles: true }));
        assert.ok(!hostEl.querySelector('[data-acc-drag-handle]')?.classList.contains('is-sort-locked'));
        await ctrl.expandEntry('20');
        assert.equal(ctrl.getExpandedCount(), 1);

        // Position item rects vertically for deterministic pointer hit-testing
        const setRects = () => {
            const items = hostEl.querySelectorAll('.wbo-acc-item');
            items.forEach((el, idx) => {
                el._rect = { left: 0, top: idx * 50, right: 300, bottom: (idx + 1) * 50, width: 300, height: 50 };
            });
        };
        setRects();

        // Drag expanded item '20' (0..50) below item '30' (100..150, mid=125 -> clientY=140) with syncOrder=false
        const handle20 = hostEl.querySelector('.wbo-acc-item[data-acc-uid="20"] [data-acc-drag-handle]');
        handle20.dispatchEvent(new dom.MockEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'touch', clientY: 15 }));
        globalThis.dispatchEvent(new dom.MockEvent('pointermove', { pointerId: 7, clientY: 140 }));
        globalThis.dispatchEvent(new dom.MockEvent('pointerup', { pointerId: 7, clientY: 140 }));
        await new Promise((r) => prevSetTimeout(r, 10));

        assert.deepEqual(getDomUids(), ['10', '30', '20'], 'expanded entry drag moves 20 to the end');
        assert.equal(editPayloads.length, 1);
        assert.equal(worldPayload.entries['10'].displayIndex, 0);
        assert.equal(worldPayload.entries['30'].displayIndex, 1);
        assert.equal(worldPayload.entries['20'].displayIndex, 2);
        assert.equal(worldPayload.entries['20'].order, 200, 'syncOrder=false preserves original order values');
        assert.equal(ctrl.getExpandedCount(), 1, 'expanded editor stays open across drag-reorder');
        assert.equal(mutatedEvents.at(-1)?.action, 'reorder');

        // Drag item '30' before '10' with syncOrder=true
        syncOrderFlag = true;
        setRects();
        const handle30 = hostEl.querySelector('.wbo-acc-item[data-acc-uid="30"] [data-acc-drag-handle]');
        handle30.dispatchEvent(new dom.MockEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 8, clientY: 75 }));
        globalThis.dispatchEvent(new dom.MockEvent('pointermove', { pointerId: 8, clientY: 10 }));
        globalThis.dispatchEvent(new dom.MockEvent('pointerup', { pointerId: 8, clientY: 10 }));
        await new Promise((r) => prevSetTimeout(r, 10));

        assert.deepEqual(getDomUids(), ['30', '10', '20']);
        assert.equal(worldPayload.entries['30'].order, 100);
        assert.equal(worldPayload.entries['10'].order, 101);
        assert.equal(worldPayload.entries['20'].order, 102);

        // API error rollback restores DOM order & item snapshot
        failNextSave = true;
        setRects();
        const handle20b = hostEl.querySelector('.wbo-acc-item[data-acc-uid="20"] [data-acc-drag-handle]');
        handle20b.dispatchEvent(new dom.MockEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 9, clientY: 120 }));
        globalThis.dispatchEvent(new dom.MockEvent('pointermove', { pointerId: 9, clientY: 10 }));
        globalThis.dispatchEvent(new dom.MockEvent('pointerup', { pointerId: 9, clientY: 10 }));
        await new Promise((r) => prevSetTimeout(r, 10));
        assert.deepEqual(getDomUids(), ['30', '10', '20'], 'failed save rolls back DOM order cleanly');

        // v2.35.1 features preserved inside expanded editor
        assert.ok(hostEl.querySelector('[data-acc-delete]'), 'v2.35.1 delete entry button preserved');
        assert.ok(hostEl.querySelector('[data-acc-tall]'), 'v2.35.1 tall toggle button preserved');
        assert.ok(hostEl.querySelector('[data-acc-ta-backdrop]'), 'v2.35.1 find backdrop preserved');
        assert.ok(hostEl.querySelector('.wbo-acc-find-nav'), 'v2.35.1 find nav preserved');
        assert.ok(hostEl.querySelector('.wbo-undo-svg'), 'v2.35.1 undo SVG preserved');

        ctrl.destroy();
    } finally {
        globalThis.confirm = prevConfirm;
        globalThis.fetch = prevFetch;
        dom.restore();
    }
});
