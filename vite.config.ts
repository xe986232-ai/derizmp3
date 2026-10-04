import { defineConfig, type Plugin } from 'vite';

// onnxruntime-web (dipakai Stem Splitter lewat web-audio-separation) menaruh referensi `new URL('ort-wasm-*.wasm', import.meta.url)`, jadi Vite
// menyalin WASM ~28 MB ke dist. Tidak terpakai: web-audio-separation mengarahkan `env.wasm.wasmPaths` ke CDN jsDelivr sebelum membuat sesi.
// Aset itu dibuang dari bundel supaya deploy tidak membengkak 28 MB.
const dropOrtWasm = (): Plugin => ({
  name: 'drop-ort-wasm',
  apply: 'build',
  generateBundle(_, bundle) {
    for (const name of Object.keys(bundle)) if (/(^|\/)ort-wasm[^/]*\.wasm$/.test(name)) delete bundle[name];
  },
});

export default defineConfig({
  plugins: [dropOrtWasm()],
  build: {
    // CSS dibiarkan apa adanya (tidak di-minify) supaya tampilan identik dengan versi HTML
    cssMinify: false,
  },
});
