.pragma library
.import "Phase.js" as Phase
.import "StateFile.js" as StateFile
.import "Notify.js" as Notify
.import "Record.js" as Record

// abobreshov.pomodoro — the pomodoro state machine, pure and clock-injected
// (PLAN §7.3, A47).
//
// Service.qml owns one instance of this state and feeds it events through
// `reduce(state, event, now, cfg) -> { state, effects, reply }`. Nothing here
// touches QML, the file system or a process: every side effect comes back as
// an effect object the service runs (`record`, `writeState`, `notify`,
// `sound`), so the whole machine is unit-tested under Node (test/). The
// reducer never changes the state it was given: it works on a shallow copy
// and copies every queued record action it fills in.
//
// Phases and their transitions are upstream's (markbus-ai/omarchy-pomodoro):
// idle → work → short or long break → work (paused) …; skip moves on without
// counting. Reset deviates (UX 6.2): it abandons the phase and returns to
// idle with no task, the one way back. Underneath, the fork keeps a
// wall-clock deadline (`endsAt`) instead of a decrementing tick, treats a gap
// of more than five seconds between ticks as a pause (suspend), records
// sessions through todocli when `backend = cli` (Record.js) and checkpoints
// a state file (StateFile.js).

var SUSPEND_GAP_MS = 5000
var CHECKPOINT_MS = 60000
var RESTORE_GRACE_MS = 60000

// ---------------------------------------------------------------- state

// `now` is the ms the service instance was created (`Date.now()` in
// Service.qml; the tests pass nothing). `loadedAt` names the instance, not
// the phase: no event and no restore changes it and the state file never
// carries it, so `status` can tell whether `omarchy restart shell` replaced
// the service that `keepLoaded: true` keeps alive across a plugin update
// (README "Install": a `loadedAt` older than the update is the old code).
function initialState(now) {
  return {
    loadedAt: typeof now === "number" && isFinite(now) ? now : null,
    phase: "idle",           // idle | work | shortBreak | longBreak
    running: false,
    endsAt: null,            // ms wall clock while running
    remaining: 0,            // seconds left, frozen while paused
    completed: 0,
    taskId: "",
    taskLabel: "",
    sessionUid: null,        // uid of the open recorded session, when known
    focusSeconds: 0,         // running seconds of the current session
    lastTickAt: null,
    pendingClose: null,      // { verb, sessionUid, focusSeconds } of a failed close
    lastRecordError: null,   // todocli not found | database busy | todocli error
    restored: false,
    failedStart: null,       // { taskId, label, planned, startedAt } to retry at phase end
    recorded: false,         // a start was issued for the current work phase
    lastWriteAt: null,
    queue: [],               // record actions waiting for the one in flight
    inflight: null,
    nextRecordId: 1
  }
}

// Shallow: nested objects are never written in place (queue and inflight
// actions are copied when filled in; the rest is replaced wholesale).
function clone(state) {
  var next = {}
  for (var k in state) next[k] = state[k]
  return next
}

// ------------------------------------------------------ transitions

function startPhase(state, cfg, now, phase, run) {
  state.phase = phase
  state.remaining = Phase.phaseSeconds(phase, cfg)
  state.running = run
  state.endsAt = run ? now + state.remaining * 1000 : null
  state.lastTickAt = now
  state.focusSeconds = 0
  state.recorded = false
  state.restored = false
}

function attach(state, taskId, label) {
  state.taskId = taskId
  state.taskLabel = label
}

// Back to `initialState`'s phase fields: no phase, no task, no session. The
// pomodoro count, a pending close, the record error and the queue stay —
// they belong to the cycle and to the recording layer, not to the phase.
function goIdle(state) {
  state.phase = "idle"
  state.running = false
  state.endsAt = null
  state.remaining = 0
  state.lastTickAt = null
  state.focusSeconds = 0
  state.recorded = false
  state.restored = false
  state.sessionUid = null
  attach(state, "", "")
}

// The one focus-time rule (A47): while running a work phase, the time since
// the last tick counts, capped at 2 s per step; breaks and pauses never do.
function accrueFocus(state, now) {
  if (state.running && state.phase === "work" && state.lastTickAt !== null)
    state.focusSeconds += Math.min(2, Math.max(0, (now - state.lastTickAt) / 1000))
  state.lastTickAt = now
}

function resume(state, effects, cfg, now) {
  state.running = true
  state.endsAt = now + state.remaining * 1000
  state.lastTickAt = now
  state.restored = false
  if (state.phase === "work" && !state.recorded) Record.openSession(state, effects, cfg, now)
}

function pause(state, now) {
  accrueFocus(state, now)
  state.remaining = Phase.remainingAt(state, now)
  state.running = false
  state.endsAt = null
}

function beginWork(state, effects, cfg, now) {
  startPhase(state, cfg, now, "work", true)
  Record.openSession(state, effects, cfg, now)
}

// The timer keeps its remaining time; the record splits (UX 6.2): `close`
// names the new session's target, `taskId`/`label` the timer's.
function switchTask(state, effects, cfg, now, taskId, label, close) {
  if (state.phase === "work" && state.recorded) {
    accrueFocus(state, now)
    Record.enqueueClose(state, effects, cfg, "retarget", close)
    state.focusSeconds = 0
  }
  attach(state, taskId, label)
}

function retarget(state, effects, cfg, now, taskId, label) {
  switchTask(state, effects, cfg, now, taskId, label, { taskId: taskId, label: label, planned: Phase.remainingAt(state, now) })
}

// `x`: the session continues unlinked as `Pomodoro`; the label is cleared.
function detach(state, effects, cfg, now) {
  switchTask(state, effects, cfg, now, "", "", { taskId: "", label: Phase.UNLINKED_LABEL, planned: null })
}

function completePhase(state, effects, cfg, now) {
  state.running = false
  if (state.phase === "work") {
    state.completed += 1
    var long = state.completed % cfg.pomodorosPerCycle === 0
    Record.enqueueClose(state, effects, cfg, "done")
    startPhase(state, cfg, now, long ? "longBreak" : "shortBreak", true)
    Notify.pushNotify(state, effects, cfg, long ? "longBreak" : "workEnd")
  } else {
    if (state.phase === "longBreak") state.completed = 0
    startPhase(state, cfg, now, "work", false)
    Notify.pushNotify(state, effects, cfg, "breakEnd")
  }
}

function sameTask(state, taskId, label) {
  if (taskId !== "") return taskId === state.taskId
  return state.taskId === "" && label === state.taskLabel
}

function tick(state, effects, cfg, now) {
  if (!state.running || state.phase === "idle") return
  var gap = now - (state.lastTickAt === null ? now : state.lastTickAt)
  if (gap > SUSPEND_GAP_MS) {
    // The machine slept: pause as of the last tick; the gap is not focus time.
    pause(state, state.lastTickAt)
    state.lastTickAt = now
    StateFile.writeState(state, effects, now)
    return
  }
  accrueFocus(state, now)
  state.remaining = Phase.remainingAt(state, now)
  if (state.remaining <= 0) {
    completePhase(state, effects, cfg, now)
    StateFile.writeState(state, effects, now)
    return
  }
  if (state.lastWriteAt === null || now - state.lastWriteAt >= CHECKPOINT_MS) StateFile.writeState(state, effects, now)
}

// ---------------------------------------------------------- restore

// Restore on service start (PLAN A22, UX 6.5) from the raw state file text:
// a recent phase comes back paused; an old one with a session is closed as
// interrupted; else idle. Two guards for the startup window: the IPC handler
// enables at 100 ms, so an event may already have run — then the live timer
// wins and only the count, a pending close and the owed interrupt are
// adopted; and a session may be closed only once the settings are known
// (`backend = none` would drop the interrupt), so with
// `event.settingsKnown === false` the restore replies `deferred` and changes
// nothing, and the service asks again when the shell arrives.
function serviceStart(state, effects, cfg, now, event) {
  var s = StateFile.parseStateFile(event.text)
  if (s === null) {
    StateFile.writeState(state, effects, now)
    return ""
  }
  var age = s.updatedAt === null ? NaN : now - s.updatedAt
  var recent = s.phase !== "idle" && age >= 0 && age <= s.remaining * 1000 + RESTORE_GRACE_MS
  var restores = state.phase === "idle" && recent
  var owesInterrupt = s.phase !== "idle" && s.sessionUid !== null && !restores
  if (owesInterrupt && event.settingsKnown === false) return "deferred"
  state.completed = s.completed
  if (state.pendingClose === null) state.pendingClose = s.pendingClose
  if (restores) {
    state.phase = s.phase
    state.running = false
    state.endsAt = null
    state.remaining = s.remaining
    state.taskId = s.taskId
    state.taskLabel = s.taskLabel
    state.sessionUid = s.sessionUid
    state.focusSeconds = s.focusSeconds
    state.recorded = s.phase === "work" && s.sessionUid !== null
    state.restored = true
    state.lastTickAt = now
  } else if (owesInterrupt) {
    Record.enqueue(state, effects, cfg, { verb: "interrupt", sessionUid: s.sessionUid, focusSeconds: s.focusSeconds })
  }
  StateFile.writeState(state, effects, now)
  return ""
}

// -------------------------------------------------------------- events

// UX 6.2: the result word per timer state.
function startFor(state, effects, cfg, now, event) {
  var taskId = Phase.sanitizeTaskId(event.taskId)
  var label = Phase.sanitizeLabel(event.label)
  if (label === "") return "empty"
  var reply
  if (state.phase === "idle" || Phase.isBreak(state.phase)) {
    attach(state, taskId, label)
    beginWork(state, effects, cfg, now)
    reply = "started"
  } else if (state.running) {
    if (sameTask(state, taskId, label)) return "already running"
    retarget(state, effects, cfg, now, taskId, label)
    reply = "retargeted"
  } else if (sameTask(state, taskId, label)) {
    resume(state, effects, cfg, now)
    reply = "resumed"
  } else {
    retarget(state, effects, cfg, now, taskId, label)
    resume(state, effects, cfg, now)
    reply = "retargeted"
  }
  StateFile.writeState(state, effects, now)
  return reply
}

function onToggle(state, effects, cfg, now) {
  var reply
  if (state.phase === "idle") {
    beginWork(state, effects, cfg, now)
    reply = "started"
  } else if (state.running) {
    pause(state, now)
    reply = "paused"
  } else {
    resume(state, effects, cfg, now)
    reply = "resumed"
  }
  StateFile.writeState(state, effects, now)
  return reply
}

// `pause` toggles (the todo panel's `p` on the attached task); `resume` only resumes.
function onPause(state, effects, cfg, now) {
  if (state.phase === "idle") return "idle"
  if (state.running) pause(state, now)
  else resume(state, effects, cfg, now)
  StateFile.writeState(state, effects, now)
  return state.running ? "resumed" : "paused"
}

function onResume(state, effects, cfg, now) {
  if (state.phase === "idle") return "idle"
  if (!state.running) resume(state, effects, cfg, now)
  StateFile.writeState(state, effects, now)
  return "resumed"
}

function onSkip(state, effects, cfg, now) {
  if (state.phase === "work") {
    pause(state, now)
    Record.enqueueClose(state, effects, cfg, "cancel")
    startPhase(state, cfg, now, "shortBreak", true)
    StateFile.writeState(state, effects, now)
  } else if (Phase.isBreak(state.phase)) {
    startPhase(state, cfg, now, "work", false)
    StateFile.writeState(state, effects, now)
  }
  return "ok"
}

// `R` / IPC `reset` (UX 6.2, a fork deviation): the phase is abandoned and
// the machine returns to idle with no task, whatever the phase. A recorded
// work session is closed as `cancel` with its running seconds through the
// same path as skip, so todocli sees it; a break or an unrecorded work phase
// records nothing. The state file is written idle, so the todo panel's
// markers disappear.
function onReset(state, effects, cfg, now) {
  if (state.phase === "idle") return "idle"
  if (state.phase === "work") {
    pause(state, now)
    Record.enqueueClose(state, effects, cfg, "cancel")
  }
  goIdle(state)
  StateFile.writeState(state, effects, now)
  return "reset"
}

function onDetach(state, effects, cfg, now) {
  if (state.phase === "idle") return "idle"
  detach(state, effects, cfg, now)
  StateFile.writeState(state, effects, now)
  return "detached"
}

// Every handler is `(state, effects, cfg, now, event) -> reply | undefined`
// and works on the copy `reduce` made.
var HANDLERS = {
  tick: tick,
  startFor: startFor,
  toggle: onToggle,
  pause: onPause,
  resume: onResume,
  skip: onSkip,
  reset: onReset,
  detach: onDetach,
  serviceStart: serviceStart,
  recordResult: Record.recordResult
}

function reduce(prev, event, now, cfg) {
  var state = clone(prev)
  var effects = []
  var type = event && typeof event === "object" ? String(event.type) : ""
  var handler = Object.prototype.hasOwnProperty.call(HANDLERS, type) ? HANDLERS[type] : null
  var reply = handler ? (handler(state, effects, cfg, now, event) || "") : ""
  return { state: state, effects: effects, reply: reply }
}
