/**
 * The Docs screen, kept as data so a new entry is one object rather than a
 * template edit. Answers are the ones people actually ask, not a manual.
 */

export interface DocSection {
  title: string;
  /** Rendered as paragraphs and bullet lists; `code` marks an inline span. */
  body: Array<
    | { kind: 'p'; text: string }
    | { kind: 'ul'; items: string[] }
  >;
}

export const DOCS: DocSection[] = [
  {
    title: 'Provider mana yang harus saya pilih?',
    body: [
      {
        kind: 'p',
        text: 'Semua 17 provider memakai format wire yang sama dengan aplikasi Android, jadi key yang jalan di sana juga jalan di sini.'
      },
      {
        kind: 'ul',
        items: [
          '**Groq** — cepat dan gratis untuk model kecil. Default app.',
          '**Anthropic** / **OpenAI** — penalaran terkuat, biasanya paling mahal.',
          '**Google Gemini** — konteks panjang, format `GEMINI_CONTENT` sendiri.',
          '**DeepSeek** — murah, ada `deepseek-reasoner` untuk yang berpikir.',
          '**Ollama (lokal)** — tanpa API key, jalan di mesin Anda sendiri.'
        ]
      }
    ]
  },
  {
    title: 'Kenapa "Ambil daftar model" gagal?',
    body: [
      {
        kind: 'p',
        text: 'Katalog dibaca langsung dari `/models` provider memakai key yang sedang diketik. Kegagalan biasanya berarti key belum tersimpan atau provider tidak menyediakannya.'
      },
      {
        kind: 'ul',
        items: [
          'Provider tanpa `/models` (sebagian gateway lokal) → pakai daftar bawaan, ketik id model manual.',
          'Key habis kuota → bagian **API Key** akan menampilkan tautan billing.',
          'Base URL kustom belum diisi → isi dulu di bagian **Provider**.'
        ]
      }
    ]
  },
  {
    title: 'Kapan saya perlu ganti model?',
    body: [
      {
        kind: 'p',
        text: 'Saat provider menjawab "model does not exist or you do not have access to it". Itu bukan key rusak — hanya key itu tidak punya akses ke model tersebut.'
      },
      {
        kind: 'p',
        text: 'Kotak **API Key** di Pengaturan akan menampilkan model pengganti yang memang ada di akun Anda, lengkap dengan tombol untuk memakainya.'
      }
    ]
  },
  {
    title: 'Apa arti badge $ / $$ / $$$ di daftar model?',
    body: [
      {
        kind: 'p',
        text: 'Itulah harga per juta token, dibaca dari `/models` provider saat katalog diambil. provider yang tidak menerbitkan harga tetap mendapat perkiraan dari nama model (misalnya `8b` → murah, `70b` → mahal).'
      },
      {
        kind: 'p',
        text: 'Angka di sebelahnya adalah harga masuk / harga keluar, dan `ctx` adalah panjang konteks.'
      }
    ]
  },
  {
    title: 'Apakah API key saya aman?',
    body: [
      {
        kind: 'p',
        text: 'Key disimpan di `state.json` pada folder data aplikasi, dalam bentuk **terenkripsi** lewat keychain sistem — padanan AES-256-GCM + AndroidKeyStore di sisi Android.'
      },
      {
        kind: 'ul',
        items: [
          'Tidak pernah dikirim ke server kami; tidak ada server sama sekali.',
          'Semua panggilan jaringan terjadi di main process, renderer punya `connect-src \'none\'`.',
          'Kalau keychain tidak tersedia, bagian **API Key** mengatakannya secara terbuka.'
        ]
      }
    ]
  },
  {
    title: 'Bagaimana cara backup?',
    body: [
      {
        kind: 'p',
        text: 'Bagian **Backup** di Pengaturan menulis satu berkas `.selfdev` berisi pengaturan, sesi, dan proyek. Restore menimpanya kembali, jadi lakukan export dulu sebelum mengganti mesin.'
      }
    ]
  },
  {
    title: 'Mengapa tools lokal tidak dipakai?',
    body: [
      {
        kind: 'ul',
        items: [
          'Tools dimatikan — nyalakan **Tools lokal** di Pengaturan.',
          'Mode workspace yang dipilih memang bukan mode yang memakai tools (Hanya Kode, Umum, dan Riset yang memakainya).',
          'Workspace belum dipilih — klik **Pilih workspace** di header.'
        ]
      }
    ]
  },
  {
    title: 'Bisakah membuat gambar?',
    body: [
      {
        kind: 'p',
        text: 'Bisa. Layar **Gambar** di navigasi atas memakai endpoint image OpenAI (`/images/generations`) dan endpoint Imagen / Gemini, lalu menyimpan hasilnya ke disk dari tombol Simpan.'
      }
    ]
  }
];