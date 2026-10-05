import { createUser, deleteUser, hashToken, licenseOf, rest } from '../server/supabase.js';
import { issue, json } from './_issue.js';

// Aktivasi token: buat akun lalu KLAIM token secara atomik (PATCH hanya kena baris yang user_id-nya masih kosong),
// jadi dua orang yang memakai token yang sama bersamaan tidak mungkin sama-sama berhasil.
export async function redeemToken(req: Request, email: string, password: string, token: string): Promise<Response> {
  const BAD = json({ error: 'Token tidak valid atau sudah dipakai.' }, 400);   // satu pesan untuk semua kegagalan token (tidak membocorkan mana yang ada)
  if (token.replace(/[^A-Za-z0-9]/g, '').length < 12) return BAD;
  const th = await hashToken(token);
  const found = await rest<{ user_id: string | null; status: string; duration_days: number | null }[]>(`licenses?token_hash=eq.${th}&select=user_id,status,duration_days&limit=1`);
  if (!found[0] || found[0].user_id || found[0].status !== 'active') return BAD;

  const u = await createUser(email, password);
  if ('error' in u) return u.error === 'exists' ? json({ error: 'Email sudah terdaftar. Silakan masuk, atau pakai email lain.' }, 409) : json({ error: 'Gagal membuat akun.' }, 500);

  const d = found[0].duration_days;
  const claimed = await rest<{ token_hash: string }[]>(`licenses?token_hash=eq.${th}&user_id=is.null&status=eq.active`, {
    method: 'PATCH', returnRows: true,
    body: { user_id: u.id, email, claimed_at: new Date().toISOString(), expires_at: d ? new Date(Date.now() + d * 864e5).toISOString() : null },
  });
  if (!claimed.length) { await deleteUser(u.id); return BAD; }   // keduluan orang lain: batalkan akun yang barusan dibuat

  const lic = await licenseOf(u.id);
  return lic ? issue(req, u.id, lic) : json({ error: 'Gagal mengaktifkan lisensi.' }, 500);
}
