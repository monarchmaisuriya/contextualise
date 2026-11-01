// What the daemon says about a live agent, as far as M's attention goes. Shared by the Tags screen
// and the knowledge pulse.
export interface LiveAgent {
  id: string;
  title: string | null;
  status?: string;
  requiresAttention?: boolean;
  attentionReason?: "finished" | "error" | "permission" | null;
  attentionTimestamp?: string | null;
  pendingPermissions?: readonly unknown[];
  updatedAt?: string;
}

// Why an agent waits for M, in the order Paseo's own sidebar puts them: a permission request first,
// then an error, then a finished turn not looked at yet.
export function needsYou(agent: LiveAgent): "permission" | "error" | "finished" | null {
  if ((agent.pendingPermissions?.length ?? 0) > 0 || agent.attentionReason === "permission") return "permission";
  if (agent.status === "error" || (agent.requiresAttention && agent.attentionReason === "error")) return "error";
  if (agent.requiresAttention && agent.attentionReason === "finished") return "finished";
  return null;
}
