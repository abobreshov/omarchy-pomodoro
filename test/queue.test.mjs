// The record queue and its recovery rules (PLAN §7.3, §7.6; UX §6.2;
// AC-6.8, 6.11, 6.14, 6.16, 6.17, 6.21, 6.21b, 6.22): which verbs a phase
// emits and with which seconds, the one-at-a-time FIFO that hands a close the
// uid its start returned, a failed start retried at phase end, a failed close
// kept as `pendingClose` and re-sent once, and what is dropped into
// `lastRecordError`. Driven through Timer.js with the harness answering the
// records; the timer itself never waits for a reply.
import { test } from "node:test"
import assert from "node:assert/strict"
import { loadQmlJs } from "./qml-js-loader.mjs"
import { Sim, SESSION, SAVED, fakeSessions, startFor } from "./harness.mjs"

const T = loadQmlJs(new URL("../Timer.js", import.meta.url).pathname)
const CLI = T.settings({ backend: "cli" })
const NONE = T.settings({})
const fake = fakeSessions()
const newSim = (cfg, now) => new Sim(T, cfg, { now, answer: fake.ok })

// ---------------------------------------------------------- verbs per phase

test("AC-6.11 a work phase emits start then done with the running time", () => {
  const sim = newSim(CLI)
  startFor(sim, "3", "Wire…")
  const uid = sim.state.sessionUid
  sim.tick(1500)
  const r = sim.records()
  assert.deepEqual(r.map((e) => e.verb), ["start", "done"])
  assert.equal(r[0].taskId, "3")
  assert.equal(r[0].planned, 1500)
  assert.equal(r[0].interrupt, true)
  assert.equal(r[1].focusSeconds, 1500)
  assert.equal(r[1].sessionUid, uid)
  assert.equal(sim.state.phase, "shortBreak")
  assert.equal(sim.state.running, true)
  assert.equal(sim.state.remaining, 300)
  assert.equal(sim.state.sessionUid, null)
  const n = sim.notifies()
  assert.equal(n.length, 1)
  assert.equal(n[0].argv[5], "Pomodoro complete")
  assert.equal(n[0].argv[6], "Work session done. Take a short break.\nWire…")
  assert.deepEqual(n[0].argv.slice(7), ["--exec", "omarchy-shell", "abobreshov.todo", "openTask", "3"])
  assert.equal(sim.sounds()[0].file, "/usr/share/sounds/freedesktop/stereo/alarm-clock-elapsed.oga")
})

test("AC-6.14 backend none never records", () => {
  const sim = newSim(NONE)
  startFor(sim, "3", "Wire…")
  sim.tick(1500)
  assert.equal(sim.state.phase, "shortBreak")
  assert.equal(sim.records().length, 0)
  assert.equal(sim.state.sessionUid, null)
  sim.apply({ type: "skip" })
  sim.apply({ type: "toggle" })
  sim.apply({ type: "detach" })
  assert.equal(sim.records().length, 0)
  assert.equal(sim.notifies().length, 1)
})

test("AC-6.17 skip cancels; detach retargets to Pomodoro and keeps running", () => {
  const sim = newSim(CLI)
  startFor(sim, "3", "Wire…")
  sim.tick(600)
  sim.clear()
  sim.apply({ type: "skip" })
  assert.equal(sim.records()[0].verb, "cancel")
  assert.equal(sim.records()[0].focusSeconds, 600)
  assert.equal(sim.state.phase, "shortBreak")
  const sim2 = newSim(CLI)
  startFor(sim2, "3", "Wire…")
  sim2.tick(600)
  sim2.clear()
  assert.equal(sim2.apply({ type: "detach" }), "detached")
  const r = sim2.records()
  assert.equal(r[0].verb, "retarget")
  assert.equal(r[0].label, "Pomodoro")
  assert.equal(r[0].taskId, "")
  assert.equal(r[0].focusSeconds, 600)
  assert.equal(r[0].planned, null)
  assert.equal(sim2.state.running, true)
  assert.equal(sim2.state.taskId, "")
  assert.equal(sim2.state.taskLabel, "")
  assert.equal(sim2.state.remaining, 900)
  sim2.tick(900)
  assert.equal(sim2.records().find((e) => e.verb === "done").focusSeconds, 900)
  assert.equal(sim2.notifies()[0].argv.length, 7)
})

// --------------------------------------------------------- the FIFO itself

test("records are a FIFO: a close waits for the start reply and takes its uid", () => {
  const sim = newSim(CLI)
  const pending = []
  sim.answer = (e) => { pending.push(e); return null }
  startFor(sim, "3", "Wire…")
  sim.tick(60)
  sim.apply({ type: "skip" })
  assert.deepEqual(sim.verbs(), ["start"])
  assert.equal(sim.state.sessionUid, null)
  sim.reply(pending.shift(), fake.ok())
  assert.deepEqual(sim.verbs(), ["start", "cancel"])
  assert.equal(sim.records()[1].sessionUid, fake.last)
  sim.reply(pending.shift(), { exitCode: 0, stdout: "" })
  assert.equal(sim.state.sessionUid, null)
  assert.equal(sim.state.lastRecordError, null)
})

test("reduce is pure: a scripted sequence with queued closes leaves every previous state unchanged", () => {
  let state = T.initialState()
  const step = (event, now) => {
    const before = JSON.stringify(state)
    const out = T.reduce(state, event, now, CLI)
    assert.equal(JSON.stringify(state), before, event.type)
    state = out.state
    return out
  }
  const started = step({ type: "startFor", taskId: "3", label: "Wire" }, 0)
  const start = started.effects.find((e) => e.type === "record")
  assert.equal(start.verb, "start")
  step({ type: "tick" }, 1000)
  step({ type: "skip" }, 2000)
  assert.equal(state.queue.length, 1)
  assert.equal(state.queue[0].sessionUid, null)
  const prevQueue = state.queue
  const answered = step({ type: "recordResult", id: start.id, exitCode: 0, exitStatus: 0, stdout: SESSION("P1"), stderr: "" }, 2500)
  const cancel = answered.effects.find((e) => e.type === "record")
  assert.equal(cancel.verb, "cancel")
  assert.equal(cancel.sessionUid, "P1")
  assert.equal(prevQueue[0].sessionUid, null)
  assert.equal(prevQueue[0].type, undefined)
  step({ type: "recordResult", id: cancel.id, exitCode: 0, exitStatus: 0, stdout: "", stderr: "" }, 3000)
  assert.equal(state.sessionUid, null)
  assert.equal(state.inflight, null)
  step({ type: "skip" }, 4000)
  step({ type: "toggle" }, 5000)
  assert.equal(state.inflight.verb, "start")
})

// -------------------------------------------------- a failed start (6.16)

test("AC-6.16 a failed start is retried at the end of the phase with --started-at", () => {
  const sim = newSim(CLI)
  sim.now = 7000
  sim.answer = () => ({ exitCode: 1, stderr: "boom\n" })
  startFor(sim, "3", "Wire…")
  assert.equal(sim.state.lastRecordError, "todocli error")
  assert.equal(sim.state.sessionUid, null)
  assert.equal(sim.state.running, true)
  sim.answer = fake.ok
  sim.clear()
  sim.tick(1500)
  const r = sim.records()
  assert.deepEqual(r.map((e) => e.verb), ["start", "done"])
  assert.equal(r[0].startedAt, 7000)
  assert.equal(r[0].taskId, "3")
  assert.equal(r[0].retry, true)
  assert.equal(r[1].focusSeconds, 1500)
  assert.equal(T.recordArgv("todocli", r[0]).join(" "), "/usr/bin/env -- todocli --source omarchy --json pomodoro start 3 --planned 1500 --started-at 7 --interrupt")
  assert.equal(sim.state.lastRecordError, null)
})

test("a start answered without a session object counts as a failure and is retried", () => {
  const sim = newSim(CLI)
  sim.answer = (e) => (e.retry ? fake.ok() : { exitCode: 0, stdout: "not json" })
  startFor(sim, "3", "Wire…")
  assert.equal(sim.state.lastRecordError, "todocli error")
  sim.tick(1500)
  assert.deepEqual(sim.verbs(), ["start", "start", "done"])
})

test("AC-6.22 start failing twice: no done is ever sent, the next start runs, the error names the loss", () => {
  const sim = newSim(CLI)
  sim.answer = () => ({ exitCode: 127, stderr: "env: todocli: No such file or directory\n" })
  startFor(sim, "3", "Wire…")
  assert.equal(sim.state.lastRecordError, "todocli not found")
  sim.tick(1500)
  assert.deepEqual(sim.verbs(), ["start", "start"])
  assert.equal(sim.records()[1].retry, true)
  assert.equal(sim.state.pendingClose, null)
  assert.equal(sim.state.lastRecordError, "todocli not found")
  sim.answer = fake.ok
  sim.clear()
  sim.tick(300)
  sim.apply({ type: "toggle" })
  assert.deepEqual(sim.verbs(), ["start"])
  assert.equal(sim.records()[0].retry, undefined)
  assert.equal(sim.state.lastRecordError, "todocli not found")
  sim.tick(1500)
  assert.equal(sim.verbs().at(-1), "done")
  assert.equal(sim.state.lastRecordError, null)
})

test("a work start clears a stale failed-start retry from an unrecorded phase", () => {
  const sim = newSim(CLI)
  sim.answer = () => ({ exitCode: 1 })
  startFor(sim, "3", "Wire…")
  assert.notEqual(sim.state.failedStart, null)
  sim.cfg = NONE
  sim.tick(1500)
  sim.tick(300)
  sim.cfg = CLI
  sim.answer = fake.ok
  sim.clear()
  sim.apply({ type: "toggle" })
  assert.deepEqual(sim.verbs(), ["start"])
  assert.equal(sim.state.failedStart, null)
})

// ---------------------------------------------- a failed close (6.21, 6.22)

test("AC-6.21 a failed close is re-sent with its seconds before the next start", () => {
  const sim = newSim(CLI)
  startFor(sim, "3", "Wire…")
  sim.answer = (e) => (e.verb === "done" ? { exitCode: 1, stderr: "db error\n" } : fake.ok())
  sim.tick(1500)
  assert.deepEqual(sim.state.pendingClose, { verb: "done", sessionUid: fake.last, focusSeconds: 1500 })
  const S = sim.state.pendingClose.sessionUid
  assert.equal(sim.state.lastRecordError, "todocli error")
  assert.equal(sim.state.phase, "shortBreak")
  assert.equal(sim.writes().some((w) => w.doc.pendingClose !== null && w.doc.pendingClose.sessionUid === S), true)
  sim.answer = fake.ok
  sim.clear()
  sim.tick(300)
  assert.equal(sim.state.phase, "work")
  assert.equal(sim.state.running, false)
  assert.equal(sim.records().length, 0)
  assert.equal(sim.notifies()[0].argv[5], "Break over")
  assert.equal(sim.notifies()[0].argv[6], "Ready for the next focus session?\nNext: Wire…")
  assert.deepEqual(sim.notifies()[0].argv.slice(7), ["--exec", "omarchy-shell", "abobreshov.pomodoro", "open"])
  assert.equal(sim.sounds()[0].file, "/usr/share/sounds/freedesktop/stereo/complete.oga")
  sim.clear()
  assert.equal(startFor(sim, "3", "Wire…"), "resumed")
  const r = sim.records()
  assert.deepEqual(r.map((e) => e.verb), ["done", "start"])
  assert.equal(r[0].sessionUid, S)
  assert.equal(r[0].focusSeconds, 1500)
  assert.equal(r[0].resend, true)
  assert.equal(r[1].taskId, "3")
  assert.equal(r[1].planned, 1500)
  assert.equal(r[1].interrupt, true)
  assert.equal(sim.state.pendingClose, null)
  assert.equal(sim.state.lastRecordError, null)
})

test("AC-6.21b a lost reply clears on the re-send (exit 0)", () => {
  const sim = newSim(CLI)
  startFor(sim, "3", "Wire…")
  sim.tick(100)
  sim.answer = () => ({ exitCode: 75, stderr: "database is busy\n" })
  sim.apply({ type: "skip" })
  assert.equal(sim.state.lastRecordError, "database busy")
  assert.equal(sim.state.pendingClose.verb, "cancel")
  assert.equal(sim.state.pendingClose.focusSeconds, 100)
  sim.answer = fake.ok
  sim.clear()
  sim.apply({ type: "skip" })
  sim.apply({ type: "toggle" })
  assert.deepEqual(sim.verbs(), ["cancel", "start"])
  assert.equal(sim.state.lastRecordError, null)
  assert.equal(sim.state.pendingClose, null)
})

test("AC-6.22 a re-send answered exit 1 is dropped and the next start runs cleanly", () => {
  const sim = newSim(CLI)
  startFor(sim, "3", "Wire…")
  sim.answer = (e) => (e.verb === "done" ? { exitCode: 1, stderr: "x" } : fake.ok())
  sim.tick(1500)
  sim.tick(300)
  sim.answer = (e) => (e.resend ? { exitCode: 1, stderr: "No running pomodoro S.\n" } : fake.ok())
  sim.clear()
  sim.apply({ type: "toggle" })
  assert.deepEqual(sim.verbs(), ["done", "start"])
  assert.equal(sim.state.pendingClose, null)
  assert.equal(sim.state.lastRecordError, "todocli error")
  assert.equal(sim.state.sessionUid, fake.last)
  sim.answer = fake.ok
  sim.tick(1500)
  assert.equal(sim.verbs().at(-1), "done")
  assert.equal(sim.state.lastRecordError, null)
})

test("a pendingClose without a sessionUid is dropped into lastRecordError before the start", () => {
  const sim = newSim(CLI, 2000000)
  sim.restore({ version: 1, phase: "idle", pendingClose: { verb: "done", sessionUid: null, focusSeconds: 900 }, updatedAt: 1000 })
  assert.equal(sim.state.pendingClose.sessionUid, null)
  sim.apply({ type: "toggle" })
  assert.deepEqual(sim.verbs(), ["start"])
  assert.equal(sim.state.pendingClose, null)
  assert.equal(sim.state.lastRecordError, "todocli error")
})

test("a failed retarget keeps the old session; a failed interrupt only reports", () => {
  const sim = newSim(CLI)
  startFor(sim, "3", "Wire…")
  sim.tick(10)
  sim.answer = () => ({ exitCode: 1, exitStatus: 1 })
  startFor(sim, "4", "Other")
  assert.equal(sim.state.sessionUid, fake.last)
  assert.equal(sim.state.lastRecordError, "todocli error")
  const sim2 = newSim(CLI, 1000000 + 1122000 + 61000)
  sim2.answer = () => ({ exitCode: 1 })
  sim2.restore(SAVED)
  assert.equal(sim2.state.lastRecordError, "todocli error")
  assert.equal(sim2.state.phase, "idle")
})
