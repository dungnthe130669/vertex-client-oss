import { createContext } from "preact";

/** True inside the desktop Settings modal's right pane: the left nav already lists the panes, so General does not repeat them as rows. */
export const PaneCtx = createContext(false);
