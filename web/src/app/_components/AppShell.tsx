"use client";

import { ReactNode, useState } from "react";
import {
  UploadCloud,
  Wand2,
  Clapperboard,
  FlaskConical,
  ScrollText,
  Search,
  Waves,
  PanelLeftClose,
  PanelLeft,
  Users,
  LogOut,
} from "lucide-react";
import type { Me, Person } from "./WorkspaceProvider";

export type ViewKey = "upload" | "studio" | "editor" | "history" | "skills";

const NAV: {
  group: string;
  items: { key: ViewKey; label: string; icon: typeof UploadCloud }[];
}[] = [
  {
    group: "Workspace",
    items: [
      { key: "upload", label: "Upload & Analyze", icon: UploadCloud },
      { key: "studio", label: "Generation Studio", icon: Wand2 },
      { key: "editor", label: "Editor", icon: Clapperboard },
    ],
  },
  {
    group: "Library",
    items: [
      { key: "history", label: "Experiment History", icon: FlaskConical },
      { key: "skills", label: "Prompt Skills", icon: ScrollText },
    ],
  },
];

const TITLES: Record<ViewKey, { title: string; subtitle: string }> = {
  upload: { title: "Upload & Analyze", subtitle: "Decompose a source video with Pegasus 1.5" },
  studio: { title: "Generation Studio", subtitle: "Plan and run model-specific regenerations" },
  editor: { title: "Editor", subtitle: "Trim, cut, reorder and export your clips" },
  history: { title: "Experiment History", subtitle: "Browse and compare your generations" },
  skills: { title: "Prompt Skills", subtitle: "Editable model guidance fed to Gemini" },
};

export function AppShell({
  view,
  onSelect,
  me,
  people,
  viewedPersonId,
  onSelectPerson,
  signOut,
  header,
  children,
}: {
  view: ViewKey | null;
  onSelect: (v: ViewKey) => void;
  me: Me;
  people: Person[];
  viewedPersonId: string | null;
  onSelectPerson: (p: Person) => void;
  signOut: () => void;
  header?: { title: string; subtitle: string };
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const t = header ?? (view ? TITLES[view] : { title: "Workspace", subtitle: "" });
  const others = people.filter((p) => p.id !== me.id);

  return (
    <div className="flex h-dvh overflow-hidden">
      {/* Sidebar */}
      <aside className={"flex shrink-0 flex-col border-r border-line bg-surface transition-[width] " + (collapsed ? "w-16" : "w-64")}>
        <div className={"flex items-center py-4 " + (collapsed ? "flex-col gap-3 px-2" : "gap-2.5 px-5")}>
          <div className="flex size-8 items-center justify-center rounded-lg bg-brand-600 text-white shadow-sm shadow-brand-600/30">
            <Waves className="size-4.5" strokeWidth={2.5} />
          </div>
          {!collapsed && (
            <div className="leading-tight">
              <div className="text-[15px] font-semibold tracking-tight">Echoes</div>
              <div className="text-[10px] font-medium uppercase tracking-wider text-ink-400">beta</div>
            </div>
          )}
          <button
            onClick={() => setCollapsed((c) => !c)}
            title={collapsed ? "Expand" : "Collapse"}
            className={"rounded-md p-1.5 text-ink-400 transition hover:bg-canvas hover:text-ink-700 " + (collapsed ? "" : "ml-auto")}
          >
            {collapsed ? <PanelLeft className="size-4" /> : <PanelLeftClose className="size-4" />}
          </button>
        </div>

        {!collapsed && (
          <div className="px-3 pb-2">
            <button className="flex w-full items-center gap-2 rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-ink-400 transition hover:border-brand-200 hover:text-ink-500">
              <Search className="size-4" />
              <span>Quick actions</span>
              <kbd className="ml-auto rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-[10px] text-ink-400">⌘K</kbd>
            </button>
          </div>
        )}

        <nav className={"flex-1 overflow-y-auto py-2 " + (collapsed ? "px-2" : "px-3")}>
          {NAV.map((section) => (
            <div key={section.group} className="mb-4">
              {!collapsed && (
                <div className="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-400">{section.group}</div>
              )}
              <div className="space-y-0.5">
                {section.items.map((item) => {
                  const Icon = item.icon;
                  const isActive = !viewedPersonId && view === item.key;
                  return (
                    <button
                      key={item.key}
                      onClick={() => onSelect(item.key)}
                      title={collapsed ? item.label : undefined}
                      className={
                        "flex w-full items-center rounded-lg text-sm transition " +
                        (collapsed ? "justify-center p-2 " : "gap-2.5 px-2.5 py-2 ") +
                        (isActive ? "bg-brand-50 font-medium text-brand-700" : "text-ink-700 hover:bg-canvas")
                      }
                    >
                      <Icon className={"size-4.5 " + (isActive ? "text-brand-600" : "text-ink-400")} />
                      {!collapsed && <span>{item.label}</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}

          {/* People — other collaborators' workspaces (read-only) */}
          <div className="mb-4">
            {!collapsed && (
              <div className="flex items-center gap-1.5 px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-400">
                <Users className="size-3" /> People
              </div>
            )}
            <div className="space-y-0.5">
              {others.length === 0 && !collapsed && (
                <p className="px-2.5 py-1 text-[11px] text-ink-400">No one else yet.</p>
              )}
              {others.map((p) => {
                const isActive = viewedPersonId === p.id;
                return (
                  <button
                    key={p.id}
                    onClick={() => onSelectPerson(p)}
                    title={collapsed ? p.username : undefined}
                    className={
                      "flex w-full items-center rounded-lg text-sm transition " +
                      (collapsed ? "justify-center p-2 " : "gap-2.5 px-2.5 py-2 ") +
                      (isActive ? "bg-brand-50 font-medium text-brand-700" : "text-ink-700 hover:bg-canvas")
                    }
                  >
                    <span className={"flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold " + (isActive ? "bg-brand-600 text-white" : "bg-canvas text-ink-500")}>
                      {p.username.slice(0, 1).toUpperCase()}
                    </span>
                    {!collapsed && <span className="truncate">{p.username}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        </nav>

        {/* Current user */}
        <div className={"border-t border-line " + (collapsed ? "p-2" : "p-3")}>
          <div className={"flex items-center rounded-lg " + (collapsed ? "justify-center" : "gap-2.5 px-1.5 py-1.5")}>
            <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand-100 text-sm font-semibold text-brand-700">{me.username.slice(0, 1).toUpperCase()}</div>
            {!collapsed && (
              <>
                <div className="min-w-0 flex-1 leading-tight">
                  <div className="truncate text-sm font-medium">{me.username}</div>
                  <div className="truncate text-[11px] text-ink-400">your workspace</div>
                </div>
                <button onClick={signOut} title="Switch user" className="rounded-md p-1.5 text-ink-400 transition hover:bg-canvas hover:text-ink-700"><LogOut className="size-4" /></button>
              </>
            )}
          </div>
        </div>
      </aside>

      {/* Main */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-line bg-surface/80 px-8 py-4 backdrop-blur">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">{t.title}</h1>
            {t.subtitle && <p className="text-sm text-ink-500">{t.subtitle}</p>}
          </div>
          <span className="rounded-full border border-line bg-canvas px-3 py-1 text-xs font-medium text-ink-500">{viewedPersonId ? "Read-only" : "Cloud"}</span>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto px-8 py-7">
          <div className={view === "editor" && !viewedPersonId ? "mx-auto h-full w-full max-w-7xl" : "mx-auto w-full max-w-5xl"}>{children}</div>
        </main>
      </div>
    </div>
  );
}
