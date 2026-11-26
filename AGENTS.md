# AGENTS.md — sillytavern-voice-mode

> 面向在本仓库工作的 AI 编码代理。服务器级基线见 `~/.dsh/AGENTS.md`；本文件只放本仓库特有约束。
> 单一真源：`CONTEXT.md`、`CODING_STANDARDS.md`、`GLOSSARY.md`、`SECURITY.md`。

## 命令

- `pnpm run check:all`：typecheck → lint → test → build → release gate（提交前必跑）。
- `pnpm run build` 后必须 `git add dist/index.js`（dist 入库，gate 校验与源码同步）。
- 共享内核来自 `vendor/` tgz；同步后跑 `pnpm install --lockfile-only` + `check:all`。

## 硬约束

1. 共享内核复用率 **≥73.3%**（gate 强制，2026-11-26 因 P4 导出功能调整）；新增逻辑优先下沉 `@voice-mode/core`，调阈值前必须先抽共享（纪律见 docs/16）。
2. 密钥只存 ST 服务端 `secrets.json` + 会话内存，绝不写入 `extension_settings`/`localStorage`。
3. 引擎能力变化必须同步 README「Engine expression capabilities」表（来源 `@voice-mode/core`）。
4. 打断后不得复读截断消息（`onGenerationStopped` 抑制一次 `CHARACTER_MESSAGE_RENDERED`）。
5. 群聊说话者必须从生成消息的 name/original_avatar 解析，Voice Map 才生效。
6. `auto_update: false` 是版本锁定治理项，不得改回。
7. WAV 导出仅支持 WAV 能力引擎；system/MP3 引擎必须明确提示不可导出，导出防重（共享槽）。
8. 语义端点默认关闭；开启时 final 转录只注入一次，`interimResults` 仅在该开关下启用。

## 提交前检查（2026-11-26 教训）

- 删除任何 i18n key / 常量前，必须先跑完整 `pnpm run check:all`（含 typecheck）——只跑 test 会漏掉类型错误。
- 推送后必须复核 CI 实际结论（`gh run list` / 母仓 `scripts/check-ci.mjs`）：push 成功 ≠ CI 绿。
- 新增测试断言不得依赖本机缓存/状态（CI 是干净环境）。

## 禁止

- 不 `git add -A`；提交白名单。
- 不擅自打 tag/发布。
- 不引入声音克隆；不静默丢弃内容（队列溢出必须可见）。
