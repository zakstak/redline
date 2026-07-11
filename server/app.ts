import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_NAME, HEALTH_STATUS } from "../shared/app-info.js";
import { ReviewWorkspace } from "./review-workspace.js";

const reviewAnchorSchema = {
  type: "object",
  additionalProperties: false,
  required: ["side", "startLine", "endLine"],
  properties: {
    side: { type: "string", enum: ["old", "new"] },
    startLine: { type: "integer", minimum: 1 },
    endLine: { type: "integer", minimum: 1 },
  },
} as const;

const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Redline local review API",
    version: "1.0.0",
    description:
      "Loopback-only API for reading a local Git review, adding anchored comments, and approving snapshots.",
  },
  servers: [{ url: "http://127.0.0.1:4322", description: "Local Redline app" }],
  paths: {
    "/api": {
      get: {
        summary: "Discover API endpoints and agent usage guidance",
        responses: { "200": { description: "API index" } },
      },
    },
    "/api/health": {
      get: {
        summary: "Check local server health",
        responses: { "200": { description: "Healthy" } },
      },
    },
    "/api/events": {
      get: {
        summary: "Stream local workspace filesystem changes",
        responses: {
          "200": { description: "Server-sent workspace change events" },
        },
      },
    },
    "/api/workspace": {
      get: {
        summary: "List changed files and their review state",
        parameters: [
          {
            name: "includeNoise",
            in: "query",
            schema: { type: "boolean", default: false },
          },
        ],
        responses: {
          "200": {
            description: "Current workspace",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Workspace" },
              },
            },
          },
        },
      },
    },
    "/api/workspace/open": {
      post: {
        summary: "Open another local Git workspace",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["path"],
                properties: { path: { type: "string" } },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Opened workspace",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Workspace" },
              },
            },
          },
        },
      },
    },
    "/api/settings": {
      get: {
        summary: "Read workspace review settings",
        responses: {
          "200": {
            description: "Review settings",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Settings" },
              },
            },
          },
        },
      },
      put: {
        summary: "Update workspace review settings",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["diffContextLines", "keyboardLayout"],
                properties: {
                  diffContextLines: {
                    type: "integer",
                    minimum: 0,
                    maximum: 20,
                  },
                  keyboardLayout: { type: "string", enum: ["normie", "vim"] },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Updated review settings",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Settings" },
              },
            },
          },
        },
      },
    },
    "/api/settings/theme": {
      put: {
        summary: "Validate and save the active workspace theme",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["workspaceRoot", "preference"],
                properties: {
                  workspaceRoot: { type: "string" },
                  preference: {
                    $ref: "#/components/schemas/ThemePreference",
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Updated workspace settings" },
          "400": { description: "Invalid or stale theme preference" },
        },
      },
      delete: {
        summary: "Delete the active workspace theme preference",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["workspaceRoot"],
                properties: { workspaceRoot: { type: "string" } },
              },
            },
          },
        },
        responses: {
          "200": { description: "Default workspace theme settings" },
          "400": { description: "Stale workspace identity" },
        },
      },
    },
    "/api/diff": {
      get: {
        summary: "Read a raw and structured diff for one changed file",
        parameters: [
          {
            name: "path",
            in: "query",
            required: true,
            schema: { type: "string" },
          },
          {
            name: "context",
            in: "query",
            schema: { type: "integer", minimum: 0, maximum: 20, default: 3 },
          },
        ],
        responses: {
          "200": {
            description: "Diff with stable, side-aware line anchors",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Diff" },
              },
            },
          },
        },
      },
    },
    "/api/review": {
      get: {
        summary: "Read all review state and comments for an agent",
        responses: {
          "200": {
            description: "Versioned review payload",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ReviewData" },
              },
            },
          },
        },
      },
    },
    "/api/comments/export": {
      get: {
        summary: "Export all review comments for a local agent",
        parameters: [
          {
            name: "format",
            in: "query",
            schema: {
              type: "string",
              enum: ["json", "markdown"],
              default: "json",
            },
          },
        ],
        responses: {
          "200": {
            description:
              "Structured comments with stable anchors, or Markdown with code context",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CommentExport" },
              },
              "text/markdown": { schema: { type: "string" } },
            },
          },
        },
      },
    },
    "/api/review/file": {
      post: {
        summary: "Approve the currently loaded bytes of one file",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["path", "fingerprint"],
                properties: {
                  path: { type: "string" },
                  fingerprint: { type: "string", minLength: 1 },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "File approval" },
          "409": { description: "File changed before approval" },
        },
      },
    },
    "/api/review/files": {
      post: {
        summary: "Atomically approve explicit current file fingerprints",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApproveFiles" },
            },
          },
        },
        responses: {
          "200": {
            description: "Atomic file approvals",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/FilesApprovalResponse" },
              },
            },
          },
          "409": {
            description: "At least one file changed, so nothing was approved",
          },
        },
      },
    },
    "/api/review/snapshot": {
      post: {
        summary:
          "Approve all currently reviewable file fingerprints without staging or committing",
        responses: {
          "200": { description: "New snapshot and workspace state" },
        },
      },
    },
    "/api/comments": {
      post: {
        summary: "Add a side-aware comment to one or more diff ranges",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CreateComment" },
            },
          },
        },
        responses: {
          "200": {
            description: "Created comment",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Comment" },
              },
            },
          },
          "409": { description: "The file changed after the diff was loaded" },
        },
      },
    },
    "/api/comments/{id}": {
      delete: {
        summary: "Delete one review comment",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          "204": { description: "Deleted" },
          "404": { description: "Comment not found" },
        },
      },
    },
  },
  components: {
    schemas: {
      ReviewAnchor: reviewAnchorSchema,
      DiffLine: {
        type: "object",
        required: ["id", "type", "content", "oldLine", "newLine", "anchors"],
        properties: {
          id: { type: "string" },
          type: {
            type: "string",
            enum: ["context", "add", "remove", "hunk", "meta"],
          },
          content: { type: "string" },
          oldLine: { type: ["integer", "null"] },
          newLine: { type: ["integer", "null"] },
          anchors: {
            type: "array",
            items: { $ref: "#/components/schemas/ReviewAnchor" },
          },
          noNewline: { type: "boolean" },
        },
      },
      Comment: {
        type: "object",
        required: [
          "id",
          "path",
          "anchors",
          "body",
          "createdAt",
          "fingerprint",
          "outdated",
        ],
        properties: {
          id: { type: "string", format: "uuid" },
          path: { type: "string" },
          anchors: {
            type: "array",
            minItems: 1,
            items: { $ref: "#/components/schemas/ReviewAnchor" },
          },
          body: { type: "string", maxLength: 4000 },
          createdAt: { type: "string", format: "date-time" },
          fingerprint: { type: "string" },
          outdated: { type: "boolean" },
        },
      },
      CreateComment: {
        type: "object",
        additionalProperties: false,
        required: ["path", "fingerprint", "anchors", "body"],
        properties: {
          path: { type: "string" },
          fingerprint: {
            type: "string",
            description: "Fingerprint returned by GET /api/diff",
          },
          anchors: {
            type: "array",
            minItems: 1,
            items: { $ref: "#/components/schemas/ReviewAnchor" },
          },
          body: { type: "string", minLength: 1, maxLength: 4000 },
        },
      },
      FileApprovalRequest: {
        type: "object",
        additionalProperties: false,
        required: ["path", "fingerprint"],
        properties: {
          path: { type: "string", minLength: 1 },
          fingerprint: { type: "string", minLength: 1 },
        },
      },
      FileApprovalResult: {
        type: "object",
        additionalProperties: false,
        required: ["path", "fingerprint", "approvedAt"],
        properties: {
          path: { type: "string" },
          fingerprint: { type: "string" },
          approvedAt: { type: "string", format: "date-time" },
        },
      },
      ApproveFiles: {
        type: "object",
        additionalProperties: false,
        required: ["files"],
        properties: {
          files: {
            type: "array",
            minItems: 1,
            maxItems: 5000,
            items: { $ref: "#/components/schemas/FileApprovalRequest" },
          },
        },
      },
      FilesApprovalResponse: {
        type: "object",
        required: ["approvedAt", "approvals"],
        properties: {
          approvedAt: { type: "string", format: "date-time" },
          approvals: {
            type: "array",
            items: { $ref: "#/components/schemas/FileApprovalResult" },
          },
        },
      },
      ChangedFile: {
        type: "object",
        required: [
          "path",
          "name",
          "directory",
          "kind",
          "fingerprint",
          "reviewStatus",
          "binary",
          "generated",
          "commentCount",
        ],
        properties: {
          path: { type: "string" },
          name: { type: "string" },
          directory: { type: "string" },
          kind: { type: "string" },
          fingerprint: { type: "string" },
          reviewStatus: {
            type: "string",
            enum: ["unreviewed", "approved", "changed"],
          },
          binary: { type: "boolean" },
          generated: { type: "boolean" },
          commentCount: { type: "integer" },
        },
      },
      Workspace: {
        type: "object",
        required: [
          "root",
          "name",
          "branch",
          "head",
          "files",
          "counts",
          "hiddenNoiseCount",
          "latestSnapshot",
          "refreshedAt",
        ],
        properties: {
          root: { type: "string" },
          name: { type: "string" },
          branch: { type: "string" },
          head: { type: "string" },
          files: {
            type: "array",
            items: { $ref: "#/components/schemas/ChangedFile" },
          },
          hiddenNoiseCount: { type: "integer" },
          counts: { type: "object" },
          latestSnapshot: { type: ["object", "null"] },
          refreshedAt: { type: "string", format: "date-time" },
        },
      },
      Diff: {
        type: "object",
        required: [
          "schemaVersion",
          "path",
          "diff",
          "lines",
          "language",
          "fingerprint",
          "reviewStatus",
          "truncated",
          "stats",
          "comments",
        ],
        properties: {
          schemaVersion: { type: "integer", const: 1 },
          path: { type: "string" },
          diff: { type: "string" },
          lines: {
            type: "array",
            items: { $ref: "#/components/schemas/DiffLine" },
          },
          language: { type: "string" },
          fingerprint: { type: "string" },
          reviewStatus: {
            type: "string",
            enum: ["unreviewed", "approved", "changed"],
          },
          truncated: { type: "boolean" },
          stats: { type: "object" },
          comments: {
            type: "array",
            items: { $ref: "#/components/schemas/Comment" },
          },
        },
      },
      ReviewData: {
        type: "object",
        required: ["version", "generatedAt", "workspace", "comments"],
        properties: {
          version: { type: "integer", const: 1 },
          generatedAt: { type: "string", format: "date-time" },
          workspace: { $ref: "#/components/schemas/Workspace" },
          comments: {
            type: "array",
            items: { $ref: "#/components/schemas/Comment" },
          },
        },
      },
      CommentExport: {
        type: "object",
        required: ["version", "generatedAt", "workspace", "comments"],
        properties: {
          version: { type: "integer", const: 1 },
          generatedAt: { type: "string", format: "date-time" },
          workspace: {
            type: "object",
            required: ["root", "name", "branch", "head"],
            properties: {
              root: { type: "string" },
              name: { type: "string" },
              branch: { type: "string" },
              head: { type: "string" },
            },
          },
          comments: {
            type: "array",
            items: { $ref: "#/components/schemas/Comment" },
          },
        },
      },
      Settings: {
        type: "object",
        required: ["version", "diffContextLines", "keyboardLayout", "theme"],
        properties: {
          version: { type: "integer", const: 1 },
          diffContextLines: { type: "integer", minimum: 0, maximum: 20 },
          keyboardLayout: { type: "string", enum: ["normie", "vim"] },
          theme: { $ref: "#/components/schemas/ThemePreference" },
        },
      },
      ThemePreference: {
        type: "object",
        additionalProperties: false,
        required: ["version", "preset", "overrides"],
        properties: {
          version: { type: "integer", const: 1 },
          preset: { type: "string", enum: ["redline", "dusk", "paper"] },
          overrides: {
            type: "object",
            additionalProperties: {
              type: "string",
              pattern: "^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$",
            },
          },
        },
      },
    },
  },
} as const;

function isLoopbackHost(hostHeader: string | undefined) {
  if (!hostHeader) return false;
  const hostname = hostHeader.startsWith("[")
    ? hostHeader.slice(1, hostHeader.indexOf("]"))
    : hostHeader.split(":")[0];
  return (
    hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1"
  );
}

function isLoopbackOrigin(origin: string) {
  try {
    const url = new URL(origin);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      isLoopbackHost(url.host)
    );
  } catch {
    return false;
  }
}

interface BuildServerOptions {
  serveStatic?: boolean;
  clientDir?: string;
  workspaceDir: string;
}

export function buildServer(options: BuildServerOptions): FastifyInstance {
  const app = Fastify({ logger: true });
  const workspace = new ReviewWorkspace(options.workspaceDir);
  app.addHook("onReady", () => workspace.initialize());
  app.addHook("onClose", () => workspace.close());

  const sendError = (reply: FastifyReply, error: unknown, statusCode = 400) => {
    const message =
      error instanceof Error
        ? error.message
        : "The local workspace request failed.";
    return reply
      .status(statusCode)
      .send({ error: "Workspace request failed", message, statusCode });
  };

  app.addHook("onRequest", async (request, reply) => {
    if (!isLoopbackHost(request.headers.host)) {
      return reply.status(403).send({
        error: "Local access only",
        message: "Redline only accepts localhost requests.",
        statusCode: 403,
      });
    }

    if (
      request.method === "GET" ||
      request.method === "HEAD" ||
      request.method === "OPTIONS"
    )
      return;
    const origin = request.headers.origin;
    const fetchSite = request.headers["sec-fetch-site"];
    if (
      (typeof origin === "string" && !isLoopbackOrigin(origin)) ||
      fetchSite === "cross-site"
    ) {
      return reply.status(403).send({
        error: "Local mutation only",
        message: "Cross-site requests cannot change Redline review state.",
        statusCode: 403,
      });
    }
    if (
      (request.method === "POST" ||
        request.method === "PUT" ||
        request.method === "PATCH") &&
      !request.headers["content-type"]
        ?.toLowerCase()
        .startsWith("application/json")
    ) {
      return reply.status(415).send({
        error: "JSON required",
        message: "State-changing requests must use application/json.",
        statusCode: 415,
      });
    }
  });

  app.get("/api/health", () => ({
    app: APP_NAME,
    status: HEALTH_STATUS,
  }));

  app.get("/api", () => ({
    app: APP_NAME,
    apiVersion: 1,
    localOnly: true,
    openapi: "/api/openapi.json",
    agentUsage: {
      readReview: "GET /api/review",
      readDiff: "GET /api/diff?path=<workspace-relative-path>",
      readSettings: "GET /api/settings",
      addComment:
        "POST /api/comments with path, fingerprint from /api/diff, body, and side-aware anchors",
      exportComments: "GET /api/comments/export (JSON) or ?format=markdown",
      anchorContract: {
        side: "old | new",
        startLine: "positive integer",
        endLine: "positive integer",
      },
    },
    endpoints: {
      index: { method: "GET", path: "/api" },
      openapi: { method: "GET", path: "/api/openapi.json" },
      events: { method: "GET", path: "/api/events" },
      workspace: { method: "GET", path: "/api/workspace" },
      openWorkspace: { method: "POST", path: "/api/workspace/open" },
      settings: { method: "GET", path: "/api/settings" },
      updateSettings: { method: "PUT", path: "/api/settings" },
      updateTheme: { method: "PUT", path: "/api/settings/theme" },
      resetTheme: { method: "DELETE", path: "/api/settings/theme" },
      diff: { method: "GET", path: "/api/diff?path=<workspace-relative-path>" },
      reviewData: { method: "GET", path: "/api/review" },
      exportComments: {
        method: "GET",
        path: "/api/comments/export?format=json|markdown",
      },
      approveFile: { method: "POST", path: "/api/review/file" },
      approveFiles: { method: "POST", path: "/api/review/files" },
      approveSnapshot: { method: "POST", path: "/api/review/snapshot" },
      createComment: { method: "POST", path: "/api/comments" },
      deleteComment: { method: "DELETE", path: "/api/comments/:id" },
    },
  }));

  app.get("/api/openapi.json", () => openApiDocument);

  app.get("/api/events", (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.write(
      `retry: 2000\n\nevent: ready\ndata: ${JSON.stringify({ localOnly: true, watching: workspace.isFileWatchActive() })}\n\n`,
    );

    const unsubscribe = workspace.subscribeToChanges((event) => {
      if (!reply.raw.destroyed) {
        reply.raw.write(
          `event: workspace-changed\ndata: ${JSON.stringify(event)}\n\n`,
        );
      }
    });
    const keepAlive = setInterval(() => {
      if (!reply.raw.destroyed) reply.raw.write(": keepalive\n\n");
    }, 15_000);
    keepAlive.unref();
    const cleanup = () => {
      clearInterval(keepAlive);
      unsubscribe();
    };
    request.raw.once("close", cleanup);
    reply.raw.once("error", cleanup);
  });

  app.get("/api/workspace", async (request, reply) => {
    try {
      const query = request.query as { includeNoise?: string };
      return await workspace.getWorkspace(query.includeNoise === "true");
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/api/workspace/open", async (request, reply) => {
    const body = request.body as { path?: unknown };
    if (typeof body?.path !== "string" || !body.path.trim()) {
      return sendError(
        reply,
        new Error("Enter the path to a local Git workspace."),
      );
    }

    try {
      return await workspace.openWorkspace(body.path.trim());
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get("/api/settings", async (_request, reply) => {
    try {
      return await workspace.getSettings();
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.put("/api/settings", async (request, reply) => {
    const body = request.body as {
      diffContextLines?: unknown;
      keyboardLayout?: unknown;
    };
    if (typeof body?.diffContextLines !== "number") {
      return sendError(
        reply,
        new Error("Choose a whole number of unchanged lines from 0 to 20."),
      );
    }
    if (body.keyboardLayout !== "normie" && body.keyboardLayout !== "vim") {
      return sendError(
        reply,
        new Error("Choose Normie or Vim keyboard layout."),
      );
    }
    try {
      return await workspace.updateSettings(
        body.diffContextLines,
        body.keyboardLayout,
      );
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.put("/api/settings/theme", async (request, reply) => {
    const body = request.body as {
      workspaceRoot?: unknown;
      preference?: unknown;
    };
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).some(
        (key) => !["workspaceRoot", "preference"].includes(key),
      ) ||
      typeof body.workspaceRoot !== "string" ||
      !body.workspaceRoot
    ) {
      return sendError(
        reply,
        new Error("Theme updates require the active workspace identity."),
      );
    }
    try {
      return await workspace.updateThemePreference(
        body.workspaceRoot,
        body.preference,
      );
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.delete("/api/settings/theme", async (_request, reply) => {
    const body = _request.body as { workspaceRoot?: unknown };
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => key !== "workspaceRoot") ||
      typeof body.workspaceRoot !== "string" ||
      !body.workspaceRoot
    ) {
      return sendError(
        reply,
        new Error("Theme reset requires the active workspace identity."),
      );
    }
    try {
      return await workspace.deleteThemePreference(body.workspaceRoot);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get("/api/diff", async (request, reply) => {
    const query = request.query as { path?: unknown; context?: unknown };
    if (typeof query.path !== "string" || !query.path) {
      return sendError(
        reply,
        new Error("Choose a changed file to load its diff."),
      );
    }

    try {
      const savedContext = (await workspace.getSettings()).diffContextLines;
      const context =
        typeof query.context === "string"
          ? Number(query.context)
          : savedContext;
      if (!Number.isSafeInteger(context) || context < 0 || context > 20) {
        return sendError(
          reply,
          new Error("Diff context must be a whole number from 0 to 20."),
        );
      }
      return await workspace.getDiff(query.path, context);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/api/review/file", async (request, reply) => {
    const body = request.body as { path?: unknown; fingerprint?: unknown };
    if (
      typeof body?.path !== "string" ||
      !body.path ||
      typeof body.fingerprint !== "string" ||
      !body.fingerprint
    ) {
      return sendError(
        reply,
        new Error(
          "Choose a file and provide its current diff fingerprint before approving it.",
        ),
      );
    }

    try {
      return await workspace.approveFile(body.path, body.fingerprint);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      return sendError(
        reply,
        error,
        message.includes("changed while") ? 409 : 400,
      );
    }
  });

  app.post("/api/review/files", async (request, reply) => {
    const body = request.body as { files?: unknown };
    if (
      !Array.isArray(body?.files) ||
      body.files.length === 0 ||
      body.files.length > 5_000
    ) {
      return sendError(
        reply,
        new Error("Choose between 1 and 5,000 visible files to approve."),
      );
    }
    const files = body.files.flatMap(
      (entry): Array<{ path: string; fingerprint: string }> => {
        if (!entry || typeof entry !== "object") return [];
        const candidate = entry as { path?: unknown; fingerprint?: unknown };
        return typeof candidate.path === "string" &&
          candidate.path.length > 0 &&
          typeof candidate.fingerprint === "string" &&
          candidate.fingerprint.length > 0
          ? [{ path: candidate.path, fingerprint: candidate.fingerprint }]
          : [];
      },
    );
    if (files.length !== body.files.length) {
      return sendError(
        reply,
        new Error(
          "Every visible file needs a path and its current fingerprint.",
        ),
      );
    }

    try {
      return await workspace.approveFiles(files);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const conflict =
        message.includes("Nothing was approved") ||
        message.includes("active workspace changed");
      return sendError(reply, error, conflict ? 409 : 400);
    }
  });

  app.post("/api/review/snapshot", async (_request, reply) => {
    try {
      return await workspace.approveSnapshot();
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get("/api/review", async (_request, reply) => {
    try {
      return await workspace.getReviewData();
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get("/api/comments/export", async (request, reply) => {
    const query = request.query as { format?: unknown };
    const format = query.format ?? "json";
    if (format !== "json" && format !== "markdown") {
      return sendError(
        reply,
        new Error("Comment export format must be json or markdown."),
      );
    }
    try {
      if (format === "markdown") {
        return reply
          .type("text/markdown; charset=utf-8")
          .send(await workspace.getReviewMarkdown());
      }
      return await workspace.getCommentExport();
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/api/comments", async (request, reply) => {
    const body = request.body as {
      path?: unknown;
      anchors?: unknown;
      fingerprint?: unknown;
      body?: unknown;
    };
    const anchors = Array.isArray(body?.anchors)
      ? body.anchors.flatMap(
          (
            anchor,
          ): Array<{
            side: "old" | "new";
            startLine: number;
            endLine: number;
          }> => {
            if (!anchor || typeof anchor !== "object") return [];
            const candidate = anchor as {
              side?: unknown;
              startLine?: unknown;
              endLine?: unknown;
            };
            return (candidate.side === "old" || candidate.side === "new") &&
              typeof candidate.startLine === "number" &&
              typeof candidate.endLine === "number"
              ? [
                  {
                    side: candidate.side,
                    startLine: candidate.startLine,
                    endLine: candidate.endLine,
                  },
                ]
              : [];
          },
        )
      : [];
    if (
      typeof body?.path !== "string" ||
      typeof body.fingerprint !== "string" ||
      anchors.length === 0 ||
      typeof body.body !== "string"
    ) {
      return sendError(
        reply,
        new Error("Choose a diff line and write a comment before saving it."),
      );
    }

    try {
      return await workspace.addComment({
        path: body.path,
        expectedFingerprint: body.fingerprint,
        anchors,
        body: body.body,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      return sendError(
        reply,
        error,
        message.includes("changed while") ? 409 : 400,
      );
    }
  });

  app.delete("/api/comments/:id", async (request, reply) => {
    const params = request.params as { id?: string };
    try {
      await workspace.deleteComment(params.id ?? "");
      return reply.status(204).send();
    } catch (error) {
      return sendError(reply, error, 404);
    }
  });

  const clientDir =
    options.clientDir ??
    fileURLToPath(new URL("../../client", import.meta.url));
  const shouldServeStatic = options.serveStatic ?? existsSync(clientDir);

  if (shouldServeStatic) {
    const assetsDir = resolve(clientDir, "assets");
    const indexHtmlPath = resolve(clientDir, "index.html");

    const sendIndexHtml = async (reply: FastifyReply) => {
      const html = await readFile(indexHtmlPath, "utf8");
      return reply.type("text/html; charset=utf-8").send(html);
    };

    if (existsSync(assetsDir)) {
      app.register(fastifyStatic, {
        root: assetsDir,
        prefix: "/assets/",
      });
    }

    app.get("/", async (_request, reply) => sendIndexHtml(reply));

    app.get("/*", async (request, reply) => {
      const requestPath = request.raw.url ?? "";
      const isApiRoute =
        requestPath === "/api" || requestPath.startsWith("/api/");
      const isAssetRoute =
        requestPath === "/assets" || requestPath.startsWith("/assets/");

      if (isApiRoute || isAssetRoute) {
        return reply.status(404).send({
          error: "Not Found",
          message: "Not Found",
          statusCode: 404,
        });
      }

      return sendIndexHtml(reply);
    });
  }

  return app;
}
