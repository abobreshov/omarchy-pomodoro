// The state file's document, goldened (PLAN §7.5, A22): the four shapes a
// reader meets — work running, work paused, a break running, idle — as
// StateFile.stateFileDoc writes them, kept in test/fixtures/state-file.json.
// It is the source of the copy abobreshov.todo's README names as
// tests/fixtures/pomodoro-state-file.json, vendored and pinned by SHA-256 and
// read through its Pomodoro.pomodoroView, so the two plugins agree on the
// contract by the bytes, not by a comment. UPDATE_FIXTURES=1 rewrites the
// golden; a rewrite is re-vendored there.
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { loadQmlJs } from "./qml-js-loader.mjs"
import { Sim, fakeSessions, startFor } from "./harness.mjs"

const T = loadQmlJs(new URL("../Timer.js", import.meta.url).pathname)
const GOLDEN = new URL("./fixtures/state-file.json", import.meta.url)
const CLI = T.settings({ backend: "cli" })

// A work phase started on task 12 at t = 1 000 000 ms, written 378 s in,
// then paused, skipped into a short break, and reset to idle; every value
// comes from the simulated clock and the fake sessions ("S1"…).
function shapes() {
  const fake = fakeSessions()
  const sim = new Sim(T, CLI, { now: 1000000, answer: fake.ok })
  startFor(sim, "12", "Write UX spec for the panels")
  sim.tick(378)
  const running = T.stateFileDoc(sim.state, sim.now)
  sim.apply({ type: "pause" })
  const paused = T.stateFileDoc(sim.state, sim.now)
  sim.apply({ type: "resume" })
  sim.apply({ type: "skip" })
  const brk = T.stateFileDoc(sim.state, sim.now)
  sim.apply({ type: "reset" })
  const idle = T.stateFileDoc(sim.state, sim.now)
  return { running, paused, break: brk, idle }
}

test("the state-file golden is what stateFileDoc writes for running, paused, break and idle", () => {
  const docs = shapes()
  const text = JSON.stringify(docs, null, 2) + "\n"
  if (process.env.UPDATE_FIXTURES) fs.writeFileSync(GOLDEN, text)
  assert.equal(fs.readFileSync(GOLDEN, "utf8"), text, "test/fixtures/state-file.json drifted: UPDATE_FIXTURES=1 rewrites it, then re-vendor it in abobreshov.todo")
  assert.deepEqual(Object.keys(docs), ["running", "paused", "break", "idle"])
  for (const doc of Object.values(docs)) {
    assert.equal(doc.version, 1)
    assert.deepEqual(T.parseStateFile(JSON.stringify(doc)), doc, "every shape round-trips through the parser")
  }
  assert.equal(docs.running.phase, "work")
  assert.equal(docs.running.running, true)
  assert.equal(docs.running.endsAt, 1000000 + 1500000)
  assert.equal(docs.running.taskId, "12")
  assert.equal(docs.paused.running, false)
  assert.equal(docs.paused.endsAt, null)
  assert.equal(docs.paused.remaining, 1122)
  assert.equal(docs.break.phase, "shortBreak")
  assert.equal(docs.break.running, true)
  assert.equal(docs.idle.phase, "idle")
  assert.equal(docs.idle.taskId, "")
  assert.equal(docs.idle.sessionUid, null)
})
