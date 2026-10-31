// Entry-by-entry writes for lorebooks (POST /api/item/entries): the ops between two versions of a decoded book.
export const clone = (/** @type {any} */ v) => JSON.parse(JSON.stringify(v));
const entriesOf = (/** @type {any} */ d) => (d && d.entries && typeof d.entries === 'object' ? Object.values(d.entries).filter((e) => e && typeof e === 'object') : null);

/**
 * Lorebooks are written entry by entry: compares `now` with the last written snapshot and returns entry ops
 * (delete, set with patch/unset, create in uid order), or null when something outside the entries changed or the
 * snapshot is unusable (then the whole item is written).
 * @param {any} prev last written data (plain) @param {any} now data to write (plain)
 */
export function entryOpsBetween(prev, now) {
  const before = entriesOf(prev), after = entriesOf(now);
  if (!before || !after) return null;
  const { entries: _a, ...restPrev } = prev;
  const { entries: _b, ...restNow } = now;
  if (JSON.stringify(restPrev) !== JSON.stringify(restNow)) return null;
  const old = new Map(), cur = new Map();
  for (const e of before) { if (!Number.isInteger(e.uid)) return null; old.set(e.uid, e); }
  for (const e of after) { if (!Number.isInteger(e.uid) || cur.has(e.uid)) return null; cur.set(e.uid, e); }
  /** @type {any[]} */
  const ops = [];
  for (const uid of old.keys()) if (!cur.has(uid)) ops.push({ op: 'delete', uid });
  const creates = [];
  for (const [uid, e] of cur) {
    const o = old.get(uid);
    if (!o) { creates.push(uid); continue; }
    /** @type {Record<string, any>} */
    const patch = {};
    for (const k of Object.keys(e)) if (k !== 'uid' && JSON.stringify(e[k]) !== JSON.stringify(o[k])) patch[k] = e[k];
    const unset = Object.keys(o).filter((k) => k !== 'uid' && !(k in e));
    if (Object.keys(patch).length || unset.length) ops.push({ op: 'set', uid, patch, ...(unset.length ? { unset } : {}) });
  }
  creates.sort((a, b) => a - b);
  for (const uid of creates) { const { uid: _u, ...entry } = cur.get(uid); ops.push({ op: 'create', entry }); }
  return { ops, creates };
}
