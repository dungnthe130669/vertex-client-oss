// The desktop app's install id (docs/vertex-client-devices-v2.md section 5): random, not a secret, grants nothing. It rides on the pairing code minted by "Add this device" and is sent as `x-vc-install` on the device list,
// so the server can mark the row that belongs to THIS app install. Storage unusable => null => no header and no badge (never a guess).
const KEY = "vc:install";
const OK = /^[0-9a-f]{32}$/;
export function installId(st: Pick<Storage, "getItem" | "setItem"> | undefined = typeof localStorage === "undefined" ? undefined : localStorage): string | null {
  try {
    if (!st) return null;
    const cur = st.getItem(KEY);
    if (cur && OK.test(cur)) return cur;
    const b = new Uint8Array(16); crypto.getRandomValues(b);
    const id = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    st.setItem(KEY, id);
    return id;
  } catch { return null; }
}
