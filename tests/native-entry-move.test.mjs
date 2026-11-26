import assert from 'node:assert/strict';
import test from 'node:test';
import { planNativeEntryMove } from '../src/entry-groups/entry-reorder.js';
const entries = Object.fromEntries([0, 1, 2, 3].map((uid) => [uid, { uid, displayIndex: uid, order: 100, content: '保留' }]));
const config = { groups: [{ id: 'a', name: '甲' }, { id: 'b', name: '乙' }], assignments: { 0: 'a', 1: 'a', 2: 'b', 3: 'b' } };
test('native row moves reorder within a group without mutating source fields', () => {
    assert.deepEqual(planNativeEntryMove(entries, config, '1', 'a', '0', false), ['1', '0', '2', '3']);
    assert.equal(entries[1].displayIndex, 1);
    assert.equal(entries[1].order, 100);
});
test('native drops can cross groups onto rows or group headers', () => {
    assert.deepEqual(planNativeEntryMove(entries, config, '0', 'b', '2', true), ['1', '2', '0', '3']);
    assert.deepEqual(planNativeEntryMove(entries, config, '0', 'b', null, true), ['1', '2', '3', '0']);
    assert.deepEqual(planNativeEntryMove(entries, config, '0', 'missing', null, true), []);
    assert.deepEqual(planNativeEntryMove(entries, config, '0', 'b', '1', true), []);
    assert.equal(config.assignments[0], 'a');
});
