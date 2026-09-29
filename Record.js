.pragma library
.import "Phase.js" as Phase
.import "StateFile.js" as StateFile

// abobreshov.pomodoro — recording through todocli (PLAN §7.6, §7.3; UX
// §6.2): the argv per verb, the exit-code classification, the one-at-a-time
// queue (`enqueue`/`pump`) whose next action leaves only after the previous
// reply was applied, and the two recovery rules — a failed `start` is
// retried at phase end with `--started-at` (AC-6.16); a failed close is kept
// as `pendingClose` and re-sent once before the next start, a re-send
// answered exit 1 or a pending close without a uid is dropped into
// `lastRecordError` (AC-6.21, 6.21b, 6.22). Every function works on the
// state copy `reduce` made and copies each record action it fills in, so a
// previous state keeps its queue. `backend = none` records nothing
// (AC-6.14); the timer never waits for a reply (AC-6.8).

var ERR_MISSING = "todocli not found"
var ERR_BUSY = "database busy"
var ERR_FAILED = "todocli error"
var CLOSE_VERBS = { done: true, cancel: true, retarget: true, interrupt: true }
// Every successful close clears the caption; a successful `start` keeps it so
// the caption can still name the lost phase (AC-6.22). UX 5.2 says "after the
// next successful record"; this reads it as the next successful close.
var CLEARS_RECORD_ERROR = CLOSE_VERBS

// ----------------------------------------------------------------- argv

function taskArgs(action) {
  if (Phase.isNumericId(action.taskId)) return [String(action.taskId)]
  return ["--label=" + (action.label || Phase.UNLINKED_LABEL)]
}

// `/usr/bin/env --` in front: Quickshell 0.3.1 never emits `exited` for a
// binary it cannot start, while env exits 127 for one, which classifies as
// `todocli not found` without any shell (PLAN §6.4, §7.6). The `--` keeps a
// cliPath that starts with a dash a program name rather than an env option.
function recordArgv(cliPath, action) {
  var argv = ["/usr/bin/env", "--", cliPath || Phase.DEFAULTS.cliPath, "--source", "omarchy", "--json", "pomodoro"]
  if (action.verb === "start") {
    argv = argv.concat(["start"]).concat(taskArgs(action)).concat(["--planned", String(action.planned)])
    if (action.startedAt !== null && action.startedAt !== undefined) argv = argv.concat(["--started-at", String(Math.floor(action.startedAt / 1000))])
    return argv.concat(["--interrupt"])
  }
  if (action.verb === "retarget") {
    argv = argv.concat(["retarget", String(action.sessionUid)]).concat(taskArgs(action)).concat(["--focus-seconds", String(Phase.roundSeconds(action.focusSeconds))])
    if (action.planned !== null && action.planned !== undefined) argv = argv.concat(["--planned", String(action.planned)])
    return argv
  }
  return argv.concat([action.verb, String(action.sessionUid), "--focus-seconds", String(Phase.roundSeconds(action.focusSeconds))])
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

// ---------------------------------------------------------------- queue

// Queue a record action (copied, with its id); `backend = none` records
// nothing (AC-6.14).
function enqueue(state, effects, cfg, action) {
  if (cfg.backend !== "cli") return
  state.queue = state.queue.concat([Object.assign({ id: state.nextRecordId }, action)])
  state.nextRecordId += 1
  pump(state, effects)
}

function dropClose(state, reason) {
  state.lastRecordError = reason || state.lastRecordError || ERR_FAILED
}

// One process at a time: the next action leaves the queue only after the
// previous reply was applied, so a close created while its start was still
// in flight takes the uid that start returned. The dequeued action is a copy:
// the caller's previous state keeps its queue as it was.
function pump(state, effects) {
  while (state.inflight === null && state.queue.length > 0) {
    var action = Object.assign({}, state.queue[0])
    state.queue = state.queue.slice(1)
    if (CLOSE_VERBS[action.verb] && action.sessionUid === null) {
      if (state.failedStart !== null) {
        var retry = state.failedStart
        state.failedStart = null
        state.queue = [action].concat(state.queue)
        action = { id: state.nextRecordId, verb: "start", taskId: retry.taskId, label: retry.label, planned: retry.planned, interrupt: true, startedAt: retry.startedAt, openedAt: retry.openedAt, retry: true }
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

// The reply to the action in flight (the service's `exited` handler):
// success takes the uid a start or retarget returned; a failure applies the
// recovery rule for its verb, then the next action leaves the queue.
function recordResult(state, effects, cfg, now, event) {
  var action = state.inflight
  if (action === null || action.id !== event.id) return
  state.inflight = null
  var opens = action.verb === "start" || action.verb === "retarget"
  var reason = classifyExit(event.exitCode, event.exitStatus)
  var session = reason === null && opens ? parseSession(event.stdout) : null
  if (reason === null && opens && session === null) reason = ERR_FAILED
  if (reason === null) {
    if (opens) state.sessionUid = session.uid
    if (CLEARS_RECORD_ERROR[action.verb]) state.lastRecordError = null
  } else if (action.verb === "start") {
    state.lastRecordError = reason
    if (!action.retry) state.failedStart = { taskId: action.taskId, label: action.label, planned: action.planned, startedAt: action.openedAt, openedAt: action.openedAt }
  } else if (action.verb === "retarget") {
    state.sessionUid = action.sessionUid
    state.lastRecordError = reason
  } else if (action.resend || action.verb === "interrupt") {
    dropClose(state, reason)
  } else {
    state.pendingClose = { verb: action.verb, sessionUid: action.sessionUid, focusSeconds: Phase.roundSeconds(action.focusSeconds) }
    state.lastRecordError = reason
  }
  pump(state, effects)
  StateFile.writeState(state, effects, now)
}

// --------------------------------------------------- opening and closing

// A close of the current session; the uid is filled in when known.
function enqueueClose(state, effects, cfg, verb, extra) {
  if (!state.recorded) return
  var action = { verb: verb, sessionUid: state.sessionUid, focusSeconds: Phase.roundSeconds(state.focusSeconds) }
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
  enqueue(state, effects, cfg, { verb: "start", taskId: state.taskId, label: state.taskLabel, planned: Phase.phaseSeconds("work", cfg), interrupt: true, startedAt: null, openedAt: now })
}
