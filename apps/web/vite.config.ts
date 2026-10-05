import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// The shared package is consumed as TypeScript source so the client and API validate with
// the same schemas without a separate ESM build.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@teeth/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)) },
  },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3000' },
  },
});
