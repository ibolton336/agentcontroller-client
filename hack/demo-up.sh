#!/usr/bin/env bash
# One-command demo bring-up: converge the cluster, start the shim + UI.
# Idempotent — safe to re-run after a reboot or `minikube stop`.
#
#   hack/demo-up.sh          # bring everything up
#   hack/demo-down.sh        # stop the local processes (cluster untouched)
#
# Logs: /tmp/demo-hub-shim.log, /tmp/demo-ui.log
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SHIM_PORT="${SHIM_PORT:-7080}"
UI_PORT="${UI_PORT:-5199}"
NS=konveyor-agents

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

echo "── cluster ──────────────────────────────────────────"
minikube status >/dev/null 2>&1 || die "minikube is not running — start it: minikube start"
[ "$(kubectl config current-context)" = "minikube" ] || die "kubectl context is not minikube"
ok "minikube up, context correct"

kubectl get deploy agent-sandbox-controller -n agent-sandbox-system >/dev/null 2>&1 \
  || die "Agent Sandbox missing — install v0.5.0 (helm chart from kubernetes-sigs/agent-sandbox)"
ok "Agent Sandbox present"

echo "── controller (PR #4 snapshot) ─────────────────────"
if ! minikube image ls 2>/dev/null | grep -q 'agentic-controller:dev'; then
  die "agentic-controller:dev image missing from minikube — rebuild per manifests/controller/install.yaml header"
fi
kubectl apply -f "$ROOT/manifests/controller/install.yaml" >/dev/null
kubectl wait deployment/agentic-controller-controller-manager \
  -n agentic-controller-system --for=condition=Available --timeout=120s >/dev/null
ok "controller Available (manifests/controller/install.yaml)"

echo "── agent-base images ───────────────────────────────"
if ! minikube image ls 2>/dev/null | grep -q 'acp-mock-harness:dev'; then
  warn "building acp-mock-harness:dev"
  (cd "$ROOT/harness-mock" && minikube image build -t acp-mock-harness:dev -f Dockerfile . >/dev/null)
fi
ok "acp-mock-harness:dev"
if ! minikube image ls 2>/dev/null | grep -q 'goose-harness:dev'; then
  warn "building goose-harness:dev"
  (cd "$ROOT/harness-goose" && minikube image build -t goose-harness:dev -f Dockerfile . >/dev/null)
fi
ok "goose-harness:dev"

echo "── sample resources ────────────────────────────────"
kubectl apply -f "$ROOT/manifests/samples.yaml" >/dev/null
ok "samples applied (mock agent + provider)"
if kubectl get secret aws-bedrock-creds -n $NS >/dev/null 2>&1; then
  kubectl apply -f "$ROOT/manifests/goose-bedrock.yaml" >/dev/null
  ok "goose-bedrock applied (aws-bedrock-creds present)"
else
  warn "aws-bedrock-creds secret missing — skipping goose-bedrock.yaml (mock-only demo); see README to create it"
fi

# Readiness gate: providers verify via a Job, then agents flip Ready.
if kubectl wait agent/migration-analyzer -n $NS \
     --for=jsonpath='{.status.conditions[?(@.type=="Ready")].status}'=True --timeout=90s >/dev/null 2>&1; then
  ok "agent migration-analyzer Ready"
else
  warn "migration-analyzer not Ready yet — check: kubectl get llmproviders,agents -n $NS"
fi

echo "── hub-shim (:$SHIM_PORT) ──────────────────────────"
if curl -sf --max-time 2 "http://127.0.0.1:$SHIM_PORT/healthz" >/dev/null 2>&1; then
  ok "already serving — reusing"
else
  [ -d "$ROOT/packages/hub-shim/node_modules" ] || (cd "$ROOT/packages/hub-shim" && npm install >/dev/null 2>&1)
  # Background ONLY the nohup command (an `&` after a `cmd1 && cmd2` list
  # would fork a lingering wrapper shell that holds our stdout open and
  # poisons the pidfile).
  (
    cd "$ROOT/packages/hub-shim"
    PORT=$SHIM_PORT nohup npm start </dev/null > /tmp/demo-hub-shim.log 2>&1 &
    echo $! > /tmp/demo-hub-shim.pid
  )
  for _ in $(seq 1 20); do
    curl -sf --max-time 1 "http://127.0.0.1:$SHIM_PORT/healthz" >/dev/null 2>&1 && break
    sleep 0.5
  done
  curl -sf --max-time 2 "http://127.0.0.1:$SHIM_PORT/healthz" >/dev/null || die "shim failed — /tmp/demo-hub-shim.log"
  ok "started (pid $(cat /tmp/demo-hub-shim.pid), log /tmp/demo-hub-shim.log)"
fi

echo "── ui (:$UI_PORT) ──────────────────────────────────"
if curl -sf --max-time 2 "http://127.0.0.1:$UI_PORT/" >/dev/null 2>&1; then
  ok "already serving — reusing"
else
  [ -d "$ROOT/ui/node_modules" ] || (cd "$ROOT/ui" && npm install >/dev/null 2>&1)
  (
    cd "$ROOT/ui"
    VITE_SHIM_URL="http://127.0.0.1:$SHIM_PORT" nohup npm run dev -- --host 127.0.0.1 --port "$UI_PORT" --strictPort </dev/null > /tmp/demo-ui.log 2>&1 &
    echo $! > /tmp/demo-ui.pid
  )
  for _ in $(seq 1 30); do
    curl -sf --max-time 1 "http://127.0.0.1:$UI_PORT/" >/dev/null 2>&1 && break
    sleep 0.5
  done
  curl -sf --max-time 2 "http://127.0.0.1:$UI_PORT/" >/dev/null || die "ui failed — /tmp/demo-ui.log"
  ok "started (pid $(cat /tmp/demo-ui.pid), log /tmp/demo-ui.log)"
fi

echo
echo "ready:"
echo "  ui        http://localhost:$UI_PORT"
echo "  shim      http://127.0.0.1:$SHIM_PORT/healthz"
echo "  real run  kubectl create -f docs/demo/real-run.yaml   (goose+Bedrock; needs aws-bedrock-creds)"
echo "  note      sandbox pods do not survive a minikube restart (restartPolicy Never) —"
echo "            old runs flip Failed after reboot; create a fresh run instead."
echo "  script    docs/DEMO.md"
