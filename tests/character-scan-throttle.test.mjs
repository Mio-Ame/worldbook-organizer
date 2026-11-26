import assert from 'node:assert/strict';
import test from 'node:test';
import { scanShallowCharactersInBatches } from '../src/host.js';

async function measureScan(t, { width, coarse = false, cancel = false }) {
    const old = Object.fromEntries(['SillyTavern', 'innerWidth', 'matchMedia'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    globalThis.SillyTavern = { getContext: () => ({ characters: [] }) };
    globalThis.innerWidth = width;
    globalThis.matchMedia = () => ({ matches: coarse });
    t.after(() => {
        for (const [key, descriptor] of Object.entries(old)) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    });
    let active = 0;
    let peak = 0;
    const reads = [];
    const signal = { cancelled: false };
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        assert.equal(url, '/api/characters/get');
        const avatar = JSON.parse(options.body).avatar_url;
        reads.push(avatar);
        peak = Math.max(peak, ++active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return Response.json({ avatar, name: '测试角色', data: {
            description: '正文不应留存', extensions: { world: '测试书' },
            character_book: { name: '测试内嵌书', entries: [{ uid: 0, content: '条目正文不应留存' }] },
        } });
    });
    const targets = Array.from({ length: 4 }, (_, i) => ({ avatar: `card-${i}.png`, name: '测试角色', chid: i }));
    const progress = [];
    const result = await scanShallowCharactersInBatches(targets, { signal,
        onProgress: (done) => { progress.push(done); if (cancel) signal.cancelled = true; } });
    assert.equal(JSON.stringify(result.scanned).includes('正文不应'), false);
    return { peak, reads, progress, result };
}

for (const device of [{ width: 390 }, { width: 1200, coarse: true }]) {
    test(`mobile character scans read one card at a time (${device.width}, coarse ${!!device.coarse})`, async (t) => {
        const scan = await measureScan(t, device);
        assert.equal(scan.peak, 1);
        assert.deepEqual(scan.progress, [1, 2, 3, 4]);
        assert.equal(scan.result.scanned.length, 4);
    });
}

test('desktop character scans retain two-card throughput without confirmation steps', async (t) => {
    const scan = await measureScan(t, { width: 1280 });
    assert.equal(scan.peak, 2);
    assert.equal(scan.result.done, 4);
});

test('stopping a mobile scan prevents the next card read and keeps completed summaries', async (t) => {
    const scan = await measureScan(t, { width: 390, cancel: true });
    assert.equal(scan.reads.length, 1);
    assert.equal(scan.result.scanned.length, 1);
    assert.equal(scan.result.cancelled, true);
});
