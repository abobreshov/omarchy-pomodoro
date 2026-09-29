// The recording path (PLAN §7.6): the argv Record.js builds per verb and its
// exit-code classification as units, then end to end under Node — a real
// process runs the argv against the fake todocli (test/fakebin/todocli) and
// its exit code and stdout go back through Timer.reduce as the service does
// in Service.qml, the fake logging what it was asked.
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { loadQmlJs } from "./qml-js-loader.mjs"
import { Sim, SESSION } from "./harness.mjs"

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

test("reset cancels a running work session through the fake todocli; a break reset sends nothing", () => {
  const log = tmpLog()
  const sim = fakeSim(T.settings({ backend: "cli", cliPath: FAKE }), { FAKE_LOG: log })
  sim.apply({ type: "startFor", taskId: "3", label: "Wire" })
  const uid = sim.state.sessionUid
  sim.tick(120)
  assert.equal(sim.apply({ type: "reset" }), "reset")
  assert.equal(sim.state.phase, "idle")
  assert.equal(sim.state.taskId, "")
  assert.equal(sim.state.sessionUid, null)
  assert.equal(sim.state.lastRecordError, null)
  let calls = logLines(log).map((c) => c.argv.slice(4))
  assert.deepEqual(calls, [["start", "3", "--planned", "1500", "--interrupt"], ["cancel", uid, "--focus-seconds", "120"]])
  // A fresh phase after the reset opens a new session; reset in its break records nothing more.
  assert.equal(sim.apply({ type: "toggle" }), "started")
  const uid2 = sim.state.sessionUid
  assert.notEqual(uid2, uid)
  sim.tick(1500)
  assert.equal(sim.state.phase, "shortBreak")
  assert.equal(sim.apply({ type: "reset" }), "reset")
  assert.equal(sim.apply({ type: "reset" }), "idle")
  calls = logLines(log).map((c) => c.argv.slice(4))
  assert.equal(calls.length, 4)
  assert.deepEqual(calls[2], ["start", "--label=Pomodoro", "--planned", "1500", "--interrupt"])
  assert.deepEqual(calls[3], ["done", uid2, "--focus-seconds", "1500"])
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

// --------------------------------------------------------- argv units (7.6)

test("recordArgv: every verb, env prefix, attached --label, one element per value", () => {
  const p = ["/usr/bin/env", "--", "/opt/todocli", "--source", "omarchy", "--json", "pomodoro"]
  assert.deepEqual(T.recordArgv("/opt/todocli", { verb: "start", taskId: "3", label: "L", planned: 1500, interrupt: true, startedAt: null }), p.concat(["start", "3", "--planned", "1500", "--interrupt"]))
  assert.deepEqual(T.recordArgv("/opt/todocli", { verb: "start", taskId: "", label: "--json x", planned: 60, interrupt: true, startedAt: 1700000000999 }), p.concat(["start", "--label=--json x", "--planned", "60", "--started-at", "1700000000", "--interrupt"]))
  assert.deepEqual(T.recordArgv("/opt/todocli", { verb: "done", sessionUid: "S", focusSeconds: 12.6 }), p.concat(["done", "S", "--focus-seconds", "13"]))
  assert.deepEqual(T.recordArgv("/opt/todocli", { verb: "cancel", sessionUid: "S", focusSeconds: -1 }), p.concat(["cancel", "S", "--focus-seconds", "0"]))
  assert.deepEqual(T.recordArgv("/opt/todocli", { verb: "retarget", sessionUid: "S", taskId: "8", label: "x", focusSeconds: 300, planned: 1200 }), p.concat(["retarget", "S", "8", "--focus-seconds", "300", "--planned", "1200"]))
  assert.deepEqual(T.recordArgv("/opt/todocli", { verb: "retarget", sessionUid: "S", taskId: "", label: "Pomodoro", focusSeconds: 600, planned: null }), p.concat(["retarget", "S", "--label=Pomodoro", "--focus-seconds", "600"]))
  assert.deepEqual(T.recordArgv("/opt/todocli", { verb: "interrupt", sessionUid: "S", focusSeconds: 378 }), p.concat(["interrupt", "S", "--focus-seconds", "378"]))
  assert.deepEqual(T.recordArgv("", { verb: "interrupt", sessionUid: "S", focusSeconds: 1 })[2], "todocli")
  assert.deepEqual(T.recordArgv("-S sh", { verb: "interrupt", sessionUid: "S", focusSeconds: 1 }).slice(0, 3), ["/usr/bin/env", "--", "-S sh"])
})

test("classifyExit and parseSession", () => {
  assert.equal(T.classifyExit(0, 0), null)
  assert.equal(T.classifyExit(127, 0), "todocli not found")
  assert.equal(T.classifyExit(75, 0), "database busy")
  assert.equal(T.classifyExit(1, 0), "todocli error")
  assert.equal(T.classifyExit(0, 1), "todocli error")
  assert.equal(T.classifyExit(11, 1), "todocli error")
  assert.deepEqual(T.parseSession(SESSION("U1")).uid, "U1")
  assert.equal(T.parseSession(""), null)
  assert.equal(T.parseSession("{"), null)
  assert.equal(T.parseSession("[1]"), null)
  assert.equal(T.parseSession('{"uid": ""}'), null)
  assert.equal(T.parseSession('{"uid": 5}'), null)
  assert.equal(T.parseSession('{"ok":false,"error":"x","code":1}'), null)
})
