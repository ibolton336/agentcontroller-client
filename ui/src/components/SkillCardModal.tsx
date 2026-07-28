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
import type { SkillCard, SkillCardSpec } from "@konveyor/agentic-client/contract";
import { RESOURCE_NAME_PATTERN } from "@konveyor/agentic-client/contract";
import type { ShimClient } from "@konveyor/agentic-client/transport-shim";
import { errorMessage } from "../format";

interface SkillCardModalProps {
  api: ShimClient;
  existing?: SkillCard;
  onClose: () => void;
  onSaved: () => void;
}

export function SkillCardModal({ api, existing, onClose, onSaved }: SkillCardModalProps) {
  const isEdit = !!existing;
  const [name, setName] = useState(existing?.metadata.name ?? "");
  const [displayName, setDisplayName] = useState(existing?.spec.displayName ?? "");
  const [description, setDescription] = useState(existing?.spec.description ?? "");
  const [type, setType] = useState<string>(existing?.spec.type ?? "skill");
  const [image, setImage] = useState(existing?.spec.image ?? "");
  const [version, setVersion] = useState(existing?.spec.version ?? "");
  const [tags, setTags] = useState((existing?.spec.tags ?? []).join(", "));
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const nameValid = !name || RESOURCE_NAME_PATTERN.test(name);
  const hadNonImage = isEdit && !existing?.spec.image && (existing?.spec.inline || existing?.spec.source);

  const canSubmit = name.trim() !== "" && nameValid && image.trim() !== "" && !submitting;

  const submit = async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const spec: SkillCardSpec = {
        displayName: displayName.trim() || undefined,
        description: description.trim() || undefined,
        type: type as "skill" | "rule",
        image,
        version: version.trim() || undefined,
        tags: tags.split(",").map((t) => t.trim()).filter(Boolean).length > 0
          ? tags.split(",").map((t) => t.trim()).filter(Boolean) : undefined,
      };
      if (isEdit) {
        await api.updateSkillCard(name, spec);
      } else {
        await api.createSkillCard(name, spec);
      }
      onSaved();
    } catch (err) {
      setSubmitError(errorMessage(err));
      setSubmitting(false);
    }
  };

  return (
    <Modal variant={ModalVariant.medium} isOpen onClose={() => { if (!submitting) onClose(); }}
      aria-labelledby="skillcard-modal-title">
      <ModalHeader title={isEdit ? `Edit skill card: ${name}` : "Create skill card"} labelId="skillcard-modal-title" />
      <ModalBody>
        {submitError && <Alert variant="danger" isInline title="Save failed" style={{ marginBottom: "1rem" }}>{submitError}</Alert>}
        {hadNonImage && (
          <Alert variant="warning" isInline title="Source type change" style={{ marginBottom: "1rem" }}>
            This card uses {existing?.spec.inline ? "inline" : "git source"} content. Saving will convert it to
            image-ref (the only Ready kind today). The original content will be replaced.
          </Alert>
        )}

        <Form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <FormGroup label="Name" isRequired fieldId="sc-name">
            <TextInput id="sc-name" isRequired isDisabled={isEdit} value={name}
              onChange={(_e, v) => setName(v)} validated={nameValid ? "default" : "error"} />
            {!nameValid && (
              <FormHelperText><HelperText><HelperTextItem variant="error">
                Must be a valid DNS-1123 name
              </HelperTextItem></HelperText></FormHelperText>
            )}
          </FormGroup>
          <FormGroup label="Display name" fieldId="sc-display">
            <TextInput id="sc-display" value={displayName} onChange={(_e, v) => setDisplayName(v)} />
          </FormGroup>
          <FormGroup label="Description" fieldId="sc-desc">
            <TextInput id="sc-desc" value={description} onChange={(_e, v) => setDescription(v)} />
          </FormGroup>
          <FormGroup label="Type" fieldId="sc-type">
            <FormSelect id="sc-type" value={type} onChange={(_e, v) => setType(v)}>
              <FormSelectOption value="skill" label="Skill" />
              <FormSelectOption value="rule" label="Rule" />
            </FormSelect>
          </FormGroup>
          <FormGroup label="Image" isRequired fieldId="sc-image">
            <TextInput id="sc-image" isRequired value={image}
              onChange={(_e, v) => setImage(v)} placeholder="quay.io/konveyor/skill-analyze-java-ee:v0.1.0" />
            <FormHelperText><HelperText><HelperTextItem>
              OCI image containing the skill content. Image-ref cards are Ready immediately.
            </HelperTextItem></HelperText></FormHelperText>
          </FormGroup>
          <FormGroup label="Version" fieldId="sc-version">
            <TextInput id="sc-version" value={version} onChange={(_e, v) => setVersion(v)} placeholder="0.1.0" />
          </FormGroup>
          <FormGroup label="Tags" fieldId="sc-tags">
            <TextInput id="sc-tags" value={tags} onChange={(_e, v) => setTags(v)} placeholder="java, migration, analysis" />
            <FormHelperText><HelperText><HelperTextItem>Comma-separated</HelperTextItem></HelperText></FormHelperText>
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
