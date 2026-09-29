#!/usr/bin/env bash
# Smoke test of Service.qml in a scratch Quickshell instance (opt-in; needs
# a Wayland session and `qs`). Nothing here touches the live omarchy-shell,
# ~/.config/omarchy or ~/.local/state: HOME is redirected to a scratch dir,
# the notification binary is a logging fake and todocli is test/fakebin.
#
# Drives the IPC target and checks: registration and typed functions, the
# 0700 state directory (pre-created 0755, so the mode must be fixed before
# the first write) and the state file, `status.loadedAt` (this instance's
# start; a restarted instance reports a newer one — the rollout check),
# start/pause/skip/detach replies, reset back to idle from work (the cancel
# record) and from a break (no record), the records the fake todocli
# received (uid round trip), a full 1-minute work phase (done record +
# notification argv), restore of a fresh state (paused, restored true) and
# the interrupt of a stale one. Settings reach the service the way the shell
# delivers them: a `shell` object whose `barConfig.layout` holds the widget's
# entry.
#
# The phase end is polled, not slept for (a fixed 62 s against a 60 s phase
# left ~3 s of margin), a read-only `status` call is retried when `qs ipc`
# fails transiently, and a failing check prints what the service answered.
set -euo pipefail

dir=$(cd "$(dirname "$0")/.." && pwd)
scratch=${SMOKE_DIR:-$(mktemp -d)}
mkdir -p "$scratch/home" "$scratch/omarchy/bin" "$scratch/cfg"
log="$scratch/todocli.log"
nlog="$scratch/notify.log"
: > "$log"; : > "$nlog"

cat > "$scratch/omarchy/bin/omarchy-notification-send" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$(printf '%s\x1f' "\$@")" >> "$nlog"
EOF
chmod +x "$scratch/omarchy/bin/omarchy-notification-send"

cat > "$scratch/cfg/shell.qml" <<EOF
import QtQuick
import Quickshell
ShellRoot {
  id: root
  property var svc: null
  Component.onCompleted: {
    var comp = Qt.createComponent("file://$dir/Service.qml")
    if (comp.status !== Component.Ready) { console.log("SMOKE LOAD FAILED " + comp.errorString()); Qt.quit(); return }
    root.svc = comp.createObject(null)
    root.svc.omarchyPath = "$scratch/omarchy"
    root.svc.shell = ({ barConfig: { layout: { left: [], center: [], right: [
      { id: "agx.screen-time" },
      { id: "abobreshov.pomodoro", backend: "cli", cliPath: "$dir/test/fakebin/todocli", sound: "false", workMinutes: "1", shortBreakMinutes: 1, todoTarget: "abobreshov.todo" }
    ] } } })
    console.log("SMOKE SERVICE READY")
  }
}
EOF

pass=0; fail=0
# A failing check prints the status line, the records so far and the tail of
# the qs log, so a flaky run leaves the values behind instead of a bare FAIL.
check() {
  if eval "$2"; then pass=$((pass+1)); echo "ok   $1"; return; fi
  fail=$((fail+1)); echo "FAIL $1 :: $2"
  echo "     status:  $(ipc status 2>&1 | head -c 600)"
  echo "     records: $(records 2>/dev/null || true)"
  tail -n 3 "$scratch/qs.out" 2>/dev/null | sed 's/^/     qs: /'
}
ipc() { qs ipc -p "$scratch/cfg" call -- abobreshov.pomodoro "$@"; }
# One field of `status`. A `qs ipc` call can fail transiently (the socket is
# busy while the instance starts or under load): a read-only call is retried
# up to three times; a mutator never is, so `ipc` stays a single call.
status() {
  local out="" n
  for n in 1 2 3; do
    out=$(ipc status 2>/dev/null) && [[ $out == \{* ]] && break
    sleep 0.3
  done
  printf '%s' "$out" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[sys.argv[1]])" "$1"
}
# Polls a status field until it reads `value`, for at most `timeout` seconds.
wait_for() { # field value timeout
  local end=$((SECONDS + $3))
  while (( SECONDS < end )); do
    [[ $(status "$1") == "$2" ]] && return 0
    sleep 1
  done
  return 1
}
launch() {
  launched_at=$(date +%s%3N)
  ( cd "$scratch" && HOME="$scratch/home" FAKE_LOG="$log" exec qs -p "$scratch/cfg" ) > "$scratch/qs.out" 2>&1 &
  qs_pid=$!
  for _ in $(seq 1 50); do grep -q "SMOKE SERVICE READY" "$scratch/qs.out" 2>/dev/null && break; sleep 0.1; done
  sleep 0.5
}
stop() { kill "$qs_pid" 2>/dev/null || true; wait "$qs_pid" 2>/dev/null || true; }
state() { python3 -c "import sys,json; d=json.load(open(sys.argv[1])); print(d[sys.argv[2]])" "$scratch/home/.local/state/abobreshov.pomodoro/state.json" "$1"; }
records() { python3 -c "import sys,json; print(' | '.join(' '.join(json.loads(l)['argv'][4:]) for l in open(sys.argv[1]) if l.strip()))" "$log"; }

echo "== fresh start (state directory pre-created world-readable)"
mkdir -p -m 0755 "$scratch/home/.local/state/abobreshov.pomodoro"
launch
check "service loaded without QML errors" "grep -q 'SMOKE SERVICE READY' '$scratch/qs.out' && ! grep -v 'portal' '$scratch/qs.out' | grep -qi 'error'"
check "IPC target registered with typed functions" "qs ipc -p '$scratch/cfg' show | grep -q 'startFor(taskId: string, label: string): string'"
check "pre-existing 0755 state dir is 0700 once the idle state was written" "[[ -f '$scratch/home/.local/state/abobreshov.pomodoro/state.json' && \$(stat -c %a '$scratch/home/.local/state/abobreshov.pomodoro') == 700 ]]"
check "state file written idle" "[[ \$(state phase) == idle ]]"
check "status idle" "[[ \$(status phase) == idle && \$(status backend) == cli ]]"
first_loaded=$(status loadedAt)
check "status.loadedAt is the ms this instance started (not before launch, not in the future)" "[[ '$first_loaded' =~ ^[0-9]+$ && $first_loaded -ge $launched_at && $first_loaded -le \$(date +%s%3N) ]]"
check "the state file does not carry loadedAt" "! grep -q loadedAt '$scratch/home/.local/state/abobreshov.pomodoro/state.json'"
check "startFor -> started" "[[ \$(ipc startFor 3 'Wire the payment-provider webhook') == started ]]"
sleep 1.5
check "status work running with task" "[[ \$(status phase) == work && \$(status running) == True && \$(status taskId) == 3 ]]"
uid=$(status sessionUid)
check "sessionUid came back from the fake todocli" "[[ '$uid' == 01FAKE* ]]"
check "start record argv" "[[ \"\$(records)\" == 'start 3 --planned 60 --interrupt' ]]"
check "state file has the uid" "[[ \$(state sessionUid) == '$uid' ]]"
check "same task -> already running" "[[ \$(ipc startFor 3 'Wire the payment-provider webhook') == 'already running' ]]"
check "pause -> paused" "[[ \$(ipc pause) == paused ]]"
check "status paused" "[[ \$(status running) == False ]]"
check "pause -> resumed" "[[ \$(ipc pause) == resumed ]]"
check "startFor other -> retargeted" "[[ \$(ipc startFor 8 'Book dentist') == retargeted ]]"
sleep 1
uid2=$(status sessionUid)
check "retarget gave a new uid" "[[ '$uid2' == 01FAKE* && '$uid2' != '$uid' ]]"
check "retarget record argv" "[[ \"\$(records)\" == *'retarget $uid 8 --focus-seconds '*'--planned '* ]]"
check "detach -> detached" "[[ \$(ipc detach) == detached ]]"
sleep 1
check "detach record" "[[ \"\$(records)\" == *'retarget $uid2 --label=Pomodoro --focus-seconds '* ]]"
check "label cleared" "[[ \$(status label) == '' ]]"
uidd=$(status sessionUid)
check "detach retarget gave the unlinked session a new uid" "[[ '$uidd' == 01FAKE* && '$uidd' != '$uid2' ]]"
check "reset -> reset, idle with no task" "[[ \$(ipc reset) == reset && \$(status phase) == idle && \$(status running) == False && \$(status taskId) == '' && \$(status sessionUid) == None ]]"
sleep 1
check "reset cancel record with the session's uid" "[[ \"\$(records)\" == *'cancel $uidd --focus-seconds '* ]]"
check "state file idle after reset, no session" "[[ \$(state phase) == idle && \$(state sessionUid) == None && \$(state taskId) == '' ]]"
check "reset while idle -> idle" "[[ \$(ipc reset) == idle ]]"
check "loadedAt unchanged by the events so far" "[[ \$(status loadedAt) == '$first_loaded' ]]"
check "start -> started" "[[ \$(ipc start) == started ]]"
sleep 1
uid3=$(status sessionUid)
check "fresh session after the reset" "[[ '$uid3' == 01FAKE* && '$uid3' != '$uid2' ]]"
check "skip -> ok, break" "[[ \$(ipc skip) == ok && \$(status phase) == shortBreak ]]"
sleep 1
check "skip cancel record" "[[ \"\$(records)\" == *'cancel $uid3 --focus-seconds '* ]]"
check "skip break -> work paused" "[[ \$(ipc skip) == ok && \$(status phase) == work && \$(status running) == False ]]"
check "startFor in paused work -> retargeted (no session yet: start)" "[[ \$(ipc startFor 5 'Phase two') == retargeted ]]"
sleep 1
check "start record for the new phase" "[[ \"\$(records)\" == *'| start 5 --planned 60 --interrupt' ]]"
echo "-- waiting for the 60 s phase to complete (polled, up to 75 s)"
t0=$SECONDS
check "phase completed into a break" "wait_for phase shortBreak 75 && [[ \$(status completed) == 1 ]]"
echo "   phase end seen after $((SECONDS - t0)) s"
sleep 1
check "done record with ~60 s" "[[ \"\$(records)\" =~ done\ 01FAKE[A-Z0-9]+\ --focus-seconds\ (59|60|61)$ ]]"
check "notification argv: -g glyph -u normal, constant headline" "grep -qF -- \$'-u\x1fnormal\x1fPomodoro complete\x1fWork session done. Take a short break.' '$nlog' && grep -qF -- \$'-g\x1f' '$nlog'"
# The body's embedded newline lands as a line break in the log: the label
# opens line 2, followed by the --exec words as separate argv elements.
check "notification label on its own line, --exec tail as separate words" "grep -qF -- \$'Phase two\x1f--exec\x1fomarchy-shell\x1fabobreshov.todo\x1fopenTask\x1f5' '$nlog' && [[ \$(grep -c . '$nlog') -eq 2 ]]"
check "lastRecordError null" "[[ \$(status lastRecordError) == None ]]"
nrec=$(grep -c . "$log")
check "reset from the break -> idle, task dropped, count kept" "[[ \$(ipc reset) == reset && \$(status phase) == idle && \$(status label) == '' && \$(status completed) == 1 ]]"
sleep 1
check "reset from a break records nothing" "[[ \$(grep -c . '$log') -eq $nrec ]]"
stop

echo "== restore a fresh state"
now=$(date +%s%3N)
cat > "$scratch/home/.local/state/abobreshov.pomodoro/state.json" <<EOF
{ "version": 1, "phase": "work", "running": true, "endsAt": $((now + 40000)), "remaining": 40, "completed": 2,
  "taskId": "12", "taskLabel": "Write UX spec", "sessionUid": "01FAKERESTORED", "focusSeconds": 20,
  "pendingClose": null, "updatedAt": $now }
EOF
: > "$log"
launch
sleep 3.5
check "restored paused with task and uid" "[[ \$(status phase) == work && \$(status running) == False && \$(status remaining) == 40 && \$(status taskId) == 12 && \$(status sessionUid) == 01FAKERESTORED && \$(status restored) == True ]]"
check "a restarted service reports a newer loadedAt (the rollout check), not before its launch" "[[ \$(status loadedAt) -gt $first_loaded && \$(status loadedAt) -ge $launched_at ]]"
check "no record on a fresh restore" "[[ ! -s '$log' ]]"
check "resume clears restored" "[[ \$(ipc start) == resumed && \$(status restored) == False ]]"
stop

echo "== restore a stale state"
cat > "$scratch/home/.local/state/abobreshov.pomodoro/state.json" <<EOF
{ "version": 1, "phase": "work", "running": true, "endsAt": 1000, "remaining": 40, "completed": 2,
  "taskId": "12", "taskLabel": "Write UX spec", "sessionUid": "01FAKESTALE", "focusSeconds": 378,
  "pendingClose": null, "updatedAt": 1000 }
EOF
: > "$log"
launch
sleep 3.5
check "stale state -> idle" "[[ \$(status phase) == idle && \$(status taskId) == '' ]]"
check "stale state -> interrupt record with the checkpoint" "[[ \"\$(records)\" == 'interrupt 01FAKESTALE --focus-seconds 378' ]]"
check "state file idle" "[[ \$(state phase) == idle ]]"
stop

echo
echo "smoke: $pass passed, $fail failed (scratch: $scratch)"
grep -i "warn\|error" "$scratch/qs.out" | grep -v portal || true
[[ $fail -eq 0 ]]
