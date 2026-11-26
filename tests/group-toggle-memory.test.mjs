import assert from 'node:assert/strict';
import test from 'node:test';
import * as core from '../src/entry-groups/core.js';

const entry = (uid, disabled = false) => ({ uid, disabled, isPureBanner: false });
const config = (mode = 'normal') => ({ groups: [{ id: 'a', name: '测试组', mode }], assignments: { 0: 'a', 1: 'a', 2: 'a' } });
const apply = (entries, plan) => entries.map((entry) => ({ ...entry, disabled: plan.has(entry.uid) ? plan.get(entry.uid) : entry.disabled }));

test('paused states survive normalization, cloning and pin-free ungrouped settings without retaining moved entries', () => {
    const source = { ...config(), pausedGroupStates: { a: { 0: false, 1: true, outside: false, invalid: 'false' }, missing: { 9: false },
        __ungrouped__: { 8: false, 0: false } } };
    const normalized = core.normalizeBookConfig(source);
    assert.deepEqual(normalized.pausedGroupStates, { a: { 0: false, 1: true }, __ungrouped__: { 8: false } });
    const copy = core.cloneBookConfig(normalized);
    copy.pausedGroupStates.a['0'] = true;
    assert.equal(normalized.pausedGroupStates.a['0'], false, 'undo snapshots must not share nested state maps');
    const settings = core.normalizeSettings({ books: { '记忆测试书': { pausedGroupStates: { __ungrouped__: { 8: false } } } } });
    assert.deepEqual(settings.books['记忆测试书'].pausedGroupStates, { __ungrouped__: { 8: false } });
    core.pruneOrphanAssignments(normalized, new Set(['0', '2']));
    assert.deepEqual(normalized.pausedGroupStates, { a: { 0: false } });
    core.removeGroupFromBookConfig(normalized, 'a');
    assert.deepEqual(normalized.pausedGroupStates, {});
});

test('mixed group pauses directly and restores the exact previous mix after serialization', () => {
    const entries = [entry('0'), entry('1', true), entry('2')];
    const before = config();
    const paused = core.computeRememberedGroupToggle(entries, before, 'a');
    assert.equal(paused.targetEnabled, false);
    assert.deepEqual([...paused.plan], [['0', true], ['1', true], ['2', true]]);
    assert.deepEqual(paused.pausedGroupStates, { a: { 0: false, 1: true, 2: false } });
    const restored = core.computeRememberedGroupToggle(apply(entries, paused.plan), JSON.parse(JSON.stringify({ ...before,
        pausedGroupStates: paused.pausedGroupStates })), 'a');
    assert.equal(restored.restoring, true);
    assert.deepEqual(apply(entries, restored.plan), entries);
    assert.deepEqual(before, config(), 'planning does not mutate settings before a successful write');
});

test('explicit enable-all bypasses remembered mix; first activation without a snapshot also enables all', () => {
    const entries = [entry('0', true), entry('1', true), entry('2', true)];
    const saved = { ...config(), pausedGroupStates: { a: { 0: false, 1: true, 2: false } } };
    const all = core.computeRememberedGroupToggle(entries, saved, 'a', true, { allEnabled: true });
    assert.deepEqual(apply(entries, all.plan).map((entry) => entry.disabled), [false, false, false]);
    assert.deepEqual(all.pausedGroupStates, {});
    const first = core.computeRememberedGroupToggle(entries, config(), 'a');
    assert.deepEqual(apply(entries, first.plan).map((entry) => entry.disabled), [false, false, false]);
});

test('restore ignores moved and deleted entries and preserves newly added entry states', () => {
    const saved = { ...config(), assignments: { 0: 'a', 1: 'a', 3: 'a' },
        pausedGroupStates: { a: { 0: false, 1: true, 2: false } } };
    const entries = [entry('0', true), entry('1', true), entry('2', true), entry('3', true)];
    const restored = core.computeRememberedGroupToggle(entries, saved, 'a');
    assert.deepEqual(apply(entries, restored.plan).map((entry) => entry.disabled), [false, true, true, true]);
    assert.equal(restored.plan.has('2'), false, 'a moved entry must not be re-enabled');
});

test('IF route activation remembers the outgoing mix and restoring it still closes the current route', () => {
    const cfg = { groups: [{ id: 'a', name: '甲线', mode: 'if_line' }, { id: 'b', name: '乙线', mode: 'if_line' }],
        assignments: { 0: 'a', 1: 'a', 2: 'b', 3: 'b' } };
    const initial = [entry('0'), entry('1', true), entry('2', true), entry('3', true)];
    const toB = core.computeRememberedGroupToggle(initial, cfg, 'b');
    assert.deepEqual(toB.pausedGroupStates.a, { 0: false, 1: true });
    const back = core.computeRememberedGroupToggle(apply(initial, toB.plan), { ...cfg, pausedGroupStates: toB.pausedGroupStates }, 'a');
    assert.deepEqual(apply(apply(initial, toB.plan), back.plan).map((entry) => entry.disabled), [false, true, true, true]);
    assert.deepEqual(back.pausedGroupStates.b, { 2: false, 3: false });
});

test('radio memory restores the original selected entry and never enables multiple entries', () => {
    const initial = [entry('0', true), entry('1'), entry('2', true)];
    const cfg = config('radio');
    const paused = core.computeRememberedGroupToggle(initial, cfg, 'a');
    const restored = core.computeRememberedGroupToggle(apply(initial, paused.plan), { ...cfg, pausedGroupStates: paused.pausedGroupStates }, 'a');
    assert.deepEqual(apply(initial, restored.plan).map((entry) => entry.disabled), [true, false, true]);
    const all = core.computeRememberedGroupToggle(apply(initial, paused.plan), cfg, 'a', true, { allEnabled: true });
    assert.equal([...all.plan.values()].filter((disabled) => !disabled).length, 1);
});

test('ungrouped memory and scene groups preserve mixed states and never toggle decorative banners', () => {
    for (const group of ['__ungrouped__', 'a']) {
        const cfg = group === 'a' ? config('scene') : {};
        const initial = [entry('0'), entry('1', true), { ...entry('2'), isPureBanner: true }];
        const paused = core.computeRememberedGroupToggle(initial, cfg, group);
        assert.equal(paused.plan.has('2'), false);
        assert.deepEqual(paused.pausedGroupStates[group], { 0: false, 1: true });
        const restored = core.computeRememberedGroupToggle(apply(initial, paused.plan), { ...cfg, pausedGroupStates: paused.pausedGroupStates }, group);
        assert.deepEqual(apply(initial, restored.plan), initial);
    }
});

test('renaming a book preserves paused states and merging remaps groups without overriding destination choices', () => {
    const cfg = { ...config(), pausedGroupStates: { a: { 0: false, 1: true, 2: false } } };
    const settings = { books: { '旧测试书': cfg } };
    core.migrateSettingsOnWorldRename(settings, '旧测试书', '新测试书');
    assert.deepEqual(settings.books['新测试书'].pausedGroupStates, cfg.pausedGroupStates);
    const merged = { books: { '旧测试书': cfg, '新测试书': {
        groups: [{ id: 'b', name: '测试组' }], assignments: { 1: 'b' }, pausedGroupStates: { b: { 1: false } },
    } } };
    core.migrateSettingsOnWorldRename(merged, '旧测试书', '新测试书');
    assert.deepEqual(core.normalizeBookConfig(merged.books['新测试书']).pausedGroupStates, { b: { 0: false, 1: false, 2: false } });
});
