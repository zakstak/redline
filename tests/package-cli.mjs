import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const prefix = await mkdtemp(join(tmpdir(), "redline-package-"));

try {
  await exec("npm", [
    "install",
    "--prefix",
    prefix,
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    resolve(process.cwd()),
  ]);
  const executable = join(prefix, "node_modules", ".bin", "redline");
  const { stdout } = await exec(executable, ["--help"], { cwd: prefix });
  if (!stdout.includes("Usage: redline")) {
    throw new Error("Installed redline executable did not print CLI help.");
  }
} finally {
  await rm(prefix, { recursive: true, force: true });
}
