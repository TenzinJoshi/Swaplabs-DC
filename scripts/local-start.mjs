import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import net from 'node:net';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = 8000;
const origin = `http://localhost:${port}`;
const stateDirectory = join(root, 'data', 'runtime');
const marker = join(root, 'data', 'legacy-import.done');
const legacyUsers = join(root, '.original-swaplabs', 'data', 'users.json');
const wrangler = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const env = {
  ...process.env,
  PATH: `${dirname(process.execPath)}:${process.env.PATH || ''}`,
  DO_NOT_TRACK: '1', WRANGLER_SEND_METRICS: 'false', WRANGLER_SEND_ERROR_REPORTS: 'false',
  WRANGLER_HIDE_BANNER: 'true', WRANGLER_NO_SKILLS_UPDATE_PROMPTS: 'true',
  CI: 'true'
};
const openBrowser = () => {
  if (!process.argv.includes('--open')) return;
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', origin] : [origin];
  const opener = spawn(command, args, {stdio: 'ignore'});
  opener.on('error', () => console.log(`Open ${origin} in your browser.`));
};
async function health() {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/local/status`, {signal: AbortSignal.timeout(1000)});
    const result = await response.json();
    return response.ok && result.ok && result.app === 'swaplabs-local';
  } catch (_error) { return false; }
}
async function portInUse() {
  return new Promise(resolvePort => {
    const connection = net.createConnection({host: '127.0.0.1', port});
    connection.once('connect', () => { connection.destroy(); resolvePort(true); });
    connection.once('error', () => resolvePort(false));
    connection.setTimeout(1000, () => { connection.destroy(); resolvePort(false); });
  });
}
async function run(command, args, quiet = false) {
  await new Promise((resolveRun, reject) => {
    const task = spawn(command, args, {cwd: root, env, stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit'});
    let output = '';
    if (quiet) {
      task.stdout.on('data', chunk => { output += chunk; });
      task.stderr.on('data', chunk => { output += chunk; });
    }
    task.on('error', reject);
    task.on('exit', code => code === 0 ? resolveRun() : reject(new Error(`${command} failed (${code}).\n${output}`)));
  });
}
const cli = (args, quiet = false) => run(process.execPath, [wrangler, ...args], quiet);

if (await health()) {
  console.log(`SwapLabs is already running at ${origin}.`);
  openBrowser();
  process.exit(0);
}
if (await portInUse()) {
  console.error(`Port ${port} is being used by another application. Close that application, then start SwapLabs again.`);
  process.exit(1);
}
if (!existsSync(wrangler)) {
  console.error('The bundled local runtime is missing. Restore node_modules from the supplied folder before starting.');
  process.exit(1);
}
await mkdir(stateDirectory, {recursive: true});
console.log('Preparing SwapLabs on this computer…');
await run(process.execPath, ['scripts/build-worker.mjs']);
await cli(['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', stateDirectory], true);
if (!existsSync(marker) && existsSync(legacyUsers) && existsSync(join(root, 'scripts', 'migrate-swaplabs.py'))) {
  await run('python3', ['scripts/migrate-swaplabs.py', '--output', 'data/legacy-import.sql']);
  await cli(['d1', 'execute', 'DB', '--local', '--persist-to', stateDirectory, '--file', 'data/legacy-import.sql', '--yes'], true);
  const manifestPath = join(root, 'data', 'legacy-attachments.json');
  if (existsSync(manifestPath)) {
    const attachments = JSON.parse(await readFile(manifestPath, 'utf8'));
    for (const attachment of attachments) {
      const args = ['r2', 'object', 'put', `swaplabs-local-media/${attachment.key}`, '--local', '--persist-to', stateDirectory, '--file', resolve(root, attachment.file)];
      if (attachment.type) args.push('--content-type', attachment.type);
      await cli(args, true);
    }
  }
  await writeFile(marker, new Date().toISOString() + '\n');
  // Migration copies the original photographs into the public asset folder.
  await run(process.execPath, ['scripts/build-worker.mjs']);
}
console.log(`Starting SwapLabs at ${origin}. Press Control-C to stop.`);
const server = spawn(process.execPath, [wrangler, 'dev', '--local', '--ip', '127.0.0.1', '--port', String(port), '--persist-to', stateDirectory, '--inspector-port', '9231', '--show-interactive-dev-session=false'], {cwd: root, env, stdio: 'inherit'});
let stopped = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopped = true; server.kill(signal); });
server.on('exit', code => { stopped = true; process.exitCode = code || 0; });
server.on('error', error => { stopped = true; console.error(error.message); process.exitCode = 1; });
for (let attempt = 0; attempt < 80 && !stopped; attempt += 1) {
  if (await health()) {
    console.log(`SwapLabs is ready: ${origin}`);
    openBrowser();
    break;
  }
  await new Promise(resolveWait => setTimeout(resolveWait, 500));
}
