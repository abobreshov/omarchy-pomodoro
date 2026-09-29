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
// only renders and forwards key presses. All logic is in Timer.js: this file
// runs its effects and feeds it events.
//
// Forked from markbus-ai/omarchy-pomodoro (MIT). The phases, durations,
// settings keys, notification copy and sounds are upstream's.
Item {
  id: root

  // Injected by omarchy-shell when the service is created.
  property var shell: null
  property string omarchyPath: ""
  property var manifest: null

  readonly property string target: "abobreshov.pomodoro"
  readonly property string home: Quickshell.env("HOME")
  readonly property string stateDir: root.home + "/.local/state/abobreshov.pomodoro"
  readonly property string statePath: root.stateDir + "/state.json"
  readonly property string notifyPath: root.omarchyPath !== ""
    ? root.omarchyPath
    : (Quickshell.env("OMARCHY_PATH") || "/usr/share/omarchy")

  // Settings arrive from the bar widgets (they hold the shell.json entry);
  // every key is coerced in Timer.settings.
  property var rawSettings: ({})
  readonly property var cfg: {
    var c = TimerLib.settings(root.rawSettings)
    c.omarchyPath = root.notifyPath
    return c
  }

  // The machine state, replaced wholesale on every event so bindings refresh.
  property var timerState: TimerLib.initialState()
  readonly property var view: TimerLib.view(root.timerState, root.cfg)
  readonly property bool ready: root.restoredOnce

  property bool ipcReady: false
  property bool stateLoaded: false
  property bool settingsApplied: false
  property bool restoredOnce: false
  property var savedState: null
  property var widgets: []
  property var inflight: null

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
  function toggleTimer() { root.dispatch({ type: "toggle" }) }
  function resetPhase() { root.dispatch({ type: "reset" }) }
  function skipPhase() { root.dispatch({ type: "skip" }) }
  function detachTask() { root.dispatch({ type: "detach" }) }

  // ---------------------------------------------------------- settings

  function applySettings(raw) {
    root.rawSettings = raw && typeof raw === "object" ? raw : {}
    root.settingsApplied = true
    Qt.callLater(root.restoreWhenReady)
  }

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

  // One todocli process at a time; Timer.js queues the rest and hands the
  // next one over only after this reply was applied (PLAN §7.6).
  function startRecord(action) {
    root.inflight = action
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
      var action = root.inflight
      root.inflight = null
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
  Process {
    id: ensureDirProc
    command: ["install", "-d", "-m", "0700", root.stateDir]
    onExited: stateFile.reload()
  }

  FileView {
    id: stateFile
    path: root.statePath
    watchChanges: false
    atomicWrites: true
    printErrors: false
    onLoaded: root.onStateRead(text())
    onLoadFailed: root.onStateRead("")
  }

  function onStateRead(text) {
    if (root.stateLoaded) return
    root.stateLoaded = true
    root.savedState = TimerLib.parseStateFile(text)
    Qt.callLater(root.restoreWhenReady)
  }

  // Never write before the first read: a save in the gap would clobber the
  // file the restore is about to read.
  function saveState(doc) {
    if (!root.stateLoaded) return
    stateFile.setText(JSON.stringify(doc, null, 2) + "\n")
  }

  // Restore once the file was read and the widgets delivered the settings
  // (a stale state records an interrupt only with backend = cli); without a
  // widget the grace timer lets the defaults through.
  function restoreWhenReady() {
    if (root.restoredOnce || !root.stateLoaded) return
    if (!root.settingsApplied && settingsGrace.running) return
    root.restoredOnce = true
    var saved = root.savedState
    root.savedState = null
    root.dispatch({ type: "serviceStart", saved: saved })
  }

  Timer {
    id: settingsGrace
    interval: 3000
    running: true
    onTriggered: root.restoreWhenReady()
  }

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
