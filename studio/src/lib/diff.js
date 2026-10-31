// Inline text diff for the conflict view.
// Common prefix/suffix are trimmed first (most edits append or change one passage); the remaining middle gets a
// character LCS only while it stays small, otherwise it is shown as one replaced block.

/** @typedef {['=' | '+' | '-', string]} Part */

const LCS_LIMIT = 250000; // cells of the LCS table (middle length a * b)

/** @param {string} a @param {string} b @returns {Part[]} */
function lcs(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  /** @type {Part[]} */
  const out = [];
  const push = (/** @type {Part[0]} */ op, /** @type {string} */ ch) => { const l = out[out.length - 1]; if (l && l[0] === op) l[1] += ch; else out.push([op, ch]); };
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { push('=', a[i]); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) push('-', a[i++]); else push('+', b[j++]);
  }
  while (i < n) push('-', a[i++]);
  while (j < m) push('+', b[j++]);
  return out;
}

/** Parts turning `from` into `to`. @param {string} from @param {string} to @returns {Part[]} */
export function diffText(from, to) {
  if (from === to) return from ? [['=', from]] : [];
  let p = 0;
  const max = Math.min(from.length, to.length);
  while (p < max && from[p] === to[p]) p++;
  let s = 0;
  while (s < max - p && from[from.length - 1 - s] === to[to.length - 1 - s]) s++;
  const a = from.slice(p, from.length - s), b = to.slice(p, to.length - s);
  /** @type {Part[]} */
  const mid = a.length * b.length <= LCS_LIMIT ? lcs(a, b) : [...(a ? [['-', a]] : []), ...(b ? [['+', b]] : [])];
  /** @type {Part[]} */
  const out = [];
  if (p) out.push(['=', from.slice(0, p)]);
  out.push(...mid);
  if (s) out.push(['=', from.slice(from.length - s)]);
  return out;
}
