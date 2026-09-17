#!/usr/bin/env bash
# Rotate the AWS credentials the Bedrock Gateways use. Run this yourself — the
# keys must not travel through a chat session.
#
# The Gateways (bedrock-sonnet, bedrock-haiku) hold no credentials: they point
# at the Secret `aws-bedrock-creds`, and the controller envFroms the WHOLE
# Secret into every sandbox pod. So "update the gateway creds" == replace that
# Secret. Pods read it at start: no restart, the next run picks it up.
#
# The symptom that sends you here — every run dies ~2 min in, on turn 1, with
#   UnrecognizedClientException: The security token included in the request is invalid.
# The Gateway stays Ready=True the whole time (aws-bedrock has no /v1/models to
# probe, so credentials are never verified) — Ready tells you nothing.
#
# Usage:
#   ./set-bedrock-creds.sh <namespace> [namespace ...]
#     ROKS runs execute in konveyor-tackle; konveyor-agents holds a second copy.
#
# Credentials come from AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
# (/ AWS_SESSION_TOKEN) if exported, else from the AWS CLI's current profile
# (`aws configure export-credentials`). They are never echoed.
#
#   SECRET_NAME=...    Secret to write (default aws-bedrock-creds; upstream
#                      samples use bedrock-credentials)
#   SKIP_PREFLIGHT=1   skip the live Bedrock call (e.g. no aws CLI on this box)
#   MODEL=...          model id for the preflight call
set -euo pipefail

[ $# -ge 1 ] || { echo "usage: $0 <namespace> [namespace ...]   (ROKS runs: konveyor-tackle)" >&2; exit 1; }

REGION=${AWS_REGION:-us-east-1}   # must match the Gateway endpoint's region
SECRET_NAME=${SECRET_NAME:-aws-bedrock-creds}
MODEL=${MODEL:-us.anthropic.claude-sonnet-4-5-20250929-v1:0}

if [ -z "${AWS_ACCESS_KEY_ID:-}" ] || [ -z "${AWS_SECRET_ACCESS_KEY:-}" ]; then
  echo "AWS_* not exported; reading the AWS CLI's current profile..."
  eval "$(aws configure export-credentials --format env)"
fi
: "${AWS_ACCESS_KEY_ID:?no credentials: export AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY or log the aws CLI in}"
: "${AWS_SECRET_ACCESS_KEY:?no credentials}"
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY

# Shape checks. Both of these were hit for real on 2026-09-17: a pasted
# placeholder ("AKIA...", 7 bytes) and a pasted "<your 20-char key id>" (21).
[ ${#AWS_ACCESS_KEY_ID} -eq 20 ] || { echo "AWS_ACCESS_KEY_ID is ${#AWS_ACCESS_KEY_ID} chars, expected 20 — placeholder?" >&2; exit 1; }
[ ${#AWS_SECRET_ACCESS_KEY} -eq 40 ] || { echo "AWS_SECRET_ACCESS_KEY is ${#AWS_SECRET_ACCESS_KEY} chars, expected 40 — placeholder?" >&2; exit 1; }
case $AWS_ACCESS_KEY_ID in
  ASIA*)
    [ -n "${AWS_SESSION_TOKEN:-}" ] || { echo "ASIA* key is temporary (STS/SSO) and needs AWS_SESSION_TOKEN — without it Bedrock answers 'security token is invalid'." >&2; exit 1; }
    echo "note: temporary credentials — these expire within hours; runs will start failing again when they do. Prefer a long-lived AKIA* IAM user key for a demo cluster." ;;
  AKIA*) unset AWS_SESSION_TOKEN ;;
  *) echo "AWS_ACCESS_KEY_ID starts with neither AKIA nor ASIA" >&2; exit 1 ;;
esac

# Prove the keys against Bedrock BEFORE writing them — a bad key otherwise
# costs a 2-minute run to discover.
if [ -z "${SKIP_PREFLIGHT:-}" ]; then
  echo "preflight: calling $MODEL in $REGION..."
  # env credentials outrank any profile in the SDK chain, so this tests
  # exactly the triple about to be written.
  [ -n "${AWS_SESSION_TOKEN:-}" ] && export AWS_SESSION_TOKEN
  aws bedrock-runtime converse --region "$REGION" --model-id "$MODEL" \
    --messages '[{"role":"user","content":[{"text":"reply with: ok"}]}]' \
    --inference-config '{"maxTokens":8}' \
    --query 'output.message.content[0].text' --output text
fi

echo "cluster: $(oc whoami --show-server)  as $(oc whoami)"
for ns in "$@"; do
  # create|apply, not delete+create: a missing Secret flips the Gateways NotReady.
  oc -n "$ns" create secret generic "$SECRET_NAME" \
    --from-literal=AWS_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID" \
    --from-literal=AWS_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY" \
    ${AWS_SESSION_TOKEN:+--from-literal=AWS_SESSION_TOKEN="$AWS_SESSION_TOKEN"} \
    --from-literal=AWS_REGION="$REGION" \
    --dry-run=client -o yaml | oc apply -f - >/dev/null
  echo "== $ns/$SECRET_NAME (sizes only; expect 20 / 40 / ${#REGION})"
  oc -n "$ns" describe secret "$SECRET_NAME" | sed -n '/^Data/,$p' | tail -n +3
done
echo "done — no restart needed; start a new run."
