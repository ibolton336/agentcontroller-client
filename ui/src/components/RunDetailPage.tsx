import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  DescriptionList,
  DescriptionListDescription,
  DescriptionListGroup,
  DescriptionListTerm,
  ExpandableSection,
  Flex,
  FlexItem,
  Label,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalVariant,
  PageSection,
  Title,
} from "@patternfly/react-core";
import ArrowLeftIcon from "@patternfly/react-icons/dist/esm/icons/arrow-left-icon";
import type { AgentRun, EnvVar } from "@konveyor/agentic-client/contract";
import { isTerminalPhase, RUN_ENV, defaultTargetBranch } from "@konveyor/agentic-client/contract";
import type { ShimClient } from "@konveyor/agentic-client/transport-shim";
import { errorMessage, formatAge, formatDuration, truncate } from "../format";
import { PhaseLabel } from "./PhaseLabel";
import { ChatPanel } from "./ChatPanel";

const POLL_MS = 2_000;

interface RunDetailPageProps {
  api: ShimClient;
  runName: string;
  onBack: () => void;
  onOpenRun?: (name: string) => void;
}

function envValue(run: AgentRun, key: string): string | undefined {
  return (run.spec.env as EnvVar[] | undefined)?.find((e) => e.name === key)?.value;
}

export function RunDetailPage({ api, runName, onBack, onOpenRun }: RunDetailPageProps) {
  const [run, setRun] = useState<AgentRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [rerunning, setRerunning] = useState(false);
  const [rerunError, setRerunError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    let stopped = false;
    const tick = async () => {
      if (inFlight || stopped) return;
      inFlight = true;
      try {
        const r = await api.getRun(runName);
        if (!disposed) { setRun(r); setError(null); }
      } catch (err) {
        if (!disposed) {
          const msg = errorMessage(err);
          if (msg.includes("HTTP 404")) { setNotFound(true); stopped = true; }
          else setError(msg);
        }
      } finally { inFlight = false; }
    };
    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => { disposed = true; clearInterval(timer); };
  }, [api, runName]);

  const confirmDelete = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.deleteRun(runName);
      setDeleteOpen(false);
      onBack();
    } catch (err) {
      setDeleteError(errorMessage(err));
    } finally {
      setDeleting(false);
    }
  };

  const rerun = async () => {
    if (!run) return;
    setRerunning(true);
    setRerunError(null);
    try {
      const params: Record<string, string> = {};
      for (const p of run.spec.params ?? []) params[p.name] = p.value;
      const created = await api.createRun({
        agentRef: run.spec.agentRef,
        params: Object.keys(params).length > 0 ? params : undefined,
        instructions: run.spec.instructions,
        targetBranch: defaultTargetBranch(),
      });
      const newName = created.metadata.name;
      if (newName && onOpenRun) onOpenRun(newName);
    } catch (err) {
      setRerunError(errorMessage(err));
    } finally {
      setRerunning(false);
    }
  };

  if (notFound) {
    return (
      <PageSection>
        <Alert variant="warning" isInline title={`AgentRun "${runName}" not found`}>
          It may have been deleted.
        </Alert>
        <Button variant="link" isInline icon={<ArrowLeftIcon />} onClick={onBack} style={{ marginTop: "1rem" }}>
          Back to runs
        </Button>
      </PageSection>
    );
  }

  const terminal = run ? isTerminalPhase(run.status?.phase) : false;
  const targetBranch = run ? envValue(run, RUN_ENV.TARGET_BRANCH) : undefined;
  const hubBaseUrl = run ? envValue(run, RUN_ENV.HUB_BASE_URL) : undefined;
  const appId = run ? envValue(run, RUN_ENV.APP_ID) : undefined;
  const hubToken = run ? envValue(run, RUN_ENV.HUB_TOKEN) : undefined;

  return (
    <>
      <PageSection>
        <Button variant="link" isInline icon={<ArrowLeftIcon />} onClick={onBack}>
          Back to runs
        </Button>
        <Flex alignItems={{ default: "alignItemsCenter" }} spaceItems={{ default: "spaceItemsMd" }}
          style={{ marginTop: "0.5rem" }}>
          <FlexItem>
            <Title headingLevel="h2" size="xl">{runName}</Title>
          </FlexItem>
          <FlexItem><PhaseLabel phase={run?.status?.phase} /></FlexItem>
          <FlexItem style={{ marginLeft: "auto" }}>
            {terminal && (
              <Button variant="secondary" size="sm" isLoading={rerunning} isDisabled={rerunning}
                onClick={() => void rerun()} style={{ marginRight: "0.5rem" }}>
                Re-run
              </Button>
            )}
            <Button variant="danger" size="sm" onClick={() => setDeleteOpen(true)}>Delete</Button>
          </FlexItem>
        </Flex>
        {error && <Alert variant="danger" isInline title="Failed to refresh run" style={{ marginTop: "0.75rem" }}>{error}</Alert>}
        {rerunError && <Alert variant="danger" isInline title="Re-run failed" style={{ marginTop: "0.75rem" }}>{rerunError}</Alert>}

        <DescriptionList isHorizontal isCompact columnModifier={{ default: "2Col" }} style={{ marginTop: "0.75rem" }}>
          <DescriptionListGroup>
            <DescriptionListTerm>Agent</DescriptionListTerm>
            <DescriptionListDescription>{run?.spec.agentRef ?? "—"}</DescriptionListDescription>
          </DescriptionListGroup>
          <DescriptionListGroup>
            <DescriptionListTerm>Sandbox</DescriptionListTerm>
            <DescriptionListDescription>{run?.status?.sandboxName ?? "—"}</DescriptionListDescription>
          </DescriptionListGroup>
          <DescriptionListGroup>
            <DescriptionListTerm>Age</DescriptionListTerm>
            <DescriptionListDescription>{formatAge(run?.metadata.creationTimestamp)}</DescriptionListDescription>
          </DescriptionListGroup>
          <DescriptionListGroup>
            <DescriptionListTerm>Duration</DescriptionListTerm>
            <DescriptionListDescription>{formatDuration(run?.status?.duration)}</DescriptionListDescription>
          </DescriptionListGroup>
        </DescriptionList>

        {run && (
          <ExpandableSection toggleText="Run spec" style={{ marginTop: "1rem" }}>
            <DescriptionList isHorizontal isCompact style={{ marginTop: "0.5rem" }}>
              {(run.spec.params ?? []).length > 0 && (
                <DescriptionListGroup>
                  <DescriptionListTerm>Params</DescriptionListTerm>
                  <DescriptionListDescription>
                    {run.spec.params!.map((p) => (
                      <Label key={p.name} isCompact style={{ marginRight: "0.25rem" }}>
                        <code>{p.name}={p.value}</code>
                      </Label>
                    ))}
                  </DescriptionListDescription>
                </DescriptionListGroup>
              )}
              {run.spec.gateway && (
                <DescriptionListGroup>
                  <DescriptionListTerm>Gateway</DescriptionListTerm>
                  <DescriptionListDescription>
                    <Label isCompact>{run.spec.gateway}</Label>
                  </DescriptionListDescription>
                </DescriptionListGroup>
              )}
              {run.spec.instructions && (
                <DescriptionListGroup>
                  <DescriptionListTerm>Instructions</DescriptionListTerm>
                  <DescriptionListDescription>{truncate(run.spec.instructions, 200)}</DescriptionListDescription>
                </DescriptionListGroup>
              )}
              {targetBranch && (
                <DescriptionListGroup>
                  <DescriptionListTerm>Target branch</DescriptionListTerm>
                  <DescriptionListDescription><code>{targetBranch}</code></DescriptionListDescription>
                </DescriptionListGroup>
              )}
              {appId && (
                <DescriptionListGroup>
                  <DescriptionListTerm>Application ID</DescriptionListTerm>
                  <DescriptionListDescription>{appId}</DescriptionListDescription>
                </DescriptionListGroup>
              )}
              {hubBaseUrl && (
                <DescriptionListGroup>
                  <DescriptionListTerm>Hub base URL</DescriptionListTerm>
                  <DescriptionListDescription><code>{hubBaseUrl}</code></DescriptionListDescription>
                </DescriptionListGroup>
              )}
              {hubToken !== undefined && (
                <DescriptionListGroup>
                  <DescriptionListTerm>Hub token</DescriptionListTerm>
                  <DescriptionListDescription>
                    <Label isCompact color="grey">{hubToken ? "set" : "unset"}</Label>
                  </DescriptionListDescription>
                </DescriptionListGroup>
              )}
            </DescriptionList>
          </ExpandableSection>
        )}
      </PageSection>

      <PageSection isFilled className="run-detail-chat-section">
        <ChatPanel api={api} runName={runName} />
      </PageSection>

      <Modal variant={ModalVariant.small} isOpen={deleteOpen}
        onClose={() => { if (!deleting) setDeleteOpen(false); }} aria-labelledby="delete-run-title">
        <ModalHeader title="Delete AgentRun?" labelId="delete-run-title" />
        <ModalBody>
          {deleteError && <Alert variant="danger" isInline title="Delete failed" style={{ marginBottom: "1rem" }}>{deleteError}</Alert>}
          Delete run <strong>{runName}</strong>? Its sandbox pod and ACP session go with it.
        </ModalBody>
        <ModalFooter>
          <Button variant="danger" isLoading={deleting} isDisabled={deleting} onClick={() => void confirmDelete()}>Delete</Button>
          <Button variant="link" isDisabled={deleting} onClick={() => setDeleteOpen(false)}>Cancel</Button>
        </ModalFooter>
      </Modal>
    </>
  );
}
