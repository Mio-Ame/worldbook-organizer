import assert from 'node:assert/strict';
import test from 'node:test';
import {
    normalizeTogglePresets,
    captureTogglePreset,
    computeTogglePresetPlan,
    upsertTogglePreset,
} from '../src/entry-groups/toggle-presets.js';

const entry = (uid, disabled = false, extra = {}) => ({ uid, disabled, ...extra });
const preset = (id = 'a', name = '用户方案', states = {}) => ({ id, name, states });

test('normalization rejects invalid containers and invalid preset metadata', () => {
    for (const raw of [undefined, null, false, 0, '', {}, '[]']) {
        assert.deepEqual(normalizeTogglePresets(raw), []);
    }
    assert.deepEqual(normalizeTogglePresets([null, [], false, {},
        preset('', '名称'), preset('a', '  '), preset(1), preset('a', 1),
        Object.create(preset()),
    ]), []);
});

test('normalization trims metadata, strips extras and retains only boolean states', () => {
    const raw = [{ id: ' a ', name: ' 夜间 ', content: '不应保存', greetingIndex: 1,
        states: { 0: false, 1: true, 2: 'false', 3: 0, 4: null, 5: {}, 6: undefined, '': true, ' 7 ': false } }];
    assert.deepEqual(normalizeTogglePresets(raw), [preset('a', '夜间', { 0: false, 1: true, 7: false })]);
    for (const states of [null, [], true, 'true', 1]) {
        assert.deepEqual(normalizeTogglePresets([preset('a', '空方案', states)]), [preset('a', '空方案')]);
    }
});

test('normalization keeps the first valid ID while allowing equal names', () => {
    const raw = [preset(' a ', '  '), preset('a', '相同名称', { 0: true }),
        preset('a', '后到方案', { 0: false }), preset('b', '相同名称')];
    assert.deepEqual(normalizeTogglePresets(raw), [preset('a', '相同名称', { 0: true }), preset('b', '相同名称')]);
});

test('normalization excludes dangerous keys and inherited state properties', () => {
    const states = JSON.parse('{"__proto__":true,"constructor":false,"prototype":true,"0":false,"toString":true}');
    Object.setPrototypeOf(states, { inherited: true });
    const raw = [preset('a', '安全方案', states), preset('__proto__'), preset('constructor'), preset('prototype')];
    const result = normalizeTogglePresets(raw);
    assert.deepEqual(result, [preset('a', '安全方案', { 0: false, toString: true })]);
    assert.equal(Object.getPrototypeOf(result[0].states), Object.prototype);
    assert.equal(Object.hasOwn(result[0].states, '__proto__'), false);
    assert.equal(Object.hasOwn(result[0].states, 'inherited'), false);
    assert.equal(Object.prototype.inherited, undefined);
});

test('normalization is detached, serializable and does not mutate frozen inputs', () => {
    const raw = Object.freeze([Object.freeze(preset('a', '原名', Object.freeze({ 0: true })))]);
    const result = normalizeTogglePresets(raw);
    assert.deepEqual(normalizeTogglePresets(JSON.parse(JSON.stringify(result))), result);
    result[0].states['0'] = false;
    result[0].name = '新名';
    assert.deepEqual(raw, [preset('a', '原名', { 0: true })]);
});

test('capture stores summary UIDs and disabled flags without reading body or author presets', () => {
    const rows = [entry(0), entry('1', true), entry('banner', true, { isPureBanner: true })];
    for (const row of rows) Object.defineProperty(row, 'content', { get() { throw new Error('must not read body'); } });
    const result = captureTogglePreset(' a ', ' 日间 ', rows);
    assert.deepEqual(result, preset('a', '日间', { 0: false, 1: true }));
    assert.deepEqual(Object.keys(result), ['id', 'name', 'states']);
});

test('capture ignores invalid summaries and uses the first valid occurrence of a UID', () => {
    const rows = [null, {}, entry(true), entry(-1), entry(1.5), entry(Infinity), entry({}),
        entry(''), entry('__proto__'), entry('constructor'), entry('prototype'), entry('bad', 'false'),
        entry(0, 'false'), entry(' 0 ', true), entry(0, false), entry('1', false)];
    assert.deepEqual(captureTogglePreset('a', '方案', rows), preset('a', '方案', { 0: true, 1: false }));
});

test('capture returns null for invalid metadata and permits an empty snapshot', () => {
    assert.equal(captureTogglePreset('', '名称', []), null);
    assert.equal(captureTogglePreset('a', ' ', []), null);
    assert.equal(captureTogglePreset('__proto__', '名称', []), null);
    assert.deepEqual(captureTogglePreset('a', '空方案', null), preset('a', '空方案'));
});

test('planning returns only changed current UIDs, leaving unrecorded and newly added entries alone', () => {
    const rows = [entry('2', false), entry('0', true), entry('1', true), entry('new', true)];
    const saved = preset('a', '方案', { 0: false, 1: true, 2: true, deleted: false });
    const plan = computeTogglePresetPlan(rows, saved);
    assert.ok(plan instanceof Map);
    assert.deepEqual([...plan], [['2', true], ['0', false]]);
});

test('planning excludes banners, inherited states, unsafe UIDs and non-boolean states', () => {
    const states = JSON.parse('{"__proto__":false,"constructor":false,"prototype":false,"banner":false,"bad":"false","0":false,"toString":false}');
    Object.setPrototypeOf(states, { inherited: false });
    const rows = [entry('banner', true, { isPureBanner: true }), entry('inherited', true), entry('bad', true),
        entry('__proto__', true), entry('constructor', true), entry('prototype', true), entry(0, true), entry('toString', true)];
    assert.deepEqual([...computeTogglePresetPlan(rows, preset('a', '方案', states))], [['0', false], ['toString', false]]);
});

test('planning handles empty, invalid and repeated summaries without coercing current states', () => {
    for (const saved of [undefined, null, {}, preset('a', '方案', [])]) {
        assert.deepEqual([...computeTogglePresetPlan([entry('0', true)], saved)], []);
    }
    assert.deepEqual([...computeTogglePresetPlan(null, preset())], []);
    assert.deepEqual([...computeTogglePresetPlan([null, {}, entry('0', 'true'), entry('1', true), entry(1, false)],
        preset('a', '方案', { 0: false, 1: false }))], [['1', false]]);
});

test('user snapshots restore exact scene and route switches without adding group or chat rules', () => {
    const rows = Object.freeze([Object.freeze(entry('0', true, { mode: 'scene' })),
        Object.freeze(entry('1', true, { mode: 'if_line' })), Object.freeze(entry('2', false, { mode: 'radio' }))]);
    const saved = Object.freeze(preset('a', '用户自存', Object.freeze({ 0: false, 1: false, 2: true })));
    const before = JSON.stringify({ rows, saved });
    assert.deepEqual([...computeTogglePresetPlan(rows, saved)], [['0', false], ['1', false], ['2', true]]);
    assert.equal(JSON.stringify({ rows, saved }), before);
});

test('capture and difference plans support reverting a switch without touching new entries', () => {
    const original = [entry('0'), entry('1', true), entry('banner', false, { isPureBanner: true })];
    const before = captureTogglePreset('before', '切换前', original);
    assert.deepEqual(before, preset('before', '切换前', { 0: false, 1: true }));
    const next = preset('next', '另一方案', { 0: true, 1: false });
    const apply = (rows, plan) => rows.map(row => ({ ...row, disabled: plan.has(row.uid) ? plan.get(row.uid) : row.disabled }));
    const switched = [...apply(original, computeTogglePresetPlan(original, next)), entry('new', true)];
    assert.deepEqual(switched.map(row => row.disabled), [true, false, false, true]);
    assert.deepEqual(apply(switched, computeTogglePresetPlan(switched, before)), [...original, entry('new', true)]);
});

test('upsert replaces the same ID in place and allows different IDs with equal names', () => {
    const existing = [preset('a', '同名', { 0: false }), preset('b', '同名', { 1: true })];
    const updated = upsertTogglePreset(existing, preset(' a ', '修改名称', { 2: false }));
    assert.deepEqual(updated, [preset('a', '修改名称', { 2: false }), existing[1]]);
    assert.deepEqual(upsertTogglePreset(updated, preset('c', '同名')), [...updated, preset('c', '同名')]);
});

test('upsert ignores invalid candidates and returns normalized independent copies', () => {
    const existing = Object.freeze([Object.freeze(preset('a', '旧方案', Object.freeze({ 0: true })))]);
    const candidate = Object.freeze(preset('a', '新方案', Object.freeze({ 1: false })));
    assert.deepEqual(upsertTogglePreset(existing, null), normalizeTogglePresets(existing));
    assert.deepEqual(upsertTogglePreset(existing, preset('a', ' ')), normalizeTogglePresets(existing));
    const result = upsertTogglePreset(existing, candidate);
    result[0].states['1'] = true;
    assert.equal(candidate.states['1'], false);
    assert.equal(existing[0].states['0'], true);
});

test('the panel owns the fifty-preset limit; normalization and upsert never truncate stored presets', () => {
    const existing = Array.from({ length: 50 }, (_, i) => preset(`p${i}`, `方案${i}`));
    assert.equal(normalizeTogglePresets(existing).length, 50);
    const updated = upsertTogglePreset(existing, preset('p20', '更新方案', { 0: true }));
    assert.equal(updated.length, 50);
    assert.equal(updated[20].name, '更新方案');
    const overLimit = upsertTogglePreset(existing, preset('extra', '新增由界面拦截'));
    assert.equal(overLimit.length, 51);
    assert.equal(normalizeTogglePresets(overLimit).length, 51);
});
