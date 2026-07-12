import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../server/app.js";
import { ReviewDatabase } from "../server/review-database.js";
import { ReviewWorkspace } from "../server/review-workspace.js";
import type {
  CommentExportResponse,
  DiffResponse,
  GitHubImportStatus,
  ReviewComment,
  ReviewDataResponse,
} from "../shared/review-contract.js";
import { DEFAULT_THEME_PREFERENCE } from "../shared/theme.js";
import { DEFAULT_TYPOGRAPHY_PREFERENCE } from "../shared/typography.js";

const executeFile = promisify(execFile);
const isolatedGitEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
);

function exec(file: string, args: string[], options: { cwd: string }) {
  return executeFile(file, args, { ...options, env: isolatedGitEnvironment });
}
let repository = "";

async function runGit(...args: string[]) {
  await exec("git", args, { cwd: repository });
}

beforeEach(async () => {
  repository = await mkdtemp(join(tmpdir(), "redline-review-"));
  await runGit("init");
  await runGit("config", "user.email", "redline@example.test");
  await runGit("config", "user.name", "Redline Test");
  await writeFile(
    join(repository, "example.ts"),
    "export const count = 1;\n",
    "utf8",
  );
  await runGit("add", "example.ts");
  await runGit("commit", "-m", "initial");
  await writeFile(
    join(repository, "example.ts"),
    "export const count = 2;\nexport const ready = true;\n",
    "utf8",
  );
});

afterEach(async () => {
  await rm(repository, { recursive: true, force: true });
});

describe("workspace initialization", () => {
  it("verifies imported threads before lookup and preserves GitHub staleness", async () => {
    const workspace = new ReviewWorkspace(repository);
    try {
      await workspace.initialize();
      const current = (await workspace.getDiff("example.ts")).fingerprint;
      const id = "github:base/project#1:thread-1";
      const steps: string[] = [];
      const manager = {
        isImportedId: (candidate: string) => candidate === id,
        verifyForRead: (): Promise<GitHubImportStatus> => {
          steps.push("verify");
          return Promise.resolve({
            version: 1,
            state: "available",
            retained: true,
            stale: false,
            message: "Available.",
          });
        },
      };
      const internals = workspace as unknown as {
        githubImports: typeof manager;
        importedReviewComments(): Promise<ReviewComment[]>;
      };
      internals.githubImports = manager;
      internals.importedReviewComments = () => {
        steps.push("lookup");
        return Promise.resolve([
          {
            id,
            path: "example.ts",
            anchors: [],
            body: "Outdated upstream thread",
            author: {
              name: "Reviewer",
              login: "reviewer",
              initials: "R",
              avatarUrl: null,
            },
            createdAt: "2026-07-12T00:00:00.000Z",
            fingerprint: current,
            outdated: true,
            state: "pending",
            rootVersion: 1,
            threadRevision: 0,
            replies: [],
            source: "github",
            readOnly: true,
            github: {
              repository: "base/project",
              pullRequest: 1,
              threadId: "thread-1",
              url: "https://github.com/base/project/pull/1#discussion_r1",
              mapping: "unmapped",
              originalPath: "example.ts",
              isResolved: false,
              isOutdated: true,
              resolved: false,
              synchronizedAt: "2026-07-12T00:00:00.000Z",
            },
          },
        ]);
      };

      const packet = await workspace.getThreadPacket(id);
      expect(steps).toEqual(["verify", "lookup"]);
      expect(packet.comment.outdated).toBe(true);
    } finally {
      workspace.close();
    }
  });

  it("defers the full workspace scan until workspace data is requested", async () => {
    const workspace = new ReviewWorkspace(repository);
    const getWorkspace = vi.spyOn(workspace, "getWorkspace");

    try {
      await workspace.initialize();

      expect(getWorkspace).not.toHaveBeenCalled();

      await workspace.openWorkspace(repository);
      expect(getWorkspace).toHaveBeenCalledOnce();
    } finally {
      workspace.close();
    }
  });

  it("ignores inherited local Git environment variables", async () => {
    const previousGitDir = process.env.GIT_DIR;
    process.env.GIT_DIR = join(repository, "missing-git-dir");
    const workspace = new ReviewWorkspace(repository);
    try {
      await workspace.initialize();
      await expect(workspace.getWorkspace()).resolves.toMatchObject({
        root: repository,
      });
    } finally {
      workspace.close();
      if (previousGitDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previousGitDir;
    }
  });
});

describe("local review snapshots", () => {
  it("keeps an unchanged file approved and invalidates approval after its bytes change", async () => {
    const workspace = new ReviewWorkspace(repository);
    await workspace.initialize();

    const initial = await workspace.getWorkspace();
    expect(initial.files).toHaveLength(1);
    expect(initial.files[0]?.reviewStatus).toBe("unreviewed");

    const approved = await workspace.approveSnapshot();
    expect(approved.workspace.files[0]?.reviewStatus).toBe("approved");
    expect(approved.snapshot.changedCount).toBe(0);

    const unchanged = await workspace.getWorkspace();
    expect(unchanged.files[0]?.reviewStatus).toBe("approved");

    await runGit("add", "example.ts");
    const afterStaging = await workspace.getWorkspace();
    expect(afterStaging.files[0]?.reviewStatus).toBe("approved");
    await runGit("reset", "example.ts");

    await writeFile(
      join(repository, "unrelated.txt"),
      "land this separately\n",
      "utf8",
    );
    await runGit("add", "unrelated.txt");
    await runGit("commit", "-m", "unrelated commit");
    const afterUnrelatedHeadChange = await workspace.getWorkspace();
    expect(
      afterUnrelatedHeadChange.files.find((file) => file.path === "example.ts")
        ?.reviewStatus,
    ).toBe("approved");

    await writeFile(
      join(repository, "example.ts"),
      "export const count = 3;\n",
      "utf8",
    );
    const changed = await workspace.getWorkspace();
    expect(changed.files[0]?.reviewStatus).toBe("changed");
    expect(changed.latestSnapshot?.changedCount).toBe(1);

    await runGit("add", "example.ts");
    await runGit("commit", "-m", "land reviewed change");
    const clean = await workspace.getWorkspace();
    expect(clean.files).toHaveLength(0);
    expect(clean.latestSnapshot?.changedCount).toBe(0);
  });

  it("stores approvals and comments in Git metadata instead of the worktree", async () => {
    const workspace = new ReviewWorkspace(repository);
    await workspace.initialize();
    const initial = await workspace.getWorkspace();
    const file = initial.files[0];
    expect(file).toBeDefined();

    await workspace.addComment({
      path: "example.ts",
      expectedFingerprint: file?.fingerprint ?? "",
      anchors: [{ side: "new", startLine: 1, endLine: 2 }],
      body: "Check this value.",
    });
    await workspace.approveFile("example.ts", file?.fingerprint ?? "");

    const status = await exec("git", ["status", "--porcelain"], {
      cwd: repository,
    });
    expect(status.stdout).toBe(" M example.ts\n");

    const stored = JSON.parse(
      await readFile(join(repository, ".git", "redline", "state.json"), "utf8"),
    ) as { approvals: Record<string, unknown> };
    expect(stored.approvals["example.ts"]).toBeDefined();

    const database = new DatabaseSync(
      join(repository, ".git", "redline", "review.sqlite"),
    );
    try {
      expect(
        database.prepare("SELECT body FROM review_comments").get(),
      ).toMatchObject({
        body: "Check this value.",
      });
      const columns = database
        .prepare("PRAGMA table_info(review_comments)")
        .all() as unknown as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toEqual([
        "id",
        "path",
        "anchors_json",
        "body",
        "created_at",
        "fingerprint",
        "state",
        "root_version",
        "thread_revision",
        "deleted",
      ]);
    } finally {
      database.close();
      workspace.close();
    }
  });

  it("approves filenames that collide with Object prototype properties", async () => {
    await writeFile(join(repository, "toString"), "first\n", "utf8");
    await writeFile(join(repository, "__proto__"), "second\n", "utf8");
    const workspace = new ReviewWorkspace(repository);
    try {
      await workspace.initialize();
      const before = await workspace.getWorkspace(true);
      expect(
        before.files.find((file) => file.path === "toString")?.reviewStatus,
      ).toBe("unreviewed");
      expect(
        before.files.find((file) => file.path === "__proto__")?.reviewStatus,
      ).toBe("unreviewed");

      await workspace.approveSnapshot();
      const approved = await workspace.getWorkspace(true);
      expect(
        approved.files.find((file) => file.path === "toString")?.reviewStatus,
      ).toBe("approved");
      expect(
        approved.files.find((file) => file.path === "__proto__")?.reviewStatus,
      ).toBe("approved");

      const stored = JSON.parse(
        await readFile(
          join(repository, ".git", "redline", "state.json"),
          "utf8",
        ),
      ) as { approvals: Record<string, unknown> };
      expect(Object.keys(stored.approvals)).toEqual(
        expect.arrayContaining(["toString", "__proto__"]),
      );
    } finally {
      workspace.close();
    }
  });

  it("persists diff context settings in the workspace database", async () => {
    const workspace = new ReviewWorkspace(repository);
    await workspace.initialize();
    expect(await workspace.getSettings()).toEqual({
      version: 1,
      diffContextLines: 3,
      keyboardLayout: "normie",
      theme: DEFAULT_THEME_PREFERENCE,
      typography: DEFAULT_TYPOGRAPHY_PREFERENCE,
    });
    expect(await workspace.updateSettings(8, "vim")).toEqual({
      version: 1,
      diffContextLines: 8,
      keyboardLayout: "vim",
      theme: DEFAULT_THEME_PREFERENCE,
      typography: DEFAULT_TYPOGRAPHY_PREFERENCE,
    });
    workspace.close();

    const reopened = new ReviewWorkspace(repository);
    await reopened.initialize();
    expect(await reopened.getSettings()).toEqual({
      version: 1,
      diffContextLines: 8,
      keyboardLayout: "vim",
      theme: DEFAULT_THEME_PREFERENCE,
      typography: DEFAULT_TYPOGRAPHY_PREFERENCE,
    });
    await expect(reopened.updateSettings(21)).rejects.toThrow("0 to 20");
    reopened.close();
  });

  it("keeps validated theme preferences isolated across workspace switches", async () => {
    const secondRepository = await mkdtemp(
      join(tmpdir(), "redline-theme-second-"),
    );
    await exec("git", ["init"], { cwd: secondRepository });
    await exec("git", ["config", "user.email", "redline@example.test"], {
      cwd: secondRepository,
    });
    await exec("git", ["config", "user.name", "Redline Test"], {
      cwd: secondRepository,
    });
    await writeFile(
      join(secondRepository, "second.ts"),
      "export const second = true;\n",
      "utf8",
    );
    await exec("git", ["add", "second.ts"], { cwd: secondRepository });
    await exec("git", ["commit", "-m", "initial"], { cwd: secondRepository });

    const workspace = new ReviewWorkspace(repository);
    try {
      await workspace.initialize();
      expect(
        (
          await workspace.updateThemePreference(repository, {
            version: 1,
            preset: "paper",
            overrides: {},
          })
        ).theme.preset,
      ).toBe("paper");
      await workspace.updateTypographyPreference(repository, {
        ...DEFAULT_TYPOGRAPHY_PREFERENCE,
        uiFont: "serif",
        interfaceFontSize: 18,
      });

      await workspace.openWorkspace(secondRepository);
      expect((await workspace.getSettings()).theme).toEqual(
        DEFAULT_THEME_PREFERENCE,
      );
      expect((await workspace.getSettings()).typography).toEqual(
        DEFAULT_TYPOGRAPHY_PREFERENCE,
      );
      expect(
        (
          await workspace.updateThemePreference(secondRepository, {
            version: 1,
            preset: "dusk",
            overrides: {},
          })
        ).theme.preset,
      ).toBe("dusk");
      await expect(
        workspace.updateThemePreference(repository, {
          version: 1,
          preset: "paper",
          overrides: {},
        }),
      ).rejects.toThrow("active workspace changed");

      await workspace.openWorkspace(repository);
      expect((await workspace.getSettings()).theme.preset).toBe("paper");
      expect((await workspace.getSettings()).typography).toMatchObject({
        uiFont: "serif",
        interfaceFontSize: 18,
      });
    } finally {
      workspace.close();
      await rm(secondRepository, { recursive: true, force: true });
    }
  });

  it("falls back safely when a persisted theme is malformed or inaccessible", async () => {
    const workspace = new ReviewWorkspace(repository);
    await workspace.initialize();
    workspace.close();
    const database = new DatabaseSync(
      join(repository, ".git", "redline", "review.sqlite"),
    );
    try {
      database
        .prepare(
          `
        INSERT INTO review_settings (key, value)
        VALUES ('theme_preference', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `,
        )
        .run(
          JSON.stringify({
            version: 1,
            preset: "redline",
            overrides: { ink: "#191a1f" },
          }),
        );
    } finally {
      database.close();
    }

    const reopened = new ReviewWorkspace(repository);
    try {
      await reopened.initialize();
      expect((await reopened.getSettings()).theme).toEqual(
        DEFAULT_THEME_PREFERENCE,
      );
    } finally {
      reopened.close();
    }
  });

  it("upgrades v1 state files that predate deferred paths", async () => {
    const stateDir = join(repository, ".git", "redline");
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, "state.json"),
      JSON.stringify({ version: 1, approvals: {}, snapshots: [] }),
      "utf8",
    );
    const workspace = new ReviewWorkspace(repository);
    await workspace.initialize();
    expect((await workspace.getWorkspace()).deferredFiles).toEqual([]);
    workspace.close();
  });

  it("keeps deferred comments out of active queue counts", async () => {
    const workspace = new ReviewWorkspace(repository);
    await workspace.initialize();
    const diff = await workspace.getDiff("example.ts");
    await workspace.addComment({
      path: "example.ts",
      expectedFingerprint: diff.fingerprint,
      anchors: [{ side: "new", startLine: 1, endLine: 1 }],
      body: "Deferred comment",
    });
    expect((await workspace.getWorkspace()).counts.comments).toBe(1);
    const deferred = await workspace.deferFile("example.ts");
    expect(deferred.counts.comments).toBe(0);
    expect(deferred.deferredFiles[0]).toMatchObject({
      path: "example.ts",
      commentCount: 1,
    });
    workspace.close();
  });

  it("migrates v1 comment rows without dropping local review notes", async () => {
    const stateDir = join(repository, ".git", "redline");
    await mkdir(stateDir, { recursive: true });
    const databasePath = join(stateDir, "review.sqlite");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE review_comments (
        id TEXT PRIMARY KEY, path TEXT NOT NULL, anchors_json TEXT NOT NULL,
        body TEXT NOT NULL, created_at TEXT NOT NULL, fingerprint TEXT NOT NULL
      ) STRICT;
      CREATE TABLE review_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      INSERT INTO review_comments VALUES (
        'legacy', 'example.ts', '[{"side":"new","startLine":1,"endLine":1}]',
        'Preserve this note', '2026-07-12T00:00:00.000Z', 'legacy-fingerprint'
      );
      PRAGMA user_version = 1;
    `);
    legacy.close();
    const migrated = new ReviewDatabase(databasePath);
    expect(migrated.allComments()).toEqual([
      expect.objectContaining({
        id: "legacy",
        body: "Preserve this note",
        state: "pending",
        rootVersion: 1,
        threadRevision: 0,
      }),
    ]);
    migrated.close();
  });

  it("finishes an interrupted v1 comment migration idempotently", async () => {
    const stateDir = join(repository, ".git", "redline");
    await mkdir(stateDir, { recursive: true });
    const databasePath = join(stateDir, "review.sqlite");
    const partial = new DatabaseSync(databasePath);
    partial.exec(`
      CREATE TABLE review_comments (
        id TEXT PRIMARY KEY, path TEXT NOT NULL, anchors_json TEXT NOT NULL,
        body TEXT NOT NULL, created_at TEXT NOT NULL, fingerprint TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending', root_version INTEGER NOT NULL DEFAULT 1
      ) STRICT;
      CREATE TABLE review_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      INSERT INTO review_comments VALUES ('partial', 'example.ts', '[]', 'Still here', 'now', 'fp', 'pending', 1);
      PRAGMA user_version = 1;
    `);
    partial.close();
    const migrated = new ReviewDatabase(databasePath);
    expect(migrated.allComments()[0]).toMatchObject({
      id: "partial",
      body: "Still here",
      threadRevision: 0,
    });
    migrated.close();
    const reopened = new ReviewDatabase(databasePath);
    expect(reopened.allComments()).toHaveLength(1);
    reopened.close();
  });

  it("rejects ghost replies and returns the original durable idempotent response", async () => {
    const workspace = new ReviewWorkspace(repository);
    await workspace.initialize();
    const diff = await workspace.getDiff("example.ts");
    const comment = await workspace.addComment({
      path: "example.ts",
      expectedFingerprint: diff.fingerprint,
      anchors: [{ side: "new", startLine: 1, endLine: 1 }],
      body: "Review this change",
    });
    await expect(
      workspace.mutateThread({
        commentId: comment.id,
        expectedState: "pending",
        expectedRootVersion: 1,
        expectedThreadRevision: 0,
        requestId: "empty-reply",
        body: "   ",
      }),
    ).rejects.toThrow("non-empty body");
    const acceptedContext = (await workspace.getThreadPacket(comment.id))
      .acceptedContext;
    const accepted = await workspace.mutateThread({
      commentId: comment.id,
      expectedState: "pending",
      expectedRootVersion: 1,
      expectedThreadRevision: 0,
      requestId: "accept-once",
      body: "Implemented and validated.",
      decision: "accepted",
      acceptedContext,
    });
    expect(accepted.comment.state).toBe("accepted");
    await workspace.mutateThread({
      commentId: comment.id,
      expectedState: "accepted",
      expectedRootVersion: 1,
      expectedThreadRevision: 1,
      requestId: "reopen-later",
      reopen: true,
    });
    const retry = await workspace.mutateThread({
      commentId: comment.id,
      expectedState: "pending",
      expectedRootVersion: 1,
      expectedThreadRevision: 0,
      requestId: "accept-once",
      body: "Implemented and validated.",
      decision: "accepted",
      acceptedContext,
    });
    expect(retry.comment).toMatchObject({
      state: "accepted",
      threadRevision: 1,
    });
    workspace.close();
  });

  it("redacts replied tombstones and removes them from the pending agent queue", async () => {
    const workspace = new ReviewWorkspace(repository);
    await workspace.initialize();
    const diff = await workspace.getDiff("example.ts");
    const comment = await workspace.addComment({
      path: "example.ts",
      expectedFingerprint: diff.fingerprint,
      anchors: [{ side: "new", startLine: 1, endLine: 1 }],
      body: "Sensitive deleted note",
    });
    await workspace.mutateThread({
      commentId: comment.id,
      expectedState: "pending",
      expectedRootVersion: 1,
      expectedThreadRevision: 0,
      requestId: "user-reply",
      body: "Keep the thread history.",
    });
    await workspace.deleteComment(comment.id);
    const stored = (await workspace.getReviewData()).comments[0];
    expect(stored).toMatchObject({
      body: "[deleted]",
      deleted: true,
      state: "deferred",
    });
    expect(await workspace.getPendingThreadPackets()).toEqual([]);
    await expect(
      workspace.mutateThread({
        commentId: comment.id,
        expectedState: "deferred",
        expectedRootVersion: 2,
        expectedThreadRevision: 1,
        requestId: "cannot-reopen-tombstone",
        reopen: true,
      }),
    ).rejects.toThrow("invalid_state");
    workspace.close();
  });

  it("does not let the user reply endpoint smuggle an agent decision", async () => {
    const workspace = new ReviewWorkspace(repository);
    await workspace.initialize();
    const diff = await workspace.getDiff("example.ts");
    const comment = await workspace.addComment({
      path: "example.ts",
      expectedFingerprint: diff.fingerprint,
      anchors: [{ side: "new", startLine: 1, endLine: 1 }],
      body: "Keep this pending for an agent.",
    });
    workspace.close();
    const app = buildServer({ workspaceDir: repository });
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/comments/${comment.id}/replies`,
        headers: { "content-type": "application/json" },
        payload: {
          expectedState: "pending",
          expectedRootVersion: 1,
          expectedThreadRevision: 0,
          requestId: "user-cannot-decide",
          body: "This is only a user reply.",
          decision: "rejected",
          reopen: true,
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        comment: {
          state: "pending",
          threadRevision: 1,
          replies: [
            expect.objectContaining({
              actor: "user",
              body: "This is only a user reply.",
            }),
          ],
        },
      });
    } finally {
      await app.close();
    }
  });

  it("rejects imported GitHub identifiers through every local thread mutation", async () => {
    const workspace = new ReviewWorkspace(repository);
    await workspace.initialize();
    await expect(
      workspace.deleteComment("github:repository#1:thread"),
    ).rejects.toThrow("imported_read_only");
    await expect(
      workspace.mutateThread({
        commentId: "github:repository#1:thread",
        expectedState: "pending",
        expectedRootVersion: 1,
        expectedThreadRevision: 0,
        requestId: "imported-mutation",
        body: "Must remain immutable.",
      }),
    ).rejects.toThrow("imported_read_only");
    workspace.close();
  });

  it("emits a debounced local event when a worktree file changes", async () => {
    const workspace = new ReviewWorkspace(repository);
    await workspace.initialize();
    expect(workspace.isFileWatchActive()).toBe(true);

    let unsubscribe: (() => void) | undefined;
    try {
      const changed = new Promise<{ paths: string[] }>(
        (resolveEvent, reject) => {
          const timeout = setTimeout(
            () =>
              reject(new Error("Timed out waiting for the workspace watcher.")),
            3_000,
          );
          unsubscribe = workspace.subscribeToChanges((event) => {
            clearTimeout(timeout);
            resolveEvent(event);
          });
        },
      );
      await writeFile(
        join(repository, "example.ts"),
        "export const count = 77;\n",
        "utf8",
      );
      expect((await changed).paths).toContain("example.ts");
    } finally {
      unsubscribe?.();
      workspace.close();
    }
  });

  it("exposes validated settings through the local API", async () => {
    const baselineLines = Array.from(
      { length: 9 },
      (_, index) => `export const value${index + 1} = ${index + 1};`,
    );
    await writeFile(
      join(repository, "example.ts"),
      `${baselineLines.join("\n")}\n`,
      "utf8",
    );
    await runGit("add", "example.ts");
    await runGit("commit", "-m", "context baseline");
    baselineLines[4] = "export const value5 = 50;";
    await writeFile(
      join(repository, "example.ts"),
      `${baselineLines.join("\n")}\n`,
      "utf8",
    );

    const app = buildServer({ workspaceDir: repository });
    try {
      const initial = await app.inject({ method: "GET", url: "/api/settings" });
      expect(initial.statusCode).toBe(200);
      expect(initial.json()).toEqual({
        version: 1,
        diffContextLines: 3,
        keyboardLayout: "normie",
        theme: DEFAULT_THEME_PREFERENCE,
        typography: DEFAULT_TYPOGRAPHY_PREFERENCE,
      });

      const updated = await app.inject({
        method: "PUT",
        url: "/api/settings",
        payload: { diffContextLines: 12, keyboardLayout: "vim" },
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.json()).toEqual({
        version: 1,
        diffContextLines: 12,
        keyboardLayout: "vim",
        theme: DEFAULT_THEME_PREFERENCE,
        typography: DEFAULT_TYPOGRAPHY_PREFERENCE,
      });

      const typography = {
        version: 1,
        uiFont: "serif",
        codeFont: "modern",
        interfaceFontSize: 18,
        codeFontSize: 12,
      } as const;
      const typographyUpdated = await app.inject({
        method: "PUT",
        url: "/api/settings/typography",
        payload: { workspaceRoot: repository, preference: typography },
      });
      expect(typographyUpdated.statusCode).toBe(200);
      expect(typographyUpdated.json()).toMatchObject({
        diffContextLines: 12,
        keyboardLayout: "vim",
        theme: DEFAULT_THEME_PREFERENCE,
        typography,
      });
      expect(
        (
          await app.inject({
            method: "PUT",
            url: "/api/settings/typography",
            payload: {
              workspaceRoot: repository,
              preference: { ...typography, codeFontSize: 12.5 },
            },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: "PUT",
            url: "/api/settings/typography",
            payload: {
              workspaceRoot: `${repository}-other`,
              preference: typography,
            },
          })
        ).statusCode,
      ).toBe(400);

      const typographyPersistenceFailure = vi
        .spyOn(ReviewDatabase.prototype, "updateTypographyPreference")
        .mockImplementationOnce(() => {
          throw new Error("database is busy");
        });
      try {
        const failedTypographyUpdate = await app.inject({
          method: "PUT",
          url: "/api/settings/typography",
          payload: { workspaceRoot: repository, preference: typography },
        });
        expect(failedTypographyUpdate.statusCode).toBe(500);
        expect(failedTypographyUpdate.json()).toMatchObject({
          message: "database is busy",
          statusCode: 500,
        });
      } finally {
        typographyPersistenceFailure.mockRestore();
      }

      const themed = await app.inject({
        method: "PUT",
        url: "/api/settings/theme",
        payload: {
          workspaceRoot: repository,
          preference: { version: 1, preset: "paper", overrides: {} },
        },
      });
      expect(themed.statusCode).toBe(200);
      expect(themed.json()).toMatchObject({
        diffContextLines: 12,
        keyboardLayout: "vim",
        theme: { version: 1, preset: "paper", overrides: {} },
      });

      const inaccessible = await app.inject({
        method: "PUT",
        url: "/api/settings/theme",
        payload: {
          workspaceRoot: repository,
          preference: {
            version: 1,
            preset: "paper",
            overrides: { ink: "#f4f2ee" },
          },
        },
      });
      expect(inaccessible.statusCode).toBe(400);

      const persistenceFailure = vi
        .spyOn(ReviewDatabase.prototype, "updateThemePreference")
        .mockImplementationOnce(() => {
          throw new Error("database is temporarily busy");
        });
      const transientFailure = await app.inject({
        method: "PUT",
        url: "/api/settings/theme",
        payload: {
          workspaceRoot: repository,
          preference: { version: 1, preset: "dusk", overrides: {} },
        },
      });
      expect(transientFailure.statusCode).toBe(500);
      persistenceFailure.mockRestore();

      const staleWorkspace = await app.inject({
        method: "DELETE",
        url: "/api/settings/theme",
        payload: { workspaceRoot: `${repository}-other` },
      });
      expect(staleWorkspace.statusCode).toBe(400);

      const resetTheme = await app.inject({
        method: "DELETE",
        url: "/api/settings/theme",
        payload: { workspaceRoot: repository },
      });
      expect(resetTheme.statusCode).toBe(200);
      expect(resetTheme.json()).toMatchObject({
        theme: DEFAULT_THEME_PREFERENCE,
      });

      const invalid = await app.inject({
        method: "PUT",
        url: "/api/settings",
        payload: { diffContextLines: 2.5 },
      });
      expect(invalid.statusCode).toBe(400);

      await app.inject({
        method: "PUT",
        url: "/api/settings",
        payload: { diffContextLines: 0, keyboardLayout: "normie" },
      });
      const savedDefaultDiff = await app.inject({
        method: "GET",
        url: "/api/diff?path=example.ts",
      });
      expect(savedDefaultDiff.statusCode).toBe(200);
      expect(
        savedDefaultDiff
          .json<DiffResponse>()
          .lines.filter((line) => line.type === "context"),
      ).toHaveLength(0);

      const invalidContext = await app.inject({
        method: "GET",
        url: "/api/diff?path=example.ts&context=2.5",
      });
      expect(invalidContext.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("exposes structured review data and Markdown comment export for local agents", async () => {
    const workspace = new ReviewWorkspace(repository);
    await workspace.initialize();
    const currentDiff = await workspace.getDiff("example.ts");
    await workspace.addComment({
      path: "example.ts",
      expectedFingerprint: currentDiff.fingerprint,
      anchors: [{ side: "new", startLine: 1, endLine: 2 }],
      body: "Review this range.",
    });

    const app = buildServer({ workspaceDir: repository });
    try {
      const reviewResponse = await app.inject({
        method: "GET",
        url: "/api/review",
      });
      expect(reviewResponse.statusCode).toBe(200);
      expect(reviewResponse.json<ReviewDataResponse>()).toMatchObject({
        version: 1,
      });
      expect(
        reviewResponse.json<ReviewDataResponse>().comments[0],
      ).toMatchObject({
        path: "example.ts",
        anchors: [{ side: "new", startLine: 1, endLine: 2 }],
        body: "Review this range.",
      });

      const diffResponse = await app.inject({
        method: "GET",
        url: "/api/diff?path=example.ts",
      });
      expect(diffResponse.statusCode).toBe(200);
      const diffData = diffResponse.json<DiffResponse>();
      expect(diffData.schemaVersion).toBe(1);
      expect(diffData.lines.find((line) => line.id === "new-1")).toMatchObject({
        type: "add",
        anchors: [{ side: "new", startLine: 1, endLine: 1 }],
      });

      const agentExportResponse = await app.inject({
        method: "GET",
        url: "/api/comments/export",
      });
      expect(agentExportResponse.statusCode).toBe(200);
      expect(agentExportResponse.headers["content-type"]).toContain(
        "application/json",
      );
      const agentExport = agentExportResponse.json<CommentExportResponse>();
      expect(agentExport.version).toBe(1);
      expect(agentExport.workspace.name).toContain("redline-review-");
      expect(agentExport.comments).toMatchObject([
        {
          path: "example.ts",
          anchors: [{ side: "new", startLine: 1, endLine: 2 }],
          body: "Review this range.",
        },
      ]);

      const agentMarkdownResponse = await app.inject({
        method: "GET",
        url: "/api/comments/export?format=markdown",
      });
      expect(agentMarkdownResponse.statusCode).toBe(200);
      expect(agentMarkdownResponse.headers["content-type"]).toContain(
        "text/markdown",
      );
      expect(agentMarkdownResponse.body).toContain("new lines 1-2");
      expect(agentMarkdownResponse.body).toContain("Review this range.");
      expect(agentMarkdownResponse.body).toContain("export const count = 2;");

      const invalidExportResponse = await app.inject({
        method: "GET",
        url: "/api/comments/export?format=xml",
      });
      expect(invalidExportResponse.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("accepts side-aware comment anchors", async () => {
    const app = buildServer({ workspaceDir: repository });
    try {
      const currentDiff = await app.inject({
        method: "GET",
        url: "/api/diff?path=example.ts",
      });
      const response = await app.inject({
        method: "POST",
        url: "/api/comments",
        payload: {
          path: "example.ts",
          fingerprint: currentDiff.json<DiffResponse>().fingerprint,
          anchors: [{ side: "old", startLine: 1, endLine: 1 }],
          body: "Keep the previous behavior in mind.",
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        anchors: [{ side: "old", startLine: 1, endLine: 1 }],
        body: "Keep the previous behavior in mind.",
      });

      const lineIdOnly = await app.inject({
        method: "POST",
        url: "/api/comments",
        payload: {
          path: "example.ts",
          fingerprint: currentDiff.json<DiffResponse>().fingerprint,
          lineId: "old-1",
          body: "This obsolete contract must be rejected.",
        },
      });
      expect(lineIdOnly.statusCode).toBe(400);

      await writeFile(
        join(repository, "example.ts"),
        "export const count = 77;\n",
        "utf8",
      );
      const staleResponse = await app.inject({
        method: "POST",
        url: "/api/comments",
        payload: {
          path: "example.ts",
          fingerprint: currentDiff.json<DiffResponse>().fingerprint,
          anchors: [{ side: "old", startLine: 1, endLine: 1 }],
          body: "This should be rejected.",
        },
      });
      expect(staleResponse.statusCode).toBe(409);
      const refreshed = await app.inject({
        method: "GET",
        url: "/api/diff?path=example.ts",
      });
      expect(refreshed.json<DiffResponse>().comments).toMatchObject([
        {
          body: "Keep the previous behavior in mind.",
          outdated: true,
          anchors: [{ side: "old", startLine: 1, endLine: 1 }],
        },
      ]);
    } finally {
      await app.close();
    }
  });

  it("hides generated and binary noise without losing its count", async () => {
    await writeFile(
      join(repository, "artifact.png"),
      Buffer.from([0, 1, 2, 3]),
    );
    await writeFile(
      join(repository, "bundle.min.js"),
      "const bundled=true;\n",
      "utf8",
    );
    const workspace = new ReviewWorkspace(repository);
    await workspace.initialize();

    const filtered = await workspace.getWorkspace();
    expect(filtered.files.map((file) => file.path)).toEqual(["example.ts"]);
    expect(filtered.hiddenNoiseCount).toBe(2);

    const withNoise = await workspace.getWorkspace(true);
    expect(withNoise.files).toHaveLength(3);
    const deferredNoise = await workspace.deferFile("bundle.min.js", true);
    expect(deferredNoise.deferredFiles.map((file) => file.path)).toContain(
      "bundle.min.js",
    );
    const restoredNoise = await workspace.restoreFile("bundle.min.js", true);
    expect(restoredNoise.files.map((file) => file.path)).toContain(
      "bundle.min.js",
    );
    workspace.close();
  });

  it("recovers a stale review-state lock owned by a dead process", async () => {
    const workspace = new ReviewWorkspace(repository);
    await workspace.initialize();
    const lockPath = join(repository, ".git", "redline", "state.json.lock");
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      join(lockPath, "owner.json"),
      JSON.stringify({
        pid: 2_147_483_647,
        createdAt: Date.now() - 60_000,
      }),
    );
    const deferred = await workspace.deferFile("example.ts");
    expect(deferred.deferredFiles[0]?.path).toBe("example.ts");
    await expect(
      readFile(join(lockPath, "owner.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    workspace.close();
  });

  it("rejects comments when the viewed fingerprint or anchors are stale", async () => {
    const workspace = new ReviewWorkspace(repository);
    await workspace.initialize();
    const viewed = await workspace.getDiff("example.ts");
    await writeFile(
      join(repository, "example.ts"),
      "export const count = 99;\n",
      "utf8",
    );

    await expect(
      workspace.addComment({
        path: "example.ts",
        expectedFingerprint: viewed.fingerprint,
        anchors: [{ side: "new", startLine: 1, endLine: 1 }],
        body: "This view is stale.",
      }),
    ).rejects.toThrow("changed while");

    const current = await workspace.getDiff("example.ts");
    await expect(
      workspace.addComment({
        path: "example.ts",
        expectedFingerprint: current.fingerprint,
        anchors: [{ side: "new", startLine: 999, endLine: 999 }],
        body: "This anchor does not exist.",
      }),
    ).rejects.toThrow("not present");
    expect((await workspace.getReviewData()).comments).toHaveLength(0);
    workspace.close();
  });

  it("preserves no-newline metadata without shifting line anchors", async () => {
    await writeFile(
      join(repository, "example.ts"),
      "export const count = 2;",
      "utf8",
    );
    const workspace = new ReviewWorkspace(repository);
    await workspace.initialize();

    const diff = await workspace.getDiff("example.ts");
    expect(diff.lines.find((line) => line.type === "add")).toMatchObject({
      id: "new-1",
      newLine: 1,
      noNewline: true,
    });
    expect(diff.lines.filter((line) => line.type === "add")).toHaveLength(1);
    workspace.close();
  });

  it("renders an untracked symlink target without reading outside the workspace", async () => {
    await symlink("/etc/hosts", join(repository, "outside-link"));
    const workspace = new ReviewWorkspace(repository);
    await workspace.initialize();

    const diff = await workspace.getDiff("outside-link");
    expect(diff.diff).toContain("new file mode 120000");
    expect(diff.diff).toContain("+/etc/hosts");
    expect(diff.diff).not.toContain("localhost");
    workspace.close();
  });

  it("does not invent a source line for an empty file and marks a missing final newline", async () => {
    await writeFile(join(repository, "empty.txt"), "", "utf8");
    await writeFile(join(repository, "no-newline.txt"), "local text", "utf8");
    const workspace = new ReviewWorkspace(repository);
    try {
      await workspace.initialize();
      const empty = await workspace.getDiff("empty.txt");
      expect(empty.stats).toEqual({ additions: 0, deletions: 0 });
      expect(empty.lines.every((line) => line.anchors.length === 0)).toBe(true);
      expect(empty.diff).not.toContain("@@ ");

      const noNewline = await workspace.getDiff("no-newline.txt");
      expect(noNewline.lines).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "new-1",
            content: "local text",
            noNewline: true,
          }),
        ]),
      );
      expect(noNewline.diff).toContain("\\ No newline at end of file");
    } finally {
      workspace.close();
    }
  });

  it("shows the executable mode for an untracked executable file", async () => {
    const executablePath = join(repository, "run.sh");
    await writeFile(executablePath, "#!/bin/sh\necho local\n", "utf8");
    await chmod(executablePath, 0o755);
    const workspace = new ReviewWorkspace(repository);
    try {
      await workspace.initialize();
      const diff = await workspace.getDiff("run.sh");
      expect(diff.diff).toContain("new file mode 100755");
      expect(diff.diff).not.toContain("new file mode 100644");
    } finally {
      workspace.close();
    }
  });

  it("reads only the displayed prefix of oversized untracked files", async () => {
    const limit = 5 * 1024 * 1024;
    await writeFile(
      join(repository, "large.txt"),
      Buffer.concat([
        Buffer.alloc(limit, 97),
        Buffer.from("SECRET_AFTER_LIMIT"),
      ]),
    );
    const workspace = new ReviewWorkspace(repository);
    await workspace.initialize();

    const diff = await workspace.getDiff("large.txt");
    expect(diff.truncated).toBe(true);
    expect(diff.diff).not.toContain("SECRET_AFTER_LIMIT");
    workspace.close();
  });

  it("hides deleted binary files even when their extension is unknown", async () => {
    await writeFile(
      join(repository, "binary.data"),
      Buffer.from([1, 0, 2, 0, 3]),
    );
    await runGit("add", "binary.data");
    await runGit("commit", "-m", "binary fixture");
    await rm(join(repository, "binary.data"));
    const workspace = new ReviewWorkspace(repository);
    await workspace.initialize();

    const filtered = await workspace.getWorkspace();
    expect(filtered.files.map((file) => file.path)).not.toContain(
      "binary.data",
    );
    expect(filtered.hiddenNoiseCount).toBeGreaterThanOrEqual(1);
    const withNoise = await workspace.getWorkspace(true);
    expect(
      withNoise.files.find((file) => file.path === "binary.data"),
    ).toMatchObject({
      binary: true,
      kind: "deleted",
    });
    workspace.close();
  });

  it("serializes concurrent approval writes without losing either file", async () => {
    await writeFile(
      join(repository, "second.ts"),
      "export const second = 1;\n",
      "utf8",
    );
    await runGit("add", "second.ts");
    await runGit("commit", "-m", "second fixture");
    await writeFile(
      join(repository, "second.ts"),
      "export const second = 2;\n",
      "utf8",
    );
    const workspace = new ReviewWorkspace(repository);
    await workspace.initialize();
    const files = (await workspace.getWorkspace(true)).files;
    const example = files.find((file) => file.path === "example.ts");
    const second = files.find((file) => file.path === "second.ts");
    expect(example).toBeDefined();
    expect(second).toBeDefined();

    await Promise.all([
      workspace.approveFile("example.ts", example?.fingerprint ?? ""),
      workspace.approveFile("second.ts", second?.fingerprint ?? ""),
    ]);
    const store = JSON.parse(
      await readFile(join(repository, ".git", "redline", "state.json"), "utf8"),
    ) as { approvals: Record<string, unknown> };
    expect(Object.keys(store.approvals).sort()).toEqual([
      "example.ts",
      "second.ts",
    ]);
    workspace.close();
  });

  it("approves an explicit file set atomically and rejects the whole set when one fingerprint is stale", async () => {
    await writeFile(
      join(repository, "second.ts"),
      "export const second = 1;\n",
      "utf8",
    );
    await runGit("add", "second.ts");
    await runGit("commit", "-m", "second batch fixture");
    await writeFile(
      join(repository, "example.ts"),
      "export const count = 4;\n",
      "utf8",
    );
    await writeFile(
      join(repository, "second.ts"),
      "export const second = 2;\n",
      "utf8",
    );
    const workspace = new ReviewWorkspace(repository);
    await workspace.initialize();

    const viewed = (await workspace.getWorkspace(true)).files.filter(
      (file) => file.path === "example.ts" || file.path === "second.ts",
    );
    expect(viewed).toHaveLength(2);
    await writeFile(
      join(repository, "example.ts"),
      "export const count = 5;\n",
      "utf8",
    );

    await expect(
      workspace.approveFiles(
        viewed.map((file) => ({
          path: file.path,
          fingerprint: file.fingerprint,
        })),
      ),
    ).rejects.toThrow("Nothing was approved");
    const afterConflict = await workspace.getWorkspace(true);
    expect(
      afterConflict.files.find((file) => file.path === "example.ts")
        ?.reviewStatus,
    ).toBe("unreviewed");
    expect(
      afterConflict.files.find((file) => file.path === "second.ts")
        ?.reviewStatus,
    ).toBe("unreviewed");

    const current = afterConflict.files.filter(
      (file) => file.path === "example.ts" || file.path === "second.ts",
    );
    const result = await workspace.approveFiles(
      current.map((file) => ({
        path: file.path,
        fingerprint: file.fingerprint,
      })),
    );
    expect(result.approvals).toHaveLength(2);
    expect(
      new Set(result.approvals.map((approval) => approval.approvedAt)),
    ).toEqual(new Set([result.approvedAt]));
    const approved = await workspace.getWorkspace(true);
    expect(
      approved.files
        .filter(
          (file) => file.path === "example.ts" || file.path === "second.ts",
        )
        .every((file) => file.reviewStatus === "approved"),
    ).toBe(true);
    workspace.close();
  });

  it("surfaces malformed approval state without overwriting it", async () => {
    const stateDir = join(repository, ".git", "redline");
    const statePath = join(stateDir, "state.json");
    await mkdir(stateDir, { recursive: true });
    await writeFile(statePath, "{ definitely not json", "utf8");
    const workspace = new ReviewWorkspace(repository);

    await expect(workspace.initialize()).rejects.toThrow(
      "Review state is malformed",
    );
    expect(await readFile(statePath, "utf8")).toBe("{ definitely not json");
    workspace.close();
  });

  it("rejects valid JSON with an invalid review state shape", async () => {
    const stateDir = join(repository, ".git", "redline");
    const statePath = join(stateDir, "state.json");
    await mkdir(stateDir, { recursive: true });
    const invalidState = '{"version":1,"approvals":[],"snapshots":[]}';
    await writeFile(statePath, invalidState, "utf8");
    const workspace = new ReviewWorkspace(repository);

    await expect(workspace.initialize()).rejects.toThrow(
      "approvals must be an object",
    );
    expect(await readFile(statePath, "utf8")).toBe(invalidState);
    workspace.close();
  });

  it("invalidates approval when the executable mode changes", async () => {
    const workspace = new ReviewWorkspace(repository);
    await workspace.initialize();
    const initial = await workspace.getWorkspace();
    const file = initial.files.find(
      (candidate) => candidate.path === "example.ts",
    );
    expect(file).toBeDefined();
    await workspace.approveFile("example.ts", file?.fingerprint ?? "");

    await chmod(join(repository, "example.ts"), 0o755);
    const changed = await workspace.getWorkspace();
    expect(
      changed.files.find((candidate) => candidate.path === "example.ts")
        ?.reviewStatus,
    ).toBe("changed");
    workspace.close();
  });

  it("invalidates approval when a submodule advances to another commit", async () => {
    const submoduleRepository = await mkdtemp(
      join(tmpdir(), "redline-submodule-"),
    );
    try {
      await exec("git", ["init"], { cwd: submoduleRepository });
      await exec("git", ["config", "user.email", "redline@example.test"], {
        cwd: submoduleRepository,
      });
      await exec("git", ["config", "user.name", "Redline Test"], {
        cwd: submoduleRepository,
      });
      await writeFile(join(submoduleRepository, "value.txt"), "a\n", "utf8");
      await exec("git", ["add", "value.txt"], { cwd: submoduleRepository });
      await exec("git", ["commit", "-m", "a"], { cwd: submoduleRepository });
      const commitA = (
        await exec("git", ["rev-parse", "HEAD"], { cwd: submoduleRepository })
      ).stdout.trim();
      await writeFile(join(submoduleRepository, "value.txt"), "b\n", "utf8");
      await exec("git", ["commit", "-am", "b"], { cwd: submoduleRepository });
      const commitB = (
        await exec("git", ["rev-parse", "HEAD"], { cwd: submoduleRepository })
      ).stdout.trim();
      await writeFile(join(submoduleRepository, "value.txt"), "c\n", "utf8");
      await exec("git", ["commit", "-am", "c"], { cwd: submoduleRepository });
      const commitC = (
        await exec("git", ["rev-parse", "HEAD"], { cwd: submoduleRepository })
      ).stdout.trim();

      await exec(
        "git",
        [
          "-c",
          "protocol.file.allow=always",
          "submodule",
          "add",
          submoduleRepository,
          "vendor/submodule",
        ],
        { cwd: repository },
      );
      await exec("git", ["checkout", commitA], {
        cwd: join(repository, "vendor", "submodule"),
      });
      await runGit("add", ".gitmodules", "vendor/submodule");
      await runGit("commit", "-m", "add submodule");
      await exec("git", ["checkout", commitB], {
        cwd: join(repository, "vendor", "submodule"),
      });

      const workspace = new ReviewWorkspace(repository);
      await workspace.initialize();
      const before = await workspace.getWorkspace(true);
      const submodule = before.files.find(
        (file) => file.path === "vendor/submodule",
      );
      expect(submodule).toBeDefined();
      await workspace.approveFile(
        "vendor/submodule",
        submodule?.fingerprint ?? "",
      );
      expect(
        (await workspace.getWorkspace(true)).files.find(
          (file) => file.path === "vendor/submodule",
        )?.reviewStatus,
      ).toBe("approved");

      await exec("git", ["checkout", commitC], {
        cwd: join(repository, "vendor", "submodule"),
      });
      const after = (await workspace.getWorkspace(true)).files.find(
        (file) => file.path === "vendor/submodule",
      );
      expect(after?.fingerprint).not.toBe(submodule?.fingerprint);
      expect(after?.reviewStatus).toBe("changed");
      workspace.close();
    } finally {
      await rm(submoduleRepository, { recursive: true, force: true });
    }
  });

  it("represents a mode-only diff without source-line anchors", async () => {
    await runGit("add", "example.ts");
    await runGit("commit", "-m", "content baseline");
    await chmod(join(repository, "example.ts"), 0o755);
    const workspace = new ReviewWorkspace(repository);
    await workspace.initialize();

    const diff = await workspace.getDiff("example.ts");
    expect(diff.lines.map((line) => line.content)).toEqual([
      "old mode 100644",
      "new mode 100755",
    ]);
    expect(
      diff.lines.every(
        (line) => line.type === "meta" && line.anchors.length === 0,
      ),
    ).toBe(true);
    workspace.close();
  });

  it("preserves header-like source lines and their API anchors", async () => {
    await writeFile(
      join(repository, "directives.txt"),
      "-- old directive\ntail\n",
      "utf8",
    );
    await runGit("add", "directives.txt");
    await runGit("commit", "-m", "add directive fixture");
    await writeFile(
      join(repository, "directives.txt"),
      "++ new directive\ntail\n",
      "utf8",
    );

    const workspace = new ReviewWorkspace(repository);
    try {
      await workspace.initialize();
      const result = await workspace.getDiff("directives.txt");
      expect(result.lines).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "old-1",
            content: "-- old directive",
            oldLine: 1,
          }),
          expect.objectContaining({
            id: "new-1",
            content: "++ new directive",
            newLine: 1,
          }),
          expect.objectContaining({
            id: "both-2-2",
            content: "tail",
            oldLine: 2,
            newLine: 2,
          }),
        ]),
      );
    } finally {
      workspace.close();
    }
  });

  it("loads both sides of a pure rename instead of rendering a full-file addition", async () => {
    await writeFile(
      join(repository, "before-name.ts"),
      "export const renamed = true;\n",
      "utf8",
    );
    await runGit("add", "before-name.ts");
    await runGit("commit", "-m", "add rename source");
    await runGit("mv", "before-name.ts", "after-name.ts");

    const workspace = new ReviewWorkspace(repository);
    try {
      await workspace.initialize();
      const state = await workspace.getWorkspace(true);
      expect(state.files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "after-name.ts",
            originalPath: "before-name.ts",
            kind: "renamed",
          }),
        ]),
      );
      const result = await workspace.getDiff("after-name.ts");
      expect(result.diff).toContain("similarity index 100%");
      expect(result.diff).toContain("rename from before-name.ts");
      expect(result.diff).not.toContain("new file mode");
      expect(result.stats).toEqual({ additions: 0, deletions: 0 });
    } finally {
      workspace.close();
    }
  });

  it("prefers a rename target when exporting threads for a reused original path", async () => {
    await writeFile(join(repository, "before-name.ts"), "original\n", "utf8");
    await runGit("add", "before-name.ts");
    await runGit("commit", "-m", "add reusable rename source");
    await runGit("mv", "before-name.ts", "after-name.ts");
    await writeFile(join(repository, "before-name.ts"), "new file\n", "utf8");

    const workspace = new ReviewWorkspace(repository);
    let resolvedPath = "";
    try {
      await workspace.initialize();
      const internal = workspace as unknown as {
        githubImports: {
          hasCommentsForDiff: () => Promise<boolean>;
          allComments: (
            resolver: (path: string) => Promise<{ diff: DiffResponse }>,
          ) => Promise<[]>;
        };
        importedReviewComments: () => Promise<[]>;
      };
      internal.githubImports = {
        hasCommentsForDiff: () => Promise.resolve(false),
        allComments: async (resolver) => {
          const resolved = await resolver("before-name.ts");
          resolvedPath = resolved.diff.path;
          return [];
        },
      };

      await internal.importedReviewComments();
      expect(resolvedPath).toBe("after-name.ts");
    } finally {
      workspace.close();
    }
  });

  it("requires the viewed fingerprint when approving through the API", async () => {
    const app = buildServer({ workspaceDir: repository });
    try {
      const missing = await app.inject({
        method: "POST",
        url: "/api/review/file",
        payload: { path: "example.ts" },
      });
      expect(missing.statusCode).toBe(400);

      const viewed = await app.inject({
        method: "GET",
        url: "/api/diff?path=example.ts",
      });
      await writeFile(
        join(repository, "example.ts"),
        "export const count = 123;\n",
        "utf8",
      );
      const stale = await app.inject({
        method: "POST",
        url: "/api/review/file",
        payload: {
          path: "example.ts",
          fingerprint: viewed.json<DiffResponse>().fingerprint,
        },
      });
      expect(stale.statusCode).toBe(409);

      const malformedBatch = await app.inject({
        method: "POST",
        url: "/api/review/files",
        payload: { files: [{ path: "example.ts" }] },
      });
      expect(malformedBatch.statusCode).toBe(400);
      const staleBatch = await app.inject({
        method: "POST",
        url: "/api/review/files",
        payload: {
          files: [
            {
              path: "example.ts",
              fingerprint: viewed.json<DiffResponse>().fingerprint,
            },
          ],
        },
      });
      expect(staleBatch.statusCode).toBe(409);
      expect(staleBatch.json<{ message: string }>().message).toContain(
        "Nothing was approved",
      );
    } finally {
      await app.close();
    }
  });

  it("models the net worktree without crashing on staged-add/delete or rename/delete states", async () => {
    await writeFile(
      join(repository, "old-name.ts"),
      "export const oldName = true;\n",
      "utf8",
    );
    await runGit("add", "old-name.ts");
    await runGit("commit", "-m", "add rename fixture");
    await writeFile(
      join(repository, "example.ts"),
      "export const count = 3;\n",
      "utf8",
    );

    await writeFile(
      join(repository, "transient.ts"),
      "export const transient = true;\n",
      "utf8",
    );
    await runGit("add", "transient.ts");
    await rm(join(repository, "transient.ts"));
    await runGit("mv", "old-name.ts", "new-name.ts");
    await rm(join(repository, "new-name.ts"));

    const workspace = new ReviewWorkspace(repository);
    try {
      await workspace.initialize();
      const state = await workspace.getWorkspace(true);
      expect(state.files.some((file) => file.path === "transient.ts")).toBe(
        false,
      );
      expect(state.files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "example.ts", kind: "modified" }),
          expect.objectContaining({ path: "old-name.ts", kind: "deleted" }),
        ]),
      );
      expect(state.files.some((file) => file.path === "new-name.ts")).toBe(
        false,
      );
    } finally {
      workspace.close();
    }
  });

  it("retries a read that overlaps a workspace switch instead of mixing repositories", async () => {
    const secondRepository = await mkdtemp(
      join(tmpdir(), "redline-read-switch-"),
    );
    try {
      await exec("git", ["init"], { cwd: secondRepository });
      await exec("git", ["config", "user.email", "redline@example.test"], {
        cwd: secondRepository,
      });
      await exec("git", ["config", "user.name", "Redline Test"], {
        cwd: secondRepository,
      });
      await writeFile(
        join(secondRepository, "second.ts"),
        "export const second = 1;\n",
        "utf8",
      );
      await exec("git", ["add", "second.ts"], { cwd: secondRepository });
      await exec("git", ["commit", "-m", "initial"], { cwd: secondRepository });
      await writeFile(
        join(secondRepository, "second.ts"),
        "export const second = 2;\n",
        "utf8",
      );

      const workspace = new ReviewWorkspace(repository);
      await workspace.initialize();
      const internals = workspace as unknown as {
        changedFiles: (head: string, store: unknown) => Promise<unknown>;
      };
      const originalChangedFiles = internals.changedFiles.bind(workspace);
      let invocation = 0;
      let markReadStarted: (() => void) | undefined;
      let releaseRead: (() => void) | undefined;
      const readStarted = new Promise<void>((resolveStarted) => {
        markReadStarted = resolveStarted;
      });
      const readGate = new Promise<void>((resolveRead) => {
        releaseRead = resolveRead;
      });
      internals.changedFiles = async (head, store) => {
        invocation += 1;
        if (invocation === 1) {
          markReadStarted?.();
          await readGate;
        }
        return originalChangedFiles(head, store);
      };

      const reading = workspace.getWorkspace(true);
      await readStarted;
      const switching = workspace.openWorkspace(secondRepository);
      await switching;
      releaseRead?.();
      const result = await reading;
      expect(result.root).toBe(secondRepository);
      expect(result.files.map((file) => file.path)).toEqual(["second.ts"]);
      workspace.close();
    } finally {
      await rm(secondRepository, { recursive: true, force: true });
    }
  });

  it("keeps the current workspace active when opening a target with corrupt review state", async () => {
    const corruptRepository = await mkdtemp(
      join(tmpdir(), "redline-corrupt-open-"),
    );
    try {
      await exec("git", ["init"], { cwd: corruptRepository });
      await exec("git", ["config", "user.email", "redline@example.test"], {
        cwd: corruptRepository,
      });
      await exec("git", ["config", "user.name", "Redline Test"], {
        cwd: corruptRepository,
      });
      await writeFile(
        join(corruptRepository, "target.ts"),
        "export const target = 1;\n",
        "utf8",
      );
      await exec("git", ["add", "target.ts"], { cwd: corruptRepository });
      await exec("git", ["commit", "-m", "initial"], {
        cwd: corruptRepository,
      });
      await mkdir(join(corruptRepository, ".git", "redline"), {
        recursive: true,
      });
      await writeFile(
        join(corruptRepository, ".git", "redline", "state.json"),
        "{ malformed",
        "utf8",
      );

      const workspace = new ReviewWorkspace(repository);
      await workspace.initialize();
      await expect(workspace.openWorkspace(corruptRepository)).rejects.toThrow(
        "malformed",
      );
      const state = await workspace.getWorkspace(true);
      expect(state.root).toBe(repository);
      expect(state.files.map((file) => file.path)).toContain("example.ts");
      workspace.close();
    } finally {
      await rm(corruptRepository, { recursive: true, force: true });
    }
  });

  it("does not let a queued approval cross into a newly opened workspace", async () => {
    const secondRepository = await mkdtemp(join(tmpdir(), "redline-switch-"));
    try {
      await exec("git", ["init"], { cwd: secondRepository });
      await exec("git", ["config", "user.email", "redline@example.test"], {
        cwd: secondRepository,
      });
      await exec("git", ["config", "user.name", "Redline Test"], {
        cwd: secondRepository,
      });
      await writeFile(
        join(secondRepository, "second.ts"),
        "export const second = 1;\n",
        "utf8",
      );
      await exec("git", ["add", "second.ts"], { cwd: secondRepository });
      await exec("git", ["commit", "-m", "initial"], { cwd: secondRepository });
      await writeFile(
        join(secondRepository, "second.ts"),
        "export const second = 2;\n",
        "utf8",
      );

      const workspace = new ReviewWorkspace(repository);
      await workspace.initialize();
      const firstFile = (await workspace.getWorkspace()).files.find(
        (file) => file.path === "example.ts",
      );
      expect(firstFile).toBeDefined();

      const internals = workspace as unknown as {
        writeStore: (store: unknown) => Promise<void>;
      };
      const originalWrite = internals.writeStore.bind(workspace);
      let releaseWrite: (() => void) | undefined;
      let markWriteStarted: (() => void) | undefined;
      const writeStarted = new Promise<void>((resolveStarted) => {
        markWriteStarted = resolveStarted;
      });
      const writeGate = new Promise<void>((resolveWrite) => {
        releaseWrite = resolveWrite;
      });
      internals.writeStore = async (store: unknown) => {
        markWriteStarted?.();
        await writeGate;
        await originalWrite(store);
      };

      const approval = workspace.approveFile(
        "example.ts",
        firstFile?.fingerprint ?? "",
      );
      await writeStarted;
      const switching = workspace.openWorkspace(secondRepository);
      releaseWrite?.();
      await approval;
      await switching;

      const firstStore = JSON.parse(
        await readFile(
          join(repository, ".git", "redline", "state.json"),
          "utf8",
        ),
      ) as { approvals: Record<string, unknown> };
      expect(firstStore.approvals["example.ts"]).toBeDefined();
      const secondStatePath = join(
        secondRepository,
        ".git",
        "redline",
        "state.json",
      );
      await expect(readFile(secondStatePath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      workspace.close();
    } finally {
      await rm(secondRepository, { recursive: true, force: true });
    }
  });

  it("does not reconcile an old workspace deferred set into a newly opened store", async () => {
    const secondRepository = await mkdtemp(
      join(tmpdir(), "redline-deferred-switch-"),
    );
    try {
      await exec("git", ["init"], { cwd: secondRepository });
      await exec("git", ["config", "user.email", "redline@example.test"], {
        cwd: secondRepository,
      });
      await exec("git", ["config", "user.name", "Redline Test"], {
        cwd: secondRepository,
      });
      await writeFile(
        join(secondRepository, "second.ts"),
        "export const second = 1;\n",
        "utf8",
      );
      await exec("git", ["add", "second.ts"], { cwd: secondRepository });
      await exec("git", ["commit", "-m", "initial"], { cwd: secondRepository });
      await writeFile(
        join(secondRepository, "second.ts"),
        "export const second = 2;\n",
        "utf8",
      );
      const seed = new ReviewWorkspace(secondRepository);
      await seed.initialize();
      await seed.deferFile("second.ts");
      seed.close();

      const firstStateDir = join(repository, ".git", "redline");
      await mkdir(firstStateDir, { recursive: true });
      await writeFile(
        join(firstStateDir, "state.json"),
        JSON.stringify({
          version: 1,
          approvals: {},
          snapshots: [],
          deferredPaths: ["vanished.ts"],
        }),
        "utf8",
      );
      const workspace = new ReviewWorkspace(repository);
      await workspace.initialize();
      const internals = workspace as unknown as {
        changedFiles: (...args: unknown[]) => Promise<unknown>;
      };
      const originalChangedFiles = internals.changedFiles.bind(workspace);
      let release: (() => void) | undefined;
      let started: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      let blocked = false;
      internals.changedFiles = async (...args: unknown[]) => {
        if (!blocked) {
          blocked = true;
          started?.();
          await gate;
        }
        return originalChangedFiles(...args);
      };
      const staleRead = workspace.getWorkspace();
      await entered;
      const switching = workspace.openWorkspace(secondRepository);
      while (workspace.getRoot() !== secondRepository)
        await new Promise((resolve) => setTimeout(resolve, 1));
      release?.();
      await Promise.allSettled([staleRead, switching]);
      const secondStore = JSON.parse(
        await readFile(
          join(secondRepository, ".git", "redline", "state.json"),
          "utf8",
        ),
      ) as { deferredPaths: string[] };
      expect(secondStore.deferredPaths).toEqual(["second.ts"]);
      workspace.close();
    } finally {
      await rm(secondRepository, { recursive: true, force: true });
    }
  });
});
