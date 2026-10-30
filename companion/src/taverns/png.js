/**
 * Character card metadata in PNG tEXt chunks, matching SillyTavern (src/character-card-parser.js)
 * and TauriTavern (png_card_metadata.rs):
 *   read:  `ccv3` takes precedence over `chara`; both are base64 UTF-8 JSON.
 *   write: drop existing `chara`/`ccv3`, insert `chara` (data as given) and `ccv3` (spec patched to v3) before IEND.
 * All other chunks, including the image data, are kept byte for byte.
 */
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CARD_KEYS = ['chara', 'ccv3'];

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(buffers) {
    let crc = 0xffffffff;
    for (const buf of buffers) for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

/** @returns {Array<{type: string, data: Buffer, raw: Buffer}>} raw = the full chunk bytes */
export function readChunks(png) {
    if (png.length < 8 || !png.subarray(0, 8).equals(SIGNATURE)) throw new Error('Not a PNG file');
    const chunks = [];
    let pos = 8;
    while (pos + 12 <= png.length) {
        const length = png.readUInt32BE(pos);
        const end = pos + 12 + length;
        if (end > png.length) throw new Error('Truncated PNG chunk');
        const type = png.toString('latin1', pos + 4, pos + 8);
        chunks.push({ type, data: png.subarray(pos + 8, pos + 8 + length), raw: png.subarray(pos, end) });
        pos = end;
        if (type === 'IEND') break;
    }
    if (chunks.at(-1)?.type !== 'IEND') throw new Error('PNG has no IEND chunk');
    return chunks;
}

function decodeText(data) {
    const zero = data.indexOf(0);
    if (zero < 0) return null;
    return { keyword: data.toString('latin1', 0, zero), text: data.toString('latin1', zero + 1) };
}

function encodeChunk(type, data) {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32([head.subarray(4), data]), 0);
    return Buffer.concat([head, data, crc]);
}

function textChunk(keyword, text) {
    return encodeChunk('tEXt', Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0]), Buffer.from(text, 'latin1')]));
}

/** @returns {string} raw card JSON text stored in the PNG */
export function readCardText(png) {
    const texts = readChunks(png).filter(c => c.type === 'tEXt').map(c => decodeText(c.data)).filter(Boolean);
    for (const key of ['ccv3', 'chara']) {
        const found = texts.find(t => t.keyword.toLowerCase() === key);
        if (found) return Buffer.from(found.text, 'base64').toString('utf8');
    }
    throw new Error('PNG metadata does not contain character data');
}

/** @param {object} card card JSON as the tavern would store it in `chara` */
export function writeCard(png, card) {
    const json = JSON.stringify(card);
    const v3 = JSON.stringify({ ...card, spec: 'chara_card_v3', spec_version: '3.0' });
    const kept = readChunks(png).filter(c => {
        if (c.type !== 'tEXt') return true;
        const text = decodeText(c.data);
        return !(text && CARD_KEYS.includes(text.keyword.toLowerCase()));
    });
    const iend = kept.pop();
    return Buffer.concat([
        SIGNATURE,
        ...kept.map(c => c.raw),
        textChunk('chara', Buffer.from(json, 'utf8').toString('base64')),
        textChunk('ccv3', Buffer.from(v3, 'utf8').toString('base64')),
        iend.raw,
    ]);
}
