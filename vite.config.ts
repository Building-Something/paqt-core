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
  if (
    id.includes('@tiptap') ||
    id.includes('@remirror') ||
    id.includes('prosemirror') ||
    id.includes('@lezer') ||
    id.includes('w3c-keyname')
  ) {
    return 'tiptap';
  }
  if (id.includes('pdfmake') || id.includes('pdfkit') || id.includes('@foliojs-fork') || id.includes('linebreak')) {
    return 'pdfmake';
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
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        manualChunks,
      },
    },
  },
});