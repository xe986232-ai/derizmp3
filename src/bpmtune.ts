// BPMTUNE: satu plugin, dua fungsi.
//   Tab BPM   : upload / drop audio -> tempo dicari di Worker (bpmtune-dsp.ts). Grid ketukan di atas envelope onset, tombol ÷2 / ×2, TAP tempo,
//               PLAY (audio + klik di tiap garis grid supaya bisa dicek dengan kuping), seret di grid = geser fase ketukan, SET = kirim tempo ke BPM project.
//   Tab TUNER : mic -> nama nada, jarum cent, Hz, dan A4 acuan 415-466 (YIN).
// Kartunya ada di halaman Plugin pada panel efek (fx-rack.ts); tidak ada di daftar tombol "+": dimunculkan lewat tekan-tahan "+" di tab Plugin.
// Gaya: saudara CUTE (faceplate miring 3D, layar kaca, LED, tombol cembung) dengan bahan "enamel amber".

import { ACCEPT as AUDIO_ACCEPT, isAudio } from './audio-upload-card';
import { bringFront, dragWindow } from './win-drag';
import { detectTempo, hzToNote, tapBpm, toMono, yin, type TempoResult } from './bpmtune-dsp';

const svg = (inner: string, size = 18): string =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
const ICON = {
  up: svg('<path d="M12 16V5M7 10l5-5 5 5M5 19h14"/>', 22),
  play: svg('<path d="M8 5l12 7-12 7z" fill="currentColor" stroke="none"/>', 20),
  pause: svg('<rect x="6" y="5" width="4.5" height="14" rx="1.2" fill="currentColor" stroke="none"/><rect x="13.5" y="5" width="4.5" height="14" rx="1.2" fill="currentColor" stroke="none"/>', 20),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>', 12),
  mic: svg('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>', 18)
};

/** Jembatan ke main.ts: BPM project (dipasang sekali dari main.ts). */
export interface BpmtuneBridge { getBpm(): number; setBpm(v: number): void }
let bridge: BpmtuneBridge | null = null;
export const setBpmtuneBridge = (b: BpmtuneBridge): void => { bridge = b; };

let root: HTMLElement | null = null, openFn: (() => void) | null = null;
export function openBpmtune(): void {
  if (!root) build();
  openFn?.();
}

const fmtT = (t: number): string => { const m = Math.floor(t / 60), s = t - m * 60; return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1); };
const BPM_MIN = 30, BPM_MAX = 300, A4_MIN = 415, A4_MAX = 466;

function build(): void {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const el = document.createElement('div');
  el.className = 'bt'; el.hidden = true;
  el.innerHTML =
    '<div class="bt__win is-off" role="dialog" aria-label="BPMTUNE" tabindex="-1">' +
      `<header class="bt__head"><i class="bt__led" aria-hidden="true"></i><span class="bt__title">BPMTUNE</span><div class="bt__lcd"><span class="bt__stat" role="status" aria-live="polite"></span></div>` +
        `<button type="button" class="bt__close" aria-label="Tutup BPMTUNE">${ICON.close}</button></header>` +
      '<div class="bt__tabs" role="tablist"><button type="button" role="tab" class="bt__tab is-on" data-t="bpm" aria-selected="true">BPM</button><button type="button" role="tab" class="bt__tab" data-t="tuner" aria-selected="false">TUNER</button></div>' +
      // ----- tab BPM -----
      '<section class="bt__pane" data-p="bpm">' +
        '<div class="bt__stage"><canvas class="bt__cv" role="img" aria-label="Envelope onset dan grid ketukan. Seret untuk menggeser grid"></canvas>' +
          `<button type="button" class="bt__drop">${ICON.up}<span>Drop audio di sini</span><small>atau ketuk untuk memilih file</small></button><div class="bt__busy" hidden><i></i></div></div>` +
        '<input type="range" class="bt__scrub" min="0" max="1000" value="0" aria-label="Geser tampilan" hidden>' +
        '<div class="bt__row">' +
          '<div class="bt__big"><output class="bt__bpm" aria-live="polite">---</output><small>BPM</small></div>' +
          '<button type="button" class="bt__btn" data-a="half" title="Bagi dua" disabled>÷2</button><button type="button" class="bt__btn" data-a="dbl" title="Kali dua" disabled>×2</button>' +
          '<button type="button" class="bt__btn bt__btn--tap" data-a="tap" title="Ketuk mengikuti irama">TAP</button>' +
          `<button type="button" class="bt__btn bt__btn--play" data-a="play" aria-label="Putar" title="Putar dengan klik di grid" disabled>${ICON.play}</button>` +
          '<button type="button" class="bt__btn bt__btn--set" data-a="set" title="Jadikan BPM project" disabled>SET</button>' +
          '<button type="button" class="bt__btn bt__btn--sm" data-a="swap" title="Ganti audio" hidden>GANTI</button>' +
        '</div>' +
      '</section>' +
      // ----- tab TUNER -----
      '<section class="bt__pane" data-p="tuner" hidden>' +
        '<div class="bt__tun">' +
          '<canvas class="bt__meter" role="img" aria-label="Jarum cent"></canvas>' +
          '<div class="bt__nrow"><div class="bt__note"><b class="bt__nn">--</b><sup class="bt__no"></sup></div><div class="bt__hz"><output class="bt__hzv">--- Hz</output><small class="bt__ct">&nbsp;</small></div></div>' +
        '</div>' +
        '<div class="bt__row bt__row--tun">' +
          `<button type="button" class="bt__btn bt__btn--mic" data-a="mic" aria-pressed="false" title="Nyalakan / matikan mikrofon">${ICON.mic}<span>MIC</span></button>` +
          '<div class="bt__a4"><span>A4</span><button type="button" class="bt__step" data-a="a4-" aria-label="Turunkan A4">−</button><output class="bt__a4v">440</output><button type="button" class="bt__step" data-a="a4+" aria-label="Naikkan A4">+</button><small>Hz</small></div>' +
        '</div>' +
      '</section>' +
      '<div class="bt__glass" aria-hidden="true"></div>' +
      `<input type="file" class="bt__file" accept="${AUDIO_ACCEPT}" hidden>` +
    '</div>';
  document.body.appendChild(el);
  dragWindow({ root: el, move: el.querySelector<HTMLElement>('.bt__win')!, handle: '.bt__head' });
  root = el;

  const q = <T extends HTMLElement>(s: string): T => el.querySelector<T>(s)!;
  const win = q('.bt__win'), stat = q('.bt__stat'), led = q('.bt__led');
  const stage = q('.bt__stage'), cv = q<HTMLCanvasElement>('.bt__cv'), drop = q<HTMLButtonElement>('.bt__drop'), busy = q('.bt__busy');
  const scrub = q<HTMLInputElement>('.bt__scrub'), bpmOut = q('.bt__bpm'), file = q<HTMLInputElement>('.bt__file');
  const btn = (a: string): HTMLButtonElement => q<HTMLButtonElement>(`[data-a="${a}"]`);
  const bHalf = btn('half'), bDbl = btn('dbl'), bTap = btn('tap'), bPlay = btn('play'), bSet = btn('set'), bSwap = btn('swap');
  const meter = q<HTMLCanvasElement>('.bt__meter'), nn = q('.bt__nn'), no = q('.bt__no'), hzv = q('.bt__hzv'), ct = q('.bt__ct'), a4v = q('.bt__a4v'), bMic = btn('mic');
  const g = cv.getContext('2d')!, mg = meter.getContext('2d')!;

  type Tab = 'bpm' | 'tuner';
  let tab: Tab = 'bpm', statT = 0;
  const flash = (msg: string): void => { stat.textContent = msg; clearTimeout(statT); statT = window.setTimeout(info, 2400); };
  let name = '', buf: AudioBuffer | null = null, R: TempoResult | null = null, bpm = 0, off = 0, dur = 0;
  let vs = 0, W = 0, H = 0, dpr = 1, loadTok = 0;
  const span = (): number => Math.min(dur, 12);
  const info = (): void => {
    stat.textContent = tab === 'tuner' ? (micOn ? 'Mic aktif' : 'Mic mati') : buf ? name + ' · ' + fmtT(dur) : 'Belum ada audio';
  };

  // ---------- tab ----------
  function setTab(t: Tab): void {
    if (t === tab) return;
    if (t === 'bpm') stopMic(); else stopPlay();
    tab = t;
    el.querySelectorAll<HTMLElement>('.bt__tab').forEach(b => { const on = b.dataset.t === t; b.classList.toggle('is-on', on); b.setAttribute('aria-selected', String(on)); });
    el.querySelectorAll<HTMLElement>('.bt__pane').forEach(p => { p.hidden = p.dataset.p !== t; });
    win.classList.toggle('is-tuner', t === 'tuner');
    layout(); info();
  }
  el.querySelectorAll<HTMLButtonElement>('.bt__tab').forEach(b => b.addEventListener('click', () => setTab(b.dataset.t as Tab)));

  // ---------- tata letak & gambar ----------
  function sizeCanvas(c: HTMLCanvasElement, ctx: CanvasRenderingContext2D, w: number, h: number): void {
    dpr = Math.min(2, devicePixelRatio || 1);
    c.width = Math.max(1, Math.round(w * dpr)); c.height = Math.max(1, Math.round(h * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function layout(): void {
    if (el.hidden) return;
    if (tab === 'bpm') { W = stage.clientWidth; H = stage.clientHeight; if (W && H) { sizeCanvas(cv, g, W, H); draw(); } }
    else { const w = meter.clientWidth, h = meter.clientHeight; if (w && h) { sizeCanvas(meter, mg, w, h); drawMeter(lastNote); } }
  }
  new ResizeObserver(layout).observe(win);

  const period = (): number => 60 / bpm;
  let playing = false;
  function curPos(): number { return playing && ac ? Math.min(dur, pos0 + (ac.currentTime - t0)) : pos0; }
  function draw(): void {
    g.clearRect(0, 0, W, H);
    if (!buf || !R || !W) return;
    const sp = span(), a = vs, b = vs + sp, fps = R.fps, env = R.env, dl = R.delay;
    const sorted = Float32Array.from(env).sort(), mx = Math.max(1e-6, sorted[Math.floor(sorted.length * 0.97)] * 1.4);   // skala: persentil 97 supaya satu puncak liar tidak meratakan sisanya
    g.fillStyle = 'rgba(255,196,92,.78)';
    for (let x = 0; x < W; x++) {
      const ta = a + (x / W) * sp, tb = a + ((x + 1) / W) * sp;
      const i0 = Math.max(0, Math.floor((ta - dl) * fps)), i1 = Math.min(env.length - 1, Math.max(i0, Math.floor((tb - dl) * fps)));
      let m = 0; for (let i = i0; i <= i1; i++) if (env[i] > m) m = env[i];
      const h = Math.min(1, m / mx) * (H - 14);
      if (h > 0.5) g.fillRect(x, H - 6 - h, 1, h);
    }
    // grid ketukan
    const per = period();
    const k0 = Math.ceil((a - off) / per);
    for (let k = k0, t = off + k0 * per; t <= b; k++, t = off + k * per) {
      const x = Math.round(((t - a) / sp) * W), bar = ((k % 4) + 4) % 4 === 0;
      g.fillStyle = bar ? 'rgba(255,236,190,.95)' : 'rgba(255,220,150,.5)';
      g.fillRect(x, 0, bar ? 2 : 1, H);
    }
    // playhead
    const p = playing ? curPos() : pos0;
    if (p >= a && p <= b) { const x = ((p - a) / sp) * W; g.fillStyle = '#fff'; g.fillRect(x - 1, 0, 2, H); }
    g.fillStyle = 'rgba(255,230,190,.6)'; g.font = '10px system-ui,sans-serif'; g.textBaseline = 'bottom';
    g.fillText(fmtT(a), 4, H - 1); g.textAlign = 'right'; g.fillText(fmtT(b), W - 4, H - 1); g.textAlign = 'left';
  }

  // ---------- tampilan BPM ----------
  function showBpm(): void {
    bpmOut.textContent = bpm ? bpm.toFixed(1) : '---';
    const has = !!buf && !!R;
    bHalf.disabled = bDbl.disabled = !has && !bpm; bPlay.disabled = !has; bSet.disabled = !bpm;
    draw();
  }
  function setBpmValue(v: number): void {
    bpm = Math.max(BPM_MIN, Math.min(BPM_MAX, v));
    showBpm();
  }
  function syncScrub(): void {
    const need = dur > span() + 0.01;
    scrub.hidden = !need;
    if (need) scrub.value = String(Math.round((vs / (dur - span())) * 1000));
  }
  scrub.addEventListener('input', () => { vs = (Number(scrub.value) / 1000) * Math.max(0, dur - span()); draw(); });

  // ---------- worker ----------
  let worker: Worker | null = null, jobId = 0;
  const jobs = new Map<number, (r: TempoResult | null) => void>();
  function analyse(pcm: Float32Array, sr: number): Promise<TempoResult | null> {
    return new Promise(done => {
      const id = ++jobId;
      jobs.set(id, done);
      try {
        if (!worker) {
          worker = new Worker(new URL('./bpmtune-worker.ts', import.meta.url), { type: 'module' });
          worker.onmessage = (e: MessageEvent<{ id: number; res: TempoResult | null }>) => { const j = jobs.get(e.data.id); if (j) { jobs.delete(e.data.id); j(e.data.res); } };
          worker.onerror = () => { const all = [...jobs.values()]; jobs.clear(); worker = null; all.forEach(j => j(null)); };
        }
        worker.postMessage({ id, pcm, sr }, [pcm.buffer]);
      } catch {   // Worker tidak tersedia: hitung di thread utama
        jobs.delete(id);
        setTimeout(() => done(detectTempo(pcm, sr)), 20);
      }
    });
  }

  // ---------- muat audio ----------
  async function load(f: File): Promise<void> {
    if (!isAudio(f)) { drop.classList.remove('is-shake'); void drop.offsetWidth; drop.classList.add('is-shake'); flash('Bukan file audio'); return; }
    const tok = ++loadTok;
    stopPlay(); pos0 = 0;
    busy.hidden = false; stat.textContent = 'Memuat…'; drop.hidden = true;
    try {
      ac ??= new AudioContext();
      const b = await ac.decodeAudioData(await f.arrayBuffer());
      if (tok !== loadTok) return;
      buf = b; dur = b.duration; name = f.name.replace(/\.[^.]+$/, ''); R = null; bpm = 0; off = 0; vs = 0;
      stat.textContent = 'Menganalisis tempo…';
      const chs: Float32Array[] = []; for (let c = 0; c < b.numberOfChannels; c++) chs.push(b.getChannelData(c));
      const mono = chs.length === 1 ? chs[0].slice() : toMono(chs);
      const r = await analyse(mono, b.sampleRate);
      if (tok !== loadTok) return;
      busy.hidden = true;
      if (!r) { R = null; bpm = 0; flash('Tempo tidak terdeteksi (audio terlalu pendek / datar). Pakai TAP'); }
      else { R = r; bpm = r.bpm; off = r.offset % (60 / r.bpm); flash(`Terdeteksi ${r.bpm.toFixed(1)} BPM`); }
      bSwap.hidden = false; syncScrub(); showBpm(); layout();
      win.classList.remove('is-off');
    } catch {
      if (tok !== loadTok) return;
      busy.hidden = true; buf = null; R = null; bpm = 0; dur = 0; drop.hidden = false; bSwap.hidden = true;
      flash('Gagal membaca audio'); showBpm();
    }
  }
  file.addEventListener('change', () => { const f = file.files?.[0]; file.value = ''; if (f) void load(f); });
  drop.addEventListener('click', () => file.click());
  bSwap.addEventListener('click', () => file.click());
  el.addEventListener('dragover', e => { e.preventDefault(); win.classList.add('is-drop'); });
  el.addEventListener('dragleave', e => { if (!el.contains(e.relatedTarget as Node | null)) win.classList.remove('is-drop'); });
  el.addEventListener('drop', e => { e.preventDefault(); win.classList.remove('is-drop'); const f = e.dataTransfer?.files[0]; if (f) { if (tab !== 'bpm') setTab('bpm'); void load(f); } });

  // ---------- geser grid ----------
  let gdrag: number | null = null;
  const timeAt = (x: number): number => vs + Math.max(0, Math.min(1, x / W)) * span();
  const placeGrid = (e: PointerEvent): void => {
    const r = cv.getBoundingClientRect(), t = timeAt(e.clientX - r.left), per = period();
    off = ((t % per) + per) % per; draw();
  };
  cv.addEventListener('pointerdown', e => {
    if (!buf || !bpm || e.button > 0) return;
    gdrag = e.pointerId; cv.setPointerCapture(e.pointerId); placeGrid(e);
  });
  cv.addEventListener('pointermove', e => { if (gdrag === e.pointerId) placeGrid(e); });
  const gend = (e: PointerEvent): void => { if (gdrag === e.pointerId) gdrag = null; };
  cv.addEventListener('pointerup', gend); cv.addEventListener('pointercancel', gend);

  // ---------- putar + klik grid ----------
  let ac: AudioContext | null = null, src: AudioBufferSourceNode | null = null, pos0 = 0, t0 = 0, raf = 0, sched = 0, nextK = 0;
  function tick(at: number, accent: boolean): void {
    if (!ac) return;
    const o = ac.createOscillator(), gn = ac.createGain();
    o.frequency.value = accent ? 1760 : 1175; o.type = 'sine';
    gn.gain.setValueAtTime(0.0001, at); gn.gain.exponentialRampToValueAtTime(0.35, at + 0.002); gn.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
    o.connect(gn).connect(ac.destination); o.start(at); o.stop(at + 0.06);
  }
  function scheduler(): void {
    if (!ac || !playing || !bpm) return;
    const now = pos0 + (ac.currentTime - t0), per = period(), horizon = now + 0.25;
    if (nextK * per + off < now - 0.01) nextK = Math.max(0, Math.ceil((now - off) / per));
    while (off + nextK * per < horizon) {
      const tt = off + nextK * per;
      if (tt >= now - 0.005 && tt < dur) tick(t0 + (tt - pos0), nextK % 4 === 0);
      nextK++;
    }
  }
  async function startPlay(): Promise<void> {
    if (!buf || playing) return;
    ac ??= new AudioContext();
    if (ac.state === 'suspended') await ac.resume();
    if (pos0 >= dur - 0.05) pos0 = 0;
    src = ac.createBufferSource(); src.buffer = buf; src.connect(ac.destination);
    src.onended = () => { if (src === s0) { /* selesai alami */ if (playing && curPos() >= dur - 0.06) { stopPlay(); pos0 = 0; draw(); } } };
    const s0 = src;
    t0 = ac.currentTime + 0.03; src.start(t0, pos0);
    playing = true; nextK = Math.max(0, Math.ceil((pos0 - off) / period()));
    bPlay.innerHTML = ICON.pause; bPlay.setAttribute('aria-label', 'Jeda'); bPlay.classList.add('is-on'); led.classList.add('is-live');
    clearInterval(sched); sched = window.setInterval(scheduler, 40); scheduler();
    const step = (): void => {
      if (!playing) return;
      const p = curPos();
      if (p < vs || p > vs + span()) { vs = Math.max(0, Math.min(dur - span(), p - span() * 0.1)); syncScrub(); }
      draw(); raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }
  function stopPlay(keep = true): void {
    if (playing) { pos0 = curPos(); }
    playing = false; clearInterval(sched); cancelAnimationFrame(raf);
    try { src?.stop(); } catch { /* sudah berhenti */ }
    src?.disconnect(); src = null;
    bPlay.innerHTML = ICON.play; bPlay.setAttribute('aria-label', 'Putar'); bPlay.classList.remove('is-on'); led.classList.remove('is-live');
    if (!keep) pos0 = 0;
    draw();
  }

  // ---------- tombol BPM ----------
  let taps: number[] = [];
  function tap(): void {
    const now = performance.now();
    if (taps.length && now - taps[taps.length - 1] > 2000) taps = [];
    taps.push(now); if (taps.length > 8) taps.shift();
    const v = tapBpm(taps);
    if (v) { setBpmValue(v); flash('TAP · ' + taps.length + ' ketukan'); } else flash('Ketuk lagi…');
    bTap.classList.add('is-hit'); setTimeout(() => bTap.classList.remove('is-hit'), 90);
  }
  function setProject(): void {
    if (!bpm) return;
    if (!bridge) { flash('Tidak terhubung ke project'); return; }
    bridge.setBpm(bpm);
    flash('BPM project = ' + bridge.getBpm());
  }
  el.addEventListener('click', e => {
    const b = (e.target as Element).closest<HTMLButtonElement>('[data-a]');
    if (!b || b.disabled) return;
    switch (b.dataset.a) {
      case 'half': setBpmValue(bpm / 2); break;
      case 'dbl': setBpmValue(bpm * 2); break;
      case 'tap': tap(); break;
      case 'play': if (playing) stopPlay(); else void startPlay(); break;
      case 'set': setProject(); break;
      case 'mic': if (micOn) stopMic(); else void startMic(); break;
      case 'a4-': setA4(a4 - 1); break;
      case 'a4+': setA4(a4 + 1); break;
    }
  });

  // ======================================================================
  //  TUNER
  // ======================================================================
  let a4 = 440, micOn = false, mac: AudioContext | null = null, stream: MediaStream | null = null, an: AnalyserNode | null = null, mtimer = 0;
  let lastNote: { cents: number; locked: boolean } | null = null;
  const hist: number[] = [];
  let lastHit = 0;
  const tbuf = new Float32Array(4096);
  function setA4(v: number): void { a4 = Math.max(A4_MIN, Math.min(A4_MAX, Math.round(v))); a4v.textContent = String(a4); hist.length = 0; }

  function drawMeter(n: { cents: number; locked: boolean } | null): void {
    const w = meter.clientWidth, h = meter.clientHeight; if (!w || !h) return;
    mg.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h - 6, r = Math.min(w / 2 - 14, h - 22);
    mg.lineCap = 'round';
    for (let c = -50; c <= 50; c += 10) {   // skala: -50..+50 cent, sudut -60..+60 derajat
      const ang = (-90 + (c / 50) * 60) * Math.PI / 180, major = c % 50 === 0 || c === 0, r1 = r - (major ? 12 : 7);
      mg.strokeStyle = c === 0 ? 'rgba(255,236,190,.95)' : 'rgba(255,200,110,.55)'; mg.lineWidth = c === 0 ? 2.5 : 1.5;
      mg.beginPath(); mg.moveTo(cx + Math.cos(ang) * r1, cy + Math.sin(ang) * r1); mg.lineTo(cx + Math.cos(ang) * r, cy + Math.sin(ang) * r); mg.stroke();
    }
    mg.fillStyle = 'rgba(255,230,190,.7)'; mg.font = '10px system-ui,sans-serif'; mg.textAlign = 'center';
    mg.fillText('♭', cx + Math.cos((-90 - 60) * Math.PI / 180) * (r + 8), cy + Math.sin((-90 - 60) * Math.PI / 180) * (r + 8) + 3);
    mg.fillText('♯', cx + Math.cos((-90 + 60) * Math.PI / 180) * (r + 8), cy + Math.sin((-90 + 60) * Math.PI / 180) * (r + 8) + 3);
    const c = n ? Math.max(-55, Math.min(55, n.cents)) : 0, ang = (-90 + (c / 50) * 60) * Math.PI / 180;
    mg.strokeStyle = !n ? 'rgba(160,140,110,.5)' : n.locked ? '#fff' : '#ffc45c'; mg.lineWidth = 3;
    mg.shadowColor = n && n.locked ? 'rgba(255,214,120,.95)' : 'transparent'; mg.shadowBlur = n && n.locked ? 12 : 0;
    mg.beginPath(); mg.moveTo(cx, cy); mg.lineTo(cx + Math.cos(ang) * (r - 4), cy + Math.sin(ang) * (r - 4)); mg.stroke();
    mg.shadowBlur = 0; mg.fillStyle = '#ffc45c'; mg.beginPath(); mg.arc(cx, cy, 5, 0, Math.PI * 2); mg.fill();
  }
  function showNote(hz: number | null): void {
    const now = performance.now();
    if (hz) {
      lastHit = now;
      hist.push(hz); if (hist.length > 5) hist.shift();
      const s = [...hist].sort((x, y) => x - y), m = s[s.length >> 1], n = hzToNote(m, a4), lock = Math.abs(n.cents) < 5;
      nn.textContent = n.name; no.textContent = String(n.octave); hzv.textContent = m.toFixed(1) + ' Hz';
      ct.textContent = (n.cents >= 0 ? '+' : '−') + Math.abs(n.cents).toFixed(0) + ' cent · ' + n.target.toFixed(1) + ' Hz';
      win.classList.toggle('is-lock', lock); win.classList.remove('is-quiet');
      lastNote = { cents: n.cents, locked: lock };
      drawMeter(lastNote);
    } else if (now - lastHit > 600) {   // nada hilang: tahan sebentar lalu redupkan
      hist.length = 0; win.classList.remove('is-lock'); win.classList.add('is-quiet');
      lastNote = null; drawMeter(null);
    }
  }
  function tunerStep(): void {
    if (!an || !mac) return;
    an.getFloatTimeDomainData(tbuf);
    const r = yin(tbuf, mac.sampleRate, 50, 1500);
    showNote(r && r.prob > 0.82 ? r.hz : null);
  }
  async function startMic(): Promise<void> {
    if (micOn) return;
    try {
      if (!navigator.mediaDevices?.getUserMedia) { flash('Mic tidak didukung di browser ini'); return; }
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      mac = new AudioContext();
      if (mac.state === 'suspended') await mac.resume();
      an = mac.createAnalyser(); an.fftSize = 4096; an.smoothingTimeConstant = 0;
      mac.createMediaStreamSource(stream).connect(an);   // tidak disambung ke speaker: tidak ada umpan balik
      micOn = true; hist.length = 0;
      bMic.classList.add('is-on'); bMic.setAttribute('aria-pressed', 'true'); win.classList.remove('is-off'); led.classList.add('is-live'); win.classList.add('is-quiet');
      mtimer = window.setInterval(tunerStep, 45); info();
    } catch (err) {
      stopMic();
      flash((err as DOMException)?.name === 'NotAllowedError' ? 'Izin mic ditolak' : 'Mic tidak bisa dibuka');
    }
  }
  function stopMic(): void {
    clearInterval(mtimer); mtimer = 0;
    stream?.getTracks().forEach(t => t.stop()); stream = null;
    void mac?.close().catch(() => undefined); mac = null; an = null;
    if (micOn) { micOn = false; bMic.classList.remove('is-on'); bMic.setAttribute('aria-pressed', 'false'); led.classList.remove('is-live'); win.classList.remove('is-lock', 'is-quiet'); lastNote = null; if (tab === 'tuner') { nn.textContent = '--'; no.textContent = ''; hzv.textContent = '--- Hz'; ct.innerHTML = '&nbsp;'; drawMeter(null); info(); } }
  }

  // ---------- buka / tutup ----------
  el.addEventListener('keydown', e => {
    e.stopPropagation();   // pintasan DAW (Space, tuts keyboard) tidak ikut jalan selagi BPMTUNE terbuka
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === ' ' && tab === 'bpm' && buf && !(e.target as Element).closest?.('button, input')) { e.preventDefault(); if (playing) stopPlay(); else void startPlay(); }
  });
  el.addEventListener('keyup', e => e.stopPropagation());
  el.querySelector('.bt__close')!.addEventListener('click', () => close());
  win.addEventListener('pointerdown', () => bringFront(el));
  meter.addEventListener('wheel', e => { e.preventDefault(); setA4(a4 + (e.deltaY < 0 ? 1 : -1)); }, { passive: false });

  function close(): void {
    stopPlay(); stopMic();
    const done = (): void => { el.hidden = true; };
    if (reduce) { done(); return; }
    win.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(10px) scale(.96)' }], { duration: 170, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' }).onfinish = () => { done(); el.getAnimations({ subtree: true }).forEach(a => a.cancel()); };
  }
  openFn = () => {
    if (!el.hidden) return;
    el.getAnimations({ subtree: true }).forEach(a => a.cancel());
    el.hidden = false; drop.hidden = !!buf;
    layout(); info(); showBpm();
    if (!reduce) win.animate([{ opacity: 0, transform: 'translateY(14px) scale(.94)' }, { opacity: 1, transform: 'none' }], { duration: 380, easing: 'cubic-bezier(.34,1.3,.64,1)' });
    win.focus({ preventScroll: true });
  };
}
