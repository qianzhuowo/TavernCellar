import { decodeCharacter, encodeCharacter, ownsCharacterFile } from './character.js';
import { decodeLorebook, encodeLorebook, ownsLorebookFile } from './lorebook.js';

/**
 * Per-kind codec registry. `folder` is the workspace top-level directory; `nameOf` derives the item folder name.
 * `owns(rel)` tells which files in an item folder belong to the codec: only those are ever deleted when the
 * tavern version is written back, so users can keep their own notes next to the card.
 */
export const CODECS = Object.freeze({
    character: {
        folder: 'characters',
        nameOf: id => id.replace(/\.png$/i, ''),
        decode: data => decodeCharacter(data),
        encode: (files) => encodeCharacter(files),
        owns: rel => ownsCharacterFile(rel),
    },
    lorebook: {
        folder: 'lorebooks',
        nameOf: id => id,
        decode: data => decodeLorebook(data),
        encode: (files, options) => encodeLorebook(files, options),
        owns: rel => ownsLorebookFile(rel),
    },
});

export function codecFor(kind) {
    const codec = CODECS[kind];
    if (!codec) throw new Error(`No codec for kind: ${kind}`);
    return codec;
}
