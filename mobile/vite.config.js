import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: 'src',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'src/index.html'),
        // browser interop test page, only built with E2E=1 (not shipped in the APK)
        ...(process.env.E2E ? { e2e: resolve(__dirname, 'src/e2e.html') } : {})
      }
    }
  },
  optimizeDeps: { esbuildOptions: { target: 'es2022' } },
  server: {
    port: 3000,
  },
});
