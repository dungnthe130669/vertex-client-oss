import { call } from "./api";
import type { RemoteCommand, RemoteDetail, RemoteRow } from "../../src/remote";

export type { RemoteCommand, RemoteDetail, RemoteRow };
export type RemoteSessionDetail = RemoteDetail & { commands?: RemoteCommand[]; error?: string };
export const remoteSessions = (status?: string) => call<{ enabled: boolean; sessions: RemoteRow[]; error?: string }>(`/api/remote/sessions${status ? `?status=${status}` : ""}`);
export const remoteSession = (id: string) => call<RemoteSessionDetail>(`/api/remote/sessions/${encodeURIComponent(id)}`);
const B = (o: unknown) => ({ method: "POST", body: JSON.stringify(o) });
export const createCommand = (session_id: string, text: string) => call<{ command: RemoteCommand; nonce: string; nonce_ttl_s: number; error?: string }>("/api/remote/commands", B({ session_id, text }));
export const renewNonce = (id: string) => call<{ nonce: string; nonce_ttl_s: number; error?: string }>(`/api/remote/commands/${id}/nonce`, B({}));
export const approveCommand = (id: string, nonce: string) => call<RemoteCommand & { error?: string }>(`/api/remote/commands/${id}/approve`, B({ nonce }));
export const rejectCommand = (id: string) => call<RemoteCommand & { error?: string }>(`/api/remote/commands/${id}/reject`, B({}));
