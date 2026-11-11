import { defineConfig } from 'vite';

export default defineConfig({
  // The diagnosis rules live in ../shared, outside this package's root.
  server: { fs: { allow: ['..'] } }
});
