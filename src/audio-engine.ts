// Mesin audio clip: decode file, simpan buffer, gambar waveform sederhana, dan putar sesuai posisi playhead.
// Satu clip di timeline = elemen .pattern dengan data-clip (id buffer) dan data-off (offset dalam detik).

interface Entry { buf: AudioBuffer; peaks?: Float32Array; max: number; }
const buffers = new Map<number, Entry>();
let seq = 0;

export interface ClipPlacement {
  track: string;
  clip: number;
  startBar: number;
  endBar: number;
  offsetSec: number;
}

export async function decodeFile(ctx: AudioContext, file: File): Promise<AudioBuffer> {
  return ctx.decodeAudioData(await file.arrayBuffer());
}

// Decode file untuk plugin (mis. DERIZ) tanpa AudioContext yang sedang berjalan: OfflineAudioContext tidak butuh gestur pengguna.
export async function decodeStandalone(file: File): Promise<AudioBuffer> {
  const Ctor = window.OfflineAudioContext || (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  return new Ctor(2, 1, 44100).decodeAudioData(await file.arrayBuffer());
}

// Puncak (min, max) per "bucket" rata di seluruh durasi; semua channel digabung. Hasil: [min0, max0, min1, max1, ...]
export function bucketPeaks(buf: AudioBuffer, n: number): Float32Array {
  const p = new Float32Array(n * 2), len = buf.length;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let b = 0; b < n; b++) {
      const s0 = Math.floor(b * len / n), s1 = Math.min(len, Math.max(s0 + 1, Math.floor((b + 1) * len / n)));
      let lo = p[b * 2], hi = p[b * 2 + 1];
      for (let i = s0; i < s1; i++) { const v = d[i]; if (v < lo) lo = v; else if (v > hi) hi = v; }
      p[b * 2] = lo; p[b * 2 + 1] = hi;
    }
  }
  return p;
}

export function addBuffer(buf: AudioBuffer): number {
  buffers.set(++seq, { buf, max: 0 });
  return seq;
}

export const bufferDuration = (id: number): number => buffers.get(id)?.buf.duration ?? 0;

// ---------- waveform (sementara: bentuk gelombang polos, bisa diganti nanti) ----------
const PPS = 100;          // jumlah "bucket" puncak per detik audio
const WAVE_COLS = 1200;   // kolom maksimum yang digambar per clip

function peaksOf(e: Entry): Float32Array {
  if (e.peaks) return e.peaks;
  const { buf } = e, n = Math.max(1, Math.ceil(buf.duration * PPS)), p = new Float32Array(n * 2);
  const sr = buf.sampleRate;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let b = 0; b < n; b++) {
      const s0 = Math.floor(b * sr / PPS), s1 = Math.min(d.length, Math.floor((b + 1) * sr / PPS));
      let lo = p[b * 2], hi = p[b * 2 + 1];
      for (let i = s0; i < s1; i++) { const v = d[i]; if (v < lo) lo = v; else if (v > hi) hi = v; }
      p[b * 2] = lo; p[b * 2 + 1] = hi;
    }
  }
  let m = 0;
  for (let i = 0; i < p.length; i++) m = Math.max(m, Math.abs(p[i]));
  e.peaks = p; e.max = m;
  return p;
}

const SVGNS = 'http://www.w3.org/2000/svg';

export function renderWave(el: HTMLElement, clipId: number, offSec: number, durSec: number): void {
  const e = buffers.get(clipId);
  if (!e || durSec <= 0) return;
  let host = el.querySelector<HTMLElement>('.pattern__wave');
  if (!host) {
    host = document.createElement('div');
    host.className = 'pattern__wave';
    el.insertBefore(host, el.querySelector('.pattern__handle'));
  }
  const audioSec = Math.min(durSec, e.buf.duration - offSec);
  if (audioSec <= 0) { host.textContent = ''; return; }
  const p = peaksOf(e), n = p.length / 2;
  const b0 = offSec * PPS, b1 = (offSec + audioSec) * PPS;
  const cols = Math.max(1, Math.min(WAVE_COLS, Math.ceil(b1 - b0)));
  const span = 1000 * (audioSec / durSec), norm = 0.92 / Math.max(e.max, 0.05);
  const top: string[] = [], bot: string[] = [];
  for (let i = 0; i < cols; i++) {
    const lo = Math.min(n - 1, Math.floor(b0 + i * (b1 - b0) / cols));
    const hi = Math.min(n, Math.max(lo + 1, Math.ceil(b0 + (i + 1) * (b1 - b0) / cols)));
    let mn = 0, mx = 0;
    for (let b = lo; b < hi; b++) { if (p[b * 2] < mn) mn = p[b * 2]; if (p[b * 2 + 1] > mx) mx = p[b * 2 + 1]; }
    let yt = 50 - mx * norm * 48, yb = 50 - mn * norm * 48;
    if (yb - yt < 1) { yt -= .5; yb += .5; }
    const x = ((i + .5) / cols * span).toFixed(2);
    top.push(x + ' ' + yt.toFixed(1)); bot.push(x + ' ' + yb.toFixed(1));
  }
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', '0 0 1000 100');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVGNS, 'path');
  path.setAttribute('d', 'M' + top.join('L') + 'L' + bot.reverse().join('L') + 'Z');
  svg.appendChild(path);
  host.replaceChildren(svg);
}

// ---------- playback ----------
const volumes = new Map<string, number>();       // persen per track (slider volume: 0-150, 100 = default)
const gains = new Map<string, GainNode>();
const active = new Set<{ src: AudioBufferSourceNode; env: GainNode; track: string }>();
const pctToLin = (pct: number) => pct / 100;   // 100% = gain 1.0 (tanpa perubahan), 150% = boost x1.5

const muted = new Set<string>();                  // track yang dimatikan lewat switch on/off di header track
export function setTrackMuted(track: string, off: boolean): void {
  if (off) muted.add(track); else muted.delete(track);
  const o = dests.get(track) as GainNode | undefined;   // `out` track: meter level ikut turun ke nol saat mati
  if (o) o.gain.setTargetAtTime(off ? 0 : 1, o.context.currentTime, .015);
}

export function setTrackVolume(track: string, pct: number): void {
  volumes.set(track, pct);
  const g = gains.get(track);
  if (g) g.gain.setTargetAtTime(pctToLin(pct), g.context.currentTime, .02);
}

export function trackInput(ctx: AudioContext, dest: AudioNode, track: string): GainNode {   // titik masuk jalur track (fader -> efek -> out); dipakai juga oleh synth
  return trackGain(ctx, dest, track);
}

function trackGain(ctx: AudioContext, dest: AudioNode, track: string): GainNode {
  let g = gains.get(track);
  if (!g || g.context !== ctx) {
    g = ctx.createGain();
    g.gain.value = pctToLin(volumes.get(track) ?? 100);
    // titik akhir jalur track: semua efek bermuara ke `out`, lalu ke master. Meter level membaca dari sini (setelah fader + efek).
    const out = ctx.createGain();
    out.gain.value = muted.has(track) ? 0 : 1;
    out.connect(dest);
    g.connect(out);
    gains.set(track, g);
    dests.set(track, out);
    makeMeter(ctx, track, out);
    syncFx(track);   // track ini sudah punya kartu efek sebelum pernah diputar
  }
  return g;
}

// ---------- meter level stereo per track ----------
interface Meter { ctx: BaseAudioContext; l: AnalyserNode; r: AnalyserNode; bufL: Float32Array<ArrayBuffer>; bufR: Float32Array<ArrayBuffer>; }
const meters = new Map<string, Meter>();

function makeMeter(ctx: BaseAudioContext, track: string, from: AudioNode): void {
  const split = ctx.createChannelSplitter(2), l = ctx.createAnalyser(), r = ctx.createAnalyser(), mute = ctx.createGain();
  l.fftSize = r.fftSize = 1024; l.smoothingTimeConstant = r.smoothingTimeConstant = 0;
  mute.gain.value = 0; mute.connect(ctx.destination);   // sambungan senyap: beberapa browser baru memproses node yang tersambung ke output
  from.connect(split); split.connect(l, 0); split.connect(r, 1); l.connect(mute); r.connect(mute);
  meters.set(track, { ctx, l, r, bufL: new Float32Array(l.fftSize), bufR: new Float32Array(r.fftSize) });
}

const peakOf = (a: AnalyserNode, buf: Float32Array<ArrayBuffer>): number => {
  a.getFloatTimeDomainData(buf);
  let m = 0;
  for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i]); if (v > m) m = v; }
  return m;
};

// Level puncak [kiri, kanan] track ini, 0..1 linear (0 = senyap / track belum pernah diputar).
export function trackLevels(track: string): [number, number] {
  const m = meters.get(track);
  return m ? [peakOf(m.l, m.bufL), peakOf(m.r, m.bufR)] : [0, 0];
}

// ---------- effect per track: equalizer -> reverb ----------
// Jalur: gain track -> [EQ: low shelf -> mid peaking -> high shelf] -> dry -> output, dan -> convolver -> wet -> output (reverb).
// Mix reverb memakai crossfade equal-power. Urutan di jalur audio selalu EQ dulu, baru reverb (tidak tergantung urutan card).
export interface ReverbParams { on: boolean; mix: number; size: number }   // mix 0..1, size 0..1 (-> gema 0,4 s .. 5 s)
const reverbs = new Map<string, ReverbParams>();
const dests = new Map<string, AudioNode>();
export interface EqParams { on: boolean; low: number; mid: number; high: number }   // tiap band 0..1, 0,5 = 0 dB
const eqs = new Map<string, EqParams>();
export const EQ_RANGE_DB = 12;   // knob penuh = ±12 dB
export const eqDb = (v: number): number => (Math.max(0, Math.min(1, v)) - 0.5) * 2 * EQ_RANGE_DB;
interface Chain {
  ctx: BaseAudioContext; topo: string;
  low: BiquadFilterNode; mid: BiquadFilterNode; high: BiquadFilterNode;
  dry: GainNode; wet: GainNode; conv: ConvolverNode; decay: number;
}
const chains = new Map<string, Chain>();

export const reverbSeconds = (size: number): number => Math.round((0.4 + Math.max(0, Math.min(1, size)) * 4.6) * 10) / 10;

// impuls respons buatan: derau stereo yang meluruh, makin ke ekor makin redup (low-pass satu kutub)
function makeImpulse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const sr = ctx.sampleRate, len = Math.max(1, Math.floor(seconds * sr)), pre = Math.floor(.012 * sr);
  const buf = ctx.createBuffer(2, len, sr);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let lp = 0;
    let e = 0;
    for (let i = pre; i < len; i++) {
      const t = (i - pre) / (len - pre), a = 0.65 - 0.5 * t;
      lp += a * ((Math.random() * 2 - 1) - lp);
      d[i] = lp * Math.pow(1 - t, 3);
      e += d[i] * d[i];
    }
    const k = e > 0 ? 1 / Math.sqrt(e) : 0;   // energi impuls dibuat 1, supaya level wet sama untuk ruang kecil maupun besar
    for (let i = pre; i < len; i++) d[i] *= k;
  }
  return buf;
}

function syncFx(track: string): void {
  const g = gains.get(track), dest = dests.get(track), rv = reverbs.get(track), eq = eqs.get(track);
  if (!g || !dest) return;                       // belum pernah diputar: dipasang saat gain track dibuat
  const ctx = g.context;
  let ch = chains.get(track);
  if (!rv && !eq) {                              // semua card efek dihapus: kembali ke jalur langsung
    if (ch) {
      g.disconnect(); [ch.low, ch.mid, ch.high, ch.dry, ch.wet, ch.conv].forEach(n => n.disconnect());
      g.connect(dest); chains.delete(track);
    }
    return;
  }
  if (!ch || ch.ctx !== ctx) {
    const low = ctx.createBiquadFilter(), mid = ctx.createBiquadFilter(), high = ctx.createBiquadFilter();
    low.type = 'lowshelf'; low.frequency.value = 150;
    mid.type = 'peaking'; mid.frequency.value = 1000; mid.Q.value = 0.8;
    high.type = 'highshelf'; high.frequency.value = 6000;
    const conv = ctx.createConvolver();
    conv.normalize = false;   // normalisasi dilakukan sendiri di makeImpulse
    ch = { ctx, topo: '', low, mid, high, dry: ctx.createGain(), wet: ctx.createGain(), conv, decay: 0 };
    chains.set(track, ch);
  }
  const topo = (eq ? 'e' : '-') + (rv ? 'r' : '-');
  if (topo !== ch.topo) {                        // susun ulang jalur sesuai efek yang ada
    g.disconnect(); [ch.low, ch.mid, ch.high, ch.dry, ch.wet, ch.conv].forEach(n => n.disconnect());
    let s: AudioNode = g;
    if (eq) { g.connect(ch.low); ch.low.connect(ch.mid); ch.mid.connect(ch.high); s = ch.high; }
    if (rv) { s.connect(ch.dry); ch.dry.connect(dest); s.connect(ch.conv); ch.conv.connect(ch.wet); ch.wet.connect(dest); }
    else s.connect(dest);
    ch.topo = topo;
  }
  const now = ctx.currentTime;
  if (eq) {
    ch.low.gain.setTargetAtTime(eq.on ? eqDb(eq.low) : 0, now, .02);
    ch.mid.gain.setTargetAtTime(eq.on ? eqDb(eq.mid) : 0, now, .02);
    ch.high.gain.setTargetAtTime(eq.on ? eqDb(eq.high) : 0, now, .02);
  }
  if (rv) {
    const decay = reverbSeconds(rv.size);
    if (decay !== ch.decay) { ch.conv.buffer = makeImpulse(ctx, decay); ch.decay = decay; }
    const m = rv.on ? Math.max(0, Math.min(1, rv.mix)) : 0;
    ch.dry.gain.setTargetAtTime(Math.cos(m * Math.PI / 2), now, .02);
    ch.wet.gain.setTargetAtTime(Math.sin(m * Math.PI / 2), now, .02);
  }
}

// null = track tidak punya reverb
export function setReverb(track: string, p: ReverbParams | null): void {
  if (p) reverbs.set(track, { ...p }); else reverbs.delete(track);
  syncFx(track);
}

// null = track tidak punya equalizer
export function setEq(track: string, p: EqParams | null): void {
  if (p) eqs.set(track, { ...p }); else eqs.delete(track);
  syncFx(track);
}

function release(r: { src: AudioBufferSourceNode; env: GainNode }, now: number): void {
  r.src.onended = null;
  const cur = r.env.gain.value;               // nilai saat ini (bisa sedang di tengah fade-in / fade-out clip)
  r.env.gain.cancelScheduledValues(now);
  r.env.gain.setValueAtTime(cur, now);        // tanpa ini gain loncat balik ke 1 setelah cancel -> klik
  r.env.gain.setTargetAtTime(0, now, .008);   // fade sangat singkat agar tidak ada bunyi "klik"
  try { r.src.stop(now + .06); } catch { /* sudah berhenti */ }
  setTimeout(() => { r.src.disconnect(); r.env.disconnect(); }, 120);
}

export function stopAll(ctx: AudioContext | null): void {
  if (!ctx) return;
  active.forEach(r => release(r, ctx.currentTime));
  active.clear();
}

export function stopTrack(ctx: AudioContext | null, track: string): void {
  if (!ctx) return;
  active.forEach(r => { if (r.track === track) { release(r, ctx.currentTime); active.delete(r); } });
}

const CLIP_FADE_IN = .004, CLIP_FADE_OUT = .006;   // detik; cukup singkat supaya serangan (transien) tidak terasa tumpul

// Jadwalkan semua clip mulai dari posisi `fromBar`; `t0` = waktu AudioContext saat fromBar dimainkan.
export function play(ctx: AudioContext, dest: AudioNode, clips: ClipPlacement[], fromBar: number, secPerBar: number, t0: number): void {
  stopAll(ctx);
  for (const c of clips) {
    const e = buffers.get(c.clip);
    if (!e || c.endBar <= fromBar + 1e-6) continue;
    let when: number, off: number, dur: number;
    if (c.startBar >= fromBar) {
      when = t0 + (c.startBar - fromBar) * secPerBar; off = c.offsetSec; dur = (c.endBar - c.startBar) * secPerBar;
    } else {
      when = t0; off = c.offsetSec + (fromBar - c.startBar) * secPerBar; dur = (c.endBar - fromBar) * secPerBar;
    }
    dur = Math.min(dur, e.buf.duration - off);
    if (dur < .001 || off < 0) continue;
    const src = ctx.createBufferSource(), env = ctx.createGain();
    src.buffer = e.buf;
    src.connect(env); env.connect(trackGain(ctx, dest, c.track));
    // clip dimulai / diakhiri di titik mana pun pada gelombang (offset, potongan, split): tanpa fade terdengar sebagai klik / kresek
    const fin = Math.min(CLIP_FADE_IN, dur / 2), fout = Math.min(CLIP_FADE_OUT, dur / 2), tNow = Math.max(when, ctx.currentTime);
    env.gain.setValueAtTime(0, tNow);
    env.gain.linearRampToValueAtTime(1, tNow + fin);
    if (when + dur - fout > tNow + fin) { env.gain.setValueAtTime(1, when + dur - fout); env.gain.linearRampToValueAtTime(0, when + dur); }
    const rec = { src, env, track: c.track };
    src.onended = () => { active.delete(rec); src.disconnect(); env.disconnect(); };
    active.add(rec);
    src.start(when, off, dur);
  }
}
