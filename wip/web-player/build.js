import { context } from 'esbuild';
import path from 'path';
const args = process.argv.slice(2);
const isWatch = args.includes('--watch');
const isMinify = args.includes('--minify');

const options = {
  entryPoints: ['src/main.ts'],
  bundle: true,
  outfile: 'dist/bundle.js',
  sourcemap: true,
  target: 'es2022',
  minify: isMinify,
};

const ctx = await context(options);
console.log("Using alias:", path.resolve("src/mux-lib"));
if (isWatch) {
  await ctx.watch();
  console.log('👀 esbuild is watching for changes...');
} else {
  await ctx.rebuild();
  console.log('✅ Build complete.');
  process.exit(0); // force exit
}
