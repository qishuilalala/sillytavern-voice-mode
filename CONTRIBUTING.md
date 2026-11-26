# Contributing to SillyTavern Voice Mode / 贡献指南

感谢参与缺陷报告、文档完善与代码贡献。参与社区协作即表示同意遵守[社区行为准则](CODE_OF_CONDUCT.md)。

## 开发环境

- **Node.js** `>= 22.18.0`；**pnpm** `12.21.0`（`pnpm install --frozen-lockfile`）
- 单包结构：`src/`（扩展源码）、`dist/index.js`（构建产物，**提交入库**）、`vendor/`（共享内核 tgz）
- 共享内核 `@voice-mode/core`、`@voice-mode/browser` 来自 `vendor/` 归档；**不要直接改 `vendor/`**，其唯一真源是母仓 `obsidian-voice-mode` 的 `packages/voice-core` / `packages/voice-browser`

## 本地验证

提交前必须运行完整门禁：

```bash
pnpm run check:all   # typecheck → lint → test → build → check:release gate
```

- `dist/index.js` 必须与源码同步（`pnpm run build` 后提交），否则 gate 会报 Git-install 产物过期
- 复跑共享内核归档一致性（需母仓检出）：在母仓运行 `pnpm run verify:matrix --require-all /mnt`
- 复用率约束：`@voice-mode/*` 字节占比 **≥ 73.3%**（gate 自动检查）

## 提交规范

- 提交信息用中文、简短专业；一次提交只做一件事
- 不提交密钥、本地路径或私人对话/音频；日志需经脱敏
- 新增外部请求/域名必须登记到 README 的隐私披露

## 报告问题

用 [Bug Report](../../issues/new?template=bug_report.yml)；安全问题走 [Security Policy](SECURITY.md)，不要在公开 issue 贴敏感信息。
