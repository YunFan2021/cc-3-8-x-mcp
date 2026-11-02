'use strict';

// 所有身份字段均来自当前编辑器；切换途中或消息不可用时保留未知状态。
async function queryContext(msg, projectPath) {
    const query = (name) => msg('scene', name).catch(() => null);
    const sample = () => Promise.all(['query-current-scene', 'query-scene-mode', 'query-is-ready', 'query-dirty'].map(query));
    const [uuid, rawMode, ready, dirty] = await sample();
    const unknown = { projectPath, mode: 'unknown', assetUuid: null, assetUrl: null, rootUuid: null, ready: false, dirty: null };
    if (ready !== true || typeof uuid !== 'string' || !uuid) return unknown;
    const [info, tree] = await Promise.all([
        msg('asset-db', 'query-asset-info', uuid).catch(() => null),
        query('query-node-tree'),
    ]);
    const [lastUuid, lastMode, lastReady, lastDirty] = await sample();
    if (!info || info.uuid !== uuid || uuid !== lastUuid || rawMode !== lastMode || lastReady !== true) return unknown;

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
        ready: !!root?.uuid, dirty: dirty === true || lastDirty === true ? true : dirty === false && lastDirty === false ? false : null };
}

module.exports = { queryContext };
