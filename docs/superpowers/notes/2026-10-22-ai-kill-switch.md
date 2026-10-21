# AI kill switch

**Status:** postponed (2026-10-22) until the app has an admin interface where the owner can flip
it. Nothing is built.

## Why it came up

The Gemini key's project was on the free tier: 20 requests a day for `gemini-3.8-flash`, counted
per Google project, resetting at midnight Pacific. Voice, grocery sorting and category name
translation all share that quota. Once it was used up:
- **Grocery lists:** items sat under "Sorting…" for hours.
- **Voice:** replies were the generic `voice.error`.

Turning on billing (Tier 1) fixed it. The switch would stop a quota or cost problem from looking
like a bug.

## Sketch

One check in front of every Gemini call:
- `GeminiCategorizer.generate` in `src/services/categorizer.ts`. This covers sorting and
  `translateName`.
- `GeminiVoiceProcessor.process` in `src/services/voice-processor.ts`.

- **Manual:** an owner-only toggle in the future admin interface, stored in Redis
  (`src/lib/redis.ts`), so flipping it needs no redeploy.
- **Automatic (optional):** a Gemini 429 `RESOURCE_EXHAUSTED` for a per-day quota pauses calls for
  the `RetryInfo.retryDelay` Google sends, capped at 24 hours. Per-minute 429s are short, and the
  SDK's one retry already covers them. Today the SDK also retries the daily-quota 429, which can't
  succeed.
- **While AI is off:**
  - **Voice:** reply that voice is off, instead of `voice.error`. This needs a new key in all
    three locales.
  - **Category add or rename:** use the typed name for every language. That fallback already
    exists in `src/services/category-names.ts`.
  - **"Sorting…" header:** shouldn't pulse. The client retries in `useSortingRetry` could stop.
- **Redis down:** treat AI as on. The AI rate limiters are already fail-closed.

## Related idea, not chosen

Allow dragging an item out of "Sorting…" into a category. Today the spec forbids it, so while the
AI is unavailable there is no manual way out. It pairs naturally with the switch.
