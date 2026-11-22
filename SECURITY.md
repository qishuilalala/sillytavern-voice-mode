# Security Policy / 安全策略

## Supported Versions / 支持的版本

Only the latest release receives security fixes. The repository is currently at **`0.1.0` (Alpha)**; configuration schemas and storage boundaries may evolve prior to `1.0.0`.

仅最新版本接收安全修复。当前仓库处于 **`0.1.0`（Alpha）**，在 `1.0.0` 正式版前配置结构与边界可能调整。

## Reporting a Vulnerability / 报告漏洞

Please **do not** disclose security vulnerabilities in public GitHub issues, pull requests, or discussions. Use GitHub's private vulnerability reporting channel (**Security → Report a vulnerability** on `qishuilalala/sillytavern-voice-mode`).

请**不要**在公开 Issue、PR 或讨论区披露安全漏洞细节。请通过仓库私密漏洞报告入口（**Security → Report a vulnerability**）提交。

---

## Privacy & Data Flow Boundaries / 隐私与数据流边界

### 1. Zero Telemetry / 零遥测承诺

- This extension sends **zero telemetry, zero analytics, zero crash reports, and zero usage tracking**.
- No outbound network requests are made to external cloud hosts on startup.

本扩展**零遥测、零埋点、零崩溃上报**，启动时不会向任何外部云端发起静默请求。

### 2. Audio & Text Data Flows / 语音与文本数据流

- **Local Browser / Companion Daemon Mode**:
  - System speech (`window.speechSynthesis`), browser WASM engines, and the optional local `voice-daemon` (`http://127.0.0.1:18790`) process speech locally on your machine.
  - When `voice-daemon` is unreachable, probing fails closed within `< 1s` without uploading data externally.
- **Optional BYOK TTS / STT Endpoints**:
  - Outbound requests to cloud speech providers occur **only** when explicitly configured and enabled by the user.
  - Only cleaned speakable utterance text (for TTS) or segmented utterance audio (for STT) is sent to your configured endpoint; this project operates **no relay server**.

### 3. SillyTavern Host & LAN Boundaries / SillyTavern 宿主与局域网边界

- **No Server Plugin Required for UI Install**: Installed as a standard SillyTavern third-party UI extension (`enableServerPlugins` remains `false` by default).
- **CSRF & Host Secrets**: Any request to SillyTavern's own `/api/*` routes uses SillyTavern's `getRequestHeaders()` (`X-CSRF-Token`). SillyTavern keeps `allowKeysExposure: false` by default; secrets are never logged or echoed into chat history.
- **Secure Context Microphone Gate (`window.isSecureContext`)**: When SillyTavern is accessed over plain LAN HTTP (`listen: true` without HTTPS), browsers block `navigator.mediaDevices.getUserMedia`. The extension detects non-secure contexts upfront and provides HTTPS / loopback remediation guidance rather than attempting unsafe workarounds.
- **Outbound Hardening**: Direct `fetch` requests enforce `redirect: 'error'`, reject embedded URL credentials (`user:pass@`), and pass error payloads through secret redaction before truncation or toast display.

---

## Third-Party Model & License Isolation / 第三方模型与许可证隔离

- This repository's source code is licensed under the **MIT License**.
- **No third-party model weights, WASM binaries, or GPL phoneme archives (`espeak-ng-data`) are bundled in this repository or its GitHub Releases.**
