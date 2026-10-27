import { type PluginSurfaceProps, useSettings } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsRow, SettingsSection, SettingsSelect, SettingsSwitch, TextInput } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Text } from "react-native";
import { type FetchPreference, MAX_CUSTOM_ROUTES, type SnapshotSettings, snapshotSettings } from "../shared/contracts";
import { tagsChanged } from "./tag-events";

type NumberKey = "snapshotMaxChars" | "turnsPerAgent" | "terminalLines" | "resultsPerSearch" | "pillNameMaxChars" | "fetchTimeoutSeconds" | "maxConcurrentFetches" | "noteMaxChars" | "commentsPerItem" | "autoRefreshHours";
type TextKey = "claudeFetchModel" | "codexFetchModel" | "extraInstructions" | "customRoutes";
type DraftKey = NumberKey | TextKey;
type SwitchKey =
  | "includeWorkspaces"
  | "includeLinks"
  | "includeItems"
  | "includeAgents"
  | "showPill"
  | "shortenLinks"
  | "agentShowWorkspace"
  | "agentShowStatus"
  | "agentShowActivity"
  | "includeArchivedAgents"
  | "showTokenEstimates"
  | "notifyFetchResults"
  | "autoRefreshItems";

const ATTACHMENT_NUMBERS: ReadonlyArray<{ key: NumberKey; label: string; hint: string }> = [
  { key: "snapshotMaxChars", label: "Longest attachment (characters)", hint: "Default 40,000 (about 10,000 tokens), from 1,000 to 200,000. 0 means the default." },
  { key: "turnsPerAgent", label: "Recent turns per agent", hint: "Default 6, from 1 to 50. 0 means the default." },
  { key: "terminalLines", label: "Terminal lines to attach", hint: "Default 200, from 10 to 5,000. The newest lines are kept. 0 means the default." },
];
const SECTION_SWITCHES: ReadonlyArray<{ key: SwitchKey; label: string; hint: string }> = [
  { key: "includeWorkspaces", label: "Include labeled workspaces", hint: "Project, name, and folder of each workspace with the tag's label." },
  { key: "includeLinks", label: "Include links", hint: "Links added with /tag-link or Add link." },
  { key: "includeItems", label: "Include fetched items", hint: "Jira, Sentry, Slack, and Notion items fetched into the tag." },
  { key: "includeAgents", label: "Include agent conversations", hint: "Each tagged agent's recent turns. Off: agents are not read at all." },
];
const PICKER_SWITCHES: ReadonlyArray<{ key: SwitchKey; label: string; hint: string }> = [
  { key: "shortenLinks", label: "Shorten links in agent titles", hint: "github.com/…/pull/12 instead of the whole address, so more of the title fits." },
  { key: "agentShowWorkspace", label: "Show the workspace", hint: "In each agent row's subtitle." },
  { key: "agentShowStatus", label: "Show running or archived", hint: "In each agent row's subtitle. An agent that cannot be read always says so." },
  { key: "agentShowActivity", label: "Show when it was last active", hint: "In each agent row's subtitle, for example: active 5 min ago." },
  { key: "includeArchivedAgents", label: "Include archived agents", hint: "Archived agents are listed after the others. Pinned agents are always listed." },
  { key: "showTokenEstimates", label: "Show token estimates", hint: "At the end of every agent, tag, and terminal row, for example: ~1.2k tokens. An estimate (characters divided by 4); code and non-English text can differ." },
];
const PREFIX_OPTIONS = [
  { label: "None (rows start with the title)", value: "none" as const },
  { label: "Words (Claude, Codex, Tag, Terminal)", value: "word" as const },
];
const AGENT_SORT_OPTIONS = [
  { label: "Most recently active", value: "recent" as const },
  { label: "Title", value: "title" as const },
];

const ADVANCED_NUMBERS: ReadonlyArray<{ key: NumberKey; label: string; hint: string }> = [
  { key: "fetchTimeoutSeconds", label: "Fetch time limit (seconds)", hint: "Default 180, from 30 to 900. A worker still running then is stopped and the item marked failed." },
  { key: "maxConcurrentFetches", label: "Fetches at once", hint: "Default 2, from 1 to 5. Each running fetch is one agent run." },
  { key: "noteMaxChars", label: "Stored item size (characters)", hint: "Default 8,000, from 1,000 to 20,000. Longer items are cut." },
  { key: "commentsPerItem", label: "Comments or replies per item", hint: "Default 10, from 0 to 50. 0 leaves them out." },
];
const REFRESH_HOURS_FIELD = { key: "autoRefreshHours" as const, label: "Refresh items older than (hours)", hint: "Default 24, from 1 to 168. Checked every 15 minutes while automatic refresh is on. 0 means the default." };
const PROVIDER_OPTIONS: ReadonlyArray<{ label: string; value: FetchPreference }> = [
  { label: "Automatic (Claude, then Codex)", value: "auto" },
  { label: "Claude only", value: "claude" },
  { label: "Codex only", value: "codex" },
];
const PILL_LABEL_OPTIONS = [
  { label: "Tag names (auth rewrite +2)", value: "names" as const },
  { label: "Count (3 tags)", value: "count" as const },
];
const ROUTES_EXAMPLE = '[{"vendor":"jira","provider":"codex","server":"my-jira","tools":["get_issue","search_issues"]}]';

const RESULTS_FIELD = { key: "resultsPerSearch" as const, label: "Results per picker", hint: "Default 20, from 5 to 50. More results scroll; each agent result reads that agent's recent turns. 0 means the default." };
const PILL_LENGTH_FIELD = { key: "pillNameMaxChars" as const, label: "Longest tag name on the pill", hint: "Default 24, from 10 to 60 characters; longer names end in …. 0 means the default." };
const NUMBER_LABELS = new Map([...ATTACHMENT_NUMBERS, ...ADVANCED_NUMBERS, RESULTS_FIELD, PILL_LENGTH_FIELD, REFRESH_HOURS_FIELD].map(({ key, label }) => [key, label]));

function draftValue(values: SnapshotSettings, key: DraftKey): string {
  if (key === "customRoutes") return values.customRoutes.length === 0 ? "" : JSON.stringify(values.customRoutes);
  return String(values[key]);
}

export function SnapshotSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(snapshotSettings);
  const [drafts, setDrafts] = useState<Partial<Record<DraftKey, string>>>({});
  const [errors, setErrors] = useState<Partial<Record<DraftKey, string>>>({});
  if (settings.status === "loading") return <Text style={{ color: theme.colors.foregroundMuted, padding: 16 }}>Loading settings</Text>;
  if (settings.status !== "ready") {
    return (
      <SettingsSection title="Contextualise">
        <SettingsCard>
          <SettingsAction
            label="These settings are invalid"
            hint="Attachments and fetches fail until they are fixed. Resetting restores every default."
            error={settings.error}
            actionLabel="Reset to defaults"
            disabled={settings.saving}
            onPress={() => void settings.reset().then(tagsChanged)}
          />
        </SettingsCard>
      </SettingsSection>
    );
  }
  const values = settings.values;
  const persist = (next: SnapshotSettings) => void settings.save(next, settings.revision).then((saved) => saved && tagsChanged());

  // Typed fields are saved together; each one that does not parse gets its own message.
  const saveDrafts = () => {
    const next: Record<string, unknown> = { ...values };
    const problems: Partial<Record<DraftKey, string>> = {};
    for (const [key, raw] of Object.entries(drafts) as Array<[DraftKey, string]>) {
      const text = raw.trim();
      if (key === "customRoutes") {
        try {
          next.customRoutes = text === "" ? [] : JSON.parse(text);
        } catch {
          problems.customRoutes = "Expected a JSON list of routes, like the example.";
        }
      } else if (key === "claudeFetchModel" || key === "codexFetchModel" || key === "extraInstructions") next[key] = text;
      else if (!/^\d+$/.test(text)) problems[key] = `Enter a whole number for "${NUMBER_LABELS.get(key)}" (got "${text}").`;
      else next[key] = Number(text);
    }
    const parsed = snapshotSettings.schema.safeParse(next);
    if (!parsed.success)
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] as DraftKey;
        problems[key] ??= `${issue.path.length > 1 ? `${issue.path.slice(1).join(".")}: ` : ""}${issue.message}`;
      }
    setErrors(problems);
    if (Object.keys(problems).length > 0 || !parsed.success) return;
    void settings.save(parsed.data, settings.revision).then((saved) => {
      if (!saved) return;
      setDrafts({});
      tagsChanged();
    });
  };
  const draftInput = (key: DraftKey, label: string, hint: string, placeholder?: string) => (
    // Keyed by revision so a save shows the stored value (0 becomes the default), not the typed text.
    <SettingsInput
      key={`${key}:${settings.revision}`}
      label={label}
      hint={hint}
      placeholder={placeholder}
      initialValue={draftValue(values, key)}
      error={errors[key] ?? null}
      disabled={settings.saving}
      onChangeText={(text) => setDrafts((current) => ({ ...current, [key]: text }))}
    />
  );
  const saveRow = <SettingsAction label="" actionLabel="Save changes" disabled={settings.saving || Object.keys(drafts).length === 0} error={settings.saveError} onPress={saveDrafts} />;

  return (
    <>
      <SettingsSection title="Attachments">
        <SettingsCard>
          {ATTACHMENT_NUMBERS.map(({ key, label, hint }) => draftInput(key, label, hint))}
          {saveRow}
        </SettingsCard>
        <SettingsCard>
          {SECTION_SWITCHES.map(({ key, label, hint }) => (
            <SettingsSwitch key={key} label={label} hint={hint} value={values[key]} disabled={settings.saving} onValueChange={(value) => persist({ ...values, [key]: value })} />
          ))}
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Tags pill">
        <SettingsCard>
          <SettingsSwitch label="Show the Tags pill" hint="The pill next to Tasks and Subagents in every agent's message box." value={values.showPill} disabled={settings.saving} onValueChange={(value) => persist({ ...values, showPill: value })} />
          <SettingsSelect label="Pill label" value={values.pillLabel} options={PILL_LABEL_OPTIONS} disabled={settings.saving || !values.showPill} onValueChange={(value) => persist({ ...values, pillLabel: value })} />
          {draftInput(PILL_LENGTH_FIELD.key, PILL_LENGTH_FIELD.label, PILL_LENGTH_FIELD.hint)}
          {saveRow}
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Pickers">
        <SettingsCard>
          <SettingsSelect
            label="Row prefix"
            hint="What comes before each title in Attach > Tag, Agent conversation, and Terminal output. Paseo draws plugin picker rows as text only, so there is no icon option."
            value={values.pickerPrefix}
            options={PREFIX_OPTIONS}
            disabled={settings.saving}
            onValueChange={(value) => persist({ ...values, pickerPrefix: value })}
          />
          {draftInput(RESULTS_FIELD.key, RESULTS_FIELD.label, RESULTS_FIELD.hint)}
          {saveRow}
        </SettingsCard>
        <SettingsCard>
          <SettingsSelect label="Sort agents by" value={values.agentSort} options={AGENT_SORT_OPTIONS} disabled={settings.saving} onValueChange={(value) => persist({ ...values, agentSort: value })} />
          {PICKER_SWITCHES.map(({ key, label, hint }) => (
            <SettingsSwitch key={key} label={label} hint={hint} value={values[key]} disabled={settings.saving} onValueChange={(value) => persist({ ...values, [key]: value })} />
          ))}
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Fetching">
        <SettingsCard>
          <SettingsSelect
            label="Fetch with"
            hint="Which agent reads Jira, Sentry, Slack, and Notion items. Automatic uses Claude when it has the connector, else Codex. OpenCode cannot be kept read-only, so it is not offered."
            value={values.fetchProvider}
            options={PROVIDER_OPTIONS}
            disabled={settings.saving}
            onValueChange={(value) => persist({ ...values, fetchProvider: value })}
          />
          {draftInput("claudeFetchModel", "Claude model", "Model id as Paseo lists it. Empty uses Claude's default.", "claude-sonnet-5-5")}
          {draftInput("codexFetchModel", "Codex model", "Model id as Paseo lists it. Empty uses Codex's default.")}
          {saveRow}
        </SettingsCard>
        <SettingsCard>
          <SettingsSwitch
            label="Show fetch results in the agent"
            hint="A fetch started from an agent (/tag-fetch or the Tags pill) adds one row to that agent's conversation when it ends, with Read and Open tags. A refresh replaces the row."
            value={values.notifyFetchResults}
            disabled={settings.saving}
            onValueChange={(value) => persist({ ...values, notifyFetchResults: value })}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Advanced">
        <SettingsCard>
          {ADVANCED_NUMBERS.map(({ key, label, hint }) => draftInput(key, label, hint))}
          <SettingsSwitch
            label="Refresh fetched items automatically"
            hint="Off by default. On: items older than the hours below are fetched again in the background. Each refresh is one agent run and uses tokens. Automatic refreshes never add rows to agents."
            value={values.autoRefreshItems}
            disabled={settings.saving}
            onValueChange={(value) => persist({ ...values, autoRefreshItems: value })}
          />
          {draftInput(REFRESH_HOURS_FIELD.key, REFRESH_HOURS_FIELD.label, REFRESH_HOURS_FIELD.hint)}
          {draftInput("extraInstructions", "Extra instructions for workers", "Up to 1,000 characters, added to every fetch, for example: include acceptance criteria.")}
          <SettingsRow
            label="Custom routes"
            hint={`Extra ways to read a vendor, tried before the built-in ones: which agent, which of its MCP servers, and the only tools it may use there (read tools only). Up to ${MAX_CUSTOM_ROUTES}. Example: ${ROUTES_EXAMPLE}`}
            error={errors.customRoutes ?? null}
          >
            <TextInput
              key={`customRoutes:${settings.revision}`}
              defaultValue={draftValue(values, "customRoutes")}
              placeholder={ROUTES_EXAMPLE}
              multiline
              autoCapitalize="none"
              autoCorrect={false}
              editable={!settings.saving}
              style={{ minHeight: 80, color: theme.colors.foreground, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, padding: 8, fontFamily: "monospace" }}
              onChangeText={(text) => setDrafts((current) => ({ ...current, customRoutes: text }))}
              accessibilityLabel="Custom routes as JSON"
            />
          </SettingsRow>
          {saveRow}
          <SettingsAction label="Reset everything" hint="Restores every Contextualise setting to its default." actionLabel="Reset" disabled={settings.saving} onPress={() => void settings.reset().then(tagsChanged)} />
        </SettingsCard>
      </SettingsSection>
    </>
  );
}
