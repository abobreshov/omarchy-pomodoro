// Load a QML `.pragma library` JavaScript file under Node for unit tests.
//
// QML libraries are not ES modules: they start with `.pragma library` and may
// carry `.import` lines. Those lines are blanked (never removed) so that every
// reported line number, including the coverage reporter's, still points at the
// original file. The body is wrapped in a function on the same first line.
//
// Deviation from A28 (`runInNewContext({Date, JSON, Math, …})`): the script
// runs in this context so the objects it returns share the test realm and
// `assert.deepStrictEqual` compares them by value. Node's own globals are
// hidden instead by shadowing them as parameters of the wrapper, which is
// called with no arguments, so `process`, `Buffer`, the timers, `fetch` and
// `require` are `undefined` inside the library exactly as in a QML context.
import fs from "node:fs"
import path from "node:path"
import vm from "node:vm"

const DIRECTIVE = /^\.(pragma\s+library|import\s)/
const HIDDEN = "process, require, module, exports, Buffer, global, setTimeout, setInterval, setImmediate, clearTimeout, clearInterval, queueMicrotask, structuredClone, fetch"

export function loadQmlJs(file) {
  const abs = path.resolve(file)
  const lines = fs.readFileSync(abs, "utf8").split("\n")
  for (let i = 0; i < lines.length; i++) {
    if (DIRECTIVE.test(lines[i])) lines[i] = ""
  }
  const body = lines.join("\n")
  const names = new Set()
  for (const m of body.matchAll(/^(?:function|var)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1])
  lines[0] = "(function (" + HIDDEN + ") {" + lines[0]
  const src = lines.join("\n") + "\n;return {" + [...names].join(",") + "}\n})()"
  return new vm.Script(src, { filename: abs }).runInThisContext()
}
