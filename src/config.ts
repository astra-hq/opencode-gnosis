/**
 * Config handling for the opencode-gnosis plugin.
 *
 * Mirrors the hermes-gnosis config pattern:
 *  - Secrets live in environment variables (GNOSIS_SERVICE_TOKEN)
 *  - Behavioral settings live in ~/.config/opencode/opencode-gnosis.json
 *    or project-local .opencode/opencode-gnosis.json
 *  - Environment variables provide defaults; JSON file overrides them
 *    (except the token, where the env var always wins)
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const CONFIG_FILENAME = "opencode-gnosis.json";

export const DEFAULT_USER_ID = "opencode-user";
export const DEFAULT_AGENT_ID = "opencode";
export const DEFAULT_TENANT_ID = "nolgia";
export const DEFAULT_SPACE_ID = "opencode";
export const DEFAULT_TIMEOUT = 10;
export const DEFAULT_ADD_TIMEOUT = 30;
export const DEFAULT_RECALL_MODE: RecallMode = "context";

export const TOKEN_ENV_VAR = "GNOSIS_SERVICE_TOKEN";

export type RecallMode = "context" | "search";

export interface GnosisConfig {
  gnosis_url: string;
  gnosis_token: string;
  user_id: string;
  agent_id: string;
  tenant_id: string;
  timeout: number;
  add_timeout: number;
  recall_mode: RecallMode;
}

function asFloat(value: unknown, fallback: number): number {
  const n = typeof value === "string" ? parseFloat(value) : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function getConfigDirs(): string[] {
  const dirs: string[] = [];
  // Global config
  dirs.push(join(homedir(), ".config", "opencode"));
  // Project-local config (cwd or git root)
  if (process.cwd) {
    dirs.push(join(process.cwd(), ".opencode"));
  }
  return dirs;
}

export function loadConfig(options?: Partial<GnosisConfig>): GnosisConfig {
  // Start with environment variable defaults
  const config: GnosisConfig = {
    gnosis_url: process.env.GNOSIS_URL ?? "",
    gnosis_token: process.env[TOKEN_ENV_VAR] ?? "",
    agent_id: process.env.GNOSIS_AGENT_ID ?? DEFAULT_AGENT_ID,
    tenant_id: process.env.GNOSIS_TENANT_ID ?? DEFAULT_TENANT_ID,
    timeout: asFloat(process.env.GNOSIS_TIMEOUT, DEFAULT_TIMEOUT),
    add_timeout: asFloat(process.env.GNOSIS_ADD_TIMEOUT, DEFAULT_ADD_TIMEOUT),
    recall_mode: (process.env.GNOSIS_RECALL_MODE as RecallMode) ?? DEFAULT_RECALL_MODE,
    user_id: process.env.GNOSIS_USER_ID ?? DEFAULT_USER_ID,
  };

  // Load from JSON config files (global first, then project-local overrides)
  for (const dir of getConfigDirs()) {
    const path = join(dir, CONFIG_FILENAME);
    if (existsSync(path)) {
      try {
        const raw = readFileSync(path, "utf-8");
        const fileCfg = JSON.parse(raw) as Record<string, unknown>;
        for (const [key, value] of Object.entries(fileCfg)) {
          if (value !== null && value !== "") {
        (config as unknown as Record<string, unknown>)[key] = value;
          }
        }
      } catch {
        // Ignore malformed JSON
      }
    }
  }

  // Plugin options from opencode.json tuple form override everything
  // except the token (env var always wins)
  if (options) {
    for (const [key, value] of Object.entries(options as unknown as Record<string, unknown>)) {
      if (value !== undefined && value !== null && value !== "") {
        (config as unknown as Record<string, unknown>)[key] = value;
      }
    }
  }

  // Env token always wins over any plaintext token in config files
  const envToken = process.env[TOKEN_ENV_VAR];
  if (envToken) {
    config.gnosis_token = envToken;
  }

  // Normalize numeric fields
  config.timeout = asFloat(config.timeout, DEFAULT_TIMEOUT);
  config.add_timeout = asFloat(config.add_timeout, DEFAULT_ADD_TIMEOUT);

  return config;
}
