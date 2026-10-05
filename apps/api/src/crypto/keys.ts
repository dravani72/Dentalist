import { createCipheriv, createDecipheriv, createHash, generateKeyPairSync, KeyObject, createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Key-management boundary. Production implements these interfaces with AWS KMS (per-tenant
 * data keys for field encryption, an asymmetric KMS key for record signatures). The local
 * implementations below keep keys in files under var/keys for development and tests only.
 */
export interface FieldCipher {
  encrypt(plaintext: string, context: string): string;
  decrypt(ciphertext: string, context: string): string;
}

export interface RecordSigner {
  readonly keyId: string;
  readonly algorithm: string;
  sign(digestHex: string): Promise<string>;
  verify(digestHex: string, signatureB64: string): Promise<boolean>;
}

export const FIELD_CIPHER = Symbol('FIELD_CIPHER');
export const RECORD_SIGNER = Symbol('RECORD_SIGNER');

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** AES-256-GCM with the encryption context bound as additional authenticated data. */
export class LocalFieldCipher implements FieldCipher {
  private readonly key: Buffer;

  constructor(keyDir: string) {
    ensureDir(keyDir);
    const file = path.join(keyDir, 'field.key');
    if (!fs.existsSync(file)) fs.writeFileSync(file, randomBytes(32).toString('base64'), { mode: 0o600 });
    this.key = Buffer.from(fs.readFileSync(file, 'utf8'), 'base64');
  }

  encrypt(plaintext: string, context: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(Buffer.from(context));
    const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
    return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join('.');
  }

  decrypt(ciphertext: string, context: string): string {
    const [v, iv, tag, ct] = ciphertext.split('.');
    if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Unrecognized ciphertext');
    const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    d.setAAD(Buffer.from(context));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
  }

  /** Raw bytes variant used by local media storage. */
  encryptBytes(data: Buffer, context: string): Buffer {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(Buffer.from(context));
    const ct = Buffer.concat([c.update(data), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]);
  }

  decryptBytes(blob: Buffer, context: string): Buffer {
    const d = createDecipheriv('aes-256-gcm', this.key, blob.subarray(0, 12));
    d.setAAD(Buffer.from(context));
    d.setAuthTag(blob.subarray(12, 28));
    return Buffer.concat([d.update(blob.subarray(28)), d.final()]);
  }
}

/** Ed25519 signatures over the SHA-256 content hash of a signed encounter version. */
export class LocalRecordSigner implements RecordSigner {
  readonly algorithm = 'Ed25519';
  readonly keyId: string;
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;

  constructor(keyDir: string) {
    ensureDir(keyDir);
    const file = path.join(keyDir, 'record-signing.pem');
    if (!fs.existsSync(file)) {
      const { privateKey } = generateKeyPairSync('ed25519');
      fs.writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    }
    this.privateKey = createPrivateKey(fs.readFileSync(file));
    this.publicKey = createPublicKey(this.privateKey);
    const spki = this.publicKey.export({ type: 'spki', format: 'der' });
    this.keyId = 'local:' + createHash('sha256').update(spki).digest('hex').slice(0, 16);
  }

  async sign(digestHex: string): Promise<string> {
    return sign(null, Buffer.from(digestHex, 'hex'), this.privateKey).toString('base64');
  }

  async verify(digestHex: string, signatureB64: string): Promise<boolean> {
    return verify(null, Buffer.from(digestHex, 'hex'), this.publicKey, Buffer.from(signatureB64, 'base64'));
  }
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}
