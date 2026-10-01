# pi-codex-plan

[English](README.md) · [中文](README.zh-CN.md)

A [pi](https://pi.dev) extension for the ChatGPT (Codex) plan pi is logged into:

- **Limits below the editor** — the 5-hour and weekly windows as bars, how much is used, when each resets, how
  many banked resets you have, and (after redeeming one) how long until the original weekly reset.
- **`/codex reset`** — list the banked rate-limit resets and redeem one.

```
Codex │ 5h 2h30m ━━━━━━━━━━━━━━━━━━ 12% │ Week 3d4h ━━━━━━━━━━━━━━━━━ 59% │ 2 resets │ spend by 2d23h
```

The line follows your ChatGPT login, not the selected model, so it also shows under routers and other providers.
Bars show how much is used and turn amber over 50% and red over 75%; the countdown turns amber under 24 hours and red under 2.

## Install

```bash
pi install git:github.com/fyang93/pi-codex-plan
```

Requires a ChatGPT login in pi (`/login`, pick ChatGPT). Without one the line stays hidden.

## Commands

| Command | What it does |
|---|---|
| `/codex` | Refresh the limits now |
| `/codex reset` | List banked resets (soonest to expire first) and redeem one |
| `/codex clear` | Dismiss the post-reset countdown |

The limits refresh every five minutes and after each turn (at most once a minute).

Redeeming asks for confirmation with **Cancel as the default**, because it spends the reset for good.

## Why the countdown

Redeeming a banked reset restores your quota immediately, but it does **not** move the original weekly reset.
Whatever you have not spent by then is gone, so the extension records the original reset time before redeeming
and shows how long you have left to use what you got back.

## How it works

It reads your ChatGPT OAuth token from pi's credential store (`~/.pi/agent/auth.json`, or
`$PI_CODING_AGENT_DIR/auth.json`) and only talks to `chatgpt.com`:

| Endpoint | Used for |
|---|---|
| `GET /backend-api/wham/usage` | Rate-limit windows |
| `GET /backend-api/wham/rate-limit-reset-credits` | Banked resets |
| `POST /backend-api/wham/rate-limit-reset-credits/consume` | Redeem one reset |

These are the private endpoints the official Codex CLI uses; OpenAI can change them at any time. The countdown is
stored in `$PI_CODING_AGENT_DIR/codex-plan.json` and deleted once it passes or after `/codex clear`.

Banked resets expire 30 days after they are granted. `nothing_to_reset` means your quota is not limited right now
and no reset was spent. The bar style follows [pi-sub-bar](https://github.com/marckrenn/pi-sub-bar).
This project is not affiliated with OpenAI.

## License

MIT
