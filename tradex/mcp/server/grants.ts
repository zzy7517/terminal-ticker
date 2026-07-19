/** 管理 Claude 每次运行所需的短期 MCP 授权。 */
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

  /**
   * 为一次 Claude run 签发随机 token，并只在内存中保存其 hash 和工具集合。
   * 工具集合来自 listToolsForClaudeMcp：含 Message/Channel 协作写，永不含交易写。
   */
  issue(input: { tradexSessionId: string; registry: ToolRegistry; ttlMs: number }): { token: string; expiresAt: number } {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = this.now() + input.ttlMs;
    this.grants.set(hashToken(token), {
      tradexSessionId: input.tradexSessionId,
      tools: input.registry.listToolsForClaudeMcp(),
      expiresAt,
    });
    return { token, expiresAt };
  }

  /** 校验 token 是否存在且未过期，过期 grant 会被顺便清理。 */
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

  /** 在 run 结束、取消或超时时立即撤销本次 MCP 授权。 */
  revoke(token: string): void {
    if (token) this.grants.delete(hashToken(token));
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
