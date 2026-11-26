import { defineConfig } from 'vite';

export default defineConfig({
  base: '/static/',
  build: {
    rollupOptions: {
      input: 'src/main.ts',
      output: { entryFileNames: 'terminal.js', assetFileNames: 'terminal.[ext]' },
    },
  },
});
