import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type ExtensionCommandContext, getAgentDir } from "@earendil-works/pi-coding-agent";

export interface ClassifierRecoveryConfig {
  enabled: boolean;
  provider: string;
  model: string;
  minContinueProbability: number;
  maxAttempts: number;
}

const DEFAULTS: ClassifierRecoveryConfig = {
  enabled: false,
  provider: "typesafe",
  model: "jev-latest",
  minContinueProbability: 0.8,
  maxAttempts: 1,
};

export function classifierRecoveryConfigPath(): string {
  return join(getAgentDir(), "pi-loop-monitor.json");
}

function readDocument(): Record<string, unknown> {
  const path = classifierRecoveryConfigPath();
  try {
    if (statSync(path).size > 16_384) throw new Error("pi-loop-monitor config exceeds 16 KiB");
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a config object");
    return value as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export function readClassifierRecoveryConfig(): ClassifierRecoveryConfig {
  const value = readDocument().classifierRecovery;
  if (value === undefined) return { ...DEFAULTS };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected classifierRecovery object");
  const config = { ...DEFAULTS, ...value };
  if (typeof config.enabled !== "boolean"
    || typeof config.provider !== "string" || !config.provider.trim() || config.provider.length > 200
    || typeof config.model !== "string" || !config.model.trim() || config.model.length > 200
    || typeof config.minContinueProbability !== "number" || !Number.isFinite(config.minContinueProbability)
    || config.minContinueProbability < 0.8 || config.minContinueProbability > 1
    || !Number.isInteger(config.maxAttempts) || config.maxAttempts < 1 || config.maxAttempts > 10) {
    throw new Error("Invalid classifierRecovery config: probability must be 0.8–1 and maxAttempts 1–10");
  }
  return config;
}

function saveConfig(config: ClassifierRecoveryConfig): void {
  const document = readDocument();
  const path = classifierRecoveryConfigPath();
  const temporary = `${path}.${randomUUID()}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(temporary, `${JSON.stringify({ ...document, classifierRecovery: config }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** User-owned opt-in; enabling shares terminal snippets and authorizes bounded continuation. */
export async function configureClassifierRecovery(ctx: ExtensionCommandContext): Promise<void> {
  try {
    const config = readClassifierRecoveryConfig();
    const action = await ctx.ui.select(`Classifier recovery: ${config.enabled ? "on" : "off"} · ${config.provider}/${config.model}`, [
      config.enabled ? "Disable classifier recovery" : "Enable classifier recovery",
      "Choose classifier model",
      "Show configuration file",
    ]);
    if (!action) return;
    if (action.startsWith("Show")) {
      ctx.ui.notify(classifierRecoveryConfigPath(), "info");
      return;
    }
    if (action.startsWith("Disable")) {
      saveConfig({ ...config, enabled: false });
      ctx.ui.notify("Classifier recovery disabled. Signals go to the caller unchanged.", "info");
      return;
    }
    if (typeof ctx.modelRegistry.getAvailableOfType !== "function" || typeof ctx.modelRegistry.classify !== "function") {
      throw new Error("This Pi version does not support extension classifier calls. Update Pi first.");
    }
    const models = await ctx.modelRegistry.getAvailableOfType("classifier");
    const supported = models.filter((model) => /jev|clef/.test(model.id) || (model.provider === "openai" && model.id === "gpt-6-luna"));
    if (!supported.length) throw new Error("No Jev, OpenAI Decisions or Cloudflare Clef classifier has usable credentials. Configure credentials in Pi first.");
    const selected = await ctx.ui.select("Classifier provider/model", supported.map((model) => `${model.provider}/${model.id}`));
    const model = supported.find((entry) => `${entry.provider}/${entry.id}` === selected);
    if (!model) return;
    const enabling = action.startsWith("Enable");
    if ((enabling || config.enabled) && !(await ctx.ui.confirm("Enable automatic worker continuation?", "The last 10 worker-output lines are sent to this classifier provider and may incur charges. Common secrets are redacted, but sensitive text may remain. A confident continue decision prompts a live worker automatically, without waking the caller. Other decisions and failures keep existing caller notifications."))) return;
    saveConfig({ ...config, provider: model.provider, model: model.id, enabled: enabling || config.enabled });
    ctx.ui.notify(`Classifier recovery ${enabling || config.enabled ? "enabled" : "model saved (still disabled)"}. Config: ${classifierRecoveryConfigPath()}`, "info");
  } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : "Classifier recovery settings failed", "error");
  }
}
