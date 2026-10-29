/**
 * Stable hashing shared by Cellar Link (browser) and the companion (Node).
 * Both environments expose WebCrypto as globalThis.crypto.subtle.
 */

/**
 * JSON.stringify with object keys sorted recursively. Arrays keep their order.
 * Keys whose value is undefined/function/symbol are dropped, matching JSON.stringify.
 * @param {unknown} value
 * @returns {string}
 */
export function stableStringify(value) {
    return JSON.stringify(sortDeep(value));
}

function sortDeep(value) {
    if (Array.isArray(value)) {
        return value.map(item => {
            const sorted = sortDeep(item);
            return sorted === undefined ? null : sorted;
        });
    }
    if (value && typeof value === 'object') {
        if (typeof value.toJSON === 'function') {
            return sortDeep(value.toJSON());
        }
        const out = Object.create(null); // keeps an own "__proto__" key from JSON intact
        for (const key of Object.keys(value).sort()) {
            const sorted = sortDeep(value[key]);
            if (sorted !== undefined) {
                out[key] = sorted;
            }
        }
        return out;
    }
    if (typeof value === 'function' || typeof value === 'symbol') {
        return undefined;
    }
    return value;
}

/**
 * Lists dotted paths where two JSON values differ (for human-readable warnings).
 * @returns {string[]}
 */
export function diffPaths(a, b, limit = 10, prefix = '', out = []) {
    if (out.length >= limit || stableStringify(a) === stableStringify(b)) return out;
    const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
    if (isObj(a) && isObj(b)) {
        for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
            diffPaths(a[key], b[key], limit, prefix ? `${prefix}.${key}` : key, out);
        }
    } else {
        out.push(prefix || '(root)');
    }
    return out;
}

/**
 * @param {unknown} data
 * @returns {Promise<string>} lowercase hex SHA-256 of stableStringify(data)
 */
export async function hashData(data) {
    if (!globalThis.crypto?.subtle) {
        throw new Error('WebCrypto is unavailable (page is not a secure context); open the tavern via localhost/127.0.0.1');
    }
    const bytes = new TextEncoder().encode(stableStringify(data));
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
