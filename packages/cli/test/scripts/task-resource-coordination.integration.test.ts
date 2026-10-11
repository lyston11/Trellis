/** Integration tests for task coordination claims and start blocking. */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEMPLATE_SCRIPTS = path.resolve(__dirname, "../../src/templates/trellis/scripts");

function setupRepo(tmp: string): void {
  fs.mkdirSync(path.join(tmp, ".trellis", "scripts"), { recursive: true });
  fs.cpSync(TEMPLATE_SCRIPTS, path.join(tmp, ".trellis", "scripts"), { recursive: true });
  fs.writeFileSync(path.join(tmp, ".trellis", ".developer"), "name=tester\n");
  fs.writeFileSync(path.join(tmp, ".trellis", "config.yaml"), "session_auto_commit: false\n");
}

function runTask(repo: string, ...args: string[]) {
  return spawnSync("python3", [".trellis/scripts/task.py", ...args], {
    cwd: repo,
    encoding: "utf-8",
    env: { ...process.env, TRELLIS_DEVELOPER: "tester", TRELLIS_CONTEXT_ID: "coord-test" },
  });
}

function taskDir(repo: string, slug: string): string {
  const name = fs.readdirSync(path.join(repo, ".trellis", "tasks")).find((item) => item.endsWith(`-${slug}`));
  if (!name) throw new Error(`task not found: ${slug}`);
  return `.trellis/tasks/${name}`;
}

function taskJson(repo: string, dir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(repo, dir, "task.json"), "utf-8"));
}

describe.skipIf(!(() => {
  try { execFileSync("python3", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
})())("task coordination", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-coordination-test-"));
    setupRepo(tmp);
  });

  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("stores normalized path claims and rejects unsafe paths", () => {
    const created = runTask(tmp, "create", "claim one", "--description", "d", "--slug", "claim-one", "--no-start");
    expect(created.status).toBe(0);
    const dir = taskDir(tmp, "claim-one");
    expect(runTask(tmp, "claim-paths", dir, "backend\\app\\services\\memory_rag.py").status).toBe(0);
    expect(taskJson(tmp, dir).coordination).toMatchObject({
      owned_paths: ["backend/app/services/memory_rag.py"],
    });
    const unsafe = runTask(tmp, "claim-paths", dir, "../outside.py");
    expect(unsafe.status).toBe(1);
    expect(unsafe.stderr).toContain("may not contain '..'");
  });

  it("blocks overlapping in-progress tasks before status or pointer writes", () => {
    for (const slug of ["first", "second"]) {
      expect(runTask(tmp, "create", slug, "--description", "d", "--slug", slug, "--no-start").status).toBe(0);
    }
    const first = taskDir(tmp, "first");
    const second = taskDir(tmp, "second");
    expect(runTask(tmp, "claim-paths", first, "backend/app/services/memory_rag.py").status).toBe(0);
    expect(runTask(tmp, "claim-paths", second, "backend/app/services/memory_rag.py").status).toBe(0);
    expect(runTask(tmp, "start", first).status).toBe(0);
    const blocked = runTask(tmp, "start", second);
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain("declared paths overlap");
    expect(blocked.stderr).toContain("memory_rag.py");
    expect(taskJson(tmp, second).status).toBe("planning");
    expect(runTask(tmp, "current").stdout).toContain(first.split("/").at(-1));
  });

  it("does not let a planning task block an active task", () => {
    for (const slug of ["active", "planned"]) {
      expect(runTask(tmp, "create", slug, "--description", "d", "--slug", slug, "--no-start").status).toBe(0);
    }
    const active = taskDir(tmp, "active");
    const planned = taskDir(tmp, "planned");
    expect(runTask(tmp, "claim-paths", active, "backend/app/services/shared.py").status).toBe(0);
    expect(runTask(tmp, "claim-paths", planned, "backend/app/services/shared.py").status).toBe(0);
    expect(runTask(tmp, "start", active).status).toBe(0);
    expect(taskJson(tmp, planned).status).toBe("planning");
  });

  it("rejects blocker cycles and reports integration preflight failures", () => {
    for (const slug of ["a", "b"]) {
      expect(runTask(tmp, "create", slug, "--description", "d", "--slug", slug, "--no-start").status).toBe(0);
    }
    const a = taskDir(tmp, "a");
    const b = taskDir(tmp, "b");
    expect(runTask(tmp, "add-blocker", a, b).status).toBe(0);
    const cycle = runTask(tmp, "add-blocker", b, a);
    expect(cycle.status).toBe(1);
    expect(cycle.stderr).toContain("dependency cycle");
    expect(runTask(tmp, "start", a).status).toBe(1);
    expect(taskJson(tmp, a).status).toBe("planning");
  });
});
