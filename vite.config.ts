import { defineConfig, type Plugin } from 'vite';
import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const hash = (() => { try { return execSync('git rev-parse --short HEAD').toString().trim(); } catch { return 'dev'; } })();   // nomor versi build, tampil di panel Debug Audio
const stamp = hash + ' ' + new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

// PWA: setelah build, isi daftar semua file hasil build ke dist/sw.js supaya seluruh aplikasi
// (termasuk worker dan font) tersimpan di cache saat pertama dibuka dan bisa jalan offline.
function pwaPrecache(): Plugin {
  let outDir = 'dist';
  const walk = (dir: string, base = ''): string[] =>
    readdirSync(dir).flatMap((name) => {
      const rel = base ? base + '/' + name : name;
      return statSync(join(dir, name)).isDirectory() ? walk(join(dir, name), rel) : [rel];
    });
  return {
    name: 'pwa-precache',
    apply: 'build',
    configResolved(c) { outDir = c.build.outDir; },
    closeBundle() {
      const swPath = join(outDir, 'sw.js');
      const files = walk(outDir).filter((f) => f !== 'sw.js' && !f.endsWith('.map')).map((f) => './' + f);
      const src = readFileSync(swPath, 'utf8')
        .replace('/*__PRECACHE__*/[]', JSON.stringify(files))
        .replace('__VERSION__', hash + '-' + Date.now().toString(36));
      writeFileSync(swPath, src);
    },
  };
}

export default defineConfig({
  define: { __BUILD__: JSON.stringify(stamp) },
  plugins: [pwaPrecache()],
  build: {
    // CSS dibiarkan apa adanya (tidak di-minify) supaya tampilan identik dengan versi HTML
    cssMinify: false,
  },
});
