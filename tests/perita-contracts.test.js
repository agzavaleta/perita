'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../perita-contracts.js');

function captureError(action) {
  try {
    action();
  } catch (error) {
    return error;
  }
  assert.fail('expected action to throw');
}

test('V1.1.0 CLP money contracts', async (t) => {
  await t.test('accepts safe positive integers without altering them', () => {
    assert.equal(C.assertMoney(1), 1);
    assert.equal(C.assertPositiveMoney(2500000), 2500000);
    assert.equal(C.assertPositiveMoney(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
  });

  await t.test('zero is accepted only when the caller explicitly allows it', () => {
    assert.equal(C.assertMoney(0, { allowZero: true }), 0);
    assert.equal(captureError(() => C.assertMoney(0)).code, C.ERROR_CODES.MONEY_ZERO_NOT_ALLOWED);
    assert.equal(captureError(() => C.assertPositiveMoney(0)).code, C.ERROR_CODES.MONEY_ZERO_NOT_ALLOWED);
  });

  await t.test('rejects NaN, infinities, decimals, strings, and unsafe integers', () => {
    const invalidValues = [
      NaN,
      Infinity,
      -Infinity,
      1.5,
      '1000',
      Number.MAX_SAFE_INTEGER + 1,
      Number.MIN_SAFE_INTEGER - 1,
    ];
    for (const value of invalidValues) {
      const error = captureError(() => C.assertMoney(value));
      assert.ok(error instanceof C.ContractValidationError);
      assert.equal(error.code, C.ERROR_CODES.INVALID_MONEY);
    }
  });

  await t.test('normal money rejects negatives without rounding or correction', () => {
    const error = captureError(() => C.assertPositiveMoney(-500));
    assert.equal(error.code, C.ERROR_CODES.MONEY_NEGATIVE_NOT_ALLOWED);
    assert.equal(error.details.value, -500);
  });

  await t.test('movement deltas accept either sign but reject zero and invalid numbers', () => {
    assert.equal(C.assertSafeDelta(900), 900);
    assert.equal(C.assertSafeDelta(-900), -900);
    for (const value of [0, 1.2, '5', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal(captureError(() => C.assertSafeDelta(value)).code, C.ERROR_CODES.INVALID_DELTA);
    }
  });
});

test('V1.1.0 civil-date and period contracts', async (t) => {
  await t.test('accepts real Gregorian dates and rejects ambiguous or impossible dates', () => {
    assert.equal(C.assertCivilDate('2024-02-29'), '2024-02-29');
    assert.equal(C.assertCivilDate('2026-07-31'), '2026-07-31');
    for (const value of ['2023-02-29', '2026-04-31', '2026-13-01', '0000-01-01', '2026-7-01', new Date()]) {
      assert.equal(captureError(() => C.assertCivilDate(value)).code, C.ERROR_CODES.INVALID_CIVIL_DATE);
    }
  });

  await t.test('validates periods and derives them without parsing Date objects', () => {
    assert.equal(C.assertPeriod('2026-07'), '2026-07');
    assert.equal(C.periodFromCivilDate('2026-07-31'), '2026-07');
    for (const value of ['2026-00', '2026-13', '2026-7', '0000-01', 202607]) {
      assert.equal(captureError(() => C.assertPeriod(value)).code, C.ERROR_CODES.INVALID_PERIOD);
    }
  });

  await t.test('advances normal periods and December arithmetically', () => {
    assert.equal(C.nextPeriod('2026-07'), '2026-08');
    assert.equal(C.nextPeriod('2026-12'), '2027-01');
    assert.equal(captureError(() => C.nextPeriod('9999-12')).code, C.ERROR_CODES.INVALID_PERIOD);
  });

  await t.test('checks membership in a period with a typed mismatch', () => {
    assert.equal(C.isCivilDateInPeriod('2026-07-31', '2026-07'), true);
    assert.equal(C.isCivilDateInPeriod('2026-08-01', '2026-07'), false);
    assert.equal(C.assertCivilDateInPeriod('2026-07-01', '2026-07'), '2026-07-01');
    assert.equal(
      captureError(() => C.assertCivilDateInPeriod('2026-08-01', '2026-07')).code,
      C.ERROR_CODES.DATE_OUTSIDE_PERIOD
    );
  });

  await t.test('Chile civil dates do not depend on the process timezone', () => {
    const modulePath = path.join(__dirname, '..', 'perita-contracts.js');
    const source = [
      `const C = require(${JSON.stringify(modulePath)});`,
      "process.stdout.write(C.civilDateInChile(new Date('2026-08-01T02:30:00.000Z')));",
    ].join('');
    for (const timezone of ['America/Santiago', 'UTC']) {
      const output = execFileSync(process.execPath, ['-e', source], {
        env: { ...process.env, TZ: timezone },
        encoding: 'utf8',
      });
      assert.equal(output, '2026-07-31');
    }
  });

  await t.test('rejects invalid technical instants with a typed error', () => {
    for (const value of [new Date('invalid'), '2026-07-31T00:00:00Z', null]) {
      assert.equal(captureError(() => C.civilDateInChile(value)).code, C.ERROR_CODES.INVALID_INSTANT);
    }
  });
});

test('V1.1.0 UUID contracts', async (t) => {
  await t.test('prefers crypto.randomUUID and validates its UUID v4 result', () => {
    let randomUuidCalls = 0;
    const id = C.createUuidV4({
      randomUUID() {
        randomUuidCalls += 1;
        return '123e4567-e89b-42d3-a456-426614174000';
      },
      getRandomValues() {
        assert.fail('getRandomValues must not run when randomUUID is available');
      },
    });
    assert.equal(randomUuidCalls, 1);
    assert.equal(id, '123e4567-e89b-42d3-a456-426614174000');
    assert.equal(C.assertUuid(id, { version: 4 }), id);
  });

  await t.test('falls back to crypto.getRandomValues and produces a valid UUID v4', () => {
    const id = C.createUuidV4({
      getRandomValues(bytes) {
        bytes.set(Uint8Array.from({ length: 16 }, (_, index) => 255 - index));
        return bytes;
      },
    });
    assert.equal(id, 'fffefdfc-fbfa-49f8-b7f6-f5f4f3f2f1f0');
    assert.equal(C.assertUuid(id, { version: 4 }), id);
  });

  await t.test('builds a canonical UUID v4 from explicit deterministic entropy', () => {
    const entropy = Uint8Array.from({ length: 16 }, (_, index) => index);
    const id = C.uuidV4FromBytes(entropy);
    assert.equal(id, '00010203-0405-4607-8809-0a0b0c0d0e0f');
    assert.equal(C.assertUuid(id, { version: 4 }), id);
    assert.deepEqual(Array.from(entropy), Array.from({ length: 16 }, (_, index) => index), 'input entropy is not mutated');
  });

  await t.test('rejects malformed entropy and malformed UUIDs', () => {
    for (const entropy of [[], new Uint8Array(15), new Array(16).fill(256), 'sixteen bytes']) {
      assert.equal(captureError(() => C.uuidV4FromBytes(entropy)).code, C.ERROR_CODES.INVALID_UUID_ENTROPY);
    }
    for (const id of ['not-a-uuid', '00000000-0000-0000-0000-000000000000', 123]) {
      assert.equal(captureError(() => C.assertUuid(id)).code, C.ERROR_CODES.INVALID_UUID);
    }
  });

  await t.test('missing cryptographic capabilities produce a typed error without Math.random fallback', () => {
    const error = captureError(() => C.createUuidV4({}));
    assert.ok(error instanceof C.ContractValidationError);
    assert.equal(error.code, C.ERROR_CODES.CRYPTO_UNAVAILABLE);
    const source = fs.readFileSync(path.join(__dirname, '..', 'perita-contracts.js'), 'utf8');
    assert.doesNotMatch(source, /Math\.random\s*\(/);
  });

  await t.test('creates RFC-compatible UUID v5 values deterministically', () => {
    const first = C.deterministicUuid(C.UUID_DNS_NAMESPACE, 'www.example.com');
    const second = C.deterministicUuid(C.UUID_DNS_NAMESPACE, 'www.example.com');
    assert.equal(first, '2ed6657d-e927-568b-95e1-2665a8aea6a2');
    assert.equal(second, first);
    assert.equal(C.assertUuid(first, { version: 5 }), first);
  });

  await t.test('different deterministic names do not collide in the tested namespace', () => {
    const account = C.deterministicUuid(C.PERITA_MIGRATION_NAMESPACE_UUID, 'account:1');
    const debt = C.deterministicUuid(C.PERITA_MIGRATION_NAMESPACE_UUID, 'debt:1');
    assert.notEqual(account, debt);
    assert.equal(C.assertUuid(C.PERITA_MIGRATION_NAMESPACE_UUID, { version: 5 }), C.PERITA_MIGRATION_NAMESPACE_UUID);
  });
});

test('V1.1.0 typed errors', async (t) => {
  await t.test('errors preserve code, message, immutable serializable context, cause, and stack', () => {
    const originalContext = { field: 'salary', input: { value: '100' } };
    const cause = new TypeError('original failure');
    const error = new C.ContractValidationError(
      C.ERROR_CODES.INVALID_MONEY,
      'salary must be a safe CLP integer',
      originalContext,
      cause
    );
    originalContext.field = 'changed';
    originalContext.input.value = 'changed';

    assert.ok(error instanceof Error);
    assert.ok(error instanceof C.PeritaError);
    assert.ok(error instanceof C.ContractValidationError);
    assert.equal(error.name, 'ContractValidationError');
    assert.equal(error.code, C.ERROR_CODES.INVALID_MONEY);
    assert.equal(error.message, 'salary must be a safe CLP integer');
    assert.deepEqual(error.context, { field: 'salary', input: { value: '100' } });
    assert.equal(error.details, error.context, 'details is a documented compatibility alias');
    assert.equal(Object.isFrozen(error.context), true);
    assert.equal(Object.isFrozen(error.context.input), true);
    assert.doesNotThrow(() => JSON.stringify(error.context));
    assert.equal(error.cause, cause);
    assert.match(error.stack, /ContractValidationError/);
    assert.match(error.message, /salary/);
  });

  await t.test('every subclass inherits the same error contract', () => {
    const cause = new Error('stale read');
    const error = new C.RevisionConflictError(
      C.ERROR_CODES.REVISION_CONFLICT,
      'revision conflict',
      { expectedRevision: 2, actualRevision: 3 },
      cause
    );
    assert.ok(error instanceof Error);
    assert.ok(error instanceof C.PeritaError);
    assert.equal(error.code, C.ERROR_CODES.REVISION_CONFLICT);
    assert.equal(error.message, 'revision conflict');
    assert.deepEqual(error.context, { expectedRevision: 2, actualRevision: 3 });
    assert.equal(error.cause, cause);
    assert.match(error.stack, /RevisionConflictError/);
  });
});

test('V1.1.0 optimistic revision contracts', async (t) => {
  await t.test('accepts positive entity revisions and optionally permits revision zero', () => {
    assert.equal(C.assertRevision(1), 1);
    assert.equal(C.assertRevision(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
    assert.equal(C.assertRevision(0, { allowZero: true }), 0);
    for (const value of [0, -1, 1.5, '1', NaN, Infinity]) {
      assert.equal(captureError(() => C.assertRevision(value)).code, C.ERROR_CODES.INVALID_REVISION);
    }
  });

  await t.test('expected revision succeeds only on an exact match', () => {
    assert.equal(C.assertExpectedRevision(4, 4), 4);
    const error = captureError(() => C.assertExpectedRevision(5, 4, {
      entityType: 'Account',
      entityId: 'account-id',
    }));
    assert.ok(error instanceof C.RevisionConflictError);
    assert.equal(error.code, C.ERROR_CODES.REVISION_CONFLICT);
    assert.deepEqual(error.details, {
      entityType: 'Account',
      entityId: 'account-id',
      expectedRevision: 4,
      actualRevision: 5,
    });
  });

  await t.test('increments safely and rejects revision overflow', () => {
    assert.equal(C.nextRevision(1), 2);
    assert.equal(C.nextRevision(0, { allowZero: true }), 1);
    const error = captureError(() => C.nextRevision(Number.MAX_SAFE_INTEGER));
    assert.equal(error.code, C.ERROR_CODES.REVISION_OVERFLOW);
  });
});
