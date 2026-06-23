import { defineConfig } from 'vite';

// On GitHub Pages a project site is served from https://<user>.github.io/<repo>/,
// so the build needs a matching base path. The deploy workflow sets BASE_PATH;
// locally it defaults to '/'.
export default defineConfig({
  base: process.env.BASE_PATH || '/',
  server: {
    open: true,
  },
  build: {
    target: 'esnext',
  },
});
