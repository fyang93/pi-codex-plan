# pi-codex-plan

[English](README.md) · [中文](README.zh-CN.md)

一个 [pi](https://pi.dev) 扩展，管理 pi 已登录的 ChatGPT（Codex）套餐：

- **输入框下方的额度栏**：5 小时和每周两个窗口的进度条、剩余比例、各自的重置倒计时、可用的重置卡数量，以及兑换重置卡之后距离原周重置的倒计时。
- **`/codex reset`**：列出可用的重置卡并兑换一张。

```
Codex │ 5h 2h30m ━━━━━━━━━━━━━━━━━━ 88% │ Week 3d4h ━━━━━━━━━━━━━━━━━ 41% │ 2 resets │ spend by 2d23h
```

额度栏跟随 ChatGPT 的登录状态，而不是当前选择的模型，所以在路由器或其他服务商的模型下也会显示。剩余低于 50% 变黄、低于 25% 变红；倒计时不足 24 小时变黄、不足 2 小时变红。

## 安装

```bash
pi install git:github.com/fyang93/pi-codex-plan
```

需要先在 pi 里登录 ChatGPT（`/login` 选 ChatGPT），未登录时额度栏不显示。

## 命令

| 命令 | 作用 |
|---|---|
| `/codex` | 立即刷新额度 |
| `/codex reset` | 列出重置卡（最快过期的在前）并兑换一张 |
| `/codex clear` | 关掉兑换后的倒计时 |

额度每 5 分钟刷新一次，每轮对话结束后也会刷新（最多每分钟一次）。兑换前需要确认，**默认选项是取消**，因为兑换会用掉这张卡。

## 为什么要倒计时

兑换重置卡会立刻恢复额度，但**不会**推迟原来的周重置时间，到时没用完的额度会作废。所以兑换前会记下原来的周重置时间，并显示还剩多久可以用掉恢复的额度。

## 实现

从 pi 的凭据存储（`~/.pi/agent/auth.json` 或 `$PI_CODING_AGENT_DIR/auth.json`）读取 ChatGPT OAuth token，只访问 `chatgpt.com`：

| 接口 | 用途 |
|---|---|
| `GET /backend-api/wham/usage` | 速率限制窗口 |
| `GET /backend-api/wham/rate-limit-reset-credits` | 重置卡 |
| `POST /backend-api/wham/rate-limit-reset-credits/consume` | 兑换一张重置卡 |

这些是官方 Codex CLI 使用的私有接口，OpenAI 随时可能修改。倒计时保存在 `$PI_CODING_AGENT_DIR/codex-plan.json`，到期或执行 `/codex clear` 后删除。

重置卡在发放 30 天后过期。返回 `nothing_to_reset` 表示当前额度没有受限，不会消耗重置卡。额度栏的样式参考了 [pi-sub-bar](https://github.com/marckrenn/pi-sub-bar)。本项目与 OpenAI 无关。

## 许可证

MIT
