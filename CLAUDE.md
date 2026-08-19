# agentcontroller-client

## Testing

**Do not write unit tests for this project.** Testing effort goes to tests that
prove the real system works — cluster, protocol, agent runtime — not
isolated-module coverage.

Invest instead in:

- Repeatable integration/E2E harnesses: upstream konveyor/agentic-controller
  `test/e2e` + `hack/run-e2e.sh`; this repo's `hack/hub-auth-probe.sh` (auth
  matrix against a real hub) and `hack/mock-inventory-stack.mjs` (contract
  fixture the console is verified against).
- Failure-path coverage inside those harnesses, not just the happy path.
- Contract canaries against pinned external binaries (e.g. goose releases).

When a workflow calls for test-first development, the test written first should
be an E2E or integration test. "Write the test first" applies; "write a unit
test" does not.

## Clusters

Never touch a cluster the user has not explicitly named in the current request.
Do not fall back to whatever kubeconfig context happens to be active. Ask which
cluster to use if it is not stated.
