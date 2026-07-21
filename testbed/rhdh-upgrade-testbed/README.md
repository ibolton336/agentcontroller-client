# rhdh-upgrade-testbed

RHDH configuration for a Developer Hub instance running the MTA
(Migration Toolkit for Applications) dynamic plugins. Used as the input
workspace for automated upgrade assessments.

- `dynamic-plugins.yaml` — installed dynamic plugins (OCI + dist-path refs)
- `app-config.yaml` — Backstage app configuration
- `.rhdh-upgrade-helper.yaml` — assessment defaults (from/to release, config list)

## Demo runs

`demo-runs/*.bundle` are git bundles preserving the full branch history of
completed playbook runs — the audit trail the demo pitches. Inspect one:

    git clone demo-runs/upgrade-run-1.bundle -b upgrade/rhdh-1.10 /tmp/run
    git -C /tmp/run log --oneline   # assess -> remediate -> validate commits
    git -C /tmp/run diff <assess>..<remediate> -- dynamic-plugins.yaml
