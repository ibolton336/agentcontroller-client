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
import {
  CREDENTIAL_SOURCES_ANNOTATION,
  SOURCE_APPLICATION_IDENTITY,
  SOURCE_APPLICATION_REPOSITORY_BRANCH,
  SOURCE_APPLICATION_REPOSITORY_URL,
  parseSourcesAnnotation,
} from "@konveyor/agentic-client/contract";
import type { AgentParam, AgentResource, Application } from "@konveyor/agentic-client/contract";
import type { ShimClient } from "@konveyor/agentic-client/transport-shim";
import { errorMessage, truncate } from "../format";

/**
 * Human names for the source identifiers this UI recognizes. Membership in
 * this map IS the recognition test (ADR 0005 fail-open): a param whose
 * source is absent here is treated as caller-supplied and gets a form
 * field, so a newer agent stays usable from an older UI.
 */
const SOURCE_LABELS: Record<string, string> = {
  [SOURCE_APPLICATION_REPOSITORY_URL]: "application repository URL",
  [SOURCE_APPLICATION_REPOSITORY_BRANCH]: "application repository branch",
  [SOURCE_APPLICATION_IDENTITY]: "application identity",
};

const isRecognized = (source: string | undefined): boolean =>
  source !== undefined && source in SOURCE_LABELS;

/** Mirror of the platform's resolution, for previewing values in the form. */
function previewValue(source: string, app: Application | undefined): string | undefined {
  if (!app) return undefined;
  if (source === SOURCE_APPLICATION_REPOSITORY_URL) return app.repository?.url;
  if (source === SOURCE_APPLICATION_REPOSITORY_BRANCH) return app.repository?.branch;
  return undefined;
}

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
  const [applications, setApplications] = useState<Application[]>([]);
  const [applicationsError, setApplicationsError] = useState<string | null>(null);
  const [applicationId, setApplicationId] = useState("");
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
    // A failing inventory must not block agents without sources — but for
    // agents that need one, the error is surfaced (see the alert below)
    // rather than leaving a dead form with a disabled Create button.
    api
      .listApplications()
      .then((list) => {
        if (!disposed) setApplications(list);
      })
      .catch((err) => {
        if (!disposed) setApplicationsError(errorMessage(err));
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

  // Partition params: those with a RECOGNIZED source are the platform's job
  // (given an application); everything else — including params whose source
  // this UI does not understand — is a user form field (ADR 0005 fail-open).
  const paramSources = parseSourcesAnnotation(selected);
  const credentialSources = parseSourcesAnnotation(selected, CREDENTIAL_SOURCES_ANNOTATION);
  const allParams = selected?.spec.params ?? [];
  const userParams = allParams.filter((p) => !isRecognized(paramSources[p.name]));
  const platformParams = allParams.filter((p) => isRecognized(paramSources[p.name]));
  const platformCredentials = Object.entries(credentialSources).filter(([, s]) => isRecognized(s));
  const needsApplication = platformParams.length > 0 || platformCredentials.length > 0;
  const application = applications.find((a) => a.id === applicationId);

  const missingRequired = userParams.filter((p) => p.required && !(paramValues[p.name] ?? "").trim());
  const missingApplication = needsApplication && !application;
  const canCreate = !!selected && missingRequired.length === 0 && !missingApplication && !submitting;

  const submit = async () => {
    if (!selected || !canCreate) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const params: Record<string, string> = {};
      for (const p of userParams) {
        const v = (paramValues[p.name] ?? "").trim();
        if (v) params[p.name] = v; // omit empty optional params
      }
      const created = await api.createRun({
        agentRef: selected.metadata.name ?? agentName,
        params: Object.keys(params).length > 0 ? params : undefined,
        instructions: instructions.trim() || undefined,
        applicationRef: needsApplication ? application?.id : undefined,
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

            {needsApplication && applicationsError && (
              <Alert variant="danger" isInline title="Failed to load applications">
                {applicationsError} — this agent resolves its inputs from an application, so a run
                cannot be created until the inventory loads.
              </Alert>
            )}
            {needsApplication && !applicationsError && applications.length === 0 && (
              <Alert variant="warning" isInline title="No applications available">
                This agent resolves its inputs from an application, but the platform's inventory is
                empty.
              </Alert>
            )}

            {needsApplication && (
              <FormGroup label="Application" isRequired fieldId="create-application">
                <FormSelect
                  id="create-application"
                  value={applicationId}
                  onChange={(_e, v) => setApplicationId(v)}
                >
                  <FormSelectOption value="" label="Select an application…" isDisabled />
                  {applications.map((a) => (
                    <FormSelectOption key={a.id} value={a.id} label={a.name} />
                  ))}
                </FormSelect>
                <FormHelperText>
                  <HelperText>
                    <HelperTextItem>
                      This agent takes its inputs from an application; the platform resolves them
                      on create.
                    </HelperTextItem>
                  </HelperText>
                </FormHelperText>
              </FormGroup>
            )}

            {needsApplication && (
              <div className="resolved-params">
                {platformParams.map((p) => {
                  const source = paramSources[p.name];
                  const value = previewValue(source, application);
                  return (
                    <div key={p.name} className="resolved-param">
                      <code>{p.name}</code>
                      <span className="resolved-param-source">
                        ← {SOURCE_LABELS[source] ?? source}
                      </span>
                      {value && <span className="resolved-param-value">{truncate(value, 60)}</span>}
                    </div>
                  );
                })}
                {platformCredentials.map(([name, source]) => (
                  <div key={`cred-${name}`} className="resolved-param">
                    <code>{name} credentials</code>
                    <span className="resolved-param-source">
                      ← {SOURCE_LABELS[source] ?? source}
                    </span>
                    {application &&
                      (application.identitySecret ? (
                        <span className="resolved-param-value">
                          secret: {application.identitySecret}
                        </span>
                      ) : (
                        <span className="resolved-param-value">none on this application</span>
                      ))}
                  </div>
                ))}
              </div>
            )}

            {userParams.map((p) => {
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
