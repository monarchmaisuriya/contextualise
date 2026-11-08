import { type PluginSurfaceProps, useRpc, useSettings } from "@getpaseo/plugin/client";
import { copyText, SettingsAction, SettingsCard, SettingsInput, SettingsRow, SettingsSection, SettingsSelect, SettingsSwitch, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text } from "react-native";
import { type FetchPreference, KNOWLEDGE_MAP_PARTS, type KnowledgeMapPart, MAX_CUSTOM_ROUTES, SYMBOL_LANGUAGES, type SymbolLanguage, type SnapshotSettings, snapshotSettings } from "../shared/contracts";
import { memoriseStatusRpc } from "../shared/knowledge";
import { errorText } from "./errors";
import { memoriseNote } from "./memorise-note";
import { TEXT } from "./parts/rules";
import { keepsOpen, saveRowKey, withDraft, withoutError } from "./settings-drafts";
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
// A typed setting: shown as a draft until Save.
type Field<Key extends DraftKey = DraftKey> = { key: Key; label: string; hint: string; placeholder?: string };

const ATTACHMENT_NUMBERS: ReadonlyArray<Field<NumberKey>> = [
  { key: "snapshotMaxChars", label: "Longest attachment (characters)", hint: "How much text one attachment can add to your message (default 40,000, about 25 pages)." },
  { key: "turnsPerAgent", label: "Messages to include from each conversation", hint: "How many of an agent's latest back-and-forths go into an attachment (default 6)." },
  { key: "terminalLines", label: "Terminal lines to include", hint: "The newest lines of the terminal are attached (default 200)." },
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
  { key: "includeArchivedAgents", label: "Show archived conversations", hint: "When on, archived conversations are listed after the others; pinned ones always show." },
  { key: "showTokenEstimates", label: "Show the size of each attachment", hint: "A rough guide to how much each one adds to your message, for example ~1.2k tokens at the end of the row." },
];
const PREFIX_OPTIONS = [
  { label: "None", value: "none" as const },
  { label: "A word (Claude, Codex, Tag, Terminal)", value: "word" as const },
];
const AGENT_SORT_OPTIONS = [
  { label: "Most recently used", value: "recent" as const },
  { label: "Title", value: "title" as const },
];

const ADVANCED_NUMBERS: ReadonlyArray<Field<NumberKey>> = [
  { key: "fetchTimeoutSeconds", label: "Time limit for saving an item (seconds)", hint: "If saving takes longer, it stops and the item shows as failed (default 180)." },
  { key: "maxConcurrentFetches", label: "Items saved at the same time", hint: "Each one runs a helper agent (default 2)." },
  { key: "noteMaxChars", label: "Longest saved item (characters)", hint: "Longer items are cut (default 8,000)." },
  { key: "commentsPerItem", label: "Comments or replies per item", hint: "Default 10; set 0 to leave them out." },
];
const REFRESH_HOURS_FIELD: Field<NumberKey> = { key: "autoRefreshHours", label: "Refresh items older than (hours)", hint: "Used when automatic refresh is on (default 24)." };
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

const MAP_LINES_FIELD: Field<NumberKey> = { key: "knowledgeMapLines", label: "Length of the project overview (lines)", hint: "The overview each new agent starts with (default 40); set 0 to skip it and keep only search." };
const RECENT_TASKS_FIELD: Field<NumberKey> = { key: "knowledgeRecentTasks", label: "Recent tasks in the overview", hint: "Default 3; set 0 to leave them out." };
const PORT_FIELD: Field<NumberKey> = { key: "knowledgePort", label: "Connection number for agents (port)", hint: "Only change this if another app already uses 6791; it takes effect after Contextualise restarts." };
const TITLE_LENGTH_FIELD: Field<NumberKey> = { key: "pickerTitleMaxChars", label: "Longest title in lists (characters)", hint: "Longer titles end in … so the grey details beside them stay visible (default 44)." };
const PILL_LENGTH_FIELD: Field<NumberKey> = { key: "pillNameMaxChars", label: "Longest tag name on the button", hint: "Longer names end in … (default 24)." };
const FILE_NUMBERS: ReadonlyArray<Field<NumberKey>> = [
  { key: "knowledgeMaxFileKb", label: "Largest file to read (KB)", hint: "Bigger files are skipped (default 256)." },
  { key: "knowledgeMaxDocs", label: "Most documents per project", hint: "Code files do not count (default 2,000)." },
];
const GENERATE_NUMBERS: ReadonlyArray<Field<NumberKey>> = [
  { key: "knowledgeGenerateIdleMinutes", label: "Write a summary after this many quiet minutes", hint: "A new message in the conversation restarts the wait (default 20). A conversation is summarised again once it has twice the messages it had, or a day later." },
  { key: "knowledgeGenerateMaxPerDay", label: "Most summaries per day", hint: "Each summary and each project description counts once (default 20)." },
];
const MAP_PART_LABELS: Record<KnowledgeMapPart, string> = {
  brief: "Description",
  pinned: "Pinned items",
  architecture: "Design documents",
  conventions: "Team rules and guides",
  adrs: "Decision records",
  folders: "Main areas of code",
  tasks: "Recent work",
};
const LANGUAGE_LABELS: Record<SymbolLanguage, string> = { typescript: "TypeScript and TSX", javascript: "JavaScript", python: "Python", go: "Go" };
const GENERATE_PROVIDER_OPTIONS = [
  { label: "Same as the conversation (OpenCode conversations use Claude)", value: "same" as const },
  { label: "Always Claude", value: "claude" as const },
  { label: "Always Codex", value: "codex" as const },
];
const FILE_FIELDS: readonly Field[] = [
  { key: "knowledgeExtraDocGlobs", label: "Also read these files", hint: "Markdown files are always read; add others with patterns separated by commas, such as notes/**/*.txt.", placeholder: "notes/**/*.txt" },
  { key: "knowledgeExcludeGlobs", label: "Never read these files", hint: "Patterns separated by commas, such as docs/private/**.", placeholder: "docs/private/**" },
  ...FILE_NUMBERS,
];
const MODEL_FIELDS: readonly Field[] = [
  { key: "claudeFetchModel", label: "Claude model", hint: "Model id as Paseo lists it; empty uses Claude's default.", placeholder: "claude-sonnet-5-5" },
  { key: "codexFetchModel", label: "Codex model", hint: "Model id as Paseo lists it; empty uses Codex's default." },
];
const ADVANCED_FIELDS: readonly Field[] = [
  PORT_FIELD,
  ...ADVANCED_NUMBERS,
  REFRESH_HOURS_FIELD,
  { key: "extraInstructions", label: "Extra instructions for helper agents", hint: "Up to 1,000 characters added whenever an item is saved, for example: include acceptance criteria." },
];
const OVERVIEW_FIELDS = [MAP_LINES_FIELD, RECENT_TASKS_FIELD];
const LIST_FIELDS = [TITLE_LENGTH_FIELD, PILL_LENGTH_FIELD];
const keysOf = (fields: readonly Field[]): DraftKey[] => fields.map(({ key }) => key);
const ADVANCED_KEYS: readonly DraftKey[] = [...keysOf(ADVANCED_FIELDS), "customRoutes"];
// Every typed field lives under More settings, so any draft or problem keeps it open.
const MORE_KEYS: readonly DraftKey[] = [...keysOf(OVERVIEW_FIELDS), ...keysOf(FILE_FIELDS), ...keysOf(GENERATE_NUMBERS), ...keysOf(ATTACHMENT_NUMBERS), ...keysOf(LIST_FIELDS), ...keysOf(MODEL_FIELDS), ...ADVANCED_KEYS];
const NUMBER_LABELS = new Map([...OVERVIEW_FIELDS, ...FILE_NUMBERS, ...GENERATE_NUMBERS, ...ATTACHMENT_NUMBERS, ...LIST_FIELDS, ...ADVANCED_NUMBERS, REFRESH_HOURS_FIELD, PORT_FIELD].map(({ key, label }) => [key, label]));

function draftValue(values: SnapshotSettings, key: DraftKey): string {
  if (key === "customRoutes") return values.customRoutes.length === 0 ? "" : JSON.stringify(values.customRoutes);
  return String(values[key]);
}

export function SnapshotSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(snapshotSettings);
  const memoriseStatus = useRpc(memoriseStatusRpc);
  const memorise = useQuery({ queryKey: ["contextualise", "knowledge", "memorise"], queryFn: () => memoriseStatus({}) });
  const note = memorise.data ? memoriseNote(memorise.data.state) : null;
  const toast = useToast();
  const [drafts, setDrafts] = useState<Partial<Record<DraftKey, string>>>({});
  const [errors, setErrors] = useState<Partial<Record<DraftKey, string>>>({});
  const [lastEdited, setLastEdited] = useState<DraftKey | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
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
          problems.customRoutes = "Expected a JSON list of routes, in the format shown in the empty box.";
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
  const edit = (key: DraftKey, text: string) => {
    setDrafts((current) => withDraft(current, key, text, draftValue(values, key)));
    setErrors((current) => withoutError(current, key));
    setLastEdited(key);
  };
  const draftInput = ({ key, label, hint, placeholder }: Field) => (
    // Keyed by revision so a save shows the stored value (0 becomes the default), not the typed text.
    <SettingsInput
      key={`${key}:${settings.revision}`}
      label={label}
      hint={hint}
      placeholder={placeholder}
      initialValue={drafts[key] ?? draftValue(values, key)}
      error={errors[key] ?? null}
      disabled={settings.saving}
      onChangeText={(text) => edit(key, text)}
    />
  );
  // One Save, in the card of the field typed in last (or another waiting one); it saves every typed
  // field on the page, and names a problem in any of them, so nothing waits or fails out of sight.
  const unsaved = Object.keys(drafts).length;
  const saveKey = saveRowKey(lastEdited, drafts);
  const problems = Object.values(errors).join(" ");
  const saveRowFor = (keys: readonly DraftKey[]) =>
    saveKey !== null && keys.includes(saveKey) ? (
      <SettingsAction label={unsaved === 1 ? "1 unsaved change" : `${unsaved} unsaved changes`} actionLabel="Save" disabled={settings.saving} error={problems || settings.saveError} onPress={saveDrafts} />
    ) : null;
  const moreShown = moreOpen || keepsOpen(MORE_KEYS, drafts, errors);

  return (
    <>
      <SettingsSection title="Project knowledge">
        <SettingsCard>
          <SettingsSwitch
            label="Project knowledge"
            hint="Each new agent gets a short overview of its project and can search its documents, code, and past work, with or without git. Off stops all of it: nothing is read or offered, and what was read is kept for when you switch it back on."
            value={values.knowledgeEnabled}
            disabled={settings.saving}
            onValueChange={(value) => persist({ ...values, knowledgeEnabled: value })}
          />
          <SettingsSwitch
            label="Include code"
            hint="Lets agents find functions and classes by name, in the languages chosen under More settings."
            value={values.knowledgeCodeSymbols}
            disabled={settings.saving || !values.knowledgeEnabled}
            onValueChange={(value) => persist({ ...values, knowledgeCodeSymbols: value })}
          />
          <SettingsSwitch
            label="Write summaries of finished conversations"
            hint="Off by default; when on, a helper agent sends each quiet conversation to Claude or Codex, with passwords and keys removed, to write a title, a summary, and now and then a project description, using some of your plan."
            value={values.knowledgeGenerate}
            disabled={settings.saving || !values.knowledgeEnabled}
            onValueChange={(value) => persist({ ...values, knowledgeGenerate: value })}
          />
          <SettingsSwitch
            label="Let chats recover their own history"
            hint="Gives every chat tools to search and reload its earlier messages and outputs word for word, including what was dropped when its context was compacted, and adds a row to the chat after each compaction."
            value={values.historyTools}
            disabled={settings.saving}
            onValueChange={(value) => persist({ ...values, historyTools: value })}
          />
          <SettingsSwitch
            label="Let agents search without asking"
            hint="Searching only reads this project; when off, you approve each search."
            value={values.knowledgeAutoApproveTools}
            disabled={settings.saving || !values.knowledgeEnabled}
            onValueChange={(value) => persist({ ...values, knowledgeAutoApproveTools: value })}
          />
          {/* In the card, not an info tooltip, so the command can be copied on a phone too. */}
          {note?.command ? (
            <SettingsAction
              label={note.text}
              hint={note.command}
              actionLabel="Copy command"
              onPress={() => void copyText(note.command ?? "").then(() => toast.show("Copied", { variant: "success" }), (error: unknown) => toast.error(errorText(error)))}
            />
          ) : note ? (
            <SettingsRow label={note.text} />
          ) : null}
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Tags and attachments">
        <SettingsCard>
          <SettingsSwitch label="Show the Tags button" hint="The Tags button in every message box." value={values.showPill} disabled={settings.saving} onValueChange={(value) => persist({ ...values, showPill: value })} />
          <SettingsSelect label="Tags button shows" value={values.pillLabel} options={PILL_LABEL_OPTIONS} disabled={settings.saving || !values.showPill} onValueChange={(value) => persist({ ...values, pillLabel: value })} />
        </SettingsCard>
      </SettingsSection>
      {/* The Attached popover stays a list and a search box; how attaching works is said here. */}
      <SettingsSection title="Attached projects">
        <SettingsCard>
          <SettingsRow label="What attaching does" hint="Every new Claude, Codex, or OpenCode chat in that workspace can search, read, and edit the attached project as well as its own folder. Other workspaces, even of the same project, are not affected." />
          <SettingsRow label="How to attach" hint="Pick a project in Attach > Project, or use the Attached button above the message box: its Projects tab attaches a project's main folder, its Workspaces tab one workspace's own folder (such as another project's worktree on a branch). In a new workspace's first message, the project is attached as the workspace is created." />
          <SettingsRow label="Chats already running" hint="They search a newly attached project at once, but keep the folders they started with. Use New Chat in the Attached button, or Fork Chat (a new chat that carries this conversation), to edit it." />
          <SettingsRow label="Workspaces that share a folder" hint="Chats started from Paseo's own new-chat button there cannot be told apart, so they get no attached projects. Use New Chat in the Attached button instead." />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Saving items">
        <SettingsCard>
          <SettingsSelect
            label="Save items with"
            hint="Which assistant reads Jira, Sentry, Slack, and Notion items for you; Automatic picks Claude when it can reach the app, else Codex."
            value={values.fetchProvider}
            options={PROVIDER_OPTIONS}
            disabled={settings.saving}
            onValueChange={(value) => persist({ ...values, fetchProvider: value })}
          />
          <SettingsSwitch
            label="Tell the conversation when an item is saved"
            hint="Adds a short note with Read and Open tags to the conversation that asked for it."
            value={values.notifyFetchResults}
            disabled={settings.saving}
            onValueChange={(value) => persist({ ...values, notifyFetchResults: value })}
          />
        </SettingsCard>
      </SettingsSection>
      {/* Rarely changed, so closed until asked for; the groups below are its contents. */}
      <SettingsSection
        title="More settings"
        trailing={
          <Pressable onPress={() => setMoreOpen(!moreShown)} hitSlop={10} accessibilityRole="button" accessibilityState={{ expanded: moreShown }} accessibilityLabel={moreShown ? "Hide more settings" : "Show more settings"}>
            <Text style={{ ...TEXT.body, color: theme.colors.accent }}>{moreShown ? "Hide" : "Show"}</Text>
          </Pressable>
        }
      >
        {null}
      </SettingsSection>
      {moreShown ? (
        <>
          <SettingsSection title="What the overview includes">
            <SettingsCard>
              {KNOWLEDGE_MAP_PARTS.map((part) => (
                <SettingsSwitch
                  key={part}
                  label={MAP_PART_LABELS[part]}
                  value={values.knowledgeMapParts.includes(part)}
                  disabled={settings.saving || !values.knowledgeEnabled}
                  onValueChange={(on) => persist({ ...values, knowledgeMapParts: KNOWLEDGE_MAP_PARTS.filter((entry) => (entry === part ? on : values.knowledgeMapParts.includes(entry))) })}
                />
              ))}
              {OVERVIEW_FIELDS.map(draftInput)}
              {saveRowFor(keysOf(OVERVIEW_FIELDS))}
            </SettingsCard>
          </SettingsSection>
          <SettingsSection title="Code languages">
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
            </SettingsCard>
          </SettingsSection>
          <SettingsSection title="Files to read">
            <SettingsCard>
              {FILE_FIELDS.map(draftInput)}
              {saveRowFor(keysOf(FILE_FIELDS))}
            </SettingsCard>
          </SettingsSection>
          <SettingsSection title="Summaries">
            <SettingsCard>
              <SettingsSelect
                label="Write summaries with"
                hint="Uses the models chosen under Models."
                value={values.knowledgeGenerateProvider}
                options={GENERATE_PROVIDER_OPTIONS}
                disabled={settings.saving || !values.knowledgeGenerate}
                onValueChange={(value) => persist({ ...values, knowledgeGenerateProvider: value })}
              />
              {GENERATE_NUMBERS.map(draftInput)}
              {saveRowFor(keysOf(GENERATE_NUMBERS))}
            </SettingsCard>
          </SettingsSection>
          <SettingsSection title="Attachments">
            <SettingsCard>
              {ATTACHMENT_NUMBERS.map(draftInput)}
              {saveRowFor(keysOf(ATTACHMENT_NUMBERS))}
              {SECTION_SWITCHES.map(({ key, label, hint }) => (
                <SettingsSwitch key={key} label={label} hint={hint} value={values[key]} disabled={settings.saving} onValueChange={(value) => persist({ ...values, [key]: value })} />
              ))}
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
              <SettingsSelect label="Sort conversations by" value={values.agentSort} options={AGENT_SORT_OPTIONS} disabled={settings.saving} onValueChange={(value) => persist({ ...values, agentSort: value })} />
              {PICKER_SWITCHES.map(({ key, label, hint }) => (
                <SettingsSwitch key={key} label={label} hint={hint} value={values[key]} disabled={settings.saving} onValueChange={(value) => persist({ ...values, [key]: value })} />
              ))}
              {LIST_FIELDS.map(draftInput)}
              {saveRowFor(keysOf(LIST_FIELDS))}
            </SettingsCard>
          </SettingsSection>
          <SettingsSection title="Models">
            <SettingsCard>
              {MODEL_FIELDS.map(draftInput)}
              {saveRowFor(keysOf(MODEL_FIELDS))}
            </SettingsCard>
          </SettingsSection>
          <SettingsSection title="Advanced">
            <SettingsCard>
              <SettingsSwitch
                label="Suggest Memorise updates when code changes"
                hint="If code a memory talks about is renamed or removed, Memorise gets a suggestion to update it, and nothing changes until you approve it there."
                value={values.memoriseSuggestions}
                disabled={settings.saving || !values.knowledgeEnabled}
                onValueChange={(value) => persist({ ...values, memoriseSuggestions: value })}
              />
              <SettingsSwitch
                label="Keep saved items up to date"
                hint="When on, a helper agent saves items older than the hours below again in the background, using some of your plan."
                value={values.autoRefreshItems}
                disabled={settings.saving}
                onValueChange={(value) => persist({ ...values, autoRefreshItems: value })}
              />
              {ADVANCED_FIELDS.map(draftInput)}
              <SettingsRow
                label="Custom routes"
                hint={`Extra ways to read a vendor, tried before the built-in ones: which agent, which of its MCP servers, and the only read tools it may use there (up to ${MAX_CUSTOM_ROUTES}; the empty box shows the format).`}
                error={errors.customRoutes ?? null}
              >
                <TextInput
                  key={`customRoutes:${settings.revision}`}
                  defaultValue={drafts.customRoutes ?? draftValue(values, "customRoutes")}
                  placeholder={ROUTES_EXAMPLE}
                  multiline
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!settings.saving}
                  style={{ minHeight: 80, color: theme.colors.foreground, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, padding: 8, fontFamily: "monospace" }}
                  onChangeText={(text) => edit("customRoutes", text)}
                  accessibilityLabel="Custom routes as JSON"
                />
              </SettingsRow>
              {saveRowFor(ADVANCED_KEYS)}
              <SettingsAction label="Reset everything" hint="Puts every Contextualise setting back to its default." actionLabel="Reset" disabled={settings.saving} onPress={() => void settings.reset().then(tagsChanged)} />
            </SettingsCard>
          </SettingsSection>
        </>
      ) : null}
    </>
  );
}
