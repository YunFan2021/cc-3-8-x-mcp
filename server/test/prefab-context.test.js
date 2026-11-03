'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createOpener, resolvePrefab } = require('../prefab-open');
const { queryContext } = require('../prefab-context');

const current = { mode: 'prefab', ready: true, dirty: false, assetUuid: 'a', rootUuid: 'node' };

test('unsaved, unknown dirty, and incomplete roots block editor writes', async () => {
    for (const patch of [{ dirty: true }, { dirty: null }, { rootUuid: null }, { ready: false }]) {
        let writes = 0;
        const open = createOpener({ resolve: async () => ({ uuid: 'b' }), context: async () => ({ ...current, ...patch }), open: () => writes++ });
        assert.equal((await open('b')).status, 'blocked');
        assert.equal(writes, 0);
    }
});

test('already open preserves even an unsaved instance', async () => {
    const open = createOpener({ resolve: async () => ({ uuid: 'a' }), context: async () => ({ ...current, dirty: true }), open: assert.fail });
    assert.equal((await open('a')).status, 'already_open');
});

test('timeout and late completion do not trigger duplicate or competing opens', async () => {
    let release, active = current, writes = 0;
    const open = createOpener({ resolve: async uuid => ({ uuid }), context: async () => active,
        open: () => { writes++; return new Promise(done => { release = done; }); }, timeoutMs: 30, pollMs: 1 });
    const first = open('b');
    assert.equal((await open('c')).status, 'busy');
    assert.equal((await first).status, 'unconfirmed');
    assert.equal((await open('c')).status, 'pending');
    release();
    await Promise.resolve();
    assert.equal((await open('b')).status, 'pending');
    active = { ...current, assetUuid: 'b' };
    assert.equal((await open('b')).status, 'already_open');
    assert.equal(writes, 1);
});

test('context rejects a snapshot spanning two different editor assets', async () => {
    let count = 0;
    const msg = async (_, name) => ({
        'query-asset-info': { uuid: 'a', type: 'cc.Prefab' },
        'query-node-tree': { children: [{ uuid: 'node', prefab: { assetUuid: 'a' } }] },
        'query-scene-mode': 'prefab', 'query-is-ready': true, 'query-dirty': false,
    })[name] ?? (count++ === 0 ? 'a' : 'b');
    const result = await queryContext(msg, '/project');
    assert.equal(result.rootUuid, null);
    assert.equal(result.dirty, null);
});

test('resolver excludes non-prefabs, foreign files, traversal and subassets', async t => {
    const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-prefab-'));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    fs.mkdirSync(path.join(tmp, 'assets'));
    const good = path.join(tmp, 'assets', 'A.prefab'), outside = path.join(tmp, 'A.prefab');
    for (const f of [good, outside]) fs.writeFileSync(f, '');
    const info = { uuid: 'id', type: 'cc.Prefab', file: good, url: 'db://assets/A.prefab' };
    assert.equal((await resolvePrefab(async () => info, tmp, good)).uuid, 'id');
    for (const key of [outside, 'db://assets/../A.prefab', 'db://assets/A.prefab@sub']) {
        await assert.rejects(resolvePrefab(async () => info, tmp, key));
    }
    await assert.rejects(resolvePrefab(async () => ({ ...info, type: 'cc.SceneAsset' }), tmp, good));
});

test('status query confirms late arrival without issuing another open', async () => {
    let release, state = current, writes = 0;
    const open = createOpener({ resolve: async () => ({ uuid: 'b' }), context: async () => state,
        open: () => { writes++; return new Promise(done => { release = done; }); }, timeoutMs: 20 });
    const first = await open('b');
    assert.equal(first.status, 'unconfirmed');
    assert.equal(first.dispatched, true);
    assert.equal((await open.queryStatus('unknown')).status, 'not_found');
    state = { ...current, assetUuid: 'b' };
    assert.equal((await open.queryStatus(first.operationId)).settled, false);
    release(); await Promise.resolve(); await Promise.resolve();
    assert.equal((await open.queryStatus(first.operationId)).status, 'opened');
    assert.equal(writes, 1);
    assert.equal(first.status, 'unconfirmed');
});

test('preflight timeout cannot issue a delayed open and allows a new request', async () => {
    let release, calls = 0, writes = 0;
    const open = createOpener({ resolve: async () => {
        if (++calls === 1) return new Promise(done => { release = done; });
        return { uuid: 'a' };
    }, context: async () => current, open: () => writes++, timeoutMs: 20 });
    assert.equal((await open('a')).status, 'failed');
    assert.equal((await open('a')).status, 'already_open');
    release({ uuid: 'b' }); await new Promise(done => setImmediate(done));
    assert.equal(writes, 0);
});

test('rejected editor request retains protection and exposes its phase', async () => {
    const open = createOpener({ resolve: async () => ({ uuid: 'b' }), context: async () => current,
        open: () => { throw Error('message failed'); } });
    const result = await open('b');
    assert.equal(result.reason, 'EDITOR_REQUEST_FAILED');
    assert.equal(result.phase, 'opening');
    assert.equal(result.settled, true);
    assert.equal((await open('c')).status, 'pending');
});

test('context message timeout is bounded and late completion cannot mutate diagnostics', async () => {
    let release;
    const msg = (_, name) => {
        if (name === 'query-dirty') return new Promise(done => { release = done; });
        return Promise.resolve({ 'query-current-scene': 'a', 'query-scene-mode': 'prefab', 'query-is-ready': true }[name]);
    };
    const result = await queryContext(msg, '/project', { timeoutMs: 20 });
    assert.equal(result.ready, false);
    assert.ok(result.diagnostics.some(d => d.code === 'TIMEOUT'));
    const before = JSON.stringify(result);
    release(false); await new Promise(done => setImmediate(done));
    assert.equal(JSON.stringify(result), before);
});

test('scene contexts retain roots, dirty states and sync message failure diagnostics', async () => {
    for (const dirty of [true, false, null]) {
        const result = await queryContext((_, name) => {
            if (name === 'query-dirty' && dirty === null) throw Error('unsupported');
            return Promise.resolve({
                'query-current-scene': 'a', 'query-scene-mode': 'general', 'query-is-ready': true,
                'query-dirty': dirty, 'query-asset-info': { uuid: 'a', type: 'cc.SceneAsset', url: 'db://assets/A.scene' },
                'query-node-tree': { uuid: 'scene-root', type: 'cc.Scene' },
            }[name]);
        }, '/project');
        assert.equal(result.rootUuid, 'scene-root');
        assert.equal(result.dirty, dirty);
        if (dirty === null) assert.ok(result.diagnostics.some(d => d.code === 'MESSAGE_FAILED'));
    }
});
