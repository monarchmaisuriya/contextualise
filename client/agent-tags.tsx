import { useAgent, useRpc } from "@getpaseo/plugin/client";
import { Icon, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { Text, View } from "react-native";
import { addTagRpc, listTagsRpc, parseTagNames, pinAgentRpc, removeTagRpc } from "../shared/contracts";
import { errorText } from "./errors";
import { FetchForm } from "./fetch-form";
import { ICONS } from "./icons";
import { Button, Chip, SectionTitle, type Styles, TAGS_QUERY, useTagChange } from "./kit";

// One agent's tags, used by the composer pill's popover and the Tags screen opened for an agent:
// its tags as chips to remove, every other tag as a chip to add, and a box for new names.
export function AgentTags({ agentId, fallbackWorkspaceId, styles, footer }: { agentId: string; fallbackWorkspaceId: string | undefined; styles: Styles; footer?: ReactNode }) {
  const list = useRpc(listTagsRpc);
  const query = useQuery({ queryKey: TAGS_QUERY, queryFn: () => list({}) });
  const tags = query.data?.tags ?? [];
  const agent = useAgent(agentId, (snapshot) => ({ title: snapshot.title, workspaceId: snapshot.workspaceId }));
  const workspaceId = agent?.workspaceId ?? fallbackWorkspaceId;
  const add = useRpc(addTagRpc);
  const remove = useRpc(removeTagRpc);
  const toast = useToast();
  const [names, setNames] = useState("");
  const adding = useTagChange(
    (list: string[]) => {
      if (!workspaceId) throw new Error("This agent's workspace is not loaded yet; open the agent once and try again");
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
  const others = tags.filter((tag) => !mine.includes(tag)).slice(0, 24);
  const submit = () => {
    try {
      adding.mutate(parseTagNames(names));
    } catch (error) {
      toast.error(errorText(error));
    }
  };
  return (
    <View style={styles.card}>
      <View style={styles.inline}>
        <Icon name={ICONS.agent} size={16} color={styles.colors.foregroundMuted} />
        <Text style={[styles.title, styles.grow]} numberOfLines={1}>
          {agent?.title ?? "This agent"}
        </Text>
        <Button label={pinned ? "Unpin" : "Pin"} icon={pinned ? ICONS.unpin : ICONS.pin} styles={styles} onPress={() => pinning.mutate(undefined)} disabled={pinning.isPending || !query.data} />
      </View>
      <SectionTitle icon={ICONS.tags} label={mine.length === 0 ? "No tags yet" : "Tagged with (tap to remove)"} count={mine.length || undefined} styles={styles} />
      {mine.length > 0 ? (
        <View style={styles.wrap}>
          {mine.map((tag) => (
            <Chip key={tag.key} label={tag.name} icon={ICONS.close} on onPress={() => removing.mutate(tag.name)} accessibilityLabel={`Remove tag ${tag.name}`} styles={styles} />
          ))}
        </View>
      ) : null}
      {mine.length === 0 ? <Text style={styles.muted}>Type tag names below and press Add, or type /tag auth-rewrite in the message box.</Text> : null}
      <View style={styles.row}>
        <TextInput style={styles.input} value={names} onChangeText={setNames} placeholder="New tags, separated by commas" onSubmitEditing={submit} accessibilityLabel="Tag names" />
        <Button label="Add" icon={ICONS.add} kind="primary" styles={styles} onPress={submit} disabled={adding.isPending} />
      </View>
      {query.error ? <Text style={styles.danger}>Could not load tags: {errorText(query.error)}</Text> : null}
      {others.length > 0 ? (
        <>
          <SectionTitle icon={ICONS.add} label="Add an existing tag" styles={styles} />
          <View style={styles.wrap}>
            {others.map((tag) => (
              <Chip key={tag.key} label={tag.name} icon={ICONS.tag} onPress={() => adding.mutate([tag.name])} accessibilityLabel={`Add tag ${tag.name}`} styles={styles} />
            ))}
          </View>
        </>
      ) : null}
      {mine.length > 0 ? (
        <>
          <SectionTitle icon={ICONS.fetch} label="Fetch an item into a tag" styles={styles} />
          <FetchForm tagNames={mine.map((tag) => tag.name)} styles={styles} notifyAgentId={agentId} />
        </>
      ) : null}
      {footer}
    </View>
  );
}
