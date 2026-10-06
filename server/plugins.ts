// Daftar plugin berbayar (id sama dengan id di katalog Manage Plugin). Plugin di luar daftar ini gratis / bawaan.
export const PAID_PLUGINS: readonly string[] = [];   // MGCHORD sekarang gratis (bawaan), tidak lagi lewat token/database
export const isPaidPlugin = (p: string): boolean => (PAID_PLUGINS as readonly string[]).includes(p);
