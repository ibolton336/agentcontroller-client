#!/usr/bin/env bash
# The optional runs layer for the auth-ON hub rig: everything that turns
# console-created AgentRuns from Pending litter into pods that actually run.
#
#   hack/hub-auth-up.sh      # the hub (see the AgentRunCreate caveat below)
#   hack/ui-up.sh            # the console (also the gateway probe target)
#   hack/runs-up.sh          # this — controller + sandbox + Bedrock gateway
#
# Installs agentic-controller from deploy/roks/agentic-controller-install.yaml
# (current-main render, image ghcr.io/ibolton336/agentic-controller:demo —
# NOT quay.io/konveyor/agentic-controller:latest, which is stale: it predates
# the #149 gateway verify among much else) and Agent Sandbox v0.5.0, builds
# the aws-bedrock-creds secret from your local AWS identity, and applies
# manifests/goose-bedrock.yaml with two rig substitutions:
#
#   - Gateway spec.endpoint -> $GATEWAY_PROBE_URL (default: the console
#     service). The controller verifies a Gateway by curling
#     $endpoint/v1/models from a Job and only 2xx passes (#149); Bedrock
#     answers 403/404 there, so a real Bedrock endpoint can never verify.
#     The harness ignores spec.endpoint for aws-bedrock and derives the
#     endpoint from AWS_REGION, so any in-cluster 2xx URL is safe here.
#   - Agent image goose-harness:dev -> $AGENT_IMAGE (public multi-arch).
#
# Credentials: `aws configure export-credentials` must work in this shell
# (session credentials expire — re-run this script to refresh the secret;
# already-running pods keep the env they started with).
#
# Idempotent; never touches any cluster but its own profile. Runs still
# need a hub that can create them: the default ghcr :agentic hub image
# predates AgentRunCreate (POST /agentic/agentruns 404s) — build the
# tackle2-hub#1119 head locally per the loop in hub-auth-up.sh's header.
set -euo pipefail

PROFILE="${PROFILE:-hub-auth}"
NS=konveyor-agents
AWS_REGION="${AWS_REGION:-us-east-1}"
AGENT_IMAGE="${AGENT_IMAGE:-ghcr.io/ibolton336/agent-base:demo}"
GATEWAY_PROBE_URL="${GATEWAY_PROBE_URL:-http://tackle2-ui.konveyor-agents.svc:8080}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AC_INSTALL="${AC_INSTALL:-$ROOT/deploy/roks/agentic-controller-install.yaml}"
SANDBOX_INSTALL="${SANDBOX_INSTALL:-$ROOT/deploy/roks/agent-sandbox-v0.5.0.json}"

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }

k() { kubectl --context "$PROFILE" "$@"; }

step "Hub on profile $PROFILE"
k -n "$NS" get deploy/tackle-hub >/dev/null 2>&1 \
  || die "no hub on profile $PROFILE — run hack/hub-auth-up.sh first"
HUB_IMAGE_LIVE="$(k -n "$NS" get deploy/tackle-hub \
  -o jsonpath='{.spec.template.spec.containers[0].image}')"
ok "hub runs $HUB_IMAGE_LIVE"
if [ "$HUB_IMAGE_LIVE" = "ghcr.io/ibolton336/tackle2-hub:agentic" ]; then
  warn "that image predates AgentRunCreate — POST /agentic/agentruns 404s, so the console cannot start runs"
  warn "build the tackle2-hub#1119 head into the profile (HUB_LOCAL_BUILD=1, see hub-auth-up.sh header)"
fi
if ! k -n "$NS" get deploy/tackle-hub -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="HUB_BASE_URL")].value}' \
     | grep -q .; then
  warn "hub has no HUB_BASE_URL env — AgentRuns will carry localhost:8080 and loop on Hub Resolution; re-run hack/hub-auth-up.sh (current hub-auth-rig.yaml sets it)"
fi
# Default probe target is the console service; the gateway can never turn
# Ready without something answering 2xx at $GATEWAY_PROBE_URL/v1/models.
if [ "$GATEWAY_PROBE_URL" = "http://tackle2-ui.konveyor-agents.svc:8080" ] \
   && ! k -n "$NS" get svc/tackle2-ui >/dev/null 2>&1; then
  die "no console service to use as the gateway probe target — run hack/ui-up.sh first (or set GATEWAY_PROBE_URL)"
fi

step "AWS credentials"
command -v aws >/dev/null 2>&1 || die "aws CLI not found — the Bedrock secret is built from your local AWS identity"
CREDS="$(aws configure export-credentials --format env-no-export 2>/dev/null)" \
  || die "aws configure export-credentials failed — log in (aws sso login / set a profile) and re-run"
case "$CREDS" in *AWS_ACCESS_KEY_ID=*) : ;; *) die "export-credentials returned no AWS_ACCESS_KEY_ID" ;; esac
EXPIRY="$(printf '%s\n' "$CREDS" | sed -n 's/^AWS_CREDENTIAL_EXPIRATION=//p')"
[ -n "$EXPIRY" ] && warn "session credentials expire $EXPIRY — re-run this script to refresh the secret" \
                 || ok "long-lived credentials"
ok "identity exported (region $AWS_REGION)"

step "Agent Sandbox v0.5.0"
k apply -f "$SANDBOX_INSTALL" >/dev/null
k -n agent-sandbox-system rollout status deploy/agent-sandbox-controller --timeout=180s >/dev/null \
  || die "agent-sandbox controller not ready — k -n agent-sandbox-system logs deploy/agent-sandbox-controller"
ok "agent-sandbox-controller ready"

step "agentic-controller"
k apply -f "$AC_INSTALL" >/dev/null
k -n agentic-controller-system rollout status deploy/agentic-controller-controller-manager --timeout=300s >/dev/null \
  || die "controller not ready — k -n agentic-controller-system logs deploy/agentic-controller-controller-manager"
ok "controller ready ($(basename "$AC_INSTALL"))"

step "Bedrock secret"
# envFrom exposes every key to the harness (AWS SigV4 spans several vars).
k -n "$NS" create secret generic aws-bedrock-creds \
  --from-env-file=<(printf '%s\nAWS_REGION=%s\n' "$CREDS" "$AWS_REGION") \
  --dry-run=client -o yaml | k apply -f - >/dev/null
ok "aws-bedrock-creds applied in $NS"

step "Gateway + agent"
sed -e "s|https://bedrock-runtime\.[a-z0-9-]*\.amazonaws\.com|${GATEWAY_PROBE_URL}|" \
    -e "s|goose-harness:dev|${AGENT_IMAGE}|" \
    "$ROOT/manifests/goose-bedrock.yaml" | k apply -f - >/dev/null
ok "applied goose-bedrock.yaml (endpoint→${GATEWAY_PROBE_URL}, agent image ${AGENT_IMAGE})"
# First verify spawns a Job that pulls quay.io/konveyor/agentic-controller-agent
# — give it time. 2-4 min on a cold profile is the pull, not a failure.
if k -n "$NS" wait --for=condition=Ready gateway/bedrock-sonnet --timeout=300s >/dev/null 2>&1; then
  ok "gateway bedrock-sonnet Ready (verify Job passed against $GATEWAY_PROBE_URL)"
else
  warn "gateway bedrock-sonnet not Ready after 300s:"
  k -n "$NS" get gateway bedrock-sonnet \
    -o jsonpath='{range .status.conditions[*]}    {.type}={.status} {.reason}: {.message}{"\n"}{end}' || true
  warn "verify Job: k -n $NS get jobs -l konveyor.io/gateway=bedrock-sonnet"
fi

step "Ready"
cat <<EOF
  Runs launched from the console (or POST /agentic/agentruns) now get a
  sandbox pod, Bedrock credentials, and a hub they can reach.

  Watch one:  kubectl --context $PROFILE -n $NS get agentruns,pods -w
  Refresh expiring AWS credentials:  re-run hack/runs-up.sh
  Tear down just this layer:
    kubectl --context $PROFILE delete -f $AC_INSTALL -f $SANDBOX_INSTALL
EOF
