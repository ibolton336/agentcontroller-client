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
  Spinner,
  TextArea,
  TextInput,
} from "@patternfly/react-core";
import type { AgentParam, AgentResource } from "@konveyor/agentic-client/contract";
import type { ShimClient } from "@konveyor/agentic-client/transport-shim";
import { errorMessage, truncate } from "../format";

interface CreateRunModalProps {
  api: ShimClient;
  onClose: () => void;
  onCreated: (runName: string) => void;
}

function defaultsFor(agent: AgentResource | undefined): Record<string, string> {
  const values: Record<string, string> = {};
  for (const p of agent?.spec.params ?? []) {
    values[p.name] = p.default ?? "";
  }
  return values;
}

function paramHelperText(p: AgentParam): string {
  const parts: string[] = [];
  if (p.description) parts.push(p.description);
  if (p.type && p.type !== "string") parts.push(`type: ${p.type}`);
  if (p.default) parts.push(`default: ${p.default}`);
  return parts.join(" — ");
}

export function CreateRunModal({ api, onClose, onCreated }: CreateRunModalProps) {
  const [agents, setAgents] = useState<AgentResource[] | null>(null);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [agentName, setAgentName] = useState("");
  const [paramValues, setParamValues] = useState<Record<string, string>>({});
  const [instructions, setInstructions] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    api
      .listAgents()
      .then((list) => {
        if (disposed) return;
        setAgents(list);
        const first = list.length > 0 ? list[0] : undefined;
        if (first?.metadata.name) {
          setAgentName(first.metadata.name);
          setParamValues(defaultsFor(first));
        }
      })
      .catch((err) => {
        if (!disposed) setAgentsError(errorMessage(err));
      });
    return () => {
      disposed = true;
    };
  }, [api]);

  const selected = agents?.find((a) => a.metadata.name === agentName);

  const selectAgent = (name: string) => {
    setAgentName(name);
    setParamValues(defaultsFor(agents?.find((a) => a.metadata.name === name)));
  };

  const missingRequired = (selected?.spec.params ?? []).filter(
    (p) => p.required && !(paramValues[p.name] ?? "").trim(),
  );
  const canCreate = !!selected && missingRequired.length === 0 && !submitting;

  const submit = async () => {
    if (!selected || !canCreate) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const params: Record<string, string> = {};
      for (const p of selected.spec.params ?? []) {
        const v = (paramValues[p.name] ?? "").trim();
        if (v) params[p.name] = v; // omit empty optional params
      }
      const created = await api.createRun({
        agentRef: selected.metadata.name ?? agentName,
        params: Object.keys(params).length > 0 ? params : undefined,
        instructions: instructions.trim() || undefined,
      });
      const name = created.metadata.name;
      if (!name) throw new Error("shim returned a created run without metadata.name");
      onCreated(name);
    } catch (err) {
      setSubmitError(errorMessage(err));
      setSubmitting(false);
    }
  };

  return (
    <Modal
      variant={ModalVariant.medium}
      isOpen
      onClose={() => {
        if (!submitting) onClose();
      }}
      aria-labelledby="create-run-title"
    >
      <ModalHeader
        title="Create run"
        labelId="create-run-title"
        description="Creates an AgentRun; the controller provisions a sandbox pod running the agent's ACP server."
      />
      <ModalBody>
        {agentsError && (
          <Alert variant="danger" isInline title="Failed to load agents" style={{ marginBottom: "1rem" }}>
            {agentsError}
          </Alert>
        )}
        {submitError && (
          <Alert variant="danger" isInline title="Create failed" style={{ marginBottom: "1rem" }}>
            {submitError}
          </Alert>
        )}
        {agents === null && !agentsError ? (
          <Spinner aria-label="Loading agents" />
        ) : agents !== null && agents.length === 0 ? (
          <Alert variant="warning" isInline title="No Agent resources found">
            The cluster has no Agent CRs in the shim's namespace, so there is nothing to run.
          </Alert>
        ) : (
          <Form
            id="create-run-form"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <FormGroup label="Agent" isRequired fieldId="create-agent">
              <FormSelect
                id="create-agent"
                value={agentName}
                onChange={(_e, v) => selectAgent(v)}
              >
                {(agents ?? []).map((a) => (
                  <FormSelectOption
                    key={a.metadata.name}
                    value={a.metadata.name}
                    label={a.metadata.name ?? "(unnamed)"}
                  />
                ))}
              </FormSelect>
              {selected?.spec.prompt && (
                <FormHelperText>
                  <HelperText>
                    <HelperTextItem>{truncate(selected.spec.prompt, 160)}</HelperTextItem>
                  </HelperText>
                </FormHelperText>
              )}
            </FormGroup>

            {(selected?.spec.params ?? []).map((p) => {
              const helper = paramHelperText(p);
              return (
                <FormGroup key={p.name} label={p.name} isRequired={p.required} fieldId={`param-${p.name}`}>
                  <TextInput
                    id={`param-${p.name}`}
                    isRequired={p.required}
                    value={paramValues[p.name] ?? ""}
                    onChange={(_e, v) => setParamValues((prev) => ({ ...prev, [p.name]: v }))}
                  />
                  {helper && (
                    <FormHelperText>
                      <HelperText>
                        <HelperTextItem>{helper}</HelperTextItem>
                      </HelperText>
                    </FormHelperText>
                  )}
                </FormGroup>
              );
            })}

            <FormGroup label="Instructions" fieldId="create-instructions">
              <TextArea
                id="create-instructions"
                value={instructions}
                onChange={(_e, v) => setInstructions(v)}
                rows={4}
                resizeOrientation="vertical"
                placeholder="Task-specific instructions, composed with the agent's standing prompt"
              />
            </FormGroup>
          </Form>
        )}
      </ModalBody>
      <ModalFooter>
        <Button variant="primary" isDisabled={!canCreate} isLoading={submitting} onClick={() => void submit()}>
          Create
        </Button>
        <Button variant="link" isDisabled={submitting} onClick={onClose}>
          Cancel
        </Button>
      </ModalFooter>
    </Modal>
  );
}
