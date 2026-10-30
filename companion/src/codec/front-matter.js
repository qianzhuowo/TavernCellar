/**
 * Markdown files with a YAML front matter header, used for lorebook entries and embedded character book entries.
 * YAML uses the JSON schema, so `yes`/`no` stay strings and values round-trip like JSON.
 */
import yaml from 'js-yaml';
import { isPlainObject } from './object-path.js';

const YAML_OPTIONS = { schema: yaml.JSON_SCHEMA, lineWidth: -1, noRefs: true };

export function serializeEntry(frontMatter, body) {
    return `---\n${yaml.dump(frontMatter, YAML_OPTIONS)}---\n${body}`;
}

/**
 * @param {string} text
 * @returns {{frontMatter: object, body: string}}
 */
export function parseEntry(text, fileName = 'entry') {
    const source = text.replace(/^\uFEFF/, '');
    const match = /^---\r?\n(?:([\s\S]*?)\r?\n)?---(?:\r?\n|$)/.exec(source);
    if (!match) return { frontMatter: {}, body: source };
    let frontMatter;
    try {
        frontMatter = match[1]?.trim() ? yaml.load(match[1], { schema: yaml.JSON_SCHEMA }) : {};
    } catch (error) {
        throw new Error(`${fileName}: invalid YAML front matter (${error.message})`);
    }
    if (frontMatter === null || frontMatter === undefined) frontMatter = {};
    if (!isPlainObject(frontMatter)) throw new Error(`${fileName}: front matter must be a mapping`);
    return { frontMatter, body: source.slice(match[0].length) };
}
