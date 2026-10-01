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
const volumes = new Map<string, number>();       // dB per track (dari slider volume)
const gains = new Map<string, GainNode>();
const active = new Set<{ src: AudioBufferSourceNode; env: GainNode; track: string }>();
const dbToLin = (db: number) => Math.pow(10, db / 20);

export function setTrackVolume(track: string, db: number): void {
  volumes.set(track, db);
  const g = gains.get(track);
  if (g) g.gain.setTargetAtTime(dbToLin(db), g.context.currentTime, .02);
}

function trackGain(ctx: AudioContext, dest: AudioNode, track: string): GainNode {
  let g = gains.get(track);
  if (!g || g.context !== ctx) {
    g = ctx.createGain();
    g.gain.value = dbToLin(volumes.get(track) ?? -5.5);
    g.connect(dest);
    gains.set(track, g);
  }
  return g;
}

function release(r: { src: AudioBufferSourceNode; env: GainNode }, now: number): void {
  r.src.onended = null;
  r.env.gain.cancelScheduledValues(now);
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
    const rec = { src, env, track: c.track };
    src.onended = () => { active.delete(rec); src.disconnect(); env.disconnect(); };
    active.add(rec);
    src.start(when, off, dur);
  }
}
