import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src',
  base: './',
  server: {
    port: 5173,
    host: '0.0.0.0'
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/node_modules/pdfjs-dist/')) return 'pdf-renderer';
          if (id.includes('/node_modules/pdf-lib/')) return 'pdf-tools';
          if (id.includes('/node_modules/fabric/')) return 'canvas-editor';
        }
      }
    }
  }
});
