// Worker time-stretch: WSOLA dikerjakan di luar thread utama supaya UI dan audio DAW tidak tersendat.
import { timeStretchPitch } from './time-stretch';

interface Scope { postMessage(m: unknown, t?: Transferable[]): void; onmessage: ((e: MessageEvent) => void) | null }
const ctx = self as unknown as Scope;

ctx.onmessage = (e: MessageEvent) => {
  const m = e.data;
  try {
    const y = timeStretchPitch(m.chs as Float32Array[], m.sr as number, m.factor as number, (m.pitch as number) || 0, p => ctx.postMessage({ type: 'progress', id: m.id, p }));
    ctx.postMessage({ type: 'done', id: m.id, y }, y.map(c => c.buffer));
  } catch (err) {
    ctx.postMessage({ type: 'error', id: m.id, msg: String((err as Error).message || err) });
  }
};
