#!/usr/bin/env bash
# THROWAWAY PROBE — see probe/README.md for what the output means.
# Self-locating: run it from anywhere as `bash /path/to/probe/run-probe.sh`.
set -u

PROBE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
rm -f "$PROBE_DIR"/mcp-server-stdin.log "$PROBE_DIR"/probe-stdout.log \
      "$PROBE_DIR"/probe-stderr.log "$PROBE_DIR"/probe-exit-code.txt

# Turn 1: an ordinary message, no tool involved — establishes the process
# answers at all.
# Turn 2: asks the model to ACTUALLY INVOKE a built-in tool (Bash) and show
# the raw output — a real tool_use event in the stream, not a description
# of what it believes it has. This is the test the two earlier runs were
# missing: the first (auth-failed) run never reached a model call at all,
# and the second (authenticated) run only had the model describe its tools
# in prose, never attempt a call.
# Turn 3: asks for the ONE MCP-declared tool (echo) — tests whether the
# confirmed --disallowedTools "*" MCP-filtering bug leaves it reachable.
# All three are sent on the SAME stdin without closing it between them —
# that "without closing between them" is the whole point of the probe.
MSG1='{"type":"user","message":{"role":"user","content":"Say hello in one short sentence."}}'
MSG2='{"type":"user","message":{"role":"user","content":"Run the shell command: pwd — using your Bash tool. Show me the exact raw output the tool returned, verbatim."}}'
MSG3='{"type":"user","message":{"role":"user","content":"Call the echo tool now, passing the argument text set to the string probe-two. Then tell me exactly what the tool returned."}}'

(
  printf '%s\n' "$MSG1"
  sleep 3
  printf '%s\n' "$MSG2"
  sleep 5
  printf '%s\n' "$MSG3"
  sleep 5
) | claude -p \
    --input-format stream-json \
    --output-format stream-json \
    --verbose \
    --disallowedTools "*" \
    --strict-mcp-config \
    --mcp-config "$PROBE_DIR/mcp-config.json" \
    --no-session-persistence \
    --safe-mode \
    > "$PROBE_DIR/probe-stdout.log" \
    2> "$PROBE_DIR/probe-stderr.log" &

CLAUDE_PID=$!
# Manual timeout — deliberately not the GNU `timeout` command, which isn't
# on a stock macOS box — so this doesn't hang indefinitely if the process
# never exits. That itself is a meaningful, reportable result; see README.
for i in $(seq 1 90); do
  kill -0 "$CLAUDE_PID" 2>/dev/null || break
  sleep 1
done
if kill -0 "$CLAUDE_PID" 2>/dev/null; then
  echo "claude did not exit within 90s — killing it now. NOTE THIS in your reply." >&2
  kill "$CLAUDE_PID" 2>/dev/null
fi
wait "$CLAUDE_PID" 2>/dev/null
echo $? > "$PROBE_DIR/probe-exit-code.txt"

echo ""
echo "Done. Send back these four files from $PROBE_DIR:"
echo "  probe-stdout.log       (every stdout line from claude, all three turns)"
echo "  probe-stderr.log"
echo "  probe-exit-code.txt"
echo "  mcp-server-stdin.log   (what the probe MCP server actually saw/sent)"
