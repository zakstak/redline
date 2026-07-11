import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream, watch, type FSWatcher } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, readlink, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, resolve, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type {
  ChangedFile,
  ChangeKind,
  CommentExportResponse,
  DiffApiLine,
  DiffResponse,
  FileApprovalRequest,
  FilesApprovalResponse,
  ReviewComment,
  ReviewAnchor,
  ReviewDataResponse,
  ReviewSettings,
  ReviewStatus,
  SnapshotResponse,
  WorkspaceResponse,
  WorkspaceChangeEvent,
  WorkspaceSnapshotSummary
} from '../shared/review-contract.js';
import { ReviewDatabase } from './review-database.js';

interface StatusEntry {
  path: string;
  originalPath?: string;
  statusCode: string;
  kind: ChangeKind;
}

interface StoredApproval {
  fingerprint: string;
  approvedAt: string;
}

interface StoredSnapshot {
  id: string;
  approvedAt: string;
  head: string;
  files: Record<string, string>;
}

interface ReviewStore {
  version: 1;
  approvals: Record<string, StoredApproval>;
  snapshots: StoredSnapshot[];
}

type PersistedReviewStore = ReviewStore;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeRecord<T>(source: Record<string, T> = {}): Record<string, T> {
  return Object.assign(Object.create(null) as Record<string, T>, source);
}

function ownValue<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function validatePersistedStore(value: unknown, path: string): PersistedReviewStore {
  const invalid = (detail: string): never => {
    throw new Error(`Review state has an invalid shape at ${path}: ${detail}. The file was left untouched.`);
  };
  if (!isRecord(value)) return invalid('the root must be an object');
  const store = value;
  if (store.version !== 1) invalid('version must be 1');

  if (!isRecord(store.approvals)) return invalid('approvals must be an object');
  for (const approval of Object.values(store.approvals)) {
    if (
      !isRecord(approval) || typeof approval.fingerprint !== 'string' ||
      typeof approval.approvedAt !== 'string'
    ) invalid('each approval must contain fingerprint and approvedAt strings');
  }

  if (!Array.isArray(store.snapshots)) return invalid('snapshots must be an array');
  for (const snapshot of store.snapshots) {
    if (
      !isRecord(snapshot) || typeof snapshot.id !== 'string' ||
      typeof snapshot.approvedAt !== 'string' || typeof snapshot.head !== 'string' ||
      !isRecord(snapshot.files) || Object.values(snapshot.files).some((fingerprint) => typeof fingerprint !== 'string')
    ) invalid('each snapshot must contain id, approvedAt, head, and string fingerprints');
  }

  return store as unknown as ReviewStore;
}

const binaryExtensions = new Set([
  '.7z', '.avi', '.bmp', '.class', '.dll', '.doc', '.docx', '.eot', '.exe', '.gif', '.gz', '.ico',
  '.jar', '.jpeg', '.jpg', '.mov', '.mp3', '.mp4', '.o', '.otf', '.pdf', '.png', '.pyc', '.so', '.tar',
  '.ttf', '.wav', '.webm', '.webp', '.woff', '.woff2', '.xls', '.xlsx', '.zip'
]);

const generatedPathPatterns = [
  /(^|\/)(build|coverage|dist|generated|target)(\/|$)/i,
  /(^|\/)vendor(\/|$)/i,
  /\.generated\.[^/]+$/i,
  /\.min\.(css|js)$/i,
  /\.map$/i
];

const languageByExtension: Record<string, string> = {
  '.css': 'css',
  '.go': 'go',
  '.html': 'html',
  '.java': 'java',
  '.js': 'javascript',
  '.json': 'json',
  '.jsx': 'javascript',
  '.md': 'markdown',
  '.py': 'python',
  '.rb': 'ruby',
  '.rs': 'rust',
  '.sh': 'shell',
  '.sql': 'sql',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.vue': 'vue',
  '.xml': 'xml',
  '.yaml': 'yaml',
  '.yml': 'yaml'
};

function git(root: string, args: string[], allowedExitCodes: number[] = [0]): Promise<string> {
  return new Promise((resolveResult, reject) => {
    execFile(
      'git',
      args,
      {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 48 * 1024 * 1024,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolveResult(stdout);
          return;
        }

        const exitCode = typeof error.code === 'number' ? error.code : Number(error.code);
        if (allowedExitCodes.includes(exitCode)) {
          resolveResult(stdout);
          return;
        }

        const message = stderr.trim() || error.message;
        reject(new Error(message, { cause: error }));
      }
    );
  });
}

function parseNameStatus(output: string): StatusEntry[] {
  const tokens = output.split('\0');
  const entries: StatusEntry[] = [];

  for (let index = 0; index < tokens.length;) {
    const statusCode = tokens[index];
    if (!statusCode) break;
    index += 1;
    const statusKind = statusCode[0];
    const originalPath = statusKind === 'R' || statusKind === 'C'
      ? tokens[index++] || undefined
      : undefined;
    const path = tokens[index++] || '';
    if (!path) continue;

    let kind: ChangeKind = 'modified';
    if (statusKind === 'R') kind = 'renamed';
    else if (statusKind === 'A' || statusKind === 'C') kind = 'added';
    else if (statusKind === 'D') kind = 'deleted';
    else if (statusKind === 'T') kind = 'type-changed';

    entries.push({ path, originalPath, statusCode, kind });
  }

  return entries;
}

function assertPathInside(root: string, filePath: string) {
  const absolutePath = resolve(root, filePath);
  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (absolutePath !== root && !absolutePath.startsWith(rootPrefix)) {
    throw new Error('The requested path is outside the active workspace.');
  }
  return absolutePath;
}

function reviewStatusFor(approval: StoredApproval | undefined, fingerprint: string): ReviewStatus {
  if (!approval) return 'unreviewed';
  return approval.fingerprint === fingerprint ? 'approved' : 'changed';
}

function diffStats(diff: string) {
  let additions = 0;
  let deletions = 0;

  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
    if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
  }

  return { additions, deletions };
}

function normalizeAnchors(anchors: ReviewAnchor[]): ReviewAnchor[] {
  const sorted = anchors
    .filter((anchor) =>
      (anchor.side === 'old' || anchor.side === 'new') &&
      Number.isSafeInteger(anchor.startLine) &&
      Number.isSafeInteger(anchor.endLine) &&
      anchor.startLine > 0 &&
      anchor.endLine > 0
    )
    .map((anchor) => ({
      side: anchor.side,
      startLine: Math.min(anchor.startLine, anchor.endLine),
      endLine: Math.max(anchor.startLine, anchor.endLine)
    }))
    .sort((first, second) =>
      first.side.localeCompare(second.side) || first.startLine - second.startLine
    );

  const merged: ReviewAnchor[] = [];
  for (const anchor of sorted) {
    const previous = merged.at(-1);
    if (previous && previous.side === anchor.side && anchor.startLine <= previous.endLine + 1) {
      previous.endLine = Math.max(previous.endLine, anchor.endLine);
    } else {
      merged.push({ ...anchor });
    }
  }
  return merged;
}

function parseApiDiff(diff: string): DiffApiLine[] {
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  const lines: DiffApiLine[] = [];

  const rawLines = diff.split('\n');
  rawLines.forEach((rawLine, index) => {
    if (rawLine === '' && index === rawLines.length - 1) return;
    if (rawLine === '\\ No newline at end of file') {
      const previous = lines.at(-1);
      if (previous && previous.type !== 'hunk' && previous.type !== 'meta') previous.noNewline = true;
      return;
    }
    const hunk = rawLine.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk?.[1] && hunk[2]) {
      inHunk = true;
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      lines.push({
        id: `hunk-${oldLine}-${newLine}`,
        type: 'hunk',
        content: rawLine,
        oldLine: null,
        newLine: null,
        anchors: []
      });
      return;
    }

    if (rawLine.startsWith('diff --git')) {
      inHunk = false;
      return;
    }
    if (
      !inHunk &&
      (rawLine.startsWith('index ') || rawLine.startsWith('--- ') || rawLine.startsWith('+++ '))
    ) return;

    if (!inHunk) {
      lines.push({
        id: `meta-${index}`,
        type: 'meta',
        content: rawLine,
        oldLine: null,
        newLine: null,
        anchors: []
      });
      return;
    }

    if (rawLine.startsWith('-')) {
      lines.push({
        id: `old-${oldLine}`,
        type: 'remove',
        content: rawLine.slice(1),
        oldLine,
        newLine: null,
        anchors: [{ side: 'old', startLine: oldLine, endLine: oldLine }]
      });
      oldLine += 1;
      return;
    }

    if (rawLine.startsWith('+')) {
      lines.push({
        id: `new-${newLine}`,
        type: 'add',
        content: rawLine.slice(1),
        oldLine: null,
        newLine,
        anchors: [{ side: 'new', startLine: newLine, endLine: newLine }]
      });
      newLine += 1;
      return;
    }

    if (!rawLine.startsWith(' ')) {
      lines.push({
        id: `meta-${index}`,
        type: 'meta',
        content: rawLine,
        oldLine: null,
        newLine: null,
        anchors: []
      });
      return;
    }
    const content = rawLine.slice(1);
    lines.push({
      id: `both-${oldLine}-${newLine}`,
      type: 'context',
      content,
      oldLine,
      newLine,
      anchors: [
        { side: 'old', startLine: oldLine, endLine: oldLine },
        { side: 'new', startLine: newLine, endLine: newLine }
      ]
    });
    oldLine += 1;
    newLine += 1;
  });

  return lines;
}

function newFileDiff(path: string, content: string, mode = '100644', complete = true) {
  const normalized = content.replace(/\r\n/g, '\n');
  const endsWithNewline = normalized.endsWith('\n');
  const lines = normalized.length === 0
    ? []
    : endsWithNewline ? normalized.slice(0, -1).split('\n') : normalized.split('\n');
  const output = [
    `diff --git a/${path} b/${path}`,
    `new file mode ${mode}`,
    '--- /dev/null',
    `+++ b/${path}`
  ];
  if (lines.length > 0) {
    output.push(`@@ -0,0 +1,${lines.length} @@`);
    output.push(...lines.map((line) => `+${line}`));
    if (complete && !endsWithNewline) output.push('\\ No newline at end of file');
  }
  return output.join('\n');
}

async function readUtf8Prefix(path: string, byteLimit: number) {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(byteLimit);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return new StringDecoder('utf8').write(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

export class ReviewWorkspace {
  private root: string;
  private gitDir = '';
  private database: ReviewDatabase | null = null;
  private inspectionCache = new Map<string, {
    signature: string;
    contentHash: string;
    binary: boolean;
    worktreeMode: string | null;
  }>();
  private storeMutationQueue: Promise<void> = Promise.resolve();
  private workspaceGeneration = 0;
  private workspaceSwitchPromise: Promise<void> | null = null;
  private fileWatchers: FSWatcher[] = [];
  private watchTimer: NodeJS.Timeout | null = null;
  private pendingWatchPaths = new Set<string>();
  private watchSequence = 0;
  private watchListeners = new Set<(event: WorkspaceChangeEvent) => void>();

  constructor(initialRoot: string) {
    this.root = resolve(initialRoot);
  }

  async initialize() {
    await this.openWorkspace(this.root);
  }

  async openWorkspace(requestedPath: string) {
    const candidate = isAbsolute(requestedPath) ? requestedPath : resolve(this.root, requestedPath);
    const root = (await git(candidate, ['rev-parse', '--show-toplevel'])).trim();
    const gitDir = (await git(root, ['rev-parse', '--absolute-git-dir'])).trim();
    const operation = this.enqueueExclusive(async () => {
      const targetStorePath = this.storePath(gitDir);
      const targetDatabasePath = this.databasePath(gitDir);
      // Validate persisted state before closing or replacing the active
      // workspace. A failed open must leave the current review usable.
      await this.readPersistedStore(targetStorePath);
      await mkdir(dirname(targetDatabasePath), { recursive: true, mode: 0o700 });
      await chmod(dirname(targetDatabasePath), 0o700);
      const targetDatabase = new ReviewDatabase(targetDatabasePath);
      const previousDatabase = this.database;
      this.root = root;
      this.gitDir = gitDir;
      this.database = targetDatabase;
      this.workspaceGeneration += 1;
      this.inspectionCache.clear();
      previousDatabase?.close();
      this.startFileWatch(root, gitDir);
    });
    const switchPromise = operation.then(() => undefined);
    // Concurrent requests should still observe a failed workspace switch, while
    // this attached handler prevents Node from treating the tracked promise as
    // an unhandled rejection before one of those requests awaits it.
    void switchPromise.catch(() => undefined);
    this.workspaceSwitchPromise = switchPromise;
    try {
      await operation;
    } finally {
      if (this.workspaceSwitchPromise === switchPromise) this.workspaceSwitchPromise = null;
    }
    return this.getWorkspace();
  }

  close() {
    this.stopFileWatch();
    this.database?.close();
    this.database = null;
  }

  subscribeToChanges(listener: (event: WorkspaceChangeEvent) => void) {
    this.watchListeners.add(listener);
    return () => {
      this.watchListeners.delete(listener);
    };
  }

  isFileWatchActive() {
    return this.fileWatchers.length > 0;
  }

  private shouldIgnoreWatchPath(path: string) {
    return path === 'node_modules' || path.startsWith('node_modules/') ||
      path === 'test-results' || path.startsWith('test-results/') ||
      path === 'playwright-report' || path.startsWith('playwright-report/') ||
      path === '.git/redline' || path.startsWith('.git/redline/') ||
      (path.startsWith('.git/') &&
        path !== '.git/HEAD' && path !== '.git/index' && !path.startsWith('.git/refs/'));
  }

  private queueWatchEvent(filename: string | Buffer | null, prefix = '') {
    const reported = typeof filename === 'string'
      ? `${prefix}${filename}`.replaceAll('\\', '/').replace(/^\.\//, '')
      : '';
    if (reported && this.shouldIgnoreWatchPath(reported)) return;
    if (reported) this.pendingWatchPaths.add(reported);
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null;
      const event: WorkspaceChangeEvent = {
        type: 'workspace-changed',
        sequence: ++this.watchSequence,
        observedAt: new Date().toISOString(),
        paths: [...this.pendingWatchPaths].sort().slice(0, 32)
      };
      this.pendingWatchPaths.clear();
      for (const listener of this.watchListeners) listener(event);
    }, 140);
  }

  private stopFileWatch() {
    for (const watcher of this.fileWatchers) watcher.close();
    this.fileWatchers = [];
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = null;
    this.pendingWatchPaths.clear();
  }

  private startFileWatch(root: string, gitDir: string) {
    this.stopFileWatch();
    const addWatcher = (path: string, recursive: boolean, prefix = '') => {
      try {
        const watcher = watch(path, { recursive, persistent: false }, (_eventType, filename) => {
          this.queueWatchEvent(filename, prefix);
        });
        watcher.on('error', () => {
          watcher.close();
          this.fileWatchers = this.fileWatchers.filter((candidate) => candidate !== watcher);
        });
        this.fileWatchers.push(watcher);
      } catch {
        // The browser retains its visibility and 30-second polling fallback.
      }
    };
    addWatcher(root, true);
    addWatcher(gitDir, false, '.git/');
  }

  private async ensureInitialized() {
    if (this.workspaceSwitchPromise) await this.workspaceSwitchPromise;
    if (!this.gitDir || !this.database) {
      await this.initialize();
    }
  }

  private storePath(gitDir = this.gitDir) {
    return resolve(gitDir, 'redline', 'state.json');
  }

  private databasePath(gitDir = this.gitDir) {
    return resolve(gitDir, 'redline', 'review.sqlite');
  }

  private reviewDatabase() {
    if (!this.database) throw new Error('The local review database is not initialized.');
    return this.database;
  }

  private async readPersistedStore(path = this.storePath()): Promise<PersistedReviewStore> {
    try {
      return validatePersistedStore(
        JSON.parse(await readFile(path, 'utf8')) as unknown,
        path
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { version: 1, approvals: {}, snapshots: [] };
      if (error instanceof SyntaxError) {
        throw new Error(`Review state is malformed at ${path}. The file was left untouched.`, { cause: error });
      }
      throw error;
    }
  }

  private async readStore(): Promise<ReviewStore> {
    await this.ensureInitialized();
    const parsed = await this.readPersistedStore();
    return {
      version: 1,
      approvals: safeRecord(parsed.approvals),
      snapshots: parsed.snapshots
    };
  }

  private async writeStore(store: ReviewStore, destination = this.storePath()) {
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, destination);
    await chmod(destination, 0o600);
  }

  private enqueueExclusive<T>(operation: () => T | Promise<T>) {
    const queued = this.storeMutationQueue.then(operation);
    this.storeMutationQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  private async readStable<T>(reader: () => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await this.ensureInitialized();
      const generation = this.workspaceGeneration;
      try {
        const result = await reader();
        if (generation === this.workspaceGeneration) return result;
      } catch (error) {
        if (generation === this.workspaceGeneration) throw error;
      }
    }
    throw new Error('The active workspace changed while the request was being read. Try again.');
  }

  private async mutateStore<T>(
    expectedGeneration: number,
    mutator: (store: ReviewStore) => T | Promise<T>
  ): Promise<T> {
    let result: T | undefined;
    const mutation = this.enqueueExclusive(async () => {
      if (expectedGeneration !== this.workspaceGeneration) {
        throw new Error('The active workspace changed before the review state could be saved.');
      }
      const store = await this.readStore();
      result = await mutator(store);
      await this.writeStore(store);
    });
    await mutation;
    return result as T;
  }

  private async currentHead() {
    const head = (await git(this.root, ['rev-parse', '--verify', 'HEAD'], [0, 128])).trim();
    return head || 'unborn';
  }

  private async inspectFile(entry: StatusEntry) {
    if (entry.kind === 'deleted') {
      return {
        contentHash: 'deleted',
        binary: binaryExtensions.has(extname(entry.path).toLowerCase()),
        worktreeMode: null
      };
    }
    const absolutePath = assertPathInside(this.root, entry.path);
    const fileStat = await lstat(absolutePath, { bigint: true });
    let specialDiff = '';
    if (!fileStat.isSymbolicLink() && !fileStat.isFile()) {
      specialDiff = await git(this.root, [
        'diff', '--no-ext-diff', '--no-color', '--submodule=short', 'HEAD', '--', `:(literal)${entry.path}`
      ], [0, 128]);
    }
    const signature = [
      entry.kind,
      fileStat.mode,
      fileStat.size,
      fileStat.mtimeNs,
      fileStat.ctimeNs,
      specialDiff ? createHash('sha256').update(specialDiff).digest('hex') : ''
    ].join(':');
    const cached = this.inspectionCache.get(entry.path);
    if (cached?.signature === signature) return cached;

    let contentHash: string;
    let binary = binaryExtensions.has(extname(entry.path).toLowerCase());
    const worktreeMode = fileStat.isSymbolicLink()
      ? '120000'
      : fileStat.isFile() ? (Number(fileStat.mode & 0o111n) !== 0 ? '100755' : '100644') : `special:${fileStat.mode}`;

    if (fileStat.isSymbolicLink()) {
      contentHash = createHash('sha256').update(`symlink:${await readlink(absolutePath)}`).digest('hex');
    } else if (!fileStat.isFile()) {
      contentHash = createHash('sha256')
        .update(`special:${fileStat.mode}:${fileStat.size}:${specialDiff}`)
        .digest('hex');
    } else {
      const inspected = await new Promise<{ contentHash: string; binary: boolean }>((resolveHash, reject) => {
        const digest = createHash('sha256');
        const stream = createReadStream(absolutePath);
        let sampledBytes = 0;
        let containsNull = false;
        stream.on('data', (chunk) => {
          const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
          digest.update(bytes);
          if (sampledBytes < 8192) {
            const sample = bytes.subarray(0, 8192 - sampledBytes);
            containsNull ||= sample.includes(0);
            sampledBytes += sample.length;
          }
        });
        stream.on('error', reject);
        stream.on('end', () => resolveHash({ contentHash: digest.digest('hex'), binary: binary || containsNull }));
      });
      contentHash = inspected.contentHash;
      binary = inspected.binary;
    }

    const inspection = { signature, contentHash, binary, worktreeMode };
    this.inspectionCache.set(entry.path, inspection);
    return inspection;
  }

  private isGenerated(path: string) {
    return generatedPathPatterns.some((pattern) => pattern.test(path));
  }

  private async baselineBlobs(head: string, entries: StatusEntry[]) {
    const blobs = new Map<string, { blob: string; mode: string }>();
    if (head === 'unborn') return blobs;
    const paths = [...new Set(entries.map((entry) => entry.originalPath ?? entry.path))];

    for (let index = 0; index < paths.length; index += 400) {
      const chunk = paths.slice(index, index + 400);
      const output = await git(this.root, [
        'ls-tree', '-r', '-z', head, '--', ...chunk.map((path) => `:(literal)${path}`)
      ]);
      for (const record of output.split('\0')) {
        const match = record.match(/^(\d+)\s+\w+\s+([0-9a-f]+)\t(.+)$/);
        if (match?.[1] && match[2] && match[3]) {
          blobs.set(match[3], { mode: match[1], blob: match[2] });
        }
      }
    }

    return blobs;
  }

  private async deletedBinaryPaths(head: string, entries: StatusEntry[]) {
    const deleted = entries.filter((entry) => entry.kind === 'deleted');
    const binary = new Set<string>();
    if (head === 'unborn' || deleted.length === 0) return binary;
    const output = await git(this.root, [
      'diff', '--numstat', '-z', head, '--', ...deleted.map((entry) => `:(literal)${entry.path}`)
    ]);
    for (const record of output.split('\0')) {
      const fields = record.split('\t');
      if (fields[0] === '-' && fields[1] === '-' && fields.length >= 3) {
        binary.add(fields.slice(2).join('\t'));
      }
    }
    return binary;
  }

  private async changeEntries(head: string): Promise<StatusEntry[]> {
    if (head === 'unborn') {
      const output = await git(this.root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
      const entries: StatusEntry[] = [];
      for (const path of new Set(output.split('\0').filter(Boolean))) {
        try {
          await lstat(assertPathInside(this.root, path));
          entries.push({ path, statusCode: 'A', kind: 'added' });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      return entries;
    }

    const [trackedOutput, untrackedOutput] = await Promise.all([
      git(this.root, ['diff', '--name-status', '-z', '--find-renames', 'HEAD']),
      git(this.root, ['ls-files', '--others', '--exclude-standard', '-z'])
    ]);
    const entries = parseNameStatus(trackedOutput);
    const trackedPaths = new Set(entries.map((entry) => entry.path));
    for (const path of untrackedOutput.split('\0').filter(Boolean)) {
      if (!trackedPaths.has(path)) {
        entries.push({ path, statusCode: '??', kind: 'untracked' });
      }
    }
    return entries;
  }

  private async changedFiles(head: string, store: ReviewStore): Promise<ChangedFile[]> {
    // Redline reviews the net HEAD-to-worktree state. Deriving tracked entries
    // from that same comparison avoids crashing on valid two-column porcelain
    // states such as AD (staged add, then removed from the worktree), whose net
    // content is unchanged. Untracked files are added separately.
    const entries = await this.changeEntries(head);
    const [baselineBlobs, deletedBinary] = await Promise.all([
      this.baselineBlobs(head, entries),
      this.deletedBinaryPaths(head, entries)
    ]);
    const commentCounts = this.reviewDatabase().commentCountsByPath();
    const currentPaths = new Set(entries.map((entry) => entry.path));
    for (const cachedPath of this.inspectionCache.keys()) {
      if (!currentPaths.has(cachedPath)) this.inspectionCache.delete(cachedPath);
    }

    return Promise.all(
      entries.map(async (entry) => {
        const inspection = await this.inspectFile(entry);
        const binary = inspection.binary || deletedBinary.has(entry.path);
        const { contentHash, worktreeMode } = inspection;
        const baselinePath = entry.originalPath ?? entry.path;
        const baseline = baselineBlobs.get(baselinePath);
        const fingerprint = createHash('sha256')
          .update(JSON.stringify({
            path: entry.path,
            originalPath: entry.originalPath,
            kind: entry.kind,
            contentHash,
            worktreeMode,
            baselineBlob: baseline?.blob ?? null,
            baselineMode: baseline?.mode ?? null
          }))
          .digest('hex');
        const approval = ownValue(store.approvals, entry.path);
        const reviewStatus = reviewStatusFor(approval, fingerprint);

        return {
          ...entry,
          name: basename(entry.path),
          directory: dirname(entry.path) === '.' ? '' : dirname(entry.path),
          fingerprint,
          reviewStatus,
          approvedAt: approval?.approvedAt,
          binary,
          generated: this.isGenerated(entry.path),
          commentCount: commentCounts.get(entry.path) ?? 0
        } satisfies ChangedFile;
      })
    );
  }

  private snapshotSummary(snapshot: StoredSnapshot, files: ChangedFile[]): WorkspaceSnapshotSummary {
    let unchangedCount = 0;
    let changedCount = 0;

    for (const file of files) {
      if (ownValue(snapshot.files, file.path) === file.fingerprint) unchangedCount += 1;
      else changedCount += 1;
    }

    return {
      id: snapshot.id,
      approvedAt: snapshot.approvedAt,
      fileCount: Object.keys(snapshot.files).length,
      unchangedCount,
      changedCount
    };
  }

  async getWorkspace(includeNoise = false): Promise<WorkspaceResponse> {
    return this.readStable(() => this.getWorkspaceOnce(includeNoise));
  }

  private async getWorkspaceOnce(includeNoise = false): Promise<WorkspaceResponse> {
    await this.ensureInitialized();
    const store = await this.readStore();
    const [head, branch] = await Promise.all([
      this.currentHead(),
      git(this.root, ['branch', '--show-current']).then((value) => value.trim() || 'detached')
    ]);
    const allFiles = (await this.changedFiles(head, store)).sort((first, second) =>
      first.path.localeCompare(second.path)
    );
    const visibleFiles = includeNoise ? allFiles : allFiles.filter((file) => !file.binary && !file.generated);
    const latestStoredSnapshot = store.snapshots.at(-1);
    const comments = visibleFiles.reduce((total, file) => total + file.commentCount, 0);

    return {
      root: this.root,
      name: basename(this.root),
      branch,
      head,
      files: visibleFiles,
      hiddenNoiseCount: allFiles.length - visibleFiles.length,
      counts: {
        total: visibleFiles.length,
        needsReview: visibleFiles.filter((file) => file.reviewStatus !== 'approved').length,
        approved: visibleFiles.filter((file) => file.reviewStatus === 'approved').length,
        changed: visibleFiles.filter((file) => file.reviewStatus === 'changed').length,
        comments
      },
      latestSnapshot: latestStoredSnapshot ? this.snapshotSummary(latestStoredSnapshot, visibleFiles) : null,
      refreshedAt: new Date().toISOString()
    };
  }

  async getDiff(path: string, context = 3): Promise<DiffResponse> {
    return this.readStable(() => this.getDiffOnce(path, context));
  }

  private async getDiffOnce(path: string, context = 3): Promise<DiffResponse> {
    await this.ensureInitialized();
    const workspace = await this.getWorkspaceOnce(true);
    const file = workspace.files.find((candidate) => candidate.path === path);
    if (!file) throw new Error('That file is no longer part of the current change set.');
    if (file.binary) throw new Error('Binary files do not have a readable text diff.');

    const absolutePath = assertPathInside(this.root, path);
    let diff = '';
    let truncated = false;

    if (file.kind === 'untracked' || workspace.head === 'unborn') {
      const fileStat = await lstat(absolutePath);
      if (fileStat.isSymbolicLink()) {
        diff = newFileDiff(path, await readlink(absolutePath), '120000');
      } else if (!fileStat.isFile()) {
        throw new Error('Only regular files and symbolic links have readable text diffs.');
      } else if (fileStat.size > 5 * 1024 * 1024) {
        truncated = true;
        const mode = (fileStat.mode & 0o111) !== 0 ? '100755' : '100644';
        diff = newFileDiff(path, await readUtf8Prefix(absolutePath, 5 * 1024 * 1024), mode, false);
      } else {
        const mode = (fileStat.mode & 0o111) !== 0 ? '100755' : '100644';
        diff = newFileDiff(path, await readFile(absolutePath, 'utf8'), mode);
      }
    } else {
      diff = await git(this.root, [
        'diff',
        '--no-ext-diff',
        '--find-renames',
        '--no-color',
        `--unified=${Math.min(Math.max(context, 0), 20)}`,
        'HEAD',
        '--',
        ...[file.originalPath, path]
          .filter((candidate): candidate is string => Boolean(candidate))
          .map((candidate) => `:(literal)${candidate}`)
      ]);
    }

    const comments = this.reviewDatabase().commentsForPath(path)
      .map((comment) => ({ ...comment, outdated: comment.fingerprint !== file.fingerprint }));

    return {
      schemaVersion: 1,
      path,
      diff,
      lines: parseApiDiff(diff),
      language: languageByExtension[extname(path).toLowerCase()] ?? 'text',
      fingerprint: file.fingerprint,
      reviewStatus: file.reviewStatus,
      approvedAt: file.approvedAt,
      truncated,
      stats: diffStats(diff),
      comments
    };
  }

  async approveFile(path: string, expectedFingerprint: string) {
    await this.ensureInitialized();
    const generation = this.workspaceGeneration;
    const workspace = await this.getWorkspace(true);
    const file = workspace.files.find((candidate) => candidate.path === path);
    if (!file) throw new Error('That file is no longer part of the current change set.');
    if (expectedFingerprint !== file.fingerprint) {
      throw new Error('The file changed while it was open. Refresh the diff before approving it.');
    }

    const approvedAt = new Date().toISOString();
    await this.mutateStore(generation, (store) => {
      store.approvals[path] = { fingerprint: file.fingerprint, approvedAt };
    });
    return { path, fingerprint: file.fingerprint, approvedAt };
  }

  async approveFiles(requests: FileApprovalRequest[]): Promise<FilesApprovalResponse> {
    await this.ensureInitialized();
    if (requests.length === 0) throw new Error('Choose at least one visible file to approve.');
    if (requests.length > 5_000) throw new Error('Approve no more than 5,000 visible files at once.');
    const uniquePaths = new Set(requests.map((request) => request.path));
    if (uniquePaths.size !== requests.length) throw new Error('Each visible file can be approved only once per request.');

    const generation = this.workspaceGeneration;
    const workspace = await this.getWorkspace(true);
    const filesByPath = new Map(workspace.files.map((file) => [file.path, file]));
    const binaryPaths: string[] = [];
    const stalePaths: string[] = [];
    for (const request of requests) {
      const file = filesByPath.get(request.path);
      if (file?.binary) binaryPaths.push(request.path);
      else if (!file || file.fingerprint !== request.fingerprint) stalePaths.push(request.path);
    }
    if (binaryPaths.length > 0) {
      throw new Error(`Binary files cannot be batch approved because they do not have a readable diff: ${binaryPaths.slice(0, 5).join(', ')}.`);
    }
    if (stalePaths.length > 0) {
      const count = stalePaths.length;
      const listed = stalePaths.slice(0, 5).join(', ');
      const remainder = count > 5 ? ` and ${count - 5} more` : '';
      throw new Error(`Nothing was approved. ${count} file${count === 1 ? '' : 's'} changed while the visible set was open: ${listed}${remainder}. Review ${count === 1 ? 'it' : 'them'} again.`);
    }

    const approvedAt = new Date().toISOString();
    const approvals = requests.map((request) => ({ ...request, approvedAt }));
    await this.mutateStore(generation, (store) => {
      for (const approval of approvals) {
        store.approvals[approval.path] = {
          fingerprint: approval.fingerprint,
          approvedAt
        };
      }
    });
    return { approvedAt, approvals };
  }

  async approveSnapshot(): Promise<SnapshotResponse> {
    await this.ensureInitialized();
    const generation = this.workspaceGeneration;
    const workspace = await this.getWorkspace(false);
    if (workspace.files.length === 0) throw new Error('There are no reviewable changes to approve.');

    const approvedAt = new Date().toISOString();
    const snapshot: StoredSnapshot = {
      id: randomUUID(),
      approvedAt,
      head: workspace.head,
      files: Object.fromEntries(workspace.files.map((file) => [file.path, file.fingerprint]))
    };

    await this.mutateStore(generation, (store) => {
      for (const file of workspace.files) {
        store.approvals[file.path] = { fingerprint: file.fingerprint, approvedAt };
      }
      store.snapshots.push(snapshot);
      store.snapshots = store.snapshots.slice(-30);
    });

    const refreshedWorkspace = await this.getWorkspace(false);
    return {
      snapshot: this.snapshotSummary(snapshot, refreshedWorkspace.files),
      workspace: refreshedWorkspace
    };
  }

  async addComment(input: {
    path: string;
    expectedFingerprint: string;
    anchors: ReviewAnchor[];
    body: string;
  }) {
    await this.ensureInitialized();
    const generation = this.workspaceGeneration;
    const body = input.body.trim();
    if (!body) throw new Error('Write a comment before saving it.');
    if (body.length > 4000) throw new Error('Comments must be 4,000 characters or fewer.');

    const currentDiff = await this.getDiff(input.path, 20);
    if (input.expectedFingerprint !== currentDiff.fingerprint) {
      throw new Error('The file changed while the comment was open. Refresh the diff before saving it.');
    }

    const anchors = normalizeAnchors(input.anchors);
    if (anchors.length === 0) throw new Error('Choose at least one numbered diff line before saving a comment.');
    const availableLines = { old: new Set<number>(), new: new Set<number>() };
    for (const line of currentDiff.lines) {
      for (const anchor of line.anchors) {
        for (let lineNumber = anchor.startLine; lineNumber <= anchor.endLine; lineNumber += 1) {
          availableLines[anchor.side].add(lineNumber);
        }
      }
    }
    const anchorsExist = anchors.every((anchor) => {
      for (let lineNumber = anchor.startLine; lineNumber <= anchor.endLine; lineNumber += 1) {
        if (!availableLines[anchor.side].has(lineNumber)) return false;
      }
      return true;
    });
    if (!anchorsExist) throw new Error('One or more comment lines are not present in the current diff.');
    const comment: Omit<ReviewComment, 'outdated'> = {
      id: randomUUID(),
      path: input.path,
      anchors,
      body,
      createdAt: new Date().toISOString(),
      fingerprint: currentDiff.fingerprint
    };
    await this.enqueueExclusive(() => {
      if (generation !== this.workspaceGeneration) {
        throw new Error('The active workspace changed before the comment could be saved.');
      }
      this.reviewDatabase().insertComment(comment);
    });
    return { ...comment, outdated: false } satisfies ReviewComment;
  }

  async deleteComment(id: string) {
    await this.ensureInitialized();
    const generation = this.workspaceGeneration;
    await this.enqueueExclusive(() => {
      if (generation !== this.workspaceGeneration) {
        throw new Error('The active workspace changed before the comment could be deleted.');
      }
      if (!this.reviewDatabase().deleteComment(id)) throw new Error('That comment no longer exists.');
    });
  }

  async getReviewData(): Promise<ReviewDataResponse> {
    return this.readStable(() => this.getReviewDataOnce());
  }

  private async getReviewDataOnce(): Promise<ReviewDataResponse> {
    const workspace = await this.getWorkspace(false);
    const fingerprints = new Map(workspace.files.map((file) => [file.path, file.fingerprint]));
    const comments = this.reviewDatabase().allComments().map((comment) => ({
      ...comment,
      outdated: fingerprints.get(comment.path) !== comment.fingerprint
    }));

    return {
      version: 1,
      generatedAt: new Date().toISOString(),
      workspace,
      comments
    };
  }

  async getCommentExport(): Promise<CommentExportResponse> {
    const review = await this.getReviewData();
    return {
      version: 1,
      generatedAt: review.generatedAt,
      workspace: {
        root: review.workspace.root,
        name: review.workspace.name,
        branch: review.workspace.branch,
        head: review.workspace.head
      },
      comments: review.comments
    };
  }

  async getSettings(): Promise<ReviewSettings> {
    return this.readStable(() => Promise.resolve(this.reviewDatabase().getSettings()));
  }

  async updateSettings(
    diffContextLines: number,
    keyboardLayout: ReviewSettings['keyboardLayout'] = 'normie'
  ): Promise<ReviewSettings> {
    await this.ensureInitialized();
    if (!Number.isSafeInteger(diffContextLines) || diffContextLines < 0 || diffContextLines > 20) {
      throw new Error('Unchanged context lines must be a whole number from 0 to 20.');
    }
    if (keyboardLayout !== 'normie' && keyboardLayout !== 'vim') {
      throw new Error('Keyboard layout must be normie or vim.');
    }
    const generation = this.workspaceGeneration;
    return this.enqueueExclusive(() => {
      if (generation !== this.workspaceGeneration) {
        throw new Error('The active workspace changed before settings could be saved.');
      }
      return this.reviewDatabase().updateSettings(diffContextLines, keyboardLayout);
    });
  }

  async getReviewMarkdown() {
    return this.readStable(() => this.getReviewMarkdownOnce());
  }

  private async getReviewMarkdownOnce() {
    const review = await this.getReviewData();
    const lines = [
      `# Redline review: ${review.workspace.name}`,
      '',
      `Branch: ${review.workspace.branch}`,
      `Head: ${review.workspace.head}`,
      `Generated: ${review.generatedAt}`,
      ''
    ];

    if (review.comments.length === 0) {
      lines.push('No review comments.');
      return `${lines.join('\n')}\n`;
    }

    const diffByPath = new Map<string, DiffResponse | null>();
    for (const path of new Set(review.comments.map((comment) => comment.path))) {
      try {
        diffByPath.set(path, await this.getDiff(path, 3));
      } catch {
        diffByPath.set(path, null);
      }
    }

    for (const comment of review.comments) {
      const lineLabel = comment.anchors.map((anchor) => {
        const side = anchor.side === 'old' ? 'old' : 'new';
        return anchor.startLine === anchor.endLine
          ? `${side} line ${anchor.startLine}`
          : `${side} lines ${anchor.startLine}-${anchor.endLine}`;
      }).join(', ') || 'File comment';
      lines.push(`## ${comment.path}`);
      lines.push('');
      lines.push(`${lineLabel}${comment.outdated ? ' (outdated)' : ''}`);
      lines.push('');
      lines.push(comment.body);
      lines.push('');

      const fileDiff = diffByPath.get(comment.path);
      if (fileDiff) {
        const context = fileDiff.lines.filter((line) => line.anchors.some((lineAnchor) =>
          comment.anchors.some((commentAnchor) =>
            lineAnchor.side === commentAnchor.side &&
            lineAnchor.startLine >= Math.max(1, commentAnchor.startLine - 2) &&
            lineAnchor.startLine <= commentAnchor.endLine + 2
          )
        ));
        if (context.length > 0) {
          lines.push(`\`\`\`${fileDiff.language}`);
          for (const line of context) {
            const marker = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ';
            const location = line.newLine ?? line.oldLine ?? '';
            lines.push(`${marker} ${String(location).padStart(5, ' ')} | ${line.content}`);
          }
          lines.push('```');
          lines.push('');
        }
      }
    }

    return `${lines.join('\n')}\n`;
  }
}
