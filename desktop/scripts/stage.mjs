/**
 * Builds desktop/.stage/: the app folder electron-builder packages.
 * Keeps the repository layout (desktop/, companion/src/, shared/, studio/dist/) so relative imports and
 * the companion's defaultStudioDir() work unchanged inside the packaged app.
 */
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(desktop, '..');
const stage = join(desktop, '.stage');

const exists = p => stat(p).then(() => true, () => false);

if (!await exists(join(repo, 'studio', 'dist', 'index.html'))) {
    console.error('studio/dist/index.html is missing: build the Studio UI first (cd studio && npm run build).');
    process.exit(1);
}

await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });

const copy = (from, to = from) => cp(join(repo, from), join(stage, to), { recursive: true });
await copy('desktop/main.cjs');
await copy('desktop/preload.cjs');
await copy('desktop/assets');
await copy('companion/src');
await copy('companion/package.json');
await copy('shared');
await copy('studio/dist');
await copy('LICENSE');

// Runtime dependencies of the companion (copied, not reinstalled, so the bundle matches what the tests ran).
const companionPkg = JSON.parse(await readFile(join(repo, 'companion', 'package.json'), 'utf8'));
const seen = new Set();
async function copyDep(name) {
    if (seen.has(name)) return;
    seen.add(name);
    const from = join(repo, 'companion', 'node_modules', name);
    if (!await exists(from)) throw new Error(`companion/node_modules/${name} is missing; run npm install in companion/`);
    await cp(from, join(stage, 'node_modules', name), { recursive: true });
    const pkg = JSON.parse(await readFile(join(from, 'package.json'), 'utf8'));
    for (const dep of Object.keys(pkg.dependencies ?? {})) await copyDep(dep);
}
for (const dep of Object.keys(companionPkg.dependencies ?? {})) await copyDep(dep);

const desktopPkg = JSON.parse(await readFile(join(desktop, 'package.json'), 'utf8'));
await writeFile(join(stage, 'package.json'), JSON.stringify({
    name: desktopPkg.name,
    productName: desktopPkg.productName,
    version: desktopPkg.version,
    description: desktopPkg.description,
    license: desktopPkg.license,
    author: 'TavernCellar',
    type: 'module', // shared/*.js are ES modules without their own package.json
    main: 'desktop/main.cjs',
    dependencies: Object.fromEntries([...seen].map(n => [n, '*'])),
}, null, 2));

console.log(`staged ${stage} (deps: ${[...seen].join(', ')})`);
