import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import type { FilePayload } from "@claude-telegram-hub/protocol";

/** A small extension→MIME map for outbound files; unknown extensions fall back. */
const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".html": "text/html",
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
};

export function mimeFromExtension(filename: string): string {
  return MIME_BY_EXT[extname(filename).toLowerCase()] ?? "application/octet-stream";
}

/** Keep a filename to a safe basename — no directory parts, no odd characters. */
function safeName(name: string): string {
  return basename(name).replace(/[^A-Za-z0-9._-]/g, "_") || "file";
}

/**
 * Read a local file for sending out through the hub, base64-encoding its bytes.
 * Throws if the file exceeds `maxBytes` (checked after read; the caller sizes the
 * limit from config). The MIME type is inferred from the extension.
 */
export async function readOutboundFile(path: string, maxBytes: number): Promise<FilePayload> {
  const bytes = await readFile(path);
  if (bytes.length > maxBytes) {
    const mb = (bytes.length / (1024 * 1024)).toFixed(1);
    const limit = Math.round(maxBytes / (1024 * 1024));
    throw new Error(`file is ${mb} MB, over the ${limit} MB limit`);
  }
  const filename = basename(path);
  return {
    filename,
    mimeType: mimeFromExtension(filename),
    dataBase64: bytes.toString("base64"),
  };
}

/**
 * Write an inbound file's bytes to a per-agent temp directory and return the
 * absolute path, so the session can open it locally. The name is randomized (to
 * avoid collisions) and sanitized (to prevent path traversal from the sender).
 */
export async function materializeInboundFile(agent: string, file: FilePayload): Promise<string> {
  const dir = join(tmpdir(), "claude-telegram-hub", safeName(agent));
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${randomUUID()}-${safeName(file.filename)}`);
  await writeFile(path, Buffer.from(file.dataBase64, "base64"));
  return path;
}
