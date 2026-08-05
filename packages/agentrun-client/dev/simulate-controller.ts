/**
 * Stand-in for the not-yet-implemented AgentRun reconciler in
 * konveyor/agentic-controller. Performs the same externally observable
 * steps the real controller will (per ADR 0001/0002), so the client can
 * be developed and tested against the real CRD contract today:
 *
 *   1. Watch AgentRuns; for new ones resolve the Agent, apply param
 *      defaults, and generate a per-run ACP secret key.
 *   2. Create the key Secret, sandbox Pod, and stable-DNS Service
 *      (plain Pod/Service here instead of an agent-sandbox Sandbox CR —
 *      identical from the client's point of view).
 *   3. Patch AgentRun status: sandboxName, secretKeyRef, phase
 *      transitions Pending -> Running -> Succeeded/Failed.
 *
 * Delete this file when the real controller lands.
 */
import * as crypto from "node:crypto";
import * as k8s from "@kubernetes/client-node";
import { GROUP, VERSION, PLURALS, type Agent, type AgentRun, type Gateway } from "../src/types.js";

const NAMESPACE = process.env.NAMESPACE ?? "konveyor-agents";
const HARNESS_IMAGE = process.env.HARNESS_IMAGE ?? "acp-mock-harness:dev";
const POLL_MS = 2_000;

const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const custom = kc.makeApiClient(k8s.CustomObjectsApi);
const core = kc.makeApiClient(k8s.CoreV1Api);

const mergePatch = k8s.setHeaderOptions("Content-Type", k8s.PatchStrategy.MergePatch);

function ownerRef(run: AgentRun): k8s.V1OwnerReference {
  return {
    apiVersion: `${GROUP}/${VERSION}`,
    kind: "AgentRun",
    name: run.metadata.name!,
    uid: run.metadata.uid!,
    controller: true,
  };
}

async function patchStatus(name: string, status: Record<string, unknown>) {
  await custom.patchNamespacedCustomObjectStatus(
    {
      group: GROUP,
      version: VERSION,
      namespace: NAMESPACE,
      plural: PLURALS.AgentRun,
      name,
      body: { status },
    },
    mergePatch,
  );
}

async function getAgent(name: string): Promise<Agent> {
  return (await custom.getNamespacedCustomObject({
    group: GROUP,
    version: VERSION,
    namespace: NAMESPACE,
    plural: PLURALS.Agent,
    name,
  })) as Agent;
}

async function provision(run: AgentRun) {
  const name = run.metadata.name!;
  const sandboxName = `${name}-sandbox`;
  const secretName = `${name}-acp-key`;
  console.log(`[simulator] provisioning ${name} (agentRef=${run.spec.agentRef})`);

  let agent: Agent;
  try {
    agent = await getAgent(run.spec.agentRef);
  } catch {
    await patchStatus(name, {
      phase: "Failed",
      conditions: [
        {
          type: "Ready",
          status: "False",
          reason: "AgentNotFound",
          message: `Agent ${run.spec.agentRef} not found`,
          lastTransitionTime: new Date().toISOString(),
        },
      ],
    });
    return;
  }

  const secretKey = crypto.randomBytes(24).toString("hex");
  await core.createNamespacedSecret({
    namespace: NAMESPACE,
    body: {
      metadata: { name: secretName, ownerReferences: [ownerRef(run)] },
      stringData: { ACP_SECRET_KEY: secretKey },
    },
  });

  // Params: run values over agent defaults, injected as KONVEYOR_PARAM_{NAME}.
  const paramValues = new Map<string, string>();
  for (const p of agent.spec.params ?? []) {
    if (p.default !== undefined) paramValues.set(p.name, p.default);
  }
  for (const p of run.spec.params ?? []) paramValues.set(p.name, p.value);

  const env: k8s.V1EnvVar[] = [
    {
      name: "GOOSE_SERVER__SECRET_KEY",
      valueFrom: { secretKeyRef: { name: secretName, key: "ACP_SECRET_KEY" } },
    },
    { name: "GOOSE_MODE", value: "auto" },
    { name: "AGENT_PROMPT", value: agent.spec.prompt ?? "" },
    { name: "AGENT_INSTRUCTIONS", value: run.spec.instructions ?? "" },
    ...[...paramValues].map(([k, v]) => ({
      name: `KONVEYOR_PARAM_${k.toUpperCase()}`,
      value: v,
    })),
    ...((run.spec.env as k8s.V1EnvVar[] | undefined) ?? []),
  ];
  const envFrom: k8s.V1EnvFromSource[] = [
    ...((run.spec.envFrom as k8s.V1EnvFromSource[] | undefined) ?? []),
  ];

  // Gateway -> harness runtime config. Mirrors the real controller
  // (buildEnvVars): resolve the run's Gateway — defaulting to the Agent's
  // only gateway when exactly one is declared, as validateGateway does —
  // inject KONVEYOR_LLM_*, and mount the credential Secret (single-key ->
  // KONVEYOR_LLM_API_KEY, keyless -> whole Secret via envFrom). GOOSE_*
  // is additionally set because the mock harness has no entrypoint doing
  // the KONVEYOR_LLM_* -> goose mapping.
  const gatewayName =
    run.spec.gateway ?? (agent.spec.gateways.length === 1 ? agent.spec.gateways[0].ref : undefined);
  if (gatewayName) {
    const gateway = (await custom.getNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace: NAMESPACE,
      plural: PLURALS.Gateway,
      name: gatewayName,
    })) as Gateway;
    env.push({ name: "KONVEYOR_LLM_PROVIDER", value: gateway.spec.provider });
    env.push({ name: "KONVEYOR_LLM_ENDPOINT", value: gateway.spec.endpoint });
    env.push({ name: "KONVEYOR_LLM_MODEL", value: gateway.spec.model.name });
    env.push({ name: "GOOSE_PROVIDER", value: gateway.spec.provider === "aws-bedrock" ? "aws_bedrock" : gateway.spec.provider });
    env.push({ name: "GOOSE_MODEL", value: gateway.spec.model.name });
    const cred = gateway.spec.credentialRef;
    if (cred.key) {
      env.push({
        name: "KONVEYOR_LLM_API_KEY",
        valueFrom: { secretKeyRef: { name: cred.secretName, key: cred.key } },
      });
    } else {
      envFrom.push({ secretRef: { name: cred.secretName } });
    }
  }

  // Workspace: the harness clones the target repo before the agent starts
  // (git is the persistence layer). Mirrored here with an initContainer.
  const repository = paramValues.get("repository");
  const branch = paramValues.get("branch") || "main";
  const initContainers: k8s.V1Container[] = repository
    ? [
        {
          name: "clone-workspace",
          image: "alpine/git",
          args: ["clone", "--depth", "1", "--branch", branch, repository, "/workspace"],
          volumeMounts: [{ name: "workspace", mountPath: "/workspace" }],
        },
      ]
    : [];

  await core.createNamespacedPod({
    namespace: NAMESPACE,
    body: {
      metadata: {
        name: sandboxName,
        labels: { "konveyor.io/agentrun": name },
        ownerReferences: [ownerRef(run)],
      },
      spec: {
        restartPolicy: "Never",
        initContainers,
        volumes: [{ name: "workspace", emptyDir: {} }],
        containers: [
          {
            name: "harness",
            image: agent.spec.image,
            imagePullPolicy: "Never", // image built into minikube's daemon
            env,
            envFrom,
            volumeMounts: [{ name: "workspace", mountPath: "/workspace" }],
            ports: [{ containerPort: 4000, name: "acp" }],
            // TCP, not HTTP: real `goose serve` has no unauthenticated
            // health route; a listening socket is the readiness signal.
            readinessProbe: {
              tcpSocket: { port: 4000 },
              initialDelaySeconds: 2,
              periodSeconds: 2,
              failureThreshold: 30,
            },
          },
        ],
      },
    },
  });

  await core.createNamespacedService({
    namespace: NAMESPACE,
    body: {
      metadata: { name: sandboxName, ownerReferences: [ownerRef(run)] },
      spec: {
        selector: { "konveyor.io/agentrun": name },
        ports: [{ port: 4000, targetPort: 4000, name: "acp" }],
      },
    },
  });

  await patchStatus(name, {
    phase: "Pending",
    sandboxName,
    secretKeyRef: { name: secretName },
    observedGeneration: (run.metadata as { generation?: number }).generation,
  });
  console.log(`[simulator] ${name}: sandbox=${sandboxName} secret=${secretName}`);
}

async function trackLifecycle(run: AgentRun) {
  const name = run.metadata.name!;
  const sandboxName = run.status!.sandboxName!;
  let pod: k8s.V1Pod;
  try {
    pod = await core.readNamespacedPod({ name: sandboxName, namespace: NAMESPACE });
  } catch {
    return;
  }
  const podPhase = pod.status?.phase;
  const ready = pod.status?.conditions?.some(
    (c) => c.type === "Ready" && c.status === "True",
  );

  if (run.status!.phase === "Pending" && podPhase === "Running" && ready) {
    await patchStatus(name, { phase: "Running", startTime: new Date().toISOString() });
    console.log(`[simulator] ${name}: Running`);
  } else if (run.status!.phase === "Running" && (podPhase === "Succeeded" || podPhase === "Failed")) {
    const completionTime = new Date();
    const startTime = run.status!.startTime ? new Date(run.status!.startTime) : completionTime;
    await patchStatus(name, {
      phase: podPhase,
      completionTime: completionTime.toISOString(),
      duration: Math.round((completionTime.getTime() - startTime.getTime()) / 1000),
    });
    console.log(`[simulator] ${name}: ${podPhase}`);
  }
}

async function reconcileAll() {
  const list = (await custom.listNamespacedCustomObject({
    group: GROUP,
    version: VERSION,
    namespace: NAMESPACE,
    plural: PLURALS.AgentRun,
  })) as { items: AgentRun[] };

  for (const run of list.items) {
    try {
      if (!run.status?.sandboxName) await provision(run);
      else if (run.status.phase === "Pending" || run.status.phase === "Running")
        await trackLifecycle(run);
    } catch (err) {
      console.error(`[simulator] error reconciling ${run.metadata.name}:`, err);
    }
  }
}

console.log(`[simulator] watching AgentRuns in ${NAMESPACE} (harness image: ${HARNESS_IMAGE})`);
for (;;) {
  await reconcileAll();
  await new Promise((r) => setTimeout(r, POLL_MS));
}
