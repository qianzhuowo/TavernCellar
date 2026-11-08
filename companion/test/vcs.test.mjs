import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Vcs, UNDESCRIBED, deployedRef, itemKey } from '../src/vcs/vcs.js';
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
        await vcs.tag('v1.0', 'lorebooks/B');
        assert.equal(await vcs.resolve('v1.0'), v2);
        assert.equal(await vcs.resolve('lorebooks/B:v1.0'), v2);
        assert.deepEqual((await vcs.log())[0].tags, [{ path: 'lorebooks/B', name: 'v1.0' }]);
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

test('ref names are short and valid for any item path (spaces, dots, long CJK names)', () => {
    const long = 'lorebooks/_' + '很长很长的世界书名字 (测试 !)'.repeat(10);
    for (const p of ['characters/A b.c~..lock', long]) {
        assert.match(deployedRef('0123456789abcdef01234567', p), /^refs\/cellar\/deployed\/0123456789abcdef01234567\/[0-9a-f]{20}$/);
    }
    assert.notEqual(itemKey('characters/A'), itemKey('characters/B'));
});

test('pointers named the old way (percent-encoded paths) are renamed on start and still found', async () => {
    await fixture(async ({ vcs }) => {
        await vcs.init();
        const head = await vcs.resolve('HEAD');
        const p = 'lorebooks/世界 书';
        const old = [...new TextEncoder().encode(p)].map(b => (/[A-Za-z0-9_-]/.test(String.fromCharCode(b)) && b < 128 ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase().padStart(2, '0')}`)).join('');
        const dir = join(vcs.dir, '.git', 'refs', 'cellar', 'deployed', 't1');
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, old), head + '\n');
        const fresh = new Vcs(vcs.dir);
        await fresh.ready();
        assert.equal(await fresh.getDeployed('t1', p), head);
        assert.deepEqual((await readdir(dir)), [itemKey(p)]);
    });
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

test('.gitignore rules match git.isIgnored: nested files, negation, ignored folders, info/exclude', async () => {
    const git = (await import('isomorphic-git')).default;
    const fs = (await import('node:fs')).default;
    await fixture(async ({ ws, vcs, file }) => {
        await vcs.init();
        await mkdir(join(ws.root, 'characters', 'A', 'notes', 'deep'), { recursive: true });
        await mkdir(join(ws.root, 'scratch'), { recursive: true });
        await mkdir(join(ws.root, '.git', 'info'), { recursive: true });
        await writeFile(join(ws.root, '.git', 'info', 'exclude'), '*.bak\n');
        await file('.gitignore', '.cellar/\nscratch/\n*.log\n!keep.log\n');
        await file('characters/A/.gitignore', 'notes/*\n!notes/deep\n');
        const files = ['characters/A/a.log', 'characters/A/keep.log', 'characters/A/x.bak', 'characters/A/notes/n.md',
            'characters/A/notes/deep/d.md', 'scratch/s.md', 'characters/A/ok.md'];
        for (const f of files) await file(f, f);
        const oid = await vcs.snapshot();
        const inTree = new Set();
        await git.walk({ fs, dir: ws.root, trees: [git.TREE({ ref: oid })], map: async (p, [e]) => { if (e && (await e.type()) === 'blob') inTree.add(p); return true; } });
        for (const f of files) {
            const ignored = await git.isIgnored({ fs, dir: ws.root, filepath: f });
            assert.equal(inTree.has(f), !ignored, f);
        }
    });
});

test('压缩历史 deletes replaced draft states, packs the rest, and every version, tag and pointer still reads', async () => {
    await fixture(async ({ vcs, file }) => {
        await vcs.init();
        for (const text of ['d1', 'd2', 'd3']) { await file('characters/A/description.md', text); await vcs.snapshot(); }
        const v1 = await vcs.commit('v1');
        await vcs.tag('keep', 'characters/A', v1);
        await file('characters/A/description.md', 'draft');
        const draft = await vcs.snapshot();
        await vcs.setDeployed('t1', 'characters/A', v1);
        await vcs.setOrigin('characters/A', draft);

        assert.equal((await vcs.storage({ unused: true })).unusedFiles, 0, 'nothing is old enough yet');
        const before = await vcs.storage({ unused: true, keepMs: 0 });
        assert.ok(before.unusedFiles >= 2, 'the replaced drafts d1, d2 left commits and blobs behind');
        const r = await vcs.compact({ keepMs: 0 });
        assert.equal(r.removed, before.unusedFiles);
        const after = await vcs.storage({ unused: true, keepMs: 0 });
        assert.deepEqual([after.loose, after.packs, after.unusedFiles], [0, 1, 0], 'one pack, nothing loose');

        // a fresh reader (as after a restart) sees the same history
        const fresh = new Vcs(vcs.dir);
        assert.deepEqual((await fresh.log()).map(c => c.id), (await vcs.log()).map(c => c.id));
        assert.equal((await fresh.readItemAt('keep', 'characters/A'))['description.md'], 'd3');
        assert.equal((await fresh.readItemAt(draft, 'characters/A'))['description.md'], 'draft');
        assert.equal(await fresh.getDeployed('t1', 'characters/A'), v1);
        assert.equal((await fresh.revertPoint('characters/A')).oid, draft);
        // unchanged files are not written again as loose objects after a restart
        assert.equal(await fresh.snapshot(), draft);
        assert.equal((await fresh.storage()).loose, 0);
        await file('characters/A/description.md', 'after');
        assert.notEqual(await fresh.snapshot(), draft);
        assert.equal((await fresh.readItemAt('HEAD', 'characters/A'))['description.md'], 'after');
        // compacting again replaces the pack; git itself agrees the repository is whole
        await fresh.compact({ keepMs: 0 });
        assert.equal((await fresh.storage()).packs, 1);
        let hasGit = true;
        try { execFileSync('git', ['--version']); } catch { hasGit = false; }
        if (hasGit) execFileSync('git', ['fsck', '--strict'], { cwd: vcs.dir, stdio: 'pipe' });
    });
});

test('cleanup by age keeps recent unused objects and does not pack', async () => {
    await fixture(async ({ vcs, file }) => {
        await vcs.init();
        await file('characters/A/description.md', 'x1'); await vcs.snapshot();
        await file('characters/A/description.md', 'x2'); await vcs.snapshot();
        const r = await vcs.compact({ keepMs: 60 * 60 * 1000, pack: false });
        assert.equal(r.removed, 0, 'younger than the age limit');
        assert.ok((await vcs.storage({ unused: true, keepMs: 0 })).unusedFiles > 0);
        assert.equal((await vcs.storage()).packs, 0);
    });
});

test('recording only some items leaves the others in the draft, with their origin pointer moved along', async () => {
    await fixture(async ({ ws, vcs, file }) => {
        await vcs.init();
        await mkdir(join(ws.root, 'lorebooks', 'B'), { recursive: true });
        await file('lorebooks/B/book.json', '{"v":1}');
        const base = await vcs.commit('base');
        await file('characters/A/description.md', 'A2');
        await file('lorebooks/B/book.json', '{"v":2}');
        await file('cellar.json', (await readFile(join(ws.root, 'cellar.json'), 'utf8')).replace(/\n?$/, '\n'));
        const draft = await vcs.snapshot();
        await vcs.setOrigin('lorebooks/B', draft);

        const v = await vcs.commit('只存 A', ['characters/A']);
        assert.deepEqual((await vcs.changedItems(base, v)).filter(p => p.includes('/')), ['characters/A']);
        assert.equal((await vcs.readItemAt(v, 'lorebooks/B'))['book.json'], '{"v":1}', 'B as last recorded');
        const info = await vcs.draftInfo();
        assert.deepEqual(info.items, ['lorebooks/B']);
        assert.equal((await vcs.parentOf(info.id)), v);
        assert.equal((await vcs.revertPoint('lorebooks/B')).oid !== null, true, 'B can still be undone to where it came in');
        assert.deepEqual((await vcs.log({ path: 'characters/A' })).map(c => c.message).slice(0, 1), ['只存 A']);
        await assert.rejects(vcs.commit('x', ['characters/A']), /没有未存档的修改/);
        const v2 = await vcs.commit('', ['lorebooks/B']);
        assert.equal((await vcs.log())[0].id, v2);
        assert.equal((await vcs.draftInfo()).id, null);
    });
});

test('descriptions are notes (the id stays); tags belong to items; tagging the draft records that item with the message', async () => {
    await fixture(async ({ ws, vcs, file }) => {
        await vcs.init();
        await mkdir(join(ws.root, 'lorebooks', 'B'), { recursive: true });
        await file('lorebooks/B/book.json', '{}');
        const v1 = await vcs.commit('第一版');
        await vcs.tag('v1', 'characters/A', v1);
        await vcs.tag('v1', 'lorebooks/B', v1);
        assert.equal(await vcs.describeVersion(v1, '改过的说明'), v1);
        const [top] = await vcs.log();
        assert.equal(top.id, v1);
        assert.equal(top.message, '改过的说明');
        assert.deepEqual(top.tags, [{ path: 'characters/A', name: 'v1' }, { path: 'lorebooks/B', name: 'v1' }]);
        assert.equal(await vcs.resolve('v1'), v1, 'same version: not ambiguous');
        await assert.rejects(vcs.tag('v1', 'characters/A', v1), /已有标签/);

        await file('characters/A/description.md', 'A2');
        await file('lorebooks/B/book.json', '{"x":1}');
        const draft = await vcs.snapshot();
        const v2 = await vcs.tag('v2', 'characters/A', draft, '带标签的存档');
        assert.notEqual(v2, draft);
        assert.equal((await vcs.log({ path: 'characters/A' }))[0].message, '带标签的存档');
        assert.deepEqual((await vcs.draftInfo()).items, ['lorebooks/B']);
        await vcs.tag('v2', 'lorebooks/B', 'HEAD');
        await assert.rejects(vcs.resolve('v2'), /多个项/);
        assert.equal(await vcs.resolve('characters/A:v2'), v2);
        assert.equal(await vcs.untag('v2', 'lorebooks/B'), true);
        assert.equal(await vcs.resolve('v2'), v2);
    });
});

test('git tags of the old workspace-wide model become tags of the items their version recorded', async () => {
    await fixture(async ({ ws, vcs, file }) => {
        await vcs.init();
        await mkdir(join(ws.root, 'lorebooks', 'B'), { recursive: true });
        await file('lorebooks/B/book.json', '{}');
        const v = await vcs.commit('add B');
        const git = (await import('isomorphic-git')).default;
        const fs = await import('node:fs');
        await git.tag({ fs, dir: ws.root, ref: 'old', object: v });
        const fresh = new Vcs(ws.root);
        assert.equal(await fresh.init(), false);
        assert.deepEqual(await git.listTags({ fs, dir: ws.root }), []);
        assert.deepEqual(await fresh.tagsAt(v), [{ path: 'lorebooks/B', name: 'old' }]);
    });
});
