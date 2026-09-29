import QtQuick
import Quickshell
import Quickshell.Io
import "Timer.js" as TimerLib

// abobreshov.pomodoro — the one timer per session.
//
// omarchy-shell creates a plugin `service` once per session (a bar widget is
// created once per monitor), so the timer, the IPC target, notifications,
// sounds, todocli recording and the state file all live here; every
// BarWidget/Panel binds to this object through bar.shell.serviceFor() and
// only renders and forwards key presses. All logic is in Timer.js and the
// modules behind it (Machine.js holds `reduce`): this file runs its effects
// and feeds it events.
//
// Forked from markbus-ai/omarchy-pomodoro (MIT). The phases, durations,
// settings keys, notification copy and sounds are upstream's.
Item {
  id: root

  // Injected by omarchy-shell when the service is created.
  property var shell: null
  property string omarchyPath: ""
  property var manifest: null

  readonly property string target: TimerLib.TARGET
  readonly property string home: Quickshell.env("HOME")
  readonly property string stateDir: root.home + "/.local/state/" + TimerLib.TARGET
  readonly property string statePath: root.stateDir + "/state.json"
  readonly property string notifyPath: root.omarchyPath !== ""
    ? root.omarchyPath
    : (Quickshell.env("OMARCHY_PATH") || "/usr/share/omarchy")

  // Settings are the widget's shell.json entry, read out of the bar config
  // the shell injects (refreshed on every shell.json change), so they are
  // known before any widget exists and the restore never waits for one.
  // Every key is coerced in Timer.settings.
  readonly property var rawSettings: TimerLib.widgetSettings(root.shell ? root.shell.barConfig : null, root.target)
  readonly property bool settingsKnown: root.shell !== null
  readonly property var cfg: {
    var c = TimerLib.settings(root.rawSettings)
    c.omarchyPath = root.notifyPath
    return c
  }

  // The machine state, replaced wholesale on every event so bindings refresh.
  // The clock stamps this instance's creation (`status.loadedAt`).
  property var timerState: TimerLib.initialState(Date.now())
  readonly property var view: TimerLib.view(root.timerState, root.cfg)

  property bool ipcReady: false
  property bool stateLoaded: false
  property bool restoredOnce: false
  property string stateText: ""
  property var widgets: []

  // ---------------------------------------------------------- dispatch

  function dispatch(event) {
    var out = TimerLib.reduce(root.timerState, event, Date.now(), root.cfg)
    root.timerState = out.state
    for (var i = 0; i < out.effects.length; i++) root.runEffect(out.effects[i])
    return out.reply
  }

  function runEffect(effect) {
    if (effect.type === "record") root.startRecord(effect)
    else if (effect.type === "writeState") root.saveState(effect.doc)
    else if (effect.type === "notify") Quickshell.execDetached(effect.argv)
    else if (effect.type === "sound") Quickshell.execDetached(["/usr/bin/pw-play", effect.file])
  }

  // Public API for the widgets (the popup keys and the pill's middle click).
  // Each is the reducer action its IPC twin dispatches (R = `reset`).
  function toggleTimer() { root.dispatch({ type: "toggle" }) }
  function resetPhase() { root.dispatch({ type: "reset" }) }
  function skipPhase() { root.dispatch({ type: "skip" }) }
  function detachTask() { root.dispatch({ type: "detach" }) }

  // ----------------------------------------------------------- widgets

  function registerWidget(widget) {
    if (root.widgets.indexOf(widget) !== -1) return
    root.widgets = root.widgets.concat([widget])
  }

  function unregisterWidget(widget) {
    root.widgets = root.widgets.filter(function(w) { return w !== widget })
  }

  // An IPC target routes to one handler; a bar widget exists per monitor, so
  // open/close/toggle reach every instance through the widget's broadcast.
  function relay(method) {
    var ws = root.widgets
    for (var i = 0; i < ws.length; i++) {
      if (ws[i] && typeof ws[i].broadcast === "function") {
        ws[i].broadcast(method)
        return
      }
    }
  }

  // --------------------------------------------------------- recording

  // One todocli process at a time; Timer.js queues the rest, keeps the one
  // in flight as `timerState.inflight` and hands the next one over only
  // after this reply was applied (PLAN §7.6).
  function startRecord(action) {
    recordProc.command = TimerLib.recordArgv(root.cfg.cliPath, action)
    recordProc.running = true
  }

  Process {
    id: recordProc
    stdout: StdioCollector { id: recordOut; waitForEnd: true }
    stderr: StdioCollector { id: recordErr; waitForEnd: true }
    onStarted: recordWatchdog.restart()
    onExited: function(exitCode, exitStatus) {
      recordWatchdog.stop()
      var action = root.timerState.inflight
      if (!action) return
      root.dispatch({ type: "recordResult", id: action.id, exitCode: exitCode, exitStatus: exitStatus,
                      stdout: recordOut.text, stderr: recordErr.text })
    }
  }

  // A todocli that never returns must not stall the queue for good.
  Timer {
    id: recordWatchdog
    interval: 60000
    onTriggered: if (recordProc.running) recordProc.signal(15)
  }

  // -------------------------------------------------------- state file

  // The directory is private (0700): the file holds task titles. `install -d
  // -m` sets the mode on an existing directory too, in one argv, no shell.
  // The file is read as soon as the path resolves (a read needs no
  // directory); the restore waits for `install -d` to have exited
  // (`dirChecked`), and every write also needs its exit 0 (`dirReady`), so
  // nothing is ever written into a directory that is not private and no save
  // can clobber the file the restore is about to read. In Quickshell 0.3.1
  // `preload: false` + `reload()` delivers no `loaded`/`loadFailed`, hence
  // the default preload here.
  property bool dirChecked: false
  property bool dirReady: false

  Process {
    id: ensureDirProc
    command: ["install", "-d", "-m", "0700", root.stateDir]
    onExited: function(exitCode, exitStatus) {
      root.dirReady = exitCode === 0
      root.dirChecked = true
      if (!root.dirReady) console.warn(root.target + ": install -d exited " + exitCode + "; state file disabled")
      root.restoreWhenReady()
    }
  }

  FileView {
    id: stateFile
    path: root.statePath
    watchChanges: false
    atomicWrites: true
    printErrors: false
    onLoaded: root.onStateRead(text())
    onLoadFailed: root.onStateRead("")
    onSaveFailed: function(error) {
      console.warn(root.target + ": state save failed: " + FileViewError.toString(error))
    }
  }

  // `loaded` can fire more than once at startup; the first read wins.
  function onStateRead(text) {
    if (root.stateLoaded) return
    root.stateLoaded = true
    root.stateText = text
    root.restoreWhenReady()
  }

  function saveState(doc) {
    if (!root.stateLoaded || !root.dirReady) return
    stateFile.setText(JSON.stringify(doc, null, 2) + "\n")
  }

  // Restore once the file was read and the directory checked. Timer.serviceStart
  // replies `deferred` while a stale session cannot be closed yet because the
  // settings are unknown (no shell injected); the text is kept and the
  // restore runs again when the shell arrives.
  function restoreWhenReady() {
    if (root.restoredOnce || !root.stateLoaded || !root.dirChecked) return
    var reply = root.dispatch({ type: "serviceStart", text: root.stateText, settingsKnown: root.settingsKnown })
    if (reply === "deferred") return
    root.restoredOnce = true
    root.stateText = ""
  }

  onShellChanged: root.restoreWhenReady()

  Component.onCompleted: ensureDirProc.running = true

  // ----------------------------------------------------------- ticking

  Timer {
    interval: 1000
    repeat: true
    running: root.timerState.running
    onTriggered: root.dispatch({ type: "tick" })
  }

  // --------------------------------------------------------------- IPC

  // Registered after 100 ms so a retiring instance and its replacement never
  // hold the target at the same time (the todo plugin's guard).
  Timer {
    id: ipcRegistrationTimer
    interval: 100
    running: true
    onTriggered: root.ipcReady = true
  }

  IpcHandler {
    enabled: root.ipcReady
    target: root.target

    function open(): void { root.relay("open") }
    function close(): void { root.relay("close") }
    function show(): void { root.relay("open") }
    function hide(): void { root.relay("close") }
    function toggle(): void { root.relay("togglePanel") }

    function start(): string { return root.dispatch({ type: "toggle" }) }
    function pause(): string { return root.dispatch({ type: "pause" }) }
    function startFor(taskId: string, label: string): string {
      return root.dispatch({ type: "startFor", taskId: taskId, label: label })
    }
    function detach(): string { return root.dispatch({ type: "detach" }) }
    function skip(): string { return root.dispatch({ type: "skip" }) }
    function reset(): string { return root.dispatch({ type: "reset" }) }
    function status(): string { return TimerLib.statusJson(root.timerState, root.cfg, Date.now()) }
  }
}
