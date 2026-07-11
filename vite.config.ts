import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    strictPort: true,
    port: 4322,
    proxy: {
      '/api': 'http://127.0.0.1:4323'
    }
  },
  build: {
    outDir: 'dist/client',
    target: 'es2022'
  }
});
