import { createHash, randomBytes } from "node:crypto";
import type { ToolDefinition, ToolRegistry } from "../../agent/tools/registry.js";

export interface McpRunGrant {
  tradexSessionId: string;
  tools: ToolDefinition[];
  expiresAt: number;
}

export class McpRunGrantStore {
  private readonly grants = new Map<string, McpRunGrant>();
  private readonly now: () => number;

  constructor(input: { now?: () => number } = {}) {
    this.now = input.now ?? Date.now;
  }

  issue(input: { tradexSessionId: string; registry: ToolRegistry; ttlMs: number }): { token: string; expiresAt: number } {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = this.now() + input.ttlMs;
    this.grants.set(hashToken(token), {
      tradexSessionId: input.tradexSessionId,
      tools: input.registry.listToolsForRuntime("claude-code", "read"),
      expiresAt,
    });
    return { token, expiresAt };
  }

  resolve(token: string): McpRunGrant | null {
    if (!token) return null;
    const key = hashToken(token);
    const grant = this.grants.get(key);
    if (!grant) return null;
    if (grant.expiresAt <= this.now()) {
      this.grants.delete(key);
      return null;
    }
    return grant;
  }

  revoke(token: string): void {
    if (token) this.grants.delete(hashToken(token));
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
