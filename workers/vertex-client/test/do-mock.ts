import { destroyOrdered } from "../src/files";

/** Stand-in for the per-conversation DO in route tests: /destroy runs the SAME ordered teardown the real DO runs (R2 first, then storage clear). */
export function chatMock(getFiles: () => R2Bucket | undefined, onCall?: (r: Request) => void, cleared: string[] = []): DurableObjectNamespace {
  return { idFromName: (n: string) => ({ toString: () => n }), get: () => ({ fetch: async (r: Request) => {
    onCall?.(r);
    const u = new URL(r.url);
    if (u.pathname === "/destroy") {
      const conv = r.headers.get("x-conv-id");
      const res = await destroyOrdered(getFiles(), conv, async () => { cleared.push(conv ?? ""); });
      return res.ok ? Response.json({ ok: true }) : Response.json({ error: res.error }, { status: res.status });
    }
    return Response.json({ seq: 0, messages: [] });
  } }) } as unknown as DurableObjectNamespace;
}
