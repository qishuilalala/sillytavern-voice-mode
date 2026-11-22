# Voice Mode（SillyTavern 语音模式扩展）

[English](./README.md) · [安全策略](./SECURITY.md) · [领域词典](./GLOSSARY.md) · [更新日志](./CHANGELOG.md)

面向 [SillyTavern](https://github.com/SillyTavern/SillyTavern)（`>= 1.19.1`）的本地优先流式朗读（TTS）、免提 AEC3 语音打断（Voice Barge-In）、多角色音色表（Voice Map）与情感标签（Emotion Cue）全双工语音扩展。

## 核心特性

- **流式首句抢先起播**：将 SillyTavern `STREAM_TOKEN_RECEIVED` 的累积文本实时切片为增量字符流，交由 `@voice-mode/core` 的 `SentenceSegmenter` 分句清洗，在大模型仍在吐字时立即朗读首句（`GENERATION_ENDED` 冲刷尾句；非流式后端自动回退至 `CHARACTER_MESSAGE_RENDERED`）。
- **多角色音色表与 `*旁白*` / `"对白"` 自动分轨**：支持按角色名或头像文件名绑定独立音色，开启分轨后自动区分 `*动作旁白*` 与角色对白（精准保留 `**粗体**` 不误判）。
- **四类 TTS 引擎与 `< 1s` 离线自动回退**：
  - `system` — 零配置浏览器系统语音（默认开箱即用）。
  - `kokoro-daemon` — 可选本地 `voice-daemon`（`http://127.0.0.1:18790`，内置 Kokoro 103 多语种音色），守护进程未启动时 `< 1s` 自动无缝回退至 `system`。
  - `openai-compat` 与 `mimo` — 自带密钥（BYOK）云端或自建兼容端点。
- **AEC3 免提语音打断联动 `stopGeneration()`**：在 `HTMLAudioElement` 播报期间通过 `@voice-mode/browser` 的 `AecBargeInMonitor` 监测人声，确认开口后立即清空本地语音队列并同步中止正在生成的 LLM 回复（严格受 `isGenerating()` 保护，空闲态绝不误触），同时支持手动打断按钮与 `Alt+Shift+B` 快捷键。
- **`#send_textarea` 语音听写与词表纠错**：支持浏览器原生识别、本地 `voice-daemon`（`Zipformer2` / `SenseVoice`）与 OpenAI 兼容 Whisper，经 `createAsrReplacer` 专名替换后由 `FocusTextInjector` 注入 `#send_textarea`（`Alt+Shift+V`），支持免提自动点击 `#send_but` 发送。
- **情感标签系统提示词注入（`<whisper>`、`<break Nms>`）**：可选开启 `setExtensionPrompt` 引导模型输出细腻停顿与耳语标签，由 `compileEmotionPlan` 编译为语音指令或静音间隔，绝不字面误读标签。
- **服务端密钥隔离与安全上下文（`isSecureContext`）提示**：API 密钥通过 SillyTavern `/api/secrets/write`（服务端 `secrets.json`）及当前标签页临时内存保存，**绝不写入明文 `extension_settings`**；局域网明文 HTTP 访问时自动提示切换 `127.0.0.1`、SSH 端口转发或 HTTPS。

## 一键安装（SillyTavern 扩展管理器）

1. 打开 SillyTavern（`>= 1.19.1`）→ **Extensions（扩展）** → **Install extension（安装扩展）**。
2. 粘贴仓库地址：
   ```text
   https://github.com/qishuilalala/sillytavern-voice-mode
   ```
3. 点击 **Install just for me** 或 **Install for all users** 即可，无需部署 Extras API，也无需开启 `enableServerPlugins`。

## 可选服务端插件（无 CORS 端点代理）

默认纯前端扩展模式在 `enableServerPlugins: false` 下完整可用。若自定义第三方 TTS 接口未配置浏览器 CORS 响应头，可按需安装配套服务端代理插件：

```bash
node scripts/install-server-plugin.mjs /path/to/SillyTavern
# 在 SillyTavern 的 config.yaml 中设置 enableServerPlugins: true 并重启服务
```

## 开发与门禁校验

```bash
pnpm install
pnpm run check:all
pnpm audit --audit-level high
```

## 开源许可

[MIT](./LICENSE)
