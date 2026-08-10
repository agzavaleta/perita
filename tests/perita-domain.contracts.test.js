'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Contracts = require('../perita-contracts.js');
const Domain = require('../perita-domain.js');

const NOW = '2026-08-05T12:00:00.000Z';
const LATER = '2026-08-05T12:01:00.000Z';

function id(number) {
  return `10000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function captureError(action) {
  try {
    action();
  } catch (error) {
    return error;
  }
  assert.fail('expected action to throw');
}

function validFinancialSettings(overrides) {
  return {
    key: 'current',
    salaryReferenceAmount: 900000,
    currency: 'CLP',
    timezone: 'America/Santiago',
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...(overrides || {}),
  };
}

function validPeriod(overrides) {
  return {
    id: id(1),
    periodKey: '2026-08',
    status: 'open',
    plannedSalaryAmount: 900000,
    openedAt: NOW,
    closedAt: null,
    snapshotId: null,
    revision: 1,
    ...(overrides || {}),
  };
}

function validPeriodOpening(overrides) {
  return {
    id: id(2),
    periodId: id(1),
    targetType: 'account',
    targetId: id(3),
    openingAmount: 0,
    ...(overrides || {}),
  };
}

function validAccount(overrides) {
  return {
    id: id(3),
    name: 'Cuenta principal',
    bank: null,
    openingBalance: 0,
    currentBalance: 0,
    status: 'active',
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...(overrides || {}),
  };
}

function validGoal(overrides) {
  return {
    id: id(4),
    name: 'Emergencias',
    targetAmount: 1000000,
    openingBalance: 0,
    currentBalance: 0,
    plannedMonthlyAmount: 100000,
    lifecycleStatus: 'active',
    progressStatus: 'in_progress',
    closedAt: null,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...(overrides || {}),
  };
}

function validDebt(overrides) {
  return {
    id: id(5),
    name: 'Crédito',
    totalAmount: 500000,
    openingOutstanding: 500000,
    outstandingAmount: 500000,
    dueDate: '2026-09-30',
    lifecycleStatus: 'active',
    paymentStatus: 'active',
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...(overrides || {}),
  };
}

function validCategory(overrides) {
  return {
    id: id(6),
    name: 'Alimentación',
    status: 'active',
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...(overrides || {}),
  };
}

function validTemplate(overrides) {
  return {
    id: id(7),
    name: 'Internet',
    referenceAmount: 25000,
    status: 'active',
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...(overrides || {}),
  };
}

function validInstance(overrides) {
  return {
    id: id(8),
    periodId: id(1),
    templateId: id(7),
    nameSnapshot: 'Internet',
    plannedAmount: 25000,
    status: 'pending',
    activePaymentOperationId: null,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...(overrides || {}),
  };
}

function validOperation(overrides) {
  return {
    id: id(9),
    periodId: id(1),
    type: 'balance_adjustment',
    operationDate: '2026-08-05',
    amount: 50000,
    status: 'posted',
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    voidedAt: null,
    voidReason: null,
    ...(overrides || {}),
  };
}

function validMovement(overrides) {
  return {
    id: id(10),
    operationId: id(9),
    periodId: id(1),
    targetType: 'account',
    targetId: id(3),
    effectType: 'asset_balance',
    delta: 50000,
    status: 'posted',
    createdAt: NOW,
    updatedAt: NOW,
    ...(overrides || {}),
  };
}

function validRevision(overrides) {
  return {
    id: id(11),
    operationId: id(9),
    periodId: id(1),
    revisionNumber: 1,
    changeType: 'edit',
    previousOperation: validOperation(),
    previousMovements: [validMovement()],
    reason: null,
    createdAt: LATER,
    ...(overrides || {}),
  };
}

function validAuditEvent(overrides) {
  return {
    id: id(12),
    periodId: id(1),
    subjectType: 'account',
    subjectId: id(3),
    action: 'created',
    commandType: 'account.create',
    previousRevision: null,
    nextRevision: 1,
    previousValue: null,
    nextValue: validAccount(),
    reason: null,
    occurredAt: NOW,
    ...(overrides || {}),
  };
}

test('V1.1.0 domain module surface and isolation', async (t) => {
  await t.test('exports frozen enums with every approved operation type', () => {
    assert.deepEqual(Domain.OPERATION_TYPES, [
      'balance_adjustment',
      'salary_receipt',
      'additional_income',
      'variable_expense',
      'fixed_expense_payment',
      'debt_payment',
      'debt_total_adjustment',
      'savings_deposit',
      'savings_withdrawal',
      'transfer',
    ]);
    for (const values of [
      Domain.PERIOD_STATUSES,
      Domain.ACCOUNT_STATUSES,
      Domain.GOAL_LIFECYCLE_STATUSES,
      Domain.GOAL_PROGRESS_STATUSES,
      Domain.DEBT_PAYMENT_STATUSES,
      Domain.OPERATION_STATUSES,
      Domain.MOVEMENT_TARGET_TYPES,
      Domain.REVISION_CHANGE_TYPES,
      Domain.AUDIT_SUBJECT_TYPES,
      Domain.AUDIT_ACTIONS,
      Domain.DOMAIN_SCOPE_TYPES,
    ]) {
      assert.equal(Object.isFrozen(values), true);
    }
  });

  await t.test('loads in a browser-style context without CommonJS or ambient application state', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'perita-domain.js'), 'utf8');
    const context = { self: { PeritaContracts: Contracts } };
    vm.runInNewContext(source, context, { filename: 'perita-domain.js' });
    assert.ok(context.self.PeritaDomain);
    assert.equal(context.self.PeritaDomain.OPERATION_TYPES.length, 10);
    assert.equal(typeof context.self.PeritaDomain.validateAccount, 'function');
    assert.doesNotMatch(source, /\bindexedDB\b|\blocalStorage\b|\bdocument\b/);
    assert.doesNotMatch(source, /new Date\s*\(\s*\)/);
  });

  await t.test('DomainError preserves the shared typed-error contract', () => {
    const error = captureError(() => Domain.validateAccount(null));
    assert.ok(error instanceof Error);
    assert.ok(error instanceof Contracts.PeritaError);
    assert.ok(error instanceof Domain.DomainError);
    assert.equal(error.code, Contracts.ERROR_CODES.INVALID_DOMAIN_RECORD);
    assert.equal(Object.isFrozen(error.context), true);
  });
});

test('V1.1.0 valid domain records', async (t) => {
  const cases = [
    ['FinancialSettings', Domain.validateFinancialSettings, validFinancialSettings()],
    ['Period', Domain.validatePeriod, validPeriod()],
    ['PeriodOpening', Domain.validatePeriodOpening, validPeriodOpening()],
    ['Account', Domain.validateAccount, validAccount()],
    ['SavingsGoal', Domain.validateSavingsGoal, validGoal()],
    ['Debt', Domain.validateDebt, validDebt()],
    ['Category', Domain.validateCategory, validCategory()],
    ['FixedExpenseTemplate', Domain.validateFixedExpenseTemplate, validTemplate()],
    ['FixedExpenseInstance', Domain.validateFixedExpenseInstance, validInstance()],
    ['Operation', Domain.validateOperation, validOperation()],
    ['Movement', Domain.validateMovement, validMovement()],
    ['OperationRevision', Domain.validateOperationRevision, validRevision()],
    ['AuditEvent', Domain.validateAuditEvent, validAuditEvent()],
  ];

  for (const [name, validator, input] of cases) {
    await t.test(`${name} returns an equivalent deeply immutable copy`, () => {
      const before = clone(input);
      const result = validator(input);
      assert.deepEqual(result, before);
      assert.notEqual(result, input);
      assert.equal(Object.isFrozen(result), true);
      for (const value of Object.values(result)) {
        if (value && typeof value === 'object') assert.equal(Object.isFrozen(value), true);
      }
      assert.deepEqual(input, before, 'validator does not mutate its input');
    });
  }
});

test('V1.1.0 required fields, scalar contracts, and enums', async (t) => {
  await t.test('Period ignores retired monthly-planning fields from existing V1.1.0 data', () => {
    const result = Domain.validatePeriod(validPeriod({
      variableExpenseBudgetAmount: 123456,
      plannedSavingsAmount: 654321,
    }));
    assert.equal(Object.hasOwn(result, 'variableExpenseBudgetAmount'), false);
    assert.equal(Object.hasOwn(result, 'plannedSavingsAmount'), false);
  });

  await t.test('every model rejects a missing required field', () => {
    const cases = [
      [Domain.validateFinancialSettings, validFinancialSettings(), 'currency'],
      [Domain.validatePeriod, validPeriod(), 'periodKey'],
      [Domain.validatePeriodOpening, validPeriodOpening(), 'openingAmount'],
      [Domain.validateAccount, validAccount(), 'currentBalance'],
      [Domain.validateSavingsGoal, validGoal(), 'progressStatus'],
      [Domain.validateDebt, validDebt(), 'outstandingAmount'],
      [Domain.validateCategory, validCategory(), 'name'],
      [Domain.validateFixedExpenseTemplate, validTemplate(), 'referenceAmount'],
      [Domain.validateFixedExpenseInstance, validInstance(), 'activePaymentOperationId'],
      [Domain.validateOperation, validOperation(), 'amount'],
      [Domain.validateMovement, validMovement(), 'delta'],
      [Domain.validateOperationRevision, validRevision(), 'previousMovements'],
      [Domain.validateAuditEvent, validAuditEvent(), 'previousValue'],
    ];
    for (const [validator, record, field] of cases) {
      delete record[field];
      assert.equal(captureError(() => validator(record)).code, Contracts.ERROR_CODES.INVALID_DOMAIN_FIELD);
    }
  });

  await t.test('invalid enums are rejected', () => {
    const cases = [
      [Domain.validatePeriod, validPeriod({ status: 'active' })],
      [Domain.validateAccount, validAccount({ status: 'closed' })],
      [Domain.validateSavingsGoal, validGoal({ lifecycleStatus: 'paused' })],
      [Domain.validateDebt, validDebt({ paymentStatus: 'paused' })],
      [Domain.validateCategory, validCategory({ status: 'deleted' })],
      [Domain.validateFixedExpenseInstance, validInstance({ status: 'scheduled' })],
      [Domain.validateOperation, validOperation({ type: 'unknown' })],
      [Domain.validateOperationRevision, validRevision({ changeType: 'delete' })],
      [Domain.validateAuditEvent, validAuditEvent({ action: 'voided' })],
    ];
    for (const [validator, record] of cases) {
      assert.equal(captureError(() => validator(record)).code, Contracts.ERROR_CODES.INVALID_DOMAIN_FIELD);
    }
  });

  await t.test('unsafe, decimal, and wrongly signed money is rejected', () => {
    for (const amount of [1.5, Number.MAX_SAFE_INTEGER + 1, '100']) {
      assert.equal(
        captureError(() => Domain.validateFinancialSettings(
          validFinancialSettings({ salaryReferenceAmount: amount })
        )).code,
        Contracts.ERROR_CODES.INVALID_MONEY
      );
    }
    assert.equal(
      captureError(() => Domain.validateSavingsGoal(validGoal({ targetAmount: -1 }))).code,
      Contracts.ERROR_CODES.MONEY_NEGATIVE_NOT_ALLOWED
    );
  });

  await t.test('invalid dates, periods, timestamps, UUIDs, and revisions are rejected', () => {
    assert.equal(
      captureError(() => Domain.validatePeriod(validPeriod({ periodKey: '2026-13' }))).code,
      Contracts.ERROR_CODES.INVALID_PERIOD
    );
    assert.equal(
      captureError(() => Domain.validateOperation(validOperation({ operationDate: '2026-02-30' }))).code,
      Contracts.ERROR_CODES.INVALID_CIVIL_DATE
    );
    assert.equal(
      captureError(() => Domain.validateDebt(validDebt({ dueDate: '2026-02-30' }))).code,
      Contracts.ERROR_CODES.INVALID_CIVIL_DATE
    );
    assert.equal(
      captureError(() => Domain.validateAccount(validAccount({ createdAt: 'not-utc' }))).code,
      Contracts.ERROR_CODES.INVALID_DOMAIN_FIELD
    );
    assert.equal(
      captureError(() => Domain.validateCategory(validCategory({ id: 'bad' }))).code,
      Contracts.ERROR_CODES.INVALID_UUID
    );
    assert.equal(
      captureError(() => Domain.validateAccount(validAccount({ revision: 0 }))).code,
      Contracts.ERROR_CODES.INVALID_REVISION
    );
  });

  await t.test('PeriodOpening accepts only the approved five fields', () => {
    for (const field of ['origin', 'effectiveDate', 'revision']) {
      const opening = validPeriodOpening({ [field]: field === 'revision' ? 1 : 'invented' });
      assert.equal(
        captureError(() => Domain.validatePeriodOpening(opening)).code,
        Contracts.ERROR_CODES.INVALID_DOMAIN_FIELD
      );
    }
  });

  await t.test('inactive accounts/debts and overdue debts obey their internal states', () => {
    assert.equal(
      captureError(() => Domain.validateAccount(
        validAccount({ status: 'inactive', currentBalance: 1 })
      )).code,
      Contracts.ERROR_CODES.DOMAIN_STATE_INVALID
    );
    assert.equal(
      captureError(() => Domain.validateDebt(
        validDebt({ paymentStatus: 'overdue', dueDate: null })
      )).code,
      Contracts.ERROR_CODES.DOMAIN_STATE_INVALID
    );
    assert.equal(
      captureError(() => Domain.validateDebt(
        validDebt({ lifecycleStatus: 'inactive' })
      )).code,
      Contracts.ERROR_CODES.DOMAIN_STATE_INVALID
    );
  });
});

test('V1.1.0 movement convention and operation context', async (t) => {
  await t.test('accepts positive and negative account, goal, and debt deltas', () => {
    const cases = [
      validMovement({ delta: 100 }),
      validMovement({ delta: -100 }),
      validMovement({ targetType: 'savings_goal', targetId: id(4), delta: 100 }),
      validMovement({ targetType: 'savings_goal', targetId: id(4), delta: -100 }),
      validMovement({
        targetType: 'debt', targetId: id(5), effectType: 'debt_outstanding', delta: 100,
      }),
      validMovement({
        targetType: 'debt', targetId: id(5), effectType: 'debt_outstanding', delta: -100,
      }),
    ];
    for (const movement of cases) assert.equal(Domain.validateMovement(movement).delta, movement.delta);
  });

  await t.test('rejects zero/unsafe deltas and incompatible effects', () => {
    for (const delta of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal(
        captureError(() => Domain.validateMovement(validMovement({ delta }))).code,
        Contracts.ERROR_CODES.INVALID_DELTA
      );
    }
    assert.equal(
      captureError(() => Domain.validateMovement(validMovement({ effectType: 'debt_outstanding' }))).code,
      Contracts.ERROR_CODES.DOMAIN_RELATION_MISMATCH
    );
  });

  await t.test('movement identity, period, and status must match its operation', () => {
    assert.doesNotThrow(() => Domain.assertMovementMatchesOperation(validOperation(), validMovement()));
    for (const movement of [
      validMovement({ operationId: id(99) }),
      validMovement({ periodId: id(99) }),
      validMovement({ status: 'voided' }),
    ]) {
      assert.equal(
        captureError(() => Domain.assertMovementMatchesOperation(validOperation(), movement)).code,
        Contracts.ERROR_CODES.DOMAIN_RELATION_MISMATCH
      );
    }
  });

  await t.test('operation date uses injected period and current civil date', () => {
    assert.doesNotThrow(() => Domain.assertOperationDateContext(
      validOperation(), validPeriod(), '2026-08-05'
    ));
    assert.equal(
      captureError(() => Domain.assertOperationDateContext(
        validOperation({ operationDate: '2026-08-06' }), validPeriod(), '2026-08-05'
      )).code,
      Contracts.ERROR_CODES.DOMAIN_STATE_INVALID
    );
    assert.equal(
      captureError(() => Domain.assertOperationDateContext(
        validOperation({ operationDate: '2026-07-31' }), validPeriod(), '2026-08-05'
      )).code,
      Contracts.ERROR_CODES.DATE_OUTSIDE_PERIOD
    );
  });
});

test('V1.1.0 OperationRevision contract', async (t) => {
  await t.test('preserves a complete immutable prior operation and all movements', () => {
    const input = validRevision({
      previousMovements: [
        validMovement(),
        validMovement({ id: id(13), targetId: id(14) }),
      ],
      previousOperation: validOperation({ details: { reason: 'Saldo real' } }),
    });
    const result = Domain.validateOperationRevision(input);
    input.previousOperation.details.reason = 'mutated';
    input.previousMovements[0].delta = 1;
    assert.equal(result.previousOperation.details.reason, 'Saldo real');
    assert.equal(result.previousMovements[0].delta, 50000);
    assert.equal(Object.isFrozen(result.previousOperation.details), true);
    assert.equal(Object.isFrozen(result.previousMovements[0]), true);
    assert.equal('commitId' in result, false);
    assert.equal(
      captureError(() => Domain.validateOperationRevision(
        validRevision({ commitId: id(30) })
      )).code,
      Contracts.ERROR_CODES.INVALID_DOMAIN_FIELD
    );
  });

  await t.test('rejects identity, period, revision, and movement inconsistencies', () => {
    const cases = [
      validRevision({ operationId: id(99) }),
      validRevision({ periodId: id(99) }),
      validRevision({ revisionNumber: 2 }),
      validRevision({ previousMovements: [validMovement({ operationId: id(99) })] }),
      validRevision({ previousMovements: [] }),
    ];
    for (const revision of cases) {
      assert.ok([
        Contracts.ERROR_CODES.DOMAIN_RELATION_MISMATCH,
        Contracts.ERROR_CODES.INVALID_DOMAIN_FIELD,
      ].includes(captureError(() => Domain.validateOperationRevision(revision)).code));
    }
  });

  await t.test('enforces logical operationId/revisionNumber uniqueness without an index', () => {
    const first = validRevision();
    const second = validRevision({ id: id(20) });
    assert.equal(
      captureError(() => Domain.assertUniqueOperationRevisions([first, second])).code,
      Contracts.ERROR_CODES.DUPLICATE_OPERATION_REVISION
    );
    assert.equal(Domain.assertUniqueOperationRevisions([
      first,
      validRevision({
        id: id(20),
        revisionNumber: 2,
        previousOperation: validOperation({ revision: 2 }),
      }),
    ]).length, 2);
  });
});

test('V1.1.0 AuditEvent contract', async (t) => {
  await t.test('created may have a null period for global setup/configuration', () => {
    const event = validAuditEvent({
      periodId: null,
      subjectType: 'financial_settings',
      subjectId: 'current',
      commandType: 'financial-settings.create',
      nextValue: validFinancialSettings(),
    });
    assert.equal(Domain.validateAuditEvent(event).periodId, null);
    assert.doesNotThrow(() => Domain.assertAuditEventHasNoFinancialOperation(event, null));
  });

  await t.test('updated and state changes require consecutive complete snapshots', () => {
    const previous = validAccount();
    const next = validAccount({ status: 'inactive', revision: 2, updatedAt: LATER });
    const event = validAuditEvent({
      action: 'deactivated',
      commandType: 'account.deactivate',
      previousRevision: 1,
      nextRevision: 2,
      previousValue: previous,
      nextValue: next,
    });
    assert.equal(Domain.validateAuditEvent(event).nextRevision, 2);
    assert.equal(
      captureError(() => Domain.validateAuditEvent({ ...event, nextRevision: 3 })).code,
      Contracts.ERROR_CODES.DOMAIN_STATE_INVALID
    );
  });

  await t.test('deleted keeps only the complete previous snapshot', () => {
    const event = validAuditEvent({
      action: 'deleted',
      commandType: 'account.delete-unused',
      previousRevision: 1,
      nextRevision: null,
      previousValue: validAccount(),
      nextValue: null,
    });
    assert.equal(Domain.validateAuditEvent(event).nextValue, null);
  });

  await t.test('cannot duplicate a canonical financial operation', () => {
    assert.equal(
      captureError(() => Domain.assertAuditEventHasNoFinancialOperation(
        validAuditEvent(), validOperation()
      )).code,
      Contracts.ERROR_CODES.DOMAIN_STATE_INVALID
    );
    assert.equal(
      captureError(() => Domain.validateAuditEvent(
        validAuditEvent({ operationId: id(9) })
      )).code,
      Contracts.ERROR_CODES.INVALID_DOMAIN_FIELD
    );
  });
});

test('V1.1.0 approved opening and negative-balance rules', async (t) => {
  await t.test('post-setup accounts and goals start at zero with matching PeriodOpening', () => {
    assert.doesNotThrow(() => Domain.assertPostSetupAccountOpening(
      validAccount(), validPeriodOpening(), id(1)
    ));
    assert.doesNotThrow(() => Domain.assertPostSetupSavingsGoalOpening(
      validGoal(),
      validPeriodOpening({ targetType: 'savings_goal', targetId: id(4) }),
      id(1)
    ));
    assert.equal(
      captureError(() => Domain.assertPostSetupAccountOpening(
        validAccount({ openingBalance: 10, currentBalance: 10 }),
        validPeriodOpening({ openingAmount: 10 }),
        id(1)
      )).code,
      Contracts.ERROR_CODES.DOMAIN_STATE_INVALID
    );
    assert.equal(
      captureError(() => Domain.assertPostSetupSavingsGoalOpening(
        validGoal({ openingBalance: 10, currentBalance: 10 }),
        validPeriodOpening({ targetType: 'savings_goal', targetId: id(4), openingAmount: 10 }),
        id(1)
      )).code,
      Contracts.ERROR_CODES.DOMAIN_STATE_INVALID
    );
  });

  await t.test('new debt opening equals total and has a matching PeriodOpening', () => {
    assert.doesNotThrow(() => Domain.assertNewDebtOpening(
      validDebt(),
      validPeriodOpening({ targetType: 'debt', targetId: id(5), openingAmount: 500000 }),
      id(1)
    ));
    assert.equal(
      captureError(() => Domain.assertNewDebtOpening(
        validDebt({ openingOutstanding: 400000, outstandingAmount: 400000 }),
        validPeriodOpening({ targetType: 'debt', targetId: id(5), openingAmount: 400000 }),
        id(1)
      )).code,
      Contracts.ERROR_CODES.DOMAIN_STATE_INVALID
    );
  });

  await t.test('only setup accounts may start negative', () => {
    assert.doesNotThrow(() => Domain.assertInitialBalancePolicy({
      targetType: 'account', duringSetup: true, openingBalance: -1000, currentBalance: -1000,
    }));
    for (const input of [
      { targetType: 'account', duringSetup: false, openingBalance: -1, currentBalance: -1 },
      { targetType: 'account', duringSetup: false, openingBalance: 1, currentBalance: 1 },
      { targetType: 'savings_goal', duringSetup: false, openingBalance: -1, currentBalance: -1 },
      { targetType: 'savings_goal', duringSetup: false, openingBalance: 1, currentBalance: 1 },
      { targetType: 'debt', duringSetup: false, openingBalance: -1, currentBalance: -1 },
    ]) {
      const error = captureError(() => Domain.assertInitialBalancePolicy(input));
      assert.ok([
        Contracts.ERROR_CODES.MONEY_NEGATIVE_NOT_ALLOWED,
        Contracts.ERROR_CODES.DOMAIN_STATE_INVALID,
      ].includes(error.code));
    }
  });
});

test('V1.1.0 debt adjustment and fixed-template rules', async (t) => {
  function debtAdjustment(overrides) {
    const operation = validOperation({
      type: 'debt_total_adjustment',
    });
    const movement = validMovement({
      operationId: operation.id,
      targetType: 'debt',
      targetId: id(5),
      effectType: 'debt_outstanding',
      delta: 100000,
    });
    return {
      operation,
      movements: [movement],
      period: validPeriod(),
      currentCivilDate: '2026-08-05',
      previousOutstandingAmount: 500000,
      newOutstandingAmount: 600000,
      ...(overrides || {}),
    };
  }

  await t.test('debt_total_adjustment has one exact signed debt movement', () => {
    const positive = Domain.assertDebtTotalAdjustment(debtAdjustment());
    assert.equal(positive.movement.delta, 100000);
    const negativeInput = debtAdjustment({
      previousOutstandingAmount: 500000,
      newOutstandingAmount: 400000,
    });
    negativeInput.movements[0].delta = -100000;
    assert.equal(Domain.assertDebtTotalAdjustment(negativeInput).movement.delta, -100000);
  });

  await t.test('rejects extra/account movements, wrong deltas, and future dates', () => {
    const extra = debtAdjustment();
    extra.movements.push(validMovement({ id: id(30) }));
    const account = debtAdjustment();
    account.movements[0] = validMovement({ delta: 100000 });
    const wrongDelta = debtAdjustment();
    wrongDelta.movements[0].delta = 99999;
    const future = debtAdjustment();
    future.operation.operationDate = '2026-08-06';
    for (const input of [extra, account, wrongDelta]) {
      assert.equal(
        captureError(() => Domain.assertDebtTotalAdjustment(input)).code,
        Contracts.ERROR_CODES.DEBT_ADJUSTMENT_INVALID
      );
    }
    assert.equal(
      captureError(() => Domain.assertDebtTotalAdjustment(future)).code,
      Contracts.ERROR_CODES.DOMAIN_STATE_INVALID
    );
  });

  await t.test('a template created in an open period has no current-period instance', () => {
    assert.doesNotThrow(() => Domain.assertNoCurrentPeriodFixedExpenseInstance({
      template: validTemplate(),
      activePeriod: validPeriod(),
      instances: [],
    }));
    const futureInstance = validInstance({ periodId: id(40) });
    assert.doesNotThrow(() => Domain.assertNoCurrentPeriodFixedExpenseInstance({
      template: validTemplate(),
      activePeriod: validPeriod(),
      instances: [futureInstance],
    }));
    assert.equal(
      captureError(() => Domain.assertNoCurrentPeriodFixedExpenseInstance({
        template: validTemplate(),
        activePeriod: validPeriod(),
        instances: [validInstance()],
      })).code,
      Contracts.ERROR_CODES.FIXED_INSTANCE_NOT_ALLOWED
    );
  });
});

test('V1.1.0 domain scopes are canonical and typed', () => {
  assert.equal(Domain.domainScope('account', id(3)), `account:${id(3)}`);
  assert.equal(Domain.domainScope('financial_settings', 'current'), 'financial_settings:current');
  assert.equal(
    captureError(() => Domain.domainScope('unknown', id(3))).code,
    Contracts.ERROR_CODES.INVALID_DOMAIN_FIELD
  );
  assert.equal(
    captureError(() => Domain.domainScope('financial_settings', id(3))).code,
    Contracts.ERROR_CODES.INVALID_DOMAIN_FIELD
  );
});
