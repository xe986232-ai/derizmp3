// POST /api/session  { action: 'login' | 'redeem', email, password, token? }
//  - redeem: aktivasi pertama. Token (sekali pakai) dikunci ke akun baru. Satu token = satu akun.
//  - login : masuk lagi dengan email + password (lisensi harus aktif, perangkat dalam batas).
import { redeemToken } from './_redeem.js';
import { issue, json } from './_issue.js';
import { licenseOf, licenseOk, passwordLogin } from '../server/supabase.js';

export async function POST(req: Request): Promise<Response> {
  let b: { action?: string; email?: string; password?: string; token?: string };
  try { b = await req.json(); } catch { return json({ error: 'Permintaan tidak valid.' }, 400); }
  const email = String(b.email || '').trim().toLowerCase(), password = String(b.password || '');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || password.length < 8 || password.length > 128) return json({ error: 'Email atau password (minimal 8 karakter) tidak valid.' }, 400);

  try {
    if (b.action === 'redeem') return await redeemToken(req, email, password, String(b.token || ''));
    const uid = await passwordLogin(email, password);
    if (!uid) return json({ error: 'Email atau password salah.' }, 401);
    const lic = await licenseOf(uid);
    if (!licenseOk(lic)) return json({ error: 'Lisensi tidak aktif atau sudah berakhir.' }, 403);
    return await issue(req, uid, lic);
  } catch (e) {
    console.error(e);
    return json({ error: 'Terjadi kesalahan di server. Coba lagi sebentar.' }, 500);
  }
}
