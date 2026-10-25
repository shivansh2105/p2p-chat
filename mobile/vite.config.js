import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig(({ mode }) => ({
  root: 'src',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'src/index.html'),
        // browser interop test page, only built with --mode e2e (not shipped in the APK)
        ...(mode === 'e2e' ? { e2e: resolve(__dirname, 'src/e2e.html') } : {})
      }
    }
  },
  optimizeDeps: { esbuildOptions: { target: 'es2022' } },
  server: {
    port: 3000,
  },
}));
