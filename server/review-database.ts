import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync } from "node:fs";
import type {
  ReviewComment,
  ReviewSettings,
} from "../shared/review-contract.js";
import {
  DEFAULT_THEME_PREFERENCE,
  parseThemePreference,
  type ThemePreference,
} from "../shared/theme.js";

type StoredComment = Omit<ReviewComment, "outdated">;

interface CommentRow {
  id: string;
  path: string;
  anchors_json: string;
  body: string;
  created_at: string;
  fingerprint: string;
}

const DEFAULT_CONTEXT_LINES = 3;
const DEFAULT_KEYBOARD_LAYOUT = "normie" as const;

function parseJsonArray<T>(value: string): T[] {
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? (parsed as T[]) : [];
}

function commentFromRow(row: CommentRow): StoredComment {
  return {
    id: row.id,
    path: row.path,
    anchors: parseJsonArray<StoredComment["anchors"][number]>(row.anchors_json),
    body: row.body,
    createdAt: row.created_at,
    fingerprint: row.fingerprint,
  };
}

export class ReviewDatabase {
  private database: DatabaseSync;

  constructor(path: string) {
    this.database = new DatabaseSync(path, {
      enableForeignKeyConstraints: true,
      timeout: 5_000,
    });
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS review_comments (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        anchors_json TEXT NOT NULL,
        body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 4000),
        created_at TEXT NOT NULL,
        fingerprint TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS review_comments_path_created_at
        ON review_comments(path, created_at);
      CREATE TABLE IF NOT EXISTS review_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      PRAGMA user_version = 1;
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
      SELECT id, path, anchors_json, body, created_at, fingerprint
      FROM review_comments
      ORDER BY created_at, id
    `,
      )
      .all() as unknown as CommentRow[];
    return rows.map(commentFromRow);
  }

  commentsForPath(path: string): StoredComment[] {
    const rows = this.database
      .prepare(
        `
      SELECT id, path, anchors_json, body, created_at, fingerprint
      FROM review_comments
      WHERE path = ?
      ORDER BY created_at, id
    `,
      )
      .all(path) as unknown as CommentRow[];
    return rows.map(commentFromRow);
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
      INSERT INTO review_comments (id, path, anchors_json, body, created_at, fingerprint)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        comment.id,
        comment.path,
        JSON.stringify(comment.anchors),
        comment.body,
        comment.createdAt,
        comment.fingerprint,
      );
  }

  deleteComment(id: string) {
    const result = this.database
      .prepare("DELETE FROM review_comments WHERE id = ?")
      .run(id);
    return Number(result.changes) > 0;
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
    const parsed = Number(contextRow?.value ?? DEFAULT_CONTEXT_LINES);
    let theme = DEFAULT_THEME_PREFERENCE;
    try {
      theme =
        parseThemePreference(JSON.parse(themeRow?.value ?? "null")) ??
        DEFAULT_THEME_PREFERENCE;
    } catch {
      theme = DEFAULT_THEME_PREFERENCE;
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
        `
      INSERT INTO review_settings (key, value)
      VALUES ('theme_preference', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `,
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
}
