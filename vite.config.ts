import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';
import renderer from 'vite-plugin-electron-renderer';
import path from 'path';

// Helper to determine if we're building for Electron
const isElectron = process.env.ELECTRON === 'true';

// Base configuration
const config = {
  // Always use relative paths for assets in Electron
  base: isElectron ? '' : '/',
  // Use custom HTML template for Electron builds
  root: isElectron ? process.cwd() : undefined,
  plugins: [
    react(),
    isElectron && electron([
      { 
        entry: 'electron/main.ts',
        vite: {
          build: {
            outDir: 'dist-electron/main',
            rollupOptions: {
              external: ['electron'],
            },
          },
        },
      },
      { 
        entry: 'electron/preload.ts',
        onstart(options) { 
          options.reload(); 
        },
        vite: {
          build: {
            outDir: 'dist-electron/preload',
          },
        },
      },
    ]),
    isElectron && renderer(),
  ].filter(Boolean),
  resolve: {
    alias: { 
      '@': path.resolve(__dirname, 'src'),
    },
  },
  build: {
    outDir: isElectron ? 'dist' : 'dist-web',
    emptyOutDir: true,
    assetsDir: 'assets',
    // Use custom HTML template for Electron builds
    rollupOptions: isElectron ? {
      input: {
        main: path.resolve(__dirname, 'public/electron-index.html'),
      },
      output: {
        manualChunks: undefined, // Disable code splitting for Electron
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    } : {
      output: {
        manualChunks: undefined,
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  define: {
    'process.env.ELECTRON': JSON.stringify(isElectron ? 'true' : 'false'),
  },
  // Ensure Vite doesn't try to handle file URLs
  server: {
    fs: {
      strict: false,
    },
  },
};

// Add base URL handling for production builds
if (!isElectron) {
  config.base = '/';
}

export default defineConfig(config);
