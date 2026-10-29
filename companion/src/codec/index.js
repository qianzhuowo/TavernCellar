import { decodeCharacter, encodeCharacter } from './character.js';
import { decodeLorebook, encodeLorebook } from './lorebook.js';

/** Per-kind codec registry. `folder` is the workspace top-level directory; `nameOf` derives the item folder name. */
export const CODECS = Object.freeze({
    character: {
        folder: 'characters',
        nameOf: id => id.replace(/\.png$/i, ''),
        decode: data => decodeCharacter(data),
        encode: (files) => encodeCharacter(files),
    },
    lorebook: {
        folder: 'lorebooks',
        nameOf: id => id,
        decode: data => decodeLorebook(data),
        encode: (files, options) => encodeLorebook(files, options),
    },
});

export function codecFor(kind) {
    const codec = CODECS[kind];
    if (!codec) throw new Error(`No codec for kind: ${kind}`);
    return codec;
}
