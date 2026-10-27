import { useAgent, useRpc } from "@getpaseo/plugin/client";
import { TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { addTagRpc, listTagsRpc, parseTagNames, removeTagRpc } from "../shared/contracts";
import { errorText } from "./errors";
import { Button, type Styles, TAGS_QUERY, useTagChange } from "./kit";

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
      <Text style={styles.title}>{agent?.title ?? "This agent"}</Text>
      <Text style={styles.muted}>{mine.length === 0 ? "No tags yet." : "Tagged with (tap to remove):"}</Text>
      {mine.length > 0 ? (
        <View style={styles.wrap}>
          {mine.map((tag) => (
            <Pressable key={tag.key} style={styles.chipOn} onPress={() => removing.mutate(tag.name)} accessibilityRole="button" accessibilityLabel={`Remove tag ${tag.name}`}>
              <Text style={styles.chipOnText}>{tag.name} ×</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <View style={styles.row}>
        <TextInput style={styles.input} value={names} onChangeText={setNames} placeholder="New tags, separated by commas" onSubmitEditing={submit} accessibilityLabel="Tag names" />
        <Button label="Add" kind="primary" styles={styles} onPress={submit} disabled={adding.isPending} />
      </View>
      {query.error ? <Text style={styles.danger}>Could not load tags: {errorText(query.error)}</Text> : null}
      {others.length > 0 ? (
        <>
          <Text style={styles.muted}>Add an existing tag:</Text>
          <View style={styles.wrap}>
            {others.map((tag) => (
              <Pressable key={tag.key} style={styles.chip} onPress={() => adding.mutate([tag.name])} accessibilityRole="button" accessibilityLabel={`Add tag ${tag.name}`}>
                <Text style={styles.chipText}>+ {tag.name}</Text>
              </Pressable>
            ))}
          </View>
        </>
      ) : null}
      {footer}
    </View>
  );
}
