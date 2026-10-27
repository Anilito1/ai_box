import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TeamRole } from "../shared/types";
import { loadConfig } from "./config";
import type { CostLog } from "./costLog";
import type { McpHub } from "./mcpHub";
import { rosterBlock } from "./prompts";
import { SessionManager } from "./sessions";

type RoleArgs = {
  name: string;
  description?: string;
  folders?: string[];
  provider?: string;
  model?: string;
  effort?: string;
};
interface RoleTools {
  createRole(args: RoleArgs, signal: AbortSignal): Promise<string>;
  updateRole(args: RoleArgs, signal: AbortSignal): Promise<string>;
  listRoles(): string;
}

const CODEX = "a-cdx00001";
const VENICE = "a-ven00001";

/** `custom`: with a provider the user added, Venice. */
function hub(custom = false) {
  const dir = mkdtempSync(join(tmpdir(), "hub-roles-"));
  const work = join(dir, "work");
  mkdirSync(work);
  const cfg = loadConfig(dir, "en");
  cfg.workspaces = [work];
  cfg.accounts = [
    {
      id: CODEX,
      kind: "codex",
      name: "OpenAI (ChatGPT)",
      baseUrl: "",
      model: "",
      smallModel: "",
      slug: "",
      models: [],
      isolated: true,
    },
    ...(custom
      ? [
          {
            id: VENICE,
            kind: "openai" as const,
            name: "Venice",
            baseUrl: "https://api.venice.ai/api/v1",
            model: "venice-uncensored",
            smallModel: "",
            slug: "venice",
            models: ["venice-uncensored", "llama-3.3-70b"],
            isolated: false,
          },
        ]
      : []),
  ];
  const m = new SessionManager({
    cfg,
    dataDir: dir,
    executable: () => "",
    codexExecutable: () => "",
    geminiExecutable: () => "",
    mcpHub: {} as McpHub,
    sessionEnv: () => ({ set: {}, unset: [] }),
    persist: () => undefined,
    costLog: {} as CostLog,
    capabilities: async () => "",
  });
  if (custom)
    m.setCatalog(
      VENICE,
      ["venice-uncensored", "llama-3.3-70b"].map((value) => ({
        value,
        displayName: value,
        description: "",
        efforts: [],
      })),
    );
  m.setProviderStates({
    openai: { connected: true, accountId: CODEX, method: "chatgpt" },
    ...(custom
      ? {
          venice: { connected: true, accountId: VENICE, method: "apikey" as const },
        }
      : {}),
  });
  m.setCatalog(CODEX, [
    {
      value: "gpt-6-astra",
      displayName: "GPT-6 Astra",
      description: "",
      efforts: ["low", "high"],
    },
  ]);
  const tools = m as unknown as RoleTools;
  const post = (name: string): TeamRole =>
    cfg.team.find((r) => r.name === name) as TeamRole;
  return {
    cfg,
    work,
    tools,
    post,
    done: () => {
      m.killAll();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const signal = new AbortController().signal;

test("a post is created on a connected provider with one of its models", async () => {
  const { cfg, work, tools, post, done } = hub();
  try {
    const text = await tools.createRole(
      {
        name: "blender-3d",
        description: "3D",
        folders: [work],
        provider: "openai",
        model: "GPT-6-Astra",
        effort: "high",
      },
      signal,
    );
    assert.deepEqual(
      [
        post("blender-3d").account,
        post("blender-3d").model,
        post("blender-3d").effort,
      ],
      [CODEX, "gpt-6-astra", "high"],
    );
    assert.match(text, /provider openai · model gpt-6-astra/);
    assert.match(tools.listRoles(), /provider openai/);
    assert.match(
      rosterBlock(cfg, "en"),
      /blender-3d .* provider openai, model gpt-6-astra/,
    );
  } finally {
    done();
  }
});

test("a provider's model without the provider is refused, and the provider named", async () => {
  const { work, tools, done } = hub();
  try {
    await assert.rejects(
      tools.createRole(
        { name: "x", description: "X", folders: [work], model: "gpt-6-astra" },
        signal,
      ),
      /Allowed models: opus, sonnet\. .*provider: "openai"/,
    );
    await assert.rejects(
      tools.createRole(
        {
          name: "y",
          description: "Y",
          folders: [work],
          provider: "openai",
          model: "opus",
        },
        signal,
      ),
      /Model not allowed/,
    );
  } finally {
    done();
  }
});

test("a provider that is not connected is refused", async () => {
  const { work, tools, done } = hub();
  try {
    await assert.rejects(
      tools.createRole(
        {
          name: "x",
          description: "X",
          folders: [work],
          provider: "deepseek",
          model: "pro",
        },
        signal,
      ),
      /Settings › Accounts/,
    );
  } finally {
    done();
  }
});

test("an Anthropic post works as before, and moving it keeps a model only where it exists", async () => {
  const { work, tools, post, done } = hub();
  try {
    await tools.createRole(
      {
        name: "api",
        description: "API",
        folders: [work],
        model: "opus",
        effort: "max",
      },
      signal,
    );
    assert.deepEqual([post("api").account, post("api").model], ["", "opus"]);
    assert.match(tools.listRoles(), /provider anthropic · model opus/);
    const moved = await tools.updateRole(
      { name: "api", provider: "openai" },
      signal,
    );
    assert.deepEqual([post("api").account, post("api").model], [CODEX, ""]);
    assert.match(moved, /- provider: "anthropic" → "openai"/);
    await tools.updateRole(
      { name: "api", provider: "anthropic", model: "sonnet" },
      signal,
    );
    assert.deepEqual(
      [post("api").account, post("api").model],
      ["default", "sonnet"],
    );
  } finally {
    done();
  }
});

test("a provider the user added is one like the others: a post runs there, the master reads it", async () => {
  const { cfg, work, tools, post, done } = hub(true);
  try {
    const text = await tools.createRole(
      {
        name: "writer",
        description: "Writes",
        folders: [work],
        provider: "Venice",
        model: "llama-3.3-70b",
      },
      signal,
    );
    assert.deepEqual(
      [post("writer").account, post("writer").model],
      [VENICE, "llama-3.3-70b"],
    );
    assert.match(text, /provider venice · model llama-3\.3-70b/);
    const roster = rosterBlock(cfg, "en");
    assert.match(roster, /writer .* provider venice, model llama-3\.3-70b/);
    assert.ok(
      roster.includes(
        "venice (Venice · connected · models: venice-uncensored, llama-3.3-70b)",
      ),
    );
    assert.ok(
      roster.includes(
        "spawn_worker or message_worker (anthropic, openai, deepseek, gemini, venice)",
      ),
    );
    await assert.rejects(
      tools.updateRole({ name: "writer", provider: "venice", model: "gpt-6-astra" }, signal),
      /gpt-6-astra/,
    );
    await tools.updateRole({ name: "writer", provider: "openai" }, signal);
    assert.deepEqual([post("writer").account, post("writer").model], [CODEX, ""]);
  } finally {
    done();
  }
});
