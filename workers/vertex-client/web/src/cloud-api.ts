import { call } from "./api";

export type CloudConfig = { enabled: boolean; repos: string[]; executors: string[]; e2eBasePrefix: string };
export type CloudRun = { id: string; kind: "task" | "session"; repo: string; base: string | null; branch: string | null; executor: string; title: string; status: string; cost_usd: number; created_at: string; updated_at: string; pr_number?: number | null; pr_url?: string | null; live?: unknown; ranOn?: string | null };
export type Card = { partial?: boolean; status: string; branch: string; pushed: boolean; head?: string; baseBranch?: string; compareUrl?: string; prUrl?: string; files: { status: string; path: string; add: number; del: number }[]; diffStat?: string; uncommittedFiles?: string[]; model?: string; costUsd?: number; turns?: number; tokens?: number | { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }; containerSecs?: number; wallSecs?: number; error?: string };
export type RunDetail = { run: CloudRun; state: Record<string, unknown> | null; card: Card | null; error?: string };

const B = (o: unknown) => ({ method: "POST", body: JSON.stringify(o) });
export const cloudConfig = () => call<CloudConfig>("/api/cloud/config");
export const listRuns = () => call<{ enabled: boolean; runs: CloudRun[] }>("/api/cloud/runs");
export const startRun = (o: { kind: "task" | "session"; repo: string; instruction: string; base?: string; executor?: string }) => call<{ id: string; warning?: string; error?: string }>("/api/cloud/runs", B(o));
export const getRun = (id: string) => call<RunDetail>(`/api/cloud/runs/${id}`);
export const runEvents = (id: string, after: number) => call<{ events: import("./cloud-events").AgentEvent[]; next?: number; ended?: boolean }>(`/api/cloud/runs/${id}/events?after=${after}`);
export const runAction = (id: string, action: "message" | "stop" | "tasks" | "sleep" | "wake" | "close", body: unknown = {}) => call<{ ok?: boolean; error?: string }>(`/api/cloud/runs/${id}/${action}`, B(body));
export type OpenedPr = { number: number; url: string; draft: boolean; head: string; base: string | null; error?: string };
export const openPr = (id: string) => call<OpenedPr>(`/api/cloud/runs/${id}/pr`, B({}));
