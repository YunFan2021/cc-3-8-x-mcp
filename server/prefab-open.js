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

// 每个 Editor Bridge 实例共享一个切换锁。超时后仅在确认目标到达时解除迟到操作的保护。
function createOpener({ resolve, context, open, timeoutMs = 12000, pollMs = 150 }) {
    let busy = false, pending = null;
    const loaded = (c, uuid) => c.ready && c.mode === 'prefab' && c.assetUuid === uuid && !!c.rootUuid;
    return async function openPrefab(asset) {
        if (busy) return { status: 'busy' };
        busy = true;
        let expired = false, timer;
        const timeout = new Promise(done => { timer = setTimeout(() => { expired = true; done({ status: 'unconfirmed' }); }, timeoutMs); });
        async function run() {
            const target = await resolve(asset);
            const current = await context();
            if (expired) return;
            if (pending) {
                if (!pending.settled || !loaded(current, pending.uuid)) return { status: 'pending', assetUuid: pending.uuid };
                pending = null;
            }
            if (loaded(current, target.uuid)) return { status: 'already_open', context: current };
            if (current.dirty !== false || !current.ready || !current.rootUuid || current.mode === 'unknown')
                return { status: 'blocked', reason: current.dirty === true ? 'unsaved' : 'unknown_context', context: current };

            const attempt = { uuid: target.uuid, settled: false };
            pending = attempt;
            try { await open(target.uuid); }
            catch (err) {
                // 请求失败也可能已送达；保留保护，避免下一次切换与迟到操作竞争。
                return { status: 'unconfirmed', assetUuid: target.uuid, message: String(err.message || err) };
            } finally { attempt.settled = true; }
            while (!expired) {
                const actual = await context();
                if (expired) return;
                if (loaded(actual, target.uuid)) {
                    pending = null;
                    return { status: 'opened', context: actual };
                }
                await new Promise(done => setTimeout(done, pollMs));
            }
        }
        try { return await Promise.race([run(), timeout]); }
        finally { clearTimeout(timer); busy = false; }
    };
}

module.exports = { createOpener, resolvePrefab };
