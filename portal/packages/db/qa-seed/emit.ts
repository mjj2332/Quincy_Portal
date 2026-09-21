#!/usr/bin/env -S npx tsx
/**
 * QA scheduling fixture — dataset-only CLI (#220 follow-on). Run exclusively under `tsx` by
 * `cli.mjs` (`node`'s native TypeScript stripping cannot resolve `@quincy/shared`'s extensionless
 * relative imports). **This file never imports `node:child_process` and never touches the network
 * or a database.** It reads argv, builds statements, and prints JSON to stdout. `cli.mjs` is the
 * only file in this directory allowed to spawn `wrangler`.
 */
import { randomUUID } from "node:crypto";
import { BOOTSTRAP_ADMIN_ID, buildQaFixtureDataset, resolveAnchor, type QaTier } from "./dataset";
import { buildApplyPlan, buildTeardownStatements, type FixtureEntity } from "./sql";

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

function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value));
}

function modePlan(argv: string[]): void {
  const anchor = resolveAnchor(readFlag(argv, "anchor"));
  const tiers = parseTiers(readFlag(argv, "tier"));
  const defaultEditorIds = parseIdList(readFlag(argv, "default-editor-ids"));
  const appliedAtMsRaw = readFlag(argv, "applied-at-ms");
  if (!appliedAtMsRaw) throw new Error("--applied-at-ms is required for `plan`.");
  const appliedAtMs = Number(appliedAtMsRaw);
  if (!Number.isSafeInteger(appliedAtMs)) throw new Error("--applied-at-ms must be a safe integer.");

  const dataset = buildQaFixtureDataset({ anchor, tiers, defaultEditorIds });
  const plan = buildApplyPlan(dataset, { runId: randomUUID(), appliedAtMs, createdBy: BOOTSTRAP_ADMIN_ID });
  printJson(plan);
}

function modeManifest(argv: string[]): void {
  const anchor = resolveAnchor(readFlag(argv, "anchor"));
  const tiers = parseTiers(readFlag(argv, "tier"));
  const defaultEditorIds = parseIdList(readFlag(argv, "default-editor-ids"));
  const dataset = buildQaFixtureDataset({ anchor, tiers, defaultEditorIds });
  printJson({
    anchor: dataset.anchor,
    tiers: dataset.tiers,
    projectIds: dataset.projects.map((p) => p.id),
    subtaskIds: dataset.subtasks.map((s) => s.id),
    collectionIds: dataset.collections.map((c) => c.id),
    deadlineOccurrenceIds: dataset.deadlineOccurrences.map((o) => o.id),
    memberIds: dataset.members.map((m) => m.id),
    summary: {
      projects: dataset.projects.length, subtasks: dataset.subtasks.length, collections: dataset.collections.length,
      deadlineOccurrences: dataset.deadlineOccurrences.length, members: dataset.members.length,
    },
  });
}

function modeTeardownPlan(argv: string[]): void {
  const entitiesRaw = readFlag(argv, "entities");
  const runIdsRaw = readFlag(argv, "run-ids");
  if (!entitiesRaw) throw new Error("--entities=<json> is required for `teardown-plan`.");
  const entities = JSON.parse(entitiesRaw) as FixtureEntity[];
  const runIds = runIdsRaw ? (JSON.parse(runIdsRaw) as string[]) : [];
  const statements = buildTeardownStatements(entities, runIds);
  printJson({ statements });
}

function main(): void {
  const [, , mode, ...rest] = process.argv;
  if (mode === "plan") return modePlan(rest);
  if (mode === "manifest") return modeManifest(rest);
  if (mode === "teardown-plan") return modeTeardownPlan(rest);
  throw new Error(`Unknown emit.ts mode: ${JSON.stringify(mode)}. Expected plan | manifest | teardown-plan.`);
}

main();
