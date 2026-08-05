import { useState } from "react";
import {
  Alert,
  Bullseye,
  Button,
  EmptyState,
  EmptyStateActions,
  EmptyStateBody,
  EmptyStateFooter,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalVariant,
  PageSection,
  Spinner,
  Title,
  Toolbar,
  ToolbarContent,
  ToolbarItem,
} from "@patternfly/react-core";
import { ActionsColumn, Table, Tbody, Td, Th, Thead, Tr } from "@patternfly/react-table";
import CubesIcon from "@patternfly/react-icons/dist/esm/icons/cubes-icon";
import type { AgentWorkflow } from "@konveyor/agentic-client/contract";
import type { ShimClient } from "@konveyor/agentic-client/transport-shim";
import { errorMessage, formatAge, truncate } from "../format";
import { ReadyLabel, usePolledList } from "./sources";
import { WorkflowComposerModal } from "./WorkflowComposerModal";

interface WorkflowsPageProps {
  api: ShimClient;
}

export function WorkflowsPage({ api }: WorkflowsPageProps) {
  const { items: workflows, error: fetchError, refresh } = usePolledList(
    () => api.listWorkflows(), [api],
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<AgentWorkflow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.deleteWorkflow(deleteTarget);
      setDeleteTarget(null);
      void refresh();
    } catch (err) {
      setDeleteError(errorMessage(err));
    } finally {
      setDeleting(false);
    }
  };

  const stagesSummary = (pb: AgentWorkflow) => {
    const names = pb.spec.stages.map((s) => s.name);
    return `${names.length}: ${names.join(" → ")}`;
  };

  return (
    <>
      <PageSection>
        <Title headingLevel="h2" size="xl">Workflows</Title>
        <Toolbar inset={{ default: "insetNone" }}>
          <ToolbarContent>
            <ToolbarItem>
              <Button variant="primary" onClick={() => setCreateOpen(true)}>Create workflow</Button>
            </ToolbarItem>
          </ToolbarContent>
        </Toolbar>
        {fetchError && <Alert variant="danger" isInline title="Cannot reach the hub-shim" style={{ marginBottom: "1rem" }}>{fetchError}</Alert>}
        {workflows === null && !fetchError ? (
          <Bullseye><Spinner aria-label="Loading workflows" /></Bullseye>
        ) : workflows !== null && workflows.length === 0 ? (
          <EmptyState titleText="No workflows" headingLevel="h3" icon={CubesIcon}>
            <EmptyStateBody>No managed AgentWorkflow CRs exist. Create one to compose a multi-stage workflow.</EmptyStateBody>
            <EmptyStateFooter>
              <EmptyStateActions>
                <Button variant="primary" onClick={() => setCreateOpen(true)}>Create workflow</Button>
              </EmptyStateActions>
            </EmptyStateFooter>
          </EmptyState>
        ) : workflows !== null ? (
          <Table aria-label="Workflows" variant="compact">
            <Thead>
              <Tr>
                <Th>Name</Th>
                <Th>Stages</Th>
                <Th>Guide</Th>
                <Th>Ready</Th>
                <Th>Age</Th>
                <Th screenReaderText="Actions" />
              </Tr>
            </Thead>
            <Tbody>
              {workflows.map((pb) => {
                const name = pb.metadata.name ?? "";
                return (
                  <Tr key={pb.metadata.uid ?? name}>
                    <Td dataLabel="Name">{name}</Td>
                    <Td dataLabel="Stages">{stagesSummary(pb)}</Td>
                    <Td dataLabel="Guide">{pb.spec.guide ? truncate(pb.spec.guide, 80) : "—"}</Td>
                    <Td dataLabel="Ready"><ReadyLabel conditions={pb.status?.conditions} /></Td>
                    <Td dataLabel="Age">{formatAge(pb.metadata.creationTimestamp)}</Td>
                    <Td isActionCell>
                      <ActionsColumn items={[
                        { title: "Edit", onClick: () => setEditTarget(pb) },
                        { title: "Delete", onClick: () => { setDeleteError(null); setDeleteTarget(name); } },
                      ]} />
                    </Td>
                  </Tr>
                );
              })}
            </Tbody>
          </Table>
        ) : null}
      </PageSection>

      {(createOpen || editTarget) && (
        <WorkflowComposerModal api={api} existing={editTarget ?? undefined}
          onClose={() => { setCreateOpen(false); setEditTarget(null); }}
          onSaved={() => { setCreateOpen(false); setEditTarget(null); void refresh(); }} />
      )}

      <Modal variant={ModalVariant.small} isOpen={deleteTarget !== null}
        onClose={() => { if (!deleting) setDeleteTarget(null); }} aria-labelledby="delete-pb-title">
        <ModalHeader title="Delete Workflow?" labelId="delete-pb-title" />
        <ModalBody>
          {deleteError && <Alert variant="danger" isInline title="Delete failed" style={{ marginBottom: "1rem" }}>{deleteError}</Alert>}
          Delete workflow <strong>{deleteTarget}</strong>? Existing workflow runs are unaffected.
        </ModalBody>
        <ModalFooter>
          <Button variant="danger" isLoading={deleting} isDisabled={deleting} onClick={() => void confirmDelete()}>Delete</Button>
          <Button variant="link" isDisabled={deleting} onClick={() => setDeleteTarget(null)}>Cancel</Button>
        </ModalFooter>
      </Modal>
    </>
  );
}
