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

export function resolveInside(root: string, ...parts: string[]): string {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...parts);
  const relative = path.relative(resolvedRoot, target);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return target;
  }
  throw new Error(`Path escapes data directory: ${parts.join("/")}`);
}