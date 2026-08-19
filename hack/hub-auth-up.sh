#!/usr/bin/env bash
# Stand up the auth-ON hub rig on a disposable minikube profile.
# Idempotent — safe to re-run; re-running rolls the hub pod, which reseeds
# the emptyDir DB (that is how you test a seed change in ~1 rollout).
#
#   hack/hub-auth-up.sh                     # ghcr image, default profile
#   HUB_IMAGE=localhost/tackle2-hub:dev \
#     HUB_LOCAL_BUILD=1 hack/hub-auth-up.sh # image built into the profile daemon
#   hack/hub-auth-down.sh                   # stop the port-forward
#   minikube delete -p hub-auth             # reclaim everything
#
# Never touches any cluster but its own profile, and never changes the
# caller's current kubectl context (minikube start --keep-context).
# Fresh profile → serving hub is ~40 s plus the image pull.
#
# To test a hub branch, the fast loop (~6 min, no registry round-trip):
#   cd <tackle2-hub checkout> && git checkout <branch>
#   eval "$(minikube -p hub-auth docker-env)"
#   docker build -t localhost/tackle2-hub:dev .
#   HUB_IMAGE=localhost/tackle2-hub:dev HUB_LOCAL_BUILD=1 hack/hub-auth-up.sh
set -euo pipefail

PROFILE="${PROFILE:-hub-auth}"
NS=konveyor-agents
# Default = the multi-arch build of jortel a3af8307c (nonce-era, the same
# content ROKS runs) pushed by .github/workflows/build-hub.yml.
HUB_IMAGE="${HUB_IMAGE:-ghcr.io/ibolton336/tackle2-hub:agentic}"
HUB_LOCAL_BUILD="${HUB_LOCAL_BUILD:-0}"
HUB_LOCAL_PORT="${HUB_LOCAL_PORT:-18080}"
# AUTH_REQUIRED=false for a console-only stack (no login, no scopes).
AUTH_REQUIRED="${AUTH_REQUIRED:-true}"
# Browser origins the OIDC client must accept, see the IdpClient note in
# hub-auth-rig.yaml. Keep in step with hack/ui-up.sh (UI_LOCAL_PORT) and
# the tackle2-ui dev server default (9000).
UI_LOCAL_PORT="${UI_LOCAL_PORT:-18081}"
UI_DEV_PORT="${UI_DEV_PORT:-9000}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Agentic CRDs: this repo's manifests/crd/ tracks upstream agentic-controller
# main, so the rig is self-contained. Set CRD_DIR to an agentic-controller
# checkout's config/crd/bases to test CRD changes from a branch.
CRD_DIR="${CRD_DIR:-$ROOT/manifests/crd}"
# The hub's own CRDs (idpclients, identityproviders, ... — 8 of them) come
# from the tackle operator bundle, pinned to a commit so the rig is
# reproducible. The hub exits at boot if idpclients/identityproviders/
# ldapproviders/schemas are missing; the rest keep its managers quiet.
TACKLE_OPERATOR_REF="${TACKLE_OPERATOR_REF:-d57baa682a96be8ae329914e6e44e5271bba44a4}"
TACKLE_CRD_BASE="https://raw.githubusercontent.com/konveyor/tackle2-operator/${TACKLE_OPERATOR_REF}/bundle/manifests"
TACKLE_CRDS="addons extensions identityproviders idpclients ldapproviders schemas tackles tasks"
PF_PID_FILE="/tmp/hub-auth-rig-portforward.pid"
PF_LOG="/tmp/hub-auth-rig-portforward.log"

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }

k() { kubectl --context "$PROFILE" "$@"; }

step "Profile $PROFILE"
docker info >/dev/null 2>&1 || die "docker daemon is not running — start Docker Desktop first"
if minikube -p "$PROFILE" status >/dev/null 2>&1; then
  ok "already running"
else
  # --keep-context: never hijack whatever kubectl context the caller had
  # active. Everything below addresses the profile by name.
  minikube start -p "$PROFILE" --keep-context >/dev/null
  ok "started"
fi

step "CRDs"
[ -d "$CRD_DIR" ] || die "no agentic CRDs at $CRD_DIR (set CRD_DIR)"
k apply -f "$CRD_DIR/" >/dev/null
ok "agentic CRDs applied from $CRD_DIR"
# The Gateway rename (upstream #100) replaced LLMProvider. A CRD set from
# before that still ships konveyor.io_llmproviders.yaml and no gateways CRD,
# which will not reproduce anything current — say so rather than fail later.
if ! k get crd gateways.konveyor.io >/dev/null 2>&1; then
  warn "no gateways.konveyor.io CRD — $CRD_DIR predates the Gateway rename (#100)"
fi
for c in $TACKLE_CRDS; do
  k apply -f "$TACKLE_CRD_BASE/tackle.konveyor.io_$c.yaml" >/dev/null \
    || die "could not apply tackle CRD $c from $TACKLE_CRD_BASE"
done
ok "tackle CRDs applied from tackle2-operator@${TACKLE_OPERATOR_REF:0:12}"
# The IdpClient in the rig manifest needs its CRD to be established first.
k wait --for=condition=Established crd/idpclients.tackle.konveyor.io --timeout=60s >/dev/null

step "Rig"
PULL_POLICY=IfNotPresent
[ "$HUB_LOCAL_BUILD" = "1" ] && PULL_POLICY=Never
sed -e "s|HUB_IMAGE_PLACEHOLDER|${HUB_IMAGE}|" \
    -e "s|PULL_POLICY_PLACEHOLDER|${PULL_POLICY}|" \
    -e "s|AUTH_REQUIRED_PLACEHOLDER|${AUTH_REQUIRED}|" \
    -e "s|UI_ORIGIN_PLACEHOLDER|http://localhost:${UI_LOCAL_PORT}|" \
    -e "s|UI_DEV_ORIGIN_PLACEHOLDER|http://localhost:${UI_DEV_PORT}|" \
    "$ROOT/hack/hub-auth-rig.yaml" | k apply -f - >/dev/null
ok "applied (image ${HUB_IMAGE}, pullPolicy ${PULL_POLICY}, AUTH_REQUIRED=${AUTH_REQUIRED})"

# Force a fresh pod so a rebuilt image or a seed change actually takes effect.
k -n "$NS" rollout restart deploy/tackle-hub >/dev/null
k -n "$NS" rollout status deploy/tackle-hub --timeout=180s >/dev/null \
  || die "hub did not become ready — k -n $NS logs deploy/tackle-hub"
ok "hub rolled out (DB reseeded)"

step "OIDC client"
# The builtin OIDC provider needs an IdpClient named web-ui; the rig
# manifest carries the operator's one verbatim, so this is a sanity check.
if k -n "$NS" get idpclient web-ui >/dev/null 2>&1; then
  ok "IdpClient web-ui present"
else
  die "IdpClient web-ui missing in $NS — the rig manifest should have created it"
fi

step "Port-forward :$HUB_LOCAL_PORT"
if [ -f "$PF_PID_FILE" ] && kill -0 "$(cat "$PF_PID_FILE")" 2>/dev/null; then
  ok "already forwarding (pid $(cat "$PF_PID_FILE"))"
else
  # kubectl port-forward exits the first time the pod side refuses or the
  # pod is replaced (which every re-run of this script does), so keep it in
  # a loop. The pid file holds the loop, not the current kubectl.
  (
    while true; do
      kubectl --context "$PROFILE" -n "$NS" port-forward svc/tackle-hub \
        "$HUB_LOCAL_PORT:8080" >>"$PF_LOG" 2>&1 || true
      sleep 1
    done
  ) </dev/null >/dev/null 2>&1 &
  echo $! >"$PF_PID_FILE"
  ok "forwarding on http://localhost:$HUB_LOCAL_PORT (loop pid $(cat "$PF_PID_FILE"), log $PF_LOG)"
fi
# Don't hand back a rig that isn't answering yet. Any HTTP status counts —
# with AUTH_REQUIRED the honest answer here is 401, without it 200.
for _ in $(seq 1 30); do
  code="$(curl -sS -o /dev/null -w '%{http_code}' "http://localhost:$HUB_LOCAL_PORT/agentic/agents" 2>/dev/null || true)"
  [ -n "$code" ] && [ "$code" != "000" ] && break
  sleep 1
done
case "$AUTH_REQUIRED:$code" in
  true:401)  ok "hub answers on :$HUB_LOCAL_PORT — unauthenticated GET /agentic/agents = 401 (auth is on)" ;;
  false:200) ok "hub answers on :$HUB_LOCAL_PORT — unauthenticated GET /agentic/agents = 200 (auth is off)" ;;
  *:""|*:000) die "hub not reachable on :$HUB_LOCAL_PORT after 30s — see $PF_LOG" ;;
  *) warn "hub answers $code unauthenticated with AUTH_REQUIRED=$AUTH_REQUIRED — unexpected" ;;
esac

step "Ready"
cat <<EOF
  Hub:      http://localhost:$HUB_LOCAL_PORT   (AUTH_REQUIRED=$AUTH_REQUIRED)
  Login:    admin / admin   (users.yaml seed)
  Token:    eval "\$(hack/hub-auth-login.sh --export)"
  Probe:    hack/hub-auth-probe.sh
  Console:  hack/ui-up.sh   (the tackle2-ui agent-runs console against this hub)
EOF
