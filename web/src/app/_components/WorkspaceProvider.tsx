"use client";

import { createContext, useContext, useState, useEffect, ReactNode } from "react";
import { useMutation } from "convex/react";
import { Waves, Loader2, ArrowRight } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";

export type Me = { id: Id<"workspaces">; username: string };
export type Person = { id: Id<"workspaces">; username: string };
type Ctx = { me: Me; signOut: () => void };

const WorkspaceCtx = createContext<Ctx | null>(null);
export const useWorkspace = (): Ctx => {
  const c = useContext(WorkspaceCtx);
  if (!c) throw new Error("useWorkspace must be used inside WorkspaceProvider");
  return c;
};

const LS_KEY = "echoes.me.v1";

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (raw) setMe(JSON.parse(raw));
    } catch {}
    setReady(true);
  }, []);

  const signIn = (m: Me) => { setMe(m); try { localStorage.setItem(LS_KEY, JSON.stringify(m)); } catch {} };
  const signOut = () => { setMe(null); try { localStorage.removeItem(LS_KEY); } catch {} };

  if (!ready) return null;
  if (!me) return <LoginGate onIn={signIn} />;
  return <WorkspaceCtx.Provider value={{ me, signOut }}>{children}</WorkspaceCtx.Provider>;
}

function LoginGate({ onIn }: { onIn: (m: Me) => void }) {
  const signIn = useMutation(api.workspaces.signIn);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      const r = await signIn({ username, password });
      onIn({ id: r.id, username: r.username });
    } catch (e) {
      setErr(e instanceof Error ? e.message.replace(/^.*Error:\s*/, "") : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-3 flex size-11 items-center justify-center rounded-xl bg-brand-600 text-white shadow-sm shadow-brand-600/30">
            <Waves className="size-6" strokeWidth={2.5} />
          </div>
          <h1 className="text-xl font-semibold tracking-tight">Echoes</h1>
          <p className="mt-1 text-sm text-ink-500">Pick a name to enter your workspace.</p>
        </div>
        <div className="space-y-3 rounded-2xl border border-line bg-surface p-5 shadow-sm">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-ink-500">Your name</span>
            <input
              autoFocus value={username} onChange={(e) => setUsername(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
              placeholder="e.g. Sam"
              className="w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm focus:border-brand-400 focus:bg-surface focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-ink-500">Access password</span>
            <input
              type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
              placeholder="Shared password"
              className="w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm focus:border-brand-400 focus:bg-surface focus:outline-none"
            />
          </label>
          {err && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</p>}
          <button
            onClick={submit} disabled={busy || !username.trim() || !password}
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm shadow-brand-600/25 transition hover:bg-brand-700 disabled:opacity-50"
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <ArrowRight className="size-4" />} Enter workspace
          </button>
        </div>
        <p className="mt-3 text-center text-[11px] text-ink-400">New name = new workspace · existing name reopens yours.</p>
      </div>
    </div>
  );
}
