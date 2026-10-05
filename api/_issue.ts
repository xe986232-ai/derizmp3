// Dipakai bersama oleh /api/session: pasang slot perangkat lalu terbitkan cookie sesi.
import { DEVICE_COOKIE, COOKIE, SESSION_SEC, getCookie, setCookie, signSession } from '../server/session';
import { rest, type License } from '../server/supabase';

export const json = (data: unknown, status = 200, cookies: string[] = []): Response => {
  const h = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  cookies.forEach((c) => h.append('Set-Cookie', c));
  return new Response(JSON.stringify(data), { status, headers: h });
};

export async function issue(req: Request, uid: string, lic: License): Promise<Response> {
  const did = getCookie(req, DEVICE_COOKIE) || crypto.randomUUID();
  const rows = await rest<{ device_id: string }[]>(`devices?token_hash=eq.${lic.token_hash}&select=device_id`);
  if (rows.some((r) => r.device_id === did)) {
    await rest(`devices?token_hash=eq.${lic.token_hash}&device_id=eq.${did}`, { method: 'PATCH', body: { last_seen: new Date().toISOString() } });
  } else if (rows.length >= lic.max_devices) {
    return json({ error: `Batas ${lic.max_devices} perangkat untuk akun ini sudah tercapai. Hubungi penjual untuk mengganti perangkat.` }, 403);
  } else {
    await rest('devices', { method: 'POST', body: { token_hash: lic.token_hash, device_id: did } });
  }
  const sess = await signSession({ uid, did, exp: Math.floor(Date.now() / 1000) + SESSION_SEC }, process.env.SESSION_SECRET!);
  return json({ ok: true }, 200, [setCookie(COOKIE, sess, SESSION_SEC), setCookie(DEVICE_COOKIE, did, 365 * 24 * 3600)]);
}
