import { useState } from "react";
import {
  Alert,
  Bullseye,
  Button,
  EmptyState,
  EmptyStateActions,
  EmptyStateBody,
  EmptyStateFooter,
  Label,
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
import type { AgentResource } from "@konveyor/agentic-client/contract";
import type { ShimClient } from "@konveyor/agentic-client/transport-shim";
import { errorMessage, formatAge } from "../format";
import { ReadyLabel, skillCount, usePolledList } from "./sources";
import { AgentDesignerModal } from "./AgentDesignerModal";

interface AgentsPageProps {
  api: ShimClient;
}

export function AgentsPage({ api }: AgentsPageProps) {
  const { items: agents, error: fetchError, refresh } = usePolledList(
    () => api.listAgents(),
    [api],
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<AgentResource | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.deleteAgent(deleteTarget);
      setDeleteTarget(null);
      void refresh();
    } catch (err) {
      setDeleteError(errorMessage(err));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <PageSection>
        <Title headingLevel="h2" size="xl">Agents</Title>
        <Toolbar inset={{ default: "insetNone" }}>
          <ToolbarContent>
            <ToolbarItem>
              <Button variant="primary" onClick={() => setCreateOpen(true)}>Create agent</Button>
            </ToolbarItem>
          </ToolbarContent>
        </Toolbar>
        {fetchError && (
          <Alert variant="danger" isInline title="Cannot reach the hub-shim" style={{ marginBottom: "1rem" }}>
            {fetchError}
          </Alert>
        )}
        {agents === null && !fetchError ? (
          <Bullseye><Spinner aria-label="Loading agents" /></Bullseye>
        ) : agents !== null && agents.length === 0 ? (
          <EmptyState titleText="No agents" headingLevel="h3" icon={CubesIcon}>
            <EmptyStateBody>No managed Agent CRs exist. Create one to define an agent template.</EmptyStateBody>
            <EmptyStateFooter>
              <EmptyStateActions>
                <Button variant="primary" onClick={() => setCreateOpen(true)}>Create agent</Button>
              </EmptyStateActions>
            </EmptyStateFooter>
          </EmptyState>
        ) : agents !== null ? (
          <Table aria-label="Agents" variant="compact">
            <Thead>
              <Tr>
                <Th>Name</Th>
                <Th>Image</Th>
                <Th>Providers</Th>
                <Th>Skills</Th>
                <Th>Params</Th>
                <Th>Ready</Th>
                <Th>Age</Th>
                <Th screenReaderText="Actions" />
              </Tr>
            </Thead>
            <Tbody>
              {agents.map((agent) => {
                const name = agent.metadata.name ?? "";
                const sc = skillCount(agent.spec);
                return (
                  <Tr key={agent.metadata.uid ?? name}>
                    <Td dataLabel="Name">{name}</Td>
                    <Td dataLabel="Image"><code style={{ fontSize: "0.85em" }}>{agent.spec.image}</code></Td>
                    <Td dataLabel="Providers">{(agent.spec.providers ?? []).map((p) => p.ref).join(", ") || "—"}</Td>
                    <Td dataLabel="Skills">
                      {sc === 0 ? (
                        <Label color="red">0 skills</Label>
                      ) : (
                        <Label color="blue">{sc}</Label>
                      )}
                    </Td>
                    <Td dataLabel="Params">{agent.spec.params?.length ?? 0}</Td>
                    <Td dataLabel="Ready"><ReadyLabel conditions={agent.status?.conditions} /></Td>
                    <Td dataLabel="Age">{formatAge(agent.metadata.creationTimestamp)}</Td>
                    <Td isActionCell>
                      <ActionsColumn items={[
                        { title: "Edit", onClick: () => setEditTarget(agent) },
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
        <AgentDesignerModal
          api={api}
          existing={editTarget ?? undefined}
          onClose={() => { setCreateOpen(false); setEditTarget(null); }}
          onSaved={() => { setCreateOpen(false); setEditTarget(null); void refresh(); }}
        />
      )}

      <Modal variant={ModalVariant.small} isOpen={deleteTarget !== null}
        onClose={() => { if (!deleting) setDeleteTarget(null); }}
        aria-labelledby="delete-agent-title">
        <ModalHeader title="Delete Agent?" labelId="delete-agent-title" />
        <ModalBody>
          {deleteError && <Alert variant="danger" isInline title="Delete failed" style={{ marginBottom: "1rem" }}>{deleteError}</Alert>}
          Delete agent <strong>{deleteTarget}</strong>? Existing runs using this agent are unaffected.
        </ModalBody>
        <ModalFooter>
          <Button variant="danger" isLoading={deleting} isDisabled={deleting} onClick={() => void confirmDelete()}>Delete</Button>
          <Button variant="link" isDisabled={deleting} onClick={() => setDeleteTarget(null)}>Cancel</Button>
        </ModalFooter>
      </Modal>
    </>
  );
}
