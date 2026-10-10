// Suara plugin Printer (semua disintesis dengan Web Audio, tanpa file audio):
//   - motor + roller saat mencetak (dengung rendah + derau bandpass)
//   - "zzt" dot-matrix tiap print head bergerak, nadanya mengikuti pitch yang sedang dicetak
//   - nada melody (triangle) untuk tombol PLAY
//   - "ting" saat selesai, "bruk" pendek saat paper jam
export interface Sfx {
  start(): void;                  // motor hidup
  zzt(midi: number, vel?: number): void;   // satu goresan head
  tone(midi: number, dur: number, vel?: number, when?: number): void;   // satu nada melody
  stop(): void;                   // motor mati
  ding(): void;
  jam(): void;
  muted: boolean;
}

export function createSfx(ac: AudioContext): Sfx {
  const out = ac.createGain(); out.gain.value = 0.5; out.connect(ac.destination);
  const noise = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);   // 1 detik derau putih, dipakai ulang
  { const d = noise.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
  let motor: { o: OscillatorNode; g: GainNode; n: AudioBufferSourceNode; ng: GainNode } | null = null;
  let lastZ = 0;
  const hz = (m: number): number => 440 * 2 ** ((m - 69) / 12);
  const s: Sfx = {
    muted: false,
    start() {
      if (s.muted || motor) return;
      const o = ac.createOscillator(), g = ac.createGain(), lp = ac.createBiquadFilter();
      o.type = 'sawtooth'; o.frequency.value = 52; lp.type = 'lowpass'; lp.frequency.value = 260; g.gain.value = 0;
      g.gain.linearRampToValueAtTime(0.09, ac.currentTime + 0.12);
      o.connect(lp); lp.connect(g); g.connect(out); o.start();
      const n = ac.createBufferSource(), bp = ac.createBiquadFilter(), ng = ac.createGain();   // desis roller kertas
      n.buffer = noise; n.loop = true; bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 0.7; ng.gain.value = 0;
      ng.gain.linearRampToValueAtTime(0.05, ac.currentTime + 0.12);
      n.connect(bp); bp.connect(ng); ng.connect(out); n.start();
      motor = { o, g, n, ng };
    },
    zzt(midi, vel = 0.8) {
      if (s.muted) return;
      const t = ac.currentTime; if (t - lastZ < 0.045) return; lastZ = t;   // maksimal ~22 goresan per detik: terdengar seperti dot-matrix, bukan desis
      const n = ac.createBufferSource(), bp = ac.createBiquadFilter(), g = ac.createGain();
      n.buffer = noise; n.playbackRate.value = 1 + Math.random() * 0.2;
      bp.type = 'bandpass'; bp.frequency.value = Math.min(6000, 1400 + midi * 28); bp.Q.value = 5;   // makin tinggi nada, makin tinggi "zzt"
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.28 * vel, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.032);
      n.connect(bp); bp.connect(g); g.connect(out); n.start(t, Math.random() * 0.5, 0.05);
    },
    tone(midi, dur, vel = 0.8, when = 0) {
      if (s.muted) return;
      const t = ac.currentTime + when, o = ac.createOscillator(), g = ac.createGain();
      o.type = 'triangle'; o.frequency.value = hz(midi);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.32 * vel, t + 0.012);
      g.gain.setTargetAtTime(0.0001, t + Math.max(0.02, dur - 0.04), 0.03);
      o.connect(g); g.connect(out); o.start(t); o.stop(t + dur + 0.2);
    },
    stop() {
      const m = motor; if (!m) return; motor = null;
      const t = ac.currentTime;
      m.g.gain.cancelScheduledValues(t); m.g.gain.setTargetAtTime(0, t, 0.05); m.ng.gain.cancelScheduledValues(t); m.ng.gain.setTargetAtTime(0, t, 0.05);
      setTimeout(() => { try { m.o.stop(); m.n.stop(); } catch { /* sudah berhenti */ } }, 400);
    },
    ding() {
      if (s.muted) return;
      const t = ac.currentTime;
      for (const [f, d] of [[1760, 0], [2349, 0.09]] as const) {
        const o = ac.createOscillator(), g = ac.createGain(); o.type = 'sine'; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t + d); g.gain.exponentialRampToValueAtTime(0.25, t + d + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.5);
        o.connect(g); g.connect(out); o.start(t + d); o.stop(t + d + 0.55);
      }
    },
    jam() {
      if (s.muted) return;
      const t = ac.currentTime;
      for (let i = 0; i < 3; i++) {
        const o = ac.createOscillator(), g = ac.createGain(); o.type = 'square'; o.frequency.value = 130 - i * 22;
        g.gain.setValueAtTime(0.0001, t + i * 0.11); g.gain.exponentialRampToValueAtTime(0.16, t + i * 0.11 + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.11 + 0.1);
        o.connect(g); g.connect(out); o.start(t + i * 0.11); o.stop(t + i * 0.11 + 0.12);
      }
    }
  };
  return s;
}
