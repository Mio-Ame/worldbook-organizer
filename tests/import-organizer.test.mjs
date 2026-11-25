import assert from 'node:assert/strict';
import test from 'node:test';
import { exportConfigData, importConfigData, normalizeSettings } from '../src/core.js';
import * as organize from '../src/import-organizer.js';

const groups = [
    { id: 'custom', name: '测试自定义组' },
    { id: 'adult', name: '成人向' },
];

test('title rules honor first-match priority, preserve groups, and protect all character books', () => {
    assert.equal(typeof organize.planImportedWorldbooks, 'function');
    const settings = normalizeSettings({
        groups,
        assignments: { '规则已有组': 'adult' },
        aliases: { '普通书': '规则别名' },
        charBookOverrides: { '规则角色手动': 'include_in_char', '规则角色附加': 'exclude_from_char' },
        importOrganize: { rules: [{ keyword: '规则', groupId: 'custom' }, { keyword: '规则', groupId: 'adult' }], sensitiveGroupId: 'adult' },
        includeExtraCharBooks: false,
        includeEmbeddedNameMatch: false,
    });
    const titles = ['规则普通书', '成人向样例', '普通书', '规则已有组', '规则角色主书', '规则角色附加', '规则角色内嵌', '规则角色手动', '规则同名角色'];
    const characters = [{
        avatar: 'fixture.png',
        name: '规则同名角色',
        data: { extensions: { world: '规则角色主书' }, character_book: { name: '规则角色内嵌' } },
    }];
    assert.deepEqual(organize.planImportedWorldbooks({
        settings, titles, characters, charLore: [{ name: 'fixture', extraBooks: ['规则角色附加'] }],
    }), [
        { title: '规则普通书', groupId: 'custom' },
        { title: '成人向样例', groupId: 'adult' },
    ]);
});

test('intro can reach upgraded users with no groups and remembers a decision in backup', () => {
    assert.equal(typeof organize.findSensitiveImportCandidates, 'function');
    const settings = normalizeSettings({ groups: [] });
    assert.deepEqual(organize.findSensitiveImportCandidates({
        settings, titles: ['普通书', '成人向样例'], characters: [],
    }), ['成人向样例']);
    settings.importOrganize.sensitivePromptSeen = true;
    const restored = normalizeSettings(null);
    assert.equal(importConfigData(restored, exportConfigData(settings)).ok, true);
    assert.equal(restored.importOrganize.sensitivePromptSeen, true);
});

test('file chooser tracking only confirms newly added titles associated with a selected file', () => {
    assert.equal(typeof organize.createWorldbookImportTracker, 'function');
    const tracker = organize.createWorldbookImportTracker();
    tracker.capture(['同名旧书.json', '新增书.json', '失败书.json'], ['同名旧书'], 1000);
    assert.deepEqual(tracker.collect(['同名旧书', '新建书', '新增书'], 2000), ['新增书']);
    assert.deepEqual(tracker.collect(['同名旧书', '新建书', '新增书'], 3000), []);
    assert.deepEqual(tracker.collect(['失败书'], 1000 + 5 * 60_000 + 1), []);
});
