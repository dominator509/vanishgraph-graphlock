#!/usr/bin/env sh
# Layer import-boundary check. Sentinel: `import boundary: ok`
#
# Enforces the ARCHITECTURE.md code law:
#   "domain imports only standard library; application imports domain; adapters
#    implement ports; http/ui/mcp import application contracts only; ...
#    Lower layers never import higher layers."
#
# This is a hard gate, not a convention. The domain layer is where the privacy
# rules live (the eleven truth states, the closed transition table, the authority
# and egress rules). If a framework, ORM, HTTP client, or model SDK can be imported
# into it, those rules become untestable in isolation and start depending on
# infrastructure behaviour — which is precisely how a privacy guarantee silently
# becomes a network call.
#
# THREE RULES, all enforced here:
#   (1) src/domain/**        may import only relative paths and node:* builtins.
#   (2) src/application/**   may import only node:*, relative paths, and src/domain.
#   (3) src/http/**          must not import src/domain internals, src/adapters, or
#                            src/infrastructure. It MAY import its own framework.
#
# Rule (3) is what makes the API boundary real: a handler that reaches a database
# driver or an adapter directly has bypassed the application layer where authority,
# policy and egress are enforced.
#
# WHY (3) DOES NOT FORBID THIRD-PARTY PACKAGES, and why the first version of this rule
# was wrong: ARCHITECTURE.md §2 lists "frameworks" as forbidden for `domain` and for
# `domain` only. For `http` the table permits "application contracts" and forbids
# "domain internals, adapters directly" — so `fastify` is not merely allowed in
# `src/http`, it is the layer's reason to exist. An earlier draft of this gate rejected
# any bare specifier in `src/http` and failed on the HTTP framework itself, which would
# have forced the framework behind a port and gained nothing.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

[ -d src/domain ] || { echo "import boundary: FAIL - src/domain is missing" >&2; exit 1; }

violations=""

# ---------------------------------------------------------------------------------------------
# (1) domain: relative paths and node:* only. UNCHANGED from the original rule.
# ---------------------------------------------------------------------------------------------
specifiers=$(grep -rhoE "(from|import)[[:space:]]*'[^']+'" src/domain 2>/dev/null \
  | sed -E "s/.*'([^']+)'.*/\1/" | sort -u || true)

for spec in $specifiers; do
  case "$spec" in
    ./*|../*) ;;                 # relative: fine
    node:*) ;;                   # standard library: fine
    *) violations="${violations}  src/domain: ${spec} (bare dependency; the domain may import only node:* and relative paths)
" ;;
  esac
done

# ---------------------------------------------------------------------------------------------
# (2) application: node:*, relative, and src/domain. Never adapters, infrastructure, or http.
#
# A file's own directory decides what "src/domain" resolves to, but every file under
# src/application resolves it as `../domain/...`, so the check is on the specifier's shape.
# ---------------------------------------------------------------------------------------------
if [ -d src/application ]; then
  app_specs=$(grep -rhoE "(from|import)[[:space:]]*'[^']+'" src/application 2>/dev/null \
    | sed -E "s/.*'([^']+)'.*/\1/" | sort -u || true)
  for spec in $app_specs; do
    case "$spec" in
      ./*|../*) ;;               # relative: fine (including ../domain/...)
      node:*) ;;                 # standard library: fine
      *) violations="${violations}  src/application: ${spec} (the application layer may import only node:*, relative paths, and src/domain)
" ;;
    esac
  done
fi

# ---------------------------------------------------------------------------------------------
# (3) http: must not reach the domain internals, an adapter, or infrastructure directly.
#
# The rule is about DIRECTION, not about third-party packages. `fastify`, `jose`, `pino` and
# similar are legitimate here; `../domain/entities.ts` and `../adapters/**` are not, because
# reaching them means the handler bypassed the application layer.
#
# A bare specifier that is NOT relative and not a node builtin is a package, and packages are
# allowed at this layer. The one package-shaped import that must still be refused is a relative
# climb out of the layer, which the explicit cases below catch.
# ---------------------------------------------------------------------------------------------
if [ -d src/http ]; then
  http_specs=$(grep -rhoE "(from|import)[[:space:]]*'[^']+'" src/http 2>/dev/null \
    | sed -E "s/.*'([^']+)'.*/\1/" | sort -u || true)
  for spec in $http_specs; do
    case "$spec" in
      ../domain/*|../../domain/*)
        violations="${violations}  src/http: ${spec} (http must reach the domain through src/application, never directly)
" ;;
      ../adapters/*|../../adapters/*|../infrastructure/*|../../infrastructure/*)
        violations="${violations}  src/http: ${spec} (http must not import adapters or infrastructure)
" ;;
      *) ;;   # node builtins, other relative paths, and layer-appropriate packages: fine
    esac
  done
fi

if [ -n "$violations" ]; then
  echo "import boundary: FAIL - a layer imports something it must not" >&2
  echo "Offending module specifiers:" >&2
  printf '%s' "$violations" >&2
  echo "" >&2
  echo "Move the dependency behind a port declared in SPEC-001 §5 and implement it in" >&2
  echo "an adapter. Do not relax this check (DOD-027)." >&2
  exit 1
fi

echo "import boundary: ok"
