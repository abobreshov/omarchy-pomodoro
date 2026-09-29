// The recording path end to end under Node: Timer.recordArgv builds the argv,
// a real process runs it against the fake todocli (test/fakebin/todocli),
// and its exit code and stdout go back through Timer.reduce as the service
// does in Service.qml. Covers PLAN §7.6 (argv order, env prefix, exit
// mapping) with the fake logging what it was asked.
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { loadQmlJs } from "./qml-js-loader.mjs"
import { Sim } from "./harness.mjs"

const T = loadQmlJs(new URL("../Timer.js", import.meta.url).pathname)
const FAKE = new URL("./fakebin/todocli", import.meta.url).pathname

// An `answer` that runs the record's argv as a real process, with `env` on
// top of the test's environment, and logs every run into `results`.
function spawnAnswer(cliPath, env, results) {
  return (e) => {
    const argv = T.recordArgv(cliPath, e)
    const r = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", env: Object.assign({}, process.env, env || {}) })
    results.push({ argv, status: r.status, stdout: r.stdout, stderr: r.stderr })
    return { exitCode: r.status, exitStatus: r.signal ? 1 : 0, stdout: r.stdout, stderr: r.stderr }
  }
}

function fakeSim(cfg, env, results) {
  return new Sim(T, cfg, { answer: spawnAnswer(cfg.cliPath, env, results || []) })
}

function tmpLog() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pomodoro-fake-"))
  return path.join(dir, "todocli.log")
}

function logLines(file) {
  return fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l))
}

test("a work phase records start then done through the fake todocli", () => {
  const log = tmpLog()
  const results = []
  const sim = fakeSim(T.settings({ backend: "cli", cliPath: FAKE }), { FAKE_LOG: log }, results)
  assert.equal(sim.apply({ type: "startFor", taskId: "3", label: "Wire the payment-provider webhook" }), "started")
  const uid = sim.state.sessionUid
  assert.match(uid, /^01FAKE/)
  sim.tick(1500)
  assert.equal(sim.state.phase, "shortBreak")
  assert.equal(sim.state.lastRecordError, null)
  const calls = logLines(log)
  assert.deepEqual(calls[0].argv, ["--source", "omarchy", "--json", "pomodoro", "start", "3", "--planned", "1500", "--interrupt"])
  assert.deepEqual(calls[1].argv, ["--source", "omarchy", "--json", "pomodoro", "done", uid, "--focus-seconds", "1500"])
  assert.deepEqual(results[0].argv.slice(0, 3), ["/usr/bin/env", "--", FAKE])
})

test("retarget, detach and skip carry the uid the fake returned", () => {
  const log = tmpLog()
  const sim = fakeSim(T.settings({ backend: "cli", cliPath: FAKE }), { FAKE_LOG: log })
  sim.apply({ type: "startFor", taskId: "", label: "Admin" })
  const first = sim.state.sessionUid
  sim.tick(300)
  assert.equal(sim.apply({ type: "startFor", taskId: "8", label: "Book dentist" }), "retargeted")
  const second = sim.state.sessionUid
  assert.notEqual(second, first)
  sim.tick(60)
  assert.equal(sim.apply({ type: "detach" }), "detached")
  const third = sim.state.sessionUid
  sim.tick(1)
  sim.apply({ type: "skip" })
  const calls = logLines(log).map((c) => c.argv)
  assert.deepEqual(calls[0].slice(4), ["start", "--label=Admin", "--planned", "1500", "--interrupt"])
  assert.deepEqual(calls[1].slice(4), ["retarget", first, "8", "--focus-seconds", "300", "--planned", "1200"])
  assert.deepEqual(calls[2].slice(4), ["retarget", second, "--label=Pomodoro", "--focus-seconds", "60"])
  assert.deepEqual(calls[3].slice(4), ["cancel", third, "--focus-seconds", "1"])
  assert.equal(sim.state.sessionUid, null)
})

test("a missing cliPath maps to todocli not found through env's exit 127; 75 is database busy", () => {
  const results = []
  const sim = fakeSim(T.settings({ backend: "cli", cliPath: "/nonexistent/dir/todocli-xyz" }), {}, results)
  sim.apply({ type: "startFor", taskId: "3", label: "x" })
  assert.equal(results[0].status, 127)
  assert.equal(sim.state.lastRecordError, "todocli not found")
  assert.equal(sim.state.running, true)
  const busy = fakeSim(T.settings({ backend: "cli", cliPath: FAKE }), { FAKE_EXIT: "75", FAKE_STDERR: "database is busy\n" })
  busy.apply({ type: "startFor", taskId: "3", label: "x" })
  assert.equal(busy.state.lastRecordError, "database busy")
  const bad = fakeSim(T.settings({ backend: "cli", cliPath: FAKE }), { FAKE_STDOUT: "not json\n" })
  bad.apply({ type: "startFor", taskId: "3", label: "x" })
  assert.equal(bad.state.lastRecordError, "todocli error")
  assert.equal(bad.state.sessionUid, null)
})

test("a dash-leading cliPath is a program name for env, never an env option", () => {
  const results = []
  const sim = fakeSim(T.settings({ backend: "cli", cliPath: "-S" }), {}, results)
  sim.apply({ type: "startFor", taskId: "3", label: "x" })
  assert.equal(results[0].status, 127)
  assert.equal(sim.state.lastRecordError, "todocli not found")
})

test("a failed done becomes a pending close re-sent before the next start (AC-6.21 through the fake)", () => {
  const log = tmpLog()
  const cfg = T.settings({ backend: "cli", cliPath: FAKE })
  const sim = fakeSim(cfg, { FAKE_LOG: log })
  sim.apply({ type: "startFor", taskId: "3", label: "Wire" })
  const uid = sim.state.sessionUid
  sim.tick(1499)
  sim.answer = spawnAnswer(FAKE, { FAKE_LOG: log, FAKE_EXIT: "1", FAKE_STDERR: "boom\n" }, [])
  sim.tick(1)
  assert.equal(sim.state.phase, "shortBreak")
  assert.deepEqual(sim.state.pendingClose, { verb: "done", sessionUid: uid, focusSeconds: 1500 })
  sim.answer = spawnAnswer(FAKE, { FAKE_LOG: log }, [])
  sim.tick(300)
  assert.equal(sim.apply({ type: "resume" }), "resumed")
  const calls = logLines(log).map((c) => c.argv.slice(4))
  assert.deepEqual(calls[calls.length - 2], ["done", uid, "--focus-seconds", "1500"])
  assert.equal(calls[calls.length - 1][0], "start")
  assert.equal(sim.state.pendingClose, null)
  assert.equal(sim.state.lastRecordError, null)
})

test("the fake refuses an argv outside the contract", () => {
  const r = spawnSync(FAKE, ["pomodoro", "start", "3"], { encoding: "utf8" })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /unexpected argv/)
  const u = spawnSync(FAKE, ["--source", "omarchy", "--json", "pomodoro", "bogus"], { encoding: "utf8" })
  assert.equal(u.status, 1)
})
