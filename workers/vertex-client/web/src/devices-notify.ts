import { toast } from "./toast";

/** In-app notice that a device wants approval. Web Push for "needs approval" is sent by the Worker (DeviceHub -> src/device-push.ts, on `approval_request`,
 *  when no visible PWA socket is connected); this in-app notice stays as the foreground fallback and does not talk to the push service. */
export function notifyApproval(tool: string, review: () => void) {
  toast(`Approval needed: ${tool}`, { action: { label: "Review", run: review } });
}
