// Load a QML `.pragma library` JavaScript file under Node for unit tests.
//
// QML libraries are not ES modules: they start with `.pragma library` and may
// carry `.import` lines. Those lines are blanked (never removed) so that every
// reported line number, including the coverage reporter's, still points at the
// original file. The body is wrapped in a function on the same first line.
//
// `.import "Other.js" as Name` (a library importing a library, Qt's form) is
// resolved relative to the importing file: the dependency is loaded first and
// handed to the wrapper as the parameter `Name`, exactly the qualifier the QML
// engine provides. One `cache` per top-level load keeps a library imported on
// several paths a single instance, as `.pragma library` does in QML. A module
// import (`.import QtQuick as Q`) has no file to resolve and is only blanked.
//
// Deviation from A28 (`runInNewContext({Date, JSON, Math, …})`): the script
// runs in this context so the objects it returns share the test realm and
// `assert.deepStrictEqual` compares them by value. Node's own globals are
// hidden instead by shadowing them as parameters of the outer wrapper, which
// is called with no arguments, so `process`, `Buffer`, the timers, `fetch` and
// `require` are `undefined` inside the library exactly as in a QML context.
import fs from "node:fs"
import path from "node:path"
import vm from "node:vm"

const DIRECTIVE = /^\.(pragma\s+library|import\s)/
const FILE_IMPORT = /^\.import\s+"([^"]+)"\s+as\s+([A-Za-z_$][\w$]*)\s*$/
const HIDDEN = "process, require, module, exports, Buffer, global, setTimeout, setInterval, setImmediate, clearTimeout, clearInterval, queueMicrotask, structuredClone, fetch"

export function loadQmlJs(file, cache = new Map()) {
  const abs = path.resolve(file)
  if (cache.has(abs)) return cache.get(abs)
  const lines = fs.readFileSync(abs, "utf8").split("\n")
  const imports = []
  for (let i = 0; i < lines.length; i++) {
    const m = FILE_IMPORT.exec(lines[i])
    if (m) imports.push({ file: path.resolve(path.dirname(abs), m[1]), name: m[2] })
    if (DIRECTIVE.test(lines[i])) lines[i] = ""
  }
  const body = lines.join("\n")
  const names = new Set()
  for (const m of body.matchAll(/^(?:function|var)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1])
  const qualifiers = imports.map((i) => i.name).join(", ")
  lines[0] = "(function (" + HIDDEN + ") { return function (" + qualifiers + ") {" + lines[0]
  const src = lines.join("\n") + "\n;return {" + [...names].join(",") + "}\n}})()"
  const factory = new vm.Script(src, { filename: abs }).runInThisContext()
  const deps = imports.map((i) => loadQmlJs(i.file, cache))
  const lib = factory(...deps)
  cache.set(abs, lib)
  return lib
}
