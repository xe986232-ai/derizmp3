// Sampler DERIZ mode "Natural": pitch-shift + time-stretch memakai Signalsmith Stretch (MIT, WASM + AudioWorklet).
// Beda utama dengan mesin klasik (deriz-synth.ts): pitch digeser dengan KOREKSI FORMANT, jadi suara tidak jadi
// "chipmunk" / robot saat dimainkan di nada tinggi (resampling biasa ikut menggeser formant).
// Antarmuka sama persis dengan DerizSynth (lihat interface Sampler), jadi fx-rack tinggal memilih salah satu.
//
// Satu node Signalsmith = satu suara (satu playhead). Akor = beberapa node. Node dipakai ulang kalau bufer-nya sama,
// supaya data sample tidak disalin ulang tiap tuts ditekan.

import SignalsmithStretch from 'signalsmith-stretch';
import type { Sampler } from './deriz-synth';

interface StretchNode extends AudioWorkletNode {
  inputTime: number;
  start(when?: number): void;
  stop(when?: number): void;
  schedule(o: Record<string, unknown>): void;
  addBuffers(b: Float32Array[]): Promise<number>;
  dropBuffers(): void;
  setUpdateInterval(sec: number, cb?: (t: number) => void): void;
  configure(o: Record<string, unknown>): void;
}

interface Voice {
  node: StretchNode; gain: GainNode; ready: Promise<void>;
  id: number; active: boolean; rel: boolean; semis: number; seq: number; endTimer: number;
}

const MAX_VOICES = 8;
const REL = 0.05;   // detik, peluruhan saat tuts dilepas

export class DerizNatural implements Sampler {
  private out: GainNode;
  private buf: AudioBuffer | null = null;
  private voices: Voice[] = [];
  private seq = 0;
  private speed = 1; private pitch = 0; private vol = 0.9;
  private target: AudioNode | null = null;
  private dead = false;

  private constructor(readonly ctx: BaseAudioContext) { this.out = ctx.createGain(); }

  static async create(ctx: BaseAudioContext): Promise<DerizNatural> { return new DerizNatural(ctx); }

  routeTo(dest: AudioNode): void {
    if (this.target === dest) return;
    this.out.disconnect(); this.out.connect(dest); this.target = dest;
  }

  setBuffer(buf: AudioBuffer): void {
    if (this.buf === buf) return;
    this.buf = buf;
    for (const v of this.voices) this.kill(v);   // node lama berisi data sample lama
    this.voices = [];
  }

  private kill(v: Voice): void {
    window.clearTimeout(v.endTimer);
    try { v.node.stop(); } catch { /* sudah berhenti */ }
    v.gain.disconnect(); v.node.disconnect();
  }

  private make(buf: AudioBuffer): Voice {
    const chs = Math.min(2, buf.numberOfChannels), gain = this.ctx.createGain();
    gain.gain.value = 0; gain.connect(this.out);
    const v = { gain, id: -1, active: false, rel: false, semis: 0, seq: 0, endTimer: 0 } as Voice;
    v.ready = SignalsmithStretch(this.ctx, { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [chs] }).then(async n => {
      const node = n as StretchNode;
      v.node = node;
      if (this.dead || this.buf !== buf) { node.disconnect(); return; }
      node.connect(gain);
      const data: Float32Array[] = [];
      for (let c = 0; c < chs; c++) data.push(buf.getChannelData(c).slice());
      node.configure({ splitComputation: true });   // sebar beban hitung merata: akor (banyak node) tidak menyebabkan dropout / kresek
      await node.addBuffers(data);
      node.setUpdateInterval(0.05, () => { if (v.active && !v.rel && node.inputTime >= buf.duration - 0.03) this.release(v); });   // sample habis: lepas sendiri
    });
    return v;
  }

  noteOn(id: number, semis: number, start: number, speed: number, pitch: number, vol: number): void {
    const buf = this.buf; if (!buf || this.dead) return;
    this.speed = speed; this.pitch = pitch; this.vol = vol;
    // pakai suara yang sudah bebas (data sample sudah di dalamnya); kalau tidak ada: buat baru, atau curi yang paling lama
    let v = this.voices.find(x => !x.active && !x.rel);
    if (!v) {
      if (this.voices.length >= MAX_VOICES) {
        const old = this.voices.reduce((a, b) => (a.seq < b.seq ? a : b));
        this.voices.splice(this.voices.indexOf(old), 1); this.kill(old);
      }
      v = this.make(buf); this.voices.push(v);
    }
    const voice = v;
    voice.id = id; voice.semis = semis; voice.active = true; voice.rel = false; voice.seq = ++this.seq;
    window.clearTimeout(voice.endTimer);
    voice.ready.then(() => {
      if (!voice.node || !voice.active || voice.id !== id || voice.rel) return;   // sudah dilepas selagi disiapkan
      const t = this.ctx.currentTime, g = voice.gain.gain;
      g.cancelScheduledValues(t); g.setValueAtTime(0, t); g.linearRampToValueAtTime(this.vol, t + 0.004);
      voice.node.schedule({
        output: t, active: true, input: start / buf.sampleRate, rate: Math.max(0.01, speed), semitones: semis + pitch,
        formantCompensation: true, formantBaseHz: 0, loopStart: 0, loopEnd: 0
      });
    }).catch(err => console.error(err));
  }

  private release(v: Voice): void {
    if (v.rel) return;
    v.rel = true;
    const t = this.ctx.currentTime, g = v.gain.gain;
    g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); g.linearRampToValueAtTime(0, t + REL);
    v.endTimer = window.setTimeout(() => {
      try { v.node?.stop(); } catch { /* sudah berhenti */ }
      v.active = false; v.rel = false; v.id = -1;
    }, REL * 1000 + 60);
  }

  noteOff(id: number): void {
    for (const v of this.voices) if (v.active && v.id === id) this.release(v);
  }

  params(speed: number, pitch: number, vol: number): void {
    this.speed = speed; this.pitch = pitch; this.vol = vol;
    const t = this.ctx.currentTime;
    for (const v of this.voices) {
      if (!v.active || v.rel || !v.node) continue;
      v.node.schedule({ output: t, active: true, rate: Math.max(0.01, speed), semitones: v.semis + pitch });
      v.gain.gain.setTargetAtTime(vol, t, 0.02);
    }
  }

  dispose(): void {
    this.dead = true;
    for (const v of this.voices) this.kill(v);
    this.voices = []; this.out.disconnect(); this.target = null;
  }
}
