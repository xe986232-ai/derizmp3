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
