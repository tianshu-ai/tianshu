#!/bin/bash
# Reproduce stale bridge connection issue on macOS.
#
# Finds the bridge process (Tianshu.app node sidecar running
# bridge/index.js), identifies its WS TCP connection, and uses
# pfctl to silently DROP packets — the server never gets a FIN/RST,
# creating a half-open socket.
#
# Usage:
#   sudo ./scripts/repro-stale-bridge.sh              # interactive pick
#   sudo ./scripts/repro-stale-bridge.sh localhost     # filter by server
#   sudo ./scripts/repro-stale-bridge.sh ai.jieheyun   # filter by server

set -euo pipefail

FILTER="${1:-}"

echo "=== Stale Bridge Connection Reproducer ==="
echo ""

if [[ $EUID -ne 0 ]]; then
  echo "Need sudo. Run: sudo $0 $*"
  exit 1
fi

# Find bridge processes (Tianshu.app node sidecar running bridge/index.js)
BRIDGE_PIDS=$(pgrep -f 'bridge/index\.js' || true)
if [[ -z "$BRIDGE_PIDS" ]]; then
  # Fallback: try local-bridge
  BRIDGE_PIDS=$(pgrep -f 'local-bridge' || true)
fi

if [[ -z "$BRIDGE_PIDS" ]]; then
  echo "ERROR: No bridge process found."
  echo "Looking for processes matching 'bridge/index.js'..."
  ps aux | grep -i bridge | grep -v grep || true
  exit 1
fi

echo "Bridge PIDs: $BRIDGE_PIDS"
echo ""

# Find all ESTABLISHED TCP connections from bridge processes
CONNS=""
for pid in $BRIDGE_PIDS; do
  lines=$(lsof -i TCP -a -p "$pid" -n -P 2>/dev/null | grep ESTABLISHED || true)
  if [[ -n "$lines" ]]; then
    CONNS+="$lines"$'\n'
  fi
done

if [[ -z "$CONNS" ]]; then
  echo "ERROR: No ESTABLISHED TCP connections from bridge processes."
  exit 1
fi

# Filter if requested
if [[ -n "$FILTER" ]]; then
  CONNS=$(echo "$CONNS" | grep "$FILTER" || true)
  if [[ -z "$CONNS" ]]; then
    echo "ERROR: No connections matching '$FILTER'."
    exit 1
  fi
fi

echo "Bridge connections:"
echo "$CONNS" | grep -v '^$' | cat -n
echo ""

# Let user pick if multiple
CONN_COUNT=$(echo "$CONNS" | grep -v '^$' | wc -l | tr -d ' ')
if [[ "$CONN_COUNT" -gt 1 ]]; then
  echo -n "Pick connection # to kill [1]: "
  read -r PICK
  PICK="${PICK:-1}"
else
  PICK=1
fi

CONN_LINE=$(echo "$CONNS" | grep -v '^$' | sed -n "${PICK}p")
echo "Target: $CONN_LINE"

# Extract local and remote ports
# lsof format: ... node PID user ... TCP localhost:LOCAL->host:REMOTE (ESTABLISHED)
ADDR_PAIR=$(echo "$CONN_LINE" | awk '{print $9}')
LOCAL_ADDR=$(echo "$ADDR_PAIR" | cut -d'>' -f1 | sed 's/-$//')
REMOTE_ADDR=$(echo "$ADDR_PAIR" | cut -d'>' -f2)
LOCAL_PORT=$(echo "$LOCAL_ADDR" | sed 's/.*://')
REMOTE_PORT=$(echo "$REMOTE_ADDR" | sed 's/.*://')

echo "Local port:  $LOCAL_PORT"
echo "Remote port: $REMOTE_PORT"
echo ""

# Block with pf (silent drop, no RST → half-open socket)
ANCHOR="tianshu_stale_repro"
RULES="block drop quick proto tcp from any port $LOCAL_PORT to any port $REMOTE_PORT
block drop quick proto tcp from any port $REMOTE_PORT to any port $LOCAL_PORT"

echo "Blocking connection with pfctl..."
echo "$RULES" | pfctl -a "$ANCHOR" -f - 2>/dev/null
pfctl -e 2>/dev/null || true

echo ""
echo "✅ BLOCKED. Server will NOT see a close event."
echo ""
echo "Timeline:"
echo "  Now      : bridge WS is silently dead (half-open)"
echo "  +20s     : bridge heartbeat re-register send buffers (no ACK)"
echo "  +60s     : bridge detects dead link, terminates, reconnects"
echo ""
echo "Test now: send a message that uses a bridge tool."
echo "  WITHOUT fix: 'not connected' (dead socket in registry)"
echo "  WITH fix:    first call marks stale, retry waits for reconnect"
echo ""
echo "Press Enter to unblock and clean up..."
read -r

echo "Unblocking..."
pfctl -a "$ANCHOR" -F all 2>/dev/null
echo "✅ Unblocked. Bridge should reconnect within seconds."
