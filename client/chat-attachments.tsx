import type { PluginAttachmentItem } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { ScrollView, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import { searchAgentsRpc } from "../shared/contracts";
import { errorText } from "./errors";
import { ICONS } from "./icons";
import { Button, ListRow, SearchField, StateView, type Styles } from "./kit";

export function ChatAttachments({ agentId, workspaceId, hostId, styles, attach }: { agentId: string; workspaceId: string; hostId?: string; styles: Styles; attach(item: PluginAttachmentItem): "added" | "already-attached" }) {
  const searchChats = useRpc(searchAgentsRpc);
  const toast = useToast();
  const [search, setSearch] = useState("");
  const [shown, setShown] = useState(30);
  const [picking, setPicking] = useState(false);
  const query = useQuery({ queryKey: ["contextualise", "attach-chats", hostId, workspaceId, agentId, search], queryFn: () => searchChats({ query: search }) });
  const rows = query.error ? [] : (query.data?.items ?? []).filter((item) => item.id !== agentId);
  const pick = (item: PluginAttachmentItem) => {
    setPicking(true);
    try {
      const result = attach(item);
      toast.show(result === "added" ? "Chat attached to this message" : "Chat is already attached to this message", { variant: "success" });
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setPicking(false);
    }
  };
  return (
    <View style={{ gap: 8 }}>
      <SearchField value={search} onChange={(value) => { setSearch(value); setShown(30); }} placeholder="Search chats by title, provider, or workspace" label="Chat to attach to this message" styles={styles} />
      <Text style={styles.note}>Adds a chat snapshot to this message, not a workspace link.</Text>
      <ScrollView style={{ maxHeight: 260 }} keyboardShouldPersistTaps="handled" onScroll={({ nativeEvent: { layoutMeasurement, contentOffset, contentSize } }) => {
        if (layoutMeasurement.height + contentOffset.y >= contentSize.height - 80) setShown((count) => count + 30);
      }} scrollEventThrottle={100}>
        {rows.slice(0, shown).map((item) => <ListRow key={item.id} title={item.title} meta={item.subtitle} icon={ICONS.agent} onPress={() => pick(item)} disabled={picking || query.isFetching} accessibilityLabel={`Attach ${item.title} to this message`} styles={styles} />)}
        {query.error ? <><StateView state="error" text={`Could not find chats: ${errorText(query.error)}`} styles={styles} /><Button label="Retry" onPress={() => void query.refetch()} styles={styles} /></> : null}
        {!rows.length && !query.error ? <Text style={styles.note}>{query.isFetching ? "Searching chats…" : "No chats match this search"}</Text> : null}
      </ScrollView>
    </View>
  );
}
