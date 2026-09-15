#!/usr/bin/env bash
# THROWAWAY PROBE — isolates the stall seen in the earlier --safe-mode-off
# run: does an ORDINARY turn (no tools attempted, no MCP call) still hang
# once --safe-mode is dropped, or was 90s simply too short to tell slow from
# hung? --mcp-config is still supplied (the real target session shape keeps
# MCP wired up) but NO turn asks for the MCP tool this time — that question
# is already answered (mcp_servers connects, stays connected across turns)
# and is not what this run tests.
#
# FLAG CHOSEN, AND WHY: --safe-mode is DROPPED (it blocks MCP, which this
# design deliberately needs). --bare is NOT added. This repo's own
# CHANGELOG.md (0.25.0 entry) documents --bare's effect on exactly one
# thing: auth ("Anthropic auth under it is strictly ANTHROPIC_API_KEY/
# apiKeyHelper — OAuth and keychain never read"). It says nothing about
# --bare's effect on hooks/skills/plugins/CLAUDE.md determinism, so there is
# no changelog basis for expecting it to give us what --safe-mode gave for
# THAT question — adding it would not help here, only reopen the auth
# question for no benefit. Determinism itself is meant to be enforced by an
# EXTENDED startup assertion against the CLI's own init event (a
# session.ts change, not built this turn, not part of this probe) rather
# than by flag choice: pick wrong, and the assertion refuses loudly on the
# very first call instead of a silently different runner. WHAT THAT
# ASSERTION CANNOT CATCH: anything that fires and has side effects BEFORE
# the init event is even emitted. The prior run's SessionStart hook is
# exactly this case — hook_started/hook_response appeared, with real
# output, ahead of "init" in the very same stdout stream — which is part of
# why THIS run exists: to see whether that hook, or something else specific
# to this flag choice, is what actually stalled an otherwise ordinary turn.
set -u

PROBE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WATCHDOG_SECS=300   # 5 minutes — well past the 90s that killed the earlier
                    # run, so a slow turn is distinguishable from a hung one.

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
    --strict-mcp-config \
    --mcp-config "$PROBE_DIR/mcp-config.json" \
    --no-session-persistence \
    > "$PROBE_DIR/probe-stdout.log" \
    2> "$PROBE_DIR/probe-stderr.log" &
    # NOTE: --safe-mode deliberately absent — see the header above.

CLAUDE_PID=$!

# COARSE per-line timing, without touching the primary capture above: none
# of claude's own stdout lines carry a wall-clock mark of when THIS SCRIPT
# received them (only some event types carry their own internal
# "timestamp"/duration fields, and system/init carries neither) — so this
# polls the growing output file's size once a second and records wall-clock
# time whenever it changes. A rough "where did the time go" timeline, not a
# per-JSON-line timestamp, but enough to show whether growth plateaus (a
# stall) versus keeps trickling in slowly (merely slow).
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
