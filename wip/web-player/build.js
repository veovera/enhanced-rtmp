import { context } from 'esbuild';
import path from 'path';
const args = process.argv.slice(2);
const isWatch = args.includes('--watch');
const isDebug = args.includes('--debug');
let isMinify = args.includes('--minify');

if (isDebug) {
  console.log('Debug mode is enabled. Minification will be disabled.');
  isMinify = false; // Disable minification in debug mode
}

const options = {
  entryPoints: ['src/main.ts'],
  bundle: true,
  outfile: 'dist/bundle.js',
  sourcemap: true,
  target: 'es2022',
  minify: isMinify,
  logLevel: 'info',  // Add this to see more detailed build information
  define: {
    '__VERSION__': JSON.stringify(process.env.npm_package_version),
    '__DEBUG__': JSON.stringify(isDebug),
  }
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
