#!/usr/bin/env bash
# Pre-release smoke test, part A: run the ROKS demo stack on the images
# UPSTREAM built from main (quay.io/konveyor/*:latest) instead of the fork's
# ghcr builds. Same commits, different artifacts — these are the binaries a
# v0.11.0-alpha.N tag re-publishes, so a green coolstore run here says the
# shipped images work, not just the code.
#
# Hub, operator and the hand-rendered CRD/RBAC install are untouched; part B
# (deploy/release-candidate/README.md) covers the operator-driven install.
#
# Usage:
#   ./use-upstream-images.sh             # swap to quay :latest, pinned by digest
#   ./use-upstream-images.sh rollback    # back to ghcr.io/ibolton336 (FORK_TAG)
#
# Pins by digest on purpose: Agents pull IfNotPresent, so a mutable :latest
# would go stale on the nodes — and the digests printed at the end are the
# record of exactly what was tested.
set -euo pipefail

FORK=ghcr.io/ibolton336
FORK_TAG=${FORK_TAG:-main-20260916}
UP=quay.io/konveyor
AGENT_NAMESPACES=${AGENT_NAMESPACES:-"konveyor-tackle konveyor-agents"}

digest() { # multi-arch index digest of $1
  docker buildx imagetools inspect "$1" | awk '/^Digest:/{print $2; exit}'
}

if [ "${1:-}" = rollback ]; then
  ctrl=$FORK/agentic-controller:$FORK_TAG
  java=$FORK/agent-java:$FORK_TAG
  ui=$FORK/tackle2-ui:$FORK_TAG
else
  ctrl=$UP/agentic-controller@$(digest $UP/agentic-controller:latest)
  java=$UP/agent-java@$(digest $UP/agent-java:latest)
  ui=$UP/tackle2-ui@$(digest $UP/tackle2-ui:latest)
fi

echo "cluster: $(oc whoami --show-server)  as $(oc whoami)"
active=$(oc get agentruns.konveyor.io -A -o jsonpath='{range .items[?(@.status.phase=="Running")]}{.metadata.name} {end}')
[ -z "$active" ] || { echo "runs still Running: $active— wait or cancel them first" >&2; exit 1; }

# The controller image doubles as the skill-loader init container.
oc -n agentic-controller-system set image deploy/agentic-controller-controller-manager manager="$ctrl"
oc -n agentic-controller-system set env deploy/agentic-controller-controller-manager SKILL_LOADER_IMAGE="$ctrl"
oc -n agentic-controller-system rollout status deploy/agentic-controller-controller-manager --timeout=180s

oc -n konveyor-agents set image deploy/tackle2-ui "*=$ui"
oc -n konveyor-agents rollout status deploy/tackle2-ui --timeout=300s

for ns in $AGENT_NAMESPACES; do
  for a in $(oc -n "$ns" get agents.konveyor.io -o name); do
    oc -n "$ns" patch "$a" --type merge -p "{\"spec\":{\"image\":\"$java\"}}"
  done
done

echo
echo "== now running"
echo "controller  $ctrl"
echo "agent-java  $java"
echo "tackle2-ui  $ui"
oc get agents.konveyor.io -A -o custom-columns='NS:.metadata.namespace,AGENT:.metadata.name,READY:.status.conditions[?(@.type=="Ready")].status'
echo "next: start a coolstore run from the console and watch it past turn 1."
