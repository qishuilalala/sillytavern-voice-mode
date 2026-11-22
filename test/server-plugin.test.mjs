import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createServerPluginHandlers,
  info as pluginInfo,
  isBlockedIpAddress,
} from "../server-plugin/index.mjs";

function makeMockRes() {
  return {
    statusCode: 200,
    headers: {},
    jsonBody: null,
    rawBody: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    json(payload) {
      this.jsonBody = payload;
      return this;
    },
    send(payload) {
      this.rawBody = payload;
      return this;
    },
  };
}

test("isBlockedIpAddress blocks all private/reserved IPv4, IPv6, and dotted/hex IPv4-mapped IPv6", () => {
  const blocked = [
    "127.0.0.1",
    "127.255.0.9",
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.254",
    "192.168.1.42",
    "169.254.169.254",
    "0.0.0.0",
    "100.64.0.1",
    "100.127.255.254",
    "::1",
    "::",
    "fe80::1",
    "fc00::1",
    "fd12:3456::1",
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
    "::ffff:7f00:1",
    "::ffff:a9fe:a9fe",
    "0:0:0:0:0:ffff:c0a8:0101",
  ];
  for (const ip of blocked) {
    assert.equal(isBlockedIpAddress(ip), true, `Expected IP to be blocked: ${ip}`);
  }

  const allowed = ["1.1.1.1", "8.8.8.8", "172.15.0.1", "172.32.0.1", "2606:4700:4700::1111"];
  for (const ip of allowed) {
    assert.equal(isBlockedIpAddress(ip), false, `Expected public IP to be allowed: ${ip}`);
  }
});

test("server-plugin enforces auth, sec-fetch-site, <=64KiB cap, zero secret exfiltration on custom URLs, DNS SSRF check, daemon health verification, and bounded stream reads", async () => {
  assert.equal(pluginInfo.id, "voice-mode");
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "vm-sp-user-"));
  try {
    fs.writeFileSync(
      path.join(userDir, "secrets.json"),
      JSON.stringify({
        api_key_custom_openai_tts: [
          { id: "1", value: "sk-proj-supersecret1234567890", active: true },
        ],
        voice_mode_daemon_token: [
          { id: "2", value: "sk-vmd-daemontoken1234567890", active: true },
        ],
      }),
    );

    const outboundCalls = [];
    const handlers = createServerPluginHandlers({
      maxAudioBytes: 1024,
      lookupFn: async (hostname) => {
        if (hostname === "rebind-metadata.example") {
          return [{ address: " ::ffff:a9fe:a9fe ", family: 6 }];
        }
        return [{ address: "93.184.216.34", family: 4 }];
      },
      fetchFn: async (url, init) => {
        outboundCalls.push({ url: String(url), headers: init?.headers ?? {} });
        if (String(url) === "http://127.0.0.1:18790/v1/health") {
          return new Response(JSON.stringify({ ok: true, service: "voice-daemon" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (String(url).includes("oversized.example")) {
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(700));
              controller.enqueue(new Uint8Array(700));
              controller.close();
            },
          });
          return new Response(stream, { status: 200, headers: { "content-type": "audio/wav" } });
        }
        return new Response(new Uint8Array([82, 73, 70, 70]), {
          status: 200,
          headers: { "content-type": "audio/wav" },
        });
      },
    });

    // 1. Missing req.user?.directories?.root -> 401
    const rUnauth = makeMockRes();
    await handlers.postTts({ headers: {}, body: { presetId: "openai" } }, rUnauth);
    assert.equal(rUnauth.statusCode, 401);

    // 2. Cross-site sec-fetch-site -> 403
    const rCsrf = makeMockRes();
    await handlers.postTts(
      {
        headers: { "sec-fetch-site": "cross-site" },
        user: { directories: { root: userDir } },
        body: { presetId: "openai" },
      },
      rCsrf,
    );
    assert.equal(rCsrf.statusCode, 403);

    // 3. Body > 64 KiB -> 413
    const rHuge = makeMockRes();
    await handlers.postTts(
      {
        headers: { "sec-fetch-site": "same-origin" },
        user: { directories: { root: userDir } },
        body: { presetId: "openai", upstreamBody: "x".repeat(70000) },
      },
      rHuge,
    );
    assert.equal(rHuge.statusCode, 413);

    // 4. Custom URL attempting to exfiltrate server-held secret -> NEVER receives Authorization header!
    const rCustom = makeMockRes();
    await handlers.postTts(
      {
        headers: { "sec-fetch-site": "same-origin" },
        user: { directories: { root: userDir } },
        body: {
          presetId: "custom",
          customBaseUrl: "https://public-tts.example/v1",
          secretSlot: "openaiTts",
          upstreamBody: '{"input":"hi"}',
        },
      },
      rCustom,
    );
    assert.equal(rCustom.statusCode, 200);
    const customCall = outboundCalls.find((c) => c.url === "https://public-tts.example/v1/audio/speech");
    assert.ok(customCall);
    assert.equal(customCall.headers.Authorization, undefined, "Must NEVER send server secret to custom URL!");

    // 5. Pinned preset ('openai') DOES attach server secret to pinned api.openai.com
    const rPinned = makeMockRes();
    await handlers.postTts(
      {
        headers: {},
        user: { directories: { root: userDir } },
        body: { presetId: "openai", upstreamBody: '{"input":"hi"}' },
      },
      rPinned,
    );
    assert.equal(rPinned.statusCode, 200);
    const pinnedCall = outboundCalls.find((c) => c.url === "https://api.openai.com/v1/audio/speech");
    assert.ok(pinnedCall);
    assert.equal(pinnedCall.headers.Authorization, "Bearer sk-proj-supersecret1234567890");

    // 6. DNS rebind resolving to hex IPv4-mapped IPv6 ::ffff:a9fe:a9fe -> 400/403 blocked before fetch!
    const rSsrf = makeMockRes();
    await handlers.postTts(
      {
        headers: {},
        user: { directories: { root: userDir } },
        body: {
          presetId: "custom",
          customBaseUrl: "https://rebind-metadata.example/v1",
          upstreamBody: "{}",
        },
      },
      rSsrf,
    );
    assert.equal(rSsrf.statusCode, 400);
    assert.equal(
      outboundCalls.some((c) => c.url.includes("rebind-metadata.example")),
      false,
    );

    // 7. Local voice-daemon verifies /v1/health service === 'voice-daemon' and restricts path
    const rDaemonBadPath = makeMockRes();
    await handlers.postTts(
      {
        headers: {},
        user: { directories: { root: userDir } },
        body: { presetId: "daemon", daemonPath: "/admin/shutdown", upstreamBody: "{}" },
      },
      rDaemonBadPath,
    );
    assert.equal(rDaemonBadPath.statusCode, 400);

    const rDaemonOk = makeMockRes();
    await handlers.postTts(
      {
        headers: {},
        user: { directories: { root: userDir } },
        body: { presetId: "daemon", daemonPath: "/v1/audio/speech", upstreamBody: "{}" },
      },
      rDaemonOk,
    );
    assert.equal(rDaemonOk.statusCode, 200);

    // 8. Oversized upstream audio stream aborts at > maxAudioBytes -> 413
    const rOversized = makeMockRes();
    await handlers.postTts(
      {
        headers: {},
        user: { directories: { root: userDir } },
        body: {
          presetId: "custom",
          customBaseUrl: "https://oversized.example/v1",
          upstreamBody: "{}",
        },
      },
      rOversized,
    );
    assert.equal(rOversized.statusCode, 413);
  } finally {
    fs.rmSync(userDir, { recursive: true, force: true });
  }
});
