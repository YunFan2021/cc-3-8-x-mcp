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

test('共享锁阻止 Prefab 打开期间保存或重载', async () => {
    let release;
    const opener = createOpener({ resolve: async () => ({ uuid: 'b' }), context: async () => current,
        open: () => new Promise(done => { release = done; }), timeoutMs: 20 });
    const running = opener('b');
    assert.equal((await opener.runEditorAction('reload', {}, assert.fail)).status, 'busy');
    await running;
    assert.equal((await opener.runEditorAction('save', { expectedAssetUuid: 'a' }, assert.fail)).status, 'pending');
    release();
});

test('保存必须指定当前资源，重载必须已保存', async () => {
    let state = { ...current, dirty: true }, writes = 0;
    const opener = createOpener({ resolve: assert.fail, context: async () => state, open: assert.fail });
    const action = () => { writes++; state = { ...state, dirty: false }; };
    assert.equal((await opener.runEditorAction('save', {}, action)).reason, 'EXPECTED_RESOURCE_REQUIRED');
    assert.equal((await opener.runEditorAction('save', { expectedAssetUuid: 'wrong' }, action)).reason, 'CONTEXT_CONFLICT');
    assert.equal((await opener.runEditorAction('reload', {}, action)).reason, 'UNSAVED');
    assert.equal(writes, 0);
    assert.equal((await opener.runEditorAction('save', { expectedAssetUuid: 'a' }, action)).status, 'completed');
    assert.equal(writes, 1);
});

test('检查期间页面变化时阻止实际消息', async () => {
    let count = 0;
    const opener = createOpener({ resolve: assert.fail, context: async () => ({ ...current, assetUuid: ++count === 1 ? 'a' : 'b' }), open: assert.fail });
    assert.equal((await opener.runEditorAction('reload', {}, assert.fail)).reason, 'CONTEXT_CONFLICT');
});

test('重载超时后保持保护，完成消息与实例确认后可恢复', async () => {
    let release;
    const opener = createOpener({ resolve: async () => ({ uuid: 'a' }), context: async () => current, open: assert.fail, timeoutMs: 20 });
    const result = await opener.runEditorAction('reload', {}, () => new Promise(done => { release = done; }));
    assert.equal(result.status, 'unconfirmed');
    assert.equal((await opener('a')).status, 'pending');
    release(); await new Promise(done => setImmediate(done));
    assert.equal((await opener.queryStatus(result.operationId)).status, 'completed');
    assert.equal((await opener('a')).status, 'already_open');
});

test('参数校验遵循顶层必填及封闭字段，同时允许任意脚本参数', () => {
    const { defineTools } = require('../tools');
    const { validateArguments } = require('../validate-arguments');
    const tools = defineTools({ msg() {}, local: {} });
    const schema = name => tools.find(t => t.name === name).inputSchema;
    for (const value of [null, [], false, { uuid: 3 }, { uuid: 'a', unexpected: true }])
        assert.equal(validateArguments(schema('scene_query_node'), value).code, 'INVALID_ARGUMENTS');
    assert.equal(validateArguments(schema('scene_save_scene'), {}).code, 'INVALID_ARGUMENTS');
    assert.equal(validateArguments(schema('scene_execute_script'), { extension: 'x', method: 'y', args: [null, { free: 'value' }] }), null);
    assert.equal(validateArguments(schema('scene_set_property'), { uuid: 'a', path: 'name', dump: { type: 'String', value: 'n' } }), null);
});

test('属性写入进入共享保护并配对 begin/end recording，失败也结束记录', async () => {
    const calls = [];
    const { defineTools } = require('../tools');
    const tool = defineTools({
        msg: async (...args) => {
            calls.push(args);
            if (args[1] === 'begin-recording') return 'undo-id';
            if (args[1] === 'set-property') return false;
        },
        local: { runEditorAction: async (kind, args, action) => {
            assert.equal(kind, 'edit');
            assert.equal(args.expectedAssetUuid, 'asset');
            return action({ write: fn => fn() });
        } },
    }).find(t => t.name === 'scene_set_property');
    await assert.rejects(tool.handler({ uuid: 'node', path: 'name', dump: { type: 'String', value: 'n' }, expectedAssetUuid: 'asset' }), /PROPERTY_WRITE_REJECTED/);
    assert.deepEqual(calls.map(a => a[1]), ['begin-recording', 'set-property', 'end-recording']);
    assert.deepEqual(calls[2], ['scene', 'end-recording', 'undo-id']);
});
