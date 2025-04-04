import { defineConfig } from 'vite';
import path from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
    extensions: ['.js', '.ts', '.jsx', '.tsx']
  },
  optimizeDeps: {
    include: ['es6-promise', 'webworkify-webpack'],
    exclude: ['@types/node']
  },
  build: {
    commonjsOptions: {
      include: [/es6-promise/, /webworkify-webpack/, /node_modules/]
    }
  },
  esbuild: {
    tsconfigRaw: {
      compilerOptions: {
        strict: false,
        paths: {
          '@/*': ['./src/*']
        }
      }
    }
  }
}); 