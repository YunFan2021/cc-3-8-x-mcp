'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createOpener } = require('../prefab-open');
const { defineTools } = require('../tools');
const { validateArguments } = require('../validate-arguments');

const clean = { mode: 'prefab', ready: true, dirty: false, assetUuid: 'Game', rootUuid: 'old-root' };
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
    let state = { ...clean }, resolve, reject, writes = 0;
    const action = new Promise((yes, no) => { resolve = yes; reject = no; });
    const opener = createOpener({ resolve: async uuid => ({ uuid }), context: async () => ({ ...state }),
        open: async uuid => { writes++; state = { ...clean, assetUuid: uuid, rootUuid: uuid + '-root' }; },
        timeoutMs: 30, pollMs: 1 });
    return { opener, action, resolve, reject, writes: () => writes, state: patch => { state = { ...state, ...patch }; } };
}

test('超时后的明确拒绝保留真实错误，恢复失败状态后可以切换 Hall', async () => {
    const f = fixture();
    const first = await f.opener.runEditorAction('reload', { expectedAssetUuid: 'Game' }, () => f.action);
    assert.equal(first.requestOutcome, 'pending');
    assert.equal(first.settledAt, null);
    assert.equal(first.lockActive, true);
    f.reject(TypeError('reload handler failed'));
    await flush();
    const recovered = await f.opener.queryStatus(first.operationId);
    assert.equal(recovered.status, 'failed');
    assert.equal(recovered.kind, 'reload');
    assert.equal(recovered.reason, 'EDITOR_REQUEST_FAILED');
    assert.equal(recovered.timedOut, true);
    assert.equal(recovered.requestOutcome, 'rejected');
    assert.equal(recovered.requestError.message, 'reload handler failed');
    assert.ok(recovered.settledAt >= recovered.startedAt);
    assert.equal(recovered.lockActive, false);
    assert.equal(recovered.recovery, null);
    assert.equal(first.requestOutcome, 'pending'); // 已返回快照不被迟到回调改写。
    assert.equal((await f.opener('Hall')).status, 'opened');
    assert.equal(f.writes(), 1);
});

test('传输拒绝即使页面和根节点已更新也不能恢复或写入', async () => {
    for (const error of [Object.assign(Error('remote timeout'), { code: 'TIMEOUT' }), Error('IPC channel closed'), Error('No response received'), Error('unclassified failure'), TypeError('IPC disconnected')]) {
        const f = fixture();
        const first = await f.opener.runEditorAction('reload', {}, () => f.action);
        f.reject(error); await flush();
        f.state({ rootUuid: 'new-root' });
        const result = await f.opener.recover({ operationId: first.operationId, expectedAssetUuid: 'Game', expectedRootUuid: 'new-root' });
        assert.equal(result.status, 'unconfirmed');
        assert.equal(result.requestOutcome, 'rejected');
        assert.equal(result.lockActive, true);
        assert.equal(result.recovery, 'REMOTE_EFFECT_UNCONFIRMED');
        assert.equal((await f.opener('Hall')).status, 'pending');
        assert.equal(f.writes(), 0);
    }
});

test('仍在执行时只能读已打开目标，不能伪装为旧请求完成或解除保存保护', async () => {
    const f = fixture();
    const first = await f.opener.runEditorAction('reload', {}, () => f.action);
    f.state({ dirty: true });
    const read = await f.opener('Game');
    assert.equal(read.status, 'already_open');
    assert.equal(read.readOnly, true);
    assert.equal(read.context.dirty, true);
    assert.equal(read.blockingOperation.operationId, first.operationId);
    assert.equal(read.blockingOperation.requestOutcome, 'pending');
    assert.equal(read.lockActive, true);
    assert.equal((await f.opener.runEditorAction('save', { expectedAssetUuid: 'Game' }, assert.fail)).status, 'pending');
    f.resolve(); await flush();
});

test('人工接手恢复必须匹配操作与实例，脏页面和未知状态不解除失败锁', async () => {
    const f = fixture();
    const first = await f.opener.runEditorAction('reload', {}, () => f.action);
    f.reject(TypeError('handler failed')); await flush();
    assert.equal((await f.opener.recover({ operationId: 'wrong', expectedAssetUuid: 'Game', expectedRootUuid: 'old-root' })).status, 'not_found');
    assert.equal((await f.opener.recover({ operationId: first.operationId, expectedAssetUuid: 'Hall', expectedRootUuid: 'old-root' })).recoveryBlocked, 'CONTEXT_CONFLICT');
    assert.equal((await f.opener.recover({ operationId: first.operationId, expectedAssetUuid: 'Game', expectedRootUuid: 'stale-root' })).recoveryBlocked, 'CONTEXT_CONFLICT');
    for (const patch of [{ dirty: true }, { dirty: null }, { dirty: false, ready: false }, { ready: true, rootUuid: null }]) {
        f.state(patch);
        assert.equal((await f.opener.queryStatus(first.operationId)).lockActive, true);
    }
    f.state({ ...clean, assetUuid: 'Hall', rootUuid: 'hall-root' });
    const result = await f.opener.recover({ operationId: first.operationId, expectedAssetUuid: 'Hall', expectedRootUuid: 'hall-root' });
    assert.equal(result.status, 'failed');
    assert.equal(result.lockActive, false);
    assert.equal(f.writes(), 0);
});

test('消息成功但目标未加载不能自动收尾，人工切页只能显式标记接手', async () => {
    const f = fixture();
    const first = await f.opener('Other'); // 正常打开，用独立未完成请求检验后续路径。
    assert.equal(first.status, 'opened');
    const reload = await f.opener.runEditorAction('reload', {}, () => f.action);
    f.resolve(); await flush();
    f.state({ assetUuid: 'Hall', rootUuid: 'hall-root' });
    assert.equal((await f.opener.queryStatus(reload.operationId)).lockActive, true);
    const recovered = await f.opener.recover({ operationId: reload.operationId, expectedAssetUuid: 'Hall', expectedRootUuid: 'hall-root' });
    assert.equal(recovered.status, 'superseded');
    assert.equal(recovered.lockActive, false);
    assert.equal(recovered.reason, 'CONTEXT_SUPERSEDED');
});

test('连续上下文变化时不恢复，之后稳定的查询可以恢复', async () => {
    let calls = 0, changing = false;
    const opener = createOpener({ resolve: assert.fail, open: assert.fail,
        context: async () => ({ ...clean, rootUuid: changing ? 'root-' + calls++ : clean.rootUuid }) });
    const first = await opener.runEditorAction('reload', {}, () => { throw TypeError('handler failed'); });
    changing = true;
    assert.equal((await opener.queryStatus(first.operationId)).lockActive, true);
    changing = false;
    assert.equal((await opener.queryStatus(first.operationId)).lockActive, false);
});

test('保存、导入和编辑的明确失败不能被恢复查询标为成功', async () => {
    for (const kind of ['save', 'import', 'edit']) {
        const f = fixture();
        const result = await f.opener.runEditorAction(kind, { expectedAssetUuid: 'Game' }, () => { throw TypeError('handler failed'); });
        const recovered = await f.opener.queryStatus(result.operationId);
        assert.equal(recovered.status, 'failed');
        assert.equal(recovered.lockActive, false);
    }
});

test('恢复入口验证参数且只调用恢复查询', async () => {
    let calls = 0;
    const tool = defineTools({ msg: assert.fail, local: { recoverPrefabOperation: args => { calls++; return args; } } })
        .find(t => t.name === 'prefab_recover_operation');
    const valid = { operationId: 'op', expectedAssetUuid: 'Game', expectedRootUuid: 'root' };
    for (const args of [{}, { operationId: 'op' }, { ...valid, force: true }])
        assert.equal(validateArguments(tool.inputSchema, args).code, 'INVALID_ARGUMENTS');
    assert.equal(validateArguments(tool.inputSchema, valid), null);
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.deepEqual(await tool.handler(valid), valid);
    assert.equal(calls, 1);
});

test('并发旧查询不能清掉新操作的保护', async () => {
    let count = 0, pause = false, releaseQuery, releaseReload;
    const opener = createOpener({ resolve: assert.fail, open: assert.fail, timeoutMs: 50,
        context: async () => {
            if (pause && ++count === 2) await new Promise(resolve => { releaseQuery = resolve; });
            return { ...clean };
        } });
    const failed = await opener.runEditorAction('reload', {}, () => { throw TypeError('handler failed'); });
    pause = true;
    const oldQuery = opener.queryStatus(failed.operationId);
    while (!releaseQuery) await flush();
    assert.equal((await opener.queryStatus(failed.operationId)).lockActive, false);
    const next = await opener.runEditorAction('reload', {}, () => new Promise(resolve => { releaseReload = resolve; }));
    assert.notEqual(next.operationId, failed.operationId);
    releaseQuery(); await oldQuery;
    const nextQuery = await opener.queryStatus(next.operationId);
    assert.equal(nextQuery.requestOutcome, 'pending');
    assert.equal(nextQuery.lockActive, true);
    releaseReload(); await flush();
});

test('未派发写入的迟到预检失败不遗留锁，非 Error 拒绝仍保守保护', async () => {
    const f = fixture();
    const first = await f.opener.runEditorAction('import', {}, () => f.action, undefined, true);
    assert.equal(first.dispatched, false);
    f.reject(Object.assign(Error('timeout'), { code: 'TIMEOUT' })); await flush();
    assert.equal((await f.opener.queryStatus(first.operationId)).lockActive, false);
    assert.equal((await f.opener('Hall')).status, 'opened');
    const rejected = await f.opener.runEditorAction('reload', {}, () => Promise.reject(null));
    const queried = await f.opener.queryStatus(rejected.operationId);
    assert.equal(queried.requestError.category, 'unknown');
    assert.equal(queried.lockActive, true);
});
