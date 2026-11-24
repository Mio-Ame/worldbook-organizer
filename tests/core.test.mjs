import test from 'node:test';
import assert from 'node:assert/strict';

import {
    SPECIAL_GROUPS,
    addCustomGroup,
    applyAiOrganizeProposals,
    buildAiOrganizePrompt,
    buildLocalOrganizeProposals,
    buildCharacterBindingIndex,
    buildPersonaBindingIndex,
    classifyWorldbooks,
    cleanupDeletedWorldSettings,
    compareWorldbookEntries,
    detectAiRefusal,
    exportConfigData,
    findCardsWithUnimportedBooks,
    findUnscannedShallowCharacters,
    importConfigData,
    isBookVisibleInCharBindPopup,
    isBookVisibleInSelector,
    isPotentiallySensitiveTitle,
    matchesSearch,
    migrateSettingsOnWorldRename,
    moveSectionOrder,
    normalizeSettings,
    parseAiOrganizeResponse,
    promoteSectionToTop,
    pushUndoSnapshot,
    reorderSection,
    restoreOrganizeSnapshot,
    summarizeCharacterWorldCoverage,
    undoLastAiOrganize,
    updateCachedCharBindings,
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
    assert.match(redoPrompt.systemPrompt, /缝合/);
    assert.match(redoPrompt.systemPrompt, /场景与互动/);
    assert.match(redoPrompt.userPrompt, /重新分组反馈/);
    assert.match(redoPrompt.userPrompt, /previousGroup/);
    assert.match(redoPrompt.userPrompt, /世界观与角色/);
    assert.match(redoPrompt.userPrompt, /缝合/);

    // Local zero-API organize handles prefixes, ST keywords, sensitive books, custom rules, and title cleanup
    const localProps = buildLocalOrganizeProposals({
        books: [
            { realName: '[缝]不因爱失去自我v1.7 (1)' },
            { realName: '[人设] 娇妻软萌User' },
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
    assert.equal(localProps[1].group, '人设');
    assert.equal(localProps[1].note, '');
    assert.equal(localProps[2].group, '场景与互动');
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
