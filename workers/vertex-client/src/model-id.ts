// One syntax check for a model id from a client. Vertex ids are plain (`claude-sonnet-5-5`); other providers' ids are `<providerId>:<their id>` and
// their own ids contain `/`, `@` and `:` (`cloudflare:@cf/openai/gpt-oss-120b`, `nvidia:nvidia/nemotron-3-ultra-550b-a55b`). Syntax only: whether the id
// exists in the caller's space is decided by the registry.
export const MODEL_ID_RE = /^[A-Za-z0-9._:@/-]{1,160}$/;
export const isModelIdSyntax = (v: unknown): v is string => typeof v === "string" && MODEL_ID_RE.test(v);
