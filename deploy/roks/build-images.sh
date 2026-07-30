#!/usr/bin/env bash
# Build every demo image natively on the cluster and push to its internal
# registry.
#
# Why in-cluster and not `docker buildx --platform linux/amd64` from the Mac:
# the emulated x86_64 UBI10 `dnf` fails TLS against cdn-ubi.redhat.com
# ("digital envelope routines::provider signature failure") under QEMU, which
# kills the agent-base build outright. OpenShift Builds run native amd64 on
# the cluster's own nodes, so there is no emulation and no external registry
# to publish to.
#
# Usage:  ./build-images.sh [image ...]      (default: all)
set -euo pipefail

NS=konveyor-agents
STAGE=${STAGE:-$(mktemp -d)}

# Repo checkouts this pulls from. CONTROLLER_REPO must be the tree the
# controller image is built from — its config/crd and config/default have to
# match the running binary (see README, "CRDs and RBAC follow the image").
CLIENT_REPO=${CLIENT_REPO:-$(cd "$(dirname "$0")/../.." && pwd)}
CONTROLLER_REPO=${CONTROLLER_REPO:-$HOME/Development/agentic-controller}
TACKLE_UI_REPO=${TACKLE_UI_REPO:-$HOME/Development/tackle2-ui}

stage_agent_base() {
  mkdir -p "$STAGE/agent-base/images/agent-base"
  cp -R "$CONTROLLER_REPO/harness" "$STAGE/agent-base/harness"
  cp "$CONTROLLER_REPO/images/agent-base/Containerfile" "$STAGE/agent-base/images/agent-base/"
}

# agent-java bakes the five demo skills at /opt/skills. Four live in the
# controller repo, patternfly-migration lives in this one.
stage_agent_java() {
  mkdir -p "$STAGE/agent-java/skills"
  for s in plan execute verify javaee-to-quarkus; do
    cp -R "$CONTROLLER_REPO/skills/$s" "$STAGE/agent-java/skills/"
  done
  cp -R "$CLIENT_REPO/skills/patternfly-migration" "$STAGE/agent-java/skills/"
  cp "$CLIENT_REPO/deploy/roks/agent-java.Containerfile" "$STAGE/agent-java/Containerfile"
}

# git archive keeps untracked junk (node_modules, 218M of clients/) out of the
# upload. cypress/fixtures alone is 240M of sample WARs the build never reads.
stage_from_git() {
  local repo=$1 dest=$2; shift 2
  mkdir -p "$STAGE/$dest"
  git -C "$repo" archive HEAD | tar -x -C "$STAGE/$dest"
  for excl in "$@"; do rm -rf "${STAGE:?}/$dest/$excl"; done
}

build() {
  local name=$1
  echo "==> $name"
  oc -n "$NS" start-build "$name" --from-dir="$STAGE/$name" --follow
}

targets=("$@")
[ ${#targets[@]} -eq 0 ] && targets=(agent-base agent-java agentic-controller agentic-gateway tackle2-ui)

for t in "${targets[@]}"; do
  case $t in
    agent-base)         stage_agent_base ;;
    agent-java)         stage_agent_java ;;
    agentic-controller) stage_from_git "$CONTROLLER_REPO" agentic-controller clients ;;
    agentic-gateway)    stage_from_git "$CLIENT_REPO"     agentic-gateway slides testbed ;;
    tackle2-ui)         stage_from_git "$TACKLE_UI_REPO"  tackle2-ui cypress ;;
    *) echo "unknown image: $t" >&2; exit 1 ;;
  esac
done

# agent-java layers on agent-base, so order matters when both are requested.
for t in "${targets[@]}"; do build "$t"; done

echo
echo "Images now in the internal registry:"
oc -n "$NS" get is -o custom-columns=NAME:.metadata.name,TAGS:.status.tags[*].tag
