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

const T = loadQmlJs(new URL("../Timer.js", import.meta.url).pathname)
const FAKE = new URL("./fakebin/todocli", import.meta.url).pathname
fs.chmodSync(FAKE, 0o755)

function runner(cliPath, env) {
  return (state, now, cfg) => {
    let s = state
    const results = []
    let out = null
    // Run every record effect the reducer emits, one at a time, in order.
    const pump = (effects) => {
      for (const e of effects) {
        if (e.type !== "record") continue
        const argv = T.recordArgv(cliPath, e)
        const r = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", env: Object.assign({}, process.env, env || {}) })
        results.push({ argv, status: r.status, stdout: r.stdout, stderr: r.stderr })
        out = T.reduce(s, { type: "recordResult", id: e.id, exitCode: r.status, exitStatus: r.signal ? 1 : 0, stdout: r.stdout, stderr: r.stderr }, now, cfg)
        s = out.state
        pump(out.effects)
      }
    }
    return {
      apply(event) {
        const first = T.reduce(s, event, now(), cfg)
        s = first.state
        pump(first.effects)
        return first.reply
      },
      state: () => s,
      results
    }
  }
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
  const cfg = T.settings({ backend: "cli", cliPath: FAKE })
  let now = 0
  const sim = runner(FAKE, { FAKE_LOG: log })(T.initialState(), () => now, cfg)
  assert.equal(sim.apply({ type: "startFor", taskId: "3", label: "Wire the payment-provider webhook" }), "started")
  const uid = sim.state().sessionUid
  assert.match(uid, /^01FAKE/)
  for (let i = 0; i < 1500; i++) { now += 1000; sim.apply({ type: "tick" }) }
  assert.equal(sim.state().phase, "shortBreak")
  assert.equal(sim.state().lastRecordError, null)
  const calls = logLines(log)
  assert.deepEqual(calls[0].argv, ["--source", "omarchy", "--json", "pomodoro", "start", "3", "--planned", "1500", "--interrupt"])
  assert.deepEqual(calls[1].argv, ["--source", "omarchy", "--json", "pomodoro", "done", uid, "--focus-seconds", "1500"])
  assert.equal(sim.results[0].argv[0], "/usr/bin/env")
  assert.equal(sim.results[0].argv[1], FAKE)
})

test("retarget, detach and skip carry the uid the fake returned", () => {
  const log = tmpLog()
  const cfg = T.settings({ backend: "cli", cliPath: FAKE })
  let now = 0
  const sim = runner(FAKE, { FAKE_LOG: log })(T.initialState(), () => now, cfg)
  sim.apply({ type: "startFor", taskId: "", label: "Admin" })
  const first = sim.state().sessionUid
  for (let i = 0; i < 300; i++) { now += 1000; sim.apply({ type: "tick" }) }
  assert.equal(sim.apply({ type: "startFor", taskId: "8", label: "Book dentist" }), "retargeted")
  const second = sim.state().sessionUid
  assert.notEqual(second, first)
  for (let i = 0; i < 60; i++) { now += 1000; sim.apply({ type: "tick" }) }
  assert.equal(sim.apply({ type: "detach" }), "detached")
  const third = sim.state().sessionUid
  now += 1000; sim.apply({ type: "tick" })
  sim.apply({ type: "skip" })
  const calls = logLines(log).map((c) => c.argv)
  assert.deepEqual(calls[0].slice(4), ["start", "--label=Admin", "--planned", "1500", "--interrupt"])
  assert.deepEqual(calls[1].slice(4), ["retarget", first, "8", "--focus-seconds", "300", "--planned", "1200"])
  assert.deepEqual(calls[2].slice(4), ["retarget", second, "--label=Pomodoro", "--focus-seconds", "60"])
  assert.deepEqual(calls[3].slice(4), ["cancel", third, "--focus-seconds", "1"])
  assert.equal(sim.state().sessionUid, null)
})

test("a missing cliPath maps to todocli not found through env's exit 127; 75 is database busy", () => {
  const cfg = T.settings({ backend: "cli", cliPath: "/nonexistent/dir/todocli-xyz" })
  const sim = runner(cfg.cliPath, {})(T.initialState(), () => 0, cfg)
  sim.apply({ type: "startFor", taskId: "3", label: "x" })
  assert.equal(sim.results[0].status, 127)
  assert.equal(sim.state().lastRecordError, "todocli not found")
  assert.equal(sim.state().running, true)
  const busy = runner(FAKE, { FAKE_EXIT: "75", FAKE_STDERR: "database is busy\n" })(T.initialState(), () => 0, T.settings({ backend: "cli", cliPath: FAKE }))
  busy.apply({ type: "startFor", taskId: "3", label: "x" })
  assert.equal(busy.state().lastRecordError, "database busy")
  const bad = runner(FAKE, { FAKE_STDOUT: "not json\n" })(T.initialState(), () => 0, T.settings({ backend: "cli", cliPath: FAKE }))
  bad.apply({ type: "startFor", taskId: "3", label: "x" })
  assert.equal(bad.state().lastRecordError, "todocli error")
  assert.equal(bad.state().sessionUid, null)
})

test("a failed done becomes a pending close re-sent before the next start (AC-6.21 through the fake)", () => {
  const log = tmpLog()
  const cfg = T.settings({ backend: "cli", cliPath: FAKE })
  let now = 0
  const failing = runner(FAKE, { FAKE_LOG: log, FAKE_EXIT: "1", FAKE_STDERR: "boom\n" })
  const ok = runner(FAKE, { FAKE_LOG: log })
  let sim = ok(T.initialState(), () => now, cfg)
  sim.apply({ type: "startFor", taskId: "3", label: "Wire" })
  const uid = sim.state().sessionUid
  for (let i = 0; i < 1499; i++) { now += 1000; sim.apply({ type: "tick" }) }
  sim = failing(sim.state(), () => now, cfg)
  now += 1000; sim.apply({ type: "tick" })
  assert.equal(sim.state().phase, "shortBreak")
  assert.deepEqual(sim.state().pendingClose, { verb: "done", sessionUid: uid, focusSeconds: 1500 })
  sim = ok(sim.state(), () => now, cfg)
  for (let i = 0; i < 300; i++) { now += 1000; sim.apply({ type: "tick" }) }
  assert.equal(sim.apply({ type: "resume" }), "resumed")
  const calls = logLines(log).map((c) => c.argv.slice(4))
  assert.deepEqual(calls[calls.length - 2], ["done", uid, "--focus-seconds", "1500"])
  assert.equal(calls[calls.length - 1][0], "start")
  assert.equal(sim.state().pendingClose, null)
  assert.equal(sim.state().lastRecordError, null)
})

test("the fake refuses an argv outside the contract", () => {
  const r = spawnSync(FAKE, ["pomodoro", "start", "3"], { encoding: "utf8" })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /unexpected argv/)
  const u = spawnSync(FAKE, ["--source", "omarchy", "--json", "pomodoro", "bogus"], { encoding: "utf8" })
  assert.equal(u.status, 1)
})
