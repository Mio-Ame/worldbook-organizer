import test from 'node:test';
import assert from 'node:assert/strict';
import {
    GROUP_MODES,
    buildGreetingCoordinationIndex,
    computeGreetingPresetPlan,
    detectAutoGroups,
    extractWorldbookEntrySummaries,
    formatGreetingCommentTag,
    parseGreetingCommentTags,
} from '../src/entry-groups/core.js';

function fixture() {
    const source = {
        firstMes: '<!-- lore: 0 --><!-- exclude: 3 --><!-- route: 7 -->',
        alternateGreetings: [
            '<!-- title: 场景甲 --><!-- lore: 1 -->',
            '<!-- lore: 2 --><!-- exclude: 0 -->',
        ],
        currentSwipeId: 2,
    };
    const entries = extractWorldbookEntrySummaries({ entries: Array.from({ length: 4 }, (_, uid) => ({
        uid, comment: `普通资料${uid}`, content: '中性正文', key: [],
    })) });
    return { source, entries };
}

test('greeting labels are one-based display text while swipe indexes, UID references and route protocol stay unchanged', () => {
    const { source } = fixture();
    const before = structuredClone(source);
    const index = buildGreetingCoordinationIndex(source);
    assert.deepEqual(index.greetings.map(({ label }) => label), ['第 1 条开场白', '第 2 条开场白', '第 3 条开场白']);
    assert.deepEqual(index.greetings.map(({ swipeIndex }) => swipeIndex), [0, 1, 2]);
    assert.deepEqual(index.greetings.map(({ loreUids }) => loreUids), [['0'], ['1'], ['2']]);
    assert.deepEqual(index.greetings.map(({ excludeUids }) => excludeUids), [['3'], [], ['0']]);
    assert.equal(index.greetings[0].routeNumber, 7);
    assert.equal(index.currentSwipeId, 2);
    assert.equal(index.activeGreeting, index.greetings[2]);
    assert.deepEqual(index.byUid.get('0'), {
        includeGreetings: [{ swipeIndex: 0, label: '第 1 条开场白', title: '' }],
        excludeGreetings: [{ swipeIndex: 2, label: '第 3 条开场白', title: '' }],
    });
    assert.deepEqual(source, before);
    assert.equal(formatGreetingCommentTag(['0', '2']), '<!-- lore: 0,2 -->');
    assert.deepEqual(parseGreetingCommentTags(source.firstMes), {
        title: '', desc: '', loreUids: ['0'], excludeUids: ['3'], routeNumber: 7,
    });
});

test('preset route labels use the friendly number once without shifting selection or enable plans', () => {
    const { source, entries } = fixture();
    const index = buildGreetingCoordinationIndex(source);
    const first = computeGreetingPresetPlan(entries, index, 0);
    const second = computeGreetingPresetPlan(entries, index, 1);
    const third = computeGreetingPresetPlan(entries, index, 2);
    assert.equal(first.routeLabel, '第 1 条开场白');
    assert.equal(second.routeLabel, '第 2 条开场白 场景甲');
    assert.equal(third.routeLabel, '第 3 条开场白');
    assert.deepEqual(Object.fromEntries(first.plan), { 0: false, 1: true, 2: true, 3: true });
    assert.deepEqual(Object.fromEntries(second.plan), { 0: true, 1: false, 2: true });
    assert.deepEqual(Object.fromEntries(third.plan), { 0: true, 1: true, 2: false });
    assert.equal(computeGreetingPresetPlan(entries, index, 3), null);
});

test('greeting-derived automatic fallback names have one friendly label while keys, modes and assignments remain unchanged', () => {
    const { source, entries } = fixture();
    const proposals = detectAutoGroups(entries, {
        strategy: 'greeting', greetingIndex: buildGreetingCoordinationIndex(source),
    });
    assert.deepEqual(proposals, [
        { key: 'greeting_0', name: 'IF · 第 1 条开场白', suggestedMode: GROUP_MODES.IF_LINE, uids: ['0'], source: 'greeting' },
        { key: 'greeting_1', name: 'IF · 场景甲', suggestedMode: GROUP_MODES.IF_LINE, uids: ['1'], source: 'greeting' },
        { key: 'greeting_2', name: 'IF · 第 3 条开场白', suggestedMode: GROUP_MODES.IF_LINE, uids: ['2'], source: 'greeting' },
    ]);
});

test('swipe-only indexes and empty first greeting slots retain their zero-based protocol positions', () => {
    const swipeOnly = buildGreetingCoordinationIndex({ swipes: ['<!-- lore: 8 -->', '<!-- exclude: 9 -->'], currentSwipeId: 1 });
    assert.deepEqual(swipeOnly.greetings.map(({ label, swipeIndex }) => ({ label, swipeIndex })), [
        { label: '第 1 条开场白', swipeIndex: 0 }, { label: '第 2 条开场白', swipeIndex: 1 },
    ]);
    assert.equal(swipeOnly.activeGreeting.swipeIndex, 1);
    const emptyFirst = buildGreetingCoordinationIndex({ firstMes: '', alternateGreetings: ['<!-- lore: 8 -->'] });
    assert.equal(emptyFirst.presetGreetings[0].label, '第 2 条开场白');
    assert.equal(emptyFirst.presetGreetings[0].swipeIndex, 1);
});
