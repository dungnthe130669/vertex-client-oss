# Self-hosting (technical description only)

**This document describes a technical option. It is not a licence grant.** The code is all rights reserved (see `LICENSE`);
running it requires prior written permission from the owner.

## What a deployment needs
- Your **own Cloudflare account** (Workers, D1, R2, Durable Objects). Nothing from the original owner's account is reachable.
- A `wrangler.jsonc` with **only** these bindings: one D1 database (apply `workers/vertex-client/migrations/` in order), one R2 bucket, the Durable Object classes declared in the Worker.
- A **GitHub OAuth app of your own** for login (callback = your Worker's `/auth/callback`), plus your own session secret.
- **Your own LLM provider key(s)**, added as provider keys inside the app (Open space). No shared gateway key is available.

## What is NOT available
- **Cloud mode** (agent runtime), **Fleet / Remote**, and **connector tools** — they depend on private Workers and service bindings that do not exist outside the owner's account.
- **The owner's Vertex models** — they sit behind a private gateway key.
- Any hosted login, domain or push-key setup of the original deployment.

Features whose bindings are absent are simply off; there is no licence-key mechanism.

## Checklist (bring your own Cloudflare)
1. `workers/vertex-client/wrangler.selfhost.jsonc` is a template with placeholders only. Copy it to `wrangler.jsonc` and fill in your names/ids.
2. Create the resources in your account: a D1 database (required), the R2 bucket, the Vectorize index (optional). The Durable Object classes, `AI`, `BROWSER` and `LOADER` need no resource, only the binding.
3. Apply **every** file in `migrations/` to your D1 in order (`wrangler d1 migrations apply <name> --remote`) **before** deploying code.
4. Set secrets with `wrangler secret put` (never in the config): `SESSION_SECRET`, `KEY_ENC_SECRET`, your GitHub OAuth app's `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`; optionally `VAPID_PRIVATE_KEY` for push. Put your own login in `ALLOWED_GITHUB_LOGINS`.
5. Deploy, sign in as the owner, then open the health check below.

## Health check (owner only, read-only)
`GET /api/admin/health` lists every feature, which bindings it needs, which are present, and for each missing one the exact text to add to your wrangler config (or the `wrangler secret put` line). It runs no probes by default.
`GET /api/admin/health?probe=1` additionally checks, read-only: D1 (`SELECT 1`), R2 (`head` of a probe key), Vectorize (`describe`), the Durable Object namespace, and whether your D1 has the latest migration applied. Probe results are cached for 60 seconds. The Workers AI binding is **never** probed (it would cost money); it is reported as `skipped (manual)`. The output holds only booleans and short reasons, never ids or secret values. Other users get 403.
