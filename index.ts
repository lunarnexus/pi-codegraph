import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type JsonRpcId = string | number;

type CodegraphToolSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
};

type CodegraphToolDefinition = {
  name: string;
  description: string;
  inputSchema: CodegraphToolSchema;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

type CodegraphToolResult = {
  content?: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function findCodegraphPackageRoot(): string | undefined {
  const which = spawnSync("bash", ["-lc", "command -v codegraph"], { encoding: "utf8" });
  const binPath = which.stdout.trim();
  if (!binPath) return undefined;

  const realBinPath = realpathSync(binPath);
  const launcherRoot = dirname(realBinPath);
  const candidates = [
    resolve(launcherRoot, ".."),
    launcherRoot,
    join(
      launcherRoot,
      "node_modules",
      "@colbymchenry",
      `codegraph-${process.platform}-${process.arch}`,
    ),
  ];

  return candidates.find((candidate) =>
    existsSync(join(candidate, "lib", "dist", "mcp", "tools.js")),
  );
}

function loadCodegraphMetadata(packageRoot: string): {
  tools: CodegraphToolDefinition[];
  instructions: string;
} {
  const toolsModulePath = join(packageRoot, "lib", "dist", "mcp", "tools.js");
  const instructionsModulePath = join(packageRoot, "lib", "dist", "mcp", "server-instructions.js");

  const toolsModule = require(toolsModulePath) as { tools?: CodegraphToolDefinition[] };
  const instructionsModule = require(instructionsModulePath) as { SERVER_INSTRUCTIONS?: string };

  return {
    tools: Array.isArray(toolsModule.tools) ? toolsModule.tools : [],
    instructions: typeof instructionsModule.SERVER_INSTRUCTIONS === "string" ? instructionsModule.SERVER_INSTRUCTIONS : "",
  };
}

function firstSentence(text: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed) return "CodeGraph tool";

  const match = trimmed.match(/^(.+?[.!?])(?:\s|$)/);
  return match?.[1] ?? trimmed;
}

const CODE_RESEARCH_FAST_PATH = `## Code intelligence fast path

For verification, review, behavior analysis, or change-impact work, \`codegraph_explore\` is the required first code-intelligence tool. A workspace or repository path in the request is project context, not a directory-inventory request. Do not choose \`codegraph_files\` merely because a workspace path was provided.

Even when no symbol or file is named, call \`codegraph_explore\` with the acceptance goal as the query and the workspace as \`projectPath\`. Use \`codegraph_files\` only when the requested result is specifically a file tree or directory inventory. Calling \`codegraph_files\` does not replace the initial \`codegraph_explore\` query for verification or impact analysis.

Do not begin with grep, Read, or broad shell scanning. Use them only for narrow confirmation after the graph query.`;

const CODEGRAPH_EXPLORE_FAST_PATH_DESCRIPTION = "Required first code-intelligence tool for verification, review, behavior analysis, and change-impact work. A workspace path is project context, not a directory-inventory request: do not choose codegraph_files merely because a path was provided. Even when no symbol or file is named, call codegraph_explore with the acceptance goal as the query and the workspace as projectPath. Call this before Read, grep, rg, find, or broad shell inspection; use raw inspection afterward only for narrow confirmation or evidence CodeGraph did not return.";

const CODEGRAPH_EXPLORE_GUIDELINES = [
  "For verification, review, behavior analysis, or change-impact work, call codegraph_explore before any other code-intelligence or raw inspection tool. Treat a supplied workspace path as projectPath, not as a request for codegraph_files. When no symbol or file is named, use the acceptance goal as the query. codegraph_files does not satisfy this initial exploration requirement; reserve it for explicit file-tree or directory-inventory requests.",
];

function toolDescription(tool: CodegraphToolDefinition): string {
  if (tool.name === "codegraph_explore") {
    return `${tool.description}\n\n${CODEGRAPH_EXPLORE_FAST_PATH_DESCRIPTION}`;
  }
  if (tool.name === "codegraph_files") {
    return `DIRECTORY INVENTORY ONLY. Use this when the requested result is specifically a file tree or directory listing. A workspace path supplied for verification is project context, not an inventory request; use codegraph_explore first for verification, review, behavior analysis, or change-impact work.\n\n${tool.description}`;
  }
  return tool.description;
}

function normalizePathArg(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return value.startsWith("@") ? value.slice(1) : value;
}

function isCodegraphProjectRoot(path: string): boolean {
  return existsSync(join(path, ".codegraph", "codegraph.db"));
}

function findNearestCodegraphRoot(start: string): string | undefined {
  let current = resolve(start);
  while (true) {
    if (isCodegraphProjectRoot(current)) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function discoverCodegraphRoots(cwd: string, limit = 12): string[] {
  const roots = new Set<string>();
  const nearest = findNearestCodegraphRoot(cwd);
  if (nearest) roots.add(nearest);

  const home = process.env.HOME ? resolve(process.env.HOME) : undefined;
  const bases = [cwd];
  if (home && cwd === home) {
    bases.push(join(home, "workspace"), join(home, ".hermes"));
  }

  const skip = new Set([
    ".cache",
    ".cargo",
    ".git",
    ".local",
    ".npm",
    ".opencode",
    ".rustup",
    ".vscode",
    "build",
    "dist",
    "node_modules",
    "target",
  ]);
  let visited = 0;
  const maxVisited = 2500;

  const scan = (dir: string, depth: number) => {
    if (roots.size >= limit || visited++ > maxVisited || depth < 0) return;
    let realDir = dir;
    try {
      realDir = realpathSync(dir);
    } catch {
      return;
    }
    if (isCodegraphProjectRoot(realDir)) {
      roots.add(realDir);
      return;
    }

    let entries: string[];
    try {
      entries = readdirSync(realDir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (roots.size >= limit) break;
      if (skip.has(entry)) continue;
      if (entry.startsWith(".") && entry !== ".hermes" && entry !== ".pi") continue;

      const child = join(realDir, entry);
      try {
        if (statSync(child).isDirectory()) scan(child, depth - 1);
      } catch {
        // Ignore unreadable or disappearing directories.
      }
    }
  };

  for (const base of bases) scan(base, 4);
  return Array.from(roots).sort();
}

function formatProjectPathRecovery(cwd: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const roots = discoverCodegraphRoots(cwd);
  const candidates = roots.length > 0 ? roots.map((root) => `- ${root}`).join("\n") : "(none discovered nearby)";

  return `CodeGraph failed: ${message}\n\nDo not broad-scan files yet. Retry same codegraph tool with explicit projectPath, or ask user which project to use.\n\ncwd: ${cwd}\nInitialized roots found:\n${candidates}\n\nUse raw file scanning only for narrow confirmation, or if user asks to init/index.`;
}

class CodegraphMcpClient {
  private proc: ChildProcessWithoutNullStreams | undefined;
  private started: Promise<void> | undefined;
  private nextId = 1;
  private pending = new Map<JsonRpcId, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private buffer = "";

  async start(cwd: string): Promise<void> {
    if (this.started) return this.started;

    this.started = new Promise<void>((resolveStarted, rejectStarted) => {
      const proc = spawn("codegraph", ["serve", "--mcp"], {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });

      this.proc = proc;
      proc.stdout.setEncoding("utf8");
      proc.stderr.setEncoding("utf8");

      let stderr = "";
      let settled = false;

      const failStart = (error: Error) => {
        if (settled) return;
        settled = true;
        rejectStarted(error);
      };

      proc.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });

      proc.stdout.on("data", (chunk: string) => {
        this.buffer += chunk;
        while (true) {
          const newlineIndex = this.buffer.indexOf("\n");
          if (newlineIndex === -1) break;

          const line = this.buffer.slice(0, newlineIndex).trim();
          this.buffer = this.buffer.slice(newlineIndex + 1);
          if (!line) continue;

          try {
            const message = JSON.parse(line) as JsonRpcResponse & { method?: string; params?: unknown };

            if (typeof message.method === "string") {
              if (message.method === "roots/list" && message.id !== undefined) {
                this.send({ jsonrpc: "2.0", id: message.id, result: { roots: [] } });
              }
              continue;
            }

            if (message.id === undefined) continue;

            const pending = this.pending.get(message.id);
            if (!pending) continue;
            this.pending.delete(message.id);

            if (message.error) {
              pending.reject(new Error(message.error.message || "MCP request failed"));
            } else {
              pending.resolve(message.result);
            }
          } catch (error) {
            if (!settled) {
              failStart(error instanceof Error ? error : new Error(String(error)));
            }
          }
        }
      });

      proc.on("error", (error) => {
        this.rejectAll(error instanceof Error ? error : new Error(String(error)));
        failStart(error instanceof Error ? error : new Error(String(error)));
      });

      proc.on("exit", (code, signal) => {
        const detail = stderr.trim();
        const reason = detail || `codegraph MCP exited (${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`})`;
        const error = new Error(reason);
        this.rejectAll(error);
        if (!settled) failStart(error);
        this.proc = undefined;
        this.started = undefined;
      });

      this.request(
        "initialize",
        {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "pi-codegraph", version: "0.1.0" },
          rootUri: pathToFileURL(cwd).href,
        },
        undefined,
        10000,
      )
        .then(() => {
          this.send({ jsonrpc: "2.0", method: "initialized", params: {} });
          settled = true;
          resolveStarted();
        })
        .catch((error) => {
          failStart(error instanceof Error ? error : new Error(String(error)));
        });
    });

    return this.started;
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CodegraphToolResult> {
    const result = await this.request("tools/call", { name, arguments: args }, signal, 30000);
    return (result ?? {}) as CodegraphToolResult;
  }

  stop(): void {
    this.rejectAll(new Error("CodeGraph MCP client stopped"));
    this.proc?.kill();
    this.proc = undefined;
    this.started = undefined;
    this.buffer = "";
  }

  private send(message: Record<string, unknown>): void {
    if (!this.proc?.stdin.writable) {
      throw new Error("CodeGraph MCP process is not writable");
    }
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private request(method: string, params: unknown, signal?: AbortSignal, timeoutMs = 30000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = `${method}-${this.nextId++}`;
      let finished = false;

      const finish = (fn: () => void) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
        fn();
      };

      const onAbort = () => finish(() => reject(new Error(`CodeGraph MCP request aborted: ${method}`)));
      const timeout = setTimeout(() => {
        finish(() => reject(new Error(`Timed out waiting for CodeGraph MCP response: ${method}`)));
      }, timeoutMs);
      timeout.unref?.();

      if (signal?.aborted) {
        onAbort();
        return;
      }

      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve: (value) => finish(() => resolve(value)),
        reject: (error) => finish(() => reject(error)),
      });

      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        finish(() => reject(error instanceof Error ? error : new Error(String(error))));
      }
    });
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export default function piCodegraphExtension(pi: ExtensionAPI) {
  const packageRoot = findCodegraphPackageRoot();
  if (!packageRoot) return;

  const { tools, instructions } = loadCodegraphMetadata(packageRoot);
  if (tools.length === 0) return;

  const client = new CodegraphMcpClient();
  const toolNames = new Set(tools.map((tool) => tool.name));

  for (const tool of tools) {
    pi.registerTool({
      name: tool.name,
      label: tool.name,
      description: toolDescription(tool),
      promptSnippet: firstSentence(toolDescription(tool)),
      promptGuidelines: tool.name === "codegraph_explore" ? CODEGRAPH_EXPLORE_GUIDELINES : undefined,
      parameters: tool.inputSchema as any,
      prepareArguments(args) {
        if (!args || typeof args !== "object") return args as any;

        const input = { ...(args as Record<string, unknown>) };
        if ("projectPath" in input) input.projectPath = normalizePathArg(input.projectPath);
        if ("path" in input) input.path = normalizePathArg(input.path);
        return input as any;
      },
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        try {
          await client.start(ctx.cwd);

          const args = { ...(params as Record<string, unknown>) };
          if (typeof args.projectPath === "string") args.projectPath = normalizePathArg(args.projectPath);
          if (typeof args.path === "string") args.path = normalizePathArg(args.path);

          const result = await client.callTool(tool.name, args, signal);
          const content = Array.isArray(result.content) ? result.content : [{ type: "text", text: "" }];
          const text = content.map((item) => item.text).join("\n");
          if (result.isError && /not initialized|CodeGraph not initialized|No CodeGraph project is loaded|working-directory detection issue/i.test(text)) {
            return {
              content: [{ type: "text", text: `${text}\n\n${formatProjectPathRecovery(ctx.cwd, text)}` }],
              details: result,
              isError: true,
            };
          }
          return {
            content,
            details: result,
            isError: !!result.isError,
          };
        } catch (error) {
          const text = formatProjectPathRecovery(ctx.cwd, error);
          return {
            content: [{ type: "text", text }],
            details: { error: error instanceof Error ? error.message : String(error) },
            isError: true,
          };
        }
      },
    });
  }

  pi.on("before_agent_start", async (event) => {
    const active = new Set(pi.getActiveTools());
    const hasActiveCodegraphTool = Array.from(toolNames).some((name) => active.has(name));
    if (!hasActiveCodegraphTool || !instructions.trim()) return;
    if (event.systemPrompt.includes("# Codegraph — code intelligence over an indexed knowledge graph")) return;

    const projectPathGuidance = `\n\n## Codegraph projectPath fallback\n\nCodeGraph finds initialized parent dirs by itself. If it still says \"Not initialized\", do not broad-scan files. Retry same tool with explicit \`projectPath\`, or ask user / run \`codegraph init\`.`;

    return {
      systemPrompt: `${event.systemPrompt}\n\n${instructions}\n\n${CODE_RESEARCH_FAST_PATH}${projectPathGuidance}`,
    };
  });

  pi.on("session_shutdown", () => {
    client.stop();
  });
}
