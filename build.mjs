// Bundles the TypeScript app and the AudioWorklet into dist/ (committed so GitHub Pages can serve it).
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
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
