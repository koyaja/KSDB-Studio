// Bundle du process principal, du preload et des tests moteur avec esbuild.
import * as esbuild from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
const external = ['electron', ...Object.keys(pkg.dependencies || {})];
const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  external,
  logLevel: 'info',
};

const builds = [
  { ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main/main.js' },
  { ...common, entryPoints: ['src/preload/preload.ts'], outfile: 'dist/preload/preload.js' },
  { ...common, entryPoints: ['src/test/engine.test.ts'], outfile: 'dist/test/engine.test.js' },
  { ...common, entryPoints: ['src/test/vpn.test.ts'], outfile: 'dist/test/vpn.test.js' },
  { ...common, entryPoints: ['src/test/update.test.ts'], outfile: 'dist/test/update.test.js' },
  { ...common, entryPoints: ['src/test/compare.test.ts'], outfile: 'dist/test/compare.test.js' },
  { ...common, entryPoints: ['src/test/transfer.test.ts'], outfile: 'dist/test/transfer.test.js' },
];

if (watch) {
  for (const b of builds.slice(0, 2)) {
    const ctx = await esbuild.context(b);
    await ctx.watch();
  }
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
