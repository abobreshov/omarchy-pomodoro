.pragma library

// abobreshov.pomodoro — the pomodoro state machine, pure and clock-injected.
//
// Service.qml owns one instance of this state and feeds it events through
// `reduce(state, event, now, cfg) -> { state, effects, reply }`. Nothing here
// touches QML, the file system or a process: every side effect comes back as
// an effect object the service runs (`record`, `writeState`, `notify`,
// `sound`), so the whole machine is unit-tested under Node (test/).
//
// Phases and their transitions are upstream's (markbus-ai/omarchy-pomodoro):
// idle → work → short or long break → work (paused) …; skip moves on without
// counting; reset restores the phase length. Underneath, the fork keeps a
// wall-clock deadline (`endsAt`) instead of a decrementing tick, treats a gap
// of more than five seconds between ticks as a pause (suspend), records
// sessions through todocli when `backend = cli`, and checkpoints a state file.

var STATE_VERSION = 1
var TARGET = "abobreshov.pomodoro"
var SUSPEND_GAP_MS = 5000
var CHECKPOINT_MS = 60000
var RESTORE_GRACE_MS = 60000
var LABEL_MAX = 120
var TASK_ID_MAX = 64
var UNLINKED_LABEL = "Pomodoro"
var GLYPH_WORK = ""   // fa-stopwatch (upstream)
var GLYPH_BREAK = "\u{F0176}" // md-coffee (upstream)
var SOUND_WORK_END = "/usr/share/sounds/freedesktop/stereo/alarm-clock-elapsed.oga"
var SOUND_BREAK_END = "/usr/share/sounds/freedesktop/stereo/complete.oga"
var DEFAULT_OMARCHY_PATH = "/usr/share/omarchy"
var ERR_MISSING = "todocli not found"
var ERR_BUSY = "database busy"
var ERR_FAILED = "todocli error"
var CLOSE_VERBS = { done: true, cancel: true, retarget: true, interrupt: true }

var DEFAULTS = {
  workMinutes: 25,
  shortBreakMinutes: 5,
  longBreakMinutes: 15,
  pomodorosPerCycle: 4,
  sound: true,
  breakColor: "#a6e3a1",
  backend: "none",
  cliPath: "todocli",
  todoTarget: "abobreshov.todo"
}

// ------------------------------------------------------------- settings

// Every value may arrive as a string (`omarchy bar set` without --json), so
// each key is coerced (PLAN A21).
function settings(raw) {
  var r = raw && typeof raw === "object" ? raw : {}
  function minutes(key) {
    var v = r[key]
    return Math.max(1, Number(v === undefined || v === null ? DEFAULTS[key] : v) || DEFAULTS[key])
  }
  function str(key) {
    var v = r[key] === undefined || r[key] === null ? "" : String(r[key])
    return v === "" ? DEFAULTS[key] : v
  }
  return {
    workMinutes: minutes("workMinutes"),
    shortBreakMinutes: minutes("shortBreakMinutes"),
    longBreakMinutes: minutes("longBreakMinutes"),
    pomodorosPerCycle: minutes("pomodorosPerCycle"),
    sound: r.sound !== false && r.sound !== "false",
    breakColor: str("breakColor"),
    backend: String(r.backend) === "cli" ? "cli" : "none",
    cliPath: str("cliPath"),
    todoTarget: str("todoTarget")
  }
}

// Controls (C0, DEL, C1) become spaces; trimmed; at most 120 characters.
function sanitizeLabel(s) {
  return String(s === undefined || s === null ? "" : s).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim().slice(0, LABEL_MAX)
}

function sanitizeTaskId(s) {
  return String(s === undefined || s === null ? "" : s).replace(/[\x00-\x1f\x7f-\x9f]/g, "").trim().slice(0, TASK_ID_MAX)
}

function isNumericId(s) {
  return /^[0-9]+$/.test(String(s))
}

function formatTime(secs) {
  var total = Math.max(0, Math.floor(secs))
  var h = Math.floor(total / 3600)
  var m = Math.floor((total % 3600) / 60)
  var s = total % 60
  var ss = (s < 10 ? "0" : "") + s
  if (h > 0) return h + ":" + ((m < 10 ? "0" : "") + m) + ":" + ss
  return m + ":" + ss
}

// ---------------------------------------------------------------- state

function initialState() {
  return {
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

function clone(state) {
  var next = {}
  for (var k in state) next[k] = state[k]
  return next
}

function phaseSeconds(phase, cfg) {
  if (phase === "shortBreak") return cfg.shortBreakMinutes * 60
  if (phase === "longBreak") return cfg.longBreakMinutes * 60
  return cfg.workMinutes * 60
}

function isBreak(phase) {
  return phase === "shortBreak" || phase === "longBreak"
}

function roundSeconds(n) {
  return Math.max(0, Math.round(Number(n) || 0))
}

function remainingAt(state, now) {
  if (!state.running || state.endsAt === null) return state.remaining
  return Math.max(0, Math.ceil((state.endsAt - now) / 1000))
}

// ------------------------------------------------------------ effects

function stateFileDoc(state, now) {
  return {
    version: STATE_VERSION,
    phase: state.phase,
    running: state.running,
    endsAt: state.endsAt,
    remaining: state.remaining,
    completed: state.completed,
    taskId: state.taskId,
    taskLabel: state.taskLabel,
    sessionUid: state.sessionUid,
    focusSeconds: roundSeconds(state.focusSeconds),
    pendingClose: state.pendingClose,
    updatedAt: now
  }
}

function writeState(state, effects, now) {
  state.lastWriteAt = now
  effects.push({ type: "writeState", doc: stateFileDoc(state, now) })
}

function notifyCopy(kind, label, taskId, todoTarget) {
  var l = sanitizeLabel(label)
  if (kind === "breakEnd") {
    return {
      headline: "Break over",
      body: "Ready for the next focus session?" + (l ? "\nNext: " + l : ""),
      exec: ["omarchy-shell", TARGET, "open"]
    }
  }
  return {
    headline: "Pomodoro complete",
    body: (kind === "longBreak" ? "Long break — you earned it." : "Work session done. Take a short break.") + (l ? "\n" + l : ""),
    exec: isNumericId(taskId) ? ["omarchy-shell", String(todoTarget), "openTask", String(taskId)] : null
  }
}

// One argv element per value; the headline is a constant and the label rides
// on the body's second line, so no element is ever a bare flag (PLAN §7.7).
function notifyArgv(omarchyPath, glyph, copy) {
  var argv = [(omarchyPath || DEFAULT_OMARCHY_PATH) + "/bin/omarchy-notification-send", "-g", glyph, "-u", "normal", copy.headline, copy.body]
  if (copy.exec) argv = argv.concat(["--exec"]).concat(copy.exec)
  return argv
}

function pushNotify(state, effects, cfg, kind) {
  var copy = notifyCopy(kind, state.taskLabel, state.taskId, cfg.todoTarget)
  var glyph = kind === "breakEnd" ? GLYPH_WORK : GLYPH_BREAK
  effects.push({ type: "notify", kind: kind, argv: notifyArgv(cfg.omarchyPath, glyph, copy) })
  if (cfg.sound) effects.push({ type: "sound", file: kind === "breakEnd" ? SOUND_BREAK_END : SOUND_WORK_END })
}

// ---------------------------------------------------------- recording

function taskArgs(action) {
  if (isNumericId(action.taskId)) return [String(action.taskId)]
  return ["--label=" + (action.label || UNLINKED_LABEL)]
}

// `/usr/bin/env` in front: Quickshell 0.3.1 never emits `exited` for a
// binary it cannot start, while env exits 127 for one, which classifies as
// `todocli not found` without any shell (PLAN §6.4, §7.6).
function recordArgv(cliPath, action) {
  var argv = ["/usr/bin/env", cliPath || DEFAULTS.cliPath, "--source", "omarchy", "--json", "pomodoro"]
  if (action.verb === "start") {
    argv = argv.concat(["start"]).concat(taskArgs(action)).concat(["--planned", String(action.planned)])
    if (action.startedAt !== null && action.startedAt !== undefined) argv = argv.concat(["--started-at", String(Math.floor(action.startedAt / 1000))])
    return argv.concat(["--interrupt"])
  }
  if (action.verb === "retarget") {
    argv = argv.concat(["retarget", String(action.sessionUid)]).concat(taskArgs(action)).concat(["--focus-seconds", String(roundSeconds(action.focusSeconds))])
    if (action.planned !== null && action.planned !== undefined) argv = argv.concat(["--planned", String(action.planned)])
    return argv
  }
  return argv.concat([action.verb, String(action.sessionUid), "--focus-seconds", String(roundSeconds(action.focusSeconds))])
}

function classifyExit(exitCode, exitStatus) {
  if (Number(exitStatus) !== 0) return ERR_FAILED
  if (exitCode === 0) return null
  if (exitCode === 127) return ERR_MISSING
  if (exitCode === 75) return ERR_BUSY
  return ERR_FAILED
}

function parseSession(stdout) {
  var obj
  try { obj = JSON.parse(String(stdout || "").trim()) } catch (e) { return null }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null
  if (typeof obj.uid !== "string" || obj.uid === "") return null
  return obj
}

// Queue a record action; `backend = none` records nothing (AC-6.14).
function enqueue(state, effects, cfg, action) {
  if (cfg.backend !== "cli") return
  action.id = state.nextRecordId
  state.nextRecordId += 1
  state.queue = state.queue.concat([action])
  pump(state, effects)
}

function dropClose(state, reason) {
  state.lastRecordError = reason || state.lastRecordError || ERR_FAILED
}

// One process at a time: the next action leaves the queue only after the
// previous reply was applied, so a close created while its start was still
// in flight takes the uid that start returned.
function pump(state, effects) {
  while (state.inflight === null && state.queue.length > 0) {
    var action = state.queue[0]
    state.queue = state.queue.slice(1)
    if (CLOSE_VERBS[action.verb] && action.sessionUid === null) {
      if (state.failedStart !== null) {
        var retry = state.failedStart
        state.failedStart = null
        state.queue = [action].concat(state.queue)
        action = { id: action.id, verb: "start", taskId: retry.taskId, label: retry.label, planned: retry.planned, interrupt: true, startedAt: retry.startedAt, openedAt: retry.openedAt, retry: true }
        action.id = state.nextRecordId
        state.nextRecordId += 1
      } else if (state.sessionUid !== null) {
        action.sessionUid = state.sessionUid
        state.sessionUid = null
      } else {
        dropClose(state, null)
        continue
      }
    }
    action.type = "record"
    state.inflight = action
    effects.push(action)
  }
}

function recordResult(state, effects, event, now) {
  var action = state.inflight
  if (action === null || action.id !== event.id) return
  state.inflight = null
  var reason = classifyExit(event.exitCode, event.exitStatus)
  var session = reason === null && (action.verb === "start" || action.verb === "retarget") ? parseSession(event.stdout) : null
  if (reason === null && (action.verb === "start" || action.verb === "retarget") && session === null) reason = ERR_FAILED
  if (action.verb === "start") {
    if (reason === null) {
      state.sessionUid = session.uid
    } else {
      state.lastRecordError = reason
      if (!action.retry) state.failedStart = { taskId: action.taskId, label: action.label, planned: action.planned, startedAt: action.openedAt, openedAt: action.openedAt }
    }
  } else if (action.verb === "retarget") {
    if (reason === null) {
      state.sessionUid = session.uid
      state.lastRecordError = null
    } else {
      state.sessionUid = action.sessionUid
      state.lastRecordError = reason
    }
  } else if (action.verb === "interrupt") {
    if (reason === null) state.lastRecordError = null
    else state.lastRecordError = reason
  } else if (reason === null) {
    state.lastRecordError = null
  } else if (action.resend) {
    dropClose(state, reason)
  } else {
    state.pendingClose = { verb: action.verb, sessionUid: action.sessionUid, focusSeconds: roundSeconds(action.focusSeconds) }
    state.lastRecordError = reason
  }
  pump(state, effects)
  writeState(state, effects, now)
}

// A close of the current session; the uid is filled in when known.
function enqueueClose(state, effects, cfg, verb, extra) {
  if (!state.recorded) return
  var action = { verb: verb, sessionUid: state.sessionUid, focusSeconds: roundSeconds(state.focusSeconds) }
  if (extra) for (var k in extra) action[k] = extra[k]
  state.sessionUid = null
  enqueue(state, effects, cfg, action)
}

// The work phase begins running: re-send a pending close once, then open the
// session with `--interrupt` (PLAN §7.3; UX 6.2).
function openSession(state, effects, cfg, now) {
  state.recorded = true
  state.failedStart = null
  if (state.pendingClose !== null) {
    var pc = state.pendingClose
    state.pendingClose = null
    if (pc.sessionUid) enqueue(state, effects, cfg, { verb: pc.verb, sessionUid: pc.sessionUid, focusSeconds: pc.focusSeconds, resend: true })
    else dropClose(state, null)
  }
  enqueue(state, effects, cfg, { verb: "start", taskId: state.taskId, label: state.taskLabel, planned: phaseSeconds("work", cfg), interrupt: true, startedAt: null, openedAt: now })
}

// ------------------------------------------------------ transitions

function startPhase(state, cfg, now, phase, run) {
  state.phase = phase
  state.remaining = phaseSeconds(phase, cfg)
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

function resume(state, effects, cfg, now) {
  state.running = true
  state.endsAt = now + state.remaining * 1000
  state.lastTickAt = now
  state.restored = false
  if (state.phase === "work" && !state.recorded) openSession(state, effects, cfg, now)
}

function pause(state, now) {
  if (state.running && state.phase === "work" && state.lastTickAt !== null) {
    state.focusSeconds += Math.min(2, Math.max(0, (now - state.lastTickAt) / 1000))
  }
  state.remaining = remainingAt(state, now)
  state.running = false
  state.endsAt = null
  state.lastTickAt = now
}

function beginWork(state, effects, cfg, now) {
  startPhase(state, cfg, now, "work", true)
  openSession(state, effects, cfg, now)
}

// The timer keeps its remaining time; the record splits (UX 6.2). A detach
// (`x`) retargets to an unlinked `Pomodoro` session and clears the label.
function retarget(state, effects, cfg, now, taskId, label, detach) {
  if (state.phase === "work" && state.recorded) {
    var extra = detach
      ? { taskId: "", label: UNLINKED_LABEL, planned: null }
      : { taskId: taskId, label: label, planned: remainingAt(state, now) }
    enqueueClose(state, effects, cfg, "retarget", extra)
    state.focusSeconds = 0
    state.lastTickAt = now
  }
  attach(state, taskId, label)
}

function completePhase(state, effects, cfg, now) {
  state.running = false
  if (state.phase === "work") {
    state.completed += 1
    var long = cfg.pomodorosPerCycle > 0 && state.completed % cfg.pomodorosPerCycle === 0
    enqueueClose(state, effects, cfg, "done")
    startPhase(state, cfg, now, long ? "longBreak" : "shortBreak", true)
    pushNotify(state, effects, cfg, long ? "longBreak" : "workEnd")
  } else {
    if (state.phase === "longBreak") state.completed = 0
    startPhase(state, cfg, now, "work", false)
    pushNotify(state, effects, cfg, "breakEnd")
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
    state.remaining = Math.max(0, Math.ceil((state.endsAt - state.lastTickAt) / 1000))
    state.running = false
    state.endsAt = null
    state.lastTickAt = now
    writeState(state, effects, now)
    return
  }
  if (state.phase === "work") state.focusSeconds += Math.min(2, Math.max(0, gap / 1000))
  state.remaining = remainingAt(state, now)
  state.lastTickAt = now
  if (state.remaining <= 0) {
    completePhase(state, effects, cfg, now)
    writeState(state, effects, now)
    return
  }
  if (state.lastWriteAt === null || now - state.lastWriteAt >= CHECKPOINT_MS) writeState(state, effects, now)
}

// --------------------------------------------------------- state file

function parseStateFile(text) {
  var obj
  try { obj = JSON.parse(String(text || "")) } catch (e) { return null }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null
  if (Number(obj.version) !== STATE_VERSION) return null
  var phase = String(obj.phase)
  if (phase !== "work" && phase !== "shortBreak" && phase !== "longBreak") phase = "idle"
  var pc = null
  if (obj.pendingClose && typeof obj.pendingClose === "object") {
    var verb = String(obj.pendingClose.verb)
    if (verb === "done" || verb === "cancel") {
      var uid = obj.pendingClose.sessionUid === undefined || obj.pendingClose.sessionUid === null ? "" : String(obj.pendingClose.sessionUid).trim()
      pc = { verb: verb, sessionUid: uid === "" ? null : uid, focusSeconds: roundSeconds(obj.pendingClose.focusSeconds) }
    }
  }
  var sessionUid = typeof obj.sessionUid === "string" ? obj.sessionUid.trim() : ""
  return {
    version: STATE_VERSION,
    phase: phase,
    running: obj.running === true,
    endsAt: typeof obj.endsAt === "number" && isFinite(obj.endsAt) ? obj.endsAt : null,
    remaining: Math.max(0, Math.floor(Number(obj.remaining) || 0)),
    completed: Math.max(0, Math.floor(Number(obj.completed) || 0)),
    taskId: sanitizeTaskId(obj.taskId),
    taskLabel: sanitizeLabel(obj.taskLabel),
    sessionUid: sessionUid === "" ? null : sessionUid,
    focusSeconds: roundSeconds(obj.focusSeconds),
    pendingClose: pc,
    updatedAt: typeof obj.updatedAt === "number" || typeof obj.updatedAt === "string" ? Number(obj.updatedAt) : null
  }
}

// Restore on service start (PLAN A22, UX 6.5): a recent phase comes back
// paused; an old one with a session is closed as interrupted; else idle.
function serviceStart(state, effects, cfg, now, saved) {
  var s = saved && typeof saved === "object" && Number(saved.version) === STATE_VERSION ? parseStateFile(JSON.stringify(saved)) : null
  if (s === null) {
    writeState(state, effects, now)
    return
  }
  state.completed = s.completed
  state.pendingClose = s.pendingClose
  var age = s.updatedAt === null ? NaN : now - s.updatedAt
  if (s.phase !== "idle" && age >= 0 && age <= s.remaining * 1000 + RESTORE_GRACE_MS) {
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
  } else if (s.phase !== "idle" && s.sessionUid !== null) {
    enqueue(state, effects, cfg, { verb: "interrupt", sessionUid: s.sessionUid, focusSeconds: s.focusSeconds })
  }
  writeState(state, effects, now)
}

// -------------------------------------------------------------- reduce

function reduce(prev, event, now, cfg) {
  var state = clone(prev)
  var effects = []
  var reply = ""
  var type = event && event.type
  if (type === "tick") {
    tick(state, effects, cfg, now)
  } else if (type === "startFor") {
    reply = startFor(state, effects, cfg, now, event.taskId, event.label)
  } else if (type === "toggle") {
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
    writeState(state, effects, now)
  } else if (type === "pause" || type === "resume") {
    if (state.phase === "idle") {
      reply = "idle"
    } else if (state.running) {
      if (type === "pause") { pause(state, now); reply = "paused" } else reply = "resumed"
      writeState(state, effects, now)
    } else {
      resume(state, effects, cfg, now)
      reply = "resumed"
      writeState(state, effects, now)
    }
  } else if (type === "skip") {
    reply = "ok"
    if (state.phase === "work") {
      pause(state, now)
      enqueueClose(state, effects, cfg, "cancel")
      startPhase(state, cfg, now, "shortBreak", true)
      writeState(state, effects, now)
    } else if (isBreak(state.phase)) {
      startPhase(state, cfg, now, "work", false)
      writeState(state, effects, now)
    }
  } else if (type === "reset") {
    reply = "ok"
    if (state.phase !== "idle") {
      pause(state, now)
      state.remaining = phaseSeconds(state.phase, cfg)
      writeState(state, effects, now)
    }
  } else if (type === "detach") {
    if (state.phase === "idle") {
      reply = "idle"
    } else {
      reply = "detached"
      if (state.running) { state.focusSeconds += Math.min(2, Math.max(0, (now - state.lastTickAt) / 1000)); state.lastTickAt = now }
      retarget(state, effects, cfg, now, "", "", true)
      writeState(state, effects, now)
    }
  } else if (type === "serviceStart") {
    serviceStart(state, effects, cfg, now, event.saved)
  } else if (type === "recordResult") {
    recordResult(state, effects, event, now)
  }
  return { state: state, effects: effects, reply: reply }
}

// UX 6.2: the result word per timer state.
function startFor(state, effects, cfg, now, rawTaskId, rawLabel) {
  var taskId = sanitizeTaskId(rawTaskId)
  var label = sanitizeLabel(rawLabel)
  if (label === "") return "empty"
  var reply
  if (state.phase === "idle" || isBreak(state.phase)) {
    attach(state, taskId, label)
    beginWork(state, effects, cfg, now)
    reply = "started"
  } else if (state.running) {
    if (sameTask(state, taskId, label)) return "already running"
    state.focusSeconds += Math.min(2, Math.max(0, (now - state.lastTickAt) / 1000))
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
  writeState(state, effects, now)
  return reply
}

// ---------------------------------------------------------------- views

function statusJson(state, cfg, now) {
  return JSON.stringify({
    version: 1,
    backend: cfg.backend,
    cliPath: cfg.cliPath,
    phase: state.phase,
    running: state.running,
    remaining: now === undefined ? state.remaining : remainingAt(state, now),
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
  var first = phaseLabel(state.phase) + " — " + (state.running ? formatTime(state.remaining) : "paused")
  if (state.taskLabel === "") return first
  return first + "\n" + (isBreak(state.phase) ? "Next: " : "") + tooltipText(state.taskLabel)
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

// Everything the pill and the popup bind to, derived once per state change.
function view(state, cfg) {
  var hasSession = state.phase !== "idle"
  var secs = phaseSeconds(state.phase, cfg)
  var progress = secs > 0 ? Math.max(0, Math.min(1, 1 - state.remaining / secs)) : 0
  return {
    phase: state.phase,
    running: state.running,
    isBreak: isBreak(state.phase),
    hasSession: hasSession,
    playing: state.running && hasSession,
    phaseGlyph: isBreak(state.phase) ? GLYPH_BREAK : GLYPH_WORK,
    phaseLabel: phaseLabel(state.phase),
    phaseSeconds: secs,
    progress: progress,
    displaySeconds: hasSession ? state.remaining : secs,
    timeText: formatTime(hasSession ? state.remaining : secs),
    remainingText: formatTime(state.remaining),
    tooltip: tooltip(state),
    hint: hint(state),
    attached: state.taskLabel !== "",
    taskId: state.taskId,
    taskLabel: state.taskLabel,
    completed: state.completed,
    perCycle: cfg.pomodorosPerCycle,
    lastRecordError: state.lastRecordError,
    recordCaption: recordCaption(state.lastRecordError),
    restored: state.restored,
    restoredCaption: restoredCaption(state.restored),
    sessionUid: state.sessionUid
  }
}

// UX 5.1: horizontal = upstream's Style.space(56) × barSize with glyph and
// time; vertical = barSize × iconSlot, glyph only, time in the tooltip.
function pillLayout(vertical, m) {
  if (vertical) return { width: m.barSize, height: m.iconSlot, showTime: false }
  return { width: m.pillWidth, height: m.barSize, showTime: true }
}
