#!/bin/sh
# Phase-4 agent base entrypoint: adapt the agentic-controller's KONVEYOR_*
# env contract to goose, then serve ACP.
#
# The controller injects: KONVEYOR_PARAM_* (run params),
# KONVEYOR_LLM_{PROVIDER,MODEL,ENDPOINT,API_KEY} (from the run's Gateway,
# post-#100; the pre-#100 KONVEYOR_MODEL_PRIMARY_* names are honored as
# fallbacks), KONVEYOR_PROMPT / KONVEYOR_INSTRUCTIONS,
# GOOSE_SERVER__SECRET_KEY, plus run.spec.env / run.spec.envFrom
# passthrough. It does NOT clone the repository (the retired dev simulator
# did that in an init container) — the agent base owns workspace setup now.
#
# Credentials: a single-key Gateway credentialRef arrives as
# KONVEYOR_LLM_API_KEY; a keyless one (SigV4/Bedrock) arrives as the whole
# Secret via envFrom (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
# AWS_REGION) — both mounted by the controller itself.
set -u

log() { echo "[agent-base] $*"; }

# 1. Workspace: clone the target repo into the controller's EmptyDir.
REPO="${KONVEYOR_PARAM_REPOSITORY:-}"
BRANCH="${KONVEYOR_PARAM_BRANCH:-main}"
if [ -n "$REPO" ]; then
  if [ -z "$(ls -A /workspace 2>/dev/null)" ]; then
    log "cloning $REPO@$BRANCH into /workspace"
    if git clone --depth 1 --branch "$BRANCH" "$REPO" /workspace 2>&1; then
      log "clone OK: $(ls /workspace | head -6 | tr '\n' ' ')"
    else
      log "WARNING: clone failed — agent starts with an empty workspace"
    fi
  else
    log "workspace not empty — skipping clone"
  fi
else
  log "no repository param — skipping clone"
fi

# 2. Model: map KONVEYOR_LLM_* (Gateway injection, with legacy
#    KONVEYOR_MODEL_PRIMARY_* fallback) onto goose env. Explicit
#    GOOSE_PROVIDER / GOOSE_MODEL (from run.spec.env) win. The provider
#    value is Gateway spec.provider (a runtime provider id like
#    "aws-bedrock"); map well-known ids onto goose provider
#    implementations, else pass through with "-" -> "_".
LLM_MODEL="${KONVEYOR_LLM_MODEL:-${KONVEYOR_MODEL_PRIMARY_MODEL:-}}"
LLM_PROVIDER="${KONVEYOR_LLM_PROVIDER:-${KONVEYOR_MODEL_PRIMARY_PROVIDER:-}}"
if [ -z "${GOOSE_MODEL:-}" ] && [ -n "$LLM_MODEL" ]; then
  GOOSE_MODEL="$LLM_MODEL"
  export GOOSE_MODEL
fi
if [ -z "${GOOSE_PROVIDER:-}" ] && [ -n "$LLM_PROVIDER" ]; then
  case "$LLM_PROVIDER" in
    *bedrock*) GOOSE_PROVIDER=aws_bedrock ;;
    *anthropic*) GOOSE_PROVIDER=anthropic ;;
    *openai*) GOOSE_PROVIDER=openai ;;
    *ollama*) GOOSE_PROVIDER=ollama ;;
    *) GOOSE_PROVIDER="$(printf '%s' "$LLM_PROVIDER" | tr 'A-Z-' 'a-z_')" ;;
  esac
  export GOOSE_PROVIDER
fi
# Single-key credential (e.g. Anthropic/OpenAI API key) -> the goose
# provider's expected env var when not already set via run.spec.env.
if [ -n "${KONVEYOR_LLM_API_KEY:-}" ]; then
  case "${GOOSE_PROVIDER:-}" in
    anthropic) : "${ANTHROPIC_API_KEY:=$KONVEYOR_LLM_API_KEY}"; export ANTHROPIC_API_KEY ;;
    openai) : "${OPENAI_API_KEY:=$KONVEYOR_LLM_API_KEY}"; export OPENAI_API_KEY ;;
  esac
fi
log "provider=${GOOSE_PROVIDER:-unset} model=${GOOSE_MODEL:-unset}"
if [ "${GOOSE_PROVIDER:-}" = "aws_bedrock" ] && [ -z "${AWS_ACCESS_KEY_ID:-}" ]; then
  log "WARNING: aws_bedrock selected but AWS_ACCESS_KEY_ID is unset — pass the credential secret via run.spec.envFrom"
fi

# 3. Standing prompt + instructions + workflow guide -> .goosehints in the
#    workspace (sessions run with cwd /workspace; goose reads hints from
#    there). KONVEYOR_WORKFLOW_GUIDE is the AgentWorkflow guide the
#    workflow-run controller injects for every stage (#36/#80); the
#    KONVEYOR_WORKLOAD_INSTRUCTIONS fallback covers pre-rename controllers.
WORKFLOW_GUIDE="${KONVEYOR_WORKFLOW_GUIDE:-${KONVEYOR_WORKLOAD_INSTRUCTIONS:-}}"
if [ -n "${KONVEYOR_PROMPT:-}${KONVEYOR_INSTRUCTIONS:-}${WORKFLOW_GUIDE}" ]; then
  {
    [ -n "${KONVEYOR_PROMPT:-}" ] && printf '%s\n' "$KONVEYOR_PROMPT"
    [ -n "${WORKFLOW_GUIDE}" ] && printf '\n## Workflow guide\n\n%s\n' "$WORKFLOW_GUIDE"
    [ -n "${KONVEYOR_INSTRUCTIONS:-}" ] && printf '\n%s\n' "$KONVEYOR_INSTRUCTIONS"
    true # group status must reflect the redirect, not the last [ -n ] test
  } > /workspace/.goosehints 2>/dev/null && log "wrote /workspace/.goosehints" \
    || log "WARNING: could not write /workspace/.goosehints"
fi

# 4. Skills: the controller mounts each resolved SkillCard as an ImageVolume
#    at /opt/skills/<name>/. Fold every skill's SKILL.md into the hints so
#    the agent actually knows its skills. (Requires a runtime with k8s
#    ImageVolume support — containerd >= 2.0 / CRI-O; docker/cri-dockerd
#    pods fail with CreateContainerError before we ever run.)
if [ -d /opt/skills ]; then
  for d in /opt/skills/*/; do
    [ -f "${d}SKILL.md" ] || continue
    name="$(basename "$d")"
    {
      printf '\n\n## Skill: %s (files under %s)\n\n' "$name" "$d"
      cat "${d}SKILL.md"
    } >> /workspace/.goosehints 2>/dev/null \
      && log "folded skill '$name' into .goosehints" \
      || log "WARNING: could not fold skill '$name'"
  done
fi

# 5. Serve ACP (interactive chat runs), or — when the run carries a
#    mode=batch param — execute the task headlessly and exit so the pod
#    completes. Workflow stages need run-to-completion semantics: a stage
#    AgentRun only Succeeds when its pod exits 0, and `goose serve` never
#    exits. The task text is the stage instructions; prompt + guide are
#    already in .goosehints.
if [ "${KONVEYOR_PARAM_MODE:-}" = "batch" ]; then
  printf '%s\n' "${KONVEYOR_INSTRUCTIONS:-Follow your standing prompt.}" > /tmp/task.md
  log "batch mode: goose run starting"
  goose run -i /tmp/task.md
  rc=$?
  log "batch mode: goose run exited rc=$rc"
  exit $rc
fi

exec goose serve --host 0.0.0.0 --port 4000
