/**
 * Shared PPCS LAN lookup targeting for camera and HomeBase sessions.
 *
 * Session owners supply any private address retained from current inventory.
 * This module only builds bounded UDP destinations and owns no socket, retry,
 * credential, or device state.
 */

const LOCAL_LOOKUP_PORT = 32_108;

/** Enumerate the advertised UDP port and the bounded NAT-remap neighbourhood used by PPCS. */
export function ppcsCandidatePorts(port: number): number[] {
  const ports: number[] = [];
  for (let candidate = port - 3; candidate <= port + 3; candidate++) {
    if (candidate > 0 && candidate <= 65_535) ports.push(candidate);
  }
  return ports;
}

/** Build broadcast and current-inventory directed targets for a local PPCS lookup. */
export function ppcsLocalLookupTargets(
  localAddress?: string | null,
): Array<{ readonly host: string; readonly port: number }> {
  return [
    { host: "255.255.255.255", port: LOCAL_LOOKUP_PORT },
    ...(localAddress ? [{ host: localAddress, port: LOCAL_LOOKUP_PORT }] : []),
  ];
}
