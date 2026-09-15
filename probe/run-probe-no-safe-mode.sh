#!/usr/bin/env bash
# THROWAWAY PROBE #4 — isolates --safe-mode as the (still unconfirmed)
# cause of mcp_servers always coming back empty. Identical to probe #3
# (run-probe.sh) in every other respect — same three turns, same
# --disallowedTools "*", same --mcp-config, same --strict-mcp-config —
# with exactly one flag removed: --safe-mode. See probe/README.md.
set -u

PROBE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
rm -f "$PROBE_DIR"/mcp-server-stdin.log "$PROBE_DIR"/probe-stdout.log \
      "$PROBE_DIR"/probe-stderr.log "$PROBE_DIR"/probe-exit-code.txt

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
    > "$PROBE_DIR/probe-stdout.log" \
    2> "$PROBE_DIR/probe-stderr.log" &
    # NOTE: --safe-mode is deliberately ABSENT above — the one variable
    # this probe changes relative to probe #3. Without --safe-mode this
    # invocation also drops CLAUDE.md/skills/plugins/hooks/custom-command
    # suppression, not just whatever it was doing to MCP — read the
    # result with that in mind, not as a pure MCP-only test.

CLAUDE_PID=$!
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
