'use strict';
const { bounded } = require('./bounded');

// 只接受当前实例内节点的组件引用字段，数组按位置比较，null 不当作有效引用。
function references(field) {
    if (!field || typeof field !== 'object' || !('value' in field)) throw Error('NOT_REFERENCE_FIELD');
    const value = field.value;
    if (Array.isArray(value)) return value.map(item => references(item));
    if (value === null || value?.uuid === '') return null;
    if (typeof value?.uuid === 'string') return value.uuid;
    throw Error('NOT_REFERENCE_FIELD');
}

async function verifyBindings({ context, msg }, args) {
    const started = Date.now(), deadline = started + 5000;
    const call = fn => bounded(() => {
        if (Date.now() >= deadline) { const e = new Error('TIMEOUT'); e.code = 'TIMEOUT'; throw e; }
        return fn();
    }, deadline - Date.now());
    try {
        if (!Array.isArray(args.checks) || args.checks.length < 1 || args.checks.length > 100) return { status: 'invalid', reason: 'CHECK_COUNT' };
        const before = await call(context);
        if (!before.ready || before.assetUuid !== args.expectedAssetUuid) return { status: 'invalidated', reason: 'CONTEXT_CONFLICT' };
        const tree = await call(() => msg('scene', 'query-node-tree', before.rootUuid));
        const nodes = new Set(), instances = new Map();
        function visit(n) {
            if (!n) return;
            nodes.add(n.uuid); instances.set(n.uuid, { type: n.type || 'cc.Node', extends: ['cc.Node'] });
            for (const c of n.components || []) instances.set(c.value, c);
            for (const c of n.children || []) visit(c);
        }
        visit(tree);
        const results = [], reads = [];
        for (const check of args.checks) {
            if (!nodes.has(check.nodeUuid)) { results.push({ ...check, status: 'mismatch', reason: 'NODE_OUTSIDE_INSTANCE' }); continue; }
            const read = async () => {
                const dump = await call(() => msg('scene', 'query-node', check.nodeUuid));
                const matches = (dump?.__comps__ || []).filter(c => c.type === check.componentType);
                if (matches.length !== 1) throw Error('COMPONENT_MISSING_OR_AMBIGUOUS');
                return matches[0].value?.[check.field];
            };
            try {
                const field = await read(), actual = references(field);
                reads.push({ read, encoded: JSON.stringify(field) });
                const uuids = Array.isArray(actual) ? actual : [actual];
                const resolved = [];
                for (const uuid of uuids) {
                    if (uuid === null) { resolved.push(false); continue; }
                    const local = instances.get(uuid);
                    const info = local || await call(() => msg('asset-db', 'query-asset-info', uuid));
                    const actualType = info?.type;
                    const compatible = actualType === field.type || (info?.extends || []).includes(field.type);
                    resolved.push(!!info && (local || info.uuid === uuid) && info.invalid !== true &&
                        info.imported !== false && compatible);
                }
                const matched = JSON.stringify(actual) === JSON.stringify(check.expected) &&
                    (!check.expectedType || field.type === check.expectedType) && resolved.every(Boolean);
                results.push({ nodeUuid: check.nodeUuid, field: check.field, actual, expected: check.expected, type: field.type,
                    resolved, status: matched ? 'matched' : 'mismatch' });
            } catch (e) {
                if (e.code === 'TIMEOUT') throw e;
                results.push({ nodeUuid: check.nodeUuid, field: check.field, status: 'mismatch', reason: e.message });
            }
        }
        for (const item of reads) if (JSON.stringify(await item.read()) !== item.encoded) return { status: 'invalidated', reason: 'FIELD_CHANGED' };
        const after = await call(context);
        if (!after.ready || after.assetUuid !== before.assetUuid || after.rootUuid !== before.rootUuid ||
            after.mode !== before.mode || after.dirty !== before.dirty) return { status: 'invalidated', reason: 'CONTEXT_CHANGED' };
        return { status: results.every(r => r.status === 'matched') ? 'matched' : 'mismatch', context: after, results };
    } catch (e) { return { status: 'unconfirmed', reason: e.code === 'TIMEOUT' ? 'TIMEOUT' : 'QUERY_FAILED' }; }
}
module.exports = { verifyBindings, references };
