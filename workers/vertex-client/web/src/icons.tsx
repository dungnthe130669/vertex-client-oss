import type { ComponentChildren } from "preact";
// Inline SVG icon set (no emoji glyphs, no deps). 20px grid, currentColor, decorative (aria-hidden) — the owning button carries the label.
const I = ({ children, size = 20, testid }: { children: ComponentChildren; size?: number; testid?: string }) => (
  <svg class="ic" data-testid={testid} width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">{children}</svg>
);
export const IconBack = () => <I><path d="M12 4l-6 6 6 6" /></I>;
export const IconMore = () => <I><circle cx="4.5" cy="10" r=".9" fill="currentColor" /><circle cx="10" cy="10" r=".9" fill="currentColor" /><circle cx="15.5" cy="10" r=".9" fill="currentColor" /></I>;
export const IconPlus = () => <I><path d="M10 4v12M4 10h12" /></I>;
export const IconAttach = () => <I><path d="M16 9.5l-5.8 5.8a3.6 3.6 0 01-5.1-5.1l6-6a2.4 2.4 0 013.4 3.4l-6 6a1.2 1.2 0 01-1.7-1.7l5.4-5.4" /></I>;
export const IconSend = () => <I><path d="M10 16V4M5 9l5-5 5 5" /></I>;
export const IconStop = () => <I><rect x="5.5" y="5.5" width="9" height="9" rx="1.8" fill="currentColor" stroke="none" /></I>;
export const IconChevron = () => <I size={16}><path d="M7 5l5 5-5 5" /></I>;
export const IconChevronDown = () => <I size={16}><path d="M5 8l5 5 5-5" /></I>;
export const IconCopy = () => <I size={16}><rect x="7" y="7" width="9" height="9" rx="2" /><path d="M4 13V5.5A1.5 1.5 0 015.5 4H13" /></I>;
export const IconCheck = () => <I size={16}><path d="M4.5 10.5l3.5 3.5 7.5-8" /></I>;
export const IconTool = () => <I size={16}><path d="M12.5 4.5a3.5 3.5 0 00-4.4 4.4L3.5 13.5a1.4 1.4 0 002 2l4.6-4.6a3.5 3.5 0 004.4-4.4l-2.2 2.2-1.8-.4-.4-1.8z" /></I>;
export const IconFile = () => <I size={16}><path d="M5 2.5h6l4 4v11H5z" /><path d="M11 2.5v4h4" /></I>;
export const IconImage = () => <I size={16}><rect x="3" y="4" width="14" height="12" rx="2" /><circle cx="7.5" cy="8.5" r="1.3" /><path d="M3.5 14l4-3.5 3 2.5 3-3 3 3" /></I>;
export const IconCode = () => <I size={16}><path d="M7.5 6L3.5 10l4 4M12.5 6l4 4-4 4" /></I>;
export const IconTable = () => <I size={16}><rect x="3" y="4" width="14" height="12" rx="1.5" /><path d="M3 8.5h14M3 12.3h14M8.5 4v12" /></I>;
export const IconChart = () => <I><path d="M4 16V9M10 16V4M16 16v-5" /></I>;
// Gear/cog (24-grid path scaled to the 20 grid), deliberately not sun-like so it cannot read as a theme toggle.
export const IconSettings = () => <I testid="settings-icon-gear"><g transform="scale(.8333)" stroke-width="1.9"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" /></g></I>;
export const IconTrash = () => <I><path d="M4 6h12M8 6V4h4v2M6 6l.7 10h6.6L14 6" /></I>;
export const IconAlert = () => <I size={16}><path d="M10 3l8 14H2z" /><path d="M10 8v4M10 14.5v.1" /></I>;
export const IconSpark = () => <I size={28}><path d="M10 3v4M10 13v4M3 10h4M13 10h4M5.2 5.2l2.4 2.4M12.4 12.4l2.4 2.4M5.2 14.8l2.4-2.4M12.4 7.6l2.4-2.4" /></I>;
export const IconDown = () => <I size={16}><path d="M10 4v11M5 11l5 5 5-5" /></I>;
export const IconMenu = () => <I testid="menu-icon"><path d="M3.5 6h13M3.5 10h9M3.5 14h11" /></I>;
export const IconTheme = () => <I><circle cx="10" cy="10" r="6.5" /><path d="M10 3.5v13" /><path d="M10 3.5a6.5 6.5 0 010 13z" fill="currentColor" stroke="none" /></I>;
export const IconInfo = () => <I><circle cx="10" cy="10" r="7" /><path d="M10 9v5M10 6.4v.1" /></I>;
// ---- shell (drawer / start screen / settings) ----
export const IconCompose = () => <I><path d="M9 4H5.5A1.5 1.5 0 004 5.5v9A1.5 1.5 0 005.5 16h9a1.5 1.5 0 001.5-1.5V11" /><path d="M14.3 3.7a1.4 1.4 0 012 2L10 12l-2.6.6.6-2.6z" /></I>;
export const IconClose = () => <I><path d="M5 5l10 10M15 5L5 15" /></I>;
export const IconChat = () => <I><path d="M4 14.5V6.5A2.5 2.5 0 016.5 4h7A2.5 2.5 0 0116 6.5v5a2.5 2.5 0 01-2.5 2.5H8l-4 3z" /></I>;
export const IconCloud = () => <I><path d="M6 15.5h8a3.5 3.5 0 00.4-7A4.5 4.5 0 005.7 9.2 3.2 3.2 0 006 15.5z" /></I>;
export const IconAgent = () => <I><rect x="4.5" y="6.5" width="11" height="9" rx="2.5" /><path d="M10 3.5v3M8 11h.1M12 11h.1" /></I>;
export const IconDesktop = () => <I><rect x="3" y="4" width="14" height="9.5" rx="1.5" /><path d="M7.5 16.5h5M10 13.5v3" /></I>;
export const IconRemote = () => <I><path d="M4.5 6.5l3.5 3.5-3.5 3.5M10 14h5.5" /></I>;
export const IconSlash = () => <I><rect x="3.5" y="3.5" width="13" height="13" rx="3" /><path d="M11.5 7l-3 6" /></I>;
export const IconUser = () => <I><circle cx="10" cy="7.5" r="3" /><path d="M4.5 16.5a5.5 5.5 0 0111 0" /></I>;
export const IconBell = () => <I><path d="M5.5 13.5V9a4.5 4.5 0 019 0v4.5l1 1.5h-11z" /><path d="M8.5 17h3" /></I>;
export const IconSignOut = () => <I><path d="M8 4H5.5A1.5 1.5 0 004 5.5v9A1.5 1.5 0 005.5 16H8M12.5 6.5L16 10l-3.5 3.5M16 10H8" /></I>;
export const IconModels = () => <I><rect x="5" y="5" width="10" height="10" rx="2" /><path d="M8 2.5V5M12 2.5V5M8 15v2.5M12 15v2.5M2.5 8H5M2.5 12H5M15 8h2.5M15 12h2.5" /></I>;
export const IconVideo = () => <I size={16}><rect x="2.5" y="5" width="11" height="10" rx="2" /><path d="M13.5 9l4-2.5v7l-4-2.5" /></I>;
export const IconLock = () => <I size={14}><rect x="4.5" y="9" width="11" height="7.5" rx="2" /><path d="M7 9V6.5a3 3 0 016 0V9" /></I>;
export const IconDoc = () => <I><path d="M5 2.5h6l4 4v11H5z" /><path d="M11 2.5v4h4M7.5 11h5M7.5 14h5" /></I>;
export const IconSidebar = () => <I testid="sidebar-icon"><rect x="3" y="4" width="14" height="12" rx="2.5" /><path d="M8 4v12" /></I>;
export const IconSearch = () => <I><circle cx="9" cy="9" r="5" /><path d="M13 13l4 4" /></I>;
export const IconPin = () => <I size={16}><path d="M7 3h6l-1 5 3 3H5l3-3-1-5zM10 11v6" /></I>;
export const IconDownload = () => <I size={16}><path d="M10 3.5v9M6 9l4 4 4-4M4 16h12" /></I>;

export const IconFolder = () => <I><path d="M3 5.5A1.5 1.5 0 014.5 4H8l2 2.5h5.5A1.5 1.5 0 0117 8v7a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 013 15z" /></I>;
export const IconPlay = () => <I><path d="M7 4.5v11l9-5.5z" /></I>;
export const IconLibrary = () => <I><rect x="3" y="3.5" width="14" height="13" rx="2" /><circle cx="7.5" cy="8" r="1.3" /><path d="M3.5 14l4-3.5 3 2.5 2.5-2 3.5 3" /></I>;

// Menu-regroup icons (menu2): each Settings row / group has its own glyph.
export const IconGrid = () => <I><rect x="3.5" y="3.5" width="5.5" height="5.5" rx="1.4" /><rect x="11" y="3.5" width="5.5" height="5.5" rx="1.4" /><rect x="3.5" y="11" width="5.5" height="5.5" rx="1.4" /><rect x="11" y="11" width="5.5" height="5.5" rx="1.4" /></I>;
export const IconPlug = () => <I><path d="M7.5 3v4M12.5 3v4M5.5 7h9v2.5a4.5 4.5 0 01-9 0zM10 14v3" /></I>;
export const IconShield = () => <I><path d="M10 3l6 2.2v4.6c0 3.4-2.4 5.8-6 7.2-3.6-1.4-6-3.8-6-7.2V5.2z" /><path d="M7.4 10l1.9 1.9 3.3-3.6" /></I>;
export const IconBranch = () => <I><circle cx="5.5" cy="5" r="1.6" /><circle cx="5.5" cy="15" r="1.6" /><circle cx="14.5" cy="8" r="1.6" /><path d="M5.5 6.6v6.8M14.5 9.6c0 2.6-3 2.4-9 4" /></I>;
export const IconBolt = () => <I><path d="M11 2.8L5 11h4.2L8.4 17.2 15 8.6h-4.3z" /></I>;
export const IconDevices = () => <I><rect x="2.5" y="5" width="10.5" height="7.5" rx="1.4" /><path d="M5.5 15h4.5M7.7 12.5V15" /><rect x="14.2" y="8" width="3.3" height="6.5" rx="1" /></I>;
export const IconSwap = () => <I><path d="M4 7h11M12 4l3 3-3 3M16 13H5M8 10l-3 3 3 3" /></I>;
export const IconCoin = () => <I><circle cx="10" cy="10" r="6.8" /><path d="M12.2 7.8c-.4-.8-1.2-1.2-2.2-1.2-1.3 0-2.1.6-2.1 1.5 0 2.1 4.4 1 4.4 3.1 0 .9-.9 1.5-2.2 1.5-1 0-1.9-.4-2.3-1.3M10 5v1.6M10 13.4V15" /></I>;
