import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GitHubImportManager,
  mapGitHubAnchor,
  normalizeGitHubAuthor,
  parseGitHubRemote,
  sanitizeGitHubMarkdown,
  safeGitHubLink,
  type CommandExecutor,
} from "../server/github-import.js";
import type {
  DiffResponse,
  GitHubImportStatus,
} from "../shared/review-contract.js";

let repository = "";
let gitDir = "";

beforeEach(async () => {
  repository = await mkdtemp(join(tmpdir(), "redline-github-import-"));
  gitDir = join(repository, ".git");
  await mkdir(gitDir, { recursive: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(repository, { recursive: true, force: true });
});

const diff: DiffResponse = {
  schemaVersion: 1,
  path: "src/example.ts",
  diff: "",
  lines: [
    {
      id: "new-1",
      type: "context",
      content: "before",
      oldLine: 1,
      newLine: 1,
      anchors: [
        { side: "old", startLine: 1, endLine: 1 },
        { side: "new", startLine: 1, endLine: 1 },
      ],
    },
    {
      id: "new-2",
      type: "add",
      content: "updated",
      oldLine: null,
      newLine: 2,
      anchors: [{ side: "new", startLine: 2, endLine: 2 }],
    },
    {
      id: "new-3",
      type: "context",
      content: "after",
      oldLine: 2,
      newLine: 3,
      anchors: [
        { side: "old", startLine: 2, endLine: 2 },
        { side: "new", startLine: 3, endLine: 3 },
      ],
    },
  ],
  language: "typescript",
  fingerprint: "fingerprint",
  reviewStatus: "unreviewed",
  truncated: false,
  stats: { additions: 1, deletions: 0 },
  comments: [],
};

describe("GitHub import primitives", () => {
  it.each([
    "https://github.com/Owner/Repo.git",
    "https://github.com/Owner/Repo.git/",
    "ssh://git@github.com/Owner/Repo.git",
    "git@github.com:Owner/Repo.git",
  ])("normalizes equivalent GitHub remotes: %s", (value) => {
    expect(parseGitHubRemote(value)?.normalized).toBe("owner/repo");
  });

  it.each([
    "https://example.com/owner/repo",
    "https://user:secret@github.com/owner/repo",
    "https://github.com/owner/repo/extra",
    "file:///tmp/repo",
  ])("rejects an ineligible remote: %s", (value) => {
    expect(parseGitHubRemote(value)).toBeNull();
  });

  it("maps exact content and one unique context match but rejects ambiguity", () => {
    expect(
      mapGitHubAnchor(
        { side: "new", startLine: 1, endLine: 3 },
        "before\nupdated\nafter\n",
        "before\nupdated\nafter\n",
        { ...diff, lines: [diff.lines[0]] },
      ).reason,
    ).toBe("not_in_diff");
    expect(
      mapGitHubAnchor(
        { side: "new", startLine: 2, endLine: 2 },
        "before\r\nupdated\r\nafter\r\n",
        "before\nupdated\nafter\n",
        diff,
      ),
    ).toEqual({ anchor: { side: "new", startLine: 2, endLine: 2 } });
    expect(
      mapGitHubAnchor(
        { side: "new", startLine: 3, endLine: 3 },
        "origin\nbefore\nupdated\nafter\ntail\n",
        "prefix\nbefore\nupdated\nafter\ntail\n",
        {
          ...diff,
          lines: diff.lines.map((line) => ({
            ...line,
            newLine: line.newLine === null ? null : line.newLine + 1,
            anchors: line.anchors.map((anchor) =>
              anchor.side === "new"
                ? {
                    ...anchor,
                    startLine: anchor.startLine + 1,
                    endLine: anchor.endLine + 1,
                  }
                : anchor,
            ),
          })),
        },
      ).anchor,
    ).toEqual({ side: "new", startLine: 3, endLine: 3 });
    expect(
      mapGitHubAnchor(
        { side: "new", startLine: 2, endLine: 2 },
        "before\nupdated\nafter\n",
        "before\nupdated\nafter\nbefore\nupdated\nafter\n",
        diff,
      ).reason,
    ).toBe("ambiguous_context");
    expect(
      mapGitHubAnchor(
        { side: "new", startLine: 2, endLine: 2 },
        "before\nupdated\nafter\n",
        "before\nupdated\ndifferent\n",
        diff,
      ).reason,
    ).toBe("context_not_found");
  });

  it("normalizes poster labels and grapheme initials independently", () => {
    expect(
      normalizeGitHubAuthor({
        login: "octocat",
        name: "  Élodie 山田  ",
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
      }),
    ).toMatchObject({ name: "Élodie 山田", initials: "É山" });
    expect(
      normalizeGitHubAuthor({ login: "🦊fox", name: " ", avatarUrl: null }),
    ).toMatchObject({ name: "🦊fox", initials: "🦊F" });
    expect(
      normalizeGitHubAuthor({ login: null, name: null, avatarUrl: null }),
    ).toMatchObject({ name: "Deleted GitHub user", initials: "GH" });
  });

  it.each([
    ["https://github.com/owner/repo/pull/1#discussion_r1", true],
    ["http://github.com/owner/repo", false],
    ["https://user@github.com/owner/repo", false],
    ["https://example.com/owner/repo", false],
  ])("validates a source link: %s", (value, accepted) => {
    expect(Boolean(safeGitHubLink(value))).toBe(accepted);
  });

  it("removes HTML, images, relative and unsafe links while preserving GFM code and autolinks", () => {
    expect(
      sanitizeGitHubMarkdown(
        [
          "<b>safe text</b>",
          "![tracking](https://example.com/a.png)",
          "[relative](./file) [unsafe](javascript:evil) [safe](https://example.com)",
          "<https://example.com>",
          "<https://user:token@example.com/private>",
          "```html",
          '<img src="example.png">',
          "```",
        ].join("\n"),
      ),
    ).toBe(
      [
        "safe text",
        "tracking",
        "relative unsafe [safe](https://example.com)",
        "<https://example.com>",
        "",
        "```html",
        '<img src="example.png">',
        "```",
      ].join("\n"),
    );
  });

  it("removes unsafe reference-style link and image destinations", () => {
    expect(
      sanitizeGitHubMarkdown(
        [
          "[safe-looking][unsafe] ![pixel][image] [ok][safe] ![safe pixel][safe]",
          "[unsafe]: javascript:alert(1)",
          "[image]: data:image/svg+xml,evil",
          '[safe]: https://example.com/path "title"',
        ].join("\n"),
      ),
    ).toBe(
      [
        "[safe-looking][unsafe] pixel [ok][safe] safe pixel",
        "",
        "",
        '[safe]: https://example.com/path "title"',
      ].join("\n"),
    );
  });
});

describe("GitHub import synchronization", () => {
  it("discovers one exact PR, coalesces refresh, and preserves a complete snapshot on failure", async () => {
    let failThreads = false;
    let graphQLError = false;
    let failDiscovery = false;
    let abortOnSource: AbortController | null = null;
    let changeIdentityOnSource = false;
    let threadCalls = 0;
    const ghCalls: string[][] = [];
    const gitCalls: string[] = [];
    let remoteUrl = "https://github.com/base/project.git";
    const headSha = "a".repeat(40);
    let gitStateHead = headSha;
    const baseSha = "b".repeat(40);
    const diffBaseSha = "c".repeat(40);
    const executor: CommandExecutor = async (command, args) => {
      await Promise.resolve();
      if (command === "git") {
        const joined = args.join(" ");
        gitCalls.push(joined);
        if (joined === "remote")
          return { stdout: "origin\n", stderr: "", code: 0 };
        if (joined.includes("remote.origin.url"))
          return {
            stdout: `${remoteUrl}\n`,
            stderr: "",
            code: 0,
          };
        if (joined.includes("--get-regexp"))
          return {
            stdout: `remote.origin.url\n${remoteUrl}\0`,
            stderr: "",
            code: 0,
          };
        if (joined.includes("remote.origin.pushurl"))
          return { stdout: "", stderr: "", code: 1 };
        if (
          joined.includes("branch.feature.pushRemote") ||
          joined.includes("remote.pushDefault")
        )
          return { stdout: "", stderr: "", code: 1 };
        if (joined.includes("branch.feature.remote"))
          return { stdout: "origin\n", stderr: "", code: 0 };
        if (joined === "branch --show-current")
          return { stdout: "feature\n", stderr: "", code: 0 };
        if (joined === "rev-parse HEAD")
          return { stdout: `${headSha}\n`, stderr: "", code: 0 };
        if (joined === "rev-parse --verify HEAD")
          return { stdout: `${gitStateHead}\n`, stderr: "", code: 0 };
        if (joined.startsWith("merge-base --is-ancestor"))
          return { stdout: "", stderr: "", code: 0 };
        if (joined === `merge-base ${baseSha} ${headSha}`)
          return { stdout: `${diffBaseSha}\n`, stderr: "", code: 0 };
        if (joined === `show ${headSha}:src/example.ts`) {
          abortOnSource?.abort();
          if (changeIdentityOnSource) gitStateHead = "e".repeat(40);
        }
        if (joined === `show ${headSha}:src/example.ts`)
          return { stdout: "before\nupdated\nafter\n", stderr: "", code: 0 };
        if (joined === `show ${diffBaseSha}:src/deleted.ts`)
          return { stdout: "deleted\n", stderr: "", code: 0 };
      }
      if (command === "gh") {
        ghCalls.push(args);
        const joined = args.join(" ");
        if (joined.includes("repos/base/project/pulls")) {
          if (failDiscovery)
            return { stdout: "", stderr: "network unavailable", code: 1 };
          return {
            stdout: JSON.stringify([
              {
                number: 17,
                title: "Feature",
                base: {
                  sha: baseSha,
                  repo: { full_name: "base/project" },
                },
                head: {
                  sha: headSha,
                  ref: "feature",
                  repo: { full_name: "base/project" },
                },
              },
            ]),
            stderr: "",
            code: 0,
          };
        }
        if (joined.includes("reviewThreads")) {
          threadCalls += 1;
          if (failThreads) return { stdout: "", stderr: "rate limit", code: 1 };
          const response = {
            ...(graphQLError
              ? { errors: [{ message: "Something failed upstream" }] }
              : {}),
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      {
                        id: "thread-1",
                        isResolved: false,
                        isOutdated: false,
                        subjectType: "LINE",
                        path: "src/example.ts",
                        line: 2,
                        startLine: 2,
                        diffSide: "RIGHT",
                        comments: {
                          pageInfo: { hasNextPage: false, endCursor: null },
                          nodes: [
                            {
                              id: "root-1",
                              body: "**Please** keep this safe.",
                              createdAt: "2026-07-11T10:00:00.000Z",
                              updatedAt: "2026-07-11T10:00:00.000Z",
                              url: "https://github.com/base/project/pull/17#discussion_r1",
                              state: "SUBMITTED",
                              author: {
                                login: "root-user",
                                name: "Root User",
                                avatarUrl: null,
                              },
                              commit: { oid: headSha },
                            },
                            {
                              id: "reply-1",
                              body: "Reply from another person.",
                              createdAt: "2026-07-11T11:00:00.000Z",
                              updatedAt: "2026-07-11T11:00:00.000Z",
                              url: "https://github.com/base/project/pull/17#discussion_r2",
                              state: "SUBMITTED",
                              author: {
                                login: "reply-user",
                                name: "Reply User",
                                avatarUrl: null,
                              },
                              commit: { oid: headSha },
                            },
                          ],
                        },
                      },
                      {
                        id: "deleted-thread",
                        isResolved: false,
                        isOutdated: false,
                        subjectType: "LINE",
                        path: "src/deleted.ts",
                        line: 1,
                        startLine: 1,
                        diffSide: "LEFT",
                        comments: {
                          pageInfo: { hasNextPage: false, endCursor: null },
                          nodes: [
                            {
                              id: "deleted-root",
                              body: "Keep this deletion in view.",
                              createdAt: "2026-07-11T10:00:00.000Z",
                              updatedAt: "2026-07-11T10:00:00.000Z",
                              url: "https://github.com/base/project/pull/17#discussion_deleted",
                              state: "SUBMITTED",
                              author: null,
                              commit: { oid: headSha },
                            },
                          ],
                        },
                      },
                      {
                        id: "file-thread",
                        subjectType: "FILE",
                        path: "src/example.ts",
                        comments: {
                          pageInfo: { hasNextPage: false, endCursor: null },
                          nodes: [],
                        },
                      },
                      {
                        id: "pending-thread",
                        isResolved: false,
                        isOutdated: false,
                        subjectType: "LINE",
                        path: "src/example.ts",
                        line: 2,
                        startLine: 2,
                        diffSide: "RIGHT",
                        comments: {
                          pageInfo: { hasNextPage: false, endCursor: null },
                          nodes: [
                            {
                              id: "pending-root",
                              body: "Not published.",
                              createdAt: "2026-07-11T10:00:00.000Z",
                              updatedAt: "2026-07-11T10:00:00.000Z",
                              url: "https://github.com/base/project/pull/17#discussion_pending",
                              state: "PENDING",
                              author: null,
                              commit: { oid: headSha },
                            },
                            {
                              id: "submitted-reply",
                              body: "A published reply cannot promote a pending root.",
                              createdAt: "2026-07-11T11:00:00.000Z",
                              updatedAt: "2026-07-11T11:00:00.000Z",
                              url: "https://github.com/base/project/pull/17#discussion_reply",
                              state: "SUBMITTED",
                              author: null,
                              commit: { oid: headSha },
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              },
            },
          };
          return {
            stdout: JSON.stringify(response),
            stderr: "",
            code: 0,
          };
        }
      }
      return {
        stdout: "",
        stderr: `unexpected ${command} ${args.join(" ")}`,
        code: 1,
      };
    };

    const importer = new GitHubImportManager(repository, gitDir, executor);
    expect(await importer.discover()).toMatchObject({
      state: "available",
      repository: "base/project",
      pullRequest: 17,
      retained: false,
    });
    const [first, second] = await Promise.all([
      importer.refresh(),
      importer.refresh(),
    ]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ state: "available", retained: true });
    expect(threadCalls).toBe(1);
    expect(gitCalls).toContain(`show ${diffBaseSha}:src/deleted.ts`);
    expect(gitCalls).not.toContain(`show ${headSha}:src/deleted.ts`);
    expect(ghCalls.length).toBeGreaterThan(0);
    expect(
      ghCalls.every(
        (args) =>
          args[0] === "api" &&
          args[1] === "--hostname" &&
          args[2] === "github.com",
      ),
    ).toBe(true);
    const comments = await importer.commentsForDiff(diff, {
      old: "before\nafter\n",
      new: "before\nupdated\nafter\n",
    });
    expect(comments[0]).toMatchObject({
      source: "github",
      readOnly: true,
      author: { name: "Root User" },
      anchors: [{ side: "new", startLine: 2, endLine: 2 }],
      replies: [{ author: { name: "Reply User" } }],
      github: { mapping: "mapped", repository: "base/project" },
    });
    const editedHead = await importer.commentsForDiff(
      {
        ...diff,
        lines: [
          {
            id: "old-2",
            type: "remove",
            content: "updated",
            oldLine: 2,
            newLine: null,
            anchors: [{ side: "old", startLine: 2, endLine: 2 }],
          },
        ],
      },
      {
        old: "before\nupdated\nafter\n",
        new: "before\nlocally changed\nafter\n",
      },
    );
    expect(editedHead[0]).toMatchObject({
      anchors: [{ side: "old", startLine: 2, endLine: 2 }],
      github: { mapping: "mapped" },
    });
    const renamed = await importer.commentsForDiff(
      { ...diff, path: "src/renamed.ts" },
      { old: "before\nafter\n", new: "before\nupdated\nafter\n" },
      ["src/renamed.ts", "src/example.ts"],
    );
    expect(renamed[0]).toMatchObject({
      path: "src/renamed.ts",
      github: { originalPath: "src/example.ts", mapping: "mapped" },
    });
    expect(await importer.hasCommentsForDiff(["src/unrelated.ts"])).toBe(false);

    remoteUrl = "https://github.com/other/project.git";
    expect(
      await importer.commentsForDiff(diff, {
        old: "before\nafter\n",
        new: "before\nupdated\nafter\n",
      }),
    ).toEqual([]);
    remoteUrl = "https://github.com/base/project.git";
    expect(
      await importer.commentsForDiff(diff, {
        old: "before\nafter\n",
        new: "before\nupdated\nafter\n",
      }),
    ).toHaveLength(1);

    failDiscovery = true;
    expect(await importer.discover()).toMatchObject({ state: "unavailable" });
    failDiscovery = false;
    expect(
      await importer.commentsForDiff(diff, {
        old: "before\nafter\n",
        new: "before\nupdated\nafter\n",
      }),
    ).toHaveLength(1);

    const retainedReader = new GitHubImportManager(
      repository,
      gitDir,
      executor,
    );
    const retainedComments = await retainedReader.commentsForDiff(diff, {
      old: "before\nafter\n",
      new: "before\nupdated\nafter\n",
    });
    expect(retainedComments).toHaveLength(1);
    expect(retainedComments[0]).toMatchObject({
      id: "github:base/project#17:thread-1",
      anchors: [{ side: "new", startLine: 2, endLine: 2 }],
    });
    const unavailable = await importer.allComments(() =>
      Promise.reject(new Error("path unavailable")),
    );
    expect(unavailable[0]).toMatchObject({
      anchors: [],
      github: { mapping: "unmapped" },
    });
    const storePath = join(gitDir, "redline", "github-imports.json");
    const beforeReactivation = JSON.parse(
      await readFile(storePath, "utf8"),
    ) as {
      snapshots: Array<{ activatedAt: string }>;
    };
    beforeReactivation.snapshots[0].activatedAt = "2000-01-01T00:00:00.000Z";
    await writeFile(storePath, JSON.stringify(beforeReactivation));
    await importer.verifyForRead();
    const afterRead = JSON.parse(await readFile(storePath, "utf8")) as {
      snapshots: Array<{ activatedAt: string }>;
    };
    expect(afterRead.snapshots[0]?.activatedAt).toBe(
      "2000-01-01T00:00:00.000Z",
    );
    await importer.discover();
    const afterReactivation = JSON.parse(await readFile(storePath, "utf8")) as {
      snapshots: Array<{ activatedAt: string }>;
    };
    expect(afterReactivation.snapshots[0]?.activatedAt).not.toBe(
      "2000-01-01T00:00:00.000Z",
    );
    const storedBefore = await readFile(storePath, "utf8");
    const storedShape = JSON.parse(storedBefore) as {
      sources: Record<string, string>;
      snapshots: Array<{ sourceIds: string[]; sources?: unknown }>;
    };
    expect(Object.keys(storedShape.sources)).toHaveLength(2);
    expect(storedShape.snapshots[0]?.sourceIds).toEqual(
      Object.keys(storedShape.sources).sort(),
    );
    expect(storedShape.snapshots[0]).not.toHaveProperty("sources");
    changeIdentityOnSource = true;
    expect(await importer.refresh()).toMatchObject({
      state: "failed",
      retained: true,
    });
    expect(await readFile(storePath, "utf8")).toBe(storedBefore);
    changeIdentityOnSource = false;
    gitStateHead = headSha;
    graphQLError = true;
    expect(await importer.refresh()).toMatchObject({
      state: "failed",
      retained: true,
    });
    expect(await readFile(storePath, "utf8")).toBe(storedBefore);
    graphQLError = false;

    abortOnSource = new AbortController();
    const cancelled = abortOnSource;
    expect(await importer.refresh(cancelled.signal)).toMatchObject({
      retained: true,
      message: "GitHub import was cancelled.",
    });
    expect(await readFile(storePath, "utf8")).toBe(storedBefore);
    abortOnSource = null;

    failThreads = true;
    expect(await importer.refresh()).toMatchObject({
      state: "failed",
      retained: true,
      stale: true,
    });
    expect(
      await readFile(join(gitDir, "redline", "github-imports.json"), "utf8"),
    ).toBe(storedBefore);
    expect(
      await importer.commentsForDiff(diff, {
        old: null,
        new: "before\nupdated\nafter\n",
      }),
    ).toHaveLength(1);

    const corrupt = JSON.parse(await readFile(storePath, "utf8")) as {
      sources: Record<string, string>;
    };
    const sourceId = Object.keys(corrupt.sources)[0];
    expect(sourceId).toBeDefined();
    if (!sourceId) throw new Error("expected a stored source");
    corrupt.sources[sourceId] = "corrupt bytes";
    await writeFile(storePath, JSON.stringify(corrupt));
    const incompleteStage = `${storePath}.crashed.tmp`;
    const liveStage = `${storePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(incompleteStage, "incomplete");
    await writeFile(liveStage, "active write");
    const staleTime = new Date(Date.now() - 2 * 60 * 60_000);
    await utimes(incompleteStage, staleTime, staleTime);
    expect(await importer.verifyForRead()).toMatchObject({ retained: false });
    await expect(access(incompleteStage)).rejects.toThrow();
    await expect(access(liveStage)).resolves.toBeUndefined();
  });

  it("keeps a shared refresh running while another waiter remains", async () => {
    const importer = new GitHubImportManager(repository, gitDir);
    let sharedSignal: AbortSignal | undefined;
    let finish: ((status: GitHubImportStatus) => void) | undefined;
    const internals = importer as unknown as {
      refreshOnce(signal?: AbortSignal): Promise<GitHubImportStatus>;
    };
    internals.refreshOnce = (signal) => {
      sharedSignal = signal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    };

    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = importer.refresh(firstController.signal);
    const second = importer.refresh(secondController.signal);
    firstController.abort();

    await expect(first).resolves.toMatchObject({
      message: "GitHub import wait was cancelled.",
    });
    expect(sharedSignal?.aborted).toBe(false);
    finish?.({
      version: 1,
      state: "available",
      retained: true,
      stale: false,
      message: "Import complete.",
    });
    await expect(second).resolves.toMatchObject({
      message: "Import complete.",
    });
  });

  it("keys coalesced discovery to the git state", async () => {
    const importer = new GitHubImportManager(repository, gitDir);
    let state = "feature\0head-a\0origin-a";
    let finishFirst: ((status: GitHubImportStatus) => void) | undefined;
    let calls = 0;
    const internals = importer as unknown as {
      gitState(): Promise<string>;
      discoverOnce(): Promise<GitHubImportStatus>;
    };
    internals.gitState = () => Promise.resolve(state);
    internals.discoverOnce = () => {
      calls += 1;
      if (calls === 1)
        return new Promise((resolve) => {
          finishFirst = resolve;
        });
      return Promise.resolve({
        version: 1,
        state: "available",
        retained: false,
        stale: false,
        message: "Current branch.",
      });
    };

    const first = importer.discover();
    await vi.waitFor(() => expect(calls).toBe(1));
    state = "other\0head-b\0origin-b";
    const second = importer.discover();
    finishFirst?.({
      version: 1,
      state: "available",
      retained: false,
      stale: false,
      message: "Previous branch.",
    });

    await expect(first).resolves.toMatchObject({ message: "Previous branch." });
    await expect(second).resolves.toMatchObject({ message: "Current branch." });
    expect(calls).toBe(2);
  });

  it("propagates refresh cancellation into GitHub retrieval", async () => {
    let retrievalSignal: AbortSignal | undefined;
    const executor: CommandExecutor = (command, args, options) => {
      if (command !== "gh" || !args.includes("graphql"))
        return Promise.resolve({ stdout: "", stderr: "", code: 1 });
      retrievalSignal = options.signal;
      return new Promise((resolve) => {
        options.signal?.addEventListener(
          "abort",
          () => resolve({ stdout: "", stderr: "cancelled", code: 1 }),
          { once: true },
        );
      });
    };
    const importer = new GitHubImportManager(repository, gitDir, executor);
    const internals = importer as unknown as {
      retrievalCalls: number;
      retrievalBytes: number;
      retrievalStderrBytes: number;
      retrievalStartedAt: number;
      fetchThreads(
        identity: {
          base: { owner: string; name: string; normalized: string };
          head: { owner: string; name: string; normalized: string };
          number: number;
          title: string;
          headRefName: string;
          headSha: string;
          baseSha: string;
          diffBaseSha: string;
        },
        signal: AbortSignal,
      ): Promise<unknown>;
    };
    internals.retrievalCalls = 0;
    internals.retrievalBytes = 0;
    internals.retrievalStderrBytes = 0;
    internals.retrievalStartedAt = Date.now();
    const controller = new AbortController();
    const fetching = internals.fetchThreads(
      {
        base: { owner: "base", name: "project", normalized: "base/project" },
        head: { owner: "base", name: "project", normalized: "base/project" },
        number: 1,
        title: "Feature",
        headRefName: "feature",
        headSha: "a".repeat(40),
        baseSha: "b".repeat(40),
        diffBaseSha: "b".repeat(40),
      },
      controller.signal,
    );
    await vi.waitFor(() => expect(retrievalSignal).toBe(controller.signal));
    controller.abort();
    await expect(fetching).rejects.toThrow();
    expect(retrievalSignal?.aborted).toBe(true);
  });

  it("propagates cancellation while proving PR identity", async () => {
    let discoverySignal: AbortSignal | undefined;
    const executor: CommandExecutor = (command, args, options) => {
      const joined = args.join(" ");
      if (command === "git") {
        if (joined === "remote")
          return Promise.resolve({ stdout: "origin\n", stderr: "", code: 0 });
        if (joined.includes("remote.origin.url"))
          return Promise.resolve({
            stdout: "https://github.com/base/project.git\n",
            stderr: "",
            code: 0,
          });
        if (joined.includes("remote.origin.pushurl"))
          return Promise.resolve({ stdout: "", stderr: "", code: 1 });
        if (joined.includes("branch.feature.remote"))
          return Promise.resolve({ stdout: "origin\n", stderr: "", code: 0 });
        if (
          joined.includes("branch.feature.pushRemote") ||
          joined.includes("remote.pushDefault")
        )
          return Promise.resolve({ stdout: "", stderr: "", code: 1 });
        if (joined === "branch --show-current")
          return Promise.resolve({ stdout: "feature\n", stderr: "", code: 0 });
        if (joined === "rev-parse HEAD")
          return Promise.resolve({
            stdout: `${"a".repeat(40)}\n`,
            stderr: "",
            code: 0,
          });
      }
      if (command === "gh") {
        discoverySignal = options.signal;
        return new Promise((resolve) => {
          options.signal?.addEventListener(
            "abort",
            () => resolve({ stdout: "", stderr: "cancelled", code: 1 }),
            { once: true },
          );
        });
      }
      return Promise.resolve({ stdout: "", stderr: "unexpected", code: 1 });
    };
    const importer = new GitHubImportManager(repository, gitDir, executor);
    const internals = importer as unknown as {
      discoverIdentity(signal: AbortSignal): Promise<unknown>;
    };
    const controller = new AbortController();
    const discovery = internals.discoverIdentity(controller.signal);
    await vi.waitFor(() => expect(discoverySignal).toBe(controller.signal));
    controller.abort();
    await expect(discovery).rejects.toThrow("cancelled");
  });

  it("does not launch commands for an already-aborted identity proof", async () => {
    const importer = new GitHubImportManager(repository, gitDir);
    const internals = importer as unknown as {
      discoverIdentity(signal: AbortSignal): Promise<unknown>;
    };
    const controller = new AbortController();
    controller.abort();
    await expect(internals.discoverIdentity(controller.signal)).rejects.toThrow(
      "cancelled",
    );
  });

  it("does not cache a read proof across a git state change", async () => {
    const importer = new GitHubImportManager(repository, gitDir);
    let gitStateCalls = 0;
    const internals = importer as unknown as {
      readIdentityVerified: boolean;
      verifiedGitState: string | null;
      activeIdentity: string | null;
      gitState(): Promise<string>;
      readStore(): Promise<{
        version: 1;
        snapshots: Array<{ repository: string; pullRequest: number }>;
        sources: Record<string, string>;
      }>;
      discoverIdentity(): Promise<{
        base: { owner: string; name: string; normalized: string };
        head: { owner: string; name: string; normalized: string };
        number: number;
        title: string;
        headRefName: string;
        headSha: string;
        baseSha: string;
        diffBaseSha: string;
      }>;
    };
    internals.gitState = () =>
      Promise.resolve(gitStateCalls++ === 0 ? "old-state" : "new-state");
    internals.readStore = () =>
      Promise.resolve({
        version: 1,
        snapshots: [{ repository: "base/project", pullRequest: 1 }],
        sources: {},
      });
    internals.discoverIdentity = () =>
      Promise.resolve({
        base: { owner: "base", name: "project", normalized: "base/project" },
        head: { owner: "base", name: "project", normalized: "base/project" },
        number: 1,
        title: "Feature",
        headRefName: "feature",
        headSha: "a".repeat(40),
        baseSha: "b".repeat(40),
        diffBaseSha: "b".repeat(40),
      });

    await importer.verifyForRead();
    expect(internals.readIdentityVerified).toBe(false);
    expect(internals.verifiedGitState).toBeNull();
    expect(internals.activeIdentity).toBeNull();
  });

  it("does not cache a failed retained identity proof", async () => {
    const importer = new GitHubImportManager(repository, gitDir);
    const internals = importer as unknown as {
      readIdentityVerified: boolean;
      verifiedGitState: string | null;
      gitState(): Promise<string>;
      readStore(): Promise<{
        version: 1;
        snapshots: Array<{ repository: string; pullRequest: number }>;
        sources: Record<string, string>;
      }>;
      discoverIdentity(): Promise<never>;
    };
    internals.gitState = () => Promise.resolve("stable-state");
    internals.readStore = () =>
      Promise.resolve({
        version: 1,
        snapshots: [{ repository: "base/project", pullRequest: 1 }],
        sources: {},
      });
    internals.discoverIdentity = () =>
      Promise.reject(new Error("temporary_network_failure"));

    await expect(importer.verifyForRead()).resolves.toMatchObject({
      state: "unavailable",
    });
    expect(internals.readIdentityVerified).toBe(false);
    expect(internals.verifiedGitState).toBeNull();
  });

  it("evicts inactive snapshots to admit source text for the current PR", () => {
    const importer = new GitHubImportManager(repository, gitDir);
    type Snapshot = {
      repository: string;
      pullRequest: number;
      title: string;
      headRepository: string;
      headRefName: string;
      headSha: string;
      baseSha: string;
      activatedAt: string;
      synchronizedAt: string;
      threads: Array<{
        id: string;
        path: string;
        resolved: boolean;
        outdated: boolean;
        coordinate: null;
        alternateCoordinate: null;
        sourceCommit: null;
        sourceContentId: string | null;
        comments: [];
      }>;
      sourceIds: string[];
    };
    type Store = {
      version: 1;
      snapshots: Snapshot[];
      sources: Record<string, string>;
    };
    const sources: Record<string, string> = {};
    const snapshots = Array.from({ length: 7 }, (_, index): Snapshot => {
      const sourceId = `old-${index}`;
      sources[sourceId] = "x".repeat(9 * 1024 * 1024);
      return {
        repository: `base/old-${index}`,
        pullRequest: index + 1,
        title: "Old",
        headRepository: `base/old-${index}`,
        headRefName: "feature",
        headSha: "a".repeat(40),
        baseSha: "b".repeat(40),
        activatedAt: `2026-01-0${index + 1}T00:00:00.000Z`,
        synchronizedAt: "2026-01-01T00:00:00.000Z",
        threads: [],
        sourceIds: [sourceId],
      };
    });
    const incoming: Snapshot = {
      repository: "base/current",
      pullRequest: 99,
      title: "Current",
      headRepository: "base/current",
      headRefName: "feature",
      headSha: "c".repeat(40),
      baseSha: "d".repeat(40),
      activatedAt: "2026-07-12T00:00:00.000Z",
      synchronizedAt: "2026-07-12T00:00:00.000Z",
      threads: [
        {
          id: "thread",
          path: "src/example.ts",
          resolved: false,
          outdated: false,
          coordinate: null,
          alternateCoordinate: null,
          sourceCommit: null,
          sourceContentId: "current-source",
          comments: [],
        },
      ],
      sourceIds: [],
    };
    const internals = importer as unknown as {
      admitSnapshot(
        store: Store,
        snapshot: Snapshot,
        optionalSources: Record<string, string>,
      ): Store;
    };

    const admitted = internals.admitSnapshot(
      { version: 1, snapshots, sources },
      incoming,
      { "current-source": "y".repeat(2 * 1024 * 1024) },
    );
    expect(admitted.snapshots).toHaveLength(7);
    expect(
      admitted.snapshots.map((snapshot) => snapshot.repository),
    ).not.toContain("base/old-0");
    expect(
      admitted.snapshots.find(
        (snapshot) => snapshot.repository === "base/current",
      )?.sourceIds,
    ).toEqual(["current-source"]);
  });

  it("coalesces and validates same-origin avatar source data", async () => {
    const importer = new GitHubImportManager(repository, gitDir, async () => {
      await Promise.resolve();
      return { stdout: "", stderr: "", code: 0 };
    });
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(png, { headers: { "content-type": "image/png" } }),
      );
    const url = "https://avatars.githubusercontent.com/u/1";
    const [first, second] = await Promise.all([
      importer.getAvatar(url),
      importer.getAvatar(url),
    ]);
    expect(first.data).toEqual(png);
    expect(second.data).toEqual(png);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await expect(
      importer.getAvatar("https://example.com/avatar.png"),
    ).rejects.toThrow("invalid_avatar_url");
  });

  it("reserves released avatar slots for queued requests", async () => {
    const importer = new GitHubImportManager(repository, gitDir);
    const pending: Array<() => void> = [];
    let active = 0;
    let maximum = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          active += 1;
          maximum = Math.max(maximum, active);
          pending.push(() => {
            active -= 1;
            resolve(
              new Response(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]), {
                headers: { "content-type": "image/png" },
              }),
            );
          });
        }),
    );
    const requests = Array.from({ length: 5 }, (_, index) =>
      importer.getAvatar(`https://avatars.githubusercontent.com/u/${index}`),
    );
    await vi.waitFor(() => expect(pending).toHaveLength(4));
    pending.shift()?.();
    await vi.waitFor(() => expect(pending).toHaveLength(4));
    while (pending.length > 0) pending.shift()?.();
    await Promise.all(requests);
    expect(maximum).toBe(4);
  });
});
