import { WEB_TOOLS } from "../../src/web-taint";

/** Approval-card body for a browse tool call: the FULL address (never clamped or truncated, wrapped, select-all) and why approval is asked. */
export const webCallUrl = (name: string, input: unknown): string | null => WEB_TOOLS.has(name) && input && typeof (input as { url?: unknown }).url === "string" ? (input as { url: string }).url : null;
export function WebApprovalNote({ url }: { url: string }) {
  return (
    <div class="webapprove" data-testid="web-approval">
      <div class="muted small">Full address the model wants to open (check it carefully):</div>
      <div class="pre weburl" data-testid="web-approval-url">{url}</div>
      <div class="muted small" data-testid="web-approval-why">A web page read earlier in this conversation was untrusted content. Approve only if you want this exact address opened.</div>
    </div>
  );
}
