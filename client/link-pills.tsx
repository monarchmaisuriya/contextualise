import type { PluginButtonContentProps, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { View } from "react-native";
import { workspaceLinksRpc } from "../shared/linked-projects";
import { ICONS } from "./icons";
import { useStyles } from "./kit";
import { LinkedProjects, onLinksChanged } from "./linked-projects";

const PILL_ID = "linked-projects";

// A Linked pill on every active agent's composer. Its label counts the workspace's linked projects;
// pressing it opens a popover to add or remove them and to start a chat that has them.
export function followLinkPills(client: PluginClientContext): () => void {
  const pills = new Map<string, { registration: PluginButtonRegistration; workspaceId: string }>();
  const counts = new Map<string, number>();
  let stopped = false;
  const lifetime = new AbortController();

  function Popover(props: PluginButtonContentProps) {
    const styles = useStyles(props.theme, props.layout.compact);
    if (props.context !== "agent") return null;
    const navigation = (props as { navigation?: { openAgent?: (input: { agentId: string }) => void } }).navigation;
    const openAgent = navigation?.openAgent
      ? (agentId: string) => {
          props.close();
          navigation.openAgent?.({ agentId });
        }
      : undefined;
    return (
      <View style={{ padding: 12, maxWidth: 420 }}>
        <LinkedProjects workspaceId={props.workspaceId} agentId={props.agentId} styles={styles} openAgent={openAgent} />
      </View>
    );
  }

  const label = (workspaceId: string) => {
    const count = counts.get(workspaceId) ?? 0;
    return count > 0 ? `Linked ${count}` : "Linked";
  };

  function drop(agentId: string) {
    pills.get(agentId)?.registration.remove();
    pills.delete(agentId);
  }

  // A failed count keeps the last label.
  async function refreshCount(workspaceId: string) {
    try {
      counts.set(workspaceId, (await client.rpc(workspaceLinksRpc, { workspaceId })).links.length);
      for (const pill of pills.values()) if (pill.workspaceId === workspaceId) pill.registration.update({ label: label(workspaceId) });
    } catch (error) {
      if (!stopped) console.error("[contextualise] could not count linked projects", error);
    }
  }

  // An existing pill is kept as it is, so an open popover is not closed, unless the agent moved
  // workspace or was archived.
  function register(agent: { id: string; workspaceId?: string | null; archivedAt?: string | null }) {
    if (stopped) return;
    if (!agent.workspaceId || agent.archivedAt) return drop(agent.id);
    if (pills.get(agent.id)?.workspaceId === agent.workspaceId) return;
    drop(agent.id);
    const workspaceId = agent.workspaceId;
    if (!counts.has(workspaceId)) void refreshCount(workspaceId);
    pills.set(agent.id, {
      workspaceId,
      registration: client.addComposerPill({
        id: PILL_ID,
        workspaceId,
        agentId: agent.id,
        button: { title: "Linked projects", icon: ICONS.link, label: label(workspaceId), behavior: { kind: "popover", Content: Popover } },
      }),
    });
  }

  const stopListening = onLinksChanged(() => {
    for (const workspaceId of new Set([...pills.values()].map((pill) => pill.workspaceId))) void refreshCount(workspaceId);
  });
  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          const current = new Set(entries.map(({ agent }) => agent.id));
          for (const agentId of [...pills.keys()]) if (!current.has(agentId)) drop(agentId);
          for (const { agent } of entries) register(agent);
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          if (message.payload.kind === "remove") drop(message.payload.agentId);
          else register(message.payload.agent);
        },
      });
    })
    .catch((error: unknown) => {
      if (!stopped) console.error("[contextualise] could not follow agents for linked-project pills", error);
    });

  return () => {
    stopped = true;
    lifetime.abort();
    stopListening();
    for (const agentId of [...pills.keys()]) drop(agentId);
  };
}
