"use client";

import { useState, useEffect } from "react";
import { useQuery } from "convex/react";
import { AppShell, type ViewKey } from "./_components/AppShell";
import { WorkspaceProvider, useWorkspace, type Person } from "./_components/WorkspaceProvider";
import { UploadAnalyze } from "./_components/UploadAnalyze";
import { GenerationStudio } from "./_components/GenerationStudio";
import { Editor } from "./_components/Editor";
import { ExperimentHistory } from "./_components/ExperimentHistory";
import { PromptSkills } from "./_components/PromptSkills";
import { api } from "../../convex/_generated/api";

const ENABLED: ViewKey[] = ["upload", "studio", "editor", "history", "skills"];

export default function Home() {
  return (
    <WorkspaceProvider>
      <AppRoot />
    </WorkspaceProvider>
  );
}

function AppRoot() {
  const { me, signOut } = useWorkspace();
  const people = useQuery(api.workspaces.list) ?? [];
  const [view, setView] = useState<ViewKey>("upload");
  const [person, setPerson] = useState<Person | null>(null);

  // hash-based, deep-linkable view selection (e.g. #studio)
  useEffect(() => {
    const apply = () => {
      const h = window.location.hash.slice(1) as ViewKey;
      if (ENABLED.includes(h)) { setView(h); setPerson(null); }
    };
    apply();
    window.addEventListener("hashchange", apply);
    return () => window.removeEventListener("hashchange", apply);
  }, []);

  const selectView = (v: ViewKey) => { setPerson(null); setView(v); window.location.hash = v; };

  return (
    <AppShell
      view={person ? null : view}
      onSelect={selectView}
      me={me}
      people={people}
      viewedPersonId={person?.id ?? null}
      onSelectPerson={setPerson}
      signOut={signOut}
      header={person ? { title: `${person.username}'s workspace`, subtitle: "Read-only — generations, prompts and assets" } : undefined}
    >
      {person ? (
        <ExperimentHistory workspaceId={person.id} readOnly />
      ) : (
        <>
          {view === "upload" && <UploadAnalyze />}
          {view === "studio" && <GenerationStudio />}
          {view === "editor" && <Editor />}
          {view === "history" && <ExperimentHistory workspaceId={me.id} />}
          {view === "skills" && <PromptSkills />}
        </>
      )}
    </AppShell>
  );
}
