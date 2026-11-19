# Webmail

A small React + Vite SPA that talks to the API's REST endpoints. It is built
into `web/dist` and served by the API itself, so there is no second deployment.

## Features

- **Inbox** — merges inbound messages (`GET /v1/messages`) and outbound mail
  (`GET /v1/outbound`), newest first.
- **Read** — renders `body_text` only. Inbound HTML is never injected into the
  page; it exists solely for download, which keeps the view XSS-safe.
- **Compose** — sends via `POST /v1/outbound`.
- **Reply** — sends via `POST /v1/messages/:id/reply`; the API derives
  `In-Reply-To`, `References` and `Reply-To` from the original message.
- **Settings** — stores the API base URL, a tenant API key, and a default
  From address in `localStorage`.

## Credentials

The browser holds **only a tenant API key**. `RESEND_API_KEY` is a server-side
environment variable and is never sent to the frontend. The key is stored in
`localStorage` under `mail.apiKey` and is sent only as the `Authorization`
header to the configured base URL.

## Development

```bash
cd web
npm install
npm run dev     # Vite dev server, proxying nothing — point BASE URL at the API
npm run build   # typecheck + build into web/dist
```

## Serving

The API serves `web/dist` as static files when that directory exists (see
`src/app.ts`). Any non-`/v1` GET that is not a real file falls back to
`index.html` so client-side navigation works. Set `WEB_DIST` to point at a
different build directory.

To find the API key: create a tenant and API key via the admin endpoints
(`POST /v1/admin/tenants`, `POST /v1/admin/tenants/:id/keys`) using
`ADMIN_BOOTSTRAP_TOKEN`. See the root `README.md`.