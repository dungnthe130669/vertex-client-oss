import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { navKey } from "../web/src/shell-logic";
import { DIFF_MAX_LINES, PRESET_WIDTH, SVG_MAX_BYTES, diffStats, downloadMeta, latestArtifactVersion, lineDiff, noteArtifactVersion, subscribeArtifactVersions, viewRows, parseArtifactResult, previewLines, relTime, stepVersion, svgOk } from "../web/src/artifacts-logic";

const web = (f: string) => readFileSync(new URL(`../web/src/${f}`, import.meta.url), "utf8");
const ID = "0b9f8c1e-1111-4222-8333-444455556666";
const res = (o: unknown) => JSON.stringify(o);

describe("parseArtifactResult (chat card)", () => {
  test("accepts exactly the server's shape for the two artifact tools only", () => {
    const ok = res({ artifact: { id: ID, title: "Plan", type: "markdown", version: 2 } });
    expect(parseArtifactResult("create_artifact", ok)).toEqual({ id: ID, title: "Plan", type: "markdown", version: 2 });
    expect(parseArtifactResult("update_artifact", ok)?.version).toBe(2);
    expect(parseArtifactResult("search_notes", ok)).toBeNull(); // another tool cannot spoof a card
    expect(parseArtifactResult("create_artifact", "not json")).toBeNull();
    expect(parseArtifactResult("create_artifact", res({ artifact: { id: "../x", title: "t", type: "svg", version: 1 } }))).toBeNull();
    expect(parseArtifactResult("create_artifact", res({ artifact: { id: ID, title: "t", type: "pdf", version: 1 } }))).toBeNull();
    expect(parseArtifactResult("create_artifact", res({ artifact: { id: ID, title: "t", type: "html", version: 1 } }))?.type).toBe("html");
    expect(parseArtifactResult("create_artifact", res({ artifact: { id: ID, title: "t", type: "svg", version: "1" } }))).toBeNull();
    expect(parseArtifactResult("create_artifact", "artifact limit reached")).toBeNull();
  });
  test("title is clamped", () => expect(parseArtifactResult("create_artifact", res({ artifact: { id: ID, title: "x".repeat(500), type: "code", version: 1 } }))!.title.length).toBe(120));
});

describe("gallery helpers", () => {
  const now = Date.parse("2026-10-20T12:00:00.000Z");
  test("relTime", () => {
    expect(relTime("2026-10-20T11:59:50.000Z", now)).toBe("just now");
    expect(relTime("2026-10-20T11:55:00.000Z", now)).toBe("5m ago");
    expect(relTime("2026-10-20T09:00:00.000Z", now)).toBe("3h ago");
    expect(relTime("2026-10-14T12:00:00.000Z", now)).toBe("6d ago");
    expect(relTime("2026-01-01T00:00:00.000Z", now)).toBe("2026-01-01");
    expect(relTime("garbage", now)).toBe("");
  });
  test("previewLines keeps at most 6 lines", () => expect(previewLines("1\n2\n3\n4\n5\n6\n7\n8").split("\n")).toEqual(["1", "2", "3", "4", "5", "6"]));
  test("stepVersion clamps at both ends and skips pruned versions", () => {
    expect(stepVersion(3, [1, 2, 3], -1)).toBe(2);
    expect(stepVersion(1, [1, 2, 3], -1)).toBe(1);
    expect(stepVersion(3, [1, 2, 3], 1)).toBe(3);
    expect(stepVersion(6, [6, 9, 10], 1)).toBe(9);
  });
  test("svgOk: size cap and must contain <svg", () => {
    expect(svgOk("<svg></svg>")).toBe(true);
    expect(svgOk("<div>")).toBe(false);
    expect(svgOk("<svg>" + "a".repeat(SVG_MAX_BYTES))).toBe(false);
  });
  test("/artifacts and /artifacts/:id highlight the Artifacts drawer row", () => {
    expect(navKey("/artifacts")).toBe("artifacts");
    expect(navKey(`/artifacts/${ID}`)).toBe("artifacts");
    expect(navKey("/skills")).toBe("skills");
  });
});

// The DOM is not available in bun, so the rendering rules are pinned at the source: this is the guard that "svg never inline / never innerHTML of raw content".
describe("rendering rules (source guard)", () => {
  const src = web("artifacts.tsx");
  test("the only innerHTML is the sanitized markdown renderer's output", () => {
    const uses = [...src.matchAll(/dangerouslySetInnerHTML/g)];
    expect(uses.length).toBe(1);
    expect(src).toMatch(/dangerouslySetInnerHTML=\{\{ __html: renderMarkdown\(a\.content\) \}\}/);
    expect(src).not.toMatch(/\.innerHTML\s*=|insertAdjacentHTML|outerHTML|document\.write|srcdoc|<object|<embed/i);
  });
  test("svg is shown only through <img src=blob:> built from a Blob with the svg+xml type", () => {
    expect(src).toContain("URL.createObjectURL(new Blob([content], { type: \"image/svg+xml\" }))");
    expect(src).toMatch(/<img src=\{url\}/);
    expect(src).toContain("URL.revokeObjectURL");
    expect(src).not.toMatch(/<svg\b/); // no inline <svg> element carrying model content in this file
  });
  test("code is rendered as text children of <pre><code>, never as HTML", () => expect(src).toContain("<pre data-testid=\"artifact-code\"><code>{a.content}</code></pre>"));
  test("every artifact mutation is inside withBusy", () => {
    for (const fn of ["deleteArtifact", "undeleteArtifact", "restoreArtifact"]) {
      const t = src.split("\n").filter((l) => !l.startsWith("import ")).join("\n");
      const calls = [...t.matchAll(new RegExp(`(?<![\\w.])${fn}\\(`, "g"))];
      expect(calls.length).toBeGreaterThan(0);
      for (const m of calls) expect(t.slice(Math.max(0, m.index! - 90), m.index!)).toContain("withBusy(");
    }
  });
  test("the chat card is the only chat.tsx hook: built from parseArtifactResult, no raw result HTML", () => {
    const chat = web("chat.tsx");
    expect(chat).toContain("parseArtifactResult(b.name, result.text)");
    expect(chat).toContain("<ArtifactCard {...art} />");
  });
  test("html artifacts: exactly one <iframe>, sandbox=\"allow-scripts\" and nothing else, a minted /af/ URL, no message listener", () => {
    expect([...src.matchAll(/<iframe/g)].length).toBe(1);
    const tag = /<iframe[^>]*>/.exec(src)![0];
    expect(tag).toContain('sandbox="allow-scripts"');
    expect(tag).toContain('referrerpolicy="no-referrer"');
    expect(tag).toContain("src={src}");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, ""); // comments may name the forbidden tokens
    expect(code).not.toMatch(/allow-same-origin|allow-popups|allow-forms|allow-top-navigation|allow-modals/);
    expect(code).not.toMatch(/addEventListener\(\s*["']message|onmessage|postMessage/); // nothing from the frame is trusted
    expect(src).toContain("viewArtifact(a.id, a.shown)");
  });
  test("app CSP: frame-src 'self' added, no script/style loosening, no blob in script-src", () => {
    const h = readFileSync(new URL("../src/headers.ts", import.meta.url), "utf8");
    expect(h).toMatch(/worker-src 'self'; frame-src 'self'; frame-ancestors 'none'/);
    expect(h).toMatch(/script-src 'self';/);
    expect(h).toMatch(/style-src 'self';/);
  });
});

describe("lineDiff (LCS)", () => {
  const apply = (ops: NonNullable<ReturnType<typeof lineDiff>>, side: "old" | "new") => ops.filter((o) => o.t === "eq" || o.t === (side === "old" ? "del" : "add")).map((o) => o.line).join("\n");
  test("identical text is all eq", () => expect(lineDiff("a\nb", "a\nb")!.every((o) => o.t === "eq")).toBe(true));
  test("add, delete and change", () => {
    expect(lineDiff("a\nb\nc", "a\nc")!.map((o) => o.t + o.line)).toEqual(["eqa", "delb", "eqc"]);
    expect(lineDiff("a\nc", "a\nb\nc")!.map((o) => o.t + o.line)).toEqual(["eqa", "addb", "eqc"]);
    expect(diffStats(lineDiff("one\ntwo\nthree", "one\n2\nthree")!)).toEqual({ add: 1, del: 1 });
  });
  test("reconstructs both sides for scrambled input", () => {
    const a = "x\ny\nz\nw\nq", b = "y\nq\nz\nn\nw\nx";
    const ops = lineDiff(a, b)!;
    expect(apply(ops, "old")).toBe(a);
    expect(apply(ops, "new")).toBe(b);
  });
  test("empty sides", () => {
    expect(lineDiff("", "a")!.map((o) => o.t)).toEqual(["del", "add"]); // "" is one empty line
    expect(diffStats(lineDiff("a\nb", "a\nb\nc\nd")!)).toEqual({ add: 2, del: 0 });
  });
  test("refuses an oversized middle instead of freezing", () => {
    const big = (p: string) => Array.from({ length: DIFF_MAX_LINES + 1 }, (_, i) => p + i).join("\n");
    expect(lineDiff(big("a"), big("b"))).toBeNull();
    expect(lineDiff("a\nb\nc\nd", "d\nc\nb\na", 4)).toBeNull();
  });
});

describe("download / gallery / viewport / live card helpers", () => {
  test("downloadMeta: extension and mime per type", () => {
    expect(downloadMeta({ title: "My Plan!", type: "markdown" })).toEqual({ name: "My-Plan.md", mime: "text/markdown;charset=utf-8" });
    expect(downloadMeta({ title: "Logo", type: "svg" })).toEqual({ name: "Logo.svg", mime: "image/svg+xml" });
    expect(downloadMeta({ title: "Page", type: "html" }).name).toBe("Page.html");
    expect(downloadMeta({ title: "s", type: "code", language: "Python" })).toEqual({ name: "s.py", mime: "text/plain;charset=utf-8" });
    expect(downloadMeta({ title: "s", type: "code", language: "weird" }).name).toBe("s.txt");
    expect(downloadMeta({ title: "../../etc/passwd", type: "code", language: null }).name).toBe("etcpasswd.txt");
    expect(downloadMeta({ title: "???", type: "markdown" }).name).toBe("artifact.md");
  });
  test("viewRows filters by type and sorts", () => {
    const r = [{ type: "code", title: "b", updatedAt: "2026-01-02T00:00:00Z" }, { type: "svg", title: "A", updatedAt: "2026-01-03T00:00:00Z" }, { type: "code", title: "c", updatedAt: "2026-01-01T00:00:00Z" }];
    expect(viewRows(r, "code", "recent").map((x) => x.title)).toEqual(["b", "c"]);
    expect(viewRows(r, "all", "name").map((x) => x.title)).toEqual(["A", "b", "c"]);
    expect(viewRows(r, "html", "recent")).toEqual([]);
  });
  test("viewport presets", () => expect(PRESET_WIDTH).toEqual({ mobile: "390px", tablet: "768px", desktop: "100%" }));
  test("noteArtifactVersion only moves forward and notifies", () => {
    let n = 0;
    const off = subscribeArtifactVersions(() => n++);
    noteArtifactVersion("zz", 2); noteArtifactVersion("zz", 1); noteArtifactVersion("zz", 3);
    off(); noteArtifactVersion("zz", 4);
    expect(n).toBe(2);
    expect(latestArtifactVersion("zz", 1)).toBe(4);
    expect(latestArtifactVersion("other", 5)).toBe(5);
  });
});

describe("polish rendering rules (source guard)", () => {
  const src = web("artifacts.tsx");
  test("html frame stays sandboxed: no Open-in-new-tab, no window.open / target=_blank", () => {
    expect(src).not.toMatch(/window\.open|target=["']_blank|Open in new tab/i);
  });
  test("downloads go through a Blob URL with a download attribute only", () => {
    expect(src).toContain("new Blob([a.content], { type: mime })");
    expect(src).toContain("l.download = name");
  });
  test("viewport preset is set through CSSOM on the container, not the frame", () => {
    expect(src).toContain("box.current.style.width = PRESET_WIDTH[preset]");
    expect(src).not.toMatch(/style=\{/);
  });
});
