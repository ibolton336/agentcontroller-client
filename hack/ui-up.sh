#!/usr/bin/env bash
# Put the tackle2-ui agent-runs console in front of the rig's hub. No shim:
# the console talks to the real hub's /agentic/* surface through its own
# /hub proxy, exactly as it does on the ROKS demo cluster.
#
#   hack/hub-auth-up.sh      # the hub (auth on by default)
#   hack/ui-up.sh            # this — console on http://localhost:18081
#   hack/hub-auth-down.sh    # stops both port-forwards
#
#   UI_IMAGE=ghcr.io/ibolton336/tackle2-ui:demo hack/ui-up.sh   # moving tag instead of the pin
#   UI_LOCAL_PORT=18081                                          # must match what hub-auth-up.sh registered
#
# Idempotent; re-running rolls the UI pod. Never touches any cluster but
# its own profile.
set -euo pipefail

PROFILE="${PROFILE:-hub-auth}"
NS=konveyor-agents
UI_LOCAL_PORT="${UI_LOCAL_PORT:-18081}"
# feature/agent-runs @ 7787852 — the build the ROKS demo runs (multi-arch).
# See docs/tackle2-ui-real-hub-handoff.md for what is in it.
UI_IMAGE="${UI_IMAGE:-ghcr.io/ibolton336/tackle2-ui@sha256:19a151a0a640f9be4c9bc4a64b9e7cb31d7b50fe682c3c99de1c084a6a3a40d0}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PF_PID_FILE="/tmp/hub-auth-rig-ui-portforward.pid"
PF_LOG="/tmp/hub-auth-rig-ui-portforward.log"

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }

k() { kubectl --context "$PROFILE" "$@"; }

step "Hub on profile $PROFILE"
k -n "$NS" get deploy/tackle-hub >/dev/null 2>&1 \
  || die "no hub on profile $PROFILE — run hack/hub-auth-up.sh first"
# The pair must agree on auth, and the hub's IdpClient must already list
# this UI's origin (hub-auth-up.sh registers http://localhost:$UI_LOCAL_PORT).
AUTH_REQUIRED="$(k -n "$NS" get deploy/tackle-hub \
  -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="AUTH_REQUIRED")].value}')"
AUTH_REQUIRED="${AUTH_REQUIRED:-false}"
ok "hub runs AUTH_REQUIRED=$AUTH_REQUIRED"
if [ "$AUTH_REQUIRED" = "true" ] && \
   ! k -n "$NS" get idpclient web-ui -o jsonpath='{.spec.redirectURIs}' 2>/dev/null \
     | grep -q "http://localhost:$UI_LOCAL_PORT\""; then
  warn "IdpClient web-ui does not list http://localhost:$UI_LOCAL_PORT — re-run hack/hub-auth-up.sh with UI_LOCAL_PORT=$UI_LOCAL_PORT or login will 400"
fi

step "Console"
sed -e "s|UI_IMAGE_PLACEHOLDER|${UI_IMAGE}|" \
    -e "s|AUTH_REQUIRED_PLACEHOLDER|${AUTH_REQUIRED}|" \
    -e "s|UI_ORIGIN_PLACEHOLDER|http://localhost:${UI_LOCAL_PORT}|" \
    "$ROOT/hack/ui-rig.yaml" | k apply -f - >/dev/null
ok "applied (image ${UI_IMAGE##*/}, AUTH_REQUIRED=${AUTH_REQUIRED})"
k -n "$NS" rollout restart deploy/tackle2-ui >/dev/null
k -n "$NS" rollout status deploy/tackle2-ui --timeout=300s >/dev/null \
  || die "console did not become ready — k -n $NS logs deploy/tackle2-ui"
ok "console rolled out"

step "Port-forward :$UI_LOCAL_PORT"
if [ -f "$PF_PID_FILE" ] && kill -0 "$(cat "$PF_PID_FILE")" 2>/dev/null; then
  ok "already forwarding (pid $(cat "$PF_PID_FILE"))"
else
  (
    while true; do
      kubectl --context "$PROFILE" -n "$NS" port-forward svc/tackle2-ui \
        "$UI_LOCAL_PORT:8080" >>"$PF_LOG" 2>&1 || true
      sleep 1
    done
  ) </dev/null >/dev/null 2>&1 &
  echo $! >"$PF_PID_FILE"
  ok "forwarding on http://localhost:$UI_LOCAL_PORT (loop pid $(cat "$PF_PID_FILE"), log $PF_LOG)"
fi
for _ in $(seq 1 30); do
  code="$(curl -sS -o /dev/null -w '%{http_code}' "http://localhost:$UI_LOCAL_PORT/" 2>/dev/null || true)"
  [ -n "$code" ] && [ "$code" != "000" ] && break
  sleep 1
done
[ "$code" = "200" ] || die "console not answering 200 on :$UI_LOCAL_PORT (got '${code:-nothing}') — see $PF_LOG"
ok "console answers on :$UI_LOCAL_PORT"
# The console proxies /hub to the hub; prove the pair is wired before
# anyone opens a browser. With auth on, an anonymous JSON call is a 401
# (the proxy rewrites non-JSON 401s to a redirect, hence the Accept header).
hub_code="$(curl -sS -o /dev/null -w '%{http_code}' -H 'Accept: application/json' "http://localhost:$UI_LOCAL_PORT/hub/agentic/agents" 2>/dev/null || true)"
case "$AUTH_REQUIRED:$hub_code" in
  true:401)  ok "console → hub proxy works (/hub/agentic/agents = 401 anonymous, auth on)" ;;
  false:200) ok "console → hub proxy works (/hub/agentic/agents = 200, auth off)" ;;
  *) warn "console → hub proxy answered $hub_code for /hub/agentic/agents (AUTH_REQUIRED=$AUTH_REQUIRED)" ;;
esac

step "Ready"
cat <<EOF
  Console:  http://localhost:$UI_LOCAL_PORT
  Login:    admin / admin      (only when AUTH_REQUIRED=true)
  Agentic:  left nav → Agents / Agent runs / Workflows … (AGENTIC_ENABLED=true)
  Hub API:  http://localhost:${HUB_LOCAL_PORT:-18080}   (same hub, direct)

  Seed something to look at:  kubectl --context $PROFILE apply -f manifests/samples.yaml
EOF
