import { describe, it, expect } from 'vitest';
import {
  loadMasterKey,
  tenantKey,
  encrypt,
  decrypt,
  unpack,
  newMasterKeyB64,
} from '../src/crypto';

describe('crypto: loadMasterKey', () => {
  it('rejects empty input', () => {
    expect(() => loadMasterKey('')).toThrow(/empty/);
  });

  it('rejects base64 that does not decode to 32 bytes', () => {
    expect(() => loadMasterKey('AAAA')).toThrow(/32 bytes/);
    expect(() => loadMasterKey(Buffer.alloc(48).toString('base64'))).toThrow(
      /32 bytes/,
    );
  });

  it('accepts base64 of exactly 32 bytes', () => {
    const k = loadMasterKey(newMasterKeyB64());
    expect(k.length).toBe(32);
  });
});

describe('crypto: tenantKey HKDF derivation', () => {
  it('returns 32 bytes for any non-empty tenant id', () => {
    const k = loadMasterKey(newMasterKeyB64());
    expect(tenantKey(k, 'tenant-a').length).toBe(32);
  });

  it('rejects an empty tenant id', () => {
    const k = loadMasterKey(newMasterKeyB64());
    expect(() => tenantKey(k, '')).toThrow(/tenantId/);
  });

  it('is deterministic for the same tenant id', () => {
    const k = loadMasterKey(newMasterKeyB64());
    const a1 = tenantKey(k, 'tenant-x');
    const a2 = tenantKey(k, 'tenant-x');
    expect(a1.equals(a2)).toBe(true);
  });

  it('produces different keys for different tenants', () => {
    const k = loadMasterKey(newMasterKeyB64());
    const a = tenantKey(k, 'tenant-1');
    const b = tenantKey(k, 'tenant-2');
    expect(a.equals(b)).toBe(false);
  });

  it('produces different keys for different master keys (same tenant)', () => {
    const k1 = loadMasterKey(newMasterKeyB64());
    const k2 = loadMasterKey(newMasterKeyB64());
    const t1 = tenantKey(k1, 'tenant-1');
    const t2 = tenantKey(k2, 'tenant-1');
    expect(t1.equals(t2)).toBe(false);
  });
});

describe('crypto: encrypt / decrypt', () => {
  it('round-trips a UTF-8 string', () => {
    const k = loadMasterKey(newMasterKeyB64());
    const pt = Buffer.from('hunter2-secret-password', 'utf8');
    const { packed } = encrypt(k, 'tenant-a', pt);
    const out = decrypt(k, 'tenant-a', packed);
    expect(out.equals(pt)).toBe(true);
  });

  it('round-trips a binary buffer', () => {
    const k = loadMasterKey(newMasterKeyB64());
    const pt = Buffer.from([0, 1, 2, 255, 254, 253]);
    const { packed } = encrypt(k, 'tenant', pt);
    expect(decrypt(k, 'tenant', packed).equals(pt)).toBe(true);
  });

  it('includes a fresh random iv per call (collision-resistant)', () => {
    const k = loadMasterKey(newMasterKeyB64());
    const pt = Buffer.from('same plaintext', 'utf8');
    const { packed: a } = encrypt(k, 't', pt);
    const { packed: b } = encrypt(k, 't', pt);
    expect(a.equals(b)).toBe(false);
  });

  it('packed layout is iv ‖ ct ‖ tag', () => {
    const k = loadMasterKey(newMasterKeyB64());
    const pt = Buffer.from('hello world', 'utf8');
    const { packed, iv, tag } = encrypt(k, 't', pt);
    expect(unpack(packed).iv.equals(iv)).toBe(true);
    expect(unpack(packed).tag.equals(tag)).toBe(true);
    expect(packed.length).toBe(12 + pt.length + 16);
  });

  it('rejects decryption with the wrong tenant', () => {
    const k = loadMasterKey(newMasterKeyB64());
    const pt = Buffer.from('secret', 'utf8');
    const { packed } = encrypt(k, 'tenant-a', pt);
    expect(() => decrypt(k, 'tenant-b', packed)).toThrow();
  });

  it('rejects decryption with the wrong master key', () => {
    const k1 = loadMasterKey(newMasterKeyB64());
    const k2 = loadMasterKey(newMasterKeyB64());
    const pt = Buffer.from('secret', 'utf8');
    const { packed } = encrypt(k1, 'tenant-a', pt);
    expect(() => decrypt(k2, 'tenant-a', packed)).toThrow();
  });

  it('rejects a tampered ciphertext', () => {
    const k = loadMasterKey(newMasterKeyB64());
    const pt = Buffer.from('top secret', 'utf8');
    const { packed } = encrypt(k, 'tenant-a', pt);
    packed[13] = (packed[13]! ^ 0xff) & 0xff;
    expect(() => decrypt(k, 'tenant-a', packed)).toThrow();
  });

  it('rejects a tampered tag', () => {
    const k = loadMasterKey(newMasterKeyB64());
    const pt = Buffer.from('top secret', 'utf8');
    const { packed } = encrypt(k, 'tenant-a', pt);
    packed[packed.length - 1] = (packed[packed.length - 1]! ^ 0x01) & 0x01;
    expect(() => decrypt(k, 'tenant-a', packed)).toThrow();
  });

  it('rejects a truncated buffer', () => {
    const k = loadMasterKey(newMasterKeyB64());
    const { packed } = encrypt(k, 't', Buffer.from('xx', 'utf8'));
    expect(() => decrypt(k, 't', packed.subarray(0, 10))).toThrow();
  });
});
