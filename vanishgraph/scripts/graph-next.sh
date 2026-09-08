#!/usr/bin/env sh
set -eu
awk '/^GRAPH-TABLE-BEGIN$/{x=1;next}/^GRAPH-TABLE-END$/{x=0}x&&$1=="NODE"{print $2,$4}' .agent/GRAPH.md >/tmp/vg
while read -r id deps;do st=$(sh scripts/ledger.sh status $id);[ "$st" = PENDING ]&&{ echo NEXT $id;exit;};done </tmp/vg
echo ALL_DONE
