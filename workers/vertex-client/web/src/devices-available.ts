import { useEffect, useState } from "preact/hooks";
import { listDevices } from "./devices-api";

/** Is the Devices feature on for this account? The same probe the Settings row always used: 200 = yes; 404 (flag off / not Business or main), 403, a failure = no.
 *  Only asked when `eligible` (Erich, Business space, not a team session), so other accounts never call the endpoint. */
export const probeDevices = (): Promise<boolean> => listDevices().then((r) => r.status === 200, () => false);
export function useDevicesAvailable(eligible: boolean): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!eligible) { setOn(false); return; }
    let live = true;
    void probeDevices().then((v) => { if (live) setOn(v); });
    return () => { live = false; };
  }, [eligible]);
  return eligible && on;
}
