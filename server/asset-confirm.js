'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 内容与 meta 一起取样，导入期间任一文件变化均使结果失效；不读取 library 产物。
function fingerprint(file) {
    const hash = crypto.createHash('sha256');
    for (const p of [file, file + '.meta']) hash.update(fs.readFileSync(p));
    return hash.digest('hex');
}

// 保留原 reimport 基础接口；此接口通过公共锁串行，且要求明确当前编辑资源。
async function reimportConfirm({ msg, projectPath, run }, args) {
    let report = { status: 'not_started', instanceVerified: false };
    const result = await run('import', args, async controls => {
        const publish = value => { report = value; controls.details({ import: report }); };
        if (!/^db:\/\/assets\//.test(args.url)) throw Error('INVALID_ASSET');
        const info = await controls.read(() => msg('asset-db', 'query-asset-info', args.url));
        if (!info?.file || info.url !== args.url || info.isDirectory) throw Error('INVALID_ASSET');
        const assets = fs.realpathSync(path.join(projectPath, 'assets'));
        const file = fs.realpathSync(info.file), rel = path.relative(assets, file);
        if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw Error('OUTSIDE_PROJECT');
        const before = fingerprint(file);
        publish({ status: 'importing', uuid: info.uuid, url: info.url, sourceHash: before, instanceVerified: false });
        await controls.write(() => msg('asset-db', 'reimport-asset', info.url));
        let after;
        try { after = await require('./bounded').bounded(() => msg('asset-db', 'query-asset-info', info.uuid), 3000); }
        catch (error) {
            publish({ ...report, status: 'unconfirmed', reason: error.code || 'QUERY_FAILED' });
            throw error;
        }
        if (fingerprint(file) !== before) {
            publish({ ...report, status: 'source_changed' }); return;
        }
        const valid = after?.uuid === info.uuid && after.url === info.url && after.imported === true && after.invalid === false;
        publish({ ...report, status: valid ? 'imported' : 'unconfirmed', type: after?.type || null,
            subAssets: Object.values(after?.subAssets || {}).map(a => ({ uuid: a.uuid, name: a.name, type: a.type || a.importer })) });
    }, undefined, true);
    // result.completed 仅说明调用及上下文确认完成，是否导入成功以 import.status 为准。
    return { ...result, import: { ...report } };
}
module.exports = { reimportConfirm, fingerprint };
