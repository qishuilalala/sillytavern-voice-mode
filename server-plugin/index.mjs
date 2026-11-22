import fs from "node:fs";
import path from "node:path";

export const info = {
  id: "voice-mode",
  name: "Voice Mode Proxy",
  description:
    "Optional server-side CORS and secret-injecting TTS proxy for SillyTavern Voice Mode.",
};

const SLOT_TO_SECRET_KEY = Object.freeze({
  openaiTts: "api_key_custom_openai_tts",
  mimo: "voice_mode_mimo_api_key",
  asr: "voice_mode_asr_api_key",
  daemon: "voice_mode_daemon_token",
});

const MAX_PROXY_AUDIO_BYTES = 25 * 1024 * 1024;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function isPrivateOrReservedHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (LOOPBACK_HOSTS.has(host)) return false;
  if (
    host === "0.0.0.0" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.startsWith("fe80:") ||
    host.startsWith("fc") ||
    host.startsWith("fd")
  ) {
    return true;
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!ipv4) return false;
  const a = Number(ipv4[1]);
  const b = Number(ipv4[2]);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

export function validateUpstreamTargetUrl(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) {
    return { ok: false, error: "Disallowed empty targetUrl" };
  }
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, error: "Invalid targetUrl syntax" };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: "Disallowed credentials in targetUrl" };
  }
  const isLoopback = LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase());
  if (parsed.protocol === "http:" && !isLoopback) {
    return { ok: false, error: "Disallowed plain HTTP target; use HTTPS or loopback" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, error: "Disallowed URL protocol" };
  }
  if (!isLoopback && isPrivateOrReservedHost(parsed.hostname)) {
    return { ok: false, error: "Disallowed private or link-local target host" };
  }
  return { ok: true, url: parsed.toString() };
}

function readActiveUserSecret(userRoot, secretKey) {
  if (!userRoot || !secretKey) return "";
  const secretsPath = path.join(userRoot, "secrets.json");
  if (!fs.existsSync(secretsPath)) return "";
  try {
    const parsed = JSON.parse(fs.readFileSync(secretsPath, "utf8"));
    const entries = parsed?.[secretKey];
    if (Array.isArray(entries)) {
      const active = entries.find((item) => item && item.active);
      return typeof active?.value === "string" ? active.value.trim() : "";
    }
    return typeof entries === "string" ? entries.trim() : "";
  } catch {
    return "";
  }
}

function redactToken(text, secret) {
  let out = String(text ?? "").replace(
    /(?:Bearer\s+|sk-)[A-Za-z0-9._-]{8,}/gi,
    "[REDACTED]",
  );
  if (secret && secret.length >= 4 && out.includes(secret)) {
    out = out.split(secret).join("[REDACTED]");
  }
  return out.slice(0, 240);
}

export async function init(router) {
  router.get("/health", (_req, res) => {
    res.json({ ok: true, id: info.id, version: "0.1.0" });
  });

  router.post("/tts", async (req, res) => {
    const { targetUrl, secretSlot, upstreamBody } = req.body ?? {};
    const targetCheck = validateUpstreamTargetUrl(targetUrl);
    if (!targetCheck.ok) {
      return res.status(400).json({ error: targetCheck.error });
    }

    const secretKey =
      typeof secretSlot === "string" && Object.hasOwn(SLOT_TO_SECRET_KEY, secretSlot)
        ? SLOT_TO_SECRET_KEY[secretSlot]
        : "";
    const apiKey = readActiveUserSecret(req.user?.directories?.root, secretKey);

    const headers = { "Content-Type": "application/json" };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    try {
      const upstream = await fetch(targetCheck.url, {
        method: "POST",
        headers,
        body: typeof upstreamBody === "string" ? upstreamBody : JSON.stringify(upstreamBody ?? {}),
        redirect: "error",
        signal: AbortSignal.timeout(20000),
      });

      if (!upstream.ok) {
        const snippet = redactToken(await upstream.text(), apiKey);
        return res.status(upstream.status).json({ error: snippet || "Upstream TTS failed" });
      }

      const buf = Buffer.from(await upstream.arrayBuffer());
      if (buf.byteLength > MAX_PROXY_AUDIO_BYTES) {
        return res.status(413).json({ error: "Upstream audio payload exceeded 25 MB limit" });
      }
      res.setHeader(
        "Content-Type",
        upstream.headers.get("content-type") || "application/octet-stream",
      );
      return res.send(buf);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return res.status(502).json({ error: redactToken(message, apiKey) });
    }
  });
}

export async function exit() {
  // Stateless proxy; nothing to tear down.
}
