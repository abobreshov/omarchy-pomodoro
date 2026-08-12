# Pomodoro

A Pomodoro focus timer for the [Omarchy](https://omarchy.org/) shell: a bar
pill that counts down the current phase, a popup controller, desktop
notifications and system sounds when a phase completes.

`Panel.qml` owns the bar pill and the popup. The timer cycles work, short
break, and long break phases; the bar pill tints by phase — the theme accent
while focusing, a distinct green during breaks — so you can read the state at
a glance without opening anything.

## What you see

- **Bar pill** — stopwatch glyph and remaining time. Green coffee during
  breaks. Middle click starts/pauses without opening the popup.
- **Popup** — phase label with pomodoro count dots, a large remaining-time
  readout, a progress bar, and transport buttons. Keyboard: Space start/pause,
  R reset, S skip, Esc close.
- **Notifications + sound** — phase completion fires a desktop notification
  and plays a system sound (`alarm-clock-elapsed` after work,
  `complete` after a break).

## Install

```bash
omarchy plugin add https://github.com/markbus-ai/omarchy-pomodoro --enable
```

The widget joins the bar's default layout at the next shell reload
(`omarchy-restart-shell`). Remove it with:

```bash
omarchy plugin remove markbusking.pomodoro
```

## Settings

Settings live in the widget's entry in `~/.config/omarchy/shell.json`. Set
them with `omarchy bar set markbusking.pomodoro <key> <value>`:

| Key | Default | What it does |
|---|---|---|
| `workMinutes` | `25` | Work phase length in minutes |
| `shortBreakMinutes` | `5` | Short break length in minutes |
| `longBreakMinutes` | `15` | Long break length in minutes |
| `pomodorosPerCycle` | `4` | Completed work sessions before a long break |
| `sound` | `true` | `false` silences the phase-end sounds |
| `breakColor` | `"#a6e3a1"` | Color used for the break pill (catppuccin green) |

Numbers need `--json`, or they land in `shell.json` as strings:

```bash
omarchy bar set markbusking.pomodoro workMinutes 50 --json
omarchy bar set markbusking.pomodoro sound false --json
```

## Interactions

- Bar pill: left = popup, middle = start/pause, tooltip shows phase + time.
- Popup: Space start/pause, R reset, S skip, Tab moves to the neighboring bar
  panel, Esc closes.
- IPC: `omarchy-shell markbusking.pomodoro <open|close|toggle>`.

## License

MIT.
