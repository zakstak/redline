import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync } from "node:fs";
import type {
  ReviewComment,
  ReviewDecision,
  ReviewReply,
  ReviewSettings,
  ReviewThreadState,
} from "../shared/review-contract.js";
import {
  DEFAULT_THEME_PREFERENCE,
  parseThemePreference,
  type ThemePreference,
} from "../shared/theme.js";
import {
  DEFAULT_TYPOGRAPHY_PREFERENCE,
  parseTypographyPreference,
  type TypographyPreference,
} from "../shared/typography.js";

type StoredComment = Omit<ReviewComment, "outdated">;

interface CommentRow {
  id: string;
  path: string;
  anchors_json: string;
  body: string;
  created_at: string;
  fingerprint: string;
  state: ReviewThreadState;
  root_version: number;
  thread_revision: number;
  deleted: number;
}

interface ReplyRow {
  id: string;
  comment_id: string;
  actor: "user" | "agent";
  body: string;
  created_at: string;
  decision: ReviewDecision | null;
  request_id: string | null;
  answered_root_json: string | null;
}

const DEFAULT_CONTEXT_LINES = 3;
const DEFAULT_KEYBOARD_LAYOUT = "normie" as const;

function parseJsonArray<T>(value: string): T[] {
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? (parsed as T[]) : [];
}

function replyFromRow(row: ReplyRow): ReviewReply {
  return {
    id: row.id,
    actor: row.actor,
    body: row.body,
    createdAt: row.created_at,
    ...(row.decision ? { decision: row.decision } : {}),
    ...(row.request_id ? { requestId: row.request_id } : {}),
    ...(row.answered_root_json
      ? {
          answeredRoot: JSON.parse(
            row.answered_root_json,
          ) as ReviewReply["answeredRoot"],
        }
      : {}),
  };
}

function commentFromRow(
  row: CommentRow,
  replies: ReviewReply[] = [],
): StoredComment {
  return {
    id: row.id,
    path: row.path,
    anchors: parseJsonArray<StoredComment["anchors"][number]>(row.anchors_json),
    body: row.body,
    createdAt: row.created_at,
    fingerprint: row.fingerprint,
    state: row.state,
    rootVersion: row.root_version,
    threadRevision: row.thread_revision,
    replies,
    ...(row.deleted ? { deleted: true } : {}),
  };
}

export class ReviewDatabase {
  private database: DatabaseSync;

  constructor(path: string) {
    this.database = new DatabaseSync(path, {
      enableForeignKeyConstraints: true,
      timeout: 5_000,
    });
    const schemaVersion = (
      this.database.prepare("PRAGMA user_version").get() as {
        user_version: number;
      }
    ).user_version;
    if (schemaVersion === 1) {
      this.database.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE review_comments ADD COLUMN state TEXT NOT NULL DEFAULT 'pending';
        ALTER TABLE review_comments ADD COLUMN root_version INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE review_comments ADD COLUMN thread_revision INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE review_comments ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0;
        COMMIT;
      `);
    }
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS review_comments (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        anchors_json TEXT NOT NULL,
        body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 4000),
        created_at TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending', 'accepted', 'rejected', 'deferred')),
        root_version INTEGER NOT NULL,
        thread_revision INTEGER NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0, 1))
      ) STRICT;
      CREATE INDEX IF NOT EXISTS review_comments_path_created_at
        ON review_comments(path, created_at);
      CREATE TABLE IF NOT EXISTS review_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS review_replies (
        id TEXT PRIMARY KEY,
        comment_id TEXT NOT NULL REFERENCES review_comments(id),
        actor TEXT NOT NULL CHECK(actor IN ('user', 'agent')),
        body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 4000),
        created_at TEXT NOT NULL,
        decision TEXT CHECK(decision IN ('accepted', 'rejected', 'deferred')),
        request_id TEXT,
        answered_root_json TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS review_replies_comment_created
        ON review_replies(comment_id, created_at, id);
      CREATE TABLE IF NOT EXISTS review_requests (
        scope TEXT NOT NULL,
        request_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        response_json TEXT NOT NULL,
        PRIMARY KEY(scope, request_id)
      ) STRICT;
      PRAGMA user_version = 2;
    `);
    for (const databaseFile of [path, `${path}-wal`, `${path}-shm`]) {
      if (existsSync(databaseFile)) chmodSync(databaseFile, 0o600);
    }
  }

  close() {
    this.database.close();
  }

  allComments(): StoredComment[] {
    const rows = this.database
      .prepare(
        `
      SELECT id, path, anchors_json, body, created_at, fingerprint,
             state, root_version, thread_revision, deleted
      FROM review_comments
      ORDER BY created_at, id
    `,
      )
      .all() as unknown as CommentRow[];
    return rows.map((row) =>
      commentFromRow(row, this.repliesForComment(row.id)),
    );
  }

  commentsForPath(path: string): StoredComment[] {
    const rows = this.database
      .prepare(
        `
      SELECT id, path, anchors_json, body, created_at, fingerprint,
             state, root_version, thread_revision, deleted
      FROM review_comments
      WHERE path = ?
      ORDER BY created_at, id
    `,
      )
      .all(path) as unknown as CommentRow[];
    return rows.map((row) =>
      commentFromRow(row, this.repliesForComment(row.id)),
    );
  }

  commentCountsByPath(): Map<string, number> {
    const rows = this.database
      .prepare(
        `
      SELECT path, COUNT(*) AS count
      FROM review_comments
      GROUP BY path
    `,
      )
      .all() as unknown as Array<{ path: string; count: number }>;
    return new Map(rows.map((row) => [row.path, row.count]));
  }

  insertComment(comment: StoredComment) {
    this.database
      .prepare(
        `
      INSERT INTO review_comments (
        id, path, anchors_json, body, created_at, fingerprint,
        state, root_version, thread_revision, deleted
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        comment.id,
        comment.path,
        JSON.stringify(comment.anchors),
        comment.body,
        comment.createdAt,
        comment.fingerprint,
        comment.state,
        comment.rootVersion,
        comment.threadRevision,
        comment.deleted ? 1 : 0,
      );
  }

  deleteComment(id: string) {
    const hasReplies =
      Number(
        (
          this.database
            .prepare(
              "SELECT COUNT(*) AS count FROM review_replies WHERE comment_id = ?",
            )
            .get(id) as { count: number } | undefined
        )?.count ?? 0,
      ) > 0;
    const result = hasReplies
      ? this.database
          .prepare(
            `UPDATE review_comments
             SET deleted = 1, body = '[deleted]', state = 'deferred',
                 root_version = root_version + 1
             WHERE id = ?`,
          )
          .run(id)
      : this.database
          .prepare("DELETE FROM review_comments WHERE id = ?")
          .run(id);
    return Number(result.changes) > 0;
  }

  private repliesForComment(commentId: string): ReviewReply[] {
    const rows = this.database
      .prepare(
        `
      SELECT id, comment_id, actor, body, created_at, decision, request_id,
             answered_root_json
      FROM review_replies
      WHERE comment_id = ?
      ORDER BY created_at, id
    `,
      )
      .all(commentId) as unknown as ReplyRow[];
    return rows.map(replyFromRow);
  }

  commentById(id: string): StoredComment | null {
    const row = this.database
      .prepare(
        `
      SELECT id, path, anchors_json, body, created_at, fingerprint,
             state, root_version, thread_revision, deleted
      FROM review_comments WHERE id = ?
    `,
      )
      .get(id) as CommentRow | undefined;
    return row ? commentFromRow(row, this.repliesForComment(id)) : null;
  }

  priorResponse(
    scope: string,
    requestId: string,
    requestHash: string,
  ): StoredComment | null {
    const prior = this.database
      .prepare(
        "SELECT request_hash, response_json FROM review_requests WHERE scope = ? AND request_id = ?",
      )
      .get(scope, requestId) as
      | { request_hash: string; response_json: string }
      | undefined;
    if (!prior) return null;
    if (prior.request_hash !== requestHash)
      throw new Error("idempotency_conflict");
    return JSON.parse(prior.response_json) as StoredComment;
  }

  mutateThread(input: {
    commentId: string;
    expectedState: ReviewThreadState;
    expectedRootVersion: number;
    expectedThreadRevision: number;
    requestId: string;
    requestHash: string;
    scope: string;
    reply?: ReviewReply;
    nextState: ReviewThreadState;
  }): StoredComment {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.database
        .prepare(
          "SELECT request_hash, response_json FROM review_requests WHERE scope = ? AND request_id = ?",
        )
        .get(input.scope, input.requestId) as
        | { request_hash: string; response_json: string }
        | undefined;
      if (prior) {
        if (prior.request_hash !== input.requestHash)
          throw new Error("idempotency_conflict");
        this.database.exec("COMMIT");
        return JSON.parse(prior.response_json) as StoredComment;
      }
      const current = this.commentById(input.commentId);
      if (!current) throw new Error("not_found");
      if (current.rootVersion !== input.expectedRootVersion)
        throw new Error("stale_root");
      if (current.threadRevision !== input.expectedThreadRevision)
        throw new Error("stale_thread");
      if (current.state !== input.expectedState)
        throw new Error("invalid_state");
      if (input.reply) {
        this.database
          .prepare(
            `
          INSERT INTO review_replies (
            id, comment_id, actor, body, created_at, decision, request_id,
            answered_root_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
          )
          .run(
            input.reply.id,
            input.commentId,
            input.reply.actor,
            input.reply.body,
            input.reply.createdAt,
            input.reply.decision ?? null,
            input.reply.requestId ?? null,
            input.reply.answeredRoot
              ? JSON.stringify(input.reply.answeredRoot)
              : null,
          );
      }
      this.database
        .prepare(
          `
        UPDATE review_comments
        SET state = ?, thread_revision = thread_revision + 1
        WHERE id = ?
      `,
        )
        .run(input.nextState, input.commentId);
      const response = this.commentById(input.commentId);
      if (!response) throw new Error("not_found");
      this.database
        .prepare(
          `
        INSERT INTO review_requests (scope, request_id, request_hash, response_json)
        VALUES (?, ?, ?, ?)
      `,
        )
        .run(
          input.scope,
          input.requestId,
          input.requestHash,
          JSON.stringify(response),
        );
      this.database.exec("COMMIT");
      return response;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  getSettings(): ReviewSettings {
    const contextRow = this.database
      .prepare(
        "SELECT value FROM review_settings WHERE key = 'diff_context_lines'",
      )
      .get() as { value?: string } | undefined;
    const keyboardRow = this.database
      .prepare(
        "SELECT value FROM review_settings WHERE key = 'keyboard_layout'",
      )
      .get() as { value?: string } | undefined;
    const themeRow = this.database
      .prepare(
        "SELECT value FROM review_settings WHERE key = 'theme_preference'",
      )
      .get() as { value?: string } | undefined;
    const typographyRow = this.database
      .prepare(
        "SELECT value FROM review_settings WHERE key = 'typography_preference'",
      )
      .get() as { value?: string } | undefined;
    const parsed = Number(contextRow?.value ?? DEFAULT_CONTEXT_LINES);
    let theme = DEFAULT_THEME_PREFERENCE;
    try {
      theme =
        parseThemePreference(JSON.parse(themeRow?.value ?? "null")) ??
        DEFAULT_THEME_PREFERENCE;
    } catch {
      theme = DEFAULT_THEME_PREFERENCE;
    }
    let typography = DEFAULT_TYPOGRAPHY_PREFERENCE;
    try {
      typography =
        parseTypographyPreference(JSON.parse(typographyRow?.value ?? "null")) ??
        DEFAULT_TYPOGRAPHY_PREFERENCE;
    } catch {
      typography = DEFAULT_TYPOGRAPHY_PREFERENCE;
    }
    return {
      version: 1,
      diffContextLines:
        Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 20
          ? parsed
          : DEFAULT_CONTEXT_LINES,
      keyboardLayout:
        keyboardRow?.value === "vim" ? "vim" : DEFAULT_KEYBOARD_LAYOUT,
      theme,
      typography,
    };
  }

  updateSettings(
    diffContextLines: number,
    keyboardLayout: ReviewSettings["keyboardLayout"],
  ): ReviewSettings {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const update = this.database.prepare(`
        INSERT INTO review_settings (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `);
      update.run("diff_context_lines", String(diffContextLines));
      update.run("keyboard_layout", keyboardLayout);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getSettings();
  }

  updateThemePreference(theme: ThemePreference): ReviewSettings {
    this.database
      .prepare(
        `INSERT INTO review_settings (key, value) VALUES ('theme_preference', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(JSON.stringify(theme));
    return this.getSettings();
  }

  deleteThemePreference(): ReviewSettings {
    this.database
      .prepare("DELETE FROM review_settings WHERE key = 'theme_preference'")
      .run();
    return this.getSettings();
  }

  updateTypographyPreference(typography: TypographyPreference): ReviewSettings {
    this.database
      .prepare(
        `INSERT INTO review_settings (key, value) VALUES ('typography_preference', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(JSON.stringify(typography));
    return this.getSettings();
  }
}
