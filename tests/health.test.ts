import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { buildServer } from "../server/app.js";
import { APP_NAME, HEALTH_STATUS } from "../shared/app-info.js";

const workspaceDir = process.cwd();
let app = buildServer({ workspaceDir });
const fixtureClientDir = fileURLToPath(
  new URL("./fixtures/client", import.meta.url),
);

afterEach(async () => {
  await app.close();
  app = buildServer({ workspaceDir });
});

describe("GET /api/health", () => {
  it("returns the bootstrap health payload", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/health",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      app: APP_NAME,
      status: HEALTH_STATUS,
    });
  });
});

describe("static bootstrap serving", () => {
  it("serves the built shell for the root route", async () => {
    app = buildServer({
      clientDir: fixtureClientDir,
      serveStatic: true,
      workspaceDir,
    });

    const response = await app.inject({
      method: "GET",
      url: "/",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("<title>Fixture Shell</title>");
  });

  it("publishes a local API index instead of falling through to the SPA", async () => {
    app = buildServer({
      clientDir: fixtureClientDir,
      serveStatic: true,
      workspaceDir,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      app: APP_NAME,
      apiVersion: 1,
      localOnly: true,
      openapi: "/api/openapi.json",
      endpoints: {
        events: { method: "GET", path: "/api/events" },
        reviewData: { method: "GET", path: "/api/review" },
        approveFiles: { method: "POST", path: "/api/review/files" },
        exportComments: {
          method: "GET",
          path: "/api/comments/export?format=json|markdown",
        },
      },
    });
  });

  it("publishes a machine-readable contract for structured diffs and anchors", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/openapi.json",
    });
    const document = response.json<{
      paths: Record<string, unknown>;
      components: {
        schemas: {
          Comment: { properties: Record<string, unknown> };
          CreateComment: { properties: Record<string, unknown> };
        };
      };
    }>();

    expect(response.statusCode).toBe(200);
    expect(document).toMatchObject({
      openapi: "3.1.0",
      info: { version: "1.0.0" },
      components: {
        schemas: {
          ReviewAnchor: {
            required: ["side", "startLine", "endLine"],
          },
          Settings: {
            required: [
              "version",
              "diffContextLines",
              "keyboardLayout",
              "theme",
            ],
          },
          CommentExport: {
            required: ["version", "generatedAt", "workspace", "comments"],
          },
          ApproveFiles: {
            required: ["files"],
          },
        },
      },
    });
    expect(
      document.components.schemas.CreateComment.properties,
    ).not.toHaveProperty("lineId");
    expect(document.components.schemas.Comment.properties).not.toHaveProperty(
      "lineNumber",
    );
    expect(document.paths).toMatchObject({
      "/api/settings/theme": {
        put: {
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  required: ["workspaceRoot", "preference"],
                  properties: {
                    preference: {
                      $ref: "#/components/schemas/ThemePreference",
                    },
                  },
                },
              },
            },
          },
        },
        delete: {
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { required: ["workspaceRoot"] },
              },
            },
          },
        },
      },
    });
  });

  it("rejects non-loopback host headers", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: { host: "redline.example.test" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: "Local access only" });
  });

  it("rejects cross-site and form-encoded state mutations", async () => {
    const crossSite = await app.inject({
      method: "POST",
      url: "/api/review/snapshot",
      headers: {
        host: "127.0.0.1:4322",
        origin: "https://attacker.example",
        "content-type": "application/json",
        "sec-fetch-site": "cross-site",
      },
      payload: {},
    });
    expect(crossSite.statusCode).toBe(403);
    expect(crossSite.json()).toMatchObject({ error: "Local mutation only" });

    const formPost = await app.inject({
      method: "POST",
      url: "/api/review/snapshot",
      headers: {
        host: "127.0.0.1:4322",
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: "",
    });
    expect(formPost.statusCode).toBe(415);
    expect(formPost.json()).toMatchObject({ error: "JSON required" });
  });

  it("returns a 404 json payload for missing assets", async () => {
    app = buildServer({
      clientDir: fixtureClientDir,
      serveStatic: true,
      workspaceDir,
    });

    const response = await app.inject({
      method: "GET",
      url: "/assets/missing.js",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: "Not Found",
      message: "Not Found",
      statusCode: 404,
    });
  });
});
