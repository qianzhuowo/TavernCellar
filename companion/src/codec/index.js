import { CHARACTER_CODEC_VERSION, decodeCharacter, encodeCharacter, ownsCharacterFile } from './character.js';
import { decodeLorebook, encodeLorebook, LOREBOOK_CODEC_VERSION, ownsLorebookFile } from './lorebook.js';

/**
 * Per-kind codec registry. `folder` is the workspace top-level directory; `nameOf` derives the item folder name.
 * `owns(rel)` tells which files in an item folder belong to the codec: only those are ever deleted when the
 * tavern version is written back, so users can keep their own notes next to the card.
 * `version` is the layout version written to cellar-item.json (`codec`); items with an older one are re-laid out
 * on startup (content unchanged, so hashes and sync state stay valid).
 */
export const CODECS = Object.freeze({
    character: {
        folder: 'characters',
        nameOf: id => id.replace(/\.png$/i, ''),
        decode: data => decodeCharacter(data),
        encode: (files) => encodeCharacter(files),
        owns: rel => ownsCharacterFile(rel),
        version: CHARACTER_CODEC_VERSION,
    },
    lorebook: {
        folder: 'lorebooks',
        nameOf: id => id,
        decode: (data, options) => decodeLorebook(data, options),
        encode: (files, options) => encodeLorebook(files, options),
        owns: rel => ownsLorebookFile(rel),
        version: LOREBOOK_CODEC_VERSION,
    },
});

export function codecFor(kind) {
    const codec = CODECS[kind];
    if (!codec) throw new Error(`No codec for kind: ${kind}`);
    return codec;
}
