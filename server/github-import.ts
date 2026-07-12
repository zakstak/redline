import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type {
  DiffResponse,
  GitHubImportStatus,
  ReviewAnchor,
  ReviewAuthor,
  ReviewComment,
  ReviewReply,
} from "../shared/review-contract.js";

const MAX_SNAPSHOTS = 8;
const MAX_PR_BYTES = 25 * 1024 * 1024;
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_RETRIEVAL_CALLS = 1_000;
const MAX_RETRIEVAL_BYTES = 64 * 1024 * 1024;
const MAX_SOURCE_CALLS = 500;
const MAX_SOURCE_RAW_BYTES = 20 * 1024 * 1024;
const STALE_IMPORT_TEMP_AGE_MS = 60 * 60_000;

export interface GitHubIdentity {
  owner: string;
  name: string;
  normalized: string;
}

interface PullRequestIdentity {
  base: GitHubIdentity;
  head: GitHubIdentity;
  number: number;
  title: string;
  headRefName: string;
  headSha: string;
  baseSha: string;
}

interface StoredCoordinate {
  side: "old" | "new";
  startLine: number;
  endLine: number;
}

export interface GitHubAuthorInput {
  login: string | null;
  name: string | null;
  avatarUrl: string | null;
}

interface StoredGitHubComment {
  id: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  url: string;
  author: GitHubAuthorInput;
}

interface StoredGitHubThread {
  id: string;
  path: string;
  resolved: boolean;
  outdated: boolean;
  coordinate: StoredCoordinate | null;
  alternateCoordinate: StoredCoordinate | null;
  sourceCommit: string | null;
  sourceContentId: string | null;
  sourceFailure?: string;
  comments: StoredGitHubComment[];
}

interface StoredSnapshot {
  repository: string;
  pullRequest: number;
  title: string;
  headRepository: string;
  headRefName: string;
  headSha: string;
  baseSha: string;
  activatedAt: string;
  synchronizedAt: string;
  threads: StoredGitHubThread[];
  sourceIds: string[];
}

interface StoredImports {
  version: 1;
  snapshots: StoredSnapshot[];
  sources: Record<string, string>;
}

interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type CommandExecutor = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    timeoutMs: number;
    stdoutLimit: number;
    stderrLimit: number;
    signal?: AbortSignal;
  },
) => Promise<CommandResult>;

function commandEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
}

const executeCommand: CommandExecutor = (
  command,
  args,
  { cwd, timeoutMs, stdoutLimit, stderrLimit, signal },
) =>
  new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: commandEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finish = (error?: Error, result?: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolveResult(result as CommandResult);
    };
    const abort = () => {
      child.kill("SIGKILL");
      finish(new Error(signal?.aborted ? "cancelled" : "command_timeout"));
    };
    const timer = setTimeout(abort, timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > stdoutLimit) {
        child.kill("SIGKILL");
        finish(new Error("stdout_limit"));
        return;
      }
      stdout += stdoutDecoder.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > stderrLimit) {
        child.kill("SIGKILL");
        finish(new Error("stderr_limit"));
        return;
      }
      stderr += stderrDecoder.write(chunk);
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code) =>
      finish(undefined, {
        stdout: stdout + stdoutDecoder.end(),
        stderr: stderr + stderrDecoder.end(),
        code: code ?? 1,
      }),
    );
  });

export function parseGitHubRemote(value: string): GitHubIdentity | null {
  const trimmed = value.trim();
  let owner = "";
  let name = "";
  const scp = trimmed.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (scp) {
    owner = scp[1] ?? "";
    name = scp[2] ?? "";
  } else {
    try {
      const url = new URL(trimmed);
      if (
        url.hostname.toLowerCase() !== "github.com" ||
        (url.username &&
          !(url.protocol === "ssh:" && url.username === "git")) ||
        url.password ||
        url.port ||
        url.search ||
        url.hash ||
        !["https:", "ssh:", "git:"].includes(url.protocol)
      )
        return null;
      const parts = url.pathname.replace(/^\//, "").split("/");
      if (parts.length !== 2) return null;
      owner = parts[0] ?? "";
      name = (parts[1] ?? "").replace(/\.git$/i, "");
    } catch {
      return null;
    }
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(name))
    return null;
  return { owner, name, normalized: `${owner}/${name}`.toLowerCase() };
}

export function normalizeGitHubAuthor(author: GitHubAuthorInput): ReviewAuthor {
  const name = author.name?.trim();
  const login = author.login?.trim() || null;
  const label = name || login || "Deleted GitHub user";
  const wordGraphemes = label.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu);
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const firstGrapheme = (value: string) =>
    [...segmenter.segment(value)][0]?.segment ?? "";
  const initials = name
    ? (wordGraphemes ?? [])
        .slice(0, 2)
        .map(firstGrapheme)
        .join("")
        .toLocaleUpperCase()
    : login
      ? [...segmenter.segment(login)]
          .slice(0, 2)
          .map((item) => item.segment)
          .join("")
          .toLocaleUpperCase()
      : "GH";
  return {
    login,
    name: label,
    avatarUrl: safeAvatarUrl(author.avatarUrl),
    initials: initials || "GH",
  };
}

export function safeGitHubLink(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.hostname.toLowerCase() !== "github.com" ||
      url.username ||
      url.password ||
      url.port
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

function safeMarkdownDestination(value: string) {
  if (/\p{Cc}/u.test(value)) return false;
  if (value.startsWith("#")) return true;
  try {
    decodeURIComponent(value);
    const url = new URL(value);
    return (
      url.protocol === "mailto:" ||
      ((url.protocol === "https:" || url.protocol === "http:") &&
        !url.username &&
        !url.password)
    );
  } catch {
    return false;
  }
}

export function sanitizeGitHubMarkdown(value: string) {
  let fenced = false;
  return value
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced;
        return line;
      }
      if (fenced) return line;
      const reference = line.match(/^\s{0,3}\[([^\]]+)\]:\s*(\S+)(.*)$/);
      if (reference) {
        const [, label = "", destination = "", suffix = ""] = reference;
        return safeMarkdownDestination(destination)
          ? `[${label}]: ${destination}${suffix}`
          : "";
      }
      return line
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(
          /<(?!https?:\/\/|mailto:|[^ <>@]+@[^ <>@]+\.[^ <>@]+>)[^>]*>/g,
          "",
        )
        .replace(
          /\[([^\]]+)\]\(([^)]+)\)/g,
          (_match, label: string, url: string) =>
            safeMarkdownDestination(url.trim())
              ? `[${label}](${url.trim()})`
              : label,
        );
    })
    .join("\n");
}

function boundThreadLink(value: string, identity: PullRequestIdentity) {
  const safe = safeGitHubLink(value);
  if (safe) {
    const url = new URL(safe);
    const expected = `/${identity.base.normalized}/pull/${identity.number}`;
    const pathname = url.pathname.toLowerCase();
    if (pathname === expected || pathname.startsWith(`${expected}/`))
      return safe;
  }
  return `https://github.com/${identity.base.normalized}/pull/${identity.number}`;
}

function safeAvatarUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname.toLowerCase() === "avatars.githubusercontent.com" &&
      !url.username &&
      !url.password &&
      !url.port
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function normalizeLines(value: string) {
  const normalized = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const finalSeparator = normalized.endsWith("\n");
  const lines = normalized.split("\n");
  if (finalSeparator) lines.pop();
  return { lines, finalSeparator };
}

export function mapGitHubAnchor(
  coordinate: StoredCoordinate,
  source: string,
  displayed: string,
  diff: DiffResponse,
): { anchor: ReviewAnchor | null; reason?: string } {
  const sourceText = normalizeLines(source);
  const displayedText = normalizeLines(displayed);
  const start = coordinate.startLine - 1;
  const end = coordinate.endLine;
  if (start < 0 || end <= start || end > sourceText.lines.length)
    return { anchor: null, reason: "invalid_bounds" };
  if (
    sourceText.finalSeparator === displayedText.finalSeparator &&
    sourceText.lines.length === displayedText.lines.length &&
    sourceText.lines.every((line, index) => line === displayedText.lines[index])
  ) {
    const anchor = {
      side: coordinate.side,
      startLine: coordinate.startLine,
      endLine: coordinate.endLine,
    } satisfies ReviewAnchor;
    const exists = diff.lines.some((line) =>
      line.anchors.some(
        (lineAnchor) =>
          lineAnchor.side === anchor.side &&
          lineAnchor.startLine >= anchor.startLine &&
          lineAnchor.endLine <= anchor.endLine,
      ),
    );
    return exists ? { anchor } : { anchor: null, reason: "not_in_diff" };
  }
  const range = sourceText.lines.slice(start, end);
  const hasBefore = start > 0;
  const hasAfter = end < sourceText.lines.length;
  if (!hasBefore && !hasAfter)
    return { anchor: null, reason: "insufficient_context" };
  const haystack = displayedText.lines;
  let matches: number[] = [];
  for (let index = 0; index + range.length <= haystack.length; index += 1) {
    if (range.every((line, offset) => haystack[index + offset] === line))
      matches.push(index);
  }
  let usedBefore = 0;
  let usedAfter = 0;
  let contextCompared = false;
  for (let distance = 1; distance <= 3 && matches.length > 0; distance += 1) {
    if (start - distance >= 0) {
      const expected = sourceText.lines[start - distance];
      matches = matches.filter(
        (index) =>
          index - distance >= 0 && haystack[index - distance] === expected,
      );
      usedBefore = distance;
      contextCompared = true;
    }
    if (end + distance - 1 < sourceText.lines.length) {
      const expected = sourceText.lines[end + distance - 1];
      matches = matches.filter(
        (index) => haystack[index + range.length + distance - 1] === expected,
      );
      usedAfter = distance;
      contextCompared = true;
    }
    if (matches.length === 1 && contextCompared) break;
  }
  if (matches.length !== 1)
    return {
      anchor: null,
      reason: matches.length === 0 ? "context_not_found" : "ambiguous_context",
    };
  const match = matches[0] ?? 0;
  if (start - usedBefore === 0 && match - usedBefore !== 0)
    return { anchor: null, reason: "boundary_mismatch" };
  if (end + usedAfter === sourceText.lines.length) {
    if (match + range.length + usedAfter !== displayedText.lines.length)
      return { anchor: null, reason: "boundary_mismatch" };
    if (sourceText.finalSeparator !== displayedText.finalSeparator)
      return { anchor: null, reason: "final_separator_mismatch" };
  }
  const mappedStart = match + 1;
  const mapped = {
    side: coordinate.side,
    startLine: mappedStart,
    endLine: mappedStart + range.length - 1,
  } satisfies ReviewAnchor;
  const exists = diff.lines.some((line) =>
    line.anchors.some(
      (anchor) =>
        anchor.side === mapped.side &&
        anchor.startLine >= mapped.startLine &&
        anchor.endLine <= mapped.endLine,
    ),
  );
  return exists ? { anchor: mapped } : { anchor: null, reason: "not_in_diff" };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function snapshotCoreBytes(snapshot: StoredSnapshot) {
  return Buffer.byteLength(canonicalJson(snapshot), "utf8");
}

function sourceBytes(ids: Iterable<string>, sources: Record<string, string>) {
  return [...new Set(ids)].reduce(
    (total, id) => total + Buffer.byteLength(sources[id] ?? ""),
    0,
  );
}

function validateStore(value: unknown): StoredImports {
  if (!value || typeof value !== "object")
    return { version: 1, snapshots: [], sources: {} };
  const candidate = value as Partial<StoredImports>;
  if (
    candidate.version !== 1 ||
    !Array.isArray(candidate.snapshots) ||
    !candidate.sources ||
    typeof candidate.sources !== "object" ||
    Array.isArray(candidate.sources)
  )
    throw new Error("GitHub import state is malformed.");
  const verifiedSources = Object.fromEntries(
    Object.entries(candidate.sources).filter(
      ([id, content]) =>
        typeof content === "string" &&
        createHash("sha256").update(content).digest("hex") === id,
    ),
  );
  const snapshots = candidate.snapshots.flatMap((snapshot) => {
    if (
      !snapshot ||
      typeof snapshot !== "object" ||
      typeof snapshot.repository !== "string" ||
      !Number.isSafeInteger(snapshot.pullRequest) ||
      typeof snapshot.activatedAt !== "string" ||
      typeof snapshot.synchronizedAt !== "string" ||
      !Array.isArray(snapshot.threads) ||
      !Array.isArray(snapshot.sourceIds) ||
      snapshot.sourceIds.some(
        (id) => typeof id !== "string" || !Object.hasOwn(verifiedSources, id),
      )
    )
      return [];
    const threads = snapshot.threads.filter(
      (thread) =>
        thread &&
        typeof thread.id === "string" &&
        typeof thread.path === "string" &&
        Array.isArray(thread.comments) &&
        thread.comments.length > 0 &&
        thread.comments.every(
          (comment) =>
            comment &&
            typeof comment.id === "string" &&
            typeof comment.body === "string" &&
            typeof comment.createdAt === "string" &&
            typeof comment.url === "string",
        ) &&
        (thread.sourceContentId === null ||
          snapshot.sourceIds.includes(thread.sourceContentId)),
    );
    if (threads.length !== snapshot.threads.length) return [];
    return [
      {
        ...snapshot,
        threads,
        sourceIds: [...new Set(snapshot.sourceIds)].sort(),
      },
    ];
  });
  const referenced = new Set(
    snapshots.flatMap((snapshot) => snapshot.sourceIds),
  );
  return {
    version: 1,
    snapshots,
    sources: Object.fromEntries(
      Object.entries(verifiedSources).filter(([id]) => referenced.has(id)),
    ),
  };
}

function coordinateFromNode(node: Record<string, unknown>) {
  const pair = (prefix: "" | "original") => {
    const line = node[prefix ? "originalLine" : "line"];
    const startLine = node[prefix ? "originalStartLine" : "startLine"] ?? line;
    const side = node.diffSide;
    const startSide = node.startDiffSide ?? side;
    if (
      !Number.isSafeInteger(line) ||
      !Number.isSafeInteger(startLine) ||
      Number(startLine) < 1 ||
      Number(line) < Number(startLine) ||
      (side !== "LEFT" && side !== "RIGHT") ||
      startSide !== side
    )
      return null;
    return {
      side: side === "LEFT" ? ("old" as const) : ("new" as const),
      startLine: Number(startLine),
      endLine: Number(line),
    };
  };
  const current = pair("");
  const original = pair("original");
  const preferred = node.isOutdated ? original : current;
  const alternate = node.isOutdated ? current : original;
  return { coordinate: preferred ?? alternate, alternate };
}

function sanitizeMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/auth|401|403|login/i.test(message))
    return "GitHub authentication failed.";
  if (/cancel/i.test(message)) return "GitHub import was cancelled.";
  if (/rate.?limit/i.test(message))
    return "GitHub rate limit reached; retry later.";
  return "GitHub review threads could not be refreshed; retained data was preserved.";
}

export class GitHubImportManager {
  private activeIdentity: string | null = null;
  private activationTime: string | null = null;
  private status: GitHubImportStatus = {
    version: 1,
    state: "unavailable",
    retained: false,
    stale: false,
    message: "GitHub pull request discovery has not run.",
  };
  private refreshOperation: {
    controller: AbortController;
    promise: Promise<GitHubImportStatus>;
    waiters: Set<symbol>;
  } | null = null;
  private discoveryPromise: Promise<GitHubImportStatus> | null = null;
  private discoveryGitState: string | null = null;
  private readIdentityVerified = false;
  private verifiedGitState: string | null = null;
  private storeMutation = Promise.resolve();
  private retrievalCalls = 0;
  private retrievalBytes = 0;
  private retrievalStderrBytes = 0;
  private retrievalStartedAt = 0;
  private sourceCalls = 0;
  private sourceBytes = 0;
  private sourceOutputBytes = 0;
  private sourceStderrBytes = 0;
  private avatarCache = new Map<
    string,
    { data: Buffer; contentType: string; expiresAt: number }
  >();
  private avatarRequests = new Map<
    string,
    Promise<{ data: Buffer; contentType: string }>
  >();
  private avatarActive = 0;
  private avatarWaiters: Array<() => void> = [];

  constructor(
    private root: string,
    private gitDir: string,
    private execute: CommandExecutor = executeCommand,
  ) {}

  private storePath() {
    return resolve(this.gitDir, "redline", "github-imports.json");
  }

  private async readStore(): Promise<StoredImports> {
    const directory = dirname(this.storePath());
    try {
      const entries = await readdir(directory);
      await Promise.all(
        entries
          .filter(
            (entry) =>
              entry.startsWith("github-imports.json.") &&
              entry.endsWith(".tmp"),
          )
          .map(async (entry) => {
            const temporary = resolve(directory, entry);
            try {
              const metadata = await stat(temporary);
              if (Date.now() - metadata.mtimeMs > STALE_IMPORT_TEMP_AGE_MS)
                await rm(temporary, { force: true });
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                throw error;
            }
          }),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      return validateStore(
        JSON.parse(await readFile(this.storePath(), "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { version: 1, snapshots: [], sources: {} };
      throw error;
    }
  }

  private async writeStore(store: StoredImports) {
    const destination = this.storePath();
    const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    try {
      await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, {
        mode: 0o600,
      });
      await rename(temporary, destination);
      await chmod(destination, 0o600);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async mutateStore(
    mutation: (store: StoredImports) => StoredImports | Promise<StoredImports>,
  ) {
    const operation = this.storeMutation.then(async () => {
      const store = await this.readStore();
      const next = await mutation(store);
      await this.writeStore(next);
      return next;
    });
    this.storeMutation = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async gitState() {
    const [head, branch, remotes] = await Promise.all([
      this.git(["rev-parse", "--verify", "HEAD"]).catch(() => "unborn"),
      this.git(["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(
        () => "detached",
      ),
      this.git([
        "config",
        "--null",
        "--get-regexp",
        "^(remote\\..*\\.(url|pushurl)|branch\\..*\\.(remote|pushRemote)|remote\\.pushDefault)$",
      ]).catch(() => ""),
    ]);
    return `${branch}\0${head}\0${remotes}`;
  }

  private async ensureReadIdentity() {
    const state = await this.gitState();
    if (!this.readIdentityVerified || this.verifiedGitState !== state) {
      await this.verifyForRead();
      this.verifiedGitState = state;
    }
  }

  private async command(
    command: string,
    args: string[],
    gh = false,
    signal?: AbortSignal,
  ) {
    if (gh) {
      this.retrievalCalls += 1;
      if (
        this.retrievalCalls > MAX_RETRIEVAL_CALLS ||
        Date.now() - this.retrievalStartedAt > 5 * 60_000
      )
        throw new Error("retrieval_budget_exhausted");
    }
    const result = await this.execute(command, args, {
      cwd: this.root,
      timeoutMs: gh ? 15_000 : 10_000,
      stdoutLimit: gh ? 8 * 1024 * 1024 : 2 * 1024 * 1024,
      stderrLimit: gh ? 256 * 1024 : 256 * 1024,
      signal,
    });
    if (gh) {
      this.retrievalBytes += Buffer.byteLength(result.stdout);
      this.retrievalStderrBytes += Buffer.byteLength(result.stderr);
      if (
        this.retrievalBytes > MAX_RETRIEVAL_BYTES ||
        this.retrievalStderrBytes > 1024 * 1024 ||
        Date.now() - this.retrievalStartedAt > 5 * 60_000
      )
        throw new Error("retrieval_budget_exhausted");
    }
    if (result.code !== 0)
      throw new Error(result.stderr.trim() || "command_failed");
    return result.stdout;
  }

  private async git(args: string[]) {
    return (await this.command("git", args)).trim();
  }

  private async configValues(key: string) {
    const result = await this.execute("git", ["config", "--get-all", key], {
      cwd: this.root,
      timeoutMs: 10_000,
      stdoutLimit: 64 * 1024,
      stderrLimit: 64 * 1024,
    });
    if (result.code === 1) return [];
    if (result.code !== 0) throw new Error("invalid_git_configuration");
    const values = result.stdout.split("\n");
    if (result.stdout.endsWith("\n")) values.pop();
    return values;
  }

  private async remoteIdentity(name: string, requireFetch = false) {
    const fetchUrls = await this.configValues(`remote.${name}.url`);
    const pushUrls = await this.configValues(`remote.${name}.pushurl`);
    if (requireFetch && fetchUrls.length === 0)
      throw new Error("missing_fetch_url");
    const values = fetchUrls;
    if (values.length === 0) return null;
    const identities = values.map(parseGitHubRemote);
    if (identities.some((identity) => !identity))
      throw new Error("invalid_remote");
    const unique = new Set(identities.map((identity) => identity?.normalized));
    if (unique.size !== 1) throw new Error("conflicting_remote");
    return {
      identity: identities[0] as GitHubIdentity,
      pushUrls,
      fetchUrls,
    };
  }

  private async resolveRepositories() {
    const remotes = (await this.git(["remote"])).split("\n").filter(Boolean);
    let base: GitHubIdentity | null = null;
    if (remotes.includes("upstream")) {
      base = (await this.remoteIdentity("upstream", true))?.identity ?? null;
    } else if (remotes.includes("origin")) {
      base = (await this.remoteIdentity("origin", true))?.identity ?? null;
    } else {
      const identities = await Promise.all(
        remotes.map(
          async (remote) => (await this.remoteIdentity(remote, true))?.identity,
        ),
      );
      if (identities.length === 0 || identities.some((value) => !value))
        throw new Error("missing_remote");
      if (new Set(identities.map((value) => value?.normalized)).size !== 1)
        throw new Error("ambiguous_base");
      base = identities[0] ?? null;
    }
    if (!base) throw new Error("missing_base");

    const branch = await this.git(["branch", "--show-current"]);
    if (!branch) return { base, head: null, branch: null };
    const keys = [
      `branch.${branch}.pushRemote`,
      "remote.pushDefault",
      `branch.${branch}.remote`,
    ];
    let selected: string | null = null;
    for (const key of keys) {
      const values = await this.configValues(key);
      if (values.length === 0) continue;
      if (
        values.length !== 1 ||
        values[0] === "." ||
        !remotes.includes(values[0] ?? "")
      )
        throw new Error("invalid_head_remote");
      selected = values[0] ?? null;
      break;
    }
    if (!selected) {
      const identities = await Promise.all(
        remotes.map(async (remote) => {
          const resolved = await this.remoteIdentity(remote, true);
          return resolved?.identity;
        }),
      );
      if (new Set(identities.map((value) => value?.normalized)).size !== 1)
        throw new Error("ambiguous_head");
      return { base, head: identities[0] ?? null, branch };
    }
    const remote = await this.remoteIdentity(selected, true);
    const headValues =
      remote && remote.pushUrls.length > 0
        ? remote.pushUrls
        : remote?.fetchUrls;
    const parsed = (headValues ?? []).map(parseGitHubRemote);
    if (parsed.length === 0 || parsed.some((value) => !value))
      throw new Error("invalid_head_remote");
    if (new Set(parsed.map((value) => value?.normalized)).size !== 1)
      throw new Error("conflicting_head_remote");
    return { base, head: parsed[0] as GitHubIdentity, branch };
  }

  private async ghJson(args: string[], signal?: AbortSignal) {
    const output = await this.command(
      "gh",
      ["api", "--hostname", "github.com", ...args],
      true,
      signal,
    );
    try {
      const parsed = JSON.parse(output) as unknown;
      if (
        parsed &&
        typeof parsed === "object" &&
        Array.isArray((parsed as { errors?: unknown }).errors) &&
        ((parsed as { errors: unknown[] }).errors.length ?? 0) > 0
      )
        throw new Error("github_graphql_error");
      return parsed;
    } catch {
      throw new Error("malformed_github_response");
    }
  }

  private async sourceGhJson(args: string[], signal?: AbortSignal) {
    const result = await this.execute(
      "gh",
      ["api", "--hostname", "github.com", ...args],
      {
        cwd: this.root,
        timeoutMs: 10_000,
        stdoutLimit: 2 * 1024 * 1024,
        stderrLimit: 256 * 1024,
        signal,
      },
    );
    this.sourceOutputBytes += Buffer.byteLength(result.stdout);
    this.sourceStderrBytes += Buffer.byteLength(result.stderr);
    if (
      this.sourceOutputBytes > 32 * 1024 * 1024 ||
      this.sourceStderrBytes > 1024 * 1024
    )
      throw new Error("source_output_exhausted");
    if (result.code !== 0)
      throw new Error(result.stderr.trim() || "source_command_failed");
    try {
      return JSON.parse(result.stdout) as unknown;
    } catch {
      throw new Error("malformed_source_response");
    }
  }

  private async discoverIdentity(): Promise<PullRequestIdentity | null> {
    this.retrievalCalls = 0;
    this.retrievalBytes = 0;
    this.retrievalStderrBytes = 0;
    this.retrievalStartedAt = Date.now();
    const { base, head, branch } = await this.resolveRepositories();
    const headSha = await this.git(["rev-parse", "HEAD"]);
    const pulls: unknown[] = [];
    let pullPagesComplete = false;
    for (let page = 1; page <= 1_000; page += 1) {
      const response = await this.ghJson([
        `repos/${base.owner}/${base.name}/pulls?state=open&per_page=100&page=${page}`,
      ]);
      if (!Array.isArray(response)) throw new Error("malformed_pull_response");
      pulls.push(...(response as unknown[]));
      if (response.length < 100) {
        pullPagesComplete = true;
        break;
      }
    }
    if (!pullPagesComplete) throw new Error("incomplete_pull_pagination");
    const matches: PullRequestIdentity[] = [];
    for (const pull of pulls) {
      if (!pull || typeof pull !== "object") continue;
      const item = pull as Record<string, unknown>;
      const baseData = item.base as Record<string, unknown> | undefined;
      const headData = item.head as Record<string, unknown> | undefined;
      const baseRepo = baseData?.repo as Record<string, unknown> | undefined;
      const headRepo = headData?.repo as Record<string, unknown> | undefined;
      const number = item.number;
      const candidateHeadSha = headData?.sha;
      const baseSha = baseData?.sha;
      if (
        typeof number !== "number" ||
        !Number.isSafeInteger(number) ||
        number < 1 ||
        typeof candidateHeadSha !== "string" ||
        !/^[0-9a-f]{40}$/i.test(candidateHeadSha) ||
        typeof baseSha !== "string" ||
        !/^[0-9a-f]{40}$/i.test(baseSha) ||
        typeof baseRepo?.full_name !== "string" ||
        baseRepo.full_name.toLowerCase() !== base.normalized ||
        typeof headRepo?.full_name !== "string" ||
        typeof headData?.ref !== "string"
      )
        continue;
      if (branch) {
        if (
          !head ||
          headRepo.full_name.toLowerCase() !== head.normalized ||
          headData.ref !== branch
        )
          continue;
        const forward = await this.execute(
          "git",
          ["merge-base", "--is-ancestor", headSha, candidateHeadSha],
          {
            cwd: this.root,
            timeoutMs: 10_000,
            stdoutLimit: 1_024,
            stderrLimit: 16_384,
          },
        );
        const reverse = await this.execute(
          "git",
          ["merge-base", "--is-ancestor", candidateHeadSha, headSha],
          {
            cwd: this.root,
            timeoutMs: 10_000,
            stdoutLimit: 1_024,
            stderrLimit: 16_384,
          },
        );
        if (forward.code !== 0 && reverse.code !== 0) continue;
      } else if (candidateHeadSha !== headSha) continue;
      matches.push({
        base,
        head: parseGitHubRemote(
          `https://github.com/${headRepo.full_name}`,
        ) as GitHubIdentity,
        number,
        title:
          typeof item.title === "string"
            ? item.title
            : `Pull request #${number}`,
        headRefName: headData.ref,
        headSha: candidateHeadSha,
        baseSha,
      });
    }
    if (matches.length > 1) throw new Error("ambiguous_pull_request");
    return matches[0] ?? null;
  }

  async discover(): Promise<GitHubImportStatus> {
    const state = await this.gitState();
    if (this.discoveryPromise) {
      if (this.discoveryGitState === state) return this.discoveryPromise;
      await this.discoveryPromise;
      return this.discover();
    }
    this.discoveryGitState = state;
    this.discoveryPromise = this.discoverOnce().finally(() => {
      this.discoveryPromise = null;
      this.discoveryGitState = null;
    });
    return this.discoveryPromise;
  }

  private async discoverOnce(): Promise<GitHubImportStatus> {
    try {
      const identity = await this.discoverIdentity();
      const store = await this.readStore();
      if (!identity) {
        this.activeIdentity = null;
        this.activationTime = null;
        this.status = {
          version: 1,
          state: "none",
          retained: false,
          stale: false,
          message:
            "No eligible open GitHub pull request matches this worktree.",
        };
        return this.status;
      }
      const key = `${identity.base.normalized}#${identity.number}`;
      this.activeIdentity = key;
      const activationTime = new Date().toISOString();
      this.activationTime = activationTime;
      const retained = store.snapshots.find(
        (snapshot) => `${snapshot.repository}#${snapshot.pullRequest}` === key,
      );
      if (retained) {
        await this.mutateStore((current) => {
          const latest = current.snapshots.find(
            (snapshot) =>
              `${snapshot.repository}#${snapshot.pullRequest}` === key,
          );
          if (latest) latest.activatedAt = activationTime;
          return current;
        });
      }
      this.status = {
        version: 1,
        state: "available",
        repository: identity.base.normalized,
        pullRequest: identity.number,
        title: identity.title,
        retained: Boolean(retained),
        stale: Boolean(retained),
        ...(retained ? { lastSuccessAt: retained.synchronizedAt } : {}),
        message: retained
          ? "Retained GitHub comments are available; refresh to synchronize."
          : "GitHub review comments are available to import.",
      };
      return this.status;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const state: GitHubImportStatus["state"] = /ENOENT|spawn gh/i.test(
        message,
      )
        ? "missing_gh"
        : /auth|401|403|login/i.test(message)
          ? "authentication_failed"
          : /ambiguous/i.test(message)
            ? "ambiguous"
            : "unavailable";
      this.activeIdentity = null;
      this.activationTime = null;
      this.readIdentityVerified = false;
      this.verifiedGitState = null;
      this.status = {
        version: 1,
        state,
        retained: false,
        stale: false,
        message:
          state === "missing_gh"
            ? "Install the GitHub CLI to import review comments."
            : state === "authentication_failed"
              ? "Authenticate the GitHub CLI before importing review comments."
              : state === "ambiguous"
                ? "More than one pull request matches this worktree."
                : "GitHub pull request identity could not be proven safely.",
      };
      return this.status;
    }
  }

  async verifyForRead(): Promise<GitHubImportStatus> {
    try {
      if ((await this.readStore()).snapshots.length === 0) {
        this.activeIdentity = null;
        return {
          version: 1,
          state: "none",
          retained: false,
          stale: false,
          message: "No retained GitHub comments exist for this repository.",
        };
      }
      const identity = await this.discoverIdentity();
      if (!identity) {
        this.activeIdentity = null;
        return {
          version: 1,
          state: "none",
          retained: false,
          stale: false,
          message:
            "No eligible open GitHub pull request matches this worktree.",
        };
      }
      const key = `${identity.base.normalized}#${identity.number}`;
      this.activeIdentity = key;
      const retained = (await this.readStore()).snapshots.find(
        (snapshot) => `${snapshot.repository}#${snapshot.pullRequest}` === key,
      );
      this.status = {
        version: 1,
        state: "available",
        repository: identity.base.normalized,
        pullRequest: identity.number,
        title: identity.title,
        retained: Boolean(retained),
        stale: Boolean(retained),
        ...(retained ? { lastSuccessAt: retained.synchronizedAt } : {}),
        message: retained
          ? "Retained GitHub comments are available; refresh to synchronize."
          : "GitHub review comments are available to import.",
      };
      return this.status;
    } catch {
      this.activeIdentity = null;
      return {
        version: 1,
        state: "unavailable",
        retained: false,
        stale: false,
        message: "GitHub pull request identity could not be proven safely.",
      };
    } finally {
      this.readIdentityVerified = true;
      this.verifiedGitState = await this.gitState().catch(() => null);
    }
  }

  private async fetchThreads(
    identity: PullRequestIdentity,
    signal?: AbortSignal,
  ) {
    const query = `query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor}nodes{id isResolved isOutdated subjectType path line startLine diffSide startDiffSide originalLine originalStartLine comments(first:100){pageInfo{hasNextPage endCursor}nodes{id body createdAt updatedAt url state path line startLine originalLine originalStartLine outdated author{login avatarUrl ... on User{name}} commit{oid} originalCommit{oid}}}}}}}}`;
    const threads: StoredGitHubThread[] = [];
    let after: string | null = null;
    let complete = false;
    for (let page = 0; page < 1_000; page += 1) {
      const response = (await this.ghJson(
        [
          "graphql",
          "-f",
          `query=${query}`,
          "-F",
          `owner=${identity.base.owner}`,
          "-F",
          `name=${identity.base.name}`,
          "-F",
          `number=${identity.number}`,
          ...(after ? ["-F", `after=${after}`] : []),
        ],
        signal,
      )) as Record<string, unknown>;
      const data = response.data as Record<string, unknown> | undefined;
      const repository = data?.repository as
        | Record<string, unknown>
        | undefined;
      const pullRequest = repository?.pullRequest as
        | Record<string, unknown>
        | undefined;
      const connection = pullRequest?.reviewThreads as
        | Record<string, unknown>
        | undefined;
      const nodes = connection?.nodes;
      if (!Array.isArray(nodes)) throw new Error("malformed_thread_page");
      for (const raw of nodes) {
        if (!raw || typeof raw !== "object") continue;
        const node = raw as Record<string, unknown>;
        if (node.subjectType !== "LINE") continue;
        if (
          typeof node.id !== "string" ||
          !node.id ||
          typeof node.path !== "string" ||
          !node.path ||
          node.path.startsWith("/") ||
          node.path.split("/").some((part) => part === "..") ||
          /[\0\r\n]/.test(node.path)
        )
          continue;
        const commentsConnection = node.comments as
          | Record<string, unknown>
          | undefined;
        let comments: unknown[] = Array.isArray(commentsConnection?.nodes)
          ? [...(commentsConnection.nodes as unknown[])]
          : [];
        const pageInfo = commentsConnection?.pageInfo as
          | Record<string, unknown>
          | undefined;
        let commentAfter =
          pageInfo?.hasNextPage && typeof pageInfo.endCursor === "string"
            ? pageInfo.endCursor
            : null;
        while (commentAfter) {
          const nestedQuery = `query($id:ID!,$after:String!){node(id:$id){... on PullRequestReviewThread{comments(first:100,after:$after){pageInfo{hasNextPage endCursor}nodes{id body createdAt updatedAt url state path line startLine originalLine originalStartLine outdated author{login avatarUrl ... on User{name}} commit{oid} originalCommit{oid}}}}}}`;
          const nested = (await this.ghJson(
            [
              "graphql",
              "-f",
              `query=${nestedQuery}`,
              "-F",
              `id=${String(node.id)}`,
              "-F",
              `after=${commentAfter}`,
            ],
            signal,
          )) as Record<string, unknown>;
          const nestedNode = (
            nested.data as Record<string, unknown> | undefined
          )?.node as Record<string, unknown> | undefined;
          const nestedConnection = nestedNode?.comments as
            | Record<string, unknown>
            | undefined;
          if (!Array.isArray(nestedConnection?.nodes))
            throw new Error("incomplete_comment_pagination");
          comments = comments.concat(nestedConnection.nodes);
          const nestedPageInfo = nestedConnection.pageInfo as
            | Record<string, unknown>
            | undefined;
          commentAfter =
            nestedPageInfo?.hasNextPage &&
            typeof nestedPageInfo.endCursor === "string"
              ? nestedPageInfo.endCursor
              : null;
        }
        const rootCandidate = comments[0];
        if (
          !rootCandidate ||
          typeof rootCandidate !== "object" ||
          (rootCandidate as Record<string, unknown>).state !== "SUBMITTED"
        )
          continue;
        const published = comments.filter((comment) => {
          if (!comment || typeof comment !== "object") return false;
          const state = (comment as Record<string, unknown>).state;
          return state === "SUBMITTED";
        });
        if (published.length === 0) continue;
        let coordinates = coordinateFromNode(node);
        const normalizedComments = published.flatMap((comment) => {
          const item = comment as Record<string, unknown>;
          const author = item.author as
            | Record<string, unknown>
            | null
            | undefined;
          if (
            typeof item.id !== "string" ||
            !item.id ||
            typeof item.body !== "string" ||
            typeof item.createdAt !== "string" ||
            typeof item.url !== "string"
          )
            return [];
          return [
            {
              id: item.id,
              body: sanitizeGitHubMarkdown(item.body),
              createdAt: item.createdAt,
              updatedAt:
                typeof item.updatedAt === "string"
                  ? item.updatedAt
                  : item.createdAt,
              url: boundThreadLink(item.url, identity),
              author: {
                login: typeof author?.login === "string" ? author.login : null,
                name: typeof author?.name === "string" ? author.name : null,
                avatarUrl:
                  typeof author?.avatarUrl === "string"
                    ? author.avatarUrl
                    : null,
              },
            } satisfies StoredGitHubComment,
          ];
        });
        if (normalizedComments.length === 0) continue;
        const root = published[0] as Record<string, unknown>;
        if (!coordinates.coordinate) {
          coordinates = coordinateFromNode({
            ...root,
            diffSide: node.diffSide,
            startDiffSide: node.startDiffSide,
            isOutdated: root.outdated ?? node.isOutdated,
          });
        }
        if (!coordinates.coordinate) continue;
        const currentCommit = (
          root.commit as Record<string, unknown> | undefined
        )?.oid;
        const originalCommit = (
          root.originalCommit as Record<string, unknown> | undefined
        )?.oid;
        const commitCandidate =
          coordinates.coordinate.side === "old"
            ? identity.baseSha
            : node.isOutdated
              ? (originalCommit ?? currentCommit)
              : (currentCommit ?? originalCommit);
        const commit =
          typeof commitCandidate === "string" &&
          /^[0-9a-f]{40}$/i.test(commitCandidate)
            ? commitCandidate
            : null;
        if (!commit) continue;
        threads.push({
          id: String(node.id),
          path: node.path,
          resolved: node.isResolved === true,
          outdated: node.isOutdated === true,
          coordinate: coordinates.coordinate,
          alternateCoordinate: coordinates.alternate,
          sourceCommit: commit,
          sourceContentId: null,
          comments: normalizedComments,
        });
      }
      const pageInfoValue = connection?.pageInfo as
        | Record<string, unknown>
        | undefined;
      if (!pageInfoValue?.hasNextPage) {
        complete = true;
        break;
      }
      if (typeof pageInfoValue.endCursor !== "string")
        throw new Error("incomplete_thread_pagination");
      after = pageInfoValue.endCursor;
    }
    if (!complete) throw new Error("incomplete_thread_pagination");
    return threads;
  }

  private async acquireSources(
    identity: PullRequestIdentity,
    threads: StoredGitHubThread[],
    signal?: AbortSignal,
  ) {
    const sources: Record<string, string> = {};
    this.sourceCalls = 0;
    this.sourceBytes = 0;
    this.sourceOutputBytes = 0;
    this.sourceStderrBytes = 0;
    const sourceStartedAt = Date.now();
    const candidates = new Map<string, StoredGitHubThread[]>();
    for (const thread of threads) {
      if (!thread.sourceCommit) continue;
      const key = `${thread.coordinate?.side ?? "unknown"}\0${thread.sourceCommit}\0${thread.path}`;
      const existing = candidates.get(key) ?? [];
      existing.push(thread);
      candidates.set(key, existing);
    }
    const ordered = [...candidates.entries()].sort((left, right) => {
      const leftIds = left[1]
        .map((thread) => thread.id)
        .sort()
        .join("\0");
      const rightIds = right[1]
        .map((thread) => thread.id)
        .sort()
        .join("\0");
      return leftIds.localeCompare(rightIds) || left[0].localeCompare(right[0]);
    });
    let exhaustionReason: string | null = null;
    for (const [candidate, references] of ordered) {
      if (signal?.aborted) throw new Error("cancelled");
      if (
        this.sourceCalls >= MAX_SOURCE_CALLS ||
        Date.now() - sourceStartedAt > 2 * 60_000
      ) {
        exhaustionReason = "source_phase_exhausted";
        break;
      }
      this.sourceCalls += 1;
      const [, commit = "", path = ""] = candidate.split("\0", 3);
      let content: string | null = null;
      let invalidUtf8 = false;
      const local = await this.execute("git", ["show", `${commit}:${path}`], {
        cwd: this.root,
        timeoutMs: 10_000,
        stdoutLimit: 1024 * 1024,
        stderrLimit: 256 * 1024,
        signal,
      }).catch(() => ({ stdout: "", stderr: "", code: 1 }));
      if (signal?.aborted) throw new Error("cancelled");
      this.sourceOutputBytes += Buffer.byteLength(local.stdout);
      this.sourceStderrBytes += Buffer.byteLength(local.stderr);
      if (
        this.sourceOutputBytes > 32 * 1024 * 1024 ||
        this.sourceStderrBytes > 1024 * 1024
      ) {
        exhaustionReason = "source_output_exhausted";
        break;
      }
      if (local.code === 0 && !local.stdout.includes("\0"))
        content = local.stdout;
      if (content === null) {
        const preferred = references.some(
          (thread) => thread.coordinate?.side === "new",
        )
          ? [identity.head, identity.base]
          : [identity.base, identity.head];
        const repositories = [
          ...new Map(
            preferred.map((value) => [value.normalized, value]),
          ).values(),
        ];
        for (const sourceRepository of repositories) {
          if (this.sourceCalls >= MAX_SOURCE_CALLS) {
            exhaustionReason = "source_phase_exhausted";
            break;
          }
          this.sourceCalls += 1;
          try {
            const encoded = (await this.sourceGhJson(
              [
                `repos/${sourceRepository.owner}/${sourceRepository.name}/contents/${path
                  .split("/")
                  .map(encodeURIComponent)
                  .join("/")}?ref=${encodeURIComponent(commit)}`,
              ],
              signal,
            )) as Record<string, unknown>;
            if (
              encoded.encoding === "base64" &&
              typeof encoded.content === "string"
            ) {
              const base64 = encoded.content.replaceAll(/\s/g, "");
              if (
                base64.length % 4 !== 0 ||
                !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)
              )
                continue;
              const raw = Buffer.from(base64, "base64");
              if (!isUtf8(raw)) {
                invalidUtf8 = true;
                break;
              }
              content = raw.toString("utf8");
              break;
            }
          } catch (error) {
            if (signal?.aborted) throw new Error("cancelled");
            if (
              error instanceof Error &&
              error.message === "source_output_exhausted"
            ) {
              exhaustionReason = "source_output_exhausted";
              break;
            }
          }
        }
      }
      if (exhaustionReason) break;
      if (content === null || content.includes("\0") || invalidUtf8) {
        for (const thread of references)
          thread.sourceFailure =
            content === null
              ? invalidUtf8
                ? "invalid_utf8"
                : "source_unavailable"
              : content.includes("\0")
                ? "binary_source"
                : "source_unavailable";
        continue;
      }
      const bytes = Buffer.byteLength(content);
      const id = createHash("sha256").update(content).digest("hex");
      if (Object.hasOwn(sources, id)) {
        for (const thread of references) thread.sourceContentId = id;
        continue;
      }
      if (
        bytes > 1024 * 1024 ||
        this.sourceBytes + bytes > MAX_SOURCE_RAW_BYTES
      ) {
        for (const thread of references)
          thread.sourceFailure =
            bytes > 1024 * 1024 ? "source_too_large" : "source_bytes_exhausted";
        continue;
      }
      sources[id] = content;
      this.sourceBytes += bytes;
      for (const thread of references) thread.sourceContentId = id;
    }
    if (exhaustionReason) {
      for (const thread of threads) {
        if (!thread.sourceContentId && !thread.sourceFailure)
          thread.sourceFailure = exhaustionReason;
      }
    }
    return sources;
  }

  private admitSnapshot(
    store: StoredImports,
    incoming: StoredSnapshot,
    optionalSources: Record<string, string>,
  ) {
    if (snapshotCoreBytes(incoming) > MAX_PR_BYTES)
      throw new Error("github_snapshot_core_too_large");
    const key = `${incoming.repository}#${incoming.pullRequest}`;
    incoming.sourceIds = [];
    const sources = { ...store.sources };
    const snapshots = store.snapshots.filter(
      (snapshot) => `${snapshot.repository}#${snapshot.pullRequest}` !== key,
    );
    const sourceUsage = (values: StoredSnapshot[]) => {
      return sourceBytes(
        values.flatMap((snapshot) => snapshot.sourceIds),
        sources,
      );
    };
    const total = (values: StoredSnapshot[]) =>
      values.reduce((sum, snapshot) => sum + snapshotCoreBytes(snapshot), 0) +
      sourceUsage(values);
    snapshots.push(incoming);
    snapshots.sort(
      (left, right) =>
        left.activatedAt.localeCompare(right.activatedAt) ||
        left.repository.localeCompare(right.repository) ||
        left.pullRequest - right.pullRequest,
    );
    while (
      snapshots.length > MAX_SNAPSHOTS ||
      total(snapshots) > MAX_TOTAL_BYTES
    ) {
      const removable = snapshots.findIndex(
        (snapshot) =>
          `${snapshot.repository}#${snapshot.pullRequest}` !== key &&
          `${snapshot.repository}#${snapshot.pullRequest}` !==
            this.activeIdentity,
      );
      if (removable < 0) throw new Error("github_capacity_exhausted");
      snapshots.splice(removable, 1);
    }
    for (const [id, content] of Object.entries(optionalSources)) {
      sources[id] = content;
      incoming.sourceIds.push(id);
      incoming.sourceIds.sort();
      while (
        sourceUsage(snapshots) > MAX_SOURCE_BYTES ||
        total(snapshots) > MAX_TOTAL_BYTES
      ) {
        const removable = snapshots.findIndex(
          (snapshot) =>
            `${snapshot.repository}#${snapshot.pullRequest}` !== key &&
            `${snapshot.repository}#${snapshot.pullRequest}` !==
              this.activeIdentity,
        );
        if (removable < 0) break;
        snapshots.splice(removable, 1);
      }
      if (
        snapshotCoreBytes(incoming) + sourceBytes(incoming.sourceIds, sources) >
          MAX_PR_BYTES ||
        sourceUsage(snapshots) > MAX_SOURCE_BYTES ||
        total(snapshots) > MAX_TOTAL_BYTES
      ) {
        incoming.sourceIds = incoming.sourceIds.filter(
          (candidate) => candidate !== id,
        );
        for (const thread of incoming.threads) {
          if (thread.sourceContentId === id) {
            thread.sourceContentId = null;
            thread.sourceFailure = "source_capacity_omitted";
          }
        }
      }
    }
    const referenced = new Set(
      snapshots.flatMap((snapshot) => snapshot.sourceIds),
    );
    return {
      version: 1,
      snapshots,
      sources: Object.fromEntries(
        Object.entries(sources).filter(([id]) => referenced.has(id)),
      ),
    } satisfies StoredImports;
  }

  async refresh(signal?: AbortSignal): Promise<GitHubImportStatus> {
    let operation = this.refreshOperation;
    if (!operation) {
      const controller = new AbortController();
      const waiters = new Set<symbol>();
      operation = {
        controller,
        waiters,
        promise: Promise.resolve(this.status),
      };
      const activeOperation = operation;
      operation.promise = this.refreshOnce(controller.signal).finally(() => {
        if (this.refreshOperation === activeOperation)
          this.refreshOperation = null;
      });
      this.refreshOperation = operation;
    }

    const activeOperation = operation;
    const waiter = Symbol("github-refresh-waiter");
    activeOperation.waiters.add(waiter);
    return new Promise<GitHubImportStatus>((resolveWaiter, rejectWaiter) => {
      let settled = false;
      const cleanup = () => {
        signal?.removeEventListener("abort", onAbort);
        activeOperation.waiters.delete(waiter);
      };
      const complete = (status: GitHubImportStatus) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolveWaiter(status);
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        rejectWaiter(
          error instanceof Error ? error : new Error("GitHub import failed."),
        );
      };
      const onAbort = () => {
        if (settled) return;
        activeOperation.waiters.delete(waiter);
        if (activeOperation.waiters.size === 0) {
          activeOperation.controller.abort();
          return;
        }
        complete({
          ...this.status,
          state: this.status.retained ? "available" : "unavailable",
          stale: this.status.retained,
          message: "GitHub import wait was cancelled.",
        });
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      activeOperation.promise.then(complete, fail);
    });
  }

  private async refreshOnce(signal?: AbortSignal) {
    const priorStatus = this.status;
    let retainedOnFailure = priorStatus.retained;
    this.status = {
      ...priorStatus,
      state: "refreshing",
      message: "Importing GitHub review threads…",
    };
    try {
      if (signal?.aborted) throw new Error("cancelled");
      const identity = await this.discoverIdentity();
      if (!identity) throw new Error("no_pull_request");
      const proofTime = new Date().toISOString();
      const key = `${identity.base.normalized}#${identity.number}`;
      const transientActivation =
        this.activeIdentity === key ? this.activationTime : null;
      this.activeIdentity = key;
      const store = await this.readStore();
      const previous = store.snapshots.find(
        (snapshot) => `${snapshot.repository}#${snapshot.pullRequest}` === key,
      );
      retainedOnFailure = Boolean(previous);
      const threads = await this.fetchThreads(identity, signal);
      if (signal?.aborted) throw new Error("cancelled");
      const sources = await this.acquireSources(identity, threads, signal);
      if (signal?.aborted) throw new Error("cancelled");
      const now = new Date().toISOString();
      const snapshot: StoredSnapshot = {
        repository: identity.base.normalized,
        pullRequest: identity.number,
        title: identity.title,
        headRepository: identity.head.normalized,
        headRefName: identity.headRefName,
        headSha: identity.headSha,
        baseSha: identity.baseSha,
        activatedAt: previous?.activatedAt ?? transientActivation ?? proofTime,
        synchronizedAt: now,
        threads,
        sourceIds: Object.keys(sources).sort(),
      };
      await this.mutateStore((current) =>
        this.admitSnapshot(current, snapshot, sources),
      );
      this.activationTime = now;
      this.status = {
        version: 1,
        state: "available",
        repository: identity.base.normalized,
        pullRequest: identity.number,
        title: identity.title,
        retained: true,
        stale: false,
        lastSuccessAt: now,
        message: `Imported ${threads.length} GitHub review thread${threads.length === 1 ? "" : "s"}.`,
      };
      return this.status;
    } catch (error) {
      if (error instanceof Error && error.message === "cancelled") {
        this.status = {
          ...priorStatus,
          state: retainedOnFailure ? "available" : priorStatus.state,
          retained: retainedOnFailure,
          stale: retainedOnFailure,
          message: "GitHub import was cancelled.",
        };
        return this.status;
      }
      this.status = {
        ...priorStatus,
        state: "failed",
        retained: retainedOnFailure,
        stale: retainedOnFailure,
        message: sanitizeMessage(error),
      };
      return this.status;
    }
  }

  private async activeSnapshot() {
    if (!this.activeIdentity) return null;
    const store = await this.readStore();
    const snapshot = store.snapshots.find(
      (snapshot) =>
        `${snapshot.repository}#${snapshot.pullRequest}` ===
        this.activeIdentity,
    );
    return snapshot ? { snapshot, sources: store.sources } : null;
  }

  async hasCommentsForDiff(sourcePaths: string[]): Promise<boolean> {
    if (sourcePaths.length === 0) return false;
    const retained = await this.readStore();
    if (retained.snapshots.length === 0) return false;
    await this.ensureReadIdentity();
    const active = await this.activeSnapshot();
    return Boolean(
      active?.snapshot.threads.some((thread) =>
        sourcePaths.includes(thread.path),
      ),
    );
  }

  async commentsForDiff(
    diff: DiffResponse,
    contents: { old: string | null; new: string | null },
    sourcePaths: string[] = [diff.path],
  ): Promise<ReviewComment[]> {
    await this.ensureReadIdentity();
    const active = await this.activeSnapshot();
    if (!active) return [];
    const { snapshot, sources } = active;
    return snapshot.threads
      .filter((thread) => sourcePaths.includes(thread.path))
      .map((thread): ReviewComment => {
        const root = thread.comments[0];
        const source = thread.sourceContentId
          ? sources[thread.sourceContentId]
          : undefined;
        const displayed = thread.coordinate
          ? contents[thread.coordinate.side]
          : null;
        const mapped =
          !thread.coordinate || !source || displayed === null
            ? {
                anchor: null,
                reason: !source
                  ? (thread.sourceFailure ?? "source_unavailable")
                  : "displayed_side_unavailable",
              }
            : mapGitHubAnchor(thread.coordinate, source, displayed, diff);
        const alternateMapped =
          thread.alternateCoordinate &&
          source &&
          contents[thread.alternateCoordinate.side] !== null
            ? mapGitHubAnchor(
                thread.alternateCoordinate,
                source,
                contents[thread.alternateCoordinate.side] as string,
                diff,
              )
            : null;
        const coordinateConflict = Boolean(
          mapped.anchor &&
          alternateMapped?.anchor &&
          JSON.stringify(mapped.anchor) !==
            JSON.stringify(alternateMapped.anchor),
        );
        if (coordinateConflict) {
          mapped.anchor = null;
          mapped.reason = "coordinate_conflict";
        }
        const author = normalizeGitHubAuthor(root.author);
        const replies: ReviewReply[] = thread.comments
          .slice(1)
          .map((reply) => ({
            id: `github:${reply.id}`,
            actor: "github",
            body: reply.body,
            createdAt: reply.createdAt,
            author: normalizeGitHubAuthor(reply.author),
            externalId: reply.id,
            url: reply.url,
          }));
        return {
          id: `github:${snapshot.repository}#${snapshot.pullRequest}:${thread.id}`,
          path: diff.path,
          anchors: mapped.anchor ? [mapped.anchor] : [],
          body: root.body,
          createdAt: root.createdAt,
          fingerprint: diff.fingerprint,
          outdated: thread.outdated || !mapped.anchor,
          state: thread.resolved ? "accepted" : "pending",
          rootVersion: 1,
          threadRevision: replies.length,
          replies,
          source: "github",
          readOnly: true,
          author,
          github: {
            repository: snapshot.repository,
            pullRequest: snapshot.pullRequest,
            threadId: thread.id,
            url: root.url,
            resolved: thread.resolved,
            synchronizedAt: snapshot.synchronizedAt,
            mapping: coordinateConflict
              ? "conflict"
              : mapped.anchor
                ? "mapped"
                : "unmapped",
            ...(!mapped.anchor ? { unmappedReason: mapped.reason } : {}),
            ...(thread.path !== diff.path ? { originalPath: thread.path } : {}),
          },
        };
      });
  }

  async allComments(
    resolver: (path: string) => Promise<{
      diff: DiffResponse;
      old: string | null;
      new: string | null;
    }>,
  ) {
    const active = await this.activeSnapshot();
    if (!active) return [];
    const { snapshot } = active;
    const result: ReviewComment[] = [];
    for (const path of new Set(snapshot.threads.map((thread) => thread.path))) {
      try {
        const context = await resolver(path);
        result.push(
          ...(await this.commentsForDiff(
            context.diff,
            {
              old: context.old,
              new: context.new,
            },
            [path, context.diff.path],
          )),
        );
      } catch {
        result.push(
          ...(await this.commentsForDiff(
            {
              schemaVersion: 1,
              path,
              diff: "",
              lines: [],
              language: "text",
              fingerprint: "",
              reviewStatus: "unreviewed",
              truncated: false,
              stats: { additions: 0, deletions: 0 },
              comments: [],
            },
            { old: null, new: null },
          )),
        );
      }
    }
    return [
      ...new Map(result.map((comment) => [comment.id, comment])).values(),
    ];
  }

  isImportedId(id: string) {
    return id.startsWith("github:");
  }

  getStatus() {
    return this.status;
  }

  private async avatarSlot() {
    if (this.avatarActive >= 4)
      await new Promise<void>((resolveSlot) =>
        this.avatarWaiters.push(resolveSlot),
      );
    this.avatarActive += 1;
    return () => {
      this.avatarActive -= 1;
      this.avatarWaiters.shift()?.();
    };
  }

  async getAvatar(value: string) {
    if (!safeAvatarUrl(value)) throw new Error("invalid_avatar_url");
    const url = value;
    const cached = this.avatarCache.get(url);
    if (cached && cached.expiresAt > Date.now()) {
      this.avatarCache.delete(url);
      this.avatarCache.set(url, cached);
      return {
        data: Buffer.from(cached.data),
        contentType: cached.contentType,
      };
    }
    const pending = this.avatarRequests.get(url);
    if (pending) return pending;
    const request = this.fetchAvatar(url).finally(() =>
      this.avatarRequests.delete(url),
    );
    this.avatarRequests.set(url, request);
    return request;
  }

  private async fetchAvatar(initial: string) {
    const release = await this.avatarSlot();
    try {
      let target = initial;
      let response: Response | null = null;
      const deadline = Date.now() + 3_000;
      for (let redirects = 0; redirects <= 3; redirects += 1) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("avatar_timeout");
        response = await fetch(target, {
          redirect: "manual",
          signal: AbortSignal.timeout(remaining),
        });
        if (response.status < 300 || response.status >= 400) break;
        const location = response.headers.get("location");
        if (!location) throw new Error("invalid_avatar_redirect");
        const next = new URL(location, target).href;
        if (!safeAvatarUrl(next)) throw new Error("invalid_avatar_redirect");
        target = next;
        response = null;
      }
      if (!response?.ok) throw new Error("avatar_fetch_failed");
      const declared = response.headers.get("content-type")?.split(";")[0];
      if (
        !declared ||
        !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
          declared,
        )
      )
        throw new Error("invalid_avatar_type");
      const declaredLength = Number(
        response.headers.get("content-length") ?? 0,
      );
      if (declaredLength > 1024 * 1024) throw new Error("invalid_avatar_size");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("avatar_fetch_failed");
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        totalBytes += chunk.value.byteLength;
        if (totalBytes > 1024 * 1024) {
          await reader.cancel();
          throw new Error("invalid_avatar_size");
        }
        chunks.push(Buffer.from(chunk.value));
      }
      const data = Buffer.concat(chunks, totalBytes);
      if (data.length === 0) throw new Error("invalid_avatar_size");
      const matches =
        (declared === "image/png" &&
          data
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
        (declared === "image/jpeg" && data[0] === 0xff && data[1] === 0xd8) ||
        (declared === "image/gif" &&
          data.subarray(0, 3).toString("ascii") === "GIF") ||
        (declared === "image/webp" &&
          data.subarray(0, 4).toString("ascii") === "RIFF" &&
          data.subarray(8, 12).toString("ascii") === "WEBP");
      if (!matches) throw new Error("avatar_signature_mismatch");
      while (
        this.avatarCache.size >= 256 ||
        [...this.avatarCache.values()].reduce(
          (total, item) => total + item.data.length,
          0,
        ) +
          data.length >
          32 * 1024 * 1024
      ) {
        const oldest = this.avatarCache.keys().next().value;
        if (!oldest) break;
        this.avatarCache.delete(oldest);
      }
      this.avatarCache.set(initial, {
        data,
        contentType: declared,
        expiresAt: Date.now() + 24 * 60 * 60 * 1_000,
      });
      return { data: Buffer.from(data), contentType: declared };
    } finally {
      release();
    }
  }
}
