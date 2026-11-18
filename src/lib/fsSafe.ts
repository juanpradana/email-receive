import path from "node:path";

const WINDOWS_RESERVED = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

export function sanitizeFilename(name: string): string {
  const base = path.basename(name.replace(/\\/g, "/")).normalize("NFC");
  let cleaned = base.replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_").replace(/\.+$/g, "").trim();
  if (!cleaned || cleaned === "." || cleaned === "..") cleaned = "attachment";
  const stem = cleaned.split(".")[0]!.toLowerCase();
  if (WINDOWS_RESERVED.has(stem)) cleaned = `${cleaned}_file`;
  return cleaned.slice(0, 180);
}

/**
 * RFC 6266 Content-Disposition value: an ASCII-only fallback for old clients
 * plus the exact UTF-8 name in `filename*`. Non-ASCII bytes in the quoted
 * `filename` would make Node reject the header and turn a download into a 500.
 */
export function contentDisposition(name: string, disposition: "attachment" | "inline" = "attachment"): string {
  const safe = sanitizeFilename(name);
  const ascii = safe.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "attachment";
  const encoded = encodeURIComponent(safe).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export function resolveInside(root: string, ...parts: string[]): string {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...parts);
  const relative = path.relative(resolvedRoot, target);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return target;
  }
  throw new Error(`Path escapes data directory: ${parts.join("/")}`);
}