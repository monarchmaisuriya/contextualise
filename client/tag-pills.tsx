import type { PluginButtonContentProps, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { settingsRpc } from "@getpaseo/plugin";
import { listTagsRpc, snapshotSettings, snapshotSettingsSchema } from "../shared/contracts";
import { AgentTags } from "./agent-tags";
import { Button, useStyles } from "./kit";
import { pillLabel, tagNamesByAgent } from "./pill-label";
import { onTagsChanged } from "./tag-events";

const PILL_ID = "tags";

// A Tags pill on every active agent's composer. Its label shows the agent's tags; pressing it opens
// a popover to add or remove them. Pills follow the agent directory, and labels refresh whenever a
// tag changes anywhere in this client.
export function followAgentPills(client: PluginClientContext, openTagsFor: (agentId: string, workspaceId: string) => void): () => void {
  const pills = new Map<string, { registration: PluginButtonRegistration; workspaceId: string }>();
  let names = new Map<string, string[]>();
  let display = { visible: true, style: "names" as "names" | "count", maxChars: 24 };
  let stopped = false;
  const lifetime = new AbortController();

  function Popover({ theme, layout, agentId, workspaceId, close }: PluginButtonContentProps & { agentId: string }) {
    const styles = useStyles(theme, layout.compact);
    const footer = (
      <Button
        label="Open tags"
        styles={styles}
        onPress={() => {
          close();
          openTagsFor(agentId, workspaceId);
        }}
      />
    );
    return <AgentTags agentId={agentId} fallbackWorkspaceId={workspaceId} styles={styles} footer={footer} />;
  }

  const label = (agentId: string) => pillLabel(names.get(agentId) ?? [], display.style, display.maxChars);

  function drop(agentId: string) {
    pills.get(agentId)?.registration.remove();
    pills.delete(agentId);
  }

  // Agent updates arrive on every status change; an existing pill is kept as it is, so an open
  // popover is not closed, unless the agent moved workspace or was archived.
  function register(agent: { id: string; workspaceId?: string | null; archivedAt?: string | null }) {
    if (stopped) return;
    if (!agent.workspaceId || agent.archivedAt) return drop(agent.id);
    if (pills.get(agent.id)?.workspaceId === agent.workspaceId) return;
    drop(agent.id);
    pills.set(agent.id, {
      workspaceId: agent.workspaceId,
      registration: client.addComposerPill({
        id: PILL_ID,
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        button: {
          title: "Tags for this agent",
          icon: "Tags",
          label: label(agent.id),
          visible: display.visible,
          behavior: { kind: "popover", Content: (props) => (props.context === "agent" ? <Popover {...props} agentId={props.agentId} /> : null) },
        },
      }),
    });
  }

  // Settings decide whether pills show and how they are labeled. Invalid settings keep the last
  // choice; the settings screen shows the problem.
  async function refreshDisplay() {
    const state = await client.rpc(settingsRpc(snapshotSettings.id).read, {});
    const parsed = state.status === "ready" ? snapshotSettingsSchema.safeParse(state.values) : null;
    if (parsed?.success) display = { visible: parsed.data.showPill, style: parsed.data.pillLabel, maxChars: parsed.data.pillNameMaxChars };
  }

  // One tags.list call per change, shared by every pill. A failed refresh keeps the last labels.
  async function refreshLabels() {
    try {
      const [{ tags }] = await Promise.all([client.rpc(listTagsRpc, {}), refreshDisplay()]);
      names = tagNamesByAgent(tags);
      for (const [agentId, pill] of pills) pill.registration.update({ label: label(agentId), visible: display.visible });
    } catch (error) {
      if (!stopped) console.error("[contextualise] could not refresh tag pills", error);
    }
  }

  const stopListening = onTagsChanged(() => void refreshLabels());
  void refreshLabels();
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
      if (!stopped) console.error("[contextualise] could not follow agents for tag pills", error);
    });

  return () => {
    stopped = true;
    lifetime.abort();
    stopListening();
    for (const agentId of [...pills.keys()]) drop(agentId);
  };
}
