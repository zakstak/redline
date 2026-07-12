import { buildServer } from "./app.js";
import { resolveStartupWorkspace } from "./startup-workspace.js";

const host = "127.0.0.1";
const port = Number(process.env.PORT ?? "4322");
const startupDirectory = process.cwd();
const workspaceDir = resolveStartupWorkspace(
  process.env.REDLINE_WORKSPACE,
  startupDirectory,
);

async function start() {
  const app = buildServer({
    workspaceDir,
  });

  try {
    await app.listen({ host, port });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

void start();
