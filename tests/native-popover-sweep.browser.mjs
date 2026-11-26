import assert from 'node:assert/strict';
import http from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const suite = process.env.WBO_E2E_SUITE;
if (!suite) throw new Error('Set WBO_E2E_SUITE to the retained browser regression suite');
const load = (name) => import(pathToFileURL(resolve(suite, 'lib', name)).href);
const { createMockStServer } = await load('mock-server.mjs');
const { VIEWPORTS, launchEdgeCdp } = await load('cdp.mjs');
const { createDefaultSeed } = await load('fixtures.mjs');
const { resetAndBoot } = await load('assert-helpers.mjs');
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

// Instrument only the browser response: no test exports or counters in production.
function instrument(source) {
    source = source.replace('const sweepOpenEnhancedPopovers = () => {',
        'const sweepOpenEnhancedPopovers = () => { if (window.sweepMetrics?.active) window.sweepMetrics.sweeps++;');
    for (const [name, key] of [
        ['enhanceCustomDropdownPopover', 'enhancements'],
        ['getEnhancedPopoverOptionText', 'textReads'],
        ['syncEnhancedScriptTheme', 'themeSamples'],
        ['createDropdownFilterBar', 'rebuilds'],
    ]) {
        source += `\n{ const original = ${name}; ${name} = function (...args) {
            if (window.sweepMetrics?.active) window.sweepMetrics.${key}++;
            return original.apply(this, args);
        }; }`;
    }
    return source;
}

async function withHost(verify) {
    const backend = createMockStServer();
    const upstream = await backend.start();
    const proxy = http.createServer((req, res) => {
        const request = http.request(upstream + req.url, { method: req.method, headers: req.headers }, (response) => {
            if (!req.url.endsWith('/src/native-filter.js')) {
                res.writeHead(response.statusCode, response.headers);
                response.pipe(res);
                return;
            }
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => {
                const headers = { ...response.headers };
                delete headers['content-length'];
                res.writeHead(response.statusCode, headers);
                res.end(instrument(Buffer.concat(chunks).toString('utf8')));
            });
        });
        request.on('error', (error) => res.destroy(error));
        req.pipe(request);
    });
    let cdp;
    try {
        await new Promise((done) => proxy.listen(0, '127.0.0.1', done));
        const names = Array.from({ length: 240 }, (_, i) => `Book ${String(i).padStart(3, '0')}`);
        const seed = createDefaultSeed({
            characters: [], worldbooks: Object.fromEntries(names.map((name) => [name, { entries: {} }])),
            pluginSettings: {
                autoScanNewCharacters: false, showCharBooks: true, hideCharBooksByDefault: false,
                groups: Array.from({ length: 4 }, (_, i) => ({ id: `g${i}`, name: `Group ${i}` })),
                assignments: Object.fromEntries(names.map((name, i) => [name, `g${i % 4}`])),
                pinnedBooks: [names[0]], globalHiddenGroupIds: [], editorHiddenGroupIds: [],
            },
        });
        cdp = await launchEdgeCdp();
        await resetAndBoot(cdp, `http://127.0.0.1:${proxy.address().port}`, { seed, viewport: VIEWPORTS.mobile });
        await pause(300);
        await cdp.evalFn(() => {
            const marker = document.createElement('style');
            marker.dataset.grDropdownStyle = '1';
            document.head.append(marker);
            window.mountSweepPopover = (hidden = false, nested = false) => {
                const pop = document.createElement('div');
                pop.id = 'gr-global-dropdown-container';
                pop.className = 'gr-container-enhanced';
                pop.dataset.wboSourceRole = 'global';
                pop.style.cssText = `display:${hidden ? 'none' : 'block'};position:fixed;top:120px;left:10px;width:360px;max-height:550px;overflow:hidden;background:white`;
                pop.innerHTML = '<div class="gr-options" style="max-height:500px;overflow:auto;background:white"><div class="gr-search-box"><input type="search" spellcheck="false"></div><div class="gr-options-container"></div></div>';
                for (const option of document.getElementById('world_info').options) {
                    const row = document.createElement('div');
                    row.className = 'gr-option';
                    row.dataset.value = option.value;
                    row.textContent = option.textContent;
                    pop.querySelector('.gr-options-container').append(row);
                }
                (nested ? document.getElementById('sweep-test-mount') : document.body).append(pop);
            };
            const mount = document.createElement('div');
            mount.id = 'sweep-test-mount';
            document.body.append(mount);
        });
        await verify(cdp);
        assert.deepEqual(cdp.getErrors().runtimeErrors, []);
    } finally {
        await cdp?.close();
        if (proxy.listening) await new Promise((done) => proxy.close(done));
        await backend.stop();
    }
}

async function gesture(cdp, { paired = true, delay = null } = {}) {
    await cdp.evalFn((paired, delay) => {
        window.sweepMetrics = { active: true, sweeps: 0, enhancements: 0, textReads: 0, themeSamples: 0, rebuilds: 0 };
        const select = document.getElementById('world_info');
        select.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        if (paired) select.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        if (delay !== null) setTimeout(() => window.mountSweepPopover(false, true), delay);
        else document.getElementById('gr-global-dropdown-container').style.display = 'block';
    }, paired, delay);
    await pause(280);
    return cdp.evalFn(() => {
        window.sweepMetrics.active = false;
        return {
            ...window.sweepMetrics,
            ready: document.getElementById('gr-global-dropdown-container')?.dataset.wboPopoverReady,
            rows: document.querySelectorAll('#gr-global-dropdown-container .gr-option').length,
            bars: document.querySelectorAll('#gr-global-dropdown-container .wbo-pop-filter-bar').length,
        };
    });
}

test('one opening shares its sweep batch between pointerdown and compatibility mousedown', async (t) => {
    await withHost(async (cdp) => {
        await cdp.evalFn(() => window.mountSweepPopover(true));
        await pause(50);
        const pointer = await gesture(cdp, { paired: false });
        await cdp.evalFn(() => { document.getElementById('gr-global-dropdown-container').style.display = 'none'; });
        await pause(50);
        const paired = await gesture(cdp);
        t.diagnostic(JSON.stringify({ pointer, paired }));
        assert.equal(pointer.sweeps, 3, 'keep the frame, 35ms and 110ms host-opening fallbacks');
        assert.equal(paired.sweeps, pointer.sweeps, 'the compatibility event must not schedule a second batch');
        assert.ok(paired.enhancements <= pointer.enhancements);
        assert.ok(paired.textReads <= pointer.textReads);
        assert.equal(paired.ready, '1');
        assert.equal(paired.rows, 240);
        assert.equal(paired.bars, 1);
    });
});

test('coalesced sweeps still catch delayed nested popovers and later independent openings', async (t) => {
    await withHost(async (cdp) => {
        for (const delay of [20, 65]) {
            await cdp.evalFn(() => document.getElementById('gr-global-dropdown-container')?.remove());
            const result = await gesture(cdp, { delay });
            t.diagnostic(JSON.stringify({ delay, ...result }));
            assert.equal(result.sweeps, 3);
            assert.equal(result.ready, '1', 'the fallback must enhance a popover missed by the top-level body observer');
            assert.equal(result.rows, 240);
            assert.equal(result.bars, 1);
        }
    });
});

test('an independent opening at 80ms enhances its nested popover mounted at 145ms', async (t) => {
    await withHost(async (cdp) => {
        await cdp.evalFn(() => {
            window.sweepMetrics = { active: true, sweeps: 0, enhancements: 0, textReads: 0, themeSamples: 0, rebuilds: 0 };
            const press = () => {
                const select = document.getElementById('world_info');
                select.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
                select.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            };
            press();
            window.mountSweepPopover(false, true);
            setTimeout(() => {
                document.getElementById('gr-global-dropdown-container').remove();
                press();
            }, 80);
            setTimeout(() => window.mountSweepPopover(false, true), 145);
        });
        await pause(350);
        const result = await cdp.evalFn(() => ({
            ...window.sweepMetrics,
            ready: document.getElementById('gr-global-dropdown-container')?.dataset.wboPopoverReady,
            rows: document.querySelectorAll('#gr-global-dropdown-container .gr-option').length,
            bars: document.querySelectorAll('#gr-global-dropdown-container .wbo-pop-filter-bar').length,
        }));
        t.diagnostic(JSON.stringify(result));
        assert.equal(result.ready, '1', 'a previous pending batch must not swallow the second opening');
        assert.equal(result.sweeps, 6, 'two independent openings each retain three fallbacks');
        assert.equal(result.rows, 240);
        assert.equal(result.bars, 1);
    });
});

test('stopping observers cancels a pending batch and restarting does not retain its lock', async () => {
    await withHost(async (cdp) => {
        await cdp.evalFn(async () => {
            const native = await import('/scripts/extensions/third-party/worldbook-organizer/src/native-filter.js');
            window.sweepMetrics = { active: true, sweeps: 0, enhancements: 0, textReads: 0, themeSamples: 0, rebuilds: 0 };
            const select = document.getElementById('world_info');
            select.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
            select.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            native.stopNativeObservers();
        });
        await pause(240);
        assert.equal(await cdp.evalFn(() => window.sweepMetrics.sweeps), 0);
        await cdp.evalFn(async () => {
            window.sweepMetrics.active = false;
            const native = await import('/scripts/extensions/third-party/worldbook-organizer/src/native-filter.js');
            native.startNativeObservers();
            window.mountSweepPopover(true);
        });
        await pause(50);
        const result = await gesture(cdp);
        assert.equal(result.sweeps, 3);
        assert.equal(result.ready, '1');
    });
});
