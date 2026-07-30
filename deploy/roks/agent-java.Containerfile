# agent-java for the ROKS demo cluster: JDK 21 + Maven on top of agent-base,
# plus the five demo skills baked at /opt/skills.
#
# The upstream images/agent-java/Containerfile COPYs no skills — the minikube
# demo image had them added by an ad-hoc local layer (see
# docs/quarkus-demo-flow-and-design.md, "Image drifts from Containerfile").
# This bakes them properly so the cluster image is reproducible from source.
ARG BASE_IMAGE=image-registry.openshift-image-registry.svc:5000/konveyor-agents/agent-base:demo
FROM ${BASE_IMAGE} AS base

USER root

RUN dnf install -y \
    java-21-openjdk-devel \
    maven \
    && dnf clean all

RUN JAVA_HOME_PATH=$(dirname $(dirname $(readlink -f $(which java)))) \
    && ln -sf "$JAVA_HOME_PATH" /usr/lib/jvm/java-current
ENV JAVA_HOME=/usr/lib/jvm/java-current
ENV PATH="${JAVA_HOME}/bin:${PATH}"

# Demo skills. The harness globs /opt/skills/*/SKILL.md and folds each into
# the prompt; skillCards would ImageVolume-mount into this same directory.
COPY skills/ /opt/skills/

# Maven writes ~/.m2 under the random OpenShift UID; HOME is set to
# /home/harness by agent-base and that tree is already GID-0 / g=u.
RUN mkdir -p /home/harness/.m2 \
    && chown -R 1001:0 /home/harness /opt/skills \
    && chmod -R g=u /home/harness /opt/skills

USER 1001

ENTRYPOINT ["migration-harness"]
CMD ["run"]
