.pragma library
.import "Phase.js" as Phase

// abobreshov.pomodoro — the state file's document (PLAN §7.5, A22):
// `~/.local/state/abobreshov.pomodoro/state.json` as the service writes it
// (`stateFileDoc`, carried by the `writeState` effect) and as a restore reads
// it back (`parseStateFile`, tolerant of an older or hand-edited file: every
// field is coerced, an unknown phase reads as idle, an unknown pending verb
// is dropped). The restore itself is Machine.serviceStart; this module only
// knows the shape.

var STATE_VERSION = 1

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
    focusSeconds: Phase.roundSeconds(state.focusSeconds),
    pendingClose: state.pendingClose,
    updatedAt: now
  }
}

// Stamps the write on the state (the once-a-minute checkpoint in
// Machine.tick reads `lastWriteAt`) and queues the effect the service runs.
function writeState(state, effects, now) {
  state.lastWriteAt = now
  effects.push({ type: "writeState", doc: stateFileDoc(state, now) })
}

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
      pc = { verb: verb, sessionUid: uid === "" ? null : uid, focusSeconds: Phase.roundSeconds(obj.pendingClose.focusSeconds) }
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
    taskId: Phase.sanitizeTaskId(obj.taskId),
    taskLabel: Phase.sanitizeLabel(obj.taskLabel),
    sessionUid: sessionUid === "" ? null : sessionUid,
    focusSeconds: Phase.roundSeconds(obj.focusSeconds),
    pendingClose: pc,
    updatedAt: typeof obj.updatedAt === "number" || typeof obj.updatedAt === "string" ? Number(obj.updatedAt) : null
  }
}
