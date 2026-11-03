'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { reimportConfirm } = require('../asset-confirm');
test('导入确认区分最新源文件、导入失败与子资源', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-import-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(root + '/assets');
    const file = root + '/assets/a.png';
    fs.writeFileSync(file, 'image'); fs.writeFileSync(file + '.meta', '{}');
    const info = { uuid: 'a', url: 'db://assets/a.png', file, imported: true, invalid: false, type: 'cc.ImageAsset',
        subAssets: { x: { uuid: 'a@x', type: 'cc.SpriteFrame', name: 'spriteFrame' } } };
    for (const mode of ['ok', 'changed', 'invalid']) {
        const result = await reimportConfirm({ projectPath: root,
            run: async (_, args, action) => { await action({ read: fn => fn(), write: fn => fn(), details() {} }); return { status: 'completed' }; },
            msg: async (_, method) => {
                if (method === 'reimport-asset') { if (mode === 'changed') fs.appendFileSync(file + '.meta', ' '); return; }
                return { ...info, invalid: mode === 'invalid' };
            } }, { url: info.url, expectedAssetUuid: 'context' });
        assert.equal(result.import.status, { ok: 'imported', changed: 'source_changed', invalid: 'unconfirmed' }[mode]);
        assert.equal(result.import.instanceVerified, false);
    }
});

const { verifyBindings } = require('../binding-verify');
test('绑定校验检测数组顺序、空引用、迟到页面切换', async () => {
    for (const mode of ['ok','order','empty','switch']) {
        let n = 0;
        const result = await verifyBindings({
            context: async () => ({ ready: true, assetUuid: ++n > 1 && mode === 'switch' ? 'other' : 'asset', rootUuid: 'node', mode: 'prefab', dirty: false }),
            msg: async (_, name) => {
                if (name === 'query-node-tree') return { uuid: 'node', components: [{ value: 'ref1', type:'cc.Sprite' },{value:'ref2',type:'cc.Sprite'}] };
                return { __comps__: [{ type: 'Example', value: { frames: { type: 'cc.Sprite', value:
                    [mode === 'empty' ? null : 'ref1','ref2'].map(uuid => ({ value: uuid ? { uuid } : null })) } } }] };
            },
        }, { expectedAssetUuid: 'asset', checks: [{ nodeUuid: 'node', componentType: 'Example', field: 'frames',
            expected: mode === 'order' ? ['ref2','ref1'] : ['ref1','ref2'] }] });
        assert.equal(result.status, { ok:'matched',order:'mismatch',empty:'mismatch',switch:'invalidated' }[mode]);
    }
});

const { digest, inspect, createIdentity } = require('../identity');
test('身份清单区分启动加载、磁盘改变、缺失文件和未知安装', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-identity-'));
    t.after(() => fs.rmSync(root,{recursive:true,force:true}));
    fs.writeFileSync(root+'/package.json', '{"version":"test"}');
    fs.writeFileSync(root+'/main.js','old');
    fs.mkdirSync(root+'/server'); fs.writeFileSync(root+'/server/tools.js',''); fs.writeFileSync(root+'/server/editor-bridge.js','');
    const manifest = require('../identity').buildManifest(root);
    fs.writeFileSync(root+'/maintenance-manifest.json',JSON.stringify(manifest));
    const identity = createIdentity(root);
    assert.equal(identity().requiresReload,false);
    fs.writeFileSync(root+'/main.js','new');
    assert.equal(identity().requiresReload,true);
    assert.equal(identity().loaded.status,'matched');
    assert.equal(identity().disk.status,'modified');
    fs.unlinkSync(root+'/main.js');
    assert.deepEqual(inspect(root).missing,['main.js']);
    fs.unlinkSync(root+'/maintenance-manifest.json');
    assert.equal(createIdentity(root)().loaded.status,'unavailable');
});

const { createOpener } = require('../prefab-open');
test('导入预检超时后迟到查询不会触发重导入', async t => {
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'mcp-deadline-'));
    t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    fs.mkdirSync(root+'/assets');const file=root+'/assets/a.png';fs.writeFileSync(file,'x');fs.writeFileSync(file+'.meta','{}');
    const info={file,uuid:'a',url:'db://assets/a.png',type:'cc.ImageAsset',imported:true,invalid:false};
    let release,writes=0;
    const context=async()=>({ready:true,dirty:false,assetUuid:'s',rootUuid:'r',mode:'scene'});
    const opener=createOpener({resolve:assert.fail,context,open:assert.fail,timeoutMs:25});
    const result=await reimportConfirm({projectPath:root,run:opener.runEditorAction,msg:async(_,name)=>{
        if(name==='query-asset-info')return new Promise(done=>{release=()=>done(info);});
        writes++;
    }},{url:info.url,expectedAssetUuid:'s'});
    assert.equal(result.reason,'TIMEOUT');release();
    await new Promise(done=>setTimeout(done,10));assert.equal(writes,0);
});
test('已发出导入迟到结束后操作查询保留 source_changed', async t=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'mcp-late-'));
    t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    fs.mkdirSync(root+'/assets');const file=root+'/assets/a.png';fs.writeFileSync(file,'x');fs.writeFileSync(file+'.meta','{}');
    const info={file,uuid:'a',url:'db://assets/a.png',type:'cc.ImageAsset',imported:true,invalid:false};
    let release;
    const opener=createOpener({resolve:assert.fail,context:async()=>({ready:true,dirty:false,assetUuid:'s',rootUuid:'r',mode:'scene'}),open:assert.fail,timeoutMs:25});
    const result=await reimportConfirm({projectPath:root,run:opener.runEditorAction,msg:async(_,name)=>{
        if(name==='reimport-asset')return new Promise(done=>release=done);
        return info;
    }},{url:info.url,expectedAssetUuid:'s'});
    assert.equal(result.status,'unconfirmed');fs.appendFileSync(file,'changed');release();
    await new Promise(done=>setTimeout(done,10));
    assert.equal((await opener.queryStatus(result.operationId)).details.import.status,'source_changed');
    assert.equal(result.import.status,'importing');
});
test('声明类型不能掩盖实际资源类型、UUID或有效性错误',async()=>{
    for(const info of [{uuid:'a',type:'cc.Texture2D'},{uuid:'a',type:'cc.SpriteFrame',invalid:true},{uuid:'other',type:'cc.SpriteFrame'}]){
        const result=await verifyBindings({context:async()=>({ready:true,assetUuid:'s',rootUuid:'r',mode:'scene',dirty:false}),msg:async(_,name)=>{
            if(name==='query-node-tree')return {uuid:'r'};
            if(name==='query-node')return {__comps__:[{type:'Example',value:{icon:{type:'cc.SpriteFrame',value:{uuid:'a'}}}}]};
            return info;
        }},{expectedAssetUuid:'s',checks:[{nodeUuid:'r',componentType:'Example',field:'icon',expected:'a',expectedType:'cc.SpriteFrame'}]});
        assert.equal(result.status,'mismatch');
    }
});
test('清单总哈希错误与未列入的新生产文件不能报告一致',t=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'mcp-manifest-'));
    t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    fs.mkdirSync(root+'/server');
    for(const f of ['main.js','server/tools.js','server/editor-bridge.js'])fs.writeFileSync(root+'/'+f,'');
    fs.writeFileSync(root+'/package.json','{"version":"test"}');
    const m=require('../identity').buildManifest(root);
    fs.writeFileSync(root+'/maintenance-manifest.json',JSON.stringify({...m,fingerprint:'bad'}));
    assert.throws(()=>inspect(root),/FINGERPRINT/);
    fs.writeFileSync(root+'/maintenance-manifest.json',JSON.stringify(m));fs.writeFileSync(root+'/server/new.js','');
    assert.equal(inspect(root).status,'modified');assert.deepEqual(inspect(root).added,['server/new.js']);
});
