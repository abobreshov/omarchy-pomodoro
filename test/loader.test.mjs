// The loader runs a `.pragma library` file with Node's globals hidden, so a
// Node-only call (process, Buffer, timers, fetch, require) fails under the
// unit tests exactly as it would in a QML JavaScript context (A28).
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { loadQmlJs } from "./qml-js-loader.mjs"

const PROBE = [
  ".pragma library",
  ".import QtQuick as Q",
  "var NAMES = [\"process\", \"require\", \"module\", \"exports\", \"Buffer\", \"global\", \"setTimeout\", \"setInterval\", \"setImmediate\", \"clearTimeout\", \"clearInterval\", \"queueMicrotask\", \"structuredClone\", \"fetch\"]",
  "function nodeGlobals() {",
  "  var found = []",
  "  var probes = { process: typeof process, require: typeof require, module: typeof module, exports: typeof exports, Buffer: typeof Buffer, global: typeof global, setTimeout: typeof setTimeout, setInterval: typeof setInterval, setImmediate: typeof setImmediate, clearTimeout: typeof clearTimeout, clearInterval: typeof clearInterval, queueMicrotask: typeof queueMicrotask, structuredClone: typeof structuredClone, fetch: typeof fetch }",
  "  for (var k in probes) if (probes[k] !== \"undefined\") found.push(k)",
  "  return found",
  "}",
  "function qmlGlobals() { return [typeof Date, typeof JSON, typeof Math, typeof String, typeof Number, typeof Array, typeof Object, typeof console].join(\",\") }",
  "function lineOfThrow() { throw new Error(\"probe\") }",
  ""
].join("\n")

function writeProbe() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pomodoro-loader-"))
  const file = path.join(dir, "Probe.qmljs")
  fs.writeFileSync(file, PROBE)
  return file
}

test("Node-only globals are undefined inside a loaded library; the QML ones remain", () => {
  const P = loadQmlJs(writeProbe())
  assert.deepEqual(P.nodeGlobals(), [])
  assert.equal(P.qmlGlobals(), "function,object,object,function,function,function,function,object")
  assert.deepEqual(P.NAMES.length, 14)
})

test("directive lines are blanked, not removed, so reported line numbers match the file", () => {
  const file = writeProbe()
  const P = loadQmlJs(file)
  let stack = ""
  try { P.lineOfThrow() } catch (e) { stack = e.stack }
  assert.match(stack, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ":11:"))
})
