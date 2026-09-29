# pi-reset-chatgpt

[English](README.md) · [中文](README.zh-CN.md)

A [pi](https://pi.dev) extension that lists the banked Codex rate-limit resets on
the ChatGPT account you are already logged into, lets you redeem one, and then
keeps a countdown in the status bar until your weekly window would have reset
anyway.

## Why the countdown

Redeeming a banked reset restores your quota immediately, but it does **not** move
the original weekly reset. If your window was going to roll over in 3 days, it
still rolls over in 3 days — and whatever quota you have not spent by then is
gone. So the extension records the original reset time before redeeming and shows
how long you have left to actually use what you just got back.

```
⏳ ChatGPT: 2d 23h        # plenty of time left
⏳ ChatGPT: 8h 12m        # amber under 24 hours
⏳ ChatGPT: 47m           # red under 2 hours
```

The countdown appears only after you redeem a reset, and disappears on its own
once the deadline passes. It never interrupts you — urgency is carried by color,
not by notifications.

## Install

```bash
pi install git:github.com/fyang93/pi-reset-chatgpt
```

Or try it for a single run without installing:

```bash
pi -e git:github.com/fyang93/pi-reset-chatgpt
```

Requires a ChatGPT (Codex) login in pi — run `/login` and pick ChatGPT if you
have not already.

## Usage

| Command | What it does |
|---|---|
| `/reset-chatgpt` | List available resets and redeem one |
| `/reset-chatgpt status` | Show the current countdown as a notification |
| `/reset-chatgpt clear` | Dismiss the countdown |

`/reset-chatgpt` shows every reset your account still has, soonest to expire
first:

```
2 resets available — soonest to expire first
  1. Full reset — expires 2026-10-04 10:58 (in 11d 16h)
  2. Full reset — expires 2026-10-05 13:19 (in 12d 18h)
```

Pick one with `enter`, and a second prompt asks you to confirm. **Cancel is the
default** — you have to move the selection to `Confirm` deliberately, because
redeeming spends the reset for good.

## How it works

The extension reads your ChatGPT OAuth token from pi's own credential store
(`~/.pi/agent/auth.json`, or `$PI_CODING_AGENT_DIR/auth.json`). It never asks you
for a token and never sends it anywhere except `chatgpt.com`.

It talks to three endpoints:

| Endpoint | Used for |
|---|---|
| `GET /backend-api/wham/rate-limit-reset-credits` | List banked resets |
| `GET /backend-api/wham/usage` | Read the weekly reset time before redeeming |
| `POST /backend-api/wham/rate-limit-reset-credits/consume` | Redeem one reset |

These are the same endpoints the official Codex CLI uses, but they are private
and undocumented — OpenAI can change them at any time.

The countdown deadline is stored in `$PI_CODING_AGENT_DIR/reset-chatgpt.json`
(default `~/.pi/agent/reset-chatgpt.json`) so it survives restarts. The file is
deleted once the deadline passes or you run `/reset-chatgpt clear`.

## Notes

- Banked resets expire 30 days after they are granted. The list is sorted so the
  one closest to expiring is first.
- If the confirm step reports `nothing_to_reset`, your quota is not currently
  limited and no credit was spent.
- This project is not affiliated with OpenAI.

## License

MIT
