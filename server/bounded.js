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
module.exports = { bounded };
