/** Small helpers for dotted object paths ("data.extensions.depth_prompt.prompt"). */

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

export function hasPath(obj, path) {
    let cur = obj;
    for (const key of path.split('.')) {
        if (!isPlainObject(cur) || !Object.prototype.hasOwnProperty.call(cur, key)) return false;
        cur = cur[key];
    }
    return true;
}

export function getPath(obj, path) {
    let cur = obj;
    for (const key of path.split('.')) {
        if (!isPlainObject(cur)) return undefined;
        cur = cur[key];
    }
    return cur;
}

/** Sets a value, creating intermediate plain objects. Throws if an intermediate is not an object. */
export function setPath(obj, path, value) {
    const keys = path.split('.');
    let cur = obj;
    for (const key of keys.slice(0, -1)) {
        if (cur[key] === undefined) cur[key] = {};
        if (!isPlainObject(cur[key])) throw new Error(`Cannot set ${path}: ${key} is not an object`);
        cur = cur[key];
    }
    cur[keys.at(-1)] = value;
}

/** Removes the leaf key only; parents are kept even if they become empty. */
export function unsetPath(obj, path) {
    const keys = path.split('.');
    const parent = keys.length === 1 ? obj : getPath(obj, keys.slice(0, -1).join('.'));
    if (isPlainObject(parent)) delete parent[keys.at(-1)];
}

export function deepClone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export { isPlainObject };

/**
 * Paths where two JSON values differ ("data.description", "data.alternate_greetings.2"), at most `limit` of them.
 * Used to explain why workspace files do not round-trip exactly.
 */
export function diffPaths(a, b, limit = 20) {
    const out = [];
    const walk = (x, y, path) => {
        if (out.length >= limit) return;
        const bothObjects = x && y && typeof x === 'object' && typeof y === 'object' && Array.isArray(x) === Array.isArray(y);
        if (!bothObjects) {
            if (JSON.stringify(x) !== JSON.stringify(y)) out.push(path || '(root)');
            return;
        }
        for (const key of new Set([...Object.keys(x), ...Object.keys(y)])) walk(x[key], y[key], path ? `${path}.${key}` : key);
    };
    walk(a, b, '');
    return out;
}
