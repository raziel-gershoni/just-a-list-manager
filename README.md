# Just a List Manager

> A collaborative shopping and to-do list for households — talk to it, and a voice message becomes structured list edits.

![Next.js](https://img.shields.io/badge/Next.js%2016-000?style=flat-square&logo=next.js&logoColor=white)
![React](https://img.shields.io/badge/React%2019-20232A?style=flat-square&logo=react&logoColor=61DAFB)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Tailwind CSS](https://img.shields.io/badge/Tailwind%20CSS%204-06B6D4?style=flat-square&logo=tailwindcss&logoColor=white)
![Supabase](https://img.shields.io/badge/Supabase-3FCF8E?style=flat-square&logo=supabase&logoColor=white)
![Google Gemini](https://img.shields.io/badge/Google%20Gemini-8E75B2?style=flat-square&logo=googlegemini&logoColor=white)
![Telegram](https://img.shields.io/badge/Telegram%20Mini%20App-26A5E4?style=flat-square&logo=telegram&logoColor=white)
![Vercel](https://img.shields.io/badge/Vercel-000?style=flat-square&logo=vercel&logoColor=white)
[![demo · live](https://img.shields.io/badge/demo-live-3FCF8E?style=flat-square)](https://just-a-list-manager.vercel.app)

**🔗 Live demo:** https://just-a-list-manager.vercel.app _(sign in with Telegram)_

A real-time collaborative list app for two-person households, built to run both as a Telegram Mini App and as a standalone web app. Two people share a shopping or to-do list, edit it at the same time, and can update it hands-free: record a Telegram voice message and Google Gemini transcribes and parses it into structured add/remove actions against the right list — including reminders and recurring items. The interesting part is not the CRUD; it's the voice-to-list AI pipeline, the custom Telegram auth wired into Supabase Row-Level Security, and the offline-first collaborative sync underneath.

<!-- Screenshot placeholder: leave exactly this HTML comment so the owner can drop an image in later:
     ![screenshot](docs/screenshot.png) -->

## ✨ Features

- **Voice-driven editing** — send a Telegram voice message ("add milk and eggs, remove bread") and it lands as parsed items on the correct list, with reminders and recurrence pulled from natural speech.
- **Real-time collaboration** — multiple people edit the same list simultaneously with live sync; edits are attributed to who made them.
- **Offline-first** — optimistic edits apply instantly and queue locally, then reconcile automatically on reconnect, so the app stays usable on a spotty phone connection.
- **Share with permissions** — invite a collaborator by link with view-only or edit access.
- **Reminders, recurrence, and daily digests** — set per-item reminders, mark items as recurring, and receive scheduled reminder/digest messages in Telegram.
- **Smart de-duplication** — completed items are recycled instead of duplicated; typos and near-matches are caught with fuzzy matching.
- **Household hand-off signals** — "ready for you" and "remind to update" cues coordinate the two people around a shared list.
- **Reorder by drag-and-drop**, list icons/colors, and item sections.
- **Trilingual** — English, Hebrew (full RTL), and Russian, resolved from the user's Telegram language.

## 🏗️ How it works

**Voice-to-list AI pipeline.** A Telegram voice note arrives as OGG audio on the bot webhook. Before doing anything expensive, the handler enforces a per-user rate limit (fail-closed, to protect the Gemini quota) and acquires a distributed Redis lock keyed on the audio's `file_unique_id`, so Telegram's webhook retries can't double-process the same message. The audio is streamed to a Google Gemini multimodal model with a strict JSON response schema, returning a typed list of `{ text, action, targetList, remind_at, recurrence }` entries. The pipeline then resolves each entry to a concrete list the user owns or can edit (exact name match → substring fuzzy match → sole-list fallback), and applies it: adds run through server-side recycling, removes soft-delete the best active match, and any `remind_at` becomes a reminder row. The user gets a per-list receipt back in chat. The processor sits behind a `VoiceProcessor` interface so the model provider is swappable.

**Server-side fuzzy matching to avoid duplicates.** New items aren't blindly inserted. A Postgres `pg_trgm` similarity search (via an RPC) finds recyclable completed items; a Dice-coefficient bigram check gates auto-recycling at a confidence threshold, and low-confidence matches fall through to creating a fresh item. Removals do exact-`ILIKE`-then-fuzzy matching and distinguish "already checked off" from "not found." All text is normalized to a canonical form before matching, and `ILIKE` wildcards are escaped to prevent injection.

**Custom auth bridged to Supabase RLS.** Two entry points, one identity model. Inside Telegram, Mini App `initData` is validated with the documented HMAC-SHA256 scheme (`WebAppData`-derived secret, sorted data-check-string, `timingSafeEqual`, 5-minute freshness). On the open web, users log in via Telegram's OAuth 2.0 / OIDC flow with PKCE — the app generates the verifier/challenge client-side and verifies the returned `id_token` against Telegram's JWKS. Either path ends the same way: the server mints its own `jose`-signed JWT carrying Supabase-shaped claims (`sub`, `aud: authenticated`, `role`), which drives Postgres Row-Level Security and Realtime. API routes accept the bearer JWT (preferred) or fall back to `initData`, both rate-limited per Telegram user.

**Offline-first collaborative sync.** The client keeps a per-list mutation queue: edits apply optimistically, and if the request fails while offline they stay queued (with a 24-hour max age) rather than being lost. Idempotency keys make retried mutations safe against the server, and a reconnect orchestrator re-flushes the queue and resubscribes to Realtime when the connection returns — so two collaborators editing at once converge without stomping each other.

**Scheduled work and a build-time migration runner.** Reminders and daily digests are driven by Supabase `pg_cron`, which uses `pg_net` to call authenticated API routes on a schedule, with the calling secret stored in Supabase Vault rather than in the schema. The database itself is 23 sequential SQL migrations applied by a small custom runner (`scripts/migrate.mjs`) that tracks applied files in a `_migrations` table and is wired into the `build` step so deploys stay in sync. The project is spec-driven: each feature has a design spec and implementation plan under `docs/`.

## 🛠️ Tech stack

- **Frontend:** Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS 4, shadcn / Radix UI, dnd-kit, next-intl (en / he-RTL / ru)
- **Backend / API:** Next.js Route Handlers, `node-telegram-bot-api` (webhook), Telegram Mini App `initData` + Telegram OAuth 2.0 / OIDC with PKCE, `jose` (JWT), `zod` validation
- **Data:** Supabase Postgres with Row-Level Security, Realtime, and `pg_trgm`; `postgres` (postgres-js); custom SQL migration runner
- **AI:** Google Gemini multimodal (`@google/generative-ai`) with a strict response schema for audio → structured actions
- **Infra:** Vercel; Upstash Redis + Ratelimit (rate limiting and distributed voice-processing locks); Supabase `pg_cron` + `pg_net` + Vault for scheduled reminders/digests
- **Testing:** Vitest, Testing Library

## 🚀 Getting started

### Prerequisites

- Node.js 20+ and npm
- A Supabase project (Postgres + Realtime) and its direct database connection string
- A Telegram bot (token + webhook secret) and a Telegram OAuth client for standalone web login
- A Google Gemini API key
- An Upstash Redis instance (REST URL + token)

### Environment variables

Set these in `.env.local` for development (and in your host's environment for deploys). Names only — never commit real values.

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase publishable (anon) key for the client |
| `SUPABASE_SECRET_KEY` | Supabase service key for server-side access |
| `SUPABASE_JWT_SECRET` | Secret used to sign the app's Supabase-compatible JWTs |
| `DATABASE_URL` | Direct Postgres connection string (used by the migration runner) |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token (Mini App auth + bot messaging) |
| `TELEGRAM_WEBHOOK_SECRET` | Shared secret validating incoming Telegram webhooks |
| `TELEGRAM_OAUTH_CLIENT_ID` | Telegram OAuth client ID (standalone web login) |
| `TELEGRAM_OAUTH_CLIENT_SECRET` | Telegram OAuth client secret |
| `NEXT_PUBLIC_BOT_ID` | Telegram bot numeric ID (client login widget) |
| `NEXT_PUBLIC_BOT_USERNAME` | Telegram bot username |
| `GEMINI_API_KEY` | Google Gemini API key for voice processing |
| `UPSTASH_REDIS_REST_URL` | Upstash Redis REST URL (rate limits + locks) |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis REST token |
| `NEXT_PUBLIC_APP_URL` | Public base URL of the deployed app |
| `CRON_SECRET` | Bearer secret authorizing scheduled cron calls (provided by the host in production) |

### Install & run

```bash
# Install dependencies
npm install

# Run the dev server
npm run dev

# Production build (applies pending SQL migrations, then builds)
npm run build

# Start the production server
npm run start
```

> `npm run build` runs `scripts/migrate.mjs` first; it applies any un-applied migrations when `DATABASE_URL` is set and no-ops otherwise.

## 🧪 Testing

Unit tests run on Vitest (with Testing Library), covering the voice/duplicate-detection logic, the mutation queue and executor factory, `initData` validation, text normalization, and list helpers.

```bash
# Watch mode
npm test

# Single run (CI)
npm run test:run
```

## 📦 Deployment

Deployed on Vercel. Database schema changes ship automatically via the migration runner in the build step, and scheduled reminders and daily digests run inside Supabase through `pg_cron` + `pg_net` calling the app's authenticated cron routes.

## 📄 License

Shared publicly as a portfolio project.
