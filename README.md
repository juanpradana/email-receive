# email-receive

REST API self-hosted untuk menerima email dari **Cloudflare Email Routing / Email Workers**, menyimpannya per tenant berdasarkan domain penerima, lalu mendorong webhook bertanda tangan untuk automation.

- Email Worker mem-POST MIME mentah ke `POST /v1/ingest` dengan HMAC.
- API menyimpan `.eml` secara atomik, mencatat metadata di SQLite, lalu mem-parsing MIME secara asinkron.
- Tenant membaca pesan dengan API key ber-scope dan mendaftarkan webhook; dispatcher outbox mengirim event dengan retry.

## Arsitektur singkat

```
Internet mail ──> Cloudflare Email Routing ──> Email Worker (worker/) ──HTTPS+HMAC──> Fastify API
                                                                                  ├─ data/raw/*.eml   (sumber kebenaran)
                                                                                  ├─ data/html/*.html
                                                                                  ├─ data/att/*
                                                                                  └─ SQLite (metadata, outbox webhook)
                                                                                           │
                                                                       webhook bertanda tangan ◀── automation
```

## Kebutuhan

- Node.js 22+ atau Docker
- Domain yang diarahkan ke Cloudflare (Email Routing) untuk produksi
- HTTPS publik untuk API (Caddy atau reverse proxy lain); endpoint publik tidak boleh HTTP biasa

## Konfigurasi

Salin `.env.example` menjadi `.env` lalu isi:

| Variabel | Wajib | Default | Keterangan |
|---|---|---|---|
| `PUBLIC_BASE_URL` | ya | — | URL HTTPS publik API, dipakai untuk URL mentah/attachment di payload webhook |
| `INGEST_HMAC_SECRET` | ya | — | Minimal 32 karakter; dipakai Worker dan API |
| `ADMIN_BOOTSTRAP_TOKEN` | ya | — | Minimal 16 karakter; header `Authorization: Bearer …` untuk route admin |
| `SIGNED_URL_SECRET` | ya | — | Minimal 32 karakter; disiapkan untuk URL bertanda tangan |
| `DATA_DIR` | tidak | `./data` | Akar file `.eml`, HTML, attachment; di container memakai `/data` |
| `DB_PATH` | tidak | `<DATA_DIR>/email.db` | Lokasi SQLite |
| `PORT` / `HOST` | tidak | `3000` / `0.0.0.0` | Bind API |
| `MAX_MESSAGE_BYTES` | tidak | `26214400` (25 MiB) | Email lebih besar → `413` |
| `DEDUPE_WINDOW_HOURS` | tidak | `24` | Jendela dedupe `tenant_id + sha256(raw)` |
| `WEBHOOK_ALLOW_PRIVATE` | tidak | `false` | `true` hanya untuk pengembangan; produksi wajib `false` |
| `WEBHOOK_MAX_ATTEMPTS` | tidak | `8` | Setelah itu delivery menjadi `dead` |
| `RETENTION_DAYS` | tidak | `0` | `0` = simpan selamanya |
| `LOG_LEVEL` | tidak | `info` | Level pino |

## Menjalankan

```bash
npm install
npm run build
npm start            # node dist/server.js
# atau pengembangan:
npm run dev
```

Dengan Docker:

```bash
cp .env.example .env   # isi nilai sungguhan
docker compose up -d --build
curl -fsS https://mail.example.com/healthz
curl -fsS https://mail.example.com/readyz
```

Image berjalan sebagai user non-root (`10001`), volume `/data`, root filesystem read-only, dan healthcheck memanggil `/readyz`. Reverse proxy contoh ada di `Caddyfile.example`.

## Provisioning tenant

Tenant dipilih dari **domain penerima** (`X-Envelope-To`). Domain yang tidak terdaftar → `404` dan Worker tidak menganggapnya sukses.

```bash
API=https://mail.example.com
ADMIN="Authorization: Bearer $ADMIN_BOOTSTRAP_TOKEN"

# 1) buat tenant
curl -fsS -X POST "$API/v1/admin/tenants" -H "$ADMIN" -H 'content-type: application/json' \
  -d '{"name":"Acme"}'
# → { "tenant": { "id": "...", "name": "Acme", ... } }

# 2) daftarkan domain yang akan menerima email
curl -fsS -X POST "$API/v1/admin/tenants/<TENANT_ID>/domains" -H "$ADMIN" -H 'content-type: application/json' \
  -d '{"domain":"mail.acme.test"}'

# 3) buat API key (plaintext hanya muncul sekali)
curl -fsS -X POST "$API/v1/admin/tenants/<TENANT_ID>/keys" -H "$ADMIN" -H 'content-type: application/json' \
  -d '{"name":"automation","scopes":["read","admin"]}'
```

API key disimpan sebagai hash scrypt; server tidak pernah menyimpan plaintext. Scope `read` cukup untuk membaca pesan; `admin` diperlukan untuk menghapus pesan dan mengelola webhook.

## Setup Cloudflare Email Routing + Worker

1. Deploy Worker di `worker/`:

   ```bash
   cd worker
   npm install
   npx wrangler secret put INGEST_HMAC_SECRET   # nilai sama dengan API
   npx wrangler deploy
   ```

   Atur `INGEST_URL` (dan opsional `MAX_BYTES`) di `wrangler.toml`, atau lewat dashboard Worker → Variables.

2. Di dashboard Cloudflare → **Email Routing** → **Routes**, arahkan alamat/domain tenant ke Worker tersebut.
3. Worker membaca `message.raw`, menghitung HMAC, lalu POST ke `/v1/ingest`. Email di atas `MAX_BYTES` ditolak dengan `setReject` (bounce).

Perilaku saat API mati: Worker mencoba ulang 3 kali (250 ms, 1000 ms, 2500 ms) lalu **melempar error**. Cloudflare menandai pemrosesan gagal sehingga pengirim menerima bounce; tidak ada email yang dilaporkan sukses secara diam-diam. Tidak ada spool lokal.

## Ingest manual (curl)

Signature = `HMAC-SHA256(INGEST_HMAC_SECRET, "<timestamp>.<sha256hex(body)>")`, dikirim sebagai `X-Ingest-Signature: t=<timestamp>,v1=<hex>`. Skew yang diterima 300 detik.

```bash
BODY=./mail.eml
TS=$(date +%s)
DIGEST=$(openssl dgst -sha256 -hex "$BODY" | awk '{print $2}')
SIG=$(printf '%s.%s' "$TS" "$DIGEST" | openssl dgst -sha256 -hmac "$INGEST_HMAC_SECRET" -hex | awk '{print $2}')

curl -fsS -X POST "$API/v1/ingest" \
  -H 'content-type: message/rfc822' \
  -H "x-envelope-from: sender@example.test" \
  -H "x-envelope-to: inbox@mail.acme.test" \
  -H "x-ingest-signature: t=$TS,v1=$SIG" \
  --data-binary "@$BODY"
# 202 { "id": "...", "status": "pending", "duplicate": false }
# 200 { "id": "...", "status": "pending", "duplicate": true }  ← retry/duplikat
```

Mengulang body yang sama dalam `DEDUPE_WINDOW_HOURS` mengembalikan id yang sama dan tidak membuat row/file baru.

## Membaca pesan

```bash
KEY="Authorization: Bearer ek_..."

curl -fsS "$API/v1/messages?limit=20" -H "$KEY"
curl -fsS "$API/v1/messages/<ID>" -H "$KEY"
curl -fsS "$API/v1/messages/<ID>/raw" -H "$KEY" -o message.eml
curl -fsS "$API/v1/messages/<ID>/attachments/<ATTACHMENT_ID>" -H "$KEY" -o attachment.bin
curl -fsS -X DELETE "$API/v1/messages/<ID>" -H "$KEY"   # butuh scope admin
```

Setiap query difilter `tenant_id`; key tenant lain selalu mendapat `404` untuk pesan, raw, maupun attachment.

## Webhook

```bash
curl -fsS -X POST "$API/v1/webhooks" -H "$KEY" -H 'content-type: application/json' \
  -d '{"url":"https://automation.example.com/hooks/email","events":["message.received"]}'
# → { "endpoint": { "id", "url", "events", "secret": "whsec_...", "createdAt" } }  (secret hanya sekali)

curl -fsS "$API/v1/webhooks" -H "$KEY"
curl -fsS "$API/v1/webhooks/<ENDPOINT_ID>/deliveries" -H "$KEY"
curl -fsS -X POST "$API/v1/messages/<ID>/redeliver" -H "$KEY"
```

Event `message.received` dikirim setelah parsing selesai. Delivery bersifat **at-least-once**; kegagalan webhook tidak pernah mengubah status email. Backoff: 10 s, 60 s, 5 m, 30 m, 2 h, 6 h, 24 h (+jitter), lalu `dead` setelah `WEBHOOK_MAX_ATTEMPTS`.

URL tujuan wajib HTTPS, tanpa kredensial di URL, dan tidak boleh mengarah ke alamat privat/loopback/metadata. Resolusi DNS diperiksa pada setiap percobaan; redirect tidak diikuti.

### Verifikasi signature

Header `X-Webhook-Signature: t=<unix>,v1=<hmac_sha256_hex>`, dihitung atas `<t>.<raw body>`. Tolak jika selisih waktu terlalu besar.

```js
import { createHmac, timingSafeEqual } from "node:crypto";

const [t, v1] = header.split(",").map((part) => part.split("=")[1]);
const expected = createHmac("sha256", WEBHOOK_SECRET).update(`${t}.${rawBody}`).digest("hex");
const ok = Date.now() / 1000 - Number(t) < 300 &&
  timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
```

Payload berisi `event` dan `message` (metadata, snippet, `bodyText` maksimal 20 000 karakter, metadata attachment, `rawUrl`) — tanpa isi biner attachment. URL memakai `PUBLIC_BASE_URL` dan tetap memerlukan API key tenant.

## Retensi dan backup

- `RETENTION_DAYS=0` menyimpan semua. Nilai `N > 0` menghapus pesan lebih tua dari `N` hari (row + raw + HTML + attachment) setiap jam.
- Backup: hentikan container sebentar atau gunakan snapshot volume, lalu salin seluruh isi `/data` (`email.db` **beserta** `email.db-wal`/`email.db-shm` dan folder `raw/`, `html/`, `att/`). Jangan hanya menyalin `email.db` saat server hidup.

## Catatan keamanan dan batasan

- Simpan rahasia hanya di `.env`/secret manager; log API meredaksi `authorization` dan `x-ingest-signature`.
- Raw `.eml` adalah sumber kebenaran. Jika parsing gagal, pesan tetap `status='failed'` dengan raw yang bisa diunduh.
- Body HTML **disimpan** di `data/html/`, tetapi tidak dirender atau disajikan sebagai halaman oleh API — automation harus mengambil raw atau mem-parse ulang bila perlu.
- Response mentah dan attachment dikirim dengan `Content-Disposition: attachment` dan `X-Content-Type-Options: nosniff`.
- API ini tidak mengirim email keluar dan tidak menjadi relay.

## Pengujian

```bash
npm run typecheck
npm test                 # suite API
cd worker && npm test    # suite Email Worker
```