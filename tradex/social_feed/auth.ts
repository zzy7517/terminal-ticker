import fs from "node:fs";
import path from "node:path";
import { defaultCacheDir } from "../db.js";
import { XAuthenticationError, XCookieAuth } from "./providers/x_internal.js";

export const DEFAULT_X_AUTH_FILENAME = "x_auth.json";

export interface XAuthStatus {
  configured: boolean;
  path: string;
  error: string | null;
}

export function defaultXAuthStorePath(): string {
  return path.join(defaultCacheDir(), DEFAULT_X_AUTH_FILENAME);
}

export class XAuthStore {
  readonly authPath: string;

  constructor(authPath: string | null = null) {
    this.authPath = authPath ?? defaultXAuthStorePath();
  }

  status(): XAuthStatus {
    try {
      const payload = this.readPayload();
      return { configured: Boolean(payload.auth_token && payload.ct0), path: this.authPath, error: null };
    } catch (error) {
      return { configured: false, path: this.authPath, error: error instanceof Error ? error.message : String(error) };
    }
  }

  save(input: { authToken: string; ct0: string }): XAuthStatus {
    fs.mkdirSync(path.dirname(this.authPath), { recursive: true });
    fs.writeFileSync(this.authPath, JSON.stringify({ auth_token: input.authToken, ct0: input.ct0 }, null, 2));
    return this.status();
  }

  clear(): XAuthStatus {
    try {
      fs.unlinkSync(this.authPath);
    } catch {
      // already absent
    }
    return this.status();
  }

  load(): XCookieAuth {
    const payload = this.readPayload();
    if (!payload.auth_token || !payload.ct0) throw new XAuthenticationError("X auth store is missing auth_token/ct0", 401);
    return { authToken: String(payload.auth_token), ct0: String(payload.ct0), cookieString: typeof payload.cookie_string === "string" ? payload.cookie_string : null };
  }

  private readPayload(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(this.authPath, "utf8")) as Record<string, unknown>;
  }
}
