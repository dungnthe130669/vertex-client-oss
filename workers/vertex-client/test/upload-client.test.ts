import { describe, expect, test } from "bun:test";
import { chipKind, fitWithin, imageRefusal, prepareFile, tokensLabel } from "../web/src/upload";

describe("client upload prep (non-image)", () => {
  test("code with a vague mime is retyped by extension; PDF/office pass through", async () => {
    const py = await prepareFile(new File(["x=1"], "a.py", { type: "" }));
    expect(py.blob.type).toBe("text/x-python");
    const docx = await prepareFile(new File(["PK"], "a.docx", { type: "application/octet-stream" }));
    expect(docx.blob.type).toContain("wordprocessingml");
    const pdf = new File(["%PDF"], "a.pdf", { type: "application/pdf" });
    expect((await prepareFile(pdf)).blob).toBe(pdf);
  });
  test("unsupported and oversize are refused before any upload", async () => {
    await expect(prepareFile(new File(["x"], "a.exe", { type: "application/octet-stream" }))).rejects.toThrow("unsupported file type");
    await expect(prepareFile(new File(["x"], "a.mp3", { type: "audio/mpeg" }))).rejects.toThrow("no audio, video or zip");
    await expect(prepareFile(new File([new Uint8Array(2 * 1024 * 1024 + 1)], "big.txt", { type: "text/plain" }))).rejects.toThrow("2 MB");
  });
  test("chip icon kind + token label", () => {
    expect(chipKind("image/png", "a.png")).toBe("image");
    expect(chipKind("application/pdf", "a.pdf")).toBe("pdf");
    expect(chipKind("text/csv", "a.csv")).toBe("sheet");
    expect(chipKind("text/x-python", "a.py")).toBe("code");
    expect(chipKind("text/plain", "notes.txt")).toBe("doc");
    expect(chipKind("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "a.xlsx")).toBe("sheet");
    expect(tokensLabel(undefined)).toBe("");
    expect(tokensLabel(850)).toBe("~850 tok");
    expect(tokensLabel(12_000)).toBe("~12k tok");
    expect(tokensLabel(1500)).toBe("~1.5k tok");
  });
});

describe("photo sizing (camera shots)", () => {
  test("a 12 MP phone photo is cut to the long edge, aspect kept, portrait and landscape", () => {
    expect(fitWithin(4032, 3024)).toEqual({ w: 1568, h: 1176 });
    expect(fitWithin(3024, 4032)).toEqual({ w: 1176, h: 1568 });
    expect(fitWithin(4032, 3024, 2048)).toEqual({ w: 2048, h: 1536 });
  });
  test("small images are never upscaled; degenerate sizes stay at least 1px", () => {
    expect(fitWithin(800, 600)).toEqual({ w: 800, h: 600 });
    expect(fitWithin(1568, 1568)).toEqual({ w: 1568, h: 1568 });
    expect(fitWithin(20000, 3)).toEqual({ w: 1568, h: 1 });
  });
});

describe("image paste/drag guard for text-only models", () => {
  test("image refused when the model cannot see images (png, heic), other files pass", () => {
    expect(imageRefusal(false, { type: "image/png", name: "image.png" })).toContain("can't read images");
    expect(imageRefusal(false, { type: "image/heic", name: "shot.heic" })).toContain("can't read images");
    expect(imageRefusal(false, { type: "application/pdf", name: "a.pdf" })).toBeNull();
    expect(imageRefusal(false, { type: "text/plain", name: "a.txt" })).toBeNull();
  });
  test("vision models accept images", () => { expect(imageRefusal(true, { type: "image/png", name: "image.png" })).toBeNull(); });
});
