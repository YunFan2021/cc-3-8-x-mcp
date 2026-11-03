'use strict';

/**
 * MCP Tools 注册表
 * 每个 tool 透传到对应的 Editor.Message.request 或本地 helper。
 * ctx 提供：editor message 封装、本地辅助函数。
 */

function defineTools(ctx) {
    var msg = ctx.msg;   // async (target, name, ...args) => result
    var local = ctx.local; // { getPreviewUrl, doRefreshAssets, doReloadScene, listWorktrees, openDevDir, cleanDevDir, getStatus }

    return [
        // ── scene 域 ──
        {
            name: 'scene_verify_bindings',
            description: '只读校验当前资源实例中的节点/组件字段引用。checks 使用 nodeUuid、componentType、field、expected（UUID或UUID数组）及可选 expectedType。最多100项；期间上下文或字段变化返回 invalidated。',
            annotations: { readOnlyHint: true },
            inputSchema: { type: 'object', properties: {
                expectedAssetUuid: { type: 'string' },
                checks: { type: 'array', items: { type: 'object', properties: {
                    nodeUuid: { type: 'string' }, componentType: { type: 'string' }, field: { type: 'string' },
                    expected: {}, expectedType: { type: 'string' },
                }, required: ['nodeUuid','componentType','field','expected'], additionalProperties: false } },
            }, required: ['expectedAssetUuid','checks'] },
            handler: args => local.verifyBindings(args),
        },
        {
            name: 'local_query_identity',
            description: '只读查询扩展加载时与磁盘当前身份，比较维护清单中的生产代码文件。modified 表示本地差异，不能据此自动覆盖。',
            annotations: { readOnlyHint: true },
            inputSchema: { type: 'object', properties: {} },
            handler: () => local.queryIdentity(),
        },
        {
            name: 'scene_query_context',
            description: '只读查询当前编辑资源、加载根节点及未保存状态。无法确认的信息返回 null。',
            annotations: { readOnlyHint: true },
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            handler: () => local.queryContext(),
        },
        {
            name: 'scene_query_node_tree',
            description: '查询当前场景节点树。传 uuid 查子树，不传查根。',
            inputSchema: {
                type: 'object',
                properties: { uuid: { type: 'string', description: '可选：节点 uuid' } },
            },
            handler: async function (args) {
                return await msg('scene', 'query-node-tree', args.uuid);
            },
        },
        {
            name: 'scene_query_node',
            description: '查询单个节点完整 dump（含所有组件属性）',
            inputSchema: {
                type: 'object',
                properties: { uuid: { type: 'string' } },
                required: ['uuid'],
            },
            handler: async function (args) {
                return await msg('scene', 'query-node', args.uuid);
            },
        },
        {
            name: 'scene_set_property',
            description: '设置节点/组件属性。path 是 dump path（如 "position" 或 "__comps__.0.string"），dump 是 {type,value}。\n⚠️ 注意：若目的是修改 prefab 资源文件的属性，建议改用 prefab_edit（offline，不需要编辑器运行，直接读写 .prefab 文件，支持嵌套 prefab override）；scene_set_property 仅适用于修改运行时场景节点或需要编辑器上下文的场景。',
            inputSchema: {
                type: 'object',
                properties: {
                    uuid: { type: 'string' },
                    path: { type: 'string' },
                    expectedAssetUuid: { type: 'string', description: '预期当前编辑资源 UUID' },
                    dump: { type: 'object' },
                },
                required: ['uuid', 'path', 'dump'],
            },
            handler: async function (args) {
                return local.runEditorAction('edit', args, async controls => {
                    const record = await controls.write(() => msg('scene', 'begin-recording', args.uuid));
                    try {
                        const result = await controls.write(() => msg('scene', 'set-property', { uuid: args.uuid, path: args.path, dump: args.dump }));
                        if (result === false) throw Error('PROPERTY_WRITE_REJECTED');
                    } finally {
                        await msg('scene', 'end-recording', record);
                    }
                }, undefined, true);
            },
        },
        {
            name: 'prefab_query_open',
            description: '只读查询最近一次 Prefab 打开操作及超时恢复状态。可用 operationId 核对，未知 ID 返回 not_found；不发起打开或取消请求。',
            annotations: { readOnlyHint: true },
            inputSchema: { type: 'object', properties: { operationId: { type: 'string' } }, additionalProperties: false },
            handler: args => local.queryPrefabOpen(args.operationId),
        },
        {
            name: 'prefab_open',
            description: '安全打开本项目 Prefab，等待实际根节点。blocked/pending/unconfirmed 时禁止自动重试或保存。只在 opened/already_open 后回读实例。',
            inputSchema: { type: 'object', properties: { asset: { type: 'string', description: 'db://assets URL、项目内绝对路径或标准资源 UUID' } }, required: ['asset'], additionalProperties: false },
            handler: args => local.openPrefab(args.asset),
        },
        {
            name: 'scene_open_scene',
            description: '打开场景',
            inputSchema: {
                type: 'object',
                properties: { uuid: { type: 'string', description: '场景资源 uuid' }, expectedAssetUuid: { type: 'string', description: '可选：预期当前编辑资源 UUID，用于检测页面已切换' } },
                required: ['uuid'],
            },
            handler: async function (args) {
                return local.runEditorAction('scene', args, () => msg('scene', 'open-scene', args.uuid), async () => {
                    const info = await msg('asset-db', 'query-asset-info', args.uuid);
                    if (!info || info.uuid !== args.uuid || info.type !== 'cc.SceneAsset' ||
                        !info.url?.startsWith('db://assets/') || info.invalid) throw Error('INVALID_SCENE');
                });
            },
        },
        {
            name: 'scene_save_scene',
            description: '保存明确指定的当前编辑资源。必须传 expectedAssetUuid，需已获得保存该资源的授权。',
            inputSchema: { type: 'object', properties: { expectedAssetUuid: { type: 'string' } }, required: ['expectedAssetUuid'] },
            handler: args => local.runEditorAction('save', args, () => msg('scene', 'save-scene')),
        },
        {
            name: 'scene_soft_reload',
            description: '仅在当前编辑内容已保存时软重载，返回完成或保护状态。',
            inputSchema: { type: 'object', properties: { expectedAssetUuid: { type: 'string' } } },
            handler: args => local.runEditorAction('reload', args, () => msg('scene', 'soft-reload')),
        },
        {
            name: 'scene_execute_component_method',
            description: '调用指定节点组件上的方法。组件方法内不得再次同步请求同一 Scene 通道；调用扩展 scene.js 方法请直接使用 scene_execute_script。',
            inputSchema: {
                type: 'object',
                properties: {
                    uuid: { type: 'string' },
                    name: { type: 'string', description: '方法名' },
                    args: { type: 'array', items: {} },
                },
                required: ['uuid', 'name'],
            },
            handler: async function (args) {
                return await msg('scene', 'execute-component-method', {
                    uuid: args.uuid,
                    name: args.name,
                    args: args.args || [],
                });
            },
        },
        {
            name: 'scene_execute_script',
            description: '直接调用编辑器扩展的 Scene 脚本方法。用于需要 execute-scene-script 的扩展能力，避免组件方法内再次请求同一 Scene 通道造成重入等待。',
            inputSchema: {
                type: 'object',
                properties: {
                    extension: { type: 'string', description: '扩展 package.json 的 name' },
                    method: { type: 'string', description: '扩展 scene.js 导出的 methods 方法名' },
                    args: { type: 'array', items: {}, description: '传给 Scene 脚本方法的参数列表' },
                },
                required: ['extension', 'method'],
            },
            handler: async function (args) {
                return await msg('scene', 'execute-scene-script', {
                    name: args.extension,
                    method: args.method,
                    args: args.args || [],
                });
            },
        },

        // ── asset-db 域 ──
        {
            name: 'asset_query_assets',
            description: '按 pattern 列出资源（glob，如 db://assets/**/*.prefab）',
            inputSchema: {
                type: 'object',
                properties: {
                    pattern: { type: 'string' },
                    ccType: { type: 'string', description: '可选：cc 类型过滤，如 cc.Prefab' },
                },
            },
            handler: async function (args) {
                var assets = await msg('asset-db', 'query-assets', {
                    pattern: args.pattern,
                    ccType: args.ccType,
                });
                return { assets: assets || [] };
            },
        },
        {
            name: 'asset_query_info',
            description: '按 url 或 uuid 查询资源元数据',
            inputSchema: {
                type: 'object',
                properties: {
                    urlOrUUID: { type: 'string' },
                },
                required: ['urlOrUUID'],
            },
            handler: async function (args) {
                return await msg('asset-db', 'query-asset-info', args.urlOrUUID);
            },
        },
        {
            name: 'asset_query_url',
            description: '由 uuid 反查 url',
            inputSchema: {
                type: 'object',
                properties: { uuid: { type: 'string' } },
                required: ['uuid'],
            },
            handler: async function (args) {
                return await msg('asset-db', 'query-url', args.uuid);
            },
        },
        {
            name: 'asset_query_uuid',
            description: '由 url 反查 uuid',
            inputSchema: {
                type: 'object',
                properties: { url: { type: 'string' } },
                required: ['url'],
            },
            handler: async function (args) {
                return await msg('asset-db', 'query-uuid', args.url);
            },
        },
        {
            name: 'asset_refresh',
            description: '刷新资源（可指定子目录）',
            inputSchema: {
                type: 'object',
                properties: { url: { type: 'string', description: '默认 db://assets/' } },
            },
            handler: async function (args) {
                return await msg('asset-db', 'refresh-asset', args.url || 'db://assets/');
            },
        },
        {
            name: 'asset_reimport_confirm',
            description: '定向重导入并核对源文件、meta、导入状态和子资源。import.status 为 imported 才确认资源导入；实例更新须另外校验。',
            inputSchema: { type: 'object', properties: { url: { type: 'string' }, expectedAssetUuid: { type: 'string' } }, required: ['url', 'expectedAssetUuid'] },
            handler: args => local.reimportConfirm(args),
        },
        {
            name: 'asset_reimport',
            description: '重新导入指定资源',
            inputSchema: {
                type: 'object',
                properties: { url: { type: 'string' } },
                required: ['url'],
            },
            handler: async function (args) {
                return await msg('asset-db', 'reimport-asset', args.url);
            },
        },
        {
            name: 'asset_create',
            description: '创建资源（文本内容）',
            inputSchema: {
                type: 'object',
                properties: {
                    url: { type: 'string' },
                    content: { type: 'string' },
                    overwrite: { type: 'boolean' },
                },
                required: ['url', 'content'],
            },
            handler: async function (args) {
                return await msg('asset-db', 'create-asset', args.url, args.content, { overwrite: !!args.overwrite });
            },
        },
        {
            name: 'asset_save',
            description: '保存已有资源内容',
            inputSchema: {
                type: 'object',
                properties: {
                    url: { type: 'string' },
                    content: { type: 'string' },
                },
                required: ['url', 'content'],
            },
            handler: async function (args) {
                return await msg('asset-db', 'save-asset', args.url, args.content);
            },
        },
        {
            name: 'asset_delete',
            description: '删除资源',
            inputSchema: {
                type: 'object',
                properties: { url: { type: 'string' } },
                required: ['url'],
            },
            handler: async function (args) {
                return await msg('asset-db', 'delete-asset', args.url);
            },
        },
        {
            name: 'asset_move',
            description: '移动资源',
            inputSchema: {
                type: 'object',
                properties: {
                    source: { type: 'string' },
                    target: { type: 'string' },
                },
                required: ['source', 'target'],
            },
            handler: async function (args) {
                return await msg('asset-db', 'move-asset', args.source, args.target);
            },
        },

        // ── preview 域 ──
        {
            name: 'preview_query_url',
            description: '查询当前预览地址',
            inputSchema: { type: 'object', properties: {} },
            handler: async function () {
                return { url: await local.getPreviewUrl() };
            },
        },
        {
            name: 'preview_refresh_and_reload',
            description: '在同一编辑上下文保护下刷新资源并软重载。未保存或状态未知时阻止。',
            inputSchema: { type: 'object', properties: { expectedAssetUuid: { type: 'string' } }, required: ['expectedAssetUuid'] },
            handler: args => local.runEditorAction('reload', args, async controls => {
                await controls.write(() => local.doRefreshAssets());
                const current = await controls.read(() => local.queryContext());
                if (current.dirty !== false || current.assetUuid !== args.expectedAssetUuid) throw Error('CONTEXT_CONFLICT');
                await controls.write(() => local.doReloadScene());
            }, undefined, true),
        },

        // ── local 域 ──
        {
            name: 'local_reload_package',
            description: 'reload（disable→enable）指定编辑器扩展，让其 JS 代码改动生效，无需重启编辑器。本质 Editor.Package.disable→enable，fire-and-forget 立即返回。',
            inputSchema: {
                type: 'object',
                properties: { name: { type: 'string', description: '扩展名（package.json 的 name，如 state-ctrl-gen）' } },
                required: ['name'],
            },
            handler: async function (args) {
                local.reloadPackage(args.name);
                return { ok: true, reloaded: args.name };
            },
        },
        {
            name: 'local_get_status',
            description: '获取插件本地状态（git 分支/HEAD、watchers、预览、命令日志）',
            inputSchema: { type: 'object', properties: {} },
            handler: async function () {
                return await local.getStatus();
            },
        },
        {
            name: 'local_list_worktrees',
            description: '扫描同机其他 worktree 的 dev-reload-info.json',
            inputSchema: { type: 'object', properties: {} },
            handler: async function () {
                return local.listWorktrees();
            },
        },
        {
            name: 'local_open_dev_dir',
            description: '在 Finder 打开 .dev 目录',
            inputSchema: { type: 'object', properties: {} },
            handler: async function () {
                return local.openDevDir();
            },
        },
        {
            name: 'local_clean_dev_dir',
            description: '清理 .dev 临时产物',
            inputSchema: { type: 'object', properties: {} },
            handler: async function () {
                return local.cleanDevDir();
            },
        },
        {
            name: 'meta_fix',
            description: '清理 Cocos 重启造成的图片 meta 噪音（保守，只还原能确认是破坏的）：① 纯 key 顺序/格式变化还原 git 原文；② 九宫格 border 被重置成 0 精准还原；③ trimType 从 none 被改成自动裁剪还原该 frame 到 git。靠 git 对比、正确处理中文路径。dryRun=true 只预览不写。',
            inputSchema: {
                type: 'object',
                properties: { dryRun: { type: 'boolean', description: 'true=只预览不写文件，列出将还原的 meta' } },
            },
            handler: async function (args) {
                return local.fixMeta({ dryRun: !!(args && args.dryRun) });
            },
        },
    ].map(tool => {
        // 顶层参数严格校验；dump、脚本 args 等嵌套内容继续遵循自身开放 schema。
        tool.inputSchema.additionalProperties = false;
        return tool;
    });
}

function defineResources(ctx) {
    var msg = ctx.msg;
    var local = ctx.local;
    return [
        {
            uri: 'cocos://project/info',
            name: 'Project Info',
            description: '项目路径、名称、引擎版本',
            mimeType: 'application/json',
            read: async function () {
                return await local.getStatus();
            },
        },
        {
            uri: 'cocos://scene/tree',
            name: 'Current Scene Tree',
            description: '当前场景节点树 dump',
            mimeType: 'application/json',
            read: async function () {
                return await msg('scene', 'query-node-tree');
            },
        },
        {
            uri: 'cocos://preview/url',
            name: 'Preview URL',
            description: '当前预览地址',
            mimeType: 'text/plain',
            read: async function () {
                return await local.getPreviewUrl();
            },
        },
    ];
}

module.exports = { defineTools: defineTools, defineResources: defineResources };
