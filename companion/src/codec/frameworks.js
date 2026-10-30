/**
 * Recognizes script frameworks a character card depends on, so users know what the card needs in the tavern.
 * Pure function over the canonical card JSON; evidence strings are short and human-readable.
 */
import { getPath, isPlainObject } from './object-path.js';
import { HELPER_PATH, LEGACY_SCRIPTS_PATH, REGEX_PATH } from './character-parts.js';

const helperScripts = card => {
    const helper = getPath(card, HELPER_PATH);
    let scripts = [];
    if (isPlainObject(helper)) scripts = helper.scripts;
    else if (Array.isArray(helper)) scripts = helper.find(p => Array.isArray(p) && p[0] === 'scripts')?.[1];
    const legacy = getPath(card, LEGACY_SCRIPTS_PATH);
    return [...(Array.isArray(scripts) ? scripts : []), ...(Array.isArray(legacy) ? legacy : [])].filter(isPlainObject);
};

/**
 * @param {object} card
 * @returns {{id: 'tavern_helper'|'mvu'|'xiaobaix', name: string, evidence: string}[]}
 */
export function detectFrameworks(card) {
    const out = [];
    const extensions = getPath(card, 'data.extensions');
    const ext = isPlainObject(extensions) ? extensions : {};
    const scripts = helperScripts(card);

    if (scripts.length > 0) out.push({ id: 'tavern_helper', name: '酒馆助手', evidence: `${scripts.length} 个脚本` });

    const mvuScript = scripts.find(s => /MagVarUpdate|\bmvu\b/i.test(`${s.name ?? ''}\n${s.content ?? ''}`));
    const regexList = getPath(card, REGEX_PATH);
    const texts = [getPath(card, 'data.first_mes'), ...(Array.isArray(regexList) ? regexList.map(r => r?.replaceString) : [])];
    if (mvuScript) out.push({ id: 'mvu', name: 'MVU 变量框架', evidence: `脚本「${mvuScript.name ?? '未命名'}」` });
    else if (Array.isArray(ext.cfMvuVarGroups)) out.push({ id: 'mvu', name: 'MVU 变量框架', evidence: 'cfMvuVarGroups' });
    else if (texts.some(t => typeof t === 'string' && t.includes('<UpdateVariable>'))) out.push({ id: 'mvu', name: 'MVU 变量框架', evidence: '<UpdateVariable> 标记' });

    const xbKeys = Object.keys(ext).filter(k => /^xiaobaix|^LittleWhiteBox/i.test(k));
    if (xbKeys.length > 0) out.push({ id: 'xiaobaix', name: '小白X', evidence: xbKeys.join(', ') });

    return out;
}
