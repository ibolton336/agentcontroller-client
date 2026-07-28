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
import type { SkillCard, SkillCollection } from "@konveyor/agentic-client/contract";
import type { ShimClient } from "@konveyor/agentic-client/transport-shim";
import { errorMessage, formatAge } from "../format";
import { ReadyLabel, usePolledList } from "./sources";
import { SkillCardModal } from "./SkillCardModal";
import { SkillCollectionModal } from "./SkillCollectionModal";

interface SkillsPageProps {
  api: ShimClient;
}

export function SkillsPage({ api }: SkillsPageProps) {
  const { items: cards, error: cardsError, refresh: refreshCards } = usePolledList(
    () => api.listSkillCards(), [api],
  );
  const { items: collections, error: colError, refresh: refreshCols } = usePolledList(
    () => api.listSkillCollections(), [api],
  );
  const [createCard, setCreateCard] = useState(false);
  const [editCard, setEditCard] = useState<SkillCard | null>(null);
  const [createCol, setCreateCol] = useState(false);
  const [editCol, setEditCol] = useState<SkillCollection | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ kind: "card" | "collection"; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      if (deleteTarget.kind === "card") {
        await api.deleteSkillCard(deleteTarget.name);
        void refreshCards();
      } else {
        await api.deleteSkillCollection(deleteTarget.name);
        void refreshCols();
      }
      setDeleteTarget(null);
    } catch (err) {
      setDeleteError(errorMessage(err));
    } finally {
      setDeleting(false);
    }
  };

  const sourceLabel = (sc: SkillCard) => {
    if (sc.spec.image) return "image";
    if (sc.spec.inline) return "inline";
    if (sc.spec.source) return "git";
    return "—";
  };

  return (
    <>
      <PageSection>
        <Title headingLevel="h2" size="xl">Skill cards</Title>
        <Toolbar inset={{ default: "insetNone" }}>
          <ToolbarContent>
            <ToolbarItem>
              <Button variant="primary" onClick={() => setCreateCard(true)}>Create skill card</Button>
            </ToolbarItem>
          </ToolbarContent>
        </Toolbar>
        {cardsError && <Alert variant="danger" isInline title="Failed to load skill cards" style={{ marginBottom: "1rem" }}>{cardsError}</Alert>}
        {cards === null && !cardsError ? (
          <Bullseye><Spinner aria-label="Loading skill cards" /></Bullseye>
        ) : cards !== null && cards.length === 0 ? (
          <EmptyState titleText="No skill cards" headingLevel="h3" icon={CubesIcon}>
            <EmptyStateBody>No managed SkillCard CRs exist.</EmptyStateBody>
            <EmptyStateFooter>
              <EmptyStateActions>
                <Button variant="primary" onClick={() => setCreateCard(true)}>Create skill card</Button>
              </EmptyStateActions>
            </EmptyStateFooter>
          </EmptyState>
        ) : cards !== null ? (
          <Table aria-label="Skill cards" variant="compact">
            <Thead>
              <Tr>
                <Th>Name</Th>
                <Th>Display name</Th>
                <Th>Type</Th>
                <Th>Source</Th>
                <Th>Ready</Th>
                <Th>Tags</Th>
                <Th>Age</Th>
                <Th screenReaderText="Actions" />
              </Tr>
            </Thead>
            <Tbody>
              {cards.map((sc) => {
                const name = sc.metadata.name ?? "";
                return (
                  <Tr key={sc.metadata.uid ?? name}>
                    <Td dataLabel="Name">{name}</Td>
                    <Td dataLabel="Display name">{sc.spec.displayName ?? "—"}</Td>
                    <Td dataLabel="Type"><Label isCompact>{sc.spec.type ?? "skill"}</Label></Td>
                    <Td dataLabel="Source">{sourceLabel(sc)}</Td>
                    <Td dataLabel="Ready"><ReadyLabel conditions={sc.status?.conditions} /></Td>
                    <Td dataLabel="Tags">{(sc.spec.tags ?? []).join(", ") || "—"}</Td>
                    <Td dataLabel="Age">{formatAge(sc.metadata.creationTimestamp)}</Td>
                    <Td isActionCell>
                      <ActionsColumn items={[
                        { title: "Edit", onClick: () => setEditCard(sc) },
                        { title: "Delete", onClick: () => { setDeleteError(null); setDeleteTarget({ kind: "card", name }); } },
                      ]} />
                    </Td>
                  </Tr>
                );
              })}
            </Tbody>
          </Table>
        ) : null}
      </PageSection>

      <PageSection>
        <Title headingLevel="h2" size="xl">Skill collections</Title>
        <Toolbar inset={{ default: "insetNone" }}>
          <ToolbarContent>
            <ToolbarItem>
              <Button variant="primary" onClick={() => setCreateCol(true)}>Create collection</Button>
            </ToolbarItem>
          </ToolbarContent>
        </Toolbar>
        {colError && <Alert variant="danger" isInline title="Failed to load collections" style={{ marginBottom: "1rem" }}>{colError}</Alert>}
        {collections === null && !colError ? (
          <Bullseye><Spinner aria-label="Loading collections" /></Bullseye>
        ) : collections !== null && collections.length === 0 ? (
          <EmptyState titleText="No skill collections" headingLevel="h3" icon={CubesIcon}>
            <EmptyStateBody>No managed SkillCollection CRs exist.</EmptyStateBody>
            <EmptyStateFooter>
              <EmptyStateActions>
                <Button variant="primary" onClick={() => setCreateCol(true)}>Create collection</Button>
              </EmptyStateActions>
            </EmptyStateFooter>
          </EmptyState>
        ) : collections !== null ? (
          <Table aria-label="Skill collections" variant="compact">
            <Thead>
              <Tr>
                <Th>Name</Th>
                <Th>Skills</Th>
                <Th>Ready</Th>
                <Th>Age</Th>
                <Th screenReaderText="Actions" />
              </Tr>
            </Thead>
            <Tbody>
              {collections.map((col) => {
                const name = col.metadata.name ?? "";
                return (
                  <Tr key={col.metadata.uid ?? name}>
                    <Td dataLabel="Name">{name}</Td>
                    <Td dataLabel="Skills">{col.spec.skills?.length ?? 0}</Td>
                    <Td dataLabel="Ready"><ReadyLabel conditions={col.status?.conditions} /></Td>
                    <Td dataLabel="Age">{formatAge(col.metadata.creationTimestamp)}</Td>
                    <Td isActionCell>
                      <ActionsColumn items={[
                        { title: "Edit", onClick: () => setEditCol(col) },
                        { title: "Delete", onClick: () => { setDeleteError(null); setDeleteTarget({ kind: "collection", name }); } },
                      ]} />
                    </Td>
                  </Tr>
                );
              })}
            </Tbody>
          </Table>
        ) : null}
      </PageSection>

      {(createCard || editCard) && (
        <SkillCardModal api={api} existing={editCard ?? undefined}
          onClose={() => { setCreateCard(false); setEditCard(null); }}
          onSaved={() => { setCreateCard(false); setEditCard(null); void refreshCards(); }} />
      )}
      {(createCol || editCol) && (
        <SkillCollectionModal api={api} existing={editCol ?? undefined}
          onClose={() => { setCreateCol(false); setEditCol(null); }}
          onSaved={() => { setCreateCol(false); setEditCol(null); void refreshCols(); }} />
      )}

      <Modal variant={ModalVariant.small} isOpen={deleteTarget !== null}
        onClose={() => { if (!deleting) setDeleteTarget(null); }} aria-labelledby="delete-skill-title">
        <ModalHeader title={`Delete ${deleteTarget?.kind === "collection" ? "SkillCollection" : "SkillCard"}?`} labelId="delete-skill-title" />
        <ModalBody>
          {deleteError && <Alert variant="danger" isInline title="Delete failed" style={{ marginBottom: "1rem" }}>{deleteError}</Alert>}
          Delete <strong>{deleteTarget?.name}</strong>? Agents referencing it will lose this skill.
        </ModalBody>
        <ModalFooter>
          <Button variant="danger" isLoading={deleting} isDisabled={deleting} onClick={() => void confirmDelete()}>Delete</Button>
          <Button variant="link" isDisabled={deleting} onClick={() => setDeleteTarget(null)}>Cancel</Button>
        </ModalFooter>
      </Modal>
    </>
  );
}
