/**
 * vertex-client — Worker serving the PWA (Workers Static Assets) plus /api/* and /auth/* (run worker-first).
 * Secrets (wrangler secret put / secret-run; never in this file):
 *   SESSION_SECRET, GATEWAY_KEY (caller `vertex-client`), GITHUB_CLIENT_ID + GITHUB_CLIENT_SECRET (OAuth app)
 * cf-lite: server/middleware.ts = the /api/* session gate (generated .cf-lite/app mounts it); every route is still the Hono app in src/index.ts
 * (createApp({ gate: false }) - the gate comes from the middleware), behind root. The ChatSession Durable Object and the cron handler are exported here.
 */
import { Hono } from "hono";
import app from "../.cf-lite/app";
import { createApp, scheduled } from "../src/index";
import { withSecurityHeaders } from "../src/headers";

export { ChatSession } from "../src/chat-session";
export { DeviceHub } from "../src/device-hub";

const root = new Hono<{ Bindings: Env }>();
root.route("/", app);                        // server/middleware.ts in front of /api/*
root.route("/", createApp({ gate: false })); // all routes (incl. the /auth/* surface and the ASSETS catch-all), session gate already applied

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return withSecurityHeaders(await root.fetch(req, env, ctx), req);
  },
  scheduled,
} as ExportedHandler<Env> & { scheduled(ev: unknown, env: Env, ctx: ExecutionContext): Promise<void> };
