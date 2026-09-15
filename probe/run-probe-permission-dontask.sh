#!/usr/bin/env bash
# THROWAWAY PROBE — single-variable change from run-probe-stall-isolation.sh
# (cwd-pinned version): adds --permission-mode dontAsk to the claude
# invocation. Nothing else moves — same two turns (hello, then "run pwd via
# Bash"), same --disallowedTools "*", same --mcp-config/--strict-mcp-config,
# same --safe-mode-absent, same 300s watchdog, same timing capture.
#
# WHY: the operator's channel to the CLI confirmed --permission-mode dontAsk
# is documented to auto-deny every tool call that would otherwise prompt,
# never waiting for input — "the session never waits for input." Under
# --safe-mode off, permissionMode reports "default" (interactive-ask
# behaviour) and the earlier stall-isolation run — same flags, minus this
# one — hung indefinitely on exactly the turn that asked for Bash. This run
# tests whether dontAsk resolves that turn instead of hanging on it, and
# which of three outcomes below actually happens.
#
# THREE OUTCOMES, EACH SELF-LABELLING — read probe-stdout.log's second
# result event (result_index: 1) for these:
#   1. permission_denials carries an entry for the Bash attempt.
#      -> The call reached the permission-decision flow; the tool was
#         registered (dispatchable) but unadvertised (tools:[] in init),
#         and permission was the only remaining gate. dontAsk resolved it
#         by denying rather than hanging.
#   2. The assistant's reply/stream shows a tool_use_error (e.g. "No such
#      tool available: Bash") instead of a permission_denials entry.
#      -> Rejected at the dispatch layer, before any permission decision
#         was ever reached — the tool was never truly reachable in the
#         first place, consistent with --disallowedTools "*" doing its job
#         at a layer prior to permissions.
#   3. Still hangs (plateau in probe-timing.log, no second result event,
#      forced kill, exit 143).
#      -> permission-mode was never the blocker; something else in the
#         no-safe-mode configuration stalls this turn regardless of
#         permission policy. The no-timeout-under-headless-stall theory
#         (Claude Code issues #52506/#79610/#86074) is what's left
#         standing.
#
# THIS OUTCOME NAMES THE MECHANISM DIRECTLY, independent of whether the
# gitkraken-hooks plugin has been removed by the time this runs — a
# concurrent plugin removal cannot be mistaken for the cause of whichever
# of the three outcomes above is observed, because each outcome points at
# a specific layer (permission decision / tool dispatch / something else
# entirely) rather than merely "passed" or "still hung".
set -u

PROBE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WATCHDOG_SECS=300   # 5 minutes — same as run-probe-stall-isolation.sh, so a
                    # slow turn is distinguishable from a hung one here too.

rm -f "$PROBE_DIR"/mcp-server-stdin.log "$PROBE_DIR"/probe-stdout.log \
      "$PROBE_DIR"/probe-stderr.log "$PROBE_DIR"/probe-exit-code.txt \
      "$PROBE_DIR"/probe-timing.log

MSG1='{"type":"user","message":{"role":"user","content":"Say hello in one short sentence."}}'
MSG2='{"type":"user","message":{"role":"user","content":"Run the shell command: pwd — using your Bash tool. Show me the exact raw output the tool returned, verbatim."}}'

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
    --permission-mode dontAsk \
    --strict-mcp-config \
    --mcp-config "$PROBE_DIR/mcp-config.json" \
    --no-session-persistence \
    > "$PROBE_DIR/probe-stdout.log" \
    2> "$PROBE_DIR/probe-stderr.log" &
    # NOTE: --safe-mode deliberately absent, same as run-probe-stall-isolation.sh.
    # --permission-mode dontAsk is the ONE flag added relative to that script.

CLAUDE_PID=$!

# COARSE per-line timing — see run-probe-stall-isolation.sh's own comment
# for why this polls file size rather than per-line timestamps.
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
echo "  mcp-server-stdin.log   (expected: initialize/tools/list only — no tools/call, since no MCP turn was sent this run)"
