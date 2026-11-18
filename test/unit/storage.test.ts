import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalStorage } from "../../src/services/storage.js";
import { resolveInside, sanitizeFilename } from "../../src/lib/fsSafe.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "email-receive-storage-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("filename safety", () => {
  it.each([
    "../evil.txt",
    "..\\evil.txt",
    "/abs/evil.txt",
    "C:\\evil.txt",
    "CON",
    "nul.txt",
    "a. ",
    "",
    "../../etc/passwd",
  ])("never resolves %s outside root", (name) => {
    const safe = sanitizeFilename(name);
    const resolved = resolveInside(root, safe);
    expect(resolved === root || resolved.startsWith(root + path.sep)).toBe(true);
    expect(path.relative(root, resolved)).not.toMatch(/^\.\./);
  });

  it("keeps ordinary names readable", () => {
    expect(sanitizeFilename("invoice-2026.pdf")).toBe("invoice-2026.pdf");
  });

  it("rejects traversal in resolveInside", () => {
    expect(() => resolveInside(root, "..", "evil")).toThrow();
  });
});

describe("local storage", () => {
  it("writes raw mail via tmp then rename", async () => {
    const storage = createLocalStorage(root);
    const stored = await storage.putRaw("msg-1", Buffer.from("Subject: Hi\r\n\r\nbody"));
    expect(stored.startsWith(root)).toBe(true);
    expect(readFileSync(stored, "utf8")).toContain("Subject: Hi");
    expect((await readdir(path.join(root, "tmp"))).length).toBe(0);
  });

  it("stores attachments inside the message folder with sanitized names", async () => {
    const storage = createLocalStorage(root);
    const stored = await storage.putAttachment("msg-1", 2, "../../evil.txt", Buffer.from("data"));
    expect(stored.startsWith(path.join(root, "att", "msg-1"))).toBe(true);
    expect(path.basename(stored)).toBe("2_evil.txt");
  });

  it("leaves no file in tmp after sweepTmp", async () => {
    const storage = createLocalStorage(root);
    await storage.putRaw("msg-1", Buffer.from("x"));
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(path.join(root, "tmp"), { recursive: true });
    writeFileSync(path.join(root, "tmp", "abandoned.part"), "junk");
    await storage.sweepTmp();
    expect((await readdir(path.join(root, "tmp"))).length).toBe(0);
  });

  it("refuses to read or delete outside root", async () => {
    const storage = createLocalStorage(root);
    await expect(storage.read(path.join(os.tmpdir(), "outside.txt"))).rejects.toThrow();
    await expect(storage.delete(path.join(os.tmpdir(), "outside.txt"))).rejects.toThrow();
  });
});