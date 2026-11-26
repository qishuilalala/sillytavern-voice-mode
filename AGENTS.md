# AGENTS.md — sillytavern-voice-mode

> 面向在本仓库工作的 AI 编码代理。服务器级基线见 `~/.dsh/AGENTS.md`；本文件只放本仓库特有约束。
> 单一真源：`CONTEXT.md`、`CODING_STANDARDS.md`、`GLOSSARY.md`、`SECURITY.md`。

## 命令

- `pnpm run check:all`：typecheck → lint → test → build → release gate（提交前必跑）。
- `pnpm run build` 后必须 `git add dist/index.js`（dist 入库，gate 校验与源码同步）。
- 共享内核来自 `vendor/` tgz；同步后跑 `pnpm install --lockfile-only` + `check:all`。

## 硬约束

1. 共享内核复用率 ≥74%（gate 强制）；新增逻辑优先下沉 `@voice-mode/core`。
2. 密钥只存 ST 服务端 `secrets.json` + 会话内存，绝不写入 `extension_settings`/`localStorage`。
3. 引擎能力变化必须同步 README「Engine expression capabilities」表（来源 `@voice-mode/core`）。
4. 打断后不得复读截断消息（`onGenerationStopped` 抑制一次 `CHARACTER_MESSAGE_RENDERED`）。
5. 群聊说话者必须从生成消息的 name/original_avatar 解析，Voice Map 才生效。
6. `auto_update: false` 是版本锁定治理项，不得改回。

## 禁止

- 不 `git add -A`；提交白名单。
- 不擅自打 tag/发布。
- 不引入声音克隆；不静默丢弃内容（队列溢出必须可见）。
