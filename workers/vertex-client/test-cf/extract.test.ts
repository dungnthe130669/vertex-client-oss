import { expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { extractOffice } from "../src/extract";

// fflate bundles and runs under workerd (the real runtime), and a worst-case-allowed 10 MB docx (22 MB of XML) extracts without blowing up.
// CPU time inside miniflare is only indicative: workerd enforces no CPU limit locally, production limits are an account/plan setting.
it("extracts a ~10 MB docx inside workerd", () => {
  const words = Array.from({ length: 5000 }, (_, i) => Math.random().toString(36).slice(2, 5 + (i % 8)));
  const parts: string[] = []; let size = 0;
  while (size < 22e6) { let p = "<w:p><w:r><w:t>"; for (let k = 0; k < 40; k++) p += words[(Math.random() * 5000) | 0] + " "; p += "</w:t></w:r></w:p>"; parts.push(p); size += p.length; }
  const z = zipSync({ "word/document.xml": strToU8(`<w:document><w:body>${parts.join("")}</w:body></w:document>`) });
  const t = performance.now();
  const out = extractOffice(z, "docx");
  const ms = Math.round(performance.now() - t);
  console.log(`workerd docx ${z.length} bytes -> ${out.length} chars in ${ms} ms`);
  expect(z.length).toBeLessThanOrEqual(10 * 1024 * 1024 + 500_000);
  expect(out).toMatch(/\[truncated \d+ bytes\]$/);
});
