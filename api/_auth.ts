// Pembantu untuk /api yang butuh pembeli sudah masuk (profil, foto).
import { COOKIE, getCookie, verifySession } from '../server/session.js';
import { licenseOf, licenseOk } from '../server/supabase.js';

// Sesi sah + lisensi masih aktif -> id akun. Selain itu null.
export async function userOf(req: Request): Promise<string | null> {
  const s = await verifySession(getCookie(req, COOKIE), process.env.SESSION_SECRET);
  if (!s) return null;
  return licenseOk(await licenseOf(s.uid)) ? s.uid : null;
}

// Lapis tambahan di atas SameSite=Lax: kalau browser mengirim Origin, harus sama dengan host kita.
export const sameOrigin = (req: Request): boolean => { const o = req.headers.get('origin'); return !o || new URL(o).host === new URL(req.url).host; };

// Nama tampilan: tanpa karakter kontrol, spasi dirapikan, maks 40 karakter. Kosong -> null.
export const cleanName = (v: unknown): string | null => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) || null;
