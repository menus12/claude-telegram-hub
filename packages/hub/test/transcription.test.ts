import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { HttpTranscriptionService } from "../src/index.js";

interface Captured {
  method?: string;
  url?: string;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

let server: Server | undefined;

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

/** Start a fake transcription endpoint; returns its base URL + a captured-request ref. */
async function startServer(
  respond: (captured: Captured) => { status: number; json: unknown },
): Promise<{ url: string; captured: Captured }> {
  const captured: Captured = { body: "", headers: {} };
  server = createServer((req, res) => {
    captured.method = req.method;
    captured.url = req.url;
    captured.headers = req.headers;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      captured.body = Buffer.concat(chunks).toString("latin1");
      const { status, json } = respond(captured);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
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

const audio = { bytes: Buffer.from("OGG-BYTES"), filename: "voice.ogg", mimeType: "audio/ogg" };

describe("HttpTranscriptionService", () => {
  it("POSTs multipart audio to /v1/audio/transcriptions and returns the text", async () => {
    const { url, captured } = await startServer(() => ({
      status: 200,
      json: { text: "  bump the log level to debug  ", language: "en" },
    }));
    const svc = new HttpTranscriptionService({ url, model: "small" });

    const result = await svc.transcribe(audio);
    expect(result.text).toBe("bump the log level to debug"); // trimmed
    expect(result.lang).toBe("en");

    expect(captured.method).toBe("POST");
    expect(captured.url).toBe("/v1/audio/transcriptions");
    expect(captured.body).toContain('name="model"');
    expect(captured.body).toContain("small");
    expect(captured.body).toContain("voice.ogg");
    expect(captured.body).toContain("OGG-BYTES");
  });

  it("sends a prompt (agent-name bias) when provided", async () => {
    const { url, captured } = await startServer(() => ({ status: 200, json: { text: "ok" } }));
    const svc = new HttpTranscriptionService({ url, model: "small" });
    await svc.transcribe(audio, { prompt: "Agent names: conn, kb, platform." });
    expect(captured.body).toContain('name="prompt"');
    expect(captured.body).toContain("conn, kb, platform");
  });

  it("sends a language field only when not auto", async () => {
    // explicit language
    {
      const { url, captured } = await startServer(() => ({ status: 200, json: { text: "ok" } }));
      const svc = new HttpTranscriptionService({ url, model: "medium", defaultLang: "auto" });
      await svc.transcribe(audio, { lang: "ru" });
      expect(captured.body).toContain('name="language"');
      expect(captured.body).toContain("ru");
    }
    // auto → no language part
    {
      const { url, captured } = await startServer(() => ({ status: 200, json: { text: "ok" } }));
      const svc = new HttpTranscriptionService({ url, model: "small", defaultLang: "auto" });
      await svc.transcribe(audio);
      expect(captured.body).not.toContain('name="language"');
    }
  });

  it("throws on a non-2xx response", async () => {
    const { url } = await startServer(() => ({ status: 500, json: { error: "boom" } }));
    const svc = new HttpTranscriptionService({ url, model: "small" });
    await expect(svc.transcribe(audio)).rejects.toThrow(/returned 500/);
  });

  it("appends the transcriptions path to a base URL with a trailing slash", async () => {
    const { url, captured } = await startServer(() => ({ status: 200, json: { text: "hi" } }));
    const svc = new HttpTranscriptionService({ url: `${url}/`, model: "small" });
    await svc.transcribe(audio);
    expect(captured.url).toBe("/v1/audio/transcriptions");
  });

  it("sends an API key (Bearer by default, or a custom header for Azure)", async () => {
    {
      const { url, captured } = await startServer(() => ({ status: 200, json: { text: "hi" } }));
      const svc = new HttpTranscriptionService({ url, model: "whisper-1", apiKey: "sk-abc" });
      await svc.transcribe(audio);
      expect(captured.headers.authorization).toBe("Bearer sk-abc");
    }
    {
      const { url, captured } = await startServer(() => ({ status: 200, json: { text: "hi" } }));
      const svc = new HttpTranscriptionService({
        url,
        model: "whisper",
        apiKey: "azkey",
        authHeader: "api-key",
      });
      await svc.transcribe(audio);
      expect(captured.headers["api-key"]).toBe("azkey");
      expect(captured.headers.authorization).toBeUndefined();
    }
  });

  it("uses a full endpoint URL verbatim (cloud non-standard path)", async () => {
    const { url, captured } = await startServer(() => ({ status: 200, json: { text: "hi" } }));
    const full = `${url}/openai/deployments/whisper/audio/transcriptions?api-version=2024-06-01`;
    const svc = new HttpTranscriptionService({ url: full, model: "whisper" });
    await svc.transcribe(audio);
    expect(captured.url).toBe("/openai/deployments/whisper/audio/transcriptions?api-version=2024-06-01");
  });
});
