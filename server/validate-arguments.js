'use strict';

// 验证当前工具表采用的 schema 子集。任意内容参数（dump、args）保持其声明的开放结构。
function validateArguments(schema, value, path = '$') {
    const fail = message => ({ code: 'INVALID_ARGUMENTS', path, message });
    if (schema.enum && !schema.enum.includes(value)) return fail('Value is not in enum');
    if (schema.type) {
        const valid = schema.type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
            : schema.type === 'array' ? Array.isArray(value)
            : schema.type === 'integer' ? Number.isInteger(value)
            : schema.type === 'number' ? typeof value === 'number' && Number.isFinite(value)
            : typeof value === schema.type;
        if (!valid) return fail('Expected ' + schema.type);
    }
    if (schema.type === 'object') {
        for (const key of schema.required || []) {
            if (!Object.prototype.hasOwnProperty.call(value, key)) return fail('Missing required property ' + key);
        }
        for (const key of Object.keys(value)) {
            const child = Object.prototype.hasOwnProperty.call(schema.properties || {}, key) ? schema.properties[key] : null;
            if (!child && schema.additionalProperties === false) return fail('Unknown property ' + key);
            if (child) {
                const error = validateArguments(child, value[key], path + '.' + key);
                if (error) return error;
            }
        }
    }
    if (schema.type === 'array' && schema.items) {
        for (let i = 0; i < value.length; i++) {
            const error = validateArguments(schema.items, value[i], path + '[' + i + ']');
            if (error) return error;
        }
    }
    return null;
}
module.exports = { validateArguments };
