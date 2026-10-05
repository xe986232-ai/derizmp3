// Sesi bertanda tangan (HMAC-SHA256) untuk versi full. Dipakai oleh middleware (Edge) dan fungsi /api (Node), jadi hanya Web Crypto.
// Isi cookie: { uid, did, exp }. Tanpa database, middleware cukup memeriksa tanda tangan + masa berlaku.
export const COOKIE = 'mx_s';          // sesi
export const DEVICE_COOKIE = 'mx_d';   // id perangkat (acak, dibuat server)
export const SESSION_SEC = 3 * 24 * 3600;   // sesi diperpanjang tiap /api/me sukses; kalau lisensi dicabut, paling lama habis dalam 3 hari

export type Session = { uid: string; did: string; exp: number };

const enc = new TextEncoder();
const b64 = (u: Uint8Array): string => btoa(String.fromCharCode(...u)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const key = (secret: string): Promise<CryptoKey> =>
  crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

export async function signSession(s: Session, secret: string): Promise<string> {
  const body = b64(enc.encode(JSON.stringify(s)));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await key(secret), enc.encode(body)));
  return body + '.' + b64(sig);
}

export async function verifySession(token: string | null, secret: string | undefined): Promise<Session | null> {
  if (!token || !secret) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await key(secret), unb64(sig), enc.encode(body));   // pembandingan waktu-konstan
    if (!ok) return null;
    const s = JSON.parse(new TextDecoder().decode(unb64(body))) as Session;
    return typeof s.uid === 'string' && typeof s.did === 'string' && s.exp > Date.now() / 1000 ? s : null;
  } catch { return null; }
}

export function getCookie(req: Request, name: string): string | null {
  const m = (req.headers.get('cookie') || '').split(/;\s*/).find((c) => c.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}

export const setCookie = (name: string, value: string, maxAge: number): string =>
  `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
export const clearCookie = (name: string): string => setCookie(name, '', 0);
