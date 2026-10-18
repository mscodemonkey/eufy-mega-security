/**
 * Checks RTC relay and candidate addresses before the trial opens media sockets.
 * The session owns resulting ICE configuration. This pure boundary permits
 * public IP relays and IP-only candidates, including local camera addresses.
 */
import { BlockList, isIP } from "node:net";
import type { RTCIceServer } from "werift";
import { GeneralRtcError } from "./general-rtc-protocol.js";
import { nvrCandidate, nvrRecord } from "./nvr-protocol.js";

const excludedV4 = new BlockList(), excludedV6 = new BlockList(), allocatedV6 = new BlockList();

// Conservative RIR allocations from IANA's IPv6 Global Unicast registry,
// checked 18 Oct 2026. Future allocations fail closed until this list is reviewed.
for (const subnet of ["2001:200::/23", "2001:400::/23", "2001:600::/23", "2001:800::/22", "2001:c00::/23", "2001:e00::/23",
  "2001:1200::/23", "2001:1400::/22", "2001:1800::/23", "2001:1a00::/23", "2001:1c00::/22", "2001:2000::/19",
  "2001:4000::/23", "2001:4200::/23", "2001:4400::/23", "2001:4600::/23", "2001:4800::/23", "2001:4a00::/23",
  "2001:4c00::/23", "2001:5000::/20", "2001:8000::/19", "2001:a000::/20", "2001:b000::/20", "2003::/18",
  "2400::/12", "2410::/12", "2600::/12", "2610::/23", "2620::/23", "2630::/12", "2800::/12", "2a00::/12", "2a10::/12", "2c00::/12"]) {
  const [address, prefix] = subnet.split("/");
  allocatedV6.addSubnet(address!, Number(prefix), "ipv6");
}
for (const subnet of ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16",
  "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.88.99.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24",
  "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4", "::/128", "::1/128", "::ffff:0:0/96", "64:ff9b::/96",
  "100::/64", "2001::/32", "2001:db8::/32", "2002::/16", "fc00::/7", "fe80::/10", "ff00::/8"]) {
  const [address, prefix] = subnet.split("/");
  if (isIP(address!) === 6) excludedV6.addSubnet(address!, Number(prefix), "ipv6");
  else excludedV4.addSubnet(address!, Number(prefix), "ipv4");
}

/** Reject DNS candidates and related addresses without excluding local camera IPs. */
export function generalRtcCandidate(value: unknown): string {
  let candidate: string;
  try { candidate = nvrCandidate(value); }
  catch { throw new GeneralRtcError("offer", "candidate"); }
  const parts = candidate.trim().split(/\s+/);
  if (!isIP(parts[4]!)) throw new GeneralRtcError("offer", "candidate");
  for (let i = 8; i < parts.length; i += 2) {
    if (parts[i] === "raddr" && !isIP(parts[i + 1]!)) throw new GeneralRtcError("offer", "candidate");
  }
  return candidate;
}

/** Convert at most four explicit public IP relays to UDP-only werift configuration. */
export function generalRtcRelays(value: unknown): RTCIceServer[] {
  const rows = Array.isArray(value) ? value : [value];
  if (!rows.length || rows.length > 4) throw new GeneralRtcError("turn", "shape");
  return rows.map(row => {
    if (!nvrRecord(row)) throw new GeneralRtcError("turn", "shape");
    const host = row.turn_addr, port = row.turn_port, username = row.turn_user, credential = row.turn_password;
    if (typeof host !== "string" || !isIP(host)
      || (isIP(host) === 6 ? !allocatedV6.check(host, "ipv6") || excludedV6.check(host, "ipv6") : excludedV4.check(host, "ipv4"))) throw new GeneralRtcError("turn", "turn_address");
    if (typeof port !== "number" && (typeof port !== "string" || !/^[1-9]\d{0,4}$/.test(port))
      || !Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535
      || typeof username !== "string" || !/^[\x20-\x7e]{1,512}$/.test(username)
      || typeof credential !== "string" || !/^[\x20-\x7e]{1,512}$/.test(credential)) throw new GeneralRtcError("turn", "shape");
    return { urls: `turn:${isIP(host) === 6 ? `[${host}]` : host}:${port}?transport=udp`, username, credential };
  });
}
