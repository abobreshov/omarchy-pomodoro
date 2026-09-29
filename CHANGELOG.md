# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Forked as `abobreshov.pomodoro` from `markbusking.pomodoro`
  (markbus-ai/omarchy-pomodoro, MIT); the upstream LICENSE is kept with the
  fork's copyright line added and `"license": "MIT"` in the manifest.
- The timer lives in a plugin `service` (`kinds: ["service", "bar-widget"]`,
  `keepLoaded: true`): one timer per session, one IPC owner, one
  notification and one record per phase on every monitor.
- Wall-clock deadline instead of a decrementing 1 s tick; a gap of more
  than five seconds between ticks (suspend) pauses the timer instead of
  completing the phase.
- Vertical bars show the phase glyph alone, one icon slot high, with the
  remaining time in the tooltip.
- All logic moved out of QML into `.pragma library` modules, one per
  concern — `Phase.js`, `StateFile.js`, `Notify.js`, `Record.js`,
  `Machine.js`, `View.js` — behind the `Timer.js` facade the QML files
  import; unit-tested under Node with line coverage enforced at 95 %, the
  test files mirroring the modules. No code file exceeds 500 lines.
- `todocli` runs behind `/usr/bin/env -- <cliPath>`, so a `cliPath` that
  starts with `-` is a program name, never an `env` option.
- Settings are read from the widget's entry in the bar configuration the
  shell injects into the service, so the restore after a reload never waits
  for a pill to appear.

### Added

- Task attachment: IPC `startFor <taskId> <label>` (the todo plugin's `p`),
  a task line in the popup, `x` to detach, the task title on the second
  line of the notifications and a click on a work-end notification that
  opens the todo panel on that task.
- IPC `start`, `pause`, `detach`, `skip`, `reset` and `status` (one JSON
  line), beside upstream's `open close show hide toggle`.
- State file `~/.local/state/abobreshov.pomodoro/state.json` (0700
  directory, atomic writes, checkpointed at most once a minute while
  running) and restore after a reload: a recent phase comes back paused
  with its task and session, an old one is closed as interrupted.
- Optional recording through `todocli` (`backend = cli`, `cliPath`):
  `pomodoro start / done / cancel / retarget / interrupt` with the measured
  focus seconds, a one-at-a-time queue, a failed start retried at phase end,
  a failed close re-sent once before the next start, and the caption
  `Last session not recorded: <reason>.`
- Settings `backend`, `cliPath`, `todoTarget`; every setting is coerced so a
  string value set without `--json` still works.

### Fixed

- The state directory is made private (`0700`) before the first write, and a
  failed `install -d` or a failed save is logged instead of ignored.
- An IPC call that lands before the state file was read keeps the live
  timer; the saved count, a pending close and the saved session's
  `interrupt` are adopted instead of overwriting it.
- Detaching a task during a running break no longer counts break time as
  focus time.
- The bar pill's tooltip shows: the bar only shows a tooltip for a target
  that reports `tooltipHovered`, which the pill now does. The text is the
  one handed over on enter and stays put while hovered rather than being
  re-shown on every tick.

## [0.1.0] - 2026-08-12

Upstream release of markbus-ai/omarchy-pomodoro (`markbusking.pomodoro`):
bar pill with phase tint, popup controller with count dots, progress bar
and transport buttons, notifications and sounds at phase end, the six
duration/sound/colour settings, IPC `open close show hide toggle`.

[Unreleased]: https://github.com/abobreshov/omarchy-pomodoro/compare/54dec95...HEAD
[0.1.0]: https://github.com/markbus-ai/omarchy-pomodoro/commit/54dec957244d7090bc1c46be7244f8a60a7f4866
