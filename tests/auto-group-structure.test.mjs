import test from 'node:test';
import assert from 'node:assert/strict';
import {
    GROUP_MODES,
    SPECIAL_GROUP_UNGROUPED,
    applyAutoGroupProposals,
    detectAutoGroups,
    extractWorldbookEntrySummaries,
    looksLikeIfLineName,
    normalizeBookConfig,
    normalizeSettings,
} from '../src/entry-groups/core.js';
import { getNativeGroupOrder } from '../src/entry-groups/entry-reorder.js';

function summarize(rows) {
    return extractWorldbookEntrySummaries({ entries: rows.map((row, uid) => ({
        uid, displayIndex: row.displayIndex ?? uid, comment: row.title, content: row.banner ? '' : '中性正文', key: row.keys || [],
    })) });
}

const compact = (groups) => groups.map(({ name, suggestedMode, uids }) => ({ name, suggestedMode, uids }));

test('older settings default to batches of twenty with automatic continuation', () => {
    for (const raw of [undefined, {}, { version: 1 }, { version: 2 }]) {
        const settings = normalizeSettings(raw);
        assert.equal(settings.autoGroupBatchSize, 20);
        assert.equal(settings.autoGroupAutoContinue, true);
    }
});

test('batch preferences preserve every allowed size and explicit continuation choice through serialization', () => {
    for (const autoGroupBatchSize of [5, 10, 20, 50]) {
        for (const autoGroupAutoContinue of [false, true]) {
            const raw = { autoGroupBatchSize, autoGroupAutoContinue };
            const settings = normalizeSettings(raw);
            const restored = normalizeSettings(JSON.parse(JSON.stringify(settings)));
            assert.equal(restored.autoGroupBatchSize, autoGroupBatchSize);
            assert.equal(restored.autoGroupAutoContinue, autoGroupAutoContinue);
            assert.deepEqual(raw, { autoGroupBatchSize, autoGroupAutoContinue });
        }
    }
});

test('invalid batch preferences fall back to the bounded defaults', () => {
    for (const autoGroupBatchSize of [null, 0, -1, 6, 100, 10.5, '10', false, [], {}, NaN, Infinity]) {
        assert.equal(normalizeSettings({ autoGroupBatchSize }).autoGroupBatchSize, 20);
    }
    for (const autoGroupAutoContinue of [null, 0, '', 'false']) {
        assert.equal(normalizeSettings({ autoGroupAutoContinue }).autoGroupAutoContinue, true);
    }
});

test('choice-count annotations do not split a shared title-prefix topic or leak into the proposed name', () => {
    const entries = summarize([
        { title: '【多选一·User身份】选项甲' },
        { title: '【三选一·User身份】选项乙' },
        { title: '【三选一·User身份】选项丙' },
        { title: '【背景】地理' },
        { title: '【背景】风俗' },
    ]);
    for (const strategy of ['smart', 'prefix']) {
        assert.deepEqual(compact(detectAutoGroups(entries, { strategy })), [
            { name: 'User身份', suggestedMode: GROUP_MODES.RADIO, uids: ['0', '1', '2'] },
            { name: '背景', suggestedMode: GROUP_MODES.NORMAL, uids: ['3', '4'] },
        ]);
    }
});

test('an explicit arrow range outranks repeated internal prefixes and excludes entries after its closing arrow', () => {
    const entries = summarize([
        { title: '↓本章背景↓', banner: true },
        { title: '【地点】广场' },
        { title: '【地点】车站' },
        { title: '↑本章背景↑', banner: true },
        { title: '【地点】范围之外' },
    ]);
    for (const strategy of ['smart', 'divider']) {
        assert.deepEqual(compact(detectAutoGroups(entries, { strategy })), [
            { name: '本章背景', suggestedMode: GROUP_MODES.NORMAL, uids: ['1', '2'] },
        ]);
    }
});

test('an explicit arrow range also outranks loose scene keywords inside its authored boundary', () => {
    const entries = summarize([
        { title: '↓场景资料↓', banner: true },
        { title: '公共场地' }, { title: '亲密设定' },
        { title: '↑场景资料↑', banner: true },
        { title: '成人向补充' },
    ]);
    assert.deepEqual(compact(detectAutoGroups(entries)), [
        { name: '亲密剧情 (NSFW)', suggestedMode: GROUP_MODES.SCENE, uids: ['4'] },
        { name: '场景资料', suggestedMode: GROUP_MODES.NORMAL, uids: ['1', '2'] },
    ]);
});

test('default repair skips assigned entries and never renames a manually named group', () => {
    const entries = summarize([
        { title: '↓多选一·User身份↓', banner: true },
        { title: '身份甲' }, { title: '身份乙' }, { title: '身份丙' },
        { title: '↑多选一·User身份↑', banner: true },
    ]);
    const saved = normalizeBookConfig({
        groups: [{ id: 'manual', name: '三选一·自定名称', mode: GROUP_MODES.NORMAL }],
        assignments: { 1: 'manual', 2: 'manual' },
    });
    const before = structuredClone(saved);
    const proposals = detectAutoGroups(entries, { existingAssignments: saved.assignments });
    assert.deepEqual(compact(proposals), [
        { name: 'User身份', suggestedMode: GROUP_MODES.RADIO, uids: ['3'] },
    ]);
    const after = applyAutoGroupProposals(saved, proposals);
    assert.deepEqual(saved, before);
    assert.deepEqual(after.groups.find(({ id }) => id === 'manual'), saved.groups[0]);
    assert.equal(after.assignments['1'], 'manual');
    assert.equal(after.assignments['2'], 'manual');
});

test('a count of three entries alone never suggests mutually exclusive choices', () => {
    const entries = summarize([
        { title: '【背景】地理' }, { title: '【背景】风俗' }, { title: '【背景】交通' },
    ]);
    assert.deepEqual(compact(detectAutoGroups(entries)), [
        { name: '背景', suggestedMode: GROUP_MODES.NORMAL, uids: ['0', '1', '2'] },
    ]);
});

test('a main-story arrow section keeps all chapters as a normal group, including distinct entries with the same index', () => {
    const memberTitles = [
        '环境资料', '节奏选项', '显示选项', '配角资料', '引子',
        '第一章', '第二章', '第三章', '第四章', '第五章', '第六章', '终章', '后日谈',
    ];
    const entries = summarize([
        { title: '↓主线，以下章节全部启用↓', banner: true, displayIndex: 0 },
        ...memberTitles.map((title, index) => ({ title, displayIndex: index === 1 ? 1 : index + 1 })),
        { title: '=== 补充资料 ===', banner: true, displayIndex: 14 },
        { title: '独立备注', displayIndex: 15 },
    ]);
    assert.equal(entries.find(({ uid }) => uid === '1').displayIndex,
        entries.find(({ uid }) => uid === '2').displayIndex);
    for (const strategy of ['smart', 'divider']) {
        const proposals = detectAutoGroups(entries, { strategy });
        const mainStory = proposals.find(({ name }) => name === '主线');
        assert.deepEqual(mainStory?.uids, memberTitles.map((_, index) => String(index + 1)));
        assert.equal(mainStory?.suggestedMode, GROUP_MODES.NORMAL);
        assert.equal(mainStory.uids.includes('15'), false);
        const repair = detectAutoGroups(entries, { strategy, existingAssignments: { 1: 'manual' } });
        assert.deepEqual(repair.find(({ name }) => name === '主线')?.uids, mainStory.uids.slice(1));
    }
});

test('a trailing line character is not IF evidence, while explicit IF and age routes retain their modes', () => {
    for (const label of ['主线', '时间线', '故事发展线', '基准线']) {
        assert.equal(looksLikeIfLineName(label), false, label);
        const entries = summarize([{ title: `【${label}】资料甲` }, { title: `【${label}】资料乙` }]);
        assert.equal(detectAutoGroups(entries)[0]?.suggestedMode, GROUP_MODES.NORMAL, label);
    }
    for (const label of ['IF', 'IF线', 'IF 线', 'IF2', 'IF·分歧甲', '18岁线', '30岁线', '路线', '支线', '分支']) {
        assert.equal(looksLikeIfLineName(label), true, label);
        const entries = summarize([{ title: `【${label}】资料甲` }, { title: `【${label}】资料乙` }]);
        assert.equal(detectAutoGroups(entries)[0]?.suggestedMode, GROUP_MODES.IF_LINE, label);
    }
});

test('a plain topic and explicitly exclusive topic remain separate through detection and application', () => {
    const entries = summarize([
        { title: '【背景】通用说明' }, { title: '【背景】使用说明' },
        { title: '【多选一·背景】选项甲' }, { title: '【三选一·背景】选项乙' },
    ]);
    for (const strategy of ['smart', 'prefix']) {
        const proposals = detectAutoGroups(entries, { strategy });
        assert.deepEqual(compact(proposals), [
            { name: '背景', suggestedMode: GROUP_MODES.NORMAL, uids: ['0', '1'] },
            { name: '背景', suggestedMode: GROUP_MODES.RADIO, uids: ['2', '3'] },
        ]);
        const applied = applyAutoGroupProposals(null, proposals);
        assert.notEqual(applied.assignments['0'], applied.assignments['2']);
        assert.equal(applied.groups.find(({ id }) => id === applied.assignments['0']).mode, GROUP_MODES.NORMAL);
        assert.equal(applied.groups.find(({ id }) => id === applied.assignments['2']).mode, GROUP_MODES.RADIO);
    }
});

test('repair cannot upgrade an existing same-named manual group or move its assigned entries', () => {
    const entries = summarize([
        { title: '【背景】通用说明' }, { title: '【背景】使用说明' },
        { title: '【多选一·背景】选项甲' }, { title: '【三选一·背景】选项乙' },
    ]);
    const saved = normalizeBookConfig({ groups: [{ id: 'manual', name: '背景', mode: GROUP_MODES.NORMAL }],
        assignments: { 0: 'manual', 1: 'manual' } });
    const before = structuredClone(saved);
    const proposals = detectAutoGroups(entries, { existingAssignments: saved.assignments });
    assert.deepEqual(compact(proposals), [{ name: '背景', suggestedMode: GROUP_MODES.RADIO, uids: ['2', '3'] }]);
    const applied = applyAutoGroupProposals(saved, proposals);
    assert.deepEqual(saved, before);
    assert.deepEqual(applied.groups.find(({ id }) => id === 'manual'), before.groups[0]);
    assert.equal(applied.assignments['0'], 'manual');
    assert.equal(applied.assignments['1'], 'manual');
    assert.notEqual(applied.assignments['2'], 'manual');
    const custom = detectAutoGroups(entries, { existingAssignments: saved.assignments,
        customRules: [{ group: '三选一·自定名称', keywords: ['选项'] }] });
    assert.deepEqual(compact(custom), [{ name: '三选一·自定名称', suggestedMode: GROUP_MODES.NORMAL, uids: ['2', '3'] }]);
});

test('an explicit normal region cannot become exclusive because of a local pair of choices inside it', () => {
    const entries = summarize([
        { title: '↓本章资料↓', banner: true },
        { title: '身份甲（二选一）' }, { title: '身份乙（二选一）' }, { title: '普通地点' },
        { title: '↑本章资料↑', banner: true },
    ]);
    for (const strategy of ['smart', 'divider']) {
        assert.deepEqual(compact(detectAutoGroups(entries, { strategy })), [
            { name: '本章资料', suggestedMode: GROUP_MODES.NORMAL, uids: ['1', '2', '3'] },
        ]);
    }
});

const proposal = (name, mode = GROUP_MODES.NORMAL, source = 'divider') => ({
    name, suggestedMode: mode, source, uids: [`uid-${name}`],
});
const names = (config) => config.groups.map(({ name }) => name);

test('new automatic groups order IF, explicit NSFW, ordinary topics and strict helpers without changing modes', () => {
    const input = [proposal('小手机'), proposal('背景'), proposal('IF·甲', GROUP_MODES.IF_LINE),
        proposal('主线'), proposal('状态栏'), proposal('IF·乙', GROUP_MODES.IF_LINE),
        proposal('手机维修员人设'), proposal('手机界面'), proposal('手机发展史'),
        proposal('NSFW·路线甲'), proposal('亲密剧情', GROUP_MODES.SCENE),
        proposal('表情包'), proposal('变量更新规则'), proposal('变量更新'), proposal('变量规则'), proposal('变量列表'),
        proposal('剧情变量设定'), proposal('变量更新规则说明')];
    const config = applyAutoGroupProposals(null, input);
    const expected = ['IF·甲', 'IF·乙', 'NSFW·路线甲', '亲密剧情', '背景', '主线', '手机维修员人设', '手机发展史',
        '剧情变量设定', '变量更新规则说明', '小手机', '状态栏', '手机界面', '表情包', '变量更新规则', '变量更新', '变量规则', '变量列表'];
    assert.deepEqual(names(config), expected);
    assert.equal(config.groups.find(({ name }) => name === 'NSFW·路线甲').mode, GROUP_MODES.NORMAL);
    assert.deepEqual(getNativeGroupOrder(config), [...config.groups.map(({ id }) => id), SPECIAL_GROUP_UNGROUPED]);
    // Reopening or normalizing is not another automatic ordering operation.
    config.groups.reverse();
    assert.deepEqual(names(normalizeBookConfig(config)), [...expected].reverse());
    assert.deepEqual(names(applyAutoGroupProposals(config, input)), [...expected].reverse());
});

test('incremental automatic insertion preserves all old relative order and places only new groups by priority', () => {
    const saved = normalizeBookConfig({ groups: [
        { id: 'normal', name: '既有设定' }, { id: 'phone', name: '小手机' },
        { id: 'route', name: '既有IF', mode: GROUP_MODES.IF_LINE }, { id: 'tail', name: '手动末组' },
    ] });
    const before = structuredClone(saved);
    const applied = applyAutoGroupProposals(saved, [proposal('状态栏'), proposal('新增普通'),
        proposal('IF·新甲', GROUP_MODES.IF_LINE), proposal('IF·新乙', GROUP_MODES.IF_LINE)]);
    assert.deepEqual(saved, before);
    assert.deepEqual(names(applied), ['既有设定', '新增普通', '小手机', '既有IF', 'IF·新甲', 'IF·新乙', '手动末组', '状态栏']);
    assert.deepEqual(applied.groups.filter(({ id }) => before.groups.some((old) => old.id === id)), before.groups);
});

test('new IF inserts first when no old route exists; custom proposals retain their supplied order', () => {
    const saved = { groups: [{ id: 'a', name: '旧普通' }], assignments: {} };
    const proposals = [proposal('小手机'), proposal('IF·甲', GROUP_MODES.IF_LINE), proposal('新普通')];
    assert.deepEqual(names(applyAutoGroupProposals(saved, proposals)), ['IF·甲', '旧普通', '新普通', '小手机']);
    const custom = proposals.map((item) => ({ ...item, source: 'custom' }));
    assert.deepEqual(names(applyAutoGroupProposals(null, custom)), ['小手机', 'IF·甲', '新普通']);
    assert.deepEqual(names(applyAutoGroupProposals(saved, custom)), ['旧普通', '小手机', 'IF·甲', '新普通']);
});

test('explicit native order remains authoritative for old groups and includes new groups at deliberate insertion points', () => {
    const saved = normalizeBookConfig({ groups: [
        { id: 'a', name: '普通甲' }, { id: 'b', name: '普通乙' }, { id: 'phone', name: '小手机' },
    ], nativeGroupOrder: ['b', 'a', 'phone', SPECIAL_GROUP_UNGROUPED] });
    const input = [proposal('状态栏'), proposal('IF·甲', GROUP_MODES.IF_LINE), proposal('新普通')];
    const applied = applyAutoGroupProposals(saved, input);
    const groupNames = new Map(applied.groups.map(({ id, name }) => [id, name]));
    const order = getNativeGroupOrder(applied);
    assert.deepEqual(order.map((id) => groupNames.get(id) || id),
        ['IF·甲', '普通乙', '普通甲', '新普通', '小手机', '状态栏', SPECIAL_GROUP_UNGROUPED]);
    assert.deepEqual(order.filter((id) => saved.nativeGroupOrder.includes(id)), saved.nativeGroupOrder);
    assert.deepEqual(saved.nativeGroupOrder, ['b', 'a', 'phone', SPECIAL_GROUP_UNGROUPED]);
});

test('new NSFW display groups insert after IF and before ordinary groups while preserving old native and manual order', () => {
    const saved = normalizeBookConfig({ groups: [
        { id: 'normal', name: '旧普通' }, { id: 'route', name: 'IF·旧', mode: GROUP_MODES.IF_LINE },
        { id: 'phone', name: '小手机' },
    ], nativeGroupOrder: ['route', 'normal', 'phone', SPECIAL_GROUP_UNGROUPED] });
    const before = structuredClone(saved);
    const applied = applyAutoGroupProposals(saved, [proposal('变量规则'), proposal('新普通'),
        proposal('NSFW·路线甲'), proposal('IF·新', GROUP_MODES.IF_LINE), proposal('NSFW·通用')]);
    assert.deepEqual(names(applied), ['旧普通', 'IF·旧', 'IF·新', 'NSFW·路线甲', 'NSFW·通用', '新普通', '小手机', '变量规则']);
    assert.deepEqual(applied.groups.filter(({ id }) => before.groups.some((old) => old.id === id)), before.groups);
    const byId = new Map(applied.groups.map(({ id, name }) => [id, name]));
    assert.deepEqual(getNativeGroupOrder(applied).map((id) => byId.get(id) || id),
        ['IF·旧', 'IF·新', 'NSFW·路线甲', 'NSFW·通用', '旧普通', '新普通', '小手机', '变量规则', SPECIAL_GROUP_UNGROUPED]);
    assert.deepEqual(saved, before);
});

test('automatic preview uses the same stable priority as application, without reordering custom proposals', () => {
    const entries = summarize([
        { title: '=== 小手机 ===', banner: true }, { title: '消息界面' },
        { title: '=== IF·甲 ===', banner: true }, { title: '甲路线资料' },
        { title: '=== 背景 ===', banner: true }, { title: '环境资料' },
        { title: '=== IF·乙 ===', banner: true }, { title: '乙路线资料' },
        { title: '=== NSFW ===', banner: true }, { title: '中性测试选项' },
    ]);
    for (const strategy of ['smart', 'divider']) {
        const preview = detectAutoGroups(entries, { strategy });
        assert.deepEqual(preview.map(({ name }) => name), ['IF·甲', 'IF·乙', 'NSFW', '背景', '小手机']);
        assert.deepEqual(names(applyAutoGroupProposals(null, preview)), preview.map(({ name }) => name));
    }
    const custom = detectAutoGroups(entries, { customRules: [
        { group: '小手机', keywords: ['消息界面'] }, { group: 'IF·甲', keywords: ['甲路线'] },
        { group: '背景', keywords: ['环境'] }, { group: 'IF·乙', keywords: ['乙路线'] },
    ] });
    assert.deepEqual(custom.map(({ name }) => name), ['小手机', 'IF·甲', '背景', 'IF·乙']);
    assert.deepEqual(names(applyAutoGroupProposals(null, custom)), custom.map(({ name }) => name));
});

test('default ordering consumes existing modes without reclassifying line suffixes or scene groups', () => {
    const input = [proposal('小手机'), proposal('故事发展线'), proposal('NSFW·时期甲', GROUP_MODES.SCENE),
        proposal('主线'), proposal('IF·甲', GROUP_MODES.IF_LINE)];
    const before = structuredClone(input);
    const applied = applyAutoGroupProposals(null, input);
    assert.deepEqual(applied.groups.map(({ name, mode }) => ({ name, mode })), [
        { name: 'IF·甲', mode: GROUP_MODES.IF_LINE },
        { name: 'NSFW·时期甲', mode: GROUP_MODES.SCENE },
        { name: '故事发展线', mode: GROUP_MODES.NORMAL },
        { name: '主线', mode: GROUP_MODES.NORMAL },
        { name: '小手机', mode: GROUP_MODES.NORMAL },
    ]);
    assert.deepEqual(input, before);
});

test('explicit NSFW title variants outrank interleaved arrow starts and never introduce IF or scene switching', () => {
    const entries = summarize([
        { title: '↓路线甲↓', banner: true, displayIndex: 23 },
        { title: '↓路线乙↓', banner: true, displayIndex: 23 },
        { title: '【路线乙】NSFW选项甲', displayIndex: 24 },
        { title: '【路线甲】NSFW选项甲', displayIndex: 25 },
        { title: '↑路线乙↑', banner: true, displayIndex: 26 },
        { title: '【路线甲】NSFW选项乙', displayIndex: 27 },
        { title: '【路线乙】NSFW选项乙', displayIndex: 28 },
        { title: '【通用】NSFW选项', displayIndex: 29 },
        { title: '↑路线甲↑', banner: true, displayIndex: 30 },
    ]);
    const before = structuredClone(entries);
    const proposals = detectAutoGroups(entries);
    assert.deepEqual(compact(proposals), [
        { name: 'NSFW·路线乙', suggestedMode: GROUP_MODES.NORMAL, uids: ['2', '6'] },
        { name: 'NSFW·路线甲', suggestedMode: GROUP_MODES.NORMAL, uids: ['3', '5'] },
        { name: 'NSFW·通用', suggestedMode: GROUP_MODES.NORMAL, uids: ['7'] },
    ]);
    assert.equal(new Set(proposals.flatMap(({ uids }) => uids)).size, 5);
    assert.deepEqual(entries, before);
    const saved = normalizeBookConfig({ groups: [{ id: 'manual', name: '保留组', mode: GROUP_MODES.NORMAL }],
        assignments: { 3: 'manual' } });
    const repair = detectAutoGroups(entries, { existingAssignments: saved.assignments });
    assert.deepEqual(repair.find(({ name }) => name === 'NSFW·路线甲')?.uids, ['5']);
    const applied = applyAutoGroupProposals(saved, repair);
    assert.equal(applied.assignments['3'], 'manual');
    assert.deepEqual(applied.groups.find(({ id }) => id === 'manual'), saved.groups[0]);
    assert.ok(applied.groups.every(({ mode }) => mode === GROUP_MODES.NORMAL));
});

test('full authored layers split only explicit NSFW versions while keeping repair and restriction entries in their normal section', () => {
    const entries = summarize([
        { title: '=== 背景资料 ===', banner: true }, { title: '普通背景' },
        { title: '=== 人设修正与NSFW优化 ===', banner: true },
        { title: '普通人设修正' }, { title: '【常规】NSFW选项' },
        { title: '【另一背景版本】NSFW选项' }, { title: '【常规】NSFW限制说明' },
        { title: '=== 开场白场景选择 ===', banner: true },
        { title: '普通场景' }, { title: '【另一背景版本】NSFW场景' },
        { title: '=== 附加资料 ===', banner: true }, { title: '普通附注' },
    ]);
    const proposals = detectAutoGroups(entries);
    const byName = new Map(proposals.map((group) => [group.name, group]));
    assert.deepEqual(byName.get('NSFW·通用')?.uids, ['4']);
    assert.deepEqual(byName.get('NSFW·另一背景版本')?.uids, ['5']);
    assert.deepEqual(byName.get('人设修正与NSFW优化')?.uids, ['3', '6']);
    assert.deepEqual(byName.get('开场白场景选择')?.uids, ['8', '9']);
    assert.equal(byName.get('开场白场景选择')?.suggestedMode, GROUP_MODES.RADIO);
    assert.equal(byName.get('人设修正与NSFW优化')?.suggestedMode, GROUP_MODES.NORMAL);
    for (const name of ['NSFW·通用', 'NSFW·另一背景版本']) {
        assert.equal(byName.get(name)?.suggestedMode, GROUP_MODES.NORMAL);
    }
    const members = proposals.flatMap(({ uids }) => uids);
    assert.equal(new Set(members).size, members.length, 'version-specific scene items are not copied or assigned twice');
    assert.deepEqual(members.toSorted(), ['1', '3', '4', '5', '6', '8', '9', '11'].toSorted());
    assert.ok(proposals.every(({ name }) => !/\d+岁/.test(name)), 'never invent an age from a background version');
});

test('NSFW variant splitting requires explicit title versions, leaves custom schemes alone and never reads content', () => {
    const entries = summarize([
        { title: '【常规】NSFW选项' }, { title: '【另一背景版本】NSFW选项' },
        { title: '【另一背景版本】普通资料' },
    ]);
    for (const entry of entries) {
        Object.defineProperty(entry, 'content', { get() { throw new Error('body scan is forbidden'); } });
    }
    const proposals = detectAutoGroups(entries);
    assert.deepEqual(proposals.filter(({ name }) => name.startsWith('NSFW·')).map(({ name, uids }) => ({ name, uids })), [
        { name: 'NSFW·通用', uids: ['0'] }, { name: 'NSFW·另一背景版本', uids: ['1'] },
    ]);
    const custom = detectAutoGroups(entries, { customRules: [{ group: '我的自定组', keywords: ['NSFW'] }] });
    assert.deepEqual(compact(custom), [{ name: '我的自定组', suggestedMode: GROUP_MODES.NORMAL, uids: ['0', '1'] }]);

    const unknown = summarize([{ title: '【环境】NSFW甲' }, { title: '【资料】NSFW乙' }]);
    assert.equal(detectAutoGroups(unknown).some(({ name }) => name.startsWith('NSFW·')), false,
        'unrelated topics are not guessed to be routes or versions');
    const single = detectAutoGroups(summarize([{ title: '【通用线】NSFW选项' }]));
    assert.deepEqual(compact(single), [{ name: '亲密剧情 (NSFW)', suggestedMode: GROUP_MODES.SCENE, uids: ['0'] }],
        'a single existing scene keeps its established behavior');
});

test('reversed optional-operation arrows never create a range, and box-drawing separators preserve real topics', () => {
    const entries = summarize([
        { title: '===选开分割线↑===', banner: true, keys: ['可选提示'], displayIndex: 2 },
        { title: '独立资料', displayIndex: 3 },
        { title: '选开↓', banner: true, displayIndex: 4 },
        { title: '身份丨选项甲', displayIndex: 5 }, { title: '身份丨选项乙', displayIndex: 6 },
        { title: '❤️ABO-属性甲', displayIndex: 7 }, { title: '❤️ABO-属性乙', displayIndex: 8 },
        { title: '主线资料', displayIndex: 9 }, { title: 'NPC资料', displayIndex: 10 },
        { title: '=== 附加资料 ===', banner: true, displayIndex: 12 },
    ]);
    const proposals = detectAutoGroups(entries);
    assert.equal(proposals.some(({ name }) => name === '选开'), false);
    assert.deepEqual(proposals.find(({ name }) => name === '身份')?.uids, ['3', '4']);
    assert.deepEqual(proposals.find(({ name }) => name === 'ABO')?.uids, ['5', '6']);
    assert.equal(proposals.some(({ uids }) => uids.includes('7') || uids.includes('8')), false);
});

test('a pointing-hand topic bounds choices while a parenthesized operation alone is not a common topic', () => {
    const entries = summarize([
        { title: '☟时间推移☟（通用）', banner: true },
        { title: '时期辅助甲' },
        { title: '（选一）①较早时期关系' }, { title: '(选一)②较晚时期关系' },
        { title: '时期辅助乙' },
        { title: '=== 下一主题 ===', banner: true }, { title: '普通资料' },
        { title: '（选一）亲情好感阶段' }, { title: '(选一)爱情好感阶段' },
        { title: '=== 角色设定 ===', banner: true },
    ]);
    for (const strategy of ['smart', 'divider']) {
        const proposals = detectAutoGroups(entries, { strategy });
        assert.deepEqual(proposals.find(({ name }) => name === '时间推移')?.uids, ['1', '2', '3', '4']);
        assert.equal(proposals.some(({ name }) => name === '选一'), false);
        assert.equal(proposals.some(({ uids }) => uids.includes('2') && uids.includes('7')), false);
    }
    assert.equal(detectAutoGroups(entries, { strategy: 'prefix' }).some(({ name }) => name === '选一'), false);
});

test('unbracketed explicit NSFW version titles split without reading instructions or inventing ages', () => {
    const entries = summarize([
        { title: '=== 人设修正与NSFW优化 ===', banner: true },
        { title: '人设修正' }, { title: '常规nsfw（说明）' }, { title: '另一背景nsfw（与常规可二选一，也可同时开）' },
        { title: '=== 普通资料 ===', banner: true }, { title: '地点资料' },
        { title: '=== 附加资料 ===', banner: true }, { title: '备注' },
    ]);
    const proposals = detectAutoGroups(entries);
    assert.deepEqual(proposals.find(({ name }) => name === 'NSFW·通用')?.uids, ['2']);
    assert.deepEqual(proposals.find(({ name }) => name === 'NSFW·另一背景')?.uids, ['3']);
    assert.deepEqual(proposals.find(({ name }) => name === '人设修正与NSFW优化')?.uids, ['1']);
    assert.ok(proposals.filter(({ name }) => name.startsWith('NSFW·')).every(({ suggestedMode }) => suggestedMode === GROUP_MODES.NORMAL));
});

test('adjacent marked affection stages form a local normal topic without swallowing their common section', () => {
    const entries = summarize([
        { title: '☟通用+基础☟', banner: true },
        { title: '普通资料' }, { title: '状态栏' },
        { title: '(选一)1.亲情向好感阶段' }, { title: '(选一)2.爱情向好感阶段' },
        { title: '☟角色设定☟', banner: true }, { title: '角色资料' },
    ]);
    const proposals = detectAutoGroups(entries);
    assert.deepEqual(compact(proposals).find(({ name }) => name === '好感阶段'),
        { name: '好感阶段', suggestedMode: GROUP_MODES.NORMAL, uids: ['3', '4'] });
    assert.deepEqual(proposals.find(({ name }) => name === '通用+基础')?.uids, ['1', '2']);
    assert.equal(proposals.find(({ name }) => name === '通用+基础')?.suggestedMode, GROUP_MODES.NORMAL);
});

test('an authored scene-choice section with a single variant remains present instead of being extracted away', () => {
    const entries = summarize([
        { title: '=== 人设修正与NSFW优化 ===', banner: true },
        { title: '常规nsfw（说明）' }, { title: '另一背景nsfw（说明）' },
        { title: '=== 开场白场景选择 ===', banner: true },
        { title: '【另一背景版本】NSFW场景' },
        { title: '=== 附加资料 ===', banner: true }, { title: '普通附注' },
    ]);
    const proposals = detectAutoGroups(entries);
    assert.deepEqual(proposals.find(({ name }) => name === '开场白场景选择')?.uids, ['4']);
    assert.equal(proposals.find(({ name }) => name === '开场白场景选择')?.suggestedMode, GROUP_MODES.RADIO);
    assert.equal(proposals.filter(({ uids }) => uids.includes('4')).length, 1);
});

test('an explicit author choice range retains precedence over NSFW display variants', () => {
    const entries = summarize([
        { title: '↓多选一·成人路线↓', banner: true },
        { title: '【通用】NSFW选项' }, { title: '【IF·甲】NSFW选项' },
        { title: '↑多选一·成人路线↑', banner: true },
    ]);
    assert.deepEqual(compact(detectAutoGroups(entries)), [
        { name: '成人路线', suggestedMode: GROUP_MODES.RADIO, uids: ['1', '2'] },
    ]);
});

test('interleaved same-index ranges follow explicit title ownership and never guess ambiguous members', () => {
    const entries = summarize([
        { title: '↓路线甲↓', banner: true, displayIndex: 23 },
        { title: '↓路线乙↓', banner: true, displayIndex: 23 },
        { title: '【路线甲】普通资料甲', displayIndex: 24 },
        { title: '【路线乙】普通资料甲', displayIndex: 25 },
        { title: '无法证明归属的资料', displayIndex: 26 },
        { title: '↑路线乙↑', banner: true, displayIndex: 27 },
        { title: '【路线甲】普通资料乙', displayIndex: 28 },
        { title: '【路线乙】已关闭范围的资料', displayIndex: 29 },
        { title: '↑路线甲↑', banner: true, displayIndex: 30 },
    ]);
    for (const strategy of ['smart', 'divider']) {
        const proposals = detectAutoGroups(entries, { strategy });
        assert.deepEqual(proposals.find(({ name }) => name === '路线甲')?.uids, ['2', '6']);
        assert.deepEqual(proposals.find(({ name }) => name === '路线乙')?.uids, ['3']);
        assert.equal(proposals.some(({ uids }) => uids.includes('4') || uids.includes('7')), false);
    }
});

test('equal-index headers separated by content remain consecutive sections, not overlapping routes', () => {
    const entries = summarize([
        { title: '↓路线甲↓', banner: true, displayIndex: 0 },
        { title: '普通资料甲', displayIndex: 0 },
        { title: '↓路线乙↓', banner: true, displayIndex: 0 },
        { title: '普通资料乙', displayIndex: 0 },
        { title: '↑路线乙↑', banner: true, displayIndex: 0 },
    ]);
    assert.deepEqual(compact(detectAutoGroups(entries)), [
        { name: '路线甲', suggestedMode: GROUP_MODES.NORMAL, uids: ['1'] },
        { name: '路线乙', suggestedMode: GROUP_MODES.NORMAL, uids: ['3'] },
    ]);
});

test('an unmatched closing marker still stops a previous range instead of swallowing the following book', () => {
    const entries = summarize([
        { title: '↓章节资料↓', banner: true }, { title: '范围内' },
        { title: '↑其他主题↑', banner: true }, { title: '范围外' },
    ]);
    assert.deepEqual(compact(detectAutoGroups(entries)), [
        { name: '章节资料', suggestedMode: GROUP_MODES.NORMAL, uids: ['1'] },
    ]);
});

test('explicit choice labels override NSFW scene cues without changing ordinary authored ranges', () => {
    const entries = summarize([
        { title: '↓多选一·NSFW路线↓', banner: true },
        { title: '【通用】NSFW选项' }, { title: '【IF·甲】NSFW选项' },
        { title: '↑多选一·NSFW路线↑', banner: true },
    ]);
    assert.deepEqual(compact(detectAutoGroups(entries)), [
        { name: 'NSFW路线', suggestedMode: GROUP_MODES.RADIO, uids: ['1', '2'] },
    ]);
});

test('bare NSFW version extraction is confined to explicitly mixed author sections', () => {
    const entries = summarize([
        { title: '↓普通资料↓', banner: true },
        { title: '常规nsfw（说明）' }, { title: '另一背景nsfw（说明）' },
        { title: '↑普通资料↑', banner: true },
    ]);
    assert.deepEqual(compact(detectAutoGroups(entries)), [
        { name: '普通资料', suggestedMode: GROUP_MODES.NORMAL, uids: ['1', '2'] },
    ]);
});

test('operation-only delimiter prefixes do not become automatic themes', () => {
    for (const delimiter of ['：', ':', '丨', '-', '·']) {
        const entries = summarize([
            { title: `选一${delimiter}环境甲` }, { title: `选一${delimiter}环境乙` },
            { title: `选开${delimiter}选项甲` }, { title: `选开${delimiter}选项乙` },
        ]);
        for (const strategy of ['smart', 'prefix']) {
            assert.deepEqual(detectAutoGroups(entries, { strategy }), []);
        }
    }
});

test('skipping a manually grouped separator cannot make nonadjacent affection stages a local run', () => {
    const entries = summarize([
        { title: '☟通用+基础☟', banner: true },
        { title: '(选一)1.亲情向好感阶段' },
        { title: '普通独立资料' },
        { title: '(选一)2.爱情向好感阶段' },
        { title: '☟下一主题☟', banner: true },
    ]);
    const saved = normalizeBookConfig({
        groups: [{ id: 'manual', name: '手工资料', mode: GROUP_MODES.NORMAL }],
        assignments: { 2: 'manual' },
    });
    for (const strategy of ['smart', 'divider']) {
        const proposals = detectAutoGroups(entries, { strategy, existingAssignments: saved.assignments });
        assert.equal(proposals.some(({ name }) => name === '好感阶段'), false);
        assert.deepEqual(proposals.find(({ name }) => name === '通用+基础')?.uids, ['1', '3']);
        const applied = applyAutoGroupProposals(saved, proposals);
        assert.equal(applied.assignments['2'], 'manual');
        assert.deepEqual(applied.groups.find(({ id }) => id === 'manual'), saved.groups[0]);
    }
});
