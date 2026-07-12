import { expect, test, type Page } from "@playwright/test";
import type {
  DiffResponse,
  ReviewSettings,
  WorkspaceResponse,
} from "../shared/review-contract.js";
import { DEFAULT_THEME_PREFERENCE } from "../shared/theme.js";
import { DEFAULT_TYPOGRAPHY_PREFERENCE } from "../shared/typography.js";

const changedWorkspace: WorkspaceResponse = {
  root: "/home/zack/git/redline",
  name: "redline",
  branch: "main",
  head: "1234567890abcdef",
  files: [
    {
      path: "src/App.tsx",
      name: "App.tsx",
      directory: "src",
      statusCode: " M",
      kind: "modified",
      fingerprint: "app-v2",
      reviewStatus: "changed",
      approvedAt: "2026-07-09T12:00:00.000Z",
      binary: false,
      generated: false,
      commentCount: 0,
    },
    {
      path: "src/styles.css",
      name: "styles.css",
      directory: "src",
      statusCode: " M",
      kind: "modified",
      fingerprint: "styles-v1",
      reviewStatus: "unreviewed",
      binary: false,
      generated: false,
      commentCount: 0,
    },
  ],
  deferredFiles: [],
  hiddenNoiseCount: 3,
  counts: { total: 2, needsReview: 2, approved: 0, changed: 1, comments: 0 },
  latestSnapshot: {
    id: "snapshot-1",
    approvedAt: "2026-07-09T12:00:00.000Z",
    fileCount: 1,
    unchangedCount: 0,
    changedCount: 1,
  },
  refreshedAt: "2026-07-09T13:00:00.000Z",
};

const approvedWorkspace: WorkspaceResponse = {
  ...changedWorkspace,
  files: changedWorkspace.files.map((file) => ({
    ...file,
    reviewStatus: "approved" as const,
    approvedAt: "2026-07-09T13:00:00.000Z",
  })),
  counts: { total: 2, needsReview: 0, approved: 2, changed: 0, comments: 0 },
  latestSnapshot: {
    id: "snapshot-2",
    approvedAt: "2026-07-09T13:00:00.000Z",
    fileCount: 2,
    unchangedCount: 2,
    changedCount: 0,
  },
};

const longFilePath =
  "src/features/review/workspace/components/very-long-directory-name/ReviewWorkspacePaneWithAnIntentionallyLongName.ts";

const layoutWorkspace: WorkspaceResponse = {
  ...changedWorkspace,
  name: "review-automation-with-a-deliberately-long-workspace-name",
  files: [
    ...changedWorkspace.files,
    {
      path: longFilePath,
      name: "ReviewWorkspacePaneWithAnIntentionallyLongName.ts",
      directory:
        "src/features/review/workspace/components/very-long-directory-name",
      statusCode: " M",
      kind: "modified",
      fingerprint: "long-path-v1",
      reviewStatus: "unreviewed",
      binary: false,
      generated: false,
      commentCount: 0,
    },
  ],
  counts: { total: 3, needsReview: 3, approved: 0, changed: 1, comments: 0 },
};

const generatedNoiseFile = {
  path: "generated.min.js",
  name: "generated.min.js",
  directory: "",
  statusCode: "??",
  kind: "untracked" as const,
  fingerprint: "generated-v1",
  reviewStatus: "unreviewed" as const,
  binary: false,
  generated: true,
  commentCount: 0,
};

const diff: DiffResponse = {
  schemaVersion: 1,
  path: "src/App.tsx",
  diff: [
    "diff --git a/src/App.tsx b/src/App.tsx",
    "index 1111111..2222222 100644",
    "--- a/src/App.tsx",
    "+++ b/src/App.tsx",
    "@@ -1,2 +1,2 @@",
    '-export const mode = "old";',
    '+export const mode = "review";',
    " export const local = true;",
  ].join("\n"),
  lines: [
    {
      id: "hunk-1-1",
      type: "hunk",
      content: "@@ -1,2 +1,2 @@",
      oldLine: null,
      newLine: null,
      anchors: [],
    },
    {
      id: "old-1",
      type: "remove",
      content: 'export const mode = "old";',
      oldLine: 1,
      newLine: null,
      anchors: [{ side: "old", startLine: 1, endLine: 1 }],
    },
    {
      id: "new-1",
      type: "add",
      content: 'export const mode = "review";',
      oldLine: null,
      newLine: 1,
      anchors: [{ side: "new", startLine: 1, endLine: 1 }],
    },
    {
      id: "both-2-2",
      type: "context",
      content: "export const local = true;",
      oldLine: 2,
      newLine: 2,
      anchors: [
        { side: "old", startLine: 2, endLine: 2 },
        { side: "new", startLine: 2, endLine: 2 },
      ],
    },
  ],
  language: "typescript",
  fingerprint: "app-v2",
  reviewStatus: "changed",
  approvedAt: "2026-07-09T12:00:00.000Z",
  truncated: false,
  stats: { additions: 1, deletions: 1 },
  comments: [],
};

type DiffPayload =
  | DiffResponse
  | ((url: URL) => DiffResponse | Promise<DiffResponse>);

async function mockReviewApi(
  page: Page,
  diffPayload: DiffPayload = diff,
  diffRequests: string[] = [],
  workspacePayload: WorkspaceResponse = changedWorkspace,
) {
  let settings: ReviewSettings = {
    version: 1,
    diffContextLines: 3,
    keyboardLayout: "normie",
    theme: DEFAULT_THEME_PREFERENCE,
    typography: DEFAULT_TYPOGRAPHY_PREFERENCE,
  };
  await page.route("**/api/workspace?*", (route) => {
    const includeNoise =
      new URL(route.request().url()).searchParams.get("includeNoise") ===
      "true";
    const json = includeNoise
      ? {
          ...workspacePayload,
          files: [...workspacePayload.files, generatedNoiseFile],
          hiddenNoiseCount: 0,
          counts: {
            ...workspacePayload.counts,
            total: workspacePayload.counts.total + 1,
            needsReview: workspacePayload.counts.needsReview + 1,
          },
        }
      : workspacePayload;
    return route.fulfill({ json });
  });
  await page.route("**/api/diff?*", async (route) => {
    diffRequests.push(route.request().url());
    const payload =
      typeof diffPayload === "function"
        ? await diffPayload(new URL(route.request().url()))
        : diffPayload;
    return route.fulfill({ json: payload });
  });
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON() as Pick<
        ReviewSettings,
        "diffContextLines" | "keyboardLayout"
      >;
      settings = {
        ...settings,
        diffContextLines: body.diffContextLines,
        keyboardLayout: body.keyboardLayout,
      };
    }
    return route.fulfill({ json: settings });
  });
  await page.route("**/api/settings/theme", async (route) => {
    const body = route.request().postDataJSON() as {
      preference?: ReviewSettings["theme"];
    } | null;
    settings = {
      ...settings,
      theme:
        route.request().method() === "DELETE"
          ? DEFAULT_THEME_PREFERENCE
          : (body?.preference ?? settings.theme),
    };
    return route.fulfill({ json: settings });
  });
  await page.route("**/api/settings/typography", async (route) => {
    const body = route.request().postDataJSON() as {
      preference: ReviewSettings["typography"];
    };
    settings = { ...settings, typography: body.preference };
    return route.fulfill({ json: settings });
  });
  await page.route("**/api/review/snapshot", (route) =>
    route.fulfill({
      json: {
        snapshot: approvedWorkspace.latestSnapshot,
        workspace: approvedWorkspace,
      },
    }),
  );
  await page.route("**/api/review/file", (route) =>
    route.fulfill({
      json: {
        path: "src/App.tsx",
        fingerprint: "app-v2",
        approvedAt: "2026-07-09T13:00:00.000Z",
      },
    }),
  );
  await page.route("**/api/review/files", (route) =>
    route.fulfill({
      json: {
        approvedAt: "2026-07-09T13:00:00.000Z",
        approvals: workspacePayload.files.map((file) => ({
          path: file.path,
          fingerprint: file.fingerprint,
          approvedAt: "2026-07-09T13:00:00.000Z",
        })),
      },
    }),
  );
}

test("renders local changes and flags files changed since approval", async ({
  page,
}) => {
  await mockReviewApi(page);
  await page.goto("/");

  await expect(page.locator('[data-shell="review-workspace"]')).toBeVisible();
  await expect(page.locator(".topbar")).toHaveCount(0);
  await expect(
    page.getByRole("complementary", { name: "Changed files" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /App\.tsx.*Changed since approval/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: /^Snapshot 2$/ }).click();
  await expect(page.getByText("1 file changed since approval.")).toBeVisible();
  await expect(
    page.getByText("Files and review state stay on this machine."),
  ).toBeVisible();
  await expect(
    page
      .locator('span[style*="--syntax-keyword"]')
      .filter({ hasText: "export" })
      .first(),
  ).toBeVisible();
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
});

test("collapses and restores the review panel", async ({ page }) => {
  await mockReviewApi(page);
  await page.goto("/");

  await expect(page.locator(".diff-view")).toHaveAttribute(
    "data-effective-view",
    "split",
  );
  await page.getByRole("button", { name: /^Snapshot 2$/ }).click();
  await expect(page.getByLabel("Snapshot and comments")).toBeVisible();
  await expect(page.locator(".diff-view")).toHaveAttribute(
    "data-effective-view",
    "split",
  );
  await page.getByRole("button", { name: "Collapse review panel" }).click();
  await expect(page.getByLabel("Snapshot and comments")).toBeHidden();

  await page.keyboard.press("]");
  await expect(page.getByLabel("Snapshot and comments")).toBeVisible();
});

test("collapses and restores the changed files panel", async ({ page }) => {
  await mockReviewApi(page);
  await page.goto("/");

  await expect(page.getByLabel("Changed files", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Collapse changed files panel" })
    .click();
  await expect(page.getByLabel("Changed files", { exact: true })).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Open changed files panel" }),
  ).toBeVisible();

  await page.keyboard.press("[");
  await expect(page.getByLabel("Changed files", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open changed files panel" }),
  ).toHaveCount(0);
});

test("approves a snapshot without staging or committing", async ({ page }) => {
  await mockReviewApi(page);
  await page.goto("/");

  await page.getByRole("button", { name: /^Snapshot 2$/ }).click();
  await page.getByRole("button", { name: /Approve current snapshot/ }).click();

  await expect(page.getByText("Review is current.")).toBeVisible();
  await expect(
    page.getByText("2 approved files remain unchanged."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Does not stage or commit/ }),
  ).toBeVisible();
});

test("atomically approves the current filtered file queue", async ({
  page,
}) => {
  let currentWorkspace = changedWorkspace;
  let submittedFiles: Array<{ path: string; fingerprint: string }> = [];
  await mockReviewApi(page);
  await page.unroute("**/api/workspace?*");
  await page.route("**/api/workspace?*", (route) =>
    route.fulfill({ json: currentWorkspace }),
  );
  await page.unroute("**/api/review/files");
  await page.route("**/api/review/files", (route) => {
    submittedFiles = (
      route.request().postDataJSON() as { files: typeof submittedFiles }
    ).files;
    currentWorkspace = approvedWorkspace;
    return route.fulfill({
      json: {
        approvedAt: "2026-07-09T13:00:00.000Z",
        approvals: submittedFiles.map((file) => ({
          ...file,
          approvedAt: "2026-07-09T13:00:00.000Z",
        })),
      },
    });
  });
  await page.goto("/");

  const batchAction = page.getByRole("button", {
    name: /Approve 2 visible files/,
  });
  await expect(batchAction).toBeVisible();
  await page.getByPlaceholder("Filter files").fill("App");
  await expect(batchAction).toHaveCount(0);
  await page.getByPlaceholder("Filter files").fill("");
  await page.getByRole("button", { name: /Approve 2 visible files/ }).click();

  await expect
    .poll(() => submittedFiles)
    .toEqual([
      { path: "src/App.tsx", fingerprint: "app-v2" },
      { path: "src/styles.css", fingerprint: "styles-v1" },
    ]);
  await expect(page.getByText("2 visible files approved.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Approve 2 visible files/ }),
  ).toHaveCount(0);
  await expect(page.locator("#diff-content")).toBeFocused();
});

test("keeps the visible queue unapproved when one batch fingerprint is stale", async ({
  page,
}) => {
  await mockReviewApi(page);
  await page.unroute("**/api/review/files");
  await page.route("**/api/review/files", (route) =>
    route.fulfill({
      status: 409,
      json: {
        error: "Workspace request failed",
        message:
          "Nothing was approved. 1 file changed while the visible set was open: src/App.tsx. Review it again.",
        statusCode: 409,
      },
    }),
  );
  await page.goto("/");

  await page.getByRole("button", { name: /Approve 2 visible files/ }).click();
  await expect(page.getByText(/Nothing was approved/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: /App\.tsx.*Changed since approval/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /styles\.css.*Needs review/ }),
  ).toBeVisible();
});

test("selects a line range before opening the comment composer", async ({
  page,
}) => {
  await mockReviewApi(page);
  await page.goto("/");

  await page.getByRole("button", { name: "Comment on new line 1" }).click();
  await page
    .getByRole("button", { name: "Comment on new line 2" })
    .last()
    .click({ modifiers: ["Shift"] });

  await expect(
    page
      .locator(".line-selection-toolbar")
      .getByText("2 lines selected (1 to 2)"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(page.getByLabel("2 lines selected (1 to 2)")).toBeVisible();
  await expect(
    page.getByPlaceholder("Leave a local review note"),
  ).toBeFocused();
});

test("creates a comment with C and saves it with the keyboard", async ({
  page,
}) => {
  let submittedBody = "";
  let submittedPayload: Record<string, unknown> = {};
  await mockReviewApi(page);
  await page.route("**/api/comments", (route) => {
    const payload = route.request().postDataJSON() as Record<
      string,
      unknown
    > & { body: string };
    submittedPayload = payload;
    submittedBody = payload.body;
    return route.fulfill({
      json: {
        id: "22222222-2222-4222-8222-222222222222",
        path: "src/App.tsx",
        anchors: [{ side: "new", startLine: 1, endLine: 1 }],
        body: payload.body,
        createdAt: "2026-07-09T13:30:00.000Z",
        fingerprint: "app-v2",
        outdated: false,
      },
    });
  });
  await page.goto("/");

  await page.getByRole("button", { name: "Comment on new line 1" }).focus();
  await page.keyboard.press("c");
  const composer = page.getByPlaceholder("Leave a local review note");
  await expect(composer).toBeFocused();
  await expect(page.locator(".composer-shortcut")).toContainText("saves");
  await composer.fill("Keyboard-only review note");
  await page.keyboard.press("Control+Enter");

  await expect.poll(() => submittedBody).toBe("Keyboard-only review note");
  expect(submittedPayload).toMatchObject({
    anchors: [{ side: "new", startLine: 1, endLine: 1 }],
  });
  expect(submittedPayload).not.toHaveProperty("lineId");
  await expect(page.locator(".comment-composer")).toHaveCount(0);
  await expect(page.locator(".shortcut-guide")).toContainText(
    "Comment on selected lines",
  );
});

test("undoes comment deletion before the server mutation is sent", async ({
  page,
}) => {
  let deleteRequests = 0;
  const comment = {
    id: "44444444-4444-4444-8444-444444444444",
    path: "src/App.tsx",
    anchors: [{ side: "new" as const, startLine: 1, endLine: 1 }],
    body: "Keep this review evidence recoverable.",
    createdAt: "2026-07-09T13:30:00.000Z",
    fingerprint: "app-v2",
    outdated: false,
    state: "pending" as const,
    rootVersion: 1,
    threadRevision: 1,
    replies: [],
  };
  await mockReviewApi(page, { ...diff, comments: [comment] });
  await page.route("**/api/comments/*", (route) => {
    deleteRequests += 1;
    return route.fulfill({ status: 204 });
  });
  await page.goto("/");

  await page.getByRole("button", { name: /^Snapshot 2$/ }).click();
  await expect(page.getByText(comment.body)).toBeVisible();
  await page.getByRole("button", { name: "Delete note" }).click();

  await expect(page.getByRole("button", { name: "Undo" })).toBeFocused();
  await expect(page.getByText(comment.body)).toHaveCount(0);
  expect(deleteRequests).toBe(0);

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText(comment.body)).toBeVisible();
  expect(deleteRequests).toBe(0);
});

test("teaches the first review action once and keeps shortcuts available", async ({
  page,
}) => {
  await mockReviewApi(page);
  await page.goto("/");

  await expect(
    page.getByText("Select line numbers to leave a note."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Got it" }).click();
  await page.reload();
  await expect(
    page.getByText("Select line numbers to leave a note."),
  ).toHaveCount(0);

  await page.getByText("Shortcuts", { exact: true }).click();
  await expect(page.getByText("Go to a visible line")).toBeVisible();
});

test("clears an unsaved comment anchor when the watched file fingerprint changes", async ({
  page,
}) => {
  let currentWorkspace = changedWorkspace;
  let currentDiff = diff;
  await mockReviewApi(page, () => currentDiff);
  await page.unroute("**/api/workspace?*");
  await page.route("**/api/workspace?*", (route) =>
    route.fulfill({ json: currentWorkspace }),
  );
  await page.goto("/");

  await page.getByRole("button", { name: "Comment on new line 1" }).focus();
  await page.keyboard.press("c");
  await page
    .getByPlaceholder("Leave a local review note")
    .fill("Unsaved note on the old bytes");

  currentWorkspace = {
    ...changedWorkspace,
    files: changedWorkspace.files.map((file) =>
      file.path === "src/App.tsx"
        ? { ...file, fingerprint: "app-v3", reviewStatus: "changed" as const }
        : file,
    ),
  };
  currentDiff = {
    ...diff,
    fingerprint: "app-v3",
    diff: '@@ -1,2 +1,2 @@\n-export const mode = "old";\n+export const mode = "newer";\n export const local = true;',
  };
  await page.getByRole("button", { name: "Refresh local changes" }).click();

  await expect(page.locator(".comment-composer")).toHaveCount(0);
  await expect(
    page.getByText(/unsaved comment anchor was cleared/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Comment on new line 1" }),
  ).toBeFocused();
});

test("discards a line selection and draft when approval advances to another file", async ({
  page,
}) => {
  const stylesDiff: DiffResponse = {
    ...diff,
    path: "src/styles.css",
    fingerprint: "styles-v1",
    reviewStatus: "unreviewed",
    approvedAt: undefined,
    language: "css",
    diff: "@@ -1 +1 @@\n-.old { color: red; }\n+.current-styles { color: green; }",
    lines: [],
  };
  await mockReviewApi(page, (url) =>
    url.searchParams.get("path") === "src/styles.css" ? stylesDiff : diff,
  );
  await page.goto("/");

  await page.getByRole("button", { name: "Comment on new line 1" }).click();
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await page
    .getByPlaceholder("Leave a local review note")
    .fill("This belongs only to App.tsx");
  await page.getByRole("button", { name: "Approve file" }).click();

  await expect(
    page
      .locator(".active-file-heading")
      .getByText("styles.css", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".comment-composer")).toHaveCount(0);
  await expect(page.locator(".line-selection-toolbar")).toHaveCount(0);
});

test("uses valid simple-region semantics for the virtualized diff", async ({
  page,
}) => {
  await mockReviewApi(page);
  await page.goto("/");

  await expect(
    page.getByRole("region", { name: "Side by side diff" }),
  ).toBeVisible();
  await expect(page.locator(".diff-view [aria-rowcount]")).toHaveCount(0);
  await expect(
    page.locator('.diff-view [role="row"], .diff-view [role="columnheader"]'),
  ).toHaveCount(0);
});

test("keeps diff navigation local and exposes explicit keyboard shortcuts", async ({
  page,
}) => {
  await mockReviewApi(page);
  await page.goto("/");

  const firstFile = page.getByRole("button", {
    name: /App\.tsx.*Changed since approval/,
  });
  await expect(firstFile).toHaveAttribute("aria-current", "true");

  await page.getByRole("button", { name: "Comment on new line 1" }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(
    page.getByRole("button", { name: "Comment on new line 2" }),
  ).toBeFocused();
  await expect(firstFile).toHaveAttribute("aria-current", "true");

  await page.getByRole("button", { name: "Approve file" }).focus();
  await page.keyboard.press("/");
  await expect(page.getByPlaceholder("Find in diff")).toBeFocused();
  await page.getByPlaceholder("Find in diff").fill("local");
  await expect(page.locator(".diff-search-count")).toHaveText("1/1");
  await expect(page.locator('[data-search-current="true"]')).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByPlaceholder("Find in diff")).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "Comment on new line 2" }),
  ).toBeFocused();

  await page.keyboard.press("g");
  const lineJump = page.getByPlaceholder("Visible line");
  await expect(lineJump).toBeFocused();
  await lineJump.fill("1");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("button", { name: "Comment on new line 1" }),
  ).toBeFocused();

  await page.getByRole("button", { name: "Approve file" }).focus();
  await page.keyboard.press("f");
  await expect(page.getByPlaceholder("Filter files")).toBeFocused();

  await page.getByRole("button", { name: "Approve file" }).focus();
  await page.keyboard.press("]");
  await expect(page.getByLabel("Snapshot and comments")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: /^Snapshot 2$/ }),
  ).toBeFocused();
});

test("returns focus to the new diff after J or K changes files", async ({
  page,
}) => {
  const stylesDiff: DiffResponse = {
    ...diff,
    path: "src/styles.css",
    fingerprint: "styles-v1",
    reviewStatus: "unreviewed",
    approvedAt: undefined,
    language: "css",
    diff: "@@ -1 +1 @@\n-.old { color: red; }\n+.current-styles { color: green; }",
    lines: [],
  };
  await mockReviewApi(page, (url) =>
    url.searchParams.get("path") === "src/styles.css" ? stylesDiff : diff,
  );
  await page.goto("/");

  await page.getByRole("button", { name: "Comment on new line 1" }).focus();
  await page.keyboard.press("j");
  await expect(
    page
      .locator(".active-file-heading")
      .getByText("styles.css", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Comment on new line 1" }),
  ).toBeFocused();
});

test("windows large diffs and jumps search to an offscreen match", async ({
  page,
}) => {
  const body = Array.from(
    { length: 1800 },
    (_, index) =>
      `+export const value${index + 1} = "${index === 1599 ? "needle-near-the-end" : `row-${index + 1}`}";`,
  );
  const largeDiff: DiffResponse = {
    ...diff,
    diff: [
      "diff --git a/src/App.tsx b/src/App.tsx",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/App.tsx",
      "@@ -0,0 +1,1800 @@",
      ...body,
    ].join("\n"),
    lines: [],
    stats: { additions: 1800, deletions: 0 },
  };
  await mockReviewApi(page, largeDiff);
  await page.goto("/");

  await expect(page.locator(".diff-view")).toHaveAttribute(
    "data-effective-view",
    "unified",
  );
  expect(await page.locator(".line-number-button").count()).toBeLessThan(180);
  await page.getByPlaceholder("Find in diff").fill("needle-near-the-end");
  await expect(page.locator(".diff-search-count")).toHaveText("1/1");
  await expect
    .poll(() =>
      page.locator(".diff-scroll").evaluate((element) => element.scrollTop),
    )
    .toBeGreaterThan(20_000);
  await expect(page.getByText("needle-near-the-end")).toBeVisible();
  expect(await page.locator(".line-number-button").count()).toBeLessThan(180);
  await expect(page.locator('.line-number-button[tabindex="0"]')).toHaveCount(
    1,
  );
});

test("ignores a stale diff response after switching files", async ({
  page,
}) => {
  const stylesDiff: DiffResponse = {
    ...diff,
    path: "src/styles.css",
    fingerprint: "styles-v1",
    reviewStatus: "unreviewed",
    approvedAt: undefined,
    language: "css",
    diff: "@@ -1 +1 @@\n-.old { color: red; }\n+.current-styles { color: green; }",
    lines: [],
  };
  await mockReviewApi(page, async (url) => {
    if (url.searchParams.get("path") === "src/App.tsx") {
      await new Promise((resolve) => setTimeout(resolve, 350));
      return diff;
    }
    return stylesDiff;
  });
  await page.goto("/");

  await page.getByRole("button", { name: /styles\.css.*Needs review/ }).click();
  await expect(
    page
      .locator(".active-file-heading")
      .getByText("styles.css", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(".current-styles", { exact: false }),
  ).toBeVisible();
  await page.waitForTimeout(450);
  await expect(
    page.getByText(".current-styles", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText("export const mode", { exact: false }),
  ).toHaveCount(0);
});

test("ignores an old workspace refresh after opening another repository", async ({
  page,
}) => {
  const otherWorkspace: WorkspaceResponse = {
    ...changedWorkspace,
    root: "/tmp/other-repository",
    name: "other-repository",
    files: [
      {
        ...changedWorkspace.files[0],
        path: "lib/other.ts",
        name: "other.ts",
        directory: "lib",
        fingerprint: "other-v1",
        reviewStatus: "unreviewed",
        approvedAt: undefined,
      },
    ],
    counts: { total: 1, needsReview: 1, approved: 0, changed: 0, comments: 0 },
  };
  const otherDiff: DiffResponse = {
    ...diff,
    path: "lib/other.ts",
    fingerprint: "other-v1",
    reviewStatus: "unreviewed",
    approvedAt: undefined,
    diff: "@@ -1 +1 @@\n-export const other = false;\n+export const other = true;",
    lines: [],
  };
  await mockReviewApi(page, (url) =>
    url.searchParams.get("path") === "lib/other.ts" ? otherDiff : diff,
  );
  await page.unroute("**/api/workspace?*");
  let workspaceReads = 0;
  await page.route("**/api/workspace?*", async (route) => {
    workspaceReads += 1;
    if (workspaceReads > 1)
      await new Promise((resolve) => setTimeout(resolve, 400));
    return route.fulfill({ json: changedWorkspace });
  });
  await page.route("**/api/workspace/open", (route) =>
    route.fulfill({ json: otherWorkspace }),
  );
  await page.goto("/");

  await page.getByRole("button", { name: "Refresh local changes" }).click();
  await page.getByRole("button", { name: "Change", exact: true }).click();
  await page.getByLabel("Local path").fill("/tmp/other-repository");
  await page.getByRole("button", { name: "Open", exact: true }).click();

  await expect(
    page.getByRole("heading", { name: "other-repository" }),
  ).toBeVisible();
  await expect(
    page.locator(".active-file-heading").getByText("other.ts", { exact: true }),
  ).toBeVisible();
  await page.waitForTimeout(500);
  await expect(
    page.getByRole("heading", { name: "other-repository" }),
  ).toBeVisible();
  await expect(page.getByText("App.tsx", { exact: true })).toHaveCount(0);
});

test("reloads diff comments when repositories share the same path and fingerprint", async ({
  page,
}) => {
  let opened = false;
  const firstDiff: DiffResponse = {
    ...diff,
    comments: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        path: "src/App.tsx",
        anchors: [{ side: "new", startLine: 1, endLine: 1 }],
        body: "Only in the first repository",
        createdAt: "2026-07-09T12:30:00.000Z",
        fingerprint: "app-v2",
        outdated: false,
        state: "pending",
        rootVersion: 1,
        threadRevision: 1,
        replies: [],
      },
    ],
  };
  const secondDiff: DiffResponse = { ...diff, comments: [] };
  const secondWorkspace: WorkspaceResponse = {
    ...changedWorkspace,
    root: "/tmp/equivalent-repository",
    name: "equivalent-repository",
  };
  await mockReviewApi(page, () => (opened ? secondDiff : firstDiff));
  await page.route("**/api/workspace/open", (route) => {
    opened = true;
    return route.fulfill({ json: secondWorkspace });
  });
  await page.goto("/");

  await page.getByRole("button", { name: /^Snapshot 2$/ }).click();
  await expect(page.getByText("Only in the first repository")).toBeVisible();
  await page.getByRole("button", { name: "Change", exact: true }).click();
  await page.getByLabel("Local path").fill("/tmp/equivalent-repository");
  await page.getByRole("button", { name: "Open", exact: true }).click();

  await expect(
    page.getByRole("heading", { name: "equivalent-repository" }),
  ).toBeVisible();
  await expect(page.getByText("Only in the first repository")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "0 on this file" }),
  ).toBeVisible();
});

test("keeps stale comments as history without attaching them to current lines", async ({
  page,
}) => {
  const staleDiff: DiffResponse = {
    ...diff,
    comments: [
      {
        id: "33333333-3333-4333-8333-333333333333",
        path: "src/App.tsx",
        anchors: [{ side: "new", startLine: 1, endLine: 1 }],
        body: "This was written against an older fingerprint.",
        createdAt: "2026-07-09T12:30:00.000Z",
        fingerprint: "app-v1",
        outdated: true,
        state: "pending",
        rootVersion: 1,
        threadRevision: 1,
        replies: [],
      },
    ],
  };
  await mockReviewApi(page, staleDiff);
  await page.goto("/");

  await page.getByRole("button", { name: /^Snapshot 2$/ }).click();
  await expect(page.getByText("Stale anchor")).toBeVisible();
  await expect(page.getByText("Was New line 1")).toBeVisible();
  await expect(
    page.getByText(/not attached to the current line/),
  ).toBeVisible();
  await expect(page.locator(".line-comment-count")).toHaveCount(0);
});

const layoutMatrix = [
  { width: 1440, height: 900, maxRailWidth: 216, overlay: false },
  { width: 900, height: 700, maxRailWidth: 208, overlay: false },
  { width: 768, height: 900, maxRailWidth: 240, overlay: true },
  { width: 720, height: 450, maxRailWidth: 240, overlay: true },
] as const;

for (const matrixCase of layoutMatrix) {
  test(`contains the compact file rail at ${matrixCase.width}x${matrixCase.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(matrixCase);
    await mockReviewApi(page, diff, [], layoutWorkspace);
    await page.goto("/");
    if (matrixCase.overlay)
      await page
        .getByRole("button", { name: "Open changed files panel" })
        .click();

    const rail = page.getByLabel("Changed files", { exact: true });
    const [railBox, headerBox, footerBox, searchBox, diffBox] =
      await Promise.all([
        rail.boundingBox(),
        page.locator(".workspace-identity").boundingBox(),
        page.locator(".rail-footer").boundingBox(),
        page.getByPlaceholder("Filter files").boundingBox(),
        page.locator(".diff-workspace").boundingBox(),
      ]);

    expect(railBox?.width).toBeLessThanOrEqual(matrixCase.maxRailWidth);
    expect(headerBox?.height).toBeLessThanOrEqual(76);
    expect(footerBox?.height).toBeLessThanOrEqual(92);
    expect(
      await rail.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(matrixCase.width);
    expect(
      railBox &&
        searchBox &&
        searchBox.x >= railBox.x &&
        searchBox.x + searchBox.width <= railBox.x + railBox.width,
    ).toBe(true);
    if (matrixCase.overlay) {
      expect(
        await page
          .locator(".diff-workspace")
          .evaluate((element) => (element as HTMLElement).inert),
      ).toBe(true);
    } else {
      expect(railBox && diffBox && diffBox.x >= railBox.x + railBox.width).toBe(
        true,
      );
    }

    if (matrixCase.height === 450) {
      await page.getByText("Shortcuts", { exact: true }).click();
      const shortcutsBox = await page
        .getByLabel("Keyboard shortcuts")
        .boundingBox();
      expect(
        railBox &&
          shortcutsBox &&
          shortcutsBox.x >= railBox.x &&
          shortcutsBox.x + shortcutsBox.width <= railBox.x + railBox.width &&
          shortcutsBox.y >= 0 &&
          shortcutsBox.y + shortcutsBox.height <= matrixCase.height,
      ).toBe(true);
      expect(
        (await page.locator(".rail-footer").boundingBox())?.height,
      ).toBeLessThanOrEqual(92);
    }
  });
}

test("discloses a complete long path on keyboard focus without widening the rail", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await mockReviewApi(page, diff, [], layoutWorkspace);
  await page.goto("/");

  const longRow = page.getByRole("button", {
    name: new RegExp(longFilePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  });
  await expect(longRow).toBeVisible();
  expect(await longRow.getAttribute("aria-label")).toContain(longFilePath);
  const railWidth = await page
    .getByLabel("Changed files", { exact: true })
    .evaluate((element) => element.clientWidth);
  expect(await longRow.evaluate((element) => element.clientWidth)).toBeLessThan(
    railWidth,
  );

  await longRow.focus();
  await expect(longRow.locator(".file-focus-path")).toHaveText(longFilePath);
  await expect(longRow.locator(".file-focus-path")).toBeVisible();

  await page.keyboard.press("f");
  await page.getByPlaceholder("Filter files").fill("styles");
  await expect(page.getByRole("button", { name: /styles\.css/ })).toBeVisible();
  await page.getByPlaceholder("Filter files").fill("");
  await longRow.focus();
  await page.keyboard.press("j");
  await expect(
    page.getByRole("button", { name: /styles\.css/ }),
  ).toHaveAttribute("aria-current", "true");
});

test("keeps review-noise visibility session-only in Settings and restores trigger focus", async ({
  page,
}) => {
  await page.setViewportSize({ width: 768, height: 900 });
  const workspaceRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/workspace?"))
      workspaceRequests.push(request.url());
  });
  await mockReviewApi(page, diff, [], layoutWorkspace);
  await page.goto("/");
  await page.getByRole("button", { name: "Open changed files panel" }).click();
  await page.locator(".settings-nav-button").click();

  const noiseToggle = page.getByRole("checkbox", { name: /Show review noise/ });
  await expect(noiseToggle).not.toBeChecked();
  await noiseToggle.check();
  await expect
    .poll(() =>
      workspaceRequests.some((url) => url.includes("includeNoise=true")),
    )
    .toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.locator(".settings-nav-button")).toBeFocused();
  await expect(
    page.getByRole("button", { name: /generated\.min\.js/ }),
  ).toBeVisible();

  await page.locator(".settings-nav-button").click();
  await expect(noiseToggle).toBeChecked();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    768,
  );
  expect(
    await page
      .locator(".settings-shell")
      .evaluate((element) => element.scrollHeight > element.clientHeight),
  ).toBe(true);
  const saveButton = page.getByRole("button", { name: "Save settings" });
  await saveButton.scrollIntoViewIfNeeded();
  const saveBox = await saveButton.boundingBox();
  expect(saveBox && saveBox.y >= 0 && saveBox.y + saveBox.height <= 900).toBe(
    true,
  );
  await page.keyboard.press("Escape");
  await page.reload();
  await page.getByRole("button", { name: "Open changed files panel" }).click();
  await page.locator(".settings-nav-button").click();
  await expect(
    page.getByRole("checkbox", { name: /Show review noise/ }),
  ).not.toBeChecked();
});

test("preserves a retryable typography change when review noise is toggled", async ({
  page,
}) => {
  await mockReviewApi(page);
  let settingsReads = 0;
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() === "GET") settingsReads += 1;
    return route.fallback();
  });
  await page.route("**/api/settings/typography", (route) =>
    route.fulfill({ status: 500, json: { message: "injected" } }),
  );
  await page.goto("/");
  await page.locator(".settings-nav-button").click();
  await page.getByRole("button", { name: "Decrease code text size" }).click();
  await expect(page.getByRole("alert")).toContainText("unsaved");
  await expect(
    page.locator(".typography-size-control output").last(),
  ).toContainText("15 px");

  await page.getByRole("checkbox", { name: /Show review noise/ }).check();

  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(
    page.locator(".typography-size-control output").last(),
  ).toContainText("15 px");
  expect(settingsReads).toBe(1);
});

test("includes each file's nonzero comment count in its accessible name", async ({
  page,
}) => {
  const workspaceWithComments: WorkspaceResponse = {
    ...changedWorkspace,
    files: changedWorkspace.files.map((file, index) =>
      index === 0 ? { ...file, commentCount: 2 } : file,
    ),
    counts: { ...changedWorkspace.counts, comments: 2 },
  };
  await mockReviewApi(page, diff, [], workspaceWithComments);
  await page.goto("/");

  await expect(
    page.getByRole("button", { name: /src\/App\.tsx.*2 comments/ }),
  ).toBeVisible();
});

for (const contextCase of [
  { width: 1440, height: 900, layout: "split" },
  { width: 720, height: 450, layout: "unified" },
  { width: 360, height: 700, layout: "unified" },
] as const) {
  test(`keeps the ${contextCase.layout} context control unobscured at ${contextCase.width}x${contextCase.height}`, async ({
    page,
  }) => {
    const diffRequests: string[] = [];
    await page.setViewportSize(contextCase);
    await mockReviewApi(page, diff, diffRequests, layoutWorkspace);
    await page.goto("/");
    const expectedRegion =
      contextCase.layout === "split" ? "Side by side diff" : "Unified diff";
    await expect(
      page.getByRole("region", { name: expectedRegion }),
    ).toBeVisible();
    const hunk = page.locator(".diff-hunk-line").first();
    const label = hunk.locator(":scope > span");
    const control = page
      .getByRole("button", { name: "Show more context" })
      .first();
    const scroller = page.locator(".diff-scroll");
    const [hunkBox, labelBox, controlBox, scrollerBox] = await Promise.all([
      hunk.boundingBox(),
      label.boundingBox(),
      control.boundingBox(),
      scroller.boundingBox(),
    ]);
    expect(
      hunkBox &&
        controlBox &&
        controlBox.y >= hunkBox.y &&
        controlBox.y + controlBox.height <= hunkBox.y + hunkBox.height,
    ).toBe(true);
    expect(
      labelBox && controlBox && labelBox.x + labelBox.width <= controlBox.x,
    ).toBe(true);
    expect(
      scrollerBox &&
        controlBox &&
        controlBox.x >= scrollerBox.x &&
        controlBox.x + controlBox.width <= scrollerBox.x + scrollerBox.width,
    ).toBe(true);

    if (contextCase.width <= 720) {
      await scroller.evaluate((element) => {
        element.scrollLeft = element.scrollWidth;
      });
      const [scrolledControlBox, scrolledScrollerBox] = await Promise.all([
        control.boundingBox(),
        scroller.boundingBox(),
      ]);
      expect(
        scrolledControlBox &&
          scrolledScrollerBox &&
          scrolledControlBox.x >= scrolledScrollerBox.x &&
          scrolledControlBox.x + scrolledControlBox.width <=
            scrolledScrollerBox.x + scrolledScrollerBox.width,
      ).toBe(true);
    }

    await control.focus();
    await expect(control).toBeFocused();
    await control.click();
    await expect
      .poll(() => diffRequests.some((url) => url.includes("context=8")))
      .toBe(true);
  });
}

test("uses an overlay file drawer without clipping the tablet workspace", async ({
  page,
}) => {
  await page.setViewportSize({ width: 768, height: 720 });
  await mockReviewApi(page);
  await page.goto("/");

  await expect(page.getByLabel("Changed files", { exact: true })).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Open changed files panel" }),
  ).toBeVisible();
  await expect(page.locator(".diff-scroll")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    768,
  );

  await page.getByRole("button", { name: "Open changed files panel" }).click();
  await expect(page.getByLabel("Changed files", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Close changed files panel" }),
  ).toBeVisible();
  await expect(page.getByPlaceholder("Filter files")).toBeFocused();
  expect(
    await page
      .locator(".diff-workspace")
      .evaluate((element) => (element as HTMLElement).inert),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.getByLabel("Changed files", { exact: true })).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Open changed files panel" }),
  ).toBeFocused();

  await page.getByRole("button", { name: "Open changed files panel" }).click();
  await page.getByRole("button", { name: /styles\.css.*Needs review/ }).click();
  await expect(page.getByLabel("Changed files", { exact: true })).toBeHidden();
  await expect(
    page
      .locator(".active-file-heading")
      .getByText("styles.css", { exact: true }),
  ).toBeVisible();
});

test("treats the tablet review panel as a focus-managed overlay", async ({
  page,
}) => {
  await page.setViewportSize({ width: 768, height: 720 });
  await mockReviewApi(page);
  await page.goto("/");

  await page.getByRole("button", { name: /^Snapshot 2$/ }).click();
  const panel = page.getByLabel("Snapshot and comments");
  await expect(panel).toBeVisible();
  await expect(panel).toBeFocused();
  await expect(panel).toHaveAttribute("aria-modal", "true");
  expect(
    await page
      .locator(".diff-workspace")
      .evaluate((element) => (element as HTMLElement).inert),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(
    page.getByRole("button", { name: /^Snapshot 2$/ }),
  ).toBeFocused();
});

test("saves workspace diff context from the Settings page", async ({
  page,
}) => {
  const diffRequests: string[] = [];
  await mockReviewApi(page, diff, diffRequests);
  await page.goto("/");

  await page.locator(".settings-nav-button").click();
  await expect(page.locator('[data-shell="settings"]')).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Set how the review surface behaves." }),
  ).toBeVisible();
  await expect(
    page.getByText(".git/redline/review.sqlite", { exact: false }),
  ).toBeVisible();

  await page
    .getByRole("group", { name: "Common context line values" })
    .getByRole("button", { name: "8" })
    .click();
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(
    page.getByText("Saved for this workspace.", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => diffRequests.some((url) => url.includes("context=8")))
    .toBe(true);

  await page.keyboard.press("Escape");
  await expect(page.locator('[data-shell="review-workspace"]')).toBeVisible();
  await expect(page.locator(".settings-nav-button")).toContainText(
    "Normie · 8 lines",
  );
});

test("hot-applies and autosaves a workspace theme without reloading", async ({
  page,
}) => {
  const themeRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/settings/theme"))
      themeRequests.push(request.method());
  });
  await mockReviewApi(page);
  await page.goto("/");

  await page.locator(".settings-nav-button").click();
  await page.getByRole("radio", { name: /Dusk/ }).click();

  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue("--canvas")
          .trim(),
      ),
    )
    .toBe("#1d1917");
  await expect(page.getByText("Theme saved for this workspace.")).toBeVisible();
  expect(themeRequests).toEqual(["PUT"]);
});

test("preserves a pending theme while unrelated settings are acknowledged", async ({
  page,
}) => {
  await mockReviewApi(page);
  await page.goto("/");
  await page.locator(".settings-nav-button").click();
  await page.getByRole("radio", { name: /Dusk/ }).click();
  await page
    .getByRole("group", { name: "Common context line values" })
    .getByRole("button", { name: "8" })
    .click();
  await page.getByRole("button", { name: "Save settings" }).click();

  expect(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue("--canvas")
        .trim(),
    ),
  ).toBe("#1d1917");
  await expect(page.getByText("Theme saved for this workspace.")).toBeVisible();
});

test("keeps an invalid color draft protected until the palette is valid", async ({
  page,
}) => {
  let themeUpdates = 0;
  page.on("request", (request) => {
    if (
      request.url().endsWith("/api/settings/theme") &&
      request.method() === "PUT"
    )
      themeUpdates += 1;
  });
  await mockReviewApi(page);
  await page.goto("/");
  await page.locator(".settings-nav-button").click();
  await page.getByText("Customize semantic colors").click();

  await page.getByLabel("on accent").fill("#ff7b87");
  await expect(page.getByRole("alert")).toContainText("Draft not applied");
  expect(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue("--on-accent")
        .trim(),
    ),
  ).toBe("#191a1f");
  expect(themeUpdates).toBe(0);

  await page.getByLabel("on accent").fill("#191a1f");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => ({
        accent: getComputedStyle(document.documentElement)
          .getPropertyValue("--accent")
          .trim(),
        onAccent: getComputedStyle(document.documentElement)
          .getPropertyValue("--on-accent")
          .trim(),
      })),
    )
    .toEqual({ accent: "#ff7b87", onAccent: "#191a1f" });
  await expect(page.getByText("Theme saved for this workspace.")).toBeVisible();
  expect(themeUpdates).toBe(1);
});

test("preserves an invalid draft when an earlier theme save is acknowledged", async ({
  page,
}) => {
  await mockReviewApi(page);
  let releaseUpdate: (() => void) | undefined;
  let updateStarted = false;
  await page.route("**/api/settings/theme", async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    updateStarted = true;
    await new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    const body = route.request().postDataJSON() as {
      preference: ReviewSettings["theme"];
    };
    return route.fulfill({
      json: {
        version: 1,
        diffContextLines: 3,
        keyboardLayout: "normie",
        theme: body.preference,
        typography: DEFAULT_TYPOGRAPHY_PREFERENCE,
      },
    });
  });
  await page.goto("/");
  await page.locator(".settings-nav-button").click();
  await page
    .getByRole("group", { name: "Common context line values" })
    .getByRole("button", { name: "8" })
    .click();
  await page.getByRole("radio", { name: /Dusk/ }).click();
  await expect.poll(() => updateStarted).toBe(true);
  await page.getByText("Customize semantic colors").click();
  const input = page.getByLabel("on accent");
  await input.fill("not-a-color");
  await expect(page.getByRole("alert")).toContainText("Draft not applied");
  releaseUpdate?.();
  await expect(page.getByText("Theme saved for this workspace.")).toBeVisible();
  await expect(input).toHaveValue("not-a-color");
});

test("clears an invalid theme draft when the workspace theme is reset", async ({
  page,
}) => {
  await mockReviewApi(page);
  await page.goto("/");
  await page.locator(".settings-nav-button").click();
  await page
    .getByRole("group", { name: "Common context line values" })
    .getByRole("button", { name: "8" })
    .click();
  await page.getByRole("radio", { name: /Vim/ }).click();
  await page.getByText("Customize semantic colors").click();
  await page.getByLabel("on accent").fill("not-a-color");
  await expect(page.getByRole("alert")).toContainText("Draft not applied");

  await page.getByRole("button", { name: "Reset workspace theme" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(
    page
      .getByRole("group", { name: "Common context line values" })
      .getByRole("button", { name: "8" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("radio", { name: /Vim/ })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await page.getByText("Customize semantic colors").click();
  await expect(page.getByLabel("on accent")).toHaveValue("#191a1f");
});

test("resets the acknowledged workspace theme and keeps recovery controls protected on a phone", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await mockReviewApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Open changed files panel" }).click();
  await page.locator(".settings-nav-button").click();
  await page.getByRole("radio", { name: /Paper/ }).click();
  await expect(page.getByText("Theme saved for this workspace.")).toBeVisible();

  const reset = page.getByRole("button", { name: "Reset workspace theme" });
  await expect(reset).toBeVisible();
  await reset.focus();
  await expect(reset).toBeFocused();
  expect(
    await reset.evaluate((element) => getComputedStyle(element).color),
  ).toBe("rgb(255, 123, 135)");
  await reset.click();
  await expect(page.getByText("Theme saved for this workspace.")).toBeVisible();
  await page.reload();
  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue("--canvas")
          .trim(),
      ),
    )
    .toBe("#191a1f");
});

test("keeps a failed theme update retryable and never reports false success", async ({
  page,
}) => {
  await mockReviewApi(page);
  let attempts = 0;
  await page.route("**/api/settings/theme", async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    attempts += 1;
    if (attempts === 1)
      return route.fulfill({ status: 503, json: { message: "Try again." } });
    const body = route.request().postDataJSON() as {
      preference: ReviewSettings["theme"];
    };
    return route.fulfill({
      json: {
        version: 1,
        diffContextLines: 3,
        keyboardLayout: "normie",
        theme: body.preference,
        typography: DEFAULT_TYPOGRAPHY_PREFERENCE,
      },
    });
  });
  await page.goto("/");
  await page.locator(".settings-nav-button").click();
  await page
    .getByRole("group", { name: "Common context line values" })
    .getByRole("button", { name: "8" })
    .click();
  await page.getByRole("radio", { name: /Dusk/ }).click();

  await expect(
    page.getByText("Theme is applied locally but not saved."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Retry save" }).click();
  await expect(page.getByText("Theme saved for this workspace.")).toBeVisible();
  expect(attempts).toBe(2);
});

test("discards a non-retryable rejected theme operation", async ({ page }) => {
  await mockReviewApi(page);
  let attempts = 0;
  await page.route("**/api/settings/theme", async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    attempts += 1;
    return route.fulfill({
      status: 400,
      json: { message: "The active workspace changed." },
    });
  });
  await page.goto("/");
  await page.locator(".settings-nav-button").click();
  await page
    .getByRole("group", { name: "Common context line values" })
    .getByRole("button", { name: "8" })
    .click();
  await page.getByRole("radio", { name: /Dusk/ }).click();

  await expect(
    page.getByText("Theme was rejected by the server and was not saved."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry save" })).toHaveCount(0);
  await expect(
    page
      .getByRole("group", { name: "Common context line values" })
      .getByRole("button", { name: "8" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue("--canvas")
          .trim(),
      ),
    )
    .toBe("#191a1f");
  expect(attempts).toBe(1);
});

test("keeps the default fallback after a new workspace settings load fails", async ({
  page,
}) => {
  await mockReviewApi(page);
  let settingsLoads = 0;
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    settingsLoads += 1;
    if (settingsLoads > 1)
      return route.fulfill({
        status: 500,
        json: { message: "Settings are temporarily unavailable." },
      });
    return route.fulfill({
      json: {
        version: 1,
        diffContextLines: 3,
        keyboardLayout: "normie",
        theme: { version: 1, preset: "dusk", overrides: {} },
        typography: {
          ...DEFAULT_TYPOGRAPHY_PREFERENCE,
          uiFont: "serif",
        },
      },
    });
  });
  await page.route("**/api/workspace/open", (route) =>
    route.fulfill({
      json: {
        ...changedWorkspace,
        root: "/home/zack/git/another-workspace",
        name: "another-workspace",
      },
    }),
  );
  await page.route("**/api/settings/theme", (route) =>
    route.fulfill({
      status: 400,
      json: { message: "The active workspace changed." },
    }),
  );
  await page.route("**/api/settings/typography", (route) =>
    route.fulfill({
      status: 400,
      json: { message: "The active workspace changed." },
    }),
  );
  await page.goto("/");
  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue("--canvas")
          .trim(),
      ),
    )
    .toBe("#1d1917");

  await page.getByRole("button", { name: "Change", exact: true }).click();
  await page.getByLabel("Local path").fill("/home/zack/git/another-workspace");
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(
    page.getByText("another-workspace", { exact: true }),
  ).toBeVisible();
  await page.locator(".settings-nav-button").click();
  await page.getByLabel("Interface font").selectOption("humanist");
  await expect(page.getByRole("alert")).toContainText("rejected by the server");
  await expect(page.getByLabel("Interface font")).toHaveValue("system");
  await page.getByRole("radio", { name: /Paper/ }).click();
  await expect(
    page.getByText("Theme was rejected by the server and was not saved."),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue("--canvas")
          .trim(),
      ),
    )
    .toBe("#191a1f");
});

test("does not let a stale settings save overwrite newer appearance choices", async ({
  page,
}) => {
  await mockReviewApi(page);
  let releaseSettings: (() => void) | undefined;
  let releaseTypography: (() => void) | undefined;
  let settingsStarted = false;
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    settingsStarted = true;
    await new Promise<void>((resolve) => {
      releaseSettings = resolve;
    });
    return route.fulfill({
      json: {
        version: 1,
        diffContextLines: 8,
        keyboardLayout: "normie",
        theme: DEFAULT_THEME_PREFERENCE,
        typography: DEFAULT_TYPOGRAPHY_PREFERENCE,
      },
    });
  });
  await page.route("**/api/settings/typography", async (route) => {
    const body = route.request().postDataJSON() as {
      preference: ReviewSettings["typography"];
    };
    await new Promise<void>((resolve) => {
      releaseTypography = resolve;
    });
    return route.fulfill({
      json: {
        version: 1,
        diffContextLines: 8,
        keyboardLayout: "normie",
        theme: DEFAULT_THEME_PREFERENCE,
        typography: body.preference,
      },
    });
  });
  await page.goto("/");
  await page.locator(".settings-nav-button").click();
  await page
    .getByRole("group", { name: "Common context line values" })
    .getByRole("button", { name: "8" })
    .click();
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect.poll(() => settingsStarted).toBe(true);
  await page.getByRole("radio", { name: /Paper/ }).click();
  await expect(page.getByText("Theme saved for this workspace.")).toBeVisible();
  await page.getByLabel("Interface font").selectOption("humanist");
  await expect.poll(() => releaseTypography !== undefined).toBe(true);
  releaseSettings?.();
  await expect(page.getByText("Saved for this workspace.")).toBeVisible();
  await expect(page.getByLabel("Interface font")).toHaveValue("humanist");
  releaseTypography?.();
  await expect(
    page.getByText("Typography saved for this workspace."),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue("--canvas")
          .trim(),
      ),
    )
    .toBe("#f4f2ee");
});

test("lets workspace reset supersede a debounced theme update", async ({
  page,
}) => {
  const methods: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/settings/theme"))
      methods.push(request.method());
  });
  await mockReviewApi(page);
  await page.goto("/");
  await page.locator(".settings-nav-button").click();
  await page.getByRole("radio", { name: /Dusk/ }).click();
  await page.getByRole("button", { name: "Reset workspace theme" }).click();

  await expect(page.getByText("Theme saved for this workspace.")).toBeVisible();
  await page.waitForTimeout(600);
  expect(methods).toEqual(["DELETE"]);
  expect(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue("--canvas")
        .trim(),
    ),
  ).toBe("#191a1f");
});

test("does not reapply a delayed theme acknowledgement after reset", async ({
  page,
}) => {
  await mockReviewApi(page);
  let releaseUpdate: (() => void) | undefined;
  let updateStarted = false;
  await page.route("**/api/settings/theme", async (route) => {
    if (route.request().method() === "PUT") {
      updateStarted = true;
      await new Promise<void>((resolve) => {
        releaseUpdate = resolve;
      });
      const body = route.request().postDataJSON() as {
        preference: ReviewSettings["theme"];
      };
      return route.fulfill({
        json: {
          version: 1,
          diffContextLines: 3,
          keyboardLayout: "normie",
          theme: body.preference,
          typography: DEFAULT_TYPOGRAPHY_PREFERENCE,
        },
      });
    }
    return route.fulfill({
      json: {
        version: 1,
        diffContextLines: 3,
        keyboardLayout: "normie",
        theme: DEFAULT_THEME_PREFERENCE,
        typography: DEFAULT_TYPOGRAPHY_PREFERENCE,
      },
    });
  });
  await page.goto("/");
  await page.locator(".settings-nav-button").click();
  await page.getByRole("radio", { name: /Dusk/ }).click();
  await expect.poll(() => updateStarted).toBe(true);
  await page.getByRole("button", { name: "Reset workspace theme" }).click();
  expect(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue("--canvas")
        .trim(),
    ),
  ).toBe("#191a1f");

  releaseUpdate?.();
  await expect(page.getByText("Theme saved for this workspace.")).toBeVisible();
  expect(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue("--canvas")
        .trim(),
    ),
  ).toBe("#191a1f");
});

test("reveals a saved non-default theme without a default-palette review frame", async ({
  page,
}) => {
  await mockReviewApi(page);
  await page.route("**/api/settings", (route) =>
    route.fulfill({
      json: {
        version: 1,
        diffContextLines: 3,
        keyboardLayout: "normie",
        theme: { version: 1, preset: "paper", overrides: {} },
        typography: DEFAULT_TYPOGRAPHY_PREFERENCE,
      },
    }),
  );
  await page.addInitScript(() => {
    const capture = () => {
      const state = window as unknown as { firstReviewCanvas?: string };
      if (state.firstReviewCanvas || !document.querySelector(".review-shell"))
        return;
      state.firstReviewCanvas = getComputedStyle(document.documentElement)
        .getPropertyValue("--canvas")
        .trim();
    };
    const timer = window.setInterval(() => {
      capture();
      if (
        (window as unknown as { firstReviewCanvas?: string }).firstReviewCanvas
      )
        window.clearInterval(timer);
    }, 0);
  });
  await page.goto("/");

  await expect(page.locator(".review-shell")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { firstReviewCanvas?: string })
            .firstReviewCanvas,
      ),
    )
    .toBe("#f4f2ee");
});

test("keeps the approved accessible theme baselines stable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockReviewApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Comment on new line 1" }).click();
  await expect(page).toHaveScreenshot("theme-redline-review.png", {
    maxDiffPixelRatio: 0.005,
  });

  await page.locator(".settings-nav-button").click();
  await page.getByRole("radio", { name: /Dusk/ }).click();
  await expect(page.getByText("Theme saved for this workspace.")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page).toHaveScreenshot("theme-dusk-review.png", {
    maxDiffPixelRatio: 0.005,
  });
});

test("persists independent interface and code fonts and sizes", async ({
  page,
}) => {
  await mockReviewApi(page);
  await page.goto("/");
  await page.locator(".settings-nav-button").click();
  const codeBefore = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--font-code"),
  );
  await page.getByLabel("Interface font").selectOption("serif");
  await expect(
    page.getByText("Typography saved for this workspace."),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue(
          "--font-ui",
        ),
      ),
    )
    .toContain("Charter");
  expect(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue(
        "--font-code",
      ),
    ),
  ).toBe(codeBefore);
  await page.getByLabel("Code font").selectOption("modern");
  await page
    .getByRole("button", { name: "Increase interface text size" })
    .click();
  await page.getByRole("button", { name: "Increase code text size" }).click();
  await expect(
    page.getByText("Typography saved for this workspace."),
  ).toBeVisible();
  await expect(
    page.locator(".typography-size-control output").first(),
  ).toContainText("15 px");
  await expect(
    page.locator(".typography-size-control output").last(),
  ).toContainText("17 px");
  await page.reload();
  await page.locator(".settings-nav-button").click();
  await expect(page.getByLabel("Interface font")).toHaveValue("serif");
  await expect(page.getByLabel("Code font")).toHaveValue("modern");
  await expect(
    page.locator(".typography-size-control output").first(),
  ).toContainText("15 px");
  await expect(
    page.locator(".typography-size-control output").last(),
  ).toContainText("17 px");
});

test("keeps failed size changes applied and retries the latest atomic pair", async ({
  page,
}) => {
  await mockReviewApi(page);
  let attempts = 0;
  let releaseFailure: (() => void) | undefined;
  await page.route("**/api/settings/typography", async (route) => {
    attempts += 1;
    if (attempts === 1) {
      await new Promise<void>((resolve) => {
        releaseFailure = resolve;
      });
      return route.fulfill({ status: 500, json: { message: "injected" } });
    }
    const body = route.request().postDataJSON() as {
      preference: ReviewSettings["typography"];
    };
    return route.fulfill({
      json: {
        version: 1,
        diffContextLines: 3,
        keyboardLayout: "normie",
        theme: DEFAULT_THEME_PREFERENCE,
        typography: body.preference,
      },
    });
  });
  await page.goto("/");
  await page.locator(".settings-nav-button").click();
  await page.getByRole("button", { name: "Increase code text size" }).click();
  await expect.poll(() => attempts).toBe(1);
  await page.getByRole("button", { name: "Increase code text size" }).click();
  releaseFailure?.();
  await expect(page.getByRole("alert")).toContainText("unsaved");
  await expect(
    page.locator(".typography-size-control output").last(),
  ).toContainText("18 px");
  expect(attempts).toBe(1);
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(
    page.getByText("Typography saved for this workspace."),
  ).toBeVisible();
  expect(attempts).toBe(2);
  await expect(
    page.locator(".typography-size-control output").last(),
  ).toContainText("18 px");
});

test("rolls a rejected typography choice back without offering retry", async ({
  page,
}) => {
  await mockReviewApi(page);
  let posted: ReviewSettings["typography"] | undefined;
  await page.route("**/api/settings/typography", (route) => {
    posted = (
      route.request().postDataJSON() as {
        preference: ReviewSettings["typography"];
      }
    ).preference;
    return route.fulfill({ status: 400, json: { message: "invalid" } });
  });
  await page.goto("/");
  await page.locator(".settings-nav-button").click();
  await page.getByLabel("Interface font").selectOption("serif");
  await expect.poll(() => posted?.uiFont).toBe("serif");
  await expect(page.getByRole("alert")).toContainText("rejected by the server");
  await expect(page.getByLabel("Interface font")).toHaveValue("system");
  await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
});

test("restores a failed font save and allows switching workspaces", async ({
  page,
}) => {
  await mockReviewApi(page);
  let attempts = 0;
  let releaseFailure: (() => void) | undefined;
  await page.route("**/api/settings/typography", async (route) => {
    attempts += 1;
    await new Promise<void>((resolve) => {
      releaseFailure = resolve;
    });
    return route.fulfill({ status: 500, json: { message: "injected" } });
  });
  await page.route("**/api/workspace/open", (route) =>
    route.fulfill({
      json: {
        ...changedWorkspace,
        root: "/home/zack/git/another-workspace",
        name: "another-workspace",
      },
    }),
  );
  await page.goto("/");
  await page.locator(".settings-nav-button").click();
  await expect(
    page.getByText("Typography saved for this workspace."),
  ).toBeVisible();
  await page.getByLabel("Interface font").selectOption("serif");
  await expect.poll(() => attempts).toBe(1);
  await expect(page.getByLabel("Interface font")).toHaveValue("serif");
  await page.getByLabel("Interface font").selectOption("humanist");
  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue(
          "--font-ui",
        ),
      ),
    )
    .toContain("Trebuchet");
  releaseFailure?.();
  await expect(page.getByRole("alert")).toContainText("was restored");
  await expect(page.getByLabel("Interface font")).toHaveValue("system");
  await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await page.getByRole("button", { name: "Change", exact: true }).click();
  await page.getByLabel("Local path").fill("/home/zack/git/another-workspace");
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(
    page.getByText("another-workspace", { exact: true }),
  ).toBeVisible();
  expect(attempts).toBe(1);
});

test("autosaves typography normally after settings reload clears a failed font save", async ({
  page,
}) => {
  await mockReviewApi(page);
  let attempts = 0;
  await page.route("**/api/settings/typography", async (route) => {
    attempts += 1;
    if (attempts === 1)
      return route.fulfill({ status: 500, json: { message: "injected" } });
    const body = route.request().postDataJSON() as {
      preference: ReviewSettings["typography"];
    };
    return route.fulfill({
      json: {
        version: 1,
        diffContextLines: 3,
        keyboardLayout: "normie",
        theme: DEFAULT_THEME_PREFERENCE,
        typography: body.preference,
      },
    });
  });
  await page.goto("/");
  await page.locator(".settings-nav-button").click();
  await page.getByLabel("Interface font").selectOption("serif");
  await expect(page.getByRole("alert")).toContainText("was restored");
  await page.reload();
  await page.locator(".settings-nav-button").click();
  await page.getByLabel("Interface font").selectOption("humanist");
  await expect(
    page.getByText("Typography saved for this workspace."),
  ).toBeVisible();
  expect(attempts).toBe(2);
});

test("keeps maximum typography operable on narrow unified and wide split diffs", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockReviewApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Open changed files panel" }).click();
  await page.locator(".settings-nav-button").click();
  for (let index = 0; index < 4; index += 1)
    await page
      .getByRole("button", { name: "Increase interface text size" })
      .click();
  for (let index = 0; index < 4; index += 1)
    await page.getByRole("button", { name: "Increase code text size" }).click();
  await expect(
    page.getByText("Typography saved for this workspace."),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: /Review/ }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".diff-view")).toHaveAttribute(
    "data-effective-view",
    "unified",
  );
  const narrowMetrics = await page
    .locator(".unified-line")
    .first()
    .evaluate((row) => ({
      height: row.getBoundingClientRect().height,
      scrollWidth: row.parentElement?.scrollWidth ?? 0,
    }));
  expect(narrowMetrics.height).toBeGreaterThanOrEqual(32);
  expect(narrowMetrics.scrollWidth).toBeGreaterThan(0);

  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.locator(".diff-view")).toHaveAttribute(
    "data-effective-view",
    "split",
  );
  const splitHeights = await page
    .locator(".side-cell")
    .evaluateAll((cells) =>
      cells.slice(0, 2).map((cell) => cell.getBoundingClientRect().height),
    );
  expect(splitHeights).toHaveLength(2);
  expect(splitHeights[0]).toBe(splitHeights[1]);
});

test("keeps Normie as the default and enables modal line selection in Vim layout", async ({
  page,
}) => {
  await mockReviewApi(page);
  await page.goto("/");

  await expect(page.getByRole("button", { name: "Enter Vim" })).toHaveCount(0);
  await page.locator(".settings-nav-button").click();
  await page.getByRole("radio", { name: /Vim/ }).click();
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(
    page.getByText("Saved for this workspace.", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  await expect(page.locator(".settings-nav-button")).toContainText("Vim");
  await page.getByRole("button", { name: "Enter Vim" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Normal" }),
  ).toBeVisible();

  await page.keyboard.press("v");
  await expect(page.locator(".vim-mode-guide")).toContainText("Visual line");
  await page.keyboard.press("j");
  await expect(page.locator(".line-selection-toolbar")).toContainText(
    "J/K extends in Visual line",
  );

  await page.keyboard.press("c");
  await expect(
    page.getByPlaceholder("Leave a local review note"),
  ).toBeVisible();
});

test("keeps Vim navigation line-locked with scrolloff and cursor-driven wheel movement", async ({
  page,
}) => {
  const body = Array.from(
    { length: 240 },
    (_, index) => `+export const row${index + 1} = ${index + 1};`,
  );
  const longDiff: DiffResponse = {
    ...diff,
    diff: [
      "diff --git a/src/App.tsx b/src/App.tsx",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/App.tsx",
      "@@ -0,0 +1,240 @@",
      ...body,
    ].join("\n"),
    lines: [],
    stats: { additions: 240, deletions: 0 },
  };
  await mockReviewApi(page, longDiff);
  await page.goto("/");
  await page.locator(".settings-nav-button").click();
  await page.getByRole("radio", { name: /Vim/ }).click();
  await page.getByRole("button", { name: "Save settings" }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Enter Vim" }).click();

  const scroller = page.locator(".diff-scroll");
  await expect(scroller).toHaveAttribute("data-vim-mode", "true");
  expect(
    await scroller.evaluate(
      (element) => getComputedStyle(element).scrollbarWidth,
    ),
  ).toBe("none");

  await page.keyboard.press("Control+d");
  await page.keyboard.press("Control+d");
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  const cursor = page.locator(".line-number-button:focus");
  const [cursorBox, scrollerBox] = await Promise.all([
    cursor.boundingBox(),
    scroller.boundingBox(),
  ]);
  expect(
    cursorBox &&
      scrollerBox &&
      cursorBox.y < scrollerBox.y + scrollerBox.height - 5 * 26,
  ).toBe(true);

  const beforeWheel = await cursor.getAttribute("aria-label");
  await page.mouse.move(
    (scrollerBox?.x ?? 0) + 300,
    (scrollerBox?.y ?? 0) + 300,
  );
  await page.mouse.wheel(0, 112);
  await expect
    .poll(() =>
      page.locator(".line-number-button:focus").getAttribute("aria-label"),
    )
    .not.toBe(beforeWheel);

  await page.keyboard.press("Shift+g");
  await expect(
    page.getByRole("button", { name: "Comment on new line 240", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("g");
  await page.keyboard.press("g");
  await expect(
    page.getByRole("button", { name: "Comment on new line 1", exact: true }),
  ).toBeFocused();
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollTop))
    .toBeLessThan(50);
});

test.describe("phone touch layout", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 740 },
  });

  test("keeps the diff first and primary controls touch-sized", async ({
    page,
  }) => {
    await mockReviewApi(page);
    await page.goto("/");

    await expect(
      page.getByLabel("Changed files", { exact: true }),
    ).toBeHidden();
    await expect(page.locator(".diff-scroll")).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(390);

    for (const control of [
      page.getByRole("button", { name: "Open changed files panel" }),
      page.getByRole("button", { name: /^Snapshot 2$/ }),
      page.getByRole("button", { name: "Approve file" }),
    ]) {
      const box = await control.boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);
    }

    const approveBox = await page
      .getByRole("button", { name: "Approve file" })
      .boundingBox();
    expect(approveBox?.y).toBeGreaterThan(620);

    await page
      .getByRole("button", { name: "Open changed files panel" })
      .click();
    const batchBox = await page
      .getByRole("button", { name: /Approve 2 visible files/ })
      .boundingBox();
    expect(batchBox?.height).toBeGreaterThanOrEqual(44);
    for (const control of [
      page.locator(".file-search"),
      page.getByRole("button", { name: /src\/App\.tsx/ }),
      page.locator(".settings-nav-button"),
    ]) {
      const box = await control.boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);
    }
    expect(
      await page
        .getByLabel("Changed files", { exact: true })
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);

    await page.locator(".settings-nav-button").click();
    for (let index = 0; index < 4; index += 1)
      await page
        .getByRole("button", { name: "Decrease code text size" })
        .click();
    await expect(
      page.locator(".typography-size-control output").last(),
    ).toContainText("12 px");
    const noiseBox = await page
      .getByRole("checkbox", { name: /Show review noise/ })
      .locator("..")
      .boundingBox();
    expect(noiseBox?.height).toBeGreaterThanOrEqual(44);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(390);
    await page.keyboard.press("Escape");
    await expect(page.locator(".settings-nav-button")).toBeFocused();
    await page.keyboard.press("Escape");
    const contextBox = await page
      .getByRole("button", { name: "Show more context" })
      .first()
      .boundingBox();
    expect(contextBox?.height).toBeGreaterThanOrEqual(44);
    const hunkBox = await page.locator(".diff-hunk-line").first().boundingBox();
    expect(hunkBox?.height).toBeGreaterThanOrEqual(44);
    await expect(page.locator(".diff-view")).toHaveCSS(
      "--diff-hunk-height",
      "44px",
    );
  });
});
