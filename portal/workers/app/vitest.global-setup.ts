import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext { zipCheckPort: number }
}

/** Every file under `root`, keyed by its path relative to it, as base64. */
function readTree(root: string, base = root, into: Record<string, string> = {}): Record<string, string> {
  for (const name of readdirSync(base)) {
    const path = join(base, name);
    if (statSync(path).isDirectory()) readTree(root, path, into);
    else into[path.slice(root.length + 1)] = readFileSync(path).toString("base64");
  }
  return into;
}

/**
 * An independent archive checker for the native ZIP writer (#802). Worker tests run in workerd and can neither write a temp file nor spawn a process, so this Node-side loopback server
 * does it for them: POST the archive bytes, it writes them to a temp file, runs `python3 -I -m zipfile -t <file>` (Python's own reader, which shares no code with `zip-native.ts`),
 * extracts with `-e`, and answers { ok, output, files }.
 */
function startZipChecker(): Promise<Server> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const directory = mkdtempSync(join(tmpdir(), "quincy-zip-check-"));
      try {
        const file = join(directory, "archive.zip"); const out = join(directory, "out");
        writeFileSync(file, Buffer.concat(chunks)); mkdirSync(out);
        const test = spawnSync("python3", ["-I", "-m", "zipfile", "-t", file], { encoding: "utf8", timeout: 60_000 });
        // `-t` exits 0 even when it names a corrupted member (it only prints "The following enclosed file is corrupted"), so success is the exit code AND no such line.
        const output = `${test.stdout}${test.stderr}`;
        const passed = test.status === 0 && /Done testing/.test(output) && !/corrupted/i.test(output);
        let files: Record<string, string> = {};
        if (passed) { spawnSync("python3", ["-I", "-m", "zipfile", "-e", file, out], { encoding: "utf8", timeout: 60_000 }); files = readTree(out); }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: passed, output, files }));
      } finally { rmSync(directory, { recursive: true, force: true }); }
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

/**
 * The app Worker serves the SPA through the ASSETS binding, which reads apps/web/dist. Without a
 * build every route test fails with a confusing 404 or binding error, so fail first and say why.
 * (A vitest globalSetup, not npm `pretest`: agents call vitest directly.)
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const index = fileURLToPath(new URL("../../apps/web/dist/index.html", import.meta.url));
  if (!existsSync(index)) {
    throw new Error("apps/web/dist is missing — run: npm run build -w @quincy/web (from portal/)");
  }
  const server = await startZipChecker();
  project.provide("zipCheckPort", (server.address() as { port: number }).port);
  return () => new Promise((resolve) => server.close(() => resolve()));
}
