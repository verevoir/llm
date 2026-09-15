#!/usr/bin/env bash
# THROWAWAY PROBE — single-variable change from run-probe-stall-isolation.sh:
# turn 2 is now a PLAIN follow-up (no Bash, no tool mention at all) instead
# of a Bash-invocation request. Everything else — flags, --mcp-config,
# --safe-mode dropped, 300s watchdog, timing capture — is identical.
#
# WHY: the prior run (turn 2 = "run pwd via Bash") hung: plateau at ~5s,
# exit 143 at the 300s watchdog, no second result event. Two live
# hypotheses for WHY, both consistent with that evidence: (a) a
# permission-prompt flow trying to ask about the tool call, with nobody to
# answer under -p; (b) a plugin-registered hook reacting to a tool-use
# attempt specifically (gitkraken-hooks appears in turn 2's init event,
# present only because --safe-mode is off). This run removes the one
# variable both hypotheses depend on — an attempted tool call — to see
# whether a second turn hangs AT ALL once --safe-mode is off, independent
# of tools.
#
# WHAT EACH OUTCOME MEANS:
#   - Hangs too (plateau, exit 143, no second result): the stall is not
#     about tool-attempts or permission decisions — it's something about a
#     SECOND TURN GENERALLY once hooks/plugins/memory are reopened. Broader
#     and more serious: this design could not hold any multi-turn
#     conversation with --safe-mode off, tool-related or not.
#   - Completes normally (second result, result_index:1, exit 0): the stall
#     is narrowed specifically to the tool-attempted turn — points at the
#     permission-prompt/TTY-wait mechanism or the gitkraken-hooks plugin
#     reacting to tool-use. Distinguishing those two needs a further,
#     separately-confirmed probe — not guessed here.
set -u

PROBE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WATCHDOG_SECS=300

rm -f "$PROBE_DIR"/mcp-server-stdin.log "$PROBE_DIR"/probe-stdout.log \
      "$PROBE_DIR"/probe-stderr.log "$PROBE_DIR"/probe-exit-code.txt \
      "$PROBE_DIR"/probe-timing.log

MSG1='{"type":"user","message":{"role":"user","content":"Say hello in one short sentence."}}'
MSG2='{"type":"user","message":{"role":"user","content":"Say goodbye in one short sentence."}}'

cd "$PROBE_DIR" || exit 1

(
  printf '%s\n' "$MSG1"
  sleep 3
  printf '%s\n' "$MSG2"
  sleep "$WATCHDOG_SECS"
) | claude -p \
    --input-format stream-json \
    --output-format stream-json \
    --verbose \
    --disallowedTools "*" \
    --strict-mcp-config \
    --mcp-config "$PROBE_DIR/mcp-config.json" \
    --no-session-persistence \
    > "$PROBE_DIR/probe-stdout.log" \
    2> "$PROBE_DIR/probe-stderr.log" &
    # NOTE: --safe-mode deliberately absent — matches the run that hung.

CLAUDE_PID=$!

echo "$(date +%H:%M:%S) — started" > "$PROBE_DIR/probe-timing.log"
LAST_SIZE=0
for i in $(seq 1 "$WATCHDOG_SECS"); do
  kill -0 "$CLAUDE_PID" 2>/dev/null || break
  CUR_SIZE=$(wc -c < "$PROBE_DIR/probe-stdout.log" 2>/dev/null || echo 0)
  if [ "$CUR_SIZE" != "$LAST_SIZE" ]; then
    echo "$(date +%H:%M:%S) — stdout grew to ${CUR_SIZE} bytes" >> "$PROBE_DIR/probe-timing.log"
    LAST_SIZE=$CUR_SIZE
  fi
  sleep 1
done

if kill -0 "$CLAUDE_PID" 2>/dev/null; then
  echo "$(date +%H:%M:%S) — still running after ${WATCHDOG_SECS}s, killing now" | tee -a "$PROBE_DIR/probe-timing.log" >&2
  kill "$CLAUDE_PID" 2>/dev/null
fi
wait "$CLAUDE_PID" 2>/dev/null
echo $? > "$PROBE_DIR/probe-exit-code.txt"
echo "$(date +%H:%M:%S) — exited, code $(cat "$PROBE_DIR/probe-exit-code.txt")" >> "$PROBE_DIR/probe-timing.log"

echo ""
echo "Done. Send back these five files from $PROBE_DIR:"
echo "  probe-stdout.log       (every stdout line from claude, both turns)"
echo "  probe-stderr.log"
echo "  probe-exit-code.txt"
echo "  probe-timing.log       (coarse wall-clock timeline — when output grew, or stopped)"
echo "  mcp-server-stdin.log   (expected: initialize/tools/list only — no MCP turn sent this run)"
