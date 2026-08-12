import { parseArgs } from "../packages/coding-agent/src/cli/args.ts";
import { DefaultResourceLoader } from "../packages/coding-agent/src/core/resource-loader.ts";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const cwd = process.cwd();
const agentDir = join(tmpdir(), "pi-learn-test-agent");
mkdirSync(agentDir, { recursive: true });

const withNc = parseArgs(["-nc", "-p", "hi"]);
const withoutNc = parseArgs(["-p", "hi"]);
console.log("parseArgs -nc:", withNc.noContextFiles === true);
console.log("parseArgs default:", withoutNc.noContextFiles !== true);

const loaderNc = new DefaultResourceLoader({ cwd, agentDir, noContextFiles: true });
await loaderNc.reload();
const ncCount = loaderNc.getAgentsFiles().agentsFiles.length;

const loaderDefault = new DefaultResourceLoader({ cwd, agentDir, noContextFiles: false });
await loaderDefault.reload();
const defaultFiles = loaderDefault.getAgentsFiles().agentsFiles;

console.log("agentsFiles noContextFiles=true count:", ncCount, "(expect 0)");
console.log("agentsFiles noContextFiles=false count:", defaultFiles.length, "(expect >=1)");
for (const f of defaultFiles) console.log(" loaded:", f.path);

const ok =
  withNc.noContextFiles === true &&
  ncCount === 0 &&
  defaultFiles.some((f) => f.path.replace(/\\/g, "/").endsWith("/AGENTS.md"));
console.log(ok ? "VERIFY_OK" : "VERIFY_FAIL");
process.exit(ok ? 0 : 1);