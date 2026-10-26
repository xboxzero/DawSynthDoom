// Builds dist/: the C++ DSP -> WebAssembly (clang), and the TypeScript app + worklet (esbuild).
// dist/ is committed so GitHub Pages can serve the site without a build step.
import * as esbuild from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const watch = process.argv.includes('--watch');
mkdirSync('dist', { recursive: true });

// Freestanding C++ -> wasm32: no libc, no imports, fixed 256 KB memory.
const clang = spawnSync('clang++', [
  '--target=wasm32', '-O3', '-std=c++20', '-nostdlib', '-ffreestanding', '-fno-exceptions', '-fno-rtti', '-ffast-math',
  '-Wall', '-Wextra', '-Werror',
  '-Wl,--no-entry', '-Wl,--strip-all', '-Wl,-z,stack-size=65536', '-Wl,--initial-memory=262144', '-Wl,--max-memory=262144',
  '-o', 'dist/bass.wasm', 'dsp/bass.cpp',
], { stdio: 'inherit' });
if (clang.error) console.warn('clang++ not found: keeping the committed dist/bass.wasm');
else if (clang.status !== 0) process.exit(clang.status ?? 1);
else console.log('  dist/bass.wasm (C++ DSP)');

const common = { bundle: true, sourcemap: true, target: 'es2022', logLevel: 'info', minify: !watch };
const builds = [
  { ...common, entryPoints: ['src/main.ts'], outfile: 'dist/main.js', format: 'esm' },
  { ...common, entryPoints: ['src/worklets/bass.worklet.ts'], outfile: 'dist/bass.worklet.js', format: 'iife' },
];
if (watch) {
  for (const b of builds) await (await esbuild.context(b)).watch();
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
