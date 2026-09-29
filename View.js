.pragma library
.import "Phase.js" as Phase
.import "Machine.js" as Machine

// abobreshov.pomodoro — what the widgets and `status` show (UX §5.1, §5.2;
// PLAN §7.4, A53): the `status()` JSON line, the view the pill and the popup
// bind to (derived once per state change), the tooltip and hint copy, the
// two captions and the pill's geometry. Text and numbers only; nothing here
// changes the state.

function statusJson(state, cfg, now) {
  return JSON.stringify({
    version: 1,
    backend: cfg.backend,
    cliPath: cfg.cliPath,
    phase: state.phase,
    running: state.running,
    remaining: now === undefined ? state.remaining : Phase.remainingAt(state, now),
    endsAt: state.endsAt,
    completed: state.completed,
    taskId: state.taskId,
    label: state.taskLabel,
    sessionUid: state.sessionUid,
    lastRecordError: state.lastRecordError,
    restored: state.restored
  })
}

function phaseLabel(phase) {
  if (phase === "work") return "Work"
  if (phase === "shortBreak") return "Short break"
  if (phase === "longBreak") return "Long break"
  return "Pomodoro"
}

// Kit-owned text (the bar tooltip) gets `<`/`>` mapped to `‹`/`›`, the
// todo fork's rule for text it cannot set textFormat on (PLAN §6.1, A24).
function tooltipText(s) {
  return String(s).replace(/</g, "‹").replace(/>/g, "›")
}

// UX 5.1: upstream's first line, the task on a second line when attached.
function tooltip(state) {
  if (state.phase === "idle") return "Pomodoro — click to start"
  var first = phaseLabel(state.phase) + " — " + (state.running ? Phase.formatTime(state.remaining) : "paused")
  if (state.taskLabel === "") return first
  return first + "\n" + (Phase.isBreak(state.phase) ? "Next: " : "") + tooltipText(state.taskLabel)
}

function hint(state) {
  return "Space start · R reset · S skip" + (state.taskLabel !== "" ? " · X detach" : "")
}

function recordCaption(reason) {
  return reason ? "Last session not recorded: " + reason + "." : ""
}

function restoredCaption(restored) {
  return restored ? "Restored after a reload · Space resumes" : ""
}

// Exactly what the pill and the popup bind to, derived once per state change.
function view(state, cfg) {
  var hasSession = state.phase !== "idle"
  var secs = Phase.phaseSeconds(state.phase, cfg)
  return {
    isBreak: Phase.isBreak(state.phase),
    hasSession: hasSession,
    playing: state.running && hasSession,
    phaseGlyph: Phase.isBreak(state.phase) ? Phase.GLYPH_BREAK : Phase.GLYPH_WORK,
    phaseLabel: phaseLabel(state.phase),
    progress: secs > 0 ? Math.max(0, Math.min(1, 1 - state.remaining / secs)) : 0,
    timeText: Phase.formatTime(hasSession ? state.remaining : secs),
    remainingText: Phase.formatTime(state.remaining),
    tooltip: tooltip(state),
    hint: hint(state),
    attached: state.taskLabel !== "",
    taskLabel: state.taskLabel,
    completed: state.completed,
    perCycle: cfg.pomodorosPerCycle,
    recordCaption: recordCaption(state.lastRecordError),
    restored: state.restored,
    restoredCaption: restoredCaption(state.restored)
  }
}

// The widgets' fallback while the service is not bound yet.
function idleView() {
  return view(Machine.initialState(), Phase.settings({}))
}

// UX 5.1: horizontal = upstream's Style.space(56) × barSize with glyph and
// time, dimmed to 0.7 while idle; vertical = barSize × iconSlot, glyph only,
// time in the tooltip, dimmed unless playing.
function pillLayout(vertical, m, v) {
  if (vertical) return { width: m.barSize, height: m.iconSlot, showTime: false, opacity: v.playing ? 1.0 : 0.7 }
  return { width: m.pillWidth, height: m.barSize, showTime: true, opacity: v.hasSession ? 1.0 : 0.7 }
}
