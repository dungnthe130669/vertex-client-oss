import { useState } from "preact/hooks";
// Thin typed wrapper over window.vcTheme (web/public/theme.js, loaded from <head> before first paint). Falls back to a no-op if the script is missing.
export type ThemeMode = "auto" | "light" | "dark";
export const THEME_MODES: ThemeMode[] = ["auto", "light", "dark"];
export const THEME_LABEL: Record<ThemeMode, string> = { auto: "Auto", light: "Light", dark: "Dark" };
type Api = { get(): ThemeMode; set(m: ThemeMode): void };
const api = (): Api | undefined => (window as unknown as { vcTheme?: Api }).vcTheme;
export const nextTheme = (m: ThemeMode): ThemeMode => THEME_MODES[(THEME_MODES.indexOf(m) + 1) % THEME_MODES.length];
export function useTheme(): [ThemeMode, (m: ThemeMode) => void] {
  const [mode, setMode] = useState<ThemeMode>(() => api()?.get() ?? "auto");
  return [mode, (m) => { api()?.set(m); setMode(m); }];
}
