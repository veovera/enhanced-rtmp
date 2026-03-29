import { context } from 'esbuild';

const args = process.argv.slice(2);
const isWatch = args.includes('--watch');
const isDebug = args.includes('--debug');
let isMinify = args.includes('--minify');

if (isDebug) {
  console.log('Debug mode is enabled. Minification will be disabled.');
  isMinify = false; // Disable minification in debug mode
}

let finishedCount = 0;
const buildFinishedPlugin = (label) => ({
  name: 'build-finished',
  setup(build) {
    build.onEnd(() => {
      console.log(`✅ Build finished [${label}]: ${new Date().toLocaleString()}`);
      if (++finishedCount % 2 === 0) console.log(`─`.repeat(54) + ` #${finishedCount / 2}`);
    });
  }
});

// Main bundle
const mainOptions = {
  entryPoints: ['src/demo-app.ts'],
  bundle: true,
  outfile: 'dist/e-flv-demo.js',
  sourcemap: true,
  target: 'es2022',
  minify: isMinify,
  format: 'esm',
  logLevel: 'warning',  // Add this to see more detailed build information
  plugins: [buildFinishedPlugin('main')],
  define: {
    '__VERSION__': JSON.stringify(process.env.npm_package_version),
    '__DEBUG__': JSON.stringify(isDebug),
  }
};

// Worker bundle
const workerOptions = {
  entryPoints: ['src/mux-lib/player/player-engine-worker.ts'],
  bundle: true,
  outfile: 'dist/player-engine-worker.js',
  sourcemap: true,
  target: 'es2022',
  minify: isMinify,
  format: 'esm',
  logLevel: 'warning',
  plugins: [buildFinishedPlugin('worker')],
};

const mainCtx = await context(mainOptions);
const workerCtx = await context(workerOptions);

if (isWatch) {
  await mainCtx.watch();
  await workerCtx.watch();
  console.log('👀 esbuild is watching for changes...');
} else {
  await mainCtx.rebuild();
  await workerCtx.rebuild();
  process.exit(0);
}
