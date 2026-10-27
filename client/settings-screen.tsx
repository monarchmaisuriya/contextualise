import { type PluginSurfaceProps, useSettings } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Text } from "react-native";
import { snapshotSettings } from "../shared/contracts";

type Key = "snapshotMaxChars" | "turnsPerAgent" | "terminalLines";
const FIELDS: ReadonlyArray<{ key: Key; label: string; hint: string }> = [
  { key: "snapshotMaxChars", label: "Longest tag attachment (characters)", hint: "Default 40,000 (about 10,000 tokens), from 1,000 to 200,000. 0 means the default." },
  { key: "turnsPerAgent", label: "Recent turns per agent", hint: "Default 6, from 1 to 50. 0 means the default." },
  { key: "terminalLines", label: "Terminal lines to attach", hint: "Default 200, from 10 to 5,000. The newest lines are kept. 0 means the default." },
];

export function SnapshotSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(snapshotSettings);
  const [drafts, setDrafts] = useState<Partial<Record<Key, string>>>({});
  const [inputError, setInputError] = useState<string | null>(null);
  if (settings.status === "loading") return <Text style={{ color: theme.colors.foregroundMuted, padding: 16 }}>Loading settings</Text>;
  if (settings.status !== "ready") {
    return (
      <SettingsSection title="Tag attachments">
        <SettingsCard>
          <SettingsAction
            label="These settings are invalid"
            hint="Attaching a tag fails until they are fixed. Resetting restores the defaults."
            error={settings.error}
            actionLabel="Reset to defaults"
            disabled={settings.saving}
            onPress={() => void settings.reset()}
          />
        </SettingsCard>
      </SettingsSection>
    );
  }
  const save = () => {
    const next: Record<string, unknown> = { ...settings.values };
    for (const { key, label } of FIELDS) {
      const draft = drafts[key]?.trim();
      if (draft === undefined) continue;
      if (!/^\d+$/.test(draft)) {
        setInputError(`Enter a whole number for "${label}" (got "${draft}").`);
        return;
      }
      next[key] = Number(draft);
    }
    const parsed = snapshotSettings.schema.safeParse(next);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = FIELDS.find(({ key }) => key === issue?.path[0]);
      setInputError(`${field ? `"${field.label}": ` : ""}${issue?.message ?? "invalid value"}`);
      return;
    }
    setInputError(null);
    void settings.save(parsed.data, settings.revision).then((saved) => saved && setDrafts({}));
  };
  return (
    <SettingsSection title="Attachments">
      <SettingsCard>
        {FIELDS.map(({ key, label, hint }) => (
          // Keyed by revision so a save shows the stored value (0 becomes the default), not the typed text.
          <SettingsInput
            key={`${key}:${settings.revision}`}
            label={label}
            hint={hint}
            initialValue={String(settings.values[key])}
            disabled={settings.saving}
            onChangeText={(text) => setDrafts((current) => ({ ...current, [key]: text }))}
          />
        ))}
        <SettingsAction label="" actionLabel="Save" disabled={settings.saving || Object.keys(drafts).length === 0} error={inputError ?? settings.saveError} onPress={save} />
      </SettingsCard>
    </SettingsSection>
  );
}
