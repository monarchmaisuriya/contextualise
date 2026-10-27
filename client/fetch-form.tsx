import { useRpc } from "@getpaseo/plugin/client";
import { Icon, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import { FETCH_PROVIDER_LABELS, type FetchPreference, fetchItemRpc, fetchRouteRpc, parseItemRef, parseTagName, VENDOR_LABELS } from "../shared/contracts";
import { errorText } from "./errors";
import { ICONS, VENDOR_ICONS } from "./icons";
import { Button, Chip, type Styles, useTagChange } from "./kit";

const AGENT_CHOICES: ReadonlyArray<{ value: FetchPreference | undefined; label: string }> = [
  { value: undefined, label: "Default" },
  { value: "claude", label: "Claude" },
  { value: "codex", label: "Codex" },
];

function validRef(text: string): boolean {
  try {
    parseItemRef(text);
    return true;
  } catch {
    return false;
  }
}

// Fetch a Jira, Sentry, Slack, or Notion item into one of `tagNames` (or a typed tag when there are
// none). Before anything starts it shows which agent and connector will read the item, or why none can.
// With `notifyAgentId`, the result is also shown in that agent's conversation.
export function FetchForm({ tagNames, styles, notifyAgentId, onDone, onCancel }: { tagNames: readonly string[]; styles: Styles; notifyAgentId?: string; onDone?(): void; onCancel?(): void }) {
  const fetchItem = useRpc(fetchItemRpc);
  const describeRoute = useRpc(fetchRouteRpc);
  const toast = useToast();
  const [ref, setRef] = useState("");
  const [tag, setTag] = useState(tagNames[0] ?? "");
  const [provider, setProvider] = useState<FetchPreference | undefined>(undefined);
  const trimmed = ref.trim();
  const route = useQuery({
    queryKey: ["contextualise", "fetch-route", trimmed, provider],
    queryFn: () => describeRoute({ ref: trimmed, provider }),
    enabled: validRef(trimmed),
    retry: false,
  });
  const fetching = useTagChange(
    () => fetchItem({ tag: parseTagName(tag), ref: trimmed, provider, notifyAgentId }),
    (started) => {
      toast.show(`Fetching ${trimmed} into "${started.name}" with ${FETCH_PROVIDER_LABELS[started.provider]}; it appears under Fetched items when ready`, { variant: "info" });
      setRef("");
      onDone?.();
    },
  );
  const hint = trimmed === "" ? "A Jira key, a Jira, Sentry, Slack, or Notion link, or jira: <what to find>" : !validRef(trimmed) ? errorText(new Error("Not a reference this can fetch; try PROJ-123 or a link")) : route.isPending ? "Checking which agent can read it…" : route.error ? errorText(route.error) : route.data ? `${VENDOR_LABELS[route.data.vendor]} item, read by ${FETCH_PROVIDER_LABELS[route.data.provider]} through "${route.data.server}"` : "";
  const blocked = fetching.isPending || !validRef(trimmed) || Boolean(route.error) || tag.trim() === "";
  return (
    <View style={{ gap: 8 }}>
      <View style={styles.wrap}>
        <TextInput style={styles.input} value={ref} onChangeText={setRef} placeholder="PROJ-123 or a link" autoCapitalize="none" autoCorrect={false} accessibilityLabel="Item to fetch" onSubmitEditing={() => !blocked && fetching.mutate(undefined)} />
        <Button label={fetching.isPending ? "Starting" : "Fetch"} kind="primary" styles={styles} onPress={() => fetching.mutate(undefined)} disabled={blocked} />
        {onCancel ? <Button label="Cancel" styles={styles} onPress={onCancel} /> : null}
      </View>
      <View style={styles.inline}>
        <Icon name={route.error ? ICONS.failed : route.data ? VENDOR_ICONS[route.data.vendor] : ICONS.info} size={13} color={route.error ? styles.colors.statusDanger : styles.colors.foregroundMuted} />
        <Text style={[route.error ? styles.danger : styles.faint, styles.grow]}>{hint}</Text>
      </View>
      {tagNames.length > 1 ? (
        <View style={styles.wrap}>
          <Text style={styles.faint}>Into</Text>
          {tagNames.map((name) => (
            <Chip key={name} label={name} on={name === tag} onPress={() => setTag(name)} accessibilityLabel={`Fetch into ${name}`} styles={styles} />
          ))}
        </View>
      ) : tagNames.length === 0 ? (
        <TextInput style={styles.input} value={tag} onChangeText={setTag} placeholder="Into tag, for example auth-rewrite" accessibilityLabel="Tag to fetch into" />
      ) : null}
      <View style={styles.wrap}>
        <Text style={styles.faint}>With</Text>
        {AGENT_CHOICES.map((choice) => (
          <Chip key={choice.label} label={choice.label} on={choice.value === provider} onPress={() => setProvider(choice.value)} accessibilityLabel={`Fetch with ${choice.label}`} styles={styles} />
        ))}
      </View>
    </View>
  );
}
