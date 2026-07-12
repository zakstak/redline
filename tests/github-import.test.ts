import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
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
import type { DiffResponse } from "../shared/review-contract.js";

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
        "```html",
        '<img src="example.png">',
        "```",
      ].join("\n"),
    );
  });
});

describe("GitHub import synchronization", () => {
  it("discovers one exact PR, coalesces refresh, and preserves a complete snapshot on failure", async () => {
    let failThreads = false;
    let graphQLError = false;
    let abortOnSource: AbortController | null = null;
    let threadCalls = 0;
    const headSha = "a".repeat(40);
    const baseSha = "b".repeat(40);
    const executor: CommandExecutor = async (command, args) => {
      await Promise.resolve();
      if (command === "git") {
        const joined = args.join(" ");
        if (joined === "remote")
          return { stdout: "origin\n", stderr: "", code: 0 };
        if (joined.includes("remote.origin.url"))
          return {
            stdout: "https://github.com/base/project.git\n",
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
        if (joined.startsWith("merge-base --is-ancestor"))
          return { stdout: "", stderr: "", code: 0 };
        if (joined === `show ${headSha}:src/example.ts`) abortOnSource?.abort();
        if (joined === `show ${headSha}:src/example.ts`)
          return { stdout: "before\nupdated\nafter\n", stderr: "", code: 0 };
      }
      if (command === "gh") {
        const joined = args.join(" ");
        if (joined.includes("repos/base/project/pulls")) {
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
    expect(Object.keys(storedShape.sources)).toHaveLength(1);
    expect(storedShape.snapshots[0]?.sourceIds).toEqual([
      Object.keys(storedShape.sources)[0],
    ]);
    expect(storedShape.snapshots[0]).not.toHaveProperty("sources");
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
    await writeFile(incompleteStage, "incomplete");
    expect(await importer.verifyForRead()).toMatchObject({ retained: false });
    await expect(access(incompleteStage)).rejects.toThrow();
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
});
