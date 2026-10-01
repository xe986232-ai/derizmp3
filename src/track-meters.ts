// Meter level stereo di card track (channel mixer): dua batang kiri & kanan, bergerak mengikuti level audio track.
// Level dibaca tiap frame dari audio-engine, diubah ke dB (-54..0), attack cepat dan turun perlahan seperti meter DAW.

import { trackLevels } from './audio-engine';

const FLOOR_DB = -54;                 // di bawah ini dianggap kosong
const FALL_PER_SEC = 1.3;             // kecepatan turun (skala 0..1 per detik)
const toNorm = (lin: number): number => lin <= 1e-5 ? 0 : Math.max(0, Math.min(1, 1 - 20 * Math.log10(lin) / FLOOR_DB));

export function initTrackMeters(): void {
  const shown = new Map<string, [number, number]>();   // nilai yang sedang tampil per track
  let last = performance.now();

  const paint = (bar: HTMLElement | undefined, v: number) => {
    const b = bar?.firstElementChild as HTMLElement | null;
    if (b) b.style.clipPath = `inset(${((1 - v) * 100).toFixed(1)}% 0 0 0)`;
  };

  const frame = (now: number) => {
    requestAnimationFrame(frame);
    if (document.hidden) { last = now; return; }
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    document.querySelectorAll<HTMLElement>('.trackheader-container').forEach(c => {
      const id = c.dataset.track!, bars = c.querySelectorAll<HTMLElement>('.trackmeter__bar');
      if (bars.length < 2) return;
      const [pl, pr] = trackLevels(id), prev = shown.get(id) ?? [0, 0];
      const cur: [number, number] = [
        Math.max(toNorm(pl), prev[0] - FALL_PER_SEC * dt),
        Math.max(toNorm(pr), prev[1] - FALL_PER_SEC * dt)
      ];
      if (cur[0] < 0.002) cur[0] = 0;
      if (cur[1] < 0.002) cur[1] = 0;
      if (cur[0] === prev[0] && cur[1] === prev[1] && shown.has(id)) return;   // tidak berubah: lewati penulisan DOM
      shown.set(id, cur);
      paint(bars[0], cur[0]); paint(bars[1], cur[1]);
    });
  };
  requestAnimationFrame(frame);
}
