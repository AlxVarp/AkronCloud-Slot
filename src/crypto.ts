import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM with per-tenant key derivation via HKDF-SHA256.
 *
 * Layout on disk / wire (bytes):
 *   [iv(12)][ciphertext(N)][tag(16)]
 *
 * The slot boot loads `SLOT_ENCRYPTION_KEY` (base64 of 32 raw bytes).
 * For each tenant, the actual cipher key is
 *   HKDF-SHA256(masterKey, salt=tenant_id, info="akroncloud-slot-v1")
 *
 * Spec: SPEC.md § 6.
 */

const ALGO = 'aes-256-gcm' as const;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const INFO = Buffer.from('akroncloud-slot-v1', 'utf8');

/** Decode the master key from base64 with a strict 32-byte length check. */
export function loadMasterKey(b64: string): Buffer {
  if (!b64) throw new Error('SLOT_ENCRYPTION_KEY is empty');
  let key: Buffer;
  try {
    key = Buffer.from(b64, 'base64');
  } catch (e) {
    throw new Error('SLOT_ENCRYPTION_KEY is not valid base64');
  }
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `SLOT_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${key.length})`,
    );
  }
  return key;
}

/**
 * Derive the per-tenant cipher key from the master + tenant id.
 * Uses HKDF-SHA256, deterministic.
 */
export function tenantKey(masterKey: Buffer, tenantId: string): Buffer {
  if (!tenantId) throw new Error('tenantId is required');
  const salt = Buffer.from(tenantId, 'utf8');
  // hkdfSync returns a single buffer of length `length` bytes.
  const derived = hkdfSync('sha256', masterKey, salt, INFO, KEY_BYTES);
  return Buffer.from(derived);
}

/**
 * Encrypt a plaintext buffer for a given tenant.
 * Returns a packed `ciphertext` buffer = iv ‖ ciphertext ‖ tag.
 *
 * `iv` is a fresh 12-byte random value per call. Caller must not
 * reuse ivs across different ciphertexts.
 */
export function encrypt(
  masterKey: Buffer,
  tenantId: string,
  plaintext: Buffer,
): { packed: Buffer; iv: Buffer; tag: Buffer } {
  const key = tenantKey(masterKey, tenantId);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const packed = Buffer.concat([iv, ct, tag]);
  return { packed, iv, tag };
}

/**
 * Decrypt a packed buffer (iv ‖ ciphertext ‖ tag) for a tenant.
 * Throws on MAC failure.
 */
export function decrypt(
  masterKey: Buffer,
  tenantId: string,
  packed: Buffer,
): Buffer {
  if (packed.length < IV_BYTES + TAG_BYTES) {
    throw new Error('ciphertext too short');
  }
  const key = tenantKey(masterKey, tenantId);
  const iv = packed.subarray(0, IV_BYTES);
  const tag = packed.subarray(packed.length - TAG_BYTES);
  const ct = packed.subarray(IV_BYTES, packed.length - TAG_BYTES);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  // zero out key copy on the way out
  key.fill(0);
  return pt;
}

/**
 * Pack helper used by tests + persistence: split a packed buffer back
 * into iv, ct, tag in case downstream wants them separately.
 */
export function unpack(packed: Buffer): { iv: Buffer; ct: Buffer; tag: Buffer } {
  const iv = packed.subarray(0, IV_BYTES);
  const tag = packed.subarray(packed.length - TAG_BYTES);
  const ct = packed.subarray(IV_BYTES, packed.length - TAG_BYTES);
  return { iv, ct, tag };
}

/** For tests / callers that need a fresh fixed master key. */
export function newMasterKeyB64(): string {
  return randomBytes(KEY_BYTES).toString('base64');
}
