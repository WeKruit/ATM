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
      '/health': 'http://localhost:8000',
      '/metrics': 'http://localhost:8000',
      '/version': 'http://localhost:8000',
      '/containers': 'http://localhost:8000',
      '/workers': 'http://localhost:8000',
      '/deploys': 'http://localhost:8000',
      '/secrets': 'http://localhost:8000',
      '/kamal': 'http://localhost:8000',
      '/deploy': 'http://localhost:8000',
      '/rollback': 'http://localhost:8000',
    },
  },
});
