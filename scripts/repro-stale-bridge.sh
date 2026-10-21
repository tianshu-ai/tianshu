#!/bin/bash
# Reproduce stale bridge connection issue on macOS.
#
# Two modes:
#   freeze  — SIGSTOP the bridge process so it stops responding.
#             Server socket stays open but bridge never replies.
#             Simulates a hung/frozen connection.
#   drop    — Use pfctl to silently drop packets (true half-open).
#             Requires pfctl to be functional on your macOS version.
#
# Usage:
#   sudo ./scripts/repro-stale-bridge.sh              # default: freeze
#   sudo ./scripts/repro-stale-bridge.sh freeze        # freeze bridge process
#   sudo ./scripts/repro-stale-bridge.sh drop          # pfctl packet drop

set -euo pipefail

MODE="${1:-freeze}"

echo "=== Stale Bridge Connection Reproducer (mode: $MODE) ==="
echo ""

# Find bridge processes
BRIDGE_PIDS=$(pgrep -f 'bridge/index\.js' 2>/dev/null || true)
if [[ -z "$BRIDGE_PIDS" ]]; then
  BRIDGE_PIDS=$(pgrep -f 'local-bridge' 2>/dev/null || true)
fi
if [[ -z "$BRIDGE_PIDS" ]]; then
  echo "ERROR: No bridge process found."
  echo "Running processes with 'bridge':"
  ps aux | grep -i bridge | grep -v grep || true
  exit 1
fi

echo "Bridge PIDs: $BRIDGE_PIDS"

if [[ "$MODE" == "freeze" ]]; then
  # ── FREEZE MODE ──
  # SIGSTOP suspends the process. It can't read/write the socket.
  # Server side: socket stays open, but bridge never replies to
  # heartbeats or tool calls → eventually times out.
  # This is the simplest and most reliable repro.

  for pid in $BRIDGE_PIDS; do
    CMD=$(ps -o command= -p "$pid" 2>/dev/null | head -c 80)
    echo "  Freezing PID $pid: $CMD"
    kill -STOP "$pid"
  done

  echo ""
  echo "✅ Bridge process(es) FROZEN (SIGSTOP)."
  echo ""
  echo "What happens now:"
  echo "  - Server socket is still open, but bridge can't reply"
  echo "  - Agent tool calls will timeout (default 60s)"
  echo "  - Bridge heartbeat can't fire → server won't get re-register"
  echo ""
  echo "Test: send a message that uses a bridge tool."
  echo "  WITHOUT fix: timeout, then retry hits same dead conn"
  echo "  WITH fix:    timeout marks stale, retry waits for reconnect"
  echo ""
  echo "Press Enter to UNFREEZE..."
  read -r

  for pid in $BRIDGE_PIDS; do
    kill -CONT "$pid" 2>/dev/null || true
    echo "  Resumed PID $pid"
  done
  echo "✅ Bridge unfrozen. Should resume normal operation."

elif [[ "$MODE" == "drop" ]]; then
  # ── DROP MODE ──
  # pfctl silently drops packets. Needs sudo + pfctl enabled.

  if [[ $EUID -ne 0 ]]; then
    echo "Drop mode needs sudo. Run: sudo $0 drop"
    exit 1
  fi

  # Find TCP connections
  CONNS=""
  for pid in $BRIDGE_PIDS; do
    lines=$(lsof -i TCP -a -p "$pid" -n -P 2>/dev/null | grep ESTABLISHED || true)
    if [[ -n "$lines" ]]; then
      CONNS+="$lines"$'\n'
    fi
  done

  if [[ -z "$CONNS" ]]; then
    echo "ERROR: No ESTABLISHED TCP connections from bridge."
    exit 1
  fi

  echo "Bridge connections:"
  echo "$CONNS" | grep -v '^$' | cat -n
  echo ""

  CONN_COUNT=$(echo "$CONNS" | grep -v '^$' | wc -l | tr -d ' ')
  if [[ "$CONN_COUNT" -gt 1 ]]; then
    echo -n "Pick connection # to block [1]: "
    read -r PICK
    PICK="${PICK:-1}"
  else
    PICK=1
  fi

  CONN_LINE=$(echo "$CONNS" | grep -v '^$' | sed -n "${PICK}p")
  ADDR_PAIR=$(echo "$CONN_LINE" | awk '{print $9}')
  LOCAL_PORT=$(echo "$ADDR_PAIR" | cut -d'>' -f1 | sed 's/.*://' | sed 's/-$//')
  REMOTE_PORT=$(echo "$ADDR_PAIR" | cut -d'>' -f2 | sed 's/.*://')

  ANCHOR="tianshu_stale_repro"
  RULES="block drop quick proto tcp from any port $LOCAL_PORT to any port $REMOTE_PORT
block drop quick proto tcp from any port $REMOTE_PORT to any port $LOCAL_PORT"

  echo "Blocking local:$LOCAL_PORT <-> remote:$REMOTE_PORT..."
  echo "$RULES" | pfctl -a "$ANCHOR" -f - 2>/dev/null
  pfctl -e 2>/dev/null || true

  echo "✅ BLOCKED."
  echo ""
  echo "Press Enter to unblock..."
  read -r

  pfctl -a "$ANCHOR" -F all 2>/dev/null
  echo "✅ Unblocked."

else
  echo "Unknown mode: $MODE (use 'freeze' or 'drop')"
  exit 1
fi
