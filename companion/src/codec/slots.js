/**
 * Slot-level view of items for three-way merge (docs/architecture.md §3.2).
 *
 * A slot is the unit both sides can change independently: one card field, one alternate greeting, one regex
 * script, one Tavern Helper script, the variables, one embedded book entry; one lorebook setting or one entry.
 * Ordered lists keyed by id also get a `$order` slot, so reordering is its own change (rule 5).
 *
 * slotsOf(kind, data) -> Map(slot -> value), in data order; assemble(kind, slots) is its inverse:
 * assemble(kind, slotsOf(kind, x)) deep-equals x for every x.
 */
import { stableStringify } from '../../../shared/hash.js';
import { getPath, isPlainObject } from './object-path.js';
import { V1_MIRRORS } from './character.js';

/**
 * Top-level V1 copies equal to their data field are one change with it, not a second slot: they become a marker
 * that assembly fills from the merged data field. A copy that really differs stays its own slot.
 */
const MIRROR_PATHS = new Map(V1_MIRRORS);
const MIRROR = '$mirror';

const omit = (obj, ...keys) => Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)));

/** Keys for a list of objects: their `field` when unique, otherwise positions ("@0", "@1", ...). */
function listKeys(list, field) {
    const ids = list.map(x => x?.[field]);
    const usable = ids.every(id => (typeof id === 'string' && id) || Number.isInteger(id)) && new Set(ids.map(String)).size === ids.length;
    return usable ? ids.map(String) : list.map((_, i) => `@${i}`);
}

function putList(m, prefix, list, field) {
    const keys = listKeys(list, field);
    m.set(`${prefix}.$order`, keys);
    keys.forEach((key, i) => m.set(`${prefix}.#${key}`, list[i]));
}

/** Items in `$order` first, then items added on one side only (in slot order). */
function takeList(m, prefix) {
    const order = Array.isArray(m.get(`${prefix}.$order`)) ? m.get(`${prefix}.$order`) : [];
    const items = new Map([...m].filter(([slot]) => slot.startsWith(`${prefix}.#`)).map(([slot, v]) => [slot.slice(prefix.length + 2), v]));
    const out = order.filter(k => items.has(k)).map(k => items.get(k));
    for (const [k, v] of items) if (!order.includes(k)) out.push(v);
    return out;
}

const objectList = v => Array.isArray(v) && v.every(isPlainObject);

function characterSlots(card) {
    const m = new Map();
    for (const [k, v] of Object.entries(card)) {
        if (k !== 'data' || !isPlainObject(v)) {
            const path = MIRROR_PATHS.get(k);
            const mirrored = path && getPath(card, path);
            m.set(`top.${k}`, path && mirrored !== undefined && stableStringify(mirrored) === stableStringify(v) ? { [MIRROR]: path } : v);
            continue;
        }
        m.set('data.$', true);
        for (const [dk, dv] of Object.entries(v)) {
            if (dk === 'alternate_greetings' && Array.isArray(dv)) {
                m.set('greetings.$len', dv.length);
                dv.forEach((g, i) => m.set(`greetings.${i}`, g));
            } else if (dk === 'extensions' && isPlainObject(dv)) {
                m.set('ext.$', true);
                for (const [ek, ev] of Object.entries(dv)) {
                    if (ek === 'regex_scripts' && objectList(ev)) putList(m, 'regex', ev, 'id');
                    else if (ek === 'tavern_helper' && isPlainObject(ev) && objectList(ev.scripts)) {
                        m.set('helper.$rest', omit(ev, 'scripts', 'variables'));
                        if ('variables' in ev) m.set('helper.variables', ev.variables);
                        putList(m, 'script', ev.scripts, 'id');
                    } else m.set(`ext.${ek}`, ev);
                }
            } else if (dk === 'character_book' && isPlainObject(dv) && objectList(dv.entries)) {
                m.set('book.$meta', omit(dv, 'entries'));
                putList(m, 'book', dv.entries, 'id');
            } else m.set(`data.${dk}`, dv);
        }
    }
    return m;
}

function assembleCharacter(m) {
    const card = {};
    const data = () => (card.data ??= {});
    const ext = () => (data().extensions ??= {});
    for (const [slot, v] of m) {
        if (slot.startsWith('top.')) card[slot.slice(4)] = v;
        else if (slot === 'data.$') data();
        else if (slot.startsWith('data.')) data()[slot.slice(5)] = v;
        else if (slot === 'greetings.$len') data().alternate_greetings = Array.from({ length: v }, (_, i) => m.get(`greetings.${i}`) ?? '');
        else if (slot === 'ext.$') ext();
        else if (slot.startsWith('ext.')) ext()[slot.slice(4)] = v;
        else if (slot === 'regex.$order') ext().regex_scripts = takeList(m, 'regex');
        else if (slot === 'helper.$rest') {
            ext().tavern_helper = { ...v, scripts: takeList(m, 'script'), ...(m.has('helper.variables') ? { variables: m.get('helper.variables') } : {}) };
        } else if (slot === 'book.$meta') data().character_book = { ...v, entries: takeList(m, 'book') };
    }
    for (const [k, v] of Object.entries(card)) {
        if (!isPlainObject(v) || typeof v[MIRROR] !== 'string' || Object.keys(v).length !== 1) continue;
        const value = getPath(card, v[MIRROR]);
        if (value === undefined) delete card[k];
        else card[k] = structuredClone(value);
    }
    return card;
}

function lorebookSlots(book) {
    const m = new Map();
    for (const [k, v] of Object.entries(book)) {
        if (k === 'entries' && isPlainObject(v)) {
            m.set('entries.$', true);
            for (const [ek, ev] of Object.entries(v)) m.set(`entry.${ek}`, ev);
        } else m.set(`book.${k}`, v);
    }
    return m;
}

function assembleLorebook(m) {
    const book = {};
    for (const [slot, v] of m) {
        if (slot.startsWith('book.')) book[slot.slice(5)] = v;
        else if (slot === 'entries.$') book.entries ??= {};
        else if (slot.startsWith('entry.')) (book.entries ??= {})[slot.slice(6)] = v;
    }
    return book;
}

export function slotsOf(kind, data) {
    return kind === 'lorebook' ? lorebookSlots(data) : characterSlots(data);
}

export function assemble(kind, slots) {
    return kind === 'lorebook' ? assembleLorebook(slots) : assembleCharacter(slots);
}

const same = (a, b) => stableStringify(a ?? null) === stableStringify(b ?? null) && (a === undefined) === (b === undefined);

/** Equality of two slot values (absent differs from null). */
export const sameSlot = same;

/** True when `side` moved items that it shares with `base` relative to each other (not just added/removed some). */
function reordered(side, base) {
    const common = side.filter(k => base.includes(k));
    return !same(common, base.filter(k => side.includes(k)));
}

/**
 * Both sides changed an `$order`: additions and deletions on both sides combine; a reorder on one side wins;
 * reorders on both sides conflict unless they put the shared items in the same order. Returns undefined for a conflict.
 */
function mergeOrder(base = [], local = [], remote = []) {
    if (reordered(local, base) && reordered(remote, base)) {
        const shared = base.filter(k => local.includes(k) && remote.includes(k));
        if (!same(local.filter(k => shared.includes(k)), remote.filter(k => shared.includes(k)))) return undefined;
    }
    const [primary, other] = reordered(remote, base) ? [remote, local] : [local, remote];
    const removed = new Set(base.filter(k => !other.includes(k)));
    const out = primary.filter(k => !removed.has(k));
    for (const k of other) if (!base.includes(k) && !out.includes(k)) out.push(k);
    return out;
}

/**
 * Three-way merge. A slot changed on one side only takes that side; changed to the same value on both sides is
 * no conflict; changed differently (including delete vs edit) is a conflict and keeps the workspace value.
 * @returns {{data: object, conflicts: string[]}}
 */
export function merge3(kind, base, local, remote) {
    const b = slotsOf(kind, base);
    const l = slotsOf(kind, local);
    const r = slotsOf(kind, remote);
    const merged = new Map();
    const conflicts = [];
    for (const slot of new Set([...l.keys(), ...r.keys(), ...b.keys()])) {
        const lv = l.get(slot), rv = r.get(slot), bv = b.get(slot);
        let pick;
        if (same(lv, rv) || same(rv, bv)) pick = lv;
        else if (same(lv, bv)) pick = rv;
        else if (slot.endsWith('.$order') && Array.isArray(lv) && Array.isArray(rv) && (pick = mergeOrder(bv, lv, rv)) !== undefined) { /* combined */ }
        else { pick = lv; conflicts.push(slot); }
        if (pick !== undefined) merged.set(slot, pick);
    }
    return { data: assemble(kind, merged), conflicts };
}

const FIELD_LABELS = {
    'data.name': '名称', 'data.description': '角色描述', 'data.personality': '性格', 'data.scenario': '场景',
    'data.first_mes': '第一条消息', 'data.mes_example': '对话示例', 'data.system_prompt': '系统提示词',
    'data.post_history_instructions': '历史后指令', 'data.creator_notes': '作者备注', 'data.tags': '标签',
    'greetings.$len': '其他开场数量', 'helper.variables': '酒馆助手变量', 'helper.$rest': '酒馆助手设置', 'book.$meta': '内嵌世界书设置',
};

/** Human-readable name of a slot; `value` (either side's) supplies item names. */
export function slotLabel(slot, value) {
    if (FIELD_LABELS[slot]) return FIELD_LABELS[slot];
    const name = v => (isPlainObject(v) ? v.scriptName ?? v.name ?? v.comment : undefined) || '';
    let m;
    if ((m = /^greetings\.(\d+)$/.exec(slot))) return `其他开场 第 ${Number(m[1]) + 1} 条`;
    if (slot.endsWith('.$order')) return { regex: '正则顺序', script: '脚本顺序', book: '内嵌世界书条目顺序' }[slot.split('.')[0]] ?? slot;
    if (slot.startsWith('regex.#')) return `正则「${name(value) || slot.slice(7)}」`;
    if (slot.startsWith('script.#')) return `脚本「${name(value) || slot.slice(8)}」`;
    if (slot.startsWith('book.#')) return `内嵌世界书条目「${name(value) || slot.slice(6)}」`;
    if (slot.startsWith('entry.')) return `条目「${name(value) || `uid ${slot.slice(6)}`}」`;
    if (slot.startsWith('book.')) return `书设置 ${slot.slice(5)}`;
    if (slot.startsWith('ext.')) return `扩展字段 ${slot.slice(4)}`;
    if (slot.startsWith('data.')) return `字段 ${slot.slice(5)}`;
    if (slot.startsWith('top.')) return `顶层字段 ${slot.slice(4)}`;
    return slot;
}
