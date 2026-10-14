import type { Language } from './i18n';

/**
 * The Docs screen, kept as data so a new entry is one object rather than a
 * template edit. Answers are the ones people actually ask, not a manual.
 *
 * Both languages live side by side rather than in two files so a half-finished
 * translation is visible in one place instead of in a missing module.
 */

export type DocBlock = { kind: 'p'; text: string } | { kind: 'ul'; items: string[] };

export interface DocSection {
  id: string;
  title: Record<Language, string>;
  /** Rendered as paragraphs and bullet lists; inline markdown is honoured. */
  body: Record<Language, DocBlock[]>;
}

export const DOCS: DocSection[] = [
  {
    id: 'provider',
    title: {
      id: 'Provider mana yang harus saya pilih?',
      en: 'Which provider should I pick?'
    },
    body: {
      id: [
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
      ],
      en: [
        {
          kind: 'p',
          text: 'All 17 providers speak the same wire formats as the Android app, so a key that works there works here.'
        },
        {
          kind: 'ul',
          items: [
            '**Groq** — fast and free for small models. The app default.',
            '**Anthropic** / **OpenAI** — strongest reasoning, usually the priciest.',
            '**Google Gemini** — very long context, its own `GEMINI_CONTENT` format.',
            '**DeepSeek** — cheap, with `deepseek-reasoner` for the thinking kind.',
            '**Ollama (local)** — no API key, runs on your own machine.'
          ]
        }
      ]
    }
  },
  {
    id: 'fetch-models',
    title: {
      id: 'Kenapa "Ambil daftar model" gagal?',
      en: 'Why does “Fetch the model list” fail?'
    },
    body: {
      id: [
        {
          kind: 'p',
          text: 'Katalog dibaca langsung dari `/models` provider memakai key yang sedang diketik. Kegagalan biasanya berarti key belum tersimpan atau provider tidak menyediakannya.'
        },
        {
          kind: 'ul',
          items: [
            'Provider tanpa `/models` (sebagian gateway lokal) → pakai daftar bawaan, ketik id model manual.',
            'Key habis kuota → bagian **API Key** menampilkan tautan billing.',
            'Base URL kustom belum diisi → isi dulu di bagian **Provider**.'
          ]
        }
      ],
      en: [
        {
          kind: 'p',
          text: 'The catalogue is read straight from the provider’s `/models` using the key you have typed. A failure usually means the key is not saved yet, or the provider does not offer that endpoint.'
        },
        {
          kind: 'ul',
          items: [
            'A provider with no `/models` (some local gateways) falls back to the built-in list; type the model id by hand.',
            'An out-of-credit key gets a billing link in the **API key** section.',
            'An empty custom base URL — fill it in under **Provider** first.'
          ]
        }
      ]
    }
  },
  {
    id: 'which-model',
    title: {
      id: 'Kapan saya perlu ganti model?',
      en: 'When do I need a different model?'
    },
    body: {
      id: [
        {
          kind: 'p',
          text: 'Saat provider menjawab "model does not exist or you do not have access to it". Itu bukan key rusak — hanya key itu tidak punya akses ke model tersebut.'
        },
        {
          kind: 'p',
          text: 'Bagian **API Key** akan menampilkan model pengganti yang memang ada di akun Anda, lengkap dengan tombol untuk memakainya.'
        }
      ],
      en: [
        {
          kind: 'p',
          text: 'When a provider answers “model does not exist or you do not have access to it”. That is not a broken key — this key simply cannot reach that model.'
        },
        {
          kind: 'p',
          text: 'The **API key** section will name a replacement model the account really can use, with a button to switch to it.'
        }
      ]
    }
  },
  {
    id: 'badges',
    title: {
      id: 'Apa arti badge $ / $$ / $$$ di daftar model?',
      en: 'What do the $ / $$ / $$$ badges mean?'
    },
    body: {
      id: [
        {
          kind: 'p',
          text: 'Itulah harga per juta token, dibaca dari `/models` provider saat katalog diambil. Provider yang tidak menerbitkan harga tetap mendapat perkiraan dari nama model (misalnya `8b` → murah, `70b` → mahal).'
        },
        { kind: 'p', text: 'Angka di sebelahnya adalah harga masuk / harga keluar, dan `ctx` adalah panjang konteks.' }
      ],
      en: [
        {
          kind: 'p',
          text: 'That is the price per million tokens, read from the provider’s `/models` when the catalogue was fetched. Providers that publish no price still get an estimate from the model name (an `8b` reads cheap, a `70b` expensive).'
        },
        { kind: 'p', text: 'The numbers beside them are input / output price, and `ctx` is the context length.' }
      ]
    }
  },
  {
    id: 'safety',
    title: {
      id: 'Apakah API key saya aman?',
      en: 'Is my API key safe?'
    },
    body: {
      id: [
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
      ],
      en: [
        {
          kind: 'p',
          text: 'The key lives in `state.json` in the app data folder, **encrypted** through the system keychain — the counterpart to AES-256-GCM plus AndroidKeyStore on Android.'
        },
        {
          kind: 'ul',
          items: [
            'Never sent to our servers; there are no servers at all.',
            'All network calls happen in the main process; the renderer runs with `connect-src \'none\'`.',
            'With no keychain available, the **API key** section says so outright.'
          ]
        }
      ]
    }
  },
  {
    id: 'backup',
    title: {
      id: 'Bagaimana cara backup?',
      en: 'How do I back things up?'
    },
    body: {
      id: [
        {
          kind: 'p',
          text: 'Bagian **Backup** di Pengaturan menulis satu berkas `.selfdev` berisi pengaturan, sesi, dan proyek. Restore menimpanya kembali, jadi lakukan export dulu sebelum mengganti mesin.'
        }
      ],
      en: [
        {
          kind: 'p',
          text: 'The **Backup** section in Settings writes a single `.selfdev` file holding your settings, sessions and projects. Restoring overwrites them, so export before changing machines.'
        }
      ]
    }
  },
  {
    id: 'tools',
    title: {
      id: 'Kenapa tools lokal tidak dipakai?',
      en: 'Why are the local tools not being used?'
    },
    body: {
      id: [
        {
          kind: 'ul',
          items: [
            'Tools dimatikan — nyalakan **Tools lokal** di Pengaturan.',
            'Mode workspace yang dipilih bukan mode yang memakai tools (hanya Kode, Umum, dan Riset yang memakainya).',
            'Workspace belum dipilih — klik **Pilih workspace** di header.'
          ]
        }
      ],
      en: [
        {
          kind: 'ul',
          items: [
            'Tools are off — turn **Local tools** on in Settings.',
            'The active workspace mode is not one that uses tools (only Code, General and Research do).',
            'No workspace chosen — click **Choose workspace** in the header.'
          ]
        }
      ]
    }
  },
  {
    id: 'images',
    title: {
      id: 'Bisakah membuat gambar?',
      en: 'Can it make images?'
    },
    body: {
      id: [
        {
          kind: 'p',
          text: 'Bisa. Layar **Buat gambar** di navigasi atas memakai endpoint image OpenAI (`/images/generations`) dan endpoint Imagen / Gemini, lalu menyimpan hasilnya ke disk dari tombol Simpan.'
        }
      ],
      en: [
        {
          kind: 'p',
          text: 'Yes. The **Make images** screen uses OpenAI’s image endpoint (`/images/generations`) and the Imagen / Gemini endpoint, then saves the result to disk from the Save button.'
        }
      ]
    }
  }
];
export interface LocalizedDocSection {
  id: string;
  title: string;
  body: DocBlock[];
}

/** English falls back to Indonesian for a section that has not been translated. */
export function docsFor(language: Language): LocalizedDocSection[] {
  return DOCS.map((d) => ({
    ...d,
    title: d.title[language] || d.title.id,
    body: d.body[language]?.length ? d.body[language] : d.body.id
  }));
}
