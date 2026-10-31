// SillyTavern normalisation noise in lorebook entry diffs: ST fills in defaults for properties a file left out (or
// stores null where Studio wrote the default). Such a property differs textually but means the same on both sides.
import { isPlain } from './slot-view.js';

/** ST 1.15 newWorldInfoEntryTemplate defaults (docs/studio-design.md appendix A); used when the item has no template. */
export const ENTRY_DEFAULTS = {
  key: [], keysecondary: [], comment: '', content: '', constant: false, vectorized: false, selective: true,
  selectiveLogic: 0, addMemo: false, order: 100, position: 0, disable: false, ignoreBudget: false,
  excludeRecursion: false, preventRecursion: false, matchPersonaDescription: false, matchCharacterDescription: false,
  matchCharacterPersonality: false, matchCharacterDepthPrompt: false, matchScenario: false, matchCreatorNotes: false,
  delayUntilRecursion: 0, probability: 100, useProbability: true, depth: 4, outletName: '', group: '',
  groupOverride: false, groupWeight: 100, scanDepth: null, caseSensitive: null, matchWholeWords: null,
  useGroupScoring: null, automationId: '', role: 0, sticky: null, cooldown: null, delay: null, triggers: []
};

/** Values ST treats as "not set" for a property besides its template default. */
const ALSO_UNSET = {
  role: [0, null], sticky: [0, null], cooldown: [0, null], delay: [0, null], delayUntilRecursion: [0, false],
  characterFilter: [{ isExclude: false, names: [], tags: [] }]
};

const same = (/** @type {any} */ a, /** @type {any} */ b) => JSON.stringify(a) === JSON.stringify(b);

/** Editor-only flags that do not change what reaches the prompt (ST sets addMemo when it saves an entry). */
const DISPLAY_ONLY = new Set(['addMemo']);

/**
 * True when `key` differs only by normalisation: one side is absent/null and the other is the default (or another
 * "unset" value of that property), both sides are "unset" values (0 vs false), or the property is display-only.
 * @param {string} key @param {any} a @param {any} b @param {Record<string, any>|null} template
 */
export function isNoise(key, a, b, template) {
  if (DISPLAY_ONLY.has(key)) return true;
  const unset = (/** @type {any} */ v) => v === undefined || v === null;
  const defs = template && isPlain(template) && key in template ? [template[key]] : key in ENTRY_DEFAULTS ? [ENTRY_DEFAULTS[key]] : [];
  const unsetValues = [...defs, ...(ALSO_UNSET[key] || [])];
  const meansUnset = (/** @type {any} */ v) => unset(v) || unsetValues.some((d) => same(d, v));
  return meansUnset(a) && meansUnset(b);
}

/** Slots that are lorebook entries (standalone lorebook items). */
export const isEntrySlot = (/** @type {string} */ slot) => /^entry\./.test(slot);
