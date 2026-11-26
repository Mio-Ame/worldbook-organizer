import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const suite = process.env.WBO_E2E_SUITE;
if (!suite) throw new Error('Set WBO_E2E_SUITE to the retained browser regression suite');
const load = (name) => import(pathToFileURL(resolve(suite, 'lib', name)).href);
const { createMockStServer } = await load('mock-server.mjs');
const { VIEWPORTS, launchEdgeCdp } = await load('cdp.mjs');
const { createDefaultSeed, makeBook, makeEntry } = await import('./entry-groups-fixtures.mjs');
const { getServerState, resetAndBoot, waitForCondition } = await load('assert-helpers.mjs');
const world = '控件测试书';

async function withPanel(device, count, verify, { greeting = false, chat = false, viewport = VIEWPORTS[device] } = {}) {
    const server = createMockStServer();
    const baseUrl = await server.start();
    let cdp;
    try {
        cdp = await launchEdgeCdp();
        await resetAndBoot(cdp, baseUrl, { viewport, seed: createDefaultSeed({
            characters: greeting ? [{ avatar: 'test-card.png', name: '测试角色', shallow: false,
                data: { extensions: { world }, first_mes: '<!-- title: 开场甲 -->\n<!-- lore: 0 -->',
                    alternate_greetings: ['<!-- title: 开场乙 -->\n<!-- lore: 0, 1 -->\n<!-- exclude: 2 -->',
                        '<!-- title: 开场丙 -->\n<!-- lore: 0 -->', '<!-- title: 开场丁 -->\n<!-- lore: 0 -->'] },
            }] : [],
            selected_world_info: [], worldbooks: { [world]: makeBook(Array.from({ length: count }, (_, uid) => makeEntry(uid, { comment: `资料${uid}` }))) },
            pluginSettings: { autoScanNewCharacters: false },
            extraPluginSettingsKey: { worldbook_entry_groups: { books: {} } },
        }) });
        if (chat) await cdp.evalFn(() => {
            const original = SillyTavern.getContext.bind(SillyTavern);
            window.__controlsChatMetadata = {};
            SillyTavern.getContext = () => ({ ...original(),
                getCurrentChatId: () => '测试聊天保存文件名很长但不应挤占工具栏',
                chatMetadata: window.__controlsChatMetadata, chat: [],
            });
        });
        await cdp.evalFn((worldName) => window.dispatchEvent(new CustomEvent('weg:open-panel', { detail: { worldName } })), world);
        await waitForCondition(cdp, () => document.querySelector('#weg-body .weg-entry-row'));
        await verify(cdp, baseUrl);
        assert.deepEqual(cdp.getErrors().runtimeErrors, []);
    } finally {
        await cdp?.close();
        await server.stop();
    }
}

for (const device of ['desktop', 'mobile']) {
    test(`${device}: greeting preset selection is prominent, expandable and keeps native selection`, async () => {
        await withPanel(device, 3, async (cdp, baseUrl) => {
            await cdp.clickSelector('[data-weg-page="presets"]');
            await waitForCondition(cdp, () => document.getElementById('weg-preset-greeting-select'));
            const control = await cdp.evalFn(() => {
                const el = document.getElementById('weg-preset-greeting-select');
                const style = getComputedStyle(el);
                const rect = el.getBoundingClientRect();
                return { tag: el.tagName, text: el.options[0].textContent, appearance: style.appearance,
                    weight: Number(style.fontWeight), width: rect.width, right: rect.right, viewport: innerWidth,
                    options: el.options.length, disabled: el.disabled, accent: el.classList.contains('weg-greeting-preset-select'),
                    names: [...el.options].slice(1).map((option) => option.textContent) };
            });
            assert.equal(control.tag, 'SELECT');
            assert.equal(control.appearance, 'auto', 'native dropdown arrow remains visible');
            assert.equal(control.accent, true, 'only this selector receives its accent treatment');
            assert.ok(control.weight >= 600, 'the action is distinguishable from plain status text');
            assert.match(control.text, /套用开场方案/);
            assert.ok(control.right <= control.viewport && control.width >= 140);
            assert.equal(control.options, 5);
            assert.equal(control.disabled, false);
            assert.match(control.names[0], /第 1 条开场白/);
            assert.equal(control.names.some((name) => /#[0-9]/.test(name)), false);
            const badges = await cdp.evalFn(() => [...document.querySelectorAll('#weg-body .weg-greet-tag')]
                .map((el) => ({ text: el.textContent.trim(), tip: el.title })));
            assert.deepEqual(badges.map(({ text }) => text), ['被 4 条开场白引用', '被第 2 条开场白引用', '指定开场方案中关闭']);
            assert.match(badges[2].tip, /套用.*第 2 条开场白.*关闭此条目/);
            const before = await getServerState(baseUrl);
            await cdp.evalFn(() => {
                const el = document.getElementById('weg-preset-greeting-select');
                el.value = '1';
                el.dispatchEvent(new Event('change', { bubbles: true }));
            });
            await waitForCondition(cdp, () => {
                const el = document.getElementById('weg-preset-greeting-select');
                return el && !el.disabled && el.value === '';
            });
            const after = await getServerState(baseUrl);
            assert.equal(after.metrics.worldEditCalls.length - before.metrics.worldEditCalls.length, 1, 'one selection applies once');
        }, { greeting: true });
    });

    test(`${device}: incremental entry rendering hides duplicate final-batch action`, async () => {
        await withPanel(device, 150, async (cdp) => {
            assert.equal(await cdp.evalFn(() => document.querySelectorAll('#weg-body .weg-entry-row').length), 60);
            assert.equal(await cdp.evalFn(() => document.getElementById('weg-btn-load-all')?.hidden), false);
            await cdp.evalFn(() => document.getElementById('weg-btn-load-more-60').click());
            assert.equal(await cdp.evalFn(() => document.querySelectorAll('#weg-body .weg-entry-row').length), 120);
            assert.equal(await cdp.evalFn(() => document.getElementById('weg-btn-load-all')?.hidden ?? true), true,
                'with only 30 remaining, do not offer two equivalent actions');
            assert.equal(await cdp.evalFn(() => document.getElementById('weg-btn-load-more-60').textContent.trim()), '继续加载 30 条');
            await cdp.evalFn(() => document.getElementById('weg-btn-load-more-60').click());
            assert.equal(await cdp.evalFn(() => document.querySelectorAll('#weg-body .weg-entry-row').length), 150);
            assert.equal(await cdp.evalFn(() => Boolean(document.getElementById('weg-load-more-bar'))), false);
        });
    });

    test(`${device}: chat snapshots have their own page and batch selection belongs with entry actions`, async () => {
        await withPanel(device, 3, async (cdp, baseUrl) => {
            await cdp.clickSelector('[data-weg-page="presets"]');
            const initial = await cdp.evalFn(() => ({
                text: document.getElementById('weg-save-bar').textContent,
                batchInActions: Boolean(document.querySelector('.weg-group-tools [data-weg-footer-action="enter-batch"]')),
                help: Boolean(document.querySelector('#weg-save-bar details summary')),
                label: document.querySelector('[data-weg-save-action="bind-current"]')?.textContent.trim(),
            }));
            assert.equal(initial.batchInActions, true);
            assert.equal(initial.help, false, 'avoid verbose help blocks');
            assert.equal(initial.text.includes('测试聊天保存文件名'), false);
            assert.equal(initial.text.includes('暂未锁线'), false);
            assert.equal(initial.label, '保存快照');
            assert.match(initial.text, /保存当前条目开关方案/);
            const before = await getServerState(baseUrl);
            await cdp.clickSelector('[data-weg-save-action="bind-current"]');
            assert.equal(await cdp.evalFn(() => document.querySelector('[data-weg-save-action="bind-current"]').textContent.trim()), '更新快照');
            assert.equal(await cdp.evalFn(() => document.querySelector('[data-weg-save-action="unbind-current"]').textContent.trim()), '清除快照');
            const remembered = await cdp.evalFn(() => window.__controlsChatMetadata.worldbook_entry_groups);
            assert.deepEqual(remembered.entryDisabledMap, { 0: false, 1: false, 2: false });
            writeFileSync(resolve(tmpdir(), `wbo-entry-controls-${device}.png`), Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
            await cdp.clickSelector('[data-weg-save-action="unbind-current"]');
            assert.equal(await cdp.evalFn(() => Boolean(window.__controlsChatMetadata.worldbook_entry_groups)), false);
            const after = await getServerState(baseUrl);
            assert.deepEqual(after.worldbooks, before.worldbooks);
            assert.deepEqual(after.metrics.worldEditCalls, before.metrics.worldEditCalls, 'record/clear never toggles entries');
            const overflow = await cdp.evalFn(() => [...document.querySelectorAll('#weg-save-bar, .weg-group-tools, .weg-save-bar-actions')]
                .filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.className));
            assert.deepEqual(overflow, []);
        }, { greeting: true, chat: true });
    });
}

test('narrow mobile chat controls remain reachable without horizontal overflow', async () => {
    await withPanel('mobile', 3, async (cdp) => {
        await cdp.clickSelector('[data-weg-page="presets"]');
        await cdp.clickSelector('[data-weg-save-action="bind-current"]');
        const controls = await cdp.evalFn(() => [...document.querySelectorAll('#weg-save-bar select, #weg-save-bar button')]
            .map((el) => { const r = el.getBoundingClientRect(); return { id: el.id || el.dataset.wegSaveAction || el.dataset.wegFooterAction,
                left: r.left, right: r.right, width: r.width, height: r.height, overflow: el.scrollWidth - el.clientWidth }; }));
        assert.equal(controls.every((r) => r.left >= 0 && r.right <= 320 && r.width > 40 && r.height >= 24 && r.overflow <= 1), true, JSON.stringify(controls));
    }, { greeting: true, chat: true, viewport: { ...VIEWPORTS.mobile, width: 320, height: 640 } });
});
