import type { Env } from "../env";

const encoder = new TextEncoder();

function secret(env: Env): string | null {
  return env.BETTER_AUTH_SECRET || null;
}

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function equal(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  return difference === 0;
}

async function digest(env: Env, value: string): Promise<string | null> {
  const secretValue = secret(env);
  if (!secretValue) return null;
  const cryptoKey = await crypto.subtle.importKey("raw", encoder.encode(secretValue), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(value)));
}

export async function signTransformSource(env: Env, key: string): Promise<string | null> {
  return digest(env, key);
}

export async function verifyTransformSource(env: Env, key: string, signature: string | undefined): Promise<boolean> {
  if (!signature) return false;
  const expected = await signTransformSource(env, key);
  return expected !== null && equal(signature, expected);
}
