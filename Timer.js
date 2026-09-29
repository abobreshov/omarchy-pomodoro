.pragma library
.import "Phase.js" as Phase
.import "StateFile.js" as StateFile
.import "Notify.js" as Notify
.import "Record.js" as Record
.import "Machine.js" as Machine
.import "View.js" as View

// abobreshov.pomodoro — the one library the QML files import.
//
// The logic lives in six `.pragma library` modules, one per concern, and this
// file is their public surface: Service.qml, BarWidget.qml and Panel.qml
// `import "Timer.js" as TimerLib` and never a module directly, so the split
// changes nothing for QML, the IPC surface or the state file.
//
//   Phase.js      phases and their lengths, deadline arithmetic, settings
//                 coercion, sanitisers (PLAN §7.2, A21)
//   StateFile.js  the state-file document and its parser (§7.5, A22)
//   Notify.js     notification copy and argv, sounds (§7.7, UX §5.3)
//   Record.js     todocli argv, exit classification, the one-at-a-time record
//                 queue and its recovery rules (§7.6, §7.3)
//   Machine.js    state, transitions, restore, event handlers and the pure
//                 `reduce(state, event, now, cfg) -> { state, effects, reply }`
//                 (§7.3, A47)
//   View.js       status JSON, the pill/popup view, tooltip, hint, captions,
//                 pill geometry (UX §5.1–5.2, §7.4)
//
// Every function below is a one-line pass-through with the module's own
// signature, declared as a `function` rather than aliased with `var` because
// qmllint resolves a call on a library member only through a function
// declaration. The two constants are the modules' own objects.

// Phase
var TARGET = Phase.TARGET
var DEFAULTS = Phase.DEFAULTS
function settings(raw) { return Phase.settings(raw) }
function widgetSettings(barConfig, id) { return Phase.widgetSettings(barConfig, id) }
function sanitizeLabel(s) { return Phase.sanitizeLabel(s) }
function sanitizeTaskId(s) { return Phase.sanitizeTaskId(s) }
function isNumericId(s) { return Phase.isNumericId(s) }
function formatTime(secs) { return Phase.formatTime(secs) }

// Machine
function initialState() { return Machine.initialState() }
function reduce(prev, event, now, cfg) { return Machine.reduce(prev, event, now, cfg) }

// Record
function recordArgv(cliPath, action) { return Record.recordArgv(cliPath, action) }
function classifyExit(exitCode, exitStatus) { return Record.classifyExit(exitCode, exitStatus) }
function parseSession(stdout) { return Record.parseSession(stdout) }

// StateFile
function stateFileDoc(state, now) { return StateFile.stateFileDoc(state, now) }
function parseStateFile(text) { return StateFile.parseStateFile(text) }

// Notify
function notifyCopy(kind, label, taskId, todoTarget) { return Notify.notifyCopy(kind, label, taskId, todoTarget) }
function notifyArgv(omarchyPath, glyph, copy) { return Notify.notifyArgv(omarchyPath, glyph, copy) }

// View
function statusJson(state, cfg, now) { return View.statusJson(state, cfg, now) }
function view(state, cfg) { return View.view(state, cfg) }
function idleView() { return View.idleView() }
function pillLayout(vertical, m, v) { return View.pillLayout(vertical, m, v) }
function tooltipText(s) { return View.tooltipText(s) }
function recordCaption(reason) { return View.recordCaption(reason) }
function restoredCaption(restored) { return View.restoredCaption(restored) }
