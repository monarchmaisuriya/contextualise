import type { PluginHandlerContext, PluginLifecycleEvents } from "@getpaseo/plugin/server";

// The plugin SDK uses these types in its contexts but does not export them by name. Deriving them
// keeps every import inside the SDK, which is all a Git or directory install is guaranteed to have.
export type PaseoApi = PluginHandlerContext["paseo"];
export type AgentTimelineItem = PluginLifecycleEvents["agent.turn_ended"]["timeline"][number];
