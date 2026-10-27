import type { PluginServerContext } from "@getpaseo/plugin/server";
import { resolveDataRoot } from "./server/paseo-home";
import { contributeTags } from "./server/plugin";

export default function contribute(server: PluginServerContext) {
  return contributeTags(server, resolveDataRoot);
}
