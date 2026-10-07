// Koleksi palet warna "Palet Clip Live" (referensi visual: tools/palet-clip-live.html).
// Hanya data: belum dipakai di mana pun. Token Default (styles.css) dan token Flat (--flat-*, --flat-pl-* di flat-ui.css)
// terpisah dari file ini, jadi saat Flat diupdate cukup salin nilai hex dari sini ke token --flat-* yang dituju.
export interface PaletteColor { name: string; hex: string }
export interface Palette { id: string; name: string; note: string; colors: PaletteColor[] }

const c = (name: string, hex: string): PaletteColor => ({ name, hex });

export const PALETTES: Palette[] = [
  {
    id: 'klasik', name: 'Klasik', note: 'Jenuh dan terang, paling dekat dengan palet clip Live',
    colors: [
      c('Mawar', '#FF94A6'),
      c('Jingga', '#FFA529'),
      c('Ambar', '#CC9927'),
      c('Lemon', '#F7F47C'),
      c('Limau', '#BFFB00'),
      c('Hijau', '#1AFF2F'),
      c('Mint', '#25FFA8'),
      c('Aqua', '#5CFFE8'),
      c('Langit', '#8BC5FF'),
      c('Biru', '#5480E4'),
      c('Nila', '#92A7FF'),
      c('Ungu', '#D86CE4'),
      c('Merah Muda', '#E553A0'),
      c('Abu', '#D0D0D0')
    ]
  },
  {
    id: 'pastel', name: 'Pastel', note: 'Lembut, bagus untuk clip yang banyak dan tidak mau berisik',
    colors: [
      c('Mawar', '#F7C6CE'),
      c('Persik', '#F9D3A5'),
      c('Pasir', '#E8D9A0'),
      c('Krim', '#F4F2B5'),
      c('Pucuk', '#D9F0A3'),
      c('Daun', '#B6EFC0'),
      c('Mint', '#A9EFD9'),
      c('Es', '#B5EEF0'),
      c('Langit', '#C3DDF7'),
      c('Biru', '#B7C5F2'),
      c('Lavender', '#CFC2F2'),
      c('Lilac', '#E6C2F0'),
      c('Permen', '#F2BFDD'),
      c('Abu', '#DADADA')
    ]
  },
  {
    id: 'redam', name: 'Redam', note: 'Warna lebih dalam, nyaman untuk sesi panjang di layar gelap',
    colors: [
      c('Marun', '#B5485C'),
      c('Tembaga', '#C0742A'),
      c('Mustard', '#8E7424'),
      c('Zaitun', '#A9A63F'),
      c('Lumut', '#7E9A1F'),
      c('Rimba', '#2F9E44'),
      c('Giok', '#1F9E7A'),
      c('Teal', '#2C9AA0'),
      c('Baja', '#3A7CB8'),
      c('Kobalt', '#3B5BA8'),
      c('Indigo', '#6A5BB5'),
      c('Anggur', '#9A4DB0'),
      c('Fuchsia', '#B04585'),
      c('Arang', '#6B6E73')
    ]
  },
  {
    id: 'senja', name: 'Senja', note: 'Urutan hangat dari ungu tua ke krem, cocok untuk intensitas bertahap',
    colors: [
      c('Malam', '#2B1B3D'),
      c('Plum', '#5A2A52'),
      c('Anggur', '#8C3A5E'),
      c('Bata', '#BC4A5C'),
      c('Koral', '#E0635A'),
      c('Jingga', '#F28A55'),
      c('Emas', '#F8B25A'),
      c('Kuning', '#FBD575'),
      c('Gading', '#FDEBA6'),
      c('Krim', '#FFF6D8')
    ]
  },
  {
    id: 'laut', name: 'Laut Malam', note: 'Urutan dingin dari biru gelap ke hijau laut dan biru terang',
    colors: [
      c('Dasar', '#0B1F33'),
      c('Palung', '#0F3550'),
      c('Dalam', '#135A6E'),
      c('Teluk', '#1A7F86'),
      c('Karang', '#2FA39A'),
      c('Laguna', '#5CC4A8'),
      c('Buih', '#8FDDB8'),
      c('Angin', '#7FB8E8'),
      c('Ombak', '#5B8DE0'),
      c('Pasang', '#4A5FC8')
    ]
  },
  {
    id: 'tanah', name: 'Tanah', note: 'Cokelat, hijau daun dan biru abu, terasa organik',
    colors: [
      c('Kayu', '#8C5A3C'),
      c('Tanah', '#B9794A'),
      c('Gerabah', '#D9A066'),
      c('Jerami', '#E8C98E'),
      c('Sabana', '#C9C58A'),
      c('Sirih', '#9DAA72'),
      c('Lumut', '#6F8F6B'),
      c('Hutan', '#4F7A73'),
      c('Kabut', '#3F5F6E'),
      c('Senja', '#5A5470'),
      c('Kesumba', '#7A4F64'),
      c('Bata', '#9A4A4A')
    ]
  },
  {
    id: 'studio', name: 'Studio Netral', note: 'Skala abu bernuansa hangat dengan tiga aksen untuk tombol dan meter',
    colors: [
      c('Hitam', '#1C1D1F'),
      c('Panel', '#2A2B2E'),
      c('Garis', '#3A3C40'),
      c('Grip', '#55585D'),
      c('Teks', '#8A8D92'),
      c('Terang', '#C2C4C7'),
      c('Kertas', '#E4E5E3'),
      c('Oranye', '#FF9F1A'),
      c('Cyan', '#00C2FF'),
      c('Rec', '#FF3D71')
    ]
  }
];

export const paletteById = (id: string): Palette | undefined => PALETTES.find(p => p.id === id);

// Daftar hex satu palet (urutan sama dengan tampilan referensi)
export const paletteHex = (id: string): string[] => (paletteById(id)?.colors ?? []).map(x => x.hex);

// Variabel CSS satu palet, mis. --klasik-1: #FF94A6; (sama dengan tombol "Salin CSS" di halaman referensi)
export const paletteCss = (id: string): string => {
  const p = paletteById(id);
  return p ? ':root {\n' + p.colors.map((x, i) => '  --' + p.id + '-' + (i + 1) + ': ' + x.hex + '; /* ' + x.name + ' */').join('\n') + '\n}' : '';
};
