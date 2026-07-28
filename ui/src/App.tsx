import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Masthead,
  MastheadBrand,
  MastheadContent,
  MastheadMain,
  Page,
  PageSection,
  Title,
  ToggleGroup,
  ToggleGroupItem,
} from "@patternfly/react-core";
import { ShimClient } from "@konveyor/agentic-client/transport-shim";
import { errorMessage } from "./format";
import { RunsPage } from "./components/RunsPage";
import { RunDetailPage } from "./components/RunDetailPage";
import { AgentsPage } from "./components/AgentsPage";
import { SkillsPage } from "./components/SkillsPage";
import { PlaybooksPage } from "./components/PlaybooksPage";

const SHIM_URL =
  import.meta.env.VITE_SHIM_URL ??
  (import.meta.env.DEV ? "http://127.0.0.1:7080" : window.location.origin);

type View =
  | { kind: "runs" }
  | { kind: "detail"; runName: string }
  | { kind: "agents" }
  | { kind: "skills" }
  | { kind: "playbooks" };

function viewToHash(v: View): string {
  switch (v.kind) {
    case "runs": return "#/runs";
    case "detail": return `#/runs/${encodeURIComponent(v.runName)}`;
    case "agents": return "#/agents";
    case "skills": return "#/skills";
    case "playbooks": return "#/playbooks";
  }
}

function hashToView(hash: string): View {
  const h = hash.startsWith("#") ? hash.slice(1) : hash;
  if (h === "/agents") return { kind: "agents" };
  if (h === "/skills") return { kind: "skills" };
  if (h === "/playbooks") return { kind: "playbooks" };
  const runMatch = /^\/runs\/(.+)$/.exec(h);
  if (runMatch) {
    try {
      return { kind: "detail", runName: decodeURIComponent(runMatch[1]!) };
    } catch {
      return { kind: "runs" };
    }
  }
  return { kind: "runs" };
}

export function App() {
  const [view, setViewState] = useState<View>(() => hashToView(window.location.hash));

  const navigate = useCallback((v: View) => {
    setViewState(v);
    const hash = viewToHash(v);
    if (window.location.hash !== hash) {
      window.history.pushState(null, "", hash);
    }
  }, []);

  useEffect(() => {
    const onHash = () => setViewState(hashToView(window.location.hash));
    window.addEventListener("hashchange", onHash);
    window.addEventListener("popstate", onHash);
    return () => {
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("popstate", onHash);
    };
  }, []);

  const api = useMemo<{ client?: ShimClient; error?: string }>(() => {
    try {
      return { client: new ShimClient(SHIM_URL) };
    } catch (err) {
      return { error: errorMessage(err) };
    }
  }, []);

  const navTab = view.kind === "detail" ? "runs" : view.kind;

  const masthead = (
    <Masthead>
      <MastheadMain>
        <MastheadBrand>
          <Title headingLevel="h1" size="lg" style={{ whiteSpace: "nowrap" }}>
            Konveyor Agentic{" "}
            <span style={{ fontWeight: 400, opacity: 0.7 }}>(prototype)</span>
          </Title>
        </MastheadBrand>
      </MastheadMain>
      <MastheadContent>
        <span className="masthead-shim">shim: {SHIM_URL}</span>
      </MastheadContent>
    </Masthead>
  );

  return (
    <Page masthead={masthead}>
      {api.error || !api.client ? (
        <PageSection>
          <Alert variant="danger" isInline title="Invalid shim URL (VITE_SHIM_URL)">
            {api.error ?? "no client"}
          </Alert>
        </PageSection>
      ) : (
        <>
          {view.kind !== "detail" && (
            <PageSection variant="light" style={{ paddingBottom: 0 }}>
              <ToggleGroup aria-label="Navigation">
                <ToggleGroupItem text="Agent runs" isSelected={navTab === "runs"}
                  onChange={() => navigate({ kind: "runs" })} />
                <ToggleGroupItem text="Agents" isSelected={navTab === "agents"}
                  onChange={() => navigate({ kind: "agents" })} />
                <ToggleGroupItem text="Skills" isSelected={navTab === "skills"}
                  onChange={() => navigate({ kind: "skills" })} />
                <ToggleGroupItem text="Playbooks" isSelected={navTab === "playbooks"}
                  onChange={() => navigate({ kind: "playbooks" })} />
              </ToggleGroup>
            </PageSection>
          )}
          {view.kind === "runs" && (
            <RunsPage api={api.client} onOpenRun={(name) => navigate({ kind: "detail", runName: name })} />
          )}
          {view.kind === "detail" && (
            <RunDetailPage api={api.client} runName={view.runName}
              onBack={() => navigate({ kind: "runs" })}
              onOpenRun={(name) => navigate({ kind: "detail", runName: name })} />
          )}
          {view.kind === "agents" && <AgentsPage api={api.client} />}
          {view.kind === "skills" && <SkillsPage api={api.client} />}
          {view.kind === "playbooks" && <PlaybooksPage api={api.client} />}
        </>
      )}
    </Page>
  );
}
