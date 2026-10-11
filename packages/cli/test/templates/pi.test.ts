import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { collectPiTemplates } from "../../src/configurators/pi.js";
import {
  getAllAgents,
  getExtensionTemplate,
  getSettingsTemplate,
} from "../../src/templates/pi/index.js";

interface PiExtensionInternals {
  cmdHasTrellisCtx: (cmd: string) => boolean;
  shellQuote: (v: string) => string;
  trellisExtension: (pi: {
    registerTool?: (tool: unknown) => void;
    registerShortcut?: (key: string, opts: unknown) => void;
    getThinkingLevel?: () => string;
    on?: (
      event: string,
      handler: (event: unknown, ctx?: unknown) => unknown,
    ) => void;
  }) => void;
}

function evaluateExtension<T>(
  source: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): T {
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const require = createRequire(import.meta.url);
  const moduleObject: { exports: Record<string, unknown> } = { exports: {} };
  const sandboxProcess = Object.create(process) as NodeJS.Process;
  const sandboxEnv = { ...process.env, ...env };
  delete sandboxEnv.TRELLIS_SUBAGENT_CHILD;
  Object.defineProperty(sandboxProcess, "cwd", { value: () => cwd });
  Object.defineProperty(sandboxProcess, "env", { value: sandboxEnv });
  const sandbox = vm.createContext({
    Buffer,
    console,
    exports: moduleObject.exports,
    module: moduleObject,
    process: sandboxProcess,
    require,
  });
  vm.runInContext(compiled, sandbox);
  return moduleObject.exports as T;
}

function loadExtensionInternals(
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = {},
): PiExtensionInternals {
  const source = `${getExtensionTemplate()}

export { cmdHasTrellisCtx, shellQuote, trellisExtension };
`;
  return evaluateExtension<PiExtensionInternals>(source, cwd, env);
}

function createMinimalTrellisRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "trellis-pi-355-"));
  mkdirSync(join(root, ".pi"), { recursive: true });
  mkdirSync(join(root, ".trellis", "scripts"), { recursive: true });
  writeFileSync(
    join(root, ".trellis", "workflow.md"),
    [
      "[workflow-state:no_task]",
      "No active task. First classify the current turn and ask for task-creation consent before creating any Trellis task.",
      "[/workflow-state:no_task]",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, ".trellis", "scripts", "get_context.py"),
    [
      "#!/usr/bin/env python3",
      "import sys",
      "if '--mode' in sys.argv and 'phase' in sys.argv:",
      "    print('## Phase Index\\nPhase 1: Plan')",
      "else:",
      "    print('SESSION CONTEXT\\nCurrent task: none.')",
      "",
    ].join("\n"),
  );
  return root;
}

describe("pi templates", () => {
  it("provides the three Trellis sub-agent definitions", () => {
    const agents = getAllAgents();
    expect(agents.map((agent) => agent.name).sort()).toEqual([
      "trellis-check",
      "trellis-implement",
      "trellis-research",
    ]);

    for (const agent of agents) {
      expect(agent.content).toContain(`name: ${agent.name}`);
      expect(agent.content).not.toContain("inject-subagent-context.py");
    }
  });

  it("settings no longer list a private skills root — Pi discovers shared .agents/skills/ natively (#447)", () => {
    const settings = JSON.parse(getSettingsTemplate().content) as {
      enableSkillCommands?: boolean;
      extensions?: string[];
      skills?: string[];
      prompts?: string[];
      packages?: unknown[];
    };

    expect(settings.enableSkillCommands).toBe(true);
    expect(settings.extensions).toEqual(["./extensions/trellis/index.ts"]);
    expect(settings.skills).toBeUndefined();
    expect(settings.prompts).toEqual(["./prompts"]);
    expect(settings.packages).toBeUndefined();
  });

  it("writes shared skills to .agents/skills/, not a private .pi/skills/ root (#447)", () => {
    const templates = collectPiTemplates();

    expect(
      templates.get(".agents/skills/trellis-check/SKILL.md"),
    ).toBeDefined();
    for (const key of templates.keys()) {
      expect(key.startsWith(".pi/skills/")).toBe(false);
    }
  });

  it("collects a manual trellis-start prompt for Pi fallback bootstrap", () => {
    const templates = collectPiTemplates();

    expect(templates.get(".pi/prompts/trellis-start.md")).toContain(
      "# Start Session",
    );
    expect(templates.get(".pi/prompts/trellis-continue.md")).toContain(
      "get_context.py --mode phase",
    );
    expect(templates.get(".pi/prompts/trellis-finish-work.md")).toContain(
      "finish-work",
    );
  });

  it("extension wires the Pi events Trellis needs for context flow", () => {
    const extension = getExtensionTemplate();

    // session_start: notify-only welcome
    expect(extension).toContain('pi.on?.("session_start"');
    // input: not used; Trellis must not rewrite submitted user text
    expect(extension).not.toContain('pi.on?.("input"');
    // before_agent_start: preserves system prompt context and persists hidden runtime context
    expect(extension).toContain('pi.on?.("before_agent_start"');
    // context: preserves the existing context-key establishment behavior only
    expect(extension).toContain('pi.on?.("context"');
    // tool_call: inject TRELLIS_CONTEXT_ID into bash commands
    expect(extension).toContain('pi.on?.("tool_call"');
    // tool_result: not registered — it only existed to turn failed/cancelled
    // trellis_subagent runs into errors, and inline mode spawns no sub-agent.
    expect(extension).not.toContain('pi.on?.("tool_result"');
  });

  it("keeps user input clean while persisting hidden runtime context", () => {
    const root = createMinimalTrellisRoot();
    const { trellisExtension } = loadExtensionInternals(root);
    const handlers = new Map<
      string,
      (event: unknown, ctx?: unknown) => unknown
    >();

    trellisExtension({
      registerTool: vi.fn(),
      registerShortcut: vi.fn(),
      on(event, handler) {
        handlers.set(event, handler);
      },
    });

    const ctx = {
      sessionManager: { getSessionId: () => "pi-unit-355" },
      ui: { notify: vi.fn() },
    };

    expect(handlers.has("input")).toBe(false);

    const beforeAgentStart = handlers.get("before_agent_start");
    const first = beforeAgentStart?.(
      {
        type: "before_agent_start",
        prompt: "Adjust service routing",
        systemPrompt: "BASE",
        systemPromptOptions: {},
      },
      ctx,
    ) as {
      systemPrompt?: string;
      message: { customType?: string; content?: string; display?: boolean };
    };

    // systemPrompt: the base prompt plus the byte-stable startup snapshot.
    expect(first.systemPrompt).toContain("BASE");
    expect(first.systemPrompt).toContain(
      "Trellis compact SessionStart context",
    );
    // The system prompt carries startup's session-overview snapshot.
    expect(first.systemPrompt).toContain("<session-overview>");
    expect(first.systemPrompt).toContain("<ready>");
    // Inline mode drops the two pure-noise injections and the phase index.
    expect(first.systemPrompt).not.toContain("<first-reply-notice>");
    expect(first.systemPrompt).not.toContain("<trellis-workflow>");
    expect(first.systemPrompt).not.toContain("Phase 1: Plan");
    // The full task context is no longer broadcast either: inline mode keeps
    // it on disk and injects only a pointer.
    expect(first.systemPrompt).not.toContain("## Trellis Task Context");
    // Volatile state never enters the system prompt; it travels as a
    // persisted custom message instead.
    expect(first.systemPrompt).not.toContain("<workflow-state>");

    expect(first.message).toEqual(
      expect.objectContaining({
        customType: "trellis-runtime-context",
        display: false,
      }),
    );
    expect("role" in first.message).toBe(false);
    expect("timestamp" in first.message).toBe(false);
    expect(first.message.content).not.toContain("BASE");
    expect(first.message.content).not.toContain(
      "Trellis compact SessionStart context",
    );
    expect(first.message.content).toContain("<workflow-state>");
    expect(first.message.content).toContain("Status: no_task");

    const second = beforeAgentStart?.(
      {
        type: "before_agent_start",
        prompt: "Continue",
        systemPrompt: "BASE",
        systemPromptOptions: {},
      },
      ctx,
    ) as {
      systemPrompt?: string;
      message?: { customType?: string; content?: string; display?: boolean };
    };

    // Provider prefix caches invalidate from byte 0 on any systemPrompt
    // change, so later turns must return the exact same bytes as turn one.
    expect(second.systemPrompt).toBe(first.systemPrompt);
    // The breadcrumb, by contrast, is re-asserted every turn: with no active
    // task it is the only channel carrying the triage instruction, and a
    // cross-turn dedup buried it after turn one (see PATCHES.md).
    expect(second.message?.customType).toBe("trellis-runtime-context");
    expect(second.message?.content).toContain("Status: no_task");
    expect(handlers.has("context")).toBe(true);
  });

  it("delivers task context changes as persisted messages, not systemPrompt churn", async () => {
    const root = createMinimalTrellisRoot();
    const { trellisExtension } = loadExtensionInternals(root);
    const handlers = new Map<
      string,
      (event: unknown, ctx?: unknown) => unknown
    >();

    trellisExtension({
      registerTool: vi.fn(),
      registerShortcut: vi.fn(),
      on(event, handler) {
        handlers.set(event, handler);
      },
    });

    const ctx = {
      sessionManager: { getSessionId: () => "pi-unit-task-update" },
      ui: { notify: vi.fn() },
    };
    const beforeAgentStart = handlers.get("before_agent_start");
    const fire = () =>
      beforeAgentStart?.(
        {
          type: "before_agent_start",
          prompt: "Continue",
          systemPrompt: "BASE",
          systemPromptOptions: {},
        },
        ctx,
      ) as {
        systemPrompt?: string;
        message?: { customType?: string; content?: string; display?: boolean };
      };

    const first = fire();
    // No task bound yet: the system prompt carries the startup snapshot only.
    expect(first.systemPrompt).toContain(
      "Trellis compact SessionStart context",
    );
    expect(first.systemPrompt).not.toContain("## Trellis Task");

    // A task is created and activated mid-session.
    const taskDir = join(root, ".trellis", "tasks", "07-07-cache-fix");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "prd.md"), "# PRD\nStable prefix matters.");
    writeFileSync(
      join(taskDir, "task.json"),
      JSON.stringify({ id: "07-07-cache-fix", status: "in_progress" }),
    );
    mkdirSync(join(root, ".trellis", ".runtime", "sessions"), {
      recursive: true,
    });
    writeFileSync(
      join(root, ".trellis", ".runtime", "sessions", "pi_pi-unit-task-update.json"),
      JSON.stringify({ current_task: "tasks/07-07-cache-fix" }),
    );

    // getTurnCtx caches the breadcrumb for 1.5s (one turn can fire the hook
    // twice). A real wait is the only way past it here: the extension runs in
    // a vm realm, whose Date the host's fake timers cannot patch.
    await new Promise((resolve) => setTimeout(resolve, 1600));
    const second = fire();
    // The startup snapshot is keyed by session *and* task directory, so the
    // task switch rebuilds it around the new pointer instead of leaving the
    // system prompt aimed at the previous task.
    expect(second.systemPrompt).not.toBe(first.systemPrompt);
    expect(second.systemPrompt).toContain("## Trellis Task");
    expect(second.systemPrompt).toContain(".trellis/tasks/07-07-cache-fix");
    // The breadcrumb names the artifact to read before editing.
    expect(second.message?.content).toContain("<workflow-state>");
    expect(second.message?.content).toContain("prd.md");

    // Unchanged on disk: the system prompt stays byte-identical (provider
    // prefix cache) and the pointer is not re-persisted...
    const third = fire();
    expect(third.systemPrompt).toBe(second.systemPrompt);
    expect(third.message?.content).toContain("<workflow-state>");
    expect(third.message?.content).not.toContain(
      "<trellis-task-context-update>",
    );

    // ...but a pointer-only change — a new curated manifest entry, with no new
    // task directory — arrives as a persisted update that supersedes the
    // system-prompt copy.
    writeFileSync(
      join(taskDir, "implement.jsonl"),
      JSON.stringify({
        file: ".trellis/spec/cli/backend/script-conventions.md",
        type: "file",
        reason: "naming",
      }) + "\n",
    );
    const fourth = fire();
    expect(fourth.systemPrompt).toBe(second.systemPrompt);
    expect(fourth.message?.content).toContain("<trellis-task-context-update>");
    expect(fourth.message?.content).toContain("script-conventions.md");
  });

  it("keeps a native Pi session isolated from a foreign context key (#512)", () => {
    const root = createMinimalTrellisRoot();
    const taskDir = join(root, ".trellis", "tasks", "foreign-task");
    const sessionsDir = join(root, ".trellis", ".runtime", "sessions");
    mkdirSync(taskDir, { recursive: true });
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(taskDir, "prd.md"), "FOREIGN TASK CONTENT");
    writeFileSync(
      join(taskDir, "task.json"),
      JSON.stringify({ id: "foreign-task", status: "in_progress" }),
    );
    writeFileSync(
      join(sessionsDir, "pi_process_foreign.json"),
      JSON.stringify({ current_task: "tasks/foreign-task" }),
    );

    try {
      const { trellisExtension } = loadExtensionInternals(root, {
        TRELLIS_CONTEXT_ID: "pi_process_foreign",
      });
      const handlers = new Map<
        string,
        (event: unknown, ctx?: unknown) => unknown
      >();
      trellisExtension({
        registerTool: vi.fn(),
        registerShortcut: vi.fn(),
        on(event, handler) {
          handlers.set(event, handler);
        },
      });
      const ctx = {
        sessionManager: {
          sessionId: "native-window-b",
          getSessionId(this: { sessionId: string }) {
            return this.sessionId;
          },
        },
        ui: { notify: vi.fn() },
      };

      handlers.get("session_start")?.({ type: "session_start" }, ctx);
      const bashEvent = {
        toolName: "bash",
        input: { command: "printf safe" },
      };
      handlers.get("tool_call")?.(bashEvent, ctx);
      expect(bashEvent.input.command).toBe(
        "export TRELLIS_CONTEXT_ID='pi_native-window-b'; printf safe",
      );

      const collisionKeys = ["native/window", "native:window"].map(
        (sessionId) => {
          const collisionHandlers = new Map<
            string,
            (event: unknown, ctx?: unknown) => unknown
          >();
          loadExtensionInternals(root).trellisExtension({
            on(event, handler) {
              collisionHandlers.set(event, handler);
            },
          });
          const event = {
            toolName: "bash",
            input: { command: "printf collision" },
          };
          collisionHandlers.get("tool_call")?.(event, {
            sessionManager: { getSessionId: () => sessionId },
          });
          return event.input.command.match(
            /^export TRELLIS_CONTEXT_ID='([^']+)'/,
          )?.[1];
        },
      );
      expect(collisionKeys[0]).toMatch(/^pi_native_window_[a-f0-9]{24}$/);
      expect(collisionKeys[1]).toMatch(/^pi_native_window_[a-f0-9]{24}$/);
      expect(collisionKeys[0]).not.toBe(collisionKeys[1]);

      const beforeAgentStart = handlers.get("before_agent_start")?.(
        { type: "before_agent_start", systemPrompt: "BASE" },
        ctx,
      ) as { systemPrompt?: string; message?: { content?: string } };
      expect(beforeAgentStart.systemPrompt).not.toContain("FOREIGN TASK CONTENT");
      expect(beforeAgentStart.message?.content).not.toContain(
        "FOREIGN TASK CONTENT",
      );

      const fallbackHandlers = new Map<
        string,
        (event: unknown, ctx?: unknown) => unknown
      >();
      loadExtensionInternals(root, {
        TRELLIS_CONTEXT_ID: "pi_process_foreign",
        // The ambient PI_SESSION_ID must not leak in: this branch asserts the
        // process-level fallback key, which only applies with no session id.
        PI_SESSION_ID: undefined,
        PI_SESSIONID: undefined,
      }).trellisExtension({
        on(event, handler) {
          fallbackHandlers.set(event, handler);
        },
      });
      const firstFallback = {
        toolName: "bash",
        input: { command: "printf one" },
      };
      const secondFallback = {
        toolName: "bash",
        input: { command: "printf two" },
      };
      fallbackHandlers.get("tool_call")?.(firstFallback);
      fallbackHandlers.get("tool_call")?.(secondFallback);
      const fallbackKey = firstFallback.input.command.match(
        /^export TRELLIS_CONTEXT_ID='([^']+)'/,
      )?.[1];
      expect(fallbackKey).toMatch(/^pi_process_[a-f0-9]{24}$/);
      expect(fallbackKey).not.toBe("pi_process_foreign");
      expect(secondFallback.input.command).toContain(
        `TRELLIS_CONTEXT_ID='${fallbackKey}'`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("scopes per-session caches by resolved root when ctx.cwd changes", () => {
    const root1 = createMinimalTrellisRoot();
    const root2 = createMinimalTrellisRoot();
    const sessionsDir1 = join(root1, ".trellis", ".runtime", "sessions");
    const sessionsDir2 = join(root2, ".trellis", ".runtime", "sessions");
    // Distinct task ids per root: the pointer names the task directory, so
    // this is what makes the two roots' context distinguishable.
    const taskDir1 = join(root1, ".trellis", "tasks", "task-one");
    const taskDir2 = join(root2, ".trellis", "tasks", "task-two");
    mkdirSync(sessionsDir1, { recursive: true });
    mkdirSync(sessionsDir2, { recursive: true });
    mkdirSync(taskDir1, { recursive: true });
    mkdirSync(taskDir2, { recursive: true });
    writeFileSync(join(taskDir1, "prd.md"), "ROOT ONE PRD CONTENT");
    writeFileSync(join(taskDir2, "prd.md"), "ROOT TWO PRD CONTENT");
    writeFileSync(
      join(taskDir1, "task.json"),
      JSON.stringify({ id: "task-one", status: "in_progress" }),
    );
    writeFileSync(
      join(taskDir2, "task.json"),
      JSON.stringify({ id: "task-two", status: "in_progress" }),
    );
    writeFileSync(
      join(sessionsDir1, "pi_shared-session.json"),
      JSON.stringify({ current_task: "tasks/task-one" }),
    );
    writeFileSync(
      join(sessionsDir2, "pi_shared-session.json"),
      JSON.stringify({ current_task: "tasks/task-two" }),
    );

    try {
      const { trellisExtension } = loadExtensionInternals();
      const handlers = new Map<
        string,
        (event: unknown, ctx?: unknown) => unknown
      >();
      trellisExtension({
        registerTool: vi.fn(),
        registerShortcut: vi.fn(),
        on(event, handler) {
          handlers.set(event, handler);
        },
      });
      const fire = (cwd: string) =>
        handlers.get("before_agent_start")?.(
          { type: "before_agent_start", systemPrompt: "BASE" },
          { cwd, sessionManager: { getSessionId: () => "shared-session" } },
        ) as { systemPrompt?: string; message?: { content?: string } };

      const first = fire(root1);
      expect(first.systemPrompt).toContain(".trellis/tasks/task-one");

      // Same session key but a different session cwd must NOT reuse the
      // first project's cached startup/task context.
      const second = fire(root2);
      expect(second.systemPrompt).toContain(".trellis/tasks/task-two");
      expect(second.systemPrompt).not.toContain(".trellis/tasks/task-one");
    } finally {
      rmSync(root1, { recursive: true, force: true });
      rmSync(root2, { recursive: true, force: true });
    }
  });

  it("re-asserts the current root's task context when a session switches back", () => {
    const root1 = createMinimalTrellisRoot();
    const root2 = createMinimalTrellisRoot();
    const sessionsDir1 = join(root1, ".trellis", ".runtime", "sessions");
    const sessionsDir2 = join(root2, ".trellis", ".runtime", "sessions");
    // Distinct task ids per root: the pointer names the task directory, so
    // this is what makes the two roots' context distinguishable.
    const taskDir1 = join(root1, ".trellis", "tasks", "task-one");
    const taskDir2 = join(root2, ".trellis", "tasks", "task-two");
    mkdirSync(sessionsDir1, { recursive: true });
    mkdirSync(sessionsDir2, { recursive: true });
    mkdirSync(taskDir1, { recursive: true });
    mkdirSync(taskDir2, { recursive: true });
    writeFileSync(join(taskDir1, "prd.md"), "ROOT ONE PRD CONTENT");
    writeFileSync(join(taskDir2, "prd.md"), "ROOT TWO PRD CONTENT");
    writeFileSync(
      join(taskDir1, "task.json"),
      JSON.stringify({ id: "task-one", status: "in_progress" }),
    );
    writeFileSync(
      join(taskDir2, "task.json"),
      JSON.stringify({ id: "task-two", status: "in_progress" }),
    );
    writeFileSync(
      join(sessionsDir1, "pi_shared-session.json"),
      JSON.stringify({ current_task: "tasks/task-one" }),
    );
    writeFileSync(
      join(sessionsDir2, "pi_shared-session.json"),
      JSON.stringify({ current_task: "tasks/task-two" }),
    );

    try {
      const { trellisExtension } = loadExtensionInternals();
      const handlers = new Map<
        string,
        (event: unknown, ctx?: unknown) => unknown
      >();
      trellisExtension({
        registerTool: vi.fn(),
        registerShortcut: vi.fn(),
        on(event, handler) {
          handlers.set(event, handler);
        },
      });
      const fire = (cwd: string) =>
        handlers.get("before_agent_start")?.(
          { type: "before_agent_start", systemPrompt: "BASE" },
          { cwd, sessionManager: { getSessionId: () => "shared-session" } },
        ) as { systemPrompt?: string; message?: { content?: string } };

      // A: first visit seeds the snapshot into the system prompt; the
      // persisted history carries only the breadcrumb.
      const a1 = fire(root1);
      expect(a1.message?.content).toContain("<workflow-state>");
      expect(a1.message?.content).not.toContain(
        "<trellis-task-context-update>",
      );

      // A -> B: the switch re-asserts B's task context as a persisted
      // update (it supersedes the system-prompt context).
      const b = fire(root2);
      expect(b.message?.content).toContain("<trellis-task-context-update>");
      expect(b.message?.content).toContain(".trellis/tasks/task-two");

      // B -> A with unchanged A on disk: A's task context must be re-emitted
      // so the most recent persisted update belongs to A, not B.
      const a2 = fire(root1);
      expect(a2.message?.content).toContain("<trellis-task-context-update>");
      expect(a2.message?.content).toContain(".trellis/tasks/task-one");
      expect(a2.message?.content).not.toContain(".trellis/tasks/task-two");
    } finally {
      rmSync(root1, { recursive: true, force: true });
      rmSync(root2, { recursive: true, force: true });
    }
  });

  it("cmdHasTrellisCtx detects already-prefixed bash commands", () => {
    const { cmdHasTrellisCtx } = loadExtensionInternals();

    expect(cmdHasTrellisCtx("export TRELLIS_CONTEXT_ID=foo; ls")).toBe(true);
    expect(cmdHasTrellisCtx("TRELLIS_CONTEXT_ID=foo ls")).toBe(true);
    expect(cmdHasTrellisCtx("env TRELLIS_CONTEXT_ID=foo ls")).toBe(true);
    expect(cmdHasTrellisCtx("ls -la")).toBe(false);
    expect(cmdHasTrellisCtx("")).toBe(false);
  });

  it("shellQuote single-quotes values and escapes embedded single quotes", () => {
    const { shellQuote } = loadExtensionInternals();

    expect(shellQuote("simple")).toBe("'simple'");
    expect(shellQuote("with space")).toBe("'with space'");
    expect(shellQuote("with 'quote'")).toBe("'with '\\''quote'\\'''");
  });

});

