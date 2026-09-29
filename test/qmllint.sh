#!/usr/bin/env bash
# qmllint gate for the plugin's QML files (PLAN §9.4, A28).
#
# The shell's modules are imported as `qs.Commons` / `qs.Ui`, which resolve
# only through an import root that holds a `qs` entry, so a scratch directory
# with `qs -> /usr/share/omarchy/shell` is passed as -I (the plugin folder
# itself may hold no symlink: `omarchy plugin validate` refuses them).
#
# Gate: qmllint exits 0, prints no `Error:` line, and every warning (file,
# message and category, line numbers stripped) is in test/qmllint-baseline.txt.
# First-party widgets emit inherent `missing-property` warnings on
# `Style.font.*`, so a baseline rather than "zero warnings" is the rule.
# `--update` rewrites the baseline from the current warnings.
set -euo pipefail

dir=$(cd "$(dirname "$0")/.." && pwd)
baseline="$dir/test/qmllint-baseline.txt"
qmllint=${QMLLINT:-/usr/lib/qt6/bin/qmllint}
shell_root=${OMARCHY_SHELL:-/usr/share/omarchy/shell}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/qsroot"
ln -s "$shell_root" "$tmp/qsroot/qs"

cd "$dir"
files=(*.qml)
set +e
out=$("$qmllint" -I "$tmp/qsroot" "${files[@]}" 2>&1)
status=$?
set -e
printf '%s\n' "$out"

errors=$(printf '%s\n' "$out" | grep -c '^Error:' || true)
normalised=$(printf '%s\n' "$out" | sed -n 's/^Warning: \([^:]*\):[0-9]*:[0-9]*: \(.*\)$/\1: \2/p' | sort -u)
warnings=$(printf '%s\n' "$normalised" | grep -c . || true)

if [[ ${1:-} == "--update" ]]; then
  printf '%s\n' "$normalised" > "$baseline"
  echo "qmllint: baseline written with $warnings warning(s)"
fi

echo "qmllint: exit $status, $errors error(s), $warnings distinct warning(s)"
[[ $status -eq 0 && $errors -eq 0 ]] || { echo "qmllint: FAILED (errors)"; exit 1; }

if [[ -f $baseline ]]; then
  new=$(comm -13 <(sort -u "$baseline") <(printf '%s\n' "$normalised" | grep . || true) || true)
  if [[ -n $new ]]; then
    echo "qmllint: FAILED, warnings outside the baseline:"
    printf '%s\n' "$new"
    exit 1
  fi
fi
echo "qmllint: OK"
