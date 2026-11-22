import dns from "node:dns/promises";
import fs from "node:fs";
import https from "node:https";
import net from "node:net";
import path from "node:path";

import {
  MIMO_DEFAULT_BASE_URL,
  TTS_OPENAI_PRESETS,
  redactBodySnippet,
  redactSecrets,
} from "@voice-mode/core";

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

const MAX_REQ_JSON_BYTES = 64 * 1024;
const DEFAULT_MAX_PROXY_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_UPSTREAM_ERROR_BYTES = 8 * 1024;
const DAEMON_ORIGIN = "http://127.0.0.1:18790";
const ALLOWED_DAEMON_PATHS = new Set([
  "/v1/audio/speech",
  "/v1/audio/transcriptions",
  "/v1/health",
]);

function isReservedIpv4Octets(a, b, c) {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function parseIpv4Octets(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : -1));
  if (nums.some((n) => n < 0 || n > 255)) return null;
  return nums;
}

function expandIpv6Words(ip) {
  let work = ip.toLowerCase();
  // Convert trailing dotted-quad IPv4 (`::ffff:127.0.0.1`) into two hex words
  const lastColon = work.lastIndexOf(":");
  if (lastColon !== -1 && work.slice(lastColon + 1).includes(".")) {
    const octets = parseIpv4Octets(work.slice(lastColon + 1));
    if (!octets) return null;
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    work = `${work.slice(0, lastColon)}:${hi}:${lo}`;
  }

  const dblIdx = work.indexOf("::");
  if (dblIdx !== -1 && work.indexOf("::", dblIdx + 2) !== -1) return null;

  let left = [];
  let right = [];
  if (dblIdx === -1) {
    left = work.split(":");
    if (left.length !== 8) return null;
  } else {
    const lStr = work.slice(0, dblIdx);
    const rStr = work.slice(dblIdx + 2);
    left = lStr ? lStr.split(":") : [];
    right = rStr ? rStr.split(":") : [];
    if (left.length + right.length >= 8) return null;
  }

  const parseGroup = (g) => (/^[0-9a-f]{1,4}$/.test(g) ? Number.parseInt(g, 16) : -1);
  const lWords = left.map(parseGroup);
  const rWords = right.map(parseGroup);
  if (lWords.some((w) => w < 0) || rWords.some((w) => w < 0)) return null;

  const zeros = new Array(8 - lWords.length - rWords.length).fill(0);
  return [...lWords, ...zeros, ...rWords];
}

export function isBlockedIpAddress(rawIp) {
  if (typeof rawIp !== "string") return true;
  const trimmed = rawIp.trim().replace(/^\[|\]$/g, "");
  if (!trimmed || trimmed.includes("%")) return true;

  const family = net.isIP(trimmed);
  if (family === 4) {
    const octets = parseIpv4Octets(trimmed);
    if (!octets) return true;
    return isReservedIpv4Octets(octets[0], octets[1], octets[2]);
  }
  if (family === 6) {
    const w = expandIpv6Words(trimmed);
    if (!w) return true;
    const allZeroPrefix5 = w[0] === 0 && w[1] === 0 && w[2] === 0 && w[3] === 0 && w[4] === 0;
    // :: or ::1 or IPv4-compatible ::x.x.x.x
    if (allZeroPrefix5 && w[5] === 0) {
      if (w[6] === 0 && (w[7] === 0 || w[7] === 1)) return true;
      return isReservedIpv4Octets((w[6] >> 8) & 0xff, w[6] & 0xff, (w[7] >> 8) & 0xff);
    }
    // IPv4-mapped ::ffff:x.x.x.x (both dotted and hex forms)
    if (allZeroPrefix5 && w[5] === 0xffff) {
      return isReservedIpv4Octets((w[6] >> 8) & 0xff, w[6] & 0xff, (w[7] >> 8) & 0xff);
    }
    // NAT64 64:ff9b::/96
    if (w[0] === 0x0064 && w[1] === 0xff9b && w[2] === 0 && w[3] === 0 && w[4] === 0 && w[5] === 0) {
      return isReservedIpv4Octets((w[6] >> 8) & 0xff, w[6] & 0xff, (w[7] >> 8) & 0xff);
    }
    // 6to4 2002::/16
    if (w[0] === 0x2002) {
      return isReservedIpv4Octets((w[1] >> 8) & 0xff, w[1] & 0xff, (w[2] >> 8) & 0xff);
    }
    if ((w[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((w[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
    if ((w[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
    if (w[0] === 0x2001 && w[1] === 0x0db8) return true; // documentation
    if (w[0] === 0x0100 && w[1] === 0 && w[2] === 0 && w[3] === 0) return true; // discard
    return false;
  }
  return true;
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

function scrubWithKnownSecret(text, secret) {
  let out = redactBodySnippet(String(text ?? ""), 240);
  if (secret && secret.length >= 4 && out.includes(secret)) {
    out = out.split(secret).join("<redacted>");
  }
  return redactSecrets(out).slice(0, 240);
}

async function readBoundedBytes(response, maxBytes) {
  if (!response.body || typeof response.body.getReader !== "function") {
    return new Uint8Array(0);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        const err = new Error(`Payload exceeded ${maxBytes} bytes`);
        err.code = "PAYLOAD_TOO_LARGE";
        throw err;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function resolvePinnedPresetTarget(presetId) {
  const normalized = presetId === "openai" ? "openai-official" : presetId;
  if (normalized === "mimo") {
    return {
      url: `${MIMO_DEFAULT_BASE_URL.replace(/\/+$/, "")}/chat/completions`,
      slot: "mimo",
      isMimo: true,
    };
  }
  if (Object.hasOwn(TTS_OPENAI_PRESETS, normalized)) {
    const preset = TTS_OPENAI_PRESETS[normalized];
    if (preset.baseUrl.startsWith("https://")) {
      return {
        url: `${preset.baseUrl.replace(/\/+$/, "")}/audio/speech`,
        slot: preset.requiresKey ? "openaiTts" : null,
        isMimo: false,
      };
    }
  }
  return null;
}

async function validateCustomHttpsSpeechUrl(rawBaseUrl, lookupFn) {
  if (typeof rawBaseUrl !== "string" || !rawBaseUrl.trim()) {
    return { ok: false, error: "Disallowed empty customBaseUrl" };
  }
  let parsed;
  try {
    parsed = new URL(rawBaseUrl.trim());
  } catch {
    return { ok: false, error: "Invalid customBaseUrl syntax" };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, error: "Disallowed non-HTTPS customBaseUrl" };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: "Disallowed credentials in customBaseUrl" };
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  let pinnedRecord = null;
  if (net.isIP(hostname) !== 0) {
    if (isBlockedIpAddress(hostname)) {
      return { ok: false, error: "Disallowed private or reserved IP literal" };
    }
    pinnedRecord = { address: hostname, family: net.isIP(hostname) };
  } else {
    let records;
    try {
      records = await lookupFn(hostname, { all: true, verbatim: true });
    } catch {
      return { ok: false, error: "DNS resolution failed for customBaseUrl" };
    }
    if (!Array.isArray(records) || records.length === 0) {
      return { ok: false, error: "No DNS records found for customBaseUrl" };
    }
    for (const rec of records) {
      if (isBlockedIpAddress(rec?.address)) {
        return { ok: false, error: "Disallowed private or reserved DNS target" };
      }
    }
    pinnedRecord = {
      address: String(records[0].address).trim(),
      family: records[0].family === 6 ? 6 : 4,
    };
  }

  const cleanPath = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = cleanPath.endsWith("/audio/speech")
    ? cleanPath
    : `${cleanPath}/audio/speech`;
  parsed.search = "";
  parsed.hash = "";
  return { ok: true, url: parsed.toString(), pinnedRecord };
}

function postHttpsPinned(urlStr, pinnedRecord, headers, bodyStr, maxOkBytes, maxErrBytes) {
  const parsed = new URL(urlStr);
  return new Promise((resolve, reject) => {
    const req = https.request(
      parsed,
      {
        method: "POST",
        headers: {
          ...headers,
          "Content-Length": String(Buffer.byteLength(bodyStr, "utf8")),
        },
        servername: parsed.hostname,
        timeout: 20000,
        lookup: (_host, _opts, cb) => {
          cb(null, pinnedRecord.address, pinnedRecord.family);
        },
      },
      (res) => {
        const status = res.statusCode ?? 502;
        if (status >= 300 && status < 400) {
          res.destroy();
          reject(new Error("Redirects are disallowed"));
          return;
        }
        const limit = status >= 200 && status < 300 ? maxOkBytes : maxErrBytes;
        const chunks = [];
        let total = 0;
        res.on("data", (chunk) => {
          total += chunk.length;
          if (total > limit) {
            res.destroy();
            if (status >= 200 && status < 300) {
              const err = new Error(`Payload exceeded ${limit} bytes`);
              err.code = "PAYLOAD_TOO_LARGE";
              reject(err);
            } else {
              resolve({ status, contentType: "", bytes: Buffer.concat(chunks) });
            }
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          resolve({
            status,
            contentType: String(res.headers["content-type"] ?? ""),
            bytes: Buffer.concat(chunks),
          });
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error("Upstream request timed out"));
    });
    req.on("error", reject);
    req.end(bodyStr);
  });
}

async function verifyLocalVoiceDaemon(fetchFn) {
  const res = await fetchFn(`${DAEMON_ORIGIN}/v1/health`, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(800),
  });
  if (!res.ok) return false;
  const bytes = await readBoundedBytes(res, 16 * 1024);
  const data = JSON.parse(new TextDecoder().decode(bytes));
  return data?.service === "voice-daemon";
}

export function createServerPluginHandlers(options = {}) {
  const lookupFn = options.lookupFn ?? ((h, opts) => dns.lookup(h, opts));
  const customFetchFn = options.fetchFn ?? null;
  const fetchFn = customFetchFn ?? ((u, init) => globalThis.fetch(u, init));
  const maxAudioBytes = options.maxAudioBytes ?? DEFAULT_MAX_PROXY_AUDIO_BYTES;

  return {
    getHealth(_req, res) {
      return res.json({ ok: true, id: info.id, version: "0.1.0" });
    },

    async postTts(req, res) {
      const userRoot = req?.user?.directories?.root;
      if (!userRoot) {
        return res.status(401).json({ error: "Authenticated SillyTavern user required" });
      }

      const secFetchSite = String(req?.headers?.["sec-fetch-site"] ?? "").toLowerCase();
      if (secFetchSite && secFetchSite !== "same-origin" && secFetchSite !== "none") {
        return res.status(403).json({ error: "Cross-site requests forbidden" });
      }

      const contentLength = Number(req?.headers?.["content-length"] ?? 0);
      if (Number.isFinite(contentLength) && contentLength > MAX_REQ_JSON_BYTES) {
        return res.status(413).json({ error: "Request body exceeds 64 KiB limit" });
      }

      const bodyObj = req?.body ?? {};
      const serializedReqBytes = Buffer.byteLength(JSON.stringify(bodyObj), "utf8");
      if (serializedReqBytes > MAX_REQ_JSON_BYTES) {
        return res.status(413).json({ error: "Request payload exceeds 64 KiB limit" });
      }

      const presetId = typeof bodyObj.presetId === "string" ? bodyObj.presetId.trim() : "";
      const rawUpstreamBody =
        typeof bodyObj.upstreamBody === "string"
          ? bodyObj.upstreamBody
          : JSON.stringify(bodyObj.upstreamBody ?? {});
      if (Buffer.byteLength(rawUpstreamBody, "utf8") > MAX_REQ_JSON_BYTES) {
        return res.status(413).json({ error: "Upstream payload exceeds 64 KiB limit" });
      }

      let targetUrl = "";
      let pinnedRecord = null;
      let secretSlot = null;
      let isMimo = false;

      if (presetId === "daemon") {
        const daemonPath =
          typeof bodyObj.daemonPath === "string" ? bodyObj.daemonPath.trim() : "/v1/audio/speech";
        if (!ALLOWED_DAEMON_PATHS.has(daemonPath)) {
          return res.status(400).json({ error: "Disallowed local daemon endpoint path" });
        }
        try {
          const verified = await verifyLocalVoiceDaemon(fetchFn);
          if (!verified) {
            return res.status(502).json({ error: "Local voice-daemon health verification failed" });
          }
        } catch {
          return res.status(502).json({ error: "Local voice-daemon is unreachable" });
        }
        targetUrl = `${DAEMON_ORIGIN}${daemonPath}`;
        secretSlot = "daemon";
      } else if (presetId === "custom") {
        const check = await validateCustomHttpsSpeechUrl(bodyObj.customBaseUrl, lookupFn);
        if (!check.ok) {
          return res.status(400).json({ error: check.error });
        }
        targetUrl = check.url;
        pinnedRecord = check.pinnedRecord;
        // CRITICAL: Never attach server-held secrets to arbitrary custom URLs!
        secretSlot = null;
      } else {
        const pinned = resolvePinnedPresetTarget(presetId);
        if (!pinned) {
          return res.status(400).json({ error: "Unknown or disallowed TTS presetId" });
        }
        targetUrl = pinned.url;
        secretSlot = pinned.slot;
        isMimo = pinned.isMimo;
      }

      const secretKey =
        secretSlot && Object.hasOwn(SLOT_TO_SECRET_KEY, secretSlot)
          ? SLOT_TO_SECRET_KEY[secretSlot]
          : "";
      const apiKey = secretKey ? readActiveUserSecret(userRoot, secretKey) : "";

      const headers = { "Content-Type": "application/json" };
      if (apiKey) {
        headers.Authorization = `Bearer ${apiKey}`;
        if (isMimo) {
          headers["api-key"] = apiKey;
        }
      }

      try {
        if (pinnedRecord && !customFetchFn) {
          const pinnedRes = await postHttpsPinned(
            targetUrl,
            pinnedRecord,
            headers,
            rawUpstreamBody,
            maxAudioBytes,
            MAX_UPSTREAM_ERROR_BYTES,
          );
          if (pinnedRes.status < 200 || pinnedRes.status >= 300) {
            const snippet = scrubWithKnownSecret(pinnedRes.bytes.toString("utf8"), apiKey);
            return res.status(pinnedRes.status).json({ error: snippet || "Upstream TTS failed" });
          }
          res.setHeader("Content-Type", pinnedRes.contentType || "application/octet-stream");
          return res.send(pinnedRes.bytes);
        }

        const upstream = await fetchFn(targetUrl, {
          method: "POST",
          headers,
          body: rawUpstreamBody,
          redirect: "error",
          signal: AbortSignal.timeout(20000),
        });

        if (!upstream.ok) {
          const errBytes = await readBoundedBytes(upstream, MAX_UPSTREAM_ERROR_BYTES).catch(
            () => new Uint8Array(0),
          );
          const snippet = scrubWithKnownSecret(new TextDecoder().decode(errBytes), apiKey);
          return res.status(upstream.status).json({ error: snippet || "Upstream TTS failed" });
        }

        const audioBytes = await readBoundedBytes(upstream, maxAudioBytes);
        res.setHeader(
          "Content-Type",
          upstream.headers.get("content-type") || "application/octet-stream",
        );
        return res.send(Buffer.from(audioBytes));
      } catch (err) {
        if (err && typeof err === "object" && err.code === "PAYLOAD_TOO_LARGE") {
          return res.status(413).json({ error: "Upstream audio payload exceeded size limit" });
        }
        const message = err instanceof Error ? err.message : String(err);
        return res.status(502).json({ error: scrubWithKnownSecret(message, apiKey) });
      }
    },
  };
}

export async function init(router, options = {}) {
  const handlers = createServerPluginHandlers(options);
  router.get("/health", (req, res) => handlers.getHealth(req, res));
  router.post("/tts", (req, res) => handlers.postTts(req, res));
}

export async function exit() {
  // Stateless proxy; nothing to tear down.
}
