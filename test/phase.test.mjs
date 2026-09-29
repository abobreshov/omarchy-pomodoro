// Phase.js on its own: settings coercion (PLAN §7.2, A21), the widget entry
// out of the injected bar config, the label and task-id sanitisers (§7.4),
// the time format and the phase and deadline arithmetic.
import { test } from "node:test"
import assert from "node:assert/strict"
import { loadQmlJs } from "./qml-js-loader.mjs"

const P = loadQmlJs(new URL("../Phase.js", import.meta.url).pathname)

test("settings: A21 coercion of every key", () => {
  const d = P.settings({})
  assert.deepEqual(d, { workMinutes: 25, shortBreakMinutes: 5, longBreakMinutes: 15, pomodorosPerCycle: 4, sound: true, breakColor: "#a6e3a1", backend: "none", cliPath: "todocli", todoTarget: "abobreshov.todo" })
  assert.deepEqual(d, P.DEFAULTS)
  const s = P.settings({ workMinutes: "50", shortBreakMinutes: "abc", longBreakMinutes: -3, pomodorosPerCycle: "0", sound: "false", breakColor: "", backend: "cli", cliPath: "", todoTarget: "x.todo" })
  assert.equal(s.workMinutes, 50)
  assert.equal(s.shortBreakMinutes, 5)
  assert.equal(s.longBreakMinutes, 1)
  assert.equal(s.pomodorosPerCycle, 4)
  assert.equal(s.sound, false)
  assert.equal(s.breakColor, "#a6e3a1")
  assert.equal(s.backend, "cli")
  assert.equal(s.cliPath, "todocli")
  assert.equal(s.todoTarget, "x.todo")
  assert.equal(P.settings({ sound: false }).sound, false)
  assert.equal(P.settings({ sound: "true" }).sound, true)
  assert.equal(P.settings({ backend: "standalone" }).backend, "none")
  assert.equal(P.settings({ cliPath: "/opt/todocli", breakColor: "#fff" }).cliPath, "/opt/todocli")
  assert.equal(P.settings({ breakColor: "#fff" }).breakColor, "#fff")
  assert.equal(P.settings(null).workMinutes, 25)
})

test("widgetSettings: the widget's entry (minus id) from the injected bar config", () => {
  const cfg = { layout: { left: ["omarchy.menu"], center: [{ id: "omarchy.clock", format: "x" }], right: [{ id: "agx.screen-time" }, { id: "abobreshov.pomodoro", backend: "cli", workMinutes: "50" }] } }
  assert.equal(P.TARGET, "abobreshov.pomodoro")
  assert.deepEqual(P.widgetSettings(cfg, P.TARGET), { backend: "cli", workMinutes: "50" })
  assert.deepEqual(P.widgetSettings({ layout: { right: ["abobreshov.pomodoro"] } }, P.TARGET), {})
  assert.equal(P.widgetSettings(cfg, "abobreshov.todo"), null)
  assert.equal(P.widgetSettings(null, P.TARGET), null)
  assert.equal(P.widgetSettings({}, P.TARGET), null)
  assert.equal(P.widgetSettings({ layout: "x" }, P.TARGET), null)
  assert.equal(P.widgetSettings({ layout: { right: "nope", left: [null, 5, { name: "x" }] } }, P.TARGET), null)
  assert.equal(P.settings(P.widgetSettings(cfg, P.TARGET)).workMinutes, 50)
  assert.equal(P.settings(P.widgetSettings(cfg, P.TARGET)).backend, "cli")
  assert.equal(P.settings(P.widgetSettings(cfg, "other")).workMinutes, 25)
})

test("sanitizeLabel: controls to space, trim, 120 cap; sanitizeTaskId", () => {
  assert.equal(P.sanitizeLabel("  a\tb\nc\x00d\x7fe\x85f  "), "a b c d e f")
  assert.equal(P.sanitizeLabel("x".repeat(200)).length, 120)
  assert.equal(P.sanitizeLabel(null), "")
  assert.equal(P.sanitizeLabel(undefined), "")
  assert.equal(P.sanitizeTaskId(" 12\n"), "12")
  assert.equal(P.sanitizeTaskId(null), "")
  assert.equal(P.sanitizeTaskId("a".repeat(100)).length, 64)
  assert.equal(P.isNumericId("12"), true)
  assert.equal(P.isNumericId("#12"), false)
  assert.equal(P.isNumericId(""), false)
})

test("formatTime: upstream m:ss and h:mm:ss", () => {
  assert.equal(P.formatTime(0), "0:00")
  assert.equal(P.formatTime(65), "1:05")
  assert.equal(P.formatTime(1500), "25:00")
  assert.equal(P.formatTime(3661), "1:01:01")
  assert.equal(P.formatTime(-5), "0:00")
  assert.equal(P.formatTime(3600 + 5 * 60), "1:05:00")
})

test("phaseSeconds, isBreak and roundSeconds follow the settings and upstream's phases", () => {
  const cfg = P.settings({ workMinutes: 1, shortBreakMinutes: 2, longBreakMinutes: 3 })
  assert.equal(P.phaseSeconds("work", cfg), 60)
  assert.equal(P.phaseSeconds("shortBreak", cfg), 120)
  assert.equal(P.phaseSeconds("longBreak", cfg), 180)
  assert.equal(P.phaseSeconds("idle", cfg), 60, "idle shows the work length")
  assert.deepEqual(["idle", "work", "shortBreak", "longBreak"].map(P.isBreak), [false, false, true, true])
  assert.equal(P.roundSeconds(12.6), 13)
  assert.equal(P.roundSeconds(-1), 0)
  assert.equal(P.roundSeconds("3"), 3)
  assert.equal(P.roundSeconds(undefined), 0)
  assert.equal(P.roundSeconds(NaN), 0)
})

test("remainingAt: live from the deadline while running, the frozen value while paused", () => {
  assert.equal(P.remainingAt({ running: true, endsAt: 10000, remaining: 99 }, 7500), 3, "ceil of 2.5 s")
  assert.equal(P.remainingAt({ running: true, endsAt: 10000, remaining: 99 }, 10000), 0)
  assert.equal(P.remainingAt({ running: true, endsAt: 10000, remaining: 99 }, 12000), 0, "never negative")
  assert.equal(P.remainingAt({ running: false, endsAt: null, remaining: 99 }, 7500), 99)
  assert.equal(P.remainingAt({ running: true, endsAt: null, remaining: 42 }, 7500), 42, "no deadline yet")
})
