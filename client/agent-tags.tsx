import { useRpc } from "@getpaseo/plugin/client";
import { TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { Text, View } from "react-native";
import { addTagRpc, describeAgentRpc, listTagsRpc, parseTagNames, pinAgentRpc, removeTagRpc } from "../shared/contracts";
import { errorText } from "./errors";
import { FetchForm } from "./fetch-form";
import { ICONS } from "./icons";
import { Button, Chip, IconButton, SearchField, type Styles, TAGS_QUERY, useTagChange } from "./kit";

const OTHERS_BEFORE_FILTER = 8;

// One agent's tags, used by the composer pill's popover and the Tags screen opened for an agent:
// its tags as chips to remove, every other tag as a chip to add, and a box for new names.
export function AgentTags({ agentId, fallbackWorkspaceId, styles, footer }: { agentId: string; fallbackWorkspaceId: string | undefined; styles: Styles; footer?: ReactNode }) {
  const list = useRpc(listTagsRpc);
  const query = useQuery({ queryKey: TAGS_QUERY, queryFn: () => list({}) });
  const tags = query.data?.tags ?? [];
  // From the server, not useAgent: this also renders on the Tags screen, where Paseo's state hooks throw.
  const describe = useRpc(describeAgentRpc);
  const { data: agent } = useQuery({ queryKey: ["contextualise", "agent", agentId], queryFn: () => describe({ agentId }) });
  const workspaceId = agent?.workspaceId ?? fallbackWorkspaceId;
  const add = useRpc(addTagRpc);
  const remove = useRpc(removeTagRpc);
  const toast = useToast();
  const [names, setNames] = useState("");
  const [fetchOpen, setFetchOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const adding = useTagChange(
    (list: string[]) => {
      if (!workspaceId) throw new Error(agent ? "Paseo has no workspace for this agent, so it cannot be tagged" : "Still loading this agent; try again in a moment");
      return add({ tags: list, agentId, workspaceId });
    },
    () => setNames(""),
  );
  const removing = useTagChange((name: string) => remove({ tags: [name], agentId }));
  const pin = useRpc(pinAgentRpc);
  const pinned = query.data?.pinnedAgents.some((entry) => entry.agentId === agentId) ?? false;
  const pinning = useTagChange(() => pin({ agentId, pinned: !pinned }), (result) =>
    toast.show(result.pinned ? "Pinned: this agent comes first in Attach > Agent conversation" : "Unpinned", { variant: "success" }),
  );
  const mine = tags.filter((tag) => tag.agents.some((member) => member.agentId === agentId));
  const allOthers = tags.filter((tag) => !mine.includes(tag));
  // Past a handful of tags, a filter beats scanning chips.
  const filtering = allOthers.length > OTHERS_BEFORE_FILTER;
  const others = allOthers.filter((tag) => !filtering || tag.name.toLowerCase().includes(filter.trim().toLowerCase())).slice(0, 24);
  const submit = () => {
    try {
      adding.mutate(parseTagNames(names));
    } catch (error) {
      toast.error(errorText(error));
    }
  };
  return (
    <View style={styles.card}>
      <View style={styles.row}>
        <Text style={[styles.title, styles.grow]} numberOfLines={1}>
          {agent?.title ?? "This agent"}
        </Text>
        <IconButton
          icon={ICONS.pin}
          tone={pinned ? "accent" : "muted"}
          label={pinned ? "Unpin this agent" : "Pin this agent: first in Attach > Agent conversation"}
          onPress={() => pinning.mutate(undefined)}
          disabled={pinning.isPending || !query.data}
          styles={styles}
        />
      </View>
      {filtering ? <SearchField value={filter} onChange={setFilter} placeholder={`Filter ${allOthers.length} other tags`} label="Filter other tags" styles={styles} /> : null}
      {mine.length + others.length > 0 ? (
        <View style={styles.wrap}>
          {mine.map((tag) => (
            <Chip key={tag.key} label={tag.name} icon={ICONS.close} on onPress={() => removing.mutate(tag.name)} accessibilityLabel={`Remove tag ${tag.name}`} styles={styles} />
          ))}
          {others.map((tag) => (
            <Chip key={tag.key} label={tag.name} icon={ICONS.add} onPress={() => adding.mutate([tag.name])} accessibilityLabel={`Add tag ${tag.name}`} styles={styles} />
          ))}
        </View>
      ) : null}
      <View style={styles.row}>
        <TextInput style={styles.input} value={names} onChangeText={setNames} placeholder={mine.length === 0 ? "Add tags, or type /tag in the message box" : "Add tags, separated by commas"} onSubmitEditing={submit} accessibilityLabel="Tag names" />
        <Button label="Add" kind="primary" styles={styles} onPress={submit} disabled={adding.isPending || names.trim() === ""} />
      </View>
      {query.error ? <Text style={styles.danger}>Could not load tags: {errorText(query.error)}</Text> : null}
      {fetchOpen ? <FetchForm tagNames={mine.map((tag) => tag.name)} styles={styles} notifyAgentId={agentId} onDone={() => setFetchOpen(false)} onCancel={() => setFetchOpen(false)} /> : null}
      <View style={styles.row}>
        {mine.length > 0 && !fetchOpen ? <Button label="Fetch an item" icon={ICONS.fetch} styles={styles} onPress={() => setFetchOpen(true)} /> : null}
        <View style={styles.grow} />
        {footer}
      </View>
    </View>
  );
}
