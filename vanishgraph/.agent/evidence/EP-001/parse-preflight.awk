BEGIN { FS = "|" }
/^PREFLIGHT-TABLE-BEGIN$/ { inside = 1; next }
/^PREFLIGHT-TABLE-END$/   { inside = 0; next }
inside && NF {
  name = $1; lane = $2; probe = $3
  gsub(/^[ \t]+|[ \t]+$/, "", name)
  gsub(/^[ \t]+|[ \t]+$/, "", lane)
  gsub(/^[ \t]+|[ \t]+$/, "", probe)
  if (name != "") print name "|" lane "|" probe
}
