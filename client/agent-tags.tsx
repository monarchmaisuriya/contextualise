import { useRpc } from "@getpaseo/plugin/client";
import { TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { View } from "react-native";
import { addTagRpc, describeAgentRpc, listTagsRpc, parseTagNames, pinAgentRpc, removeTagRpc } from "../shared/contracts";
import { errorText } from "./errors";
import { FetchForm } from "./fetch-form";
import { ICONS } from "./icons";
import { Button, Chip, SectionHeader, StateView, type Styles, TAGS_QUERY, useTagChange } from "./kit";
import { popoverTags } from "./tag-list";

// One agent's tags, used by the composer pill's popover and the Tags screen opened for an agent. One
// field filters the other tags and adds the names typed into it; the agent's tags are filled chips
// to remove, the others outlined chips to add.
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
    toast.show(result.pinned ? "Pinned: this agent comes first in Attach > Chat" : "Unpinned", { variant: "success" }),
  );
  const { mine, others } = popoverTags(tags, agentId, names);
  const submit = () => {
    try {
      adding.mutate(parseTagNames(names));
    } catch (error) {
      toast.error(errorText(error));
    }
  };
  return (
    <View style={{ gap: 8 }}>
      <View style={styles.row}>
        <TextInput
          style={styles.input}
          value={names}
          onChangeText={setNames}
          placeholder={tags.length === 0 ? "Add tags, or type /tag in the message box" : "Type to filter or add tags, comma separated"}
          placeholderTextColor={styles.colors.foregroundMuted}
          autoCapitalize="none"
          autoCorrect={false}
          onSubmitEditing={submit}
          accessibilityLabel="Filter or add tags"
        />
        <Button label="Add" kind="primary" styles={styles} onPress={submit} disabled={adding.isPending || names.trim() === ""} />
      </View>
      {query.error ? <StateView state="error" text={`Could not load tags: ${errorText(query.error)}`} styles={styles} /> : null}
      {mine.length > 0 ? (
        <>
          <SectionHeader label="On this agent" styles={styles} />
          <View style={styles.wrap}>
            {mine.map((tag) => (
              <Chip key={tag.key} label={tag.name} icon={ICONS.close} on onPress={() => removing.mutate(tag.name)} accessibilityLabel={`Remove tag ${tag.name}`} styles={styles} />
            ))}
          </View>
        </>
      ) : null}
      {others.length > 0 ? (
        <>
          <SectionHeader label="Other tags" styles={styles} />
          <View style={styles.wrap}>
            {others.map((tag) => (
              <Chip key={tag.key} label={tag.name} icon={ICONS.add} onPress={() => adding.mutate([tag.name])} accessibilityLabel={`Add tag ${tag.name}`} styles={styles} />
            ))}
          </View>
        </>
      ) : null}
      {fetchOpen ? <FetchForm tagNames={mine.map((tag) => tag.name)} styles={styles} notifyAgentId={agentId} onDone={() => setFetchOpen(false)} onCancel={() => setFetchOpen(false)} /> : null}
      <View style={[styles.row, { borderTopWidth: 1, borderColor: styles.colors.border, paddingTop: 8 }]}>
        <Button
          label={pinned ? "Unpin" : "Pin"}
          icon={pinned ? ICONS.unpin : ICONS.pin}
          onPress={() => pinning.mutate(undefined)}
          disabled={pinning.isPending || !query.data}
          styles={styles}
        />
        {mine.length > 0 && !fetchOpen ? <Button label="Fetch item" icon={ICONS.fetch} styles={styles} onPress={() => setFetchOpen(true)} /> : null}
        <View style={styles.grow} />
        {footer}
      </View>
    </View>
  );
}
