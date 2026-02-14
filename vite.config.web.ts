import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

/** Web-only build for Azure Static Web Apps (no Electron). */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
