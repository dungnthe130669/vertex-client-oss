import { call } from "./api";

export type AgentsConfig = { enabled: boolean; repos: string[]; images: string[]; executors: string[]; namePrefix: string; e2eBasePrefix: string | null };
export type AgentRow = { name: string; repo: string; base?: string | null; image?: string; executor?: string; instructions?: string; phase?: string; state: "running" | "awake" | "sleeping"; costUsd: number; lastActivity?: number | null; lastDone?: number | null; lastWake?: number | null; queued?: number; session?: { id?: string; status?: string } | null };
export type InboxMsg = { id: string; from?: string; status?: string; text: string | null; reply?: string | null; hasReply?: boolean; error?: string | null; created?: number; finished?: number | null; kind?: string };
export type Sched = { id: string; text: string; nextRun: string; everySecs: number | null; cron: string | null; runs: number };
export type AgentDetail = { agent: AgentRow; inbox: InboxMsg[]; schedules: Sched[] };

const B = (o: unknown, method = "POST") => ({ method, body: JSON.stringify(o) });
const n = (name: string) => encodeURIComponent(name);
export const agentsConfig = () => call<AgentsConfig>("/api/agents/config");
export const listAgents = () => call<{ enabled: boolean; agents: AgentRow[] }>("/api/agents");
export const getAgent = (name: string) => call<AgentDetail & { error?: string }>(`/api/agents/${n(name)}`);
export const createAgent = (o: { name: string; repo: string; image?: string; executor?: string; base?: string; instructions?: string }) => call<{ error?: string }>("/api/agents", B(o));
export const updateAgent = (name: string, o: { repo?: string; image?: string; executor?: string; base?: string; instructions?: string }) => call<{ error?: string }>(`/api/agents/${n(name)}`, B(o, "PATCH"));
export const deleteAgent = (name: string) => call<{ error?: string }>(`/api/agents/${n(name)}`, B({}, "DELETE"));
export const sendToAgent = (name: string, text: string) => call<{ id?: string; error?: string }>(`/api/agents/${n(name)}/inbox`, B({ text }));
export const agentAction = (name: string, a: "wake" | "sleep" | "rollover" | "stop") => call<{ error?: string }>(`/api/agents/${n(name)}/${a}`, B({}));
export const addSchedule = (name: string, o: { text: string; delaySecs?: number; everySecs?: number; cron?: string }) => call<{ error?: string }>(`/api/agents/${n(name)}/schedules`, B(o));
export const cancelSchedule = (name: string, sid: string) => call<{ error?: string }>(`/api/agents/${n(name)}/schedules/${sid}`, B({}, "DELETE"));
export const agentEvents = (name: string, after: string | null) => call<{ events: { kind: string; cursor?: string; session?: string; previous?: string | null; ts?: number; data?: Record<string, unknown> }[]; next?: string | null }>(`/api/agents/${n(name)}/events${after ? `?after=${encodeURIComponent(after)}` : ""}`);
