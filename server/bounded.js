'use strict';

// 有界等待只终止调用方的等待，不取消已经发出的 Creator 消息。
async function bounded(call, timeoutMs) {
    let timer;
    try {
        return await Promise.race([
            Promise.resolve().then(call),
            new Promise((_, reject) => { timer = setTimeout(() => {
                const error = new Error('Editor message timeout');
                error.code = 'TIMEOUT';
                reject(error);
            }, Math.max(1, timeoutMs)); }),
        ]);
    } finally { clearTimeout(timer); }
}
// 多步骤操作共享同一毫秒截止时间；每次排入新的异步步骤前再次检查。
function createDeadline(timeoutMs) {
    const end = Date.now() + timeoutMs;
    const check = () => { if (Date.now() >= end) { const e = new Error('Operation timeout'); e.code = 'TIMEOUT'; throw e; } };
    return { check, wait: call => bounded(() => { check(); return call(); }, end - Date.now()) };
}
module.exports = { bounded, createDeadline };
