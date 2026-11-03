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
    const { bounded } = require('./bounded');
    const instance = require('crypto').randomBytes(6).toString('hex');
    let sequence = 0, busy = false, pending = null, latest = null;
    const loaded = (c, uuid) => c?.ready === true && c.mode === 'prefab' && c.assetUuid === uuid && !!c.rootUuid;

    // 复制状态，避免后续迟到回调修改调用者已经取得的快照。
    function snapshot(op, status) {
        if (!op) return { status: 'idle' };
        return { status: status || op.status, operationId: op.id, phase: op.phase,
            requestedAsset: op.asset, assetUuid: op.target?.uuid || null, assetUrl: op.target?.url || null,
            startedAt: op.startedAt, elapsedMs: Date.now() - op.startedAt,
            dispatched: op.dispatched, settled: op.settled, reason: op.reason,
            context: op.context, recovery: pending === op ? 'WAIT_FOR_TARGET_AND_REQUEST_SETTLED' : null };
    }

    // 状态查询只读编辑器。仅当旧请求结束且目标确实加载后清除内部保护。
    async function queryStatus(operationId) {
        const op = pending || latest;
        if (operationId && operationId !== op?.id) return { status: 'not_found', operationId };
        if (pending === op && op) {
            try {
                const actual = await bounded(context, Math.min(timeoutMs, 3000));
                // 查询期间可能已经有新的操作进入，旧状态查询不能清掉新操作的保护。
                if (pending === op) {
                    op.context = actual;
                    if (op.settled && loaded(actual, op.target.uuid)) {
                        pending = null;
                        op.phase = 'completed';
                        op.status = 'opened';
                        op.reason = 'TARGET_CONFIRMED';
                    }
                }
            } catch (error) {
                return { ...snapshot(op), queryError: error.code === 'TIMEOUT' ? 'TIMEOUT' : 'CONTEXT_QUERY_FAILED' };
            }
        }
        return snapshot(op);
    }

    async function openPrefab(asset) {
        if (busy) return snapshot(latest, 'busy');
        if (pending) {
            await queryStatus(pending.id);
            if (pending) return snapshot(pending, 'pending');
            // 另一个调用可能在状态查询期间先取得锁。
            if (busy) return snapshot(latest, 'busy');
        }
        busy = true;
        const op = { id: instance + '-' + (++sequence), asset, startedAt: Date.now(), status: 'running',
            phase: 'resolving', dispatched: false, settled: false, reason: null, context: null, target: null };
        latest = op;
        const deadline = op.startedAt + timeoutMs;
        async function wait(call) {
            if (Date.now() >= deadline) {
                const error = new Error('Operation timeout'); error.code = 'TIMEOUT'; throw error;
            }
            return bounded(call, deadline - Date.now());
        }
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
            await wait(async () => {
                // bounded 的微任务执行前复核截止时间，过期的预检不会发起切换。
                if (Date.now() >= deadline) { const error = new Error('Operation timeout'); error.code = 'TIMEOUT'; throw error; }
                op.dispatched = true;
                pending = op;
                try { await open(op.target.uuid); }
                finally { op.settled = true; }
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
            op.status = op.dispatched ? 'unconfirmed' : 'failed';
            op.reason = error.code === 'TIMEOUT' ? 'TIMEOUT' :
                ['INVALID_PREFAB', 'OUTSIDE_PROJECT'].includes(error.message) ? error.message : 'EDITOR_REQUEST_FAILED';
            return snapshot(op);
        } finally { busy = false; }
    }
    openPrefab.queryStatus = queryStatus;
    return openPrefab;
}

module.exports = { createOpener, resolvePrefab };
