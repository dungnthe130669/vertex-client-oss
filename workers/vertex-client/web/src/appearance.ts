import { useState } from "preact/hooks";
// Typed wrapper over window.vcAppearance (web/public/appearance.js, loaded from <head> before first paint). Falls back to the defaults if the script is missing.
export type TextFont = "system" | "serif" | "mono";
export type CodeFont = "system" | "sf";
export type Appearance = { fs: number; tf: TextFont; cf: CodeFont; wrap: boolean };
export const FONT_SIZES = [1, 2, 3, 4, 5] as const;
export const FONT_SIZE_PX: Record<number, number> = { 1: 14, 2: 15, 3: 16, 4: 18, 5: 20 };
export const TEXT_FONTS: TextFont[] = ["system", "serif", "mono"];
export const TEXT_FONT_LABEL: Record<TextFont, string> = { system: "System", serif: "Serif", mono: "Mono" };
export const CODE_FONTS: CodeFont[] = ["system", "sf"];
export const CODE_FONT_LABEL: Record<CodeFont, string> = { system: "System mono", sf: "SF Mono" };
export const APPEARANCE_DEFAULTS: Appearance = { fs: 3, tf: "system", cf: "system", wrap: false };
type Api = { get(): Appearance; set(p: Partial<Appearance>): Appearance };
const api = (): Api | undefined => (window as unknown as { vcAppearance?: Api }).vcAppearance;
export function useAppearance(): [Appearance, (p: Partial<Appearance>) => void] {
  const [a, setA] = useState<Appearance>(() => api()?.get() ?? APPEARANCE_DEFAULTS);
  return [a, (p) => setA(api()?.set(p) ?? { ...a, ...p })];
}
