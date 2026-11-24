import test from 'node:test';
import assert from 'node:assert/strict';

import {
    SPECIAL_GROUPS,
    applyAiOrganizeProposals,
    buildAiOrganizePrompt,
    buildCharacterBindingIndex,
    buildPersonaBindingIndex,
    classifyWorldbooks,
    exportConfigData,
    importConfigData,
    isBookVisibleInCharBindPopup,
    isBookVisibleInSelector,
    matchesSearch,
    normalizeSettings,
    parseAiOrganizeResponse,
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
    assert.equal(cached['Bob.png'], undefined);

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
