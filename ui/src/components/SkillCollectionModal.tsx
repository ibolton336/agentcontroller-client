import { useState } from "react";
import {
  Alert,
  Button,
  Form,
  FormGroup,
  FormHelperText,
  FormSelect,
  FormSelectOption,
  HelperText,
  HelperTextItem,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalVariant,
  TextInput,
} from "@patternfly/react-core";
import type { SkillCollection, SkillCollectionSkillRef, SkillCollectionSpec } from "@konveyor/agentic-client/contract";
import { RESOURCE_NAME_PATTERN } from "@konveyor/agentic-client/contract";
import type { ShimClient } from "@konveyor/agentic-client/transport-shim";
import { errorMessage } from "../format";

interface SkillCollectionModalProps {
  api: ShimClient;
  existing?: SkillCollection;
  onClose: () => void;
  onSaved: () => void;
}

const emptyMember = (): SkillCollectionSkillRef => ({ name: "" });

export function SkillCollectionModal({ api, existing, onClose, onSaved }: SkillCollectionModalProps) {
  const isEdit = !!existing;
  const [name, setName] = useState(existing?.metadata.name ?? "");
  const [members, setMembers] = useState<SkillCollectionSkillRef[]>(
    existing?.spec.skills?.length ? [...existing.spec.skills] : [emptyMember()],
  );
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const nameValid = !name || RESOURCE_NAME_PATTERN.test(name);
  const validMembers = members.filter((m) => m.name.trim() && (m.skillCardRef || m.image));
  const canSubmit = name.trim() !== "" && nameValid && validMembers.length > 0 && !submitting;

  const updateMember = (i: number, field: keyof SkillCollectionSkillRef, value: string) => {
    setMembers((prev) => prev.map((m, j) => {
      if (j !== i) return m;
      const updated = { ...m, [field]: value || undefined };
      if (field === "skillCardRef") { delete updated.image; delete updated.source; }
      if (field === "image") { delete updated.skillCardRef; delete updated.source; }
      return updated;
    }));
  };

  const moveUp = (i: number) => {
    if (i === 0) return;
    setMembers((prev) => { const a = [...prev]; [a[i - 1], a[i]] = [a[i]!, a[i - 1]!]; return a; });
  };
  const moveDown = (i: number) => {
    setMembers((prev) => {
      if (i >= prev.length - 1) return prev;
      const a = [...prev]; [a[i], a[i + 1]] = [a[i + 1]!, a[i]!]; return a;
    });
  };

  const submit = async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const spec: SkillCollectionSpec = { skills: validMembers };
      if (isEdit) {
        await api.updateSkillCollection(name, spec);
      } else {
        await api.createSkillCollection(name, spec);
      }
      onSaved();
    } catch (err) {
      setSubmitError(errorMessage(err));
      setSubmitting(false);
    }
  };

  return (
    <Modal variant={ModalVariant.medium} isOpen onClose={() => { if (!submitting) onClose(); }}
      aria-labelledby="collection-modal-title">
      <ModalHeader title={isEdit ? `Edit collection: ${name}` : "Create skill collection"} labelId="collection-modal-title" />
      <ModalBody>
        {submitError && <Alert variant="danger" isInline title="Save failed" style={{ marginBottom: "1rem" }}>{submitError}</Alert>}

        <Form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <FormGroup label="Name" isRequired fieldId="col-name">
            <TextInput id="col-name" isRequired isDisabled={isEdit} value={name}
              onChange={(_e, v) => setName(v)} validated={nameValid ? "default" : "error"} />
            {!nameValid && (
              <FormHelperText><HelperText><HelperTextItem variant="error">
                Must be a valid DNS-1123 name
              </HelperTextItem></HelperText></FormHelperText>
            )}
          </FormGroup>

          <FormGroup label="Skills" isRequired fieldId="col-skills">
            {members.map((m, i) => (
              <div key={i} style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginBottom: "0.5rem", flexWrap: "wrap",
                padding: "0.5rem", border: "1px solid #d2d2d2", borderRadius: "4px" }}>
                <TextInput style={{ width: "140px" }} value={m.name} placeholder="skill name"
                  onChange={(_e, v) => updateMember(i, "name", v)} />
                <FormSelect style={{ width: "130px" }}
                  value={m.skillCardRef ? "ref" : "image"}
                  onChange={(_e, v) => {
                    if (v === "ref") updateMember(i, "skillCardRef", m.image ?? "");
                    else updateMember(i, "image", m.skillCardRef ?? "");
                  }}>
                  <FormSelectOption value="ref" label="Skill card" />
                  <FormSelectOption value="image" label="Direct image" />
                </FormSelect>
                {m.skillCardRef !== undefined ? (
                  <TextInput style={{ flex: 1, minWidth: "150px" }} value={m.skillCardRef ?? ""} placeholder="skillCardRef name"
                    onChange={(_e, v) => updateMember(i, "skillCardRef", v)} />
                ) : (
                  <TextInput style={{ flex: 1, minWidth: "150px" }} value={m.image ?? ""} placeholder="quay.io/..."
                    onChange={(_e, v) => updateMember(i, "image", v)} />
                )}
                <Button variant="plain" size="sm" isDisabled={i === 0} onClick={() => moveUp(i)}>&#9650;</Button>
                <Button variant="plain" size="sm" isDisabled={i === members.length - 1} onClick={() => moveDown(i)}>&#9660;</Button>
                <Button variant="plain" size="sm" onClick={() => setMembers((prev) => prev.filter((_, j) => j !== i))}>
                  Remove
                </Button>
              </div>
            ))}
            <Button variant="link" size="sm" onClick={() => setMembers((prev) => [...prev, emptyMember()])}>
              Add skill
            </Button>
          </FormGroup>
        </Form>
      </ModalBody>
      <ModalFooter>
        <Button variant="primary" isDisabled={!canSubmit} isLoading={submitting} onClick={() => void submit()}>
          {isEdit ? "Save" : "Create"}
        </Button>
        <Button variant="link" isDisabled={submitting} onClick={onClose}>Cancel</Button>
      </ModalFooter>
    </Modal>
  );
}
