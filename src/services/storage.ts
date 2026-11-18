import { createWriteStream, mkdirSync } from "node:fs";
import { open, readFile, rename, rm, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { finished } from "node:stream/promises";
import { Readable } from "node:stream";
import { resolveInside, sanitizeFilename } from "../lib/fsSafe.js";

export interface Storage {
  putRaw(id: string, bytes: Buffer): Promise<string>;
  putAttachment(messageId: string, partIndex: number, filename: string, bytes: Buffer): Promise<string>;
  putHtml(id: string, html: string): Promise<string>;
  read(path: string): Promise<Buffer>;
  delete(path: string): Promise<void>;
  sweepTmp(): Promise<void>;
}

function dateParts(now = new Date()): [string, string, string] {
  const iso = now.toISOString();
  return [iso.slice(0, 4), iso.slice(5, 7), iso.slice(8, 10)];
}

async function writeAtomic(root: string, relative: string, bytes: Buffer): Promise<string> {
  const target = resolveInside(root, relative);
  const tmp = resolveInside(root, "tmp", `${randomUUID()}.part`);
  mkdirSync(path.dirname(target), { recursive: true });
  mkdirSync(path.dirname(tmp), { recursive: true });

  const handle = await open(tmp, "w");
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, target);
  return target;
}

export function createLocalStorage(root: string): Storage {
  const resolvedRoot = path.resolve(root);

  return {
    async putRaw(id, bytes) {
      const [year, month, day] = dateParts();
      return writeAtomic(resolvedRoot, path.join("raw", year, month, day, `${sanitizeFilename(id)}.eml`), bytes);
    },

    async putAttachment(messageId, partIndex, filename, bytes) {
      const safeMessage = sanitizeFilename(messageId);
      const safeName = sanitizeFilename(filename);
      return writeAtomic(resolvedRoot, path.join("att", safeMessage, `${partIndex}_${safeName}`), bytes);
    },

    async putHtml(id, html) {
      return writeAtomic(resolvedRoot, path.join("html", `${sanitizeFilename(id)}.html`), Buffer.from(html, "utf8"));
    },

    async read(target) {
      return readFile(resolveInside(resolvedRoot, path.relative(resolvedRoot, path.resolve(target))));
    },

    async delete(target) {
      const inside = resolveInside(resolvedRoot, path.relative(resolvedRoot, path.resolve(target)));
      await rm(inside, { force: true });
    },

    async sweepTmp() {
      const { readdir } = await import("node:fs/promises");
      const tmpDir = path.join(resolvedRoot, "tmp");
      mkdirSync(tmpDir, { recursive: true });
      for (const entry of await readdir(tmpDir)) {
        await unlink(path.join(tmpDir, entry)).catch(() => undefined);
      }
    },
  };
}

export async function streamToFile(destination: string, stream: Readable): Promise<void> {
  mkdirSync(path.dirname(destination), { recursive: true });
  await finished(Readable.from(stream).pipe(createWriteStream(destination)));
}