import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, parseEmail } from "../../src/services/parse.js";

const fixture = (name: string) => readFile(path.join(process.cwd(), "test/fixtures", name));

describe("parseEmail", () => {
  it("extracts text and subject from a simple mail", async () => {
    const parsed = await parseEmail(await fixture("plain.eml"));
    expect(parsed.subject).toBe("Hello plain");
    expect(parsed.fromAddr).toBe("alice@example.test");
    expect(parsed.fromName).toBe("Alice Example");
    expect(parsed.to).toEqual([{ address: "inbox@example.test", name: "" }]);
    expect(parsed.text).toContain("Plain message body.");
    expect(parsed.messageId).toBe("<plain-1@example.test>");
  });

  it("prefers text/plain and keeps html separately", async () => {
    const parsed = await parseEmail(await fixture("html-alt.eml"));
    expect(parsed.text).toContain("Plain version wins for automation.");
    expect(parsed.html).toContain("<p>HTML version retained.</p>");
    expect(parsed.cc).toEqual([{ address: "ops@example.test", name: "" }]);
  });

  it("extracts two attachments with stable part indexes", async () => {
    const parsed = await parseEmail(await fixture("multipart-attachments.eml"));
    expect(parsed.attachments).toHaveLength(2);
    expect(parsed.attachments.map(({ partIndex }) => partIndex)).toEqual([0, 1]);
    expect(parsed.attachments.map(({ filename }) => filename)).toEqual(["one.txt", "two.bin"]);
    expect(parsed.attachments.map(({ bytes }) => bytes.toString("utf8"))).toEqual(["one file", "two file"]);
  });

  it("decodes quoted-printable latin1 without throwing", async () => {
    const parsed = await parseEmail(await fixture("qp-latin1.eml"));
    expect(parsed.subject).toBe("Olá");
    expect(parsed.text).toContain("Olá, señor.");
  });

  it("returns partial data for broken headers instead of throwing", async () => {
    const parsed = await parseEmail(await fixture("broken-headers.eml"));
    expect(parsed.text).toContain("Body is still useful.");
    expect(parsed.fromAddr).toBeNull();
  });

  it("caps extracted attachment total bytes", async () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(50 * 1024 * 1024);
    const bytes = Buffer.from(
      "From: a@example.test\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=cap\r\n\r\n" +
        "--cap\r\nContent-Type: application/octet-stream; name=big.bin\r\nContent-Disposition: attachment; filename=big.bin\r\nContent-Transfer-Encoding: base64\r\n\r\n" +
        Buffer.alloc(2048, 0x61).toString("base64") +
        "\r\n--cap--\r\n",
    );
    await expect(parseEmail(bytes, { maxAttachmentBytes: 1024 })).rejects.toThrow(/attachment/i);
  });

  it("caps the number of extracted attachments", async () => {
    const parts = Array.from(
      { length: MAX_ATTACHMENTS + 1 },
      (_unused, index) =>
        `--many\r\nContent-Type: text/plain; name="f${index}.txt"\r\nContent-Disposition: attachment; filename="f${index}.txt"\r\n\r\nx\r\n`,
    ).join("");
    const bytes = Buffer.from(
      `From: a@example.test\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=many\r\n\r\n${parts}--many--\r\n`,
    );
    await expect(parseEmail(bytes)).rejects.toThrow(/attachment/i);
  });
});
