import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run, validateServerUrl } from "../cli/index.js";
import { buildServer } from "../server/app.js";
import { ReviewWorkspace } from "../server/review-workspace.js";

const execute = promisify(execFile);
let repository = "";

beforeEach(async () => {
  repository = await mkdtemp(join(tmpdir(), "redline-cli-"));
  await execute("git", ["init"], { cwd: repository });
  await execute("git", ["config", "user.email", "redline@example.test"], {
    cwd: repository,
  });
  await execute("git", ["config", "user.name", "Redline Test"], {
    cwd: repository,
  });
  await writeFile(join(repository, "example.ts"), "export const value = 1;\n");
  await execute("git", ["add", "example.ts"], { cwd: repository });
  await execute("git", ["commit", "-m", "initial"], { cwd: repository });
  await writeFile(join(repository, "example.ts"), "export const value = 2;\n");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(repository, { recursive: true, force: true });
});

describe("redline CLI", () => {
  it.each([
    "http://localhost",
    "http://localhost:4322",
    "http://127.0.0.1",
    "http://127.25.3.9:65535",
    "http://[::1]:4322",
  ])("accepts the safe loopback origin %s", (value) => {
    expect(validateServerUrl(value).protocol).toBe("http:");
  });

  it.each([
    "https://127.0.0.1",
    "http://0.0.0.0",
    "http://192.168.1.2",
    "http://user@localhost",
    "http://localhost/path",
    "http://localhost?query=1",
    "http://localhost/#fragment",
    "not a url",
  ])("rejects unsafe configuration before fetch: %s", (value) => {
    expect(() => validateServerUrl(value)).toThrow();
  });

  it("prints help and version without Git or network initialization", async () => {
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((value) => {
      output.push(String(value));
      return true;
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await run(["--help"])).toBe(0);
    expect(await run(["--version"])).toBe(0);
    expect(output.join("")).toContain("Usage: redline");
    expect(output.join("")).toContain("0.1.0");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("runs direct mode without validating or contacting the configured URL", async () => {
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((value) => {
      output.push(String(value));
      return true;
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(
      await run([
        "--mode",
        "direct",
        "--workspace",
        repository,
        "--server-url",
        "https://remote.invalid",
        "review",
      ]),
    ).toBe(0);
    expect(JSON.parse(output.join(""))).toMatchObject({
      ok: true,
      result: { workspace: { root: repository } },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("auto-falls back only during failed discovery and explicit server mode exits 4", async () => {
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const stderr: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((value) => {
      stderr.push(String(value));
      return true;
    });
    expect(
      await run([
        "--workspace",
        repository,
        "--server-url",
        "http://127.0.0.1:9",
        "review",
      ]),
    ).toBe(0);
    expect(stdout).toHaveBeenCalled();
    expect(
      await run([
        "--mode",
        "server",
        "--workspace",
        repository,
        "--server-url",
        "http://127.0.0.1:9",
        "review",
      ]),
    ).toBe(4);
    expect(JSON.parse(stderr.at(-1) ?? "{}")).toMatchObject({ ok: false });
  });

  it.each([
    ["connection failure", () => Promise.reject(new Error("ECONNREFUSED"))],
    ["DNS failure", () => Promise.reject(new Error("ENOTFOUND"))],
    ["connection reset", () => Promise.reject(new Error("ECONNRESET"))],
    [
      "timeout",
      () => Promise.reject(new DOMException("timeout", "AbortError")),
    ],
    ["redirect", () => Promise.resolve(new Response(null, { status: 302 }))],
    [
      "client status",
      () => Promise.resolve(new Response(null, { status: 404 })),
    ],
    [
      "server status",
      () => Promise.resolve(new Response(null, { status: 503 })),
    ],
    [
      "invalid content type",
      () => Promise.resolve(new Response("not json", { status: 200 })),
    ],
    [
      "malformed JSON",
      () =>
        Promise.resolve(
          new Response("{", {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
    ],
    [
      "missing identity",
      () =>
        Promise.resolve(
          Response.json({ workspaceRoot: repository, serverToken: "" }),
        ),
    ],
    [
      "mismatched identity",
      () =>
        Promise.resolve(
          Response.json({
            workspaceRoot: `${repository}-other`,
            serverToken: "token",
          }),
        ),
    ],
    [
      "truncated response body",
      () =>
        Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: () => Promise.reject(new TypeError("terminated")),
        } as Response),
    ],
  ])(
    "classifies the discovery outcome %s before selecting an adapter",
    async (_name, outcome) => {
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      fetchSpy.mockImplementationOnce(outcome);
      expect(
        await run([
          "--workspace",
          repository,
          "--server-url",
          "http://127.0.0.1:4322",
          "review",
        ]),
      ).toBe(0);
      expect(fetchSpy).toHaveBeenLastCalledWith(
        expect.any(URL),
        expect.objectContaining({ redirect: "error" }),
      );

      fetchSpy.mockImplementationOnce(outcome);
      expect(
        await run([
          "--mode",
          "server",
          "--workspace",
          repository,
          "--server-url",
          "http://127.0.0.1:4322",
          "review",
        ]),
      ).toBe(4);
    },
  );

  it("does not replay through direct mode after a selected server operation fails", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({ workspaceRoot: repository, serverToken: "token" }),
      )
      .mockRejectedValueOnce(new Error("operation reset"));
    expect(
      await run([
        "--workspace",
        repository,
        "--server-url",
        "http://127.0.0.1:4322",
        "approve",
        "workspace",
      ]),
    ).toBe(4);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const workspace = new ReviewWorkspace(repository);
    await workspace.initialize();
    try {
      expect((await workspace.getWorkspace()).latestSnapshot).toBeNull();
    } finally {
      workspace.close();
    }
  });

  it("rejects extra workspace approval operands in direct and server modes", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        Response.json({ workspaceRoot: repository, serverToken: "token" }),
      );

    expect(
      await run([
        "--mode",
        "direct",
        "--workspace",
        repository,
        "approve",
        "workspace",
        "unexpected",
      ]),
    ).toBe(2);
    expect(
      await run([
        "--mode",
        "server",
        "--workspace",
        repository,
        "approve",
        "workspace",
        "unexpected",
      ]),
    ).toBe(2);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("classifies direct workspace validation failures as domain conflicts", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((value) => {
      stderr.push(String(value));
      return true;
    });
    await execute("git", ["checkout", "--", "example.ts"], {
      cwd: repository,
    });

    expect(
      await run([
        "--mode",
        "direct",
        "--workspace",
        repository,
        "approve",
        "workspace",
      ]),
    ).toBe(5);
    expect(JSON.parse(stderr.join(""))).toMatchObject({
      error: {
        code: "conflict",
        message: "There are no reviewable changes to approve.",
      },
    });
  });

  it("binds reads and mutations to the discovered server process and workspace", async () => {
    const first = buildServer({ workspaceDir: repository });
    const secondRepository = await mkdtemp(
      join(tmpdir(), "redline-cli-other-"),
    );
    await execute("git", ["init"], { cwd: secondRepository });
    const second = buildServer({ workspaceDir: secondRepository });
    try {
      const discoveryResponse = await first.inject({
        method: "GET",
        url: "/api/cli/discovery",
      });
      const discovery: {
        workspaceRoot: string;
        serverToken: string;
      } = discoveryResponse.json();
      const headers = {
        "x-redline-workspace": discovery.workspaceRoot,
        "x-redline-server-token": discovery.serverToken,
      };
      expect(
        (await first.inject({ method: "GET", url: "/api/cli/review", headers }))
          .statusCode,
      ).toBe(200);
      expect(
        (
          await second.inject({
            method: "GET",
            url: "/api/cli/review",
            headers,
          })
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await second.inject({
            method: "POST",
            url: "/api/cli/approve/workspace",
            headers: { ...headers, "content-type": "application/json" },
            payload: {},
          })
        ).statusCode,
      ).toBe(409);
    } finally {
      await first.close();
      await second.close();
      await rm(secondRepository, { recursive: true, force: true });
    }
  });

  it("serves CLI discovery without scanning the workspace", async () => {
    const app = buildServer({ workspaceDir: repository });
    try {
      await app.ready();
      const scan = vi.spyOn(ReviewWorkspace.prototype, "getWorkspace");
      const response = await app.inject({
        method: "GET",
        url: "/api/cli/discovery",
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ workspaceRoot: repository });
      expect(scan).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("persists a server-mode agent response for UI reads and Markdown export", async () => {
    const workspace = new ReviewWorkspace(repository);
    await workspace.initialize();
    const diff = await workspace.getDiff("example.ts");
    const comment = await workspace.addComment({
      path: "example.ts",
      expectedFingerprint: diff.fingerprint,
      anchors: [{ side: "new", startLine: 1, endLine: 1 }],
      body: "Confirm this change is complete.",
    });
    workspace.close();

    const responsePath = join(repository, "agent-response.md");
    await writeFile(
      responsePath,
      "Implemented and validated through the CLI.\n",
    );
    const server = buildServer({ workspaceDir: repository });
    await server.listen({ host: "127.0.0.1", port: 0 });
    const address = server.server.address() as AddressInfo;
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((value) => {
      output.push(String(value));
      return true;
    });
    try {
      expect(
        await run([
          "--mode",
          "server",
          "--workspace",
          repository,
          "--server-url",
          `http://127.0.0.1:${address.port}`,
          "agent",
          "respond",
          comment.id,
          "--decision",
          "accepted",
          "--input",
          responsePath,
        ]),
      ).toBe(0);
      expect(JSON.parse(output.join(""))).toMatchObject({
        ok: true,
        result: {
          comment: {
            id: comment.id,
            state: "accepted",
            replies: [
              {
                actor: "agent",
                body: "Implemented and validated through the CLI.",
              },
            ],
          },
        },
      });

      const persisted = new ReviewWorkspace(repository);
      await persisted.initialize();
      try {
        expect(await persisted.getThreadPacket(comment.id)).toMatchObject({
          comment: { state: "accepted", threadRevision: 1 },
        });
        expect(await persisted.getReviewMarkdown()).toContain(
          "Implemented and validated through the CLI.",
        );
      } finally {
        persisted.close();
      }
    } finally {
      await server.close();
    }
  });
});
