import type { MiddlewareHandler } from "hono";
import { apiGate } from "../src/gate";

// /api/* needs a session (cookie + Origin + CSRF, or the shared-SSO exchange on GET /api/me) - src/gate.ts. cf-lite compiles the matcher into
// assets.run_worker_first (["/api", "/api/*"], merged with wrangler's hand-written ["/auth/*"]).
export const config = { matcher: ["/api/:path*"] };

export default apiGate as unknown as MiddlewareHandler<any>; // sets c.var.session (field-notes/remote-hub-0.6.md gap 2: generated app cannot type Variables)
