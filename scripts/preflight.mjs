#!/usr/bin/env node
/**
 * Pre-push / pre-release check. Run from the repo root: `node scripts/preflight.mjs`.
 * Exit code 1 when something must be fixed before committing, pushing or packaging.
 *
 *  1. Ignore rules: no tracked file is matched by .gitignore; lists untracked-but-not-ignored candidates and
 *     flags build output, dependencies and test artifacts among them.
 *  2. Leak scan over every tracked + untracked-not-ignored text file:
 *     - built-in generic patterns (non-loopback IPv4, user@host, absolute user / drive paths, tokens);
 *     - private literals from `preflight.local.json` (ignored via *.local.*, never committed), e.g.
 *       { "literals": ["<server ip>", "<real card name>"], "patterns": ["<regex>"], "allow": ["<regex>"] };
 *     - the SillyTavern basicAuth password and the companion token, read locally and compared, never printed
 *       (paths from preflight.local.json `stConfig` / `cellarConfig`, defaults below).
 *  3. Reference integrity: relative links in Markdown and relative imports in JS/Vue point at files that will be
 *     pushed (tracked or candidate, not ignored). References that intentionally leave the repo (host tavern
 *     sources) are listed in `external` below.
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, normalize, posix } from 'node:path';

const git = args => execSync(`git ${args}`, { encoding: 'utf8', maxBuffer: 64 << 20 });
const lines = s => s.split('\n').map(l => l.trim()).filter(Boolean);
const local = existsSync('preflight.local.json') ? JSON.parse(readFileSync('preflight.local.json', 'utf8')) : {};

let failures = 0;
const fail = (title, items) => { if (!items.length) return; failures += items.length; console.log(`✗ ${title} (${items.length})`); items.slice(0, 40).forEach(i => console.log(`    ${i}`)); };
const warn = (title, items) => { if (!items.length) return; console.log(`! ${title} (${items.length})`); items.slice(0, 40).forEach(i => console.log(`    ${i}`)); };

// ---------- 1. ignore rules ----------
const trackedIgnored = lines(git('ls-files -ci --exclude-standard'));
fail('tracked files matched by .gitignore (git rm --cached, or fix the rule)', trackedIgnored);
const candidates = lines(git('ls-files -o --exclude-standard'));
const artifact = /(^|\/)(node_modules|dist|release|\.stage|win-unpacked|coverage|\.tmp|tmp|test-results|screenshots)\/|\.(exe|asar|zip|tgz|log|har|dmp|blockmap|jsonl|charx)$/i;
fail('untracked candidates that look like build output / dependencies / test artifacts', candidates.filter(f => artifact.test(f)));
if (candidates.length) console.log(`  untracked candidates that will be added by "git add -A":\n${candidates.map(f => `    ${f}`).join('\n')}`);

const files = [...new Set([...lines(git('ls-files')), ...candidates])].filter(f => existsSync(f) && statSync(f).isFile());
const pushed = new Set(files);
const big = files.filter(f => statSync(f).size > 1024 * 1024).map(f => `${f} (${(statSync(f).size / 1048576).toFixed(1)} MB)`);
warn('files over 1 MB', big);

// ---------- 2. leak scan ----------
const secrets = [];
const stConfig = local.stConfig ?? join('..', '..', '..', '..', '..', 'config.yaml'); // plugin lives in ST/public/scripts/extensions/third-party/
if (existsSync(stConfig)) {
    const m = readFileSync(stConfig, 'utf8').match(/^basicAuthUser:\s*\n((?:[ \t]+.*\n?)*)/m);
    const pw = m?.[1].match(/^\s+password:\s*['"]?([^'"\r\n]*)/m)?.[1];
    if (pw && pw.length >= 3) secrets.push(pw);
}
const cellarConfig = local.cellarConfig ?? join(process.env.CELLAR_HOME ?? join(homedir(), '.tavern-cellar'), 'config.json');
if (existsSync(cellarConfig)) { try { const t = JSON.parse(readFileSync(cellarConfig, 'utf8')).token; if (t) secrets.push(t); } catch { /* unreadable config: nothing to compare */ } }

const patterns = [
    [/\b(?!127\.|0\.|255\.|10\.0\.0\.\d\b)(?:\d{1,3}\.){3}\d{1,3}\b/, 'IPv4 address'],
    [/\b[a-z_][\w.-]*@(?:\d{1,3}\.){3}\d{1,3}\b|\broot@/i, 'user@host'],
    [/\b[A-Z]:[\\/](?:Users|Documents and Settings)[\\/](?!USERNA~1|<)[^\\/\s'"`]+/i, 'absolute user path'],
    [/\b[A-Z]:[\\/](?!\\|\/)[^\s'"`<>|]*[\\/]/, 'absolute drive path'],
    [/\b(ghp|gho|github_pat|sk|xox[bp])[-_][A-Za-z0-9_]{16,}/, 'token'],
    ...(local.patterns ?? []).map(p => [new RegExp(p, 'i'), 'private pattern']),
    ...(local.literals ?? []).map(s => [s, 'private literal']),
];
// Version strings and the deliberate placeholder paths used in comments / input hints.
const allow = [/1\.15\.0|2\.4\.0|0\.1\.0/, /USERNA~1|D:\\Documents\\TavernCellar/, ...(local.allow ?? []).map(p => new RegExp(p, 'i'))];
const leaks = [];
for (const f of files) {
    const buf = readFileSync(f);
    if (buf.includes(0)) continue; // binary
    buf.toString('utf8').split(/\r?\n/).forEach((line, i) => {
        for (const s of secrets) if (line.includes(s)) leaks.push(`${f}:${i + 1}: <local secret>`);
        for (const [p, label] of patterns) {
            const hit = typeof p === 'string' ? line.includes(p) : p.test(line);
            if (hit && !allow.some(a => a.test(line))) leaks.push(`${f}:${i + 1}: [${label}] ${line.trim().slice(0, 120)}`);
        }
    });
}
// Generic patterns produce known-harmless hits (e.g. "C:\Users\USERNA~1" in a comment); review them, add real ones to
// preflight.local.json `literals`, and harmless recurring ones to `allow`.
warn(`possible leaks to review (${secrets.length} local secret(s) compared)`, leaks.filter(l => !/private|local secret/.test(l)));
fail('private literals / local secrets found', leaks.filter(l => /private|local secret/.test(l)));

// ---------- 3. reference integrity ----------
const external = [/^\/?src\/(endpoints|tauri)\//, /^\/?docs\/CurrentState\//, /^(\.\.\/){5}/];
const missing = [];
for (const f of files) {
    if (!/\.(md|js|mjs|cjs|vue)$/.test(f)) continue;
    const text = readFileSync(f, 'utf8');
    const refs = [];
    if (f.endsWith('.md')) {
        for (const m of text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) refs.push(m[1]);
        for (const m of text.matchAll(/`((?:docs|studio|companion|desktop|shared|src|scripts)\/[^`*\s<>]+\.[a-z]{1,5})`/g)) refs.push(`/${m[1]}`);
    } else {
        for (const m of text.matchAll(/(?:from\s*|import\(\s*|^import\s*)['"](\.{1,2}\/[^'"]+)['"]/gm)) refs.push(m[1]);
    }
    for (const r of refs) {
        if (/^[a-z]+:/i.test(r) || /NN|<|\{/.test(r) || external.some(e => e.test(r))) continue; // URLs, placeholders
        const p = r.startsWith('/') ? r.slice(1) : posix.normalize(posix.join(posix.dirname(f), decodeURI(r)));
        const ok = pushed.has(p) || files.some(x => x.startsWith(`${p.replace(/\/$/, '')}/`));
        if (!ok) missing.push(`${f} -> ${r}${existsSync(normalize(p)) ? ' (exists but ignored / not pushed)' : ''}`);
    }
}
fail('references to files that will not be pushed', missing);

console.log(failures ? `\npreflight: ${failures} problem(s)` : `\npreflight: ok (${files.length} files)`);
process.exit(failures ? 1 : 0);
