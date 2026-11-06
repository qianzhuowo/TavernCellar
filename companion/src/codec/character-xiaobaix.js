/**
 * LittleWhiteBox (小白X) data in a character card, split into files for the 「小白X脚本及变量」 part.
 * Shapes are those LittleWhiteBox writes with writeExtensionField (modules/scheduled-tasks, template-editor, variables):
 *   data.extensions['xiaobaix-tasks']    = { tasks: [{ name, commands, interval, triggerTiming, ... }], ... }
 *   data.extensions['xiaobaix-template'] = { enabled, template: '<html>', customRegex, ... }
 *   data.extensions.LittleWhiteBox       = { variablesCore: { ... }, ... }
 *
 * Layout:
 *   xiaobaix/tasks/NN-<name>.json   a task without `commands`
 *   xiaobaix/tasks/NN-<name>.txt    its commands (script text)
 *   xiaobaix/template.json          the template settings without `template`
 *   xiaobaix/template.html          the template text
 *   xiaobaix/variables.json         the LittleWhiteBox object
 * Only non-empty data gets files (no blank files for an empty task list or an empty object). Anything in another
 * shape stays verbatim in card.json.
 */
import { getPath, isPlainObject, setPath, unsetPath } from './object-path.js';
import { needsRaw, normalizeText } from './text.js';
import { joinList, splitList } from './character-parts.js';

export const XB_TASKS_PATH = 'data.extensions.xiaobaix-tasks';
export const XB_TEMPLATE_PATH = 'data.extensions.xiaobaix-template';
export const XB_VARIABLES_PATH = 'data.extensions.LittleWhiteBox';

const TEMPLATE_JSON = 'xiaobaix/template.json';
const TEMPLATE_HTML = 'xiaobaix/template.html';
const VARIABLES_JSON = 'xiaobaix/variables.json';
const TASK_JSON_RE = /^xiaobaix\/tasks\/(\d+)-([^/]*)\.json$/;
const TASK_SPEC = { dir: 'xiaobaix/tasks', nameKey: 'name', textKey: 'commands', textExt: '.txt', rawPrefix: 'xiaobaix.tasks', re: TASK_JSON_RE };
const OWNED = new Set([TEMPLATE_JSON, TEMPLATE_HTML, VARIABLES_JSON]);
const json = value => JSON.stringify(value, null, 2) + '\n';

/** True for files written by this module. */
export function ownsXiaobaixFile(rel) {
    return OWNED.has(rel) || /^xiaobaix\/tasks\/\d+-[^/]*\.(json|txt)$/.test(rel);
}

const taskList = card => {
    const v = getPath(card, XB_TASKS_PATH);
    const tasks = isPlainObject(v) ? v.tasks : undefined;
    return Array.isArray(tasks) && tasks.length && tasks.every(t => isPlainObject(t) && (t.commands === undefined || typeof t.commands === 'string')) ? tasks : null;
};
const template = card => {
    const v = getPath(card, XB_TEMPLATE_PATH);
    return isPlainObject(v) && typeof v.template === 'string' && v.template.length ? v : null;
};
const variables = card => {
    const v = getPath(card, XB_VARIABLES_PATH);
    return isPlainObject(v) && Object.keys(v).length ? v : null;
};

/** Whether the card holds LittleWhiteBox data that would be extracted (non-empty, recognized shape). */
export function hasXiaobaix(card) {
    return Boolean(taskList(card) || template(card) || variables(card));
}

/** Moves LittleWhiteBox data out of `rest` into `files`; records what it did in meta.xiaobaix. */
export function splitXiaobaix(rest, files, meta) {
    const info = {};
    const tasks = taskList(rest);
    if (tasks && splitList(tasks, TASK_SPEC, files, meta)) {
        const { tasks: _, ...remaining } = getPath(rest, XB_TASKS_PATH);
        setPath(rest, XB_TASKS_PATH, remaining);
        info.tasks = true;
    }
    const tpl = template(rest);
    if (tpl) {
        const { template: text, ...settings } = tpl;
        files[TEMPLATE_HTML] = text;
        files[TEMPLATE_JSON] = json(settings);
        if (needsRaw(text)) meta.raw.push('xiaobaix.template');
        unsetPath(rest, XB_TEMPLATE_PATH);
        info.template = true;
    }
    const vars = variables(rest);
    if (vars) {
        files[VARIABLES_JSON] = json(vars);
        unsetPath(rest, XB_VARIABLES_PATH);
        info.variables = true;
    }
    if (Object.keys(info).length) meta.xiaobaix = info;
}

function parse(files, name) {
    try {
        const value = JSON.parse(files[name].replace(/^\uFEFF/, ''));
        if (!isPlainObject(value)) throw new Error('expected a JSON object');
        return value;
    } catch (error) {
        throw new Error(`${name}: invalid JSON (${error.message})`);
    }
}

/** Inverse of splitXiaobaix. */
export function joinXiaobaix(card, files, meta) {
    const info = meta.xiaobaix;
    if (!info) return;
    if (info.tasks) {
        const current = getPath(card, XB_TASKS_PATH);
        setPath(card, XB_TASKS_PATH, { ...(isPlainObject(current) ? current : {}), tasks: joinList(files, TASK_SPEC, meta) });
    }
    if (info.template && (files[TEMPLATE_JSON] !== undefined || files[TEMPLATE_HTML] !== undefined)) {
        const settings = files[TEMPLATE_JSON] !== undefined ? parse(files, TEMPLATE_JSON) : {};
        const raw = (meta.raw ?? []).includes('xiaobaix.template');
        setPath(card, XB_TEMPLATE_PATH, files[TEMPLATE_HTML] !== undefined ? { ...settings, template: normalizeText(files[TEMPLATE_HTML], raw) } : settings);
    }
    if (info.variables && files[VARIABLES_JSON] !== undefined) setPath(card, XB_VARIABLES_PATH, parse(files, VARIABLES_JSON));
}
