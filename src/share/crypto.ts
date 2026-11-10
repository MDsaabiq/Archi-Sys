import type { Bytes } from '../share';

/* ------------------------------------------------------------------ *
 * Client-side encryption for stored share links.
 *
 * A stored link splits into two halves that travel by different routes:
 *
 *   https://breakscale.tech/?s=<id>#k=<key>
 *                              │       └── fragment: the browser NEVER
 *                              │           sends this to a server
 *                              └────────── query: the server sees only
 *                                          an opaque id
 *
 * That split is the whole design. The store holds ciphertext and the id
 * that names it, and never at any point holds the key that would open
 * it, so a reader of the store learns nothing about a single design. It
 * is the same reason the fragment carries the design itself on the
 * unstored path: browsers do not transmit what comes after `#`.
 *
 * AES-GCM rather than AES-CBC because it authenticates as well as
 * encrypts: a blob altered in the store, in transit, or by a link that
 * was retyped by hand fails to decrypt rather than decoding into
 * plausible garbage that then has to be caught downstream.
 *
 * 128 bits, not 256. The key rides in a URL people paste into chat
 * windows, and 22 base64url characters against 43 is a real difference
 * there; 128-bit AES has no practical attack and the threat this guards
 * against is a compromised store, not an adversary with a decade of
 * compute aimed at one diagram.
 *
 * The IV is 12 bytes, which is what GCM is specified around, and it is
 * fresh per encryption and prepended to the ciphertext. It is not a
 * secret and does not need to be: what it must never be is REUSED with
 * the same key, and since every design gets its own freshly generated
 * key that property holds trivially here.
 * ------------------------------------------------------------------ */

const ALGORITHM = 'AES-GCM';
const KEY_BITS = 128;

/**
 * GCM's nonce length in bytes. Twelve is the size the mode is defined
 * around; other lengths are legal but get hashed down to twelve
 * internally, which buys nothing and costs interoperability.
 */
const IV_BYTES = 12;

/** A design's key, and the ciphertext it opens. */
export interface Sealed {
  /** IV followed by ciphertext, which is what gets stored. */
  readonly blob: Bytes;
  /** Raw key bytes. Belongs in the URL fragment and nowhere else. */
  readonly key: Bytes;
}

/**
 * Whether this environment can do the crypto at all.
 *
 * `crypto.subtle` is absent on insecure origins, so a contributor
 * running the app over plain http on a LAN address has no WebCrypto at
 * all. Read at call time rather than cached, so a test can exercise both
 * paths in one run.
 */
export function hasCrypto(): boolean {
  return typeof crypto !== 'undefined' && typeof crypto.subtle !== 'undefined';
}

/**
 * Encrypt one design's bytes under a key generated for it alone.
 *
 * A fresh key per design rather than one per browser or per session: a
 * shared link hands out its key to whoever holds the URL, so a key that
 * covered several designs would mean handing out the others too.
 */
export async function seal(bytes: Bytes): Promise<Sealed> {
  const key = await crypto.subtle.generateKey(
    { name: ALGORITHM, length: KEY_BITS },
    true,
    ['encrypt', 'decrypt'],
  );
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt({ name: ALGORITHM, iv }, key, bytes);

  const blob = new Uint8Array(IV_BYTES + ciphertext.byteLength);
  blob.set(iv, 0);
  blob.set(new Uint8Array(ciphertext), IV_BYTES);

  const raw = await crypto.subtle.exportKey('raw', key);
  return { blob, key: new Uint8Array(raw) };
}

/**
 * Reverse `seal`. Returns null rather than throwing for every way this
 * can fail, because every one of them arrives from someone else's URL:
 * a truncated blob, a key that belongs to a different design, a store
 * that returned something else entirely. The caller has one thing to say
 * to the reader in all of those cases, so they collapse to one answer
 * here.
 */
export async function open(blob: Bytes, keyBytes: Bytes): Promise<Bytes | null> {
  if (blob.length <= IV_BYTES) return null;
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      keyBytes,
      { name: ALGORITHM },
      false,
      ['decrypt'],
    );
    const iv = blob.subarray(0, IV_BYTES);
    const body = blob.subarray(IV_BYTES);
    const plain = await crypto.subtle.decrypt({ name: ALGORITHM, iv }, key, body);
    return new Uint8Array(plain);
  } catch {
    // Wrong key, tampered blob, or an importKey the runtime refused.
    // All of them mean the same thing to the reader: this link does not
    // open.
    return null;
  }
}
