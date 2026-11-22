# Voice Mode（SillyTavern 语音模式扩展）

[English](./README.md) · [安全策略](./SECURITY.md) · [领域词典](./GLOSSARY.md) · [更新日志](./CHANGELOG.md)

Voice Mode 会在角色生成回复时按句朗读，也能把你说的话转成聊天输入框里的文字。角色和旁白可以使用不同音色。支持 SillyTavern `1.19.1` 及以上版本。

## 一键安装（SillyTavern 扩展管理器）

1. 打开 SillyTavern（`>= 1.19.1`）→ **Extensions（扩展）** → **Install extension（安装扩展）**。
2. 粘贴仓库地址：
   ```text
   https://github.com/qishuilalala/sillytavern-voice-mode
   ```
3. 点击 **Install just for me** 或 **Install for all users** 即可，无需部署 Extras API，也无需开启 `enableServerPlugins`。

## 第一次使用

打开 SillyTavern 的扩展设置，展开 **语音模式**（英文界面为 **Voice Mode**）。扩展跟随 SillyTavern 的界面语言。

1. **听一句角色回复。** 确认已勾选 **启用流式朗读**，将 **默认角色音色** 的引擎设为 **浏览器系统语音（无需配置）**。打开角色聊天，发送「请用一句话打个招呼」。角色生成完整句子后即可听到朗读。有些后端会在整条回复显示后开始朗读。
2. **口述下一条消息。** 打开本机的 `http://localhost:8000` 或通过 HTTPS 访问的酒馆，选择 **浏览器语音识别**。浏览器可能会将音频交给其语音服务提供商；需要在本机识别时，先按下表配置本机模型。点击 **开始听写**（或按 `Alt+Shift+V`），按浏览器提示允许麦克风访问。说一句话并停顿，识别结果会出现在聊天输入框。浏览器识别在自动模式下使用页面或浏览器的语言。默认由你检查后发送。听写仍在运行时可再按一次快捷键停止。
3. **打断角色。** 朗读时点击 **打断朗读与生成** 或按 `Alt+Shift+B`。若角色仍在生成，这个操作也会停止生成。系统语音使用手动打断；使用支持的音频引擎且浏览器回声消除可用时，可以开启免提打断。

## 选用本机服务或云端语音

| 想做什么 | 在扩展里怎样设置 | 语音或文本的去向 |
| --- | --- | --- |
| 换角色或旁白音色 | 在 **默认角色音色**、**旁白音色（\*动作\*）** 或当前角色的设置中选择引擎和音色。浏览器系统语音无需 API 密钥。 | 系统语音交给浏览器和操作系统播放，语音是否在线取决于所选音色。 |
| 使用本机模型 | 启动 [Voice Mode Daemon](https://github.com/qishuilalala/voice-mode-daemon)，使用其本机地址和访问令牌。在角色音色里选 Kokoro，或在识别引擎里选 **本地 Voice Daemon 语音识别**。 | 朗读文本或听写音频发往本机。Kokoro 朗读连接失败时可回退到系统语音；本机听写失败时会尝试配置的 OpenAI 兼容转写接口。 |
| 使用云端服务 | 朗读选择 OpenAI 兼容服务或 MiMo；听写选择 **OpenAI 兼容 Whisper 语音识别**。核对接口地址，为对应功能选择密钥类型，点击 **保存服务端密钥**。 | 朗读发送要合成的文字，听写发送分句后的音频。 |

## 遇到问题时

- **麦克风按钮不可用。** 在同一台设备上可用 `http://127.0.0.1:8000` 或 `http://localhost:8000`。用另一台设备访问时请使用 HTTPS；通过 SSH 转发的用户可在本机运行 `ssh -L 8000:127.0.0.1:8000 user@host` 后打开本机地址。
- **拒绝权限或识别无法启动。** 在浏览器地址栏的网站权限中允许当前站点使用麦克风，并检查系统麦克风权限后重试。若浏览器不提供语音识别，可切换本机服务或已配置的 Whisper 转写服务。
- **回复没有声音。** 检查 **启用流式朗读** 是否已勾选、标签页是否静音，确认系统有可用音色。若使用角色专属音色，检查该角色的引擎设置，它优先于默认角色音色。选择本机服务时检查进程、地址及令牌。

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

## 可选服务端插件（无 CORS 端点代理）

听写和系统朗读可直接在默认的前端扩展模式使用。若自定义第三方 TTS 接口未配置浏览器 CORS 响应头，可按需安装配套服务端代理插件：

```bash
node scripts/install-server-plugin.mjs /path/to/SillyTavern
# 在 SillyTavern 的 config.yaml 中设置 enableServerPlugins: true 并重启服务
```

## 开发与验证

开发需要 Node.js `>= 22.18.0` 和 `pnpm@12.21.0`。安装者直接使用仓库中的 `dist/index.js`。开发时修改界面或代码后，重新构建并提交对应的安装文件。详见[开发入口](./CONTEXT.md)。

```bash
pnpm install --frozen-lockfile
pnpm run check:all
pnpm audit --audit-level high
```

## 开源许可

[MIT](./LICENSE)
