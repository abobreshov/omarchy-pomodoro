// Loads a QML `.pragma library` JavaScript file under Node for unit tests.
// One file for both plugins: abobreshov.todo keeps the original, and
// abobreshov.pomodoro vendors a byte-identical copy pinned by SHA-256.
//
// The source is rewritten in place, keeping every line and every character
// offset: the `.pragma library` line (always line 1) becomes the opening of a
// wrapper function, `(function(__i){`, padded to the same length; every
// `.import "X.js" as Q` line becomes `var Q=__i.Q;` padded to its length; a
// module import (`.import QtQuick as Q`, no file to resolve) becomes spaces.
// Node maps V8's coverage ranges onto the file on disk, so an offset drift
// would credit the wrong lines; with none, `--experimental-test-coverage`
// attributes every range to the line it came from. The script runs in this
// context through `vm.Script` with its absolute filename, so the objects it
// returns share the test's prototypes and `assert.deepEqual` sees them as
// plain arrays and objects (research/_verified.md, "Node coverage over QML
// .js libraries"; PLAN A28).
//
// Node's own globals are hidden the way a QML context hides them: the tail
// appended after the source declares `var process, require, …`, which hoist
// to the wrapper's scope and shadow the globals with `undefined`, so a
// Node-only call inside a library fails under the tests as it would in the
// shell — without moving a single byte of the source.
//
// Imports resolve the way the QML engine resolves them: each `.import`ed
// library loads from the path next to the importing file, once per process
// (`.pragma library` = one shared instance), recursively. A test may still
// hand a qualifier in `imports` to inject its own object; such a load is not
// cached, so the shared instances stay untouched.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const HIDDEN = ["process", "require", "module", "exports", "Buffer", "global", "setTimeout", "setInterval", "setImmediate", "clearTimeout", "clearInterval", "queueMicrotask", "structuredClone", "fetch"];
const shared = new Map();

export function loadQmlJs(file, imports = {}) {
  const abs = path.resolve(file);
  const injected = Object.keys(imports).length > 0;
  if (!injected && shared.has(abs)) return shared.get(abs);
  const src = fs.readFileSync(abs, "utf8");
  const lines = src.split("\n");
  if (!/^\.pragma\s+library/.test(lines[0])) throw new Error(abs + ": line 1 must be `.pragma library`");
  const inPlace = (text, line) => {
    if (text.length > line.length) throw new Error(abs + ": cannot rewrite `" + line + "` at its own length");
    return text + " ".repeat(line.length - text.length);
  };
  const names = new Set();
  const deps = Object.assign({}, imports);
  const rewritten = lines.map((line, i) => {
    if (i === 0) return inPlace("(function(__i){", line);
    const imp = /^\.import\s+"([^"]+)"\s+as\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (imp) {
      if (!(imp[2] in deps)) deps[imp[2]] = loadQmlJs(path.resolve(path.dirname(abs), imp[1]));
      return inPlace("var " + imp[2] + "=__i." + imp[2] + ";", line);
    }
    if (/^\.import\s/.test(line)) return inPlace("", line);
    const fn = /^function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(line);
    if (fn) names.add(fn[1]);
    const v = /^var\s+([A-Za-z_$][\w$]*)\s*=/.exec(line);
    if (v) names.add(v[1]);
    return line;
  });
  const tail = "\n;var " + HIDDEN.join(",") + ";return {" + [...names].join(",") + "}})";
  const script = new vm.Script(rewritten.join("\n") + tail, { filename: abs });
  const lib = script.runInThisContext()(deps);
  if (!injected) shared.set(abs, lib);
  return lib;
}
