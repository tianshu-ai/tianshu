#!/bin/bash
# Reproduce stale bridge connection issue on macOS.
#
# Strategy: use `pf` (macOS packet filter) to silently DROP packets
# on the bridge's WS connection. The server never gets a FIN/RST,
# so its close event never fires — classic half-open socket.
#
# The bridge client will detect silence after ~60s (DEAD_AFTER_MS)
# and reconnect. Meanwhile, the server's registry still holds the
# dead socket. Agent tool calls will fail until the bridge
# re-registers on a new socket.
#
# WITH the fix (markStaleAndScheduleRemoval): the first failed
# send/timeout marks the conn stale, so the retry loop waits for
# a fresh connection and succeeds after bridge reconnects.
#
# Usage:
#   sudo ./scripts/repro-stale-bridge.sh [server_port]
#
# Requirements: macOS with pfctl, sudo

set -euo pipefail

PORT="${1:-3110}"

echo "=== Stale Bridge Connection Reproducer ==="
echo ""

# Must be root for pfctl
if [[ $EUID -ne 0 ]]; then
  echo "Need sudo. Run: sudo $0 $*"
  exit 1
fi

# Find bridge process
BRIDGE_PID=$(pgrep -f "local-bridge" | head -1 || true)
if [[ -z "$BRIDGE_PID" ]]; then
  echo "ERROR: No local-bridge process found."
  exit 1
fi
echo "Bridge PID: $BRIDGE_PID"

# Find its TCP connection to the server port
CONN_LINE=$(lsof -i "TCP:$PORT" -a -p "$BRIDGE_PID" -n -P 2>/dev/null \
  | grep ESTABLISHED | head -1 || true)
if [[ -z "$CONN_LINE" ]]; then
  echo "ERROR: Bridge has no ESTABLISHED connection to port $PORT"
  lsof -i TCP -a -p "$BRIDGE_PID" -n -P 2>/dev/null || true
  exit 1
fi
echo "Connection: $CONN_LINE"

LOCAL_PORT=$(echo "$CONN_LINE" | awk '{print $9}' | sed 's/.*://')
echo "Bridge local port: $LOCAL_PORT"

# Block this connection with pf (silent drop, no RST)
ANCHOR="tianshu_stale_repro"
RULES="block drop quick proto tcp from any port $LOCAL_PORT to any port $PORT
block drop quick proto tcp from any port $PORT to any port $LOCAL_PORT"

echo ""
echo "Blocking connection with pf..."
echo "$RULES" | pfctl -a "$ANCHOR" -f - 2>/dev/null
pfctl -e 2>/dev/null || true
echo "BLOCKED. Server will NOT see a close event."
echo ""
echo "Timeline:"
echo "  Now     : bridge WS is silently dead"
echo "  +20s    : bridge heartbeat re-register fails (send buffers, no ACK)"
echo "  +60s    : bridge detects dead link, terminates, reconnects"
echo "  +60-80s : bridge reconnects on NEW socket, re-registers"
echo ""
echo "Test now: send a message that triggers a bridge tool call."
echo "  - WITHOUT fix: agent says 'not connected' (dead socket in registry)"
echo "  - WITH fix: first call fails, marks stale, retry waits for reconnect"
echo ""
echo "Press Enter to unblock and clean up..."
read -r

echo "Unblocking..."
pfctl -a "$ANCHOR" -F all 2>/dev/null
echo "Done. Bridge should reconnect within seconds."
