#!/usr/bin/env bash
# Runs scripts/smoke-tools.sh REPEAT times (default 1). Each run gets its own folder, $OUT/run-<n>,
# so a failing run keeps its logs, sway log and runtime-dir listing. ONLY (a regex on the label,
# e.g. ^fuzzel-) limits which variants run. Writes $OUT/summary.md with one row per run.
# Exit status: 0 only if every run passed.
# Usage: ONLY='^fuzzel-' REPEAT=20 bash scripts/smoke-repeat.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${OUT:-$ROOT/smoke-out}"
REPEAT="${REPEAT:-1}"
mkdir -p "$OUT"
summary="$OUT/summary.md"
{
  echo "## Smoke test repeat (filter: ${ONLY:-all variants}, $REPEAT run(s))"
  echo
  echo "| Run | Result | Failed variants |"
  echo "|---|---|---|"
} > "$summary"

pass=0
fail=0
for i in $(seq 1 "$REPEAT"); do
  run_out="$OUT/run-$i"
  if OUT="$run_out" bash "$ROOT/scripts/smoke-tools.sh" > "$OUT/run-$i.stdout" 2>&1; then
    pass=$((pass + 1))
    echo "| $i | PASS | - |" >> "$summary"
    echo "run $i: PASS"
  else
    fail=$((fail + 1))
    failed_variants="$(grep '| FAIL |' "$run_out/summary.md" 2>/dev/null | cut -d'|' -f2 | tr -d ' ' | paste -sd, -)"
    echo "| $i | FAIL | ${failed_variants:-no summary} |" >> "$summary"
    echo "run $i: FAIL (${failed_variants:-no summary})"
  fi
done

{
  echo
  echo "**$pass of $REPEAT run(s) passed, $fail failed.**"
} >> "$summary"
echo "smoke-repeat: $pass of $REPEAT passed, $fail failed. Outputs in $OUT"
[ "$fail" -eq 0 ]
