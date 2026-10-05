// POST /api/logout : hapus sesi di browser ini. Slot perangkat sengaja TIDAK dibebaskan (supaya login-logout bergantian tidak bisa dipakai untuk berbagi akun).
import { COOKIE, clearCookie } from '../server/session.js';
import { json } from './_issue.js';

export function POST(): Response { return json({ ok: true }, 200, [clearCookie(COOKIE)]); }
