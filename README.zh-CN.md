# pi-reset-chatgpt

[English](README.md) · [中文](README.zh-CN.md)

一个 [pi](https://pi.dev) 扩展：列出当前已登录 ChatGPT 账号上所有可用的 Codex
额度重置机会，让你选一个使用，并在使用之后于状态栏显示一个倒计时，提醒你在原本
的周额度重置时间到来之前把额度用完。

## 为什么要有倒计时

使用一次重置机会会立刻恢复额度，但它**不会**推迟原本的周额度重置时间。如果你的
额度本来 3 天后自动重置，那么它依然会在 3 天后重置 —— 届时没用完的额度就浪费了。
所以扩展会在使用重置机会之前先记下原本的重置时间，然后显示你还剩多久可以真正用掉
这些额度。

```
⏳ ChatGPT: 2d 23h        # 充裕
⏳ ChatGPT: 8h 12m        # 不足 24 小时，转琥珀
⏳ ChatGPT: 47m           # 不足 2 小时，转红
```

倒计时只在使用了重置机会之后出现，到期后会自动消失。它不会弹通知打断你 ——
紧迫程度只用颜色表达。

## 安装

```bash
pi install git:github.com/fyang93/pi-reset-chatgpt
```

或者不安装，只在单次运行中试用：

```bash
pi -e git:github.com/fyang93/pi-reset-chatgpt
```

需要 pi 中已登录 ChatGPT (Codex) 账号 —— 如果还没登录，先运行 `/login` 并选择
ChatGPT。

## 用法

| 命令 | 作用 |
|---|---|
| `/reset-chatgpt` | 列出可用的重置机会并使用其中一个 |
| `/reset-chatgpt status` | 以通知形式显示当前倒计时 |
| `/reset-chatgpt clear` | 关闭倒计时提醒 |

`/reset-chatgpt` 会列出账号上所有可用的重置机会，有效截止日期早的排在前面：

```
2 resets available — soonest to expire first
  1. Full reset — expires 2026-10-04 10:58 (in 11d 16h)
  2. Full reset — expires 2026-10-05 13:19 (in 12d 18h)
```

用 `enter` 选中一个之后，会再弹出一个确认框。**默认选中的是 Cancel** —— 必须手动
把光标移到 `Confirm` 才会真正使用，因为重置机会一旦用掉就无法撤销。

## 工作原理

扩展直接从 pi 自己的凭据文件（`~/.pi/agent/auth.json`，或
`$PI_CODING_AGENT_DIR/auth.json`）读取 ChatGPT 的 OAuth token，不会要求你另外填
写 token，也不会把它发往 `chatgpt.com` 以外的任何地方。

它使用三个接口：

| 接口 | 用途 |
|---|---|
| `GET /backend-api/wham/rate-limit-reset-credits` | 列出重置机会 |
| `GET /backend-api/wham/usage` | 在使用前读取原本的周重置时间 |
| `POST /backend-api/wham/rate-limit-reset-credits/consume` | 使用一次重置机会 |

这些接口和官方 Codex CLI 用的是同一套，但属于未公开的私有接口，OpenAI 随时可能
改动。

倒计时的截止时间保存在 `$PI_CODING_AGENT_DIR/reset-chatgpt.json`（默认
`~/.pi/agent/reset-chatgpt.json`），重启 pi 之后依然有效。到期或执行
`/reset-chatgpt clear` 后该文件会被删除。

## 说明

- 重置机会在发放后 30 天过期，列表按最快过期的排在前面。
- 如果确认后返回 `nothing_to_reset`，说明当前额度并未受限，重置机会没有被消耗。
- 本项目与 OpenAI 无关。

## 许可证

MIT
