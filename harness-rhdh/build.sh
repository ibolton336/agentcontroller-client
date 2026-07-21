#!/bin/sh
# Assemble the goose-harness:rhdh-dev build context and build it into
# minikube's docker daemon (pods use imagePullPolicy: Never, like the
# other harness images — see docs/DEV_MODE.md).
#
# The skill content is cloned fresh from the upstream pack at a pinned
# commit rather than vendored here; bump SKILL_PACK_REF to pick up
# skill updates.
set -eu

SKILL_PACK_REPO=https://github.com/redhat-developer/rhdh-users-skill-pack
SKILL_PACK_REF=c3498d95be6259b8e5399348e0ced613c5da29da

ctx=$(mktemp -d)
trap 'rm -rf "$ctx"' EXIT

git clone -q "$SKILL_PACK_REPO" "$ctx/pack"
git -C "$ctx/pack" checkout -q "$SKILL_PACK_REF"

cp -R "$ctx/pack/skills/rhdh-upgrade-helper" "$ctx/rhdh-upgrade-helper"
cp "$ctx/pack/LICENSE" "$ctx/rhdh-upgrade-helper/LICENSE"
cp "$(cd "$(dirname "$0")" && pwd)/Dockerfile" "$ctx/Dockerfile"

minikube image build -t goose-harness:rhdh-dev "$ctx"
