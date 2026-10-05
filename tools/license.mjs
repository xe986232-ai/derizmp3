#!/usr/bin/env node
// Alat admin lisensi Melvox (jalankan di komputermu, JANGAN di-deploy). Butuh env: SUPABASE_URL, SUPABASE_SERVICE_KEY
//   npm run license -- create 5 --devices 2 --days 365 --note "Order #1201 Budi"    buat 5 token (cetak SEKALI, database hanya menyimpan hash)
//   npm run license -- list                                                       daftar lisensi
//   npm run license -- revoke  <token | email>                                    cabut (berlaku paling lambat saat app cek berikutnya)
//   npm run license -- restore <token | email>                                    aktifkan lagi
//   npm run license -- reset-devices <token | email>                              kosongkan slot perangkat (pembeli ganti HP / laptop)
import { createHash, randomInt } from 'node:crypto';

const URL_ = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
if (!URL_ || !KEY) { console.error('Isi dulu env SUPABASE_URL dan SUPABASE_SERVICE_KEY.'); process.exit(1); }

const hash = (t) => createHash('sha256').update(t.toUpperCase().replace(/[^A-Z0-9]/g, '')).digest('hex');   // harus sama dengan hashToken di server/supabase.ts
const ALPHA = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';   // tanpa 0/O/1/I supaya tidak salah baca
const newToken = () => 'MLVX-' + [0, 1, 2, 3].map(() => Array.from({ length: 4 }, () => ALPHA[randomInt(ALPHA.length)]).join('')).join('-');   // 16 karakter x 5 bit = 80 bit

async function rest(path, { method = 'GET', body } = {}) {
  const r = await fetch(URL_ + '/rest/v1/' + path, { method, headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!r.ok) throw new Error(r.status + ' ' + (await r.text()));
  const t = await r.text(); return t ? JSON.parse(t) : null;
}
const where = (who) => who.includes('@') ? 'email=eq.' + encodeURIComponent(who.toLowerCase()) : 'token_hash=eq.' + hash(who);
const flag = (name, def) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : def; };

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'create') {
  const n = Math.max(1, Math.min(500, parseInt(arg || '1', 10) || 1));
  const devices = parseInt(flag('devices', '2'), 10), days = flag('days') ? parseInt(flag('days'), 10) : null, note = flag('note', null);
  const tokens = Array.from({ length: n }, newToken);
  await rest('licenses', { method: 'POST', body: tokens.map((t) => ({ token_hash: hash(t), max_devices: devices, duration_days: days, note })) });
  console.log(`Dibuat ${n} token (maks ${devices} perangkat, ${days ? days + ' hari sejak aktivasi' : 'seumur hidup'}). Simpan sekarang, tidak bisa dilihat lagi:\n`);
  tokens.forEach((t) => console.log(t));
} else if (cmd === 'list') {
  const rows = await rest('licenses?select=token_hash,status,email,max_devices,expires_at,note,claimed_at,created_at&order=created_at.desc&limit=500');
  console.table(rows.map((r) => ({ id: r.token_hash.slice(0, 8), status: r.status, email: r.email || '(belum dipakai)', perangkat: r.max_devices, berakhir: r.expires_at ? r.expires_at.slice(0, 10) : 'seumur hidup', catatan: r.note || '' })));
} else if ((cmd === 'revoke' || cmd === 'restore') && arg) {
  const rows = await rest('licenses?' + where(arg), { method: 'PATCH', body: { status: cmd === 'revoke' ? 'revoked' : 'active' } });
  console.log(rows.length ? `${cmd}: ${rows.length} lisensi diubah.` : 'Tidak ditemukan.');
} else if (cmd === 'reset-devices' && arg) {
  const lic = await rest('licenses?select=token_hash&' + where(arg));
  if (!lic.length) { console.log('Tidak ditemukan.'); process.exit(0); }
  await rest('devices?token_hash=eq.' + lic[0].token_hash, { method: 'DELETE' });
  console.log('Slot perangkat dikosongkan.');
} else {
  console.log('Perintah: create <jumlah> [--devices 2] [--days 365] [--note ...] | list | revoke <token|email> | restore <token|email> | reset-devices <token|email>');
}
