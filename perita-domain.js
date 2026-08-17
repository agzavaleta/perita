/* perita-domain.js — pure V1.1.0 financial-domain contracts
 *
 * This module validates immutable domain records. It has no storage, runtime,
 * migration, UI, global clock, or shared mutable-state concerns.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./perita-contracts.js'));
  } else {
    root.PeritaDomain = factory(root.PeritaContracts);
  }
})(typeof self !== 'undefined' ? self : this, function (Contracts) {
  'use strict';

  if (!Contracts) throw new Error('PeritaContracts is required');

  const {
    CHILE_TIME_ZONE,
    ERROR_CODES,
    PeritaError,
    assertCivilDate,
    assertCivilDateInPeriod,
    assertMoney,
    assertPeriod,
    assertPositiveMoney,
    assertRevision,
    assertSafeDelta,
    assertUuid,
  } = Contracts;

  const PERIOD_STATUSES = Object.freeze(['open', 'closed']);
  const ACCOUNT_STATUSES = Object.freeze(['active', 'inactive']);
  const GOAL_LIFECYCLE_STATUSES = Object.freeze(['active', 'closed']);
  const GOAL_PROGRESS_STATUSES = Object.freeze(['in_progress', 'completed']);
  const DEBT_LIFECYCLE_STATUSES = Object.freeze(['active', 'inactive']);
  const DEBT_PAYMENT_STATUSES = Object.freeze(['active', 'overdue', 'paid']);
  const CATEGORY_STATUSES = Object.freeze(['active', 'inactive']);
  const FIXED_EXPENSE_TEMPLATE_STATUSES = Object.freeze(['active', 'inactive']);
  const FIXED_EXPENSE_INSTANCE_STATUSES = Object.freeze(['pending', 'paid', 'unpaid']);
  const OPERATION_STATUSES = Object.freeze(['posted', 'voided']);
  const OPERATION_TYPES = Object.freeze([
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
  const MOVEMENT_EFFECT_TYPES = Object.freeze(['asset_balance', 'debt_outstanding']);
  const MOVEMENT_TARGET_TYPES = Object.freeze(['account', 'savings_goal', 'debt']);
  const REVISION_CHANGE_TYPES = Object.freeze(['edit', 'void']);
  const AUDIT_SUBJECT_TYPES = Object.freeze([
    'financial_settings',
    'period',
    'account',
    'savings_goal',
    'debt',
    'category',
    'fixed_expense_template',
    'fixed_expense_instance',
  ]);
  const AUDIT_ACTIONS = Object.freeze([
    'created',
    'updated',
    'activated',
    'deactivated',
    'closed',
    'deleted',
  ]);
  const DOMAIN_SCOPE_TYPES = Object.freeze([
    'financial_settings',
    'period',
    'account',
    'savings_goal',
    'debt',
    'category',
    'fixed_expense_template',
    'fixed_expense_instance',
  ]);

  class DomainError extends PeritaError {}

  function domainError(code, message, context, cause) {
    return new DomainError(code, message, context, cause);
  }

  function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
    return value;
  }

  function isJsonValue(value, seen) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (!value || typeof value !== 'object') return false;
    if (seen.has(value)) return false;
    seen.add(value);
    const valid = Array.isArray(value)
      ? value.every((item) => isJsonValue(item, seen))
      : isPlainObject(value) && Object.values(value).every((item) => isJsonValue(item, seen));
    seen.delete(value);
    return valid;
  }

  function immutableCopy(value, field) {
    if (!isJsonValue(value, new Set())) {
      throw domainError(
        ERROR_CODES.INVALID_DOMAIN_FIELD,
        `${field || 'value'} must be finite, acyclic, and JSON-serializable`,
        { field: field || 'value' }
      );
    }
    return deepFreeze(JSON.parse(JSON.stringify(value)));
  }

  function requireRecord(value, modelName) {
    if (!isPlainObject(value)) {
      throw domainError(
        ERROR_CODES.INVALID_DOMAIN_RECORD,
        `${modelName} must be a plain object`,
        { modelName, valueType: Array.isArray(value) ? 'array' : typeof value }
      );
    }
    return value;
  }

  function requireFields(record, fields, modelName) {
    for (const field of fields) {
      if (!hasOwn(record, field)) {
        throw domainError(
          ERROR_CODES.INVALID_DOMAIN_FIELD,
          `${modelName}.${field} is required`,
          { modelName, field }
        );
      }
    }
  }

  function requireExactFields(record, fields, modelName) {
    requireFields(record, fields, modelName);
    const actualFields = Object.keys(record);
    if (actualFields.length !== fields.length || actualFields.some((field) => !fields.includes(field))) {
      throw domainError(
        ERROR_CODES.INVALID_DOMAIN_FIELD,
        `${modelName} contains fields outside its approved contract`,
        { modelName, fields: actualFields, allowedFields: fields }
      );
    }
  }

  function assertString(value, field, options) {
    const settings = options || {};
    if (typeof value !== 'string' || (!settings.allowEmpty && value.trim() === '')) {
      throw domainError(
        ERROR_CODES.INVALID_DOMAIN_FIELD,
        `${field} must be ${settings.allowEmpty ? 'a string' : 'a non-empty string'}`,
        { field, value }
      );
    }
    return value;
  }

  function assertNullableString(value, field) {
    if (value === null) return null;
    return assertString(value, field);
  }

  function assertEnum(value, values, field) {
    if (!values.includes(value)) {
      throw domainError(
        ERROR_CODES.INVALID_DOMAIN_FIELD,
        `${field} has an unsupported value`,
        { field, value, allowedValues: values }
      );
    }
    return value;
  }

  function assertTimestamp(value, field) {
    const parsed = typeof value === 'string' ? new Date(value) : null;
    if (!parsed || !Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
      throw domainError(
        ERROR_CODES.INVALID_DOMAIN_FIELD,
        `${field} must be a canonical ISO UTC timestamp`,
        { field, value }
      );
    }
    return value;
  }

  function assertNullableTimestamp(value, field) {
    if (value === null) return null;
    return assertTimestamp(value, field);
  }

  function assertNullableUuid(value, field) {
    if (value === null) return null;
    return assertUuid(value, { field });
  }

  function assertJsonObject(value, field, nullable) {
    if (nullable && value === null) return null;
    if (!isPlainObject(value) || !isJsonValue(value, new Set())) {
      throw domainError(
        ERROR_CODES.INVALID_DOMAIN_FIELD,
        `${field} must be a JSON-serializable plain object${nullable ? ' or null' : ''}`,
        { field }
      );
    }
    return value;
  }

  function assertUpdatedAfterCreated(record, modelName) {
    if (record.updatedAt < record.createdAt) {
      throw domainError(
        ERROR_CODES.DOMAIN_STATE_INVALID,
        `${modelName}.updatedAt cannot precede createdAt`,
        { modelName, createdAt: record.createdAt, updatedAt: record.updatedAt }
      );
    }
  }

  function validateMutableIdentity(record, modelName) {
    assertUuid(record.id, { field: `${modelName}.id` });
    assertRevision(record.revision, { field: `${modelName}.revision` });
    assertTimestamp(record.createdAt, `${modelName}.createdAt`);
    assertTimestamp(record.updatedAt, `${modelName}.updatedAt`);
    assertUpdatedAfterCreated(record, modelName);
  }

  function validateFinancialSettings(value) {
    const record = requireRecord(value, 'FinancialSettings');
    requireFields(record, [
      'key', 'salaryReferenceAmount', 'currency', 'timezone',
      'revision', 'createdAt', 'updatedAt',
    ], 'FinancialSettings');
    if (record.key !== 'current' || record.currency !== 'CLP' || record.timezone !== CHILE_TIME_ZONE) {
      throw domainError(
        ERROR_CODES.DOMAIN_STATE_INVALID,
        'FinancialSettings must use the current key, CLP, and America/Santiago',
        { key: record.key, currency: record.currency, timezone: record.timezone }
      );
    }
    assertMoney(record.salaryReferenceAmount, {
      field: 'FinancialSettings.salaryReferenceAmount', allowZero: true,
    });
    assertRevision(record.revision, { field: 'FinancialSettings.revision' });
    assertTimestamp(record.createdAt, 'FinancialSettings.createdAt');
    assertTimestamp(record.updatedAt, 'FinancialSettings.updatedAt');
    assertUpdatedAfterCreated(record, 'FinancialSettings');
    return immutableCopy(record, 'FinancialSettings');
  }

  function validatePeriod(value) {
    const record = requireRecord(value, 'Period');
    requireFields(record, [
      'id', 'periodKey', 'status', 'plannedSalaryAmount',
      'openedAt', 'closedAt', 'snapshotId', 'revision',
    ], 'Period');
    assertUuid(record.id, { field: 'Period.id' });
    assertPeriod(record.periodKey, { field: 'Period.periodKey' });
    assertEnum(record.status, PERIOD_STATUSES, 'Period.status');
    assertMoney(record.plannedSalaryAmount, {
      field: 'Period.plannedSalaryAmount', allowZero: true,
    });
    assertTimestamp(record.openedAt, 'Period.openedAt');
    assertNullableTimestamp(record.closedAt, 'Period.closedAt');
    assertNullableUuid(record.snapshotId, 'Period.snapshotId');
    assertRevision(record.revision, { field: 'Period.revision' });
    if (record.status === 'open' && (record.closedAt !== null || record.snapshotId !== null)) {
      throw domainError(
        ERROR_CODES.DOMAIN_STATE_INVALID,
        'an open Period cannot have closedAt or snapshotId',
        { periodId: record.id }
      );
    }
    if (record.status === 'closed' && (record.closedAt === null || record.snapshotId === null)) {
      throw domainError(
        ERROR_CODES.DOMAIN_STATE_INVALID,
        'a closed Period requires closedAt and snapshotId',
        { periodId: record.id }
      );
    }
    // Older V1.1.0 records can contain retired monthly-planning fields. Build
    // the canonical shape explicitly so they remain readable but disappear on
    // the next canonical write instead of leaking into projections or backups.
    return immutableCopy({
      id: record.id,
      periodKey: record.periodKey,
      status: record.status,
      plannedSalaryAmount: record.plannedSalaryAmount,
      openedAt: record.openedAt,
      closedAt: record.closedAt,
      snapshotId: record.snapshotId,
      revision: record.revision,
    }, 'Period');
  }

  function validatePeriodOpening(value) {
    const record = requireRecord(value, 'PeriodOpening');
    const fields = ['id', 'periodId', 'targetType', 'targetId', 'openingAmount'];
    requireExactFields(record, fields, 'PeriodOpening');
    assertUuid(record.id, { field: 'PeriodOpening.id' });
    assertUuid(record.periodId, { field: 'PeriodOpening.periodId' });
    assertEnum(record.targetType, MOVEMENT_TARGET_TYPES, 'PeriodOpening.targetType');
    assertUuid(record.targetId, { field: 'PeriodOpening.targetId' });
    assertMoney(record.openingAmount, {
      field: 'PeriodOpening.openingAmount', allowZero: true, allowNegative: record.targetType === 'account',
    });
    return immutableCopy(record, 'PeriodOpening');
  }

  function validateAccount(value) {
    const record = requireRecord(value, 'Account');
    requireFields(record, [
      'id', 'name', 'openingBalance', 'currentBalance', 'status',
      'revision', 'createdAt', 'updatedAt',
    ], 'Account');
    validateMutableIdentity(record, 'Account');
    assertString(record.name, 'Account.name');
    const bank = record.bank === undefined ? null : record.bank;
    assertNullableString(bank, 'Account.bank');
    assertMoney(record.openingBalance, {
      field: 'Account.openingBalance', allowZero: true, allowNegative: true,
    });
    assertMoney(record.currentBalance, {
      field: 'Account.currentBalance', allowZero: true, allowNegative: true,
    });
    assertEnum(record.status, ACCOUNT_STATUSES, 'Account.status');
    if (record.status === 'inactive' && record.currentBalance !== 0) {
      throw domainError(
        ERROR_CODES.DOMAIN_STATE_INVALID,
        'an inactive Account must have a zero current balance',
        { accountId: record.id, currentBalance: record.currentBalance }
      );
    }
    return immutableCopy({ ...record, bank }, 'Account');
  }

  function validateSavingsGoal(value) {
    const record = requireRecord(value, 'SavingsGoal');
    requireFields(record, [
      'id', 'name', 'targetAmount', 'openingBalance', 'currentBalance',
      'plannedMonthlyAmount', 'lifecycleStatus', 'progressStatus', 'closedAt',
      'revision', 'createdAt', 'updatedAt',
    ], 'SavingsGoal');
    validateMutableIdentity(record, 'SavingsGoal');
    assertString(record.name, 'SavingsGoal.name');
    const bank = record.bank === undefined ? null : record.bank;
    assertNullableString(bank, 'SavingsGoal.bank');
    assertPositiveMoney(record.targetAmount, { field: 'SavingsGoal.targetAmount' });
    for (const field of ['openingBalance', 'currentBalance', 'plannedMonthlyAmount']) {
      assertMoney(record[field], { field: `SavingsGoal.${field}`, allowZero: true });
    }
    assertEnum(record.lifecycleStatus, GOAL_LIFECYCLE_STATUSES, 'SavingsGoal.lifecycleStatus');
    assertEnum(record.progressStatus, GOAL_PROGRESS_STATUSES, 'SavingsGoal.progressStatus');
    assertNullableTimestamp(record.closedAt, 'SavingsGoal.closedAt');
    const expectedProgress = record.currentBalance >= record.targetAmount ? 'completed' : 'in_progress';
    if (record.progressStatus !== expectedProgress) {
      throw domainError(
        ERROR_CODES.DOMAIN_STATE_INVALID,
        'SavingsGoal.progressStatus does not match its current balance and target',
        { expectedProgress, actualProgress: record.progressStatus }
      );
    }
    if (record.lifecycleStatus === 'closed' && (record.currentBalance !== 0 || record.closedAt === null)) {
      throw domainError(
        ERROR_CODES.DOMAIN_STATE_INVALID,
        'a closed SavingsGoal requires a zero balance and closedAt',
        { goalId: record.id, currentBalance: record.currentBalance }
      );
    }
    if (record.lifecycleStatus === 'active' && record.closedAt !== null) {
      throw domainError(
        ERROR_CODES.DOMAIN_STATE_INVALID,
        'an active SavingsGoal cannot have closedAt',
        { goalId: record.id }
      );
    }
    return immutableCopy({ ...record, bank }, 'SavingsGoal');
  }

  function validateDebt(value) {
    const record = requireRecord(value, 'Debt');
    requireFields(record, [
      'id', 'name', 'totalAmount', 'openingOutstanding', 'outstandingAmount',
      'dueDate', 'lifecycleStatus', 'paymentStatus', 'revision', 'createdAt', 'updatedAt',
    ], 'Debt');
    validateMutableIdentity(record, 'Debt');
    assertString(record.name, 'Debt.name');
    assertPositiveMoney(record.totalAmount, { field: 'Debt.totalAmount' });
    assertMoney(record.openingOutstanding, { field: 'Debt.openingOutstanding', allowZero: true });
    assertMoney(record.outstandingAmount, { field: 'Debt.outstandingAmount', allowZero: true });
    const monthlyPaymentAmount = hasOwn(record, 'monthlyPaymentAmount')
      ? record.monthlyPaymentAmount
      : null;
    const paymentDay = hasOwn(record, 'paymentDay') ? record.paymentDay : null;
    if (monthlyPaymentAmount !== null) {
      assertPositiveMoney(monthlyPaymentAmount, { field: 'Debt.monthlyPaymentAmount' });
    }
    if (paymentDay !== null && (!Number.isSafeInteger(paymentDay) || paymentDay < 1 || paymentDay > 31)) {
      throw domainError(
        ERROR_CODES.INVALID_DOMAIN_FIELD,
        'Debt.paymentDay must be an integer between 1 and 31 or null',
        { field: 'Debt.paymentDay', value: paymentDay }
      );
    }
    if ((monthlyPaymentAmount === null) !== (paymentDay === null)) {
      throw domainError(
        ERROR_CODES.DOMAIN_STATE_INVALID,
        'Debt.monthlyPaymentAmount and Debt.paymentDay must both be defined or both be null',
        { monthlyPaymentAmount, paymentDay }
      );
    }
    if (record.dueDate !== null) assertCivilDate(record.dueDate, { field: 'Debt.dueDate' });
    assertEnum(record.lifecycleStatus, DEBT_LIFECYCLE_STATUSES, 'Debt.lifecycleStatus');
    assertEnum(record.paymentStatus, DEBT_PAYMENT_STATUSES, 'Debt.paymentStatus');
    if ((record.outstandingAmount === 0) !== (record.paymentStatus === 'paid')) {
      throw domainError(
        ERROR_CODES.DOMAIN_STATE_INVALID,
        'Debt.paymentStatus must be paid exactly when outstandingAmount is zero',
        { debtId: record.id, outstandingAmount: record.outstandingAmount, paymentStatus: record.paymentStatus }
      );
    }
    if (record.paymentStatus === 'overdue' && record.dueDate === null) {
      throw domainError(
        ERROR_CODES.DOMAIN_STATE_INVALID,
        'an overdue Debt requires a dueDate',
        { debtId: record.id }
      );
    }
    if (record.lifecycleStatus === 'inactive' && record.outstandingAmount !== 0) {
      throw domainError(
        ERROR_CODES.DOMAIN_STATE_INVALID,
        'an inactive Debt must have zero outstanding amount',
        { debtId: record.id, outstandingAmount: record.outstandingAmount }
      );
    }
    return immutableCopy({ ...record, monthlyPaymentAmount, paymentDay }, 'Debt');
  }

  function daysInMonth(year, month) {
    if (month === 2) {
      const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
      return leap ? 29 : 28;
    }
    return [4, 6, 9, 11].includes(month) ? 30 : 31;
  }

  function scheduledCivilDate(year, month, paymentDay) {
    const day = Math.min(paymentDay, daysInMonth(year, month));
    return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  function advanceScheduledMonth(year, month, offset) {
    const zeroBased = (year * 12) + (month - 1) + offset;
    return Object.freeze({
      year: Math.floor(zeroBased / 12),
      month: (zeroBased % 12) + 1,
    });
  }

  function deriveDebtSchedule(value, currentCivilDate) {
    const input = requireRecord(value, 'DebtScheduleInput');
    requireFields(
      input,
      ['outstandingAmount', 'monthlyPaymentAmount', 'paymentDay'],
      'DebtScheduleInput'
    );
    assertCivilDate(currentCivilDate, { field: 'currentCivilDate' });
    assertMoney(input.outstandingAmount, { field: 'DebtScheduleInput.outstandingAmount', allowZero: true });
    if (input.monthlyPaymentAmount === null && input.paymentDay === null) {
      return immutableCopy({
        remainingInstallments: null,
        nextPaymentDate: null,
        estimatedEndDate: null,
      });
    }
    assertPositiveMoney(input.monthlyPaymentAmount, {
      field: 'DebtScheduleInput.monthlyPaymentAmount',
    });
    if (!Number.isSafeInteger(input.paymentDay) || input.paymentDay < 1 || input.paymentDay > 31) {
      throw domainError(
        ERROR_CODES.INVALID_DOMAIN_FIELD,
        'DebtScheduleInput.paymentDay must be an integer between 1 and 31',
        { field: 'DebtScheduleInput.paymentDay', value: input.paymentDay }
      );
    }
    if (input.outstandingAmount === 0) {
      return immutableCopy({
        remainingInstallments: 0,
        nextPaymentDate: null,
        estimatedEndDate: null,
      });
    }
    const [year, month] = currentCivilDate.split('-').map(Number);
    let scheduled = advanceScheduledMonth(year, month, 0);
    let nextPaymentDate = scheduledCivilDate(scheduled.year, scheduled.month, input.paymentDay);
    if (nextPaymentDate < currentCivilDate) {
      scheduled = advanceScheduledMonth(year, month, 1);
      nextPaymentDate = scheduledCivilDate(scheduled.year, scheduled.month, input.paymentDay);
    }
    const remainingInstallments = Math.ceil(input.outstandingAmount / input.monthlyPaymentAmount);
    const finalMonth = advanceScheduledMonth(
      scheduled.year,
      scheduled.month,
      remainingInstallments - 1
    );
    return immutableCopy({
      remainingInstallments,
      nextPaymentDate,
      estimatedEndDate: scheduledCivilDate(finalMonth.year, finalMonth.month, input.paymentDay),
    });
  }

  function validateCategory(value) {
    const record = requireRecord(value, 'Category');
    requireFields(record, ['id', 'name', 'status', 'revision', 'createdAt', 'updatedAt'], 'Category');
    validateMutableIdentity(record, 'Category');
    assertString(record.name, 'Category.name');
    assertEnum(record.status, CATEGORY_STATUSES, 'Category.status');
    return immutableCopy(record, 'Category');
  }

  function validateFixedExpenseTemplate(value) {
    const record = requireRecord(value, 'FixedExpenseTemplate');
    requireFields(record, [
      'id', 'name', 'referenceAmount', 'status', 'revision', 'createdAt', 'updatedAt',
    ], 'FixedExpenseTemplate');
    validateMutableIdentity(record, 'FixedExpenseTemplate');
    assertString(record.name, 'FixedExpenseTemplate.name');
    assertPositiveMoney(record.referenceAmount, { field: 'FixedExpenseTemplate.referenceAmount' });
    assertEnum(record.status, FIXED_EXPENSE_TEMPLATE_STATUSES, 'FixedExpenseTemplate.status');
    return immutableCopy(record, 'FixedExpenseTemplate');
  }

  function validateFixedExpenseInstance(value) {
    const record = requireRecord(value, 'FixedExpenseInstance');
    requireFields(record, [
      'id', 'periodId', 'templateId', 'nameSnapshot', 'plannedAmount', 'status',
      'activePaymentOperationId', 'revision', 'createdAt', 'updatedAt',
    ], 'FixedExpenseInstance');
    validateMutableIdentity(record, 'FixedExpenseInstance');
    assertUuid(record.periodId, { field: 'FixedExpenseInstance.periodId' });
    assertUuid(record.templateId, { field: 'FixedExpenseInstance.templateId' });
    assertString(record.nameSnapshot, 'FixedExpenseInstance.nameSnapshot');
    assertPositiveMoney(record.plannedAmount, { field: 'FixedExpenseInstance.plannedAmount' });
    assertEnum(record.status, FIXED_EXPENSE_INSTANCE_STATUSES, 'FixedExpenseInstance.status');
    assertNullableUuid(record.activePaymentOperationId, 'FixedExpenseInstance.activePaymentOperationId');
    if ((record.status === 'paid') !== (record.activePaymentOperationId !== null)) {
      throw domainError(
        ERROR_CODES.DOMAIN_STATE_INVALID,
        'FixedExpenseInstance payment link must match paid status',
        { instanceId: record.id, status: record.status }
      );
    }
    return immutableCopy(record, 'FixedExpenseInstance');
  }

  function validateOperation(value) {
    const record = requireRecord(value, 'Operation');
    requireFields(record, [
      'id', 'periodId', 'type', 'operationDate', 'amount', 'status',
      'revision', 'createdAt', 'updatedAt',
    ], 'Operation');
    validateMutableIdentity(record, 'Operation');
    assertUuid(record.periodId, { field: 'Operation.periodId' });
    assertEnum(record.type, OPERATION_TYPES, 'Operation.type');
    assertCivilDate(record.operationDate, { field: 'Operation.operationDate' });
    assertPositiveMoney(record.amount, { field: 'Operation.amount' });
    assertEnum(record.status, OPERATION_STATUSES, 'Operation.status');
    if (hasOwn(record, 'voidedAt')) assertNullableTimestamp(record.voidedAt, 'Operation.voidedAt');
    if (hasOwn(record, 'voidReason')) assertNullableString(record.voidReason, 'Operation.voidReason');
    if (
      record.status === 'posted' &&
      ((hasOwn(record, 'voidedAt') && record.voidedAt !== null) ||
        (hasOwn(record, 'voidReason') && record.voidReason !== null))
    ) {
      throw domainError(
        ERROR_CODES.DOMAIN_STATE_INVALID,
        'a posted Operation cannot contain void metadata',
        { operationId: record.id }
      );
    }
    if (record.status === 'voided' && hasOwn(record, 'voidedAt') && record.voidedAt === null) {
      throw domainError(
        ERROR_CODES.DOMAIN_STATE_INVALID,
        'a voided Operation requires voidedAt',
        { operationId: record.id }
      );
    }
    return immutableCopy(record, 'Operation');
  }

  function validateMovement(value) {
    const record = requireRecord(value, 'Movement');
    requireFields(record, [
      'id', 'operationId', 'periodId', 'targetType', 'targetId', 'effectType',
      'delta', 'status', 'createdAt', 'updatedAt',
    ], 'Movement');
    assertUuid(record.id, { field: 'Movement.id' });
    assertUuid(record.operationId, { field: 'Movement.operationId' });
    assertUuid(record.periodId, { field: 'Movement.periodId' });
    assertEnum(record.targetType, MOVEMENT_TARGET_TYPES, 'Movement.targetType');
    assertUuid(record.targetId, { field: 'Movement.targetId' });
    assertEnum(record.effectType, MOVEMENT_EFFECT_TYPES, 'Movement.effectType');
    assertSafeDelta(record.delta, { field: 'Movement.delta' });
    assertEnum(record.status, OPERATION_STATUSES, 'Movement.status');
    assertTimestamp(record.createdAt, 'Movement.createdAt');
    assertTimestamp(record.updatedAt, 'Movement.updatedAt');
    assertUpdatedAfterCreated(record, 'Movement');
    const expectedEffect = record.targetType === 'debt' ? 'debt_outstanding' : 'asset_balance';
    if (record.effectType !== expectedEffect) {
      throw domainError(
        ERROR_CODES.DOMAIN_RELATION_MISMATCH,
        'Movement.effectType is incompatible with targetType',
        { targetType: record.targetType, expectedEffect, actualEffect: record.effectType }
      );
    }
    return immutableCopy(record, 'Movement');
  }

  function assertMovementMatchesOperation(operationValue, movementValue) {
    const operation = validateOperation(operationValue);
    const movement = validateMovement(movementValue);
    if (
      movement.operationId !== operation.id ||
      movement.periodId !== operation.periodId ||
      movement.status !== operation.status
    ) {
      throw domainError(
        ERROR_CODES.DOMAIN_RELATION_MISMATCH,
        'Movement does not match its Operation identity, period, and status',
        {
          operationId: operation.id,
          movementOperationId: movement.operationId,
          operationPeriodId: operation.periodId,
          movementPeriodId: movement.periodId,
          operationStatus: operation.status,
          movementStatus: movement.status,
        }
      );
    }
    return movement;
  }

  function validateOperationRevision(value) {
    const record = requireRecord(value, 'OperationRevision');
    requireExactFields(record, [
      'id', 'operationId', 'periodId', 'revisionNumber', 'changeType',
      'previousOperation', 'previousMovements', 'reason', 'createdAt',
    ], 'OperationRevision');
    assertUuid(record.id, { field: 'OperationRevision.id' });
    assertUuid(record.operationId, { field: 'OperationRevision.operationId' });
    assertUuid(record.periodId, { field: 'OperationRevision.periodId' });
    assertRevision(record.revisionNumber, { field: 'OperationRevision.revisionNumber' });
    assertEnum(record.changeType, REVISION_CHANGE_TYPES, 'OperationRevision.changeType');
    assertNullableString(record.reason, 'OperationRevision.reason');
    assertTimestamp(record.createdAt, 'OperationRevision.createdAt');
    const previousOperation = validateOperation(record.previousOperation);
    if (!Array.isArray(record.previousMovements) || record.previousMovements.length === 0) {
      throw domainError(
        ERROR_CODES.INVALID_DOMAIN_FIELD,
        'OperationRevision.previousMovements must contain all previous movements',
        { operationId: record.operationId }
      );
    }
    const previousMovements = record.previousMovements.map((movement) => (
      assertMovementMatchesOperation(previousOperation, movement)
    ));
    if (
      previousOperation.id !== record.operationId ||
      previousOperation.periodId !== record.periodId ||
      previousOperation.revision !== record.revisionNumber
    ) {
      throw domainError(
        ERROR_CODES.DOMAIN_RELATION_MISMATCH,
        'OperationRevision identity, period, or revision is inconsistent',
        {
          operationId: record.operationId,
          previousOperationId: previousOperation.id,
          periodId: record.periodId,
          previousPeriodId: previousOperation.periodId,
          revisionNumber: record.revisionNumber,
          previousRevision: previousOperation.revision,
        }
      );
    }
    const movementIds = new Set(previousMovements.map((movement) => movement.id));
    if (movementIds.size !== previousMovements.length) {
      throw domainError(
        ERROR_CODES.DOMAIN_RELATION_MISMATCH,
        'OperationRevision.previousMovements contains duplicate movement IDs',
        { operationId: record.operationId }
      );
    }
    return immutableCopy(record, 'OperationRevision');
  }

  function assertUniqueOperationRevisions(values) {
    if (!Array.isArray(values)) {
      throw domainError(
        ERROR_CODES.INVALID_DOMAIN_FIELD,
        'operation revisions must be an array',
        { field: 'operationRevisions' }
      );
    }
    const seen = new Set();
    const validated = values.map(validateOperationRevision);
    for (const revision of validated) {
      const logicalKey = `${revision.operationId}:${revision.revisionNumber}`;
      if (seen.has(logicalKey)) {
        throw domainError(
          ERROR_CODES.DUPLICATE_OPERATION_REVISION,
          'operationId and revisionNumber must be logically unique',
          { operationId: revision.operationId, revisionNumber: revision.revisionNumber }
        );
      }
      seen.add(logicalKey);
    }
    return immutableCopy(validated, 'operationRevisions');
  }

  function validateAuditEvent(value) {
    const record = requireRecord(value, 'AuditEvent');
    requireExactFields(record, [
      'id', 'periodId', 'subjectType', 'subjectId', 'action', 'commandType',
      'previousRevision', 'nextRevision', 'previousValue', 'nextValue',
      'reason', 'occurredAt',
    ], 'AuditEvent');
    assertUuid(record.id, { field: 'AuditEvent.id' });
    assertNullableUuid(record.periodId, 'AuditEvent.periodId');
    assertEnum(record.subjectType, AUDIT_SUBJECT_TYPES, 'AuditEvent.subjectType');
    assertString(record.subjectId, 'AuditEvent.subjectId');
    if (record.subjectType === 'financial_settings') {
      if (record.subjectId !== 'current') {
        throw domainError(
          ERROR_CODES.DOMAIN_RELATION_MISMATCH,
          'financial settings AuditEvent subjectId must be current',
          { subjectId: record.subjectId }
        );
      }
    } else {
      assertUuid(record.subjectId, { field: 'AuditEvent.subjectId' });
    }
    assertEnum(record.action, AUDIT_ACTIONS, 'AuditEvent.action');
    assertString(record.commandType, 'AuditEvent.commandType');
    if (record.previousRevision !== null) {
      assertRevision(record.previousRevision, { field: 'AuditEvent.previousRevision' });
    }
    if (record.nextRevision !== null) {
      assertRevision(record.nextRevision, { field: 'AuditEvent.nextRevision' });
    }
    assertJsonObject(record.previousValue, 'AuditEvent.previousValue', true);
    assertJsonObject(record.nextValue, 'AuditEvent.nextValue', true);
    assertNullableString(record.reason, 'AuditEvent.reason');
    assertTimestamp(record.occurredAt, 'AuditEvent.occurredAt');

    if (record.action === 'created') {
      if (
        record.previousRevision !== null || record.previousValue !== null ||
        record.nextRevision !== 1 || record.nextValue === null
      ) {
        throw domainError(
          ERROR_CODES.DOMAIN_STATE_INVALID,
          'a created AuditEvent requires a null previous state and revision 1 next state',
          { auditEventId: record.id }
        );
      }
    } else if (record.action === 'deleted') {
      if (
        record.previousRevision === null || record.previousValue === null ||
        record.nextRevision !== null || record.nextValue !== null
      ) {
        throw domainError(
          ERROR_CODES.DOMAIN_STATE_INVALID,
          'a deleted AuditEvent requires only a previous state',
          { auditEventId: record.id }
        );
      }
    } else if (
      record.previousRevision === null || record.nextRevision === null ||
      record.previousValue === null || record.nextValue === null ||
      record.nextRevision !== record.previousRevision + 1
    ) {
      throw domainError(
        ERROR_CODES.DOMAIN_STATE_INVALID,
        'an updated or state-change AuditEvent requires consecutive complete states',
        { auditEventId: record.id, action: record.action }
      );
    }
    return immutableCopy(record, 'AuditEvent');
  }

  function assertAuditEventHasNoFinancialOperation(eventValue, operationValue) {
    const event = validateAuditEvent(eventValue);
    if (operationValue !== null && operationValue !== undefined) {
      validateOperation(operationValue);
      throw domainError(
        ERROR_CODES.DOMAIN_STATE_INVALID,
        'AuditEvent cannot duplicate a canonical financial Operation',
        { auditEventId: event.id }
      );
    }
    return event;
  }

  function assertOperationDateContext(operationValue, periodValue, currentCivilDate) {
    const operation = validateOperation(operationValue);
    const period = validatePeriod(periodValue);
    assertCivilDate(currentCivilDate, { field: 'currentCivilDate' });
    if (period.status !== 'open' || operation.periodId !== period.id) {
      throw domainError(
        ERROR_CODES.DOMAIN_STATE_INVALID,
        'Operation must belong to the active open Period',
        { operationPeriodId: operation.periodId, periodId: period.id, periodStatus: period.status }
      );
    }
    assertCivilDateInPeriod(operation.operationDate, period.periodKey);
    if (operation.operationDate > currentCivilDate) {
      throw domainError(
        ERROR_CODES.DOMAIN_STATE_INVALID,
        'Operation.operationDate cannot be in the future',
        { operationDate: operation.operationDate, currentCivilDate }
      );
    }
    return operation;
  }

  function assertOpeningMatches(opening, targetType, targetId, periodId, amount) {
    if (
      opening.targetType !== targetType || opening.targetId !== targetId ||
      opening.periodId !== periodId || opening.openingAmount !== amount
    ) {
      throw domainError(
        ERROR_CODES.DOMAIN_RELATION_MISMATCH,
        'PeriodOpening does not match its entity and period',
        { targetType, targetId, periodId, amount }
      );
    }
  }

  function assertPostSetupAccountOpening(accountValue, openingValue, periodId) {
    const account = validateAccount(accountValue);
    const opening = validatePeriodOpening(openingValue);
    assertUuid(periodId, { field: 'periodId' });
    if (account.openingBalance !== 0 || account.currentBalance !== 0) {
      throw domainError(
        ERROR_CODES.DOMAIN_STATE_INVALID,
        'an Account created after setup must start with zero opening and current balance',
        { accountId: account.id, openingBalance: account.openingBalance, currentBalance: account.currentBalance }
      );
    }
    assertOpeningMatches(opening, 'account', account.id, periodId, 0);
    return Object.freeze({ account, opening });
  }

  function assertPostSetupSavingsGoalOpening(goalValue, openingValue, periodId) {
    const goal = validateSavingsGoal(goalValue);
    const opening = validatePeriodOpening(openingValue);
    assertUuid(periodId, { field: 'periodId' });
    if (goal.openingBalance !== 0 || goal.currentBalance !== 0) {
      throw domainError(
        ERROR_CODES.DOMAIN_STATE_INVALID,
        'a SavingsGoal created after setup must start with zero opening and current balance',
        { goalId: goal.id, openingBalance: goal.openingBalance, currentBalance: goal.currentBalance }
      );
    }
    assertOpeningMatches(opening, 'savings_goal', goal.id, periodId, 0);
    return Object.freeze({ goal, opening });
  }

  function assertNewDebtOpening(debtValue, openingValue, periodId) {
    const debt = validateDebt(debtValue);
    const opening = validatePeriodOpening(openingValue);
    assertUuid(periodId, { field: 'periodId' });
    if (
      debt.openingOutstanding !== debt.totalAmount ||
      debt.outstandingAmount !== debt.totalAmount
    ) {
      throw domainError(
        ERROR_CODES.DOMAIN_STATE_INVALID,
        'a new Debt must open with outstanding amounts equal to totalAmount',
        {
          debtId: debt.id,
          totalAmount: debt.totalAmount,
          openingOutstanding: debt.openingOutstanding,
          outstandingAmount: debt.outstandingAmount,
        }
      );
    }
    assertOpeningMatches(opening, 'debt', debt.id, periodId, debt.totalAmount);
    return Object.freeze({ debt, opening });
  }

  function assertInitialBalancePolicy(input) {
    const request = requireRecord(input, 'InitialBalancePolicy');
    requireFields(request, ['targetType', 'duringSetup', 'openingBalance', 'currentBalance'], 'InitialBalancePolicy');
    assertEnum(request.targetType, MOVEMENT_TARGET_TYPES, 'InitialBalancePolicy.targetType');
    if (typeof request.duringSetup !== 'boolean') {
      throw domainError(
        ERROR_CODES.INVALID_DOMAIN_FIELD,
        'InitialBalancePolicy.duringSetup must be boolean',
        { duringSetup: request.duringSetup }
      );
    }
    assertMoney(request.openingBalance, {
      field: 'InitialBalancePolicy.openingBalance',
      allowZero: true,
      allowNegative: request.targetType === 'account' && request.duringSetup,
    });
    assertMoney(request.currentBalance, {
      field: 'InitialBalancePolicy.currentBalance',
      allowZero: true,
      allowNegative: request.targetType === 'account' && request.duringSetup,
    });
    if (request.currentBalance !== request.openingBalance) {
      throw domainError(
        ERROR_CODES.DOMAIN_STATE_INVALID,
        'an entity must begin with currentBalance equal to openingBalance',
        { openingBalance: request.openingBalance, currentBalance: request.currentBalance }
      );
    }
    if (request.targetType === 'account' && !request.duringSetup && request.openingBalance !== 0) {
      throw domainError(
        ERROR_CODES.DOMAIN_STATE_INVALID,
        'an Account created after setup must begin at zero',
        { openingBalance: request.openingBalance }
      );
    }
    if (request.targetType === 'savings_goal' && request.openingBalance !== 0) {
      throw domainError(
        ERROR_CODES.DOMAIN_STATE_INVALID,
        'a SavingsGoal must begin at zero',
        { openingBalance: request.openingBalance }
      );
    }
    return immutableCopy(request, 'InitialBalancePolicy');
  }

  function assertDebtTotalAdjustment(input) {
    const request = requireRecord(input, 'DebtTotalAdjustment');
    requireFields(request, [
      'operation', 'movements', 'period', 'currentCivilDate',
      'previousOutstandingAmount', 'newOutstandingAmount',
    ], 'DebtTotalAdjustment');
    const operation = assertOperationDateContext(
      request.operation,
      request.period,
      request.currentCivilDate
    );
    if (operation.type !== 'debt_total_adjustment') {
      throw domainError(
        ERROR_CODES.DEBT_ADJUSTMENT_INVALID,
        'debt total adjustment requires operation type debt_total_adjustment',
        { operationType: operation.type }
      );
    }
    assertMoney(request.previousOutstandingAmount, {
      field: 'previousOutstandingAmount', allowZero: true,
    });
    assertMoney(request.newOutstandingAmount, {
      field: 'newOutstandingAmount', allowZero: true,
    });
    if (!Array.isArray(request.movements) || request.movements.length !== 1) {
      throw domainError(
        ERROR_CODES.DEBT_ADJUSTMENT_INVALID,
        'debt total adjustment requires exactly one movement',
        { movementCount: request.movements && request.movements.length }
      );
    }
    const movement = assertMovementMatchesOperation(operation, request.movements[0]);
    const expectedDelta = request.newOutstandingAmount - request.previousOutstandingAmount;
    if (
      !Number.isSafeInteger(expectedDelta) || expectedDelta === 0 ||
      movement.targetType !== 'debt' ||
      movement.effectType !== 'debt_outstanding' ||
      movement.delta !== expectedDelta
    ) {
      throw domainError(
        ERROR_CODES.DEBT_ADJUSTMENT_INVALID,
        'debt total adjustment movement is incompatible with the approved delta',
        {
          expectedDelta,
          actualDelta: movement.delta,
          targetType: movement.targetType,
          effectType: movement.effectType,
        }
      );
    }
    return Object.freeze({ operation, movement });
  }

  function assertCurrentPeriodFixedExpenseInstance(input) {
    const request = requireRecord(input, 'CurrentPeriodFixedExpenseRule');
    requireFields(
      request,
      ['template', 'activePeriod', 'instance', 'instances'],
      'CurrentPeriodFixedExpenseRule'
    );
    const template = validateFixedExpenseTemplate(request.template);
    const period = validatePeriod(request.activePeriod);
    if (period.status !== 'open') {
      throw domainError(
        ERROR_CODES.DOMAIN_STATE_INVALID,
        'the fixed-expense creation rule requires an open Period',
        { periodId: period.id, status: period.status }
      );
    }
    const instance = validateFixedExpenseInstance(request.instance);
    if (!Array.isArray(request.instances)) {
      throw domainError(
        ERROR_CODES.INVALID_DOMAIN_FIELD,
        'instances must be an array',
        { field: 'instances' }
      );
    }
    const instances = request.instances.map(validateFixedExpenseInstance);
    if (
      instance.periodId !== period.id ||
      instance.templateId !== template.id ||
      instance.nameSnapshot !== template.name ||
      instance.plannedAmount !== template.referenceAmount ||
      instance.status !== 'pending' ||
      instance.activePaymentOperationId !== null ||
      instance.revision !== 1
    ) {
      throw domainError(
        ERROR_CODES.DOMAIN_RELATION_MISMATCH,
        'the current FixedExpenseInstance must match its active Period and template',
        { templateId: template.id, periodId: period.id, instanceId: instance.id }
      );
    }
    const duplicate = instances.find(
      (stored) => stored.periodId === period.id && stored.templateId === template.id
    );
    if (duplicate) {
      throw domainError(
        ERROR_CODES.FIXED_INSTANCE_NOT_ALLOWED,
        'the active Period already has an instance for this FixedExpenseTemplate',
        { templateId: template.id, periodId: period.id, instanceId: duplicate.id }
      );
    }
    return Object.freeze({
      template,
      activePeriod: period,
      instance,
      instances: immutableCopy(instances, 'instances'),
    });
  }

  function domainScope(scopeType, subjectId) {
    assertEnum(scopeType, DOMAIN_SCOPE_TYPES, 'scopeType');
    if (scopeType === 'financial_settings') {
      if (subjectId !== 'current') {
        throw domainError(
          ERROR_CODES.INVALID_DOMAIN_FIELD,
          'financial_settings scope subjectId must be current',
          { subjectId }
        );
      }
    } else {
      assertUuid(subjectId, { field: 'subjectId' });
    }
    return `${scopeType}:${subjectId}`;
  }

  return Object.freeze({
    PERIOD_STATUSES,
    ACCOUNT_STATUSES,
    GOAL_LIFECYCLE_STATUSES,
    GOAL_PROGRESS_STATUSES,
    DEBT_LIFECYCLE_STATUSES,
    DEBT_PAYMENT_STATUSES,
    CATEGORY_STATUSES,
    FIXED_EXPENSE_TEMPLATE_STATUSES,
    FIXED_EXPENSE_INSTANCE_STATUSES,
    OPERATION_STATUSES,
    OPERATION_TYPES,
    MOVEMENT_EFFECT_TYPES,
    MOVEMENT_TARGET_TYPES,
    REVISION_CHANGE_TYPES,
    AUDIT_SUBJECT_TYPES,
    AUDIT_ACTIONS,
    DOMAIN_SCOPE_TYPES,
    DomainError,
    validateFinancialSettings,
    validatePeriod,
    validatePeriodOpening,
    validateAccount,
    validateSavingsGoal,
    validateDebt,
    deriveDebtSchedule,
    validateCategory,
    validateFixedExpenseTemplate,
    validateFixedExpenseInstance,
    validateOperation,
    validateMovement,
    validateOperationRevision,
    validateAuditEvent,
    assertMovementMatchesOperation,
    assertUniqueOperationRevisions,
    assertAuditEventHasNoFinancialOperation,
    assertOperationDateContext,
    assertPostSetupAccountOpening,
    assertPostSetupSavingsGoalOpening,
    assertNewDebtOpening,
    assertInitialBalancePolicy,
    assertDebtTotalAdjustment,
    assertCurrentPeriodFixedExpenseInstance,
    domainScope,
  });
});
