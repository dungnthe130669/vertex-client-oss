// Minimal ambient Cloudflare types (avoids pulling @cloudflare/workers-types, which clashes with bun-types in tests).
interface Fetcher { fetch(input: Request | string, init?: RequestInit): Promise<Response>; }
interface D1Result<T = unknown> { results: T[]; success: boolean; meta: Record<string, unknown>; }
interface D1PreparedStatement {
  bind(...v: unknown[]): D1PreparedStatement;
  first<T = unknown>(col?: string): Promise<T | null>;
  all<T = unknown>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}
interface D1Database { prepare(q: string): D1PreparedStatement; batch(s: D1PreparedStatement[]): Promise<D1Result[]>; }
interface ExecutionContext { waitUntil(p: Promise<unknown>): void; passThroughOnException(): void; props: any; }
type ExportedHandler<E> = { fetch(req: Request, env: E, ctx: ExecutionContext): Response | Promise<Response> };

interface SqlStorageCursor { toArray(): any[]; }
interface SqlStorage { exec(q: string, ...binds: unknown[]): SqlStorageCursor; }
interface DurableObjectStorage { sql: SqlStorage; deleteAll(): Promise<void>; setAlarm(t: number | Date): Promise<void>; getAlarm(): Promise<number | null>; }
interface DurableObjectState {
  storage: DurableObjectStorage;
  blockConcurrencyWhile<T>(f: () => Promise<T>): Promise<T>;
  acceptWebSocket(ws: WebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): WebSocket[];
  setWebSocketAutoResponse(pair: unknown): void;
  waitUntil(p: Promise<unknown>): void;
}
interface DurableObjectId { toString(): string }
interface DurableObjectStub { fetch(input: Request | string, init?: RequestInit): Promise<Response>; }
interface DurableObjectNamespace { idFromName(n: string): DurableObjectId; get(id: DurableObjectId, opts?: { locationHint?: string }): DurableObjectStub; }
declare class WebSocketRequestResponsePair { constructor(req: string, res: string); }
declare class WebSocketPair { 0: WebSocket; 1: WebSocket; }
interface ResponseInit { webSocket?: WebSocket | null }
interface WebSocket { serializeAttachment(v: unknown): void; deserializeAttachment(): any; }
declare module "cloudflare:workers" {
  export class DurableObject<Env = unknown> {
    ctx: DurableObjectState; env: Env;
    constructor(ctx: DurableObjectState, env: Env);
  }
}

interface R2ObjectBody { arrayBuffer(): Promise<ArrayBuffer>; body: ReadableStream; httpMetadata?: { contentType?: string }; size: number }
interface R2Bucket {
  get(key: string, opts?: { range?: { offset: number; length: number } }): Promise<R2ObjectBody | null>;
  head(key: string): Promise<{ size: number; httpMetadata?: { contentType?: string } } | null>;
  put(key: string, value: ArrayBuffer | ReadableStream | string, opts?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): Promise<unknown>;
  delete(keys: string | string[]): Promise<void>;
  list(opts?: { prefix?: string; limit?: number; cursor?: string }): Promise<{ objects: Array<{ key: string }>; truncated: boolean; cursor?: string }>;
}
