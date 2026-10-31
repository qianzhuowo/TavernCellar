// Helpers to show one slot (a field, entry, script…) from the conflict API: {workspace, tavern, base} sides of
// shape {value, present}.
import { diffText } from './diff.js';

export const isPlain = (/** @type {any} */ v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const fmt = (/** @type {any} */ v) => (v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v, null, 2));
const same = (/** @type {any} */ a, /** @type {any} */ b) => JSON.stringify(a) === JSON.stringify(b);

/** 'text' (inline diff) | 'object' (only differing fields) | 'json' (side by side). */
export function kindOf(/** @type {any} */ s) {
  const vals = [s.workspace, s.tavern].filter((x) => x.present).map((x) => x.value);
  if (vals.length && vals.every((v) => typeof v === 'string')) return 'text';
  if (vals.length && vals.every(isPlain)) return 'object';
  return 'json';
}

/** Fields of an object slot that differ between the two sides, with the base value when known. */
export function fieldRows(/** @type {any} */ s) {
  const w = s.workspace.present ? s.workspace.value : {};
  const t = s.tavern.present ? s.tavern.value : {};
  const b = s.base.present && isPlain(s.base.value) ? s.base.value : null;
  const keys = [...new Set([...Object.keys(w), ...Object.keys(t)])];
  return keys.filter((k) => !same(w[k], t[k])).map((k) => ({ key: k, ws: w[k], tv: t[k], base: b ? b[k] : undefined, hasBase: !!b }));
}

/**
 * Inline diff turning `from` into `to`. Whitespace-only pieces next to real changes are not highlighted (a lone
 * newline would show as an empty marker).
 */
export function parts(/** @type {any} */ from, /** @type {any} */ to) {
  const out = diffText(fmt(from), fmt(to));
  const real = out.some((p) => p[0] !== '=' && p[1].trim());
  return real ? out.map((p) => (p[0] !== '=' && !p[1].trim() ? /** @type {[any, string]} */ (['=', p[0] === '-' ? '' : p[1]]) : p)) : out;
}
