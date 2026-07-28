import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Form,
  FormGroup,
  FormHelperText,
  FormSelect,
  FormSelectOption,
  HelperText,
  HelperTextItem,
  Label,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalVariant,
  Spinner,
  TextArea,
  TextInput,
} from "@patternfly/react-core";
import type {
  AgentParam,
  AgentResource,
  AgentResourceSpec,
  LLMProvider,
  SkillCard,
  SkillCollection,
} from "@konveyor/agentic-client/contract";
import { RESOURCE_NAME_PATTERN } from "@konveyor/agentic-client/contract";
import type { ShimClient } from "@konveyor/agentic-client/transport-shim";
import { errorMessage } from "../format";
import { useImageCatalog, useProviders, ReadyLabel } from "./sources";

interface AgentDesignerModalProps {
  api: ShimClient;
  existing?: AgentResource;
  onClose: () => void;
  onSaved: () => void;
}

const emptyParam = (): AgentParam => ({ name: "", type: "string" });

export function AgentDesignerModal({ api, existing, onClose, onSaved }: AgentDesignerModalProps) {
  const isEdit = !!existing;
  const [name, setName] = useState(existing?.metadata.name ?? "");
  const [image, setImage] = useState(existing?.spec.image ?? "");
  const [customImage, setCustomImage] = useState(false);
  const [prompt, setPrompt] = useState(existing?.spec.prompt ?? "");
  const [selectedProviders, setSelectedProviders] = useState<string[]>(
    (existing?.spec.providers ?? []).map((p) => p.ref),
  );
  const [selectedSkillCards, setSelectedSkillCards] = useState<string[]>(
    (existing?.spec.skillCards ?? []).map((s) => s.ref),
  );
  const [selectedSkillCollections, setSelectedSkillCollections] = useState<string[]>(
    (existing?.spec.skillCollections ?? []).map((s) => s.ref),
  );
  const [params, setParams] = useState<AgentParam[]>(existing?.spec.params ?? []);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const { providers, loading: providersLoading } = useProviders(api);
  const { images } = useImageCatalog(api);
  const [skillCards, setSkillCards] = useState<SkillCard[] | null>(null);
  const [skillCollections, setSkillCollections] = useState<SkillCollection[] | null>(null);

  useEffect(() => {
    let d = false;
    api.listSkillCards().then((list) => { if (!d) setSkillCards(list); }).catch(() => {});
    api.listSkillCollections().then((list) => { if (!d) setSkillCollections(list); }).catch(() => {});
    return () => { d = true; };
  }, [api]);

  useEffect(() => {
    if (images.length > 0 && image && !images.some((i) => i.image === image)) {
      setCustomImage(true);
    }
  }, [images, image]);

  const totalSkills = selectedSkillCards.length + selectedSkillCollections.length;
  const nameValid = !name || RESOURCE_NAME_PATTERN.test(name);

  const canSubmit =
    name.trim() !== "" &&
    nameValid &&
    image.trim() !== "" &&
    selectedProviders.length > 0 &&
    !submitting;

  const toggleProvider = (ref: string) => {
    setSelectedProviders((prev) =>
      prev.includes(ref) ? prev.filter((r) => r !== ref) : [...prev, ref],
    );
  };

  const updateParam = (index: number, field: keyof AgentParam, value: string | boolean) => {
    setParams((prev) => prev.map((p, i) => (i === index ? { ...p, [field]: value } : p)));
  };

  const submit = async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const spec: AgentResourceSpec = {
        image,
        prompt: prompt.trim() || undefined,
        providers: selectedProviders.map((ref) => ({ ref })),
        skillCards: selectedSkillCards.length > 0 ? selectedSkillCards.map((ref) => ({ ref })) : undefined,
        skillCollections: selectedSkillCollections.length > 0 ? selectedSkillCollections.map((ref) => ({ ref })) : undefined,
        params: params.filter((p) => p.name.trim()).length > 0
          ? params.filter((p) => p.name.trim())
          : undefined,
      };
      if (isEdit) {
        await api.updateAgent(name, spec);
      } else {
        await api.createAgent(name, spec);
      }
      onSaved();
    } catch (err) {
      setSubmitError(errorMessage(err));
      setSubmitting(false);
    }
  };

  return (
    <Modal variant={ModalVariant.large} isOpen onClose={() => { if (!submitting) onClose(); }} aria-labelledby="agent-designer-title">
      <ModalHeader title={isEdit ? `Edit agent: ${name}` : "Create agent"} labelId="agent-designer-title" />
      <ModalBody>
        {submitError && <Alert variant="danger" isInline title="Save failed" style={{ marginBottom: "1rem" }}>{submitError}</Alert>}

        {totalSkills === 0 && (
          <Alert variant="danger" isInline title="No skills selected" style={{ marginBottom: "1rem" }}>
            The harness fatals when an agent has zero skills. Select at least one skill card or collection.
          </Alert>
        )}

        <Form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <FormGroup label="Name" isRequired fieldId="agent-name">
            <TextInput id="agent-name" isRequired isDisabled={isEdit} value={name}
              onChange={(_e, v) => setName(v)} validated={nameValid ? "default" : "error"} />
            {!nameValid && (
              <FormHelperText><HelperText><HelperTextItem variant="error">
                Must be a valid DNS-1123 name (lowercase, digits, hyphens)
              </HelperTextItem></HelperText></FormHelperText>
            )}
          </FormGroup>

          <FormGroup label="Image" isRequired fieldId="agent-image">
            {!customImage && images.length > 0 ? (
              <>
                <FormSelect id="agent-image" value={image} onChange={(_e, v) => {
                  if (v === "__custom__") { setCustomImage(true); setImage(""); }
                  else setImage(v);
                }}>
                  <FormSelectOption value="" label="Select an image…" isDisabled />
                  {images.map((img) => (
                    <FormSelectOption key={img.name} value={img.image}
                      label={`${img.displayName} — ${img.image}`} />
                  ))}
                  <FormSelectOption value="__custom__" label="Custom image…" />
                </FormSelect>
              </>
            ) : (
              <TextInput id="agent-image" isRequired value={image}
                onChange={(_e, v) => setImage(v)} placeholder="quay.io/konveyor/agent-java:dev" />
            )}
          </FormGroup>

          <FormGroup label="Prompt" fieldId="agent-prompt">
            <TextArea id="agent-prompt" value={prompt} onChange={(_e, v) => setPrompt(v)}
              rows={4} resizeOrientation="vertical" placeholder="Standing instructions for this agent" />
          </FormGroup>

          <FormGroup label="Providers" isRequired fieldId="agent-providers">
            {providersLoading ? <Spinner size="md" /> : providers.length === 0 ? (
              <Alert variant="warning" isInline title="No LLMProviders found" />
            ) : (
              providers.map((p) => {
                const ref = p.metadata.name!;
                const idx = selectedProviders.indexOf(ref);
                return (
                  <div key={ref} style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.25rem" }}>
                    <Checkbox id={`prov-${ref}`} isChecked={idx >= 0} onChange={() => toggleProvider(ref)}
                      label={`${ref} (${p.spec.models.map((m) => m.name).join(", ")})`} />
                    {idx === 0 && <Label color="blue" isCompact>1st</Label>}
                  </div>
                );
              })
            )}
          </FormGroup>

          <FormGroup label="Skill cards" fieldId="agent-skills">
            {skillCards === null ? <Spinner size="md" /> : skillCards.length === 0 ? (
              <Alert variant="info" isInline title="No skill cards in the cluster" />
            ) : (
              skillCards.map((sc) => {
                const ref = sc.metadata.name!;
                return (
                  <div key={ref} style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.25rem" }}>
                    <Checkbox id={`sc-${ref}`}
                      isChecked={selectedSkillCards.includes(ref)}
                      onChange={(_e, checked) => setSelectedSkillCards((prev) =>
                        checked ? [...prev, ref] : prev.filter((r) => r !== ref)
                      )}
                      label={sc.spec.displayName ?? ref} />
                    <ReadyLabel conditions={sc.status?.conditions} />
                    {sc.status?.resolvedImage && <code style={{ fontSize: "0.75em", opacity: 0.7 }}>{sc.status.resolvedImage}</code>}
                  </div>
                );
              })
            )}
          </FormGroup>

          <FormGroup label="Skill collections" fieldId="agent-collections">
            {skillCollections === null ? <Spinner size="md" /> : skillCollections.length === 0 ? (
              <Alert variant="info" isInline title="No skill collections in the cluster" />
            ) : (
              skillCollections.map((col) => {
                const ref = col.metadata.name!;
                return (
                  <div key={ref} style={{ marginBottom: "0.25rem" }}>
                    <Checkbox id={`col-${ref}`}
                      isChecked={selectedSkillCollections.includes(ref)}
                      onChange={(_e, checked) => setSelectedSkillCollections((prev) =>
                        checked ? [...prev, ref] : prev.filter((r) => r !== ref)
                      )}
                      label={`${ref} (${col.spec.skills?.length ?? 0} skills)`} />
                  </div>
                );
              })
            )}
          </FormGroup>

          <FormGroup label="Parameters" fieldId="agent-params">
            {params.map((p, i) => (
              <div key={i} style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginBottom: "0.5rem", flexWrap: "wrap" }}>
                <TextInput style={{ width: "140px" }} value={p.name} placeholder="name"
                  onChange={(_e, v) => updateParam(i, "name", v)} />
                <FormSelect style={{ width: "100px" }} value={p.type ?? "string"}
                  onChange={(_e, v) => updateParam(i, "type", v)}>
                  <FormSelectOption value="string" label="string" />
                  <FormSelectOption value="number" label="number" />
                  <FormSelectOption value="boolean" label="boolean" />
                </FormSelect>
                <TextInput style={{ width: "150px" }} value={p.description ?? ""} placeholder="description"
                  onChange={(_e, v) => updateParam(i, "description", v)} />
                <TextInput style={{ width: "100px" }} value={p.default ?? ""} placeholder="default"
                  onChange={(_e, v) => updateParam(i, "default", v)} />
                <Checkbox id={`param-req-${i}`} label="required" isChecked={!!p.required}
                  isDisabled={!!p.default}
                  onChange={(_e, checked) => updateParam(i, "required", checked)} />
                <Button variant="plain" size="sm" onClick={() => setParams((prev) => prev.filter((_, j) => j !== i))}>
                  Remove
                </Button>
              </div>
            ))}
            <Button variant="link" size="sm" onClick={() => setParams((prev) => [...prev, emptyParam()])}>
              Add parameter
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
