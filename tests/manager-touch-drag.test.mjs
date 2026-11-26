import assert from 'node:assert/strict';
import test from 'node:test';

test('touch handle resolves the drop under the finger, and cancel never drops', async () => {
    const { bindManagerTouchDrag } = await import('../src/manager-touch-drag.js');
    const root = new EventTarget();
    const handle = { closest: (selector) => selector.includes('drag-handle') ? handle : null };
    const target = { name: 'destination' };
    root.contains = (el) => el === handle || el === target;
    root.ownerDocument = { elementFromPoint: () => target };
    root.setPointerCapture = () => {};
    root.releasePointerCapture = () => {};
    root.hasPointerCapture = () => true;
    root.querySelector = () => null;
    const calls = [];
    const dispose = bindManagerTouchDrag(root, {
        start: (ev) => calls.push(['start', ev.target]),
        over: (ev) => calls.push(['over', ev.target]),
        drop: (ev) => calls.push(['drop', ev.target]),
        cancel: () => calls.push(['cancel']),
    });
    const send = (type, values = {}) => {
        const ev = new Event(type, { cancelable: true });
        Object.defineProperties(ev, Object.fromEntries(Object.entries({ pointerId: 1, pointerType: 'touch',
            isPrimary: true, button: 0, clientX: 20, clientY: 80, target: handle, ...values })
            .map(([key, value]) => [key, { value }])));
        root.dispatchEvent(ev);
        return ev;
    };
    assert.equal(send('pointerdown').defaultPrevented, true);
    send('pointerup');
    assert.equal(calls.some(([kind]) => kind === 'drop'), false, 'a tap is not a drag');
    send('pointerdown');
    send('pointermove', { clientY: 40 });
    send('pointerup', { clientY: 30 });
    assert.deepEqual(calls.filter(([kind]) => kind !== 'cancel'), [
        ['start', handle], ['over', target], ['over', target], ['drop', target],
    ], 'pointer capture must not make the source the drop destination');
    calls.length = 0;
    send('pointerdown');
    send('pointermove', { clientY: 30 });
    send('pointercancel');
    assert.equal(calls.some(([kind]) => kind === 'drop'), false);
    assert.equal(calls.at(-1)[0], 'cancel');
    calls.length = 0;
    send('pointerdown', { pointerType: 'mouse' });
    send('pointermove', { pointerType: 'mouse', clientY: 30 });
    send('pointerup', { pointerType: 'mouse', clientY: 30 });
    assert.deepEqual(calls, [], 'desktop HTML drag must not run twice');
    dispose();
    send('pointerdown');
    send('pointermove', { clientY: 30 });
    send('pointerup', { clientY: 30 });
    assert.equal(calls.some(([kind]) => kind === 'drop'), false, 'disposing removes touch listeners');
});

test('active touch frames stop when the document is hidden or the manager is detached', async () => {
    const { bindManagerTouchDrag } = await import('../src/manager-touch-drag.js');
    const root = new EventTarget();
    const doc = new EventTarget();
    const handle = { closest: () => handle };
    root.contains = () => true;
    root.ownerDocument = doc;
    root.isConnected = true;
    doc.elementFromPoint = () => handle;
    root.querySelector = () => null;
    const frames = new Map();
    let id = 0;
    let cancelled = 0;
    const originalRaf = globalThis.requestAnimationFrame;
    const originalCancel = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = (fn) => { frames.set(++id, fn); return id; };
    globalThis.cancelAnimationFrame = (key) => frames.delete(key);
    const dispose = bindManagerTouchDrag(root, { start() {}, over() {}, drop() {}, cancel() { cancelled++; } });
    const send = (type, y) => {
        const event = new Event(type, { cancelable: true });
        Object.defineProperties(event, Object.fromEntries(Object.entries({ target: handle, pointerType: 'touch',
            pointerId: 1, isPrimary: true, button: 0, clientX: 20, clientY: y }).map(([key, value]) => [key, { value }])));
        root.dispatchEvent(event);
    };
    try {
        send('pointerdown', 80); send('pointermove', 40);
        assert.equal(frames.size, 1);
        doc.hidden = true;
        doc.dispatchEvent(new Event('visibilitychange'));
        assert.equal(frames.size, 0, 'backgrounding must release active animation work');
        assert.equal(cancelled, 1);
        doc.hidden = false;
        send('pointerdown', 80); send('pointermove', 40);
        root.isConnected = false;
        const pending = [...frames.values()]; frames.clear(); pending.forEach((fn) => fn());
        assert.equal(frames.size, 0, 'detaching must not requeue a drag frame');
        assert.equal(cancelled, 2);
    } finally {
        dispose();
        globalThis.requestAnimationFrame = originalRaf;
        globalThis.cancelAnimationFrame = originalCancel;
    }
});
