import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

function manualChunks(id: string): string | undefined {
  if (id.includes('pdfjs-dist') || id.includes('react-pdf')) {
    return 'pdfjs';
  }
  if (id.includes('xlsx') || id.includes('file-saver')) {
    return 'xlsx';
  }
  if (id.includes('react-markdown') || id.includes('micromark')) {
    return 'markdown';
  }
  return undefined;
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    target: 'es2020',
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        manualChunks,
      },
    },
  },
});