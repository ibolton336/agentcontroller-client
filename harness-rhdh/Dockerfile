# Derived goose harness with the rhdh-upgrade-helper Agent Skill baked in.
#
# Why baked instead of a SkillCard image: skills mount as k8s ImageVolumes,
# which cri-dockerd (this minikube's runtime) cannot do — pods die with
# CreateContainerError (see docs/UPSTREAM-FEEDBACK.md item 4). COPYing to
# /opt/skills/<name>/ hits the exact path the controller would have mounted,
# so the entrypoint's skill-folding works unchanged and the Agent CR needs
# no skills field. On a containerd cluster, drop the COPY and use a real
# SkillCard image ref instead.
#
# python3-yaml: the skill's config-analysis instructions shell out to
# `python3 -c "import yaml, ..."` to parse Helm values.
FROM goose-harness:dev

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-yaml \
    && rm -rf /var/lib/apt/lists/*

COPY rhdh-upgrade-helper /opt/skills/rhdh-upgrade-helper
