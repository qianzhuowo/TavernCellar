import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Vcs, UNDESCRIBED, deployedRef, encodeRefSegment } from '../src/vcs/vcs.js';
import { Workspace } from '../src/workspace/workspace.js';

async function fixture(fn) {
    const root = await mkdtemp(join(tmpdir(), 'cellar-vcs-'));
    try {
        const ws = await Workspace.init(join(root, 'ws'));
        await mkdir(join(ws.root, 'characters', 'A'), { recursive: true });
        await writeFile(join(ws.root, 'characters', 'A', 'description.md'), 'v1');
        const vcs = new Vcs(ws.root);
        await fn({ ws, vcs, file: (rel, text) => writeFile(join(ws.root, ...rel.split('/')), text) });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

test('init creates the repository with an initial version and ignores .cellar', async () => {
    await fixture(async ({ ws, vcs }) => {
        await writeFile(ws.internal('state.json'), '{}');
        assert.equal(await vcs.init(), true);
        assert.equal(await vcs.init(), false, 'second init keeps the history');
        const log = await vcs.log();
        assert.equal(log.length, 1);
        assert.equal(log[0].message, '开始版本记录');
        assert.equal(log[0].draft, false);
        assert.ok(log[0].items.includes('characters/A'));
        assert.ok(!log[0].items.some(p => p.startsWith('.cellar')));
        assert.equal(await readFile(join(ws.root, '.gitattributes'), 'utf8'), '* -text\n');
    });
});

test('a same-length edit with the same modification time is still seen (no reliance on the mtime cache)', async () => {
    await fixture(async ({ ws, vcs, file }) => {
        await vcs.init();
        const path = join(ws.root, 'characters', 'A', 'description.md');
        const when = new Date();
        await file('characters/A/description.md', '霜蚀 3');
        await utimes(path, when, when);
        const d1 = await vcs.snapshot();
        await file('characters/A/description.md', '霜蚀 4');
        await utimes(path, when, when);
        const d2 = await vcs.snapshot();
        assert.notEqual(d1, d2);
        assert.equal((await vcs.readItemAt(d2, 'characters/A'))['description.md'], '霜蚀 4');
    });
});

test('snapshots amend one draft; recording a version ends it; reverting empties the draft', async () => {
    await fixture(async ({ vcs, file }) => {
        await vcs.init();
        assert.equal(await vcs.snapshot(), null, 'no change, no draft');
        await file('characters/A/description.md', 'v2');
        const d1 = await vcs.snapshot();
        await file('characters/A/description.md', 'v3');
        const d2 = await vcs.snapshot();
        assert.notEqual(d1, d2);
        let log = await vcs.log();
        assert.equal(log.length, 2, 'the draft was amended, not stacked');
        assert.equal(log[0].draft, true);
        assert.equal(log[0].message, UNDESCRIBED);
        assert.deepEqual((await vcs.draftInfo()).items, ['characters/A']);

        await vcs.describe('改了描述');
        assert.equal((await vcs.log())[0].message, '改了描述');
        const recorded = await vcs.commit('第一版');
        log = await vcs.log();
        assert.equal(log[0].id, recorded);
        assert.equal(log[0].message, '第一版');
        assert.equal(log[0].draft, false);
        assert.equal(await vcs.commit('nothing'), null, 'nothing to record');

        // A new change starts a new draft on top; undoing it drops the draft again.
        await file('characters/A/description.md', 'v4');
        await vcs.snapshot();
        assert.equal((await vcs.log()).length, 3);
        await file('characters/A/description.md', 'v3');
        assert.equal(await vcs.snapshot(), null);
        assert.equal((await vcs.log()).length, 2);
        assert.equal((await vcs.draftInfo()).id, null);
    });
});

test('deleted and added files are recorded; readItemAt returns an item folder of a version', async () => {
    await fixture(async ({ ws, vcs, file }) => {
        await vcs.init();
        const first = (await vcs.log())[0].id;
        await mkdir(join(ws.root, 'characters', 'A', 'regex'), { recursive: true });
        await file('characters/A/regex/01-x.json', '{}');
        await rm(join(ws.root, 'characters', 'A', 'description.md'));
        await vcs.commit('restructure');
        assert.deepEqual(await vcs.readItemAt(first, 'characters/A'), { 'description.md': 'v1' });
        assert.deepEqual(await vcs.readItemAt('HEAD', 'characters/A'), { 'regex/01-x.json': '{}' });
        assert.equal(await vcs.readItemAt(first, 'characters/Missing'), null);
        assert.deepEqual(await vcs.changedItems(first, 'HEAD'), ['characters/A']);
        assert.equal(await vcs.resolve(first.slice(0, 7)), first);
    });
});

test('tags, deployed pointers and log filtering by item', async () => {
    await fixture(async ({ ws, vcs, file }) => {
        await vcs.init();
        await mkdir(join(ws.root, 'lorebooks', 'B'), { recursive: true });
        await file('lorebooks/B/book.json', '{}');
        const v2 = await vcs.commit('add book');
        await vcs.tag('v1.0');
        assert.equal(await vcs.resolve('v1.0'), v2);
        assert.deepEqual((await vcs.log())[0].tags, ['v1.0']);
        assert.deepEqual((await vcs.log({ path: 'lorebooks/B' })).map(c => c.message), ['add book']);
        assert.equal((await vcs.log({ path: 'characters/A' })).length, 1);

        // An amended draft stays reachable through its deployed pointer.
        await file('characters/A/description.md', 'deployed text');
        const draft = await vcs.snapshot();
        await vcs.setDeployed('t1', 'characters/A', draft);
        await file('characters/A/description.md', 'later');
        await vcs.snapshot();
        assert.equal(await vcs.getDeployed('t1', 'characters/A'), draft);
        assert.deepEqual(await vcs.readItemAt(draft, 'characters/A'), { 'description.md': 'deployed text' });
        await vcs.dropDeployed('t1', 'characters/A');
        assert.equal(await vcs.getDeployed('t1', 'characters/A'), null);
    });
});

test('ref names stay valid for paths with spaces, dots and CJK', () => {
    const ref = deployedRef('a1b2c3d4', 'characters/A b.c~..lock');
    assert.match(ref, /^refs\/cellar\/deployed\/a1b2c3d4\/[A-Za-z0-9_%-]+$/);
    assert.equal(encodeRefSegment('世界'), '%E4%B8%96%E7%95%8C');
    assert.equal(decodeURIComponent(encodeRefSegment('characters/A b.c')), 'characters/A b.c');
});

test('an existing repository keeps its branch and the user\'s commits are never amended', async (t) => {
    try { execFileSync('git', ['--version']); } catch { t.skip('system git not available'); return; }
    await fixture(async ({ ws, vcs, file }) => {
        const g = (...args) => execFileSync('git', ['-c', 'user.name=u', '-c', 'user.email=u@x', ...args], { cwd: ws.root, encoding: 'utf8' }).trim();
        g('init', '-b', 'work');
        g('add', '-A');
        g('commit', '-m', 'mine');
        const mine = g('rev-parse', 'HEAD');
        assert.equal(await vcs.init(), false);
        await file('characters/A/description.md', 'v2');
        await vcs.snapshot();
        assert.equal(g('rev-parse', 'HEAD~1'), mine, 'draft on top of the user commit');
        assert.equal(g('branch', '--show-current'), 'work');
        // The user commits on top of our draft: the next snapshot starts a new draft instead of rewriting theirs.
        await file('characters/A/description.md', 'v3');
        g('add', '-A');
        g('commit', '-m', 'mine 2');
        const mine2 = g('rev-parse', 'HEAD');
        await file('characters/A/description.md', 'v4');
        await vcs.snapshot();
        assert.equal(g('rev-parse', 'HEAD~1'), mine2);
        assert.equal(g('status', '--porcelain'), '', 'git sees the same tree as the files');
    });
});
