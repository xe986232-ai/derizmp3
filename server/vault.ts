// Brankas token (dipakai /api/admin dan /api/shop): token asli disimpan terenkripsi AES-GCM, kunci turunan SESSION_SECRET.
// Format tersimpan = base64url(iv 12 byte || ciphertext+tag). token_hash dipakai sebagai data tambahan (AAD):
// ciphertext yang dipindah ke baris lain tidak akan bisa dibuka.
export const ALPHA = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';   // sama dengan tools/license.mjs: tanpa 0/O/1/I

const vaultKey = async (): Promise<CryptoKey> =>
  crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', new TextEncoder().encode('melvox-token-vault:' + process.env.SESSION_SECRET)), 'AES-GCM', false, ['encrypt', 'decrypt']);
const b64 = (u: Uint8Array): string => btoa(String.fromCharCode(...u)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

export async function seal(token: string, hash: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(hash) }, await vaultKey(), new TextEncoder().encode(token)));
  const o = new Uint8Array(12 + ct.length); o.set(iv); o.set(ct, 12);
  return b64(o);
}
export async function unseal(enc: string, hash: string): Promise<string | null> {
  try {
    const o = unb64(enc);
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: o.slice(0, 12), additionalData: new TextEncoder().encode(hash) }, await vaultKey(), o.slice(12)));
  } catch { return null; }   // kunci berubah (SESSION_SECRET diganti) atau data rusak
}

// Token plugin: PLG-XXXX-XXXX-XXXX-XXXX (80 bit acak; 32 huruf => x & 31 tanpa bias)
export const newPluginToken = (): string => {
  const c = [...crypto.getRandomValues(new Uint8Array(16))].map((x) => ALPHA[x & 31]);
  return 'PLG-' + [0, 1, 2, 3].map((i) => c.slice(i * 4, i * 4 + 4).join('')).join('-');
};
