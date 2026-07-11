export type ReviewStatus = "unreviewed" | "approved" | "changed";
export type ChangeKind =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "type-changed";
export type DiffSide = "old" | "new";
export type DiffApiLineType = "context" | "add" | "remove" | "hunk" | "meta";

export interface ReviewAnchor {
  side: DiffSide;
  startLine: number;
  endLine: number;
}

export interface DiffApiLine {
  id: string;
  type: DiffApiLineType;
  content: string;
  oldLine: number | null;
  newLine: number | null;
  anchors: ReviewAnchor[];
  noNewline?: boolean;
}

export interface ReviewComment {
  id: string;
  path: string;
  anchors: ReviewAnchor[];
  body: string;
  createdAt: string;
  fingerprint: string;
  outdated: boolean;
  state: ReviewThreadState;
  rootVersion: number;
  threadRevision: number;
  replies: ReviewReply[];
  deleted?: boolean;
}

export type ReviewThreadState =
  | "pending"
  | "accepted"
  | "rejected"
  | "deferred";
export type ReviewDecision = Exclude<ReviewThreadState, "pending">;

export interface ReviewReply {
  id: string;
  actor: "user" | "agent";
  body: string;
  createdAt: string;
  decision?: ReviewDecision;
  requestId?: string;
  answeredRoot?: {
    path: string;
    body: string;
    anchors: ReviewAnchor[];
    fingerprint: string;
    rootVersion: number;
  };
}

export interface ReviewThreadPacket {
  version: 1;
  workspaceRoot: string;
  comment: ReviewComment;
  currentFingerprint: string | null;
  acceptedContext: {
    workspaceRoot: string;
    commentId: string;
    rootVersion: number;
    threadRevision: number;
    path: string;
    fingerprint: string | null;
  };
}

export interface ReviewDataResponse {
  version: 1;
  generatedAt: string;
  workspace: WorkspaceResponse;
  comments: ReviewComment[];
}

export interface CommentExportResponse {
  version: 1;
  generatedAt: string;
  workspace: {
    root: string;
    name: string;
    branch: string;
    head: string;
  };
  comments: ReviewComment[];
}

export interface ReviewSettings {
  version: 1;
  /** Unchanged lines shown before and after each changed hunk. */
  diffContextLines: number;
  /** Keyboard interaction vocabulary used by the review surface. */
  keyboardLayout: "normie" | "vim";
}

export interface ChangedFile {
  path: string;
  originalPath?: string;
  name: string;
  directory: string;
  statusCode: string;
  kind: ChangeKind;
  fingerprint: string;
  reviewStatus: ReviewStatus;
  approvedAt?: string;
  binary: boolean;
  generated: boolean;
  commentCount: number;
}

export interface WorkspaceSnapshotSummary {
  id: string;
  approvedAt: string;
  fileCount: number;
  unchangedCount: number;
  changedCount: number;
}

export interface WorkspaceResponse {
  root: string;
  name: string;
  branch: string;
  head: string;
  files: ChangedFile[];
  deferredFiles: ChangedFile[];
  hiddenNoiseCount: number;
  counts: {
    total: number;
    needsReview: number;
    approved: number;
    changed: number;
    comments: number;
  };
  latestSnapshot: WorkspaceSnapshotSummary | null;
  refreshedAt: string;
}

export interface WorkspaceChangeEvent {
  type: "workspace-changed";
  sequence: number;
  observedAt: string;
  /** Workspace-relative paths only. An empty array means the platform did not report a path. */
  paths: string[];
}

export interface DiffResponse {
  schemaVersion: 1;
  path: string;
  diff: string;
  /** Parsed, side-aware lines for local agents and other non-visual consumers. */
  lines: DiffApiLine[];
  language: string;
  fingerprint: string;
  reviewStatus: ReviewStatus;
  approvedAt?: string;
  truncated: boolean;
  stats: {
    additions: number;
    deletions: number;
  };
  comments: ReviewComment[];
}

export interface SnapshotResponse {
  snapshot: WorkspaceSnapshotSummary;
  workspace: WorkspaceResponse;
}

export interface FileApprovalRequest {
  path: string;
  fingerprint: string;
}

export interface FileApprovalResult extends FileApprovalRequest {
  approvedAt: string;
}

export interface FilesApprovalResponse {
  approvedAt: string;
  approvals: FileApprovalResult[];
}
