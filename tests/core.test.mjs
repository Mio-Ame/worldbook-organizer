import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
    AI_ORGANIZE_CATEGORY_PRESETS,
    AI_ORGANIZE_NAMING_PRESETS,
    DEFAULT_LOCAL_ORGANIZE_CATEGORY_IDS,
    DEFAULT_SETTINGS,
    GROUP_COLOR_PALETTE,
    LOCAL_ORGANIZE_CATEGORIES,
    MODULE_NAME,
    SPECIAL_GROUPS,
    WORLD_ENTRY_POSITIONS,
    addCustomGroup,
    analyzeSensitiveOrganizeState,
    applyAiOrganizeProposals,
    buildAiOrganizePrompt,
    buildCharBooksCountMap,
    buildLocalOrganizeProposals,
    buildCharacterBindingIndex,
    buildPersonaBindingIndex,
    charaFileName,
    classifyWorldbooks,
    cleanupDeletedWorldSettings,
    compareWorldbookEntries,
    compareZhCn,
    createApiChannelId,
    createGlobalPresetId,
    createGroupId,
    createNewRawWorldEntry,
    deepClone,
    deleteAiOrganizePreset,
    deleteGlobalPreset,
    detectAiRefusal,
    estimateEntryTokens,
    exportConfigData,
    extractEmbeddedCharacterBookPreview,
    extractEntryListItems,
    extractSingleEntryForEdit,
    findCardsWithUnimportedBooks,
    findMatchingGlobalPreset,
    findSensitiveTargetGroup,
    findUnscannedShallowCharacters,
    formatCharacterDisplayTitle,
    getEffectiveAiOrganizePresets,
    importConfigData,
    isBookPinned,
    isBookVisibleInCharBindPopup,
    isBookVisibleInSelector,
    isPotentiallySensitiveTitle,
    matchesSearch,
    mergeEntryPatchOntoRaw,
    migrateSettingsOnWorldRename,
    moveBooksToNamedGroup,
    moveGlobalPreset,
    moveSectionOrder,
    normalizeEntryKeywordsInput,
    normalizeSettings,
    parseAiOrganizeResponse,
    parseOptionalFiniteNumber,
    partitionGroupPickerBooks,
    promoteSectionToTop,
    pruneStaleWorldbookSettings,
    pushUndoSnapshot,
    reorderBookInGroup,
    reorderSection,
    resetAiOrganizePresets,
    restoreOrganizeSnapshot,
    searchEntriesInPayload,
    summarizeCharacterWorldCoverage,
    summarizePersonaWorldBindings,
    togglePinnedBook,
    undoLastAiOrganize,
    updateCachedCharBindings,
    upsertAiOrganizePreset,
    upsertGlobalPreset,
} from '../src/core.js';

test('character binding detection covers primary, extra charLore, embedded, and shallow lazy-load cache', () => {
    const fullChars = [
        {
            avatar: 'Alice.png',
            name: '艾莉丝',
            shallow: false,
            data: {
                extensions: { world: '【v3.2作者原版】艾莉丝世界观' },
                character_book: { name: '艾莉丝内嵌设定' },
            },
        },
        {
            avatar: 'Bob.png',
            name: '鲍勃',
            shallow: false,
            data: { extensions: { world: '' } },
        },
    ];

    // Step 1: learn bindings from full characters
    const { cached, changed } = updateCachedCharBindings({}, fullChars);
    assert.equal(changed, true);
    assert.equal(cached['Alice.png'].primary, '【v3.2作者原版】艾莉丝世界观');
    assert.equal(cached['Alice.png'].embedded, '艾莉丝内嵌设定');
    assert.equal(cached['Bob.png'].scanned, true);
    assert.equal(cached['Bob.png'].primary, null);

    // Step 2: simulate reload with lazyLoadCharacters=true (shallow characters)
    const shallowChars = [
        { avatar: 'Alice.png', name: '艾莉丝', shallow: true },
        { avatar: 'Bob.png', name: '鲍勃', shallow: true },
    ];
    const afterShallow = updateCachedCharBindings(cached, shallowChars);
    assert.equal(afterShallow.cached['Alice.png'].primary, '【v3.2作者原版】艾莉丝世界观');

    const worldNames = [
        '【v3.2作者原版】艾莉丝世界观',
        '艾莉丝内嵌设定',
        '艾莉丝附加剧情书',
        '通用现代文风',
    ];
    const bindingMap = buildCharacterBindingIndex({
        characters: shallowChars,
        charLore: [{ name: 'Alice', extraBooks: ['艾莉丝附加剧情书'] }],
        cachedCharBindings: afterShallow.cached,
        worldNamesSet: new Set(worldNames),
        includeExtraCharBooks: true,
        includeEmbeddedNameMatch: true,
    });

    assert.equal(bindingMap.has('【v3.2作者原版】艾莉丝世界观'), true);
    assert.equal(bindingMap.has('艾莉丝附加剧情书'), true);
    assert.equal(bindingMap.has('艾莉丝内嵌设定'), true);
    assert.equal(bindingMap.has('通用现代文风'), false);

    // Deleted character is cleaned from cache
    const afterDelete = updateCachedCharBindings(afterShallow.cached, [
        { avatar: 'Bob.png', name: '鲍勃', shallow: true },
    ]);
    assert.equal(afterDelete.changed, true);
    assert.equal(afterDelete.cached['Alice.png'], undefined);
});

test('character worldbooks display by character name with optional small original title', () => {
    const worldNames = ['作者乱起的名字_v9_final', '通用规则书'];
    const bindingMap = new Map([
        ['作者乱起的名字_v9_final', [{ avatar: 'Luna.png', charName: '露娜', source: 'primary' }]],
    ]);

    // Mode 1: char_with_sub (default)
    const s1 = normalizeSettings({ charBookTitleMode: 'char_with_sub' });
    const c1 = classifyWorldbooks({ worldNames, bindingMap, settings: s1 });
    const lunaBook1 = c1.byName.get('作者乱起的名字_v9_final');
    assert.equal(lunaBook1.isInCharGroup, true);
    assert.equal(lunaBook1.primaryTitle, '露娜');
    assert.equal(lunaBook1.subtitle, '作者乱起的名字_v9_final');
    assert.equal(lunaBook1.realName, '作者乱起的名字_v9_final');

    // Mode 2: char_only (hide original author title completely)
    const s2 = normalizeSettings({ charBookTitleMode: 'char_only' });
    const c2 = classifyWorldbooks({ worldNames, bindingMap, settings: s2 });
    const lunaBook2 = c2.byName.get('作者乱起的名字_v9_final');
    assert.equal(lunaBook2.primaryTitle, '露娜');
    assert.equal(lunaBook2.subtitle, '');

    // Search still finds it by BOTH character name and original title
    assert.equal(matchesSearch(lunaBook2, '露娜'), true);
    assert.equal(matchesSearch(lunaBook2, '作者乱起'), true);
});

test('default selector hiding excludes character books while protecting active/editing books', () => {
    const settings = normalizeSettings({ showCharBooks: false, activeFilterGroupId: SPECIAL_GROUPS.DEFAULT });
    const bindingMap = new Map([
        ['卡书A', [{ avatar: 'A.png', charName: '角色A', source: 'primary' }]],
        ['卡书B', [{ avatar: 'B.png', charName: '角色B', source: 'primary' }]],
    ]);
    const classification = classifyWorldbooks({
        worldNames: ['卡书A', '卡书B', '公共文风'],
        bindingMap,
        settings,
    });

    // Hidden by default
    assert.equal(
        isBookVisibleInSelector({
            bookMeta: classification.byName.get('卡书A'),
            activeFilterGroupId: settings.activeFilterGroupId,
            showCharBooks: false,
            isSelected: false,
            isCurrentlyEditing: false,
        }),
        false,
    );

    // Already selected globally -> MUST stay visible so we never deactivate it
    assert.equal(
        isBookVisibleInSelector({
            bookMeta: classification.byName.get('卡书A'),
            activeFilterGroupId: settings.activeFilterGroupId,
            showCharBooks: false,
            isSelected: true,
        }),
        true,
    );

    // Currently being edited -> MUST stay visible
    assert.equal(
        isBookVisibleInSelector({
            bookMeta: classification.byName.get('卡书A'),
            activeFilterGroupId: settings.activeFilterGroupId,
            showCharBooks: false,
            isCurrentlyEditing: true,
        }),
        true,
    );

    // Non-character book -> visible by default
    assert.equal(
        isBookVisibleInSelector({
            bookMeta: classification.byName.get('公共文风'),
            activeFilterGroupId: settings.activeFilterGroupId,
            showCharBooks: false,
        }),
        true,
    );

    // Char bind popup: keeps current character's own book, hides OTHER characters' books
    assert.equal(
        isBookVisibleInCharBindPopup({
            bookMeta: classification.byName.get('卡书A'),
            currentCharAvatar: 'A.png',
            hideOtherCharBooks: true,
        }),
        true,
    );
    assert.equal(
        isBookVisibleInCharBindPopup({
            bookMeta: classification.byName.get('卡书B'),
            currentCharAvatar: 'A.png',
            hideOtherCharBooks: true,
        }),
        false,
    );
});

test('persona bindings are detected in memory without modifying real filenames', () => {
    const personaMap = buildPersonaBindingIndex({
        personas: { 'user1.png': '林默' },
        persona_descriptions: {
            'user1.png': { lorebook: '林默专属设定_v1' },
        },
    });
    assert.deepEqual(personaMap.get('林默专属设定_v1'), ['林默']);
});

test('AI organize prompt, tolerant JSON parser, apply, and undo work end-to-end', () => {
    const prompt = buildAiOrganizePrompt({
        books: [{ realName: '【2026精修】古风去八股文风_v3', sampleEntries: ['禁用词', '动作描写'] }],
        existingGroups: ['文风与写法'],
    });
    assert.match(prompt.systemPrompt, /虚拟别名/);
    assert.match(prompt.userPrompt, /古风去八股文风_v3/);

    const messyResponse = `好的，整理建议如下：\n\`\`\`json\n{\n  "【2026精修】古风去八股文风_v3": { "alias": "古风去八股文风", "group": "文风与写法", "note": "古风防八股与动作描写规范" },\n  "不存在的幽灵书": { "alias": "幽灵", "group": "其他", "note": "应被忽略" }\n}\n\`\`\`\n希望对你有帮助！`;
    const parsed = parseAiOrganizeResponse(messyResponse, new Set(['【2026精修】古风去八股文风_v3']));
    assert.equal(parsed.ok, true);
    assert.equal(parsed.proposals.length, 1);
    assert.equal(parsed.ignoredCount, 1);
    assert.equal(parsed.proposals[0].alias, '古风去八股文风');

    const settings = normalizeSettings(null);
    const applied = applyAiOrganizeProposals(settings, parsed.proposals);
    assert.equal(applied.appliedCount, 1);
    assert.deepEqual(applied.createdGroups, ['文风与写法']);
    assert.equal(settings.aliases['【2026精修】古风去八股文风_v3'], '古风去八股文风');
    assert.equal(settings.groups.length, 1);

    // Undo restores previous clean state
    const undone = undoLastAiOrganize(settings);
    assert.equal(undone, true);
    assert.equal(settings.groups.length, 0);
    assert.equal(settings.aliases['【2026精修】古风去八股文风_v3'], undefined);

    // Refusal apology detection & sensitive title check
    const refusal = parseAiOrganizeResponse("I'm sorry, I cannot assist with explicit content.", new Set(['18+ 温柔向Nsfw']));
    assert.equal(refusal.ok, false);
    assert.equal(refusal.isRefusal, true);
    assert.equal(detectAiRefusal('抱歉，我无法处理包含敏感内容的请求。'), true);
    assert.equal(isPotentiallySensitiveTitle('18+ 温柔向Nsfw'), true);
    assert.equal(isPotentiallySensitiveTitle('温柔向NSFW'), true);
    assert.equal(isPotentiallySensitiveTitle('18+纯爱文风'), true);
    assert.equal(isPotentiallySensitiveTitle('【R18】描写增强'), true);
    assert.equal(isPotentiallySensitiveTitle('恶俗文学扩展'), true);
    assert.equal(isPotentiallySensitiveTitle('反性凝视描写规范'), true);
    assert.equal(isPotentiallySensitiveTitle('打飞机与飞机杯玩法'), true);
    assert.equal(isPotentiallySensitiveTitle('名器倒模评测'), true);
    assert.equal(isPotentiallySensitiveTitle('孕期play指南'), true);
    assert.equal(isPotentiallySensitiveTitle('Dirty Talk 词库'), true);
    assert.equal(isPotentiallySensitiveTitle('NTR修罗场'), true);
    assert.equal(isPotentiallySensitiveTitle('古风去八股文风'), false);
    assert.equal(isPotentiallySensitiveTitle('约会场景与流程指南'), false);
    assert.equal(isPotentiallySensitiveTitle('smart_prompt_small'), false);
    assert.equal(isPotentiallySensitiveTitle('成人礼仪与古代风俗'), false);
    assert.equal(isPotentiallySensitiveTitle('category_entry_ignore'), false);

    // Feedback re-organize prompt includes ST taxonomy & previous rejected proposal
    const redoPrompt = buildAiOrganizePrompt({
        books: [{ realName: '约会场景与流程指南' }],
        existingGroups: ['文风'],
        feedback: {
            reason: '约会指南不要归入世界观，请分到场景与互动',
            previousProposals: [{ realName: '约会场景与流程指南', alias: '约会指南', group: '世界观与角色' }],
            acceptedGroups: ['缝合'],
        },
    });
    assert.match(redoPrompt.systemPrompt, /规则补丁/);
    assert.match(redoPrompt.systemPrompt, /剧情、事件与玩法/);
    assert.match(redoPrompt.userPrompt, /重新分组反馈/);
    assert.match(redoPrompt.userPrompt, /previousGroup/);
    assert.match(redoPrompt.userPrompt, /世界观与角色/);
    assert.match(redoPrompt.userPrompt, /缝合/);

    // Local zero-API organize handles prefixes, ST keywords, sensitive books, custom rules, and title cleanup
    const localProps = buildLocalOrganizeProposals({
        books: [
            { realName: '[缝]不因爱失去自我v1.7 (1)' },
            { realName: '[人设] 日常穿搭User' },
            { realName: '约会场景与流程指南' },
            { realName: '名器倒模评测' },
            { realName: '我的咒回设定集 by作者A' },
        ],
        usePrefix: true,
        useKeywords: true,
        cleanTitles: true,
        customRulesText: '咒回 => 同人专区',
    });
    assert.equal(localProps[0].group, '缝合');
    assert.equal(localProps[0].alias, '[缝]不因爱失去自我v1.7');
    assert.equal(localProps[0].note, '');
    assert.equal(localProps[1].group, 'User 人设');
    assert.equal(localProps[1].note, '');
    assert.equal(localProps[2].group, '剧情与互动');
    assert.equal(localProps[3].group, 'NSFW');
    assert.equal(localProps[4].group, '同人专区');
    assert.equal(localProps[4].alias, '我的咒回设定集');

    // Multi-step undo history + initialSnapshot restore
    const histSettings = normalizeSettings(null);
    applyAiOrganizeProposals(histSettings, [{ realName: '书1', alias: '书1A', group: '文风' }], { label: '第1次' });
    applyAiOrganizeProposals(histSettings, [{ realName: '书2', alias: '书2A', group: '世界观' }], { label: '第2次' });
    applyAiOrganizeProposals(histSettings, [{ realName: '书3', alias: '书3A', group: '人设' }], { label: '第3次' });
    assert.equal(histSettings.groups.length, 3);
    assert.equal(histSettings.undoSnapshots.length, 3);
    assert.ok(histSettings.initialSnapshot);
    // Jump back 2 steps (before 第2次 -> only 第1次 remains)
    assert.equal(restoreOrganizeSnapshot(histSettings, 1), true);
    assert.equal(histSettings.groups.length, 1);
    assert.equal(histSettings.groups[0].name, '文风');
    // Restore to initial pre-first-organize state
    assert.equal(restoreOrganizeSnapshot(histSettings, 'initial'), true);
    assert.equal(histSettings.groups.length, 0);
    assert.deepEqual(histSettings.aliases, {});

    // Two-book entry comparison
    const diff = compareWorldbookEntries(
        [
            { title: '相同条', content: 'AAA' },
            { title: '改过条', content: '旧版本内容' },
            { title: '仅A条', content: 'onlyA' },
        ],
        [
            { title: '相同条', content: 'AAA' },
            { title: '改过条', content: '新版本内容更长' },
            { title: '仅B条', content: 'onlyB' },
        ],
    );
    assert.equal(diff.sameCount, 1);
    assert.equal(diff.onlyA.length, 1);
    assert.equal(diff.onlyB.length, 1);
    assert.equal(diff.modified.length, 1);

    // Cleanup deleted worldbook settings
    const sDel = normalizeSettings({
        assignments: { '待删书': 'g1', '保留书': 'g1' },
        aliases: { '待删书': '别名' },
        notes: { '待删书': '备注' },
    });
    cleanupDeletedWorldSettings(sDel, ['待删书']);
    assert.equal(sDel.assignments['待删书'], undefined);
    assert.equal(sDel.aliases['待删书'], undefined);
    assert.equal(sDel.notes['待删书'], undefined);
    assert.equal(sDel.assignments['保留书'], 'g1');
});

test('findUnscannedShallowCharacters and findCardsWithUnimportedBooks detect pending scans and safe imports', () => {
    const chars = [
        {
            avatar: 'NewCard.png',
            name: '新角色',
            shallow: false,
            data: {
                extensions: { world: '' },
                character_book: { name: '新角色设定集', entries: [{ uid: 0, content: 'hi' }] },
            },
        },
        {
            avatar: 'ExistingBookCard.png',
            name: '已有书角色',
            shallow: false,
            data: {
                extensions: { world: '已存在世界书' },
                character_book: { name: '已存在世界书', entries: [{ uid: 0, content: 'hi' }] },
            },
        },
        {
            avatar: 'ShallowUnknown.png',
            name: '未扫懒加载卡',
            shallow: true,
        },
        {
            avatar: 'ShallowCached.png',
            name: '已扫懒加载卡',
            shallow: true,
        },
    ];

    const cache = {
        'ShallowCached.png': { name: '已扫懒加载卡', primary: null, embedded: null, embeddedEntryCount: 0, scanned: true },
    };

    const unscanned = findUnscannedShallowCharacters(chars, cache);
    assert.equal(unscanned.length, 1);
    assert.equal(unscanned[0].avatar, 'ShallowUnknown.png');

    const unimported = findCardsWithUnimportedBooks({
        characters: chars,
        worldNamesSet: new Set(['已存在世界书']),
        cachedCharBindings: cache,
    });
    assert.equal(unimported.length, 1);
    assert.equal(unimported[0].avatar, 'NewCard.png');
    assert.equal(unimported[0].importName, '新角色设定集');
    assert.equal(unimported[0].entryCount, 1);
});

test('addCustomGroup preserves creation order (g1 -> g2 -> ungrouped -> char) and reorderSection drags cleanly', () => {
    const settings = normalizeSettings(null);
    assert.deepEqual(settings.sectionOrder, [SPECIAL_GROUPS.UNGROUPED, SPECIAL_GROUPS.CHARACTER]);

    const g1 = addCustomGroup(settings, { name: '文风设定' });
    const g2 = addCustomGroup(settings, { name: '世界观' });
    const g3 = addCustomGroup(settings, { name: '系统规则' });
    assert.deepEqual(settings.sectionOrder, [g1.id, g2.id, g3.id, SPECIAL_GROUPS.UNGROUPED, SPECIAL_GROUPS.CHARACTER]);

    assert.equal(moveSectionOrder(settings, SPECIAL_GROUPS.CHARACTER, -1), true);
    assert.deepEqual(settings.sectionOrder, [g1.id, g2.id, g3.id, SPECIAL_GROUPS.CHARACTER, SPECIAL_GROUPS.UNGROUPED]);
    assert.equal(moveSectionOrder(settings, g1.id, -1), false);

    // Drag g3 before g1
    assert.equal(reorderSection(settings, g3.id, g1.id, 'before'), true);
    assert.deepEqual(settings.sectionOrder, [g3.id, g1.id, g2.id, SPECIAL_GROUPS.CHARACTER, SPECIAL_GROUPS.UNGROUPED]);
    assert.deepEqual(settings.groups.map((g) => g.id), [g3.id, g1.id, g2.id]);

    // Promote character group to first when enabled
    promoteSectionToTop(settings, SPECIAL_GROUPS.CHARACTER);
    assert.equal(settings.sectionOrder[0], SPECIAL_GROUPS.CHARACTER);

    // Legacy v1 default [__char__, __ungrouped__] auto-migrates to [__ungrouped__, __char__]
    const migrated = normalizeSettings({
        sectionOrder: [SPECIAL_GROUPS.CHARACTER, SPECIAL_GROUPS.UNGROUPED],
    });
    assert.equal(migrated.sectionOrderVersion, 2);
    assert.deepEqual(migrated.sectionOrder, [SPECIAL_GROUPS.UNGROUPED, SPECIAL_GROUPS.CHARACTER]);

    // Explicit v2 user reorder is preserved
    const kept = normalizeSettings({
        sectionOrderVersion: 2,
        sectionOrder: [SPECIAL_GROUPS.CHARACTER, SPECIAL_GROUPS.UNGROUPED],
    });
    assert.deepEqual(kept.sectionOrder, [SPECIAL_GROUPS.CHARACTER, SPECIAL_GROUPS.UNGROUPED]);
});

test('migrateSettingsOnWorldRename updates assignments, aliases, notes, overrides, and cached bindings', () => {
    const settings = normalizeSettings({
        assignments: { '旧书名': 'g1' },
        aliases: { '旧书名': '临时别名' },
        notes: { '旧书名': '备注内容' },
        charBookOverrides: { '旧书名': 'exclude_from_char' },
        cachedCharBindings: {
            'Alice.png': { name: '艾莉丝', primary: '旧书名', embedded: '旧书名', embeddedEntryCount: 3, scanned: true },
        },
    });
    migrateSettingsOnWorldRename(settings, '旧书名', '新书名');
    assert.equal(settings.assignments['旧书名'], undefined);
    assert.equal(settings.assignments['新书名'], 'g1');
    assert.equal(settings.notes['新书名'], '备注内容');
    assert.equal(settings.charBookOverrides['新书名'], 'exclude_from_char');
    assert.equal(settings.cachedCharBindings['Alice.png'].primary, '新书名');
    assert.equal(settings.cachedCharBindings['Alice.png'].embedded, '新书名');
    assert.equal(settings.aliases['新书名'], '临时别名');
});

test('summarizeCharacterWorldCoverage pinpoints unbound, missing-file, shared, multi-book, and orphan-extra books', () => {
    const chars = [
        { avatar: 'A.png', name: '角色A', shallow: false, data: { extensions: { world: '共用书' } } },
        { avatar: 'B.png', name: '角色B', shallow: false, data: { extensions: { world: '共用书' } } },
        { avatar: 'C.png', name: '无书角色', shallow: false, data: { extensions: { world: '' } } },
        { avatar: 'D.png', name: '缺书角色', shallow: false, data: { extensions: { world: '已删世界书' } } },
        { avatar: 'E.png', name: '多书角色', shallow: false, data: { extensions: { world: '主书E' } } },
        { avatar: 'F.png', name: '同名旧内嵌角色', shallow: false, data: { extensions: { world: '主书F' } } },
    ];
    const bindingMap = new Map([
        ['共用书', [
            { avatar: 'A.png', charName: '角色A', source: 'primary' },
            { avatar: 'B.png', charName: '角色B', source: 'primary' },
        ]],
        ['主书E', [{ avatar: 'E.png', charName: '多书角色', source: 'primary' }]],
        ['附书E', [{ avatar: 'E.png', charName: '多书角色', source: 'extra' }]],
        ['主书F', [{ avatar: 'F.png', charName: '同名旧内嵌角色', source: 'primary' }]],
        ['旧内嵌F', [{ avatar: 'F.png', charName: '同名旧内嵌角色', source: 'embedded' }]],
        ['已删角色附书', [{ avatar: 'Gone.png', charName: 'Gone', source: 'extra' }]],
    ]);
    const cov = summarizeCharacterWorldCoverage({
        characters: chars,
        bindingMap,
        worldNamesSet: new Set(['共用书', '主书E', '附书E', '主书F', '旧内嵌F', '已删角色附书']),
    });
    assert.equal(cov.unboundChars.length, 1);
    assert.equal(cov.unboundChars[0].charName, '无书角色');
    assert.equal(cov.missingFileChars.length, 1);
    assert.equal(cov.missingFileChars[0].charName, '缺书角色');
    assert.equal(cov.sharedBooks.length, 1);
    assert.equal(cov.sharedBooks[0].owners.length, 2);
    assert.equal(cov.sharedBooks[0].owners[0].avatar, 'A.png');
    // Passive embedded name-match MUST NOT trigger a false-positive multi-book character!
    assert.equal(cov.multiBookChars.length, 1);
    assert.equal(cov.multiBookChars[0].avatar, 'E.png');
    assert.equal(cov.multiBookChars[0].charName, '多书角色');
    assert.equal(cov.multiBookChars[0].books.length, 2);
    assert.equal(cov.embeddedNameMatches.length, 1);
    assert.equal(cov.embeddedNameMatches[0].charName, '同名旧内嵌角色');
    assert.equal(cov.embeddedNameMatches[0].worldName, '旧内嵌F');
    assert.equal(cov.orphanExtraBooks.length, 1);
    assert.equal(cov.orphanExtraBooks[0].worldName, '已删角色附书');
});

test('entry module and all submodules resolve and import without missing paths', async () => {
    const prevDoc = globalThis.document;
    globalThis.document = { readyState: 'loading', addEventListener() {} };
    try {
        const mod = await import('../index.js');
        assert.equal(typeof mod.onDisable, 'function');
        assert.equal(typeof mod.onClean, 'function');
    } finally {
        if (prevDoc === undefined) delete globalThis.document;
        else globalThis.document = prevDoc;
    }
});

test('config export and import round-trip cleanly', () => {
    const src = normalizeSettings({
        charBookTitleMode: 'char_only',
        groups: [{ id: 'g1', name: '通用设定', color: '#5b8def', collapsed: false }],
        assignments: { '书A': 'g1' },
        aliases: { '书A': '干净的书A' },
    });
    const exported = exportConfigData(src);
    const dst = normalizeSettings(null);
    const res = importConfigData(dst, JSON.stringify(exported));
    assert.equal(res.ok, true);
    assert.equal(dst.charBookTitleMode, 'char_only');
    assert.equal(dst.aliases['书A'], '干净的书A');
    assert.equal(dst.groups.length, 1);
});

test('no-AI organize defaults to user_persona, style, and nsfw and honors selective categories', () => {
    assert.deepEqual([...DEFAULT_LOCAL_ORGANIZE_CATEGORY_IDS], ['user_persona', 'style', 'nsfw']);
    assert.ok(LOCAL_ORGANIZE_CATEGORIES.length >= 10);

    const books = [
        { realName: '[补充]user穿搭v2.2' },
        { realName: '古风文风润色指南' },
        { realName: 'dirty talk 词库' },
        { realName: '赛博世界观设定集' },
        { realName: '随机小剧场盲盒' },
    ];

    // Default 3 categories: only matches User 人设 / 文风 / NSFW; ignores unchecked 世界观 / 小剧场
    const defProposals = buildLocalOrganizeProposals({
        books,
        enabledCategoryIds: DEFAULT_LOCAL_ORGANIZE_CATEGORY_IDS,
    });
    const byName = new Map(defProposals.map((p) => [p.realName, p.group]));
    assert.equal(byName.get('[补充]user穿搭v2.2'), 'User 人设');
    assert.equal(byName.get('古风文风润色指南'), '文风');
    assert.equal(byName.get('dirty talk 词库'), 'NSFW');
    assert.equal(byName.get('赛博世界观设定集'), '未分组');
    assert.equal(byName.get('随机小剧场盲盒'), '未分组');

    // Enabling worldview + theater picks them up cleanly
    const wideProposals = buildLocalOrganizeProposals({
        books,
        enabledCategoryIds: [...DEFAULT_LOCAL_ORGANIZE_CATEGORY_IDS, 'worldview', 'theater'],
    });
    const wideMap = new Map(wideProposals.map((p) => [p.realName, p.group]));
    assert.equal(wideMap.get('赛博世界观设定集'), '世界观');
    assert.equal(wideMap.get('随机小剧场盲盒'), '小剧场');
});

test('per-selector custom hidden groups work independently with safety invariants and migration', () => {
    // Legacy migration: hideCharBooksByDefault=true -> both default to [__char__]; false -> []
    const legacyOn = normalizeSettings({ hideCharBooksByDefault: true });
    assert.deepEqual(legacyOn.globalHiddenGroupIds, [SPECIAL_GROUPS.CHARACTER]);
    assert.deepEqual(legacyOn.editorHiddenGroupIds, [SPECIAL_GROUPS.CHARACTER]);

    const legacyOff = normalizeSettings({ hideCharBooksByDefault: false });
    assert.deepEqual(legacyOff.globalHiddenGroupIds, []);
    assert.deepEqual(legacyOff.editorHiddenGroupIds, []);

    const settings = normalizeSettings({
        groups: [
            { id: 'g_style', name: '文风', color: '#5b8def', collapsed: false },
            { id: 'g_archive', name: '归档', color: '#8c99a6', collapsed: false },
        ],
        assignments: {
            '古风文风': 'g_style',
            '旧版设定': 'g_archive',
        },
        globalHiddenGroupIds: [SPECIAL_GROUPS.CHARACTER, 'g_style', 'deleted_group_id'],
        editorHiddenGroupIds: [SPECIAL_GROUPS.CHARACTER, 'g_archive'],
    });
    // Deleted group IDs are sanitized out automatically
    assert.deepEqual(settings.globalHiddenGroupIds, [SPECIAL_GROUPS.CHARACTER, 'g_style']);
    assert.deepEqual(settings.editorHiddenGroupIds, [SPECIAL_GROUPS.CHARACTER, 'g_archive']);

    const bindingMap = new Map([
        ['角色书A', [{ avatar: 'A.png', charName: '角色A', source: 'primary' }]],
    ]);
    const cls = classifyWorldbooks({
        worldNames: ['角色书A', '古风文风', '旧版设定', '通用书'],
        bindingMap,
        settings,
    });

    // Global selector hides 角色书A + 古风文风, keeps 旧版设定 + 通用书
    assert.equal(isBookVisibleInSelector({ bookMeta: cls.byName.get('角色书A'), activeFilterGroupId: SPECIAL_GROUPS.DEFAULT, showCharBooks: false, hiddenGroupIds: settings.globalHiddenGroupIds }), false);
    assert.equal(isBookVisibleInSelector({ bookMeta: cls.byName.get('古风文风'), activeFilterGroupId: SPECIAL_GROUPS.DEFAULT, showCharBooks: false, hiddenGroupIds: settings.globalHiddenGroupIds }), false);
    assert.equal(isBookVisibleInSelector({ bookMeta: cls.byName.get('旧版设定'), activeFilterGroupId: SPECIAL_GROUPS.DEFAULT, showCharBooks: false, hiddenGroupIds: settings.globalHiddenGroupIds }), true);
    // Safety invariant: already globally selected book stays visible even if its group is excluded!
    assert.equal(isBookVisibleInSelector({ bookMeta: cls.byName.get('古风文风'), activeFilterGroupId: SPECIAL_GROUPS.DEFAULT, showCharBooks: false, hiddenGroupIds: settings.globalHiddenGroupIds, isSelected: true }), true);

    // Editor selector hides 角色书A + 旧版设定, keeps 古风文风 + 通用书
    assert.equal(isBookVisibleInSelector({ bookMeta: cls.byName.get('古风文风'), activeFilterGroupId: SPECIAL_GROUPS.DEFAULT, showCharBooks: false, hiddenGroupIds: settings.editorHiddenGroupIds }), true);
    assert.equal(isBookVisibleInSelector({ bookMeta: cls.byName.get('旧版设定'), activeFilterGroupId: SPECIAL_GROUPS.DEFAULT, showCharBooks: false, hiddenGroupIds: settings.editorHiddenGroupIds }), false);
    // Safety invariant: currently editing book stays visible even if its group is excluded!
    assert.equal(isBookVisibleInSelector({ bookMeta: cls.byName.get('旧版设定'), activeFilterGroupId: SPECIAL_GROUPS.DEFAULT, showCharBooks: false, hiddenGroupIds: settings.editorHiddenGroupIds, isCurrentlyEditing: true }), true);
    // Current chat character's own worldbook stays visible & pinned in editor even when character books are hidden!
    assert.equal(isBookVisibleInSelector({ bookMeta: cls.byName.get('角色书A'), activeFilterGroupId: SPECIAL_GROUPS.DEFAULT, showCharBooks: false, hiddenGroupIds: settings.editorHiddenGroupIds, isCurrentChatCharBook: true }), true);

    // Reveal toggle ON shows ALL hidden groups in both selectors
    assert.equal(isBookVisibleInSelector({ bookMeta: cls.byName.get('古风文风'), activeFilterGroupId: SPECIAL_GROUPS.DEFAULT, showCharBooks: true, hiddenGroupIds: settings.globalHiddenGroupIds }), true);
    assert.equal(isBookVisibleInSelector({ bookMeta: cls.byName.get('旧版设定'), activeFilterGroupId: SPECIAL_GROUPS.DEFAULT, showCharBooks: true, hiddenGroupIds: settings.editorHiddenGroupIds }), true);

    // Export/import round-trip preserves both lists
    const exported = exportConfigData(settings);
    const dst = normalizeSettings(null);
    assert.equal(importConfigData(dst, exported).ok, true);
    assert.deepEqual(dst.globalHiddenGroupIds, [SPECIAL_GROUPS.CHARACTER, 'g_style']);
    assert.deepEqual(dst.editorHiddenGroupIds, [SPECIAL_GROUPS.CHARACTER, 'g_archive']);
});

test('searchEntriesInPayload performs exact phrase matching across title, keys, and content with snippets', () => {
    const payload = {
        entries: {
            0: { uid: 0, comment: '叙事规范', key: ['第二人称'], content: '采用第二人称视角描写，保持自然流畅。', disable: false },
            1: { uid: 1, comment: '禁用草稿', key: ['旧词'], content: '这里保留第二人称旧版说明。', disable: true },
            2: { uid: 2, comment: '英文短语', key: ['tone'], content: 'Use natural small talk between scenes.', disable: false },
            3: { uid: 3, comment: '分散词不误命中', key: ['misc'], content: 'A small house. We will talk tomorrow.', disable: false },
        },
    };

    const resAll = searchEntriesInPayload(payload, '第二人称', { includeDisabled: true });
    assert.equal(resAll.totalMatchesInBook, 2);
    assert.equal(resAll.hits.length, 2);
    assert.equal(resAll.hits[0].title, '叙事规范');
    assert.ok(resAll.hits[0].matchedIn.includes('触发词'));
    assert.ok(resAll.hits[0].matchedIn.includes('正文'));
    assert.ok(resAll.hits[0].snippet.includes('第二人称'));

    const resEnabledOnly = searchEntriesInPayload(payload, '第二人称', { includeDisabled: false });
    assert.equal(resEnabledOnly.hits.length, 1);

    // Exact phrase with space matches contiguous phrase ONLY, never scattered words!
    const resPhrase = searchEntriesInPayload(payload, 'small talk', { splitSpaces: false });
    assert.equal(resPhrase.hits.length, 1);
    assert.equal(resPhrase.hits[0].title, '英文短语');

    // Optional space-separated multi-word AND matches BOTH contiguous and scattered entries
    const resMulti = searchEntriesInPayload(payload, 'small talk', { splitSpaces: true });
    assert.equal(resMulti.hits.length, 2);

    // matchesSearch supports selective bookName / charName scopes and splitSpaces
    const bookMeta = {
        realName: '清冷叙事文风',
        alias: '',
        primaryTitle: '清冷叙事文风',
        note: '',
        groupName: '文风',
        charOwners: [{ charName: '沈清晏' }],
        personaOwners: [],
        searchableText: '清冷叙事文风\n文风\n沈清晏',
    };
    assert.equal(matchesSearch(bookMeta, '沈清晏', { searchBookName: true, searchCharName: false }), false);
    assert.equal(matchesSearch(bookMeta, '沈清晏', { searchBookName: false, searchCharName: true }), true);
    assert.equal(matchesSearch(bookMeta, '清冷 文风', { searchBookName: true, searchCharName: false, splitSpaces: false }), false);
    assert.equal(matchesSearch(bookMeta, '清冷 文风', { searchBookName: true, searchCharName: false, splitSpaces: true }), true);

    const resTitleKeysOnly = searchEntriesInPayload(payload, '流畅', { searchTitleAndKeys: true, searchContent: false });
    assert.equal(resTitleKeysOnly.hits.length, 0);
});

test('deleting characters and worldbooks syncs cleanly without stale group or metadata residue', () => {
    // 1. Deleted character's orphan `charLore` does NOT trap book in 角色世界书, yet coverage still flags it
    const liveChars = [
        { avatar: 'Alive.png', name: '现存角色', shallow: false, data: { extensions: { world: '现存书' } } },
    ];
    const charLore = [
        { name: 'DeletedChar', extraBooks: ['残留附加书'] },
    ];
    const worldNames = ['现存书', '残留附加书', '通用书'];
    const bindingMap = buildCharacterBindingIndex({
        characters: liveChars,
        charLore,
        worldNamesSet: new Set(worldNames),
    });
    const settings = normalizeSettings({
        groups: [{ id: 'g1', name: '文风', color: '#5b8def', collapsed: false }],
        assignments: { '通用书': 'g1', '已删世界书': 'g1' },
        aliases: { '通用书': '通用别名', '已删世界书': '旧别名' },
        notes: { '已删世界书': '旧说明' },
        charBookOverrides: { '已删世界书': 'exclude_from_char' },
        cachedCharBindings: {
            'DeletedChar.png': { name: '已删角色', primary: '残留附加书', embedded: null, scanned: true },
        },
    });

    // Deleted character is pruned from cachedCharBindings
    const cacheSync = updateCachedCharBindings(settings.cachedCharBindings, liveChars);
    assert.equal(cacheSync.changed, true);
    assert.equal(cacheSync.cached['DeletedChar.png'], undefined);
    assert.equal(cacheSync.cached['Alive.png']?.primary, '现存书');

    // Compact summary from low-memory partial-batch scan merges WITHOUT wiping previously cached cards!
    const compactSync = updateCachedCharBindings(
        cacheSync.cached,
        [
            {
                avatar: 'BulkCard.png',
                name: '批量新卡',
                shallow: false,
                wboCompactSummary: true,
                primary: '批量新书',
                embedded: '批量内嵌书',
                embeddedEntryCount: 12,
            },
        ],
        { pruneDeleted: false },
    );
    assert.equal(compactSync.cached['Alive.png']?.primary, '现存书');
    assert.equal(compactSync.cached['BulkCard.png']?.primary, '批量新书');
    assert.equal(compactSync.cached['BulkCard.png']?.embeddedEntryCount, 12);

    // Orphan charLore book goes back to 未分组 (not trapped in 角色世界书)
    const cls = classifyWorldbooks({ worldNames, bindingMap, settings });
    assert.equal(cls.byName.get('现存书')?.groupId, SPECIAL_GROUPS.CHARACTER);
    assert.equal(cls.byName.get('残留附加书')?.groupId, SPECIAL_GROUPS.UNGROUPED);

    // Coverage audit STILL surfaces the orphan charLore entry so user can clean host charLore
    const cov = summarizeCharacterWorldCoverage({
        characters: liveChars,
        bindingMap,
        worldNamesSet: new Set(worldNames),
        cachedCharBindings: cacheSync.cached,
    });
    assert.equal(cov.orphanExtraBooks.length, 1);
    assert.equal(cov.orphanExtraBooks[0].worldName, '残留附加书');

    // 2. Deleted worldbook metadata is pruned when live set is non-empty, and preserved when empty (early boot guard)
    assert.equal(pruneStaleWorldbookSettings(settings, new Set()), false);
    assert.equal(settings.aliases['已删世界书'], '旧别名');

    assert.equal(pruneStaleWorldbookSettings(settings, new Set(worldNames)), true);
    assert.equal(settings.assignments['已删世界书'], undefined);
    assert.equal(settings.aliases['已删世界书'], undefined);
    assert.equal(settings.notes['已删世界书'], undefined);
    assert.equal(settings.charBookOverrides['已删世界书'], undefined);
    assert.equal(settings.assignments['通用书'], 'g1');
    assert.equal(settings.aliases['通用书'], '通用别名');
});

test('previously untested core utilities and constants behave reliably', () => {
    assert.equal(MODULE_NAME, 'worldbook_organizer');
    assert.ok(Array.isArray(GROUP_COLOR_PALETTE) && GROUP_COLOR_PALETTE.length >= 6);
    assert.equal(DEFAULT_SETTINGS.themePalette, 'classic');

    // compareZhCn: null/undefined safe and equal fast-path
    assert.equal(compareZhCn('甲', '甲'), 0);
    assert.equal(compareZhCn(null, undefined), 0);
    assert.equal(typeof compareZhCn('艾莉丝', '鲍勃'), 'number');

    // deepClone produces independent deep copies
    const orig = { nested: { arr: [1, { a: 'x' }] } };
    const cloned = deepClone(orig);
    cloned.nested.arr[1].a = 'y';
    assert.equal(orig.nested.arr[1].a, 'x');

    // charaFileName handles multi-dot, extensionless, and empty inputs
    assert.equal(charaFileName('a.b.png'), 'a.b');
    assert.equal(charaFileName('NoExt'), 'NoExt');
    assert.equal(charaFileName(''), '');
    assert.equal(charaFileName(null), '');

    // createGroupId and createApiChannelId generate collision-free prefixed IDs
    const gId1 = createGroupId([{ id: 'grp_taken' }]);
    assert.match(gId1, /^grp_/);
    assert.notEqual(gId1, 'grp_taken');

    const apiId1 = createApiChannelId([{ id: 'api_taken' }]);
    assert.match(apiId1, /^api_/);
    assert.notEqual(apiId1, 'api_taken');

    // buildCharBooksCountMap & formatCharacterDisplayTitle
    const bindingMap = new Map([
        ['主书A', [{ avatar: 'A.png', charName: '角色A', source: 'primary' }]],
        ['附书A1', [{ avatar: 'A.png', charName: '角色A', source: 'extra' }]],
        ['附书A2', [{ avatar: 'A.png', charName: '角色A', source: 'extra' }]],
        ['内嵌B', [{ avatar: 'B.png', charName: '角色B', source: 'embedded' }]],
        ['主书B', [{ avatar: 'B.png', charName: '角色B', source: 'primary' }]],
        ['双卡共用', [
            { avatar: 'A.png', charName: '角色A', source: 'primary' },
            { avatar: 'B.png', charName: '角色B', source: 'primary' },
        ]],
        ['三卡共用', [
            { avatar: 'A.png', charName: '角色A', source: 'primary' },
            { avatar: 'B.png', charName: '角色B', source: 'primary' },
            { avatar: 'C.png', charName: '角色C', source: 'primary' },
        ]],
    ]);
    const perChar = buildCharBooksCountMap(bindingMap);
    assert.equal(formatCharacterDisplayTitle('无主书', [], perChar), '无主书');
    assert.equal(formatCharacterDisplayTitle('主书A', bindingMap.get('主书A'), perChar), '角色A');
    assert.equal(formatCharacterDisplayTitle('附书A1', bindingMap.get('附书A1'), perChar), '角色A · 附加1');
    assert.equal(formatCharacterDisplayTitle('附书A2', bindingMap.get('附书A2'), perChar), '角色A · 附加2');
    assert.equal(formatCharacterDisplayTitle('内嵌B', bindingMap.get('内嵌B'), perChar), '角色B · 内嵌');
    assert.equal(formatCharacterDisplayTitle('双卡共用', bindingMap.get('双卡共用'), perChar), '角色A、角色B');
    assert.equal(formatCharacterDisplayTitle('三卡共用', bindingMap.get('三卡共用'), perChar), '角色A、角色B 等3卡');
});

test('normalizeSettings, bindings, and classifyWorldbooks cover edge cases', () => {
    const normalized = normalizeSettings({
        apiChannels: [
            { id: 'c1', name: '旧通道', url: 'https://example.test/v1', key: 'sk-test', model: 'm1' },
        ],
        activeApiChannelId: 'missing_channel',
        themePalette: 'invalid_palette',
        themeMode: 'invalid_mode',
        entrySearchHistory: ['a', 'b', 'a', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', ''],
        groups: [{ id: 'g_new', name: '新组' }],
        sectionOrder: [SPECIAL_GROUPS.UNGROUPED, SPECIAL_GROUPS.CHARACTER],
    });
    assert.equal(normalized.apiChannels[0].baseUrl, 'https://example.test/v1');
    assert.equal(normalized.apiChannels[0].apiKey, 'sk-test');
    assert.equal(normalized.activeApiChannelId, 'c1');
    assert.equal(normalized.themePalette, 'classic');
    assert.equal(normalized.themeMode, 'auto');
    assert.equal(normalized.entrySearchHistory.length, 10);
    assert.deepEqual(normalized.entrySearchHistory.slice(0, 3), ['a', 'b', 'c']);
    assert.deepEqual(normalized.sectionOrder, ['g_new', SPECIAL_GROUPS.UNGROUPED, SPECIAL_GROUPS.CHARACTER]);

    // buildCharacterBindingIndex precedence: embedded < extra < primary & toggles
    const chars = [
        {
            avatar: 'Hero.png',
            name: '主角',
            shallow: false,
            data: {
                extensions: { world: '同名书' },
                character_book: { name: '同名书' },
            },
        },
    ];
    const precedenceMap = buildCharacterBindingIndex({
        characters: chars,
        charLore: [{ name: 'Hero', extraBooks: ['同名书', '附加专属'] }],
        worldNamesSet: new Set(['同名书', '附加专属']),
        includeExtraCharBooks: true,
        includeEmbeddedNameMatch: true,
    });
    assert.equal(precedenceMap.get('同名书')?.[0]?.source, 'primary');
    assert.equal(precedenceMap.get('附加专属')?.[0]?.source, 'extra');

    const noExtraNoEmb = buildCharacterBindingIndex({
        characters: [{ avatar: 'EmbOnly.png', name: '内嵌', shallow: false, data: { character_book: { name: '仅内嵌' } } }],
        charLore: [{ name: 'EmbOnly', extraBooks: ['仅附加'] }],
        worldNamesSet: new Set(['仅内嵌', '仅附加']),
        includeExtraCharBooks: false,
        includeEmbeddedNameMatch: false,
    });
    assert.equal(noExtraNoEmb.size, 0);

    // classifyWorldbooks: exclude_from_char, alias_only, original, duplicate dedup
    const cls = classifyWorldbooks({
        worldNames: ['同名书', '同名书', '别名书'],
        bindingMap: precedenceMap,
        settings: {
            charBookOverrides: { '同名书': 'exclude_from_char' },
            aliases: { '别名书': '简洁别名' },
            aliasTitleMode: 'alias_only',
            charBookTitleMode: 'original',
        },
    });
    assert.equal(cls.totalCount, 2);
    assert.equal(cls.byName.get('同名书')?.groupId, SPECIAL_GROUPS.UNGROUPED);
    assert.equal(cls.byName.get('别名书')?.primaryTitle, '简洁别名');
    assert.equal(cls.byName.get('别名书')?.subtitle, '');
});

test('organize parser, partial apply, local rules, entry search, diff, and import edge cases', () => {
    // Array root, items wrapper, synonym fields, meta-analysis note filter, empty/zero-match rejection
    const valid = new Set(['书A', '书B']);
    const arrParsed = parseAiOrganizeResponse(
        JSON.stringify([
            { realName: '书A', displayName: '展示A', category: '分组A', description: '分组分析来自书名判定' },
            { world: '书B', name: '展示B', folder: '分组B', summary: '实用文风说明' },
        ]),
        valid,
    );
    assert.equal(arrParsed.ok, true);
    assert.equal(arrParsed.proposals[0].alias, '展示A');
    assert.equal(arrParsed.proposals[0].group, '分组A');
    assert.equal(arrParsed.proposals[0].note, '');
    assert.equal(arrParsed.proposals[1].note, '实用文风说明');

    const itemsParsed = parseAiOrganizeResponse(
        JSON.stringify({ items: [{ key: '书A', alias: 'A2', group: 'G2' }] }),
        valid,
    );
    assert.equal(itemsParsed.ok, true);
    assert.equal(parseAiOrganizeResponse('', valid).ok, false);
    assert.equal(parseAiOrganizeResponse('{"不存在":{"alias":"x","group":"y"}}', valid).ok, false);

    // applyAiOrganizeProposals partial flags, builtin group reset, alias==realName cleanup, 8-step cap
    const s = normalizeSettings({
        groups: [{ id: 'g1', name: '旧组' }],
        assignments: { '书A': 'g1', '书C': 'g1' },
        aliases: { '书A': '旧别名' },
        charBookOverrides: { '书C': 'exclude_from_char' },
    });
    applyAiOrganizeProposals(s, [
        { realName: '书A', alias: '书A', group: '未分组', note: '忽略备注', applyNote: false },
        { realName: '书C', alias: '新C', group: '角色世界书', applyAlias: false },
    ]);
    assert.equal(s.assignments['书A'], undefined);
    assert.equal(s.aliases['书A'], undefined);
    assert.equal(s.notes['书A'], undefined);
    assert.equal(s.assignments['书C'], undefined);
    assert.equal(s.charBookOverrides['书C'], undefined);
    assert.equal(s.aliases['书C'], undefined);

    for (let i = 0; i < 10; i += 1) {
        pushUndoSnapshot(s, { count: i, label: `步${i}` });
    }
    assert.equal(s.undoSnapshots.length, 8);

    // buildLocalOrganizeProposals: useAnyBracketPrefix, multi-delimiter custom rules, NSFW priority
    const localProps = buildLocalOrganizeProposals({
        books: [
            { realName: '【自定义标签】测试书' },
            { realName: '星际远航' },
            { realName: 'nsfw约会互动指南' },
        ],
        useAnyBracketPrefix: true,
        customRulesText: '星际 -> 科幻区\n远航 = 忽略',
    });
    assert.equal(localProps[0].group, '自定义标签');
    assert.equal(localProps[1].group, '科幻区');
    assert.equal(localProps[2].group, 'NSFW');

    // searchEntriesInPayload: keysecondary, ZERO >2400 char truncation, maxHitsPerBook vs totalMatchesInBook, empty guards
    const longBody = `前置内容 matchKey ${'字'.repeat(2500)}`;
    const payload = {
        entries: {
            0: { uid: 0, comment: '条目1', key: [], keysecondary: ['副词matchKey'], content: longBody },
            1: { uid: 1, comment: '条目2 matchKey', key: [], content: '短正文' },
        },
    };
    const searchRes = searchEntriesInPayload(payload, 'matchKey', { maxHitsPerBook: 1 });
    assert.equal(searchRes.totalMatchesInBook, 2);
    assert.equal(searchRes.hits.length, 1);
    assert.ok(searchRes.hits[0].matchedIn.includes('触发词'));
    assert.equal(searchRes.hits[0].content, longBody);
    assert.ok(searchRes.hits[0].content.length > 2500);
    assert.deepEqual(searchEntriesInPayload(payload, '').hits, []);
    assert.deepEqual(searchEntriesInPayload(payload, 'matchKey', { searchTitleAndKeys: false, searchContent: false }).hits, []);

    // compareWorldbookEntries: duplicate title #2 & untitled fallback
    const diff = compareWorldbookEntries(
        [
            { title: '重名', content: '1' },
            { title: '重名', content: '2' },
            { title: '', keys: ['k1'], content: 'a' },
        ],
        [
            { title: '重名', content: '1' },
            { title: '重名', content: '2-改' },
            { title: '', keys: ['k1'], content: 'a' },
        ],
    );
    assert.equal(diff.sameCount, 2);
    assert.equal(diff.modified.length, 1);

    // importConfigData edge cases
    assert.equal(importConfigData(normalizeSettings(null), '{bad json').ok, false);
    assert.equal(importConfigData(normalizeSettings(null), {}).ok, false);
    const flatDst = normalizeSettings(null);
    assert.equal(importConfigData(flatDst, { groups: [{ id: 'gx', name: '扁平组' }] }).ok, true);
    assert.equal(flatDst.groups[0].name, '扁平组');
});

test('manifest version strictly matches STYLE_ASSET_VERSION and host memory/bridge guarantees hold', async () => {
    const manifest = JSON.parse(
        readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'),
    );
    const prevDoc = globalThis.document;
    globalThis.document = { readyState: 'loading', addEventListener() {} };
    try {
        const entryMod = await import('../index.js');
        assert.equal(entryMod.STYLE_ASSET_VERSION, manifest.version);
    } finally {
        if (prevDoc === undefined) delete globalThis.document;
        else globalThis.document = prevDoc;
    }

    const hostMod = await import('../src/host.js');

    const prevST = globalThis.SillyTavern;
    const prevFetch = globalThis.fetch;
    const prevWin = globalThis.window;
    const prevCustomEvent = globalThis.CustomEvent;

    let unshallowCalls = 0;
    let loadWorldInfoCalls = 0;
    let updateListCalls = 0;
    const emittedEvents = [];

    const mockCtx = {
        characters: [{ avatar: 'Lazy.png', name: '懒加载卡', shallow: true }],
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        unshallowCharacter: async () => { unshallowCalls += 1; },
        loadWorldInfo: async () => { loadWorldInfoCalls += 1; return { entries: {} }; },
        getWorldInfoNames: () => ['OldBook'],
        updateWorldInfoList: async () => { updateListCalls += 1; },
        extensionSettings: {},
        saveSettingsDebounced: () => {},
    };
    globalThis.SillyTavern = { getContext: () => mockCtx };
    globalThis.CustomEvent = class MockCustomEvent {
        constructor(type, init = {}) {
            this.type = type;
            this.detail = init.detail;
        }
    };
    globalThis.window = {
        dispatchEvent: (ev) => {
            emittedEvents.push({ type: ev.type, detail: ev.detail, updateListCallsAtEmit: updateListCalls });
            return true;
        },
    };
    globalThis.fetch = async (url) => {
        if (url === '/api/characters/get') {
            return {
                ok: true,
                json: async () => ({
                    avatar: 'Lazy.png',
                    name: '懒加载卡',
                    data: { extensions: { world: '主书' } },
                }),
            };
        }
        if (url === '/api/worldinfo/get') {
            return {
                ok: true,
                json: async () => ({
                    entries: {
                        0: { uid: 0, comment: '长条', key: ['k'], content: 'A'.repeat(2200), disable: false },
                    },
                }),
            };
        }
        if (url === '/api/worldinfo/edit' || url === '/api/worldinfo/delete') {
            return { ok: true, json: async () => ({}) };
        }
        return { ok: false, status: 404, json: async () => ({}) };
    };

    try {
        // MEM-01: allowUnshallow: false must NEVER invoke ctx.unshallowCharacter
        const full = await hostMod.fetchFullCharacterOnDemand('Lazy.png', { allowUnshallow: false });
        assert.equal(full?.data?.extensions?.world, '主书');
        assert.equal(unshallowCalls, 0);

        // MEM-02: preview bypasses loadWorldInfo and preserves 100% full entry content without truncation
        const preview = await hostMod.fetchWorldbookPreviewEntries('OldBook');
        assert.equal(loadWorldInfoCalls, 0);
        assert.equal(preview.entries.length, 1);
        assert.equal(preview.entries[0].content.length, 2200);
        assert.equal(preview.entries[0].content, 'A'.repeat(2200));

        // INT-01: deferRefresh: true queues wbo:worldbook-renamed until flushWorldInfoListRefresh completes updateListFn
        const settings = normalizeSettings(null);
        const renRes = await hostMod.realRenameWorldbook('OldBook', 'NewBook', settings, { deferRefresh: true });
        assert.equal(renRes.ok, true);
        assert.equal(emittedEvents.filter((e) => e.type === 'wbo:worldbook-renamed').length, 0);
        await hostMod.flushWorldInfoListRefresh();
        const renameEvents = emittedEvents.filter((e) => e.type === 'wbo:worldbook-renamed');
        assert.equal(renameEvents.length, 1);
        assert.deepEqual(renameEvents[0].detail, { oldName: 'OldBook', newName: 'NewBook' });
        assert.equal(renameEvents[0].updateListCallsAtEmit, 1);
    } finally {
        if (prevST === undefined) delete globalThis.SillyTavern; else globalThis.SillyTavern = prevST;
        if (prevFetch === undefined) delete globalThis.fetch; else globalThis.fetch = prevFetch;
        if (prevWin === undefined) delete globalThis.window; else globalThis.window = prevWin;
        if (prevCustomEvent === undefined) delete globalThis.CustomEvent; else globalThis.CustomEvent = prevCustomEvent;
    }
});

test('pinnedBooks toggle, sorting, rename migration, delete cleanup, and export/import round-trip', () => {
    const settings = normalizeSettings({
        groups: [{ id: 'g1', name: '文风', color: '#5b8def', collapsed: false }],
        assignments: { '普通书A': 'g1', '收藏书Z': 'g1' },
        pinnedBooks: ['收藏书Z', '收藏书Z', ''],
    });
    assert.deepEqual(settings.pinnedBooks, ['收藏书Z']);
    assert.equal(isBookPinned(settings, '收藏书Z'), true);
    assert.equal(isBookPinned(settings, '普通书A'), false);

    // Pinned book sorts BEFORE unpinned book regardless of alphabetical order
    const cls = classifyWorldbooks({
        worldNames: ['普通书A', '收藏书Z', '未分组收藏'],
        bindingMap: new Map(),
        settings,
    });
    assert.equal(cls.customGroups[0].books.map((b) => b.realName)[0], '收藏书Z');
    assert.equal(cls.pinnedCount, 1);

    // Toggle pin on/off
    assert.equal(togglePinnedBook(settings, '未分组收藏'), true);
    assert.equal(isBookPinned(settings, '未分组收藏'), true);
    assert.equal(togglePinnedBook(settings, '未分组收藏'), false);
    assert.equal(isBookPinned(settings, '未分组收藏'), false);

    // Rename migrates pinnedBooks
    migrateSettingsOnWorldRename(settings, '收藏书Z', '收藏书Z_新名');
    assert.equal(isBookPinned(settings, '收藏书Z'), false);
    assert.equal(isBookPinned(settings, '收藏书Z_新名'), true);

    // Export / import preserves pinnedBooks
    const exported = exportConfigData(settings);
    const dst = normalizeSettings(null);
    assert.equal(importConfigData(dst, exported).ok, true);
    assert.deepEqual(dst.pinnedBooks, ['收藏书Z_新名']);

    // Cleanup & prune remove deleted pinned books
    cleanupDeletedWorldSettings(settings, ['收藏书Z_新名']);
    assert.deepEqual(settings.pinnedBooks, []);

    settings.pinnedBooks = ['现存书', '已删书'];
    assert.equal(pruneStaleWorldbookSettings(settings, new Set(['现存书'])), true);
    assert.deepEqual(settings.pinnedBooks, ['现存书']);
});

test('single-entry direct edit patch preserves 100% of undisplayed native and unknown fields', async () => {
    assert.ok(WORLD_ENTRY_POSITIONS.length >= 8);
    assert.deepEqual(normalizeEntryKeywordsInput('词A, 词B，词C\n词A、 词D'), ['词A', '词B', '词C', '词D']);

    const rawEntry = {
        uid: 7,
        comment: '原标题',
        content: '原正文',
        disable: false,
        constant: false,
        selective: true,
        key: ['旧词'],
        keysecondary: ['旧副词'],
        position: 4,
        depth: 3,
        order: 90,
        probability: 42,
        useProbability: false,
        selectiveLogic: 2,
        excludeRecursion: true,
        preventRecursion: true,
        delayUntilRecursion: 3,
        group: '互斥组A',
        groupOverride: true,
        groupWeight: 85,
        role: 2,
        scanDepth: 6,
        caseSensitive: true,
        matchWholeWords: true,
        sticky: 2,
        cooldown: 5,
        delay: 1,
        automationId: 'auto_1',
        addMemo: true,
        extensions: { custom_plugin: { keep: true, weight: 99 } },
        unknownCustomField: 'preserve_me_intact',
    };

    const patched = mergeEntryPatchOntoRaw(rawEntry, {
        comment: '新标题',
        disable: true,
        constant: true,
        key: '新词1, 新词2',
        keysecondary: '新副词1',
        position: 1,
        depth: 5,
        order: 200,
        content: '新正文内容',
    });

    // Edited fields updated
    assert.equal(patched.comment, '新标题');
    assert.equal(patched.disable, true);
    assert.equal(patched.constant, true);
    assert.equal(patched.selective, false);
    assert.deepEqual(patched.key, ['新词1', '新词2']);
    assert.deepEqual(patched.keysecondary, ['新副词1']);
    assert.equal(patched.position, 1);
    assert.equal(patched.depth, 5);
    assert.equal(patched.order, 200);
    assert.equal(patched.content, '新正文内容');

    // ALL undisplayed native & custom/unknown fields preserved 100%
    assert.equal(patched.uid, 7);
    assert.equal(patched.probability, 42);
    assert.equal(patched.useProbability, false);
    assert.equal(patched.selectiveLogic, 2);
    assert.equal(patched.excludeRecursion, true);
    assert.equal(patched.preventRecursion, true);
    assert.equal(patched.delayUntilRecursion, 3);
    assert.equal(patched.group, '互斥组A');
    assert.equal(patched.groupOverride, true);
    assert.equal(patched.groupWeight, 85);
    assert.equal(patched.role, 2);
    assert.equal(patched.scanDepth, 6);
    assert.equal(patched.caseSensitive, true);
    assert.equal(patched.matchWholeWords, true);
    assert.equal(patched.sticky, 2);
    assert.equal(patched.cooldown, 5);
    assert.equal(patched.delay, 1);
    assert.equal(patched.automationId, 'auto_1');
    assert.deepEqual(patched.extensions, { custom_plugin: { keep: true, weight: 99 } });
    assert.equal(patched.unknownCustomField, 'preserve_me_intact');
    // Original raw object is NOT mutated
    assert.equal(rawEntry.comment, '原标题');

    // Lightweight list projection & single-entry extraction
    const bookPayload = { entries: { 7: rawEntry } };
    const listProj = extractEntryListItems(bookPayload);
    assert.equal(listProj.total, 1);
    assert.equal(listProj.items[0].uid, '7');
    assert.equal(listProj.items[0].content, undefined);
    const single = extractSingleEntryForEdit(bookPayload, '7');
    assert.equal(single?.content, '原正文');

    // createNewRawWorldEntry finds free UID cleanly
    const created = createNewRawWorldEntry({ 0: { uid: 0, displayIndex: 0 }, 7: rawEntry }, { comment: '新条' });
    assert.equal(created.uid, 1);
    assert.equal(created.displayIndex, 1);
    assert.equal(created.comment, '新条');

    // End-to-end host saveWorldbookEntryPatch preserves unknown fields & never pollutes worldInfoCache
    const hostMod = await import('../src/host.js');
    const prevST = globalThis.SillyTavern;
    const prevFetch = globalThis.fetch;
    let savedBody = null;
    globalThis.SillyTavern = {
        getContext: () => ({
            getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
            extensionSettings: {},
        }),
    };
    globalThis.fetch = async (url, opts) => {
        if (url === '/api/worldinfo/get') {
            return { ok: true, json: async () => deepClone(bookPayload) };
        }
        if (url === '/api/worldinfo/edit') {
            savedBody = JSON.parse(opts.body);
            return { ok: true, json: async () => ({}) };
        }
        return { ok: false, status: 404, json: async () => ({}) };
    };
    try {
        const res = await hostMod.saveWorldbookEntryPatch('TestBook', '7', { comment: '直编新名', content: '直编正文' });
        assert.equal(res.ok, true);
        assert.equal(savedBody.name, 'TestBook');
        assert.equal(savedBody.data.entries['7'].comment, '直编新名');
        assert.equal(savedBody.data.entries['7'].content, '直编正文');
        assert.equal(savedBody.data.entries['7'].unknownCustomField, 'preserve_me_intact');
        assert.equal(savedBody.data.entries['7'].probability, 42);
    } finally {
        if (prevST === undefined) delete globalThis.SillyTavern; else globalThis.SillyTavern = prevST;
        if (prevFetch === undefined) delete globalThis.fetch; else globalThis.fetch = prevFetch;
    }
});

test('null/empty numeric coercion guards and selective flag preservation hold across extract and merge', () => {
    assert.equal(parseOptionalFiniteNumber(null), null);
    assert.equal(parseOptionalFiniteNumber(undefined), null);
    assert.equal(parseOptionalFiniteNumber(''), null);
    assert.equal(parseOptionalFiniteNumber('   '), null);
    assert.equal(parseOptionalFiniteNumber(false), null);
    assert.equal(parseOptionalFiniteNumber(0), 0);
    assert.equal(parseOptionalFiniteNumber('0'), 0);
    assert.equal(parseOptionalFiniteNumber('4'), 4);

    // depth: null -> 4, order: null -> 100 while explicit 0 remains 0
    const nullPayload = {
        entries: {
            0: { uid: 0, comment: 'NullNum', position: null, depth: null, order: null, constant: false, selective: false },
            1: { uid: 1, comment: 'ZeroNum', position: 0, depth: 0, order: 0, constant: false, selective: false },
        },
    };
    const listNull = extractEntryListItems(nullPayload);
    assert.equal(listNull.items[0].position, 0);
    assert.equal(listNull.items[0].depth, 4);
    assert.equal(listNull.items[0].order, 100);
    assert.equal(listNull.items[0].selective, false);
    assert.equal(listNull.items[1].position, 0);
    assert.equal(listNull.items[1].depth, 0);
    assert.equal(listNull.items[1].order, 0);

    const editNull = extractSingleEntryForEdit(nullPayload, '0');
    assert.equal(editNull?.depth, 4);
    assert.equal(editNull?.order, 100);
    const editZero = extractSingleEntryForEdit(nullPayload, '1');
    assert.equal(editZero?.depth, 0);
    assert.equal(editZero?.order, 0);

    // mergeEntryPatchOntoRaw: null / '' preserve base values, while explicit 0 overrides to 0
    const base = { uid: 1, position: 4, depth: 5, order: 120, constant: false, selective: false };
    const preserved = mergeEntryPatchOntoRaw(base, { position: null, depth: '', order: '   ', constant: false, comment: '微调' });
    assert.equal(preserved.position, 4);
    assert.equal(preserved.depth, 5);
    assert.equal(preserved.order, 120);
    assert.equal(preserved.selective, false);

    const zeroed = mergeEntryPatchOntoRaw(base, { position: 0, depth: 0, order: 0 });
    assert.equal(zeroed.position, 0);
    assert.equal(zeroed.depth, 0);
    assert.equal(zeroed.order, 0);
});

test('mid-batch realRenameWorldbook rollback succeeds with stale world_names, restores pinnedBooks, and suppresses rolled-back rename events', async () => {
    const hostMod = await import('../src/host.js');
    hostMod.clearPendingRenamedEvents();

    const prevST = globalThis.SillyTavern;
    const prevFetch = globalThis.fetch;
    const prevWin = globalThis.window;
    const prevCustomEvent = globalThis.CustomEvent;

    // Simulate faithful SillyTavern semantics: world_names only updates inside updateWorldInfoList()
    let worldNames = ['BookA', 'BookB', 'KeepBook'];
    const diskBooks = new Map([
        ['BookA', { entries: { 0: { uid: 0, comment: 'A0', content: 'bodyA' } } }],
        ['BookB', { entries: { 0: { uid: 0, comment: 'B0', content: 'bodyB' } } }],
        ['KeepBook', { entries: { 0: { uid: 0, comment: 'K0', content: 'bodyK' } } }],
    ]);
    const emittedEvents = [];

    globalThis.SillyTavern = {
        getContext: () => ({
            getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
            getWorldInfoNames: () => [...worldNames],
            updateWorldInfoList: async () => {
                worldNames = [...diskBooks.keys()];
            },
            extensionSettings: {},
            saveSettingsDebounced: () => {},
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
            emittedEvents.push({ type: ev.type, detail: ev.detail });
            return true;
        },
    };
    globalThis.fetch = async (url, opts) => {
        const body = opts?.body ? JSON.parse(opts.body) : {};
        if (url === '/api/worldinfo/get') {
            const payload = diskBooks.get(body.name);
            return payload ? { ok: true, json: async () => deepClone(payload) } : { ok: false, status: 404, json: async () => ({}) };
        }
        if (url === '/api/worldinfo/edit') {
            diskBooks.set(body.name, deepClone(body.data));
            return { ok: true, json: async () => ({}) };
        }
        if (url === '/api/worldinfo/delete') {
            diskBooks.delete(body.name);
            return { ok: true, json: async () => ({}) };
        }
        return { ok: false, status: 404, json: async () => ({}) };
    };

    try {
        const settings = normalizeSettings({
            groups: [{ id: 'g1', name: '组1', color: '#5b8def' }],
            assignments: { BookA: 'g1' },
            pinnedBooks: ['BookA', 'KeepBook'],
        });
        const preSnapshot = {
            groups: deepClone(settings.groups),
            assignments: deepClone(settings.assignments),
            aliases: deepClone(settings.aliases),
            notes: deepClone(settings.notes),
            charBookOverrides: deepClone(settings.charBookOverrides),
            cachedCharBindings: deepClone(settings.cachedCharBindings),
            sectionOrder: deepClone(settings.sectionOrder),
            undoSnapshots: deepClone(settings.undoSnapshots),
            pinnedBooks: deepClone(settings.pinnedBooks),
        };
        const liveNamesSet = new Set(hostMod.getWorldNames());
        const completed = [];

        // Forward rename 1 & 2 with deferRefresh: true (ST world_names stays stale!)
        const r1 = await hostMod.realRenameWorldbook('BookA', 'BookA_New', settings, {
            deferRefresh: true,
            existingNamesSet: liveNamesSet,
        });
        assert.equal(r1.ok, true);
        completed.push({ oldName: 'BookA', newName: 'BookA_New' });

        const r2 = await hostMod.realRenameWorldbook('BookB', 'BookB_New', settings, {
            deferRefresh: true,
            existingNamesSet: liveNamesSet,
        });
        assert.equal(r2.ok, true);
        completed.push({ oldName: 'BookB', newName: 'BookB_New' });

        // Confirm ST world_names is still stale before flush, while settings.pinnedBooks migrated
        assert.deepEqual(worldNames, ['BookA', 'BookB', 'KeepBook']);
        assert.deepEqual(settings.pinnedBooks, ['BookA_New', 'KeepBook']);

        // Mid-batch abort rollback using the liveNamesSet + discardPendingRenamedEventsForRollback
        const rolledBackPairs = [];
        for (let i = completed.length - 1; i >= 0; i -= 1) {
            const pair = completed[i];
            const rb = await hostMod.realRenameWorldbook(pair.newName, pair.oldName, settings, {
                deferRefresh: true,
                existingNamesSet: liveNamesSet,
            });
            assert.equal(rb.ok, true, `rollback ${pair.newName} -> ${pair.oldName} failed: ${rb.error}`);
            rolledBackPairs.push(pair);
        }
        const discarded = hostMod.discardPendingRenamedEventsForRollback(rolledBackPairs);
        assert.equal(discarded, 4);

        settings.pinnedBooks = deepClone(preSnapshot.pinnedBooks);
        settings.assignments = deepClone(preSnapshot.assignments);
        await hostMod.flushWorldInfoListRefresh();

        assert.deepEqual([...diskBooks.keys()].sort(), ['BookA', 'BookB', 'KeepBook']);
        assert.deepEqual(worldNames.sort(), ['BookA', 'BookB', 'KeepBook']);
        assert.deepEqual(settings.pinnedBooks, ['BookA', 'KeepBook']);
        assert.equal(emittedEvents.filter((e) => e.type === 'wbo:worldbook-renamed').length, 0);

        // Also verify wbo:entries-updated fires on saveWorldbookEntryPatch & createWorldbookEntryDirect
        emittedEvents.length = 0;
        const saveRes = await hostMod.saveWorldbookEntryPatch('BookA', '0', { comment: 'UpdatedA0' });
        assert.equal(saveRes.ok, true);
        const createRes = await hostMod.createWorldbookEntryDirect('BookA', { comment: 'NewA1' });
        assert.equal(createRes.ok, true);
        const entryUpdatedEvents = emittedEvents.filter((e) => e.type === 'wbo:entries-updated');
        assert.equal(entryUpdatedEvents.length, 2);
        assert.deepEqual(entryUpdatedEvents[0].detail, { worldName: 'BookA' });
        assert.deepEqual(entryUpdatedEvents[1].detail, { worldName: 'BookA' });
    } finally {
        hostMod.clearPendingRenamedEvents();
        if (prevST === undefined) delete globalThis.SillyTavern; else globalThis.SillyTavern = prevST;
        if (prevFetch === undefined) delete globalThis.fetch; else globalThis.fetch = prevFetch;
        if (prevWin === undefined) delete globalThis.window; else globalThis.window = prevWin;
        if (prevCustomEvent === undefined) delete globalThis.CustomEvent; else globalThis.CustomEvent = prevCustomEvent;
    }
});

test('AI organize sensitive partitioning suppresses false alarms on grouped books and 1-click moves ungrouped sensitive books to NSFW', () => {
    const books = [
        { realName: '普通世界观', groupId: SPECIAL_GROUPS.UNGROUPED, isInCharGroup: false },
        { realName: 'nsfw_已归组', groupId: 'grp_nsfw', isInCharGroup: false },
        { realName: '角色卡_nsfw', groupId: SPECIAL_GROUPS.CHARACTER, isInCharGroup: true },
    ];
    // Case 1: Only already-grouped & character sensitive books exist -> NO yellow banner!
    const groupedOnly = analyzeSensitiveOrganizeState({
        allBooks: books,
        scope: 'ungrouped',
        checkedNames: ['普通世界观'],
    });
    assert.equal(groupedOnly.bannerMode, 'hidden');
    assert.equal(groupedOnly.ungroupedSensitive.length, 0);
    assert.equal(groupedOnly.scopeSensitive.length, 0);

    // Case 2: Ungrouped sensitive book exists -> bannerMode 'warn', scopeSensitive excludes grouped & char books
    const withUngrouped = [
        ...books,
        { realName: '肉文玩法未分组', groupId: SPECIAL_GROUPS.UNGROUPED, isInCharGroup: false },
    ];
    const ungroupedState = analyzeSensitiveOrganizeState({
        allBooks: withUngrouped,
        scope: 'ungrouped',
        checkedNames: ['普通世界观'],
    });
    assert.equal(ungroupedState.bannerMode, 'warn');
    assert.deepEqual(ungroupedState.scopeSensitive.map((b) => b.realName), ['肉文玩法未分组']);

    // Case 3: 1-click move to NSFW auto-creates NSFW group, moves ungrouped sensitive book, and saves undo snapshot
    const settings = normalizeSettings(null);
    const moveRes = moveBooksToNamedGroup(settings, ['肉文玩法未分组'], 'NSFW');
    assert.equal(moveRes.movedCount, 1);
    assert.equal(moveRes.createdGroup, true);
    assert.equal(moveRes.groupName, 'NSFW');
    assert.equal(settings.assignments['肉文玩法未分组'], moveRes.groupId);
    assert.equal(settings.undoSnapshots.length, 1);
    assert.equal(undoLastAiOrganize(settings), true);
    assert.equal(settings.assignments['肉文玩法未分组'], undefined);
});

test('summarizePersonaWorldBindings and extractEmbeddedCharacterBookPreview report anomalies and V2 embedded entries cleanly', () => {
    const bindingMap = new Map([
        ['共用书', [{ avatar: 'Alice.png', charName: 'Alice', source: 'primary' }]],
    ]);
    const personaSummary = summarizePersonaWorldBindings({
        powerUserSettings: {
            personas: { 'p1.png': '主控甲', 'p2.png': '主控乙' },
            persona_descriptions: {
                'p1.png': { lorebook: '已删人设书', title: '现代线' },
                'p2.png': { lorebook: '共用书', title: '' },
            },
        },
        worldNamesSet: new Set(['共用书']),
        bindingMap,
    });
    assert.equal(personaSummary.totalBoundCount, 2);
    assert.equal(personaSummary.missingPersonaBindings.length, 1);
    assert.equal(personaSummary.missingPersonaBindings[0].worldName, '已删人设书');
    assert.equal(personaSummary.personaCharCrossBindings.length, 1);
    assert.equal(personaSummary.personaCharCrossBindings[0].personaName, '主控乙');
    assert.equal(personaSummary.personaCharCrossBindings[0].charOwners[0].charName, 'Alice');

    const embPreview = extractEmbeddedCharacterBookPreview({
        avatar: 'Alice.png',
        name: 'Alice',
        data: {
            character_book: {
                name: 'AliceEmbedded',
                entries: [
                    { id: 0, comment: '背景', keys: ['alice'], content: '卡内版本', enabled: true, constant: true },
                    { id: 1, comment: '关闭条', keys: ['off'], content: '停用', enabled: false },
                ],
            },
        },
    });
    assert.equal(embPreview?.name, 'AliceEmbedded');
    assert.equal(embPreview?.total, 2);
    assert.equal(embPreview?.enabledCount, 1);
    const diff = compareWorldbookEntries(embPreview?.entries || [], [
        { title: '背景', keys: ['alice'], content: '本地改版' },
    ]);
    assert.equal(diff.modified.length, 1);
    assert.equal(diff.onlyA.length, 1);
});

test('Iteration 3 UX helpers: 6+6 presets, sensitive synonym match, picker partition, tokens, PINNED visibility, and version parity', async () => {
    // 1. Symmetric 6+6 AI organize presets + prompt injection
    assert.equal(AI_ORGANIZE_CATEGORY_PRESETS.length, 6);
    assert.equal(AI_ORGANIZE_NAMING_PRESETS.length, 6);
    assert.ok(AI_ORGANIZE_CATEGORY_PRESETS.some((p) => p.label === '按题材背景'));
    assert.ok(AI_ORGANIZE_CATEGORY_PRESETS.some((p) => p.label === '按挂载方式'));
    const genrePreset = AI_ORGANIZE_CATEGORY_PRESETS.find((p) => p.label === '按题材背景');
    const namingPreset = AI_ORGANIZE_NAMING_PRESETS.find((p) => p.label === '【分类】名称');
    const promptWithPresets = buildAiOrganizePrompt({
        books: [{ realName: 'TestBook', groupName: '未分组', isCharBound: false, charOwners: [], entries: [] }],
        existingGroups: [],
        categoryPreset: genrePreset?.id,
        namingPreset: namingPreset?.id,
    });
    assert.ok(promptWithPresets.userPrompt.includes('故事题材与世界观背景'));
    assert.ok(promptWithPresets.userPrompt.includes('【分类】核心主题'));

    // 2. findSensitiveTargetGroup: synonym match without false positives on History/Character
    assert.equal(findSensitiveTargetGroup([
        { id: 'g1', name: 'History 历史背景' },
        { id: 'g2', name: 'Character 角色' },
    ]), null);
    assert.equal(findSensitiveTargetGroup([
        { id: 'g1', name: 'History 历史' },
        { id: 'g2', name: '成人向 / R18' },
    ])?.id, 'g2');
    assert.equal(findSensitiveTargetGroup([{ id: 'g3', name: '18+ 涩涩库' }])?.id, 'g3');
    assert.equal(findSensitiveTargetGroup([{ id: 'g4', name: 'H文专用' }])?.id, 'g4');

    // moveBooksToNamedGroup with targetGroupId reuses existing synonym group
    const moveSettings = normalizeSettings({
        groups: [{ id: 'g_adult', name: '成人向', color: '#e5534b', collapsed: false }],
    });
    const moveRes = moveBooksToNamedGroup(moveSettings, ['敏感测试书'], '成人向', {
        targetGroupId: 'g_adult',
    });
    assert.equal(moveRes.groupId, 'g_adult');
    assert.equal(moveRes.createdGroup, false);
    assert.equal(moveSettings.groups.length, 1);
    assert.equal(moveSettings.assignments['敏感测试书'], 'g_adult');

    // 3. estimateEntryTokens & entryEditorMonoFont round-trip
    assert.equal(estimateEntryTokens(''), 0);
    assert.ok(estimateEntryTokens('中文世界书测试内容 English words 12345') > 10);
    const monoSet = normalizeSettings({ entryEditorMonoFont: true });
    assert.equal(monoSet.entryEditorMonoFont, true);
    assert.equal(exportConfigData(monoSet).data.entryEditorMonoFont, true);

    // 4. SPECIAL_GROUPS.PINNED selector visibility
    const pinSet = normalizeSettings({
        groups: [{ id: 'g1', name: '文风', color: '#5b8def', collapsed: false }],
        assignments: { '普通置顶书': 'g1' },
        pinnedBooks: ['普通置顶书'],
        globalHiddenGroupIds: ['g1'],
        showCharBooks: false,
    });
    const pinCls = classifyWorldbooks({
        worldNames: ['普通置顶书', '未置顶书'],
        bindingMap: new Map(),
        settings: pinSet,
    });
    assert.equal(isBookVisibleInSelector({ bookMeta: pinCls.byName.get('普通置顶书'), activeFilterGroupId: SPECIAL_GROUPS.PINNED, showCharBooks: false }), true);
    assert.equal(isBookVisibleInSelector({ bookMeta: pinCls.byName.get('未置顶书'), activeFilterGroupId: SPECIAL_GROUPS.PINNED, showCharBooks: false }), false);
    assert.equal(isBookVisibleInCharBindPopup({ bookMeta: pinCls.byName.get('普通置顶书'), currentCharAvatar: null, hideOtherCharBooks: false, filterGroupId: SPECIAL_GROUPS.PINNED }), true);
    assert.equal(isBookVisibleInCharBindPopup({ bookMeta: pinCls.byName.get('未置顶书'), currentCharAvatar: null, hideOtherCharBooks: false, filterGroupId: SPECIAL_GROUPS.PINNED }), false);

    // 5. partitionGroupPickerBooks partitions current/ungrouped/otherGroups + promotes initialBookName
    const pickerSet = normalizeSettings({
        groups: [
            { id: 'g_a', name: '分组A', color: '#5b8def', collapsed: false },
            { id: 'g_b', name: '分组B', color: '#3fb950', collapsed: false },
        ],
        assignments: { '书A': 'g_a', '书B': 'g_b' },
    });
    const pickerCls = classifyWorldbooks({
        worldNames: ['书A', '书B', '未分组1', '初始书'],
        bindingMap: new Map(),
        settings: pickerSet,
    });
    const part = partitionGroupPickerBooks({
        classification: pickerCls,
        groupId: 'g_a',
        initialBookName: '初始书',
    });
    assert.equal(part.currentMembers.map((b) => b.realName).join(','), '书A');
    assert.equal(part.ungroupedBooks[0].realName, '初始书');
    assert.equal(part.otherGroups.length, 1);
    assert.equal(part.otherGroups[0].books[0].realName, '书B');

    // 6. manifest.json version === index.js STYLE_ASSET_VERSION
    const manifestJson = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
    const indexSrc = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    const styleVerMatch = indexSrc.match(/STYLE_ASSET_VERSION\s*=\s*'([^']+)'/);
    assert.equal(styleVerMatch?.[1], manifestJson.version);

    // 7. unbindWorldbookFromPersona clears persona_description_lorebook ONLY when active or unreferenced
    const pu = {
        persona: 'p1.png',
        persona_description_lorebook: '共享人设书',
        personas: { 'p1.png': '主控1', 'p2.png': '主控2' },
        persona_descriptions: {
            'p1.png': { lorebook: '共享人设书' },
            'p2.png': { lorebook: '共享人设书' },
        },
    };
    const prevST = globalThis.SillyTavern;
    globalThis.SillyTavern = {
        getContext: () => ({ powerUserSettings: pu, saveSettingsDebounced: () => {} }),
    };
    try {
        const hostMod = await import('../src/host.js');
        const resNonActive = await hostMod.unbindWorldbookFromPersona('p2.png', '共享人设书');
        assert.equal(resNonActive.ok, true);
        assert.equal(pu.persona_descriptions['p2.png'].lorebook, '');
        assert.equal(pu.persona_description_lorebook, '共享人设书');

        const resActive = await hostMod.unbindWorldbookFromPersona('p1.png', '共享人设书');
        assert.equal(resActive.ok, true);
        assert.equal(pu.persona_description_lorebook, '');
    } finally {
        if (prevST === undefined) delete globalThis.SillyTavern; else globalThis.SillyTavern = prevST;
    }
});

test('Global Worldbook Combos (globalPresets) CRUD, exact-set match, rename/delete sync, and backup round-trip', () => {
    const settings = normalizeSettings(null);
    assert.deepEqual(settings.globalPresets, []);

    const genId = createGlobalPresetId([{ id: 'cmb_taken' }]);
    assert.match(genId, /^cmb_/);
    assert.notEqual(genId, 'cmb_taken');

    // Validation guards
    assert.equal(upsertGlobalPreset(settings, { name: '   ', books: ['书A'] }).ok, false);
    assert.equal(upsertGlobalPreset(settings, { name: '空组合', books: [] }).ok, false);

    const c1 = upsertGlobalPreset(settings, { name: '现代日常套', books: ['现代常识', '去AI味文风', '现代常识'] });
    assert.equal(c1.ok, true);
    assert.equal(c1.created, true);
    assert.deepEqual(c1.preset.books, ['现代常识', '去AI味文风']);

    // Case-insensitive duplicate name guard
    assert.equal(upsertGlobalPreset(settings, { name: '现代日常套', books: ['书X'] }).ok, false);

    const c2 = upsertGlobalPreset(settings, { name: '跑团检定套', books: ['CoC检定补丁', '状态栏面板'] });
    assert.equal(c2.ok, true);
    assert.equal(settings.globalPresets.length, 2);

    // Exact-set matching (order-independent, rejects partial/superset/empty)
    assert.equal(findMatchingGlobalPreset(settings.globalPresets, [])?.id, undefined);
    assert.equal(findMatchingGlobalPreset(settings.globalPresets, ['去AI味文风', '现代常识'])?.id, c1.preset.id);
    assert.equal(findMatchingGlobalPreset(settings.globalPresets, ['去AI味文风'])?.id, undefined);
    assert.equal(findMatchingGlobalPreset(settings.globalPresets, ['去AI味文风', '现代常识', '额外书'])?.id, undefined);

    // Reorder up/down
    assert.equal(moveGlobalPreset(settings, c2.preset.id, -1), true);
    assert.deepEqual(settings.globalPresets.map((p) => p.name), ['跑团检定套', '现代日常套']);
    assert.equal(moveGlobalPreset(settings, c2.preset.id, -1), false);

    // Update existing combo in place
    const upd = upsertGlobalPreset(settings, {
        id: c1.preset.id,
        name: '现代通用套',
        books: ['现代常识', '去AI味文风', '防抢话补丁'],
    });
    assert.equal(upd.ok, true);
    assert.equal(upd.created, false);
    assert.equal(upd.preset.name, '现代通用套');
    assert.equal(upd.preset.books.length, 3);

    // Rename migration updates books inside globalPresets
    migrateSettingsOnWorldRename(settings, '去AI味文风', '叙事文风v2');
    const afterRename = settings.globalPresets.find((p) => p.id === c1.preset.id);
    assert.deepEqual(afterRename.books, ['现代常识', '叙事文风v2', '防抢话补丁']);

    // Delete & stale prune remove deleted worldbooks from globalPresets cleanly
    cleanupDeletedWorldSettings(settings, ['防抢话补丁']);
    assert.deepEqual(afterRename.books, ['现代常识', '叙事文风v2']);

    assert.equal(
        pruneStaleWorldbookSettings(settings, new Set(['现代常识', 'CoC检定补丁', '状态栏面板'])),
        true,
    );
    assert.deepEqual(afterRename.books, ['现代常识']);

    // Export / import round-trip (including standalone globalPresets payload)
    const exported = exportConfigData(settings);
    const dst = normalizeSettings(null);
    const imp = importConfigData(dst, exported);
    assert.equal(imp.ok, true);
    assert.equal(imp.stats.globalPresets, 2);
    assert.equal(dst.globalPresets[1].name, '现代通用套');

    const onlyCombosDst = normalizeSettings(null);
    assert.equal(importConfigData(onlyCombosDst, { globalPresets: dst.globalPresets }).ok, true);
    assert.equal(onlyCombosDst.globalPresets.length, 2);

    // Delete combo
    assert.equal(deleteGlobalPreset(settings, c2.preset.id), true);
    assert.equal(settings.globalPresets.length, 1);
});

test('Universal AI Organize prompts & user-customizable AI presets CRUD + reset', () => {
    // Built-in presets and systemPrompt must be universal across all ST player types (no romance-only dating bias)
    for (const p of AI_ORGANIZE_CATEGORY_PRESETS) {
        assert.equal(p.text.includes('约会'), false, `Preset ${p.id} should not hardcode dating bias`);
    }
    const basePrompt = buildAiOrganizePrompt({
        books: [{ realName: '克苏鲁跑团检定规则' }],
        existingGroups: ['跑团规则'],
    });
    assert.equal(basePrompt.systemPrompt.includes('约会'), false);

    const settings = normalizeSettings({
        aiOrganizePresetIds: ['smart_free'],
    });
    const defEff = getEffectiveAiOrganizePresets(settings);
    assert.equal(defEff.isCustomized, false);
    assert.equal(defEff.categoryPresets.length, 6);
    assert.equal(defEff.namingPresets.length, 6);

    // Edit a built-in preset & add a user custom preset
    const editBuiltin = upsertAiOrganizePreset(settings, {
        id: 'by_st_purpose',
        label: '我的跑团与设定分类',
        cat: 'group',
        text: '按跑团规则、模组地图、怪物图鉴、通用文风四类归纳。',
    });
    assert.equal(editBuiltin.ok, true);
    assert.equal(editBuiltin.created, false);

    const addCustom = upsertAiOrganizePreset(settings, {
        label: '极简双字组名',
        cat: 'custom',
        text: '所有分组名尽量控制在 2~4 个汉字。',
    });
    assert.equal(addCustom.ok, true);
    assert.equal(addCustom.created, true);

    // Duplicate label rejected
    assert.equal(
        upsertAiOrganizePreset(settings, { label: '极简双字组名', cat: 'group', text: '重复' }).ok,
        false,
    );

    const custEff = getEffectiveAiOrganizePresets(settings);
    assert.equal(custEff.isCustomized, true);
    const customPrompt = buildAiOrganizePrompt({
        books: [{ realName: '奈亚子模组' }],
        existingGroups: [],
        categoryPreset: 'by_st_purpose',
        presetsPool: custEff.all,
    });
    assert.ok(customPrompt.userPrompt.includes('跑团规则、模组地图'));

    // Delete cleans aiOrganizePresetIds; reset restores built-in defaults
    settings.aiOrganizePresetIds = ['smart_free', addCustom.preset.id];
    assert.equal(deleteAiOrganizePreset(settings, addCustom.preset.id), true);
    assert.deepEqual(settings.aiOrganizePresetIds, ['smart_free']);

    resetAiOrganizePresets(settings);
    assert.equal(settings.aiOrganizePresets, null);
    assert.equal(getEffectiveAiOrganizePresets(settings).isCustomized, false);
});

test('Persistent UI preferences, legacy quick-action migration, and static CSS/spellcheck guardrails', () => {
    // Legacy user who disabled both top-bar buttons auto-migrates to nativeQuickActionsMode: 'off'
    const migratedOff = normalizeSettings({
        showNativeExcludeBtn: false,
        showNativeEntrySearchBtn: false,
    });
    assert.equal(migratedOff.nativeQuickActionsMode, 'off');

    // Fresh default uses 3-in-1 'merged' button
    const fresh = normalizeSettings(null);
    assert.equal(fresh.nativeQuickActionsMode, 'merged');
    assert.equal(fresh.entrySearchScope, '__nonchar__');
    assert.equal(fresh.entryEditorTall, false);

    // Full preference persistence & export/import round-trip
    const customPrefs = normalizeSettings({
        nativeQuickActionsMode: 'split',
        showNativeComboBtn: true,
        quickHubLastTab: 'exclude',
        settingsLastTab: 'display',
        entryEditorTall: true,
        groupPanelExpanded: true,
        entrySearchScope: 'grp_style',
        entrySearchInTitle: false,
        entrySearchInContent: true,
        entrySearchIncludeDisabled: false,
        organizeLastTab: 'organize',
        localOrganizeScope: 'nonchar',
        localOrganizeUseAnyPrefix: true,
        localOrganizeCleanTitles: true,
        localOrganizeCustomRules: [{ kw: '跑团', group: '规则模组' }],
        aiOrganizeScope: 'nonchar',
        aiOrganizePresetIds: ['by_genre'],
        aiOrganizeCustomRule: '按朝代细分',
        aiOrganizeIncludeClues: true,
        aiOrganizeClueCount: 9,
        aiOrganizeSnippetLen: 120,
    });
    const exported = exportConfigData(customPrefs);
    const restored = normalizeSettings(null);
    assert.equal(importConfigData(restored, exported).ok, true);
    assert.equal(restored.nativeQuickActionsMode, 'split');
    assert.equal(restored.entryEditorTall, true);
    assert.equal(restored.groupPanelExpanded, true);
    assert.equal(restored.entrySearchScope, 'grp_style');
    assert.equal(restored.entrySearchInTitle, false);
    assert.equal(restored.entrySearchIncludeDisabled, false);
    assert.equal(restored.organizeLastTab, 'organize');
    assert.equal(restored.localOrganizeScope, 'nonchar');
    assert.equal(restored.localOrganizeUseAnyPrefix, true);
    assert.equal(restored.localOrganizeCleanTitles, true);
    assert.deepEqual(restored.localOrganizeCustomRules, [{ kw: '跑团', group: '规则模组' }]);
    assert.equal(restored.aiOrganizeScope, 'nonchar');
    assert.deepEqual(restored.aiOrganizePresetIds, ['by_genre']);
    assert.equal(restored.aiOrganizeCustomRule, '按朝代细分');
    assert.equal(restored.aiOrganizeIncludeClues, true);
    assert.equal(restored.aiOrganizeClueCount, 9);
    assert.equal(restored.aiOrganizeSnippetLen, 120);

    // Static guardrails: zero backdrop-filter/blur( in style.css, zero 3rd-party names,
    // spellcheck="false" on all text/search inputs and textareas, and zero unguarded .focus()
    const cssSrc = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
    assert.equal(/backdrop-filter\s*:/i.test(cssSrc), false, 'style.css must not use backdrop-filter');
    assert.equal(/\bblur\s*\(/i.test(cssSrc), false, 'style.css must not use blur()');
    assert.equal(/wbo-modal-mini-btn|is-mini-window|wbo-modal-resize-handle/.test(cssSrc), false, 'style.css must not contain removed mini-window or corner-badge rules');
    assert.match(cssSrc, /\.wbo-book-actions\s+\.wbo-book-more-btn\s*\{\s*display:\s*none\s*!important;/, 'wide desktop .wbo-book-more-btn hide rule must out-specify .wbo-icon-btn');
    assert.match(cssSrc, /\.wbo-book-actions\s+\.wbo-book-action-secondary\s*\{\s*display:\s*none\s*!important;/, 'responsive .wbo-book-action-secondary hide rule must out-specify .wbo-icon-btn');

    const forbiddenThirdPartyRe = /(?:baibai|st-baibai-tools|柏宝箱)/i;
    for (const relPath of ['../style.css', '../index.js', '../README.md', '../NEXT.md', '../src/core.js', '../src/host.js', '../src/panel.js', '../src/entry-accordion.js', '../src/native-filter.js']) {
        const txt = readFileSync(new URL(relPath, import.meta.url), 'utf8');
        assert.equal(forbiddenThirdPartyRe.test(txt), false, `Forbidden third-party reference found in ${relPath}`);
    }

    for (const relPath of ['../src/panel.js', '../src/entry-accordion.js', '../src/native-filter.js']) {
        const jsSrc = readFileSync(new URL(relPath, import.meta.url), 'utf8');
        const noBlockComments = jsSrc.replace(/\/\*[\s\S]*?\*\//g, '');
        const tags = noBlockComments.match(/<(?:textarea\b(?:\$\{[^}]*\}|[^>])*|input\b(?:\$\{[^}]*\}|[^>])*type=["'](?:text|search)["'](?:\$\{[^}]*\}|[^>])*)>/gi) || [];
        for (const tag of tags) {
            assert.match(tag, /spellcheck=["']false["']/i, `Missing spellcheck="false" in ${relPath}: ${tag}`);
        }
    }

    for (const relPath of ['../src/panel.js', '../src/entry-accordion.js']) {
        const rawSrc = readFileSync(new URL(relPath, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
        const lines = rawSrc.split(/\r?\n/);
        for (let i = 0; i < lines.length; i += 1) {
            const lineCode = lines[i].replace(/\/\/.*$/, '');
            if (!/\.focus\s*\(/.test(lineCode)) continue;
            const windowText = lines.slice(Math.max(0, i - 4), i + 1).join('\n');
            const isGuarded = /isDesktopAutoFocusAllowed\s*\(\)|vw\s*>\s*680\s*&&\s*!coarse/.test(windowText);
            assert.ok(isGuarded, `Unguarded .focus() at ${relPath}:${i + 1}: ${lines[i].trim()}`);
        }
    }
});

test('Intra-group worldbook drag-reorder (bookOrders) persists, sorts, and syncs across rename/delete/prune/backup', () => {
    const settings = normalizeSettings(null);
    const grp = addCustomGroup(settings, { name: '设定组' });
    settings.assignments = {
        书A: grp.id,
        书B: grp.id,
        书C: grp.id,
    };

    // Initial classification sorts alphabetically: 书A, 书B, 书C
    const initial = classifyWorldbooks({
        worldNames: ['书C', '书A', '书B', '未分组书1', '未分组书2'],
        bindingMap: new Map(),
        settings,
    });
    assert.deepEqual(initial.customGroups[0].books.map((b) => b.realName), ['书A', '书B', '书C']);

    // Drag 书C before 书A
    assert.equal(reorderBookInGroup(settings, grp.id, '书C', '书A', 'before', ['书A', '书B', '书C']), true);
    assert.deepEqual(settings.bookOrders[grp.id], ['书C', '书A', '书B']);
    // No-op reorder returns false
    assert.equal(reorderBookInGroup(settings, grp.id, '书C', '书A', 'before'), false);

    // Drag 书A after 书B
    assert.equal(reorderBookInGroup(settings, grp.id, '书A', '书B', 'after'), true);
    assert.deepEqual(settings.bookOrders[grp.id], ['书C', '书B', '书A']);

    const afterOrder = classifyWorldbooks({
        worldNames: ['书C', '书A', '书B'],
        bindingMap: new Map(),
        settings,
    });
    assert.deepEqual(afterOrder.customGroups[0].books.map((b) => b.realName), ['书C', '书B', '书A']);

    // Rename, delete, and stale prune sync bookOrders
    migrateSettingsOnWorldRename(settings, '书B', '书B_新');
    assert.deepEqual(settings.bookOrders[grp.id], ['书C', '书B_新', '书A']);

    cleanupDeletedWorldSettings(settings, ['书A']);
    assert.deepEqual(settings.bookOrders[grp.id], ['书C', '书B_新']);

    assert.equal(pruneStaleWorldbookSettings(settings, new Set(['书C'])), true);
    assert.deepEqual(settings.bookOrders[grp.id], ['书C']);

    // Moving/reordering a book into a different group prunes stale entries from other bookOrders[otherGid]
    const grp2 = addCustomGroup(settings, { name: '规则组' });
    settings.assignments['书C'] = grp2.id;
    settings.assignments['书D'] = grp2.id;
    assert.equal(reorderBookInGroup(settings, grp2.id, '书C', '书D', 'before', ['书D', '书C']), true);
    assert.deepEqual(settings.bookOrders[grp2.id], ['书C', '书D']);
    assert.equal(settings.bookOrders[grp.id], undefined);

    // Export / import round-trip preserves bookOrders
    const exported = exportConfigData(settings);
    const restored = normalizeSettings(null);
    assert.equal(importConfigData(restored, exported).ok, true);
    assert.deepEqual(restored.bookOrders[grp2.id], ['书C', '书D']);
    assert.equal(restored.bookOrders[grp.id], undefined);
});

function installMockNativeFilterDom({ innerWidth = 390, innerHeight = 844 } = {}) {
    const saved = {
        window: globalThis.window,
        document: globalThis.document,
        Element: globalThis.Element,
        HTMLElement: globalThis.HTMLElement,
        HTMLInputElement: globalThis.HTMLInputElement,
        HTMLSelectElement: globalThis.HTMLSelectElement,
        HTMLOptionElement: globalThis.HTMLOptionElement,
        HTMLOptGroupElement: globalThis.HTMLOptGroupElement,
        Event: globalThis.Event,
        CustomEvent: globalThis.CustomEvent,
        KeyboardEvent: globalThis.KeyboardEvent,
        MutationObserver: globalThis.MutationObserver,
        CSS: globalThis.CSS,
        jQuery: globalThis.jQuery,
        SillyTavern: globalThis.SillyTavern,
        requestAnimationFrame: globalThis.requestAnimationFrame,
        getComputedStyle: globalThis.getComputedStyle,
        visualViewport: globalThis.visualViewport,
        innerWidth: globalThis.innerWidth,
        innerHeight: globalThis.innerHeight,
        addEventListener: globalThis.addEventListener,
        removeEventListener: globalThis.removeEventListener,
        dispatchEvent: globalThis.dispatchEvent,
    };

    const winListeners = new Map();
    const vvListeners = new Map();
    const observerInstances = [];

    class MockEvent {
        constructor(type, init = {}) {
            this.type = type;
            this.bubbles = Boolean(init.bubbles);
            this.cancelable = Boolean(init.cancelable);
            this.defaultPrevented = false;
            this.cancelBubble = false;
            this.target = init.target || null;
            this.currentTarget = null;
            this.key = init.key || '';
            this.code = init.code || '';
            this.keyCode = init.keyCode || 0;
            this.clientX = init.clientX ?? 0;
            this.clientY = init.clientY ?? 0;
        }
        preventDefault() {
            this.defaultPrevented = true;
        }
        stopPropagation() {
            this.cancelBubble = true;
        }
        stopImmediatePropagation() {
            this.cancelBubble = true;
            this._stopImmediate = true;
        }
    }

    class MockClassList {
        constructor(el) {
            this._el = el;
            this._set = new Set();
        }
        _syncFromString(str) {
            this._set = new Set(String(str || '').split(/\s+/).filter(Boolean));
        }
        _syncToAttr() {
            this._el._attrs.set('class', [...this._set].join(' '));
        }
        add(...names) {
            for (const n of names) if (n) this._set.add(n);
            this._syncToAttr();
        }
        remove(...names) {
            for (const n of names) this._set.delete(n);
            this._syncToAttr();
        }
        toggle(name, force) {
            if (force === undefined) {
                if (this._set.has(name)) this._set.delete(name);
                else this._set.add(name);
            } else if (force) {
                this._set.add(name);
            } else {
                this._set.delete(name);
            }
            this._syncToAttr();
            return this._set.has(name);
        }
        contains(name) {
            return this._set.has(name);
        }
    }

    function parseAttrs(rawAttrs) {
        const attrs = new Map();
        const re = /([a-zA-Z0-9_:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
        let m;
        while ((m = re.exec(rawAttrs)) !== null) {
            attrs.set(m[1], m[2] ?? m[3] ?? m[4] ?? '');
        }
        return attrs;
    }

    function matchesCompound(el, compound) {
        if (!(el instanceof MockElement)) return false;
        let clean = compound.replace(/^:scope\s*>\s*/, '').trim();
        if (!clean) return false;
        const notClauses = [];
        clean = clean.replace(/:not\(([^)]+)\)/g, (_, inner) => {
            notClauses.push(inner.trim());
            return '';
        });
        if (clean) {
            const tokens = clean.match(/([#.][^\s#.[\]:]+|\[[^\]]+\]|^[a-zA-Z0-9_-]+)/g);
            if (!tokens || tokens.join('') !== clean) return false;
            for (const tok of tokens) {
                if (tok.startsWith('#')) {
                    if (el.id !== tok.slice(1)) return false;
                } else if (tok.startsWith('.')) {
                    if (!el.classList.contains(tok.slice(1))) return false;
                } else if (tok.startsWith('[')) {
                    const m = tok.match(/^\[([a-zA-Z0-9_:-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]$/);
                    if (!m) return false;
                    const attrName = m[1];
                    if (!el.hasAttribute(attrName)) return false;
                    const expected = m[2] ?? m[3] ?? m[4];
                    if (expected !== undefined && el.getAttribute(attrName) !== expected) return false;
                } else if (el.tagName !== tok.toUpperCase()) {
                    return false;
                }
            }
        }
        for (const inner of notClauses) {
            if (matchesCompound(el, inner)) return false;
        }
        return true;
    }

    function matchesSelector(el, selector, scopeEl = null) {
        if (!(el instanceof MockElement)) return false;
        const groups = String(selector || '').split(',').map((s) => s.trim()).filter(Boolean);
        return groups.some((grp) => {
            if (scopeEl && grp.startsWith(':scope')) {
                const rest = grp.replace(/^:scope\s*>\s*/, '').trim();
                if (grp.includes('>')) {
                    return el.parentElement === scopeEl && matchesCompound(el, rest);
                }
            }
            const parts = grp.replace(/>/g, ' ').trim().split(/\s+/).filter(Boolean);
            if (parts.length === 0) return false;
            if (!matchesCompound(el, parts[parts.length - 1])) return false;
            let cur = el.parentElement;
            for (let i = parts.length - 2; i >= 0; i -= 1) {
                while (cur && !matchesCompound(cur, parts[i])) {
                    cur = cur.parentElement;
                }
                if (!cur) return false;
                cur = cur.parentElement;
            }
            return true;
        });
    }

    class MockNode {
        constructor(nodeType, textContent = '') {
            this.nodeType = nodeType;
            this.parentNode = null;
            this._textContent = textContent;
        }
        get parentElement() {
            return this.parentNode instanceof MockElement ? this.parentNode : null;
        }
        get textContent() {
            return this._textContent;
        }
        set textContent(v) {
            this._textContent = String(v ?? '');
        }
        remove() {
            if (this.parentNode) {
                const idx = this.parentNode.childNodes.indexOf(this);
                if (idx >= 0) this.parentNode.childNodes.splice(idx, 1);
                this.parentNode = null;
            }
        }
    }

    class MockElement extends MockNode {
        constructor(tagName) {
            super(1, '');
            this.tagName = String(tagName || 'div').toUpperCase();
            this.childNodes = [];
            this._attrs = new Map();
            this.classList = new MockClassList(this);
            this.style = {};
            this._listeners = new Map();
            this._rect = { left: 10, top: 100, right: 250, bottom: 136, width: 240, height: 36 };
            this.scrollTop = 0;
            this.scrollLeft = 0;
            this.scrollWidth = 200;
            this.clientWidth = 200;
            this.scrollHeight = 200;
            this.clientHeight = 200;
            this.hidden = false;
            this.dataset = new Proxy({}, {
                get: (_, prop) => {
                    const attr = `data-${String(prop).replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`;
                    return this._attrs.has(attr) ? this._attrs.get(attr) : undefined;
                },
                set: (_, prop, val) => {
                    const attr = `data-${String(prop).replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`;
                    this._attrs.set(attr, String(val));
                    return true;
                },
                deleteProperty: (_, prop) => {
                    const attr = `data-${String(prop).replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`;
                    this._attrs.delete(attr);
                    return true;
                },
            });
        }
        get isConnected() {
            let cur = this;
            while (cur) {
                if (cur === doc.documentElement || cur === doc.body) return true;
                cur = cur.parentNode;
            }
            return false;
        }
        get id() {
            return this._attrs.get('id') || '';
        }
        set id(val) {
            this._attrs.set('id', String(val ?? ''));
        }
        get className() {
            return this._attrs.get('class') || '';
        }
        set className(val) {
            this._attrs.set('class', String(val ?? ''));
            this.classList._syncFromString(val);
        }
        get children() {
            return this.childNodes.filter((c) => c instanceof MockElement);
        }
        get firstChild() {
            return this.childNodes[0] || null;
        }
        get textContent() {
            if (this.childNodes.length === 0) return this._textContent;
            return this.childNodes.map((c) => c.textContent).join('');
        }
        set textContent(val) {
            this.childNodes = [];
            this._textContent = String(val ?? '');
            if (this._textContent) {
                const tn = new MockNode(3, this._textContent);
                tn.parentNode = this;
                this.childNodes.push(tn);
            }
        }
        setAttribute(name, value) {
            const val = String(value ?? '');
            this._attrs.set(name, val);
            if (name === 'class') this.classList._syncFromString(val);
            if (name === 'hidden') this.hidden = true;
        }
        getAttribute(name) {
            return this._attrs.has(name) ? this._attrs.get(name) : null;
        }
        hasAttribute(name) {
            return this._attrs.has(name);
        }
        appendChild(node) {
            if (node instanceof MockFragment) {
                for (const c of [...node.childNodes]) this.appendChild(c);
                return node;
            }
            node.remove();
            node.parentNode = this;
            this.childNodes.push(node);
            return node;
        }
        append(...nodes) {
            for (const n of nodes) {
                if (typeof n === 'string') {
                    const tn = new MockNode(3, n);
                    tn.parentNode = this;
                    this.childNodes.push(tn);
                } else if (n) {
                    this.appendChild(n);
                }
            }
        }
        insertBefore(newNode, refNode) {
            if (!refNode) return this.appendChild(newNode);
            newNode.remove();
            newNode.parentNode = this;
            const idx = this.childNodes.indexOf(refNode);
            if (idx >= 0) {
                this.childNodes.splice(idx, 0, newNode);
            } else {
                this.childNodes.push(newNode);
            }
            return newNode;
        }
        insertAdjacentElement(pos, node) {
            if (pos === 'afterend' && this.parentNode) {
                node.remove();
                node.parentNode = this.parentNode;
                const idx = this.parentNode.childNodes.indexOf(this);
                this.parentNode.childNodes.splice(idx + 1, 0, node);
            }
            return node;
        }
        set innerHTML(html) {
            this.childNodes = [];
            const voidTags = new Set(['input', 'br', 'hr', 'img', 'meta', 'link']);
            const stack = [this];
            const tokenRe = /<\/?([a-zA-Z0-9_-]+)([^>]*)>|([^<]+)/g;
            let m;
            while ((m = tokenRe.exec(String(html || ''))) !== null) {
                const parent = stack[stack.length - 1];
                if (m[3] !== undefined) {
                    if (m[3]) {
                        const tn = new MockNode(3, m[3]);
                        tn.parentNode = parent;
                        parent.childNodes.push(tn);
                    }
                    continue;
                }
                const full = m[0];
                const tag = m[1].toLowerCase();
                if (full.startsWith('</')) {
                    while (stack.length > 1 && stack[stack.length - 1].tagName.toLowerCase() !== tag) {
                        stack.pop();
                    }
                    if (stack.length > 1) stack.pop();
                } else {
                    const child = doc.createElement(tag);
                    const attrs = parseAttrs(m[2] || '');
                    for (const [k, v] of attrs.entries()) child.setAttribute(k, v);
                    parent.appendChild(child);
                    if (!voidTags.has(tag) && !full.endsWith('/>')) {
                        stack.push(child);
                    }
                }
            }
        }
        contains(other) {
            let cur = other;
            while (cur) {
                if (cur === this) return true;
                cur = cur.parentNode;
            }
            return false;
        }
        matches(sel) {
            return matchesSelector(this, sel);
        }
        closest(sel) {
            let cur = this;
            while (cur) {
                if (cur instanceof MockElement && matchesSelector(cur, sel)) return cur;
                cur = cur.parentElement;
            }
            return null;
        }
        querySelectorAll(sel) {
            const out = [];
            const walk = (node) => {
                for (const c of node.children || []) {
                    if (matchesSelector(c, sel, this)) out.push(c);
                    walk(c);
                }
            };
            walk(this);
            return out;
        }
        querySelector(sel) {
            return this.querySelectorAll(sel)[0] || null;
        }
        getBoundingClientRect() {
            return { ...this._rect };
        }
        addEventListener(type, fn, opts) {
            const capture = typeof opts === 'boolean' ? opts : Boolean(opts?.capture);
            if (!this._listeners.has(type)) this._listeners.set(type, []);
            this._listeners.get(type).push({ fn, capture });
        }
        removeEventListener(type, fn, opts) {
            const capture = typeof opts === 'boolean' ? opts : Boolean(opts?.capture);
            const arr = this._listeners.get(type);
            if (!arr) return;
            this._listeners.set(
                type,
                arr.filter((entry) => entry.fn !== fn || entry.capture !== capture),
            );
        }
        dispatchEvent(ev) {
            if (!ev.target) ev.target = this;
            const path = [];
            let cur = this;
            while (cur) {
                path.push(cur);
                cur = cur.parentNode;
            }
            for (let i = path.length - 1; i >= 0; i -= 1) {
                if (ev.cancelBubble) break;
                const node = path[i];
                const list = [...(node._listeners?.get(ev.type) || [])].filter((e) => e.capture);
                ev.currentTarget = node;
                for (const entry of list) {
                    entry.fn(ev);
                    if (ev._stopImmediate) break;
                }
            }
            for (let i = 0; i < path.length; i += 1) {
                if (ev.cancelBubble && (ev.bubbles || i > 0)) break;
                if (!ev.bubbles && i > 0) break;
                const node = path[i];
                const list = [...(node._listeners?.get(ev.type) || [])].filter((e) => !e.capture);
                ev.currentTarget = node;
                for (const entry of list) {
                    entry.fn(ev);
                    if (ev._stopImmediate) break;
                }
            }
            return !ev.defaultPrevented;
        }
        focus() {
            doc.activeElement = this;
        }
        blur() {
            if (doc.activeElement === this) doc.activeElement = doc.body;
        }
    }

    class MockInputElement extends MockElement {
        constructor() {
            super('input');
            this.value = '';
        }
    }
    class MockOptionElement extends MockElement {
        constructor() {
            super('option');
            this.selected = false;
        }
        get value() {
            return this._attrs.has('value') ? this._attrs.get('value') : this.textContent;
        }
        set value(v) {
            this._attrs.set('value', String(v ?? ''));
        }
    }
    class MockOptGroupElement extends MockElement {
        constructor() {
            super('optgroup');
        }
        get label() {
            return this._attrs.get('label') || '';
        }
        set label(v) {
            this._attrs.set('label', String(v ?? ''));
        }
    }
    class MockSelectElement extends MockElement {
        constructor() {
            super('select');
            this.multiple = false;
        }
        get options() {
            return this.querySelectorAll('option');
        }
        get selectedOptions() {
            return this.options.filter((o) => o.selected);
        }
        get value() {
            return this.selectedOptions[0]?.value ?? '';
        }
        set value(v) {
            const s = String(v ?? '');
            for (const o of this.options) {
                o.selected = o.value === s;
            }
        }
    }
    class MockFragment {
        constructor() {
            this.childNodes = [];
        }
        appendChild(node) {
            node.remove?.();
            node.parentNode = null;
            this.childNodes.push(node);
            return node;
        }
    }

    const doc = {
        readyState: 'complete',
        _listeners: new Map(),
        documentElement: null,
        body: null,
        activeElement: null,
        createElement(tag) {
            const t = String(tag).toLowerCase();
            if (t === 'input') return new MockInputElement();
            if (t === 'select') return new MockSelectElement();
            if (t === 'option') return new MockOptionElement();
            if (t === 'optgroup') return new MockOptGroupElement();
            return new MockElement(t);
        },
        createDocumentFragment() {
            return new MockFragment();
        },
        getElementById(id) {
            return this.documentElement.querySelector(`#${id}`);
        },
        querySelector(sel) {
            return this.documentElement.querySelector(sel);
        },
        querySelectorAll(sel) {
            return this.documentElement.querySelectorAll(sel);
        },
        addEventListener(type, fn, opts) {
            this.documentElement.addEventListener(type, fn, opts);
        },
        removeEventListener(type, fn, opts) {
            this.documentElement.removeEventListener(type, fn, opts);
        },
    };
    doc.documentElement = new MockElement('html');
    doc.body = new MockElement('body');
    doc.documentElement.appendChild(doc.body);
    doc.activeElement = doc.body;

    const vv = {
        height: innerHeight,
        offsetTop: 0,
        addEventListener(type, fn) {
            if (!vvListeners.has(type)) vvListeners.set(type, new Set());
            vvListeners.get(type).add(fn);
        },
        removeEventListener(type, fn) {
            vvListeners.get(type)?.delete(fn);
        },
        dispatchEvent(ev) {
            for (const fn of [...(vvListeners.get(ev.type) || [])]) fn(ev);
            return true;
        },
    };

    globalThis.Element = MockElement;
    globalThis.HTMLElement = MockElement;
    globalThis.HTMLInputElement = MockInputElement;
    globalThis.HTMLSelectElement = MockSelectElement;
    globalThis.HTMLOptionElement = MockOptionElement;
    globalThis.HTMLOptGroupElement = MockOptGroupElement;
    globalThis.Event = MockEvent;
    globalThis.CustomEvent = class MockCustomEvent extends MockEvent {
        constructor(type, init = {}) {
            super(type, init);
            this.detail = init.detail;
        }
    };
    globalThis.KeyboardEvent = MockEvent;
    globalThis.document = doc;
    globalThis.innerWidth = innerWidth;
    globalThis.innerHeight = innerHeight;
    globalThis.visualViewport = vv;
    globalThis.addEventListener = (type, fn) => {
        if (!winListeners.has(type)) winListeners.set(type, new Set());
        winListeners.get(type).add(fn);
    };
    globalThis.removeEventListener = (type, fn) => {
        winListeners.get(type)?.delete(fn);
    };
    globalThis.dispatchEvent = (ev) => {
        for (const fn of [...(winListeners.get(ev.type) || [])]) fn(ev);
        return true;
    };
    globalThis.window = {
        dispatchEvent: globalThis.dispatchEvent,
        addEventListener: globalThis.addEventListener,
        removeEventListener: globalThis.removeEventListener,
    };
    globalThis.CSS = { escape: (s) => String(s) };
    globalThis.requestAnimationFrame = (cb) => {
        cb();
        return 1;
    };
    globalThis.getComputedStyle = () => ({
        color: 'rgb(220, 220, 220)',
        height: '32px',
        paddingLeft: '10px',
        borderRadius: '6px',
        borderTopWidth: '1px',
        borderTopStyle: 'solid',
        borderTopColor: 'rgb(80, 80, 80)',
        backgroundColor: 'rgb(30, 30, 30)',
        fontSize: '13px',
        fontFamily: 'sans-serif',
        fontWeight: '400',
        boxShadow: 'none',
        marginTop: '0px',
        marginRight: '0px',
        marginBottom: '0px',
        marginLeft: '0px',
        alignSelf: 'auto',
        verticalAlign: 'middle',
    });
    globalThis.MutationObserver = class MockMutationObserver {
        constructor(cb) {
            this.cb = cb;
            this.target = null;
            observerInstances.push(this);
        }
        observe(target) {
            this.target = target;
        }
        disconnect() {
            this.target = null;
        }
        takeRecords() {
            return [];
        }
    };
    delete globalThis.jQuery;
    globalThis.SillyTavern = {
        getContext: () => ({
            characters: [],
            extensionSettings: {},
            saveSettingsDebounced: () => {},
        }),
    };

    const restore = () => {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete globalThis[k];
            else globalThis[k] = v;
        }
    };

    return { doc, vv, MockEvent, observerInstances, winListeners, vvListeners, restore };
}

test('R6.1 mobile editor picker keeps #wbo-mp-search open & focused during soft-keyboard resize/scroll and closes on unfocused width change', async () => {
    const dom = installMockNativeFilterDom({ innerWidth: 390, innerHeight: 844 });
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
        const editorSel = dom.doc.createElement('select');
        editorSel.id = 'world_editor_select';
        for (const [val, txt] of [['', '--- Pick to Edit ---'], ['0', '书A'], ['1', '书B'], ['2', '书C']]) {
            const opt = dom.doc.createElement('option');
            opt.value = val;
            opt.textContent = txt;
            editorSel.appendChild(opt);
        }
        worldPopup.appendChild(editorSel);
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
        const trigger = dom.doc.getElementById('wbo-mobile-editor-trigger');
        assert.ok(trigger, 'mobile editor trigger should mount when Select2 is absent and >=2 sections exist');

        trigger.dispatchEvent(new dom.MockEvent('click', { bubbles: true, cancelable: true }));
        const overlay = dom.doc.getElementById('wbo-mobile-picker-overlay');
        assert.ok(overlay && overlay.isConnected, 'mobile picker overlay should open');
        const popover = overlay.querySelector('.wbo-mp-popover');
        const searchInput = overlay.querySelector('#wbo-mp-search');
        assert.ok(popover && searchInput, 'popover and #wbo-mp-search must exist');

        // Focus search input to raise soft keyboard
        searchInput.focus();
        assert.equal(dom.doc.activeElement, searchInput);

        // Simulate iOS WKWebView keyboard opening: innerHeight & visualViewport.height shrink 844 -> 460 while innerWidth stays 390
        globalThis.innerHeight = 460;
        dom.vv.height = 460;
        globalThis.dispatchEvent(new dom.MockEvent('resize'));
        dom.vv.dispatchEvent(new dom.MockEvent('resize'));
        dom.vv.dispatchEvent(new dom.MockEvent('scroll'));

        assert.equal(overlay.isConnected, true, 'overlay must stay open when soft keyboard triggers resize/scroll');
        assert.equal(dom.doc.activeElement, searchInput, '#wbo-mp-search must retain focus');
        assert.equal(overlay.querySelector('#wbo-mp-search'), searchInput, '#wbo-mp-search DOM identity must not be rebuilt');
        const clampedMaxH = parseInt(popover.style.maxHeight, 10);
        assert.ok(Number.isFinite(clampedMaxH) && clampedMaxH >= 120 && clampedMaxH <= 320, `maxHeight should clamp inside 460px viewport, got ${popover.style.maxHeight}`);

        // Orientation change while #wbo-mp-search is focused updates initialVw and repositions without closing
        globalThis.innerWidth = 844;
        globalThis.innerHeight = 390;
        dom.vv.height = 390;
        globalThis.dispatchEvent(new dom.MockEvent('orientationchange'));
        assert.equal(overlay.isConnected, true, 'focused orientationchange must keep picker open');
        assert.equal(dom.doc.activeElement, searchInput);

        // Unfocused orientation/width change (844 -> 390) should close cleanly
        searchInput.blur();
        assert.equal(dom.doc.activeElement, dom.doc.body);
        globalThis.innerWidth = 390;
        globalThis.innerHeight = 844;
        dom.vv.height = 844;
        globalThis.dispatchEvent(new dom.MockEvent('resize'));
        assert.equal(overlay.isConnected, false, 'unfocused width change should close the mobile picker');
    } finally {
        nativeMod.teardownNativeFilters();
        dom.restore();
    }
});

test('R6.1 grouped popup picker (#wbo-pop-search) clamps to visualViewport without closing or rebuilding input', async () => {
    const dom = installMockNativeFilterDom({ innerWidth: 390, innerHeight: 844 });
    const nativeMod = await import('../src/native-filter.js');
    try {
        const dialog = dom.doc.createElement('dialog');
        const personaPopup = dom.doc.createElement('div');
        personaPopup.className = 'persona_world';
        const personaSel = dom.doc.createElement('select');
        personaSel.className = 'persona_world_info_selector';
        for (const [val, txt] of [['', '--- None ---'], ['0', '书A'], ['1', '书B']]) {
            const opt = dom.doc.createElement('option');
            opt.value = val;
            opt.textContent = txt;
            personaSel.appendChild(opt);
        }
        personaPopup.appendChild(personaSel);
        dialog.appendChild(personaPopup);
        dom.doc.body.appendChild(dialog);

        const settings = normalizeSettings({
            groups: [{ id: 'g1', name: '文风', color: '#5b8def', collapsed: false }],
            assignments: { 书A: 'g1' },
            adaptPersonaBindPopup: true,
        });
        const cls = classifyWorldbooks({
            worldNames: ['书A', '书B'],
            bindingMap: new Map(),
            settings,
        });

        nativeMod.applyAllNativeWorldFilters(cls, settings, { force: true });
        nativeMod.startNativeObservers(() => {});

        const bodyObserver = dom.observerInstances.find((o) => o.target === dom.doc.body);
        assert.ok(bodyObserver, 'body MutationObserver should be registered');
        bodyObserver.cb([{ addedNodes: [dialog] }]);

        const trigger = personaPopup.querySelector('.wbo-popup-select-trigger');
        assert.ok(trigger, 'grouped popup select trigger should mount');
        trigger.dispatchEvent(new dom.MockEvent('click', { bubbles: true, cancelable: true }));

        const backdrop = dialog.querySelector('.wbo-mp-backdrop');
        const popover = backdrop?.querySelector('.wbo-mp-popover');
        const popSearch = popover?.querySelector('#wbo-pop-search');
        assert.ok(backdrop && popover && popSearch, '#wbo-pop-search grouped popover should open');

        popSearch.focus();
        globalThis.innerHeight = 460;
        dom.vv.height = 460;
        globalThis.dispatchEvent(new dom.MockEvent('resize'));
        dom.vv.dispatchEvent(new dom.MockEvent('resize'));
        dom.vv.dispatchEvent(new dom.MockEvent('scroll'));

        assert.equal(backdrop.isConnected, true, '#wbo-pop-search popover must stay open on keyboard resize/scroll');
        assert.equal(dom.doc.activeElement, popSearch);
        assert.equal(popover.querySelector('#wbo-pop-search'), popSearch);
        const maxH = parseInt(popover.style.maxHeight, 10);
        assert.ok(Number.isFinite(maxH) && maxH >= 120 && maxH <= 320, `expected clamped maxHeight, got ${popover.style.maxHeight}`);
    } finally {
        nativeMod.teardownNativeFilters();
        dom.restore();
    }
});

test('R6.2 .gr-container-enhanced & #world_popup .gr-select2-display isolation + ungrouped bubble guard', async () => {
    const dom = installMockNativeFilterDom({ innerWidth: 390, innerHeight: 844 });
    const nativeMod = await import('../src/native-filter.js');
    try {
        const wiDrawer = dom.doc.createElement('div');
        wiDrawer.id = 'WorldInfo';
        const multiSel = dom.doc.createElement('div');
        multiSel.id = 'WIMultiSelector';
        const globalSel = dom.doc.createElement('select');
        globalSel.id = 'world_info';
        globalSel.multiple = true;
        const globalGrDisplay = dom.doc.createElement('div');
        globalGrDisplay.className = 'gr-select2-display';
        multiSel.appendChild(globalSel);
        multiSel.appendChild(globalGrDisplay);

        const worldPopup = dom.doc.createElement('div');
        worldPopup.id = 'world_popup';
        const editorSel = dom.doc.createElement('select');
        editorSel.id = 'world_editor_select';
        for (const [val, txt] of [['', '--- Pick to Edit ---'], ['0', '书A'], ['1', '书B']]) {
            const opt = dom.doc.createElement('option');
            opt.value = val;
            opt.textContent = txt;
            editorSel.appendChild(opt);
        }
        const editorGrDisplay = dom.doc.createElement('div');
        editorGrDisplay.className = 'gr-select2-display';
        worldPopup.appendChild(editorSel);
        worldPopup.appendChild(editorGrDisplay);
        wiDrawer.appendChild(multiSel);
        wiDrawer.appendChild(worldPopup);
        dom.doc.body.appendChild(wiDrawer);

        // Zero custom groups, zero pinned, showCharBooks: false -> needsPopoverGrouping is FALSE!
        const settings = normalizeSettings({ groups: [], showCharBooks: false });
        const cls = classifyWorldbooks({
            worldNames: ['书A', '书B'],
            bindingMap: new Map(),
            settings,
        });

        nativeMod.applyAllNativeWorldFilters(cls, settings, { force: true });
        nativeMod.startNativeObservers(() => {});

        // Simulate host mounting an ungrouped editor `.gr-container-enhanced` AND a global `#gr-global-dropdown-container`
        const editorEnhanced = dom.doc.createElement('div');
        editorEnhanced.className = 'gr-container-enhanced';
        for (const [v, t] of [['0', '书A'], ['1', '书B']]) {
            const opt = dom.doc.createElement('div');
            opt.className = 'gr-option';
            opt.dataset.value = v;
            opt.textContent = t;
            editorEnhanced.appendChild(opt);
        }
        const globalEnhanced = dom.doc.createElement('div');
        globalEnhanced.id = 'gr-global-dropdown-container';
        globalEnhanced.className = 'gr-container-enhanced';
        dom.doc.body.appendChild(editorEnhanced);
        dom.doc.body.appendChild(globalEnhanced);

        const bodyObserver = dom.observerInstances.find((o) => o.target === dom.doc.body);
        assert.ok(bodyObserver, 'body MutationObserver should be registered');
        bodyObserver.cb([{ addedNodes: [editorEnhanced, globalEnhanced] }]);

        assert.equal(editorEnhanced.dataset.wboPopoverRole, 'editor', 'ungrouped editor .gr-container-enhanced must still receive role=editor');
        assert.equal(editorEnhanced.dataset.wboBubbleGuarded, '1', 'ungrouped editor .gr-container-enhanced must receive bubble guard');
        assert.equal(globalEnhanced.dataset.wboPopoverRole, 'global');
        assert.equal(globalEnhanced.dataset.wboBubbleGuarded, '1');

        // Clicking #world_popup .gr-select2-display must preserve editorEnhanced while closing globalEnhanced!
        editorGrDisplay.dispatchEvent(new dom.MockEvent('pointerdown', { bubbles: true, cancelable: true }));
        assert.equal(editorEnhanced.isConnected, true, 'clicking #world_popup .gr-select2-display must NOT close editor .gr-container-enhanced');
        assert.notEqual(editorEnhanced.style.display, 'none');
        assert.equal(globalEnhanced.isConnected, false, 'clicking editor trigger must close global dropdown');

        // Direct closeAllOpenWorldDropdowns({ except: 'editor' }) must also keep editorEnhanced intact
        nativeMod.closeAllOpenWorldDropdowns({ except: 'editor' });
        assert.equal(editorEnhanced.isConnected, true);
        assert.notEqual(editorEnhanced.style.display, 'none');

        // Clicking #WIMultiSelector .gr-select2-display closes editorEnhanced
        globalGrDisplay.dispatchEvent(new dom.MockEvent('pointerdown', { bubbles: true, cancelable: true }));
        assert.equal(editorEnhanced.isConnected, false, 'clicking global .gr-select2-display should close editor dropdown');
    } finally {
        nativeMod.teardownNativeFilters();
        dom.restore();
    }
});

test('R6.3 & Challenger R2 static CSS/JS guardrails (.wbo-vis-popover min-width, mobile >=16px inputs, no resize closePicker)', () => {
    const cssSrc = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
    const nativeSrc = readFileSync(new URL('../src/native-filter.js', import.meta.url), 'utf8');

    const visBlock = cssSrc.match(/\.wbo-vis-popover\s*\{[\s\S]*?\}/);
    assert.ok(visBlock, '.wbo-vis-popover block must exist in style.css');
    assert.match(visBlock[0], /min-width:\s*0\s*!important\s*;/, '.wbo-vis-popover must reset .wbo-modal min-width: 340px with min-width: 0 !important;');

    const mobileInputBlock = cssSrc.match(/@media\s*\(max-width:\s*680px\),\s*\(pointer:\s*coarse\)\s*\{[\s\S]*?\.wbo-mp-popover\s+\.wbo-search-input[\s\S]*?\}\s*\}/);
    assert.ok(mobileInputBlock, 'mobile/coarse >=16px input media block must exist in style.css');
    assert.match(mobileInputBlock[0], /font-size:\s*16px\s*!important\s*;/);
    assert.match(mobileInputBlock[0], /height:\s*34px\s*!important\s*;/);
    assert.match(mobileInputBlock[0], /min-height:\s*34px\s*!important\s*;/);

    assert.equal(/const\s+onViewportChange\s*=\s*\(\)\s*=>\s*closePicker\s*\(\)/.test(nativeSrc), false, 'native-filter.js must never unconditionally close mobile picker on resize');
    assert.match(nativeSrc, /displaySelector:\s*'#WIMultiSelector \.gr-select2-display'/);
});

test('R6.2 grouped enhanceCustomDropdownPopover works for global (★ 已置顶 hoisting) and editor popovers + placeholder-only isolation', async () => {
    const dom = installMockNativeFilterDom({ innerWidth: 390, innerHeight: 844 });
    const nativeMod = await import('../src/native-filter.js');
    try {
        const wiDrawer = dom.doc.createElement('div');
        wiDrawer.id = 'WorldInfo';
        const multiSel = dom.doc.createElement('div');
        multiSel.id = 'WIMultiSelector';
        const globalSel = dom.doc.createElement('select');
        globalSel.id = 'world_info';
        globalSel.multiple = true;
        const globalGrDisplay = dom.doc.createElement('div');
        globalGrDisplay.className = 'gr-select2-display';
        multiSel.appendChild(globalSel);
        multiSel.appendChild(globalGrDisplay);

        const worldPopup = dom.doc.createElement('div');
        worldPopup.id = 'world_popup';
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
        worldPopup.appendChild(editorSel);
        worldPopup.appendChild(editorGrDisplay);
        wiDrawer.appendChild(multiSel);
        wiDrawer.appendChild(worldPopup);
        dom.doc.body.appendChild(wiDrawer);

        const settings = normalizeSettings({
            groups: [{ id: 'g1', name: '文风', color: '#5b8def', collapsed: false }],
            assignments: { 书A: 'g1' },
            pinnedBooks: ['书A'],
            showNativeOptgroups: true,
        });
        const cls = classifyWorldbooks({
            worldNames: ['书A', '书B', '书C'],
            bindingMap: new Map(),
            settings,
        });

        nativeMod.applyAllNativeWorldFilters(cls, settings, { force: true });
        nativeMod.startNativeObservers(() => {});

        const bodyObserver = dom.observerInstances.find((o) => o.target === dom.doc.body);
        assert.ok(bodyObserver, 'body MutationObserver should be registered');

        // 1) Grouped #gr-global-dropdown-container (exercises isGlobalPopover === true, orderedSections >= 2, initialPopPinned > 0)
        const globalEnhanced = dom.doc.createElement('div');
        globalEnhanced.id = 'gr-global-dropdown-container';
        globalEnhanced.className = 'gr-container-enhanced';
        const globalSearch = dom.doc.createElement('input');
        globalSearch.className = 'gr-search-input';
        const globalOptionsHost = dom.doc.createElement('div');
        globalOptionsHost.className = 'gr-options-list';
        for (const [v, t] of [['0', '书A'], ['1', '书B'], ['2', '书C']]) {
            const opt = dom.doc.createElement('div');
            opt.className = 'gr-option';
            opt.dataset.value = v;
            opt.textContent = t;
            globalOptionsHost.appendChild(opt);
        }
        globalEnhanced.appendChild(globalSearch);
        globalEnhanced.appendChild(globalOptionsHost);
        dom.doc.body.appendChild(globalEnhanced);

        bodyObserver.cb([{ addedNodes: [globalEnhanced] }]);

        assert.equal(globalEnhanced.dataset.wboPopoverRole, 'global');
        assert.equal(globalEnhanced.dataset.wboPopoverReady, '1');
        const globalSections = globalOptionsHost.querySelectorAll('.wbo-pop-section');
        assert.ok(globalSections.length >= 2, 'global popover should render pinned + ungrouped sections');
        assert.equal(globalSections[0].getAttribute('data-wbo-dd-group'), '__pinned__');
        assert.match(globalSections[0].querySelector('.wbo-dd-group-head')?.textContent || '', /★ 已置顶 \(1\)/);
        const globalFilterBar = globalEnhanced.querySelector('.wbo-pop-filter-bar');
        assert.ok(globalFilterBar, 'global popover should receive .wbo-pop-filter-bar');
        const g1Pill = Array.from(globalFilterBar.querySelectorAll('.wbo-dd-pill')).find((b) => b.getAttribute('data-wbo-pill') === 'g1');
        assert.equal(g1Pill?.textContent, '文风 1', 'global pill count must include hoisted pinned item from that group');

        // 2) Grouped editor .gr-container-enhanced (exercises isGlobalPopover === false, orderedSections >= 2)
        const editorEnhanced = dom.doc.createElement('div');
        editorEnhanced.className = 'gr-container-enhanced';
        const editorSearch = dom.doc.createElement('input');
        editorSearch.className = 'gr-search-input';
        const editorOptionsHost = dom.doc.createElement('div');
        editorOptionsHost.className = 'gr-options-list';
        for (const [v, t] of [['', '--- Pick to Edit ---'], ['0', '书A'], ['1', '书B'], ['2', '书C']]) {
            const opt = dom.doc.createElement('div');
            opt.className = 'gr-option';
            opt.dataset.value = v;
            opt.textContent = t;
            editorOptionsHost.appendChild(opt);
        }
        editorEnhanced.appendChild(editorSearch);
        editorEnhanced.appendChild(editorOptionsHost);
        dom.doc.body.appendChild(editorEnhanced);

        bodyObserver.cb([{ addedNodes: [editorEnhanced] }]);

        assert.equal(editorEnhanced.dataset.wboPopoverRole, 'editor');
        assert.equal(editorEnhanced.dataset.wboPopoverReady, '1');
        assert.equal(editorEnhanced.querySelector('[data-wbo-dd-group="__pinned__"]'), null, 'editor popover must not hoist separate pinned section');
        const editorSections = editorOptionsHost.querySelectorAll('.wbo-pop-section');
        assert.equal(editorSections.length, 2, 'editor popover should render g1 and ungrouped sections');
        assert.equal(editorSections[0].getAttribute('data-wbo-dd-group'), 'g1');

        // 3) Challenge 2: placeholder-only .gr-container-enhanced preserved when except='editor', unrelated non-world popover closed
        const placeholderEditorEnhanced = dom.doc.createElement('div');
        placeholderEditorEnhanced.className = 'gr-container-enhanced';
        const phOpt = dom.doc.createElement('div');
        phOpt.className = 'gr-option';
        phOpt.dataset.value = '';
        phOpt.textContent = '--- Pick to Edit ---';
        placeholderEditorEnhanced.appendChild(phOpt);
        dom.doc.body.appendChild(placeholderEditorEnhanced);

        const unrelatedEnhanced = dom.doc.createElement('div');
        unrelatedEnhanced.className = 'gr-container-enhanced';
        const unOpt = dom.doc.createElement('div');
        unOpt.className = 'gr-option';
        unOpt.dataset.value = '0';
        unOpt.textContent = '非世界书预设A';
        unrelatedEnhanced.appendChild(unOpt);
        dom.doc.body.appendChild(unrelatedEnhanced);

        nativeMod.closeAllOpenWorldDropdowns({ except: 'editor' });
        assert.equal(placeholderEditorEnhanced.isConnected, true, 'placeholder-only editor popover should be exempted when except="editor"');
        assert.equal(unrelatedEnhanced.isConnected, false, 'unrelated .gr-container-enhanced must still be closed');
    } finally {
        nativeMod.teardownNativeFilters();
        dom.restore();
    }
});

test('R6.1 toggle-closing #wbo-mobile-editor-trigger cleans up window/visualViewport/document listeners and wiDrawerObserver', async () => {
    const dom = installMockNativeFilterDom({ innerWidth: 390, innerHeight: 844 });
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
        const editorSel = dom.doc.createElement('select');
        editorSel.id = 'world_editor_select';
        for (const [val, txt] of [['', '--- Pick to Edit ---'], ['0', '书A'], ['1', '书B']]) {
            const opt = dom.doc.createElement('option');
            opt.value = val;
            opt.textContent = txt;
            editorSel.appendChild(opt);
        }
        worldPopup.appendChild(editorSel);
        wiDrawer.appendChild(multiSel);
        wiDrawer.appendChild(worldPopup);
        dom.doc.body.appendChild(wiDrawer);

        const settings = normalizeSettings({
            groups: [{ id: 'g1', name: '文风', color: '#5b8def', collapsed: false }],
            assignments: { 书A: 'g1' },
            showNativeOptgroups: true,
        });
        const cls = classifyWorldbooks({
            worldNames: ['书A', '书B'],
            bindingMap: new Map(),
            settings,
        });

        nativeMod.applyAllNativeWorldFilters(cls, settings, { force: true });
        nativeMod.startNativeObservers(() => {});
        const trigger = dom.doc.getElementById('wbo-mobile-editor-trigger');
        assert.ok(trigger);

        const basePointerDownCount = (dom.doc.documentElement._listeners.get('pointerdown') || []).length;
        const baseObserverCount = dom.observerInstances.length;

        // First click opens mobile picker
        trigger.dispatchEvent(new dom.MockEvent('click', { bubbles: true, cancelable: true }));
        const overlay = dom.doc.getElementById('wbo-mobile-picker-overlay');
        assert.ok(overlay && overlay.isConnected);
        assert.equal(trigger.classList.contains('is-open'), true);
        assert.equal(dom.winListeners.get('resize')?.size || 0, 1);
        assert.equal(dom.winListeners.get('orientationchange')?.size || 0, 1);
        assert.equal(dom.vvListeners.get('resize')?.size || 0, 1);
        assert.equal(dom.vvListeners.get('scroll')?.size || 0, 1);
        assert.equal((dom.doc.documentElement._listeners.get('pointerdown') || []).length, basePointerDownCount + 1);
        const wiObs = dom.observerInstances[baseObserverCount];
        assert.equal(wiObs?.target, wiDrawer);

        // Second click toggle-closes via _closeMobileEditorPicker
        trigger.dispatchEvent(new dom.MockEvent('click', { bubbles: true, cancelable: true }));
        assert.equal(overlay.isConnected, false, 'toggle click must remove overlay');
        assert.equal(trigger.classList.contains('is-open'), false, 'toggle click must clear is-open');
        assert.equal(dom.winListeners.get('resize')?.size || 0, 0, 'window resize listener must be removed on toggle close');
        assert.equal(dom.winListeners.get('orientationchange')?.size || 0, 0, 'window orientationchange listener must be removed on toggle close');
        assert.equal(dom.vvListeners.get('resize')?.size || 0, 0, 'visualViewport resize listener must be removed on toggle close');
        assert.equal(dom.vvListeners.get('scroll')?.size || 0, 0, 'visualViewport scroll listener must be removed on toggle close');
        assert.equal((dom.doc.documentElement._listeners.get('pointerdown') || []).length, basePointerDownCount, 'document pointerdown listener must be removed on toggle close');
        assert.equal(wiObs?.target, null, 'wiDrawerObserver must be disconnected on toggle close');
    } finally {
        nativeMod.teardownNativeFilters();
        dom.restore();
    }
});

test('R6.2 .wbo-mp-backdrop pointerdown over trigger rect suppresses trailing click reopen on both #wbo-mobile-editor-trigger and .wbo-popup-select-trigger', async () => {
    const dom = installMockNativeFilterDom({ innerWidth: 390, innerHeight: 844 });
    const nativeMod = await import('../src/native-filter.js');
    try {
        // 1. Setup #wbo-mobile-editor-trigger
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
        for (const [val, txt] of [['', '--- Pick to Edit ---'], ['0', '书A'], ['1', '书B']]) {
            const opt = dom.doc.createElement('option');
            opt.value = val;
            opt.textContent = txt;
            editorSel.appendChild(opt);
        }
        worldPopup.appendChild(editorSel);
        wiDrawer.appendChild(multiSel);
        wiDrawer.appendChild(worldPopup);
        dom.doc.body.appendChild(wiDrawer);

        // 2. Setup <dialog> with .persona_world_info_selector for attachGroupedSelectControl
        const dialog = dom.doc.createElement('dialog');
        const personaPopup = dom.doc.createElement('div');
        personaPopup.className = 'persona_world';
        const personaSel = dom.doc.createElement('select');
        personaSel.className = 'persona_world_info_selector';
        for (const [val, txt] of [['', '--- None ---'], ['0', '书A'], ['1', '书B']]) {
            const opt = dom.doc.createElement('option');
            opt.value = val;
            opt.textContent = txt;
            personaSel.appendChild(opt);
        }
        personaPopup.appendChild(personaSel);
        dialog.appendChild(personaPopup);
        dom.doc.body.appendChild(dialog);

        const settings = normalizeSettings({
            groups: [{ id: 'g1', name: '文风', color: '#5b8def', collapsed: false }],
            assignments: { 书A: 'g1' },
            showNativeOptgroups: true,
            adaptPersonaBindPopup: true,
        });
        const cls = classifyWorldbooks({
            worldNames: ['书A', '书B'],
            bindingMap: new Map(),
            settings,
        });

        nativeMod.applyAllNativeWorldFilters(cls, settings, { force: true });
        nativeMod.startNativeObservers(() => {});

        const bodyObserver = dom.observerInstances.find((o) => o.target === dom.doc.body);
        assert.ok(bodyObserver);
        bodyObserver.cb([{ addedNodes: [dialog] }]);

        // --- Part A: #wbo-mobile-editor-trigger ---
        const editorTrigger = dom.doc.getElementById('wbo-mobile-editor-trigger');
        assert.ok(editorTrigger);
        editorTrigger._rect = { left: 20, top: 120, right: 260, bottom: 156, width: 240, height: 36 };

        // Tap #1: opens picker
        editorTrigger.dispatchEvent(new dom.MockEvent('click', { bubbles: true, cancelable: true }));
        let editorOverlay = dom.doc.getElementById('wbo-mobile-picker-overlay');
        assert.ok(editorOverlay && editorOverlay.isConnected, 'Tap #1 should open #wbo-mobile-picker-overlay');
        assert.equal(editorTrigger.classList.contains('is-open'), true);

        // Tap #2: real-browser hit-testing sends pointerdown onto .wbo-mp-backdrop inside trigger rect,
        // which removes overlay, then synthesized click lands on uncovered triggerEl underneath.
        editorOverlay.dispatchEvent(new dom.MockEvent('pointerdown', {
            bubbles: true,
            cancelable: true,
            clientX: 100,
            clientY: 138,
        }));
        assert.equal(editorOverlay.isConnected, false, 'pointerdown on backdrop must remove #wbo-mobile-picker-overlay');
        editorTrigger.dispatchEvent(new dom.MockEvent('click', {
            bubbles: true,
            cancelable: true,
            clientX: 100,
            clientY: 138,
        }));
        assert.equal(dom.doc.getElementById('wbo-mobile-picker-overlay'), null, 'trailing click after backdrop pointerdown over trigger must NOT reopen #wbo-mobile-picker-overlay');
        assert.equal(editorTrigger.classList.contains('is-open'), false, 'editor trigger must stay closed (is-open: false)');
        assert.equal(editorTrigger.dataset.wboDismissedTapAt, undefined, 'dismiss stamp must be consumed and deleted');

        // Tap #3 (immediate): opens cleanly again
        editorTrigger.dispatchEvent(new dom.MockEvent('click', { bubbles: true, cancelable: true }));
        editorOverlay = dom.doc.getElementById('wbo-mobile-picker-overlay');
        assert.ok(editorOverlay && editorOverlay.isConnected, 'Tap #3 must reopen #wbo-mobile-picker-overlay cleanly');
        assert.equal(editorTrigger.classList.contains('is-open'), true);

        // Dismiss outside trigger rect leaves no stamp and allows immediate next click on trigger
        editorOverlay.dispatchEvent(new dom.MockEvent('pointerdown', {
            bubbles: true,
            cancelable: true,
            clientX: 5,
            clientY: 5,
        }));
        assert.equal(editorOverlay.isConnected, false);
        assert.equal(editorTrigger.dataset.wboDismissedTapAt, undefined);
        editorTrigger.dispatchEvent(new dom.MockEvent('click', { bubbles: true, cancelable: true }));
        assert.ok(dom.doc.getElementById('wbo-mobile-picker-overlay')?.isConnected, 'clicking trigger after outside-rect dismiss must open immediately');
        // Clean close before Part B
        editorTrigger.dispatchEvent(new dom.MockEvent('click', { bubbles: true, cancelable: true }));
        assert.equal(dom.doc.getElementById('wbo-mobile-picker-overlay'), null);

        // --- Part B: attachGroupedSelectControl .wbo-popup-select-trigger ---
        const popTrigger = personaPopup.querySelector('.wbo-popup-select-trigger');
        assert.ok(popTrigger);
        popTrigger._rect = { left: 40, top: 200, right: 280, bottom: 236, width: 240, height: 36 };

        // Tap #1: opens grouped popup popover
        popTrigger.dispatchEvent(new dom.MockEvent('click', { bubbles: true, cancelable: true }));
        let popOverlay = dialog.querySelector('.wbo-mp-backdrop');
        assert.ok(popOverlay && popOverlay.isConnected, 'Tap #1 should open .wbo-mp-backdrop inside dialog');
        assert.equal(popTrigger.classList.contains('is-open'), true);

        // Tap #2: pointerdown on .wbo-mp-backdrop over trigger rect -> click on trigger
        popOverlay.dispatchEvent(new dom.MockEvent('pointerdown', {
            bubbles: true,
            cancelable: true,
            clientX: 150,
            clientY: 218,
        }));
        assert.equal(popOverlay.isConnected, false, 'pointerdown on backdrop must remove popup .wbo-mp-backdrop');
        popTrigger.dispatchEvent(new dom.MockEvent('click', {
            bubbles: true,
            cancelable: true,
            clientX: 150,
            clientY: 218,
        }));
        assert.equal(dialog.querySelector('.wbo-mp-backdrop'), null, 'trailing click after backdrop pointerdown over popup trigger must NOT reopen popover');
        assert.equal(popTrigger.classList.contains('is-open'), false, 'popup trigger must stay closed (is-open: false)');
        assert.equal(popTrigger.dataset.wboDismissedTapAt, undefined, 'popup dismiss stamp must be consumed and deleted');

        // Tap #3 (immediate): opens cleanly again
        popTrigger.dispatchEvent(new dom.MockEvent('click', { bubbles: true, cancelable: true }));
        popOverlay = dialog.querySelector('.wbo-mp-backdrop');
        assert.ok(popOverlay && popOverlay.isConnected, 'Tap #3 must reopen popup .wbo-mp-backdrop cleanly');
        assert.equal(popTrigger.classList.contains('is-open'), true);
    } finally {
        nativeMod.teardownNativeFilters();
        dom.restore();
    }
});
