import crypto from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 — avoids read-back mistakes

function randomBlock(length: number): string {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return out;
}

/**
 * Human-readable order reference, e.g. `JD-6K3P-92T4`.
 * Uniqueness is additionally guaranteed by a unique index on Order.referenceNumber;
 * the order service retries on duplicate-key errors.
 */
export function generateOrderReference(prefix = 'JD'): string {
  return `${prefix}-${randomBlock(4)}-${randomBlock(4)}`;
}

export function generatePharmacyCode(name: string): string {
  const base = name
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
    .slice(0, 4)
    .padEnd(3, 'X');
  return `${base}${randomBlock(3)}`;
}

export function randomPassword(length = 14): string {
  const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%&*';
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += chars[bytes[i]! % chars.length];
  return out;
}
