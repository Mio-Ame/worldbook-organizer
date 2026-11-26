import test from 'node:test';
import assert from 'node:assert/strict';
import { cloneBookConfig, isBookConfigEmpty, migrateSettingsOnWorldRename, normalizeSettings } from '../src/entry-groups/core.js';

const preset = { id: 'p1', name: '日常方案', states: { 0: false, 1: true } };

test('switch presets survive settings normalization without requiring any groups', () => {
    const settings = normalizeSettings({ books: { '测试书': { togglePresets: [preset] } } });
    assert.deepEqual(settings.books['测试书']?.togglePresets, [preset]);
    assert.equal(isBookConfigEmpty(settings.books['测试书']), false);
    const clone = cloneBookConfig(settings.books['测试书']);
    clone.togglePresets[0].states['0'] = true;
    assert.equal(settings.books['测试书'].togglePresets[0].states['0'], false);
});

test('renaming a worldbook preserves its named switch presets', () => {
    const settings = { books: { '旧测试书': { togglePresets: [preset] } } };
    assert.equal(migrateSettingsOnWorldRename(settings, '旧测试书', '新测试书'), true);
    assert.deepEqual(settings.books['新测试书'].togglePresets, [preset]);
    assert.equal(settings.books['旧测试书'], undefined);
});

test('operation backup survives normalizing and cloning without saving content', () => {
    const settings = normalizeSettings({ books: { '测试书': { toggleBackup: { createdAt: 123, states: { 0: false, 1: true }, content: '不保存' } } } });
    assert.deepEqual(settings.books['测试书']?.toggleBackup, { createdAt: 123, states: { 0: false, 1: true } });
    const clone = cloneBookConfig(settings.books['测试书']);
    clone.toggleBackup.states['1'] = false;
    assert.equal(settings.books['测试书'].toggleBackup.states['1'], true);
});
