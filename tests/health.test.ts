import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { buildServer, bundledClientDir } from "../server/app.js";
import { APP_NAME, HEALTH_STATUS } from "../shared/app-info.js";
import { THEME_COLOR_ROLES } from "../shared/theme.js";

let app = buildServer();
const fixtureClientDir = fileURLToPath(
  new URL("./fixtures/client", import.meta.url),
);

afterEach(async () => {
  await app.close();
  app = buildServer();
});

describe("GET /api/health", () => {
  it("resolves production client assets from the package instead of cwd", () => {
    expect(bundledClientDir()).toBe(
      fileURLToPath(new URL("../dist/client", import.meta.url)),
    );
  });
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
    app = buildServer({ clientDir: fixtureClientDir, serveStatic: true });

    const response = await app.inject({
      method: "GET",
      url: "/",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("<title>Fixture Shell</title>");
  });

  it("publishes a local API index instead of falling through to the SPA", async () => {
    app = buildServer({ clientDir: fixtureClientDir, serveStatic: true });

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
          ThemePreference: {
            properties: {
              overrides: { propertyNames: { enum: string[] } };
            };
          };
          Settings: { properties: Record<string, unknown> };
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
              "typography",
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
    expect(
      document.components.schemas.ThemePreference.properties.overrides
        .propertyNames.enum,
    ).toEqual(THEME_COLOR_ROLES);
    expect(document.components.schemas.Settings.properties).toMatchObject({
      typography: { $ref: "#/components/schemas/TypographyPreference" },
    });
    expect(
      document.components.schemas.ThemePreference.properties,
    ).not.toHaveProperty("typography");
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
      "/api/settings/typography": {
        put: {
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  required: ["workspaceRoot", "preference"],
                  properties: {
                    preference: {
                      $ref: "#/components/schemas/TypographyPreference",
                    },
                  },
                },
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

  it.each([
    "/api/review/snapshot",
    "/api/review/defer",
    "/api/review/restore",
    "/api/github/refresh",
    "/api/comments/comment-id/replies",
    "/api/comments/comment-id/reopen",
    "/api/cli/comments",
    "/api/cli/approve/files",
    "/api/cli/approve/workspace",
    "/api/cli/agent/respond/comment-id",
    "/api/cli/agent/reopen/comment-id",
  ])("rejects cross-site and form-encoded mutations at %s", async (url) => {
    const crossSite = await app.inject({
      method: "POST",
      url,
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
      url,
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
    app = buildServer({ clientDir: fixtureClientDir, serveStatic: true });

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
