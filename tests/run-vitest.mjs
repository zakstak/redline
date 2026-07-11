import { spawn } from "node:child_process";
import { resolve } from "node:path";

const environment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
);
const vitest = resolve(process.cwd(), "node_modules/vitest/vitest.mjs");
const child = spawn(
  process.execPath,
  [vitest, "run", ...process.argv.slice(2)],
  {
    env: environment,
    stdio: "inherit",
  },
);

child.once("error", (error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
