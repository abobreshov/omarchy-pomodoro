// The loader runs a `.pragma library` file with Node's globals hidden, so a
// Node-only call (process, Buffer, timers, fetch, require) fails under the
// unit tests exactly as it would in a QML JavaScript context (A28), and it
// resolves `.import "Other.js" as Name` between libraries the way the QML
// engine does: relative to the importing file, one shared instance.
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

// Three libraries: Leaf, Mid (imports Leaf) and Top (imports both), the
// shape Timer.js takes over Phase/Record/Machine.
const LEAF = ".pragma library\nvar CONST = \"leaf\"\nvar TABLE = { done: true }\nfunction twice(n) { return n * 2 }\n"
const MID = ".pragma library\n.import \"Leaf.qmljs\" as Leaf\nfunction thrice(n) { return Leaf.twice(n) + n }\nfunction leaf() { return Leaf }\nfunction throwsHere() { throw new Error(\"mid\") }\n"
const TOP = ".pragma library\n.import \"Leaf.qmljs\" as Leaf\n.import \"sub/../Mid.qmljs\" as Mid\n.import QtQuick as Q\nvar CONST = Leaf.CONST\nvar twice = Leaf.twice\nvar thrice = Mid.thrice\nfunction wrapped(n) { return Mid.thrice(n) + 1 }\nfunction sameLeaf() { return Mid.leaf() === Leaf }\nfunction hasQ() { return typeof Q }\n"

function writeProbe() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pomodoro-loader-"))
  const file = path.join(dir, "Probe.qmljs")
  fs.writeFileSync(file, PROBE)
  return file
}

function writeTree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pomodoro-loader-tree-"))
  fs.mkdirSync(path.join(dir, "sub"))
  fs.writeFileSync(path.join(dir, "Leaf.qmljs"), LEAF)
  fs.writeFileSync(path.join(dir, "Mid.qmljs"), MID)
  fs.writeFileSync(path.join(dir, "Top.qmljs"), TOP)
  return dir
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

test(".import \"file.js\" as Name resolves relative to the importer as one shared instance", () => {
  const dir = writeTree()
  const Top = loadQmlJs(path.join(dir, "Top.qmljs"))
  assert.equal(Top.CONST, "leaf")
  assert.equal(Top.twice(2), 4)
  assert.equal(Top.thrice(3), 9)
  assert.equal(Top.wrapped(3), 10)
  assert.equal(Top.sameLeaf(), true, "Leaf reached through Mid is the instance Top imported")
  assert.equal(Top.hasQ(), "undefined", "a module import has no file and is only blanked")
  assert.deepEqual(Object.keys(Top).sort(), ["CONST", "hasQ", "sameLeaf", "thrice", "twice", "wrapped"])
})

test("a library loaded on its own and one reached through an importer are separate loads; line numbers survive the import lines", () => {
  const dir = writeTree()
  const Leaf = loadQmlJs(path.join(dir, "Leaf.qmljs"))
  const Mid = loadQmlJs(path.join(dir, "Mid.qmljs"))
  assert.notEqual(Mid.leaf(), Leaf, "each top-level load has its own cache, like a fresh QML engine")
  assert.deepEqual(Mid.leaf().TABLE, Leaf.TABLE)
  let stack = ""
  try { Mid.throwsHere() } catch (e) { stack = e.stack }
  assert.match(stack, new RegExp(path.join(dir, "Mid.qmljs").replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ":5:"))
})
