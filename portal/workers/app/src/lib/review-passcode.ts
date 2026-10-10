/**
 * Review link passcodes (#741 11a). Stored as `pbkdf2-sha256$<iterations>$<salt b64>$<hash b64>` with a 16-byte salt per row. 100,000 is the
 * Workers PBKDF2 ceiling and needs no secret. The version prefix lets a later slice change the algorithm without a migration. Nothing here is
 * logged, and the plain passcode is never returned by any route.
 */
const PREFIX = "pbkdf2-sha256";
export const PASSCODE_ITERATIONS = 100_000;

const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const fromBase64 = (value: string): Uint8Array => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));

async function derive(passcode: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(passcode), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations }, key, 256));
}

export async function hashPasscode(passcode: string): Promise<string> {
  const salt = new Uint8Array(16); crypto.getRandomValues(salt);
  return `${PREFIX}$${PASSCODE_ITERATIONS}$${toBase64(salt)}$${toBase64(await derive(passcode, salt, PASSCODE_ITERATIONS))}`;
}

/** Constant-time compare against a stored hash. A malformed or unknown-version hash never verifies. */
export async function verifyPasscode(stored: string, passcode: string): Promise<boolean> {
  const [prefix, iterations, salt, hash] = stored.split("$");
  if (prefix !== PREFIX || !iterations || !salt || !hash || !/^\d+$/.test(iterations)) return false;
  let expected: Uint8Array; let actual: Uint8Array;
  try { expected = fromBase64(hash); actual = await derive(passcode, fromBase64(salt), Number(iterations)); } catch { return false; }
  if (expected.length !== actual.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) difference |= expected[index]! ^ actual[index]!;
  return difference === 0;
}
