'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');

// 对文本统一换行后计算哈希，避免 Windows checkout/npm link 的换行差异产生假冲突。
function digest(text) { return crypto.createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex'); }
function inspect(root) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'maintenance-manifest.json'), 'utf8'));
    const actual = {}, changed = [], missing = [];
    for (const [relative, expected] of Object.entries(manifest.files)) {
        if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw Error('INVALID_MANIFEST_PATH');
        const file = path.join(root, relative);
        if (!fs.existsSync(file)) { missing.push(relative); continue; }
        actual[relative] = digest(fs.readFileSync(file, 'utf8'));
        if (actual[relative] !== expected) changed.push(relative);
    }
    return { version: require(path.join(root, 'package.json')).version, baseline: manifest.fingerprint,
        fingerprint: digest(JSON.stringify(actual)), status: changed.length || missing.length ? 'modified' : 'matched', changed, missing };
}
// 启动时缓存 loaded 身份，查询时另外计算 disk；修改磁盘不能冒充已加载新代码。
function createIdentity(root) {
    // 清单异常仅影响身份诊断，不阻断其余编辑器工具启动。
    const read = () => { try { return inspect(root); } catch (error) { return { status: 'unavailable', reason: error.code || error.message }; } };
    const loaded = read();
    return () => { const disk = read(); return { loaded, disk,
        requiresReload: loaded.status === 'unavailable' || disk.status === 'unavailable' ? null : loaded.fingerprint !== disk.fingerprint }; };
}
module.exports = { digest, inspect, createIdentity };
