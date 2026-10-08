import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

/**
 * Browser build (Azure Static Web Apps) and the plain browser dev server
 * (`npm run dev`). No Electron plugins. CSP comes from staticwebapp.config.json.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: { 'vendor-charts': ['recharts'] },
      },
    },
  },
});
