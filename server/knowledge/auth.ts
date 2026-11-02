import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const SECRET_BYTES = 32;

// What a token lets an agent reach: its own repository's knowledge, and its workspace's linked projects. `agent` is a random id set
// when the token is minted, one per agent, so use can be counted per agent; tokens minted before it
// existed have none and still verify.
export const agentScopeSchema = z.object({
  repoKey: z.string().min(1),
  top: z.string().min(1),
  agent: z.string().min(1).max(64).optional(),
  // The Paseo workspace the agent was created in, when it had linked projects: their knowledge is
  // reachable only while they are still linked there.
  workspace: z.string().min(1).max(200).optional(),
});
export type AgentScope = z.infer<typeof agentScopeSchema>;

// A grant to read one conversation, up to the moment it was attached. It is signed over a different
// prefix than tokens, and has fields a token lacks, so neither passes as the other.
const grantSchema = z.object({ kind: z.literal("conversation"), agentId: z.string().min(1).max(200), upTo: z.string().min(1).max(40) }).strict();
export type ConversationGrant = z.infer<typeof grantSchema>;
const GRANT_PREFIX = "conversation-grant.";

// Same scheme as Memorise (memorise/server/mcp-auth.ts). Paseo stores injected MCP entries with the
// agent and reuses them on resume, so a token must stay valid across plugin reloads and restarts.
// It is stateless: the scope travels inside the token, and an HMAC with a secret kept on disk proves
// the plugin issued it.
export class TokenAuthority {
  constructor(private readonly secret: Buffer) {
    if (secret.length !== SECRET_BYTES) throw new Error(`Expected a ${SECRET_BYTES}-byte token secret, got ${secret.length} bytes`);
  }

  private sign(payload: string): Buffer {
    return createHmac("sha256", this.secret).update(payload).digest();
  }

  mint(scope: AgentScope): string {
    const payload = Buffer.from(JSON.stringify(agentScopeSchema.parse({ ...scope, agent: scope.agent ?? randomBytes(12).toString("base64url") }))).toString("base64url");
    return `${payload}.${this.sign(payload).toString("base64url")}`;
  }

  mintGrant(agentId: string, upTo: string): string {
    const payload = Buffer.from(JSON.stringify(grantSchema.parse({ kind: "conversation", agentId, upTo }))).toString("base64url");
    return `${payload}.${this.sign(`${GRANT_PREFIX}${payload}`).toString("base64url")}`;
  }

  verifyGrant(grant: string): ConversationGrant | null {
    const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(grant.trim());
    if (!match) return null;
    const expected = this.sign(`${GRANT_PREFIX}${match[1]}`);
    const given = Buffer.from(match[2], "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    try {
      const parsed = grantSchema.safeParse(JSON.parse(Buffer.from(match[1], "base64url").toString("utf8")));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  verify(authorization: string | undefined): AgentScope | null {
    const match = /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(authorization ?? "");
    if (!match) return null;
    const expected = this.sign(match[1]);
    const given = Buffer.from(match[2], "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const parsed = agentScopeSchema.safeParse(JSON.parse(Buffer.from(match[1], "base64url").toString("utf8")));
    return parsed.success ? parsed.data : null;
  }
}

// Created once with mode 0600. Deleting the file invalidates every token already handed out.
export async function loadTokenSecret(root: string): Promise<Buffer> {
  const path = join(root, "secret");
  await mkdir(root, { recursive: true, mode: 0o700 });
  try {
    await writeFile(path, randomBytes(SECRET_BYTES), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (Reflect.get(Object(error), "code") !== "EEXIST") throw error;
  }
  return readFile(path);
}
