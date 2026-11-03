'use strict';

const { bounded } = require('./bounded');

// 总预算为毫秒。消息失败保留具体来源；迟到消息不再改变已返回的诊断。
async function queryContext(msg, projectPath, { timeoutMs = 3000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    const diagnostics = [];
    async function request(target, name, ...args) {
        try {
            if (Date.now() >= deadline) {
                diagnostics.push({ message: name, code: 'TIMEOUT' });
                return null;
            }
            return await bounded(() => msg(target, name, ...args), deadline - Date.now());
        } catch (error) {
            diagnostics.push({ message: name, code: error.code === 'TIMEOUT' ? 'TIMEOUT' : 'MESSAGE_FAILED' });
            return null;
        }
    }
    const query = name => request('scene', name);
    const sample = () => Promise.all(['query-current-scene', 'query-scene-mode', 'query-is-ready', 'query-dirty'].map(query));
    const [uuid, rawMode, ready, dirty] = await sample();
    const unknown = reason => ({ projectPath, mode: 'unknown', assetUuid: null, assetUrl: null,
        rootUuid: null, ready: false, dirty: null, reason, rawMode, diagnostics: diagnostics.slice() });
    if (ready !== true) return unknown('NOT_READY');
    if (typeof uuid !== 'string' || !uuid) return unknown('NO_RESOURCE_ID');
    const [info, tree] = await Promise.all([
        request('asset-db', 'query-asset-info', uuid), query('query-node-tree'),
    ]);
    const [lastUuid, lastMode, lastReady, lastDirty] = await sample();
    if (uuid !== lastUuid || rawMode !== lastMode || lastReady !== true) return unknown('CONTEXT_CHANGED');
    if (!info || info.uuid !== uuid) return unknown('RESOURCE_UNAVAILABLE');

    let mode = 'unknown', root = null;
    if (rawMode === 'prefab' && info.type === 'cc.Prefab') {
        mode = 'prefab';
        // 3.8.8 的 Prefab 编辑器在临时场景与资源根节点之间还有一层隐藏容器。
        const children = tree?.children || [];
        const candidates = children.flatMap(n => n.name === 'should_hide_in_hierarchy' ? n.children || [] : [n]);
        const matches = candidates.filter(n => n.prefab?.assetUuid === uuid);
        if (matches.length === 1) root = matches[0];
    } else if (info.type === 'cc.SceneAsset' && (rawMode === 'scene' || rawMode === 'general') && tree?.type === 'cc.Scene') {
        mode = 'scene';
        root = tree;
    }
    return { projectPath, mode, assetUuid: uuid, assetUrl: info.url || null, rootUuid: root?.uuid || null,
        ready: !!root?.uuid, reason: root?.uuid ? 'OK' : 'ROOT_UNCONFIRMED', rawMode, diagnostics: diagnostics.slice(), dirty: dirty === true || lastDirty === true ? true : dirty === false && lastDirty === false ? false : null };
}

module.exports = { queryContext };
