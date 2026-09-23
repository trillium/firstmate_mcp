/**
 * SessionData + in-memory SessionStore + server handle. (slice 22 of the http.ts folder split, task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/http.ts. Exported there, re-exported via
 * http.ts so the `./http.js` public surface is unchanged.
 */
import http from "node:http";
import crypto from "node:crypto";

export interface SessionData {
  readonly id: string;
  readonly createdAt: number;
  lastActivityAt: number;
  initialized: boolean;
  protocolVersion?: string;
  clientInfo?: { name: string; version: string };
  sseRes?: http.ServerResponse;
}

export class SessionStore {
  private readonly sessions = new Map<string, SessionData>();

  createSession(protocolVersion?: string, idOverride?: string): SessionData {
    const id = idOverride ?? crypto.randomUUID();
    const session: SessionData = {
      id,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      initialized: false,
      protocolVersion,
    };
    this.sessions.set(id, session);
    return session;
  }

  getSession(id: string): SessionData | undefined {
    return this.sessions.get(id);
  }

  touchSession(id: string): void {
    const s = this.sessions.get(id);
    if (s) s.lastActivityAt = Date.now();
  }

  deleteSession(id: string): boolean {
    const s = this.sessions.get(id);
    if (s) {
      if (s.sseRes && !s.sseRes.writableEnded) {
        try {
          s.sseRes.end();
        } catch {
          /* ignore */
        }
      }
      return this.sessions.delete(id);
    }
    return false;
  }

  cleanupExpired(ttlMs: number): number {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, s] of this.sessions.entries()) {
      if (now - s.lastActivityAt > ttlMs) {
        if (s.sseRes && !s.sseRes.writableEnded) {
          try {
            s.sseRes.end();
          } catch {
            /* ignore */
          }
        }
        this.sessions.delete(id);
        cleaned++;
      }
    }
    return cleaned;
  }

  count(): number {
    return this.sessions.size;
  }

  closeAll(): void {
    for (const s of this.sessions.values()) {
      if (s.sseRes && !s.sseRes.writableEnded) {
        try {
          s.sseRes.end();
        } catch {
          /* ignore */
        }
      }
    }
    this.sessions.clear();
  }
}

export interface HttpServerHandle {
  readonly server: http.Server;
  readonly host: string;
  readonly port: number;
  readonly authToken: string;
  readonly sessionStore: SessionStore;
  readonly close: () => Promise<void>;
}

