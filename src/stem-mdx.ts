// Stem Splitter, backend model: MDX-Net (Kim_Vocal_2) lewat paket `web-audio-separation` (MIT) + onnxruntime-web. Jalan penuh di browser:
// model ONNX (~67 MB) diunduh dari Hugging Face sekali, lalu disimpan di CacheStorage browser (pemakaian berikutnya tanpa unduh).
// Antarmuka hasilnya sama dengan separate() di stem-split.ts (DSP klasik, dipakai sebagai cadangan di main.ts): { vocal, instrumental }
// dengan jumlah kanal, panjang, dan sample rate sama dengan masukan, jadi sisa alur (cache, track baru, stretch tempo) tidak berubah.
//
// Kenapa di thread utama, bukan Worker: paket ini men-decode audio lewat OfflineAudioContext (tidak ada di Worker). Inferensi ONNX sendiri
// jalan di WebGPU / thread WASM-nya sendiri; yang tersisa di thread utama hanya STFT per potongan. Dimuat lewat import() dinamis, jadi
// paket + onnxruntime-web tidak ikut dimuat sebelum fitur ini dipakai.
//
// Hasil model: vokal = keluaran model; instrumen = mix - vokal·compensate (cara UVR / python-audio-separator), jadi vokal + instrumen
// hampir, tapi tidak persis, sama dengan aslinya. Model dilatih di 44,1 kHz: audio di-resample ke sana lalu dikembalikan ke sample rate asal.
import type { MDXSeparator, SeparationProgress } from 'web-audio-separation';

export const MDX_MODEL = 'Kim_Vocal_2' as const;   // alternatif dengan ukuran sama (~67 MB): 'UVR-MDX-NET-Voc_FT'
const MODEL_SR = 44100;
export interface MdxResult { vocal: Float32Array[]; instrumental: Float32Array[] }

// Porsi progres (di luar unduhan model, lihat DL_SHARE): muat model 0-8%, demix 8-90%, tulis stem 90-95%, decode + resample balik 95-100%.
function stageProgress(p: SeparationProgress): number {
  const f = Math.max(0, Math.min(1, p.fraction));
  switch (String(p.stage)) {
    case 'loading-model': return 0.08 * f;
    case 'demixing': return 0.08 + 0.82 * f;
    case 'writing-output': return 0.90 + 0.05 * f;
    default: return 0;
  }
}

// Paket hanya melaporkan "muat model" 0 -> 1 tanpa progres unduhan, jadi 67 MB pertama terlihat macet di 0%. Model diunduh sendiri di sini (dengan
// progres) ke CacheStorage yang sama dengan yang dibaca loadModel() (nama cache + kunci URL mengikuti paket), jadi loadModel() langsung kena cache.
// Kalau cache tidak ada / gagal ditulis, loadModel() mengunduh sendiri seperti biasa (tanpa progres).
const MODEL_CACHE = 'web-demix2-models', MODEL_BYTES = 67_000_000, DL_SHARE = 0.35;
async function prefetchModel(url: string, onFrac: (f: number) => void): Promise<void> {
  if (typeof caches === 'undefined') return;
  let cache: Cache;
  try { cache = await caches.open(MODEL_CACHE); if (await cache.match(url)) return; } catch { return; }
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error('Gagal mengunduh model (HTTP ' + res.status + ')');
  const total = Number(res.headers.get('content-length')) || MODEL_BYTES, reader = res.body.getReader(), parts: Uint8Array<ArrayBuffer>[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value as Uint8Array<ArrayBuffer>); got += value.length; onFrac(Math.min(1, got / total));
  }
  try { await cache.put(url, new Response(new Blob(parts), { headers: { 'content-type': 'application/octet-stream' } })); } catch { /* loadModel() unduh ulang */ }
}

// Decode WAV stem hasil model; decodeAudioData otomatis me-resample ke sample rate konteks (44,1 kHz -> sr asal). Panjang dipaskan ke n.
async function decodeStem(url: string, sr: number, n: number, ch: number): Promise<Float32Array[]> {
  const bytes = await (await fetch(url)).arrayBuffer();
  const buf = await new OfflineAudioContext(2, 1, sr).decodeAudioData(bytes);
  return Array.from({ length: ch }, (_, c) => {
    const src = buf.getChannelData(Math.min(c, buf.numberOfChannels - 1)), out = new Float32Array(n);
    out.set(src.subarray(0, Math.min(n, src.length)));
    return out;
  });
}

// Sesi ONNX tidak punya API pelepasan di MDXSeparator; tanpa ini tiap pemisahan menahan ~100+ MB. Gagal pun aman (hanya menunggu GC).
async function releaseSession(sep: MDXSeparator): Promise<void> {
  try { await (sep as unknown as { model?: { release?: () => Promise<void> } }).model?.release?.(); } catch { /* abaikan */ }
}

async function run(chs: Float32Array[], sr: number, onProgress?: (p: number) => void, onStatus?: (msg: string) => void): Promise<MdxResult> {
  if (chs.length < 1 || chs.length > 2) throw new Error('Stem splitter mendukung 1 (mono) atau 2 (stereo) kanal, bukan ' + chs.length);
  const n = chs[0].length;
  for (const c of chs) if (c.length !== n) throw new Error('Panjang kanal tidak sama');
  const report = (p: number): void => onProgress?.(Math.max(0, Math.min(1, p)));
  report(0);
  const lib = await import('web-audio-separation');
  // Separator baru per pekerjaan: instance-nya menyimpan hasil terakhir (primarySource / secondarySource tidak di-reset), jadi dipakai ulang
  // untuk file lain akan mengembalikan stem file pertama. Model tetap tidak diunduh ulang (CacheStorage).
  let dl = 0;   // porsi bar untuk unduhan model: 0 kalau model sudah di-cache, DL_SHARE begitu unduhan dimulai (sisa bar dibagi untuk tahap lain)
  let stage = '';
  const status = (msg: string): void => { if (msg !== stage) { stage = msg; onStatus?.(msg); } };
  const sep = lib.createSeparator(MDX_MODEL, {
    common: {
      sampleRate: MODEL_SR, logLevel: 'error',
      onProgress: p => {
        report(dl + (1 - dl) * stageProgress(p));
        if (String(p.stage) === 'demixing') status('Memisahkan vokal & instrumen…');
      },
    },
  });
  const urls: string[] = [];
  try {
    const inUrl = URL.createObjectURL(await lib.AudioUtils.saveAudioFile(chs, sr, 'mix.wav'));
    urls.push(inUrl);
    status('Mengunduh model AI… 0%');
    await prefetchModel(lib.MODEL_REGISTRY[MDX_MODEL].downloadUrl, f => {
      dl = DL_SHARE; report(dl * f); status('Mengunduh model AI… ' + Math.floor(f * 100) + '%');
    });
    status('Memuat model AI…');
    await sep.loadModel();
    status('Memisahkan vokal & instrumen…');
    const out = await sep.separate(inUrl);
    urls.push(...out);
    if (out.length !== 2) throw new Error('Model tidak menghasilkan dua stem');
    const [inst, voc] = out;   // separate() menyimpan stem sekunder (instrumen) lebih dulu, baru primer (vokal; primary_stem model ini 'Vocals')
    const vocal = await decodeStem(voc, sr, n, chs.length);
    report(0.975);
    const instrumental = await decodeStem(inst, sr, n, chs.length);
    report(1);
    return { vocal, instrumental };
  } finally {
    urls.forEach(u => URL.revokeObjectURL(u));
    await releaseSession(sep);
  }
}

// Pekerjaan diantre satu per satu: dua pemisahan paralel akan berebut memori dan sesi ONNX.
let queue: Promise<unknown> = Promise.resolve();
export function separateMdx(chs: Float32Array[], sr: number, onProgress?: (p: number) => void, onStatus?: (msg: string) => void): Promise<MdxResult> {
  const job = queue.then(() => run(chs, sr, onProgress, onStatus));
  queue = job.catch(() => undefined);
  return job;
}
