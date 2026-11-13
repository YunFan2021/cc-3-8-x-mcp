'use strict';

const fs = require('fs');
const path = require('path');

// 仅接受本项目 assets 中的 Prefab 主资源。用真实路径防止符号链接越界。
async function resolvePrefab(msg, projectPath, asset) {
    if (typeof asset !== 'string' || !asset.trim()) throw Error('INVALID_PREFAB');
    const assets = fs.realpathSync(path.join(projectPath, 'assets'));
    function relative(file) {
        const rel = path.relative(assets, fs.realpathSync(file));
        if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw Error('OUTSIDE_PROJECT');
        return rel.split(path.sep).join('/');
    }
    const key = path.isAbsolute(asset) ? 'db://assets/' + relative(asset) : asset;
    if (!/^db:\/\/assets\/(?!.*(?:^|\/)\.\.?(?:\/|$))[^?#\\]+\.prefab$/i.test(key) &&
        !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(key)) throw Error('INVALID_PREFAB');
    const info = await msg('asset-db', 'query-asset-info', key);
    if (!info || !info.uuid || !info.file || info.type !== 'cc.Prefab' || info.invalid ||
        info.url !== 'db://assets/' + relative(info.file) || !info.url.endsWith('.prefab') ||
        (key !== info.url && key !== info.uuid)) throw Error('INVALID_PREFAB');
    return info;
}

// 每个 Bridge 仅保留最近一次操作；ID 含实例随机前缀，扩展重载后旧 ID 不能匹配新操作。
function createOpener({ resolve, context, open, timeoutMs = 12000, pollMs = 150 }) {
    const { createDeadline } = require('./bounded');
    const instance = require('crypto').randomBytes(6).toString('hex');
    let sequence = 0, busy = false, pending = null, latest = null;
    const loaded = (c, uuid) => c?.ready === true && c.mode === 'prefab' && c.assetUuid === uuid && !!c.rootUuid;

    // 请求结果与编辑器完成条件分开：失败不能伪装成功，传输中断也不能当作远端已停止。
    const confirmed = (op, c) => op.kind
        ? op.settled && !op.requestFailed && c?.ready === true && c.assetUuid === op.target.uuid &&
            !!c.rootUuid && (op.kind !== 'scene' || c.mode === 'scene') && (op.kind !== 'save' || c.dirty === false)
        : loaded(c, op.target.uuid);

    const stable = (a, b) => a?.ready === true && b?.ready === true && !!a.rootUuid &&
        a.assetUuid === b.assetUuid && a.rootUuid === b.rootUuid && a.mode === b.mode &&
        ['prefab', 'scene'].includes(a.mode) && a.dirty === false && b.dirty === false;

    // 传输超时、断连等拒绝只说明调用方结束；未知远端副作用仍须保留保护。
    function requestError(error) {
        const code = typeof error?.code === 'string' ? error.code : null;
        const name = typeof error?.name === 'string' ? error.name : null;
        const message = String(error?.message || error || 'Unknown request error').slice(0, 1000);
        const transport = /TIME.?OUT|TIMED.?OUT|ECONN|EPIPE|CHANNEL|IPC|DISCONNECT|CONNECTION|CLOSED|DESTROYED|TERMINATED|NO RESPONSE|超时|断开|连接.*关闭/i.test((code || '') + ' ' + message);
        // 仅识别执行异常和本扩展自己的明确拒绝；未知 Error 不按排除法假定远端停止。
        const execution = /^(TypeError|ReferenceError|RangeError|SyntaxError)$/.test(name || '') ||
            /^(TypeError|ReferenceError|RangeError|SyntaxError):/.test(message) ||
            ['PROPERTY_WRITE_REJECTED', 'INVALID_ASSET', 'OUTSIDE_PROJECT'].includes(code || message);
        return { code, name, message, category: transport ? 'transport' : execution ? 'execution' : 'unknown',
            effectUncertain: transport || !execution };
    }

    // 记录真实请求的迟到结果；外层等待超时不修改这里的 pending 状态。
    async function trackRequest(op, action) {
        op.requestOutcome = 'pending';
        try {
            const result = await action();
            op.requestOutcome = 'fulfilled';
            return result;
        } catch (error) {
            op.requestOutcome = 'rejected';
            op.requestFailed = true;
            op.requestError = requestError(error);
            throw error;
        } finally {
            op.settled = true;
            op.settledAt = Date.now();
        }
    }

    function recovery(op) {
        if (pending !== op) return null;
        if (!op.settled) return 'WAIT_FOR_REQUEST_SETTLED';
        if (op.requestError?.effectUncertain) return 'REMOTE_EFFECT_UNCONFIRMED';
        return 'QUERY_STABLE_CONTEXT';
    }

    // 复制状态，避免后续迟到回调修改调用者已经取得的快照。
    function snapshot(op, status) {
        if (!op) return { status: 'idle' };
        return { status: status || op.status, operationId: op.id, phase: op.phase,
            requestedAsset: op.asset, assetUuid: op.target?.uuid || null, assetUrl: op.target?.url || null,
            startedAt: op.startedAt, elapsedMs: Date.now() - op.startedAt,
            dispatched: op.dispatched, settled: op.settled, reason: op.reason,
            kind: op.kind || 'prefab', requestOutcome: op.requestOutcome || 'not_started',
            requestError: op.requestError ? { ...op.requestError } : null, settledAt: op.settledAt || null,
            timedOut: op.timedOut === true, lockActive: pending === op || (busy && latest === op && op.status === 'running'),
            context: op.context, details: op.details ? JSON.parse(JSON.stringify(op.details)) : null, recovery: recovery(op) };
    }

    // 查询只读编辑器；恢复需连续两次核对干净上下文，且不能抢先释放仍在返回中的操作。
    // expected 用于显式恢复入口，防止人工接手后按过期实例解除另一页的保护。
    async function queryStatus(operationId, expected) {
        const op = pending || latest;
        if (operationId && operationId !== op?.id) return { status: 'not_found', operationId };
        if (pending === op && op?.settled && !op.dispatched && !busy) {
            pending = null;
            op.status = 'failed'; op.phase = 'completed';
        }
        if (pending === op && op) {
            try {
                const { wait } = createDeadline(Math.min(timeoutMs, 3000));
                const actual = await wait(context);
                if (expected && (actual.assetUuid !== expected.expectedAssetUuid || actual.rootUuid !== expected.expectedRootUuid))
                    return { ...snapshot(op), recoveryBlocked: 'CONTEXT_CONFLICT' };
                // 查询期间可能已经有新的操作进入，旧状态查询不能清掉新操作的保护。
                if (pending === op) {
                    op.context = actual;
                    if (!busy && op.settled && !op.requestFailed && confirmed(op, actual)) {
                        pending = null;
                        op.phase = 'completed';
                        op.status = op.kind ? 'completed' : 'opened';
                        op.reason = 'TARGET_CONFIRMED';
                    } else if (!busy && op.settled && !op.requestError?.effectUncertain &&
                        (op.requestFailed || (expected && actual.assetUuid !== op.target.uuid && actual.rootUuid !== op.initialContext?.rootUuid))) {
                        const verified = await wait(context);
                        if (pending === op && !busy && stable(actual, verified)) {
                            pending = null;
                            op.context = verified;
                            op.phase = 'completed';
                            // 成功消息后页面已切走属于被接手，不能宣称目标实例已校验。
                            op.status = op.requestFailed ? 'failed' : 'superseded';
                            op.reason = op.requestFailed ? 'EDITOR_REQUEST_FAILED' : 'CONTEXT_SUPERSEDED';
                        }
                    }
                }
            } catch (error) {
                return { ...snapshot(op), queryError: error?.code === 'TIMEOUT' ? 'TIMEOUT' : 'CONTEXT_QUERY_FAILED' };
            }
        }
        return snapshot(op);
    }

    // 旧锁存在时仍允许确认已打开目标并只读实例；绝不借此派发新切换或解除旧锁。
    async function inspectOpenTarget(asset, blocker) {
        const { wait } = createDeadline(Math.min(timeoutMs, 3000));
        try {
            const target = await wait(() => resolve(asset));
            const actual = await wait(context);
            const verified = await wait(context);
            if (loaded(actual, target.uuid) && loaded(verified, target.uuid) && actual.rootUuid === verified.rootUuid)
                return { status: 'already_open', assetUuid: target.uuid, assetUrl: target.url || null,
                    context: verified, lockActive: pending !== null || busy, blockingOperation: snapshot(blocker), readOnly: true };
        } catch (_) { /* 无法可靠确认时仍返回旧操作，不触发新的写入。 */ }
        return snapshot(blocker, 'pending');
    }

    async function openPrefab(asset) {
        if (busy) return snapshot(latest, 'busy');
        if (pending) {
            await queryStatus(pending.id);
            if (pending) return inspectOpenTarget(asset, pending);
            // 另一个调用可能在状态查询期间先取得锁。
            if (busy) return snapshot(latest, 'busy');
        }
        busy = true;
        const op = { id: instance + '-' + (++sequence), asset, startedAt: Date.now(), status: 'running',
            phase: 'resolving', dispatched: false, settled: false, reason: null, context: null, target: null };
        latest = op;
        const { wait, check } = createDeadline(timeoutMs);
        try {
            op.target = await wait(() => resolve(asset));
            op.phase = 'checking_context';
            op.context = await wait(context);
            if (loaded(op.context, op.target.uuid)) {
                op.status = 'already_open'; op.phase = 'completed';
                return snapshot(op);
            }
            if (op.context?.dirty !== false || !op.context.ready || !op.context.rootUuid || op.context.mode === 'unknown') {
                op.status = 'blocked';
                op.reason = op.context?.dirty === true ? 'UNSAVED' : 'UNKNOWN_CONTEXT';
                return snapshot(op);
            }
            op.phase = 'opening';
            op.initialContext = { ...op.context };
            await wait(async () => {
                // bounded 的微任务执行前复核截止时间，过期的预检不会发起切换。
                check();
                op.dispatched = true;
                pending = op;
                try { await trackRequest(op, () => open(op.target.uuid)); }
                finally {
                    op.settled = true;
                    if (!op.dispatched && pending === op) pending = null;
                }
            });
            op.phase = 'waiting_for_instance';
            while (true) {
                op.context = await wait(context);
                if (loaded(op.context, op.target.uuid)) {
                    pending = null;
                    op.status = 'opened'; op.phase = 'completed';
                    return snapshot(op);
                }
                await wait(() => new Promise(done => setTimeout(done, pollMs)));
            }
        } catch (error) {
            op.timedOut = error?.code === 'TIMEOUT';
            op.status = op.dispatched ? 'unconfirmed' : 'failed';
            op.reason = error?.code === 'TIMEOUT' ? 'TIMEOUT' :
                ['INVALID_PREFAB', 'OUTSIDE_PROJECT'].includes(error?.message) ? error.message : 'EDITOR_REQUEST_FAILED';
            return snapshot(op);
        } finally { busy = false; }
    }

    // 场景切换、重载和保存与 Prefab 打开共用 busy/pending。
    // expectedAssetUuid 用于检测用户在调用前已切换页面；保存必须明确指定它。
    async function runEditorAction(kind, args, action, validateTarget, managed = false) {
        if (busy) return snapshot(latest, 'busy');
        if (pending) {
            await queryStatus(pending.id);
            if (pending) return snapshot(pending, 'pending');
            if (busy) return snapshot(latest, 'busy');
        }
        busy = true;
        const op = { id: instance + '-' + (++sequence), kind, asset: args.uuid || args.expectedAssetUuid,
            startedAt: Date.now(), status: 'running', phase: 'checking_context', dispatched: false,
            settled: false, target: null, context: null, reason: null };
        latest = op;
        const { wait, check } = createDeadline(timeoutMs);
        try {
            op.context = await wait(context);
            const c = op.context;
            if (!c?.ready || !c.rootUuid || c.mode === 'unknown' || c.dirty === null) {
                op.status = 'blocked'; op.reason = 'UNKNOWN_CONTEXT'; return snapshot(op);
            }
            if (args.expectedAssetUuid && c.assetUuid !== args.expectedAssetUuid) {
                op.status = 'blocked'; op.reason = 'CONTEXT_CONFLICT'; return snapshot(op);
            }
            if (kind === 'save' && !args.expectedAssetUuid) {
                op.status = 'blocked'; op.reason = 'EXPECTED_RESOURCE_REQUIRED'; return snapshot(op);
            }
            if (kind !== 'save' && kind !== 'edit' && c.dirty !== false) {
                op.status = 'blocked'; op.reason = 'UNSAVED'; return snapshot(op);
            }
            if (validateTarget) await wait(validateTarget);
            const verified = await wait(context);
            if (!verified?.ready || verified.assetUuid !== c.assetUuid || verified.rootUuid !== c.rootUuid ||
                verified.dirty !== c.dirty || verified.mode !== c.mode) {
                op.status = 'blocked'; op.reason = 'CONTEXT_CONFLICT'; return snapshot(op);
            }
            op.target = { uuid: kind === 'scene' ? args.uuid : c.assetUuid };
            op.initialContext = { ...verified };
            op.phase = 'executing';
            await wait(async () => {
                pending = op;
                const controls = {
                    // 新的实际写入前复核截止时间；已发出的消息及记录清理由调用者等待结束。
                    write: call => {
                        check();
                        op.dispatched = true;
                        return call();
                    },
                    read: wait,
                    details: value => { op.details = JSON.parse(JSON.stringify(value)); },
                };
                if (!managed) op.dispatched = true;
                await trackRequest(op, () => action(controls));
            });
            op.phase = 'waiting_for_instance';
            while (true) {
                op.context = await wait(context);
                if (confirmed(op, op.context)) {
                    pending = null; op.status = 'completed'; op.phase = 'completed'; return snapshot(op);
                }
                await wait(() => new Promise(done => setTimeout(done, pollMs)));
            }
        } catch (error) {
            op.timedOut = error?.code === 'TIMEOUT';
            op.status = op.dispatched ? 'unconfirmed' : 'failed';
            op.reason = error?.code === 'TIMEOUT' ? 'TIMEOUT' : error?.message === 'INVALID_SCENE' ? 'INVALID_SCENE' : 'EDITOR_REQUEST_FAILED';
            return snapshot(op);
        } finally { busy = false; }
    }

    openPrefab.runEditorAction = runEditorAction;
    openPrefab.queryStatus = queryStatus;
    openPrefab.recover = args => queryStatus(args.operationId, args);
    return openPrefab;
}

module.exports = { createOpener, resolvePrefab };
