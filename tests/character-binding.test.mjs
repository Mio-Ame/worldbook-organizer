import assert from 'node:assert/strict';
import test from 'node:test';
import * as host from '../src/host.js';

function setup(t) {
    const avatar = 'test-character.png';
    const card = { avatar, name: '测试角色', data: { extensions: { world: '旧书', custom: 42 } } };
    const character = { avatar, name: card.name, shallow: true };
    const settings = { cachedCharBindings: {} };
    const worlds = ['旧书', '新书'];
    const writes = [];
    const context = { characters: [character], getWorldInfoNames: () => worlds };
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        if (url === '/api/characters/get') {
            assert.deepEqual(JSON.parse(options.body), { avatar_url: avatar });
            return Response.json(card);
        }
        if (url !== '/api/characters/merge-attributes') throw new Error('Unexpected endpoint');
        writes.push(JSON.parse(options.body));
        return new Response(null, { status: 200 });
    });
    const before = globalThis.SillyTavern;
    globalThis.SillyTavern = { getContext: () => context };
    t.after(() => {
        if (before === undefined) delete globalThis.SillyTavern;
        else globalThis.SillyTavern = before;
    });
    assert.equal(typeof host.bindWorldbookToCharacter, 'function');
    return { avatar, settings, character, card, writes, worlds };
}

test('primary binding refuses a stale or unconfirmed replacement', async (t) => {
    const { avatar, settings, card, writes } = setup(t);
    for (const expectedPrimary of [undefined, '', '较早的主书']) {
        const result = await host.bindWorldbookToCharacter(avatar, '新书', { kind: 'primary', expectedPrimary, settings });
        assert.equal(result.ok, false);
    }
    assert.equal(writes.length, 0);
    assert.equal(card.data.extensions.world, '旧书');
    assert.deepEqual(settings.cachedCharBindings, {});
});

test('confirmed primary binding patches only the selected card and updates the shallow cache', async (t) => {
    const { avatar, settings, character, writes } = setup(t);
    const result = await host.bindWorldbookToCharacter(avatar, '新书', { kind: 'primary', expectedPrimary: '旧书', settings });
    assert.equal(result.ok, true);
    assert.deepEqual(writes, [{ avatar, data: { extensions: { world: '新书' } } }]);
    assert.equal(settings.cachedCharBindings[avatar].primary, '新书');
    assert.equal(character.shallow, true);
    assert.equal(character.data, undefined);
});

test('missing worldbook and deleted character cannot start a binding write', async (t) => {
    const { avatar, settings, writes, worlds } = setup(t);
    worlds.pop();
    const res = await host.bindWorldbookToCharacter(avatar, '新书', { kind: 'primary', expectedPrimary: '旧书', settings });
    assert.equal(res.ok, false);
    assert.match(res.error, /发布/);
    const gone = await host.bindWorldbookToCharacter('deleted.png', '旧书', { kind: 'extra', settings });
    assert.equal(gone.ok, false);
    assert.equal(writes.length, 0);
});
