// Sampler DERIZ mode "Tape": sampler klasik. Tuts mengubah nada DAN kecepatan sekaligus (seperti kaset / sampler FL mode resample).
// Tidak ada time-stretch, jadi tidak ada artefak (robot / phasiness). Konsekuensi: nada tinggi = sample lebih pendek, nada rendah = lebih panjang.
// Knob Speed tetap berfungsi sebagai pengali tambahan di atas laju dari tuts. Antarmuka sama dengan mesin lain (lihat interface Sampler).

import type { Sampler } from './deriz-synth';

interface TapeVoice { src: AudioBufferSourceNode; gain: GainNode; semis: number; rel: boolean; }

const REL = 0.05;   // detik, peluruhan saat tuts dilepas
const ATK = 0.004;  // detik, fade-in anti-klik

export class DerizTape implements Sampler {
  private out: GainNode;
  private buf: AudioBuffer | null = null;
  private voices = new Map<number, TapeVoice>();
  private speed = 1; private pitch = 0; private vol = 0.9;
  private target: AudioNode | null = null;

  private constructor(readonly ctx: BaseAudioContext) { this.out = ctx.createGain(); }

  static async create(ctx: BaseAudioContext): Promise<DerizTape> { return new DerizTape(ctx); }

  routeTo(dest: AudioNode): void {
    if (this.target === dest) return;
    this.out.disconnect(); this.out.connect(dest); this.target = dest;
  }

  setBuffer(buf: AudioBuffer): void {
    if (this.buf === buf) return;
    this.buf = buf;
    this.stopAll();
  }

  private rate(semis: number, pitch: number, speed: number): number {
    return Math.max(0.01, Math.pow(2, (semis + pitch) / 12) * Math.max(0.01, speed));
  }

  noteOn(id: number, semis: number, start: number, speed: number, pitch: number, vol: number): void {
    const buf = this.buf; if (!buf) return;
    this.speed = speed; this.pitch = pitch; this.vol = vol;
    this.noteOff(id);   // id yang sama dimainkan lagi: ganti suara lama
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource(), gain = this.ctx.createGain();
    src.buffer = buf;
    src.playbackRate.value = this.rate(semis, pitch, speed);
    gain.gain.setValueAtTime(0, t); gain.gain.linearRampToValueAtTime(vol, t + ATK);
    src.connect(gain); gain.connect(this.out);
    const v: TapeVoice = { src, gain, semis, rel: false };
    src.onended = () => { src.disconnect(); gain.disconnect(); if (this.voices.get(id) === v) this.voices.delete(id); };
    src.start(t, Math.max(0, Math.min(buf.duration, start / buf.sampleRate)));
    this.voices.set(id, v);
  }

  noteOff(id: number): void {
    const v = this.voices.get(id); if (!v || v.rel) return;
    v.rel = true;
    const t = this.ctx.currentTime, g = v.gain.gain;
    g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); g.linearRampToValueAtTime(0, t + REL);
    try { v.src.stop(t + REL + 0.01); } catch { /* sudah berhenti */ }
  }

  params(speed: number, pitch: number, vol: number): void {
    this.speed = speed; this.pitch = pitch; this.vol = vol;
    const t = this.ctx.currentTime;
    for (const v of this.voices.values()) {
      if (v.rel) continue;
      v.src.playbackRate.setTargetAtTime(this.rate(v.semis, pitch, speed), t, 0.01);
      v.gain.gain.setTargetAtTime(vol, t, 0.02);
    }
  }

  private stopAll(): void {
    for (const v of this.voices.values()) { try { v.src.stop(); } catch { /* sudah berhenti */ } v.src.disconnect(); v.gain.disconnect(); }
    this.voices.clear();
  }

  dispose(): void { this.stopAll(); this.out.disconnect(); this.target = null; }
}
