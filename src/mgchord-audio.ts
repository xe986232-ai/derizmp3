// MGCHORD: suara preview = piano + rantai mixing. Murni Web Audio (tanpa DOM), jadi bisa dirender offline untuk dites (tools/mgchord-audio-test.ts).
//   pianoTone: tiap nada = 2-3 senar sedikit sumbang (chorus alami) dengan spektrum piano (titik pukul palu 1/8 senar), ketukan palu (noise pendek),
//              filter yang menutup seiring waktu (awal cerah, lalu hangat), decay dua tahap (nada rendah ngambang lebih lama), damper saat nada dilepas, posisi stereo menurut tinggi nada.
//   createMaster: low-cut -> EQ (kurangi gumam 300 Hz, tambah presence + udara) -> compressor perekat -> limiter -> soft-clip pengaman (tidak pernah pecah),
//              ditambah reverb ruang kecil (paralel) supaya chord terdengar penuh tanpa tebal / bising.

const waves = new WeakMap<BaseAudioContext, Map<number, PeriodicWave>>();
const noises = new WeakMap<BaseAudioContext, AudioBuffer>();
const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v));

// Spektrum satu senar piano: partial n = |sin(n*pi/8)| (palu memukul di 1/8 senar, partial ke-8 / 16 melemah) / n^1.05, dibatasi sebelum aliasing
function waveFor(c: BaseAudioContext, midi: number): PeriodicWave {
  let m = waves.get(c); if (!m) { m = new Map(); waves.set(c, m); }
  let w = m.get(midi); if (w) return w;
  const f = 440 * 2 ** ((midi - 69) / 12), N = clamp(Math.floor(10000 / f), 6, 40);
  const re = new Float32Array(N + 1), im = new Float32Array(N + 1);
  for (let n = 1; n <= N; n++) im[n] = (0.15 + 0.85 * Math.abs(Math.sin(Math.PI * n / 8))) / n ** 1.05;
  w = c.createPeriodicWave(re, im); m.set(midi, w); return w;
}
function noiseFor(c: BaseAudioContext): AudioBuffer {
  let b = noises.get(c); if (b) return b;
  b = c.createBuffer(1, Math.floor(c.sampleRate * 0.25), c.sampleRate);
  const d = b.getChannelData(0); let s = 12345;
  for (let i = 0; i < d.length; i++) { s = (s * 1664525 + 1013904223) >>> 0; d[i] = s / 2147483648 - 1; }   // noise deterministik (tidak berubah tiap bunyi)
  noises.set(c, b); return b;
}

/** Bunyikan satu nada piano ke `dest`. midi = nomor nada, when = waktu mulai (detik AudioContext), dur = lama tuts ditahan (detik), vel = 0..1. */
export function pianoTone(c: BaseAudioContext, dest: AudioNode, midi: number, when: number, dur: number, vel: number): void {
  const f = 440 * 2 ** ((midi - 69) / 12), v = clamp(vel, 0.05, 1), end = when + Math.max(0.08, dur);
  const peak = 0.2 * (0.12 + 0.88 * v ** 1.5);
  const tau = Math.max(0.45, 3.2 * 2 ** (-(midi - 36) / 30));          // decay panjang: makin tinggi makin cepat habis
  const rel = 0.07 + 0.11 * clamp((72 - midi) / 48, 0, 1);              // damper: nada rendah dilepas lebih lambat
  const g = c.createGain(), lp = c.createBiquadFilter(), pan = c.createStereoPanner();
  pan.pan.value = clamp((midi - 60) / 40, -0.55, 0.55);
  lp.type = 'lowpass'; lp.Q.value = 0.5;
  lp.frequency.setValueAtTime(clamp(f * (6 + v * 18), 1800, 14000), when);                 // awal cerah (makin keras makin cerah) ...
  lp.frequency.setTargetAtTime(clamp(f * (3 + v * 3), 700, 6000), when + 0.01, 0.45);      // ... lalu menutup jadi hangat
  g.gain.setValueAtTime(0.0001, when); g.gain.linearRampToValueAtTime(peak, when + 0.004);
  g.gain.setTargetAtTime(peak * 0.38, when + 0.004, 0.2);                                  // tahap 1: jatuh cepat setelah ketukan
  if (end > when + 0.35) g.gain.setTargetAtTime(0.0001, when + 0.35, tau);                 // tahap 2: sustain yang pelan menghilang
  g.gain.setTargetAtTime(0.0001, end, rel);                                                // tuts dilepas
  const detunes = midi < 44 ? [-1.2, 1.2] : [-1.5, 0.2, 1.4], oscs: OscillatorNode[] = [], per = 1 / Math.sqrt(detunes.length);
  const pw = waveFor(c, midi), stop = end + rel * 7 + 0.05;
  detunes.forEach(dt => {
    const o = c.createOscillator(), og = c.createGain();
    o.setPeriodicWave(pw); o.frequency.value = f; o.detune.value = dt; og.gain.value = per;
    o.connect(og); og.connect(lp); o.start(when); o.stop(stop); oscs.push(o);
  });
  lp.connect(g); g.connect(pan); pan.connect(dest);
  // ketukan palu: noise pendek lewat bandpass, tidak ikut filter yang menutup
  const nz = c.createBufferSource(), bp = c.createBiquadFilter(), hg = c.createGain();
  nz.buffer = noiseFor(c); bp.type = 'bandpass'; bp.frequency.value = clamp(f * 3, 700, 5000); bp.Q.value = 0.8;
  const hp = 0.16 * v * v * peak / 0.2;
  hg.gain.setValueAtTime(0.0001, when); hg.gain.linearRampToValueAtTime(hp, when + 0.0015); hg.gain.setTargetAtTime(0.0001, when + 0.0015, 0.012);
  nz.connect(bp); bp.connect(hg); hg.connect(pan); nz.start(when, (midi % 7) * 0.02); nz.stop(when + 0.08);
  oscs[oscs.length - 1].onended = () => { g.disconnect(); lp.disconnect(); pan.disconnect(); hg.disconnect(); };
}

export interface Master { input: GainNode; tap: AudioNode }

/** Rantai mixing preview: sambungkan semua suara ke `input`; `tap` (setelah soft-clip) cocok untuk analyser waveform. */
export function createMaster(c: BaseAudioContext, dest: AudioNode = c.destination): Master {
  const input = c.createGain(); input.gain.value = 1.7;   // gain masuk: progression nyaman di sekitar -21 dBFS RMS, akor 7 nada velocity penuh tetap terkendali (diukur lewat tools/mgchord-audio-test.ts)
  const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 38; hp.Q.value = 0.7;                                // buang gemuruh di bawah piano
  const mud = c.createBiquadFilter(); mud.type = 'peaking'; mud.frequency.value = 300; mud.Q.value = 1; mud.gain.value = -2.5;       // kurangi gumam akor
  const pres = c.createBiquadFilter(); pres.type = 'peaking'; pres.frequency.value = 3200; pres.Q.value = 0.8; pres.gain.value = 1.8;  // presence: jelas di speaker kecil
  const air = c.createBiquadFilter(); air.type = 'highshelf'; air.frequency.value = 9000; air.gain.value = 2;                          // udara
  const comp = c.createDynamicsCompressor();                                                                                           // perekat: puncak nada keras dirapikan
  comp.threshold.value = -22; comp.knee.value = 20; comp.ratio.value = 3.5; comp.attack.value = 0.01; comp.release.value = 0.25;
  const lim = c.createDynamicsCompressor();                                                                                            // limiter
  lim.threshold.value = -4; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.001; lim.release.value = 0.06;
  const clip = c.createWaveShaper(), curve = new Float32Array(2049);                                                                   // soft-clip pengaman: lurus sampai 0.7, lalu melengkung, tidak pernah lewat ~0.98
  for (let i = 0; i < curve.length; i++) { const x = (i / 1024) - 1, a = Math.abs(x); curve[i] = Math.sign(x) * (a <= 0.7 ? a : 0.7 + 0.28 * Math.tanh((a - 0.7) / 0.28)); }
  clip.curve = curve; clip.oversample = '2x';
  input.connect(hp); hp.connect(mud); mud.connect(pres); pres.connect(air); air.connect(comp); comp.connect(lim); lim.connect(clip); clip.connect(dest);
  // reverb ruang kecil, paralel: impuls noise yang meluruh (stereo), bagian bawah dibuang supaya tidak menggumpal
  const len = Math.floor(c.sampleRate * 1.5), ir = c.createBuffer(2, len, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) { const d = ir.getChannelData(ch); let s = 777 + ch * 91; for (let i = 0; i < len; i++) { s = (s * 1664525 + 1013904223) >>> 0; d[i] = (s / 2147483648 - 1) * (1 - i / len) ** 3.2; } }
  const rhp = c.createBiquadFilter(); rhp.type = 'highpass'; rhp.frequency.value = 280;
  const rlp = c.createBiquadFilter(); rlp.type = 'lowpass'; rlp.frequency.value = 7000;
  const conv = c.createConvolver(); conv.buffer = ir; conv.normalize = true;
  const wet = c.createGain(); wet.gain.value = 0.2;
  comp.connect(rhp); rhp.connect(rlp); rlp.connect(conv); conv.connect(wet); wet.connect(lim);
  return { input, tap: clip };
}
