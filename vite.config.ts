import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    // CSS dibiarkan apa adanya (tidak di-minify) supaya tampilan identik dengan versi HTML
    cssMinify: false,
  },
});
