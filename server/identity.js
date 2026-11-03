'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');

// 身份范围固定为扩展入口及 server 生产 JS；测试文件不参与运行身份。
const required = ['main.js', 'package.json', 'server/tools.js', 'server/editor-bridge.js'];
function digest(text) { return crypto.createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex'); }
function names(root) {
    const found = ['main.js','package.json'].filter(n => fs.existsSync(path.join(root,n)));
    function visit(dir) {
        for (const entry of fs.readdirSync(path.join(root,dir), { withFileTypes:true })) {
            if (entry.name === 'test') continue;
            if (entry.isSymbolicLink()) throw Error('SYMLINK_IN_MANIFEST_SCOPE');
            const name = dir + '/' + entry.name;
            if (entry.isDirectory()) visit(name);
            else if (name.endsWith('.js')) found.push(name);
        }
    }
    if (fs.existsSync(path.join(root,'server'))) visit('server');
    return found.sort();
}
function hashes(root, files) {
    return Object.fromEntries(files.map(n => {
        const file = path.join(root,n);
        if (fs.lstatSync(file).isSymbolicLink()) throw Error('SYMLINK_IN_MANIFEST_SCOPE');
        return [n,digest(fs.readFileSync(file,'utf8'))];
    }));
}
// 生成仅由显式维护命令调用，运行查询绝不修改清单。
function buildManifest(root) {
    const list = names(root);
    if (required.some(n => !list.includes(n))) throw Error('MISSING_REQUIRED_ENTRY');
    const files = hashes(root,list);
    return { schemaVersion:1, scope:'editor-bridge-production-entrypoints', fingerprint:digest(JSON.stringify(files)), files };
}
function inspect(root) {
    const manifest=JSON.parse(fs.readFileSync(path.join(root,'maintenance-manifest.json'),'utf8'));
    if (manifest.schemaVersion !== 1 || manifest.scope !== 'editor-bridge-production-entrypoints' ||
        !manifest.files || Array.isArray(manifest.files)) throw Error('INVALID_MANIFEST');
    const keys=Object.keys(manifest.files).sort();
    if (required.some(n=>!keys.includes(n)) || keys.some(n=>!(/^(main\.js|package\.json|server\/[\w./-]+\.js)$/.test(n)) ||
        n.split('/').includes('..') || !/^[a-f0-9]{64}$/.test(manifest.files[n]))) throw Error('INVALID_MANIFEST');
    const expected=Object.fromEntries(keys.map(n=>[n,manifest.files[n]]));
    if (digest(JSON.stringify(expected)) !== manifest.fingerprint) throw Error('INVALID_MANIFEST_FINGERPRINT');
    const list=names(root), actual=hashes(root,list);
    const missing=keys.filter(n=>!list.includes(n)), added=list.filter(n=>!keys.includes(n));
    const changed=keys.filter(n=>n in actual && actual[n]!==expected[n]);
    return { version:JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version,
        baseline:manifest.fingerprint, fingerprint:digest(JSON.stringify(actual)),
        status:missing.length||added.length||changed.length?'modified':'matched',changed,missing,added };
}
function createIdentity(root) {
    const read=()=>{try{return inspect(root);}catch(e){return {status:'unavailable',reason:e.code||e.message};}};
    const loaded=read();
    return ()=>{const disk=read();return {loaded,disk,requiresReload:
        loaded.status==='unavailable'||disk.status==='unavailable'?null:loaded.fingerprint!==disk.fingerprint};};
}
module.exports={digest,inspect,createIdentity,buildManifest};
