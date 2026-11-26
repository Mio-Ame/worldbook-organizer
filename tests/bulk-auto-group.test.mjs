import assert from 'node:assert/strict';
import test from 'node:test';
import { scanWorldbooksForEntryGroups } from '../src/entry-groups/bulk-auto-group.js';

function setup(t, { fail = [], onFetch } = {}) {
    const reads = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        assert.equal(url, '/api/worldinfo/get', 'scan may only read worldbooks');
        const { name } = JSON.parse(options.body);
        reads.push(name);
        onFetch?.(name);
        if (fail.includes(name)) return Response.json({ invalid: true });
        return Response.json({ entries: Array.from({ length: 5 }, (_, uid) => ({
            uid, displayIndex: uid, comment: `【背景】资料${uid}`, content: '正文不应留在扫描结果中', key: [],
        })) });
    });
    return reads;
}

const options = (extra = {}) => ({
    bookConfigs: {}, strategy: 'prefix', onlyUngrouped: true,
    signal: new AbortController().signal, ...extra,
});

test('one scan batch stops at its boundary and continuation reads each book only once', async (t) => {
    const reads = setup(t);
    const worlds = Array.from({ length: 12 }, (_, i) => `测试书${i}`);
    const progress = [];
    const first = await scanWorldbooksForEntryGroups(worlds, options({ batchSize: 5, onProgress: (n) => progress.push(n) }));
    assert.deepEqual(reads, worlds.slice(0, 5));
    assert.equal(first.nextIndex, 5);
    assert.equal(first.processed, 5);
    assert.equal(first.total, 12);
    assert.equal(first.plans.size, 5);
    const second = await scanWorldbooksForEntryGroups(worlds, options({ startIndex: first.nextIndex, batchSize: 5,
        onProgress: (n) => progress.push(n) }));
    const third = await scanWorldbooksForEntryGroups(worlds, options({ startIndex: second.nextIndex, batchSize: 5,
        onProgress: (n) => progress.push(n) }));
    assert.equal(second.nextIndex, 10);
    assert.equal(third.nextIndex, 12);
    assert.equal(third.processed, 2);
    assert.deepEqual(reads, worlds);
    assert.deepEqual(progress, worlds.map((_, i) => i + 1));
    assert.equal(second.plans.has(worlds[0]), false, 'each result retains only its own batch');
});

test('failed reads still advance the cursor; scans retain only bounded title examples and UID proposals', async (t) => {
    setup(t, { fail: ['失败测试书'] });
    const result = await scanWorldbooksForEntryGroups(['正常测试书', '失败测试书'], options({ batchSize: 5 }));
    assert.equal(result.nextIndex, 2);
    assert.deepEqual(result.failed, ['失败测试书']);
    const [group] = result.plans.get('正常测试书');
    assert.equal(group.uids.length, 5);
    assert.deepEqual(group.examples, [0, 1, 2].map((uid) => ({ uid: String(uid), title: `【背景】资料${uid}` })));
    assert.equal(JSON.stringify(result.plans.get('正常测试书')).includes('正文不应'), false);
});

test('immediately resolved reads yield a browser turn before loading the next book', async (t) => {
    let yielded = false;
    let timer;
    setup(t, { onFetch: (world) => { if (world === '乙') assert.equal(yielded, true); } });
    try {
        await scanWorldbooksForEntryGroups(['甲', '乙'], options({ batchSize: 5,
            onProgress: (n) => { if (n === 1) timer = setTimeout(() => { yielded = true; }, 0); } }));
    } finally { clearTimeout(timer); }
});

test('abort between books stops immediately and preserves the cursor for a safe continuation', async (t) => {
    const reads = setup(t);
    const controller = new AbortController();
    const result = await scanWorldbooksForEntryGroups(['甲', '乙', '丙'], options({ batchSize: 5,
        signal: controller.signal, onProgress: () => controller.abort() }));
    assert.deepEqual(reads, ['甲']);
    assert.equal(result.nextIndex, 1);
    assert.equal(result.processed, 1);
    assert.equal(result.plans.size, 1);
});

test('an already aborted scan reads nothing and emits no progress', async (t) => {
    const reads = setup(t);
    const controller = new AbortController();
    controller.abort();
    const result = await scanWorldbooksForEntryGroups(['甲'], options({ signal: controller.signal,
        startIndex: 0, batchSize: 5, onProgress: () => assert.fail('aborted scan must stay quiet') }));
    assert.deepEqual(reads, []);
    assert.equal(result.nextIndex, 0);
    assert.equal(result.plans.size, 0);
});
