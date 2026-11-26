import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SETTINGS,
  SECRET_SLOT_KEYS,
  SillyTavernSecretBroker,
  ensureExtensionSettings,
  formatSafeError,
  inspectSecureOrigin,
} from "../src/settings.ts";

test("ensureExtensionSettings normalizes VoiceMap and strips accidental plaintext secrets", () => {
  const store = {
    voice_mode: {
      enabled: true,
      emotionPromptEnabled: true,
      narrationSplitEnabled: true,
      apiKey: "sk-proj-1234567890abcdefghijklmnop",
      daemonToken: "secret-daemon-token-999999",
      openaiTtsBaseUrl: "https://user:pass@evil.example/v1",
      asrBaseUrl: "https://api.example.com/v1?api_key=AIzaSySecretKey1234567890",
      mimoModel: "gsk_1234567890abcdef",
      asrModel: "sk-vmd-1234567890abcdef",
      voiceMap: {
        Alice: { engine: "kokoro-daemon", voice: "zf_001" },
        "bob.png": "alloy",
        BadEntry: { engine: "openai-compat", voice: "AIzaSyLeak1234567890", apiKey: "sk-leak-9999999999999999" },
      },
      asrReplacements: [{ from: ["希尔薇"], to: "Sylvie" }],
    },
  };

  const settings = ensureExtensionSettings(store);
  assert.equal(settings.enabled, true);
  assert.equal(settings.emotionPromptEnabled, true);
  assert.equal(settings.narrationSplitEnabled, true);
  assert.deepEqual(settings.voiceMap.Alice, { engine: "kokoro-daemon", voice: "zf_001" });
  assert.deepEqual(settings.voiceMap["bob.png"], { engine: "system", voice: "alloy" });
  assert.deepEqual(settings.voiceMap.BadEntry, { engine: "openai-compat", voice: "" });
  assert.equal(settings.openaiTtsBaseUrl, DEFAULT_SETTINGS.openaiTtsBaseUrl);
  assert.equal(settings.asrBaseUrl, DEFAULT_SETTINGS.asrBaseUrl);
  assert.equal(settings.mimoModel, DEFAULT_SETTINGS.mimoModel);
  assert.equal(settings.asrModel, DEFAULT_SETTINGS.asrModel);
  assert.deepEqual(settings.asrReplacements, [{ from: ["希尔薇"], to: "Sylvie" }]);

  const serialized = JSON.stringify(store);
  assert.doesNotMatch(serialized, /sk-proj-|sk-leak-|secret-daemon-token|user:pass|AIzaSy|gsk_|sk-vmd-/);
  assert.equal(DEFAULT_SETTINGS.enabled, true);
});

test("SillyTavernSecretBroker persists via writeSecret and serves ephemeral session cache when allowKeysExposure is false", async () => {
  const serverVault = new Map();
  let allowKeysExposure = false;
  const extensionStore = { voice_mode: {} };

  const broker = new SillyTavernSecretBroker({
    writeSecret: async (key, value, label) => {
      serverVault.set(key, { value, label });
      return "id-1";
    },
    findSecret: async (key) => (allowKeysExposure ? (serverVault.get(key)?.value ?? null) : null),
    deleteSecret: async (key) => {
      serverVault.delete(key);
    },
  });

  await broker.setSecret("openaiTts", "sk-live-secret-value-1234567890");
  assert.equal(serverVault.get(SECRET_SLOT_KEYS.openaiTts)?.value, "sk-live-secret-value-1234567890");
  assert.equal(await broker.getSecret("openaiTts"), "sk-live-secret-value-1234567890");
  assert.doesNotMatch(JSON.stringify(extensionStore), /sk-live-secret/);

  // Simulate fresh browser reload with allowKeysExposure = true on server
  const reloadedBroker = new SillyTavernSecretBroker({
    writeSecret: async () => "id-2",
    findSecret: async (key) => (allowKeysExposure ? (serverVault.get(key)?.value ?? null) : null),
    deleteSecret: async (key) => {
      serverVault.delete(key);
    },
  });
  assert.equal(await reloadedBroker.getSecret("openaiTts"), null);
  allowKeysExposure = true;
  assert.equal(await reloadedBroker.getSecret("openaiTts"), "sk-live-secret-value-1234567890");

  await broker.deleteSecret("openaiTts");
  assert.equal(await broker.getSecret("openaiTts"), null);
  assert.equal(serverVault.has(SECRET_SLOT_KEYS.openaiTts), false);
});

test("inspectSecureOrigin detects non-secure LAN HTTP and formatSafeError redacts secrets", () => {
  const lan = inspectSecureOrigin({
    isSecureContext: false,
    location: { protocol: "http:", hostname: "192.168.1.42", host: "192.168.1.42:8000" },
  });
  assert.equal(lan.secure, false);
  assert.match(lan.remediation, /HTTPS|127\.0\.0\.1|localhost|SSH/i);

  const local = inspectSecureOrigin({
    isSecureContext: true,
    location: { protocol: "http:", hostname: "127.0.0.1", host: "127.0.0.1:18123" },
  });
  assert.equal(local.secure, true);

  // Fail-closed when win or isSecureContext is missing/undefined
  assert.equal(inspectSecureOrigin(undefined).secure, false);
  assert.equal(inspectSecureOrigin(null).secure, false);
  assert.equal(inspectSecureOrigin({}).secure, false);

  const safeMsg = formatSafeError(
    new Error("Upstream failed with Authorization: Bearer sk-secret-abcdef1234567890"),
  );
  assert.doesNotMatch(safeMsg, /sk-secret-abcdef1234567890/);
});

test("SillyTavernSecretBroker re-probes an indeterminate canViewSecrets instead of caching null", async () => {
  const serverVault = new Map();
  let probes = 0;
  let allowView = false;
  const host = {
    writeSecret: async (key, value) => {
      serverVault.set(key, value);
      return "id-1";
    },
    findSecret: async (key) => (allowView ? (serverVault.get(key) ?? null) : null),
    deleteSecret: async (key) => {
      serverVault.delete(key);
    },
    canViewSecrets: async () => {
      probes++;
      return allowView ? true : null;
    },
  };

  const writer = new SillyTavernSecretBroker(host);
  await writer.setSecret("openaiTts", "sk-live-secret-value-1234567890");

  // Simulate a page reload: fresh broker, no ephemeral cache, backend still warming up.
  const reloaded = new SillyTavernSecretBroker(host);
  assert.equal(await reloaded.getSecret("openaiTts"), null);

  // Once the backend reports a definitive answer, the key must become readable.
  allowView = true;
  assert.equal(
    await reloaded.getSecret("openaiTts"),
    "sk-live-secret-value-1234567890",
    "indeterminate probe must be retried, not cached as cannot-view",
  );
  assert.ok(probes >= 2, `canViewSecrets should be re-probed, got ${probes}`);
});
