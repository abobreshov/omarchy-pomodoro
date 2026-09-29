#!/usr/bin/env bash
# Smoke test of Service.qml in a scratch Quickshell instance (opt-in; needs
# a Wayland session and `qs`). Nothing here touches the live omarchy-shell,
# ~/.config/omarchy or ~/.local/state: HOME is redirected to a scratch dir,
# the notification binary is a logging fake and todocli is test/fakebin.
#
# Drives the IPC target and checks: registration and typed functions, the
# 0700 state directory and the state file, start/pause/skip/detach/reset
# replies, the records the fake todocli received (uid round trip), a full
# 1-minute work phase (done record + notification argv), restore of a fresh
# state (paused, restored true) and the interrupt of a stale one.
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
    root.svc.applySettings({ backend: "cli", cliPath: "$dir/test/fakebin/todocli", sound: "false", workMinutes: "1", shortBreakMinutes: 1, todoTarget: "abobreshov.todo" })
    console.log("SMOKE SERVICE READY")
  }
}
EOF

pass=0; fail=0
check() { if eval "$2"; then pass=$((pass+1)); echo "ok   $1"; else fail=$((fail+1)); echo "FAIL $1 :: $2"; fi }
ipc() { qs ipc -p "$scratch/cfg" call -- abobreshov.pomodoro "$@"; }
status() { ipc status | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[sys.argv[1]])" "$1"; }
launch() {
  ( cd "$scratch" && HOME="$scratch/home" FAKE_LOG="$log" exec qs -p "$scratch/cfg" ) > "$scratch/qs.out" 2>&1 &
  qs_pid=$!
  for _ in $(seq 1 50); do grep -q "SMOKE SERVICE READY" "$scratch/qs.out" 2>/dev/null && break; sleep 0.1; done
  sleep 0.5
}
stop() { kill "$qs_pid" 2>/dev/null || true; wait "$qs_pid" 2>/dev/null || true; }
state() { python3 -c "import sys,json; d=json.load(open(sys.argv[1])); print(d[sys.argv[2]])" "$scratch/home/.local/state/abobreshov.pomodoro/state.json" "$1"; }
records() { python3 -c "import sys,json; print(' | '.join(' '.join(json.loads(l)['argv'][4:]) for l in open(sys.argv[1]) if l.strip()))" "$log"; }

echo "== fresh start"
launch
check "service loaded without QML errors" "grep -q 'SMOKE SERVICE READY' '$scratch/qs.out' && ! grep -v 'portal' '$scratch/qs.out' | grep -qi 'error'"
check "IPC target registered with typed functions" "qs ipc -p '$scratch/cfg' show | grep -q 'startFor(taskId: string, label: string): string'"
check "state dir is 0700" "[[ \$(stat -c %a '$scratch/home/.local/state/abobreshov.pomodoro') == 700 ]]"
check "state file written idle" "[[ \$(state phase) == idle ]]"
check "status idle" "[[ \$(status phase) == idle && \$(status backend) == cli ]]"
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
check "reset -> ok, paused at 1:00" "[[ \$(ipc reset) == ok && \$(status remaining) == 60 && \$(status running) == False ]]"
check "start -> resumed" "[[ \$(ipc start) == resumed ]]"
uid3=$(status sessionUid)
check "skip -> ok, break" "[[ \$(ipc skip) == ok && \$(status phase) == shortBreak ]]"
sleep 1
check "skip cancel record" "[[ \"\$(records)\" == *'cancel $uid3 --focus-seconds '* ]]"
check "skip break -> work paused" "[[ \$(ipc skip) == ok && \$(status phase) == work && \$(status running) == False ]]"
check "startFor in paused work -> retargeted (no session yet: start)" "[[ \$(ipc startFor 5 'Phase two') == retargeted ]]"
sleep 1
check "start record for the new phase" "[[ \"\$(records)\" == *'| start 5 --planned 60 --interrupt' ]]"
echo "-- waiting 62 s for the phase to complete"
sleep 62
check "phase completed into a break" "[[ \$(status phase) == shortBreak && \$(status completed) == 1 ]]"
check "done record with ~60 s" "[[ \"\$(records)\" =~ done\ 01FAKE[A-Z0-9]+\ --focus-seconds\ (59|60|61)$ ]]"
check "notification argv: -g glyph -u normal, constant headline" "grep -qF -- \$'-u\x1fnormal\x1fPomodoro complete\x1fWork session done. Take a short break.' '$nlog' && grep -qF -- \$'-g\x1f' '$nlog'"
# The body's embedded newline lands as a line break in the log: the label
# opens line 2, followed by the --exec words as separate argv elements.
check "notification label on its own line, --exec tail as separate words" "grep -qF -- \$'Phase two\x1f--exec\x1fomarchy-shell\x1fabobreshov.todo\x1fopenTask\x1f5' '$nlog' && [[ \$(grep -c . '$nlog') -eq 2 ]]"
check "lastRecordError null" "[[ \$(status lastRecordError) == None ]]"
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
