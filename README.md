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
| `RESEND_API_KEY` | tidak | — | Kunci API Resend untuk email keluar; tanpa ini outbound mengembalikan `mail_provider_not_configured` |
| `ADMIN_BOOTSTRAP_EMAIL` | tidak | `admin@localhost` | Email admin untuk login `/admin`; di-seed otomatis saat `admin_users` kosong |
| `ADMIN_BOOTSTRAP_PASSWORD` | tidak | `change-me` | Password admin; minimal 8 karakter |
| `OUTBOUND_RATE_LIMIT_PER_HOUR` | tidak | `10` | Batas pengalian per tenant per jam UTC |
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

---

## Personal email (inbound + outbound)

### Overview

This API supports **full personal email** on a custom domain without upgrading Cloudflare:

| Direction | How it works |
|-----------|--------------|
| **Inbound** | Cloudflare Email Routing rule `to = you@yourdomain.com` → Worker `email-receive-forwarder` → `POST /v1/ingest`. Catch-all Gmail is untouched. |
| **Outbound** | `POST /v1/outbound` → `MailProvider` abstraction → **Resend free tier** (3 000/mo, 100/day). Domain verified via `send.yourdomain.com` subdomain. |
| **Webmail** | React + Vite SPA in `web/`, built to `web/dist`, served by the API at `/`. Auth via tenant API key in localStorage. |

### Setup (manual, one-time)

1. **Resend dashboard** → add `yourdomain.com` → copy the SPF/DKIM/DMARC records.
2. **Cloudflare DNS** → add those records for subdomain `send.yourdomain.com` (do not proxy).
3. **Resend** → create API key → put as `RESEND_API_KEY` in `.env`.
4. **API tenant** → `POST /v1/admin/tenants` → `POST /v1/admin/tenants/:id/domains {domain:"yourdomain.com"}` → `POST /v1/admin/tenants/:id/keys {scopes:["read","admin"]}`.
5. **Cloudflare Email Routing** → rule:
   ```
   wrangler email routing rules create yourdomain.com \
     --match-type literal --match-field to \
     --match-value "you@yourdomain.com" \
     --action-type worker --action-value "email-receive-forwarder" \
     --priority 1 --name "personal inbox: you@yourdomain.com"
   ```
   Priority `1` places it before the existing catch-all.
6. **Test send** (curl or webmail Compose):
   ```
   curl -X POST $BASE/v1/outbound -H "Authorization: Bearer $KEY" \
     -d '{"fromAddr":"you@yourdomain.com","to":["someone@gmail.com"],"subject":"uji","text":"halo"}'
   ```
   Expect `202 {accepted:true}`. The provider rejects unverified domains immediately; status=`failed`, error surfaced in list/detail.
7. **Receive** → email to `you@yourdomain.com` appears in `GET /v1/messages` and in the webmail Inbox.

### Rate limit

Default `OUTBOUND_RATE_LIMIT_PER_HOUR=10` per tenant. Configurable via `.env`. Exceeding returns `429 {error:"outbound_rate_limited"}`. Counters reset at UTC hour boundaries.

### Webmail

```bash
cd web
npm install
npm run build   # produces web/dist
```
Start the API; the SPA is served at `/`. Open in a browser, enter base URL + API key + default From address, then Compose / Inbox / Read / Reply.

### Admin UI

The admin panel is served at `/admin` and requires a database admin user:

1. Set `ADMIN_BOOTSTRAP_EMAIL` and `ADMIN_BOOTSTRAP_PASSWORD` in `.env` (both optional; defaults are `admin@localhost` / `change-me`).
2. On first start, `ensureBootstrapUser` seeds the admin if the `admin_users` table is empty.
3. Open `https://yourdomain.com/admin` → sign in with email + password → session token stored in localStorage (24h).
4. Dashboard: create tenants, add domains, create/revoke `ek_` API keys, and generate user-ready `baseUrl`/`apiKey`/`fromAddr` in the **User Setup** tab.
5. Legacy `ADMIN_BOOTSTRAP_TOKEN` still works for API-only scripts (`Authorization: Bearer <token>`).

### Docker deployment (production)

The multi-stage Dockerfile builds the web SPA into the image (`web/dist` served by `@fastify/static`).

```bash
cp .env.example .env   # isi nilai sungguhan
docker compose up -d --build
curl -fsS https://yourdomain.com/healthz
curl -fsS https://yourdomain.com/readyz
```

- Image runs as non-root user `10001`, volume `/data`, root filesystem read-only.
- API binds to Docker bridge `172.17.0.1:3000` (NOT `0.0.0.0`) — reachable from host at `http://172.17.0.1:3000`, and via reverse proxy (Caddy example in `Caddyfile.example`) at public HTTPS.
- `env_file: .env` in `docker-compose.yml` loads all config; secrets never baked into image.

### Architecture notes

- `RESEND_API_KEY` is a server-side env var — **never reaches the frontend**.
- Inbound HTML is stored for download only; the webmail renders `body_text` (anti-XSS).
- Outbound replies use `POST /v1/messages/:id/reply`; the API builds `In-Reply-To`, `References`, `Reply-To` from the original message's headers.
- The `MailProvider` interface (`src/services/mail/provider.ts`) lets you swap Resend for Brevo/SMTP2Go/Cloudflare Paid without changing routes.