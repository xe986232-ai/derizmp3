// Skala knob Speed DERIZ: tengah = 1×, kiri 0.25× (slow), kanan 4× (speed); kecepatan sample saja, nada tidak ikut berubah (diatur tuts + Pitch).
// Logaritmik: tiap SPEED_OCT oktaf di kiri / kanan tengah. Dulu rentangnya 0.5× - 2× (1 oktaf); project lama dikonversi saat dibuka (SPEED_VER, fx-rack.ts derizImport).
export const SPEED_OCT = 2, SPEED_VER = 2, SPEED_MIN = 2 ** -SPEED_OCT, SPEED_MAX = 2 ** SPEED_OCT;
export const derizSpeed = (v: number): number => 2 ** ((v - 0.5) * 2 * SPEED_OCT);
export const derizSpeedKnob = (sp: number): number => Math.max(0, Math.min(1, Math.log2(sp) / (2 * SPEED_OCT) + 0.5));
/** Posisi knob versi lama (0.5× - 2×) -> posisi knob skala sekarang dengan kecepatan yang sama. */
export const derizSpeedFromV1 = (v: number): number => derizSpeedKnob(2 ** ((v - 0.5) * 2));
