import { describe, it, expect } from "vitest";
import { PROTOCOL_VERSION, isProtocolCompatible } from "../src/index.js";

describe("protocol version", () => {
  it("is a positive integer", () => {
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
    expect(PROTOCOL_VERSION).toBeGreaterThan(0);
  });

  it("treats an exact major match as compatible", () => {
    expect(isProtocolCompatible(PROTOCOL_VERSION)).toBe(true);
    expect(isProtocolCompatible(PROTOCOL_VERSION, PROTOCOL_VERSION)).toBe(true);
  });

  it("rejects a mismatched or non-integer major", () => {
    expect(isProtocolCompatible(PROTOCOL_VERSION + 1)).toBe(false);
    expect(isProtocolCompatible(0)).toBe(false);
    expect(isProtocolCompatible(1.5, 1)).toBe(false);
  });
});
