import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "../server/app.js";
import { resolveStartupWorkspace } from "../server/startup-workspace.js";

const exec = promisify(execFile);
const apps: ReturnType<typeof buildServer>[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function createRepository(label: string) {
  const repository = await mkdtemp(join(tmpdir(), `redline-${label}-`));
  temporaryDirectories.push(repository);
  await exec("git", ["init", "-b", "main"], { cwd: repository });
  await exec("git", ["config", "user.email", "redline@example.test"], {
    cwd: repository,
  });
  await exec("git", ["config", "user.name", "Redline Test"], {
    cwd: repository,
  });
  await writeFile(
    join(repository, "reviewed.ts"),
    "export const reviewed = true;\n",
    "utf8",
  );
  await exec("git", ["add", "reviewed.ts"], { cwd: repository });
  await exec("git", ["commit", "-m", "fixture"], { cwd: repository });
  await writeFile(
    join(repository, "reviewed.ts"),
    "export const reviewed = false;\n",
    "utf8",
  );
  return repository;
}

describe("startup workspace selection", () => {
  it.each([undefined, "", "   \t"])(
    "uses the captured startup directory for a blank override (%j)",
    (override) => {
      expect(resolveStartupWorkspace(override, "/workspace/from-startup")).toBe(
        "/workspace/from-startup",
      );
    },
  );

  it("preserves a nonblank explicit override as the authoritative value", () => {
    expect(
      resolveStartupWorkspace(
        "  /workspace/from-env  ",
        "/workspace/from-startup",
      ),
    ).toBe("  /workspace/from-env  ");
  });

  it("operates on the selected startup workspace", async () => {
    const startupWorkspace = await createRepository("startup");
    const app = buildServer({
      workspaceDir: resolveStartupWorkspace(undefined, startupWorkspace),
    });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/api/workspace" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      root: startupWorkspace,
      files: [{ path: "reviewed.ts" }],
    });
  });

  it("uses a valid explicit override instead of a different valid startup workspace", async () => {
    const startupWorkspace = await createRepository("startup-precedence");
    const overrideWorkspace = await createRepository("override-precedence");
    const app = buildServer({
      workspaceDir: resolveStartupWorkspace(
        overrideWorkspace,
        startupWorkspace,
      ),
    });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/api/workspace" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ root: overrideWorkspace });
  });

  it("fails on an invalid explicit override instead of falling back to a valid startup workspace", async () => {
    const startupWorkspace = await createRepository("no-fallback");
    const invalidOverride = join(startupWorkspace, "missing-workspace");
    const app = buildServer({
      workspaceDir: resolveStartupWorkspace(invalidOverride, startupWorkspace),
    });
    apps.push(app);

    await expect(app.ready()).rejects.toThrow(
      `Redline could not open the selected workspace "${invalidOverride}". ` +
        "Launch Redline from a Git worktree or set REDLINE_WORKSPACE to a valid Git workspace.",
    );
  });

  it("fails predictably when the default startup directory is not a Git workspace", async () => {
    const invalidStartup = await mkdtemp(
      join(tmpdir(), "redline-invalid-startup-"),
    );
    temporaryDirectories.push(invalidStartup);
    const app = buildServer({
      workspaceDir: resolveStartupWorkspace(undefined, invalidStartup),
    });
    apps.push(app);

    await expect(app.ready()).rejects.toThrow(
      `selected workspace "${invalidStartup}"`,
    );
  });
});
