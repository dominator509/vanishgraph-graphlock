#!/usr/bin/env sh
# Ledger append / query. POSIX sh.
#
# Format: <utc-iso> | <agent> | <node> | <event> | <detail>
#
# COMMANDS
#   append <agent> <node> <event> [detail]   append one event
#   status <node>                            DONE if the node has ever been closed
#   tail [n]                                 last n lines (default 30)
#
# WHY `status` WAS REWRITTEN.
#
# The original implementation was:
#
#   grep -E "\| $1 \|" $L | tail -1 | grep -q NODE_DONE && echo DONE || echo PENDING
#
# It inspected only the LAST event for a node. That means any event appended after a
# node's closure — a correction, a footnote, a re-run note — silently reopened the node.
# This actually happened: EP-001 was closed with a NODE_DONE event and then an
# EVIDENCE_INDEX_FIXED event was appended, after which `status EP-001` reported PENDING
# and `graph-next.sh` regressed to `NEXT EP-001`. The graph would have re-dispatched a
# finished node, and every subsequent node was exposed to the same corruption.
#
# Closure is a HISTORICAL FACT, not a property of the most recent line. A node is DONE
# if it has ever been closed, and it stays closed. Re-opening a node is therefore a
# deliberate act: `reopen <node> <reason>` appends an explicit event, so it can never
# happen by accident.
set -eu
L=.agent/state/LEDGER.md

cmd=${1:-}
shift || true

case $cmd in
  append)
    node=${2:-}
    event=${3:-}
    [ -n "${1:-}" ] || { echo "ledger: append requires <agent> <node> <event> [detail]" >&2; exit 2; }
    [ -n "$node" ] || { echo "ledger: append requires a node id" >&2; exit 2; }
    [ -n "$event" ] || { echo "ledger: append requires an event name" >&2; exit 2; }
    printf '%s | %s | %s | %s | %s\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$node" "$event" "${4:-}" >>"$L"
    ;;

  status)
    node=${1:-}
    [ -n "$node" ] || { echo "ledger: status requires a node id" >&2; exit 2; }
    [ -f "$L" ] || { echo PENDING; exit 0; }
    # Closed if a NODE_DONE exists for this node and no REOPEN was appended after the
    # last NODE_DONE for it.
    last_done=$(grep -nE "\| ${node} \| NODE_DONE \|" "$L" 2>/dev/null | tail -1 | cut -d: -f1 || true)
    if [ -z "$last_done" ]; then
      echo PENDING
    else
      last_reopen=$(grep -nE "\| ${node} \| REOPEN \|" "$L" 2>/dev/null | tail -1 | cut -d: -f1 || true)
      if [ -n "$last_reopen" ] && [ "$last_reopen" -gt "$last_done" ]; then
        echo PENDING
      else
        echo DONE
      fi
    fi
    ;;

  reopen)
    node=${1:-}
    reason=${2:-}
    [ -n "$node" ] || { echo "ledger: reopen requires a node id" >&2; exit 2; }
    [ -n "$reason" ] || { echo "ledger: reopen requires a reason" >&2; exit 2; }
    printf '%s | %s | %s | REOPEN | %s\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${AGENT_ID:-operator}" "$node" "$reason" >>"$L"
    echo "ledger: reopened $node - $reason"
    ;;

  tail)
    tail -n "${1:-30}" "$L"
    ;;

  *)
    echo "ledger: unknown command '${cmd}'" >&2
    echo "usage: ledger.sh append <agent> <node> <event> [detail]" >&2
    echo "       ledger.sh status <node>" >&2
    echo "       ledger.sh reopen <node> <reason>" >&2
    echo "       ledger.sh tail [n]" >&2
    exit 2
    ;;
esac
