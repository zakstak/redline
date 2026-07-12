#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { ReviewWorkspace } from "../server/review-workspace.js";
import type {
  ReviewAnchor,
  ReviewThreadPacket,
} from "../shared/review-contract.js";

const exec = promisify(execFile);
const VERSION = "0.1.0";
const HELP = `Redline ${VERSION}

Usage: redline [--mode auto|server|direct] [--workspace PATH] [--server-url URL] COMMAND

Commands:
  review
  diff PATH
  comments add --input FILE|-
  comments export [--format json|markdown]
  approve files --input FILE|-
  approve workspace
  agent review COMMENT_ID
  agent review-all
  agent respond COMMENT_ID --decision accepted|rejected|deferred --input FILE|-
  agent reopen COMMENT_ID

Exit codes: 0 success, 2 invocation/configuration, 3 workspace, 4 server,
5 stale/domain conflict, 6 persistence/internal failure.`;

type Mode = "auto" | "server" | "direct";
type Parsed = {
  mode: Mode;
  workspace?: string;
  serverUrl: string;
  command: string[];
  input?: string;
  format: "json" | "markdown";
  decision?: "accepted" | "rejected" | "deferred";
};

class CliError extends Error {
  constructor(
    readonly exitCode: number,
    message: string,
    readonly code = "error",
  ) {
    super(message);
  }
}

function parseArgs(args: string[]): Parsed {
  let mode: Mode = "auto";
  let workspace: string | undefined;
  let serverUrl = process.env.REDLINE_SERVER_URL ?? "http://127.0.0.1:4322";
  let input: string | undefined;
  let format: "json" | "markdown" = "json";
  let decision: Parsed["decision"];
  const command: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = () => {
      const value = args[++index];
      if (!value)
        throw new CliError(2, `${arg} requires a value.`, "invocation");
      return value;
    };
    if (arg === "--mode") {
      const value = next();
      if (value !== "auto" && value !== "server" && value !== "direct")
        throw new CliError(
          2,
          "Mode must be auto, server, or direct.",
          "invocation",
        );
      mode = value;
    } else if (arg === "--workspace") workspace = next();
    else if (arg === "--server-url") serverUrl = next();
    else if (arg === "--input") input = next();
    else if (arg === "--format") {
      const value = next();
      if (value !== "json" && value !== "markdown")
        throw new CliError(2, "Format must be json or markdown.", "invocation");
      format = value;
    } else if (arg === "--decision") {
      const value = next();
      if (value !== "accepted" && value !== "rejected" && value !== "deferred")
        throw new CliError(
          2,
          "Decision must be accepted, rejected, or deferred.",
          "invocation",
        );
      decision = value;
    } else if (arg.startsWith("-"))
      throw new CliError(2, `Unknown option: ${arg}`, "invocation");
    else command.push(arg);
  }
  return { mode, workspace, serverUrl, command, input, format, decision };
}

export function validateServerUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError(2, "Server URL is malformed.", "unsafe_url");
  }
  const hostname = url.hostname.startsWith("[")
    ? url.hostname.slice(1, -1)
    : url.hostname;
  const loopback =
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  if (
    url.protocol !== "http:" ||
    !loopback ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  )
    throw new CliError(
      2,
      "Server URL must be a credential-free loopback HTTP origin.",
      "unsafe_url",
    );
  return url;
}

async function workspaceRoot(path?: string) {
  try {
    const { stdout } = await exec("git", ["rev-parse", "--show-toplevel"], {
      cwd: resolve(path ?? process.cwd()),
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
      ),
    });
    return resolve(stdout.trim());
  } catch {
    throw new CliError(3, "Could not resolve a Git worktree.", "workspace");
  }
}

async function inputText(path?: string) {
  if (!path) throw new CliError(2, "--input is required.", "invocation");
  return path === "-"
    ? new Promise<string>((resolveInput, reject) => {
        let value = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => {
          value += String(chunk);
        });
        process.stdin.on("end", () => resolveInput(value));
        process.stdin.on("error", reject);
      })
    : readFile(path, "utf8");
}

async function inputJson(path?: string) {
  try {
    return JSON.parse(await inputText(path)) as unknown;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(2, "Input must contain valid JSON.", "invocation");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function commentInput(path?: string) {
  const value = await inputJson(path);
  if (
    !isRecord(value) ||
    typeof value.path !== "string" ||
    typeof value.fingerprint !== "string" ||
    typeof value.body !== "string" ||
    !value.body.trim() ||
    !Array.isArray(value.anchors)
  ) {
    throw new CliError(2, "Comment input has an invalid shape.", "invocation");
  }
  const anchors = value.anchors as unknown[];
  if (
    anchors.length === 0 ||
    anchors.some(
      (anchor) =>
        !isRecord(anchor) ||
        (anchor.side !== "old" && anchor.side !== "new") ||
        !Number.isSafeInteger(anchor.startLine) ||
        !Number.isSafeInteger(anchor.endLine) ||
        Number(anchor.startLine) < 1 ||
        Number(anchor.endLine) < Number(anchor.startLine),
    )
  ) {
    throw new CliError(2, "Comment anchors are invalid.", "invocation");
  }
  return {
    path: value.path,
    fingerprint: value.fingerprint,
    body: value.body,
    anchors: anchors as ReviewAnchor[],
  };
}

async function approvalInput(path?: string) {
  const value = await inputJson(path);
  if (
    !isRecord(value) ||
    !Array.isArray(value.files) ||
    value.files.length < 1 ||
    value.files.length > 5_000 ||
    value.files.some(
      (file) =>
        !isRecord(file) ||
        typeof file.path !== "string" ||
        typeof file.fingerprint !== "string",
    )
  ) {
    throw new CliError(2, "Approval input has an invalid shape.", "invocation");
  }
  return value as { files: Array<{ path: string; fingerprint: string }> };
}

type Discovery = { workspaceRoot: string; serverToken: string };

async function fetchComplete(url: URL, init: RequestInit, timeout: number) {
  return fetch(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(timeout),
  });
}

async function discover(origin: URL, root: string): Promise<Discovery> {
  const response = await fetchComplete(
    new URL("/api/cli/discovery", origin),
    {},
    2_000,
  );
  if (
    !response.ok ||
    !response.headers.get("content-type")?.includes("application/json")
  )
    throw new Error("invalid discovery response");
  const value = (await response.json()) as Partial<Discovery>;
  if (
    value.workspaceRoot !== root ||
    typeof value.serverToken !== "string" ||
    !value.serverToken
  )
    throw new Error("workspace identity mismatch");
  return value as Discovery;
}

async function serverRequest(
  origin: URL,
  discovery: Discovery,
  path: string,
  init: RequestInit = {},
  allowText = false,
) {
  let response: Response;
  let text: string;
  try {
    response = await fetchComplete(
      new URL(path, origin),
      {
        ...init,
        headers: {
          "content-type": "application/json",
          "x-redline-workspace": discovery.workspaceRoot,
          "x-redline-server-token": discovery.serverToken,
          ...init.headers,
        },
      },
      30_000,
    );
    text = await response.text();
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(
      4,
      error instanceof Error ? error.message : "Server request failed.",
      "server",
    );
  }
  let payload: unknown = text;
  const jsonResponse = response.headers
    .get("content-type")
    ?.includes("application/json");
  if (jsonResponse) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new CliError(4, "Server returned malformed JSON.", "server");
    }
  } else if (!allowText) {
    throw new CliError(
      4,
      "Server returned an unexpected content type.",
      "server",
    );
  }
  if (!response.ok) {
    const stableCode =
      typeof payload === "object" && payload !== null && "code" in payload
        ? String(payload.code)
        : "";
    const workspaceMismatch =
      typeof payload === "object" &&
      payload !== null &&
      "code" in payload &&
      payload.code === "workspace_mismatch";
    const domainConflict =
      !workspaceMismatch &&
      (response.status === 409 ||
        stableCode === "not_found" ||
        stableCode === "invalid_input" ||
        stableCode === "invalid_state" ||
        response.status === 400);
    throw new CliError(
      domainConflict ? 5 : 4,
      typeof payload === "object" && payload && "message" in payload
        ? String(payload.message)
        : `Server failed with ${response.status}.`,
      domainConflict ? "conflict" : "server",
    );
  }
  return payload;
}

async function executeServer(
  parsed: Parsed,
  origin: URL,
  discovery: Discovery,
) {
  const [group, action, subject] = parsed.command;
  if (group === "review" && !action)
    return serverRequest(origin, discovery, "/api/cli/review");
  if (group === "diff" && action && !subject)
    return serverRequest(
      origin,
      discovery,
      `/api/cli/diff?path=${encodeURIComponent(action)}`,
    );
  if (
    group === "comments" &&
    action === "export" &&
    parsed.command.length === 2
  )
    return serverRequest(
      origin,
      discovery,
      `/api/cli/comments/export?format=${parsed.format}`,
      {},
      parsed.format === "markdown",
    );
  if (group === "comments" && action === "add" && parsed.command.length === 2)
    return serverRequest(origin, discovery, "/api/cli/comments", {
      method: "POST",
      body: JSON.stringify(await commentInput(parsed.input)),
    });
  if (group === "approve" && action === "files" && parsed.command.length === 2)
    return serverRequest(origin, discovery, "/api/cli/approve/files", {
      method: "POST",
      body: JSON.stringify(await approvalInput(parsed.input)),
    });
  if (
    group === "approve" &&
    action === "workspace" &&
    parsed.command.length === 2
  )
    return serverRequest(origin, discovery, "/api/cli/approve/workspace", {
      method: "POST",
      body: "{}",
    });
  if (
    group === "agent" &&
    action === "review" &&
    subject &&
    parsed.command.length === 3
  )
    return serverRequest(
      origin,
      discovery,
      `/api/cli/agent/review/${encodeURIComponent(subject)}`,
    );
  if (
    group === "agent" &&
    action === "review-all" &&
    parsed.command.length === 2
  )
    return serverRequest(origin, discovery, "/api/cli/agent/review-all");
  if (
    group === "agent" &&
    action === "respond" &&
    subject &&
    parsed.command.length === 3
  ) {
    if (!parsed.decision)
      throw new CliError(2, "--decision is required.", "invocation");
    const packet = (await serverRequest(
      origin,
      discovery,
      `/api/cli/agent/review/${encodeURIComponent(subject)}`,
    )) as ReviewThreadPacket;
    const body = (await inputText(parsed.input)).trim();
    if (!body || body.length > 4_000)
      throw new CliError(
        2,
        "Agent replies must contain 1 to 4,000 characters.",
        "invocation",
      );
    return serverRequest(
      origin,
      discovery,
      `/api/cli/agent/respond/${encodeURIComponent(subject)}`,
      {
        method: "POST",
        body: JSON.stringify({
          expectedState: packet.comment.state,
          expectedRootVersion: packet.comment.rootVersion,
          expectedThreadRevision: packet.comment.threadRevision,
          requestId: randomUUID(),
          decision: parsed.decision,
          body,
          ...(parsed.decision === "accepted"
            ? { acceptedContext: packet.acceptedContext }
            : {}),
        }),
      },
    );
  }
  if (
    group === "agent" &&
    action === "reopen" &&
    subject &&
    parsed.command.length === 3
  ) {
    const packet = (await serverRequest(
      origin,
      discovery,
      `/api/cli/agent/review/${encodeURIComponent(subject)}`,
    )) as ReviewThreadPacket;
    return serverRequest(
      origin,
      discovery,
      `/api/cli/agent/reopen/${encodeURIComponent(subject)}`,
      {
        method: "POST",
        body: JSON.stringify({
          expectedState: packet.comment.state,
          expectedRootVersion: packet.comment.rootVersion,
          expectedThreadRevision: packet.comment.threadRevision,
          requestId: randomUUID(),
        }),
      },
    );
  }
  throw new CliError(2, "Unknown or incomplete command.", "invocation");
}

async function executeDirect(parsed: Parsed, root: string) {
  if (parsed.command[0] === "agent")
    throw new CliError(
      2,
      "Agent thread commands require server mode.",
      "invocation",
    );
  const workspace = new ReviewWorkspace(root);
  await workspace.initialize();
  try {
    const [group, action, subject] = parsed.command;
    if (group === "review" && !action) return await workspace.getReviewData();
    if (group === "diff" && action && !subject)
      return await workspace.getDiff(action);
    if (
      group === "comments" &&
      action === "export" &&
      parsed.command.length === 2
    )
      return parsed.format === "markdown"
        ? await workspace.getReviewMarkdown()
        : await workspace.getCommentExport();
    if (
      group === "comments" &&
      action === "add" &&
      parsed.command.length === 2
    ) {
      const body = await commentInput(parsed.input);
      return await workspace.addComment({
        path: body.path,
        expectedFingerprint: body.fingerprint,
        anchors: body.anchors,
        body: body.body,
      });
    }
    if (
      group === "approve" &&
      action === "files" &&
      parsed.command.length === 2
    ) {
      const body = await approvalInput(parsed.input);
      return await workspace.approveFiles(body.files);
    }
    if (
      group === "approve" &&
      action === "workspace" &&
      parsed.command.length === 2
    )
      return await workspace.approveSnapshot();
    throw new CliError(2, "Unknown or incomplete command.", "invocation");
  } finally {
    workspace.close();
  }
}

export async function run(args = process.argv.slice(2)) {
  if (args.includes("--help") || args[0] === "help" || args.length === 0) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (args.includes("--version") || args[0] === "version") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  try {
    const parsed = parseArgs(args);
    if (
      parsed.format === "markdown" &&
      !(parsed.command[0] === "comments" && parsed.command[1] === "export")
    ) {
      throw new CliError(
        2,
        "Markdown is supported only by comments export.",
        "invocation",
      );
    }
    const root = await workspaceRoot(parsed.workspace);
    if (parsed.mode === "direct") {
      const result = await executeDirect(parsed, root);
      process.stdout.write(
        typeof result === "string"
          ? result
          : `${JSON.stringify({ ok: true, result })}\n`,
      );
      return 0;
    }
    const origin = validateServerUrl(parsed.serverUrl);
    let discovery: Discovery;
    try {
      discovery = await discover(origin, root);
    } catch (error) {
      if (parsed.mode === "server" || parsed.command[0] === "agent")
        throw new CliError(
          4,
          error instanceof Error ? error.message : "Server discovery failed.",
          "server",
        );
      const result = await executeDirect(parsed, root);
      process.stdout.write(
        typeof result === "string"
          ? result
          : `${JSON.stringify({ ok: true, result })}\n`,
      );
      return 0;
    }
    const result = await executeServer(parsed, origin, discovery);
    process.stdout.write(
      typeof result === "string"
        ? result
        : `${JSON.stringify({ ok: true, result })}\n`,
    );
    return 0;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected failure.";
    const domainConflict =
      /changed|stale|deferred|invalid_(?:input|state)|idempotency_conflict|not_found|no reviewable changes/i.test(
        message,
      );
    const failure =
      error instanceof CliError
        ? error
        : new CliError(
            domainConflict ? 5 : 6,
            message,
            domainConflict ? "conflict" : "internal",
          );
    process.stderr.write(
      `${JSON.stringify({ ok: false, error: { code: failure.code, message: failure.message } })}\n`,
    );
    return failure.exitCode;
  }
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
)
  process.exitCode = await run();
