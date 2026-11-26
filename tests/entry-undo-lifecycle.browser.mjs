import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const suite = process.env.WBO_E2E_SUITE;
if (!suite) throw new Error('Set WBO_E2E_SUITE to the retained browser regression suite');
const load = (name) => import(pathToFileURL(resolve(suite, 'lib', name)).href);
const { createMockStServer } = await load('mock-server.mjs');
const { VIEWPORTS, launchEdgeCdp } = await load('cdp.mjs');
const { createDefaultSeed, makeBook, makeEntry } = await import('./entry-groups-fixtures.mjs');
const { getServerState, mutateServer, resetAndBoot, waitForCondition } = await load('assert-helpers.mjs');
const world = '撤回测试书';
const renamed = '撤回测试书改名';
const toggle = '[data-weg-group-toggle="a"]';
const undo = '[data-weg-footer-action="undo"]';

async function openPanel(cdp) {
    await cdp.evalFn((worldName) => window.dispatchEvent(new CustomEvent('weg:open-panel', { detail: { worldName } })), world);
    await waitForCondition(cdp, () => document.querySelector('[data-weg-group-toggle="a"]:enabled'));
}

async function withHost(verify, { greeting = false } = {}) {
    const server = createMockStServer();
    const baseUrl = await server.start();
    let cdp;
    try {
        cdp = await launchEdgeCdp();
        await resetAndBoot(cdp, baseUrl, { viewport: VIEWPORTS.desktop, seed: createDefaultSeed({
            characterId: greeting ? 0 : undefined,
            characters: greeting ? [{ avatar: 'undo-card.png', name: '测试角色', shallow: false,
                data: { extensions: { world }, first_mes: '<!-- lore: 0 -->',
                    alternate_greetings: ['<!-- lore: 0, 1 -->\n<!-- exclude: 2 -->'] },
            }] : [],
            selected_world_info: [],
            worldbooks: { [world]: makeBook([0, 1, 2].map((uid) => makeEntry(uid, {
                comment: `资料${uid}`, disable: uid === 1,
            }))) },
            pluginSettings: { autoScanNewCharacters: false },
            extraPluginSettingsKey: { worldbook_entry_groups: {
                autoSwitchOnChatChange: false,
                books: { [world]: { groups: [{ id: 'a', name: '测试分组' }], assignments: { 0: 'a', 1: 'a', 2: 'a' } } },
            } },
        }) });
        await verify(cdp, baseUrl);
        assert.deepEqual(cdp.getErrors().runtimeErrors, []);
    } finally {
        await cdp?.close();
        await server.stop();
    }
}

test('P1: an old undo finally cannot unlock a new switch after stop/start', async () => {
    await withHost(async (cdp, baseUrl) => {
        await openPanel(cdp);
        await cdp.clickSelector(toggle);
        await waitForCondition(cdp, async () => {
            const state = await fetch('/__test/state').then((res) => res.json());
            return Object.values(state.worldbooks['撤回测试书'].entries).every((entry) => entry.disable)
                && document.querySelector('[data-weg-footer-action="undo"]:enabled');
        });
        const before = (await getServerState(baseUrl)).worldbooks;
        await cdp.evalFn(() => {
            window.__undoRace = { arm: 'old', reads: {}, releases: {}, consumed: {}, writes: 0 };
            const original = window.fetch.bind(window);
            window.fetch = async (url, options) => {
                const race = window.__undoRace;
                const phase = String(url) === '/api/worldinfo/get' ? race.arm : '';
                if (phase) race.arm = '';
                if (String(url) === '/api/worldinfo/edit') race.writes++;
                const response = await original(url, options);
                if (phase) {
                    const json = response.json.bind(response);
                    response.json = async () => {
                        const data = await json();
                        race.consumed[phase] = true;
                        return data;
                    };
                    await new Promise((release) => {
                        race.releases[phase] = release;
                        race.reads[phase] = true;
                    });
                }
                return response;
            };
        });
        await cdp.clickSelector(undo);
        await waitForCondition(cdp, () => window.__undoRace.reads.old);
        await cdp.evalFn(async () => {
            const lifecycle = await import('/scripts/extensions/third-party/worldbook-organizer/src/entry-groups/lifecycle.js');
            lifecycle.stopEntryGrouping();
            await lifecycle.startEntryGrouping('undo-lifecycle-test');
        });
        await openPanel(cdp);
        await cdp.evalFn(() => { window.__undoRace.arm = 'new'; });
        await cdp.clickSelector(toggle);
        await waitForCondition(cdp, () => window.__undoRace.reads.new);
        assert.equal(await cdp.evalFn(() => document.querySelector('[data-weg-group-toggle="a"]')?.disabled), true);
        await cdp.evalFn(() => { window.__undoRace.releases.old(); });
        await waitForCondition(cdp, () => window.__undoRace.consumed.old);
        // Drain promise continuations and two paint turns while the new read remains held.
        await cdp.evalFn(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
        assert.equal(await cdp.evalFn(() => document.querySelector('[data-weg-group-toggle="a"]')?.disabled), true,
            'stale undo finally must not clear the new lifecycle busy flag');
        assert.equal(await cdp.evalFn(() => window.__undoRace.consumed.new === true), false);
        assert.equal(await cdp.evalFn(() => window.__undoRace.writes), 0, 'the stopped undo must not write');
        assert.deepEqual((await getServerState(baseUrl)).worldbooks, before);
        await cdp.evalFn(() => { window.__undoRace.releases.new(); });
        await waitForCondition(cdp, () => window.__undoRace.consumed.new
            && document.querySelector('[data-weg-group-toggle="a"]:enabled'));
        const after = await getServerState(baseUrl);
        assert.deepEqual([0, 1, 2].map((uid) => after.worldbooks[world].entries[uid].disable), [false, true, false]);
        assert.equal(await cdp.evalFn(() => window.__undoRace.writes), 1, 'only the new switch writes');
    });
});

test('P2: undo of an author preset restores the previous profile under the renamed world', async () => {
    await withHost(async (cdp, baseUrl) => {
        const previous = { worldName: world, routeLabel: '先前快照', ifGroupId: '',
            entryDisabledMap: { 0: false, 1: true, 2: false }, updatedAt: 123 };
        await cdp.evalFn((profile) => {
            const original = SillyTavern.getContext.bind(SillyTavern);
            window.__undoMetadata = { world_info: profile.worldName, worldbook_entry_groups: structuredClone(profile) };
            SillyTavern.getContext = () => ({ ...original(), characterId: 0,
                getCurrentChatId: () => 'undo-chat', chatMetadata: window.__undoMetadata, chat: [],
            });
            original().extensionSettings.worldbook_entry_groups.chatProfiles = {
                'undo-card.png::undo-chat': structuredClone(profile),
            };
        }, previous);
        await openPanel(cdp);
        await cdp.clickSelector('[data-weg-page="presets"]');
        await waitForCondition(cdp, () => document.querySelector('#weg-preset-greeting-select:enabled'));
        await cdp.evalFn(() => {
            const select = document.getElementById('weg-preset-greeting-select');
            select.value = '1';
            select.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await waitForCondition(cdp, () => document.querySelector('#weg-preset-result [data-weg-preset-action="undo"]:enabled'));
        const applied = await getServerState(baseUrl);
        assert.deepEqual([0, 1, 2].map((uid) => applied.worldbooks[world].entries[uid].disable), [false, false, true]);
        assert.notDeepEqual(await cdp.evalFn(() => window.__undoMetadata.worldbook_entry_groups), previous,
            'the author preset must actually replace an existing profile before testing undo');

        // Complete the mock host rename before emitting the same authoritative bridge event.
        await mutateServer(baseUrl, { addWorldbook: { name: renamed, data: applied.worldbooks[world] }, deleteWorldbook: world });
        const merge = await fetch(`${baseUrl}/api/characters/merge-attributes`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ avatar: 'undo-card.png', data: { extensions: { world: renamed } } }),
        });
        assert.equal(merge.status, 200);
        await cdp.evalFn(async ({ oldName, newName }) => {
            const ctx = SillyTavern.getContext();
            await ctx.writeExtensionField(0, 'world', newName);
            ctx.chatMetadata.world_info = newName;
            await ctx.updateWorldInfoList();
            window.dispatchEvent(new CustomEvent('wbo:worldbook-renamed', { detail: { oldName, newName } }));
        }, { oldName: world, newName: renamed });
        const migrated = await cdp.evalFn(() => {
            const ctx = SillyTavern.getContext();
            const settings = ctx.extensionSettings.worldbook_entry_groups;
            return { names: ctx.getWorldInfoNames(), primary: ctx.characters[0].data.extensions.world,
                books: Object.keys(settings.books), metadata: ctx.chatMetadata.worldbook_entry_groups.worldName,
                stored: settings.chatProfiles['undo-card.png::undo-chat'].worldName };
        });
        assert.ok(migrated.names.includes(renamed) && !migrated.names.includes(world));
        assert.ok(migrated.books.includes(renamed) && !migrated.books.includes(world));
        assert.deepEqual([migrated.primary, migrated.metadata, migrated.stored], [renamed, renamed, renamed]);
        await waitForCondition(cdp, () => document.querySelector('#weg-preset-result [data-weg-preset-action="undo"]:enabled'));
        await cdp.clickSelector('#weg-preset-result [data-weg-preset-action="undo"]');
        await waitForCondition(cdp, () => document.getElementById('weg-preset-result')?.textContent.includes('已撤回'));
        const expected = { ...previous, worldName: renamed };
        assert.deepEqual(await cdp.evalFn(() => window.__undoMetadata.worldbook_entry_groups), expected,
            'undo must not resurrect the old worldName captured inside previousProfile');
        assert.deepEqual(await cdp.evalFn(() => SillyTavern.getContext().extensionSettings.worldbook_entry_groups
            .chatProfiles['undo-card.png::undo-chat']), expected);
        const after = await getServerState(baseUrl);
        assert.equal(Object.hasOwn(after.worldbooks, world), false);
        assert.deepEqual([0, 1, 2].map((uid) => after.worldbooks[renamed].entries[uid].disable), [false, true, false]);
    }, { greeting: true });
});
