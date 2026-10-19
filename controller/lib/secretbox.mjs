// Optional encryption at rest for job goals.
//
//   OC24_GOAL_KEY=<long random string>   -> goals are stored as `enc1.<iv>.<ct>`
//
// AES-256-GCM via WebCrypto, which exists unchanged in Node (>= 20) and in the
// Workers runtime. The key is never written to the database: if it is lost the
// goal text becomes unreadable (fail closed) while jobs, attempts, runs and
// verification results stay intact. Goals are only decrypted for an
// authenticated API response; logs and artifacts never contain them.
const PREFIX = "enc1.";
const SEALED = /^enc1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/;
const IV_BYTES = 12;

function toBase64(bytes) {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

function fromBase64(text) {
  const raw = atob(text);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function importKey(secret) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export function isSealed(value) {
  return typeof value === "string" && SEALED.test(value);
}

export async function sealText(secret, text) {
  if (!secret) return text;
  const key = await importKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(text)),
  );
  return `${PREFIX}${toBase64(iv)}.${toBase64(cipher)}`;
}

export async function openText(secret, stored) {
  if (!isSealed(stored)) return stored;
  if (!secret) return "[encrypted: OC24_GOAL_KEY is not configured on this controller]";
  try {
    const [iv, cipher] = stored.slice(PREFIX.length).split(".");
    const key = await importKey(secret);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(iv) }, key, fromBase64(cipher));
    return new TextDecoder().decode(plain);
  } catch {
    // Wrong key or tampered ciphertext: say so, do not guess and do not throw.
    return "[encrypted: cannot decrypt with the configured OC24_GOAL_KEY]";
  }
}
