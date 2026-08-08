import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { HttpSynthesisService } from "../src/index.js";

interface Captured {
  method?: string;
  url?: string;
  body: string;
}

let server: Server | undefined;

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

async function startServer(
  respond: (captured: Captured) => { status: number; audio?: Buffer },
): Promise<{ url: string; captured: Captured }> {
  const captured: Captured = { body: "" };
  server = createServer((req, res) => {
    captured.method = req.method;
    captured.url = req.url;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      captured.body = Buffer.concat(chunks).toString("utf8");
      const { status, audio } = respond(captured);
      if (audio) {
        res.writeHead(status, { "content-type": "audio/ogg" });
        res.end(audio);
      } else {
        res.writeHead(status);
        res.end("error");
      }
    });
  });
  const url = await new Promise<string>((resolve) => {
    server!.listen(0, "127.0.0.1", () => {
      const addr = server!.address();
      resolve(`http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`);
    });
  });
  return { url, captured };
}

describe("HttpSynthesisService", () => {
  it("POSTs to /v1/audio/speech and returns opus audio as audio/ogg", async () => {
    const ogg = Buffer.from("OGG-OPUS-BYTES");
    const { url, captured } = await startServer(() => ({ status: 200, audio: ogg }));
    const svc = new HttpSynthesisService({ url, model: "kokoro", voice: "af_sky" });

    const result = await svc.synthesize("done, deployed to prod");
    expect(result.audio.equals(ogg)).toBe(true);
    expect(result.mimeType).toBe("audio/ogg"); // opus → OGG, Telegram voice-note format

    expect(captured.method).toBe("POST");
    expect(captured.url).toBe("/v1/audio/speech");
    const sent = JSON.parse(captured.body) as Record<string, unknown>;
    expect(sent).toMatchObject({
      model: "kokoro",
      voice: "af_sky",
      input: "done, deployed to prod",
      response_format: "opus",
    });
  });

  it("honors a per-call voice override and a non-opus format's MIME", async () => {
    const { url, captured } = await startServer(() => ({ status: 200, audio: Buffer.from("x") }));
    const svc = new HttpSynthesisService({ url, model: "m", voice: "default", format: "mp3" });
    const result = await svc.synthesize("hi", { voice: "en_ru_1" });
    expect(result.mimeType).toBe("audio/mpeg");
    expect((JSON.parse(captured.body) as { voice: string }).voice).toBe("en_ru_1");
    expect((JSON.parse(captured.body) as { response_format: string }).response_format).toBe("mp3");
  });

  it("throws on a non-2xx response", async () => {
    const { url } = await startServer(() => ({ status: 502 }));
    const svc = new HttpSynthesisService({ url, model: "m", voice: "v" });
    await expect(svc.synthesize("hi")).rejects.toThrow(/returned 502/);
  });

  it("appends the speech path to a base URL with a trailing slash", async () => {
    const { url, captured } = await startServer(() => ({ status: 200, audio: Buffer.from("x") }));
    const svc = new HttpSynthesisService({ url: `${url}/`, model: "m", voice: "v" });
    await svc.synthesize("hi");
    expect(captured.url).toBe("/v1/audio/speech");
  });
});
