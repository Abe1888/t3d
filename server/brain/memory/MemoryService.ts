/**
 * MemoryService handles short-term session context and long-term
 * user persistence for the Translink Voice Agent.
 */

import fs from 'fs';
import path from 'path';

export interface UserContext {
  fleetSize?: number;
  lastInterest?: string;
  location?: string;
}

export class MemoryService {
  private sessionMemories: Map<string, string[]> = new Map();
  private userContexts: Map<string, UserContext> = new Map();

  async addMemory(sessionId: string, text: string) {
    const memories = this.sessionMemories.get(sessionId) || [];
    memories.push(text);
    // Keep only last 20 messages for context
    this.sessionMemories.set(sessionId, memories.slice(-20));
    console.log(`[Memory] Updated short-term memory for session ${sessionId}`);

    try {
      const logsDir = path.resolve(process.cwd(), 'src/translinkconfig/logs');
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
      }
      const dateStamp = new Date().toISOString().split('T')[0];
      const logFile = path.join(logsDir, `ai_session_log_${dateStamp}.jsonl`);
      
      const logEntry = JSON.stringify({
        timestamp: new Date().toISOString(),
        session_id: sessionId,
        text: text
      }) + '\n';
      
      fs.appendFileSync(logFile, logEntry);
    } catch (err) {
      console.error('[MemoryService] Failed to write session log:', err);
    }
  }

  async getContext(sessionId: string): Promise<string> {
    const memories = this.sessionMemories.get(sessionId) || [];
    return memories.join("\n");
  }

  async updateUserProfile(userId: string, update: Partial<UserContext>) {
    const current = this.userContexts.get(userId) || {};
    this.userContexts.set(userId, { ...current, ...update });
    console.log(`[Memory] Updated long-term profile for user ${userId}`);
  }
}

export const memoryService = new MemoryService();
