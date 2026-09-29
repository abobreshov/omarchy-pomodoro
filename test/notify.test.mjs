// Notify.js on its own: the UX 5.3 copy table, the argv for
// `Quickshell.execDetached` with one element per value (PLAN §7.7, A23) and
// the effects `pushNotify` queues.
import { test } from "node:test"
import assert from "node:assert/strict"
import { loadQmlJs } from "./qml-js-loader.mjs"

const N = loadQmlJs(new URL("../Notify.js", import.meta.url).pathname)

test("notifyCopy: table 5.3 and a hostile label stay one element (A23)", () => {
  const hostile = "-u critical; rm -rf ~"
  const c = N.notifyCopy("workEnd", hostile, "12", "abobreshov.todo")
  assert.equal(c.headline, "Pomodoro complete")
  assert.equal(c.body, "Work session done. Take a short break.\n" + hostile)
  assert.deepEqual(c.exec, ["omarchy-shell", "abobreshov.todo", "openTask", "12"])
  const argv = N.notifyArgv("/usr/share/omarchy", "󰅶", c)
  assert.deepEqual(argv, ["/usr/share/omarchy/bin/omarchy-notification-send", "-g", "󰅶", "-u", "normal", "Pomodoro complete", "Work session done. Take a short break.\n" + hostile, "--exec", "omarchy-shell", "abobreshov.todo", "openTask", "12"])
  assert.equal(argv.indexOf(hostile) >= 0, false)
  assert.equal(argv.filter((a) => a.indexOf(hostile) >= 0).length, 1)
  assert.deepEqual(N.notifyCopy("longBreak", "", "", "abobreshov.todo"), { headline: "Pomodoro complete", body: "Long break — you earned it.", exec: null })
  assert.deepEqual(N.notifyCopy("workEnd", "Task", "t1x", "abobreshov.todo").exec, null)
  assert.deepEqual(N.notifyCopy("workEnd", "Task", "", "abobreshov.todo").exec, null)
  assert.deepEqual(N.notifyCopy("breakEnd", "Task", "3", "abobreshov.todo"), { headline: "Break over", body: "Ready for the next focus session?\nNext: Task", exec: ["omarchy-shell", "abobreshov.pomodoro", "open"] })
  assert.deepEqual(N.notifyCopy("breakEnd", "", "", "abobreshov.todo"), { headline: "Break over", body: "Ready for the next focus session?", exec: ["omarchy-shell", "abobreshov.pomodoro", "open"] })
  assert.equal(N.notifyArgv("", "x", N.notifyCopy("breakEnd", "", "", ""))[0], "/usr/share/omarchy/bin/omarchy-notification-send")
})

test("notifyCopy sanitises the label like every other input", () => {
  assert.equal(N.notifyCopy("workEnd", "  a\tb\x00c  ", "", "t").body, "Work session done. Take a short break.\na b c")
  assert.equal(N.notifyCopy("breakEnd", "x".repeat(200), "", "t").body.length, "Ready for the next focus session?\nNext: ".length + 120)
})

test("pushNotify queues the notify argv with the phase glyph and, with sound on, the upstream sound file", () => {
  const state = { taskLabel: "Wire", taskId: "3" }
  const cfg = { sound: true, todoTarget: "abobreshov.todo", omarchyPath: "/opt/omarchy" }
  let effects = []
  N.pushNotify(state, effects, cfg, "workEnd")
  assert.deepEqual(effects.map((e) => e.type), ["notify", "sound"])
  assert.equal(effects[0].kind, "workEnd")
  assert.deepEqual(effects[0].argv, ["/opt/omarchy/bin/omarchy-notification-send", "-g", "󰅶", "-u", "normal", "Pomodoro complete", "Work session done. Take a short break.\nWire", "--exec", "omarchy-shell", "abobreshov.todo", "openTask", "3"])
  assert.equal(effects[1].file, "/usr/share/sounds/freedesktop/stereo/alarm-clock-elapsed.oga")
  effects = []
  N.pushNotify(state, effects, cfg, "breakEnd")
  assert.equal(effects[0].argv[2], "\uf2f2", "the work glyph announces the next work phase")
  assert.equal(effects[1].file, "/usr/share/sounds/freedesktop/stereo/complete.oga")
  effects = []
  N.pushNotify(state, effects, Object.assign({}, cfg, { sound: false, omarchyPath: undefined }), "longBreak")
  assert.deepEqual(effects.map((e) => e.type), ["notify"])
  assert.equal(effects[0].argv[0], "/usr/share/omarchy/bin/omarchy-notification-send")
  assert.equal(effects[0].argv[6], "Long break — you earned it.\nWire")
})
