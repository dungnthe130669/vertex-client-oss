// Settings > Cloudflare / Providers wording, kept apart from the components so a test can pin it. No token value ever passes through here (only a last-4 string).
import type { CfAccountView } from "./api";

/** The Providers-page notice (replaces "Cloudflare Workers AI needs no key ..."): shared operator account by default, or the user's own. */
export const CF_PROVIDERS_NOTICE = "Cloudflare (Workers AI, browser tools) runs on the operator's shared account by default: its free daily allowance, then neurons, billed to the operator. Link your own Cloudflare account under Settings > Cloudflare to use your own allowance and billing instead.";

export const cfUsing = (v: Pick<CfAccountView, "using" | "token_last4"> | null): string =>
  !v ? "" : v.using === "own" ? `Using: your account ••••${v.token_last4 ?? ""}` : v.using === "broken" ? "Using: nothing (your linked account cannot be read; remove it and link again)" : "Using: shared account";
export const cfBadge = (v: Pick<CfAccountView, "using"> | null): string => (!v ? "" : v.using === "own" ? "Your account" : v.using === "broken" ? "Re-link" : "Shared");

export const CF_HELP = "Create an API token at dash.cloudflare.com/profile/api-tokens (Create Custom Token) with only the permissions below, for one account. Paste it with your account id; it is stored encrypted, never shown again (only its last 4 characters). To stop using it, press Remove here and also delete the token in Cloudflare.";
export const CF_ACCOUNT_ID_HELP = "Account id: 32 hexadecimal characters, in the Cloudflare dashboard (Workers & Pages overview, right-hand side).";
export const CF_FREE_NOTE = "Your own account's limits apply, not ours: the free plan allows a daily Workers AI allowance and 10 minutes of Browser Rendering a day. Containers and sandboxes are not available through a pasted token.";

export const testNote = (r: { ok?: boolean; detail?: string; error?: string }, status: number): string =>
  status === 429 ? "Too many tests, wait a minute." : r.detail ?? r.error ?? `Test failed (${status})`;
export const linkError = (r: { error?: string } | null, status: number): string =>
  status === 429 ? "Too many changes, wait a minute and try again." : r?.error ?? `Could not link the account (${status})`;
