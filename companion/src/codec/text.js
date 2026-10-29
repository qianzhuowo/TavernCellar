/**
 * Text normalization shared by codecs.
 * Editors on Windows may rewrite LF as CRLF or add a BOM. When the original value had neither,
 * we normalize edited files back; when it did, files are taken verbatim so round-trips stay lossless.
 */

/** True when a value must be stored/restored verbatim (contains CR or starts with a BOM). */
export function needsRaw(text) {
    return typeof text === 'string' && (text.includes('\r') || text.startsWith('\uFEFF'));
}

/**
 * @param {string} text file content
 * @param {boolean} raw keep the content verbatim
 */
export function normalizeText(text, raw) {
    if (raw) return text;
    const out = text.startsWith('\uFEFF') ? text.slice(1) : text;
    return out.replace(/\r\n?/g, '\n');
}

/** Makes a string safe as a single Windows/POSIX path segment. */
export function safeSegment(name, maxLength = 80) {
    let out = String(name)
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
        .replace(/[. ]+$/g, '')
        .trim();
    if (!out) out = '_';
    if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(out)) out = `_${out}`;
    if (out.length > maxLength) out = out.slice(0, maxLength).replace(/[. ]+$/g, '');
    return out || '_';
}
