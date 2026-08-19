# Deploying

The in-cluster stack lives under [`roks/`](roks/README.md) — the recipe
written from the working ROKS demo cluster: hub swap (RBAC + `NAMESPACE`),
the `web-ui` IdpClient, the tackle2-ui console Deployment/Service/Route,
the agentic-controller install render, agent-sandbox, Bedrock gateways and
the coolstore demo. Live digests and traps are in
[`../docs/tackle2-ui-real-hub-handoff.md`](../docs/tackle2-ui-real-hub-handoff.md).

The former minikube-shaped variant (Vite UI + `hub-shim` gateway via
`deploy/manifests`, `deploy/ui`, `deploy/gateway`) was retired 2026-08-18
with the shim — see git history.
