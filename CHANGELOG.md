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
- All logic moved to `Timer.js` (`.pragma library`), unit-tested under
  Node with line coverage enforced at 95 %.

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

## [0.1.0] - 2026-08-12

Upstream release of markbus-ai/omarchy-pomodoro (`markbusking.pomodoro`):
bar pill with phase tint, popup controller with count dots, progress bar
and transport buttons, notifications and sounds at phase end, the six
duration/sound/colour settings, IPC `open close toggle`.

[Unreleased]: https://github.com/abobreshov/omarchy-pomodoro/compare/54dec95...HEAD
[0.1.0]: https://github.com/markbus-ai/omarchy-pomodoro/commit/54dec957244d7090bc1c46be7244f8a60a7f4866
