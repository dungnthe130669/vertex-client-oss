declare module "@novnc/novnc" {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string, opts?: { wsProtocols?: string[]; shared?: boolean; credentials?: Record<string, string> });
    scaleViewport: boolean; clipViewport: boolean; resizeSession: boolean; focusOnClick: boolean; viewOnly: boolean; showDotCursor: boolean;
    sendKey(keysym: number, code: string | null, down?: boolean): void;
    focus(): void; blur(): void; disconnect(): void;
  }
}
