import { settingsRpc } from "@getpaseo/plugin";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { snapshotSettings, snapshotSettingsSchema } from "../shared/contracts";
import { onTagsChanged } from "./tag-events";

// Paseo gives attachment sources, slash commands, and Command Center items no visibility switch, and
// a client no settings subscription outside components, so the tag ones are added while tags are on
// and removed while off. The setting is read on start and on every tagsChanged, which the settings
// screen fires after each save. Another client already open catches up when it next starts; until
// then the daemon refuses its tag calls. A failed or invalid read keeps the current state.
export function followTagsSetting(client: Pick<PluginClientContext, "rpc">, register: () => Array<() => void>): () => void {
  let removers: Array<() => void> | null = null;
  let stopped = false;
  let reading = Promise.resolve();

  function apply(on: boolean) {
    if (on && !removers) removers = register();
    if (!on && removers) {
      for (const remove of removers) remove();
      removers = null;
    }
  }

  async function check() {
    try {
      const state = await client.rpc(settingsRpc(snapshotSettings.id).read, {});
      const parsed = state.status === "ready" ? snapshotSettingsSchema.safeParse(state.values) : null;
      if (parsed?.success && !stopped) apply(parsed.data.tagsEnabled);
    } catch (error) {
      if (!stopped) console.error("[contextualise] could not read whether tags are on", error);
    }
  }

  // One read at a time, so an older answer never lands after a newer one.
  const queue = () => {
    reading = reading.then(check);
  };
  const stopListening = onTagsChanged(queue);
  queue();

  return () => {
    stopped = true;
    stopListening();
    apply(false);
  };
}
