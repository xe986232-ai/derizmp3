// GET /api/me : dipanggil aplikasi saat dibuka dan berkala. 200 = lisensi masih sah (cookie diperpanjang), 401 = dicabut / habis / perangkat dihapus.
import { COOKIE, DEVICE_COOKIE, SESSION_SEC, clearCookie, getCookie, setCookie, signSession, verifySession } from '../server/session';
import { licenseOf, licenseOk, rest } from '../server/supabase';
import { json } from './_issue';

export async function GET(req: Request): Promise<Response> {
  const s = await verifySession(getCookie(req, COOKIE), process.env.SESSION_SECRET);
  if (!s) return json({ ok: false }, 401, [clearCookie(COOKIE)]);
  try {
    const lic = await licenseOf(s.uid);
    if (!licenseOk(lic)) return json({ ok: false, reason: 'license' }, 401, [clearCookie(COOKIE)]);
    const dev = await rest<unknown[]>(`devices?token_hash=eq.${lic.token_hash}&device_id=eq.${s.did}&select=device_id`);
    if (!dev.length) return json({ ok: false, reason: 'device' }, 401, [clearCookie(COOKIE), clearCookie(DEVICE_COOKIE)]);
    const exp = Math.floor(Date.now() / 1000) + SESSION_SEC;
    return json({ ok: true }, 200, [setCookie(COOKIE, await signSession({ uid: s.uid, did: s.did, exp }, process.env.SESSION_SECRET!), SESSION_SEC)]);
  } catch (e) {
    console.error(e);
    return json({ ok: true, unverified: true }, 200);   // database sedang bermasalah: jangan usir pembeli yang sah; sesi lama tetap berlaku sampai habis
  }
}
