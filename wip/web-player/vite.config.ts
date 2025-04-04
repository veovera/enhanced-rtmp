import { defineConfig } from 'vite';
import path from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
    extensions: ['.js', '.ts']
  },
  optimizeDeps: {
    include: ['es6-promise', 'webworkify-webpack']
  },
  build: {
    commonjsOptions: {
      include: [/es6-promise/, /webworkify-webpack/, /node_modules/]
    }
  },
  esbuild: {
    tsconfigRaw: {
      compilerOptions: {
        strict: false
      }
    }
  }
}); 