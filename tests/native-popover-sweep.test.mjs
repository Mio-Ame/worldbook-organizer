import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../src/native-filter.js', import.meta.url), 'utf8');
const start = source.indexOf('    const sweepOpenEnhancedPopovers = () => {');
const end = source.indexOf('    _docDrawerGuardMouseDown = (ev) => {', start);
assert.ok(start >= 0 && end > start, 'exercise the actual production scheduling block');

function harness() {
    let now = 0;
    let sequence = 0;
    const pending = new Map();
    const sweeps = [];
    const enhanced = [];
    let visible = [];
    class Surface { isConnected = true; }
    const enqueue = (callback, delay) => {
        const id = ++sequence;
        pending.set(id, { at: now + delay, callback });
        return id;
    };
    const context = vm.createContext({
        _observersActive: true,
        _sweepPopoverTimers: new Set(),
        Date: { now: () => now },
        HTMLElement: Surface,
        ENHANCED_POPOVER_SELECTORS: { containerSelector: '.test-popover' },
        document: { querySelectorAll: () => { sweeps.push(now); return visible; } },
        enhanceCustomDropdownPopover: (node) => enhanced.push({ node, at: now }),
        setTimeout: enqueue,
        scheduleEnhancedRaf: (callback) => enqueue(callback, 16),
    });
    vm.runInContext(`${source.slice(start, end)}\nglobalThis.schedule = schedulePopoverSweep;`, context);
    return {
        sweeps, enhanced,
        press: (target, type) => context.schedule({ target, type }),
        pair(target) { this.press(target, 'pointerdown'); this.press(target, 'mousedown'); },
        show: () => { const node = new Surface(); visible = [node]; return node; },
        hide: () => { visible = []; },
        disable: () => { context._observersActive = false; },
        advance(until) {
            for (;;) {
                const next = [...pending].filter(([, job]) => job.at <= until)
                    .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
                if (!next) break;
                pending.delete(next[0]);
                now = next[1].at;
                next[1].callback();
            }
            now = until;
        },
    };
}

test('a pointer and its compatibility mouse event share exactly three fallbacks', () => {
    const h = harness();
    h.pair({});
    h.advance(250);
    assert.deepEqual(h.sweeps, [16, 35, 110]);
});

for (const sameTarget of [true, false]) {
    test(`an independent opening at 80ms keeps its 190ms fallback (${sameTarget ? 'same' : 'different'} target)`, (t) => {
        const h = harness();
        const firstTarget = {};
        h.show();
        h.pair(firstTarget);
        h.advance(80);
        h.hide();
        h.pair(sameTarget ? firstTarget : {});
        h.advance(145);
        const latePopover = h.show();
        h.advance(250);
        const lateEnhancements = h.enhanced.filter(({ node }) => node === latePopover);
        t.diagnostic(JSON.stringify({ sweeps: h.sweeps, lateEnhancements: lateEnhancements.length }));
        assert.equal(lateEnhancements.length, 1, 'the second opening must enhance its nested popover mounted at 145ms');
        assert.deepEqual(h.sweeps, [16, 35, 96, 110, 115, 190]);
    });
}

test('compatibility matching consumes only one mousedown', () => {
    const h = harness();
    const target = {};
    h.pair(target);
    h.advance(80);
    h.press(target, 'mousedown');
    h.advance(250);
    assert.equal(h.sweeps.length, 6, 'a later mouse-only opening is independent');
});

test('mousedown on another target is not consumed by an earlier pointer', () => {
    const h = harness();
    h.press({}, 'pointerdown');
    h.advance(20);
    h.press({}, 'mousedown');
    h.advance(250);
    assert.equal(h.sweeps.length, 6);
});

test('an expired pointer cannot consume a later mouse-only opening', () => {
    const h = harness();
    const target = {};
    h.press(target, 'pointerdown');
    h.advance(1000);
    h.press(target, 'mousedown');
    h.advance(1250);
    assert.equal(h.sweeps.length, 6);
});

test('disabled observers do not schedule an opening', () => {
    const h = harness();
    h.disable();
    h.pair({});
    h.advance(250);
    assert.deepEqual(h.sweeps, []);
});

test('both global and editor opening paths pass their event to the scheduler', () => {
    assert.equal([...source.matchAll(/schedulePopoverSweep\(ev\);/g)].length, 2);
});
