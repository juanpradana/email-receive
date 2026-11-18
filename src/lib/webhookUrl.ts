import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type AddressResolver = (hostname: string) => Promise<string[]>;

const defaultResolver: AddressResolver = async (hostname) => {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
};

function isPrivateIPv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts as [number, number];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isPrivateIPv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fe80") || normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (mapped) return isPrivateIPv4(mapped[1]!);
  return false;
}

export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPrivateIPv4(address);
  if (version === 6) return isPrivateIPv6(address);
  return true;
}

export function assertWebhookUrlShape(rawUrl: string, allowPrivate: boolean): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("webhook URL is not a valid URL");
  }

  if (url.username || url.password) {
    throw new Error("webhook URL must not contain credentials");
  }

  if (allowPrivate) {
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("webhook URL must use http or https");
    }
    return url;
  }

  if (url.protocol !== "https:") {
    throw new Error("webhook URL must use https");
  }
  if (url.port && url.port !== "443") {
    throw new Error("webhook URL must use the default https port");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error("webhook URL points to a private address");
  }
  if (isIP(hostname) && isPrivateAddress(hostname)) {
    throw new Error("webhook URL points to a private address");
  }
  return url;
}

export async function assertSafeWebhookUrl(
  rawUrl: string,
  allowPrivate: boolean,
  resolve: AddressResolver = defaultResolver,
): Promise<void> {
  const url = assertWebhookUrlShape(rawUrl, allowPrivate);
  if (allowPrivate) return;

  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(hostname)) return;

  const addresses = await resolve(hostname);
  if (addresses.length === 0) throw new Error("webhook host could not be resolved");
  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      throw new Error("webhook URL points to a private address");
    }
  }
}