#!/usr/bin/env node
/**
 * Re-verifies the deployed staging Worker Image Transformations gate.
 *
 * This is intentionally a destructive, remote integration spike: it uploads one
 * ~50 MiB JPEG to the production R2 account and creates temporary REMOTE D1 rows.
 * It refuses to start unless RUN_TRANSFORM_GATE=1 is set, and always attempts to
 * remove only gate-scoped data in finally.
 *
 * PROD_BETTER_AUTH_SECRET must be the BETTER_AUTH_SECRET configured on the
 * deployed staging Worker. Do not use workers/app/.dev.vars for this secret: that
 * file contains the local development secret, which cannot sign a staging cookie.
 * R2's account-level S3 credentials are read from workers/app/.dev.vars only.
 *
 * The media route validates asset IDs as UUIDs, so the asset is the sole exception
 * to the gate-* ID convention. Its R2 key is gate/transform-gate-..., and every
 * cleanup query is constrained to that known gate prefix.
 */
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import { AwsClient } from "aws4fetch";

const stagingOrigin = "https://staging.quincy.flamingfire.my";
const bucket = "quincy-portal-media";
const fixtureBytes = 50 * 1024 * 1024;
const portalRoot = fileURLToPath(new URL("..", import.meta.url));
const fixtureJpeg = Buffer.from(
  // A baseline 1x1 JPEG. Bytes after its EOI marker are deliberately harmless padding.
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/Aaf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/Aaf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Al//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z",
  "base64",
);

function printIntent() {
  console.error("This gate would upload a ~50 MiB valid JPEG to quincy-portal-media, seed temporary gate-* rows in remote D1, request the deployed staging /media/asset/:assetId/web endpoint, assert a real Cloudflare transformation, then clean up.");
}

if (process.env.RUN_TRANSFORM_GATE !== "1") {
  printIntent();
  console.error("Refusing to run: set RUN_TRANSFORM_GATE=1 to acknowledge the remote R2/D1 writes.");
  process.exit(1);
}

const productionAuthSecret = process.env.PROD_BETTER_AUTH_SECRET;
if (!productionAuthSecret) {
  printIntent();
  console.error("Refusing to run: PROD_BETTER_AUTH_SECRET is required to sign the deployed Worker session cookie.");
  process.exit(1);
}

function parseEnv(text) {
  const values = {};
  for (const sourceLine of text.split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

function mask(value) {
  return value.length <= 4 ? "*".repeat(value.length) : `${"*".repeat(Math.max(4, value.length - 4))}${value.slice(-4)}`;
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function signedSession(token, secret) {
  // Matches better-auth/crypto makeSignature(): HMAC-SHA-256, standard base64.
  return createHmac("sha256", secret).update(token).digest("base64");
}

async function makeFixture() {
  // Prefer a REAL photograph via GATE_FIXTURE_PATH: the Images engine returned an
  // internal error (err=9516) on the synthetic padded 1x1 fixture — degenerate input,
  // not representative. Real Lightroom exports are the actual gate subject.
  const fixturePath = process.env.GATE_FIXTURE_PATH;
  if (fixturePath) {
    const body = new Uint8Array(await readFile(fixturePath));
    if (body[0] !== 0xff || body[1] !== 0xd8) throw new Error(`GATE_FIXTURE_PATH is not a JPEG: ${fixturePath}`);
    console.log(`Using real fixture ${fixturePath} (${body.byteLength} bytes).`);
    return body;
  }
  if (fixtureJpeg.length >= fixtureBytes || fixtureJpeg[0] !== 0xff || fixtureJpeg[1] !== 0xd8 || fixtureJpeg.at(-2) !== 0xff || fixtureJpeg.at(-1) !== 0xd9) {
    throw new Error("Embedded JPEG fixture is not a valid-sized JPEG with SOI/EOI markers");
  }
  const body = new Uint8Array(fixtureBytes);
  body.set(fixtureJpeg);
  // JPEG decoders stop at EOI; zero padding makes the R2 original large without changing pixels.
  return body;
}

async function requireOk(response, operation) {
  if (response.ok) return response;
  const body = await response.text();
  throw new Error(`${operation} failed (${response.status}): ${body.slice(0, 500)}`);
}

function runCommand(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} ${args.slice(0, 4).join(" ")} failed with exit ${code}: ${(stderr || stdout).trim().slice(0, 1000)}`));
    });
  });
}

async function d1(statement) {
  return runCommand(
    "npx",
    ["wrangler", "d1", "execute", "quincy-portal", "--remote", "--command", statement, "--json"],
    portalRoot,
  );
}

async function d1Count(statement, field) {
  const { stdout } = await d1(statement);
  let data;
  try {
    data = JSON.parse(stdout.trim());
  } catch {
    throw new Error(`Could not parse Wrangler --json output: ${stdout.trim().slice(0, 500)}`);
  }
  const result = Array.isArray(data) ? data[0]?.results?.[0] : data?.results?.[0];
  const value = Number(result?.[field]);
  if (!Number.isInteger(value) || value < 0) throw new Error(`Wrangler count result did not contain an integer ${field}`);
  return value;
}

function assert(label, passed, detail, failures) {
  console.log(`${passed ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!passed) failures.push(label);
}

async function cleanup(aws, endpoint) {
  const results = [];
  try {
    const response = await aws.fetch(endpoint, { method: "DELETE" });
    if (!response.ok && response.status !== 404) throw new Error(`status ${response.status}`);
    results.push(response.status === 404 ? "R2 object already absent" : "R2 object deleted");
  } catch (error) {
    results.push(`R2 object delete failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Each is a single remote D1 statement. Keep predicates gate-scoped; do not widen them.
  const statements = [
    "DELETE FROM session WHERE id LIKE 'gate-%' OR token LIKE 'gate-%' OR user_id LIKE 'gate-%'",
    "DELETE FROM project_members WHERE id LIKE 'gate-%' OR project_id LIKE 'gate-%' OR user_id LIKE 'gate-%'",
    "DELETE FROM assets WHERE id LIKE 'gate-%' OR collection_id LIKE 'gate-%' OR r2_key LIKE 'gate/transform-gate-%'",
    "DELETE FROM collections WHERE id LIKE 'gate-%' OR project_id LIKE 'gate-%'",
    "DELETE FROM projects WHERE id LIKE 'gate-%'",
    "DELETE FROM user WHERE id LIKE 'gate-%'",
  ];
  for (const statement of statements) {
    try {
      await d1(statement);
    } catch (error) {
      results.push(`D1 cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  try {
    const remaining = await d1Count(
      "SELECT (SELECT COUNT(*) FROM session WHERE id LIKE 'gate-%' OR token LIKE 'gate-%' OR user_id LIKE 'gate-%') + (SELECT COUNT(*) FROM project_members WHERE id LIKE 'gate-%' OR project_id LIKE 'gate-%' OR user_id LIKE 'gate-%') + (SELECT COUNT(*) FROM assets WHERE id LIKE 'gate-%' OR collection_id LIKE 'gate-%' OR r2_key LIKE 'gate/transform-gate-%') + (SELECT COUNT(*) FROM collections WHERE id LIKE 'gate-%' OR project_id LIKE 'gate-%') + (SELECT COUNT(*) FROM projects WHERE id LIKE 'gate-%') + (SELECT COUNT(*) FROM user WHERE id LIKE 'gate-%') AS remaining",
      "remaining",
    );
    results.push(`D1 gate-row count after cleanup: ${remaining}`);
    if (remaining !== 0) results.push("D1 cleanup verification FAILED");
  } catch (error) {
    results.push(`D1 cleanup count failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  console.log("Cleanup:");
  for (const result of results) console.log(`- ${result}`);
  return results.some((result) => result.includes("failed") || result.includes("FAILED"));
}

const failures = [];
let cleanupFailed = false;
let aws;
let endpoint;

try {
  const values = parseEnv(await readFile(new URL("../workers/app/.dev.vars", import.meta.url), "utf8"));
  const accountId = values.R2_ACCOUNT_ID;
  const accessKeyId = values.R2_S3_ACCESS_KEY_ID;
  const secretAccessKey = values.R2_S3_SECRET_ACCESS_KEY;
  if (!accountId || !accessKeyId || !secretAccessKey) throw new Error("R2 S3 credentials are missing from workers/app/.dev.vars");

  console.log(`Credentials loaded (account ${mask(accountId)}, access key ${mask(accessKeyId)}, secret ${mask(secretAccessKey)}, production auth secret ${mask(productionAuthSecret)}).`);
  aws = new AwsClient({ accessKeyId, secretAccessKey, service: "s3", region: "auto" });

  const now = Date.now();
  const stamp = `${now}-${crypto.randomUUID().slice(0, 8)}`;
  const projectId = `gate-project-${stamp}`;
  const collectionId = `gate-collection-${stamp}`;
  const assetId = crypto.randomUUID();
  const userId = `gate-user-${stamp}`;
  const sessionId = `gate-session-${stamp}`;
  const token = `gate-token-${stamp}`;
  const gateKey = `gate/transform-gate-${stamp}.jpg`;
  endpoint = `https://${accountId}.r2.cloudflarestorage.com/${bucket}/${gateKey}`;
  const fixture = await makeFixture();

  console.log(`Uploading ${fixture.byteLength} byte fixture to ${gateKey}.`);
  await requireOk(await aws.fetch(endpoint, { method: "PUT", headers: { "content-type": "image/jpeg" }, body: fixture }), "upload transform gate fixture");

  console.log("Seeding temporary remote D1 rows.");
  await d1(`INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (${sqlString(projectId)}, 'Transform gate fixture', 'awaiting_raw', ${now}, ${now})`);
  await d1(`INSERT INTO collections (id, project_id, kind, status, expected_count, received_count, created_at, updated_at) VALUES (${sqlString(collectionId)}, ${sqlString(projectId)}, 'raw', 'ready', 1, 1, ${now}, ${now})`);
  await d1(`INSERT INTO assets (id, collection_id, kind, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (${sqlString(assetId)}, ${sqlString(collectionId)}, 'photo', ${sqlString(gateKey)}, 'transform-gate.jpg', ${fixture.byteLength}, 'upload', ${now}, ${now})`);
  await d1(`INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (${sqlString(userId)}, 'Transform Gate', ${sqlString(`${userId}@example.invalid`)}, 1, 'editor', 1, ${now}, ${now})`);
  await d1(`INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (${sqlString(sessionId)}, ${now + 60 * 60 * 1000}, ${sqlString(token)}, ${sqlString(userId)}, ${now}, ${now})`);

  const signature = signedSession(token, productionAuthSecret);
  const signedValue = `${token}.${signature}`;
  // HTTPS Better Auth deployments use __Secure- by default. Send both names so this
  // gate also works if staging retains the legacy unprefixed cookie configuration.
  const cookie = `better-auth.session_token=${signedValue}; __Secure-better-auth.session_token=${signedValue}`;
  console.log(`Requesting ${stagingOrigin}/media/asset/${assetId}/web.`);
  const response = await fetch(`${stagingOrigin}/media/asset/${assetId}/web`, { headers: { cookie } });
  const contentType = response.headers.get("content-type") ?? "";
  const cfResized = response.headers.get("cf-resized");
  const transformed = new Uint8Array(await response.arrayBuffer());

  assert("HTTP 200", response.status === 200, `status ${response.status}`, failures);
  assert("content-type is image/*", /^image\//i.test(contentType), contentType || "<missing>", failures);
  console.log(`cf-resized: ${cfResized ?? "<missing>"}`);
  assert("cf-resized is present and has no err=", Boolean(cfResized) && !/err=/i.test(cfResized), cfResized ?? "<missing>", failures);
  assert("transformed byte size is smaller than original", transformed.byteLength < fixture.byteLength, `${transformed.byteLength} < ${fixture.byteLength}`, failures);

  if (/err=9401/i.test(cfResized ?? "")) {
    console.error("Dashboard remediation: Images → Transformations → flamingfire.my → Sources → add staging.quincy.flamingfire.my and quincy.flamingfire.my.");
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`FAIL gate execution — ${message}`);
  failures.push("gate execution");
} finally {
  if (aws && endpoint) cleanupFailed = await cleanup(aws, endpoint);
  else {
    cleanupFailed = true;
    console.error("Cleanup could not start because R2 credentials or endpoint setup failed.");
  }
}

if (cleanupFailed) failures.push("cleanup");
console.log("\n=== Transform gate summary ===");
if (failures.length === 0) {
  console.log("GATE PASSED — Cloudflare Image Transformations are ready for production cutover validation.");
} else {
  console.log(`GATE FAILED — ${[...new Set(failures)].join(", ")}. Resolve the failures before production cutover.`);
  process.exitCode = 1;
}
