-- Jalankan sekali di Supabase: SQL Editor -> New query -> paste -> Run.
-- Akses hanya lewat kunci service (server). RLS aktif tanpa policy = anon/authenticated tidak bisa membaca apa pun.

create table if not exists public.licenses (
  token_hash    text primary key,                 -- sha256(token); token asli tidak disimpan
  status        text not null default 'active' check (status in ('active', 'revoked')),
  user_id       uuid unique references auth.users(id) on delete set null,   -- terisi saat token diaktifkan: 1 token = 1 akun
  email         text,
  max_devices   int  not null default 2,
  duration_days int,                              -- null = seumur hidup; angka = masa berlaku sejak diaktifkan
  expires_at    timestamptz,
  note          text,                             -- mis. nama pembeli / nomor order
  created_at    timestamptz not null default now(),
  claimed_at    timestamptz
);

create table if not exists public.devices (
  token_hash text not null references public.licenses(token_hash) on delete cascade,
  device_id  text not null,
  created_at timestamptz not null default now(),
  last_seen  timestamptz not null default now(),
  primary key (token_hash, device_id)
);

alter table public.licenses enable row level security;
alter table public.devices  enable row level security;

-- ===== Token terenkripsi untuk dashboard admin (ikon mata + salin). Migration "licenses_token_enc". =====
-- Berisi token asli yang dienkripsi AES-GCM oleh server (kunci turunan SESSION_SECRET), bukan teks polos.
-- null = token dibuat sebelum kolom ini ada (hanya hash yang tersimpan, tidak bisa dipulihkan).
alter table public.licenses add column if not exists token_enc text;

-- ===== Profil pembeli (nama + foto). Sudah dijalankan sebagai migration "profiles_and_avatars". =====
create table if not exists public.profiles (
  user_id           uuid primary key references auth.users(id) on delete cascade,
  display_name      text check (display_name is null or char_length(display_name) <= 40),
  avatar_updated_at timestamptz,            -- null = belum punya foto; dipakai juga sebagai versi cache
  updated_at        timestamptz not null default now()
);
alter table public.profiles enable row level security;

-- Bucket foto PRIVAT, maks 256 KB, hanya gambar. Tanpa policy storage = hanya kunci service (server) yang bisa akses;
-- foto disajikan lewat /api/avatar setelah sesi diperiksa. Satu file per pengguna: avatars/<user_id>.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', false, 262144, array['image/jpeg', 'image/webp', 'image/png'])
on conflict (id) do nothing;

-- ===== Token plugin (Manage Plugin, jalur manual). Sudah dijalankan sebagai migration "plugin_licenses". =====
-- 1 baris = 1 token untuk 1 plugin. Saat ditebus pembeli, user_id terisi = akun itu BERHAK memakai plugin tersebut.
-- source: 'token' (ditebus), 'gift' / 'order' disiapkan untuk pemberian manual atau pembayaran otomatis nanti.
create table if not exists public.plugin_licenses (
  token_hash text primary key,                 -- sha256(token); token asli tidak disimpan
  plugin     text not null check (plugin ~ '^[a-z0-9_-]{1,32}$'),
  status     text not null default 'active' check (status in ('active', 'revoked')),
  source     text not null default 'token' check (source in ('token', 'gift', 'order')),
  user_id    uuid references auth.users(id) on delete cascade,
  token_enc  text,                             -- token asli terenkripsi (sama seperti licenses.token_enc)
  note       text,
  created_at timestamptz not null default now(),
  claimed_at timestamptz
);
-- satu akun hanya boleh punya satu entitlement AKTIF per plugin (yang dicabut tidak menghalangi token baru)
create unique index if not exists plugin_licenses_user_plugin_uq
  on public.plugin_licenses (user_id, plugin) where user_id is not null and status = 'active';
create index if not exists plugin_licenses_user_idx on public.plugin_licenses (user_id);
alter table public.plugin_licenses enable row level security;

-- ===== Pesanan dari Manage Plugin (tombol Beli). Sudah dijalankan sebagai migration "plugin_licenses_buyer_lock". =====
-- Saat pembeli menekan Beli + konfirmasi, server membuat token otomatis (source = 'order') dan mengisi buyer_id = akun pemesan.
-- Token tidak dikirim ke pembeli; admin melihatnya di dashboard lalu menyerahkannya. Hanya buyer_id yang bisa menebus (user_id baru terisi saat ditebus).
alter table public.plugin_licenses add column if not exists buyer_id uuid references auth.users(id) on delete cascade;
-- satu pesanan menunggu per (akun, plugin): menekan Beli berulang tidak membuat token baru
create unique index if not exists plugin_licenses_pending_order_uq
  on public.plugin_licenses (buyer_id, plugin)
  where buyer_id is not null and user_id is null and status = 'active';
create index if not exists plugin_licenses_buyer_idx on public.plugin_licenses (buyer_id) where buyer_id is not null;
