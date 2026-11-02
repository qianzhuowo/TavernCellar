import { CHARACTER_CODEC_VERSION, decodeCharacter, encodeCharacter, ownsCharacterFile } from './character.js';
import { decodeLorebook, encodeLorebook, LOREBOOK_CODEC_VERSION, ownsLorebookFile } from './lorebook.js';
import { decodeRegex, encodeRegex, ownsRegexFile, REGEX_CODEC_VERSION } from './regex.js';
import { decodePreset, encodePreset, ownsPresetFile, PRESET_CODEC_VERSION } from './preset.js';
import { parsePresetId } from '../../../shared/protocol.js';

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
        decode: (data, options) => decodeCharacter(data, options),
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
    /** Global regex scripts of a tavern (id "global"); folder regex/global. */
    regex: {
        folder: 'regex',
        nameOf: id => id,
        decode: data => decodeRegex(data),
        encode: files => encodeRegex(files),
        owns: rel => ownsRegexFile(rel),
        version: REGEX_CODEC_VERSION,
    },
    /** Tavern presets, id "<apiId>/<name>"; folder presets/<apiId>-<name> (item paths are always two segments). */
    preset: {
        folder: 'presets',
        nameOf: id => { const { apiId, name } = parsePresetId(id); return `${apiId}-${name}`; },
        decode: (data, options) => decodePreset(data, options),
        encode: files => encodePreset(files),
        owns: rel => ownsPresetFile(rel),
        version: PRESET_CODEC_VERSION,
    },
});

export function codecFor(kind) {
    const codec = CODECS[kind];
    if (!codec) throw new Error(`No codec for kind: ${kind}`);
    return codec;
}
