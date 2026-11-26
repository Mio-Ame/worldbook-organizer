import test from 'node:test';
import assert from 'node:assert/strict';
import { getNativeGroupOrder, planNativeGroupMove } from '../src/entry-groups/entry-reorder.js';

test('native group display order preserves explicit order, pins and ungrouped without touching entries', () => {
    const config = { groups: [{ id: 'a', name: '甲组' }, { id: 'b', name: '乙组' }], pinnedGroupIds: ['b'], nativeGroupOrder: ['a', 'b', '__ungrouped__'] };
    assert.deepEqual(getNativeGroupOrder(config), ['b', 'a', '__ungrouped__']);
    assert.deepEqual(planNativeGroupMove(config, 'b', 'a', true), []);
    config.pinnedGroupIds = [];
    assert.deepEqual(planNativeGroupMove(config, 'b', 'a', false), ['b', 'a', '__ungrouped__']);
    assert.deepEqual(planNativeGroupMove(config, 'a', 'b', false), []);
    assert.deepEqual(planNativeGroupMove(config, 'missing', 'b', false), []);
    const normalized = normalizeBookConfig({ ...config, nativeGroupOrder: ['b', 'b', 'missing', '__ungrouped__', 'a'] });
    assert.deepEqual(normalized.nativeGroupOrder, ['b', '__ungrouped__', 'a']);
});

import {
    ENTRY_ACTIVATION_MODES,
    GROUP_MODES,
    SPECIAL_GROUP_UNGROUPED,
    WORLD_INFO_POSITION,
    applyAutoGroupProposals,
    applyEntryEditPatchToRawEntry,
    applyEntryEditToPayload,
    applyTextareaTabIndent,
    applyTogglePlanToPayload,
    buildGreetingCoordinationIndex,
    buildGroupedView,
    collectOrphanedOpenDrafts,
    computeEditDirty,
    computeEntryTogglePlan,
    computeGreetingPresetPlan,
    computeGroupTogglePlan,
    countPinnedEntries,
    createTextareaHistory,
    detectAutoGroups,
    estimateEntryTokens,
    evaluateSceneAutoToggle,
    extractEditableEntrySnapshot,
    extractExternalScriptRouteLabel,
    extractWorldbookEntrySummaries,
    findNextMatchInText,
    formatGreetingCommentTag,
    formatOrphanedDraftText,
    isBookConfigEmpty,
    matchEntries,
    migrateSettingsOnWorldRename,
    normalizeBookConfig,
    normalizeSettings,
    parseDividerComment,
    parseEntryKeywordsInput,
    pruneOrphanAssignments,
    reconcileAccordionDraftOnExternalRefresh,
    removeDeletedWorldsFromSettings,
    removeGroupFromBookConfig,
    setEntryPinned,
    setGroupPinned,
    sliceGroupedSectionsForRender,
} from '../src/entry-groups/core.js';
import {
    applyGreetingPresetToWorldbook,
    captureExternalWorldbookSwitchForActiveChat,
    clearRuntimeBookSnapshots,
    getPreferredDefaultBook,
    loadWorldbookEntryForEditUncached,
    loadWorldbookSummariesUncached,
    locateEntryInNativeEditor,
    recordStateIntoActiveChatIfMatching,
    saveWorldbookEntryEdit,
    switchNamedGroupInActiveChat,
    syncNativeEditorDomFallback,
    syncSceneGroupsBeforeGeneration,
    syncWorldbookForActiveChat,
    syncWorldInfoCacheEntry,
    syncWorldInfoCacheMap,
} from '../src/entry-groups/host.js';

function createSamplePayload() {
    return {
        entries: {
            0: {
                uid: 0,
                comment: '=== 基础设定 ===',
                key: [],
                content: '',
                disable: true,
                constant: false,
                displayIndex: 0,
                group: 'keep_native_inclusion_group',
            },
            1: {
                uid: 1,
                comment: '【通用线】王朝地理',
                key: ['王都', '皇城'],
                content: '大段世界观正文内容……'.repeat(50),
                disable: false,
                constant: true,
                displayIndex: 1,
                group: 'keep_native_inclusion_group',
            },
            2: {
                uid: 2,
                comment: '【通用线】势力分布',
                key: ['公会'],
                content: '势力正文……',
                disable: false,
                constant: false,
                displayIndex: 2,
            },
            10: {
                uid: 10,
                comment: '【18岁线】少年意气',
                key: ['十八岁'],
                content: '18岁线设定 1',
                disable: false,
                displayIndex: 3,
            },
            11: {
                uid: 11,
                comment: '【18岁线】课桌秘密',
                key: ['教室'],
                content: '18岁线设定 2',
                disable: false,
                displayIndex: 4,
            },
            20: {
                uid: 20,
                comment: '【30岁线】久别重逢',
                key: ['酒会'],
                content: '30岁线设定 1',
                disable: true,
                displayIndex: 5,
            },
            21: {
                uid: 21,
                comment: '【30岁线】沉稳克制',
                key: ['办公室'],
                content: '30岁线设定 2',
                disable: true,
                displayIndex: 6,
            },
            30: {
                uid: 30,
                comment: '【通用线】nfsw亲密反应',
                key: ['呼吸'],
                content: '亲密设定正文',
                disable: true,
                constant: true,
                displayIndex: 7,
            },
            40: {
                uid: 40,
                comment: '——⬇️⬇️USER身份自选⬇️⬇️——',
                key: [],
                content: '',
                disable: true,
                displayIndex: 8,
            },
            41: {
                uid: 41,
                comment: '高门贵女user',
                key: [],
                content: '身份1',
                disable: true,
                displayIndex: 9,
            },
            42: {
                uid: 42,
                comment: '江湖侠客user',
                key: [],
                content: '身份2',
                disable: true,
                displayIndex: 10,
            },
            43: {
                uid: 43,
                comment: '——⬆️⬆️USER身份自选⬆️⬆️——',
                key: [],
                content: '',
                disable: true,
                displayIndex: 11,
            },
            44: {
                uid: 44,
                comment: '【状态栏】心声格式',
                key: [],
                content: '状态栏正文',
                disable: false,
                displayIndex: 12,
            },
        },
    };
}

test('Paired ⬇️...⬆️ dividers close cleanly, common lore stays NORMAL, and nfsw typo is recognized', () => {
    const summaries = extractWorldbookEntrySummaries(createSamplePayload());
    const proposals = detectAutoGroups(summaries, { strategy: 'smart', onlyUngrouped: true });

    const byName = new Map(proposals.map((p) => [p.name, p]));

    // 1. Typo `nfsw` recognized into `亲密剧情 (NSFW)` (`scene`)
    assert.equal(byName.get('亲密剧情 (NSFW)')?.suggestedMode, GROUP_MODES.SCENE);
    assert.deepEqual(byName.get('亲密剧情 (NSFW)')?.uids, ['30']);

    // 2. Bounded `⬇️⬇️USER身份自选⬇️⬇️` ... `⬆️⬆️USER身份自选⬆️⬆️` captures 41, 42 as RADIO,
    // excludes pure banner UIDs 40 & 43, and does NOT swallow UID 44 after `⬆️⬆️`!
    assert.equal(byName.get('USER身份自选')?.suggestedMode, GROUP_MODES.RADIO);
    assert.deepEqual(byName.get('USER身份自选')?.uids, ['41', '42']);

    // 3. `通用线` MUST stay `NORMAL`, while `18岁线` & `30岁线` become `IF_LINE`!
    assert.equal(byName.get('通用线')?.suggestedMode, GROUP_MODES.NORMAL);
    assert.deepEqual(byName.get('通用线')?.uids, ['1', '2']);
    assert.equal(byName.get('18岁线')?.suggestedMode, GROUP_MODES.IF_LINE);
    assert.equal(byName.get('30岁线')?.suggestedMode, GROUP_MODES.IF_LINE);
});

test('Emoji-decorated full-book section layers (——🐰🐰...🦊🦊——) preserve exact author layering without banner bloat', () => {
    const layeredPayload = {
        entries: [
            { uid: 100, displayIndex: 1, disable: true, comment: '——🐰🐰背景信息选择🦊🦊——', content: '', key: [] },
            { uid: 101, displayIndex: 2, disable: false, comment: '【常规线背景】名利场', content: 'A', key: [] },
            { uid: 102, displayIndex: 3, disable: true, comment: '【其他背景】二选一', content: 'B', key: [] },
            { uid: 200, displayIndex: 4, disable: false, comment: '——🐰🐰变量信息选择🦊🦊——', content: '', key: [] },
            { uid: 201, displayIndex: 5, disable: false, comment: '【常规变量】阶段设定', content: 'C', key: [] },
            { uid: 202, displayIndex: 6, disable: true, comment: '【分支变量】阶段覆盖', content: 'D', key: [] },
            { uid: 300, displayIndex: 7, disable: false, comment: '——🐰🐰开场白场景选择🦊🦊——', content: '', key: [] },
            { uid: 301, displayIndex: 8, disable: true, comment: '【常规·助理线】', content: 'E', key: [] },
            { uid: 302, displayIndex: 9, disable: true, comment: '【常规·演员线】', content: 'F', key: [] },
        ],
    };

    const summaries = extractWorldbookEntrySummaries(layeredPayload);
    const proposals = detectAutoGroups(summaries, { strategy: 'smart', onlyUngrouped: true });
    assert.equal(proposals.length, 3);
    assert.equal(proposals[0].name, '背景信息选择');
    assert.deepEqual(proposals[0].uids, ['101', '102']);
    assert.equal(proposals[1].name, '变量信息选择');
    assert.deepEqual(proposals[1].uids, ['201', '202']);
    assert.equal(proposals[2].name, '开场白场景选择');
    assert.equal(proposals[2].suggestedMode, GROUP_MODES.RADIO);
    assert.deepEqual(proposals[2].uids, ['301', '302']);
});

test('decorated choice headers keep their topic, radio mode and section boundaries', () => {
    const titles = [
        '☯۰•↓多选一·玩家身份↓•۰☯', '【身份】选项甲', '【身份】选项乙', '【身份】选项丙',
        '☯۰•↓三选一·玩家属性↓•۰☯', '属性甲', '属性乙', '属性丙',
        '☯۰•↓可选，补丁区域，自行选开↓•۰☯', '补丁甲', '补丁乙',
        '☯۰•↓可选，剧情走向，多选一开↓•۰☯', '日常向(多选一开)', '仙侠向（多选一开）',
        '=== 其他设定 ===', '其他正文',
    ];
    const entries = extractWorldbookEntrySummaries({ entries: titles.map((comment, uid) => ({
        uid, displayIndex: uid, comment, content: /↓|===/.test(comment) ? '' : '中性正文', key: [],
    })) });
    for (const strategy of ['smart', 'divider']) {
        const proposals = detectAutoGroups(entries, { strategy });
        const byName = new Map(proposals.map((group) => [group.name, group]));
        assert.deepEqual(byName.get('玩家身份')?.uids, ['1', '2', '3']);
        assert.equal(byName.get('玩家身份')?.suggestedMode, GROUP_MODES.RADIO);
        assert.deepEqual(byName.get('玩家属性')?.uids, ['5', '6', '7']);
        assert.equal(byName.get('玩家属性')?.suggestedMode, GROUP_MODES.RADIO);
        assert.deepEqual(byName.get('补丁区域')?.uids, ['9', '10']);
        assert.equal(byName.get('补丁区域')?.suggestedMode, GROUP_MODES.NORMAL);
        assert.deepEqual(byName.get('剧情走向')?.uids, ['12', '13']);
        assert.equal(byName.get('剧情走向')?.suggestedMode, GROUP_MODES.RADIO);
        const repair = detectAutoGroups(entries, { strategy, existingAssignments: { 1: 'manual', 2: 'manual', 12: 'manual' } });
        assert.deepEqual(repair.find((group) => group.name === '玩家身份')?.uids, ['3']);
        assert.equal(repair.find((group) => group.name === '玩家身份')?.suggestedMode, GROUP_MODES.RADIO);
        assert.deepEqual(repair.find((group) => group.name === '剧情走向')?.uids, ['13']);
        assert.equal(repair.find((group) => group.name === '剧情走向')?.suggestedMode, GROUP_MODES.RADIO);
    }
    const custom = detectAutoGroups(entries, { customRules: [{ group: '三选一·手动方案名', keywords: ['属性'] }] });
    assert.equal(custom[0].name, '三选一·手动方案名');
});

test('an explicit choice header wins over matching title prefixes and stops at the next plain section', () => {
    const titles = ['↓多选一·身份↓•۰☯', '【身份】甲', '【身份】乙', '=== 后续说明 ===', '说明正文'];
    const entries = extractWorldbookEntrySummaries({ entries: titles.map((comment, uid) => ({
        uid, displayIndex: uid, comment, content: uid === 0 || uid === 3 ? '' : '正文', key: [],
    })) });
    const group = detectAutoGroups(entries).find((item) => item.name === '身份');
    assert.deepEqual(group?.uids, ['1', '2']);
    assert.equal(group?.suggestedMode, GROUP_MODES.RADIO);
    const saved = { groups: [{ id: 'manual', name: '三选一·我的命名', mode: 'normal' }], assignments: { 4: 'manual' } };
    const next = applyAutoGroupProposals(saved, detectAutoGroups(entries, { existingAssignments: saved.assignments }));
    assert.deepEqual(next.groups.find((item) => item.id === 'manual'), normalizeBookConfig(saved).groups[0]);
    assert.equal(next.assignments['4'], 'manual');
});

test('a lone choice section is recognized with a single remaining ungrouped member', () => {
    const entries = extractWorldbookEntrySummaries({ entries: [
        { uid: 0, comment: '↓三选一·测试身份↓•۰☯', content: '', key: [] },
        { uid: 1, comment: '【角色】选项甲', content: '正文', key: [] },
        { uid: 2, comment: '【角色】选项乙', content: '正文', key: [] },
        { uid: 3, comment: '【角色】选项丙', content: '正文', key: [] },
    ] });
    for (const strategy of ['smart', 'divider']) {
        const proposals = detectAutoGroups(entries, { strategy, existingAssignments: { 1: 'manual', 2: 'manual' } });
        assert.deepEqual(proposals.map(({ name, suggestedMode, uids }) => ({ name, suggestedMode, uids })),
            [{ name: '测试身份', suggestedMode: GROUP_MODES.RADIO, uids: ['3'] }]);
    }
});

test('Overlapping greeting lore presets (shared common lore + distinct route lore) switch cleanly without losing common lore', () => {
    const summaries = extractWorldbookEntrySummaries(createSamplePayload());
    const greetIdx = buildGreetingCoordinationIndex({
        firstMes: '<!-- title: 目录 -->',
        alternateGreetings: [
            '<!-- title: 少年初遇 -->\n<!-- lore: 1, 2, 10, 11 -->\n开场1',
            '<!-- title: 重逢酒会 -->\n<!-- lore: 1, 2, 20, 21 -->\n<!-- exclude: 10 -->\n开场2',
        ],
    });

    const preset2 = computeGreetingPresetPlan(summaries, greetIdx, 2);
    assert.ok(preset2);
    assert.equal(preset2.routeLabel, '第 3 条开场白 重逢酒会');
    // Common lore 1 & 2 stay ENABLED (`disabled = false`), 20 & 21 ENABLED, while 10 & 11 turn OFF (`disabled = true`)!
    assert.equal(preset2.plan.get('1'), false);
    assert.equal(preset2.plan.get('2'), false);
    assert.equal(preset2.plan.get('20'), false);
    assert.equal(preset2.plan.get('21'), false);
    assert.equal(preset2.plan.get('10'), true);
    assert.equal(preset2.plan.get('11'), true);
});

test('IF-line mutex group toggle and scene (NSFW) cooldown work independently', () => {
    const payload = createSamplePayload();
    const summaries = extractWorldbookEntrySummaries(payload);
    const bookCfg = {
        groups: [
            { id: 'g_lore', name: '通用线', mode: GROUP_MODES.NORMAL, collapsed: false },
            { id: 'g_18', name: '18岁线', mode: GROUP_MODES.IF_LINE, collapsed: false },
            { id: 'g_30', name: '30岁线', mode: GROUP_MODES.IF_LINE, collapsed: false },
            { id: 'g_nsfw', name: '亲密剧情 (NSFW)', mode: GROUP_MODES.SCENE, cooldownTurns: 1 },
        ],
        assignments: { 1: 'g_lore', 2: 'g_lore', 10: 'g_18', 11: 'g_18', 20: 'g_30', 21: 'g_30', 30: 'g_nsfw' },
    };

    const plan = computeGroupTogglePlan(summaries, bookCfg, 'g_30', true);
    const res = applyTogglePlanToPayload(payload, plan);
    assert.equal(res.changedCount, 4);
    assert.equal(payload.entries[1].group, 'keep_native_inclusion_group');

    const hitEval = evaluateSceneAutoToggle({
        entries: [{ uid: '30', disabled: true }],
        bookConfig: bookCfg,
        recentText: '他低喘着深吻下来。',
        cooldownByGroupId: {},
    });
    assert.equal(hitEval.togglePlan.get('30'), false);
});

test('Zero chat-history scan + external script auto-follow + greeting preset lock across saves', async () => {
    clearRuntimeBookSnapshots();
    const diskStore = createSamplePayload();
    const apiCalls = [];

    const saveAMetadata = { variables: { custom_route: { name: '定制脚本A线' } } };
    const saveBMetadata = {};
    const extensionSettings = {
        worldbook_entry_groups: normalizeSettings({
            version: 2,
            autoSwitchOnChatChange: true,
            enableSceneAutoToggle: true,
            books: {
                角色主书: {
                    groups: [
                        { id: 'g_18', name: '18岁线', mode: GROUP_MODES.IF_LINE, collapsed: false },
                        { id: 'g_30', name: '30岁线', mode: GROUP_MODES.IF_LINE, collapsed: false },
                        { id: 'g_nsfw', name: '亲密剧情 (NSFW)', mode: GROUP_MODES.SCENE, cooldownTurns: 1 },
                    ],
                    assignments: { 10: 'g_18', 11: 'g_18', 20: 'g_30', 21: 'g_30', 30: 'g_nsfw' },
                },
            },
        }),
    };

    const poisonedChat = new Proxy([], {
        get(target, prop) {
            if (prop === 'length') return 5000;
            if (typeof prop === 'string' && /^\d+$/.test(prop)) {
                throw new Error(`FORBIDDEN: scanned chat floor ${prop}!`);
            }
            return Reflect.get(target, prop);
        },
    });

    let activeChatId = 'save_A';
    let activeChatMetadata = saveAMetadata;
    let activeChatMessages = poisonedChat;

    const origFetch = globalThis.fetch;
    const origST = globalThis.SillyTavern;

    globalThis.SillyTavern = {
        getContext: () => ({
            characterId: 0,
            characters: [{
                avatar: 'hero.png',
                name: '测试角色',
                first_mes: '<!-- title: 目录 -->',
                data: {
                    extensions: { world: '角色主书' },
                    alternate_greetings: [
                        '<!-- title: 18岁篇 -->\n<!-- lore: 1, 2, 10, 11 -->',
                        '<!-- title: 30岁篇 -->\n<!-- lore: 1, 2, 20, 21 -->',
                    ],
                },
            }],
            getCurrentChatId: () => activeChatId,
            chatMetadata: activeChatMetadata,
            chat: activeChatMessages,
            extensionSettings,
            saveSettingsDebounced: () => {},
            saveMetadataDebounced: () => {},
        }),
    };

    globalThis.fetch = async (url, init) => {
        const body = JSON.parse(init.body);
        apiCalls.push({ url, name: body.name });
        if (url === '/api/worldinfo/get') {
            return { ok: true, status: 200, json: async () => structuredClone(diskStore) };
        }
        if (url === '/api/worldinfo/edit') {
            Object.assign(diskStore, structuredClone(body.data));
            return { ok: true, status: 200, json: async () => ({ ok: true }) };
        }
        throw new Error(`Unexpected URL: ${url}`);
    };

    try {
        // 1. External script flips entries in Save A (e.g. turns on 41, turns off 42)
        diskStore.entries[41].disable = false;
        diskStore.entries[42].disable = true;
        assert.equal(extractExternalScriptRouteLabel(saveAMetadata), '定制脚本A线');
        const followed = await captureExternalWorldbookSwitchForActiveChat('角色主书');
        assert.ok(followed);
        assert.equal(saveAMetadata.worldbook_entry_groups.entryDisabledMap['41'], false);

        // 2. Switch to Save B and apply Greeting Preset #2 (`30岁篇`)
        activeChatId = 'save_B';
        activeChatMetadata = saveBMetadata;
        diskStore.entries[41].disable = true;
        diskStore.entries[42].disable = false;
        const greetIdx = buildGreetingCoordinationIndex({
            firstMes: '<!-- title: 目录 -->',
            alternateGreetings: [
                '<!-- title: 18岁篇 -->\n<!-- lore: 1, 2, 10, 11 -->',
                '<!-- title: 30岁篇 -->\n<!-- lore: 1, 2, 20, 21 -->',
            ],
        });
        const presetRes = await applyGreetingPresetToWorldbook('角色主书', greetIdx, 2);
        assert.equal(presetRes.ok, true);
        assert.equal(diskStore.entries[20].disable, false);
        assert.equal(diskStore.entries[10].disable, true);

        // Wait for self-write guard window not needed for `syncWorldbookForActiveChat`!
        // 3. Switch back to 5000-floor Save A -> restores BOTH 18岁线 AND external script's entry 41/42 state with ZERO chat scan!
        activeChatId = 'save_A';
        activeChatMetadata = saveAMetadata;
        activeChatMessages = poisonedChat;
        const restoreA = await syncWorldbookForActiveChat({ reason: 'chat-changed', silentToast: true });
        assert.equal(restoreA.synced, true);
        assert.equal(diskStore.entries[10].disable, false);
        assert.equal(diskStore.entries[20].disable, true);
        assert.equal(diskStore.entries[41].disable, false);
        assert.equal(diskStore.entries[42].disable, true);

        // 4. Mid-save `/weg 30岁线` progression + NSFW pre-generation test
        await switchNamedGroupInActiveChat('30岁线');
        assert.equal(saveAMetadata.worldbook_entry_groups.routeLabel, '30岁线');

        activeChatMessages = [{ is_user: true, mes: '日常买菜' }];
        const idleGen = await syncSceneGroupsBeforeGeneration('normal', false);
        assert.equal(idleGen.changedCount, 0);

        const initRead = await loadWorldbookSummariesUncached('角色主书');
        assert.ok(initRead.ok);
        assert.ok(recordStateIntoActiveChatIfMatching('角色主书', initRead.summaries));
    } finally {
        globalThis.fetch = origFetch;
        globalThis.SillyTavern = origST;
    }
});

for (const scenario of [
    { name: 'primary worldbook in an active chat', chatId: 'fixture-chat', primaryWorld: '测试主书', saved: true },
    { name: 'no active chat', chatId: '', primaryWorld: '测试主书', saved: false },
    { name: 'non-primary worldbook in an active chat', chatId: 'fixture-chat', primaryWorld: '其它主书', saved: false },
]) {
    test(`greeting preset reports chat save truthfully: ${scenario.name}`, async (t) => {
        clearRuntimeBookSnapshots();
        t.after(clearRuntimeBookSnapshots);
        const profileBefore = {
            worldName: '测试主书', routeLabel: '先前方案', ifGroupId: '',
            entryDisabledMap: { 1: true }, updatedAt: 123,
        };
        const context = {
            extensionSettings: { worldbook_entry_groups: normalizeSettings(null) },
            characterId: 0,
            characters: [{ avatar: 'fixture.png', data: { extensions: { world: scenario.primaryWorld } } }],
            getCurrentChatId: () => scenario.chatId,
            chatMetadata: scenario.saved ? { worldbook_entry_groups: structuredClone(profileBefore) } : {},
            chat: [],
            saveSettingsDebounced: () => {},
            saveMetadataDebounced: t.mock.fn(),
        };
        const previous = globalThis.SillyTavern;
        globalThis.SillyTavern = { getContext: () => context };
        t.after(() => { globalThis.SillyTavern = previous; });
        let payload = { entries: { 1: { uid: 1, comment: '基础资料', key: [], content: '资料', disable: true } } };
        let writes = 0;
        t.mock.method(globalThis, 'fetch', async (url, init) => {
            const body = JSON.parse(init.body);
            assert.equal(body.name, '测试主书');
            if (url === '/api/worldinfo/get') {
                return { ok: true, json: async () => structuredClone(payload) };
            }
            assert.equal(url, '/api/worldinfo/edit');
            payload = structuredClone(body.data);
            writes++;
            return { ok: true, json: async () => ({ ok: true }) };
        });
        const index = buildGreetingCoordinationIndex({ firstMes: '<!-- lore: 1 -->' });
        const result = await applyGreetingPresetToWorldbook('测试主书', index, 0);
        assert.equal(result.ok, true);
        assert.equal(result.changedCount, 1);
        assert.equal(writes, 1);
        assert.equal(payload.entries[1].disable, false);
        assert.equal(result.routeLabel, '第 1 条开场白');
        assert.equal(context.saveMetadataDebounced.mock.callCount(), scenario.saved ? 1 : 0);
        if (scenario.saved) {
            assert.equal(context.chatMetadata.worldbook_entry_groups.entryDisabledMap['1'], false);
            assert.equal(context.chatMetadata.worldbook_entry_groups.routeLabel, result.routeLabel);
        } else {
            assert.deepEqual(context.chatMetadata, {});
        }
        assert.equal(result.savedToChat, scenario.saved);
        assert.equal(result.boundChatKey, scenario.saved ? 'fixture.png::fixture-chat' : '');
        assert.deepEqual(result.appliedChanges, [{ uid: '1', disabled: false }]);
        assert.deepEqual(result.undoProfileBefore, scenario.saved ? profileBefore : null);
    });
}

test('greeting preset recomputes referenced UIDs from the fresh write payload', async (t) => {
    clearRuntimeBookSnapshots();
    t.after(clearRuntimeBookSnapshots);
    const previous = globalThis.SillyTavern;
    globalThis.SillyTavern = { getContext: () => null };
    t.after(() => { globalThis.SillyTavern = previous; });
    const original = { entries: {
        1: { uid: 1, comment: '基础资料', key: [], content: '资料', disable: true },
        3: { uid: 3, comment: '独立资料', key: [], content: '原文', disable: false },
    } };
    const fresh = structuredClone(original);
    fresh.entries[2] = { uid: 2, comment: '新增资料', key: [], content: '新增原文', disable: true };
    let reads = 0;
    let writes = 0;
    let written;
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        const body = JSON.parse(init.body);
        assert.equal(body.name, '测试主书');
        if (url === '/api/worldinfo/get') {
            const payload = ++reads === 1 ? original : fresh;
            return { ok: true, json: async () => structuredClone(payload) };
        }
        assert.equal(url, '/api/worldinfo/edit');
        writes++;
        written = body.data;
        return { ok: true, json: async () => ({ ok: true }) };
    });
    const index = buildGreetingCoordinationIndex({ firstMes: '<!-- lore: 1,2 -->' });
    const result = await applyGreetingPresetToWorldbook('测试主书', index, 0);
    assert.equal(result.ok, true);
    assert.equal(reads, 2);
    assert.equal(writes, 1);
    assert.equal(result.changedCount, 2);
    assert.deepEqual(result.appliedChanges, [
        { uid: '1', disabled: false }, { uid: '2', disabled: false },
    ]);
    const expected = structuredClone(fresh);
    expected.entries[1].disable = false;
    expected.entries[2].disable = false;
    assert.deepEqual(written, expected);
    assert.equal(result.summaries.find((entry) => entry.uid === '2').disabled, false);
    assert.equal(result.savedToChat, false);
    assert.equal(result.undoProfileBefore, null);
});

function installGreetingGuardFixture(t, { interruptAt, switchChat = false, initiallyDisabled = true } = {}) {
    clearRuntimeBookSnapshots();
    t.after(clearRuntimeBookSnapshots);
    const previousProfile = {
        worldName: '测试主书', routeLabel: '先前方案', ifGroupId: '',
        entryDisabledMap: { 1: initiallyDisabled }, updatedAt: 123,
    };
    const metadataA = { worldbook_entry_groups: structuredClone(previousProfile) };
    const metadataB = {};
    const context = {
        extensionSettings: { worldbook_entry_groups: normalizeSettings(null) },
        characterId: 0,
        characters: [{ avatar: 'fixture.png', data: { extensions: { world: '测试主书' } } }],
        getCurrentChatId: () => chatId,
        chatMetadata: metadataA, chat: [],
        saveSettingsDebounced: () => {}, saveMetadataDebounced: t.mock.fn(),
    };
    let chatId = 'A';
    let current = interruptAt !== 'start';
    let reads = 0;
    let writes = 0;
    let payload = { entries: { 1: { uid: 1, comment: '资料', content: '保留正文', disable: initiallyDisabled } } };
    const previous = globalThis.SillyTavern;
    globalThis.SillyTavern = { getContext: () => context };
    t.after(() => { globalThis.SillyTavern = previous; });
    const interrupt = (phase) => {
        if (phase !== interruptAt) return;
        if (switchChat) { chatId = 'B'; context.chatMetadata = metadataB; }
        else current = false;
    };
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        const body = JSON.parse(init.body);
        assert.equal(body.name, '测试主书');
        if (url === '/api/worldinfo/get') {
            const phase = ++reads === 1 ? 'first-read' : 'fresh-read';
            return { ok: true, json: async () => { interrupt(phase); return structuredClone(payload); } };
        }
        assert.equal(url, '/api/worldinfo/edit');
        writes++;
        payload = structuredClone(body.data);
        interrupt('write-sent');
        return { ok: true, json: async () => ({ ok: true }) };
    });
    return {
        run: () => applyGreetingPresetToWorldbook('测试主书', buildGreetingCoordinationIndex({ firstMes: '<!-- lore: 1 -->' }), 0, { isCurrent: () => current }),
        context, metadataA, metadataB, previousProfile,
        counts: () => ({ reads, writes }),
    };
}

for (const interruptAt of ['first-read', 'fresh-read', 'write-sent']) {
    test(`greeting preset never binds another chat after switching at ${interruptAt}`, async (t) => {
        const fixture = installGreetingGuardFixture(t, { interruptAt, switchChat: true });
        const result = await fixture.run();
        assert.equal(result.ok, true);
        assert.equal(result.changedCount, 1);
        assert.deepEqual(result.appliedChanges, [{ uid: '1', disabled: false }]);
        assert.equal(result.savedToChat, false);
        assert.equal(result.boundChatKey, '');
        assert.deepEqual(result.undoProfileBefore, fixture.previousProfile);
        assert.deepEqual(fixture.metadataA, { worldbook_entry_groups: fixture.previousProfile });
        assert.deepEqual(fixture.metadataB, {});
        assert.equal(fixture.context.saveMetadataDebounced.mock.callCount(), 0);
        assert.equal(fixture.counts().writes, 1);
    });
}

for (const interruptAt of ['start', 'first-read', 'fresh-read', 'write-sent']) {
    test(`greeting preset respects stop at ${interruptAt} without pretending a sent write was cancelled`, async (t) => {
        const fixture = installGreetingGuardFixture(t, { interruptAt });
        const result = await fixture.run();
        if (interruptAt === 'write-sent') {
            assert.equal(result.ok, true);
            assert.notEqual(result.cancelled, true);
            assert.equal(result.changedCount, 1);
            assert.deepEqual(result.appliedChanges, [{ uid: '1', disabled: false }]);
            assert.equal(fixture.counts().writes, 1);
            assert.equal(result.savedToChat, false);
            assert.equal(result.boundChatKey, '');
        } else {
            assert.equal(result.ok, false);
            assert.equal(result.cancelled, true);
            assert.equal(fixture.counts().writes, 0);
            if (interruptAt === 'start') assert.equal(fixture.counts().reads, 0);
            if (interruptAt === 'first-read') assert.equal(fixture.counts().reads, 1);
        }
        assert.equal(fixture.context.saveMetadataDebounced.mock.callCount(), 0);
        assert.deepEqual(fixture.metadataA, { worldbook_entry_groups: fixture.previousProfile });
    });
}

test('greeting preset returns metadata undo context even when no entry switch changes', async (t) => {
    const fixture = installGreetingGuardFixture(t, { initiallyDisabled: false });
    const result = await fixture.run();
    assert.equal(result.ok, true);
    assert.equal(result.changedCount, 0);
    assert.deepEqual(result.appliedChanges, []);
    assert.equal(result.savedToChat, true);
    assert.equal(result.boundChatKey, 'fixture.png::A');
    assert.deepEqual(result.undoProfileBefore, fixture.previousProfile);
    assert.equal(fixture.context.chatMetadata.worldbook_entry_groups.routeLabel, '第 1 条开场白');
    assert.equal(fixture.counts().writes, 0);
});

test('greeting preset errors explain an unavailable opening', async () => {
    assert.deepEqual(await applyGreetingPresetToWorldbook('', null, 0), {
        ok: false, error: '没有可用的开场方案',
    });
});

test('greeting preset errors explain an unmarked opening', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ entries: {} }) }));
    const index = buildGreetingCoordinationIndex({ firstMes: '未标记的开场' });
    assert.deepEqual(await applyGreetingPresetToWorldbook('测试主书', index, 0), {
        ok: false, error: '作者未在这条开场白中标记条目',
    });
});

function installAutomaticRestoreGuardFixture(t, { interruptAt, floorZero = false } = {}) {
    clearRuntimeBookSnapshots();
    t.after(clearRuntimeBookSnapshots);
    const profile = {
        worldName: '测试主书', routeLabel: '先前方案', ifGroupId: '',
        entryDisabledMap: { 1: false }, updatedAt: 123,
    };
    const settings = normalizeSettings({ version: 2, autoSwitchOnChatChange: true });
    const metadata = { worldbook_entry_groups: structuredClone(profile) };
    const context = {
        extensionSettings: { worldbook_entry_groups: settings },
        characterId: 0,
        characters: [{ avatar: 'fixture.png', first_mes: '<!-- lore: 1 -->', data: { extensions: { world: '测试主书' } } }],
        getCurrentChatId: () => 'A',
        chatMetadata: metadata,
        chat: floorZero ? [{ mes: '<!-- lore: 1 -->' }] : [{}, {}],
        saveSettingsDebounced: t.mock.fn(), saveMetadataDebounced: t.mock.fn(),
    };
    let current = interruptAt !== 'start';
    let reads = 0;
    let writes = 0;
    let payload = { entries: { 1: { uid: 1, comment: '基础资料', content: '保留正文', disable: true } } };
    const previous = globalThis.SillyTavern;
    const previousToastr = globalThis.toastr;
    const toast = t.mock.fn();
    globalThis.SillyTavern = { getContext: () => context };
    globalThis.toastr = { info: toast };
    t.after(() => { globalThis.SillyTavern = previous; globalThis.toastr = previousToastr; });
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        const body = JSON.parse(init.body);
        assert.equal(body.name, '测试主书');
        if (url === '/api/worldinfo/get') {
            const phase = ++reads === 1 ? 'first-read' : 'fresh-read';
            return { ok: true, json: async () => {
                if (interruptAt === phase) current = false;
                return structuredClone(payload);
            } };
        }
        assert.equal(url, '/api/worldinfo/edit');
        writes++;
        payload = structuredClone(body.data);
        if (interruptAt === 'write-sent') current = false;
        return { ok: true };
    });
    return {
        run: () => syncWorldbookForActiveChat({
            reason: floorZero ? 'floor0-swipe' : 'chat-changed', isCurrent: () => current,
        }),
        stop: () => { current = false; },
        counts: () => ({ reads, writes }),
        context, metadata, profile, settings, toast,
    };
}

for (const interruptAt of ['start', 'first-read', 'fresh-read', 'write-sent']) {
    test(`automatic chat route restore respects stop at ${interruptAt}`, async (t) => {
        const fixture = installAutomaticRestoreGuardFixture(t, { interruptAt });
        const result = await fixture.run();
        if (interruptAt === 'write-sent') {
            assert.equal(result.synced, true);
            assert.equal(result.changedCount, 1);
            assert.notEqual(result.cancelled, true);
            assert.deepEqual(fixture.counts(), { reads: 2, writes: 1 });
        } else {
            assert.equal(result.synced, false);
            assert.equal(result.cancelled, true);
            assert.equal(result.changedCount, 0);
            assert.deepEqual(fixture.counts(), {
                reads: interruptAt === 'start' ? 0 : interruptAt === 'first-read' ? 1 : 2,
                writes: 0,
            });
        }
        assert.equal(fixture.toast.mock.callCount(), 0);
        assert.equal(fixture.context.saveMetadataDebounced.mock.callCount(), 0);
        assert.deepEqual(fixture.metadata, { worldbook_entry_groups: fixture.profile });
    });
}

test('automatic chat route restore still applies the saved combination while current', async (t) => {
    const fixture = installAutomaticRestoreGuardFixture(t);
    const result = await fixture.run();
    assert.equal(result.synced, true);
    assert.equal(result.changedCount, 1);
    assert.deepEqual(fixture.counts(), { reads: 2, writes: 1 });
    assert.equal(fixture.toast.mock.callCount(), 1);
});

test('automatic chat route restore does not save a floor-zero profile after stop during greeting resolution', async (t) => {
    const fixture = installAutomaticRestoreGuardFixture(t, { floorZero: true });
    const pending = fixture.run();
    fixture.stop();
    const result = await pending;
    assert.equal(result.synced, false);
    assert.equal(result.cancelled, true);
    assert.deepEqual(fixture.counts(), { reads: 0, writes: 0 });
    assert.equal(fixture.context.saveMetadataDebounced.mock.callCount(), 0);
    assert.equal(fixture.context.saveSettingsDebounced.mock.callCount(), 0);
    assert.deepEqual(fixture.metadata, { worldbook_entry_groups: fixture.profile });
    assert.deepEqual(fixture.settings.chatProfiles, {});
});

function installChatActionGuardFixture(t, { action, interruptAt, switchChat = false, initiallyDisabled = true } = {}) {
    clearRuntimeBookSnapshots();
    t.after(clearRuntimeBookSnapshots);
    const settings = normalizeSettings({
        version: 2, enableSceneAutoToggle: true,
        books: { 测试主书: {
            groups: [{ id: 'g', name: '目标组', mode: action === 'scene' ? GROUP_MODES.SCENE : GROUP_MODES.NORMAL, sceneKeywords: ['场景信号'] }],
            assignments: { 1: 'g' },
        } },
    });
    const metadataA = {};
    const metadataB = {};
    let chatId = 'A';
    let current = interruptAt !== 'start';
    const context = {
        extensionSettings: { worldbook_entry_groups: settings },
        characterId: 0,
        characters: [{ avatar: 'fixture.png', data: { extensions: { world: '测试主书' } } }],
        getCurrentChatId: () => chatId, chat: [{ mes: '场景信号' }], chatMetadata: metadataA,
        saveMetadataDebounced: t.mock.fn(), saveSettingsDebounced: t.mock.fn(),
    };
    let reads = 0;
    let writes = 0;
    const payload = { entries: { 1: { uid: 1, comment: '资料', content: '保留正文', disable: initiallyDisabled } } };
    const previous = globalThis.SillyTavern;
    const previousToastr = globalThis.toastr;
    const toast = t.mock.fn();
    globalThis.SillyTavern = { getContext: () => context };
    globalThis.toastr = { info: toast, success: toast };
    t.after(() => { globalThis.SillyTavern = previous; globalThis.toastr = previousToastr; });
    const interrupt = (phase) => {
        if (interruptAt !== phase) return;
        if (switchChat) { chatId = 'B'; context.chatMetadata = metadataB; }
        else current = false;
    };
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        const body = JSON.parse(init.body);
        assert.equal(body.name, '测试主书');
        if (url === '/api/worldinfo/get') {
            const phase = ++reads === 1 ? 'first-read' : 'fresh-read';
            return { ok: true, json: async () => { interrupt(phase); return structuredClone(payload); } };
        }
        assert.equal(url, '/api/worldinfo/edit');
        writes++;
        interrupt('write-sent');
        return { ok: true };
    });
    return {
        run: () => action === 'scene'
            ? syncSceneGroupsBeforeGeneration('normal', false, { isCurrent: () => current })
            : switchNamedGroupInActiveChat('目标组', { isCurrent: () => current }),
        stop: () => { current = false; },
        counts: () => ({ reads, writes }), context, metadataA, metadataB, settings, toast,
    };
}

for (const action of ['scene', 'named']) {
    for (const switchChat of [false, true]) {
        for (const interruptAt of switchChat ? ['first-read', 'fresh-read', 'write-sent'] : ['start', 'first-read', 'fresh-read', 'write-sent']) {
            test(`${action} chat action guards ${switchChat ? 'chat change' : 'stop'} at ${interruptAt}`, async (t) => {
                const fixture = installChatActionGuardFixture(t, { action, interruptAt, switchChat });
                const result = await fixture.run();
                if (interruptAt === 'write-sent') {
                    assert.notEqual(result.cancelled, true);
                    assert.equal(fixture.counts().writes, 1);
                    if (action === 'scene') assert.equal(result.changedCount, 1);
                    else assert.equal(result.matched, true);
                } else {
                    assert.equal(result.cancelled, true);
                    assert.deepEqual(fixture.counts(), {
                        reads: interruptAt === 'start' ? 0 : interruptAt === 'first-read' ? 1 : 2,
                        writes: 0,
                    });
                }
                assert.equal(fixture.toast.mock.callCount(), 0);
                assert.equal(fixture.context.saveMetadataDebounced.mock.callCount(), 0);
                assert.equal(fixture.context.saveSettingsDebounced.mock.callCount(), 0);
                assert.deepEqual(fixture.metadataA, {});
                assert.deepEqual(fixture.metadataB, {});
                assert.deepEqual(fixture.settings.chatProfiles, {});
            });
        }
    }
    test(`${action} chat action preserves normal writes while current`, async (t) => {
        const fixture = installChatActionGuardFixture(t, { action });
        const result = await fixture.run();
        assert.notEqual(result.cancelled, true);
        assert.deepEqual(fixture.counts(), { reads: 2, writes: 1 });
        assert.equal(fixture.toast.mock.callCount(), 1);
        assert.equal(fixture.context.saveMetadataDebounced.mock.callCount(), action === 'named' ? 1 : 0);
    });
}

test('scene chat action stops before book I/O after its module await', async (t) => {
    const fixture = installChatActionGuardFixture(t, { action: 'scene' });
    const pending = fixture.run();
    fixture.stop();
    assert.equal((await pending).cancelled, true);
    assert.deepEqual(fixture.counts(), { reads: 0, writes: 0 });
});

for (const switchChat of [false, true]) {
    test(`named chat action does not bind no-op state after ${switchChat ? 'chat change' : 'stop'}`, async (t) => {
        const fixture = installChatActionGuardFixture(t, { action: 'named', interruptAt: 'first-read', switchChat, initiallyDisabled: false });
        assert.equal((await fixture.run()).cancelled, true);
        assert.deepEqual(fixture.counts(), { reads: 1, writes: 0 });
        assert.deepEqual(fixture.metadataA, {});
        assert.deepEqual(fixture.metadataB, {});
        assert.equal(fixture.context.saveMetadataDebounced.mock.callCount(), 0);
        assert.equal(fixture.toast.mock.callCount(), 0);
    });
}

test('automatic chat route restore leaves a worldbook with no saved grouping or route alone', async (t) => {
    const context = {
        extensionSettings: { worldbook_entry_groups: normalizeSettings(null) },
        characterId: 0,
        characters: [{ avatar: 'fixture.png', data: { extensions: { world: '测试主书' } } }],
        getCurrentChatId: () => 'fixture-chat',
        chatMetadata: {},
        chat: [{ mes: '<!-- lore: 1 -->' }],
    };
    const previous = globalThis.SillyTavern;
    globalThis.SillyTavern = { getContext: () => context };
    t.after(() => { globalThis.SillyTavern = previous; });
    const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected book I/O'); });
    assert.equal((await syncWorldbookForActiveChat()).changedCount, 0);
    assert.equal(await captureExternalWorldbookSwitchForActiveChat('测试主书'), null);
    assert.deepEqual(context.chatMetadata, {});
    assert.equal(fetch.mock.callCount(), 0);
});

test('Radio mode, search, orphan pruning, and wbo rename/delete migrations work cleanly', () => {
    const summaries = extractWorldbookEntrySummaries(createSamplePayload());
    const radioPlan = computeEntryTogglePlan(
        [
            { uid: '41', title: 'A', disabled: false, keys: [] },
            { uid: '42', title: 'B', disabled: true, keys: [] },
        ],
        { groups: [{ id: 'r1', name: '单选', mode: GROUP_MODES.RADIO }], assignments: { 41: 'r1', 42: 'r1' } },
        '42',
        true,
    );
    assert.equal(radioPlan.get('42'), false);
    assert.equal(radioPlan.get('41'), true);
    assert.equal(formatGreetingCommentTag(['11', '10'], 'lore'), '<!-- lore: 10,11 -->');

    const settings = normalizeSettings({
        lastOpenedBook: '旧书',
        books: { 旧书: { groups: [{ id: 'g1', name: '组', mode: 'normal' }], assignments: { 1: 'g1', 999: 'g1' } } },
    });
    assert.equal(pruneOrphanAssignments(settings.books['旧书'], new Set(summaries.map((s) => s.uid))), 1);
    assert.equal(matchEntries(summaries, '18岁 少年', { multiTerm: true }).has('10'), true);
    assert.equal(migrateSettingsOnWorldRename(settings, '旧书', '新书'), true);
    assert.equal(removeDeletedWorldsFromSettings(settings, ['新书']), true);
    assert.equal(applyAutoGroupProposals(null, [{ name: '测试组', uids: ['1'], mode: 'normal' }]).groups.length, 1);
    assert.equal(buildGroupedView(summaries, null).sections[0].id, SPECIAL_GROUP_UNGROUPED);
});

function createMockClassList(initial = []) {
    const set = new Set(initial);
    return {
        add: (...names) => names.forEach((n) => set.add(n)),
        remove: (...names) => names.forEach((n) => set.delete(n)),
        toggle: (name, force) => {
            if (force === undefined) {
                if (set.has(name)) {
                    set.delete(name);
                    return false;
                }
                set.add(name);
                return true;
            }
            if (force) set.add(name);
            else set.delete(name);
            return Boolean(force);
        },
        contains: (name) => set.has(name),
    };
}

test('syncWorldInfoCacheMap persists mutated clone via cache.set() and syncs originalData.entries', () => {
    class MockStructuredCloneMap extends Map {
        get(key) {
            return super.has(key) ? structuredClone(super.get(key)) : undefined;
        }
    }

    const cache = new MockStructuredCloneMap();
    cache.set('书A', {
        entries: {
            10: { uid: 10, disable: false },
            11: { uid: 11, disable: true },
            12: { uid: 12, enabled: true },
        },
        originalData: {
            entries: [
                { uid: 10, enabled: true },
                { uid: 11, enabled: false },
            ],
        },
    });

    const synced = syncWorldInfoCacheMap(cache, '书A', {}, [
        { uid: '10', disabled: true },
        { uid: '11', disabled: false },
        { uid: '12', disabled: true },
    ]);
    assert.equal(synced, true);

    const after = cache.get('书A');
    assert.equal(after.entries['10'].disable, true);
    assert.equal(after.entries['11'].disable, false);
    assert.equal(after.entries['12'].enabled, false);
    assert.equal(after.originalData.entries[0].enabled, false);
    assert.equal(after.originalData.entries[1].enabled, true);

    assert.equal(syncWorldInfoCacheMap(cache, '不存在的书', {}, []), false);
});

test('syncNativeEditorDomFallback toggles .disabledWIEntry, .killSwitch icons, and removes stale .disabled', () => {
    const makeRow = (uid, initialRowClasses, initialSwitchClasses) => {
        const killSwitch = { classList: createMockClassList(initialSwitchClasses) };
        return {
            uid: String(uid),
            classList: createMockClassList(initialRowClasses),
            querySelector: (sel) => (sel === '.killSwitch' ? killSwitch : null),
            killSwitch,
        };
    };

    const row10 = makeRow(10, [], ['fa-toggle-on', 'disabled']);
    const row11 = makeRow(11, ['disabledWIEntry'], ['fa-toggle-off', 'disabled']);
    const rowMap = new Map([['10', row10], ['11', row11]]);
    const listEl = {
        querySelector: (sel) => {
            const m = sel.match(/uid="([^"]+)"/);
            return m ? (rowMap.get(m[1]) || null) : null;
        },
    };

    const count = syncNativeEditorDomFallback(listEl, [
        { uid: '10', disabled: true },
        { uid: '11', disabled: false },
    ]);
    assert.equal(count, 2);

    assert.equal(row10.classList.contains('disabledWIEntry'), true);
    assert.equal(row10.killSwitch.classList.contains('fa-toggle-off'), true);
    assert.equal(row10.killSwitch.classList.contains('fa-toggle-on'), false);
    assert.equal(row10.killSwitch.classList.contains('disabled'), false);

    assert.equal(row11.classList.contains('disabledWIEntry'), false);
    assert.equal(row11.killSwitch.classList.contains('fa-toggle-on'), true);
    assert.equal(row11.killSwitch.classList.contains('fa-toggle-off'), false);
    assert.equal(row11.killSwitch.classList.contains('disabled'), false);
});

test('locateEntryInNativeEditor clears stale search before searching and clears unrelated search before page-2+ pagination', async () => {
    const origDocument = globalThis.document;
    const origEvent = globalThis.Event;
    const origJQuery = globalThis.jQuery;
    const origST = globalThis.SillyTavern;

    const createLocateHarness = ({ initialSearch = '', unrelatedMatchOnSearch = false }) => {
        const searchHistory = [];
        const pageHistory = [];
        let currentPage = 1;
        let renderedRows = [];

        const makeEntryNode = (uid) => ({
            uid: String(uid),
            offsetWidth: 100,
            classList: createMockClassList(),
            scrollIntoView: () => assert.fail('Entry navigation must only scroll the content list'),
        });

        const row1 = makeEntryNode('1');
        const row55 = makeEntryNode('55');
        const row99 = makeEntryNode('99');

        const renderRows = () => {
            const q = searchInput.value.trim();
            if (q === '目标条目' && !unrelatedMatchOnSearch) {
                renderedRows = [row55];
            } else if (q === '目标条目' && unrelatedMatchOnSearch) {
                renderedRows = [row99];
            } else if (q === '') {
                renderedRows = currentPage === 2 ? [row55] : [row1];
            } else {
                renderedRows = [row99];
            }
        };

        const listEl = {
            get children() { return renderedRows; },
            querySelectorAll: (sel) => (sel === '.world_entry' ? renderedRows : []),
            querySelector: (sel) => {
                const m = sel.match(/\.world_entry\[uid="([^"]+)"\]/);
                if (!m) return null;
                return renderedRows.find((r) => r.uid === m[1]) || null;
            },
        };

        const searchInput = {
            tagName: 'INPUT',
            value: initialSearch,
            dispatchEvent: (ev) => {
                if (ev?.type === 'input') {
                    searchHistory.push(searchInput.value);
                    renderRows();
                }
            },
        };

        const selectEl = {
            value: '0',
            querySelectorAll: () => [{ value: '0', textContent: '测试书', selected: true }],
        };
        const pagEl = { id: 'world_info_pagination' };
        const drawerEl = { classList: createMockClassList() };

        renderRows();

        globalThis.Event = class MockEvent {
            constructor(type, init = {}) {
                this.type = type;
                this.bubbles = Boolean(init.bubbles);
            }
        };
        globalThis.SillyTavern = { getContext: () => ({}) };
        globalThis.document = {
            getElementById: (id) => {
                if (id === 'WorldInfo') return drawerEl;
                if (id === 'world_editor_select') return selectEl;
                if (id === 'world_popup_entries_list') return listEl;
                if (id === 'world_info_search') return searchInput;
                if (id === 'world_info_pagination') return pagEl;
                return null;
            },
        };
        globalThis.jQuery = (el) => {
            if (el === pagEl) {
                return {
                    pagination: (cmd, arg) => {
                        if (cmd === 'getTotalPage') return 2;
                        if (cmd === 'getCurrentPageNum') return currentPage;
                        if (cmd === 'go') {
                            currentPage = Number(arg);
                            pageHistory.push(currentPage);
                            renderRows();
                        }
                    },
                };
            }
            const jqObj = {
                val: (v) => {
                    if (v === undefined) return selectEl.value;
                    selectEl.value = String(v);
                    return jqObj;
                },
                trigger: () => jqObj,
            };
            return jqObj;
        };

        return { searchHistory, pageHistory, searchInput, row55 };
    };

    const fastOpts = {
        initialWaitMs: 1,
        searchDebounceMs: 1,
        pollIntervalMs: 1,
        pollTimeoutMs: 20,
        pageWaitMs: 1,
    };

    try {
        // (i) Clears pre-existing `#world_info_search` first, then searches `entryTitle` and locates target
        const h1 = createLocateHarness({ initialSearch: '旧搜索词', unrelatedMatchOnSearch: false });
        const ok1 = await locateEntryInNativeEditor('测试书', '55', '目标条目', fastOpts);
        assert.equal(ok1, true);
        assert.deepEqual(h1.searchHistory, ['', '目标条目']);
        assert.equal(h1.row55.classList.contains('weg-entry-locate-flash'), true);

        // (ii) Search matches unrelated entry (renderedCount > 0), clears search unconditionally before traversing page 2
        const h2 = createLocateHarness({ initialSearch: '', unrelatedMatchOnSearch: true });
        const ok2 = await locateEntryInNativeEditor('测试书', '55', '目标条目', fastOpts);
        assert.equal(ok2, true);
        assert.deepEqual(h2.searchHistory, ['目标条目', '']);
        assert.deepEqual(h2.pageHistory, [2]);
        assert.equal(h2.searchInput.value, '');
        assert.equal(h2.row55.classList.contains('weg-entry-locate-flash'), true);
    } finally {
        globalThis.document = origDocument;
        globalThis.Event = origEvent;
        globalThis.jQuery = origJQuery;
        globalThis.SillyTavern = origST;
    }
});

test('the shorthand for a thinking-chain title only groups matching prefixes', () => {
    const entries = [
        { uid: '0', title: '（缝思维链内 测试甲', keys: [] },
        { uid: '1', title: '(缝思维链内 测试乙', keys: [] },
        { uid: '2', title: '关于思维链的测试备注', keys: [] },
        { uid: '3', title: '一般条目', content: '（缝思维链内 测试', keys: [] },
    ];
    for (const strategy of ['smart', 'prefix']) {
        const proposals = detectAutoGroups(entries, { strategy });
        assert.deepEqual(proposals.map(({ name, uids }) => [name, uids]), [['思维链', ['0', '1']]]);
        assert.deepEqual(detectAutoGroups(entries.slice(1), { strategy }), []);
    }
});

test('matching divider titles group both markers and only the entries between them', () => {
    const entries = extractWorldbookEntrySummaries({ entries: {
        0: { uid: 0, comment: '===== 测试规范 =====', content: '', key: [], disable: true },
        1: { uid: 1, comment: '规范正文', content: '测试内容', key: ['规范'], disable: true },
        2: { uid: 2, comment: '===== 测试规范 =====', content: '', key: [], disable: true },
        3: { uid: 3, comment: '区间以外', content: '测试内容', key: ['测试'], disable: true },
    } });
    for (const strategy of ['smart', 'divider']) {
        const proposals = detectAutoGroups(entries, { strategy });
        assert.equal(proposals.length, 1);
        assert.equal(proposals[0].name, '测试规范');
        assert.deepEqual(proposals[0].uids, ['0', '1', '2']);
        const config = applyAutoGroupProposals(null, proposals);
        const group = config.groups[0].id;
        assert.deepEqual([...computeGroupTogglePlan(entries, config, group, true)], [['1', false]]);
        delete config.assignments['2'];
        const repair = detectAutoGroups(entries, { strategy, existingAssignments: config.assignments });
        assert.deepEqual(repair[0].uids, ['2']);
        assert.equal(applyAutoGroupProposals(config, repair).assignments['2'], group);
    }
});

test('parseDividerComment handles single-wrapper empty banners, pure-emoji section banners, and rejects normal titles', () => {
    assert.deepEqual(parseDividerComment('—字字—', { hasContent: false, keyCount: 0 }), {
        isDivider: true,
        dividerKind: 'section',
        label: '字字',
        isPureBanner: true,
    });
    assert.deepEqual(parseDividerComment('-🎀字字-', { hasContent: false, keyCount: 0 }), {
        isDivider: true,
        dividerKind: 'section',
        label: '字字',
        isPureBanner: true,
    });
    assert.deepEqual(parseDividerComment('-🌏字字-', { hasContent: false, keyCount: 0 }), {
        isDivider: true,
        dividerKind: 'section',
        label: '字字',
        isPureBanner: true,
    });

    // Pure-emoji banner must be `'section'` with empty label (never `'end'`)
    assert.deepEqual(parseDividerComment('————👽🛸————', { hasContent: false, keyCount: 0 }), {
        isDivider: true,
        dividerKind: 'section',
        label: '',
        isPureBanner: true,
    });

    // Normal titles with content or keys must NOT be misclassified
    assert.equal(parseDividerComment('字字-字字', { hasContent: true, keyCount: 1 }).isDivider, false);
    assert.equal(parseDividerComment('-带正文-', { hasContent: true, keyCount: 0 }).isDivider, false);

    // Pure-emoji banner inside a ⬇️...⬆️ block must NOT close the block prematurely
    const blockPayload = {
        entries: [
            { uid: 1, displayIndex: 0, disable: true, comment: '——⬇️⬇️支线选择⬇️⬇️——', content: '', key: [] },
            { uid: 2, displayIndex: 1, disable: true, comment: '选项甲', content: '正文A', key: [] },
            { uid: 3, displayIndex: 2, disable: true, comment: '————👽🛸————', content: '', key: [] },
            { uid: 4, displayIndex: 3, disable: true, comment: '选项乙', content: '正文B', key: [] },
            { uid: 5, displayIndex: 4, disable: true, comment: '——⬆️⬆️支线选择⬆️⬆️——', content: '', key: [] },
        ],
    };
    const summaries = extractWorldbookEntrySummaries(blockPayload);
    const proposals = detectAutoGroups(summaries, { strategy: 'smart', onlyUngrouped: true });
    const branch = proposals.find((p) => p.name === '支线选择');
    assert.ok(branch);
    assert.deepEqual(branch.uids, ['2', '4']);

    // Unclosed prefix-only comments with content or keys must NOT be classified as dividers
    assert.equal(parseDividerComment('## 角色关系', { hasContent: true, keyCount: 1 }).isDivider, false);
    assert.equal(parseDividerComment('-- 补充', { hasContent: true, keyCount: 0 }).isDivider, false);
    assert.deepEqual(parseDividerComment('## 空分隔', { hasContent: false, keyCount: 0 }), {
        isDivider: true,
        dividerKind: 'section',
        label: '空分隔',
        isPureBanner: true,
    });
});

test('syncWorldInfoCacheMap and applyTogglePlanToPayload keep both disable and enabled synchronized on dual-field entries', () => {
    class MockStructuredCloneMap extends Map {
        get(key) {
            return super.has(key) ? structuredClone(super.get(key)) : undefined;
        }
    }

    const cache = new MockStructuredCloneMap();
    cache.set('双字段书', {
        entries: {
            30: { uid: 30, disable: false, enabled: true },
        },
    });
    const synced = syncWorldInfoCacheMap(cache, '双字段书', {}, [
        { uid: '30', disabled: true },
    ]);
    assert.equal(synced, true);
    const afterCache = cache.get('双字段书');
    assert.equal(afterCache.entries['30'].disable, true);
    assert.equal(afterCache.entries['30'].enabled, false);

    const payload = {
        entries: {
            30: { uid: 30, disable: false, enabled: true },
        },
    };
    const res = applyTogglePlanToPayload(payload, new Map([['30', true]]));
    assert.equal(res.changedCount, 1);
    assert.equal(payload.entries['30'].disable, true);
    assert.equal(payload.entries['30'].enabled, false);
});

test('locateEntryInNativeEditor rewinds non-jQuery pagination from page > 1 via .paginationjs-first and .paginationjs-prev', async () => {
    const origDocument = globalThis.document;
    const origEvent = globalThis.Event;
    const origJQuery = globalThis.jQuery;
    const origST = globalThis.SillyTavern;

    const createNoJqHarness = ({ useFirstButton }) => {
        let currentPage = 2;
        const clickLog = [];
        let renderedRows = [];

        const makeEntryNode = (uid) => ({
            uid: String(uid),
            offsetWidth: 100,
            classList: createMockClassList(),
            scrollIntoView: () => assert.fail('Entry navigation must only scroll the content list'),
        });

        const rowPage1 = makeEntryNode('1');
        const rowPage2 = makeEntryNode('26');
        const renderRows = () => {
            renderedRows = currentPage === 1 ? [rowPage1] : [rowPage2];
        };

        const listEl = {
            get children() { return renderedRows; },
            querySelector: (sel) => {
                const m = sel.match(/\.world_entry\[uid="([^"]+)"\]/);
                if (!m) return null;
                return renderedRows.find((r) => r.uid === m[1]) || null;
            },
        };

        const firstBtn = {
            click: () => {
                if (currentPage <= 1) return;
                currentPage = 1;
                clickLog.push('first->1');
                renderRows();
            },
        };
        const prevBtn = {
            click: () => {
                if (currentPage <= 1) return;
                currentPage -= 1;
                clickLog.push(`prev->${currentPage}`);
                renderRows();
            },
        };
        const nextBtn = {
            click: () => {
                if (currentPage >= 2) return;
                currentPage += 1;
                clickLog.push(`next->${currentPage}`);
                renderRows();
            },
        };

        const pagEl = {
            id: 'world_info_pagination',
            querySelector: (sel) => {
                if (sel === '.paginationjs-first:not(.disabled) a' || sel === '.paginationjs-first:not(.disabled)') {
                    return useFirstButton && currentPage > 1 ? firstBtn : null;
                }
                if (sel === '.paginationjs-prev:not(.disabled) a' || sel === '.paginationjs-prev:not(.disabled)') {
                    return currentPage > 1 ? prevBtn : null;
                }
                if (sel === '.paginationjs-next:not(.disabled) a' || sel === '.paginationjs-next:not(.disabled)') {
                    return currentPage < 2 ? nextBtn : null;
                }
                return null;
            },
        };

        const selectOpt = { value: '0', textContent: '分页测试书', selected: true };
        const selectEl = {
            value: '0',
            selectedOptions: [selectOpt],
            options: [selectOpt],
            querySelectorAll: () => [selectOpt],
            dispatchEvent: () => true,
        };
        const searchInput = { tagName: 'INPUT', value: '', dispatchEvent: () => {} };
        const drawerEl = { classList: createMockClassList() };

        renderRows();

        globalThis.Event = class MockEvent {
            constructor(type, init = {}) {
                this.type = type;
                this.bubbles = Boolean(init.bubbles);
            }
        };
        globalThis.SillyTavern = { getContext: () => ({}) };
        globalThis.jQuery = undefined;
        globalThis.document = {
            getElementById: (id) => {
                if (id === 'WorldInfo') return drawerEl;
                if (id === 'world_editor_select') return selectEl;
                if (id === 'world_popup_entries_list') return listEl;
                if (id === 'world_info_search') return searchInput;
                if (id === 'world_info_pagination') return pagEl;
                return null;
            },
        };

        return { clickLog, rowPage1 };
    };

    const fastOpts = {
        initialWaitMs: 1,
        searchDebounceMs: 1,
        pollIntervalMs: 1,
        pollTimeoutMs: 20,
        pageWaitMs: 1,
    };

    try {
        // (i) ST layout (`showPageNumbers: false`): `.paginationjs-first` jumps directly to page 1
        const hFirst = createNoJqHarness({ useFirstButton: true });
        const okFirst = await locateEntryInNativeEditor('分页测试书', '1', '首页条目', fastOpts);
        assert.equal(okFirst, true);
        assert.deepEqual(hFirst.clickLog, ['first->1']);
        assert.equal(hFirst.rowPage1.classList.contains('weg-entry-locate-flash'), true);

        // (ii) `.paginationjs-prev`-only fallback rewinds to page 1
        const hPrev = createNoJqHarness({ useFirstButton: false });
        const okPrev = await locateEntryInNativeEditor('分页测试书', '1', '首页条目', fastOpts);
        assert.equal(okPrev, true);
        assert.deepEqual(hPrev.clickLog, ['prev->1']);
        assert.equal(hPrev.rowPage1.classList.contains('weg-entry-locate-flash'), true);
    } finally {
        globalThis.document = origDocument;
        globalThis.Event = origEvent;
        globalThis.jQuery = origJQuery;
        globalThis.SillyTavern = origST;
    }
});

test('synchronized getWorldInfoNames tracks rename -> delete -> delete-last with getPreferredDefaultBook', () => {
    const origST = globalThis.SillyTavern;
    const origDocument = globalThis.document;
    let worldNames = ['旧书', '备用书'];

    globalThis.document = undefined;
    globalThis.SillyTavern = {
        getContext: () => ({
            getWorldInfoNames: () => [...worldNames],
        }),
    };

    try {
        const settings = normalizeSettings({
            lastOpenedBook: '旧书',
            books: {
                旧书: {
                    groups: [{ id: 'g1', name: '主线', mode: GROUP_MODES.NORMAL }],
                    assignments: { 1: 'g1' },
                },
            },
            chatProfiles: {
                'a::1': { worldName: '旧书', ifGroupId: 'g1', routeLabel: '主线', entryDisabledMap: {} },
            },
        });

        // 1. Rename 旧书 -> 新书 with synchronized host list
        worldNames = ['新书', '备用书'];
        assert.equal(migrateSettingsOnWorldRename(settings, '旧书', '新书'), true);
        clearRuntimeBookSnapshots('旧书');
        assert.equal(settings.lastOpenedBook, '新书');
        assert.equal(settings.chatProfiles['a::1'].worldName, '新书');
        assert.equal(getPreferredDefaultBook(settings), '新书');

        // 2. Delete 新书 leaving 备用书
        worldNames = ['备用书'];
        assert.equal(removeDeletedWorldsFromSettings(settings, ['新书']), true);
        clearRuntimeBookSnapshots('新书');
        assert.equal(settings.books['新书'], undefined);
        assert.equal(settings.lastOpenedBook, '');
        assert.equal(settings.chatProfiles['a::1'], undefined);
        assert.equal(getPreferredDefaultBook(settings), '备用书');

        // 3. Delete last book 备用书
        worldNames = [];
        removeDeletedWorldsFromSettings(settings, ['备用书']);
        clearRuntimeBookSnapshots('备用书');
        assert.equal(getPreferredDefaultBook(settings), '');
    } finally {
        globalThis.SillyTavern = origST;
        globalThis.document = origDocument;
    }
});

test('Pin/favorite groups & entries float to top, retain empty-group books, and clean up across delete/prune/rename', () => {
    // 1. A book with ONLY pinnedEntryUids (0 groups, 0 assignments) must be retained by normalizeSettings
    const pinOnlySettings = normalizeSettings({
        books: {
            纯置顶书: {
                groups: [],
                assignments: {},
                pinnedEntryUids: ['2', '2', ''],
                pinnedGroupIds: ['nonexistent', SPECIAL_GROUP_UNGROUPED],
            },
        },
    });
    assert.ok(pinOnlySettings.books['纯置顶书']);
    assert.deepEqual(pinOnlySettings.books['纯置顶书'].pinnedEntryUids, ['2']);
    assert.deepEqual(pinOnlySettings.books['纯置顶书'].pinnedGroupIds, [SPECIAL_GROUP_UNGROUPED]);
    assert.equal(isBookConfigEmpty({ groups: [], assignments: {}, pinnedEntryUids: ['2'] }), false);
    assert.equal(isBookConfigEmpty({ groups: [], assignments: {} }), true);

    // 2. Partition ordering in buildGroupedView: pinned groups first, pinned entries first in every section, ungrouped last
    const summaries = [
        { uid: '1', title: '普通1', disabled: false, keys: [] },
        { uid: '2', title: '置顶条目2', disabled: false, keys: [] },
        { uid: '3', title: '组内普通3', disabled: false, keys: [] },
        { uid: '4', title: '组内置顶4', disabled: false, keys: [] },
        { uid: '5', title: '未分组普通5', disabled: false, keys: [] },
        { uid: '6', title: '未分组置顶6', disabled: false, keys: [] },
    ];
    const cfg = normalizeBookConfig({
        groups: [
            { id: 'g1', name: '分组A', mode: GROUP_MODES.NORMAL },
            { id: 'g2', name: '分组B', mode: GROUP_MODES.IF_LINE },
            { id: 'g3', name: '分组C', mode: GROUP_MODES.NORMAL },
        ],
        assignments: { 1: 'g1', 2: 'g1', 3: 'g2', 4: 'g2' },
    });

    assert.deepEqual(setGroupPinned(cfg, 'g3'), { changed: true, pinned: true });
    assert.deepEqual(setGroupPinned(cfg, 'g2'), { changed: true, pinned: true });
    assert.deepEqual(setEntryPinned(cfg, '2'), { changed: true, pinned: true });
    assert.deepEqual(setEntryPinned(cfg, '4'), { changed: true, pinned: true });
    assert.deepEqual(setEntryPinned(cfg, '6'), { changed: true, pinned: true });

    const view = buildGroupedView(summaries, cfg);
    assert.deepEqual(view.sections.map((s) => s.id), ['g2', 'g3', 'g1', SPECIAL_GROUP_UNGROUPED]);
    assert.equal(view.sections[0].pinned, true);
    assert.equal(view.sections[2].pinned, false);
    assert.equal(view.sections[3].pinned, false);
    assert.deepEqual(view.sections[0].entries.map((e) => e.uid), ['4', '3']);
    assert.deepEqual(view.sections[2].entries.map((e) => e.uid), ['2', '1']);
    assert.deepEqual(view.sections[3].entries.map((e) => e.uid), ['6', '5']);
    assert.deepEqual(setGroupPinned(cfg, SPECIAL_GROUP_UNGROUPED), { changed: true, pinned: true });
    const withUngrouped = buildGroupedView(summaries, cfg);
    assert.deepEqual(withUngrouped.sections.map((s) => s.id), ['g2', 'g3', SPECIAL_GROUP_UNGROUPED, 'g1']);
    assert.equal(withUngrouped.sections[2].pinned, true);

    // 3. Replace-mode auto-group keeps pinnedEntryUids while clearing obsolete pinnedGroupIds
    const replaced = applyAutoGroupProposals(cfg, [{ name: '新组', uids: ['1'], mode: 'normal' }], { replaceExisting: true });
    assert.deepEqual(replaced.pinnedEntryUids, ['2', '4', '6']);
    assert.deepEqual(replaced.pinnedGroupIds, [SPECIAL_GROUP_UNGROUPED]);

    // 4. Group dissolution removes groupId from pinnedGroupIds
    assert.equal(removeGroupFromBookConfig(cfg, 'g2'), true);
    assert.deepEqual(cfg.pinnedGroupIds, ['g3', SPECIAL_GROUP_UNGROUPED]);

    // 5. Orphan pruning cleans deleted UIDs from pinnedEntryUids
    cfg.pinnedEntryUids.push('999');
    const pruned = pruneOrphanAssignments(cfg, new Set(['1', '2', '3', '4', '5', '6']));
    assert.ok(pruned >= 1);
    assert.equal(cfg.pinnedEntryUids.includes('999'), false);
    assert.ok(cfg.pinnedGroupIds.includes(SPECIAL_GROUP_UNGROUPED));

    // 6. Rename merge remaps pinnedGroupIds and merges pinnedEntryUids
    const mergeSettings = normalizeSettings({
        books: {
            旧书: {
                groups: [{ id: 'old_g', name: '新合并组', mode: GROUP_MODES.NORMAL }],
                assignments: { 1: 'old_g' },
                pinnedGroupIds: ['old_g'],
                pinnedEntryUids: ['1', '2'],
            },
            目标书: {
                groups: [{ id: 'new_g', name: '既有组', mode: GROUP_MODES.NORMAL }],
                assignments: { 3: 'new_g' },
                pinnedGroupIds: ['new_g'],
                pinnedEntryUids: ['2', '3'],
            },
        },
    });
    assert.equal(migrateSettingsOnWorldRename(mergeSettings, '旧书', '目标书'), true);
    assert.equal(mergeSettings.books['旧书'], undefined);
    assert.deepEqual(mergeSettings.books['目标书'].pinnedGroupIds, ['new_g', 'old_g']);
    assert.deepEqual(mergeSettings.books['目标书'].pinnedEntryUids, ['2', '3', '1']);
});

test('parseEntryKeywordsInput preserves exact case and keeps commas inside /regex/flags literals', () => {
    const parsed = parseEntryKeywordsInput('Sword, /fire,\\s*ice/gi, 火焰， "Alpha" , sword, /a[b,c]d/u');
    assert.deepEqual(parsed, [
        'Sword',
        '/fire,\\s*ice/gi',
        '火焰',
        '"Alpha"',
        'sword',
        '/a[b,c]d/u',
    ]);
});

test('applyEntryEditToPayload preserves 100% of undisplayed/unknown native ST fields and sibling entries', () => {
    const richPayload = {
        entries: {
            10: {
                uid: 10,
                comment: '原标题',
                disable: false,
                enabled: true,
                constant: false,
                vectorized: false,
                selective: true,
                key: ['OldKey'],
                keysecondary: ['OldSec'],
                position: 0,
                depth: 4,
                order: 100,
                content: '原正文',
                // 25+ advanced / unknown native fields that must NOT be lost!
                probability: 75,
                useProbability: true,
                selectiveLogic: 2,
                excludeRecursion: true,
                preventRecursion: true,
                delayUntilRecursion: 2,
                group: 'native_inclusion_grp',
                groupOverride: true,
                groupWeight: 42,
                role: 1,
                scanDepth: 6,
                caseSensitive: true,
                matchWholeWords: false,
                useGroupScoring: true,
                automationId: 'auto_script_7',
                sticky: 3,
                cooldown: 5,
                delay: 1,
                ignoreBudget: true,
                outletName: 'custom_outlet',
                addMemo: true,
                matchPersonaDescription: true,
                matchCharacterDescription: false,
                matchScenario: true,
                characterFilter: { isExclude: true, names: ['NPC_A'], tags: ['tag1'] },
                triggers: ['normal', 'continue'],
                displayIndex: 12,
                extensions: {
                    position: 0,
                    depth: 4,
                    vectorized: false,
                    custom_nested: { keepMe: true, count: 99 },
                },
                customUnknownField: { tag: 'preserve', arr: [1, 2, 3] },
            },
            11: {
                uid: 11,
                comment: '兄弟条目',
                content: '兄弟正文原样不动',
                disable: false,
                probability: 100,
                customSiblingKey: 'untouched',
            },
        },
        originalData: {
            name: '富字段世界书',
            entries: [
                {
                    uid: 10,
                    comment: '原标题',
                    enabled: true,
                    constant: false,
                    selective: true,
                    keys: ['OldKey'],
                    secondary_keys: ['OldSec'],
                    insertion_order: 100,
                    content: '原正文',
                    extensions: { position: 0, depth: 4, vectorized: false, keepOrigExt: 'yes' },
                },
            ],
        },
    };

    const snap = extractEditableEntrySnapshot(richPayload.entries[10]);
    assert.equal(snap.comment, '原标题');
    assert.equal(snap.enabled, true);
    assert.equal(snap.mode, ENTRY_ACTIVATION_MODES.SELECTIVE);

    const res = applyEntryEditToPayload(richPayload, '10', {
        comment: '新标题',
        enabled: false,
        mode: ENTRY_ACTIVATION_MODES.CONSTANT,
        key: 'NewKey, /alpha,beta/i',
        keysecondary: '',
        position: WORLD_INFO_POSITION.AT_DEPTH,
        depth: 2,
        order: 250,
        content: '修改后的正文\n保留换行',
    });

    assert.equal(res.ok, true);
    assert.equal(res.disabledChanged, true);
    const saved = richPayload.entries[10];

    // Edited fields updated accurately
    assert.equal(saved.comment, '新标题');
    assert.equal(saved.disable, true);
    assert.equal(saved.enabled, false);
    assert.equal(saved.constant, true);
    assert.equal(saved.vectorized, false);
    assert.deepEqual(saved.key, ['NewKey', '/alpha,beta/i']);
    assert.deepEqual(saved.keysecondary, []);
    assert.equal(saved.position, WORLD_INFO_POSITION.AT_DEPTH);
    assert.equal(saved.depth, 2);
    assert.equal(saved.order, 250);
    assert.equal(saved.content, '修改后的正文\n保留换行');

    // All 25+ undisplayed / unknown native fields preserved 100% verbatim!
    assert.equal(saved.probability, 75);
    assert.equal(saved.useProbability, true);
    assert.equal(saved.selectiveLogic, 2);
    assert.equal(saved.excludeRecursion, true);
    assert.equal(saved.preventRecursion, true);
    assert.equal(saved.delayUntilRecursion, 2);
    assert.equal(saved.group, 'native_inclusion_grp');
    assert.equal(saved.groupOverride, true);
    assert.equal(saved.groupWeight, 42);
    assert.equal(saved.role, 1);
    assert.equal(saved.scanDepth, 6);
    assert.equal(saved.caseSensitive, true);
    assert.equal(saved.matchWholeWords, false);
    assert.equal(saved.useGroupScoring, true);
    assert.equal(saved.automationId, 'auto_script_7');
    assert.equal(saved.sticky, 3);
    assert.equal(saved.cooldown, 5);
    assert.equal(saved.delay, 1);
    assert.equal(saved.ignoreBudget, true);
    assert.equal(saved.outletName, 'custom_outlet');
    assert.equal(saved.addMemo, true);
    assert.equal(saved.matchPersonaDescription, true);
    assert.equal(saved.matchCharacterDescription, false);
    assert.equal(saved.matchScenario, true);
    assert.deepEqual(saved.characterFilter, { isExclude: true, names: ['NPC_A'], tags: ['tag1'] });
    assert.deepEqual(saved.triggers, ['normal', 'continue']);
    assert.equal(saved.displayIndex, 12);
    assert.deepEqual(saved.extensions.custom_nested, { keepMe: true, count: 99 });
    assert.equal(saved.extensions.position, WORLD_INFO_POSITION.AT_DEPTH);
    assert.equal(saved.extensions.depth, 2);
    assert.deepEqual(saved.customUnknownField, { tag: 'preserve', arr: [1, 2, 3] });

    // originalData synced cleanly without losing keepOrigExt
    assert.equal(richPayload.originalData.entries[0].comment, '新标题');
    assert.equal(richPayload.originalData.entries[0].enabled, false);
    assert.equal(richPayload.originalData.entries[0].extensions.keepOrigExt, 'yes');

    // Sibling entry untouched
    assert.equal(richPayload.entries[11].content, '兄弟正文原样不动');
    assert.equal(richPayload.entries[11].customSiblingKey, 'untouched');
});

test('loadWorldbookEntryForEditUncached and saveWorldbookEntryEdit perform uncached I/O, single disk write, and conditional cache sync', async () => {
    clearRuntimeBookSnapshots();
    class MockStructuredCloneMap extends Map {
        get(key) {
            return super.has(key) ? structuredClone(super.get(key)) : undefined;
        }
    }

    const diskBook = {
        entries: {
            5: {
                uid: 5,
                comment: '初始条目',
                key: ['初始'],
                keysecondary: [],
                content: '初始正文',
                disable: false,
                constant: false,
                position: 0,
                depth: 4,
                order: 100,
                probability: 88,
                customUnknown: 'keep_me',
            },
        },
        originalData: {
            entries: [
                { uid: 5, comment: '初始条目', enabled: true, keys: ['初始'], secondary_keys: [], insertion_order: 100, content: '初始正文' },
            ],
        },
    };

    const cache = new MockStructuredCloneMap();
    cache.set('测试编辑书', structuredClone(diskBook));

    assert.equal(syncWorldInfoCacheEntry(cache, '未缓存书', '5', { comment: 'x' }), false);
    assert.equal(cache.has('未缓存书'), false);

    const apiCalls = [];
    const emittedEvents = [];
    const origFetch = globalThis.fetch;
    const origWindow = globalThis.window;
    const origCustomEvent = globalThis.CustomEvent;

    globalThis.CustomEvent = class MockCustomEvent {
        constructor(type, init = {}) {
            this.type = type;
            this.detail = init.detail;
        }
    };
    globalThis.window = {
        dispatchEvent: (ev) => {
            emittedEvents.push({ type: ev.type, detail: ev.detail });
            return true;
        },
    };
    globalThis.fetch = async (url, init) => {
        const body = JSON.parse(init.body);
        apiCalls.push({ url, name: body.name });
        if (url === '/api/worldinfo/get') {
            return { ok: true, status: 200, json: async () => structuredClone(diskBook) };
        }
        if (url === '/api/worldinfo/edit') {
            Object.assign(diskBook, structuredClone(body.data));
            return { ok: true, status: 200, json: async () => ({ ok: true }) };
        }
        throw new Error(`Unexpected URL: ${url}`);
    };

    try {
        const loaded = await loadWorldbookEntryForEditUncached('测试编辑书', '5');
        assert.equal(loaded.ok, true);
        assert.equal(loaded.entry.comment, '初始条目');

        const saved = await saveWorldbookEntryEdit('测试编辑书', '5', {
            comment: '直编后标题',
            enabled: false,
            mode: ENTRY_ACTIVATION_MODES.CONSTANT,
            key: 'Alpha, /one,two/i',
            position: WORLD_INFO_POSITION.AT_DEPTH,
            depth: 3,
            order: 180,
            content: '直编后正文',
        });

        assert.equal(saved.ok, true);
        assert.equal(saved.disabledChanged, true);
        assert.equal(diskBook.entries[5].comment, '直编后标题');
        assert.equal(diskBook.entries[5].disable, true);
        assert.equal(diskBook.entries[5].probability, 88);
        assert.equal(diskBook.entries[5].customUnknown, 'keep_me');
        assert.deepEqual(diskBook.entries[5].key, ['Alpha', '/one,two/i']);

        const editRequests = apiCalls.filter((c) => c.url === '/api/worldinfo/edit');
        assert.equal(editRequests.length, 1);

        // Manually verify syncWorldInfoCacheEntry on cached vs uncached Map entries
        assert.equal(syncWorldInfoCacheEntry(cache, '测试编辑书', '5', diskBook.entries[5]), true);
        const cachedAfter = cache.get('测试编辑书');
        assert.equal(cachedAfter.entries[5].comment, '直编后标题');
        assert.equal(cachedAfter.originalData.entries[0].enabled, false);
        assert.equal(cache.has('未缓存书'), false);

        assert.ok(emittedEvents.some((e) => e.type === 'weg:entry-saved' && e.detail.uid === '5'));
        assert.ok(emittedEvents.some((e) => e.type === 'weg:entries-toggled' && e.detail.changedCount === 1));
    } finally {
        globalThis.fetch = origFetch;
        globalThis.window = origWindow;
        globalThis.CustomEvent = origCustomEvent;
    }
});

test('estimateEntryTokens and applyTextareaTabIndent handle CJK/ASCII, multi-line selection, and Shift+Tab clamping', () => {
    assert.equal(estimateEntryTokens(''), 0);
    assert.equal(estimateEntryTokens('你好世界'), 6);
    assert.equal(estimateEntryTokens('hello world!'), 3);
    assert.ok(estimateEntryTokens('key: 设定\n  desc: test') >= 6);

    // Caret indent
    const caret = applyTextareaTabIndent('line1\nline2', 5, 5);
    assert.equal(caret.value, 'line1  \nline2');
    assert.equal(caret.selectionStart, 7);
    assert.equal(caret.selectionEnd, 7);

    // Multi-line selection indent & Shift+Tab outdent inverse
    const multi = applyTextareaTabIndent('alpha\nbeta\ngamma', 2, 10);
    assert.equal(multi.value, '  alpha\n  beta\ngamma');
    assert.equal(multi.selectionStart, 4);
    assert.equal(multi.selectionEnd, 14);

    // Shift+Tab outdent on 1-space & 2-space lines with start=0 clamping
    const out1 = applyTextareaTabIndent('  a\n b\nc', 1, 8, { shiftKey: true });
    assert.equal(out1.value, 'a\nb\nc');
    assert.equal(out1.selectionStart, 0);
    assert.equal(out1.selectionEnd, 5);

    // Start=0 with leading newline must stay at 0
    const outNewline = applyTextareaTabIndent('\n  line2', 0, 0, { shiftKey: true });
    assert.equal(outNewline.value, '\n  line2');
    assert.equal(outNewline.selectionStart, 0);
});

test('native grouping stays enabled by default and remembers an explicit opt-out without losing groups', () => {
    assert.equal(normalizeSettings(null).enableNativeGrouping, true);
    const settings = normalizeSettings({ enableNativeGrouping: false, books: { '设置测试书': {
        groups: [{ id: 'g1', name: '测试组' }], assignments: { 0: 'g1' },
    } } });
    assert.equal(normalizeSettings(settings).enableNativeGrouping, false);
    assert.equal(settings.books['设置测试书'].assignments['0'], 'g1');
});

test('native entry choice is a strict persisted boolean independent of the old hint and display permission', () => {
    for (const value of [undefined, null, false, 0, 1, 'true', {}, []]) {
        assert.equal(normalizeSettings({ nativeEntryChoiceSeen: value, nativeEntryHintSeen: true }).nativeEntryChoiceSeen, false);
    }
    const settings = normalizeSettings({ nativeEntryChoiceSeen: true, nativeEntryHintSeen: false,
        showNativeEntryBtn: false, enableNativeGrouping: true, books: { '选择测试书': {
            groups: [{ id: 'g1', name: '测试组' }], assignments: { 0: 'g1' },
        } } });
    const restored = normalizeSettings(JSON.parse(JSON.stringify(settings)));
    assert.equal(restored.nativeEntryChoiceSeen, true);
    assert.equal(restored.nativeEntryHintSeen, false);
    assert.equal(restored.showNativeEntryBtn, false);
    assert.equal(restored.enableNativeGrouping, true);
    assert.equal(restored.books['选择测试书'].assignments['0'], 'g1');
});

test('experimental automations default off and upgrading settings pauses both once', () => {
    const flags = (settings) => [settings.autoSwitchOnChatChange, settings.enableSceneAutoToggle];
    assert.deepEqual(flags(normalizeSettings(null)), [false, false]);
    const migrated = normalizeSettings({
        version: 1, autoSwitchOnChatChange: true, enableSceneAutoToggle: true, lastOpenedBook: '测试世界书',
    });
    assert.deepEqual(flags(migrated), [false, false]);
    assert.equal(migrated.lastOpenedBook, '测试世界书');
    assert.deepEqual(flags(normalizeSettings({
        ...migrated, autoSwitchOnChatChange: true, enableSceneAutoToggle: true,
    })), [true, true]);
});

test('computeEditDirty and normalizeSettings editor preferences work accurately', () => {
    const baseSnap = {
        uid: '1',
        comment: '标题',
        enabled: true,
        mode: ENTRY_ACTIVATION_MODES.SELECTIVE,
        position: 0,
        depth: 4,
        order: 100,
        key: ['a'],
        keysecondary: [],
        content: '正文',
    };
    assert.equal(computeEditDirty(baseSnap, { ...baseSnap, key: ['a'], keysecondary: [] }), false);
    assert.equal(computeEditDirty(baseSnap, { ...baseSnap, comment: '新标题' }), true);
    assert.equal(computeEditDirty(baseSnap, { ...baseSnap, enabled: false }), true);
    assert.equal(computeEditDirty(baseSnap, { ...baseSnap, mode: ENTRY_ACTIVATION_MODES.CONSTANT }), true);
    assert.equal(computeEditDirty(baseSnap, { ...baseSnap, position: 4 }), true);
    assert.equal(computeEditDirty(baseSnap, { ...baseSnap, depth: 0 }), true);
    assert.equal(computeEditDirty(baseSnap, { ...baseSnap, order: 0 }), true);
    assert.equal(computeEditDirty(baseSnap, { ...baseSnap, key: ['a', 'b'] }), true);
    assert.equal(computeEditDirty(baseSnap, { ...baseSnap, keysecondary: ['x'] }), true);
    assert.equal(computeEditDirty(baseSnap, { ...baseSnap, content: '正文2' }), true);

    const s1 = normalizeSettings({ editorMonospace: 1, editorHeightSize: 'l' });
    assert.equal(s1.editorMonospace, true);
    assert.equal(s1.editorHeightSize, 'L');
    const s2 = normalizeSettings({ editorMonospace: 0, editorHeightSize: 'XL' });
    assert.equal(s2.editorMonospace, false);
    assert.equal(s2.editorHeightSize, 'M');
});

test('In-place sortPinned:false, pinned filter matching, and >60 incremental slicing retain open editors', () => {
    const entries = Array.from({ length: 150 }, (_, i) => ({
        uid: String(i + 1),
        title: `条目_${i + 1}`,
        disabled: i % 2 === 1,
        keys: [`kw_${i + 1}`],
    }));

    const cfg = normalizeBookConfig({
        groups: [
            { id: 'g1', name: '第一组', mode: GROUP_MODES.NORMAL, collapsed: false },
            { id: 'g2', name: '第二组', mode: GROUP_MODES.NORMAL, collapsed: false },
            { id: 'g3', name: '折叠组', mode: GROUP_MODES.NORMAL, collapsed: true },
        ],
        assignments: Object.fromEntries([
            ...entries.slice(0, 100).map((e) => [e.uid, 'g1']),
            ...entries.slice(100, 145).map((e) => [e.uid, 'g2']),
            ...entries.slice(145).map((e) => [e.uid, 'g3']),
        ]),
        pinnedGroupIds: ['g2'],
        pinnedEntryUids: ['5'],
    });

    // 1. sortPinned:false keeps group & entry order while marking `pinned: true`
    const frozenView = buildGroupedView(entries, cfg, { sortPinned: false });
    assert.deepEqual(frozenView.sections.map((s) => s.id), ['g1', 'g2', 'g3', SPECIAL_GROUP_UNGROUPED]);
    assert.equal(frozenView.sections[1].pinned, true);
    assert.equal(frozenView.sections[0].entries[0].uid, '1');

    // 2. countPinnedEntries + matchEntries statusFilter:'pinned'
    assert.equal(countPinnedEntries(entries, cfg), 46); // 45 in pinned g2 + uid '5' in g1
    const pinnedMatched = matchEntries(entries, '', {
        statusFilter: 'pinned',
        pinnedEntrySet: new Set(cfg.pinnedEntryUids),
        pinnedGroupSet: new Set(cfg.pinnedGroupIds),
        assignments: cfg.assignments,
    });
    assert.equal(pinnedMatched.size, 46);
    assert.equal(pinnedMatched.has('5'), true);
    assert.equal(pinnedMatched.has('101'), true);
    assert.equal(pinnedMatched.has('1'), false);

    // 3. Search across all 150 entries matches #140
    const search140 = matchEntries(entries, '140');
    assert.equal(search140.has('140'), true);

    // 4. sliceGroupedSectionsForRender: default 60 limit across expanded sections, collapsed g3 consumes 0 budget,
    //    and open accordion UID '140' stays mounted even past index 60!
    const slicedDefault = sliceGroupedSectionsForRender(frozenView.sections, { limit: 60 });
    assert.equal(slicedDefault.shownCount, 60);
    assert.equal(slicedDefault.totalCount, 145); // g1(100) + g2(45); g3(5) is collapsed!
    assert.equal(slicedDefault.hiddenCount, 85);
    assert.equal(slicedDefault.sections[0].renderedEntries.length, 60);
    assert.equal(slicedDefault.sections[1].renderedEntries.length, 0);
    assert.equal(slicedDefault.sections[2].renderedEntries.length, 0);

    const slicedWithOpen = sliceGroupedSectionsForRender(frozenView.sections, {
        limit: 60,
        alwaysIncludeUids: new Set(['140']),
    });
    assert.equal(slicedWithOpen.shownCount, 61);
    assert.equal(slicedWithOpen.hiddenCount, 84);
    assert.deepEqual(slicedWithOpen.sections[1].renderedEntries.map((e) => e.uid), ['140']);
});

test('reconcileAccordionDraftOnExternalRefresh and applyEntryEditPatchToRawEntry edge cases', () => {
    const baseSnap = {
        uid: '10',
        comment: '原标题',
        enabled: true,
        mode: ENTRY_ACTIVATION_MODES.SELECTIVE,
        position: 0,
        depth: 4,
        order: 100,
        key: ['A'],
        keysecondary: [],
        content: '原内容',
    };
    const changedExternalSnap = { ...baseSnap, content: '外部新内容' };

    // Clean open editor refreshes to external state
    const rClean = reconcileAccordionDraftOnExternalRefresh(
        { dirty: false, initialSnapshot: baseSnap, draft: { ...baseSnap } },
        changedExternalSnap,
    );
    assert.equal(rClean.action, 'update-clean');
    assert.equal(rClean.nextDraft.content, '外部新内容');
    assert.equal(rClean.externalStale, false);

    // Dirty editor when unrelated entry changed (this entry unchanged) stays clean of stale warning
    const rUnchanged = reconcileAccordionDraftOnExternalRefresh(
        { dirty: true, initialSnapshot: baseSnap, draft: { ...baseSnap, content: '本地草稿' } },
        { ...baseSnap },
    );
    assert.equal(rUnchanged.action, 'keep-dirty-unchanged');
    assert.equal(rUnchanged.nextDraft.content, '本地草稿');
    assert.equal(rUnchanged.externalStale, false);

    // Dirty editor when same entry changed externally preserves draft & flags stale
    const rStale = reconcileAccordionDraftOnExternalRefresh(
        { dirty: true, initialSnapshot: baseSnap, draft: { ...baseSnap, content: '本地草稿' } },
        changedExternalSnap,
    );
    assert.equal(rStale.action, 'mark-external-stale');
    assert.equal(rStale.nextDraft.content, '本地草稿');
    assert.equal(rStale.nextInitial.content, '外部新内容');
    assert.equal(rStale.externalStale, true);

    // Deleted externally: clean closes, dirty warns without dropping draft
    assert.equal(
        reconcileAccordionDraftOnExternalRefresh({ dirty: false, initialSnapshot: baseSnap, draft: baseSnap }, null).action,
        'close',
    );
    const rDeletedDirty = reconcileAccordionDraftOnExternalRefresh(
        { dirty: true, initialSnapshot: baseSnap, draft: { ...baseSnap, content: '本地草稿' } },
        null,
    );
    assert.equal(rDeletedDirty.action, 'warn-deleted');
    assert.equal(rDeletedDirty.nextDraft.content, '本地草稿');
    assert.equal(rDeletedDirty.externalStale, true);

    // applyEntryEditPatchToRawEntry + array-backed payload edge cases (empty comment, empty keys, depth:0, order:0)
    const arrayPayload = {
        entries: [
            {
                uid: 7,
                comment: '旧名',
                key: ['k1'],
                keysecondary: ['k2'],
                depth: 4,
                order: 50,
                content: 'old',
                disable: false,
                probability: 65,
                customNested: { keep: 1 },
            },
        ],
    };
    const patchRes = applyEntryEditToPayload(arrayPayload, '7', {
        comment: '',
        key: '',
        keysecondary: '',
        depth: 0,
        order: 0,
        content: '',
        enabled: true,
    });
    assert.equal(patchRes.ok, true);
    assert.equal(arrayPayload.entries[0].comment, '');
    assert.deepEqual(arrayPayload.entries[0].key, []);
    assert.deepEqual(arrayPayload.entries[0].keysecondary, []);
    assert.equal(arrayPayload.entries[0].depth, 0);
    assert.equal(arrayPayload.entries[0].order, 0);
    assert.equal(arrayPayload.entries[0].content, '');
    assert.equal(arrayPayload.entries[0].probability, 65);
    assert.deepEqual(arrayPayload.entries[0].customNested, { keep: 1 });

    const directPatch = applyEntryEditPatchToRawEntry(
        { uid: 9, comment: 'x', unknownProp: 'keep' },
        { depth: 0, order: 0 },
    );
    assert.equal(directPatch.updatedEntry.depth, 0);
    assert.equal(directPatch.updatedEntry.order, 0);
    assert.equal(directPatch.updatedEntry.unknownProp, 'keep');
});

test('Full-content search (zero truncation), createTextareaHistory undo/redo, and findNextMatchInText', () => {
    const longBody = `${'填充文本_'.repeat(500)}隐藏在末尾的秘密暗号XYZ`;
    const payload = {
        entries: {
            88: {
                uid: 88,
                comment: '普通标题',
                key: ['普通词'],
                content: longBody,
                disable: false,
            },
        },
    };
    const summaries = extractWorldbookEntrySummaries(payload);
    assert.equal(summaries[0].searchText.includes('隐藏在末尾的秘密暗号xyz'), true);
    const matched = matchEntries(summaries, '隐藏在末尾的秘密暗号XYZ');
    assert.equal(matched.has('88'), true);

    const snap = extractEditableEntrySnapshot(payload.entries[88]);
    assert.equal(snap.content.length, longBody.length);
    assert.equal(snap.content.endsWith('隐藏在末尾的秘密暗号XYZ'), true);

    // Undo / Redo history surviving Tab indent
    const history = createTextareaHistory('alpha\nbeta', 0, 0);
    assert.equal(history.canUndo(), false);
    assert.equal(history.canRedo(), false);
    const tabbed = applyTextareaTabIndent('alpha\nbeta', 0, 0);
    assert.equal(history.push(tabbed.value, tabbed.selectionStart, tabbed.selectionEnd), true);
    assert.equal(history.canUndo(), true);
    const undone = history.undo();
    assert.equal(undone.value, 'alpha\nbeta');
    assert.equal(history.canRedo(), true);
    const redone = history.redo();
    assert.equal(redone.value, '  alpha\nbeta');
    assert.equal(redone.selectionStart, 2);

    // Pushing new edit clears redo stack
    history.undo();
    history.push('custom', 6, 6);
    assert.equal(history.canRedo(), false);

    // In-editor find next / prev with wrap-around
    const text = 'Alpha beta alpha GAMMA alpha';
    const f1 = findNextMatchInText(text, 'alpha', 0, { direction: 'next' });
    assert.deepEqual(f1, { found: true, start: 0, end: 5, matchIndex: 0, totalMatches: 3 });
    const f2 = findNextMatchInText(text, 'alpha', f1.end, { direction: 'next' });
    assert.deepEqual(f2, { found: true, start: 11, end: 16, matchIndex: 1, totalMatches: 3 });
    const f3 = findNextMatchInText(text, 'alpha', f2.end, { direction: 'next' });
    assert.deepEqual(f3, { found: true, start: 23, end: 28, matchIndex: 2, totalMatches: 3 });
    const fWrapNext = findNextMatchInText(text, 'alpha', f3.end, { direction: 'next' });
    assert.deepEqual(fWrapNext, { found: true, start: 0, end: 5, matchIndex: 0, totalMatches: 3 });
    const fWrapPrev = findNextMatchInText(text, 'alpha', fWrapNext.start, { direction: 'prev' });
    assert.deepEqual(fWrapPrev, { found: true, start: 23, end: 28, matchIndex: 2, totalMatches: 3 });
    const fNone = findNextMatchInText(text, 'not-present', 0);
    assert.equal(fNone.found, false);
    assert.equal(fNone.totalMatches, 0);

});

test('collectOrphanedOpenDrafts and formatOrphanedDraftText surface externally deleted dirty drafts accurately', () => {
    const openEditors = new Map([
        ['1', {
            uid: '1',
            worldName: '测试书',
            dirty: true,
            externalDeleted: false,
            draft: { comment: '仍存在的条目', key: ['k1'], content: '正常修改' },
        }],
        ['75', {
            uid: '75',
            worldName: '测试书',
            dirty: true,
            externalDeleted: true,
            draft: { comment: '被外部删除的条目', key: ['触发A', '触发B'], keysecondary: ['次词'], content: '重要未保存草稿正文' },
        }],
        ['76', {
            uid: '76',
            worldName: '测试书',
            dirty: false,
            externalDeleted: false,
            draft: { comment: '干净未修改条目', key: [], content: '原正文' },
        }],
        ['77', {
            uid: '77',
            worldName: '另一本书',
            dirty: true,
            externalDeleted: true,
            draft: { comment: '其他书的条目', key: [], content: '不混入当前书' },
        }],
    ]);

    const summaries = [{ uid: '1', title: '仍存在的条目' }];
    const orphaned = collectOrphanedOpenDrafts(openEditors, summaries, '测试书');
    assert.equal(orphaned.length, 1);
    assert.deepEqual(orphaned[0], {
        uid: '75',
        title: '被外部删除的条目',
        worldName: '测试书',
        dirty: true,
        externalDeleted: true,
    });

    // Empty summaries (e.g. last entry deleted) still preserves the orphaned dirty draft
    const orphanedWhenBookEmpty = collectOrphanedOpenDrafts(openEditors, [], '测试书');
    assert.deepEqual(orphanedWhenBookEmpty.map((o) => o.uid), ['1', '75']);

    assert.equal(collectOrphanedOpenDrafts(null, [], '测试书').length, 0);

    const copied = formatOrphanedDraftText(openEditors.get('75'));
    assert.equal(copied.includes('标题：被外部删除的条目'), true);
    assert.equal(copied.includes('主触发词：触发A, 触发B'), true);
    assert.equal(copied.includes('次触发词：次词'), true);
    assert.equal(copied.endsWith('重要未保存草稿正文'), true);
    assert.equal(formatOrphanedDraftText(null), '');
});
