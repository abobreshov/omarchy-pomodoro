.pragma library

// abobreshov.pomodoro — the timer's vocabulary (PLAN §7.2, A21): the phases
// and their lengths, the wall-clock deadline arithmetic, the settings with
// their coercion and the sanitisers every input passes through. Pure
// functions over plain values; the only state fields read here are the
// three `remainingAt` needs (`running`, `endsAt`, `remaining`).
//
// The phases and their default lengths are upstream's
// (markbus-ai/omarchy-pomodoro): idle → work → short or long break → work.

var TARGET = "abobreshov.pomodoro"
var LABEL_MAX = 120
var TASK_ID_MAX = 64
var UNLINKED_LABEL = "Pomodoro"
var GLYPH_WORK = ""   // fa-stopwatch (upstream's escape)
var GLYPH_BREAK = "󰅶"        // md-coffee (upstream writes it raw: outside the BMP)

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

// The widget's shell.json entry, minus `id`, out of the bar config the shell
// injects into the service (`shell.barConfig`; refreshed on every shell.json
// change): the same object the bar hands its widgets as `settings`, available
// before any widget exists. `null` when the widget is not in the layout.
function widgetSettings(barConfig, id) {
  var layout = barConfig && typeof barConfig === "object" ? barConfig.layout : null
  if (!layout || typeof layout !== "object") return null
  var sections = ["left", "center", "right"]
  for (var i = 0; i < sections.length; i++) {
    var entries = layout[sections[i]]
    if (!Array.isArray(entries)) continue
    for (var j = 0; j < entries.length; j++) {
      var e = entries[j]
      if (e === id) return {}
      if (!e || typeof e !== "object" || e.id !== id) continue
      var out = {}
      for (var k in e) if (k !== "id") out[k] = e[k]
      return out
    }
  }
  return null
}

// ----------------------------------------------------------- sanitisers

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

// ------------------------------------------------------ phases and time

function formatTime(secs) {
  var total = Math.max(0, Math.floor(secs))
  var h = Math.floor(total / 3600)
  var m = Math.floor((total % 3600) / 60)
  var s = total % 60
  var ss = (s < 10 ? "0" : "") + s
  if (h > 0) return h + ":" + ((m < 10 ? "0" : "") + m) + ":" + ss
  return m + ":" + ss
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

// The seconds left at `now`: live from the deadline while running, the
// frozen value while paused.
function remainingAt(state, now) {
  if (!state.running || state.endsAt === null) return state.remaining
  return Math.max(0, Math.ceil((state.endsAt - now) / 1000))
}
