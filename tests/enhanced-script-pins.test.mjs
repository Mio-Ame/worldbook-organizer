import assert from 'node:assert/strict';
import test from 'node:test';
import { readScriptPinKeys, matchesScriptPin } from '../src/enhanced-script-pins.js';

test('script storage distinguishes unavailable state from an explicit unpin', () => {
    assert.equal(readScriptPinKeys({ getItem: () => null }, 'world_info'), null);
    assert.equal(readScriptPinKeys({ getItem: () => '{' }, 'world_info'), null);
    assert.equal(readScriptPinKeys({ getItem: () => { throw Error('blocked'); } }, 'world_info'), null);
    assert.deepEqual(readScriptPinKeys({ getItem: () => '{"pinned":{"world_info":[]}}' }, 'world_info'), []);
    assert.equal(readScriptPinKeys({ getItem: () => '{"pinned":{"world_editor_select":["x"]}}' }, 'world_info'), null);
});

test('script stable keys match native identity across fresh rows and reject duplicate-title value mismatches', () => {
    const option = { value: '4', text: 'Example', realName: 'Original' };
    for (const key of ['t\0Example', 't\0Original', 'v\u00004\0Example', '4', 'Example']) {
        assert.equal(matchesScriptPin([key], option), true, JSON.stringify(key));
    }
    for (const key of ['v\u00005\0Example', 't\0Unrelated', 'v\u00004\0Unrelated']) {
        assert.equal(matchesScriptPin([key], option), false, JSON.stringify(key));
    }
    assert.equal(matchesScriptPin([], option), false, 'clearing storage cancels pinning');
});
