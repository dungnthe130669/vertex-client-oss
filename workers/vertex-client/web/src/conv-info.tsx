import { useEscape } from "./confirm";
import { fmtTokens } from "./chat-state";
import { fmtWhen } from "./depth-logic";

export type InfoData = { id: string; title: string; model: string; messages: number; createdAt?: string; updatedAt?: string; costUsd: number; tokens: number; status: string; projectId: string | null; subagents?: { count: number; input: number; output: number } };

/** Conversation info sheet: facts only (model, size, dates, usage). The actions (Rename, Pin, Move, Export, Delete) live in the shared Chat actions menu (chat-menu.tsx). */
export function ConvInfo({ d, onClose }: { d: InfoData; onClose: () => void }) {
  useEscape(onClose);
  const row = (k: string, v: string, id: string) => <div class="irow"><dt class="muted">{k}</dt><dd class="num" data-testid={id}>{v}</dd></div>;
  return (
    <div class="scrim" onClick={onClose}>
      <div class="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Chat info" data-testid="conv-info">
        <div class="grabber" />
        <strong>{d.title || "New chat"}</strong>
        <dl class="info">
          {row("Model", d.model || "—", "info-model")}
          {row("Messages", String(d.messages), "info-count")}
          {row("Created", fmtWhen(d.createdAt), "info-created")}
          {row("Updated", fmtWhen(d.updatedAt), "info-updated")}
          {row("Usage", `~${fmtTokens(d.tokens)} tokens`, "info-usage")}
          {d.subagents && d.subagents.count > 0 && row("Subagents", `${d.subagents.count} ${d.subagents.count === 1 ? "delegation" : "delegations"} · ${fmtTokens(d.subagents.input + d.subagents.output)} tokens`, "info-subagents")}
          {row("Connection", d.status, "info-conn")}
        </dl>
        <button class="btn" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
