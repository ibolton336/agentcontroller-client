#!/usr/bin/env bash
# The auth probe matrix against the agentic surface, with AUTH_REQUIRED=true.
#
#   hack/hub-auth-up.sh && hack/hub-auth-probe.sh
#
# What it asserts is the AUTH OUTCOME, not an exact status code:
#   401  -> unauthenticated (no/invalid credentials, or a bad/spent nonce)
#   403  -> authenticated but scope not granted ("Required scope not granted")
#   pass -> got past auth; 200/201/400/404/503 are all "auth said yes"
# That distinction is the point. A 400 from a drifted request body still
# proves the scope check passed, so this keeps reporting the truth when the
# payload shape changes underneath it. Every line prints the real code.
#
# Role probing goes through SERVICE ACCOUNTS, not users: POST /auth/tokens
# only self-issues for the caller's own subject, so you cannot mint an
# architect token as admin that way. Mint an SA per role and use
# POST /serviceaccounts/:id/tokens.
#
# Known trap, pre-existing on hub main (tackle2-hub#1124): POST
# /serviceaccounts with a role referenced BY NAME nil-derefs in auth/cache
# addSaScopes and 500s. Role refs must carry the numeric ID.
#
# HARNESS_SA_WORKAROUND=0 disables the blocker-2 workaround (see below).
set -uo pipefail

HUB="${HUB:-http://localhost:18080}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HARNESS_SA_WORKAROUND="${HARNESS_SA_WORKAROUND:-1}"
BODY=/tmp/hub-auth-probe.body

# Seeded role IDs: admin(1) architect(2) migrator(3) project-manager(4) addon(100)
ROLE_ARCHITECT=2
ROLE_MIGRATOR=3
ROLE_PM=4
ROLE_ADDON=100

pass=0; fail=0; skip=0
red() { printf '\033[31m%s\033[0m' "$*"; }
grn() { printf '\033[32m%s\033[0m' "$*"; }
yel() { printf '\033[33m%s\033[0m' "$*"; }
note() { printf '      %s\n' "$*"; }
body1() { [ -s "$BODY" ] && head -c 160 "$BODY" | tr '\n' ' ' || true; }

# code <token> <method> <path> [body]  -> prints the HTTP status (000 = no answer)
code() {
  local tok="$1" method="$2" path="$3" body="${4:-}" got
  local args=(-sS -o "$BODY" -w '%{http_code}' -X "$method" "$HUB$path")
  [ -n "$tok" ] && args+=(-H "Authorization: Bearer $tok")
  [ -n "$body" ] && args+=(-H 'Content-Type: application/json' -d "$body")
  : >"$BODY"
  got="$(curl "${args[@]}" 2>/dev/null)" || got=""
  echo "${got:-000}"
}

# A real upgrade attempt, not a bare GET — without these headers the request
# may be rejected before the nonce is ever checked, which would make the
# WS legs assert nothing.
ws_code() {
  local got
  : >"$BODY"
  got="$(curl -sS -o "$BODY" -w '%{http_code}' \
    -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
    -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
    "$HUB$1" 2>/dev/null)" || got=""
  echo "${got:-000}"
}

judge() {
  local label="$1" expect="$2" got="$3" outcome="pass"
  case "$got" in 401|403|000) outcome="$got" ;; esac
  if [ "$outcome" = "$expect" ]; then
    printf '  %s %-50s %s\n' "$(grn ✓)" "$label" "$got"; pass=$((pass+1))
  else
    printf '  %s %-50s %s (wanted %s)\n' "$(red ✗)" "$label" "$got" "$expect"; fail=$((fail+1))
    [ -n "$(body1)" ] && note "$(body1)"
  fi
}
# probe <label> <expect:401|403|pass> <token> <method> <path> [body]
probe()    { local l="$1" e="$2"; shift 2; judge "$l" "$e" "$(code "$@")"; }
# ws_probe <label> <expect> <path>
ws_probe() { judge "$1" "$2" "$(ws_code "$3")"; }
skipped()  { printf '  %s %-50s %s\n' "$(yel −)" "$1" "$2"; skip=$((skip+1)); }

json() { python3 -c "import sys,json
try: d=json.load(open('$BODY'))
except Exception: sys.exit(0)
$1" 2>/dev/null || true; }

# mint_sa <name> <role-id>  -> token on stdout, empty on failure
mint_sa() {
  local name="$1" role="$2" id
  code "$ADMIN" POST /serviceaccounts "{\"name\":\"$name\",\"roles\":[{\"id\":$role}]}" >/dev/null
  id="$(json 'print(d.get("id",""))')"
  [ -n "$id" ] || return 0
  code "$ADMIN" POST "/serviceaccounts/$id/tokens" '{}' >/dev/null
  json 'print(d.get("token") or d.get("access_token") or "")'
}

printf '\n\033[1mUnauthenticated — everything must 401\033[0m\n'
probe "GET  /agentic/agents"                     401 "" GET  /agentic/agents
probe "GET  /agentic/gateways"                   401 "" GET  /agentic/gateways
probe "POST /agentic/agentruns"                  401 "" POST /agentic/agentruns '{}'
probe "POST /agentic/agentruns/x/acp/nonce"      401 "" POST /agentic/agentruns/x/acp/nonce '{}'
# The WS route sits outside the bearer middleware on purpose (browsers can't
# set headers on an upgrade); the nonce IS its auth, so no nonce must 401.
ws_probe "WS   dial with no nonce"               401 "/agentic/agentruns/x/acp"

printf '\n\033[1mAdmin — wildcard role, everything must get past auth\033[0m\n'
ADMIN="$(HUB="$HUB" "$ROOT/hack/hub-auth-login.sh" 2>/tmp/hub-auth-probe.login || true)"
if [ -z "$ADMIN" ]; then
  echo "  $(red "could not log in as admin"): $(cat /tmp/hub-auth-probe.login)" >&2
  exit 1
fi
probe "GET  /agentic/agents"    pass "$ADMIN" GET /agentic/agents
probe "GET  /agentic/gateways"  pass "$ADMIN" GET /agentic/gateways
probe "GET  /agentic/workflows" pass "$ADMIN" GET /agentic/workflows
probe "GET  /agentic/agentruns" pass "$ADMIN" GET /agentic/agentruns

# The create body is the AgentRun CR itself (the hub binds the CR type
# directly). agentRef is the only required field; nothing checks that the
# Agent exists because there is no controller on this rig.
RUN_NAME_WANTED="probe-run-$$"
# (Built in two steps: a `}` inside a ${var:-default} ends the expansion
# early in bash, which silently truncates JSON defaults.)
DEFAULT_RUN_BODY='{"apiVersion":"konveyor.io/v1alpha1","kind":"AgentRun","metadata":{"name":"'"$RUN_NAME_WANTED"'"},"spec":{"agentRef":"probe-agent"}}'
RUN_BODY="${RUN_BODY:-$DEFAULT_RUN_BODY}"

# Run-create is also the canary for the agentic.harness SA seed mismatch:
# auth passes, then token minting 404s "SA (agentic.harness) not-found".
# The workaround below leaves its SA in the hub DB until the next
# hub-auth-up.sh (which reseeds), so say so if a previous run planted it —
# otherwise a re-run reads as "seed fixed".
WORKAROUND_DESC="rig workaround for the seed rename"
code "$ADMIN" GET /serviceaccounts >/dev/null
if [ -n "$(json 'print(next((s for s in d if s.get("name")=="agentic.harness" and s.get("description")=="'"$WORKAROUND_DESC"'"),""))')" ]; then
  note "$(yel "blocker 2 is MASKED: agentic.harness SA was planted by an earlier probe run — re-run hack/hub-auth-up.sh to reseed and re-test the seed")"
fi
got="$(code "$ADMIN" POST /agentic/agentruns "$RUN_BODY")"
if grep -q 'agentic.harness' "$BODY" 2>/dev/null; then
  judge "POST /agentic/agentruns" pass "$got"
  note "$(yel "blocker 2 LIVE: agentic.harness SA missing — seed still ships agent.harness")"
  if [ "$HARNESS_SA_WORKAROUND" = "1" ]; then
    # Do what ROKS did by hand: give the hub the SA it looks up, with the
    # addon role the seed intends, so the ACP legs below can still run.
    # This is a rig-only workaround and it says so; the seed is still wrong.
    code "$ADMIN" POST /serviceaccounts "{\"name\":\"agentic.harness\",\"description\":\"$WORKAROUND_DESC\",\"roles\":[{\"id\":$ROLE_ADDON}]}" >/dev/null
    got="$(code "$ADMIN" POST /agentic/agentruns "$RUN_BODY")"
    judge "POST /agentic/agentruns (after creating agentic.harness SA)" pass "$got"
    note "$(yel "worked around on the rig only (HARNESS_SA_WORKAROUND=0 to disable)")"
  fi
else
  judge "POST /agentic/agentruns" pass "$got"
fi
RUN_NAME="$(json 'print((d.get("metadata") or {}).get("name") or d.get("name") or "")')"

if [ -n "$RUN_NAME" ]; then
  probe "POST .../$RUN_NAME/acp/nonce (mint)" pass "$ADMIN" POST "/agentic/agentruns/$RUN_NAME/acp/nonce" '{}'
  # The hub answers 201 with the JSON-encoded nonce string itself.
  NONCE="$(json 'print(d if isinstance(d,str) else (d.get("nonce") or d.get("token") or ""))')"
  if [ -n "$NONCE" ]; then
    # A fresh nonce must get past auth. On this inert rig that surfaces as
    # 503 (nothing to relay to) — which is a pass, not a rejection.
    ws_probe "WS   dial with a fresh nonce"       pass "/agentic/agentruns/$RUN_NAME/acp?nonce=$NONCE"
    # Single-use by design, 30s TTL. The second redemption must be rejected.
    ws_probe "WS   dial reusing a spent nonce"    401  "/agentic/agentruns/$RUN_NAME/acp?nonce=$NONCE"
  else
    skipped "WS   dial with a fresh nonce"        "no nonce returned: $(body1)"
    skipped "WS   dial reusing a spent nonce"     "no nonce returned"
  fi
  # The minted agentic-run-* token Secret should be in the namespace, owned
  # by the run, and go away with it (hub#1119 e8b8d1e). Only checkable from
  # outside the API — best effort, needs the profile's kubectl context.
  K="kubectl --context ${PROFILE:-hub-auth} -n konveyor-agents"
  owned_secret() { $K get secret -o json 2>/dev/null | python3 -c 'import sys,json
for s in json.load(sys.stdin)["items"]:
  if any(o.get("kind")=="AgentRun" and o.get("name")==sys.argv[1] for o in s["metadata"].get("ownerReferences") or []): print(s["metadata"]["name"])' "$1" 2>/dev/null; }
  if command -v kubectl >/dev/null && $K get agentrun "$RUN_NAME" >/dev/null 2>&1; then
    SECRET="$(owned_secret "$RUN_NAME" | head -1)"
    if [ -n "$SECRET" ]; then
      note "AgentRun $RUN_NAME + token Secret $SECRET (ownerRef → run) are in konveyor-agents"
    else
      note "$(yel "AgentRun $RUN_NAME exists but no token Secret owned by it was found")"
    fi
    # Clean up after ourselves. The hub has no DELETE route for agentruns
    # (a3af8307c and #1119 head alike — runs are create-only through the
    # API), so a 404 here is the router, not auth; delete through the
    # apiserver instead and use that to check the token Secret follows its
    # run — it only does when the ownerRef carries the full GVK
    # (hub#1119 e8b8d1e; a bare "v1alpha1" is invisible to the k8s GC).
    got="$(code "$ADMIN" DELETE "/agentic/agentruns/$RUN_NAME")"
    if [ "$got" = "404" ]; then
      note "no DELETE route for agentruns on this hub — runs are create-only via the API; deleting the CR with kubectl"
      $K delete agentrun "$RUN_NAME" --wait=false >/dev/null 2>&1 || true
    else
      judge "DELETE /agentic/agentruns/$RUN_NAME" pass "$got"
    fi
    if [ -n "$SECRET" ]; then
      for _ in 1 2 3 4 5 6 7 8 9 10; do $K get secret "$SECRET" >/dev/null 2>&1 || break; sleep 1; done
      if $K get secret "$SECRET" >/dev/null 2>&1; then
        note "$(yel "token Secret $SECRET survived the run delete — not GC'd (ownerRef apiVersion bare? fixed in #1119 e8b8d1e); removing it")"
        $K delete secret "$SECRET" --wait=false >/dev/null 2>&1 || true
      else
        note "token Secret $SECRET went with the run (ownerRef GC works)"
      fi
    fi
  fi
else
  skipped "POST .../acp/nonce (mint)"             "no AgentRun created — see run-create above"
  skipped "WS   dial with a fresh nonce"          "no AgentRun created"
  skipped "WS   dial reusing a spent nonce"       "no AgentRun created"
fi

printf '\n\033[1mArchitect — authoring split (hub#1119 finding (d))\033[0m\n'
ARCH="$(mint_sa "probe-architect-$$" "$ROLE_ARCHITECT")"
if [ -n "$ARCH" ]; then
  got="$(code "$ARCH" GET /agentic/agents)"
  judge "GET  /agentic/agents" pass "$got"
  # Stock roles shipped with zero agentic scopes until #1119's 8d62107
  # "update roles"; on an image from before that, every non-admin call 403s
  # and the whole console is admin-only. Name it rather than fail quietly.
  [ "$got" = "403" ] && note "$(yel "blocker 1 LIVE: architect has no agentic scopes — image predates #1119 8d62107; expect the rest of this section to 403")"
  probe "POST /agentic/agents"     403  "$ARCH" POST /agentic/agents '{"metadata":{"name":"probe"}}'
  probe "POST /agentic/gateways"   403  "$ARCH" POST /agentic/gateways '{"metadata":{"name":"probe"}}'
  probe "POST /agentic/workflows"  pass "$ARCH" POST /agentic/workflows '{"metadata":{"name":"probe"}}'
else
  for l in "GET  /agentic/agents" "POST /agentic/agents" "POST /agentic/gateways" "POST /agentic/workflows"; do
    skipped "$l" "architect SA mint failed: $(body1)"
  done
fi

printf '\n\033[1mMigrator / project-manager — ACP grant split\033[0m\n'
MIG="$(mint_sa "probe-migrator-$$" "$ROLE_MIGRATOR")"
PM="$(mint_sa "probe-pm-$$" "$ROLE_PM")"
NONCE_PATH="/agentic/agentruns/${RUN_NAME:-x}/acp/nonce"
if [ -n "$MIG" ]; then
  probe "GET  /agentic/agents (migrator)"  pass "$MIG" GET  /agentic/agents
  probe "POST acp/nonce (migrator)"        pass "$MIG" POST "$NONCE_PATH" '{}'
else
  skipped "GET  /agentic/agents (migrator)" "SA mint failed: $(body1)"
  skipped "POST acp/nonce (migrator)"       "SA mint failed"
fi
if [ -n "$PM" ]; then
  # PM holds agentic.agentruns.acp:get, but the only ACP entry point is this
  # POST — so the grant is inert and this must 403 until watch/steer split.
  probe "POST acp/nonce (project-manager)" 403 "$PM" POST "$NONCE_PATH" '{}'
else
  skipped "POST acp/nonce (project-manager)" "SA mint failed: $(body1)"
fi

printf '\n\033[1m%s\033[0m\n' "$pass passed, $fail failed, $skip skipped"
[ "$fail" -eq 0 ]
