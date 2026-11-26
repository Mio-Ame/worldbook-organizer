import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import util from 'node:util';

function getPanelSourcePaths() {
    const panelSources = readdirSync(new URL('../src/', import.meta.url))
        .filter((name) => /^panel(?:-[a-z-]+)?\.js$/.test(name))
        .map((name) => `../src/${name}`);
    return [...panelSources, '../src/entry-groups/panel.js'];
}

function readPanelSource() {
    return getPanelSourcePaths()
        .map((file) => readFileSync(new URL(file, import.meta.url), 'utf8'))
        .join('\n');
}

import {
    AI_ORGANIZE_CATEGORY_PRESETS,
    AI_ORGANIZE_NAMING_PRESETS,
    DEFAULT_LOCAL_ORGANIZE_CATEGORY_IDS,
    DEFAULT_SETTINGS,
    GROUP_COLOR_PALETTE,
    LOCAL_ORGANIZE_CATEGORIES,
    MODULE_NAME,
    SECTION_ORDER_VERSION,
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
    computeReorderedEntries,
    computeScanPromptState,
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
    findUnboundCharacterNameMatches,
    findUnscannedShallowCharacters,
    formatCharacterDisplayTitle,
    getEffectiveAiOrganizePresets,
    getVisibleSectionMoveBounds,
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
    normalizeMatchName,
    normalizeSettings,
    orderSectionsForExternalDropdown,
    parseAiOrganizeResponse,
    parseOptionalFiniteNumber,
    partitionGroupPickerBooks,
    promoteSectionToTop,
    pruneStaleWorldbookSettings,
    pushUndoSnapshot,
    reorderBookInGroup,
    reorderEntryUids,
    reorderSection,
    resetAiOrganizePresets,
    restoreOrganizeSnapshot,
    searchEntriesInPayload,
    sortEntryListItems,
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

test('addCustomGroup preserves creation order (char -> ungrouped -> g1 -> g2) and reorderSection drags cleanly', () => {
    const settings = normalizeSettings(null);
    assert.equal(settings.sectionOrderVersion, SECTION_ORDER_VERSION);
    assert.deepEqual(settings.sectionOrder, [SPECIAL_GROUPS.CHARACTER, SPECIAL_GROUPS.UNGROUPED]);

    const g1 = addCustomGroup(settings, { name: '文风设定' });
    const g2 = addCustomGroup(settings, { name: '世界观' });
    const g3 = addCustomGroup(settings, { name: '系统规则' });
    assert.deepEqual(settings.sectionOrder, [SPECIAL_GROUPS.CHARACTER, SPECIAL_GROUPS.UNGROUPED, g1.id, g2.id, g3.id]);

    assert.equal(moveSectionOrder(settings, SPECIAL_GROUPS.CHARACTER, 1), true);
    assert.deepEqual(settings.sectionOrder, [SPECIAL_GROUPS.UNGROUPED, SPECIAL_GROUPS.CHARACTER, g1.id, g2.id, g3.id]);
    assert.equal(moveSectionOrder(settings, SPECIAL_GROUPS.UNGROUPED, -1), false);

    // Drag g3 before g1
    assert.equal(reorderSection(settings, g3.id, g1.id, 'before'), true);
    assert.deepEqual(settings.sectionOrder, [SPECIAL_GROUPS.UNGROUPED, SPECIAL_GROUPS.CHARACTER, g3.id, g1.id, g2.id]);
    assert.deepEqual(settings.groups.map((g) => g.id), [g3.id, g1.id, g2.id]);

    // Promote character group to first when enabled
    promoteSectionToTop(settings, SPECIAL_GROUPS.CHARACTER);
    assert.equal(settings.sectionOrder[0], SPECIAL_GROUPS.CHARACTER);

    // Legacy v1/v2 defaults auto-migrate to v3 [__char__, __ungrouped__, ...custom]
    const migratedV1 = normalizeSettings({
        sectionOrder: [SPECIAL_GROUPS.CHARACTER, SPECIAL_GROUPS.UNGROUPED],
    });
    assert.equal(migratedV1.sectionOrderVersion, 3);
    assert.deepEqual(migratedV1.sectionOrder, [SPECIAL_GROUPS.CHARACTER, SPECIAL_GROUPS.UNGROUPED]);

    const migratedV2 = normalizeSettings({
        sectionOrderVersion: 2,
        groups: [{ id: 'g1', name: '文风' }, { id: 'g2', name: '世界观' }],
        sectionOrder: ['g1', 'g2', SPECIAL_GROUPS.UNGROUPED, SPECIAL_GROUPS.CHARACTER],
    });
    assert.equal(migratedV2.sectionOrderVersion, 3);
    assert.deepEqual(migratedV2.sectionOrder, [SPECIAL_GROUPS.CHARACTER, SPECIAL_GROUPS.UNGROUPED, 'g1', 'g2']);

    // Explicit v3 user reorder is preserved
    const kept = normalizeSettings({
        sectionOrderVersion: 3,
        groups: [{ id: 'g1', name: '文风' }],
        sectionOrder: ['g1', SPECIAL_GROUPS.UNGROUPED, SPECIAL_GROUPS.CHARACTER],
    });
    assert.deepEqual(kept.sectionOrder, ['g1', SPECIAL_GROUPS.UNGROUPED, SPECIAL_GROUPS.CHARACTER]);
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
        const panel = await import('../src/panel.js');
        assert.deepEqual(Object.keys(panel), [
            'bindPanelCallbacks',
            'invalidatePreviewCache',
            'openManagerModal',
            'renderEmbeddedPanel',
            'syncEmbeddedPanelIndicators',
            'syncNativeQuickActionsUi',
            'teardownPanels',
        ]);
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
    assert.deepEqual(normalized.sectionOrder, [SPECIAL_GROUPS.CHARACTER, SPECIAL_GROUPS.UNGROUPED, 'g_new']);

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
    assert.doesNotMatch(cssSrc, /\.wbo-book-more-btn\s*\{[^}]*display:\s*none/i);

    const forbiddenThirdPartyRe = /(?:baibai|st-baibai-tools|柏宝箱)/i;
    for (const relPath of ['../style.css', '../index.js', '../README.md', '../NEXT.md', '../src/core.js', '../src/host.js', ...getPanelSourcePaths(), '../src/entry-accordion.js', '../src/native-filter.js']) {
        const txt = readFileSync(new URL(relPath, import.meta.url), 'utf8');
        assert.equal(forbiddenThirdPartyRe.test(txt), false, `Forbidden third-party reference found in ${relPath}`);
    }

    for (const relPath of [...getPanelSourcePaths(), '../src/entry-accordion.js', '../src/native-filter.js']) {
        const jsSrc = readFileSync(new URL(relPath, import.meta.url), 'utf8');
        const noBlockComments = jsSrc.replace(/\/\*[\s\S]*?\*\//g, '');
        const tags = noBlockComments.match(/<(?:textarea|input)\b(?:\$\{[^}]*\}|[^>])*>/gi) || [];
        for (const tag of tags) {
            if (/^<input\b/i.test(tag) && /\btype=["'](?:checkbox|radio|file|number|range|hidden|button|submit|reset)["']/i.test(tag)) {
                continue;
            }
            assert.match(tag, /spellcheck=["']false["']/i, `Missing spellcheck="false" in ${relPath}: ${tag}`);
        }
    }

    for (const relPath of [...getPanelSourcePaths(), '../src/entry-accordion.js']) {
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
        HTMLTextAreaElement: globalThis.HTMLTextAreaElement,
        HTMLButtonElement: globalThis.HTMLButtonElement,
        HTMLSelectElement: globalThis.HTMLSelectElement,
        HTMLOptionElement: globalThis.HTMLOptionElement,
        HTMLOptGroupElement: globalThis.HTMLOptGroupElement,
        Event: globalThis.Event,
        PointerEvent: globalThis.PointerEvent,
        CustomEvent: globalThis.CustomEvent,
        KeyboardEvent: globalThis.KeyboardEvent,
        confirm: globalThis.confirm,
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
            this.pointerId = init.pointerId ?? 1;
            this.pointerType = init.pointerType ?? 'mouse';
            this.button = init.button ?? 0;
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
            Object.defineProperty(this, '_el', {
                value: el,
                writable: true,
                configurable: true,
                enumerable: false,
            });
            this._set = new Set();
        }
        [util.inspect.custom]() {
            return `MockClassList(${[...this._set].join(' ')})`;
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
        let requireChecked = false;
        if (clean.includes(':checked')) {
            requireChecked = true;
            clean = clean.replace(/:checked/g, '');
        }
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
        if (requireChecked) {
            if (el.tagName === 'OPTION') {
                if (!el.selected) return false;
            } else if (!el.checked) {
                return false;
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
            Object.defineProperty(this, 'parentNode', {
                value: null,
                writable: true,
                configurable: true,
                enumerable: false,
            });
            this._textContent = textContent;
        }
        [util.inspect.custom]() {
            return `MockNode(type=${this.nodeType})`;
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
            this.style = {
                setProperty(k, v) { this[k] = String(v ?? ''); },
                removeProperty(k) { delete this[k]; },
                getPropertyValue(k) { return this[k] ?? ''; },
            };
            this._listeners = new Map();
            this._rect = { left: 10, top: 100, right: 250, bottom: 136, width: 240, height: 36 };
            this.scrollTop = 0;
            this.scrollLeft = 0;
            this.scrollWidth = 200;
            this.clientWidth = 200;
            this.scrollHeight = 200;
            this.clientHeight = 200;
            this.disabled = false;
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
        get hidden() {
            return this._attrs.has('hidden');
        }
        set hidden(v) {
            if (v) this._attrs.set('hidden', '');
            else this._attrs.delete('hidden');
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
        get previousElementSibling() {
            if (!this.parentNode) return null;
            const siblings = this.parentNode.children || [];
            const idx = siblings.indexOf(this);
            return idx > 0 ? siblings[idx - 1] : null;
        }
        get nextElementSibling() {
            if (!this.parentNode) return null;
            const siblings = this.parentNode.children || [];
            const idx = siblings.indexOf(this);
            return idx >= 0 && idx < siblings.length - 1 ? siblings[idx + 1] : null;
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
            if (name === 'hidden') this._attrs.set('hidden', '');
            if (name === 'disabled') this.disabled = true;
            if (name === 'checked') this.checked = true;
            if (name === 'selected') this.selected = true;
            if (name === 'value' && ('value' in this)) this.value = val;
        }
        removeAttribute(name) {
            this._attrs.delete(name);
            if (name === 'class') this.classList._syncFromString('');
            if (name === 'disabled') this.disabled = false;
            if (name === 'checked') this.checked = false;
            if (name === 'selected') this.selected = false;
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
        click() {
            this.dispatchEvent(new MockEvent('click', { bubbles: true, cancelable: true }));
        }
        scrollIntoView() {}
        setPointerCapture() {}
        releasePointerCapture() {}
    }

    class MockInputElement extends MockElement {
        constructor() {
            super('input');
            this.value = '';
            this.checked = false;
        }
        get type() {
            return this._attrs.get('type') || 'text';
        }
        set type(v) {
            this._attrs.set('type', String(v ?? 'text'));
        }
    }
    class MockTextAreaElement extends MockElement {
        constructor() {
            super('textarea');
            this.value = '';
            this.selectionStart = 0;
            this.selectionEnd = 0;
        }
    }
    class MockButtonElement extends MockElement {
        constructor() {
            super('button');
        }
        get type() {
            return this._attrs.get('type') || 'submit';
        }
        set type(v) {
            this._attrs.set('type', String(v ?? 'button'));
        }
    }
    class MockOptionElement extends MockElement {
        constructor() {
            super('option');
            this._selected = false;
        }
        get selected() {
            return this._selected;
        }
        set selected(v) {
            const next = Boolean(v);
            this._selected = next;
            if (next) {
                const sel = this.closest?.('select');
                if (sel && !sel.multiple) {
                    for (const o of sel.options) {
                        if (o !== this) o._selected = false;
                    }
                }
            }
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
            if (t === 'textarea') return new MockTextAreaElement();
            if (t === 'button') return new MockButtonElement();
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
    globalThis.HTMLTextAreaElement = MockTextAreaElement;
    globalThis.HTMLButtonElement = MockButtonElement;
    globalThis.HTMLSelectElement = MockSelectElement;
    globalThis.HTMLOptionElement = MockOptionElement;
    globalThis.HTMLOptGroupElement = MockOptGroupElement;
    globalThis.Event = MockEvent;
    globalThis.PointerEvent = MockEvent;
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
        assert.match(globalSections[0].querySelector('.wbo-dd-group-head')?.textContent || '', /收藏 \(1\)/);
        const globalFilterBar = globalEnhanced.querySelector('.wbo-pop-filter-bar');
        assert.ok(globalFilterBar, 'global popover should receive .wbo-pop-filter-bar');
        assert.equal(globalFilterBar.querySelector('[data-wbo-pill="__pinned__"]')?.getAttribute('aria-pressed'), 'true');
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
        assert.equal(unrelatedEnhanced.isConnected, true, 'non-worldbook .gr-container-enhanced must be preserved untouched');
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

test('narrow worldbook preview keeps the summary, sort picker and binding action readable', () => {
    const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
    assert.match(css, /\.wbo-acc-summary\s*\{[^}]*white-space:\s*nowrap/s);
    assert.match(css, /\.wbo-preview-head\s*\{[^}]*flex-wrap:\s*wrap/s);
    assert.match(css, /@container\s+plugin-win\s*\(max-width:\s*600px\)[\s\S]*?\.wbo-book-preview\s+\.wbo-preview-head-actions\s*>\s*:not\(\.wbo-acc-sort-control\)\s*\{\s*display:\s*none\s*!important;/);
    assert.match(css, /@media\s*\(max-width:\s*680px\)[\s\S]*?\.wbo-book-preview\s+\.wbo-preview-head-actions\s*>\s*:not\(\.wbo-acc-sort-control\)\s*\{\s*display:\s*none\s*!important;/);
});

test('v2.35.1 polish: deleteWorldbookEntryDirect, gr-option pin stars across flat/grouped/re-rendered popovers, no duplicate scan status, and standard undo SVG', async () => {
    const panelSrc = readPanelSource();
    const accSrc = readFileSync(new URL('../src/entry-accordion.js', import.meta.url), 'utf8');
    const cssSrc = readFileSync(new URL('../style.css', import.meta.url), 'utf8');

    // 1. Zero ugly Unicode undo/redo arrows anywhere in panel.js or entry-accordion.js
    assert.ok(!panelSrc.includes('↶') && !panelSrc.includes('↷'), 'panel.js must not use ugly Unicode undo arrows');
    assert.ok(!accSrc.includes('↶') && !accSrc.includes('↷'), 'entry-accordion.js must not use ugly Unicode undo arrows');

    // 2. Scan modal has ONLY ONE #wbo-scan-status and zero #wbo-scan-top-status duplicate ID
    assert.ok(!panelSrc.includes('id="wbo-scan-top-status"'), 'duplicate scan status box removed');
    assert.equal((panelSrc.match(/id="wbo-scan-status"/g) || []).length, 1, 'exactly one scan status element');

    // 3. A legacy settings record alone must not be used as an install marker.
    const legacySrc = readFileSync(new URL('../src/entry-groups/legacy.js', import.meta.url), 'utf8');
    assert.ok(legacySrc.includes('disabledExtensions'));
    assert.ok(!panelSrc.includes('ctx?.extensionSettings?.worldbook_entry_groups !== undefined'));

    // 4. Tall mode never calls scrollIntoView on contentArea, and find nav wraps prev+next together
    assert.ok(!accSrc.includes('contentArea.scrollIntoView'), 'tall mode must keep scroll position stationary');
    assert.ok(accSrc.includes('class="wbo-acc-find-nav"'), 'find prev/next grouped in indivisible nav container');
    assert.ok(accSrc.includes('data-acc-ta-backdrop'), 'live in-textarea keyword highlight backdrop present');
    assert.ok(accSrc.includes('data-acc-delete'), 'delete entry button present in accordion editor');
    assert.match(cssSrc, /\.wbo-diff-chips\s+\.wbo-tag[\s\S]*?white-space:\s*normal/);

    // 5. Test deleteWorldbookEntryDirect against mocked /api/worldinfo/get + /api/worldinfo/edit
    const prevFetch = globalThis.fetch;
    let savedPayload = null;
    try {
        globalThis.fetch = async (url, init) => {
            const u = String(url);
            if (u.includes('/api/worldinfo/get')) {
                return {
                    ok: true,
                    json: async () => ({
                        entries: {
                            '10': { uid: 10, comment: '保留项', content: 'A' },
                            '20': { uid: 20, comment: '待删项', content: 'B' },
                        },
                    }),
                };
            }
            if (u.includes('/api/worldinfo/edit')) {
                savedPayload = JSON.parse(init.body);
                return { ok: true, json: async () => ({ ok: true }) };
            }
            return { ok: false, status: 404 };
        };
        const hostMod = await import('../src/host.js');
        const delRes = await hostMod.deleteWorldbookEntryDirect('测试世界书', '20');
        assert.equal(delRes.ok, true);
        assert.equal(delRes.uid, '20');
        assert.ok(savedPayload && Object.hasOwn(savedPayload.data.entries, '10'));
        assert.ok(!Object.hasOwn(savedPayload.data.entries, '20'));
    } finally {
        globalThis.fetch = prevFetch;
    }
});

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

        const bodyObserver = dom.observerInstances.find((o) => o.target === dom.doc.body);
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
        const bodyObserver = dom.observerInstances.find((o) => o.target === dom.doc.body);
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
            ['g1', 'g2', SPECIAL_GROUPS.UNGROUPED],
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
        const bodyObserver = dom.observerInstances.find((o) => o.target === dom.doc.body);
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
        const bodyObserver = dom.observerInstances.find((o) => o.target === dom.doc.body);
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

test('M3 R2, R3 & R5 panel.js: 3-button+gear header, visibility-skipping moves, 全部 pinned hoisting, bare 当前编辑, scan prompt + 1-click assign, floating settings & Quick Hub split isolation', async () => {
    const dom = installMockNativeFilterDom({ innerWidth: 1280, innerHeight: 800 });
    const prevConfirm = globalThis.confirm;
    const prevSetTimeout = globalThis.setTimeout;
    const panelMod = await import('../src/panel.js');

    const settings = normalizeSettings({
        showCharBooks: false,
        activeFilterGroupId: SPECIAL_GROUPS.DEFAULT,
        autoScanNewCharacters: true,
        globalPresets: [{ id: 'gp1', name: '常用套', books: ['通用书'] }],
        pinnedBooks: ['通用书'],
    });
    const grpA = addCustomGroup(settings, { name: '设定组A' });
    const grpB = addCustomGroup(settings, { name: '设定组B' });
    settings.assignments['通用书'] = grpA.id;

    const characters = [
        { name: '同名角色甲', avatar: 'han.png', shallow: false, data: { name: '同名角色甲', extensions: {} } },
        { name: '角色乙', avatar: 'lu.png', shallow: false, data: { name: '角色乙', extensions: { world: '角色乙主世界书' } } },
    ];
    const worldNames = ['角色乙主世界书', '同名角色甲', '通用书', '未分组书'];
    let currentEditorName = '角色乙主世界书';
    const mutationCalls = [];

    const wiDrawer = dom.doc.createElement('div');
    wiDrawer.id = 'WorldInfo';
    const wiHeader = dom.doc.createElement('div');
    wiHeader.className = 'flex-container';
    const pinDiv = dom.doc.createElement('div');
    pinDiv.id = 'WI_panel_pin_div';
    wiHeader.appendChild(pinDiv);
    wiDrawer.appendChild(wiHeader);
    dom.doc.body.appendChild(wiDrawer);

    const editorSelect = dom.doc.createElement('select');
    editorSelect.id = 'world_editor_select';
    for (const [idx, n] of worldNames.entries()) {
        const opt = dom.doc.createElement('option');
        opt.value = String(idx);
        opt.textContent = n;
        if (n === currentEditorName) opt.selected = true;
        editorSelect.appendChild(opt);
    }
    const worldInfoSelect = dom.doc.createElement('select');
    worldInfoSelect.id = 'world_info';
    worldInfoSelect.multiple = true;
    for (const [idx, n] of worldNames.entries()) {
        const opt = dom.doc.createElement('option');
        opt.value = String(idx);
        opt.textContent = n;
        worldInfoSelect.appendChild(opt);
    }
    dom.doc.body.appendChild(editorSelect);
    dom.doc.body.appendChild(worldInfoSelect);

    globalThis.SillyTavern = {
        getContext: () => ({
            characters,
            extensionSettings: {},
            saveSettingsDebounced: () => {},
            getWorldInfoNames: () => [...worldNames],
            world_names: [...worldNames],
        }),
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
            onMutation: async (opts = {}) => {
                mutationCalls.push(opts);
                if (opts.uiOnly) {
                    if (opts.quickActionsOnly) panelMod.syncNativeQuickActionsUi();
                    return;
                }
                state = recomputeState();
                panelMod.renderEmbeddedPanel();
            },
            onRescan: async () => {
                state = recomputeState();
                panelMod.renderEmbeddedPanel();
            },
        });

        panelMod.openManagerModal();

        // 1. Follow-up 15:18Z 3-button header [整理, 组合, 扫描] + gear icon in header-actions + no #wbo-mgr-combo-bar
        const headerTools = [...dom.doc.querySelectorAll('#wbo-manager-overlay .wbo-mgr-header-tools > .wbo-tool-btn')]
            .map((b) => b.textContent.trim().replace(/\s+/g, ' '));
        assert.deepEqual(headerTools, ['整理', '组合 1', '扫描']);
        assert.ok(dom.doc.querySelector('#wbo-manager-overlay .wbo-modal-header-actions .wbo-modal-settings-btn'), 'gear icon in header actions');
        assert.equal(dom.doc.getElementById('wbo-mgr-combo-bar'), null, 'bulky combo bar removed from main panel body');

        // 2. R1/R4 clean drag hint + R3 scan prompt + no dark .is-active on scan btn
        const dragHint = dom.doc.querySelector('#wbo-manager-overlay .wbo-mgr-drag-hint');
        assert.ok(dragHint && !dragHint.textContent.includes('展开态亦可') && !dragHint.textContent.includes('提示：'));
        const scanBtn = dom.doc.getElementById('wbo-mgr-scan-btn');
        assert.ok(scanBtn && !scanBtn.classList.contains('is-active'), 'scan btn must not have heavy dark .is-active border');
        const scanPrompt = dom.doc.getElementById('wbo-mgr-scan-prompt');
        assert.ok(scanPrompt && !scanPrompt.hidden && scanPrompt.textContent.includes('同名'), '1-line prompt shown for unbound same-name book 同名角色甲');

        // 3. R2 bare 当前编辑 when editing hidden char book outside showCharBooks
        const bareEditing = dom.doc.querySelector('#wbo-manager-overlay .wbo-mgr-bare-editing');
        assert.ok(bareEditing, 'hidden edited char book renders bare at top');
        assert.equal(bareEditing.querySelector('.wbo-book-row')?.getAttribute('data-book'), '角色乙主世界书');
        assert.ok(bareEditing.querySelector('.wbo-s2-badge.is-editing'), 'bare 当前编辑 carries inline badge');
        assert.equal(dom.doc.querySelector(`#wbo-manager-overlay .wbo-group[data-group-id="${SPECIAL_GROUPS.CHARACTER}"]`), null, 'no 角色世界书 (1) wrapper');

        // 4. R2 visibility-skipping section move arrows: when showCharBooks=false, UNGROUPED is visible #1 (canMoveUp=false!)
        const visibleGroups = dom.doc.querySelectorAll('#wbo-mgr-groups-list .wbo-group[data-group-id]');
        assert.deepEqual(visibleGroups.map((g) => g.getAttribute('data-group-id')), [SPECIAL_GROUPS.UNGROUPED, grpA.id, grpB.id]);
        const ungroupedUpBtn = visibleGroups[0].querySelector('[data-action="move-section-up"]');
        const ungroupedDownBtn = visibleGroups[0].querySelector('[data-action="move-section-down"]');
        assert.equal(ungroupedUpBtn.disabled, true, 'first visible section UNGROUPED must have disabled up arrow even though hidden __char__ precedes it');
        assert.equal(ungroupedDownBtn.disabled, false);

        // Single click on UNGROUPED down arrow skips nothing visible and swaps directly past hidden sections with grpA
        ungroupedDownBtn.click();
        await new Promise((r) => prevSetTimeout(r, 5));
        assert.deepEqual(
            dom.doc.querySelectorAll('#wbo-mgr-groups-list .wbo-group[data-group-id]').map((g) => g.getAttribute('data-group-id')),
            [grpA.id, SPECIAL_GROUPS.UNGROUPED, grpB.id],
        );

        // 5. R2 全部 view hoists 角色世界书 #1 and ★ 已置顶 #2 (both non-movable)
        settings.showCharBooks = true;
        promoteSectionToTop(settings, SPECIAL_GROUPS.CHARACTER);
        state = recomputeState();
        panelMod.renderEmbeddedPanel();
        const allViewIds = dom.doc.querySelectorAll('#wbo-mgr-groups-list .wbo-group[data-group-id]').map((g) => g.getAttribute('data-group-id'));
        assert.deepEqual(allViewIds.slice(0, 2), [SPECIAL_GROUPS.CHARACTER, SPECIAL_GROUPS.PINNED]);
        assert.equal(dom.doc.querySelector(`#wbo-mgr-groups-list .wbo-group[data-group-id="${SPECIAL_GROUPS.PINNED}"] [data-action="move-section-up"]`), null);

        // 6. R3 Scan modal surfaces 同名角色甲 + 1-click 归入角色世界书 clears prompt & blurs scanBtn
        scanBtn.focus();
        scanBtn.click();
        const assignCharBtn = dom.doc.querySelector('[data-cov-assign-char="同名角色甲"]');
        assert.ok(assignCharBtn, 'Scan modal must surface unbound same-name book 同名角色甲 with 1-click assign');
        assignCharBtn.click();
        await new Promise((r) => prevSetTimeout(r, 10));
        assert.equal(settings.charBookOverrides['同名角色甲'], 'include_in_char');
        assert.equal(dom.doc.getElementById('wbo-mgr-scan-prompt').hidden, true, 'prompt hides once same-name book is classified');
        dom.doc.querySelector('#wbo-scan-close-btn')?.click();
        assert.notEqual(dom.doc.activeElement, scanBtn, 'closing scan modal blurs #wbo-mgr-scan-btn');

        // 7. R3 移动到分组 includes 角色世界书 and R4 footer has no .wbo-spacer inside .wbo-footer-pair
        dom.doc.querySelector('#wbo-mgr-groups-list .wbo-book-row[data-book="未分组书"] [data-action="book-more-menu"]').click();
        const moveBtn = dom.doc.querySelector('.wbo-book-more-popover [data-more-act="move-group"]');
        assert.ok(moveBtn);
        moveBtn.click();
        const moveCharOpt = dom.doc.querySelector(`.wbo-move-option[data-target-group="${SPECIAL_GROUPS.CHARACTER}"]`);
        assert.ok(moveCharOpt, '移动到分组 includes 角色世界书 for unbound books');
        const moveFooter = dom.doc.querySelector('#wbo-submodal-overlay .wbo-modal-footer.wbo-footer-pair');
        assert.equal(moveFooter.querySelector('.wbo-spacer'), null, 'footer-pair must not contain .wbo-spacer');
        moveCharOpt.click();
        await new Promise((r) => prevSetTimeout(r, 5));
        assert.equal(settings.charBookOverrides['未分组书'], 'include_in_char');

        // 8. R5 Non-blocking Settings + quickActionsOnly topbar stability
        dom.doc.querySelector('#wbo-manager-overlay [data-action="open-settings-modal"]').click();
        const settingsOverlay = dom.doc.getElementById('wbo-submodal-overlay');
        assert.ok(settingsOverlay.classList.contains('wbo-floating-overlay'), 'Settings overlay must be non-blocking floating');
        assert.ok(settingsOverlay.querySelector('input[data-setting="syncEntryOrderOnDrag"]'), 'Settings exposes syncEntryOrderOnDrag');
        const beforeMutLen = mutationCalls.length;
        settingsOverlay.querySelector('[data-quick-actions-mode="split"]').click();
        await new Promise((r) => prevSetTimeout(r, 5));
        assert.equal(mutationCalls[beforeMutLen]?.uiOnly, true);
        assert.equal(mutationCalls[beforeMutLen]?.quickActionsOnly, true);
        dom.doc.querySelector('#wbo-settings-close-btn')?.click();

        // 9. R5 Quick Hub split-mode isolation + direct combo delete
        const cbBtn = dom.doc.getElementById('wbo-wi-combo-btn');
        assert.ok(cbBtn);
        cbBtn.click();
        const qhubPop = dom.doc.querySelector('.wbo-qhub-popover');
        assert.ok(qhubPop, 'Quick Hub opens in split mode');
        assert.equal(qhubPop.querySelector('.wbo-qhub-tabs'), null, 'split mode hides cross-tab bar');
        assert.equal(qhubPop.querySelector('.wbo-qe-foot'), null, 'split mode omits 分组管理/搜条目 footer');
        const delComboBtn = qhubPop.querySelector('[data-qhub-delete="gp1"]');
        assert.ok(delComboBtn, 'Quick Hub renders direct combo delete button');
        delComboBtn.click();
        await new Promise((r) => prevSetTimeout(r, 5));
        assert.equal(settings.globalPresets.length, 0, 'direct delete removes global combo');
    } finally {
        panelMod.teardownPanels();
        globalThis.confirm = prevConfirm;
        dom.restore();
    }
});

test('M3 R4 & R5 static CSS guardrails: switch capsule !important, footer alignment, floating overlay, and 3-button header grid', () => {
    const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
    const panelSrc = readPanelSource();

    // Switch capsule isolation
    assert.match(css, /\.wbo-tool-switch\s*>\s*input,\s*\r?\n\.wbo-modal\s+\.wbo-tool-switch\s*>\s*input\[type="checkbox"\]\s*\{[\s\S]*?position:\s*absolute\s*!important;[\s\S]*?width:\s*1px\s*!important;/);
    assert.match(css, /:not\(\.wbo-show-char-checkbox\):not\(\.wbo-acc-toggle-enable\)/);
    assert.match(css, /\.wbo-eb-switch\s*\{[\s\S]*?padding:\s*0\s+6px\s*!important;/);

    // Floating submodal pass-through & 3-button header grid
    assert.match(css, /\.wbo-submodal-overlay\.wbo-floating-overlay\s*\{\s*pointer-events:\s*none;\s*\}/);
    assert.match(css, /@media\s*\(max-width:\s*680px\)[\s\S]*?\.wbo-mgr-header-tools\s*\{[\s\S]*?grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\);/);
    assert.match(css, /@container\s+plugin-win\s*\(max-width:\s*600px\)[\s\S]*?\.wbo-mgr-header-tools\s*\{[\s\S]*?grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\);/);

    // Modal footer fixes
    assert.match(css, /@container\s+plugin-win\s*\(max-width:\s*600px\)[\s\S]*?\.wbo-ai-footer\.wbo-ai-footer-single\s*\{[\s\S]*?flex-direction:\s*row;/);
    assert.match(css, /@container\s+plugin-win\s*\(max-width:\s*600px\)[\s\S]*?\.wbo-modal-footer\.wbo-footer-pair\s*>\s*\.wbo-spacer\s*\{\s*display:\s*none\s*!important;\s*\}/);

    // Clean copy & preview dedup in panel.js
    assert.equal(panelSrc.includes('（展开态亦可）'), false);
    assert.equal(panelSrc.includes('直编'), false);
    assert.equal(panelSrc.includes('id="wbo-mgr-combo-bar"'), false);
    assert.equal(panelSrc.includes('data-acc-extra="edit-book"'), false);
    assert.equal(panelSrc.includes('data-acc-extra="delete-single-book"'), false);

    // M3 R2 CSS regressions: keep [data-acc-sort] visible in .wbo-book-preview on mobile/narrow & 601-680px single-footer parity
    assert.equal(
        /\.wbo-book-preview\s+\.wbo-preview-head-actions\s*\{\s*display:\s*none/i.test(css),
        false,
        'style.css must NOT hide .wbo-book-preview .wbo-preview-head-actions (would hide [data-acc-sort])',
    );
    assert.match(css, /@media\s*\(max-width:\s*680px\)[\s\S]*?\.wbo-ai-footer\.wbo-ai-footer-single\s+\.wbo-ai-footer-right\s*>\s*\.wbo-btn\s*\{[\s\S]*?height:\s*30px\s*!important;/);
});

test('M3 R2 regression: syncEmbeddedPanelIndicators & toggle-global during active search filtering out edited char book never recurse infinitely', async () => {
    const dom = installMockNativeFilterDom({ innerWidth: 1280, innerHeight: 800 });
    const prevConfirm = globalThis.confirm;
    const prevSetTimeout = globalThis.setTimeout;
    const panelMod = await import('../src/panel.js');

    const settings = normalizeSettings({
        showCharBooks: false,
        activeFilterGroupId: SPECIAL_GROUPS.DEFAULT,
    });
    const characters = [
        { name: '角色乙', avatar: 'lu.png', shallow: false, data: { name: '角色乙', extensions: { world: '角色乙主世界书' } } },
    ];
    const worldNames = ['角色乙主世界书', '通用书'];

    const editorSelect = dom.doc.createElement('select');
    editorSelect.id = 'world_editor_select';
    for (const [idx, n] of worldNames.entries()) {
        const opt = dom.doc.createElement('option');
        opt.value = String(idx);
        opt.textContent = n;
        if (n === '角色乙主世界书') opt.selected = true;
        editorSelect.appendChild(opt);
    }
    const worldInfoSelect = dom.doc.createElement('select');
    worldInfoSelect.id = 'world_info';
    worldInfoSelect.multiple = true;
    for (const [idx, n] of worldNames.entries()) {
        const opt = dom.doc.createElement('option');
        opt.value = String(idx);
        opt.textContent = n;
        worldInfoSelect.appendChild(opt);
    }
    dom.doc.body.appendChild(editorSelect);
    dom.doc.body.appendChild(worldInfoSelect);

    globalThis.SillyTavern = {
        getContext: () => ({
            characters,
            extensionSettings: {},
            saveSettingsDebounced: () => {},
            getWorldInfoNames: () => [...worldNames],
            world_names: [...worldNames],
        }),
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
            onMutation: async (opts = {}) => {
                if (opts.uiOnly) return;
                state = recomputeState();
                panelMod.renderEmbeddedPanel();
            },
            onRescan: async () => {
                state = recomputeState();
                panelMod.renderEmbeddedPanel();
            },
        });

        panelMod.openManagerModal();
        assert.ok(dom.doc.querySelector('#wbo-mgr-groups-list .wbo-mgr-bare-editing'), 'initial bare editing row present before search');

        // Search filters out 角色乙主世界书 while keeping 通用书 visible
        const searchInput = dom.doc.getElementById('wbo-mgr-search-input');
        assert.ok(searchInput);
        searchInput.value = '通用';
        searchInput.dispatchEvent(new dom.MockEvent('input', { bubbles: true }));
        await new Promise((r) => prevSetTimeout(r, 110));

        const listEl = dom.doc.getElementById('wbo-mgr-groups-list');
        assert.equal(listEl.querySelector('.wbo-mgr-bare-editing'), null, 'search hides non-matching bare editing row');
        const visibleRow = listEl.querySelector('.wbo-book-row[data-book="通用书"]');
        assert.ok(visibleRow, 'matching non-char book remains visible');

        // Direct syncEmbeddedPanelIndicators() & toggle-global must not throw RangeError
        assert.doesNotThrow(() => panelMod.syncEmbeddedPanelIndicators());
        const globalBtn = visibleRow.querySelector('[data-action="toggle-global"]');
        assert.ok(globalBtn);
        assert.doesNotThrow(() => globalBtn.click());
        await new Promise((r) => prevSetTimeout(r, 10));
        assert.equal(worldInfoSelect.options[1].selected, true, 'toggle-global activates 通用书 without recursion');
        assert.ok(visibleRow.classList.contains('is-active'));
    } finally {
        panelMod.teardownPanels();
        globalThis.confirm = prevConfirm;
        dom.restore();
    }
});

test('M3 R2 regression: 1-click 归入角色世界书 on embedded same-name book persists include_in_char, clears 同名待归类, and hides scan prompt', async () => {
    const dom = installMockNativeFilterDom({ innerWidth: 1280, innerHeight: 800 });
    const prevConfirm = globalThis.confirm;
    const prevSetTimeout = globalThis.setTimeout;
    const panelMod = await import('../src/panel.js');

    const settings = normalizeSettings({
        includeEmbeddedNameMatch: true,
        autoScanNewCharacters: true,
    });
    const characters = [
        {
            name: '角色F',
            avatar: 'charF.png',
            shallow: false,
            data: {
                name: '角色F',
                extensions: { world: '主书F' },
                character_book: { name: '旧内嵌F', entries: [] },
            },
        },
    ];
    const worldNames = ['主书F', '旧内嵌F'];

    globalThis.SillyTavern = {
        getContext: () => ({
            characters,
            extensionSettings: {},
            saveSettingsDebounced: () => {},
            getWorldInfoNames: () => [...worldNames],
            world_names: [...worldNames],
        }),
    };

    const recomputeState = () => {
        const bindingMap = buildCharacterBindingIndex({
            characters,
            charLore: [],
            cachedCharBindings: settings.cachedCharBindings,
            worldNamesSet: new Set(worldNames),
            includeExtraCharBooks: true,
            includeEmbeddedNameMatch: settings.includeEmbeddedNameMatch !== false,
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
            onMutation: async (opts = {}) => {
                if (opts.uiOnly) return;
                state = recomputeState();
                panelMod.renderEmbeddedPanel();
            },
            onRescan: async () => {
                state = recomputeState();
                panelMod.renderEmbeddedPanel();
            },
        });

        panelMod.openManagerModal();
        const scanPrompt = dom.doc.getElementById('wbo-mgr-scan-prompt');
        assert.ok(scanPrompt && !scanPrompt.hidden, 'scan prompt shown for unconfirmed embedded same-name book');

        const scanBtn = dom.doc.getElementById('wbo-mgr-scan-btn');
        assert.ok(scanBtn);
        scanBtn.click();

        const assignBtn = dom.doc.querySelector('[data-cov-assign-char="旧内嵌F"]');
        assert.ok(assignBtn, 'embedded same-name book renders 归入角色世界书 button');
        assert.equal(assignBtn.getAttribute('data-cov-match-kind'), 'embedded');

        assignBtn.click();
        await new Promise((r) => prevSetTimeout(r, 15));

        assert.equal(settings.charBookOverrides['旧内嵌F'], 'include_in_char', 'must record include_in_char override even though meta.isCharBound is true');
        assert.equal(dom.doc.querySelector('[data-cov-assign-char="旧内嵌F"]'), null, 'cleared from 同名待归类 after 1-click assign');
        assert.equal(dom.doc.getElementById('wbo-mgr-scan-prompt').hidden, true, 'scan prompt hides once embedded same-name book is confirmed');
    } finally {
        panelMod.teardownPanels();
        globalThis.confirm = prevConfirm;
        dom.restore();
    }
});

test('M3 R3 regression: assignBookToGroup / openMoveGroupModal round-trip & batch-ungroup preserve embedded charBookOverrides without resurrecting scan prompt', async () => {
    const dom = installMockNativeFilterDom({ innerWidth: 1280, innerHeight: 800 });
    const prevConfirm = globalThis.confirm;
    const prevToastr = globalThis.toastr;
    const prevSetTimeout = globalThis.setTimeout;
    const toasts = [];
    const panelMod = await import('../src/panel.js');

    const settings = normalizeSettings({
        showCharBooks: true,
        charGroupCollapsed: false,
        includeEmbeddedNameMatch: true,
        autoScanNewCharacters: true,
        groups: [{ id: 'g1', name: '剧情', color: '#6b7a8c', collapsed: false }],
    });
    const characters = [
        {
            name: '角色F',
            avatar: 'charF.png',
            shallow: false,
            data: {
                name: '角色F',
                extensions: { world: '主书F' },
                character_book: { name: '旧内嵌F', entries: [] },
            },
        },
        {
            name: '角色G',
            avatar: 'charG.png',
            shallow: false,
            data: {
                name: '角色G',
                extensions: {},
                character_book: { name: '内嵌孤书G', entries: [] },
            },
        },
    ];
    const worldNames = ['主书F', '旧内嵌F', '内嵌孤书G'];

    globalThis.SillyTavern = {
        getContext: () => ({
            characters,
            extensionSettings: {},
            saveSettingsDebounced: () => {},
            getWorldInfoNames: () => [...worldNames],
            world_names: [...worldNames],
        }),
    };

    const recomputeState = () => {
        const bindingMap = buildCharacterBindingIndex({
            characters,
            charLore: [],
            cachedCharBindings: settings.cachedCharBindings,
            worldNamesSet: new Set(worldNames),
            includeExtraCharBooks: true,
            includeEmbeddedNameMatch: settings.includeEmbeddedNameMatch !== false,
        });
        const classification = classifyWorldbooks({
            worldNames,
            bindingMap,
            personaMap: new Map(),
            settings,
        });
        return { settings, bindingMap, classification };
    };

    const moveViaModal = async (bookName, targetGroupId) => {
        const row = dom.doc.querySelector(`#wbo-mgr-groups-list .wbo-book-row[data-book="${bookName}"]`);
        assert.ok(row, `book row for ${bookName} must exist`);
        row.querySelector('[data-action="book-more-menu"]').click();
        const moveBtn = dom.doc.querySelector('.wbo-book-more-popover [data-more-act="move-group"]');
        assert.ok(moveBtn, `move-group button for ${bookName} must exist`);
        moveBtn.click();
        const opt = dom.doc.querySelector(`.wbo-move-option[data-target-group="${targetGroupId}"]`);
        assert.ok(opt, `move option ${targetGroupId} must exist`);
        opt.click();
        await new Promise((r) => prevSetTimeout(r, 15));
    };

    try {
        globalThis.confirm = () => true;
        globalThis.toastr = {
            success: (msg) => toasts.push(['success', msg]),
            info: (msg) => toasts.push(['info', msg]),
            warning: (msg) => toasts.push(['warning', msg]),
            error: (msg) => toasts.push(['error', msg]),
        };
        let state = recomputeState();
        panelMod.bindPanelCallbacks({
            getState: () => state,
            onMutation: async (opts = {}) => {
                if (opts.uiOnly) return;
                state = recomputeState();
                panelMod.renderEmbeddedPanel();
            },
            onRescan: async () => {
                state = recomputeState();
                panelMod.renderEmbeddedPanel();
            },
        });

        panelMod.openManagerModal();

        // 1. Confirm both embedded books via 1-click scan action
        dom.doc.getElementById('wbo-mgr-scan-btn').click();
        for (const name of ['旧内嵌F', '内嵌孤书G']) {
            const btn = dom.doc.querySelector(`[data-cov-assign-char="${name}"]`);
            assert.ok(btn, `1-click assign button for ${name}`);
            btn.click();
            await new Promise((r) => prevSetTimeout(r, 15));
        }
        dom.doc.querySelector('.wbo-submodal-overlay .wbo-modal-close')?.click();
        assert.equal(settings.charBookOverrides['旧内嵌F'], 'include_in_char');
        assert.equal(settings.charBookOverrides['内嵌孤书G'], 'include_in_char');
        assert.equal(dom.doc.getElementById('wbo-mgr-scan-prompt').hidden, true);

        // 2. Round-trip both embedded books: CHARACTER -> custom 'g1' -> CHARACTER
        for (const name of ['旧内嵌F', '内嵌孤书G']) {
            await moveViaModal(name, 'g1');
            assert.equal(settings.assignments[name], 'g1', `${name} moved to g1`);
            assert.equal(settings.charBookOverrides[name], 'exclude_from_char', `${name} excluded from char while in g1`);

            await moveViaModal(name, SPECIAL_GROUPS.CHARACTER);
            assert.equal(settings.assignments[name], undefined, `${name} assignment cleared when moved back to CHARACTER`);
            assert.equal(
                settings.charBookOverrides[name],
                'include_in_char',
                `${name} moved back to CHARACTER must preserve include_in_char instead of deleting override`,
            );
            const promptState = computeScanPromptState({
                worldNames,
                characters,
                bindingMap: state.bindingMap,
                settings,
            });
            assert.equal(promptState.sameNameNeedConfirmCount, 0, `${name} must not resurrect sameNameNeedConfirmCount`);
            assert.equal(dom.doc.getElementById('wbo-mgr-scan-prompt').hidden, true, `#wbo-mgr-scan-prompt must stay hidden after ${name} round-trip`);
        }

        // 3. Unconfirmed embedded book already in CHARACTER moved to CHARACTER via openMoveGroupModal still confirms include_in_char
        delete settings.charBookOverrides['内嵌孤书G'];
        panelMod.teardownPanels();
        state = recomputeState();
        panelMod.bindPanelCallbacks({
            getState: () => state,
            onMutation: async (opts = {}) => {
                if (opts.uiOnly) return;
                state = recomputeState();
                panelMod.renderEmbeddedPanel();
            },
            onRescan: async () => {
                state = recomputeState();
                panelMod.renderEmbeddedPanel();
            },
        });
        panelMod.openManagerModal();
        assert.equal(dom.doc.getElementById('wbo-mgr-scan-prompt').hidden, false);
        await moveViaModal('内嵌孤书G', SPECIAL_GROUPS.CHARACTER);
        assert.equal(settings.charBookOverrides['内嵌孤书G'], 'include_in_char');
        assert.equal(dom.doc.getElementById('wbo-mgr-scan-prompt').hidden, true);

        // 4. batch-ungroup preserves exclude_from_char on embedded books in custom groups,
        //    and restores real-bound books from UNGROUPED with accurate toast (not "原本就未分组")
        await moveViaModal('旧内嵌F', 'g1');
        await moveViaModal('主书F', SPECIAL_GROUPS.UNGROUPED);
        assert.equal(settings.charBookOverrides['旧内嵌F'], 'exclude_from_char');
        assert.equal(settings.charBookOverrides['主书F'], 'exclude_from_char');

        dom.doc.getElementById('wbo-mgr-batch-btn').click();
        const embCheck = dom.doc.querySelector('#wbo-mgr-groups-list .wbo-book-row[data-book="旧内嵌F"] .wbo-batch-check');
        assert.ok(embCheck);
        embCheck.checked = true;
        embCheck.click();
        dom.doc.querySelector('[data-action="batch-ungroup"]').click();
        await new Promise((r) => prevSetTimeout(r, 20));
        assert.equal(settings.assignments['旧内嵌F'], undefined, 'embedded book removed from custom group g1');
        assert.equal(settings.charBookOverrides['旧内嵌F'], 'exclude_from_char', 'batch-ungroup must keep exclude_from_char on embedded book');
        assert.equal(dom.doc.getElementById('wbo-mgr-scan-prompt').hidden, true);

        const realCheck = dom.doc.querySelector('#wbo-mgr-groups-list .wbo-book-row[data-book="主书F"] .wbo-batch-check');
        assert.ok(realCheck);
        realCheck.checked = true;
        realCheck.click();
        dom.doc.querySelector('[data-action="batch-ungroup"]').click();
        await new Promise((r) => prevSetTimeout(r, 20));
        assert.equal(settings.charBookOverrides['主书F'], undefined, 'real primary book restored to CHARACTER');
        assert.deepEqual(toasts.at(-1), ['success', '已解除 1 本世界书的分组'], 'must not emit false 原本就未分组 toast when exclude_from_char was cleared');

        // 5. batch-ungroup on already-ungrouped excluded embedded book preserves exclude_from_char and emits info toast
        const embUngroupedCheck = dom.doc.querySelector('#wbo-mgr-groups-list .wbo-book-row[data-book="旧内嵌F"] .wbo-batch-check');
        assert.ok(embUngroupedCheck);
        embUngroupedCheck.checked = true;
        embUngroupedCheck.click();
        dom.doc.querySelector('[data-action="batch-ungroup"]').click();
        await new Promise((r) => prevSetTimeout(r, 20));
        assert.equal(settings.charBookOverrides['旧内嵌F'], 'exclude_from_char');
        assert.deepEqual(toasts.at(-1), ['info', '选中的世界书原本就未分组']);
    } finally {
        panelMod.teardownPanels();
        globalThis.confirm = prevConfirm;
        if (prevToastr === undefined) delete globalThis.toastr;
        else globalThis.toastr = prevToastr;
        dom.restore();
    }
});

test('M3 R3 regression: AI organize isCharBoundFn persists include_in_char when assigning embedded book to 角色世界书', async () => {
    const dom = installMockNativeFilterDom({ innerWidth: 1280, innerHeight: 800 });
    const prevConfirm = globalThis.confirm;
    const prevDetails = globalThis.HTMLDetailsElement;
    const prevSetTimeout = globalThis.setTimeout;
    const panelMod = await import('../src/panel.js');

    const settings = normalizeSettings({
        includeEmbeddedNameMatch: true,
        autoScanNewCharacters: true,
        groups: [{ id: 'g1', name: '剧情', color: '#6b7a8c', collapsed: false }],
        assignments: { '旧内嵌F': 'g1' },
        charBookOverrides: { '旧内嵌F': 'exclude_from_char' },
    });
    const characters = [
        {
            name: '角色F',
            avatar: 'charF.png',
            shallow: false,
            data: {
                name: '角色F',
                extensions: { world: '主书F' },
                character_book: { name: '旧内嵌F', entries: [] },
            },
        },
    ];
    const worldNames = ['主书F', '旧内嵌F'];

    globalThis.SillyTavern = {
        getContext: () => ({
            characters,
            extensionSettings: {},
            saveSettingsDebounced: () => {},
            getWorldInfoNames: () => [...worldNames],
            world_names: [...worldNames],
        }),
    };

    const recomputeState = () => {
        const bindingMap = buildCharacterBindingIndex({
            characters,
            charLore: [],
            cachedCharBindings: settings.cachedCharBindings,
            worldNamesSet: new Set(worldNames),
            includeExtraCharBooks: true,
            includeEmbeddedNameMatch: settings.includeEmbeddedNameMatch !== false,
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
        globalThis.HTMLDetailsElement = globalThis.HTMLElement;
        let state = recomputeState();
        panelMod.bindPanelCallbacks({
            getState: () => state,
            onMutation: async (opts = {}) => {
                if (opts.uiOnly) return;
                state = recomputeState();
                panelMod.renderEmbeddedPanel();
            },
            onRescan: async () => {
                state = recomputeState();
                panelMod.renderEmbeddedPanel();
            },
        });

        panelMod.openManagerModal();
        dom.doc.querySelector('[data-action="open-ai-organize"]').click();

        const jsonInput = dom.doc.getElementById('wbo-ai-json-input');
        assert.ok(jsonInput);
        jsonInput.value = JSON.stringify([{ realName: '旧内嵌F', group: '角色世界书' }]);
        dom.doc.getElementById('wbo-ai-parse-paste-btn').click();

        const applyBtn = dom.doc.getElementById('wbo-ai-apply-btn');
        assert.ok(applyBtn);
        applyBtn.click();
        await new Promise((r) => prevSetTimeout(r, 20));

        assert.equal(settings.assignments['旧内嵌F'], undefined);
        assert.equal(
            settings.charBookOverrides['旧内嵌F'],
            'include_in_char',
            'assigning embedded book to 角色世界书 via AI organize must persist include_in_char',
        );
        assert.equal(state.classification.byName.get('旧内嵌F')?.groupId, SPECIAL_GROUPS.CHARACTER);
        const promptState = computeScanPromptState({
            worldNames,
            characters,
            bindingMap: state.bindingMap,
            settings,
        });
        assert.equal(promptState.sameNameNeedConfirmCount, 0);
        assert.equal(dom.doc.getElementById('wbo-mgr-scan-prompt').hidden, true);
    } finally {
        panelMod.teardownPanels();
        globalThis.confirm = prevConfirm;
        if (prevDetails === undefined) delete globalThis.HTMLDetailsElement;
        else globalThis.HTMLDetailsElement = prevDetails;
        dom.restore();
    }
});

test('M3 R4 regression: AI organize outbound moves to custom group or 未分组 set exclude_from_char for embedded and real char-bound books without resurrecting scan prompt', async () => {
    const dom = installMockNativeFilterDom({ innerWidth: 1280, innerHeight: 800 });
    const prevConfirm = globalThis.confirm;
    const prevDetails = globalThis.HTMLDetailsElement;
    const prevSetTimeout = globalThis.setTimeout;
    const panelMod = await import('../src/panel.js');

    const settings = normalizeSettings({
        includeEmbeddedNameMatch: true,
        autoScanNewCharacters: true,
        groups: [{ id: 'g1', name: '剧情', color: '#6b7a8c', collapsed: false }],
        assignments: {},
        charBookOverrides: {
            '旧内嵌F': 'include_in_char',
            '成人向_角色H内嵌': 'include_in_char',
            '同名角色甲': 'include_in_char',
        },
    });
    const characters = [
        {
            name: '角色F',
            avatar: 'charF.png',
            shallow: false,
            data: {
                name: '角色F',
                extensions: { world: '主书F' },
                character_book: { name: '旧内嵌F', entries: [] },
            },
        },
        {
            name: '角色H',
            avatar: 'charH.png',
            shallow: false,
            data: {
                name: '角色H',
                extensions: {},
                character_book: { name: '成人向_角色H内嵌', entries: [] },
            },
        },
    ];
    const worldNames = ['主书F', '旧内嵌F', '成人向_角色H内嵌', '同名角色甲'];

    globalThis.SillyTavern = {
        getContext: () => ({
            characters,
            extensionSettings: {},
            saveSettingsDebounced: () => {},
            getWorldInfoNames: () => [...worldNames],
            world_names: [...worldNames],
        }),
    };

    const recomputeState = () => {
        const bindingMap = buildCharacterBindingIndex({
            characters,
            charLore: [],
            cachedCharBindings: settings.cachedCharBindings,
            worldNamesSet: new Set(worldNames),
            includeExtraCharBooks: true,
            includeEmbeddedNameMatch: settings.includeEmbeddedNameMatch !== false,
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
        globalThis.HTMLDetailsElement = globalThis.HTMLElement;
        let state = recomputeState();
        panelMod.bindPanelCallbacks({
            getState: () => state,
            onMutation: async (opts = {}) => {
                if (opts.uiOnly) return;
                state = recomputeState();
                panelMod.renderEmbeddedPanel();
            },
            onRescan: async () => {
                state = recomputeState();
                panelMod.renderEmbeddedPanel();
            },
        });

        panelMod.openManagerModal();
        dom.doc.querySelector('[data-action="open-ai-organize"]').click();

        const jsonInput = dom.doc.getElementById('wbo-ai-json-input');
        assert.ok(jsonInput);
        jsonInput.value = JSON.stringify([
            { realName: '成人向_角色H内嵌', group: '剧情' },
            { realName: '旧内嵌F', group: '未分组' },
            { realName: '主书F', group: '未分组' },
            { realName: '同名角色甲', group: '未分组' },
        ]);
        dom.doc.getElementById('wbo-ai-parse-paste-btn').click();

        const applyBtn = dom.doc.getElementById('wbo-ai-apply-btn');
        assert.ok(applyBtn);
        applyBtn.click();
        await new Promise((r) => prevSetTimeout(r, 20));

        // Target 3B-ADV: embedded book moved to custom group '剧情'
        assert.equal(settings.assignments['成人向_角色H内嵌'], 'g1');
        assert.equal(settings.charBookOverrides['成人向_角色H内嵌'], 'exclude_from_char');
        assert.equal(state.classification.byName.get('成人向_角色H内嵌')?.groupId, 'g1');

        // Target 3B2-ADV: embedded & real char-bound books moved to '未分组'
        assert.equal(settings.assignments['旧内嵌F'], undefined);
        assert.equal(settings.charBookOverrides['旧内嵌F'], 'exclude_from_char');
        assert.equal(state.classification.byName.get('旧内嵌F')?.groupId, SPECIAL_GROUPS.UNGROUPED);

        assert.equal(settings.assignments['主书F'], undefined);
        assert.equal(settings.charBookOverrides['主书F'], 'exclude_from_char');
        assert.equal(state.classification.byName.get('主书F')?.groupId, SPECIAL_GROUPS.UNGROUPED);

        // Unbound control: '同名角色甲' clears include_in_char to undefined
        assert.equal(settings.assignments['同名角色甲'], undefined);
        assert.equal(settings.charBookOverrides['同名角色甲'], undefined);
        assert.equal(state.classification.byName.get('同名角色甲')?.groupId, SPECIAL_GROUPS.UNGROUPED);

        const promptState = computeScanPromptState({
            worldNames,
            characters,
            bindingMap: state.bindingMap,
            settings,
        });
        assert.equal(promptState.sameNameNeedConfirmCount, 0);
        assert.equal(dom.doc.getElementById('wbo-mgr-scan-prompt').hidden, true);
    } finally {
        panelMod.teardownPanels();
        globalThis.confirm = prevConfirm;
        if (prevDetails === undefined) delete globalThis.HTMLDetailsElement;
        else globalThis.HTMLDetailsElement = prevDetails;
        dom.restore();
    }
});

test('M3 R4 regression: 1-click NSFW & moveBooksToNamedGroup preserve exclude_from_char on embedded sensitive books', async () => {
    const dom = installMockNativeFilterDom({ innerWidth: 1280, innerHeight: 800 });
    const prevConfirm = globalThis.confirm;
    const prevDetails = globalThis.HTMLDetailsElement;
    const prevSetTimeout = globalThis.setTimeout;
    const panelMod = await import('../src/panel.js');

    const settings = normalizeSettings({
        includeEmbeddedNameMatch: true,
        autoScanNewCharacters: true,
        groups: [],
        assignments: {},
        charBookOverrides: { '成人向_角色H内嵌': 'exclude_from_char' },
    });
    const characters = [
        {
            name: '角色H',
            avatar: 'charH.png',
            shallow: false,
            data: {
                name: '角色H',
                extensions: {},
                character_book: { name: '成人向_角色H内嵌', entries: [] },
            },
        },
    ];
    const worldNames = ['成人向_角色H内嵌'];

    globalThis.SillyTavern = {
        getContext: () => ({
            characters,
            extensionSettings: {},
            saveSettingsDebounced: () => {},
            getWorldInfoNames: () => [...worldNames],
            world_names: [...worldNames],
        }),
    };

    const recomputeState = () => {
        const bindingMap = buildCharacterBindingIndex({
            characters,
            charLore: [],
            cachedCharBindings: settings.cachedCharBindings,
            worldNamesSet: new Set(worldNames),
            includeExtraCharBooks: true,
            includeEmbeddedNameMatch: settings.includeEmbeddedNameMatch !== false,
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
        globalThis.HTMLDetailsElement = globalThis.HTMLElement;
        let state = recomputeState();
        panelMod.bindPanelCallbacks({
            getState: () => state,
            onMutation: async (opts = {}) => {
                if (opts.uiOnly) return;
                state = recomputeState();
                panelMod.renderEmbeddedPanel();
            },
            onRescan: async () => {
                state = recomputeState();
                panelMod.renderEmbeddedPanel();
            },
        });

        panelMod.openManagerModal();
        dom.doc.querySelector('[data-action="open-ai-organize"]').click();

        dom.doc.querySelector('[data-ai-book-tab="sensitive"]').click();
        dom.doc.getElementById('wbo-pick-toggle-sens').click();
        const moveNsfwBtn = dom.doc.querySelector('[data-action-move-nsfw]');
        assert.ok(moveNsfwBtn);
        assert.equal(moveNsfwBtn.hidden, false);
        moveNsfwBtn.click();

        const confirmOkBtn = dom.doc.getElementById('wbo-sens-confirm-ok');
        assert.ok(confirmOkBtn);
        confirmOkBtn.click();
        await new Promise((r) => prevSetTimeout(r, 20));

        const nsfwGroup = settings.groups.find((g) => g.name === 'NSFW');
        assert.ok(nsfwGroup, 'NSFW group must be created');
        assert.equal(settings.assignments['成人向_角色H内嵌'], nsfwGroup.id);
        assert.equal(
            settings.charBookOverrides['成人向_角色H内嵌'],
            'exclude_from_char',
            '1-click NSFW UI move must preserve exclude_from_char on embedded sensitive book',
        );
        assert.equal(state.classification.byName.get('成人向_角色H内嵌')?.groupId, nsfwGroup.id);
        let promptState = computeScanPromptState({
            worldNames,
            characters,
            bindingMap: state.bindingMap,
            settings,
        });
        assert.equal(promptState.sameNameNeedConfirmCount, 0);

        // Target 3C-ADV: direct moveBooksToNamedGroup with isCharBoundFn transitioning include_in_char -> exclude_from_char
        delete settings.assignments['成人向_角色H内嵌'];
        settings.charBookOverrides['成人向_角色H内嵌'] = 'include_in_char';
        state = recomputeState();
        const moveRes = moveBooksToNamedGroup(settings, ['成人向_角色H内嵌'], 'NSFW', {
            targetGroupId: nsfwGroup.id,
            isCharBoundFn: (name) => Boolean(state.classification.byName.get(name)?.isCharBound),
        });
        assert.equal(moveRes.movedCount, 1);
        assert.equal(settings.assignments['成人向_角色H内嵌'], nsfwGroup.id);
        assert.equal(
            settings.charBookOverrides['成人向_角色H内嵌'],
            'exclude_from_char',
            'moveBooksToNamedGroup must set exclude_from_char for embedded sensitive book starting with include_in_char',
        );
        promptState = computeScanPromptState({
            worldNames,
            characters,
            bindingMap: state.bindingMap,
            settings,
        });
        assert.equal(promptState.sameNameNeedConfirmCount, 0);
    } finally {
        panelMod.teardownPanels();
        globalThis.confirm = prevConfirm;
        if (prevDetails === undefined) delete globalThis.HTMLDetailsElement;
        else globalThis.HTMLDetailsElement = prevDetails;
        dom.restore();
    }
});

test('M4 P1 regression F2.5: applyEditorWorldSelectFilter preserves empty placeholder when DocumentFragment move triggers single-select auto-promotion', async () => {
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

        const enableChromiumAutoSelectOnRemove = (opt) => {
            const baseRemove = opt.remove.bind(opt);
            opt.remove = () => {
                const parent = opt.parentNode;
                const wasSelected = Boolean(opt.selected);
                baseRemove();
                if (parent === editorSel && !editorSel.multiple && wasSelected) {
                    const remaining = editorSel.options;
                    if (remaining.length > 0) {
                        for (const o of remaining) o.selected = false;
                        remaining[0].selected = true;
                    }
                }
            };
        };

        for (const [val, txt] of [['', '--- 选择以编辑 ---'], ['0', '隐藏角色书'], ['1', '普通书A'], ['2', '普通书B']]) {
            const opt = dom.doc.createElement('option');
            opt.value = val;
            opt.textContent = txt;
            if (val === '') opt.selected = true;
            enableChromiumAutoSelectOnRemove(opt);
            editorSel.appendChild(opt);
        }

        worldPopup.appendChild(editorSel);
        wiDrawer.append(multiSel, worldPopup);
        dom.doc.body.appendChild(wiDrawer);

        const bindingMap = new Map([['隐藏角色书', [{ avatar: 'CharB.png', charName: 'CharB', source: 'primary' }]]]);
        const settings = normalizeSettings({
            groups: [{ id: 'g1', name: '文风', color: '#5b8def', collapsed: false }],
            assignments: { 普通书A: 'g1' },
            showCharBooks: false,
            hideCharBooksByDefault: true,
            pinCurrentChatCharBookInEditor: false,
            showNativeOptgroups: true,
        });
        const cls = classifyWorldbooks({
            worldNames: ['隐藏角色书', '普通书A', '普通书B'],
            bindingMap,
            settings,
        });

        assert.equal(editorSel.value, '');
        nativeMod.applyAllNativeWorldFilters(cls, settings, { force: true });

        assert.equal(editorSel.value, '', 'empty placeholder selection must survive DocumentFragment move');
        assert.equal(editorSel.selectedOptions[0]?.value, '', 'placeholder <option value=""> must remain selected');
        const trigger = dom.doc.getElementById('wbo-mobile-editor-trigger');
        assert.ok(trigger, 'mobile editor trigger should mount when >= 2 sections exist');
        assert.equal(trigger.textContent.trim(), '--- 选择以编辑 ---');
        assert.equal(trigger.classList.contains('is-placeholder'), true);

        // Simulate WORLDINFO_ENTRIES_LOADED for hidden char book while #world_editor_select still has value === ''
        nativeMod.setCurrentlyEditingWorld('隐藏角色书');
        nativeMod.applyAllNativeWorldFilters(cls, settings, { force: true });

        assert.equal(editorSel.value, '', 'selectEl.value must stay empty when _currentlyEditingWorld is tracked externally');
        assert.equal(trigger.textContent.trim(), '--- 选择以编辑 ---');

        trigger.dispatchEvent(new dom.MockEvent('click', { bubbles: true, cancelable: true }));
        const mpOverlay = dom.doc.getElementById('wbo-mobile-picker-overlay');
        assert.ok(mpOverlay, 'mobile picker overlay should open');
        const heads = mpOverlay.querySelectorAll('.wbo-mp-sec-head').map((h) => h.textContent.trim());
        assert.equal(heads.some((h) => h.includes('角色世界书')), false, 'hidden edited char book must NOT be wrapped under 角色世界书');
        const editedRow = mpOverlay.querySelectorAll('.wbo-mp-row').find((r) => r.textContent.includes('隐藏角色书'));
        assert.ok(editedRow, '隐藏角色书 must render bare in mobile picker');
        assert.ok(editedRow.textContent.includes('当前编辑'), '隐藏角色书 bare row must display 当前编辑 badge');
    } finally {
        nativeMod.teardownNativeFilters();
        dom.restore();
    }
});

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
