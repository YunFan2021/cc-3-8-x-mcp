'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const { parseWindowsPreviewConnections, countPreviewConnections, assertNoDebugSession } = require('../src/editor-control');

test('Windows 只统计本地预览端口、所属进程和 ESTABLISHED，支持 IPv4/IPv6', () => {
    const output = [
        'TCP 0.0.0.0:7456 0.0.0.0:0 LISTENING 5904',
        'TCP 127.0.0.1:7456 127.0.0.1:4000 ESTABLISHED 5904',
        'TCP [::1]:7456 [::1]:4001 ESTABLISHED 5904',
        'TCP 127.0.0.1:7456 127.0.0.1:4002 TIME_WAIT 5904',
        'TCP 127.0.0.1:7456 127.0.0.1:4003 ESTABLISHED 12336',
        'TCP 127.0.0.1:17456 127.0.0.1:4004 ESTABLISHED 5904',
        'TCP 127.0.0.1:4005 127.0.0.1:7456 ESTABLISHED 5904',
        'UDP 0.0.0.0:7456 *:* 5904',
    ].join('\r\n');
    assert.equal(parseWindowsPreviewConnections(output, 5904, 7456), 2);
    assert.equal(parseWindowsPreviewConnections('', 5904, 7456), 0);
});

test('Windows 查询失败时拒绝编辑器操作，不静默放行', { skip: process.platform !== 'win32' }, () => {
    const original = cp.execFileSync;
    try {
        cp.execFileSync = () => { throw new Error('netstat unavailable'); };
        assert.throws(() => countPreviewConnections(process.pid, 7456), /无法核对 Windows 预览连接/);
        assert.throws(() => assertNoDebugSession('editor_restart', {
            pid: process.pid, projectPath: '/no/such/project',
        }, false), /无法核对 Windows 预览连接/);
    } finally {
        cp.execFileSync = original;
    }
});
