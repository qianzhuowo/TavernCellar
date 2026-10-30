/**
 * `npm start`: runs the desktop shell from source.
 * Clears ELECTRON_RUN_AS_NODE, which terminals inside VS Code inherit and which would make Electron behave as plain Node.
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..');
const electron = createRequire(import.meta.url)('electron');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [desktop, ...process.argv.slice(2)], { env, stdio: 'inherit' });
child.on('exit', code => process.exit(code ?? 0));
