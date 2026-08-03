/**
 * Protocol version negotiated at registration.
 *
 * The hub and the channel ship on independent clocks (a hub upgraded in a
 * container while older plugins sit on developer machines), so the register
 * handshake carries this major version and the hub enforces compatibility.
 *
 * Compatibility rule (v1): the major version must match **exactly**. Minor,
 * backward-compatible additions live within a major and do not bump it; any
 * breaking change to the wire protocol increments the major and requires both
 * sides to upgrade.
 */
export const PROTOCOL_VERSION = 1 as const;

/**
 * True when a peer's protocol major version is compatible with ours.
 * v1 requires an exact major match; mismatches are rejected at registration.
 */
export function isProtocolCompatible(
  peerVersion: number,
  selfVersion: number = PROTOCOL_VERSION,
): boolean {
  return Number.isInteger(peerVersion) && peerVersion === selfVersion;
}
