import { type PluginSurfaceProps, useRpc, useSettings } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsRow, SettingsSection, SettingsSelect, SettingsSwitch, TextInput } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Text } from "react-native";
import { type FetchPreference, KNOWLEDGE_MAP_PARTS, type KnowledgeMapPart, MAX_CUSTOM_ROUTES, SYMBOL_LANGUAGES, type SymbolLanguage, type SnapshotSettings, snapshotSettings } from "../shared/contracts";
import { memoriseStatusRpc } from "../shared/knowledge";
import { memoriseNote } from "./memorise-note";
import { tagsChanged } from "./tag-events";

type NumberKey =
  | "knowledgeRecentTasks"
  | "knowledgeMaxFileKb"
  | "knowledgeMaxDocs"
  | "knowledgeGenerateIdleMinutes"
  | "knowledgeGenerateMaxPerDay"
  | "pickerTitleMaxChars"
  | "knowledgeMapLines"
  | "knowledgePort" | "snapshotMaxChars" | "turnsPerAgent" | "terminalLines" | "pillNameMaxChars" | "fetchTimeoutSeconds" | "maxConcurrentFetches" | "noteMaxChars" | "commentsPerItem" | "autoRefreshHours";
type TextKey = "claudeFetchModel" | "codexFetchModel" | "extraInstructions" | "customRoutes" | "knowledgeExtraDocGlobs" | "knowledgeExcludeGlobs";
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
  | "agentShowGit"
  | "includeArchivedAgents"
  | "showTokenEstimates"
  | "notifyFetchResults"
  | "autoRefreshItems";

const ATTACHMENT_NUMBERS: ReadonlyArray<{ key: NumberKey; label: string; hint: string }> = [
  { key: "snapshotMaxChars", label: "Longest attachment (characters)", hint: "How much text one attachment can add to your message. Default 40,000 (about 25 pages)." },
  { key: "turnsPerAgent", label: "Messages to include from each conversation", hint: "How many of an agent's latest back-and-forths go into an attachment. Default 6." },
  { key: "terminalLines", label: "Terminal lines to include", hint: "The newest lines of the terminal are attached. Default 200." },
];
const SECTION_SWITCHES: ReadonlyArray<{ key: SwitchKey; label: string; hint: string }> = [
  { key: "includeWorkspaces", label: "Include workspaces", hint: "Lists the workspaces that carry the tag's name as a label." },
  { key: "includeLinks", label: "Include links", hint: "Web links you added to the tag." },
  { key: "includeItems", label: "Include saved items", hint: "Jira, Sentry, Slack, and Notion items you saved to the tag." },
  { key: "includeAgents", label: "Include conversations", hint: "The latest messages of each agent in the tag." },
];
const PICKER_SWITCHES: ReadonlyArray<{ key: SwitchKey; label: string; hint: string }> = [
  { key: "shortenLinks", label: "Shorten links in titles", hint: "Shows github.com/…/pull/12 instead of the whole address, so more of the title fits." },
  { key: "agentShowWorkspace", label: "Show the workspace", hint: "Shown in grey after the title, unless the title already names it." },
  { key: "agentShowStatus", label: "Show running or archived", hint: "Shown in grey after the title." },
  { key: "agentShowActivity", label: "Show when it was last used", hint: "Shown first in grey, for example: 5 min ago." },
  { key: "agentShowGit", label: "Show branch and pull request", hint: "Shown in grey after the time: the branch, unsaved changes (+12 −3), and the pull request (PR #42), when known." },
  { key: "includeArchivedAgents", label: "Show archived conversations", hint: "Off by default. On: archived conversations are listed after the others. Pinned ones always show." },
  { key: "showTokenEstimates", label: "Show the size of each attachment", hint: "Shown at the end of each row, for example: ~1.2k tokens. A rough guide to how much it adds to your message." },
];
const PREFIX_OPTIONS = [
  { label: "None", value: "none" as const },
  { label: "A word (Claude, Codex, Tag, Terminal)", value: "word" as const },
];
const AGENT_SORT_OPTIONS = [
  { label: "Most recently used", value: "recent" as const },
  { label: "Title", value: "title" as const },
];

const ADVANCED_NUMBERS: ReadonlyArray<{ key: NumberKey; label: string; hint: string }> = [
  { key: "fetchTimeoutSeconds", label: "Time limit for saving an item (seconds)", hint: "If saving takes longer, it stops and the item shows as failed. Default 180." },
  { key: "maxConcurrentFetches", label: "Items saved at the same time", hint: "Each one runs a helper agent. Default 2." },
  { key: "noteMaxChars", label: "Longest saved item (characters)", hint: "Longer items are cut. Default 8,000." },
  { key: "commentsPerItem", label: "Comments or replies per item", hint: "Default 10. Set 0 to leave them out." },
];
const REFRESH_HOURS_FIELD = { key: "autoRefreshHours" as const, label: "Refresh items older than (hours)", hint: "Used when automatic refresh is on. Default 24." };
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

const MAP_LINES_FIELD = { key: "knowledgeMapLines" as const, label: "Length of the project overview (lines)", hint: "The short overview each new agent starts with. Default 40. Set 0 to skip the overview and keep only search." };
const PORT_FIELD = { key: "knowledgePort" as const, label: "Connection number for agents (port)", hint: "Only change this if another app already uses 6791. Takes effect after Contextualise restarts." };
const TITLE_LENGTH_FIELD = { key: "pickerTitleMaxChars" as const, label: "Longest title in lists (characters)", hint: "Longer titles end in … so the grey details beside them stay visible. Default 44." };
const PILL_LENGTH_FIELD = { key: "pillNameMaxChars" as const, label: "Longest tag name on the button", hint: "Longer names end in …. Default 24." };
const KNOWLEDGE_NUMBERS: ReadonlyArray<{ key: NumberKey; label: string; hint: string }> = [
  { key: "knowledgeRecentTasks", label: "Recent tasks in the overview", hint: "Default 3. Set 0 to leave them out." },
  { key: "knowledgeMaxFileKb", label: "Largest file to read (KB)", hint: "Bigger files are skipped. Default 256." },
  { key: "knowledgeMaxDocs", label: "Most documents per project", hint: "Code files do not count. Default 2,000." },
];
const GENERATE_NUMBERS: ReadonlyArray<{ key: NumberKey; label: string; hint: string }> = [
  { key: "knowledgeGenerateIdleMinutes", label: "Write a summary after this many quiet minutes", hint: "Waits until the conversation has been idle this long. A new message restarts the wait. Default 20." },
  { key: "knowledgeGenerateMaxPerDay", label: "Most summaries per day", hint: "Each summary and each project description counts once. Default 20." },
];
const MAP_PART_LABELS: Record<KnowledgeMapPart, string> = {
  brief: "a written description of the project",
  pinned: "items you pinned",
  architecture: "design documents",
  conventions: "team rules and guides",
  adrs: "decision records",
  folders: "main areas of code",
  tasks: "recent work",
};
const LANGUAGE_LABELS: Record<SymbolLanguage, string> = { typescript: "TypeScript and TSX", javascript: "JavaScript", python: "Python", go: "Go" };
const GENERATE_PROVIDER_OPTIONS = [
  { label: "Same as the conversation (OpenCode conversations use Claude)", value: "same" as const },
  { label: "Always Claude", value: "claude" as const },
  { label: "Always Codex", value: "codex" as const },
];
const NUMBER_LABELS = new Map([...KNOWLEDGE_NUMBERS, ...GENERATE_NUMBERS, ...ATTACHMENT_NUMBERS, ...ADVANCED_NUMBERS, TITLE_LENGTH_FIELD, PILL_LENGTH_FIELD, REFRESH_HOURS_FIELD, MAP_LINES_FIELD, PORT_FIELD].map(({ key, label }) => [key, label]));

function draftValue(values: SnapshotSettings, key: DraftKey): string {
  if (key === "customRoutes") return values.customRoutes.length === 0 ? "" : JSON.stringify(values.customRoutes);
  return String(values[key]);
}

export function SnapshotSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(snapshotSettings);
  const memoriseStatus = useRpc(memoriseStatusRpc);
  const memorise = useQuery({ queryKey: ["contextualise", "knowledge", "memorise"], queryFn: () => memoriseStatus({}) });
  const note = memorise.data ? memoriseNote(memorise.data.state) : null;
  const [drafts, setDrafts] = useState<Partial<Record<DraftKey, string>>>({});
  const [errors, setErrors] = useState<Partial<Record<DraftKey, string>>>({});
  if (settings.status === "loading") return <Text style={{ color: theme.colors.foregroundMuted, padding: 16 }}>Loading settings</Text>;
  if (settings.status !== "ready") {
    return (
      <SettingsSection title="Contextualise">
        <SettingsCard>
          <SettingsAction
            label="These settings could not be read"
            hint="Attachments and saved items stop working until this is fixed. Reset restores every setting to its default."
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
      } else if (key === "claudeFetchModel" || key === "codexFetchModel" || key === "extraInstructions" || key === "knowledgeExtraDocGlobs" || key === "knowledgeExcludeGlobs") next[key] = text;
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
      <SettingsSection title="Project knowledge">
        {note ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, paddingHorizontal: 4, paddingBottom: 6 }} selectable>
            {note.text}
            {note.command ? ` Run: ${note.command}` : ""}
          </Text>
        ) : null}
        <SettingsCard>
          <SettingsSwitch
            label="Give new agents knowledge of the project"
            hint="Each new agent gets a short overview of its project and can search the project's documents, code, and past work. Works in any project folder, with or without git. Off: agents start without it."
            value={values.knowledgeEnabled}
            disabled={settings.saving}
            onValueChange={(value) => persist({ ...values, knowledgeEnabled: value })}
          />
          <SettingsSwitch
            label="Include code"
            hint="Lets agents find functions and classes by name. Choose languages below. Off: documents only."
            value={values.knowledgeCodeSymbols}
            disabled={settings.saving || !values.knowledgeEnabled}
            onValueChange={(value) => persist({ ...values, knowledgeCodeSymbols: value })}
          />
          <SettingsSwitch
            label="Suggest Memorise updates when code changes"
            hint="If code a memory talks about is renamed or removed, Memorise gets a suggestion to update it. Nothing changes until you approve it in Memorise."
            value={values.memoriseSuggestions}
            disabled={settings.saving || !values.knowledgeEnabled}
            onValueChange={(value) => persist({ ...values, memoriseSuggestions: value })}
          />
          {draftInput(MAP_LINES_FIELD.key, MAP_LINES_FIELD.label, MAP_LINES_FIELD.hint)}
          {draftInput(PORT_FIELD.key, PORT_FIELD.label, PORT_FIELD.hint)}
          {saveRow}
        </SettingsCard>
        <SettingsCard>
          {KNOWLEDGE_MAP_PARTS.map((part) => (
            <SettingsSwitch
              key={part}
              label={`Overview shows: ${MAP_PART_LABELS[part]}`}
              value={values.knowledgeMapParts.includes(part)}
              disabled={settings.saving || !values.knowledgeEnabled}
              onValueChange={(on) => persist({ ...values, knowledgeMapParts: KNOWLEDGE_MAP_PARTS.filter((entry) => (entry === part ? on : values.knowledgeMapParts.includes(entry))) })}
            />
          ))}
          {KNOWLEDGE_NUMBERS.slice(0, 1).map(({ key, label, hint }) => draftInput(key, label, hint))}
          {saveRow}
        </SettingsCard>
        <SettingsCard>
          {SYMBOL_LANGUAGES.map((language) => (
            <SettingsSwitch
              key={language}
              label={`Code in ${LANGUAGE_LABELS[language]}`}
              value={values.knowledgeLanguages.includes(language)}
              disabled={settings.saving || !values.knowledgeEnabled || !values.knowledgeCodeSymbols}
              onValueChange={(on) => persist({ ...values, knowledgeLanguages: SYMBOL_LANGUAGES.filter((entry) => (entry === language ? on : values.knowledgeLanguages.includes(entry))) })}
            />
          ))}
          {draftInput("knowledgeExtraDocGlobs", "Also read these files", "Markdown files are always read. Add other files with patterns, separated by commas, such as notes/**/*.txt.", "notes/**/*.txt")}
          {draftInput("knowledgeExcludeGlobs", "Never read these files", "Patterns separated by commas, such as docs/private/**.", "docs/private/**")}
          {KNOWLEDGE_NUMBERS.slice(1).map(({ key, label, hint }) => draftInput(key, label, hint))}
          <SettingsSwitch
            label="Let agents search without asking"
            hint="Searching only reads this project. Off: you approve each search."
            value={values.knowledgeAutoApproveTools}
            disabled={settings.saving || !values.knowledgeEnabled}
            onValueChange={(value) => persist({ ...values, knowledgeAutoApproveTools: value })}
          />
          {saveRow}
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Conversation summaries">
        <SettingsCard>
          <SettingsSwitch
            label="Write summaries of finished conversations"
            hint="Off by default. On: when a conversation has been idle for a while, a helper agent reads it and writes a short title and summary, and now and then a short description of the project. Your messages are sent to Claude or Codex for this (passwords and keys are removed first), and each summary uses some of your plan. It never records your preferences or lessons learned; Memorise keeps those."
            value={values.knowledgeGenerate}
            disabled={settings.saving || !values.knowledgeEnabled}
            onValueChange={(value) => persist({ ...values, knowledgeGenerate: value })}
          />
          <SettingsSelect
            label="Write summaries with"
            hint="Uses the models chosen under Saving items."
            value={values.knowledgeGenerateProvider}
            options={GENERATE_PROVIDER_OPTIONS}
            disabled={settings.saving || !values.knowledgeGenerate}
            onValueChange={(value) => persist({ ...values, knowledgeGenerateProvider: value })}
          />
          {GENERATE_NUMBERS.map(({ key, label, hint }) => draftInput(key, label, hint))}
          {saveRow}
        </SettingsCard>
      </SettingsSection>
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
      <SettingsSection title="Tags button">
        <SettingsCard>
          <SettingsSwitch label="Show the Tags button" hint="The Tags button in every message box." value={values.showPill} disabled={settings.saving} onValueChange={(value) => persist({ ...values, showPill: value })} />
          <SettingsSelect label="Tags button shows" value={values.pillLabel} options={PILL_LABEL_OPTIONS} disabled={settings.saving || !values.showPill} onValueChange={(value) => persist({ ...values, pillLabel: value })} />
          {draftInput(PILL_LENGTH_FIELD.key, PILL_LENGTH_FIELD.label, PILL_LENGTH_FIELD.hint)}
          {saveRow}
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Attach lists">
        <SettingsCard>
          <SettingsSelect
            label="Label before each title"
            hint="A word before each title in the Attach lists, such as Claude or Tag."
            value={values.pickerPrefix}
            options={PREFIX_OPTIONS}
            disabled={settings.saving}
            onValueChange={(value) => persist({ ...values, pickerPrefix: value })}
          />
          {draftInput(TITLE_LENGTH_FIELD.key, TITLE_LENGTH_FIELD.label, TITLE_LENGTH_FIELD.hint)}
          {saveRow}
        </SettingsCard>
        <SettingsCard>
          <SettingsSelect label="Sort conversations by" value={values.agentSort} options={AGENT_SORT_OPTIONS} disabled={settings.saving} onValueChange={(value) => persist({ ...values, agentSort: value })} />
          {PICKER_SWITCHES.map(({ key, label, hint }) => (
            <SettingsSwitch key={key} label={label} hint={hint} value={values[key]} disabled={settings.saving} onValueChange={(value) => persist({ ...values, [key]: value })} />
          ))}
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Saving items">
        <SettingsCard>
          <SettingsSelect
            label="Save items with"
            hint="Which assistant reads Jira, Sentry, Slack, and Notion items for you. Automatic picks Claude when it can reach the app, else Codex."
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
            label="Tell the conversation when an item is saved"
            hint="Adds a short note with Read and Open tags to the conversation that asked for it."
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
            label="Keep saved items up to date"
            hint="Off by default. On: items older than the hours below are saved again in the background. Each refresh runs a helper agent and uses some of your plan."
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
          <SettingsAction label="Reset everything" hint="Puts every Contextualise setting back to its default." actionLabel="Reset" disabled={settings.saving} onPress={() => void settings.reset().then(tagsChanged)} />
        </SettingsCard>
      </SettingsSection>
    </>
  );
}
