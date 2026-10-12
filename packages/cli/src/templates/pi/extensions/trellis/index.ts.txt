import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { homedir } from "node:os";
import { spawn, spawnSync } from "node:child_process";

// ── Types ──────────────────────────────────────────────────────────────
type JsonObject = Record<string, unknown>;
type TextContent = { type: "text"; text: string };
interface PiToolResult {
  content: TextContent[];
  details?: unknown;
}
interface PiExtensionContext {
  cwd?: string;
  hasUI?: boolean;
  model?: {
    provider?: string;
    id?: string;
  };
  sessionManager?: {
    getSessionId?: () => string;
    getSessionFile?: () => string | undefined;
  };
  ui?: {
    notify?: (msg: string, type?: "info" | "warning" | "error") => void;
  };
}

const SESSION_OVERVIEW_TIMEOUT_MS = 1500;

// ── Utilities ─────────────────────────────────────────────────────────
function isObj(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function hash(s: string) {
  return createHash("sha256").update(s).digest("hex").slice(0, 24);
}
function readText(p: string) {
  try {
    return readFileSync(p, "utf-8");
  } catch {
    return "";
  }
}
function exists(p: string) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
function shellQuote(v: string) {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}
/**
 * Whether a bash command already carries the Trellis session context id.
 *
 * The `tool_call` hook prefixes every bash command with
 * `export TRELLIS_CONTEXT_ID=...`; this guard keeps it from double-prefixing a
 * command that already has it (a re-run of a previously rewritten command, or
 * one the user wrote by hand). Matching only at a command position — start of
 * the command, after `env`/`export`, or after a shell separator — keeps a mere
 * mention inside an argument (e.g. `echo TRELLIS_CONTEXT_ID=x`) from
 * suppressing the injection.
 */
function cmdHasTrellisCtx(cmd: string): boolean {
  return /(^|[;&|]|\benv\s|\bexport\s)\s*TRELLIS_CONTEXT_ID=/.test(cmd);
}
function callStr(
  cb: (() => string | undefined) | undefined,
  receiver?: unknown,
): string | null {
  if (!cb) return null;
  try {
    return str(cb.call(receiver));
  } catch {
    return null;
  }
}
function lookupStr(data: unknown, keys: string[]): string | null {
  if (!isObj(data)) return null;
  for (const k of keys) {
    const v = str(data[k]);
    if (v) return v;
  }
  for (const nk of [
    "input",
    "properties",
    "event",
    "hook_input",
    "hookInput",
  ]) {
    const nested = data[nk];
    const v = lookupStr(nested, keys);
    if (v) return v;
  }
  return null;
}

interface JsonlEntry {
  file: string;
  type: string;
  reason: string;
}
function readJsonlEntries(basePath: string, jsonlPath: string): JsonlEntry[] {
  const text = readText(join(basePath, jsonlPath));
  if (!text) return [];
  const entries: JsonlEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const item = JSON.parse(t) as JsonObject;
      const filePath =
        (typeof item.file === "string" && item.file) ||
        (typeof item.path === "string" && item.path) ||
        "";
      if (!filePath) continue;
      entries.push({
        file: filePath,
        type: typeof item.type === "string" ? item.type : "file",
        reason: (typeof item.reason === "string" && item.reason) || "-",
      });
    } catch {}
  }
  return entries;
}

// ── Trellis Context ────────────────────────────────────────────────────
function findRoot(start: string): string {
  let c = resolve(start);
  while (true) {
    // Only a directory with `.trellis/` is a Trellis project root. A bare
    // `.pi` can be pi's global config (`~/.pi`) or an unrelated project, so
    // accepting it here made root resolution stop too early (e.g. on `~`).
    // Also reject a regular file named `.trellis` — the marker must be a
    // directory.
    const marker = join(c, ".trellis");
    if (existsSync(marker) && statSync(marker).isDirectory()) return c;
    const p = dirname(c);
    if (p === c) return resolve(start);
    c = p;
  }
}
// Resolve the project root from the session working directory when available
// (pi's ExtensionContext.cwd), falling back to the pi host process cwd.
// process.cwd() is the host's launch directory and can differ from the
// session cwd (pi-web / RPC / multi-project hosts), which made .pi/agents
// lookups fail or resolve to the wrong project.
function resolveRoot(ctx?: PiExtensionContext): string {
  return findRoot(ctx?.cwd ?? process.cwd());
}
// Cache key scoping per-session state by both the session key and the
// resolved project root. With dynamic root resolution a session can observe
// different ctx.cwd values over its lifetime (pi-web / RPC / project
// switching); keying caches by the session key alone would leak one
// project's startup/task context into another.
function cacheKey(k: string | null, ctx?: PiExtensionContext): string {
  return `${k ?? "default"}::${resolveRoot(ctx)}`;
}

function contextKey(input?: unknown, ctx?: PiExtensionContext): string | null {
  const sessionId =
    callStr(ctx?.sessionManager?.getSessionId, ctx?.sessionManager) ??
    str(process.env.PI_SESSION_ID) ??
    str(process.env.PI_SESSIONID) ??
    lookupStr(input, ["session_id", "sessionId", "sessionID"]);
  if (sessionId) {
    const normalized = sessionId.replace(/[^A-Za-z0-9._-]+/g, "_");
    if (!normalized) return `pi_${hash(sessionId)}`;
    return `pi_${normalized}${normalized === sessionId ? "" : `_${hash(sessionId)}`}`;
  }
  const transcriptPath =
    callStr(ctx?.sessionManager?.getSessionFile, ctx?.sessionManager) ??
    lookupStr(input, ["transcript_path", "transcriptPath", "transcript"]);
  if (transcriptPath) return `pi_transcript_${hash(transcriptPath)}`;
  return null;
}

/**
 * Return `candidate` when it lands inside `root`, else null.
 *
 * A session pointer is not always something the user typed. `task.py` now
 * refuses to store a ref that leaves the project, but a session file written
 * before that fix can still hold one, and `trellis update` does not rewrite
 * session files — so a poisoned pointer outlives the upgrade that closed the
 * writer. Both sides are resolved so a task directory symlinked outside is
 * refused too, but the original `candidate` is returned on success: callers do
 * `relative(root, dir)`, and handing them a realpath would break that whenever
 * `root` itself sits behind a symlink (`/tmp` does on macOS).
 */
function containInRoot(root: string, candidate: string): string | null {
  try {
    const rel = relative(realpathSync(root), realpathSync(candidate));
    if (rel !== "" && (rel.startsWith("..") || isAbsolute(rel))) return null;
    return candidate;
  } catch {
    return null;
  }
}

function readTaskDir(root: string, key: string | null): string | null {
  if (!key) return null;
  try {
    const ctx = JSON.parse(
      readText(join(root, ".trellis", ".runtime", "sessions", `${key}.json`)),
    ) as JsonObject;
    let ref = str(ctx.current_task);
    if (!ref) return null;
    ref = ref;
    ref = ref.replace(/\\/g, "/").replace(/^\.\//, "");
    if (ref.startsWith("tasks/")) ref = `.trellis/${ref}`;
    const candidate = ref.startsWith(".trellis/")
      ? join(root, ref)
      : isAbsolute(ref)
        ? ref
        : join(root, ".trellis", "tasks", ref);
    return containInRoot(root, candidate);
  } catch {
    return null;
  }
}

// ── Workflow State Breadcrumb ─────────────────────────────────────────
const WF_RE =
  /\[workflow-state:([A-Za-z0-9_-]+)\]\s*\n([\s\S]*?)\n\s*\[\/workflow-state:\1\]/g;
// The step whose guidance is emitted per turn for a given task status. Pi
// resolves `planning` and `in_progress` directly, and both carry required
// steps.
function stepForStatus(status: string): string {
  return status === "planning" ? "1.1" : status === "in_progress" ? "2.1" : "";
}

// Step detail is read from disk on every turn but returns the same bytes while
// the status is unchanged, so the per-process copy keeps the repeated python
// spawn off the hot path (same reason as `startupCtxCache`).
const stepDetailCache = new Map<string, string>();
function stepDetail(root: string, key: string | null, step: string): string {
  const ck = `${root}\u0000${step}`;
  const hit = stepDetailCache.get(ck);
  if (hit !== undefined) return hit;
  const out = runContextScript(root, key, [
    "--mode",
    "phase",
    "--platform",
    "pi",
    "--step",
    step,
  ]).trim();
  stepDetailCache.set(ck, out);
  return out;
}

function workflowBreadcrumb(root: string, key: string | null): string {
  const wf = readText(join(root, ".trellis", "workflow.md"));
  if (!wf) return "";
  const templates: Record<string, string> = {};
  for (const m of wf.matchAll(WF_RE)) {
    const s = m[1] ?? "",
      b = (m[2] ?? "").trim();
    if (s && b) templates[s] = b;
  }
  const dir = readTaskDir(root, key);
  const lines: string[] = [];
  // A stale runtime pointer can name a task directory that no longer exists
  // (task archived, pointer not cleared). Treat an unreadable task.json as "no
  // active task" so the triage instruction is not suppressed forever by a
  // header the model cannot act on.
  let status = "",
    id = "",
    taskDir = "",
    worktreePath = "";
  if (dir) {
    try {
      const d = JSON.parse(readText(join(dir, "task.json"))) as JsonObject;
      status = str(d.status) ?? "";
      id = str(d.id) ?? dir.split(/[\\/]/).pop() ?? "";
      worktreePath = str(d.worktree_path) ?? "";
      if (status) taskDir = dir;
    } catch {}
  }
  if (taskDir) {
    // While a task is underway this per-turn line is the only place that names
    // the artifacts and the skills: the full phase index is no longer injected
    // and the workflow.md body only says "load trellis-before-dev", which the
    // model skipped. Emit the active step's own guidance
    // (`get_context.py --mode phase --step 2.1`, ~1 KB, the same text the
    // skill would have produced) and name the artifacts by path. The step
    // detail is byte-stable for a status, so this still dedups per status.
    // See PATCHES.md, "the breadcrumb had to carry the phase step".
    const step = stepForStatus(status);
    const detail = step ? stepDetail(root, key, step) : "";
    const artifacts = ["prd.md", "design.md", "implement.md"].filter((f) =>
      exists(join(taskDir, f)),
    );
    lines.push(`Task: ${id || taskDir.split(/[\\/]/).pop()} (${status || "unknown"})`);
    lines.push(`Task dir: ${relative(root, taskDir).replace(/\\/g, "/")}`);
    // The project-level parallel-isolation rule lives in AGENTS.md as 9 prose
    // bullets; it is fully injected but easy to lose at turn 200. The actual
    // worktree is recorded in task.json by the after_start hook, so the
    // breadcrumb can state it as one line — the model no longer has to find
    // the rule in a 124-line document to follow it.
    if (worktreePath)
      lines.push(
        `Worktree: ${worktreePath} — write code there, keep the main checkout clean (AGENTS.md parallel-isolation rule).`,
      );
    if (artifacts.length)
      lines.push(`Read before editing: ${artifacts.join(", ")} in that directory.`);
    // A `-inline` twin wins over the plain body. Pi resolves the status to a
    // phase step first, so this line only decides the fallback — but on that
    // fallback the plain body would tell Pi to dispatch sub-agents, which is
    // the opposite of what an inline platform does.
    lines.push(
      detail ||
        templates[`${status}-inline`] ||
        templates[status] ||
        "Refer to workflow.md for current step.",
    );
  } else {
    lines.push("Status: no_task");
    lines.push(templates.no_task ?? "Refer to workflow.md for current step.");
  }
  return `<workflow-state>\n${lines.join("\n")}\n</workflow-state>`;
}

// ── Session Overview ───────────────────────────────────────────────────
function runContextScript(root: string, key: string | null, args: string[]): string {
  const script = join(root, ".trellis", "scripts", "get_context.py");
  if (!exists(script)) return "";
  try {
    const py = process.platform === "win32" ? "python" : "python3";
    const result = spawnSync(py, [script, ...args], {
      cwd: root,
      env: key ? { ...process.env, TRELLIS_CONTEXT_ID: key } : process.env,
      encoding: "utf-8",
      timeout: SESSION_OVERVIEW_TIMEOUT_MS,
      windowsHide: true,
    });
    if (result.status !== 0) return "";
    const stdout = (result.stdout ?? "").trim();
    return stdout;
  } catch {
    return "";
  }
}

function sessionOverview(root: string, key: string | null): string {
  const stdout = runContextScript(root, key, []);
  return stdout ? `<session-overview>\n${stdout}\n</session-overview>` : "";
}

function buildStartupContext(
  root: string,
  key: string | null,
  overview: string,
): string {
  return [
    "<session-context>\nTrellis compact SessionStart context. Use it to orient the session; load details on demand.\n</session-context>",
    overview,
    "<ready>\nUse the current workflow state to decide whether to create, continue, or skip a Trellis task.\nWhile a Trellis task is active, its artifacts (prd.md, design.md, implement.md) and the spec files they name are required reading before any code is written.\n</ready>",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Inline-mode task pointer. The main session edits code directly, so the
 * full implement-agent context (prd/design/implement plus curated specs) is
 * not broadcast into the system prompt; the artifacts stay on disk and are
 * read on demand via `trellis-before-dev`. */
function buildTaskPointer(root: string, key: string | null): string {
  const dir = readTaskDir(root, key);
  if (!dir) return "";
  const rel = relative(root, dir).replace(/\\/g, "/");
  const artifacts = ["prd.md", "design.md", "implement.md"].filter((f) =>
    exists(join(dir, f)),
  );
  const lines = [
    "## Trellis Task",
    `Task directory: ${rel}`,
    artifacts.length
      ? `Artifacts: ${artifacts.join(", ")}`
      : "Artifacts: (none)",
  ];
  // Curated spec/research manifest. Inline mode does not inject the bodies
  // (they are large and churn), but the manifest is the only record of which
  // cross-task specs apply, so list path + reason and let the agent read them
  // on demand. implement.jsonl and check.jsonl hold the same file set in
  // practice, so the union is listed once; a file unique to check.jsonl still
  // appears, tagged. Skipped when empty so simple tasks stay terse.
  const implementEntries = readJsonlEntries(dir, "implement.jsonl").filter(
    (e) => e.type !== "directory",
  );
  const checkOnly = readJsonlEntries(dir, "check.jsonl")
    .filter((e) => e.type !== "directory")
    .filter((e) => !implementEntries.some((i) => i.file === e.file));
  if (implementEntries.length || checkOnly.length) {
    lines.push("Curated spec/research to read before editing or checking:");
    for (const e of implementEntries) lines.push(`- \`${e.file}\` — ${e.reason}`);
    for (const e of checkOnly)
      lines.push(`- \`${e.file}\` — ${e.reason} (check only)`);
  }
  lines.push(
    "Load `trellis-before-dev` before editing; read the artifacts and curated files above on demand.",
  );
  return lines.join("\n");
}

// ── Extension ──────────────────────────────────────────────────────────
export default function trellisExtension(pi: {
  registerTool?: (tool: JsonObject) => void;
  registerShortcut?: (
    key: string,
    opts: {
      description?: string;
      handler: (ctx: PiExtensionContext) => unknown;
    },
  ) => void;
  on?: (
    event: string,
    handler: (event: unknown, ctx?: PiExtensionContext) => unknown,
  ) => void;
  getThinkingLevel?: () => string;
}): void {
  if (process.env.TRELLIS_SUBAGENT_CHILD === "1") return;
  // Process-level fallback; call sites with a session context re-resolve via
  // resolveRoot(ctx) so the active project (session cwd) is used instead.
  const root = resolveRoot();
  const procKey = `pi_process_${hash([root, process.pid, Date.now(), randomBytes(8).toString("hex")].join(":"))}`;
  let curKey: string | null = null;

  const getKey = (input?: unknown, ctx?: PiExtensionContext) => {
    const k = contextKey(input, ctx) ?? curKey ?? procKey;
    curKey = k;
    return k;
  };

  // Per-turn cache to avoid double-spawning python
  let turnCache: {
    key: string;
    ts: number;
    wf: string;
  } | null = null;
  const getTurnCtx = (k: string | null, ctx?: PiExtensionContext) => {
    const now = Date.now();
    const ck = cacheKey(k, ctx);
    if (turnCache && turnCache.key === ck && now - turnCache.ts < 1500)
      return turnCache;
    const r = resolveRoot(ctx);
    turnCache = {
      key: ck,
      ts: now,
      wf: workflowBreadcrumb(r, k),
    };
    return turnCache;
  };
  // Provider prefix caches invalidate from byte 0 whenever the system prompt
  // changes, so everything injected into systemPrompt is memoized per context
  // key and stays byte-identical for the life of the process. Volatile state
  // travels through persisted custom messages instead (append-only history).
  const startupCtxCache = new Map<string, string>();
  const getStartupCtx = (k: string | null, ctx?: PiExtensionContext): string => {
    const r = resolveRoot(ctx);
    // Keyed by task as well as session. This snapshot lives in the system
    // prompt, so a mid-session task switch must rebuild it; otherwise the
    // overview keeps describing the previous task while the breadcrumb
    // (the authority) has already moved on.
    const key = `${cacheKey(k, ctx)}::${readTaskDir(r, k) ?? ""}`;
    let startup = startupCtxCache.get(key);
    if (startup === undefined) {
      // The session overview is orientation-only. Volatile state (the workflow
      // breadcrumb) travels through persisted messages instead.
      startup = buildStartupContext(r, k, sessionOverview(r, k));
      startupCtxCache.set(key, startup);
    }
    return startup;
  };
  const taskCtxSnapshot = new Map<string, string>();
  const lastSentTaskCtx = new Map<string, string>();
  // Session-level "most recently persisted" project root. The root-scoped
  // lastSentTaskCtx map suppresses re-emission for an unchanged root, but when
  // a session switches projects (A -> B -> A) the latest persisted update
  // would otherwise stay B's — and its <trellis-task-context-update>
  // explicitly supersedes the system-prompt context. Re-assert the current
  // root's task context on every root transition so the agent never keeps
  // following the previous project's instructions.
  const lastPersistedRoot = new Map<string, string>();

  // Tool registration

  // Events
  pi.on?.("session_start", (event, ctx) => {
    getKey(event, ctx);
    ctx?.ui?.notify?.(
      "Trellis project context is available. Use /trellis-start to bootstrap or /trellis-continue to resume.",
      "info",
    );
  });
  pi.on?.("tool_call", (event, ctx) => {
    const k = getKey(event, ctx);
    const ev = event as { toolName?: string; input?: JsonObject };
    if (
      ev.toolName === "bash" &&
      isObj(ev.input) &&
      typeof ev.input.command === "string" &&
      !cmdHasTrellisCtx(ev.input.command)
    )
      ev.input.command = `export TRELLIS_CONTEXT_ID=${shellQuote(k)}; ${ev.input.command}`;
  });
  pi.on?.("before_agent_start", (event, ctx) => {
    const k = getKey(event, ctx);
    const key = cacheKey(k, ctx);
    const cur = (event as { systemPrompt?: string }).systemPrompt ?? "";
    const root = resolveRoot(ctx);
    const turn = getTurnCtx(k, ctx);
    const startup = getStartupCtx(k, ctx);
    // Inline mode: the main session edits code directly, so only a task
    // pointer is snapshotted into systemPrompt. The full implement-agent
    // context stays on disk and is read on demand via `trellis-before-dev`.
    const taskPointer = buildTaskPointer(root, k);
    // Same reasoning as getStartupCtx: keyed by task so a mid-session switch
    // rebuilds the pointer instead of leaving it aimed at the previous task's
    // directory.
    const snapshotKey = `${key}::${readTaskDir(root, k) ?? ""}`;
    let taskCtx = taskCtxSnapshot.get(snapshotKey);
    if (taskCtx === undefined) {
      taskCtx = taskPointer;
      taskCtxSnapshot.set(snapshotKey, taskCtx);
      lastSentTaskCtx.set(key, taskPointer);
    }
    const updates: string[] = [];
    // Volatile state travels as an append-only persisted message, and the
    // breadcrumb is re-asserted on *every* turn — there is no cross-turn dedup.
    //
    // With no active task the breadcrumb is the only thing that asks the model
    // to consider creating one: Phase 2's dispatch instructions do not apply
    // (Pi registers no Task/Agent tool) and the phase index that used to
    // re-assert the triage rules every turn is gone. Deduping it would leave
    // that instruction in turn 1 only, buried under everything after it.
    //
    // An active task is not the escape hatch it looks like either: its step
    // detail is the only per-turn text that names the task artifacts, and it
    // vanishes the moment the persisted copy is older than whatever the model
    // is doing now. Compaction and context_edit both rewrite history, so a
    // "same text" key would have produced no message at exactly the turns the
    // reminder was most needed (measured: nine duplicates in one pre-patch
    // session, all immediately after compaction).
    //
    // Re-asserting every turn costs ~500 bytes next to a ~40 KB request, so the
    // same-turn cache in getTurnCtx (the 1.5s window above) is the only dedup.
    if (turn.wf) updates.push(turn.wf);
    // Re-assert the current root's context on project switches: when the
    // session returns to an unchanged root, lastSentTaskCtx alone would leave
    // the previous project's persisted update as the most recent one in
    // history.
    const prevRoot = lastPersistedRoot.get(k ?? "default");
    const switchedRoot = prevRoot !== undefined && prevRoot !== root;
    if (taskPointer && (taskPointer !== lastSentTaskCtx.get(key) || switchedRoot)) {
      lastSentTaskCtx.set(key, taskPointer);
      updates.push(
        "<trellis-task-context-update>\nTask context changed on disk. This supersedes the Trellis Task Context in the system prompt.\n\n" +
          taskPointer +
          "\n</trellis-task-context-update>",
      );
    }
    if (updates.length > 0) lastPersistedRoot.set(k ?? "default", root);
    const content = updates.join("\n\n");
    return {
      message: content
        ? {
            customType: "trellis-runtime-context",
            content,
            display: false,
          }
        : undefined,
      systemPrompt: [cur, startup, taskCtx].filter(Boolean).join("\n\n"),
    };
  });
  pi.on?.("context", (event, ctx) => {
    getKey(event, ctx);
  });
}
