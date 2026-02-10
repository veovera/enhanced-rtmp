import esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const minify = process.argv.includes('--minify');

const buildOptions = {
  entryPoints: ['src/main.ts'],
  outfile: 'dist/eflv.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'es2022',
  banner: {
    js: '#!/usr/bin/env node',
  },
  packages: 'external',
  sourcemap: true,
  minify,
};

if (watch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  console.log('Watching for changes...');
} else {
  await esbuild.build(buildOptions);
  console.log('Build complete.');
}
