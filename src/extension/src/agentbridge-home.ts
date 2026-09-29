/**
 * ~/.agentbridge: AgentBridge's own folder in the user's home, next to ~/.codex, ~/.pi and ~/.dsh.
 *
 *   ~/.agentbridge/skills     skills only AgentBridge uses; scanned before the shared ~/.agents/skills
 *   ~/.agentbridge/AGENTS.md  rules only for AgentBridge; read after the shared ~/.agents/AGENTS.md
 *
 * The skills folder is created when the extension activates (like Codex creating ~/.codex on
 * first start), so users can see where to put skills. pi and DeepSeek Harness only create their
 * home when they first write something, but AgentBridge keeps its settings in VS Code and would
 * otherwise never create the folder. AGENTS.md is never created; it is read only when present.
 * Discovery does not depend on the folder existing: a missing folder is skipped.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";

export const AGENTBRIDGE_HOME_DIR = ".agentbridge";
export const AGENTBRIDGE_SKILLS_DIR_SEGMENTS = [AGENTBRIDGE_HOME_DIR, "skills"] as const;

export interface EnsureAgentBridgeHomeResult {
  /** ~/.agentbridge/skills. */
  readonly skillsDir: string;
  /** True when this call created the folder; false when it already existed or could not be created. */
  readonly created: boolean;
  /** Why the folder could not be created. */
  readonly error?: string;
}

/** Create ~/.agentbridge/skills if it is missing. Never throws. */
export async function ensureAgentBridgeHome(homeDir: string): Promise<EnsureAgentBridgeHomeResult> {
  const skillsDir = path.join(homeDir, ...AGENTBRIDGE_SKILLS_DIR_SEGMENTS);
  try {
    const firstCreated = await fsp.mkdir(skillsDir, { recursive: true });
    return { skillsDir, created: firstCreated !== undefined };
  } catch (error) {
    return { skillsDir, created: false, error: error instanceof Error ? error.message : String(error) };
  }
}
