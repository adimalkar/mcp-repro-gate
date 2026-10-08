import { BlockList, isIP } from "node:net";

// Addresses a research fetch must never reach: loopback, private and
// link-local networks, shared and benchmark space, documentation ranges,
// multicast, broadcast, and reserved or transition ranges.
const blocked = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const)
  blocked.addSubnet(network, prefix, "ipv6");

// IPv4 carried inside IPv6 (mapped ::ffff:a.b.c.d and NAT64 64:ff9b::/96)
// is judged by its embedded IPv4 address.
function embeddedIpv4(address: string): string | undefined {
  const lower = address.toLowerCase();
  for (const prefix of ["::ffff:", "64:ff9b::"]) {
    if (!lower.startsWith(prefix)) continue;
    const tail = lower.slice(prefix.length);
    if (isIP(tail) === 4) return tail;
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(tail);
    if (hex?.[1] !== undefined && hex[2] !== undefined) {
      const high = Number.parseInt(hex[1], 16);
      const low = Number.parseInt(hex[2], 16);
      return [high >> 8, high & 255, low >> 8, low & 255].join(".");
    }
  }
  return undefined;
}

/** Whether a resolved IP address is outside what research may fetch. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  if (family === 4) return blocked.check(address, "ipv4");
  const embedded = embeddedIpv4(address);
  if (embedded !== undefined) return blocked.check(embedded, "ipv4");
  // Any other address inside the mapped or NAT64 prefixes is malformed.
  const lower = address.toLowerCase();
  if (lower.startsWith("::ffff:") || lower.startsWith("64:ff9b::")) return true;
  return blocked.check(address, "ipv6");
}
