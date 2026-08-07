import { describe, it, expect } from "vitest";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  materializeInboundFile,
  mimeFromExtension,
  readOutboundFile,
} from "../src/index.js";

describe("mimeFromExtension", () => {
  it("maps known extensions and falls back for unknown ones", () => {
    expect(mimeFromExtension("a.png")).toBe("image/png");
    expect(mimeFromExtension("A.JPG")).toBe("image/jpeg");
    expect(mimeFromExtension("notes.pdf")).toBe("application/pdf");
    expect(mimeFromExtension("data.bin")).toBe("application/octet-stream");
    expect(mimeFromExtension("noext")).toBe("application/octet-stream");
  });
});

describe("readOutboundFile", () => {
  it("reads a file into a base64 payload with an inferred mime type", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cth-out-"));
    try {
      const path = join(dir, "hello.txt");
      await writeFile(path, "hello world");
      const payload = await readOutboundFile(path, 1024);
      expect(payload.filename).toBe("hello.txt");
      expect(payload.mimeType).toBe("text/plain");
      expect(Buffer.from(payload.dataBase64, "base64").toString()).toBe("hello world");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a file over the size limit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cth-out-"));
    try {
      const path = join(dir, "big.bin");
      await writeFile(path, Buffer.alloc(2048));
      await expect(readOutboundFile(path, 1024)).rejects.toThrow(/over the/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("materializeInboundFile", () => {
  it("writes bytes to a local path the session can open", async () => {
    const path = await materializeInboundFile("re-infra", {
      filename: "shot.png",
      mimeType: "image/png",
      dataBase64: Buffer.from("PNG-BYTES").toString("base64"),
    });
    try {
      expect(path).toContain("claude-telegram-hub");
      expect(path.endsWith("shot.png")).toBe(true);
      expect((await readFile(path)).toString()).toBe("PNG-BYTES");
    } finally {
      await rm(path, { force: true });
    }
  });

  it("sanitizes a hostile filename (no path traversal)", async () => {
    const path = await materializeInboundFile("re-infra", {
      filename: "../../etc/passwd",
      mimeType: "text/plain",
      dataBase64: Buffer.from("x").toString("base64"),
    });
    try {
      expect(path).not.toContain("..");
      expect(path.endsWith("passwd")).toBe(true);
    } finally {
      await rm(path, { force: true });
    }
  });
});
