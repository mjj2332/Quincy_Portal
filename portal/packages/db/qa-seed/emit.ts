#!/usr/bin/env -S npx tsx
/**
 * QA scheduling fixture — dataset-only CLI (#220 follow-on). Run exclusively under `tsx` by
 * `cli.mjs` (`node`'s native TypeScript stripping cannot resolve `@quincy/shared`'s extensionless
 * relative imports). **This file never imports `node:child_process` and never touches the network
 * or a database.** It reads argv, builds statements, and prints JSON to stdout. `cli.mjs` is the
 * only file in this directory allowed to spawn `wrangler`.
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { BOOTSTRAP_ADMIN_ID, buildQaFixtureDataset, resolveAnchor, type QaTier } from "./dataset";
import { buildApplyPlan, buildVerificationManifest } from "./sql";
import { buildTeardownGraph, buildTeardownPlan, edgesIntoProjects, type IntrospectedForeignKey, type IntrospectedTable } from "./teardown-graph";

function readFlag(argv: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

function parseTiers(value: string | undefined): QaTier[] {
  if (!value) return ["core"];
  const tiers = value.split(",").map((v) => v.trim()).filter(Boolean);
  for (const tier of tiers) if (tier !== "core" && tier !== "density") throw new Error(`Unknown tier: ${tier}`);
  return tiers as QaTier[];
}

function parseIdList(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((v) => v.trim()).filter(Boolean);
}

function readRequiredAppliedAtMs(argv: string[], mode: string): number {
  const raw = readFlag(argv, "applied-at-ms");
  if (!raw) throw new Error(`--applied-at-ms is required for \`${mode}\`.`);
  const appliedAtMs = Number(raw);
  if (!Number.isSafeInteger(appliedAtMs)) throw new Error("--applied-at-ms must be a safe integer.");
  return appliedAtMs;
}


function modePlan(argv: string[]): unknown {
  const anchor = resolveAnchor(readFlag(argv, "anchor"));
  const tiers = parseTiers(readFlag(argv, "tier"));
  const defaultEditorIds = parseIdList(readFlag(argv, "default-editor-ids"));
  const appliedAtMs = readRequiredAppliedAtMs(argv, "plan");

  const dataset = buildQaFixtureDataset({ anchor, tiers, appliedAtMs, defaultEditorIds });
  return buildApplyPlan(dataset, { runId: randomUUID(), appliedAtMs, createdBy: BOOTSTRAP_ADMIN_ID, defaultEditorIds });
}

/**
 * `manifest` is the ONLY mode `db:qa:verify` calls (item 2 — verify must actually verify).
 * `--default-editor-ids` and `--board-positions` are the RUN's recorded values
 * (`FIXTURE_RUN_RECORDS_TABLE`/`FIXTURE_BOARD_POSITIONS_TABLE`), never today's state. Unlike
 * `plan`, `--applied-at-ms` here is never `Date.now()` — `cli.mjs` passes the RECORDED run's own
 * `applied_at` from `__quincy_local_fixture_runs`, so the recomputed dataset (including deadline
 * occurrence status, the one apply-time-dependent field — item 4) is byte-identical to what that
 * run actually inserted, not to "if you applied again right now".
 */
function modeManifest(argv: string[]): unknown {
  const anchor = resolveAnchor(readFlag(argv, "anchor"));
  const tiers = parseTiers(readFlag(argv, "tier"));
  const defaultEditorIds = parseIdList(readFlag(argv, "default-editor-ids"));
  const appliedAtMs = readRequiredAppliedAtMs(argv, "manifest");
  const boardPositionsRaw = readFlag(argv, "board-positions");
  if (!boardPositionsRaw) throw new Error("--board-positions=<json> (the run's recorded board_position per project) is required for `manifest`.");
  const boardPositions = JSON.parse(boardPositionsRaw) as Record<string, number>;

  const dataset = buildQaFixtureDataset({ anchor, tiers, appliedAtMs, defaultEditorIds });
  return buildVerificationManifest(dataset, { createdBy: BOOTSTRAP_ADMIN_ID, boardPositions });
}

/** `teardown-plan` gets the LIVE schema, as `cli.mjs` introspected it — never a table list of its
 * own (`teardown-graph.ts`). */
function modeTeardownPlan(argv: string[]): unknown {
  const tablesRaw = readFlag(argv, "tables");
  const foreignKeysRaw = readFlag(argv, "foreign-keys");
  const runIdsRaw = readFlag(argv, "run-ids");
  if (!tablesRaw || !foreignKeysRaw) throw new Error("--tables=<json> and --foreign-keys=<json> (the live schema introspection) are required for `teardown-plan`.");
  const graph = buildTeardownGraph(JSON.parse(tablesRaw) as IntrospectedTable[], JSON.parse(foreignKeysRaw) as IntrospectedForeignKey[]);
  const runIds = runIdsRaw ? (JSON.parse(runIdsRaw) as string[]) : [];
  return { ...buildTeardownPlan(graph, runIds), edgesIntoProjects: edgesIntoProjects(graph) };
}

/** Exported so the qa-seed integration tests' `node:sqlite` executor produces its plans through
 * this exact dispatch — the same argv strings `cli.mjs` passes — rather than a re-implementation. */
export function emitMode(mode: string | undefined, rest: string[]): unknown {
  if (mode === "plan") return modePlan(rest);
  if (mode === "manifest") return modeManifest(rest);
  if (mode === "teardown-plan") return modeTeardownPlan(rest);
  throw new Error(`Unknown emit.ts mode: ${JSON.stringify(mode)}. Expected plan | manifest | teardown-plan.`);
}

function main(): void {
  const [, , mode, ...rest] = process.argv;
  process.stdout.write(JSON.stringify(emitMode(mode, rest)));
}

// Only when run as a script (`cli.mjs` spawns it under tsx) — importing it runs nothing.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
