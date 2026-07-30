import { useEffect, useState } from "react";
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
  TextArea,
  TextInput,
} from "@patternfly/react-core";
import type {
  AgentWorkload,
  AgentWorkloadSpec,
  AgentWorkloadStage,
  AgentResource,
} from "@konveyor/agentic-client/contract";
import { RESOURCE_NAME_PATTERN, STAGE_NAME_PATTERN } from "@konveyor/agentic-client/contract";
import type { ShimClient } from "@konveyor/agentic-client/transport-shim";
import { errorMessage } from "../format";

interface WorkloadComposerModalProps {
  api: ShimClient;
  existing?: AgentWorkload;
  onClose: () => void;
  onSaved: () => void;
}

const emptyStage = (): AgentWorkloadStage => ({ name: "", agentRef: "", instructions: "" });

export function WorkloadComposerModal({ api, existing, onClose, onSaved }: WorkloadComposerModalProps) {
  const isEdit = !!existing;
  const [name, setName] = useState(existing?.metadata.name ?? "");
  const [guide, setGuide] = useState(existing?.spec.guide ?? "");
  const [stages, setStages] = useState<AgentWorkloadStage[]>(
    existing?.spec.stages.length ? [...existing.spec.stages] : [emptyStage()],
  );
  const [agents, setAgents] = useState<AgentResource[] | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    let d = false;
    api.listAgents().then((list) => { if (!d) setAgents(list); }).catch(() => {});
    return () => { d = true; };
  }, [api]);

  const nameValid = !name || RESOURCE_NAME_PATTERN.test(name);
  const stagesValid = stages.every((s) => s.name.trim() && STAGE_NAME_PATTERN.test(s.name) && s.agentRef);
  const validStages = stages.filter((s) => s.name.trim() && s.agentRef);

  const providerOverlap = (() => {
    if (!agents || validStages.length < 2) return false;
    const providerSets = validStages.map((s) => {
      const agent = agents.find((a) => a.metadata.name === s.agentRef);
      return new Set((agent?.spec.providers ?? []).map((p) => p.ref));
    });
    const first = providerSets[0];
    if (!first || first.size === 0) return true;
    return providerSets.some((s) => {
      for (const p of first) { if (!s.has(p)) return true; }
      return false;
    });
  })();

  const canSubmit = name.trim() !== "" && nameValid && validStages.length > 0 && stagesValid && !submitting;

  const updateStage = (i: number, field: keyof AgentWorkloadStage, value: string) => {
    setStages((prev) => prev.map((s, j) => (j === i ? { ...s, [field]: value } : s)));
  };

  const moveUp = (i: number) => {
    if (i === 0) return;
    setStages((prev) => { const a = [...prev]; [a[i - 1], a[i]] = [a[i]!, a[i - 1]!]; return a; });
  };
  const moveDown = (i: number) => {
    setStages((prev) => {
      if (i >= prev.length - 1) return prev;
      const a = [...prev]; [a[i], a[i + 1]] = [a[i + 1]!, a[i]!]; return a;
    });
  };

  const submit = async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const spec: AgentWorkloadSpec = {
        guide: guide.trim() || undefined,
        stages: validStages.map((s) => ({
          name: s.name,
          agentRef: s.agentRef,
          instructions: s.instructions?.trim() || undefined,
        })),
      };
      if (isEdit) {
        await api.updateWorkload(name, spec);
      } else {
        await api.createWorkload(name, spec);
      }
      onSaved();
    } catch (err) {
      setSubmitError(errorMessage(err));
      setSubmitting(false);
    }
  };

  return (
    <Modal variant={ModalVariant.large} isOpen onClose={() => { if (!submitting) onClose(); }}
      aria-labelledby="workload-composer-title">
      <ModalHeader title={isEdit ? `Edit workload: ${name}` : "Create workload"} labelId="workload-composer-title" />
      <ModalBody>
        {submitError && <Alert variant="danger" isInline title="Save failed" style={{ marginBottom: "1rem" }}>{submitError}</Alert>}

        <Alert variant="info" isInline title="Stage chaining is artifact-based" style={{ marginBottom: "1rem" }}>
          Each stage commits its output to TARGET_BRANCH. The next stage&apos;s skill reads from the same
          branch. There is no mechanism that feeds one stage&apos;s prompt/output into the next stage&apos;s prompt.
        </Alert>

        {providerOverlap && (
          <Alert variant="warning" isInline title="Provider overlap" style={{ marginBottom: "1rem" }}>
            The stage agents reference different providers. All stages share a single model selection
            at run time — ensure every stage agent has a common provider.
          </Alert>
        )}

        <Form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <FormGroup label="Name" isRequired fieldId="pb-name">
            <TextInput id="pb-name" isRequired isDisabled={isEdit} value={name}
              onChange={(_e, v) => setName(v)} validated={nameValid ? "default" : "error"} />
            {!nameValid && (
              <FormHelperText><HelperText><HelperTextItem variant="error">
                Must be a valid DNS-1123 name
              </HelperTextItem></HelperText></FormHelperText>
            )}
          </FormGroup>

          <FormGroup label="Guide" fieldId="pb-guide">
            <TextArea id="pb-guide" value={guide} onChange={(_e, v) => setGuide(v)}
              rows={3} resizeOrientation="vertical" placeholder="High-level guidance for this workload" />
          </FormGroup>

          <FormGroup label="Stages" isRequired fieldId="pb-stages">
            {stages.map((s, i) => {
              const nameOk = !s.name || STAGE_NAME_PATTERN.test(s.name);
              return (
                <div key={i} style={{ padding: "0.75rem", border: "1px solid #d2d2d2", borderRadius: "4px", marginBottom: "0.5rem" }}>
                  <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginBottom: "0.5rem" }}>
                    <TextInput style={{ width: "180px" }} value={s.name} placeholder="stage name (label-safe)"
                      onChange={(_e, v) => updateStage(i, "name", v)}
                      validated={nameOk ? "default" : "error"} />
                    <FormSelect style={{ width: "200px" }} value={s.agentRef}
                      onChange={(_e, v) => updateStage(i, "agentRef", v)}>
                      <FormSelectOption value="" label="Select agent…" isDisabled />
                      {(agents ?? []).map((a) => (
                        <FormSelectOption key={a.metadata.name} value={a.metadata.name!} label={a.metadata.name!} />
                      ))}
                    </FormSelect>
                    <Button variant="plain" size="sm" isDisabled={i === 0} onClick={() => moveUp(i)}>&#9650;</Button>
                    <Button variant="plain" size="sm" isDisabled={i === stages.length - 1} onClick={() => moveDown(i)}>&#9660;</Button>
                    <Button variant="plain" size="sm" onClick={() => setStages((prev) => prev.filter((_, j) => j !== i))}>
                      Remove
                    </Button>
                  </div>
                  {!nameOk && (
                    <FormHelperText><HelperText><HelperTextItem variant="error">
                      Stage names must be label-safe: lowercase, digits, hyphens
                    </HelperTextItem></HelperText></FormHelperText>
                  )}
                  <TextArea value={s.instructions ?? ""} onChange={(_e, v) => updateStage(i, "instructions", v)}
                    rows={2} resizeOrientation="vertical" placeholder="Stage-specific instructions (optional)" />
                </div>
              );
            })}
            <Button variant="link" size="sm" onClick={() => setStages((prev) => [...prev, emptyStage()])}>
              Add stage
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
