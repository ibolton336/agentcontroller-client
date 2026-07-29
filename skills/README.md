# Demo skills

Domain skills authored client-side, in the exact shape of the upstream
`skills/` tree on konveyor/agentic-controller#53: a directory with
`skill.yaml` + `SKILL.md` (+ `modules/`, `references/`), built into a
scratch OCI image with [skillctl](https://github.com/redhat-et/skillimage)
and mounted by SkillCards at `/opt/skills/<name>/`.

## patternfly-migration

The Phase 2 stretch demo: proves the skill model generalizes beyond Java —
pair this domain card with the same language-agnostic stage cards
(plan/execute/verify) on `agent-nodejs` instead of `agent-java`, and the
three-stage playbook migrates a React UI from PatternFly 5 to 6. Zero
code, one afternoon of skill-writing. The shim's `POST /api/defaults`
seeds the SkillCard, the three `patternfly-*-agent` stage Agents, and the
`patternfly-migration` playbook.

## Building the OCI image

```bash
go install github.com/redhat-et/skillimage/cmd/skillctl@v0.7.2
skillctl build skills/patternfly-migration
skillctl tag patternfly-migration:1.0.0 quay.io/konveyor/skills:patternfly-migration
skillctl push quay.io/konveyor/skills:patternfly-migration
```

(Same flow as upstream's `make skill-build`/`skill-push`.)

## Local minikube caveat

SkillCard images mount as Kubernetes ImageVolumes, which cri-dockerd (this
minikube's runtime) cannot do. To RUN this skill locally, bake it into a
derived agent image instead — the pattern `harness-rhdh/Dockerfile` uses:

```dockerfile
FROM <agent-image>
COPY skills/patternfly-migration /opt/skills/patternfly-migration
```

COPYing to `/opt/skills/<name>/` hits the exact path the controller would
have mounted, so the harness's skill discovery works unchanged. On a
containerd cluster, use the real SkillCard image ref instead.
