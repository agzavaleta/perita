/* perita-contracts.js — Perita V1.1.0 pure data contracts
 *
 * This module has no storage, migration, UI, or application-state concerns.
 * Every result depends only on explicit inputs so the contracts can be tested
 * independently before the V1.1.0 persistence layer exists.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PeritaContracts = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CHILE_TIME_ZONE = 'America/Santiago';
  const UUID_DNS_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

  const ERROR_CODES = Object.freeze({
    INVALID_MONEY: 'INVALID_MONEY',
    MONEY_ZERO_NOT_ALLOWED: 'MONEY_ZERO_NOT_ALLOWED',
    MONEY_NEGATIVE_NOT_ALLOWED: 'MONEY_NEGATIVE_NOT_ALLOWED',
    INVALID_DELTA: 'INVALID_DELTA',
    INVALID_CIVIL_DATE: 'INVALID_CIVIL_DATE',
    INVALID_PERIOD: 'INVALID_PERIOD',
    DATE_OUTSIDE_PERIOD: 'DATE_OUTSIDE_PERIOD',
    INVALID_INSTANT: 'INVALID_INSTANT',
    INVALID_UUID: 'INVALID_UUID',
    INVALID_UUID_ENTROPY: 'INVALID_UUID_ENTROPY',
    CRYPTO_UNAVAILABLE: 'CRYPTO_UNAVAILABLE',
    CRYPTO_UUID_FAILED: 'CRYPTO_UUID_FAILED',
    STORAGE_OPEN_FAILED: 'STORAGE_OPEN_FAILED',
    STORAGE_READ_FAILED: 'STORAGE_READ_FAILED',
    STORAGE_WRITE_FAILED: 'STORAGE_WRITE_FAILED',
    SCHEMA_UNSUPPORTED: 'SCHEMA_UNSUPPORTED',
    QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
    INVALID_REVISION: 'INVALID_REVISION',
    REVISION_CONFLICT: 'REVISION_CONFLICT',
    REVISION_OVERFLOW: 'REVISION_OVERFLOW',
  });

  function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
    return value;
  }

  function immutableSerializableContext(context) {
    const serialized = JSON.stringify(context || {}, (_key, value) => {
      if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
      if (typeof value === 'bigint') return value.toString();
      return value;
    });
    return deepFreeze(JSON.parse(serialized || '{}'));
  }

  class PeritaError extends Error {
    constructor(code, message, context, cause) {
      super(message, cause === undefined ? undefined : { cause });
      this.name = new.target.name;
      Object.defineProperty(this, 'code', {
        value: code,
        enumerable: true,
      });
      Object.defineProperty(this, 'context', {
        value: immutableSerializableContext(context),
        enumerable: true,
      });
      // Backward-compatible documented alias; `context` is the canonical name.
      Object.defineProperty(this, 'details', {
        get: () => this.context,
        enumerable: true,
      });
      if (cause !== undefined && this.cause !== cause) {
        Object.defineProperty(this, 'cause', {
          value: cause,
          configurable: true,
          writable: true,
        });
      }
    }
  }

  class ContractValidationError extends PeritaError {}

  class RevisionConflictError extends PeritaError {}

  class StorageError extends PeritaError {}

  function validationError(code, message, context, cause) {
    return new ContractValidationError(code, message, context, cause);
  }

  function assertMoney(value, options) {
    const settings = options || {};
    const field = settings.field || 'amount';
    const allowZero = settings.allowZero === true;
    const allowNegative = settings.allowNegative === true;

    if (!Number.isSafeInteger(value)) {
      throw validationError(
        ERROR_CODES.INVALID_MONEY,
        `${field} must be a safe CLP integer`,
        { field, value }
      );
    }
    if (value === 0 && !allowZero) {
      throw validationError(
        ERROR_CODES.MONEY_ZERO_NOT_ALLOWED,
        `${field} must not be zero`,
        { field, value }
      );
    }
    if (value < 0 && !allowNegative) {
      throw validationError(
        ERROR_CODES.MONEY_NEGATIVE_NOT_ALLOWED,
        `${field} must not be negative`,
        { field, value }
      );
    }
    return value;
  }

  function assertPositiveMoney(value, options) {
    return assertMoney(value, { ...(options || {}), allowZero: false, allowNegative: false });
  }

  function assertSafeDelta(value, options) {
    const settings = options || {};
    const field = settings.field || 'delta';
    if (!Number.isSafeInteger(value) || value === 0) {
      throw validationError(
        ERROR_CODES.INVALID_DELTA,
        `${field} must be a non-zero safe integer`,
        { field, value }
      );
    }
    return value;
  }

  function isLeapYear(year) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  }

  function daysInMonth(year, month) {
    if (month === 2) return isLeapYear(year) ? 29 : 28;
    return [4, 6, 9, 11].includes(month) ? 30 : 31;
  }

  function parseCivilDate(value) {
    const match = typeof value === 'string'
      ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
      : null;
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (
      year < 1 || year > 9999 ||
      month < 1 || month > 12 ||
      day < 1 || day > daysInMonth(year, month)
    ) {
      return null;
    }
    return { year, month, day };
  }

  function assertCivilDate(value, options) {
    const field = (options && options.field) || 'date';
    if (!parseCivilDate(value)) {
      throw validationError(
        ERROR_CODES.INVALID_CIVIL_DATE,
        `${field} must be a valid civil date in YYYY-MM-DD format`,
        { field, value }
      );
    }
    return value;
  }

  function parsePeriod(value) {
    const match = typeof value === 'string' ? /^(\d{4})-(\d{2})$/.exec(value) : null;
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    if (year < 1 || year > 9999 || month < 1 || month > 12) return null;
    return { year, month };
  }

  function assertPeriod(value, options) {
    const field = (options && options.field) || 'period';
    if (!parsePeriod(value)) {
      throw validationError(
        ERROR_CODES.INVALID_PERIOD,
        `${field} must be a valid civil period in YYYY-MM format`,
        { field, value }
      );
    }
    return value;
  }

  function periodFromCivilDate(value) {
    assertCivilDate(value);
    return value.slice(0, 7);
  }

  function nextPeriod(value) {
    const period = parsePeriod(value);
    if (!period) assertPeriod(value);
    if (period.year === 9999 && period.month === 12) {
      throw validationError(
        ERROR_CODES.INVALID_PERIOD,
        'period has no representable successor',
        { field: 'period', value }
      );
    }
    return period.month === 12
      ? `${String(period.year + 1).padStart(4, '0')}-01`
      : `${String(period.year).padStart(4, '0')}-${String(period.month + 1).padStart(2, '0')}`;
  }

  function isCivilDateInPeriod(date, period) {
    assertCivilDate(date);
    assertPeriod(period);
    return date.slice(0, 7) === period;
  }

  function assertCivilDateInPeriod(date, period) {
    if (!isCivilDateInPeriod(date, period)) {
      throw validationError(
        ERROR_CODES.DATE_OUTSIDE_PERIOD,
        `${date} does not belong to period ${period}`,
        { date, period }
      );
    }
    return date;
  }

  function civilDateInChile(instant) {
    if (!(instant instanceof Date) || !Number.isFinite(instant.getTime())) {
      throw validationError(
        ERROR_CODES.INVALID_INSTANT,
        'instant must be a valid Date',
        { value: instant }
      );
    }
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: CHILE_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(instant);
    const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${byType.year}-${byType.month}-${byType.day}`;
  }

  function assertUuid(value, options) {
    const settings = options || {};
    const field = settings.field || 'id';
    const match = typeof value === 'string'
      ? /^([0-9a-f]{8})-([0-9a-f]{4})-([1-8][0-9a-f]{3})-([89ab][0-9a-f]{3})-([0-9a-f]{12})$/i.exec(value)
      : null;
    const version = match ? Number(match[3][0]) : null;
    if (!match || (settings.version != null && version !== settings.version)) {
      throw validationError(
        ERROR_CODES.INVALID_UUID,
        `${field} must be a canonical UUID${settings.version == null ? '' : ` v${settings.version}`}`,
        { field, value, expectedVersion: settings.version == null ? null : settings.version }
      );
    }
    return value.toLowerCase();
  }

  function uuidToBytes(value) {
    const normalized = assertUuid(value);
    const compact = normalized.replace(/-/g, '');
    const bytes = new Uint8Array(16);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Number.parseInt(compact.slice(index * 2, index * 2 + 2), 16);
    }
    return bytes;
  }

  function formatUuid(bytes) {
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function normalizedEntropy(entropy) {
    const bytes = entropy instanceof Uint8Array
      ? new Uint8Array(entropy)
      : Array.isArray(entropy)
        ? new Uint8Array(entropy)
        : null;
    const validArray = bytes && entropy.length === 16;
    const validValues = validArray && Array.from(entropy).every(
      (value) => Number.isInteger(value) && value >= 0 && value <= 255
    );
    if (!validValues) {
      throw validationError(
        ERROR_CODES.INVALID_UUID_ENTROPY,
        'UUID v4 entropy must contain exactly 16 bytes',
        { length: entropy && entropy.length }
      );
    }
    return bytes;
  }

  function uuidV4FromBytes(entropy) {
    const bytes = normalizedEntropy(entropy);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    return formatUuid(bytes);
  }

  function createUuidV4(cryptoSource) {
    const source = arguments.length > 0
      ? cryptoSource
      : typeof globalThis !== 'undefined'
        ? globalThis.crypto
        : null;
    if (!source) {
      throw validationError(
        ERROR_CODES.CRYPTO_UNAVAILABLE,
        'a Web Crypto source is required to generate a UUID v4',
        { capability: 'randomUUID|getRandomValues' }
      );
    }

    if (typeof source.randomUUID === 'function') {
      try {
        return assertUuid(source.randomUUID(), { field: 'generatedUuid', version: 4 });
      } catch (cause) {
        throw validationError(
          ERROR_CODES.CRYPTO_UUID_FAILED,
          'crypto.randomUUID() did not produce a valid UUID v4',
          { method: 'randomUUID' },
          cause
        );
      }
    }

    if (typeof source.getRandomValues === 'function') {
      const bytes = new Uint8Array(16);
      try {
        source.getRandomValues(bytes);
        return uuidV4FromBytes(bytes);
      } catch (cause) {
        throw validationError(
          ERROR_CODES.CRYPTO_UUID_FAILED,
          'crypto.getRandomValues() could not generate UUID v4 entropy',
          { method: 'getRandomValues' },
          cause
        );
      }
    }

    throw validationError(
      ERROR_CODES.CRYPTO_UNAVAILABLE,
      'a Web Crypto source is required to generate a UUID v4',
      { capability: 'randomUUID|getRandomValues' }
    );
  }

  function utf8Bytes(value) {
    if (typeof value !== 'string') {
      throw validationError(
        ERROR_CODES.INVALID_UUID,
        'deterministic UUID name must be a string',
        { field: 'name', value }
      );
    }
    return new TextEncoder().encode(value);
  }

  function rotateLeft(value, bits) {
    return (value << bits) | (value >>> (32 - bits));
  }

  function sha1(input) {
    const bitLength = input.length * 8;
    const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
    const bytes = new Uint8Array(paddedLength);
    bytes.set(input);
    bytes[input.length] = 0x80;
    const view = new DataView(bytes.buffer);
    view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
    view.setUint32(paddedLength - 4, bitLength >>> 0, false);

    let h0 = 0x67452301;
    let h1 = 0xefcdab89;
    let h2 = 0x98badcfe;
    let h3 = 0x10325476;
    let h4 = 0xc3d2e1f0;
    const words = new Uint32Array(80);

    for (let offset = 0; offset < bytes.length; offset += 64) {
      for (let index = 0; index < 16; index += 1) {
        words[index] = view.getUint32(offset + index * 4, false);
      }
      for (let index = 16; index < 80; index += 1) {
        words[index] = rotateLeft(
          words[index - 3] ^ words[index - 8] ^ words[index - 14] ^ words[index - 16],
          1
        ) >>> 0;
      }

      let a = h0;
      let b = h1;
      let c = h2;
      let d = h3;
      let e = h4;
      for (let index = 0; index < 80; index += 1) {
        let f;
        let k;
        if (index < 20) {
          f = (b & c) | ((~b) & d);
          k = 0x5a827999;
        } else if (index < 40) {
          f = b ^ c ^ d;
          k = 0x6ed9eba1;
        } else if (index < 60) {
          f = (b & c) | (b & d) | (c & d);
          k = 0x8f1bbcdc;
        } else {
          f = b ^ c ^ d;
          k = 0xca62c1d6;
        }
        const temp = (rotateLeft(a, 5) + f + e + k + words[index]) >>> 0;
        e = d;
        d = c;
        c = rotateLeft(b, 30) >>> 0;
        b = a;
        a = temp;
      }

      h0 = (h0 + a) >>> 0;
      h1 = (h1 + b) >>> 0;
      h2 = (h2 + c) >>> 0;
      h3 = (h3 + d) >>> 0;
      h4 = (h4 + e) >>> 0;
    }

    const digest = new Uint8Array(20);
    const digestView = new DataView(digest.buffer);
    [h0, h1, h2, h3, h4].forEach((word, index) => {
      digestView.setUint32(index * 4, word, false);
    });
    return digest;
  }

  function deterministicUuid(namespaceUuid, name) {
    const namespace = uuidToBytes(namespaceUuid);
    const nameBytes = utf8Bytes(name);
    const input = new Uint8Array(namespace.length + nameBytes.length);
    input.set(namespace);
    input.set(nameBytes, namespace.length);
    const bytes = sha1(input).slice(0, 16);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    return formatUuid(bytes);
  }

  const PERITA_MIGRATION_NAMESPACE_UUID = deterministicUuid(
    UUID_DNS_NAMESPACE,
    'perita.app/v1.1.0/migration'
  );

  function assertRevision(value, options) {
    const settings = options || {};
    const field = settings.field || 'revision';
    const minimum = settings.allowZero === true ? 0 : 1;
    if (!Number.isSafeInteger(value) || value < minimum) {
      throw validationError(
        ERROR_CODES.INVALID_REVISION,
        `${field} must be a safe integer greater than or equal to ${minimum}`,
        { field, value, minimum }
      );
    }
    return value;
  }

  function assertExpectedRevision(actualRevision, expectedRevision, options) {
    const settings = options || {};
    const validationOptions = { allowZero: settings.allowZero === true };
    assertRevision(actualRevision, { ...validationOptions, field: 'actualRevision' });
    assertRevision(expectedRevision, { ...validationOptions, field: 'expectedRevision' });
    if (actualRevision !== expectedRevision) {
      throw new RevisionConflictError(
        ERROR_CODES.REVISION_CONFLICT,
        `expected revision ${expectedRevision}, found ${actualRevision}`,
        {
          entityType: settings.entityType || null,
          entityId: settings.entityId || null,
          expectedRevision,
          actualRevision,
        }
      );
    }
    return actualRevision;
  }

  function nextRevision(currentRevision, options) {
    const settings = options || {};
    assertRevision(currentRevision, settings);
    if (currentRevision === Number.MAX_SAFE_INTEGER) {
      throw validationError(
        ERROR_CODES.REVISION_OVERFLOW,
        'revision cannot exceed Number.MAX_SAFE_INTEGER',
        { currentRevision }
      );
    }
    return currentRevision + 1;
  }

  return {
    CHILE_TIME_ZONE,
    UUID_DNS_NAMESPACE,
    PERITA_MIGRATION_NAMESPACE_UUID,
    ERROR_CODES,
    PeritaError,
    ContractValidationError,
    RevisionConflictError,
    StorageError,
    assertMoney,
    assertPositiveMoney,
    assertSafeDelta,
    assertCivilDate,
    assertPeriod,
    periodFromCivilDate,
    nextPeriod,
    isCivilDateInPeriod,
    assertCivilDateInPeriod,
    civilDateInChile,
    assertUuid,
    uuidV4FromBytes,
    createUuidV4,
    deterministicUuid,
    assertRevision,
    assertExpectedRevision,
    nextRevision,
  };
});
