import { mobileShellVersion } from "./update-logic";
/** The native shell appends ` VertexClientDesktop/<version>` to the main window's user agent (no page-callable command). Strict: exactly that token + SemVer
 *  as its own whitespace-delimited word; anything else (absent, no version, junk) is null. */
const RE = /(?:^|\s)VertexClientDesktop\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?=\s|$)/;

export function desktopShellVersion(ua: unknown): string | null {
  return typeof ua === "string" && ua.length <= 1000 ? RE.exec(ua)?.[1] ?? null : null;
}

/** The About rows that depend on where the page runs: "Installed app" (yes / no / "desktop app" inside the shell) and, only in the shell, "Desktop app". */
export function installRows(standalone: boolean, ua: unknown): Array<[string, string]> {
  const v = desktopShellVersion(ua);
  const m = v ? null : mobileShellVersion(ua);
  if (m) return [["Installed app", "mobile app"], ["Mobile app", `${m} (native shell)`]];
  return v ? [["Installed app", "desktop app"], ["Desktop app", `${v} (native shell)`]] : [["Installed app", standalone ? "yes" : "no"]];
}
