# Pomodoro (abobreshov.pomodoro)

A Pomodoro focus timer for the [Omarchy](https://omarchy.org/) shell: a bar
pill that counts down the current phase, a popup controller, desktop
notifications and system sounds when a phase completes — and, in this fork,
a task attached to the timer from the todo panel, a state file other plugins
can read, and optional recording of every work phase through `todocli`.

Forked from <https://github.com/markbus-ai/omarchy-pomodoro> (MIT, Copyright
(c) 2026 markbus-ai). The phases, durations, settings keys, pill, popup,
keys, notification copy and sounds are upstream's; what changed is listed
under [Deviations from upstream](#deviations-from-upstream).

## What you see

- **Bar pill** — stopwatch glyph and remaining time. Green coffee during
  breaks. Middle click starts/pauses without opening the popup. On a
  vertical bar the pill is the glyph alone, one icon slot high; the time
  moves into the tooltip.
- **Popup** — phase label with pomodoro count dots, a large remaining-time
  readout, a progress bar, and transport buttons. While a task is attached
  the popup shows its title on a line of its own with a detach button.
  Keyboard: Space start/pause, R reset, S skip, X detach, Esc close.
- **Notifications + sound** — phase completion fires a desktop notification
  and plays a system sound (`alarm-clock-elapsed` after work, `complete`
  after a break). With a task attached, its title goes on the second line
  of the notification, and clicking a work-end notification opens the todo
  panel on that task.

## Install

```bash
omarchy plugin add https://github.com/abobreshov/omarchy-pomodoro --enable
```

Remove it with:

```bash
omarchy plugin remove abobreshov.pomodoro
```

The plugin declares `kinds: ["service", "bar-widget"]`: the shell creates the
service (`Service.qml`, the one timer) once per session and a pill
(`BarWidget.qml`) once per monitor. The manifest ships with
`keepLoaded: true`, so a hot reload of any plugin under
`~/.config/omarchy/plugins` leaves a running phase untouched. The cost: a
code change to *this* plugin only applies after `omarchy restart shell`.
While developing, remove `keepLoaded` from the manifest to get hot reload
back and add it again before releasing.

## Settings

Settings live in the widget's entry in `~/.config/omarchy/shell.json`. The
service reads that entry out of the bar configuration the shell injects
(`shell.barConfig`, refreshed on every change), so the settings are known
before any pill exists. Set them with
`omarchy bar set abobreshov.pomodoro <key> <value>`:

| Key | Default | What it does |
|---|---|---|
| `workMinutes` | `25` | Work phase length in minutes |
| `shortBreakMinutes` | `5` | Short break length in minutes |
| `longBreakMinutes` | `15` | Long break length in minutes |
| `pomodorosPerCycle` | `4` | Completed work sessions before a long break |
| `sound` | `true` | `false` silences the phase-end sounds |
| `breakColor` | `"#a6e3a1"` | Color used for the break pill (catppuccin green) |
| `backend` | `"none"` | `"cli"` records every work phase through `todocli pomodoro start / done / cancel / retarget / interrupt`. Any other value means `none`. |
| `cliPath` | `"todocli"` | Command name or absolute path, run as a plain argv process (never a shell) behind `/usr/bin/env --`, so a value starting with `-` is still a program name. The default resolves on the shell's PATH, which contains `~/.cargo/bin` on a default Omarchy install; elsewhere set the absolute path, for example `/home/you/.cargo/bin/todocli` (QML does not expand `~`). Residual: a value containing `=` is read by `env` as a variable assignment, so keep `=` out of the path. |
| `todoTarget` | `"abobreshov.todo"` | IPC target opened when a work-end notification is clicked |

Numbers need `--json`, or they land in `shell.json` as strings (the plugin
coerces either way, so a string still works):

```bash
omarchy bar set abobreshov.pomodoro workMinutes 50 --json
omarchy bar set abobreshov.pomodoro sound false --json
omarchy bar set abobreshov.pomodoro backend cli
```

## Interactions

- Bar pill: left = popup, middle = start/pause, tooltip shows phase + time
  (and the attached task on a second line).
- Popup: Space start/pause, R reset, S skip, X detach the task, Tab moves to
  the neighboring bar panel, Esc closes.

### IPC

`omarchy-shell abobreshov.pomodoro <function> [args…]`

| Function | Reply |
|---|---|
| `open`, `close`, `show`, `hide`, `toggle` | — (upstream; relayed to every monitor's pill) |
| `start` | `started` from idle, else `paused` / `resumed` |
| `pause` | `paused` / `resumed` / `idle` |
| `startFor <taskId> <label>` | `started`, `retargeted`, `resumed`, `already running` or `empty`. `taskId` may be `""` for a free-text label. Idle or in a break: starts a work phase attached to the task. Running on another task: keeps the remaining time and attaches the new task (the record splits). Paused: resumes. The label is sanitised (control characters become spaces, trimmed, at most 120 characters). |
| `detach` | `detached` / `idle` |
| `skip`, `reset` | `ok` |
| `status` | one JSON line: `{version, backend, cliPath, phase, running, remaining, endsAt, completed, taskId, label, sessionUid, lastRecordError, restored}` |

The todo plugin (`abobreshov.todo`) calls `startFor` when you press `p` on a
task; with the timer already on that task it calls `pause` instead, which
toggles.

## Timer mechanics

- **Wall-clock deadline.** While running, the phase ends at `endsAt`; each
  second the remaining time is recomputed from the clock, so nothing drifts.
- **Suspend is a pause.** If more than five seconds pass between two ticks
  (the machine slept), the timer pauses itself at the remaining time of the
  last tick. A phase never completes because of a suspend; press Space to
  resume.
- **State file** `~/.local/state/abobreshov.pomodoro/state.json`, written
  atomically by the service on every transition and at most once a minute
  while running (a checkpoint of the remaining time and the focus seconds).
  The directory is created with mode `0700`; the file holds task titles.
  Readers (the todo plugin) compute the remaining time as
  `running ? max(0, endsAt - now) : remaining` and treat
  `running && now > endsAt + 10 s` as idle.
- **Restore after a reload.** When the service starts (shell restart, crash,
  or a development hot reload) it makes the state directory private and
  reads the state file, then restores. A phase no older than
  `remaining + 60 s` comes back **paused** with its task, session and
  checkpointed focus seconds; the popup says `Restored after a reload ·
  Space resumes` until you resume, skip or the phase changes. An older state
  with an open session is closed as `interrupted` with its checkpoint and
  the timer starts idle. Should an IPC call land in the few milliseconds
  before that read (the target registers after 100 ms), the live timer wins
  and only the pomodoro count, a pending close and the saved session's
  `interrupt` are taken from the file.

## Recording (`backend = cli`)

Every work phase is one `todocli` pomodoro session (`todocli` is the CLI of
the `productivity` monorepo this fork is developed in; a public repository
is planned, not published yet):

| Timer event | `todocli --source omarchy --json pomodoro …` |
|---|---|
| Work phase starts running | `start <id>` or `start --label=<label>`, `--planned <workMinutes × 60> --interrupt` |
| Work phase reaches 0:00 | `done <uid> --focus-seconds <n>` |
| Skip during work | `cancel <uid> --focus-seconds <n>` |
| `startFor` another task during work | `retarget <uid> <id> --focus-seconds <n> --planned <remaining>` |
| Detach (`x`) | `retarget <uid> --label=Pomodoro --focus-seconds <n>` |
| Stale state at service start | `interrupt <uid> --focus-seconds <checkpoint>` |

`<n>` is the running time of the session: pauses and suspends are excluded.
Reset keeps the session and its seconds. Timer sessions started with no task
are recorded with `--label`.

Recording never stops the timer. A failed call shows
`Last session not recorded: <reason>.` under the task line (`todocli not
found`, `database busy` or `todocli error`; the same text is in
`status.lastRecordError`) and:

- a failed `start` is retried at the end of the phase with
  `--started-at <phase start>`, followed by the close;
- a failed `done` or `cancel` is kept in the state file as a pending close
  and re-sent once, with its measured seconds, before the next `start`;
- a re-send answered with an error is dropped (the reason stays visible), and
  the next work phase starts cleanly.

`todocli` runs as an argv list through `/usr/bin/env -- <cliPath> …`, so a
missing binary exits 127 without any shell and a `cliPath` starting with
`-` is never an `env` option. Commands wait in a queue, one at a time, in
the order the timer produced them.

## Data

- `~/.local/state/abobreshov.pomodoro/state.json` — the timer's state file
  (mode 0700 directory). Delete the directory to forget a restored phase.

## Development

```bash
omarchy plugin validate .                      # manifest and layout
node --test --experimental-test-coverage \
     --test-coverage-lines=95 --test-coverage-include="**/*.js" test/
test/qmllint.sh                                # qmllint with the qs import root
test/service-smoke.sh                          # opt-in: Service.qml in a scratch Quickshell instance (~80 s)
```

The smoke test starts its own `qs` instance with `HOME` redirected to a
scratch directory, a logging fake `omarchy-notification-send` and the fake
todocli, then drives the IPC target through a whole one-minute phase and the
restore paths. It never touches the running shell or your state.

All of the logic is in `.pragma library` JavaScript, one module per concern,
behind the `Timer.js` facade that the three QML files import:

| Module | Owns |
|---|---|
| `Phase.js` | phases and their lengths, the deadline arithmetic, settings coercion, the label and task-id sanitisers |
| `StateFile.js` | the state-file document and its tolerant parser |
| `Notify.js` | notification copy and argv, the phase-end sounds |
| `Record.js` | the `todocli` argv per verb, exit classification, the one-at-a-time record queue and its recovery rules (retry a failed start, re-send a failed close once) |
| `Machine.js` | the state, the transitions, the restore on service start, the event handlers and the pure `reduce(state, event, now, cfg) → { state, effects, reply }` |
| `View.js` | the `status` JSON, the pill and popup view, tooltip, hint, captions and pill geometry |
| `Timer.js` | one-line pass-throughs to the above; the only file QML imports |

Every code file, tests included, stays under 500 lines; one that grows past
the limit is split by responsibility, never waived (the productivity repo's
`tools/check-file-length.sh` gate).

`test/qml-js-loader.mjs` runs a library under Node with a small `vm` loader
that resolves `.import "Other.js" as Name` between modules the way the QML
engine does and hides Node's own globals (`process`, `Buffer`, timers,
`fetch`, `require`) so a call that would not exist in QML fails the tests;
`test/harness.mjs` drives the reducer and checks after every event that it
left its input state untouched; `test/fakebin/todocli` stands in for the
real CLI in the recording tests. The test files mirror the modules:
`phase`, `notify`, `machine`, `queue`, `restore`, `view`, `record` (the fake
todocli end to end), `timer` (the facade) and `loader`.

## License

MIT. Upstream copyright (c) 2026 markbus-ai; modifications copyright (c)
2026 Alexander Bobreshov. See `LICENSE`.

## Deviations from upstream

| Deviation | Why |
|---|---|
| Timer moved into a plugin `service` (`kinds: ["service", "bar-widget"]`) | One timer, one notification and one record per phase on any number of monitors; one IPC owner |
| Wall-clock deadline instead of a decrementing 1 s tick | The tick drifts and stops during suspend; the todo panel renders from `endsAt` |
| Suspend detected and treated as a pause | A deadline alone would complete the phase on wake and record time nobody worked |
| State file, checkpointed once a minute, with restore-paused on startup and `keepLoaded: true` | Hand-off to the todo panel without polling; a reload must not end a phase or lose its task |
| New IPC: `start`, `pause`, `startFor`, `detach`, `skip`, `reset`, `status` | Scripts and the todo panel drive and read the timer |
| Vertical bars: glyph only, one icon slot high | Upstream's 56 px pill overflows a 28 px vertical bar |
| `license` key in the manifest | Upstream's manifest had none; the LICENSE file says MIT |
| `Layout.alignment: Qt.AlignVCenter` on the popup's phase-row texts instead of `anchors.verticalCenter` | Anchors on `RowLayout` children are undefined behaviour in Qt and warn at runtime |

### Not implemented

- UX 5.2's 4 s transient `Closed the pomodoro started from claude (#7, 12m).`
  when a `start --interrupt` closes a session another surface left running:
  the session object `todocli pomodoro start --json` prints has no field for
  the closed session, so the plugin cannot know it happened.
