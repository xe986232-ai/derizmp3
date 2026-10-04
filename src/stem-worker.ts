// Worker Stem Splitter: pemisahan vokal / instrumen dikerjakan di luar thread utama supaya UI dan audio DAW tidak tersendat.
//   masuk : { type: 'split', id, chs: Float32Array[], sr, opts?: SplitOptions }
//   keluar: { type: 'progress', p } berkali-kali, lalu { type: 'done', id, vocal, instrumental } atau { type: 'error', id, msg }
import { separate, type SplitOptions } from './stem-split';

interface Scope { postMessage(m: unknown, t?: Transferable[]): void; onmessage: ((e: MessageEvent) => void) | null }
const ctx = self as unknown as Scope;

ctx.onmessage = (e: MessageEvent) => {
  const m = e.data;
  try {
    if (m.type === 'split') {
      const r = separate(m.chs as Float32Array[], m.sr as number, m.opts as SplitOptions | undefined, p => ctx.postMessage({ type: 'progress', id: m.id, p }));
      ctx.postMessage({ type: 'done', id: m.id, vocal: r.vocal, instrumental: r.instrumental }, [...r.vocal, ...r.instrumental].map(c => c.buffer));
    }
  } catch (err) {
    ctx.postMessage({ type: 'error', id: m.id, msg: String((err as Error).message || err) });
  }
};
