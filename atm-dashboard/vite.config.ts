import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: process.env.VITE_BASE || '/dashboard/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/health': 'http://localhost:8080',
      '/metrics': 'http://localhost:8080',
      '/version': 'http://localhost:8080',
      '/containers': 'http://localhost:8080',
      '/workers': 'http://localhost:8080',
      '/deploys': 'http://localhost:8080',
      '/secrets': 'http://localhost:8080',
      '/kamal': 'http://localhost:8080',
      '/deploy': 'http://localhost:8080',
      '/rollback': 'http://localhost:8080',
    },
  },
});
