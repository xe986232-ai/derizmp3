import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';

const hash = (() => { try { return execSync('git rev-parse --short HEAD').toString().trim(); } catch { return 'dev'; } })();   // nomor versi build, tampil di panel Debug Audio


export default defineConfig({
  define: { __BUILD__: JSON.stringify(hash + ' ' + new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC') },
  build: {
    // CSS dibiarkan apa adanya (tidak di-minify) supaya tampilan identik dengan versi HTML
    cssMinify: false,
  },
});
