"use client";

import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { Loader2, Check } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { MODELS, type ModelId } from "../../../convex/models";

export function PromptSkills() {
  const skills = useQuery(api.promptSkills.listActive);
  const seed = useMutation(api.promptSkills.seedDefaults);

  if (skills === undefined) return <p className="text-sm text-ink-400">Loading…</p>;

  return (
    <div className="space-y-5">
      <p className="text-sm text-ink-500">
        Editable, versioned guidance fed to Gemini when it plans each model&apos;s calls. Saving creates a new active
        version.
      </p>
      {skills.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-line bg-surface p-8 text-center">
          <p className="text-sm text-ink-400">No prompt skills yet.</p>
          <button
            onClick={() => seed({})}
            className="mt-3 rounded-lg bg-brand-600 px-3.5 py-2 text-sm font-medium text-white shadow-sm shadow-brand-600/25 hover:bg-brand-700"
          >
            Seed defaults
          </button>
        </div>
      ) : (
        skills.map((s) => <SkillCard key={s._id} skill={s} />)
      )}
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function SkillCard({ skill }: { skill: any }) {
  const save = useMutation(api.promptSkills.saveVersion);
  const [content, setContent] = useState<string>(skill.content);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const dirty = content !== skill.content;
  const label = MODELS[skill.modelId as ModelId]?.label ?? skill.modelId;

  const onSave = async () => {
    setSaving(true);
    setSaved(false);
    try {
      await save({ modelId: skill.modelId, skillName: skill.skillName, content });
      setSaved(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-sm">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <span className="text-sm font-semibold text-ink-900">{skill.skillName}</span>
        <span className="rounded bg-brand-50 px-1.5 py-0.5 text-[11px] font-medium text-brand-700">{label}</span>
        <span className="text-xs text-ink-400">v{skill.version}</span>
        <div className="ml-auto flex items-center gap-2">
          {saved && !dirty && <span className="text-xs text-emerald-600">saved</span>}
          <button
            onClick={onSave}
            disabled={!dirty || saving}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm shadow-brand-600/25 hover:bg-brand-700 disabled:opacity-40"
          >
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
            Save as v{skill.version + 1}
          </button>
        </div>
      </div>
      <textarea
        value={content}
        onChange={(e) => {
          setContent(e.target.value);
          setSaved(false);
        }}
        rows={16}
        className="w-full resize-y bg-surface p-4 font-mono text-xs leading-relaxed text-ink-700 focus:outline-none"
      />
    </div>
  );
}
