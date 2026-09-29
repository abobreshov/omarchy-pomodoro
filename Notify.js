.pragma library
.import "Phase.js" as Phase

// abobreshov.pomodoro — phase-end notifications and sounds (PLAN §7.7, UX
// §5.3). `notifyCopy` is the copy table, `notifyArgv` the argv list for
// `Quickshell.execDetached`: one element per value, a constant headline and
// the label on the body's second line, so a hostile label such as
// `-u critical; rm -rf ~` stays one argument and is never a flag. The
// `--exec` tail that opens the todo panel is added only for a numeric task
// id. `pushNotify` queues the `notify` effect and, with `sound` on, the
// `sound` effect; the copy and the sound files are upstream's.

var SOUND_WORK_END = "/usr/share/sounds/freedesktop/stereo/alarm-clock-elapsed.oga"
var SOUND_BREAK_END = "/usr/share/sounds/freedesktop/stereo/complete.oga"
var DEFAULT_OMARCHY_PATH = "/usr/share/omarchy"

function notifyCopy(kind, label, taskId, todoTarget) {
  var l = Phase.sanitizeLabel(label)
  if (kind === "breakEnd") {
    return {
      headline: "Break over",
      body: "Ready for the next focus session?" + (l ? "\nNext: " + l : ""),
      exec: ["omarchy-shell", Phase.TARGET, "open"]
    }
  }
  return {
    headline: "Pomodoro complete",
    body: (kind === "longBreak" ? "Long break — you earned it." : "Work session done. Take a short break.") + (l ? "\n" + l : ""),
    exec: Phase.isNumericId(taskId) ? ["omarchy-shell", String(todoTarget), "openTask", String(taskId)] : null
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
  var glyph = kind === "breakEnd" ? Phase.GLYPH_WORK : Phase.GLYPH_BREAK
  effects.push({ type: "notify", kind: kind, argv: notifyArgv(cfg.omarchyPath, glyph, copy) })
  if (cfg.sound) effects.push({ type: "sound", file: kind === "breakEnd" ? SOUND_BREAK_END : SOUND_WORK_END })
}
