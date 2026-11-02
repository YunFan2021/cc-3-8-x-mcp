'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanFiles } = require('../src/file-scan');

test('扫描中文、空格及多层目录，保留根目录顺序并筛选文件类型', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-file-scan-'));
  try {
    const first = path.join(temp, '中文 空格', 'assets');
    const second = path.join(temp, 'extensions');
    fs.mkdirSync(path.join(first, 'deep'), { recursive: true });
    fs.mkdirSync(second);
    fs.writeFileSync(path.join(first, 'deep', 'Item.ts'), '');
    fs.writeFileSync(path.join(first, 'deep', 'types.d.ts'), '');
    fs.writeFileSync(path.join(first, 'deep', 'Item.prefab.meta'), '{}');
    fs.writeFileSync(path.join(second, 'Other.ts'), '');
    assert.deepEqual(scanFiles([first, second], name => name.endsWith('.ts') && !name.endsWith('.d.ts')), [
      path.join(first, 'deep', 'Item.ts'), path.join(second, 'Other.ts'),
    ]);
    assert.deepEqual(scanFiles([first], name => name.endsWith('.prefab.meta')), [
      path.join(first, 'deep', 'Item.prefab.meta'),
    ]);
    assert.throws(() => scanFiles([path.join(temp, 'missing')], () => true), /ENOENT/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('不跟随目录链接，避免重复扫描和循环引用', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-file-scan-'));
  try {
    const root = path.join(temp, 'root');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'Item.ts'), '');
    fs.symlinkSync(root, path.join(root, 'loop'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.deepEqual(scanFiles([root], name => name.endsWith('.ts')), [path.join(root, 'Item.ts')]);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
