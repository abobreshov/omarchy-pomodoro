// Timer.js is the facade the QML files import (PLAN §7.1): every `TimerLib.*`
// name Service.qml, BarWidget.qml and Panel.qml reference exists on it, the
// surface is exactly the public one, and each function is a pass-through to
// its module — the same answer as the module for the same arguments, the two
// constants the modules' own values. The behaviour itself is tested per
// module (phase, notify, machine, queue, restore, view, record).
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { loadQmlJs } from "./qml-js-loader.mjs"
import { SESSION } from "./harness.mjs"

const here = (f) => new URL("../" + f, import.meta.url).pathname
const T = loadQmlJs(here("Timer.js"))
const Phase = loadQmlJs(here("Phase.js"))
const StateFile = loadQmlJs(here("StateFile.js"))
const Notify = loadQmlJs(here("Notify.js"))
const Record = loadQmlJs(here("Record.js"))
const Machine = loadQmlJs(here("Machine.js"))
const View = loadQmlJs(here("View.js"))

const SURFACE = {
  TARGET: Phase, DEFAULTS: Phase,
  settings: Phase, widgetSettings: Phase, sanitizeLabel: Phase, sanitizeTaskId: Phase, isNumericId: Phase, formatTime: Phase,
  initialState: Machine, reduce: Machine,
  recordArgv: Record, classifyExit: Record, parseSession: Record,
  stateFileDoc: StateFile, parseStateFile: StateFile,
  notifyCopy: Notify, notifyArgv: Notify,
  statusJson: View, view: View, idleView: View, pillLayout: View, tooltipText: View, recordCaption: View, restoredCaption: View
}

test("every TimerLib member the QML files reference exists on the facade", () => {
  const used = new Set()
  for (const f of ["Service.qml", "BarWidget.qml", "Panel.qml"]) {
    const src = fs.readFileSync(here(f), "utf8")
    assert.match(src, /^import "Timer\.js" as TimerLib$/m, f + " imports the facade")
    assert.doesNotMatch(src, /import "(Phase|StateFile|Notify|Record|Machine|View)\.js"/, f + " imports no module directly")
    for (const m of src.matchAll(/TimerLib\.([A-Za-z_]\w*)/g)) used.add(m[1])
  }
  assert.deepEqual([...used].sort(), ["TARGET", "idleView", "initialState", "pillLayout", "recordArgv", "reduce", "settings", "statusJson", "view", "widgetSettings"])
  for (const name of used) assert.equal(name in SURFACE, true, name + " is on the facade")
})

test("the facade exports exactly the public surface", () => {
  assert.deepEqual(Object.keys(T).sort(), Object.keys(SURFACE).sort())
  for (const [name, mod] of Object.entries(SURFACE)) {
    assert.equal(typeof T[name], typeof mod[name], name)
    assert.equal(typeof T[name], name === "TARGET" ? "string" : name === "DEFAULTS" ? "object" : "function", name)
  }
})

test("constants are the modules' own values", () => {
  assert.equal(T.TARGET, "abobreshov.pomodoro")
  assert.equal(T.TARGET, Phase.TARGET)
  assert.deepEqual(T.DEFAULTS, Phase.DEFAULTS)
})

test("each facade function answers exactly as its module for the same arguments", () => {
  const cfg = Phase.settings({ backend: "cli", workMinutes: "3" })
  const state = Object.assign(Machine.initialState(), { phase: "work", running: true, endsAt: 190000, remaining: 180, taskId: "3", taskLabel: "Wire <it>", lastRecordError: "database busy", restored: true })
  const start = { verb: "start", taskId: "3", label: "Wire", planned: 180, interrupt: true, startedAt: 7000 }
  const cases = [
    ["settings", [{ workMinutes: "50", backend: "cli" }]],
    ["widgetSettings", [{ layout: { right: [{ id: "abobreshov.pomodoro", backend: "cli" }] } }, "abobreshov.pomodoro"]],
    ["sanitizeLabel", ["  a\tb  "]],
    ["sanitizeTaskId", [" 12\n"]],
    ["isNumericId", ["12"]],
    ["formatTime", [3661]],
    ["initialState", []],
    ["reduce", [state, { type: "tick" }, 10000, cfg]],
    ["recordArgv", ["/opt/todocli", start]],
    ["classifyExit", [75, 0]],
    ["parseSession", [SESSION("U1")]],
    ["stateFileDoc", [state, 10000]],
    ["parseStateFile", [JSON.stringify(StateFile.stateFileDoc(state, 10000))]],
    ["notifyCopy", ["workEnd", "-u critical; rm -rf ~", "3", "abobreshov.todo"]],
    ["notifyArgv", ["/usr/share/omarchy", "x", Notify.notifyCopy("breakEnd", "L", "", "t")]],
    ["statusJson", [state, cfg, 10000]],
    ["statusJson", [state, cfg]],
    ["view", [state, cfg]],
    ["idleView", []],
    ["pillLayout", [true, { barSize: 28, iconSlot: 27, pillWidth: 56 }, { hasSession: true, playing: false }]],
    ["tooltipText", ["a<b>c"]],
    ["recordCaption", ["database busy"]],
    ["restoredCaption", [true]]
  ]
  for (const [name, args] of cases) assert.deepEqual(T[name](...args), SURFACE[name][name](...args), name)
})

test("reduce through the facade keeps its purity guarantee", () => {
  const cfg = T.settings({ backend: "cli" })
  const prev = T.initialState()
  const before = JSON.stringify(prev)
  const out = T.reduce(prev, { type: "startFor", taskId: "3", label: "Wire" }, 0, cfg)
  assert.equal(JSON.stringify(prev), before)
  assert.equal(out.reply, "started")
  assert.equal(out.state.phase, "work")
  assert.deepEqual(out.effects.map((e) => e.type), ["record", "writeState"])
})
