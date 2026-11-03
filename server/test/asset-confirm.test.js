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
            run: async (_, args, action) => { await action(); return { status: 'completed' }; },
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
                if (name === 'query-node-tree') return { uuid: 'node', components: [{ value: 'ref1' },{value:'ref2'}] };
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
    const files={'main.js':digest('old')};
    fs.writeFileSync(root+'/maintenance-manifest.json',JSON.stringify({files,fingerprint:digest(JSON.stringify(files))}));
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
