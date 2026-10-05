// POST /api/logout : hapus sesi di browser ini. Slot perangkat sengaja TIDAK dibebaskan (supaya login-logout bergantian tidak bisa dipakai untuk berbagi akun).
import { COOKIE, clearCookie } from '../server/session';
import { json } from './_issue';

export function POST(): Response { return json({ ok: true }, 200, [clearCookie(COOKIE)]); }
