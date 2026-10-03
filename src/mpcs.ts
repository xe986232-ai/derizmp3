// MPCS (Manual Pitch Correct Sample): plugin ringkas bergaya DERIZ (faceplate logam 3D).
// Isi hanya: tombol upload audio, tiga knob (Transition / Variation / Center), tombol play / pause.
//   upload audio -> analisis di Worker -> nada otomatis di-snap ke semiton -> knob mengatur seberapa kuat koreksinya -> putar hasil.
// Tombol buka sengaja tidak ada di daftar efek: jendela hanya terbuka lewat ketukan beruntun pada judul panel "Effects".
// Inti DSP ada di mpcs-dsp.ts (murni), jalan di mpcs-worker.ts.

import { ACCEPT as AUDIO_ACCEPT, isAudio } from './audio-upload-card';
import { DEFAULT_CONTROLS, snapTargets, toMono, type Controls, type Note } from './mpcs-dsp';

const svg = (inner: string, size = 18): string =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
const ICON = {
  up: svg('<path d="M12 16V5M7 10l5-5 5 5M5 19h14"/>', 16),
  play: svg('<path d="M8 5l12 7-12 7z" fill="currentColor" stroke="none"/>', 22),
  pause: svg('<rect x="6" y="5" width="4.5" height="14" rx="1.2" fill="currentColor" stroke="none"/><rect x="13.5" y="5" width="4.5" height="14" rx="1.2" fill="currentColor" stroke="none"/>', 22),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>', 12)
};

// Tiga knob global ala NewTone. Markup & kelas dasar sama dengan knob efek (fx-rack.ts) supaya gayanya menyatu dengan DAW.
const knobSvg = '<svg viewBox="0 0 36 36" aria-hidden="true" class="circular-chart">' +
  '<path d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" stroke-dasharray="75, 100" class="circle-bg" style="transform-origin:18px 18px;transform:rotate(225deg)"></path>' +
  '<path d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" stroke-dashoffset="0" stroke-dasharray="0 100" class="circle primary-theme" style="transform:rotate(225deg)"></path>' +
  '<path d="M18 5.142857142857142 a 12.857142857142858 12.857142857142858 0 0 1 0 25.714285714285715 a 12.857142857142858 12.857142857142858 0 0 1 0 -25.714285714285715" fill="var(--background-tinted-press)" stroke="none" class="circle-inner"></path>' +
  '<path d="M18 5.7857142857142865 a 12.214285714285714 12.214285714285714 0 0 1 0 24.428571428571427 a 12.214285714285714 12.214285714285714 0 0 1 0 -24.428571428571427" stroke="var(--background-tinted-base)" fill="none" class="circle-inner-stroke"></path>' +
  '<path d="M 18 7.5 L 18 12" class="knob-pos" style="transform:rotate(-135deg)"></path></svg>';
type KnobKey = keyof Controls;
const KNOBS: Record<KnobKey, { label: string; tip: string; bipolar?: boolean }> = {
  transition: { label: 'Trans', bipolar: true, tip: 'Transition: cara pindah antar nada. 50% = luncuran asli dipertahankan. Ke kiri: makin tajam sampai lompat robotik. Ke kanan: makin legato (luncuran lebar). Klik dua kali = reset' },
  variation: { label: 'Variation', tip: 'Variation: variasi alami di dalam nada (vibrato dan pitch yang goyang). 100% = asli, 0% = datar di pusat nada. Klik dua kali = reset' },
  center: { label: 'Center', tip: 'Center: tarik pitch pusat tiap nada ke semiton terdekat. 0% = pitch asli, 100% = tepat di nada. Klik dua kali = reset' }
};
const KNOB_KEYS: KnobKey[] = ['transition', 'variation', 'center'];   // urutan tampil: Trans, Variation, Center
const knobHtml = (k: KnobKey): string =>
  `<div class="mpcs__knob is-off" title="${KNOBS[k].tip}"><div class="knob fxk"><div class="knob-inner"><div role="slider" tabindex="0" class="knob-input" data-kn="${k}" aria-label="${KNOBS[k].label}" aria-valuemin="0" aria-valuemax="1" aria-valuenow="${DEFAULT_CONTROLS[k]}"><div class="knobwheel">${knobSvg}</div></div></div></div>` +
  `<span class="mpcs__lbl">${KNOBS[k].label}</span><output>${Math.round(DEFAULT_CONTROLS[k] * 100)}%</output></div>`;

interface Session { name: string; sr: number; dur: number; notes: Note[]; orig: AudioBuffer; out: AudioBuffer | null }

let root: HTMLElement | null = null, openFn: (() => void) | null = null;

export function initMpcs(): void {
  const title = document.querySelector<HTMLElement>('.fx__title');
  if (!title) return;
  title.style.userSelect = 'none'; title.style.touchAction = 'manipulation'; title.style.setProperty('-webkit-tap-highlight-color', 'transparent');
  let taps = 0, last = 0;
  title.addEventListener('click', () => {
    const t = performance.now();
    taps = t - last > 900 ? 1 : taps + 1; last = t;
    if (taps >= 7) { taps = 0; navigator.vibrate?.(18); open(); }
  });
}

function open(): void {
  if (!root) build();
  openFn?.();
}

function build(): void {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const el = document.createElement('div');
  el.className = 'mpcs'; el.hidden = true;
  el.innerHTML =
    '<div class="mpcs__back"></div>' +
    '<div class="mpcs__win is-off" role="dialog" aria-modal="true" aria-label="MPCS" tabindex="-1">' +
      `<header class="mpcs__head"><i class="mpcs__led" aria-hidden="true"></i><span class="mpcs__title">MPCS</span><button type="button" class="mpcs__close" aria-label="Tutup MPCS">${ICON.close}</button></header>` +
      `<button type="button" class="mpcs__up" data-a="up">${ICON.up}<span>Upload audio</span></button>` +
      `<div class="mpcs__knobs">${KNOB_KEYS.map(knobHtml).join('')}</div>` +
      `<button type="button" class="mpcs__play" data-a="play" aria-label="Putar" disabled>${ICON.play}</button>` +
      '<div class="mpcs__glass" aria-hidden="true"></div>' +
      `<input type="file" class="mpcs__file" accept="${AUDIO_ACCEPT}" hidden>` +
    '</div>';
  document.body.appendChild(el);
  root = el;

  const win = el.querySelector<HTMLElement>('.mpcs__win')!;
  const file = el.querySelector<HTMLInputElement>('.mpcs__file')!;
  const upBtn = el.querySelector<HTMLButtonElement>('.mpcs__up')!;
  const upTxt = upBtn.querySelector('span')!;
  const playBtn = el.querySelector<HTMLButtonElement>('.mpcs__play')!;

  let S: Session | null = null;
  let ac: AudioContext | null = null, src: AudioBufferSourceNode | null = null, playing = false, playPos = 0, t0 = 0, loading = false;
  let dirty = false, rendering = false, ver = 0, worker: Worker | null = null, jobId = 0;
  const jobs = new Map<number, { ok: (m: any) => void; fail: (e: Error) => void }>();   // eslint-disable-line @typescript-eslint/no-explicit-any

  const say = (t: string): void => { upTxt.textContent = t; };   // satu-satunya umpan balik: teks di tombol upload
  const setPlayIcon = (on: boolean): void => { playBtn.innerHTML = on ? ICON.pause : ICON.play; playBtn.setAttribute('aria-label', on ? 'Jeda' : 'Putar'); playBtn.classList.toggle('is-on', on); };

  // ---------- knob Transition / Variation / Center ----------
  let kv: Controls = { ...DEFAULT_CONTROLS };
  const knobEl = {} as Record<KnobKey, HTMLElement>;
  KNOB_KEYS.forEach(k => { knobEl[k] = el.querySelector<HTMLElement>(`[data-kn="${k}"]`)!; });
  function paintKnob(k: KnobKey): void {
    const e = knobEl[k], v = kv[k], arc = e.querySelector('.circle')!;
    e.querySelector<SVGElement>('.knob-pos')!.style.transform = `rotate(${-135 + v * 270}deg)`;
    if (KNOBS[k].bipolar) { const a = Math.min(v, 0.5) * 75, b = Math.max(v, 0.5) * 75; arc.setAttribute('stroke-dasharray', `0 ${a.toFixed(2)} ${(b - a).toFixed(2)} 100`); }   // arc dari tengah (50% = bawaan), seperti knob pan
    else arc.setAttribute('stroke-dasharray', `${(v * 75).toFixed(2)} 100`);
    const t = Math.round(v * 100) + '%';
    e.setAttribute('aria-valuenow', v.toFixed(3)); e.setAttribute('aria-valuetext', KNOBS[k].label + ' ' + t);
    e.closest('.mpcs__knob')!.querySelector('output')!.textContent = t;
  }
  const resetKnobs = (): void => { kv = { ...DEFAULT_CONTROLS }; KNOB_KEYS.forEach(paintKnob); };
  let restartT = 0;
  const lazyRestart = (): void => { if (!playing) return; clearTimeout(restartT); restartT = window.setTimeout(() => { if (playing) restartPlay(); }, 140); };   // memutar knob tidak memicu render tiap piksel
  function setKnob(k: KnobKey, v: number): void {
    const nv = Math.max(0, Math.min(1, v)); if (!S || nv === kv[k]) return;
    kv[k] = nv; paintKnob(k); dirty = true; ver++; lazyRestart();
  }
  KNOB_KEYS.forEach(k => {
    const e = knobEl[k]; let sx = 0, sy = 0, sv = 0, dr = false;
    e.style.touchAction = 'none';
    e.addEventListener('pointerdown', ev => { if (!S) return; dr = true; e.classList.add('is-dragging'); sx = ev.clientX; sy = ev.clientY; sv = kv[k]; e.setPointerCapture(ev.pointerId); ev.preventDefault(); });
    e.addEventListener('pointermove', ev => { if (dr) setKnob(k, sv + ((sy - ev.clientY) + (ev.clientX - sx)) / 150); });   // atas / kanan = naik, sama seperti knob lain
    const end = (): void => { dr = false; e.classList.remove('is-dragging'); };
    e.addEventListener('pointerup', end); e.addEventListener('pointercancel', end);
    e.addEventListener('dblclick', () => setKnob(k, DEFAULT_CONTROLS[k]));
    e.addEventListener('keydown', ev => {
      const st = ev.shiftKey ? 0.1 : 0.02;
      if (ev.key === 'ArrowUp' || ev.key === 'ArrowRight') { setKnob(k, kv[k] + st); ev.preventDefault(); ev.stopPropagation(); }
      else if (ev.key === 'ArrowDown' || ev.key === 'ArrowLeft') { setKnob(k, kv[k] - st); ev.preventDefault(); ev.stopPropagation(); }
    });
  });

  function enable(on: boolean): void {
    playBtn.disabled = !on; win.classList.toggle('is-off', !on);
    KNOB_KEYS.forEach(k => { knobEl[k].closest('.mpcs__knob')!.classList.toggle('is-off', !on); });
  }

  // ---------- worker ----------
  function getWorker(): Worker {
    if (worker) return worker;
    worker = new Worker(new URL('./mpcs-worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === 'progress') { say('Menganalisis ' + Math.round(m.p * 100) + '%'); return; }
      const j = jobs.get(m.id); if (!j) return;
      jobs.delete(m.id);
      if (m.type === 'error') j.fail(new Error(m.msg)); else j.ok(m);
    };
    worker.onerror = () => { jobs.forEach(j => j.fail(new Error('Worker gagal'))); jobs.clear(); };
    return worker;
  }
  const job = (msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<any> =>   // eslint-disable-line @typescript-eslint/no-explicit-any
    new Promise((ok, fail) => { const id = ++jobId; jobs.set(id, { ok, fail }); getWorker().postMessage({ ...msg, id }, transfer); });

  // ---------- muat & analisis ----------
  async function load(f: File): Promise<void> {
    if (loading) return;
    if (!isAudio(f)) { say('File bukan audio'); setTimeout(() => { if (!loading) say('Upload audio'); }, 1800); return; }
    loading = true; upBtn.disabled = true; stopPlay(); playPos = 0; enable(false); say('Membaca audio');
    try {
      ac ??= new AudioContext();
      const buf = await ac.decodeAudioData(await f.arrayBuffer());
      const mono = toMono(Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c).slice()));
      say('Menganalisis 0%');
      const r = await job({ type: 'analyze', x: mono, sr: buf.sampleRate }, [mono.buffer]);
      const notes: Note[] = r.notes;
      snapTargets(notes); resetKnobs();   // target = semiton terdekat (hysteresis); Center 0% jadi audio belum berubah sampai knob diputar
      S = { name: f.name.replace(/\.[^.]+$/, ''), sr: buf.sampleRate, dur: buf.duration, notes, orig: buf, out: null };
      dirty = true; ver++; upBtn.title = f.name; enable(true); say('Ganti audio');
    } catch (err) {
      S = null; say('Gagal memuat audio'); upBtn.title = '';
      console.error(err);
    } finally { loading = false; upBtn.disabled = false; }
  }

  // ---------- render hasil (di Worker), lalu putar ----------
  async function ensureRendered(): Promise<AudioBuffer | null> {
    if (!S) return null;
    if (!dirty && S.out) return S.out;
    if (rendering) { await new Promise<void>(r => { const t = setInterval(() => { if (!rendering) { clearInterval(t); r(); } }, 40); }); return ensureRendered(); }
    rendering = true; const my = ver;
    try {
      const r = await job({ type: 'render', notes: S.notes, ctl: { ...kv } });
      const out = ac!.createBuffer(1, r.y.length, S.sr); out.copyToChannel(r.y, 0);
      S.out = out; if (my === ver) dirty = false;
    } finally { rendering = false; }
    return dirty ? ensureRendered() : S.out;
  }

  function stopPlay(): void {
    if (src) { src.onended = null; try { src.stop(); } catch { /* sudah berhenti */ } src.disconnect(); src = null; }
    if (playing) { playing = false; setPlayIcon(false); }
  }
  const pause = (): void => { if (playing && ac) playPos = Math.max(0, ac.currentTime - t0); stopPlay(); };   // posisi disimpan, jadi Play berikutnya lanjut dari situ
  async function startPlay(): Promise<void> {
    if (!S || !ac) return;
    await ac.resume();
    playBtn.disabled = true;
    let b: AudioBuffer | null = null;
    try { b = await ensureRendered(); } catch (err) { console.error(err); } finally { playBtn.disabled = !S; }
    if (!b || !S) return;
    stopPlay();
    if (playPos >= S.dur - .02) playPos = 0;
    src = ac.createBufferSource(); src.buffer = b; src.connect(ac.destination);
    src.onended = () => { if (playing) { playPos = 0; stopPlay(); } };
    src.start(0, playPos); t0 = ac.currentTime - playPos; playing = true; setPlayIcon(true);
  }
  function restartPlay(): void { if (playing && ac) { playPos = Math.max(0, ac.currentTime - t0); void startPlay(); } }
  const toggle = (): void => { if (playing) pause(); else void startPlay(); };

  // ---------- tombol ----------
  el.addEventListener('click', e => {
    const b = (e.target as Element).closest<HTMLButtonElement>('button'); if (!b || b.disabled) return;
    if (b.dataset.a === 'up') file.click(); else if (b.dataset.a === 'play') toggle();
  });
  file.addEventListener('change', () => { const f = file.files?.[0]; file.value = ''; if (f) void load(f); });
  el.addEventListener('dragover', e => e.preventDefault());
  el.addEventListener('drop', e => { e.preventDefault(); const f = e.dataTransfer?.files[0]; if (f) void load(f); });

  // ---------- efek 3D: faceplate miring mengikuti kursor (mouse saja, mati saat reduced-motion), kilau mengikuti arah cahaya ----------
  const untilt = (): void => { win.classList.remove('is-tilting'); win.style.setProperty('--rx', '0deg'); win.style.setProperty('--ry', '0deg'); win.style.setProperty('--mx', '50%'); win.style.setProperty('--my', '0%'); };
  el.addEventListener('pointermove', e => {
    if (reduce || e.pointerType !== 'mouse' || (e.target as Element).closest('.knob-input.is-dragging')) return;
    const r = win.getBoundingClientRect(), px = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), py = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
    win.classList.add('is-tilting');
    win.style.setProperty('--ry', ((px - .5) * 9).toFixed(2) + 'deg'); win.style.setProperty('--rx', ((.5 - py) * 7).toFixed(2) + 'deg');
    win.style.setProperty('--mx', (px * 100).toFixed(1) + '%'); win.style.setProperty('--my', (py * 100).toFixed(1) + '%');
  });
  el.addEventListener('pointerleave', untilt);

  // ---------- buka / tutup ----------
  const onKey = (e: KeyboardEvent): void => {
    e.stopPropagation();   // pintasan DAW (Space, tuts keyboard) tidak ikut jalan selagi MPCS terbuka
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === ' ' && !(e.target as Element).closest?.('button') && S) { e.preventDefault(); toggle(); }
  };
  el.addEventListener('keydown', onKey); el.addEventListener('keyup', e => e.stopPropagation());
  el.querySelector('.mpcs__close')!.addEventListener('click', () => close());
  el.querySelector('.mpcs__back')!.addEventListener('pointerdown', () => close());

  function close(): void {
    stopPlay(); untilt();
    const done = (): void => { el.hidden = true; };
    if (reduce) { done(); return; }
    el.querySelector('.mpcs__back')!.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: 'forwards' });
    win.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(10px) scale(.96)' }], { duration: 170, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' }).onfinish = () => { done(); el.getAnimations({ subtree: true }).forEach(a => a.cancel()); };
  }
  openFn = () => {
    if (!el.hidden) return;
    el.getAnimations({ subtree: true }).forEach(a => a.cancel());
    el.hidden = false;
    if (!reduce) win.animate([{ opacity: 0, transform: 'translateY(14px) scale(.94)' }, { opacity: 1, transform: 'none' }], { duration: 380, easing: 'cubic-bezier(.34,1.3,.64,1)' });
    win.focus({ preventScroll: true });
  };
}
