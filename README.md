# SelfDev — AI Developer Console

Asisten coding desktop opencode-style, dibungkus sebagai aplikasi **Electron native**.
Semua credential milik Anda sendiri (**BYOK**), tidak ada server, tidak ada telemetry.

`Linux x64` · `Electron 44` · `MIT`

---

## Fitur

- **Chat streaming** dengan tampilan task-card: status berpikir → memakai tool → selesai
- **9 tool lokal** yang benar-benar menyentuh filesystem:
  `read_file`, `write_file`, `edit_file`, `list_dir`, `grep`, `glob`, `run_code`, `web_search`, `web_fetch`
- **Mode Dev** (tools aktif) dan **Mode Plan** (tanya-jawab, tools dimatikan)
- **BYOK untuk 17 provider**, base URL dan format wire identik dengan app Android:
  OpenAI, Anthropic, Google Gemini, Groq, DeepSeek, OpenRouter, Together AI, Fireworks AI,
  xAI Grok, Mistral AI, Cerebras, NVIDIA NIM, SambaNova, Hyperbolic, Novita AI,
  Ollama lokal, dan gateway OpenAI-compatible/custom
- **Tiga format wire** (`OPENAI_CHAT`, `ANTHROPIC_MESSAGES`, `GEMINI_CONTENT`) lengkap dengan
  header auth, bentuk tool call, dan pelaporan usage masing-masing
- **Deteksi katalog model**: `/models` provider dibaca langsung, sehingga harga dan panjang
  konteks tidak pernah dari tabel yang bisa basi; badge `$`/`$$`/`$$$` di picker
- **Deteksi provider otomatis** dari awalan API key (`sk-ant-` → Anthropic, `gsk_` → Groq, …)
- **Diagnosis error** per jenis: auth, saldo habis (dengan tautan billing), rate limit,
  model tidak tersedia (dengan saran model pengganti), timeout, jaringan
- **Self-healing**: batas `max_tokens` diturunkan dari pesan provider, streaming ditolak →
  retry non-streaming, parameter usang → retry dengan nama baru, `tools` ditolak → retry polos
- **API key terenkripsi** lewat keychain sistem (Keychain / libsecret / DPAPI)
- **Lima layar**: Console, Proyek, Kirim Berkas, Buat Gambar, Dokumentasi — semua di
  shell yang sama, hanya satu yang aktif
- **7 workspace mode** dari Android (Umum, Kode, Foto & video, Pengingat, Menulis,
  Riset, Musik), masing-masing dengan instruksi system prompt yang menentukan
  tool apa yang boleh dipakai
- **Lampirkan berkas**: teks/kode/JSON/CSV dibaca apa adanya, PDF dan DOCX
  diekstrak lapis teksnya, gambar dan PDF hasil pindai dikirim apa adanya
- **Buat gambar**: endpoint image OpenAI plus Imagen/Gemini, hasil disimpan ke disk
- **Backup** terenkripsi AES-256-GCM ke satu berkas `.selfdev`
- **Suara**: bacakan jawaban lewat mesin suara sistem operasi, dan dikte
- **Dua bahasa**: Indonesia dan Inggris, termasuk seluruh konten Dokumentasi
- **Sesi persisten** dengan riwayat penuh, ganti model, hapus sesi
- **Workspace picker** native; semua path tool relatif ke folder tersebut dan dikunci di dalamnya
- Tema light/dark, ikon SVG inline (tanpa koneksi font eksternal), copy jawaban
- Batas 12 iterasi tool per giliran, tombol stop, indentation Markdown tanpa dependency

## Arsitektur

```
src/main/       main process: window lifecycle, agent loop, LLM, tools, store
src/preload/    contextBridge sempit (satu objek window.selfdev)
src/renderer/   UI murni: tidak ada Node, tidak ada fetch jaringan
```

Keamanan renderer: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`,
CSP dengan `connect-src 'none'`. Semua panggilan jaringan terjadi di main process.

API key disimpan di `state.json` pada folder data Electron (`~/.config/SelfDev/state.json`
di Linux) dalam bentuk **terenkripsi**, di-seal lewat Electron `safeStorage` yang memakai
keychain OS — padanan AES-256-GCM + AndroidKeyStore di sisi Android. Kalau keychain tidak
tersedia (mis. Linux tanpa keyring), key disimpan apa adanya dan bagian API key di Pengaturan
menyatakannya secara terbuka, bukan berpura-pura aman.

`run_code` menjalankan JavaScript di child process Node terpisah dengan timeout 10 detik
(isolasi proses, **bukan** sandbox permission OS).

## Menjalankan

```bash
npm install
npm start          # build + jalankan
npm run dev        # build + jalankan dengan sourcemap
```

## Verifikasi

```bash
npm run typecheck            # tsc --noEmit, strict
npm test                     # 480 test logika & integrasi
npm run smoke                # boot headless: bridge, DOM, layout, screenshot
npm run smoke:e2e            # agent penuh lewat provider tiruan (format OpenAI)
npm run smoke:e2e:anthropic  # agent penuh lewat provider tiruan (format Anthropic)
```

`smoke`/`smoke:e2e` menjalankan Electron di bawah `xvfb-run` dengan `userData` sementara,
sehingga state asli Anda tidak tersentuh. Screenshot ditulis ke `/tmp/opencode/selfdev-smoke.png`.

Test e2e menjalankan satu putaran tool sungguhan: model tiruan meminta `write_file`, aplikasi
menjalankannya, dan isi file diverifikasi di disk. Format wire OpenAI maupun Anthropic diuji
terpisah, termasuk urutan `tool` / `tool_result` yang dikirim ke model.

Harness smoke juga memverifikasi dirinya sendiri: ia melempar `console.error` canary dan memastikan
listener menangkapnya, sehingga hasil "tanpa console error" tidak bisa kosong secara semu.

`smoke:e2e` juga menguji dialog Pengaturan: 17 baris provider ter-render, klik di luar area
tidak menutup dialog dan tidak menghilangkan key yang diketik, `Escape` menutup dialog saat
idle tapi **tidak** saat ada request berjalan, dan hasil tes koneksi tercatat dengan benar.
Screenshot console ditulis ke `SELFDEV_SHOT`, screenshot dialog ke `SELFDEV_SHOT_SETTINGS`.

## Packaging

```bash
npm run package      # AppImage + deb  -> release/
npm run package:dir  # direktori saja  -> release/linux-unpacked
```

Hasil:

| Berkas | Ukuran | Cara pakai |
| --- | --- | --- |
| `release/SelfDev-1.3.0.AppImage` | ~120 MB | `chmod +x … && ./SelfDev-1.3.0.AppImage` |
| `release/selfdev-desktop_1.3.0_amd64.deb` | ~95 MB | `sudo dpkg -i …` |

Isi `app.asar` hanya berisi bundle hasil build (`main.js`, `runner.js`, `preload.js`,
`index.html`, `renderer.js`, `styles.css`) plus ikon — sumber dan test tidak ikut ter-bundle.

## Struktur

```
scripts/build.mjs          esbuild: main, preload, renderer, runner, tests
scripts/smoke.mjs          runner smoke/E2E headless (userData sementara)
scripts/make-icons.py      render assets/icon*.png dari vektor Android
src/shared/               provider, mode, i18n, docs, backup, ekonomi, voice
tests/run.ts               480 test
tests/mock-provider.mjs    provider tiruan (SSE OpenAI + Anthropic + lambat)
electron-builder.yml       konfigurasi rilis
```

## Lisensi

MIT