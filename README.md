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
- **BYOK**: Anthropic, OpenAI, OpenRouter, Groq, atau endpoint OpenAI-compatible/custom
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

API key disimpan lokal di `state.json` pada folder data Electron
(`~/.config/SelfDev/state.json` di Linux) dalam bentuk plaintext, bukan OS keychain.

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
npm test                     # 142 test logika & integrasi
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

## Packaging

```bash
npm run package      # AppImage + deb  -> release/
npm run package:dir  # direktori saja  -> release/linux-unpacked
```

Hasil:

| Berkas | Ukuran | Cara pakai |
| --- | --- | --- |
| `release/SelfDev-1.0.0.AppImage` | ~120 MB | `chmod +x … && ./SelfDev-1.0.0.AppImage` |
| `release/selfdev-desktop_1.0.0_amd64.deb` | ~95 MB | `sudo dpkg -i …` |

Isi `app.asar` hanya berisi bundle hasil build (`main.js`, `runner.js`, `preload.js`,
`index.html`, `renderer.js`, `styles.css`) plus ikon — sumber dan test tidak ikut ter-bundle.

## Struktur

```
scripts/build.mjs          esbuild: main, preload, renderer, runner, tests
scripts/smoke.mjs          runner smoke/E2E headless (userData sementara)
tests/run.ts               142 test
tests/mock-provider.mjs    provider tiruan (SSE OpenAI + Anthropic)
electron-builder.yml       konfigurasi rilis
```

## Lisensi

MIT