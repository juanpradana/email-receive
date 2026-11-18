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

const MAX_HEXTET = 8;

function parseGroups(parts: string[]): number[] | null {
  const groups: number[] = [];
  for (const part of parts) {
    if (part.includes(".")) {
      const octets = part.split(".").map(Number);
      if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
      groups.push((octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    groups.push(parseInt(part, 16));
  }
  return groups;
}

/** Expands any IPv6 literal into eight 16-bit groups; null when malformed. */
export function expandIPv6(address: string): number[] | null {
  const zoneIndex = address.indexOf("%");
  const text = (zoneIndex === -1 ? address : address.slice(0, zoneIndex)).toLowerCase();
  const halves = text.split("::");
  if (halves.length > 2) return null;

  const head = parseGroups(halves[0] ? halves[0].split(":") : []);
  if (!head) return null;
  const tail = halves.length === 2 ? parseGroups(halves[1] ? halves[1].split(":") : []) : [];
  if (!tail) return null;

  if (halves.length === 1) return head.length === MAX_HEXTET ? head : null;

  const zeros = MAX_HEXTET - head.length - tail.length;
  if (zeros < 1) return null;
  return [...head, ...Array.from({ length: zeros }, () => 0), ...tail];
}

function embeddedIPv4(group6: number, group7: number): string {
  return `${group6 >> 8}.${group6 & 0xff}.${group7 >> 8}.${group7 & 0xff}`;
}

function isPrivateIPv6(address: string): boolean {
  const groups = expandIPv6(address);
  if (!groups) return true;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];

  // ::/128 and ::1/128
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) {
    return true;
  }
  // IPv4-compatible ::/96 (deprecated) and IPv4-mapped ::ffff:0:0/96
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0 || g5 === 0xffff)) {
    return isPrivateIPv4(embeddedIPv4(g6, g7));
  }
  // NAT64 64:ff9b::/96
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isPrivateIPv4(embeddedIPv4(g6, g7));
  }
  // 6to4 2002::/16 carries the tunnel endpoint in the next 32 bits
  if (g0 === 0x2002) {
    return isPrivateIPv4(embeddedIPv4(g1, g2));
  }
  // fc00::/7 unique local
  if ((g0 & 0xfe00) === 0xfc00) return true;
  // fe80::/10 link-local and fec0::/10 site-local
  if ((g0 & 0xffc0) === 0xfe80 || (g0 & 0xffc0) === 0xfec0) return true;
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