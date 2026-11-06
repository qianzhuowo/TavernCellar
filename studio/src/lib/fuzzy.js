// Fuzzy name matching for pickers: case-insensitive; a substring ranks above a scattered subsequence, earlier and
// tighter matches rank higher. Whitespace in the query is ignored ("银 松" matches "银松镇").

/**
 * @param {string} query
 * @param {string} text
 * @returns {number} -1 when `text` does not match, else a score (higher is better)
 */
export function fuzzyScore(query, text) {
  const q = String(query || '').toLowerCase().replace(/\s+/g, '');
  const t = String(text || '').toLowerCase();
  if (!q) return 0;
  const at = t.indexOf(q);
  if (at >= 0) return 10000 - at * 10 - (t.length - q.length);
  // subsequence: every query char in order; penalise the gaps between them
  let pos = -1;
  let gaps = 0;
  for (const ch of q) {
    const next = t.indexOf(ch, pos + 1);
    if (next < 0) return -1;
    if (pos >= 0) gaps += next - pos - 1;
    pos = next;
  }
  return Math.max(1, 5000 - gaps * 20 - (t.length - q.length));
}
