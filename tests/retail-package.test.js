import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const CHECK_SCRIPT = path.join(ROOT_DIR, "check-retail-package.ps1");
const POWERSHELL = process.platform === "win32" ? "powershell" : "pwsh";

function hasPowerShell() {
  const result = spawnSync(POWERSHELL, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], {
    encoding: "utf8"
  });
  return result.status === 0;
}

function runPackageCheck(packagePath) {
  const result = spawnSync(
    POWERSHELL,
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", CHECK_SCRIPT, "-PackagePath", packagePath, "-SkipZip"],
    { cwd: ROOT_DIR, encoding: "utf8" }
  );
  return {
    ...result,
    output: `${result.stdout || ""}\n${result.stderr || ""}`
  };
}

async function createRetailFixture() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "retail-package-"));
  const packageRoot = path.join(tempRoot, "SemiAutoCexTerminal-win-x64");
  const dirs = [
    "runtime",
    "app/src",
    "app/public"
  ];

  for (const dir of dirs) {
    await mkdir(path.join(packageRoot, dir), { recursive: true });
  }

  const files = new Map([
    ["SemiAutoCexTerminal.exe", "launcher"],
    ["runtime/node.exe", "node"],
    ["app/src/server.js", "console.log('server');\n"],
    ["app/public/index.html", "<!doctype html><title>Terminal</title>\n"],
    ["app/public/app.js", "console.log('app');\n"],
    ["app/public/styles.css", "body { color: #111; }\n"],
    ["app/package.json", "{\"type\":\"module\"}\n"],
    ["app/.env.example", "PORT=8787\n"],
    ["app/.env.session.example", "MEMEMAX_ORDERLY_SECRET=\nBINANCE_API_KEY=\nTRADING_MODE=dry-run\n"],
    ["app/README.md", "# Retail app\n"],
    ["README.txt", "Retail package\n"]
  ]);

  for (const [relativePath, contents] of files) {
    await writeFile(path.join(packageRoot, relativePath), contents, "utf8");
  }

  return { tempRoot, packageRoot };
}

const skipPowerShell = hasPowerShell() ? false : `${POWERSHELL} is unavailable`;

test("retail package smoke check accepts a clean package folder", { skip: skipPowerShell }, async () => {
  const { tempRoot, packageRoot } = await createRetailFixture();
  try {
    const result = runPackageCheck(packageRoot);

    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /Retail package check passed/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("retail package smoke check rejects bundled session env files", { skip: skipPowerShell }, async () => {
  const { tempRoot, packageRoot } = await createRetailFixture();
  try {
    await writeFile(path.join(packageRoot, "app/.env.session"), "BINANCE_API_SECRET=do-not-ship\n", "utf8");

    const result = runPackageCheck(packageRoot);

    assert.notEqual(result.status, 0, result.output);
    assert.match(result.output, /forbidden file: app\\.env\.session/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("retail package smoke check rejects obvious secret assignments", { skip: skipPowerShell }, async () => {
  const { tempRoot, packageRoot } = await createRetailFixture();
  try {
    await writeFile(
      path.join(packageRoot, "app/.env.session.example"),
      "MEMEMAX_ORDERLY_SECRET=real-secret-value\n",
      "utf8"
    );

    const result = runPackageCheck(packageRoot);

    assert.notEqual(result.status, 0, result.output);
    assert.match(result.output, /sensitive assignment marker: app\\.env\.session\.example:1/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("launcher keeps retail session env under user-local app data", async () => {
  const source = await readFile(path.join(ROOT_DIR, "launcher/SemiAutoCexTerminalLauncher.cs"), "utf8");

  assert.match(source, /Path\.Combine\(dataDir, "\.env\.session"\)/);
  assert.match(source, /Ignoring app-local \.env\.session/);
  assert.doesNotMatch(source, /return projectSessionEnvPath/);
});
