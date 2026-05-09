import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const crateManifest = resolve(root, 'crates/lumabridge_wasm/Cargo.toml');
const wasmInput = resolve(root, 'crates/lumabridge_wasm/target/wasm32-unknown-unknown/release/lumabridge_wasm.wasm');
const outDir = resolve(root, 'src/wasm/lumabridge_wasm');
const wasmBindgen = existsSync(resolve(homedir(), '.cargo/bin/wasm-bindgen'))
  ? resolve(homedir(), '.cargo/bin/wasm-bindgen')
  : 'wasm-bindgen';

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`);
  }
}

run('cargo', [
  'build',
  '--manifest-path',
  crateManifest,
  '--release',
  '--target',
  'wasm32-unknown-unknown',
  '--features',
  'wasm',
]);

if (!existsSync(wasmInput)) {
  throw new Error(`Expected wasm artifact was not created: ${wasmInput}`);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

run(wasmBindgen, [
  wasmInput,
  '--target',
  'web',
  '--out-dir',
  outDir,
  '--typescript',
]);
