'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 使用 Node 扫描指定目录，避免依赖平台同名但语义不同的 find 命令。
 * 保留根目录顺序，返回绝对路径；不跟随符号链接，与 find 默认行为一致。
 * 读取失败向调用方抛出，由解析器添加错误上下文，不返回不完整索引。
 * @param {string[]} roots 要扫描的已存在目录
 * @param {(name: string) => boolean} acceptFile 文件名筛选条件
 * @returns {string[]} 匹配文件的绝对路径
 */
function scanFiles(roots, acceptFile) {
  const files = [];
  /** 按文件系统条目递归，目录链接不会通过 isDirectory 检查。 */
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile() && acceptFile(entry.name)) files.push(fullPath);
    }
  }
  for (const root of roots) visit(path.resolve(root));
  return files;
}

module.exports = { scanFiles };
