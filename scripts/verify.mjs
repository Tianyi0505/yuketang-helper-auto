import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const CHECKS = [
  {
    name: "CLI unit tests",
    cwd: ".",
    fullOnly: false,
    command: { type: "node", args: ["--test", "scripts/verify.test.mjs"] },
  },
  {
    name: "ykt-helper test",
    cwd: "ykt-helper",
    fullOnly: false,
    command: { type: "npm", script: "test" },
  },
  {
    name: "ykt-helper test:model-params",
    cwd: "ykt-helper",
    fullOnly: false,
    command: { type: "npm", script: "test:model-params" },
  },
  {
    name: "ykt-helper-win test",
    cwd: "ykt-helper-win",
    fullOnly: false,
    command: { type: "npm", script: "test" },
  },
  {
    name: "ykt-helper-win lint",
    cwd: "ykt-helper-win",
    fullOnly: false,
    command: { type: "npm", script: "lint" },
  },
  {
    name: "ykt-helper-win format:check",
    cwd: "ykt-helper-win",
    fullOnly: false,
    command: { type: "npm", script: "format:check" },
  },
  {
    name: "ykt-helper test:debug",
    cwd: "ykt-helper",
    fullOnly: true,
    command: { type: "npm", script: "test:debug" },
  },
  {
    name: "ykt-helper-win build",
    cwd: "ykt-helper-win",
    fullOnly: true,
    command: { type: "npm", script: "build" },
  },
];

export function parseArgs(args) {
  const options = { full: false, help: false };

  for (const arg of args) {
    if (arg === "--full") {
      options.full = true;
    } else if (arg === "--help") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

export function getCheckPlan(full = false) {
  return CHECKS.filter((check) => full || !check.fullOnly);
}

function runCheck(check) {
  const args =
    check.command.type === "node"
      ? check.command.args
      : [process.env.npm_execpath, "run", check.command.script];

  try {
    return spawnSync(process.execPath, args, {
      cwd: resolve(REPO_ROOT, check.cwd),
      shell: false,
      stdio: "inherit",
    });
  } catch (error) {
    return { error };
  }
}

function failureReason(result) {
  if (result.error) return `failed to start: ${result.error.message}`;
  if (result.signal) return `terminated by ${result.signal}`;
  return `exit code ${result.status}`;
}

function runChecks(checks) {
  const results = [];

  for (const check of checks) {
    const result = runCheck(check);
    const passed = result.status === 0 && !result.error;
    results.push({ name: check.name, passed, result });
    console.log(
      `${passed ? "PASS" : "FAIL"} ${check.name}${passed ? "" : ` (${failureReason(result)})`}`,
    );
  }

  const passedCount = results.filter((result) => result.passed).length;
  const failedCount = results.length - passedCount;
  console.log(
    `Verification summary: ${passedCount}/${results.length} passed, ${failedCount} failed.`,
  );

  if (failedCount > 0) process.exitCode = 1;
}

function printHelp() {
  console.log("Usage: npm run verify [-- --full]");
  console.log("       npm run verify:full");
  console.log("       npm run test:verify");
  console.log("Options:");
  console.log("  --full  Include debug harness and desktop build checks");
  console.log("  --help  Show this help message");
}

function main(args) {
  let options;

  try {
    options = parseArgs(args);
  } catch (error) {
    console.error(error.message);
    printHelp();
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    printHelp();
    return;
  }

  runChecks(getCheckPlan(options.full));
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2));
}
