// BPMTUNE: analisis tempo di Worker supaya UI tidak ngelag. Terima { id, pcm (mono), sr }, balas { id, res | null }.
import { detectTempo } from './bpmtune-dsp';

self.onmessage = (e: MessageEvent<{ id: number; pcm: Float32Array; sr: number }>): void => {
  const { id, pcm, sr } = e.data;
  try {
    const res = detectTempo(pcm, sr);
    (self as unknown as Worker).postMessage({ id, res }, res ? [res.env.buffer] : []);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, res: null, error: String(err) });
  }
};
