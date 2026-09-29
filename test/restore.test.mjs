// The state file and the restore on service start (PLAN §7.5, A22; UX §6.5;
// AC-6.19, 6.20): the document's shape and its tolerant parser, a recent
// phase coming back paused with its session, a stale one closed as
// interrupted, the startup window where an IPC event ran before the file was
// read, and the `deferred` reply while the settings are unknown.
import { test } from "node:test"
import assert from "node:assert/strict"
import { loadQmlJs } from "./qml-js-loader.mjs"
import { Sim, SAVED, fakeSessions, startFor } from "./harness.mjs"

const T = loadQmlJs(new URL("../Timer.js", import.meta.url).pathname)
const CLI = T.settings({ backend: "cli" })
const fake = fakeSessions()
const newSim = (cfg, now) => new Sim(T, cfg, { now, answer: fake.ok })

// ---------------------------------------------------------- the document

test("stateFileDoc has the A22 shape and parseStateFile round-trips and validates", () => {
  const sim = newSim(CLI, 5000)
  startFor(sim, "3", "Wire it")
  sim.now += 1500
  const doc = T.stateFileDoc(sim.state, sim.now)
  assert.deepEqual(Object.keys(doc), ["version", "phase", "running", "endsAt", "remaining", "completed", "taskId", "taskLabel", "sessionUid", "focusSeconds", "pendingClose", "updatedAt"])
  assert.equal(doc.updatedAt, 6500)
  assert.equal(doc.endsAt, 1505000)
  const back = T.parseStateFile(JSON.stringify(doc))
  assert.deepEqual(back, doc)
  assert.equal(T.parseStateFile(""), null)
  assert.equal(T.parseStateFile("{"), null)
  assert.equal(T.parseStateFile("[]"), null)
  assert.equal(T.parseStateFile("null"), null)
  assert.equal(T.parseStateFile('{"version":2}'), null)
  const loose = T.parseStateFile('{"version":1,"phase":"work","running":"yes","endsAt":"x","remaining":"12.7","completed":-2,"taskId":5,"taskLabel":"a\\u0000b","sessionUid":7,"focusSeconds":"3","pendingClose":{"verb":"nope","sessionUid":"S","focusSeconds":1},"updatedAt":"9"}')
  assert.deepEqual(loose, { version: 1, phase: "work", running: false, endsAt: null, remaining: 12, completed: 0, taskId: "5", taskLabel: "a b", sessionUid: null, focusSeconds: 3, pendingClose: null, updatedAt: 9 })
  const pc = T.parseStateFile('{"version":1,"phase":"idle","pendingClose":{"verb":"cancel","sessionUid":"S","focusSeconds":"4.4"}}')
  assert.deepEqual(pc.pendingClose, { verb: "cancel", sessionUid: "S", focusSeconds: 4 })
  assert.equal(pc.updatedAt, null)
  assert.equal(pc.remaining, 0)
  assert.equal(T.parseStateFile('{"version":1,"phase":"idle","pendingClose":"x"}').pendingClose, null)
  assert.equal(T.parseStateFile('{"version":1,"phase":"idle","pendingClose":{"verb":"done","sessionUid":"","focusSeconds":1}}').pendingClose.sessionUid, null)
  assert.equal(T.parseStateFile('{"version":1,"phase":"idle","sessionUid":"  U  "}').sessionUid, "U")
})

// ------------------------------------------------------ restore (6.19, 6.20)

test("AC-6.19 a reload restores the phase paused with its session", () => {
  const sim = newSim(CLI, 1000000 + 40000)
  sim.restore(SAVED)
  const s = sim.state
  assert.equal(s.phase, "work")
  assert.equal(s.running, false)
  assert.equal(s.remaining, 1122)
  assert.equal(s.taskId, "12")
  assert.equal(s.taskLabel, "Write UX spec for the panels")
  assert.equal(s.sessionUid, "S")
  assert.equal(s.focusSeconds, 378)
  assert.equal(s.completed, 2)
  assert.equal(s.restored, true)
  assert.equal(sim.records().length, 0)
  assert.equal(sim.writes().length, 1)
  assert.equal(sim.writes()[0].doc.phase, "work")
  assert.equal(sim.apply({ type: "resume" }), "resumed")
  assert.equal(sim.state.restored, false)
  sim.tick(1122)
  const r = sim.records()
  assert.deepEqual(r.map((e) => e.verb), ["done"])
  assert.equal(r[0].sessionUid, "S")
  assert.equal(r[0].focusSeconds, 1500)
})

test("AC-6.20 a stale state closes its own session with the checkpoint", () => {
  const sim = newSim(CLI, 1000000 + 1122000 + 61000)
  sim.restore(SAVED)
  const r = sim.records()
  assert.equal(r.length, 1)
  assert.equal(r[0].verb, "interrupt")
  assert.equal(r[0].sessionUid, "S")
  assert.equal(r[0].focusSeconds, 378)
  assert.equal(sim.state.phase, "idle")
  assert.equal(sim.state.taskId, "")
  assert.equal(sim.state.restored, false)
  assert.equal(sim.writes()[0].doc.phase, "idle")
  assert.equal(T.recordArgv("todocli", r[0]).join(" "), "/usr/bin/env -- todocli --source omarchy --json pomodoro interrupt S --focus-seconds 378")
})

test("restore: invalid, idle or stale-without-session saved states start idle", () => {
  for (const saved of [null, "", "junk", { version: 2, phase: "work" }, { version: 1, phase: "idle", completed: 3 }, { version: 1, phase: "work", remaining: 10, updatedAt: 0 }, { version: 1, phase: "bogus", remaining: 10, updatedAt: 999999999 }]) {
    const sim = newSim(CLI, 5000000)
    sim.restore(saved)
    assert.equal(sim.state.phase, "idle", JSON.stringify(saved))
    assert.equal(sim.records().length, 0)
    assert.equal(sim.writes().length, 1)
  }
  const sim = newSim(CLI, 5000000)
  sim.restore({ version: 1, phase: "idle", completed: 3 })
  assert.equal(sim.state.completed, 3)
})

test("restore: a paused break with a label restores paused; the next work start records", () => {
  const sim = newSim(CLI, 2000000)
  sim.restore({ version: 1, phase: "shortBreak", running: false, endsAt: null, remaining: 100, completed: 1, taskId: "3", taskLabel: "Wire", sessionUid: null, focusSeconds: 0, pendingClose: null, updatedAt: 1999000 })
  assert.equal(sim.state.phase, "shortBreak")
  assert.equal(sim.state.restored, true)
  sim.apply({ type: "resume" })
  sim.tick(100)
  assert.equal(sim.state.phase, "work")
  assert.equal(sim.state.running, false)
  assert.equal(sim.records().length, 0)
  sim.apply({ type: "resume" })
  assert.deepEqual(sim.verbs(), ["start"])
  assert.equal(sim.records()[0].taskId, "3")
})

test("restore: a work phase without a session opens one on resume", () => {
  const sim = newSim(CLI, 2000000)
  sim.restore({ version: 1, phase: "work", running: false, endsAt: null, remaining: 1400, completed: 0, taskId: "3", taskLabel: "Wire", sessionUid: null, focusSeconds: 100, pendingClose: null, updatedAt: 1999000 })
  sim.apply({ type: "resume" })
  assert.deepEqual(sim.verbs(), ["start"])
})

test("a stale restore keeps a pendingClose for the next start", () => {
  const sim = newSim(CLI, 1000000 + 1122000 + 61000)
  sim.restore(Object.assign({}, SAVED, { pendingClose: { verb: "cancel", sessionUid: "P", focusSeconds: 5 } }))
  assert.deepEqual(sim.verbs(), ["interrupt"])
  sim.apply({ type: "toggle" })
  assert.deepEqual(sim.verbs(), ["interrupt", "cancel", "start"])
  assert.equal(sim.records()[1].sessionUid, "P")
})

// ------------------------------------------------------ the startup window

// The IPC handler enables at 100 ms and the file read may land after an event
// already ran: the live timer wins, the saved count and a pending close are
// adopted, and the saved session is closed with its checkpoint.
test("serviceStart after a live event keeps the live timer and interrupts the saved session", () => {
  const sim = newSim(CLI, 1000000 + 40000)
  assert.equal(startFor(sim, "7", "Live one"), "started")
  const live = sim.state.sessionUid
  sim.clear()
  assert.equal(sim.restore(Object.assign({}, SAVED, { pendingClose: { verb: "done", sessionUid: "P", focusSeconds: 5 } })), "")
  assert.equal(sim.state.phase, "work")
  assert.equal(sim.state.running, true)
  assert.equal(sim.state.taskId, "7")
  assert.equal(sim.state.taskLabel, "Live one")
  assert.equal(sim.state.sessionUid, live)
  assert.equal(sim.state.completed, 2)
  assert.equal(sim.state.restored, false)
  assert.deepEqual(sim.state.pendingClose, { verb: "done", sessionUid: "P", focusSeconds: 5 })
  assert.deepEqual(sim.verbs(), ["interrupt"])
  assert.equal(sim.records()[0].sessionUid, "S")
  assert.equal(sim.records()[0].focusSeconds, 378)
  assert.equal(sim.writes().length, 2) // the restore, then the answered interrupt
  assert.equal(sim.writes()[0].doc.taskId, "7")
  // A stale saved state behaves the same; a live pending close is never overwritten.
  const sim2 = newSim(CLI, 1000000 + 1122000 + 61000)
  startFor(sim2, "7", "Live one")
  sim2.tick(10)
  sim2.answer = () => ({ exitCode: 1 })
  sim2.apply({ type: "skip" })
  assert.equal(sim2.state.pendingClose.verb, "cancel")
  const livePending = sim2.state.pendingClose
  sim2.answer = fake.ok
  sim2.clear()
  sim2.restore(Object.assign({}, SAVED, { pendingClose: { verb: "done", sessionUid: "P", focusSeconds: 5 } }))
  assert.deepEqual(sim2.state.pendingClose, livePending)
  assert.equal(sim2.state.phase, "shortBreak")
  assert.deepEqual(sim2.verbs(), ["interrupt"])
  // A saved state without a session adopts only the count.
  const sim3 = newSim(CLI, 1000000 + 40000)
  startFor(sim3, "7", "Live one")
  sim3.clear()
  sim3.restore(Object.assign({}, SAVED, { sessionUid: null }))
  assert.equal(sim3.records().length, 0)
  assert.equal(sim3.state.completed, 2)
  assert.equal(sim3.state.taskId, "7")
})

test("serviceStart with unknown settings defers only a stale session's interrupt", () => {
  const sim = newSim(CLI, 1000000 + 1122000 + 61000)
  assert.equal(sim.restore(SAVED, false), "deferred")
  assert.equal(sim.effects.length, 0)
  assert.equal(sim.state.phase, "idle")
  assert.equal(sim.state.completed, 0)
  assert.equal(sim.restore(SAVED, true), "")
  assert.deepEqual(sim.verbs(), ["interrupt"])
  assert.equal(sim.state.completed, 2)
  // A fresh state restores regardless of the settings.
  const fresh = newSim(CLI, 1000000 + 40000)
  assert.equal(fresh.restore(SAVED, false), "")
  assert.equal(fresh.state.restored, true)
  // A stale state without a session needs no settings either.
  const noUid = newSim(CLI, 5000000)
  assert.equal(noUid.restore(Object.assign({}, SAVED, { sessionUid: null }), false), "")
  assert.equal(noUid.writes().length, 1)
  // With a live timer the owed interrupt is deferred the same way.
  const live = newSim(CLI, 1000000 + 1122000 + 61000)
  startFor(live, "7", "x")
  live.clear()
  assert.equal(live.restore(SAVED, false), "deferred")
  assert.equal(live.effects.length, 0)
  assert.equal(live.restore(SAVED, true), "")
  assert.deepEqual(live.verbs(), ["interrupt"])
})
