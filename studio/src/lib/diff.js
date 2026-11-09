// Text diffs: the inline character diff (conflict view, full-file view) and the compact line diff with hunks.
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

/**
 * Equal runs of one or two characters between edits are coincidences ("none" -> "示例角色.png" shares an "n"), and
 * keeping them interleaves both strings into something unreadable. Fold them into the surrounding edit, so each
 * changed stretch shows as one deletion followed by one insertion.
 * @param {Part[]} parts @returns {Part[]}
 */
function foldCoincidences(parts) {
  /** @type {Part[]} */
  const out = [];
  let del = '', ins = '';
  const flush = () => { if (del) out.push(['-', del]); if (ins) out.push(['+', ins]); del = ins = ''; };
  parts.forEach((p, i) => {
    if (p[0] === '-') del += p[1];
    else if (p[0] === '+') ins += p[1];
    else if ((del || ins) && i < parts.length - 1 && p[1].length <= 2) { del += p[1]; ins += p[1]; }
    else { flush(); out.push(p); }
  });
  flush();
  return out;
}

const LINE_LIMIT = 4000000; // cells of the line LCS table

/**
 * Edit script turning lines `la` into lines `lb` (line LCS), one op per line: '=' consumes one of each, '-' one of
 * `la`, '+' one of `lb`. Deletions come before insertions within a changed stretch. null when too large.
 * @param {string[]} la @param {string[]} lb @returns {Part[0][] | null}
 */
function lineOps(la, lb) {
  const n = la.length, m = lb.length;
  if (n * m > LINE_LIMIT) return null;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = la[i] === lb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  /** @type {Part[0][]} */
  const ops = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && la[i] === lb[j]) { ops.push('='); i++; j++; }
    else if (j >= m || (i < n && dp[i + 1][j] >= dp[i][j + 1])) { ops.push('-'); i++; }
    else { ops.push('+'); j++; }
  }
  return ops;
}

/**
 * Long texts with changes far apart: match whole lines first (like VS Code's diff), then refine each changed stretch
 * by characters when it is small enough, otherwise mark the stretch as replaced.
 * @param {string} a @param {string} b @returns {Part[]}
 */
function byLines(a, b) {
  const la = a.match(/[^\n]*\n|[^\n]+$/g) || [], lb = b.match(/[^\n]*\n|[^\n]+$/g) || [];
  const ops = lineOps(la, lb);
  if (!ops) return [...(a ? [['-', a]] : []), ...(b ? [['+', b]] : [])];
  /** @type {Part[]} */
  const out = [];
  let del = '', ins = '';
  const flush = () => {
    if (del && ins && del.length * ins.length <= LCS_LIMIT) out.push(...foldCoincidences(lcs(del, ins)));
    else { if (del) out.push(['-', del]); if (ins) out.push(['+', ins]); }
    del = ins = '';
  };
  let i = 0, j = 0;
  for (const op of ops) {
    if (op === '=') {
      flush();
      const l = out[out.length - 1];
      if (l && l[0] === '=') l[1] += la[i]; else out.push(['=', la[i]]);
      i++; j++;
    } else if (op === '-') del += la[i++];
    else ins += lb[j++];
  }
  flush();
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
  const mid = a.length * b.length <= LCS_LIMIT ? foldCoincidences(lcs(a, b)) : byLines(a, b);
  /** @type {Part[]} */
  const out = [];
  if (p) out.push(['=', from.slice(0, p)]);
  out.push(...mid);
  if (s) out.push(['=', from.slice(from.length - s)]);
  return out;
}

// ---- compact line diff (version history, pending changes) ----

/**
 * @typedef {{op: Part[0], text: string, a: number|null, b: number|null, parts?: Part[]}} DiffLine
 * One line: op, text without its line break, 1-based line numbers in `from` (a) and `to` (b), and for a changed
 * line paired with its counterpart the inline parts of this side ('=' plus its own '-' or '+').
 * @typedef {{gap: boolean, lines: DiffLine[]}} DiffBlock  changed lines with context, or a run of unchanged lines
 */

/** Inline marks only when a changed pair is mostly the same line; otherwise both lines read as replaced. */
const PAIR_SIMILAR = 0.4;
const PAIR_LIMIT = 40000; // cells of the character LCS of one line pair

/** Pairs the k-th deleted line with the k-th inserted line of a changed stretch for inline highlighting. */
function pairInline(/** @type {DiffLine[]} */ dels, /** @type {DiffLine[]} */ inss) {
  for (let k = 0; k < Math.min(dels.length, inss.length); k++) {
    const d = dels[k], s = inss[k];
    if (d.text.length * s.text.length > PAIR_LIMIT) continue;
    const parts = diffText(d.text, s.text);
    const kept = parts.filter((p) => p[0] === '=').reduce((n, p) => n + p[1].length, 0);
    if (kept < PAIR_SIMILAR * Math.max(d.text.length, s.text.length)) continue;
    d.parts = parts.filter((p) => p[0] !== '+');
    s.parts = parts.filter((p) => p[0] !== '-');
  }
}

/**
 * Line diff of `from` -> `to` as blocks: changed lines with `context` unchanged lines around them, and the unchanged
 * runs between as gap blocks (shown collapsed). Common leading/trailing lines are trimmed before the line LCS; a
 * middle too large for it is shown as all lines removed then added.
 * @param {string} from @param {string} to @param {number} [context] @returns {DiffBlock[]}
 */
export function diffLines(from, to, context = 3) {
  const la = from === '' ? [] : from.split(/\r?\n/), lb = to === '' ? [] : to.split(/\r?\n/);
  let p = 0;
  while (p < la.length && p < lb.length && la[p] === lb[p]) p++;
  let s = 0;
  while (s < la.length - p && s < lb.length - p && la[la.length - 1 - s] === lb[lb.length - 1 - s]) s++;
  const ma = la.slice(p, la.length - s), mb = lb.slice(p, lb.length - s);
  const mid = lineOps(ma, mb) || [...ma.map(() => /** @type {Part[0]} */ ('-')), ...mb.map(() => /** @type {Part[0]} */ ('+'))];
  const ops = [...Array(p).fill('='), ...mid, ...Array(s).fill('=')];
  /** @type {DiffLine[]} */
  const lines = [];
  let i = 0, j = 0;
  /** @type {DiffLine[]} */ let dels = [];
  /** @type {DiffLine[]} */ let inss = [];
  const flush = () => { pairInline(dels, inss); dels = []; inss = []; };
  for (const op of ops) {
    if (op === '=') { flush(); lines.push({ op, text: la[i], a: ++i, b: ++j }); }
    else if (op === '-') { if (inss.length) flush(); const l = { op, text: la[i], a: ++i, b: null }; dels.push(l); lines.push(l); }
    else { const l = { op, text: lb[j], a: null, b: ++j }; inss.push(l); lines.push(l); }
  }
  flush();
  // Unchanged lines farther than `context` from any change fold into gaps.
  const near = lines.map(() => false);
  lines.forEach((l, k) => { if (l.op !== '=') for (let x = Math.max(0, k - context); x <= Math.min(lines.length - 1, k + context); x++) near[x] = true; });
  /** @type {DiffBlock[]} */
  const blocks = [];
  lines.forEach((l, k) => {
    const gap = !near[k];
    const last = blocks[blocks.length - 1];
    if (last && last.gap === gap) last.lines.push(l); else blocks.push({ gap, lines: [l] });
  });
  // A fold of one or two lines saves nothing: show them.
  return blocks.reduce((/** @type {DiffBlock[]} */ out, blk) => {
    const shown = blk.gap && blk.lines.length <= 2 ? { gap: false, lines: blk.lines } : blk;
    const last = out[out.length - 1];
    if (last && !last.gap && !shown.gap) last.lines.push(...shown.lines); else out.push(shown);
    return out;
  }, []);
}
