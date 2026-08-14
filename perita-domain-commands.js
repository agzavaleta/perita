/* perita-domain-commands.js — isolated V1.1.0 domain commands
 *
 * Persistence is delegated to PeritaRuntime so writer fencing, health gates,
 * commits, and the runtime revision remain authoritative and atomic.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./perita-contracts.js'),
      require('./perita-domain.js')
    );
  } else {
    root.PeritaDomainCommands = factory(root.PeritaContracts, root.PeritaDomain);
  }
})(typeof self !== 'undefined' ? self : this, function (Contracts, Domain) {
  'use strict';

  if (!Contracts) throw new Error('PeritaContracts is required');
  if (!Domain) throw new Error('PeritaDomain is required');

  const {
    ERROR_CODES,
    PeritaError,
    assertCivilDate,
    assertExpectedRevision,
    assertMoney,
    assertPositiveMoney,
    assertRevision,
    assertSafeDelta,
    assertUuid,
    civilDateInChile,
    nextPeriod,
    nextRevision,
  } = Contracts;

  const SETUP_COMPLETE_STORES = Object.freeze([
    'financialSettings',
    'periods',
    'accounts',
    'periodOpenings',
    'auditEvents',
  ]);
  const NEGATIVE_OPENING_BALANCE_WARNING = 'NEGATIVE_OPENING_BALANCE';
  const FINANCIAL_SETTINGS_UPDATE_STORES = Object.freeze([
    'financialSettings',
    'auditEvents',
  ]);
  const PERIOD_PLANNING_UPDATE_STORES = Object.freeze([
    'periods',
    'auditEvents',
  ]);
  const PERIOD_PLANNING_FIELDS = Object.freeze([
    'plannedSalaryAmount',
  ]);
  const ACCOUNT_CREATE_STORES = Object.freeze([
    'accounts',
    'periods',
    'periodOpenings',
    'auditEvents',
  ]);
  const ACCOUNT_CHANGE_STORES = Object.freeze([
    'accounts',
    'periods',
    'auditEvents',
  ]);
  const ACCOUNT_EDITABLE_FIELDS = Object.freeze(['name', 'bank']);
  const CATEGORY_STORES = Object.freeze(['categories', 'periods', 'auditEvents']);
  const FIXED_TEMPLATE_CREATE_STORES = Object.freeze([
    'fixedExpenseTemplates',
    'fixedExpenseInstances',
    'periods',
    'auditEvents',
  ]);
  const FIXED_TEMPLATE_CHANGE_STORES = Object.freeze([
    'fixedExpenseTemplates',
    'periods',
    'auditEvents',
  ]);
  const FIXED_INSTANCE_CHANGE_STORES = Object.freeze([
    'fixedExpenseInstances',
    'periods',
    'auditEvents',
  ]);
  const SAVINGS_GOAL_CREATE_STORES = Object.freeze([
    'savingsGoals',
    'periods',
    'periodOpenings',
    'auditEvents',
  ]);
  const SAVINGS_GOAL_CHANGE_STORES = Object.freeze([
    'savingsGoals',
    'periods',
    'auditEvents',
  ]);
  const DEBT_CREATE_STORES = Object.freeze([
    'debts',
    'periods',
    'periodOpenings',
    'auditEvents',
  ]);
  const DEBT_CHANGE_STORES = Object.freeze(['debts', 'periods', 'auditEvents']);
  const CATEGORY_EDITABLE_FIELDS = Object.freeze(['name']);
  const FIXED_TEMPLATE_EDITABLE_FIELDS = Object.freeze(['name', 'referenceAmount']);
  const SAVINGS_GOAL_EDITABLE_FIELDS = Object.freeze([
    'name',
    'bank',
    'targetAmount',
    'plannedMonthlyAmount',
  ]);
  const DEBT_EDITABLE_FIELDS = Object.freeze(['name', 'monthlyPaymentAmount', 'paymentDay']);
  const CATEGORY_FIELDS = Object.freeze([
    'id', 'name', 'status', 'revision', 'createdAt', 'updatedAt',
  ]);
  const FIXED_TEMPLATE_FIELDS = Object.freeze([
    'id', 'name', 'referenceAmount', 'status', 'revision', 'createdAt', 'updatedAt',
  ]);
  const SAVINGS_GOAL_FIELDS = Object.freeze([
    'id', 'name', 'bank', 'targetAmount', 'openingBalance', 'currentBalance',
    'plannedMonthlyAmount', 'lifecycleStatus', 'progressStatus', 'closedAt',
    'revision', 'createdAt', 'updatedAt',
  ]);
  const DEBT_FIELDS = Object.freeze([
    'id', 'name', 'totalAmount', 'openingOutstanding', 'outstandingAmount',
    'dueDate', 'monthlyPaymentAmount', 'paymentDay', 'lifecycleStatus', 'paymentStatus',
    'revision', 'createdAt', 'updatedAt',
  ]);
  const FINANCIAL_OPERATION_CREATE_STORES = Object.freeze([
    'periods',
    'accounts',
    'operations',
    'movements',
  ]);
  const SAVINGS_BALANCE_ADJUSTMENT_CREATE_STORES = Object.freeze([
    'periods',
    'savingsGoals',
    'operations',
    'movements',
  ]);
  const FINANCIAL_OPERATION_CHANGE_STORES = Object.freeze([
    ...FINANCIAL_OPERATION_CREATE_STORES,
    'operationRevisions',
  ]);
  const BALANCE_ADJUSTMENT_EDITABLE_FIELDS = Object.freeze([
    'operationDate', 'delta', 'reason',
  ]);
  const FINANCIAL_TARGET_POLICIES = Object.freeze({
    account: Object.freeze({
      storeName: 'accounts',
      balanceField: 'currentBalance',
      openingField: 'openingBalance',
      statusField: 'status',
      activeStatus: 'active',
      effectType: 'asset_balance',
      validate: Domain.validateAccount,
    }),
    savings_goal: Object.freeze({
      storeName: 'savingsGoals',
      balanceField: 'currentBalance',
      openingField: 'openingBalance',
      statusField: 'lifecycleStatus',
      activeStatus: 'active',
      effectType: 'asset_balance',
      validate: Domain.validateSavingsGoal,
    }),
    debt: Object.freeze({
      storeName: 'debts',
      balanceField: 'outstandingAmount',
      openingField: 'openingOutstanding',
      statusField: 'lifecycleStatus',
      activeStatus: 'active',
      effectType: 'debt_outstanding',
      validate: Domain.validateDebt,
    }),
  });
  const ACCOUNT_OPERATION_POLICIES = Object.freeze({
    salary_receipt: Object.freeze({ deltaSign: 1 }),
    additional_income: Object.freeze({ deltaSign: 1 }),
    variable_expense: Object.freeze({ deltaSign: -1 }),
    fixed_expense_payment: Object.freeze({ deltaSign: -1 }),
  });
  const ACCOUNT_OPERATION_CREATE_STORES = FINANCIAL_OPERATION_CREATE_STORES;
  const ACCOUNT_OPERATION_CHANGE_STORES = FINANCIAL_OPERATION_CHANGE_STORES;
  const VARIABLE_EXPENSE_CREATE_STORES = Object.freeze([
    ...ACCOUNT_OPERATION_CREATE_STORES, 'categories',
  ]);
  const VARIABLE_EXPENSE_CHANGE_STORES = Object.freeze([
    ...ACCOUNT_OPERATION_CHANGE_STORES, 'categories',
  ]);
  const FIXED_EXPENSE_PAYMENT_CREATE_STORES = Object.freeze([
    ...ACCOUNT_OPERATION_CREATE_STORES, 'fixedExpenseInstances',
  ]);
  const FIXED_EXPENSE_PAYMENT_CHANGE_STORES = Object.freeze([
    ...ACCOUNT_OPERATION_CHANGE_STORES, 'fixedExpenseInstances',
  ]);
  const MULTI_TARGET_CREATE_BASE_STORES = Object.freeze([
    'periods', 'operations', 'movements',
  ]);
  const MULTI_TARGET_CHANGE_BASE_STORES = Object.freeze([
    ...MULTI_TARGET_CREATE_BASE_STORES, 'operationRevisions',
  ]);
  const TARGET_STORE_NAMES = Object.freeze({
    account: 'accounts',
    savings_goal: 'savingsGoals',
    debt: 'debts',
  });
  const MONTHLY_CLOSE_STORES = Object.freeze([
    'financialSettings',
    'periods',
    'periodOpenings',
    'accounts',
    'savingsGoals',
    'debts',
    'categories',
    'fixedExpenseTemplates',
    'fixedExpenseInstances',
    'operations',
    'movements',
    'auditEvents',
    'periodSnapshots',
  ]);
  const MONTHLY_SUMMARY_FIELDS = Object.freeze([
    'periodId',
    'periodKey',
    'plannedSalaryAmount',
    'receivedSalaryAmount',
    'additionalIncomeAmount',
    'totalIncomeAmount',
    'fixedExpensePlannedAmount',
    'fixedExpensePaidAmount',
    'fixedExpenseUnpaidAmount',
    'variableExpenseAmount',
    'debtPaymentAmount',
    'netSavingsAmount',
    'availableAmount',
  ]);

  function domainError(code, message, context, cause) {
    return new Domain.DomainError(code, message, context, cause);
  }

  function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  function requireRecord(value, name) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw domainError(
        ERROR_CODES.INVALID_DOMAIN_RECORD,
        `${name} must be a plain object`,
        { name }
      );
    }
    return value;
  }

  function requireFields(record, fields, name) {
    for (const field of fields) {
      if (!hasOwn(record, field)) {
        throw domainError(
          ERROR_CODES.INVALID_DOMAIN_FIELD,
          `${name}.${field} is required`,
          { name, field }
        );
      }
    }
  }

  function requireOnlyFields(record, fields, name) {
    const unexpected = Object.keys(record).filter((field) => !fields.includes(field));
    if (unexpected.length > 0) {
      throw domainError(
        ERROR_CODES.INVALID_DOMAIN_FIELD,
        `${name} contains unsupported fields`,
        { name, unexpectedFields: unexpected, allowedFields: fields }
      );
    }
  }

  function validateCommandHeader(request, commandType, requiredFields, allowedFields) {
    requireFields(request, requiredFields, commandType);
    requireOnlyFields(request, allowedFields || requiredFields, commandType);
    assertRevision(request.expectedDataRevision, {
      field: 'expectedDataRevision', allowZero: true,
    });
    assertRevision(request.expectedWriterEpoch, { field: 'expectedWriterEpoch' });
    assertUuid(request.periodId, { field: 'periodId' });
  }

  function editableFieldsFrom(request, editableFields, commandType) {
    const changedFields = editableFields.filter((field) => hasOwn(request, field));
    if (changedFields.length === 0) {
      throw domainError(
        ERROR_CODES.INVALID_DOMAIN_FIELD,
        `${commandType} requires at least one editable field`,
        { editableFields }
      );
    }
    return changedFields;
  }

  function assertRealChange(previousValue, request, changedFields, commandType, entityId) {
    if (changedFields.every((field) => request[field] === previousValue[field])) {
      throw domainError(
        ERROR_CODES.INVALID_DOMAIN_FIELD,
        `${commandType} requires a real change`,
        { entityId, editableFields: changedFields }
      );
    }
  }

  function entityScopes(periodId, scopeType, entityId) {
    return [
      Domain.domainScope('period', periodId),
      Domain.domainScope(scopeType, entityId),
    ];
  }

  function requireNonEmptyString(value, field) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw domainError(
        ERROR_CODES.INVALID_DOMAIN_FIELD,
        `${field} must be a non-empty string`,
        { field }
      );
    }
    return value;
  }

  function nullableNonEmptyString(value, field) {
    if (value === null) return null;
    return requireNonEmptyString(value, field);
  }

  function currentCivilDateFromTimestamp(timestamp) {
    try {
      return civilDateInChile(new Date(timestamp));
    } catch (cause) {
      if (cause instanceof PeritaError) throw cause;
      throw domainError(
        ERROR_CODES.INVALID_DOMAIN_FIELD,
        'the injected timestamp cannot produce a Chile civil date',
        { timestamp },
        cause
      );
    }
  }

  function movementScopes(periodId, movements) {
    const scopes = [Domain.domainScope('period', periodId)];
    for (const movement of movements) {
      scopes.push(Domain.domainScope(movement.targetType, movement.targetId));
    }
    return Object.freeze([...new Set(scopes)]);
  }

  function requireFinancialTarget(targetType, value, targetId, expectedRevision, options) {
    const policy = FINANCIAL_TARGET_POLICIES[targetType];
    if (!policy) {
      throw domainError(
        ERROR_CODES.DOMAIN_RELATION_MISMATCH,
        'the financial movement target type is not supported',
        { targetType, targetId }
      );
    }
    if (value === undefined) {
      throw domainError(
        ERROR_CODES.DOMAIN_STATE_INVALID,
        'the financial movement target does not exist',
        { targetType, targetId }
      );
    }
    const entity = policy.validate(value);
    const allowInactive = options && options.allowInactive === true;
    if (
      entity.id !== targetId ||
      (!allowInactive && entity[policy.statusField] !== policy.activeStatus)
    ) {
      throw domainError(
        ERROR_CODES.DOMAIN_STATE_INVALID,
        'the financial movement target must exist and be active',
        {
          targetType,
          targetId,
          actualId: entity.id,
          status: entity[policy.statusField],
        }
      );
    }
    assertExpectedRevision(entity.revision, expectedRevision, {
      entityType: targetType,
      entityId: targetId,
    });
    return Object.freeze({ entity, policy, targetType });
  }

  function checkedBalanceDelta(balance, delta, context) {
    assertMoney(balance, {
      field: context.balanceField,
      allowZero: true,
      allowNegative: context.allowCurrentNegative === true,
    });
    assertSafeDelta(delta, { field: context.deltaField || 'delta' });
    const nextBalance = balance + delta;
    if (!Number.isSafeInteger(nextBalance)) {
      throw domainError(
        ERROR_CODES.INVALID_DOMAIN_FIELD,
        'the resulting balance must be a safe CLP integer',
        { ...context, balance, delta, nextBalance }
      );
    }
    if (nextBalance < 0) {
      throw domainError(
        ERROR_CODES.DOMAIN_STATE_INVALID,
        'the financial movement would leave an insufficient balance',
        { ...context, balance, delta, missingAmount: -nextBalance }
      );
    }
    return nextBalance;
  }

  function simulateTargetChange(target, previousDelta, nextDelta, context) {
    const balanceField = target.policy.balanceField;
    let simulated = target.entity[balanceField];
    if (previousDelta !== null) {
      simulated = checkedBalanceDelta(simulated, -previousDelta, {
        ...context,
        balanceField,
        deltaField: 'reversalDelta',
      });
    }
    if (nextDelta !== null) {
      simulated = checkedBalanceDelta(simulated, nextDelta, {
        ...context,
        balanceField,
        deltaField: 'applicationDelta',
      });
    }
    if (simulated === target.entity[balanceField]) return target.entity;
    const derived = {};
    if (target.targetType === 'savings_goal') {
      derived.progressStatus = simulated >= target.entity.targetAmount
        ? 'completed'
        : 'in_progress';
    }
    if (target.targetType === 'debt') {
      derived.paymentStatus = simulated === 0
        ? 'paid'
        : target.entity.dueDate !== null && target.entity.dueDate < context.currentCivilDate
          ? 'overdue'
          : 'active';
    }
    return target.policy.validate({
      ...target.entity,
      [balanceField]: simulated,
      ...derived,
      revision: nextRevision(target.entity.revision),
      updatedAt: context.occurredAt,
    });
  }

  function financialTargetKey(targetType, targetId) {
    return `${targetType}:${targetId}`;
  }

  function multiTargetScopes(periodId, declarations) {
    return Object.freeze([
      Domain.domainScope('period', periodId),
      ...new Set(declarations.map((target) => (
        Domain.domainScope(target.targetType, target.targetId)
      ))),
    ]);
  }

  function multiTargetStores(change, declarations) {
    const stores = change ? MULTI_TARGET_CHANGE_BASE_STORES : MULTI_TARGET_CREATE_BASE_STORES;
    return Object.freeze([
      ...stores,
      ...new Set(declarations.map((target) => TARGET_STORE_NAMES[target.targetType])),
    ]);
  }

  function mergeTargetDeclarations(declarations) {
    const merged = new Map();
    for (const declaration of declarations) {
      const key = financialTargetKey(declaration.targetType, declaration.targetId);
      const previous = merged.get(key);
      if (previous && previous.expectedRevision !== declaration.expectedRevision) {
        throw domainError(
          ERROR_CODES.INVALID_DOMAIN_FIELD,
          'the same financial target must declare one expected revision',
          {
            targetType: declaration.targetType,
            targetId: declaration.targetId,
            firstExpectedRevision: previous.expectedRevision,
            nextExpectedRevision: declaration.expectedRevision,
          }
        );
      }
      merged.set(key, Object.freeze({
        targetType: declaration.targetType,
        targetId: declaration.targetId,
        expectedRevision: declaration.expectedRevision,
        requireActive: Boolean(
          declaration.requireActive || (previous && previous.requireActive)
        ),
      }));
    }
    return Object.freeze([...merged.values()]);
  }

  function sumMovementDeltas(movements) {
    const deltas = new Map();
    for (const movement of movements) {
      const key = financialTargetKey(movement.targetType, movement.targetId);
      const next = (deltas.get(key) || 0) + movement.delta;
      if (!Number.isSafeInteger(next)) {
        throw domainError(
          ERROR_CODES.INVALID_DOMAIN_FIELD,
          'aggregated financial movement delta must remain a safe integer',
          { targetType: movement.targetType, targetId: movement.targetId }
        );
      }
      deltas.set(key, next);
    }
    return deltas;
  }

  function balanceAdjustmentDetails(accountId, reason) {
    return Object.freeze({ accountId, reason });
  }

  function savingsGoalBalanceAdjustmentDetails(goalId, reason) {
    return Object.freeze({ goalId, reason });
  }

  function validateBalanceAdjustmentOperation(operation, movement, accountId) {
    const validOperation = Domain.validateOperation(operation);
    const validMovement = Domain.assertMovementMatchesOperation(validOperation, movement);
    if (
      validOperation.type !== 'balance_adjustment' ||
      validMovement.targetType !== 'account' ||
      validMovement.targetId !== accountId ||
      validMovement.effectType !== 'asset_balance' ||
      validOperation.amount !== Math.abs(validMovement.delta)
    ) {
      throw domainError(
        ERROR_CODES.DOMAIN_RELATION_MISMATCH,
        'the operation is not a balance adjustment for the requested Account',
        {
          operationId: validOperation.id,
          operationType: validOperation.type,
          targetType: validMovement.targetType,
          targetId: validMovement.targetId,
          accountId,
          operationAmount: validOperation.amount,
          movementDelta: validMovement.delta,
        }
      );
    }
    const details = requireRecord(validOperation.details, 'Operation.details');
    requireOnlyFields(details, ['accountId', 'reason'], 'Operation.details');
    assertUuid(details.accountId, { field: 'Operation.details.accountId' });
    requireNonEmptyString(details.reason, 'Operation.details.reason');
    if (details.accountId !== accountId) {
      throw domainError(
        ERROR_CODES.DOMAIN_RELATION_MISMATCH,
        'balance adjustment details do not match its Movement',
        { operationId: validOperation.id, accountId }
      );
    }
    return Object.freeze({ operation: validOperation, movement: validMovement, details });
  }

  function validateAccountOperation(operation, movement, operationType, accountId) {
    const policy = ACCOUNT_OPERATION_POLICIES[operationType];
    if (!policy) {
      throw domainError(
        ERROR_CODES.DOMAIN_STATE_INVALID,
        'the requested account operation type is not enabled',
        { operationType }
      );
    }
    const validOperation = Domain.validateOperation(operation);
    const validMovement = Domain.assertMovementMatchesOperation(validOperation, movement);
    const expectedDelta = policy.deltaSign * validOperation.amount;
    if (
      validOperation.type !== operationType ||
      validMovement.targetType !== 'account' ||
      validMovement.targetId !== accountId ||
      validMovement.effectType !== 'asset_balance' ||
      validMovement.delta !== expectedDelta
    ) {
      throw domainError(
        ERROR_CODES.DOMAIN_RELATION_MISMATCH,
        'the account Operation and Movement are inconsistent',
        {
          operationId: validOperation.id,
          expectedType: operationType,
          actualType: validOperation.type,
          accountId,
          movementTargetId: validMovement.targetId,
          expectedDelta,
          actualDelta: validMovement.delta,
        }
      );
    }
    return Object.freeze({ operation: validOperation, movement: validMovement });
  }

  function accountOperationScopes(periodId, previousAccountId, nextAccountId, relatedScopes) {
    const movements = [
      { targetType: 'account', targetId: previousAccountId },
      { targetType: 'account', targetId: nextAccountId },
    ];
    const scopes = [...movementScopes(periodId, movements), ...(relatedScopes || [])];
    return Object.freeze([...new Set(scopes)]);
  }

  function operationDetails(operation, fields) {
    const details = requireRecord(operation.details, 'Operation.details');
    requireOnlyFields(details, fields, 'Operation.details');
    return details;
  }

  function sameJsonValue(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  function deepFreezeJson(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.freeze(value);
    Object.values(value).forEach(deepFreezeJson);
    return value;
  }

  function immutableJsonCopy(value) {
    return deepFreezeJson(JSON.parse(JSON.stringify(value)));
  }

  function canonicalJsonValue(value) {
    if (Array.isArray(value)) return value.map(canonicalJsonValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalJsonValue(value[key])])
    );
  }

  function canonicalJson(value) {
    return JSON.stringify(canonicalJsonValue(value));
  }

  function normalizeSha256(value) {
    if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) {
      throw domainError(
        ERROR_CODES.HASH_FAILED,
        'snapshot SHA-256 must be a 64-character hexadecimal string',
        { algorithm: 'SHA-256' }
      );
    }
    return value.toLowerCase();
  }

  function hashSnapshotPayload(payload, sha256) {
    if (typeof sha256 !== 'function') {
      throw domainError(
        ERROR_CODES.HASH_FAILED,
        'period.close-and-open-next requires an injected synchronous SHA-256 function',
        { algorithm: 'SHA-256' }
      );
    }
    let digest;
    try {
      digest = sha256(canonicalJson(payload));
    } catch (cause) {
      throw domainError(
        ERROR_CODES.HASH_FAILED,
        'the canonical PeriodSnapshot payload could not be hashed',
        { algorithm: 'SHA-256' },
        cause
      );
    }
    if (digest && typeof digest.then === 'function') {
      throw domainError(
        ERROR_CODES.HASH_FAILED,
        'snapshot SHA-256 must complete synchronously inside the close transaction',
        { algorithm: 'SHA-256' }
      );
    }
    return normalizeSha256(digest);
  }

  function checkedMonthlyTotal(current, amount, field) {
    const next = current + amount;
    if (!Number.isSafeInteger(next)) {
      throw domainError(
        ERROR_CODES.INVALID_DOMAIN_FIELD,
        `${field} exceeds the CLP safe-integer range`,
        { field, current, amount }
      );
    }
    return next;
  }

  function requireOperationDetails(operation, fields) {
    const details = requireRecord(operation.details, 'Operation.details');
    requireOnlyFields(details, fields, 'Operation.details');
    return details;
  }

  function validateMonthlyOperationShape(operation, movements) {
    const validOperation = Domain.validateOperation(operation);
    const related = movements.map(Domain.validateMovement);
    related.forEach((movement) => Domain.assertMovementMatchesOperation(validOperation, movement));
    const amount = validOperation.amount;
    const exactSingle = (targetType, delta, targetId) => (
      related.length === 1 &&
      related[0].targetType === targetType &&
      related[0].targetId === targetId &&
      related[0].delta === delta
    );
    let valid = false;
    switch (validOperation.type) {
      case 'balance_adjustment': {
        if (related.length !== 1) break;
        const movement = related[0];
        const targetField = movement.targetType === 'account'
          ? 'accountId'
          : movement.targetType === 'savings_goal'
            ? 'goalId'
            : null;
        if (targetField === null) break;
        const details = requireOperationDetails(validOperation, [targetField, 'reason']);
        valid = movement.targetId === details[targetField] &&
          movement.effectType === 'asset_balance' &&
          Math.abs(movement.delta) === amount;
        break;
      }
      case 'salary_receipt': {
        const details = requireOperationDetails(validOperation, ['accountId']);
        valid = exactSingle('account', amount, details.accountId);
        break;
      }
      case 'additional_income': {
        const details = requireOperationDetails(
          validOperation, ['accountId', 'concept', 'observation']
        );
        valid = exactSingle('account', amount, details.accountId);
        break;
      }
      case 'variable_expense': {
        const details = requireOperationDetails(
          validOperation,
          ['accountId', 'categoryId', 'categoryName', 'concept', 'observation']
        );
        valid = exactSingle('account', -amount, details.accountId);
        break;
      }
      case 'fixed_expense_payment': {
        const details = requireOperationDetails(
          validOperation, ['accountId', 'fixedExpenseInstanceId']
        );
        valid = exactSingle('account', -amount, details.accountId);
        break;
      }
      case 'debt_payment': {
        const details = requireOperationDetails(
          validOperation, ['accountId', 'debtId', 'concept', 'observation']
        );
        valid = related.length === 2 && related.some((movement) => (
          movement.targetType === 'account' && movement.targetId === details.accountId &&
          movement.delta === -amount
        )) && related.some((movement) => (
          movement.targetType === 'debt' && movement.targetId === details.debtId &&
          movement.delta === -amount
        ));
        break;
      }
      case 'debt_total_adjustment': {
        const details = requireOperationDetails(validOperation, [
          'debtId', 'previousTotalAmount', 'newTotalAmount',
          'previousOutstandingAmount', 'newOutstandingAmount', 'validPostedPaymentsTotal',
        ]);
        const delta = details.newOutstandingAmount - details.previousOutstandingAmount;
        valid = Number.isSafeInteger(delta) && delta !== 0 && amount === Math.abs(delta) &&
          exactSingle('debt', delta, details.debtId);
        break;
      }
      case 'savings_deposit':
      case 'savings_withdrawal': {
        const details = requireOperationDetails(
          validOperation, ['goalId', 'concept', 'observation']
        );
        const delta = validOperation.type === 'savings_deposit' ? amount : -amount;
        valid = exactSingle('savings_goal', delta, details.goalId);
        break;
      }
      case 'transfer': {
        const details = requireOperationDetails(validOperation, [
          'sourceType', 'sourceId', 'destinationType', 'destinationId',
          'concept', 'observation',
        ]);
        const distinct = details.sourceType !== details.destinationType ||
          details.sourceId !== details.destinationId;
        valid = distinct && related.length === 2 && related.some((movement) => (
          movement.targetType === details.sourceType && movement.targetId === details.sourceId &&
          movement.delta === -amount
        )) && related.some((movement) => (
          movement.targetType === details.destinationType &&
          movement.targetId === details.destinationId && movement.delta === amount
        ));
        break;
      }
      default:
        valid = false;
    }
    if (!valid) {
      throw domainError(
        ERROR_CODES.DOMAIN_RELATION_MISMATCH,
        'monthly close found an Operation with incompatible Movement cardinality or signs',
        { operationId: validOperation.id, operationType: validOperation.type, movementCount: related.length }
      );
    }
    return Object.freeze({ operation: validOperation, movements: Object.freeze(related) });
  }

  function deriveMonthlySummary(input) {
    const request = requireRecord(input, 'MonthlySummaryInput');
    requireOnlyFields(
      request,
      ['period', 'operations', 'movements', 'fixedExpenseInstances'],
      'MonthlySummaryInput'
    );
    const period = Domain.validatePeriod(request.period);
    for (const field of ['operations', 'movements', 'fixedExpenseInstances']) {
      if (!Array.isArray(request[field])) {
        throw domainError(
          ERROR_CODES.INVALID_DOMAIN_FIELD,
          `MonthlySummaryInput.${field} must be an array`,
          { field }
        );
      }
    }
    const operations = request.operations
      .map(Domain.validateOperation)
      .filter((operation) => operation.periodId === period.id);
    const operationIds = new Set(operations.map((operation) => operation.id));
    const movements = request.movements
      .map(Domain.validateMovement)
      .filter((movement) => movement.periodId === period.id);
    const orphan = movements.find((movement) => !operationIds.has(movement.operationId));
    if (orphan) {
      throw domainError(
        ERROR_CODES.DOMAIN_RELATION_MISMATCH,
        'monthly close found a Movement without an Operation in the same Period',
        { movementId: orphan.id, operationId: orphan.operationId, periodId: period.id }
      );
    }
    const instances = request.fixedExpenseInstances
      .map(Domain.validateFixedExpenseInstance)
      .filter((instance) => instance.periodId === period.id);
    const postedSalaryIds = [];
    const postedFixedPayments = new Map();
    const totals = {
      receivedSalaryAmount: 0,
      additionalIncomeAmount: 0,
      fixedExpensePaidAmount: 0,
      variableExpenseAmount: 0,
      debtPaymentAmount: 0,
      netSavingsAmount: 0,
    };
    for (const operation of operations) {
      const related = movements.filter((movement) => movement.operationId === operation.id);
      const validated = validateMonthlyOperationShape(operation, related);
      if (validated.operation.status !== 'posted') continue;
      switch (validated.operation.type) {
        case 'salary_receipt':
          postedSalaryIds.push(validated.operation.id);
          totals.receivedSalaryAmount = checkedMonthlyTotal(
            totals.receivedSalaryAmount, validated.operation.amount, 'receivedSalaryAmount'
          );
          break;
        case 'additional_income':
          totals.additionalIncomeAmount = checkedMonthlyTotal(
            totals.additionalIncomeAmount, validated.operation.amount, 'additionalIncomeAmount'
          );
          break;
        case 'variable_expense':
          totals.variableExpenseAmount = checkedMonthlyTotal(
            totals.variableExpenseAmount, validated.operation.amount, 'variableExpenseAmount'
          );
          break;
        case 'fixed_expense_payment': {
          const details = validated.operation.details;
          if (postedFixedPayments.has(details.fixedExpenseInstanceId)) {
            throw domainError(
              ERROR_CODES.DOMAIN_STATE_INVALID,
              'monthly close found more than one posted payment for a FixedExpenseInstance',
              {
                fixedExpenseInstanceId: details.fixedExpenseInstanceId,
                operationIds: [postedFixedPayments.get(details.fixedExpenseInstanceId), validated.operation.id],
              }
            );
          }
          postedFixedPayments.set(details.fixedExpenseInstanceId, validated.operation.id);
          totals.fixedExpensePaidAmount = checkedMonthlyTotal(
            totals.fixedExpensePaidAmount, validated.operation.amount, 'fixedExpensePaidAmount'
          );
          break;
        }
        case 'debt_payment':
          totals.debtPaymentAmount = checkedMonthlyTotal(
            totals.debtPaymentAmount, validated.operation.amount, 'debtPaymentAmount'
          );
          break;
        case 'savings_deposit':
          totals.netSavingsAmount = checkedMonthlyTotal(
            totals.netSavingsAmount, validated.operation.amount, 'netSavingsAmount'
          );
          break;
        case 'savings_withdrawal':
          totals.netSavingsAmount = checkedMonthlyTotal(
            totals.netSavingsAmount, -validated.operation.amount, 'netSavingsAmount'
          );
          break;
        case 'transfer': {
          const details = validated.operation.details;
          const delta = details.sourceType === 'account' && details.destinationType === 'savings_goal'
            ? validated.operation.amount
            : details.sourceType === 'savings_goal' && details.destinationType === 'account'
              ? -validated.operation.amount
              : 0;
          totals.netSavingsAmount = checkedMonthlyTotal(
            totals.netSavingsAmount, delta, 'netSavingsAmount'
          );
          break;
        }
        default:
          break;
      }
    }
    if (postedSalaryIds.length > 1) {
      throw domainError(
        ERROR_CODES.DOMAIN_STATE_INVALID,
        'monthly close found more than one posted salary receipt',
        { periodId: period.id, operationIds: postedSalaryIds }
      );
    }
    let fixedExpensePlannedAmount = 0;
    let fixedExpenseUnpaidAmount = 0;
    for (const instance of instances) {
      fixedExpensePlannedAmount = checkedMonthlyTotal(
        fixedExpensePlannedAmount, instance.plannedAmount, 'fixedExpensePlannedAmount'
      );
      const postedPaymentId = postedFixedPayments.get(instance.id) || null;
      if (
        (instance.status === 'paid' && instance.activePaymentOperationId !== postedPaymentId) ||
        (instance.status !== 'paid' && (
          instance.activePaymentOperationId !== null || postedPaymentId !== null
        ))
      ) {
        throw domainError(
          ERROR_CODES.DOMAIN_STATE_INVALID,
          'FixedExpenseInstance state does not match its posted payment at monthly close',
          { instanceId: instance.id, status: instance.status, postedPaymentId }
        );
      }
      if (instance.status !== 'paid') {
        fixedExpenseUnpaidAmount = checkedMonthlyTotal(
          fixedExpenseUnpaidAmount, instance.plannedAmount, 'fixedExpenseUnpaidAmount'
        );
      }
    }
    const totalIncomeAmount = checkedMonthlyTotal(
      totals.receivedSalaryAmount, totals.additionalIncomeAmount, 'totalIncomeAmount'
    );
    let availableAmount = totalIncomeAmount;
    for (const amount of [
      -totals.fixedExpensePaidAmount,
      -totals.variableExpenseAmount,
      -totals.debtPaymentAmount,
      -totals.netSavingsAmount,
    ]) {
      availableAmount = checkedMonthlyTotal(availableAmount, amount, 'availableAmount');
    }
    const summary = {
      periodId: period.id,
      periodKey: period.periodKey,
      plannedSalaryAmount: period.plannedSalaryAmount,
      receivedSalaryAmount: totals.receivedSalaryAmount,
      additionalIncomeAmount: totals.additionalIncomeAmount,
      totalIncomeAmount,
      fixedExpensePlannedAmount,
      fixedExpensePaidAmount: totals.fixedExpensePaidAmount,
      fixedExpenseUnpaidAmount,
      variableExpenseAmount: totals.variableExpenseAmount,
      debtPaymentAmount: totals.debtPaymentAmount,
      netSavingsAmount: totals.netSavingsAmount,
      availableAmount,
    };
    if (!MONTHLY_SUMMARY_FIELDS.every((field) => hasOwn(summary, field))) {
      throw domainError(ERROR_CODES.INVALID_DOMAIN_RECORD, 'monthly summary is incomplete');
    }
    return immutableJsonCopy(summary);
  }

  function revisionExpectationList(value, name, idField, typeField) {
    if (!Array.isArray(value)) {
      throw domainError(
        ERROR_CODES.INVALID_DOMAIN_FIELD,
        `${name} must be an array`,
        { field: name }
      );
    }
    const seen = new Set();
    return Object.freeze(value.map((item, index) => {
      const record = requireRecord(item, `${name}[${index}]`);
      const fields = typeField
        ? [typeField, idField, 'expectedRevision']
        : [idField, 'expectedRevision'];
      requireOnlyFields(record, fields, `${name}[${index}]`);
      if (typeField && !hasOwn(TARGET_STORE_NAMES, record[typeField])) {
        throw domainError(
          ERROR_CODES.INVALID_DOMAIN_FIELD,
          `${name}[${index}].${typeField} is unsupported`,
          { field: `${name}[${index}].${typeField}`, value: record[typeField] }
        );
      }
      assertUuid(record[idField], { field: `${name}[${index}].${idField}` });
      assertRevision(record.expectedRevision, {
        field: `${name}[${index}].expectedRevision`,
      });
      const key = typeField ? `${record[typeField]}:${record[idField]}` : record[idField];
      if (seen.has(key)) {
        throw domainError(
          ERROR_CODES.INVALID_DOMAIN_FIELD,
          `${name} contains a duplicate expectation`,
          { field: name, key }
        );
      }
      seen.add(key);
      return Object.freeze({ ...record });
    }));
  }

  function assertExactExpectedRevisions(actual, expected, options) {
    const actualMap = new Map(actual.map((record) => [options.actualKey(record), record]));
    const expectedMap = new Map(expected.map((record) => [options.expectedKey(record), record]));
    const actualKeys = [...actualMap.keys()].sort();
    const expectedKeys = [...expectedMap.keys()].sort();
    if (!sameJsonValue(actualKeys, expectedKeys)) {
      throw domainError(
        ERROR_CODES.REVISION_CONFLICT,
        `${options.name} expectations do not match the records participating in monthly close`,
        { expectedKeys, actualKeys }
      );
    }
    for (const [key, expectation] of expectedMap) {
      assertExpectedRevision(actualMap.get(key).revision, expectation.expectedRevision, {
        entityType: options.name,
        entityId: key,
      });
    }
  }

  function targetDefinition(targetType) {
    const policy = FINANCIAL_TARGET_POLICIES[targetType];
    if (!policy) {
      throw domainError(
        ERROR_CODES.DOMAIN_RELATION_MISMATCH,
        'monthly close found an unsupported financial target',
        { targetType }
      );
    }
    return policy;
  }

  function reconcileMonthlyBalances(options) {
    const entities = options.entities;
    const operations = new Map(options.operations.map((operation) => [operation.id, operation]));
    const entityMaps = new Map();
    for (const [targetType, records] of Object.entries(entities)) {
      entityMaps.set(targetType, new Map(records.map((record) => [record.id, record])));
    }
    const globalDeltas = new Map();
    const periodDeltas = new Map();
    for (const rawMovement of options.movements) {
      const movement = Domain.validateMovement(rawMovement);
      const operation = operations.get(movement.operationId);
      if (!operation || operation.status !== movement.status) {
        throw domainError(
          ERROR_CODES.DOMAIN_RELATION_MISMATCH,
          'monthly close found a Movement with a missing or incompatible Operation',
          { movementId: movement.id, operationId: movement.operationId }
        );
      }
      const targets = entityMaps.get(movement.targetType);
      if (!targets || !targets.has(movement.targetId)) {
        throw domainError(
          ERROR_CODES.DOMAIN_RELATION_MISMATCH,
          'monthly close found a Movement with a missing financial target',
          { movementId: movement.id, targetType: movement.targetType, targetId: movement.targetId }
        );
      }
      if (movement.status !== 'posted') continue;
      const key = financialTargetKey(movement.targetType, movement.targetId);
      globalDeltas.set(
        key,
        checkedMonthlyTotal(globalDeltas.get(key) || 0, movement.delta, 'entityMovementDelta')
      );
      if (movement.periodId === options.periodId) {
        periodDeltas.set(
          key,
          checkedMonthlyTotal(periodDeltas.get(key) || 0, movement.delta, 'periodMovementDelta')
        );
      }
    }
    for (const [targetType, records] of Object.entries(entities)) {
      const policy = targetDefinition(targetType);
      for (const entity of records) {
        const key = financialTargetKey(targetType, entity.id);
        const calculated = checkedMonthlyTotal(
          entity[policy.openingField], globalDeltas.get(key) || 0, 'entityBalance'
        );
        if (calculated !== entity[policy.balanceField]) {
          throw domainError(
            ERROR_CODES.DOMAIN_STATE_INVALID,
            'cached financial entity balance is not reconciliable at monthly close',
            {
              targetType,
              targetId: entity.id,
              openingAmount: entity[policy.openingField],
              movementDelta: globalDeltas.get(key) || 0,
              calculated,
              cached: entity[policy.balanceField],
            }
          );
        }
      }
    }
    const openingMap = new Map();
    const openingBalances = {};
    const closingBalances = {};
    for (const rawOpening of options.periodOpenings) {
      const opening = Domain.validatePeriodOpening(rawOpening);
      if (opening.periodId !== options.periodId) continue;
      const key = financialTargetKey(opening.targetType, opening.targetId);
      if (openingMap.has(key)) {
        throw domainError(
          ERROR_CODES.DOMAIN_RELATION_MISMATCH,
          'monthly close found duplicate PeriodOpening records',
          { periodId: options.periodId, targetType: opening.targetType, targetId: opening.targetId }
        );
      }
      const targets = entityMaps.get(opening.targetType);
      const entity = targets && targets.get(opening.targetId);
      if (!entity) {
        throw domainError(
          ERROR_CODES.DOMAIN_RELATION_MISMATCH,
          'monthly close found a PeriodOpening with no financial entity',
          { openingId: opening.id, targetType: opening.targetType, targetId: opening.targetId }
        );
      }
      const policy = targetDefinition(opening.targetType);
      const calculated = checkedMonthlyTotal(
        opening.openingAmount, periodDeltas.get(key) || 0, 'periodClosingBalance'
      );
      if (calculated !== entity[policy.balanceField]) {
        throw domainError(
          ERROR_CODES.DOMAIN_STATE_INVALID,
          'PeriodOpening plus posted Period Movements does not match the closing balance',
          {
            periodId: options.periodId,
            targetType: opening.targetType,
            targetId: opening.targetId,
            openingAmount: opening.openingAmount,
            movementDelta: periodDeltas.get(key) || 0,
            calculated,
            cached: entity[policy.balanceField],
          }
        );
      }
      openingMap.set(key, opening);
      openingBalances[key] = opening.openingAmount;
      closingBalances[key] = calculated;
    }
    for (const [targetType, records] of Object.entries(entities)) {
      for (const entity of records) {
        const key = financialTargetKey(targetType, entity.id);
        const hasCurrentMovement = periodDeltas.has(key);
        if (hasCurrentMovement && !openingMap.has(key)) {
          throw domainError(
            ERROR_CODES.DOMAIN_RELATION_MISMATCH,
            'a financial target used in the Period has no PeriodOpening',
            { periodId: options.periodId, targetType, targetId: entity.id }
          );
        }
      }
    }
    return Object.freeze({
      openingBalances: immutableJsonCopy(openingBalances),
      closingBalances: immutableJsonCopy(closingBalances),
    });
  }

  async function applyPreparedWrites(transaction, writes) {
    for (const write of writes || []) {
      await transaction.put(write.storeName, write.value);
    }
  }

  function requireSingleOperationMovement(operationId, movements) {
    const related = movements.filter((movement) => movement.operationId === operationId);
    if (related.length !== 1) {
      throw domainError(
        ERROR_CODES.DOMAIN_RELATION_MISMATCH,
        'balance_adjustment requires exactly one linked Movement',
        { operationId, movementCount: related.length }
      );
    }
    return related[0];
  }

  function assertLogicalRevisionAvailable(existingRevisions, revision) {
    Domain.assertUniqueOperationRevisions([...existingRevisions, revision]);
    return revision;
  }

  function canonicalTimestamp(now) {
    let value;
    try {
      value = now();
    } catch (cause) {
      throw domainError(
        ERROR_CODES.INVALID_DOMAIN_FIELD,
        'the injected domain clock failed',
        { field: 'now' },
        cause
      );
    }
    const parsed = typeof value === 'string' ? new Date(value) : null;
    if (!parsed || !Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
      throw domainError(
        ERROR_CODES.INVALID_DOMAIN_FIELD,
        'now() must return a canonical ISO UTC timestamp',
        { field: 'now', value }
      );
    }
    return value;
  }

  function createIdentifier(createUuid, field, usedIds) {
    let value;
    try {
      value = assertUuid(createUuid(), { field, version: 4 });
    } catch (cause) {
      if (cause instanceof PeritaError) throw cause;
      throw domainError(
        ERROR_CODES.INVALID_UUID,
        `${field} generation failed`,
        { field },
        cause
      );
    }
    if (usedIds.has(value)) {
      throw domainError(
        ERROR_CODES.DOMAIN_RELATION_MISMATCH,
        'the injected UUID generator produced a duplicate ID',
        { field, id: value }
      );
    }
    usedIds.add(value);
    return value;
  }

  function immutableWarning(account) {
    return Object.freeze({
      code: NEGATIVE_OPENING_BALANCE_WARNING,
      accountId: account.id,
      openingBalance: account.openingBalance,
    });
  }

  function createdAuditEvent(options) {
    return Domain.validateAuditEvent({
      id: options.id,
      periodId: options.periodId,
      subjectType: options.subjectType,
      subjectId: options.subjectId,
      action: 'created',
      commandType: options.commandType || 'setup.complete',
      previousRevision: null,
      nextRevision: 1,
      previousValue: null,
      nextValue: options.nextValue,
      reason: null,
      occurredAt: options.occurredAt,
    });
  }

  function updatedAuditEvent(options) {
    return Domain.validateAuditEvent({
      id: options.id,
      periodId: options.periodId,
      subjectType: options.subjectType,
      subjectId: options.subjectId,
      action: 'updated',
      commandType: options.commandType,
      previousRevision: options.previousValue.revision,
      nextRevision: options.nextValue.revision,
      previousValue: options.previousValue,
      nextValue: options.nextValue,
      reason: null,
      occurredAt: options.occurredAt,
    });
  }

  function stateChangedAuditEvent(options) {
    return Domain.validateAuditEvent({
      id: options.id,
      periodId: options.periodId,
      subjectType: options.subjectType,
      subjectId: options.subjectId,
      action: options.action,
      commandType: options.commandType,
      previousRevision: options.previousValue.revision,
      nextRevision: options.nextValue.revision,
      previousValue: options.previousValue,
      nextValue: options.nextValue,
      reason: null,
      occurredAt: options.occurredAt,
    });
  }

  function requireActiveOpenPeriod(storedPeriod, context, periodId, commandType) {
    if (
      !context || !context.runtime || context.runtime.setupStatus !== 'completed' ||
      context.runtime.activePeriodId !== periodId
    ) {
      throw domainError(
        ERROR_CODES.DOMAIN_STATE_INVALID,
        `${commandType} requires completed setup and the active Period`,
        {
          periodId,
          setupStatus: context && context.runtime && context.runtime.setupStatus,
          activePeriodId: context && context.runtime && context.runtime.activePeriodId,
        }
      );
    }
    if (storedPeriod === undefined) {
      throw domainError(
        ERROR_CODES.DOMAIN_STATE_INVALID,
        'the active Period does not exist',
        { periodId, commandType }
      );
    }
    const period = Domain.validatePeriod(storedPeriod);
    if (period.status !== 'open') {
      throw domainError(
        ERROR_CODES.DOMAIN_STATE_INVALID,
        `${commandType} requires an open Period`,
        { periodId, status: period.status }
      );
    }
    return period;
  }

  function prepareSetup(input, now, createUuid) {
    const request = requireRecord(input, 'setup.complete');
    requireFields(request, [
      'expectedDataRevision',
      'expectedWriterEpoch',
      'currentCivilDate',
      'financialSettings',
      'period',
      'accounts',
    ], 'setup.complete');
    assertRevision(request.expectedDataRevision, {
      field: 'expectedDataRevision',
      allowZero: true,
    });
    assertRevision(request.expectedWriterEpoch, { field: 'expectedWriterEpoch' });
    assertCivilDate(request.currentCivilDate, { field: 'currentCivilDate' });

    const financialSettings = Domain.validateFinancialSettings(request.financialSettings);
    const period = Domain.validatePeriod(request.period);
    if (!Array.isArray(request.accounts) || request.accounts.length === 0) {
      throw domainError(
        ERROR_CODES.INVALID_DOMAIN_FIELD,
        'setup.complete requires at least one Account',
        { field: 'accounts', accountCount: Array.isArray(request.accounts) ? 0 : null }
      );
    }
    const accounts = request.accounts.map(Domain.validateAccount);

    if (
      financialSettings.revision !== 1 ||
      period.revision !== 1 ||
      accounts.some((account) => account.revision !== 1)
    ) {
      throw domainError(
        ERROR_CODES.DOMAIN_STATE_INVALID,
        'initial setup records must begin at revision 1',
        { financialSettingsRevision: financialSettings.revision, periodRevision: period.revision }
      );
    }
    if (period.status !== 'open') {
      throw domainError(
        ERROR_CODES.DOMAIN_STATE_INVALID,
        'the initial Period must be open',
        { periodId: period.id, status: period.status }
      );
    }
    const currentPeriodKey = request.currentCivilDate.slice(0, 7);
    if (period.periodKey > currentPeriodKey) {
      throw domainError(
        ERROR_CODES.DOMAIN_STATE_INVALID,
        'the initial Period cannot be in the future',
        { periodKey: period.periodKey, currentPeriodKey }
      );
    }
    if (period.plannedSalaryAmount !== financialSettings.salaryReferenceAmount) {
      throw domainError(
        ERROR_CODES.DOMAIN_RELATION_MISMATCH,
        'the initial planned salary must equal the salary reference amount',
        {
          salaryReferenceAmount: financialSettings.salaryReferenceAmount,
          plannedSalaryAmount: period.plannedSalaryAmount,
        }
      );
    }

    const accountIds = new Set();
    for (const account of accounts) {
      if (accountIds.has(account.id)) {
        throw domainError(
          ERROR_CODES.DOMAIN_RELATION_MISMATCH,
          'setup.complete contains duplicate Account IDs',
          { accountId: account.id }
        );
      }
      accountIds.add(account.id);
      if (account.status !== 'active') {
        throw domainError(
          ERROR_CODES.DOMAIN_STATE_INVALID,
          'every initial Account must be active',
          { accountId: account.id, status: account.status }
        );
      }
      Domain.assertInitialBalancePolicy({
        targetType: 'account',
        duringSetup: true,
        openingBalance: account.openingBalance,
        currentBalance: account.currentBalance,
      });
    }

    const occurredAt = canonicalTimestamp(now);
    const usedGeneratedIds = new Set();
    const periodOpenings = accounts.map((account, index) => Domain.validatePeriodOpening({
      id: createIdentifier(createUuid, `periodOpenings[${index}].id`, usedGeneratedIds),
      periodId: period.id,
      targetType: 'account',
      targetId: account.id,
      openingAmount: account.openingBalance,
    }));
    const auditEvents = [
      createdAuditEvent({
        id: createIdentifier(createUuid, 'auditEvents.financialSettings.id', usedGeneratedIds),
        periodId: null,
        subjectType: 'financial_settings',
        subjectId: 'current',
        nextValue: financialSettings,
        occurredAt,
      }),
      createdAuditEvent({
        id: createIdentifier(createUuid, 'auditEvents.period.id', usedGeneratedIds),
        periodId: period.id,
        subjectType: 'period',
        subjectId: period.id,
        nextValue: period,
        occurredAt,
      }),
      ...accounts.map((account, index) => createdAuditEvent({
        id: createIdentifier(createUuid, `auditEvents.accounts[${index}].id`, usedGeneratedIds),
        periodId: period.id,
        subjectType: 'account',
        subjectId: account.id,
        nextValue: account,
        occurredAt,
      })),
    ];
    const warnings = Object.freeze(
      accounts.filter((account) => account.openingBalance < 0).map(immutableWarning)
    );
    const scopes = Object.freeze([
      Domain.domainScope('financial_settings', 'current'),
      Domain.domainScope('period', period.id),
      ...accounts.map((account) => Domain.domainScope('account', account.id)),
    ]);

    return Object.freeze({
      expectedDataRevision: request.expectedDataRevision,
      expectedWriterEpoch: request.expectedWriterEpoch,
      financialSettings,
      period,
      accounts: Object.freeze(accounts),
      periodOpenings: Object.freeze(periodOpenings),
      auditEvents: Object.freeze(auditEvents),
      warnings,
      scopes,
    });
  }

  function createPeritaDomainCommands(options) {
    const settings = options || {};
    const runtime = settings.runtime;
    const now = settings.now;
    const createUuid = settings.createUuid;
    const sha256 = settings.sha256;
    if (!runtime || typeof runtime.executeCommand !== 'function') {
      throw domainError(
        ERROR_CODES.INVALID_DOMAIN_FIELD,
        'a Perita runtime instance is required',
        { field: 'runtime' }
      );
    }
    if (typeof now !== 'function' || typeof createUuid !== 'function') {
      throw domainError(
        ERROR_CODES.INVALID_DOMAIN_FIELD,
        'setup clock and UUID generator must be injected',
        { nowType: typeof now, createUuidType: typeof createUuid }
      );
    }

    async function complete(input) {
      const prepared = prepareSetup(input, now, createUuid);
      return runtime.executeCommand({
        commandType: 'setup.complete',
        expectedDataRevision: prepared.expectedDataRevision,
        expectedWriterEpoch: prepared.expectedWriterEpoch,
        affectedStores: SETUP_COMPLETE_STORES,
        affectedScopes: prepared.scopes,
        runtimePatch: {
          setupStatus: 'completed',
          activePeriodId: prepared.period.id,
        },
        metadata: {
          periodId: prepared.period.id,
          accountIds: prepared.accounts.map((account) => account.id),
          warnings: prepared.warnings,
        },
        execute: async (transaction, context) => {
          if (
            !context || !context.runtime ||
            !['not_started', 'in_progress'].includes(context.runtime.setupStatus) ||
            context.runtime.activePeriodId !== null
          ) {
            throw domainError(
              ERROR_CODES.DOMAIN_STATE_INVALID,
              'initial setup is already completed or has an incompatible runtime state',
              {
                setupStatus: context && context.runtime && context.runtime.setupStatus,
                activePeriodId: context && context.runtime && context.runtime.activePeriodId,
              }
            );
          }
          for (const storeName of SETUP_COMPLETE_STORES) {
            const existing = await transaction.getAll(storeName);
            if (existing.length !== 0) {
              throw domainError(
                ERROR_CODES.DOMAIN_STATE_INVALID,
                'setup.complete requires an empty installation',
                { storeName, existingCount: existing.length }
              );
            }
          }

          await transaction.add('financialSettings', prepared.financialSettings);
          await transaction.add('periods', prepared.period);
          for (const account of prepared.accounts) {
            await transaction.add('accounts', account);
          }
          for (const opening of prepared.periodOpenings) {
            await transaction.add('periodOpenings', opening);
          }
          for (const auditEvent of prepared.auditEvents) {
            await transaction.add('auditEvents', auditEvent);
          }
          return Object.freeze({
            financialSettings: prepared.financialSettings,
            period: prepared.period,
            accounts: prepared.accounts,
            periodOpenings: prepared.periodOpenings,
            auditEvents: prepared.auditEvents,
            warnings: prepared.warnings,
          });
        },
      });
    }

    async function updateReferenceSalary(input) {
      const request = requireRecord(input, 'financial-settings.update-reference-salary');
      const fields = [
        'expectedDataRevision',
        'expectedWriterEpoch',
        'expectedSettingsRevision',
        'salaryReferenceAmount',
      ];
      requireFields(request, fields, 'financial-settings.update-reference-salary');
      requireOnlyFields(request, fields, 'financial-settings.update-reference-salary');
      assertRevision(request.expectedDataRevision, {
        field: 'expectedDataRevision', allowZero: true,
      });
      assertRevision(request.expectedWriterEpoch, { field: 'expectedWriterEpoch' });
      assertRevision(request.expectedSettingsRevision, { field: 'expectedSettingsRevision' });
      assertMoney(request.salaryReferenceAmount, {
        field: 'salaryReferenceAmount', allowZero: true,
      });
      const occurredAt = canonicalTimestamp(now);
      const auditEventId = createIdentifier(createUuid, 'auditEvent.id', new Set());

      return runtime.executeCommand({
        commandType: 'financial-settings.update-reference-salary',
        expectedDataRevision: request.expectedDataRevision,
        expectedWriterEpoch: request.expectedWriterEpoch,
        affectedStores: FINANCIAL_SETTINGS_UPDATE_STORES,
        affectedScopes: [Domain.domainScope('financial_settings', 'current')],
        metadata: { salaryReferenceAmount: request.salaryReferenceAmount },
        execute: async (transaction) => {
          const stored = await transaction.get('financialSettings', 'current');
          if (stored === undefined) {
            throw domainError(
              ERROR_CODES.DOMAIN_STATE_INVALID,
              'FinancialSettings.current does not exist',
              { key: 'current' }
            );
          }
          const previousValue = Domain.validateFinancialSettings(stored);
          assertExpectedRevision(
            previousValue.revision,
            request.expectedSettingsRevision,
            { entityType: 'FinancialSettings', entityId: 'current' }
          );
          const nextValue = Domain.validateFinancialSettings({
            ...previousValue,
            salaryReferenceAmount: request.salaryReferenceAmount,
            revision: nextRevision(previousValue.revision),
            updatedAt: occurredAt,
          });
          const auditEvent = updatedAuditEvent({
            id: auditEventId,
            periodId: null,
            subjectType: 'financial_settings',
            subjectId: 'current',
            commandType: 'financial-settings.update-reference-salary',
            previousValue,
            nextValue,
            occurredAt,
          });
          await transaction.put('financialSettings', nextValue);
          await transaction.add('auditEvents', auditEvent);
          return Object.freeze({ financialSettings: nextValue, auditEvent });
        },
      });
    }

    async function updatePlanning(input) {
      const request = requireRecord(input, 'period.update-planning');
      const requiredFields = [
        'expectedDataRevision',
        'expectedWriterEpoch',
        'periodId',
        'expectedPeriodRevision',
      ];
      const allowedFields = [...requiredFields, ...PERIOD_PLANNING_FIELDS];
      requireFields(request, requiredFields, 'period.update-planning');
      requireOnlyFields(request, allowedFields, 'period.update-planning');
      assertRevision(request.expectedDataRevision, {
        field: 'expectedDataRevision', allowZero: true,
      });
      assertRevision(request.expectedWriterEpoch, { field: 'expectedWriterEpoch' });
      assertUuid(request.periodId, { field: 'periodId' });
      assertRevision(request.expectedPeriodRevision, { field: 'expectedPeriodRevision' });
      const changedFields = PERIOD_PLANNING_FIELDS.filter((field) => hasOwn(request, field));
      if (changedFields.length === 0) {
        throw domainError(
          ERROR_CODES.INVALID_DOMAIN_FIELD,
          'period.update-planning requires at least one planning field',
          { planningFields: PERIOD_PLANNING_FIELDS }
        );
      }
      for (const field of changedFields) {
        assertMoney(request[field], { field, allowZero: true });
      }
      const occurredAt = canonicalTimestamp(now);
      const auditEventId = createIdentifier(createUuid, 'auditEvent.id', new Set());

      return runtime.executeCommand({
        commandType: 'period.update-planning',
        expectedDataRevision: request.expectedDataRevision,
        expectedWriterEpoch: request.expectedWriterEpoch,
        affectedStores: PERIOD_PLANNING_UPDATE_STORES,
        affectedScopes: [Domain.domainScope('period', request.periodId)],
        metadata: { periodId: request.periodId, changedFields },
        execute: async (transaction, context) => {
          const stored = await transaction.get('periods', request.periodId);
          if (stored === undefined) {
            throw domainError(
              ERROR_CODES.DOMAIN_STATE_INVALID,
              'the requested Period does not exist',
              { periodId: request.periodId }
            );
          }
          const previousValue = Domain.validatePeriod(stored);
          if (!context || !context.runtime || context.runtime.activePeriodId !== request.periodId) {
            throw domainError(
              ERROR_CODES.DOMAIN_STATE_INVALID,
              'planning can only change for the active Period',
              {
                periodId: request.periodId,
                activePeriodId: context && context.runtime && context.runtime.activePeriodId,
              }
            );
          }
          if (previousValue.status !== 'open') {
            throw domainError(
              ERROR_CODES.DOMAIN_STATE_INVALID,
              'planning can only change for an open Period',
              { periodId: request.periodId, status: previousValue.status }
            );
          }
          assertExpectedRevision(
            previousValue.revision,
            request.expectedPeriodRevision,
            { entityType: 'Period', entityId: request.periodId }
          );
          const planningPatch = {};
          for (const field of changedFields) planningPatch[field] = request[field];
          const nextValue = Domain.validatePeriod({
            ...previousValue,
            ...planningPatch,
            revision: nextRevision(previousValue.revision),
          });
          const auditEvent = updatedAuditEvent({
            id: auditEventId,
            periodId: request.periodId,
            subjectType: 'period',
            subjectId: request.periodId,
            commandType: 'period.update-planning',
            previousValue,
            nextValue,
            occurredAt,
          });
          await transaction.put('periods', nextValue);
          await transaction.add('auditEvents', auditEvent);
          return Object.freeze({ period: nextValue, auditEvent });
        },
      });
    }

    async function createAccount(input) {
      const request = requireRecord(input, 'account.create');
      const fields = [
        'expectedDataRevision',
        'expectedWriterEpoch',
        'periodId',
        'account',
      ];
      requireFields(request, fields, 'account.create');
      requireOnlyFields(request, fields, 'account.create');
      assertRevision(request.expectedDataRevision, {
        field: 'expectedDataRevision', allowZero: true,
      });
      assertRevision(request.expectedWriterEpoch, { field: 'expectedWriterEpoch' });
      assertUuid(request.periodId, { field: 'periodId' });
      const account = Domain.validateAccount(request.account);
      if (account.revision !== 1 || account.status !== 'active') {
        throw domainError(
          ERROR_CODES.DOMAIN_STATE_INVALID,
          'a new Account must be active and begin at revision 1',
          { accountId: account.id, status: account.status, revision: account.revision }
        );
      }
      Domain.assertInitialBalancePolicy({
        targetType: 'account',
        duringSetup: false,
        openingBalance: account.openingBalance,
        currentBalance: account.currentBalance,
      });
      const occurredAt = canonicalTimestamp(now);
      const usedGeneratedIds = new Set();
      const opening = Domain.validatePeriodOpening({
        id: createIdentifier(createUuid, 'periodOpening.id', usedGeneratedIds),
        periodId: request.periodId,
        targetType: 'account',
        targetId: account.id,
        openingAmount: 0,
      });
      Domain.assertPostSetupAccountOpening(account, opening, request.periodId);
      const auditEvent = createdAuditEvent({
        id: createIdentifier(createUuid, 'auditEvent.id', usedGeneratedIds),
        periodId: request.periodId,
        subjectType: 'account',
        subjectId: account.id,
        commandType: 'account.create',
        nextValue: account,
        occurredAt,
      });
      const scopes = [
        Domain.domainScope('period', request.periodId),
        Domain.domainScope('account', account.id),
      ];

      return runtime.executeCommand({
        commandType: 'account.create',
        expectedDataRevision: request.expectedDataRevision,
        expectedWriterEpoch: request.expectedWriterEpoch,
        affectedStores: ACCOUNT_CREATE_STORES,
        affectedScopes: scopes,
        metadata: { periodId: request.periodId, accountId: account.id },
        execute: async (transaction, context) => {
          const storedPeriod = await transaction.get('periods', request.periodId);
          requireActiveOpenPeriod(storedPeriod, context, request.periodId, 'account.create');
          if (await transaction.get('accounts', account.id) !== undefined) {
            throw domainError(
              ERROR_CODES.DOMAIN_RELATION_MISMATCH,
              'an Account with the requested ID already exists',
              { accountId: account.id }
            );
          }
          await transaction.add('accounts', account);
          await transaction.add('periodOpenings', opening);
          await transaction.add('auditEvents', auditEvent);
          return Object.freeze({ account, periodOpening: opening, auditEvent });
        },
      });
    }

    async function updateAccount(input) {
      const request = requireRecord(input, 'account.update');
      const requiredFields = [
        'expectedDataRevision',
        'expectedWriterEpoch',
        'periodId',
        'accountId',
        'expectedAccountRevision',
      ];
      const allowedFields = [...requiredFields, ...ACCOUNT_EDITABLE_FIELDS];
      requireFields(request, requiredFields, 'account.update');
      requireOnlyFields(request, allowedFields, 'account.update');
      assertRevision(request.expectedDataRevision, {
        field: 'expectedDataRevision', allowZero: true,
      });
      assertRevision(request.expectedWriterEpoch, { field: 'expectedWriterEpoch' });
      assertUuid(request.periodId, { field: 'periodId' });
      assertUuid(request.accountId, { field: 'accountId' });
      assertRevision(request.expectedAccountRevision, { field: 'expectedAccountRevision' });
      const changedFields = ACCOUNT_EDITABLE_FIELDS.filter((field) => hasOwn(request, field));
      if (changedFields.length === 0) {
        throw domainError(
          ERROR_CODES.INVALID_DOMAIN_FIELD,
          'account.update requires at least one editable field',
          { editableFields: ACCOUNT_EDITABLE_FIELDS }
        );
      }
      const occurredAt = canonicalTimestamp(now);
      const auditEventId = createIdentifier(createUuid, 'auditEvent.id', new Set());

      return runtime.executeCommand({
        commandType: 'account.update',
        expectedDataRevision: request.expectedDataRevision,
        expectedWriterEpoch: request.expectedWriterEpoch,
        affectedStores: ACCOUNT_CHANGE_STORES,
        affectedScopes: [
          Domain.domainScope('period', request.periodId),
          Domain.domainScope('account', request.accountId),
        ],
        metadata: { periodId: request.periodId, accountId: request.accountId, changedFields },
        execute: async (transaction, context) => {
          const storedPeriod = await transaction.get('periods', request.periodId);
          requireActiveOpenPeriod(storedPeriod, context, request.periodId, 'account.update');
          const stored = await transaction.get('accounts', request.accountId);
          if (stored === undefined) {
            throw domainError(
              ERROR_CODES.DOMAIN_STATE_INVALID,
              'the requested Account does not exist',
              { accountId: request.accountId }
            );
          }
          const previousValue = Domain.validateAccount(stored);
          assertExpectedRevision(
            previousValue.revision,
            request.expectedAccountRevision,
            { entityType: 'Account', entityId: request.accountId }
          );
          if (changedFields.every((field) => request[field] === previousValue[field])) {
            throw domainError(
              ERROR_CODES.INVALID_DOMAIN_FIELD,
              'account.update requires a real descriptive change',
              { accountId: request.accountId, editableFields: ACCOUNT_EDITABLE_FIELDS }
            );
          }
          const patch = {};
          for (const field of changedFields) patch[field] = request[field];
          const nextValue = Domain.validateAccount({
            ...previousValue,
            ...patch,
            revision: nextRevision(previousValue.revision),
            updatedAt: occurredAt,
          });
          const auditEvent = updatedAuditEvent({
            id: auditEventId,
            periodId: request.periodId,
            subjectType: 'account',
            subjectId: request.accountId,
            commandType: 'account.update',
            previousValue,
            nextValue,
            occurredAt,
          });
          await transaction.put('accounts', nextValue);
          await transaction.add('auditEvents', auditEvent);
          return Object.freeze({ account: nextValue, auditEvent });
        },
      });
    }

    async function deactivateAccount(input) {
      const request = requireRecord(input, 'account.deactivate');
      const fields = [
        'expectedDataRevision',
        'expectedWriterEpoch',
        'periodId',
        'accountId',
        'expectedAccountRevision',
      ];
      requireFields(request, fields, 'account.deactivate');
      requireOnlyFields(request, fields, 'account.deactivate');
      assertRevision(request.expectedDataRevision, {
        field: 'expectedDataRevision', allowZero: true,
      });
      assertRevision(request.expectedWriterEpoch, { field: 'expectedWriterEpoch' });
      assertUuid(request.periodId, { field: 'periodId' });
      assertUuid(request.accountId, { field: 'accountId' });
      assertRevision(request.expectedAccountRevision, { field: 'expectedAccountRevision' });
      const occurredAt = canonicalTimestamp(now);
      const auditEventId = createIdentifier(createUuid, 'auditEvent.id', new Set());

      return runtime.executeCommand({
        commandType: 'account.deactivate',
        expectedDataRevision: request.expectedDataRevision,
        expectedWriterEpoch: request.expectedWriterEpoch,
        affectedStores: ACCOUNT_CHANGE_STORES,
        affectedScopes: [
          Domain.domainScope('period', request.periodId),
          Domain.domainScope('account', request.accountId),
        ],
        metadata: { periodId: request.periodId, accountId: request.accountId },
        execute: async (transaction, context) => {
          const storedPeriod = await transaction.get('periods', request.periodId);
          requireActiveOpenPeriod(storedPeriod, context, request.periodId, 'account.deactivate');
          const stored = await transaction.get('accounts', request.accountId);
          if (stored === undefined) {
            throw domainError(
              ERROR_CODES.DOMAIN_STATE_INVALID,
              'the requested Account does not exist',
              { accountId: request.accountId }
            );
          }
          const previousValue = Domain.validateAccount(stored);
          assertExpectedRevision(
            previousValue.revision,
            request.expectedAccountRevision,
            { entityType: 'Account', entityId: request.accountId }
          );
          if (previousValue.status !== 'active') {
            throw domainError(
              ERROR_CODES.DOMAIN_STATE_INVALID,
              'only an active Account can be deactivated',
              { accountId: request.accountId, status: previousValue.status }
            );
          }
          if (previousValue.currentBalance !== 0) {
            throw domainError(
              ERROR_CODES.DOMAIN_STATE_INVALID,
              'an Account balance must be zero before deactivation',
              { accountId: request.accountId, currentBalance: previousValue.currentBalance }
            );
          }
          const nextValue = Domain.validateAccount({
            ...previousValue,
            status: 'inactive',
            revision: nextRevision(previousValue.revision),
            updatedAt: occurredAt,
          });
          const auditEvent = stateChangedAuditEvent({
            id: auditEventId,
            periodId: request.periodId,
            subjectType: 'account',
            subjectId: request.accountId,
            action: 'deactivated',
            commandType: 'account.deactivate',
            previousValue,
            nextValue,
            occurredAt,
          });
          await transaction.put('accounts', nextValue);
          await transaction.add('auditEvents', auditEvent);
          return Object.freeze({ account: nextValue, auditEvent });
        },
      });
    }

    async function createCategory(input) {
      const request = requireRecord(input, 'category.create');
      const fields = ['expectedDataRevision', 'expectedWriterEpoch', 'periodId', 'category'];
      validateCommandHeader(request, 'category.create', fields);
      requireOnlyFields(requireRecord(request.category, 'Category'), CATEGORY_FIELDS, 'Category');
      const category = Domain.validateCategory(request.category);
      if (category.revision !== 1 || category.status !== 'active') {
        throw domainError(
          ERROR_CODES.DOMAIN_STATE_INVALID,
          'a new Category must be active and begin at revision 1',
          { categoryId: category.id, status: category.status, revision: category.revision }
        );
      }
      const occurredAt = canonicalTimestamp(now);
      const auditEvent = createdAuditEvent({
        id: createIdentifier(createUuid, 'auditEvent.id', new Set()),
        periodId: request.periodId,
        subjectType: 'category',
        subjectId: category.id,
        commandType: 'category.create',
        nextValue: category,
        occurredAt,
      });
      return runtime.executeCommand({
        commandType: 'category.create',
        expectedDataRevision: request.expectedDataRevision,
        expectedWriterEpoch: request.expectedWriterEpoch,
        affectedStores: CATEGORY_STORES,
        affectedScopes: entityScopes(request.periodId, 'category', category.id),
        metadata: { periodId: request.periodId, categoryId: category.id },
        execute: async (transaction, context) => {
          const storedPeriod = await transaction.get('periods', request.periodId);
          requireActiveOpenPeriod(storedPeriod, context, request.periodId, 'category.create');
          if (await transaction.get('categories', category.id) !== undefined) {
            throw domainError(
              ERROR_CODES.DOMAIN_RELATION_MISMATCH,
              'a Category with the requested ID already exists',
              { categoryId: category.id }
            );
          }
          await transaction.add('categories', category);
          await transaction.add('auditEvents', auditEvent);
          return Object.freeze({ category, auditEvent });
        },
      });
    }

    async function updateCategory(input) {
      const request = requireRecord(input, 'category.update');
      const required = [
        'expectedDataRevision', 'expectedWriterEpoch', 'periodId',
        'categoryId', 'expectedCategoryRevision',
      ];
      const allowed = [...required, ...CATEGORY_EDITABLE_FIELDS];
      validateCommandHeader(request, 'category.update', required, allowed);
      assertUuid(request.categoryId, { field: 'categoryId' });
      assertRevision(request.expectedCategoryRevision, { field: 'expectedCategoryRevision' });
      const changedFields = editableFieldsFrom(request, CATEGORY_EDITABLE_FIELDS, 'category.update');
      const occurredAt = canonicalTimestamp(now);
      const auditEventId = createIdentifier(createUuid, 'auditEvent.id', new Set());
      return runtime.executeCommand({
        commandType: 'category.update',
        expectedDataRevision: request.expectedDataRevision,
        expectedWriterEpoch: request.expectedWriterEpoch,
        affectedStores: CATEGORY_STORES,
        affectedScopes: entityScopes(request.periodId, 'category', request.categoryId),
        metadata: { periodId: request.periodId, categoryId: request.categoryId, changedFields },
        execute: async (transaction, context) => {
          const storedPeriod = await transaction.get('periods', request.periodId);
          requireActiveOpenPeriod(storedPeriod, context, request.periodId, 'category.update');
          const stored = await transaction.get('categories', request.categoryId);
          if (stored === undefined) {
            throw domainError(
              ERROR_CODES.DOMAIN_STATE_INVALID,
              'the requested Category does not exist',
              { categoryId: request.categoryId }
            );
          }
          const previousValue = Domain.validateCategory(stored);
          assertExpectedRevision(previousValue.revision, request.expectedCategoryRevision, {
            entityType: 'Category', entityId: request.categoryId,
          });
          assertRealChange(previousValue, request, changedFields, 'category.update', request.categoryId);
          const nextValue = Domain.validateCategory({
            ...previousValue,
            name: request.name,
            revision: nextRevision(previousValue.revision),
            updatedAt: occurredAt,
          });
          const auditEvent = updatedAuditEvent({
            id: auditEventId,
            periodId: request.periodId,
            subjectType: 'category',
            subjectId: request.categoryId,
            commandType: 'category.update',
            previousValue,
            nextValue,
            occurredAt,
          });
          await transaction.put('categories', nextValue);
          await transaction.add('auditEvents', auditEvent);
          return Object.freeze({ category: nextValue, auditEvent });
        },
      });
    }

    async function deactivateCategory(input) {
      const request = requireRecord(input, 'category.deactivate');
      const fields = [
        'expectedDataRevision', 'expectedWriterEpoch', 'periodId',
        'categoryId', 'expectedCategoryRevision',
      ];
      validateCommandHeader(request, 'category.deactivate', fields);
      assertUuid(request.categoryId, { field: 'categoryId' });
      assertRevision(request.expectedCategoryRevision, { field: 'expectedCategoryRevision' });
      const occurredAt = canonicalTimestamp(now);
      const auditEventId = createIdentifier(createUuid, 'auditEvent.id', new Set());
      return runtime.executeCommand({
        commandType: 'category.deactivate',
        expectedDataRevision: request.expectedDataRevision,
        expectedWriterEpoch: request.expectedWriterEpoch,
        affectedStores: CATEGORY_STORES,
        affectedScopes: entityScopes(request.periodId, 'category', request.categoryId),
        metadata: { periodId: request.periodId, categoryId: request.categoryId },
        execute: async (transaction, context) => {
          const storedPeriod = await transaction.get('periods', request.periodId);
          requireActiveOpenPeriod(storedPeriod, context, request.periodId, 'category.deactivate');
          const stored = await transaction.get('categories', request.categoryId);
          if (stored === undefined) {
            throw domainError(ERROR_CODES.DOMAIN_STATE_INVALID, 'the requested Category does not exist', {
              categoryId: request.categoryId,
            });
          }
          const previousValue = Domain.validateCategory(stored);
          assertExpectedRevision(previousValue.revision, request.expectedCategoryRevision, {
            entityType: 'Category', entityId: request.categoryId,
          });
          if (previousValue.status !== 'active') {
            throw domainError(ERROR_CODES.DOMAIN_STATE_INVALID, 'only an active Category can be deactivated', {
              categoryId: request.categoryId, status: previousValue.status,
            });
          }
          const nextValue = Domain.validateCategory({
            ...previousValue,
            status: 'inactive',
            revision: nextRevision(previousValue.revision),
            updatedAt: occurredAt,
          });
          const auditEvent = stateChangedAuditEvent({
            id: auditEventId,
            periodId: request.periodId,
            subjectType: 'category',
            subjectId: request.categoryId,
            action: 'deactivated',
            commandType: 'category.deactivate',
            previousValue,
            nextValue,
            occurredAt,
          });
          await transaction.put('categories', nextValue);
          await transaction.add('auditEvents', auditEvent);
          return Object.freeze({ category: nextValue, auditEvent });
        },
      });
    }

    async function createFixedExpenseTemplate(input) {
      const request = requireRecord(input, 'fixed-expense-template.create');
      const fields = ['expectedDataRevision', 'expectedWriterEpoch', 'periodId', 'template'];
      validateCommandHeader(request, 'fixed-expense-template.create', fields);
      requireOnlyFields(
        requireRecord(request.template, 'FixedExpenseTemplate'),
        FIXED_TEMPLATE_FIELDS,
        'FixedExpenseTemplate'
      );
      const template = Domain.validateFixedExpenseTemplate(request.template);
      if (template.revision !== 1 || template.status !== 'active') {
        throw domainError(
          ERROR_CODES.DOMAIN_STATE_INVALID,
          'a new FixedExpenseTemplate must be active and begin at revision 1',
          { templateId: template.id, status: template.status, revision: template.revision }
        );
      }
      const occurredAt = canonicalTimestamp(now);
      const auditEvent = createdAuditEvent({
        id: createIdentifier(createUuid, 'auditEvent.id', new Set()),
        periodId: request.periodId,
        subjectType: 'fixed_expense_template',
        subjectId: template.id,
        commandType: 'fixed-expense-template.create',
        nextValue: template,
        occurredAt,
      });
      return runtime.executeCommand({
        commandType: 'fixed-expense-template.create',
        expectedDataRevision: request.expectedDataRevision,
        expectedWriterEpoch: request.expectedWriterEpoch,
        affectedStores: FIXED_TEMPLATE_CREATE_STORES,
        affectedScopes: entityScopes(request.periodId, 'fixed_expense_template', template.id),
        metadata: { periodId: request.periodId, templateId: template.id },
        execute: async (transaction, context) => {
          const storedPeriod = await transaction.get('periods', request.periodId);
          const activePeriod = requireActiveOpenPeriod(
            storedPeriod, context, request.periodId, 'fixed-expense-template.create'
          );
          if (await transaction.get('fixedExpenseTemplates', template.id) !== undefined) {
            throw domainError(
              ERROR_CODES.DOMAIN_RELATION_MISMATCH,
              'a FixedExpenseTemplate with the requested ID already exists',
              { templateId: template.id }
            );
          }
          const instances = await transaction.getAll('fixedExpenseInstances');
          Domain.assertNoCurrentPeriodFixedExpenseInstance({ template, activePeriod, instances });
          await transaction.add('fixedExpenseTemplates', template);
          await transaction.add('auditEvents', auditEvent);
          return Object.freeze({ template, auditEvent });
        },
      });
    }

    async function updateFixedExpenseTemplate(input) {
      const request = requireRecord(input, 'fixed-expense-template.update');
      const required = [
        'expectedDataRevision', 'expectedWriterEpoch', 'periodId',
        'templateId', 'expectedTemplateRevision',
      ];
      const allowed = [...required, ...FIXED_TEMPLATE_EDITABLE_FIELDS];
      validateCommandHeader(request, 'fixed-expense-template.update', required, allowed);
      assertUuid(request.templateId, { field: 'templateId' });
      assertRevision(request.expectedTemplateRevision, { field: 'expectedTemplateRevision' });
      const changedFields = editableFieldsFrom(
        request, FIXED_TEMPLATE_EDITABLE_FIELDS, 'fixed-expense-template.update'
      );
      if (hasOwn(request, 'referenceAmount')) {
        assertPositiveMoney(request.referenceAmount, { field: 'referenceAmount' });
      }
      const occurredAt = canonicalTimestamp(now);
      const auditEventId = createIdentifier(createUuid, 'auditEvent.id', new Set());
      return runtime.executeCommand({
        commandType: 'fixed-expense-template.update',
        expectedDataRevision: request.expectedDataRevision,
        expectedWriterEpoch: request.expectedWriterEpoch,
        affectedStores: FIXED_TEMPLATE_CHANGE_STORES,
        affectedScopes: entityScopes(request.periodId, 'fixed_expense_template', request.templateId),
        metadata: { periodId: request.periodId, templateId: request.templateId, changedFields },
        execute: async (transaction, context) => {
          const storedPeriod = await transaction.get('periods', request.periodId);
          requireActiveOpenPeriod(storedPeriod, context, request.periodId, 'fixed-expense-template.update');
          const stored = await transaction.get('fixedExpenseTemplates', request.templateId);
          if (stored === undefined) {
            throw domainError(ERROR_CODES.DOMAIN_STATE_INVALID, 'the requested FixedExpenseTemplate does not exist', {
              templateId: request.templateId,
            });
          }
          const previousValue = Domain.validateFixedExpenseTemplate(stored);
          assertExpectedRevision(previousValue.revision, request.expectedTemplateRevision, {
            entityType: 'FixedExpenseTemplate', entityId: request.templateId,
          });
          if (previousValue.status !== 'active') {
            throw domainError(ERROR_CODES.DOMAIN_STATE_INVALID, 'only an active FixedExpenseTemplate can be updated', {
              templateId: request.templateId, status: previousValue.status,
            });
          }
          assertRealChange(
            previousValue, request, changedFields, 'fixed-expense-template.update', request.templateId
          );
          const patch = {};
          for (const field of changedFields) patch[field] = request[field];
          const nextValue = Domain.validateFixedExpenseTemplate({
            ...previousValue,
            ...patch,
            revision: nextRevision(previousValue.revision),
            updatedAt: occurredAt,
          });
          const auditEvent = updatedAuditEvent({
            id: auditEventId,
            periodId: request.periodId,
            subjectType: 'fixed_expense_template',
            subjectId: request.templateId,
            commandType: 'fixed-expense-template.update',
            previousValue,
            nextValue,
            occurredAt,
          });
          await transaction.put('fixedExpenseTemplates', nextValue);
          await transaction.add('auditEvents', auditEvent);
          return Object.freeze({ template: nextValue, auditEvent });
        },
      });
    }

    async function deactivateFixedExpenseTemplate(input) {
      const request = requireRecord(input, 'fixed-expense-template.deactivate');
      const fields = [
        'expectedDataRevision', 'expectedWriterEpoch', 'periodId',
        'templateId', 'expectedTemplateRevision',
      ];
      validateCommandHeader(request, 'fixed-expense-template.deactivate', fields);
      assertUuid(request.templateId, { field: 'templateId' });
      assertRevision(request.expectedTemplateRevision, { field: 'expectedTemplateRevision' });
      const occurredAt = canonicalTimestamp(now);
      const auditEventId = createIdentifier(createUuid, 'auditEvent.id', new Set());
      return runtime.executeCommand({
        commandType: 'fixed-expense-template.deactivate',
        expectedDataRevision: request.expectedDataRevision,
        expectedWriterEpoch: request.expectedWriterEpoch,
        affectedStores: FIXED_TEMPLATE_CHANGE_STORES,
        affectedScopes: entityScopes(request.periodId, 'fixed_expense_template', request.templateId),
        metadata: { periodId: request.periodId, templateId: request.templateId },
        execute: async (transaction, context) => {
          const storedPeriod = await transaction.get('periods', request.periodId);
          requireActiveOpenPeriod(storedPeriod, context, request.periodId, 'fixed-expense-template.deactivate');
          const stored = await transaction.get('fixedExpenseTemplates', request.templateId);
          if (stored === undefined) {
            throw domainError(ERROR_CODES.DOMAIN_STATE_INVALID, 'the requested FixedExpenseTemplate does not exist', {
              templateId: request.templateId,
            });
          }
          const previousValue = Domain.validateFixedExpenseTemplate(stored);
          assertExpectedRevision(previousValue.revision, request.expectedTemplateRevision, {
            entityType: 'FixedExpenseTemplate', entityId: request.templateId,
          });
          if (previousValue.status !== 'active') {
            throw domainError(ERROR_CODES.DOMAIN_STATE_INVALID, 'only an active FixedExpenseTemplate can be deactivated', {
              templateId: request.templateId, status: previousValue.status,
            });
          }
          const nextValue = Domain.validateFixedExpenseTemplate({
            ...previousValue,
            status: 'inactive',
            revision: nextRevision(previousValue.revision),
            updatedAt: occurredAt,
          });
          const auditEvent = stateChangedAuditEvent({
            id: auditEventId,
            periodId: request.periodId,
            subjectType: 'fixed_expense_template',
            subjectId: request.templateId,
            action: 'deactivated',
            commandType: 'fixed-expense-template.deactivate',
            previousValue,
            nextValue,
            occurredAt,
          });
          await transaction.put('fixedExpenseTemplates', nextValue);
          await transaction.add('auditEvents', auditEvent);
          return Object.freeze({ template: nextValue, auditEvent });
        },
      });
    }

    async function updateFixedExpenseInstancePlannedAmount(input) {
      const request = requireRecord(input, 'fixed-expense-instance.update-planned-amount');
      const fields = [
        'expectedDataRevision', 'expectedWriterEpoch', 'periodId',
        'instanceId', 'expectedInstanceRevision', 'plannedAmount',
      ];
      validateCommandHeader(request, 'fixed-expense-instance.update-planned-amount', fields);
      assertUuid(request.instanceId, { field: 'instanceId' });
      assertRevision(request.expectedInstanceRevision, { field: 'expectedInstanceRevision' });
      assertPositiveMoney(request.plannedAmount, { field: 'plannedAmount' });
      const occurredAt = canonicalTimestamp(now);
      const auditEventId = createIdentifier(createUuid, 'auditEvent.id', new Set());
      return runtime.executeCommand({
        commandType: 'fixed-expense-instance.update-planned-amount',
        expectedDataRevision: request.expectedDataRevision,
        expectedWriterEpoch: request.expectedWriterEpoch,
        affectedStores: FIXED_INSTANCE_CHANGE_STORES,
        affectedScopes: entityScopes(request.periodId, 'fixed_expense_instance', request.instanceId),
        metadata: { periodId: request.periodId, instanceId: request.instanceId },
        execute: async (transaction, context) => {
          const storedPeriod = await transaction.get('periods', request.periodId);
          requireActiveOpenPeriod(
            storedPeriod, context, request.periodId, 'fixed-expense-instance.update-planned-amount'
          );
          const stored = await transaction.get('fixedExpenseInstances', request.instanceId);
          if (stored === undefined) {
            throw domainError(ERROR_CODES.DOMAIN_STATE_INVALID, 'the requested FixedExpenseInstance does not exist', {
              instanceId: request.instanceId,
            });
          }
          const previousValue = Domain.validateFixedExpenseInstance(stored);
          if (previousValue.periodId !== request.periodId) {
            throw domainError(
              ERROR_CODES.DOMAIN_RELATION_MISMATCH,
              'FixedExpenseInstance does not belong to the active Period',
              {
                instanceId: request.instanceId,
                instancePeriodId: previousValue.periodId,
                activePeriodId: request.periodId,
              }
            );
          }
          assertExpectedRevision(previousValue.revision, request.expectedInstanceRevision, {
            entityType: 'FixedExpenseInstance', entityId: request.instanceId,
          });
          assertRealChange(
            previousValue,
            request,
            ['plannedAmount'],
            'fixed-expense-instance.update-planned-amount',
            request.instanceId
          );
          const nextValue = Domain.validateFixedExpenseInstance({
            ...previousValue,
            plannedAmount: request.plannedAmount,
            revision: nextRevision(previousValue.revision),
            updatedAt: occurredAt,
          });
          const auditEvent = updatedAuditEvent({
            id: auditEventId,
            periodId: request.periodId,
            subjectType: 'fixed_expense_instance',
            subjectId: request.instanceId,
            commandType: 'fixed-expense-instance.update-planned-amount',
            previousValue,
            nextValue,
            occurredAt,
          });
          await transaction.put('fixedExpenseInstances', nextValue);
          await transaction.add('auditEvents', auditEvent);
          return Object.freeze({ instance: nextValue, auditEvent });
        },
      });
    }

    async function createSavingsGoal(input) {
      const request = requireRecord(input, 'savings-goal.create');
      const fields = ['expectedDataRevision', 'expectedWriterEpoch', 'periodId', 'goal'];
      validateCommandHeader(request, 'savings-goal.create', fields);
      requireOnlyFields(
        requireRecord(request.goal, 'SavingsGoal'),
        SAVINGS_GOAL_FIELDS,
        'SavingsGoal'
      );
      const goal = Domain.validateSavingsGoal(request.goal);
      if (
        goal.revision !== 1 || goal.lifecycleStatus !== 'active' ||
        goal.progressStatus !== 'in_progress' || goal.closedAt !== null
      ) {
        throw domainError(
          ERROR_CODES.DOMAIN_STATE_INVALID,
          'a new SavingsGoal must use its exact initial active state and revision 1',
          {
            goalId: goal.id,
            revision: goal.revision,
            lifecycleStatus: goal.lifecycleStatus,
            progressStatus: goal.progressStatus,
            closedAt: goal.closedAt,
          }
        );
      }
      Domain.assertInitialBalancePolicy({
        targetType: 'savings_goal',
        duringSetup: false,
        openingBalance: goal.openingBalance,
        currentBalance: goal.currentBalance,
      });
      const occurredAt = canonicalTimestamp(now);
      const usedGeneratedIds = new Set();
      const opening = Domain.validatePeriodOpening({
        id: createIdentifier(createUuid, 'periodOpening.id', usedGeneratedIds),
        periodId: request.periodId,
        targetType: 'savings_goal',
        targetId: goal.id,
        openingAmount: 0,
      });
      Domain.assertPostSetupSavingsGoalOpening(goal, opening, request.periodId);
      const auditEvent = createdAuditEvent({
        id: createIdentifier(createUuid, 'auditEvent.id', usedGeneratedIds),
        periodId: request.periodId,
        subjectType: 'savings_goal',
        subjectId: goal.id,
        commandType: 'savings-goal.create',
        nextValue: goal,
        occurredAt,
      });
      return runtime.executeCommand({
        commandType: 'savings-goal.create',
        expectedDataRevision: request.expectedDataRevision,
        expectedWriterEpoch: request.expectedWriterEpoch,
        affectedStores: SAVINGS_GOAL_CREATE_STORES,
        affectedScopes: entityScopes(request.periodId, 'savings_goal', goal.id),
        metadata: { periodId: request.periodId, goalId: goal.id },
        execute: async (transaction, context) => {
          const storedPeriod = await transaction.get('periods', request.periodId);
          requireActiveOpenPeriod(storedPeriod, context, request.periodId, 'savings-goal.create');
          if (await transaction.get('savingsGoals', goal.id) !== undefined) {
            throw domainError(
              ERROR_CODES.DOMAIN_RELATION_MISMATCH,
              'a SavingsGoal with the requested ID already exists',
              { goalId: goal.id }
            );
          }
          await transaction.add('savingsGoals', goal);
          await transaction.add('periodOpenings', opening);
          await transaction.add('auditEvents', auditEvent);
          return Object.freeze({ goal, periodOpening: opening, auditEvent });
        },
      });
    }

    async function updateSavingsGoal(input) {
      const request = requireRecord(input, 'savings-goal.update');
      const required = [
        'expectedDataRevision', 'expectedWriterEpoch', 'periodId',
        'goalId', 'expectedGoalRevision',
      ];
      const allowed = [...required, ...SAVINGS_GOAL_EDITABLE_FIELDS];
      validateCommandHeader(request, 'savings-goal.update', required, allowed);
      assertUuid(request.goalId, { field: 'goalId' });
      assertRevision(request.expectedGoalRevision, { field: 'expectedGoalRevision' });
      const changedFields = editableFieldsFrom(request, SAVINGS_GOAL_EDITABLE_FIELDS, 'savings-goal.update');
      if (hasOwn(request, 'targetAmount')) {
        assertPositiveMoney(request.targetAmount, { field: 'targetAmount' });
      }
      if (hasOwn(request, 'plannedMonthlyAmount')) {
        assertMoney(request.plannedMonthlyAmount, { field: 'plannedMonthlyAmount', allowZero: true });
      }
      const occurredAt = canonicalTimestamp(now);
      const auditEventId = createIdentifier(createUuid, 'auditEvent.id', new Set());
      return runtime.executeCommand({
        commandType: 'savings-goal.update',
        expectedDataRevision: request.expectedDataRevision,
        expectedWriterEpoch: request.expectedWriterEpoch,
        affectedStores: SAVINGS_GOAL_CHANGE_STORES,
        affectedScopes: entityScopes(request.periodId, 'savings_goal', request.goalId),
        metadata: { periodId: request.periodId, goalId: request.goalId, changedFields },
        execute: async (transaction, context) => {
          const storedPeriod = await transaction.get('periods', request.periodId);
          requireActiveOpenPeriod(storedPeriod, context, request.periodId, 'savings-goal.update');
          const stored = await transaction.get('savingsGoals', request.goalId);
          if (stored === undefined) {
            throw domainError(ERROR_CODES.DOMAIN_STATE_INVALID, 'the requested SavingsGoal does not exist', {
              goalId: request.goalId,
            });
          }
          const previousValue = Domain.validateSavingsGoal(stored);
          assertExpectedRevision(previousValue.revision, request.expectedGoalRevision, {
            entityType: 'SavingsGoal', entityId: request.goalId,
          });
          if (previousValue.lifecycleStatus !== 'active') {
            throw domainError(ERROR_CODES.DOMAIN_STATE_INVALID, 'a closed SavingsGoal cannot be updated', {
              goalId: request.goalId, lifecycleStatus: previousValue.lifecycleStatus,
            });
          }
          assertRealChange(previousValue, request, changedFields, 'savings-goal.update', request.goalId);
          const patch = {};
          for (const field of changedFields) patch[field] = request[field];
          const targetAmount = hasOwn(patch, 'targetAmount')
            ? patch.targetAmount
            : previousValue.targetAmount;
          const nextValue = Domain.validateSavingsGoal({
            ...previousValue,
            ...patch,
            progressStatus: previousValue.currentBalance >= targetAmount ? 'completed' : 'in_progress',
            revision: nextRevision(previousValue.revision),
            updatedAt: occurredAt,
          });
          const auditEvent = updatedAuditEvent({
            id: auditEventId,
            periodId: request.periodId,
            subjectType: 'savings_goal',
            subjectId: request.goalId,
            commandType: 'savings-goal.update',
            previousValue,
            nextValue,
            occurredAt,
          });
          await transaction.put('savingsGoals', nextValue);
          await transaction.add('auditEvents', auditEvent);
          return Object.freeze({ goal: nextValue, auditEvent });
        },
      });
    }

    async function closeSavingsGoal(input) {
      const request = requireRecord(input, 'savings-goal.close');
      const fields = [
        'expectedDataRevision', 'expectedWriterEpoch', 'periodId',
        'goalId', 'expectedGoalRevision',
      ];
      validateCommandHeader(request, 'savings-goal.close', fields);
      assertUuid(request.goalId, { field: 'goalId' });
      assertRevision(request.expectedGoalRevision, { field: 'expectedGoalRevision' });
      const occurredAt = canonicalTimestamp(now);
      const auditEventId = createIdentifier(createUuid, 'auditEvent.id', new Set());
      return runtime.executeCommand({
        commandType: 'savings-goal.close',
        expectedDataRevision: request.expectedDataRevision,
        expectedWriterEpoch: request.expectedWriterEpoch,
        affectedStores: SAVINGS_GOAL_CHANGE_STORES,
        affectedScopes: entityScopes(request.periodId, 'savings_goal', request.goalId),
        metadata: { periodId: request.periodId, goalId: request.goalId },
        execute: async (transaction, context) => {
          const storedPeriod = await transaction.get('periods', request.periodId);
          requireActiveOpenPeriod(storedPeriod, context, request.periodId, 'savings-goal.close');
          const stored = await transaction.get('savingsGoals', request.goalId);
          if (stored === undefined) {
            throw domainError(ERROR_CODES.DOMAIN_STATE_INVALID, 'the requested SavingsGoal does not exist', {
              goalId: request.goalId,
            });
          }
          const previousValue = Domain.validateSavingsGoal(stored);
          assertExpectedRevision(previousValue.revision, request.expectedGoalRevision, {
            entityType: 'SavingsGoal', entityId: request.goalId,
          });
          if (previousValue.lifecycleStatus !== 'active') {
            throw domainError(ERROR_CODES.DOMAIN_STATE_INVALID, 'only an active SavingsGoal can be closed', {
              goalId: request.goalId, lifecycleStatus: previousValue.lifecycleStatus,
            });
          }
          if (previousValue.currentBalance !== 0) {
            throw domainError(ERROR_CODES.DOMAIN_STATE_INVALID, 'SavingsGoal balance must be zero before closing', {
              goalId: request.goalId, currentBalance: previousValue.currentBalance,
            });
          }
          const nextValue = Domain.validateSavingsGoal({
            ...previousValue,
            lifecycleStatus: 'closed',
            closedAt: occurredAt,
            revision: nextRevision(previousValue.revision),
            updatedAt: occurredAt,
          });
          const auditEvent = stateChangedAuditEvent({
            id: auditEventId,
            periodId: request.periodId,
            subjectType: 'savings_goal',
            subjectId: request.goalId,
            action: 'closed',
            commandType: 'savings-goal.close',
            previousValue,
            nextValue,
            occurredAt,
          });
          await transaction.put('savingsGoals', nextValue);
          await transaction.add('auditEvents', auditEvent);
          return Object.freeze({ goal: nextValue, auditEvent });
        },
      });
    }

    async function createDebt(input) {
      const request = requireRecord(input, 'debt.create');
      const fields = [
        'expectedDataRevision', 'expectedWriterEpoch', 'periodId',
        'currentCivilDate', 'debt',
      ];
      validateCommandHeader(request, 'debt.create', fields);
      assertCivilDate(request.currentCivilDate, { field: 'currentCivilDate' });
      requireOnlyFields(requireRecord(request.debt, 'Debt'), DEBT_FIELDS, 'Debt');
      const debt = Domain.validateDebt(request.debt);
      if (
        debt.revision !== 1 || debt.lifecycleStatus !== 'active' ||
        debt.paymentStatus !== 'active' || debt.dueDate !== null ||
        debt.monthlyPaymentAmount === null || debt.paymentDay === null
      ) {
        throw domainError(
          ERROR_CODES.DOMAIN_STATE_INVALID,
          'a new Debt requires a monthly payment and payment day in its exact initial active state',
          {
            debtId: debt.id,
            revision: debt.revision,
            lifecycleStatus: debt.lifecycleStatus,
            paymentStatus: debt.paymentStatus,
            dueDate: debt.dueDate,
            monthlyPaymentAmount: debt.monthlyPaymentAmount,
            paymentDay: debt.paymentDay,
          }
        );
      }
      const occurredAt = canonicalTimestamp(now);
      const usedGeneratedIds = new Set();
      const opening = Domain.validatePeriodOpening({
        id: createIdentifier(createUuid, 'periodOpening.id', usedGeneratedIds),
        periodId: request.periodId,
        targetType: 'debt',
        targetId: debt.id,
        openingAmount: debt.totalAmount,
      });
      Domain.assertNewDebtOpening(debt, opening, request.periodId);
      const auditEvent = createdAuditEvent({
        id: createIdentifier(createUuid, 'auditEvent.id', usedGeneratedIds),
        periodId: request.periodId,
        subjectType: 'debt',
        subjectId: debt.id,
        commandType: 'debt.create',
        nextValue: debt,
        occurredAt,
      });
      return runtime.executeCommand({
        commandType: 'debt.create',
        expectedDataRevision: request.expectedDataRevision,
        expectedWriterEpoch: request.expectedWriterEpoch,
        affectedStores: DEBT_CREATE_STORES,
        affectedScopes: entityScopes(request.periodId, 'debt', debt.id),
        metadata: { periodId: request.periodId, debtId: debt.id },
        execute: async (transaction, context) => {
          const storedPeriod = await transaction.get('periods', request.periodId);
          requireActiveOpenPeriod(storedPeriod, context, request.periodId, 'debt.create');
          if (await transaction.get('debts', debt.id) !== undefined) {
            throw domainError(
              ERROR_CODES.DOMAIN_RELATION_MISMATCH,
              'a Debt with the requested ID already exists',
              { debtId: debt.id }
            );
          }
          await transaction.add('debts', debt);
          await transaction.add('periodOpenings', opening);
          await transaction.add('auditEvents', auditEvent);
          return Object.freeze({ debt, periodOpening: opening, auditEvent });
        },
      });
    }

    async function updateDebtNameAndDueDate(input) {
      const request = requireRecord(input, 'debt.update-name-and-due-date');
      const required = [
        'expectedDataRevision', 'expectedWriterEpoch', 'periodId', 'currentCivilDate',
        'debtId', 'expectedDebtRevision',
      ];
      const allowed = [...required, ...DEBT_EDITABLE_FIELDS];
      validateCommandHeader(request, 'debt.update-name-and-due-date', required, allowed);
      assertCivilDate(request.currentCivilDate, { field: 'currentCivilDate' });
      assertUuid(request.debtId, { field: 'debtId' });
      assertRevision(request.expectedDebtRevision, { field: 'expectedDebtRevision' });
      const changedFields = editableFieldsFrom(
        request, DEBT_EDITABLE_FIELDS, 'debt.update-name-and-due-date'
      );
      const occurredAt = canonicalTimestamp(now);
      const auditEventId = createIdentifier(createUuid, 'auditEvent.id', new Set());
      return runtime.executeCommand({
        commandType: 'debt.update-name-and-due-date',
        expectedDataRevision: request.expectedDataRevision,
        expectedWriterEpoch: request.expectedWriterEpoch,
        affectedStores: DEBT_CHANGE_STORES,
        affectedScopes: entityScopes(request.periodId, 'debt', request.debtId),
        metadata: { periodId: request.periodId, debtId: request.debtId, changedFields },
        execute: async (transaction, context) => {
          const storedPeriod = await transaction.get('periods', request.periodId);
          requireActiveOpenPeriod(
            storedPeriod, context, request.periodId, 'debt.update-name-and-due-date'
          );
          const stored = await transaction.get('debts', request.debtId);
          if (stored === undefined) {
            throw domainError(ERROR_CODES.DOMAIN_STATE_INVALID, 'the requested Debt does not exist', {
              debtId: request.debtId,
            });
          }
          const previousValue = Domain.validateDebt(stored);
          assertExpectedRevision(previousValue.revision, request.expectedDebtRevision, {
            entityType: 'Debt', entityId: request.debtId,
          });
          if (previousValue.lifecycleStatus !== 'active' || previousValue.paymentStatus === 'paid') {
            throw domainError(ERROR_CODES.DOMAIN_STATE_INVALID, 'only an active unpaid Debt can be updated', {
              debtId: request.debtId,
              lifecycleStatus: previousValue.lifecycleStatus,
              paymentStatus: previousValue.paymentStatus,
            });
          }
          assertRealChange(
            previousValue,
            request,
            changedFields,
            'debt.update-name-and-due-date',
            request.debtId
          );
          const patch = {};
          for (const field of changedFields) patch[field] = request[field];
          const paymentStatus = previousValue.dueDate !== null && previousValue.dueDate < request.currentCivilDate
            ? 'overdue'
            : 'active';
          const nextValue = Domain.validateDebt({
            ...previousValue,
            ...patch,
            paymentStatus,
            revision: nextRevision(previousValue.revision),
            updatedAt: occurredAt,
          });
          const auditEvent = updatedAuditEvent({
            id: auditEventId,
            periodId: request.periodId,
            subjectType: 'debt',
            subjectId: request.debtId,
            commandType: 'debt.update-name-and-due-date',
            previousValue,
            nextValue,
            occurredAt,
          });
          await transaction.put('debts', nextValue);
          await transaction.add('auditEvents', auditEvent);
          return Object.freeze({ debt: nextValue, auditEvent });
        },
      });
    }

    async function executeAccountOperationCreate(options) {
      const request = options.request;
      const policy = ACCOUNT_OPERATION_POLICIES[options.operationType];
      const occurredAt = canonicalTimestamp(now);
      const currentCivilDate = currentCivilDateFromTimestamp(occurredAt);
      const generatedIds = new Set();
      let operation = Domain.validateOperation({
        id: createIdentifier(createUuid, 'operation.id', generatedIds),
        periodId: request.periodId,
        type: options.operationType,
        operationDate: request.operationDate,
        amount: request.amount,
        status: 'posted',
        revision: 1,
        createdAt: occurredAt,
        updatedAt: occurredAt,
        voidedAt: null,
        voidReason: null,
        details: options.details,
      });
      const movement = Domain.validateMovement({
        id: createIdentifier(createUuid, 'movement.id', generatedIds),
        operationId: operation.id,
        periodId: request.periodId,
        targetType: 'account',
        targetId: request.accountId,
        effectType: 'asset_balance',
        delta: policy.deltaSign * request.amount,
        status: 'posted',
        createdAt: occurredAt,
        updatedAt: occurredAt,
      });
      validateAccountOperation(operation, movement, options.operationType, request.accountId);
      return runtime.executeCommand({
        commandType: options.commandType,
        expectedDataRevision: request.expectedDataRevision,
        expectedWriterEpoch: request.expectedWriterEpoch,
        affectedStores: options.stores,
        affectedScopes: accountOperationScopes(
          request.periodId, request.accountId, request.accountId, options.relatedScopes
        ),
        metadata: {
          periodId: request.periodId,
          operationId: operation.id,
          accountId: request.accountId,
          ...(options.metadata || {}),
        },
        execute: async (transaction, context) => {
          const period = requireActiveOpenPeriod(
            await transaction.get('periods', request.periodId),
            context,
            request.periodId,
            options.commandType
          );
          Domain.assertOperationDateContext(operation, period, currentCivilDate);
          const target = requireFinancialTarget(
            'account',
            await transaction.get('accounts', request.accountId),
            request.accountId,
            request.expectedAccountRevision
          );
          const account = simulateTargetChange(target, null, movement.delta, {
            operationId: operation.id,
            targetType: 'account',
            targetId: request.accountId,
            occurredAt,
            allowCurrentNegative: true,
          });
          const relatedData = {};
          for (const read of options.relatedReads || []) {
            relatedData[read.key] = read.all
              ? await transaction.getAll(read.storeName)
              : await transaction.get(read.storeName, read.id);
          }
          const related = options.prepareRelated
            ? options.prepareRelated({
              request, operation, movement, period, occurredAt, relatedData,
            })
            : Object.freeze({ writes: [], result: {} });
          if (related.details) {
            operation = Domain.validateOperation({ ...operation, details: related.details });
            validateAccountOperation(operation, movement, options.operationType, request.accountId);
          }
          if (
            await transaction.get('operations', operation.id) !== undefined ||
            await transaction.get('movements', movement.id) !== undefined
          ) {
            throw domainError(
              ERROR_CODES.DOMAIN_RELATION_MISMATCH,
              'generated financial record IDs must be unique',
              { operationId: operation.id, movementId: movement.id }
            );
          }
          if (account !== target.entity) await transaction.put('accounts', account);
          await applyPreparedWrites(transaction, related.writes);
          await transaction.add('operations', operation);
          await transaction.add('movements', movement);
          return Object.freeze({
            operation, movement, account, ...(related.result || {}),
          });
        },
      });
    }

    async function executeAccountOperationEdit(options) {
      const request = options.request;
      const occurredAt = canonicalTimestamp(now);
      const currentCivilDate = currentCivilDateFromTimestamp(occurredAt);
      const revisionId = createIdentifier(createUuid, 'operationRevision.id', new Set());
      return runtime.executeCommand({
        commandType: options.commandType,
        expectedDataRevision: request.expectedDataRevision,
        expectedWriterEpoch: request.expectedWriterEpoch,
        affectedStores: options.stores,
        affectedScopes: accountOperationScopes(
          request.periodId,
          request.previousAccountId,
          request.accountId,
          options.relatedScopes
        ),
        metadata: {
          periodId: request.periodId,
          operationId: request.operationId,
          previousAccountId: request.previousAccountId,
          accountId: request.accountId,
          ...(options.metadata || {}),
        },
        execute: async (transaction, context) => {
          const period = requireActiveOpenPeriod(
            await transaction.get('periods', request.periodId),
            context,
            request.periodId,
            options.commandType
          );
          const storedOperation = await transaction.get('operations', request.operationId);
          if (storedOperation === undefined) {
            throw domainError(
              ERROR_CODES.DOMAIN_STATE_INVALID,
              'the requested Operation does not exist',
              { operationId: request.operationId }
            );
          }
          const previousOperation = Domain.validateOperation(storedOperation);
          if (
            previousOperation.periodId !== request.periodId ||
            previousOperation.type !== options.operationType ||
            previousOperation.status !== 'posted'
          ) {
            throw domainError(
              ERROR_CODES.DOMAIN_STATE_INVALID,
              'the requested posted Operation has an incompatible type or Period',
              {
                operationId: request.operationId,
                expectedType: options.operationType,
                actualType: previousOperation.type,
                status: previousOperation.status,
                operationPeriodId: previousOperation.periodId,
                periodId: request.periodId,
              }
            );
          }
          assertExpectedRevision(previousOperation.revision, request.expectedOperationRevision, {
            entityType: 'Operation', entityId: request.operationId,
          });
          const previousMovement = requireSingleOperationMovement(
            request.operationId, await transaction.getAll('movements')
          );
          validateAccountOperation(
            previousOperation,
            previousMovement,
            options.operationType,
            request.previousAccountId
          );
          const previousDetails = options.validateDetails(previousOperation);
          if (previousDetails.accountId !== request.previousAccountId) {
            throw domainError(
              ERROR_CODES.DOMAIN_RELATION_MISMATCH,
              'previousAccountId does not match Operation.details',
              { operationId: request.operationId, previousAccountId: request.previousAccountId }
            );
          }
          const nextDate = hasOwn(request, 'operationDate')
            ? request.operationDate
            : previousOperation.operationDate;
          const nextAmount = hasOwn(request, 'amount') ? request.amount : previousOperation.amount;
          const relatedData = {};
          for (const read of options.relatedReads || []) {
            relatedData[read.key] = read.all
              ? await transaction.getAll(read.storeName)
              : await transaction.get(read.storeName, read.id);
          }
          const related = options.prepareRelated
            ? options.prepareRelated({
              request,
              previousOperation,
              previousMovement,
              previousDetails,
              period,
              occurredAt,
              relatedData,
            })
            : Object.freeze({ details: previousDetails, writes: [], result: {} });
          const nextDetails = related.details || previousDetails;
          if (nextDetails.accountId !== request.accountId) {
            throw domainError(
              ERROR_CODES.DOMAIN_RELATION_MISMATCH,
              'the edited Operation details do not match its Account',
              { operationId: request.operationId, accountId: request.accountId }
            );
          }
          if (
            request.accountId === request.previousAccountId &&
            nextDate === previousOperation.operationDate &&
            nextAmount === previousOperation.amount &&
            sameJsonValue(nextDetails, previousDetails)
          ) {
            throw domainError(
              ERROR_CODES.INVALID_DOMAIN_FIELD,
              `${options.commandType} requires a real change`,
              { operationId: request.operationId }
            );
          }
          const nextOperation = Domain.validateOperation({
            ...previousOperation,
            operationDate: nextDate,
            amount: nextAmount,
            details: nextDetails,
            revision: nextRevision(previousOperation.revision),
            updatedAt: occurredAt,
          });
          const policy = ACCOUNT_OPERATION_POLICIES[options.operationType];
          const nextMovement = Domain.validateMovement({
            ...previousMovement,
            targetId: request.accountId,
            delta: policy.deltaSign * nextAmount,
            updatedAt: occurredAt,
          });
          validateAccountOperation(nextOperation, nextMovement, options.operationType, request.accountId);
          Domain.assertOperationDateContext(nextOperation, period, currentCivilDate);

          const previousTarget = requireFinancialTarget(
            'account',
            await transaction.get('accounts', request.previousAccountId),
            request.previousAccountId,
            request.expectedPreviousAccountRevision
          );
          const accountUpdates = [];
          let previousAccount;
          let account;
          if (request.previousAccountId === request.accountId) {
            assertExpectedRevision(
              previousTarget.entity.revision,
              request.expectedAccountRevision,
              { entityType: 'account', entityId: request.accountId }
            );
            account = simulateTargetChange(
              previousTarget, previousMovement.delta, nextMovement.delta,
              {
                operationId: request.operationId,
                targetType: 'account',
                targetId: request.accountId,
                occurredAt,
                allowCurrentNegative: true,
              }
            );
            previousAccount = account;
            if (account !== previousTarget.entity) accountUpdates.push(account);
          } else {
            const nextTarget = requireFinancialTarget(
              'account',
              await transaction.get('accounts', request.accountId),
              request.accountId,
              request.expectedAccountRevision
            );
            previousAccount = simulateTargetChange(
              previousTarget, previousMovement.delta, null,
              {
                operationId: request.operationId,
                targetType: 'account',
                targetId: request.previousAccountId,
                occurredAt,
                allowCurrentNegative: true,
              }
            );
            account = simulateTargetChange(
              nextTarget, null, nextMovement.delta,
              {
                operationId: request.operationId,
                targetType: 'account',
                targetId: request.accountId,
                occurredAt,
                allowCurrentNegative: true,
              }
            );
            if (previousAccount !== previousTarget.entity) accountUpdates.push(previousAccount);
            if (account !== nextTarget.entity) accountUpdates.push(account);
          }
          const revision = Domain.validateOperationRevision({
            id: revisionId,
            operationId: request.operationId,
            periodId: request.periodId,
            revisionNumber: previousOperation.revision,
            changeType: 'edit',
            previousOperation,
            previousMovements: [previousMovement],
            reason: null,
            createdAt: occurredAt,
          });
          assertLogicalRevisionAvailable(
            await transaction.getAll('operationRevisions'), revision
          );
          if (await transaction.get('operationRevisions', revision.id) !== undefined) {
            throw domainError(
              ERROR_CODES.DUPLICATE_OPERATION_REVISION,
              'the generated OperationRevision ID already exists',
              { revisionId: revision.id }
            );
          }
          for (const updatedAccount of accountUpdates) {
            await transaction.put('accounts', updatedAccount);
          }
          await applyPreparedWrites(transaction, related.writes);
          await transaction.put('operations', nextOperation);
          await transaction.put('movements', nextMovement);
          await transaction.add('operationRevisions', revision);
          return Object.freeze({
            operation: nextOperation,
            movement: nextMovement,
            account,
            previousAccount,
            operationRevision: revision,
            ...(related.result || {}),
          });
        },
      });
    }

    async function executeAccountOperationVoid(options) {
      const request = options.request;
      const occurredAt = canonicalTimestamp(now);
      const currentCivilDate = currentCivilDateFromTimestamp(occurredAt);
      const revisionId = createIdentifier(createUuid, 'operationRevision.id', new Set());
      const reason = hasOwn(request, 'reason')
        ? requireNonEmptyString(request.reason, 'reason')
        : null;
      return runtime.executeCommand({
        commandType: options.commandType,
        expectedDataRevision: request.expectedDataRevision,
        expectedWriterEpoch: request.expectedWriterEpoch,
        affectedStores: options.stores,
        affectedScopes: accountOperationScopes(
          request.periodId, request.accountId, request.accountId, options.relatedScopes
        ),
        metadata: {
          periodId: request.periodId,
          operationId: request.operationId,
          accountId: request.accountId,
          ...(options.metadata || {}),
        },
        execute: async (transaction, context) => {
          const period = requireActiveOpenPeriod(
            await transaction.get('periods', request.periodId),
            context,
            request.periodId,
            options.commandType
          );
          const storedOperation = await transaction.get('operations', request.operationId);
          if (storedOperation === undefined) {
            throw domainError(
              ERROR_CODES.DOMAIN_STATE_INVALID,
              'the requested Operation does not exist',
              { operationId: request.operationId }
            );
          }
          const previousOperation = Domain.validateOperation(storedOperation);
          if (
            previousOperation.periodId !== request.periodId ||
            previousOperation.type !== options.operationType ||
            previousOperation.status !== 'posted'
          ) {
            throw domainError(
              ERROR_CODES.DOMAIN_STATE_INVALID,
              'the requested posted Operation has an incompatible type or Period',
              {
                operationId: request.operationId,
                expectedType: options.operationType,
                actualType: previousOperation.type,
                status: previousOperation.status,
              }
            );
          }
          Domain.assertOperationDateContext(previousOperation, period, currentCivilDate);
          assertExpectedRevision(previousOperation.revision, request.expectedOperationRevision, {
            entityType: 'Operation', entityId: request.operationId,
          });
          const previousMovement = requireSingleOperationMovement(
            request.operationId, await transaction.getAll('movements')
          );
          validateAccountOperation(
            previousOperation, previousMovement, options.operationType, request.accountId
          );
          const previousDetails = options.validateDetails(previousOperation);
          if (previousDetails.accountId !== request.accountId) {
            throw domainError(
              ERROR_CODES.DOMAIN_RELATION_MISMATCH,
              'accountId does not match Operation.details',
              { operationId: request.operationId, accountId: request.accountId }
            );
          }
          const target = requireFinancialTarget(
            'account',
            await transaction.get('accounts', request.accountId),
            request.accountId,
            request.expectedAccountRevision
          );
          const account = simulateTargetChange(target, previousMovement.delta, null, {
            operationId: request.operationId,
            targetType: 'account',
            targetId: request.accountId,
            occurredAt,
            allowCurrentNegative: true,
          });
          const relatedData = {};
          for (const read of options.relatedReads || []) {
            relatedData[read.key] = read.all
              ? await transaction.getAll(read.storeName)
              : await transaction.get(read.storeName, read.id);
          }
          const related = options.prepareRelated
            ? options.prepareRelated({
              request,
              previousOperation,
              previousMovement,
              previousDetails,
              period,
              occurredAt,
              relatedData,
            })
            : Object.freeze({ writes: [], result: {} });
          const nextOperation = Domain.validateOperation({
            ...previousOperation,
            status: 'voided',
            voidedAt: occurredAt,
            voidReason: reason,
            revision: nextRevision(previousOperation.revision),
            updatedAt: occurredAt,
          });
          const nextMovement = Domain.validateMovement({
            ...previousMovement,
            status: 'voided',
            updatedAt: occurredAt,
          });
          Domain.assertMovementMatchesOperation(nextOperation, nextMovement);
          const revision = Domain.validateOperationRevision({
            id: revisionId,
            operationId: request.operationId,
            periodId: request.periodId,
            revisionNumber: previousOperation.revision,
            changeType: 'void',
            previousOperation,
            previousMovements: [previousMovement],
            reason,
            createdAt: occurredAt,
          });
          assertLogicalRevisionAvailable(
            await transaction.getAll('operationRevisions'), revision
          );
          if (await transaction.get('operationRevisions', revision.id) !== undefined) {
            throw domainError(
              ERROR_CODES.DUPLICATE_OPERATION_REVISION,
              'the generated OperationRevision ID already exists',
              { revisionId: revision.id }
            );
          }
          if (account !== target.entity) await transaction.put('accounts', account);
          await applyPreparedWrites(transaction, related.writes);
          await transaction.put('operations', nextOperation);
          await transaction.put('movements', nextMovement);
          await transaction.add('operationRevisions', revision);
          return Object.freeze({
            operation: nextOperation,
            movement: nextMovement,
            account,
            operationRevision: revision,
            ...(related.result || {}),
          });
        },
      });
    }

    async function createBalanceAdjustment(input) {
      const request = requireRecord(input, 'balance-adjustment.create');
      const required = [
        'expectedDataRevision', 'expectedWriterEpoch', 'periodId',
        'operationDate', 'delta', 'reason',
      ];
      const allowed = [
        ...required,
        'accountId', 'expectedAccountRevision',
        'goalId', 'expectedGoalRevision',
      ];
      validateCommandHeader(request, 'balance-adjustment.create', required, allowed);
      const hasAccountTarget = hasOwn(request, 'accountId') || hasOwn(request, 'expectedAccountRevision');
      const hasGoalTarget = hasOwn(request, 'goalId') || hasOwn(request, 'expectedGoalRevision');
      if (hasAccountTarget === hasGoalTarget) {
        throw domainError(
          ERROR_CODES.INVALID_DOMAIN_FIELD,
          'balance-adjustment.create requires exactly one Account or SavingsGoal target',
          { hasAccountTarget, hasGoalTarget }
        );
      }
      const targetType = hasAccountTarget ? 'account' : 'savings_goal';
      const targetId = hasAccountTarget ? request.accountId : request.goalId;
      const expectedTargetRevision = hasAccountTarget
        ? request.expectedAccountRevision
        : request.expectedGoalRevision;
      assertUuid(targetId, { field: hasAccountTarget ? 'accountId' : 'goalId' });
      assertRevision(expectedTargetRevision, {
        field: hasAccountTarget ? 'expectedAccountRevision' : 'expectedGoalRevision',
      });
      assertCivilDate(request.operationDate, { field: 'operationDate' });
      assertSafeDelta(request.delta, { field: 'delta' });
      requireNonEmptyString(request.reason, 'reason');
      const occurredAt = canonicalTimestamp(now);
      const currentCivilDate = currentCivilDateFromTimestamp(occurredAt);
      const generatedIds = new Set();
      const operation = Domain.validateOperation({
        id: createIdentifier(createUuid, 'operation.id', generatedIds),
        periodId: request.periodId,
        type: 'balance_adjustment',
        operationDate: request.operationDate,
        amount: Math.abs(request.delta),
        status: 'posted',
        revision: 1,
        createdAt: occurredAt,
        updatedAt: occurredAt,
        voidedAt: null,
        voidReason: null,
        details: hasAccountTarget
          ? balanceAdjustmentDetails(targetId, request.reason)
          : savingsGoalBalanceAdjustmentDetails(targetId, request.reason),
      });
      const movement = Domain.validateMovement({
        id: createIdentifier(createUuid, 'movement.id', generatedIds),
        operationId: operation.id,
        periodId: request.periodId,
        targetType,
        targetId,
        effectType: 'asset_balance',
        delta: request.delta,
        status: 'posted',
        createdAt: occurredAt,
        updatedAt: occurredAt,
      });
      Domain.assertMovementMatchesOperation(operation, movement);
      return runtime.executeCommand({
        commandType: 'balance-adjustment.create',
        expectedDataRevision: request.expectedDataRevision,
        expectedWriterEpoch: request.expectedWriterEpoch,
        affectedStores: hasAccountTarget
          ? FINANCIAL_OPERATION_CREATE_STORES
          : SAVINGS_BALANCE_ADJUSTMENT_CREATE_STORES,
        affectedScopes: movementScopes(request.periodId, [movement]),
        metadata: {
          periodId: request.periodId,
          operationId: operation.id,
          ...(hasAccountTarget ? { accountId: targetId } : { goalId: targetId }),
        },
        execute: async (transaction, context) => {
          const storedPeriod = await transaction.get('periods', request.periodId);
          const period = requireActiveOpenPeriod(
            storedPeriod, context, request.periodId, 'balance-adjustment.create'
          );
          Domain.assertOperationDateContext(operation, period, currentCivilDate);
          const target = requireFinancialTarget(
            targetType,
            await transaction.get(
              hasAccountTarget ? 'accounts' : 'savingsGoals',
              targetId
            ),
            targetId,
            expectedTargetRevision
          );
          const entity = simulateTargetChange(target, null, movement.delta, {
            operationId: operation.id,
            targetType,
            targetId,
            occurredAt,
            allowCurrentNegative: hasAccountTarget,
          });
          if (
            await transaction.get('operations', operation.id) !== undefined ||
            await transaction.get('movements', movement.id) !== undefined
          ) {
            throw domainError(
              ERROR_CODES.DOMAIN_RELATION_MISMATCH,
              'generated financial record IDs must be unique',
              { operationId: operation.id, movementId: movement.id }
            );
          }
          if (entity !== target.entity) {
            await transaction.put(hasAccountTarget ? 'accounts' : 'savingsGoals', entity);
          }
          await transaction.add('operations', operation);
          await transaction.add('movements', movement);
          return Object.freeze({
            operation,
            movement,
            ...(hasAccountTarget ? { account: entity } : { savingsGoal: entity }),
          });
        },
      });
    }

    async function editBalanceAdjustment(input) {
      const request = requireRecord(input, 'balance-adjustment.edit');
      const required = [
        'expectedDataRevision', 'expectedWriterEpoch', 'periodId',
        'accountId', 'expectedAccountRevision', 'operationId', 'expectedOperationRevision',
      ];
      const allowed = [...required, ...BALANCE_ADJUSTMENT_EDITABLE_FIELDS];
      validateCommandHeader(request, 'balance-adjustment.edit', required, allowed);
      assertUuid(request.accountId, { field: 'accountId' });
      assertUuid(request.operationId, { field: 'operationId' });
      assertRevision(request.expectedAccountRevision, { field: 'expectedAccountRevision' });
      assertRevision(request.expectedOperationRevision, { field: 'expectedOperationRevision' });
      const changedFields = editableFieldsFrom(
        request, BALANCE_ADJUSTMENT_EDITABLE_FIELDS, 'balance-adjustment.edit'
      );
      if (hasOwn(request, 'operationDate')) {
        assertCivilDate(request.operationDate, { field: 'operationDate' });
      }
      if (hasOwn(request, 'delta')) assertSafeDelta(request.delta, { field: 'delta' });
      if (hasOwn(request, 'reason')) requireNonEmptyString(request.reason, 'reason');
      const occurredAt = canonicalTimestamp(now);
      const currentCivilDate = currentCivilDateFromTimestamp(occurredAt);
      const revisionId = createIdentifier(createUuid, 'operationRevision.id', new Set());
      const declaredMovement = {
        targetType: 'account',
        targetId: request.accountId,
      };
      return runtime.executeCommand({
        commandType: 'balance-adjustment.edit',
        expectedDataRevision: request.expectedDataRevision,
        expectedWriterEpoch: request.expectedWriterEpoch,
        affectedStores: FINANCIAL_OPERATION_CHANGE_STORES,
        affectedScopes: movementScopes(request.periodId, [declaredMovement]),
        metadata: {
          periodId: request.periodId,
          operationId: request.operationId,
          accountId: request.accountId,
          changedFields,
        },
        execute: async (transaction, context) => {
          const period = requireActiveOpenPeriod(
            await transaction.get('periods', request.periodId),
            context,
            request.periodId,
            'balance-adjustment.edit'
          );
          const storedOperation = await transaction.get('operations', request.operationId);
          if (storedOperation === undefined) {
            throw domainError(
              ERROR_CODES.DOMAIN_STATE_INVALID,
              'the requested Operation does not exist',
              { operationId: request.operationId }
            );
          }
          const previousOperation = Domain.validateOperation(storedOperation);
          if (previousOperation.periodId !== request.periodId) {
            throw domainError(
              ERROR_CODES.DOMAIN_RELATION_MISMATCH,
              'the Operation does not belong to the requested Period',
              {
                operationId: request.operationId,
                operationPeriodId: previousOperation.periodId,
                periodId: request.periodId,
              }
            );
          }
          if (previousOperation.status !== 'posted') {
            throw domainError(
              ERROR_CODES.DOMAIN_STATE_INVALID,
              'only a posted Operation can be edited',
              { operationId: request.operationId, status: previousOperation.status }
            );
          }
          assertExpectedRevision(previousOperation.revision, request.expectedOperationRevision, {
            entityType: 'Operation', entityId: request.operationId,
          });
          const allMovements = await transaction.getAll('movements');
          const previousMovement = requireSingleOperationMovement(request.operationId, allMovements);
          const previousDetails = validateBalanceAdjustmentOperation(
            previousOperation, previousMovement, request.accountId
          ).details;
          const nextDate = hasOwn(request, 'operationDate')
            ? request.operationDate
            : previousOperation.operationDate;
          const nextDelta = hasOwn(request, 'delta') ? request.delta : previousMovement.delta;
          const nextReason = hasOwn(request, 'reason') ? request.reason : previousDetails.reason;
          if (
            nextDate === previousOperation.operationDate &&
            nextDelta === previousMovement.delta &&
            nextReason === previousDetails.reason
          ) {
            throw domainError(
              ERROR_CODES.INVALID_DOMAIN_FIELD,
              'balance-adjustment.edit requires a real change',
              { operationId: request.operationId, changedFields }
            );
          }
          const nextOperation = Domain.validateOperation({
            ...previousOperation,
            operationDate: nextDate,
            amount: Math.abs(nextDelta),
            details: balanceAdjustmentDetails(request.accountId, nextReason),
            revision: nextRevision(previousOperation.revision),
            updatedAt: occurredAt,
          });
          const nextMovement = Domain.validateMovement({
            ...previousMovement,
            delta: nextDelta,
            updatedAt: occurredAt,
          });
          Domain.assertMovementMatchesOperation(nextOperation, nextMovement);
          Domain.assertOperationDateContext(nextOperation, period, currentCivilDate);
          const target = requireFinancialTarget(
            'account',
            await transaction.get('accounts', request.accountId),
            request.accountId,
            request.expectedAccountRevision
          );
          const account = simulateTargetChange(target, previousMovement.delta, nextDelta, {
            operationId: request.operationId,
            targetType: 'account',
            targetId: request.accountId,
            occurredAt,
            allowCurrentNegative: true,
          });
          const revision = Domain.validateOperationRevision({
            id: revisionId,
            operationId: request.operationId,
            periodId: request.periodId,
            revisionNumber: previousOperation.revision,
            changeType: 'edit',
            previousOperation,
            previousMovements: [previousMovement],
            reason: null,
            createdAt: occurredAt,
          });
          const existingRevisions = await transaction.getAll('operationRevisions');
          assertLogicalRevisionAvailable(existingRevisions, revision);
          if (await transaction.get('operationRevisions', revision.id) !== undefined) {
            throw domainError(
              ERROR_CODES.DUPLICATE_OPERATION_REVISION,
              'the generated OperationRevision ID already exists',
              { revisionId: revision.id }
            );
          }
          if (account !== target.entity) await transaction.put('accounts', account);
          await transaction.put('operations', nextOperation);
          await transaction.put('movements', nextMovement);
          await transaction.add('operationRevisions', revision);
          return Object.freeze({
            operation: nextOperation,
            movement: nextMovement,
            account,
            operationRevision: revision,
          });
        },
      });
    }

    async function voidOperation(input) {
      const request = requireRecord(input, 'operation.void');
      const required = [
        'expectedDataRevision', 'expectedWriterEpoch', 'periodId',
        'accountId', 'expectedAccountRevision', 'operationId', 'expectedOperationRevision',
      ];
      const allowed = [...required, 'reason'];
      validateCommandHeader(request, 'operation.void', required, allowed);
      assertUuid(request.accountId, { field: 'accountId' });
      assertUuid(request.operationId, { field: 'operationId' });
      assertRevision(request.expectedAccountRevision, { field: 'expectedAccountRevision' });
      assertRevision(request.expectedOperationRevision, { field: 'expectedOperationRevision' });
      const reason = hasOwn(request, 'reason')
        ? requireNonEmptyString(request.reason, 'reason')
        : null;
      const occurredAt = canonicalTimestamp(now);
      const currentCivilDate = currentCivilDateFromTimestamp(occurredAt);
      const revisionId = createIdentifier(createUuid, 'operationRevision.id', new Set());
      const declaredMovement = { targetType: 'account', targetId: request.accountId };
      return runtime.executeCommand({
        commandType: 'operation.void',
        expectedDataRevision: request.expectedDataRevision,
        expectedWriterEpoch: request.expectedWriterEpoch,
        affectedStores: FINANCIAL_OPERATION_CHANGE_STORES,
        affectedScopes: movementScopes(request.periodId, [declaredMovement]),
        metadata: {
          periodId: request.periodId,
          operationId: request.operationId,
          accountId: request.accountId,
        },
        execute: async (transaction, context) => {
          const period = requireActiveOpenPeriod(
            await transaction.get('periods', request.periodId),
            context,
            request.periodId,
            'operation.void'
          );
          const storedOperation = await transaction.get('operations', request.operationId);
          if (storedOperation === undefined) {
            throw domainError(
              ERROR_CODES.DOMAIN_STATE_INVALID,
              'the requested Operation does not exist',
              { operationId: request.operationId }
            );
          }
          const previousOperation = Domain.validateOperation(storedOperation);
          if (
            previousOperation.periodId !== request.periodId ||
            previousOperation.type !== 'balance_adjustment'
          ) {
            throw domainError(
              ERROR_CODES.DOMAIN_RELATION_MISMATCH,
              'operation.void only supports a balance_adjustment in the requested Period',
              {
                operationId: request.operationId,
                operationType: previousOperation.type,
                operationPeriodId: previousOperation.periodId,
                periodId: request.periodId,
              }
            );
          }
          if (previousOperation.status !== 'posted') {
            throw domainError(
              ERROR_CODES.DOMAIN_STATE_INVALID,
              'only a posted Operation can be voided',
              { operationId: request.operationId, status: previousOperation.status }
            );
          }
          Domain.assertOperationDateContext(previousOperation, period, currentCivilDate);
          assertExpectedRevision(previousOperation.revision, request.expectedOperationRevision, {
            entityType: 'Operation', entityId: request.operationId,
          });
          const allMovements = await transaction.getAll('movements');
          const previousMovement = requireSingleOperationMovement(request.operationId, allMovements);
          validateBalanceAdjustmentOperation(previousOperation, previousMovement, request.accountId);
          const target = requireFinancialTarget(
            'account',
            await transaction.get('accounts', request.accountId),
            request.accountId,
            request.expectedAccountRevision
          );
          const account = simulateTargetChange(target, previousMovement.delta, null, {
            operationId: request.operationId,
            targetType: 'account',
            targetId: request.accountId,
            occurredAt,
            allowCurrentNegative: true,
          });
          const nextOperation = Domain.validateOperation({
            ...previousOperation,
            status: 'voided',
            voidedAt: occurredAt,
            voidReason: reason,
            revision: nextRevision(previousOperation.revision),
            updatedAt: occurredAt,
          });
          const nextMovement = Domain.validateMovement({
            ...previousMovement,
            status: 'voided',
            updatedAt: occurredAt,
          });
          Domain.assertMovementMatchesOperation(nextOperation, nextMovement);
          const revision = Domain.validateOperationRevision({
            id: revisionId,
            operationId: request.operationId,
            periodId: request.periodId,
            revisionNumber: previousOperation.revision,
            changeType: 'void',
            previousOperation,
            previousMovements: [previousMovement],
            reason,
            createdAt: occurredAt,
          });
          const existingRevisions = await transaction.getAll('operationRevisions');
          assertLogicalRevisionAvailable(existingRevisions, revision);
          if (await transaction.get('operationRevisions', revision.id) !== undefined) {
            throw domainError(
              ERROR_CODES.DUPLICATE_OPERATION_REVISION,
              'the generated OperationRevision ID already exists',
              { revisionId: revision.id }
            );
          }
          if (account !== target.entity) await transaction.put('accounts', account);
          await transaction.put('operations', nextOperation);
          await transaction.put('movements', nextMovement);
          await transaction.add('operationRevisions', revision);
          return Object.freeze({
            operation: nextOperation,
            movement: nextMovement,
            account,
            operationRevision: revision,
          });
        },
      });
    }

    function validateSalaryDetails(operation) {
      const details = operationDetails(operation, ['accountId']);
      assertUuid(details.accountId, { field: 'Operation.details.accountId' });
      return details;
    }

    function validateAdditionalIncomeDetails(operation) {
      const details = operationDetails(operation, ['accountId', 'concept', 'observation']);
      assertUuid(details.accountId, { field: 'Operation.details.accountId' });
      nullableNonEmptyString(details.concept, 'Operation.details.concept');
      nullableNonEmptyString(details.observation, 'Operation.details.observation');
      return details;
    }

    function validateVariableExpenseDetails(operation) {
      const details = operationDetails(operation, [
        'accountId', 'categoryId', 'categoryName', 'concept', 'observation',
      ]);
      assertUuid(details.accountId, { field: 'Operation.details.accountId' });
      assertUuid(details.categoryId, { field: 'Operation.details.categoryId' });
      requireNonEmptyString(details.categoryName, 'Operation.details.categoryName');
      requireNonEmptyString(details.concept, 'Operation.details.concept');
      nullableNonEmptyString(details.observation, 'Operation.details.observation');
      return details;
    }

    function validateFixedExpensePaymentDetails(operation) {
      const details = operationDetails(operation, ['accountId', 'fixedExpenseInstanceId']);
      assertUuid(details.accountId, { field: 'Operation.details.accountId' });
      assertUuid(details.fixedExpenseInstanceId, {
        field: 'Operation.details.fixedExpenseInstanceId',
      });
      return details;
    }

    function validateAccountCreateRequest(input, commandType, additionalRequired, additionalAllowed) {
      const request = requireRecord(input, commandType);
      const required = [
        'expectedDataRevision', 'expectedWriterEpoch', 'periodId',
        'accountId', 'expectedAccountRevision', 'operationDate', 'amount',
        ...(additionalRequired || []),
      ];
      validateCommandHeader(request, commandType, required, [
        ...required, ...(additionalAllowed || []),
      ]);
      assertUuid(request.accountId, { field: 'accountId' });
      assertRevision(request.expectedAccountRevision, { field: 'expectedAccountRevision' });
      assertCivilDate(request.operationDate, { field: 'operationDate' });
      assertPositiveMoney(request.amount, { field: 'amount' });
      return request;
    }

    function validateAccountEditRequest(input, commandType, additionalRequired, editableFields) {
      const request = requireRecord(input, commandType);
      const required = [
        'expectedDataRevision', 'expectedWriterEpoch', 'periodId',
        'operationId', 'expectedOperationRevision',
        'previousAccountId', 'expectedPreviousAccountRevision',
        'accountId', 'expectedAccountRevision',
        ...(additionalRequired || []),
      ];
      validateCommandHeader(request, commandType, required, [...required, ...editableFields]);
      for (const field of ['operationId', 'previousAccountId', 'accountId']) {
        assertUuid(request[field], { field });
      }
      for (const field of [
        'expectedOperationRevision', 'expectedPreviousAccountRevision', 'expectedAccountRevision',
      ]) {
        assertRevision(request[field], { field });
      }
      if (hasOwn(request, 'operationDate')) {
        assertCivilDate(request.operationDate, { field: 'operationDate' });
      }
      if (hasOwn(request, 'amount')) assertPositiveMoney(request.amount, { field: 'amount' });
      return request;
    }

    function validateAccountVoidRequest(input, commandType, additionalRequired) {
      const request = requireRecord(input, commandType);
      const required = [
        'expectedDataRevision', 'expectedWriterEpoch', 'periodId',
        'operationId', 'expectedOperationRevision', 'accountId', 'expectedAccountRevision',
        ...(additionalRequired || []),
      ];
      validateCommandHeader(request, commandType, required, [...required, 'reason']);
      assertUuid(request.operationId, { field: 'operationId' });
      assertUuid(request.accountId, { field: 'accountId' });
      assertRevision(request.expectedOperationRevision, { field: 'expectedOperationRevision' });
      assertRevision(request.expectedAccountRevision, { field: 'expectedAccountRevision' });
      if (hasOwn(request, 'reason')) requireNonEmptyString(request.reason, 'reason');
      return request;
    }

    async function createSalaryReceipt(input) {
      const request = validateAccountCreateRequest(input, 'salary-receipt.create');
      return executeAccountOperationCreate({
        request,
        commandType: 'salary-receipt.create',
        operationType: 'salary_receipt',
        stores: ACCOUNT_OPERATION_CREATE_STORES,
        details: Object.freeze({ accountId: request.accountId }),
        relatedReads: [{ key: 'operations', storeName: 'operations', all: true }],
        prepareRelated: (context) => {
          const duplicate = context.relatedData.operations.some((operation) => (
            operation.periodId === request.periodId &&
            operation.type === 'salary_receipt' &&
            operation.status === 'posted'
          ));
          if (duplicate) {
            throw domainError(
              ERROR_CODES.DOMAIN_STATE_INVALID,
              'only one posted salary receipt is allowed per Period',
              { periodId: request.periodId }
            );
          }
          return Object.freeze({ writes: [], result: {} });
        },
      });
    }

    async function editSalaryReceipt(input) {
      const request = validateAccountEditRequest(
        input, 'salary-receipt.edit', [], ['operationDate', 'amount']
      );
      return executeAccountOperationEdit({
        request,
        commandType: 'salary-receipt.edit',
        operationType: 'salary_receipt',
        stores: ACCOUNT_OPERATION_CHANGE_STORES,
        validateDetails: validateSalaryDetails,
        relatedReads: [{ key: 'operations', storeName: 'operations', all: true }],
        prepareRelated: (context) => {
          const duplicate = context.relatedData.operations.some((operation) => (
            operation.id !== request.operationId &&
            operation.periodId === request.periodId &&
            operation.type === 'salary_receipt' &&
            operation.status === 'posted'
          ));
          if (duplicate) {
            throw domainError(
              ERROR_CODES.DOMAIN_STATE_INVALID,
              'only one posted salary receipt is allowed per Period',
              { periodId: request.periodId }
            );
          }
          return Object.freeze({
            details: Object.freeze({ accountId: request.accountId }),
            writes: [],
            result: {},
          });
        },
      });
    }

    async function voidSalaryReceipt(input) {
      const request = validateAccountVoidRequest(input, 'salary-receipt.void');
      return executeAccountOperationVoid({
        request,
        commandType: 'salary-receipt.void',
        operationType: 'salary_receipt',
        stores: ACCOUNT_OPERATION_CHANGE_STORES,
        validateDetails: validateSalaryDetails,
      });
    }

    async function createAdditionalIncome(input) {
      const request = validateAccountCreateRequest(
        input, 'additional-income.create', [], ['concept', 'observation']
      );
      const concept = hasOwn(request, 'concept')
        ? nullableNonEmptyString(request.concept, 'concept')
        : null;
      const observation = hasOwn(request, 'observation')
        ? nullableNonEmptyString(request.observation, 'observation')
        : null;
      return executeAccountOperationCreate({
        request,
        commandType: 'additional-income.create',
        operationType: 'additional_income',
        stores: ACCOUNT_OPERATION_CREATE_STORES,
        details: Object.freeze({ accountId: request.accountId, concept, observation }),
      });
    }

    async function editAdditionalIncome(input) {
      const request = validateAccountEditRequest(
        input,
        'additional-income.edit',
        [],
        ['operationDate', 'amount', 'concept', 'observation']
      );
      if (hasOwn(request, 'concept')) nullableNonEmptyString(request.concept, 'concept');
      if (hasOwn(request, 'observation')) nullableNonEmptyString(request.observation, 'observation');
      return executeAccountOperationEdit({
        request,
        commandType: 'additional-income.edit',
        operationType: 'additional_income',
        stores: ACCOUNT_OPERATION_CHANGE_STORES,
        validateDetails: validateAdditionalIncomeDetails,
        prepareRelated: (context) => Object.freeze({
          details: Object.freeze({
            accountId: request.accountId,
            concept: hasOwn(request, 'concept') ? request.concept : context.previousDetails.concept,
            observation: hasOwn(request, 'observation')
              ? request.observation
              : context.previousDetails.observation,
          }),
          writes: [],
          result: {},
        }),
      });
    }

    async function voidAdditionalIncome(input) {
      const request = validateAccountVoidRequest(input, 'additional-income.void');
      return executeAccountOperationVoid({
        request,
        commandType: 'additional-income.void',
        operationType: 'additional_income',
        stores: ACCOUNT_OPERATION_CHANGE_STORES,
        validateDetails: validateAdditionalIncomeDetails,
      });
    }

    function requireCategoryForVariableExpense(stored, categoryId, expectedRevision, allowInactive) {
      if (stored === undefined) {
        throw domainError(
          ERROR_CODES.DOMAIN_STATE_INVALID,
          'the requested Category does not exist',
          { categoryId }
        );
      }
      const category = Domain.validateCategory(stored);
      assertExpectedRevision(category.revision, expectedRevision, {
        entityType: 'Category', entityId: categoryId,
      });
      if (!allowInactive && category.status !== 'active') {
        throw domainError(
          ERROR_CODES.DOMAIN_STATE_INVALID,
          'a new variable expense requires an active Category',
          { categoryId, status: category.status }
        );
      }
      return category;
    }

    async function createVariableExpense(input) {
      const request = validateAccountCreateRequest(
        input,
        'variable-expense.create',
        ['categoryId', 'expectedCategoryRevision', 'concept'],
        ['observation']
      );
      assertUuid(request.categoryId, { field: 'categoryId' });
      assertRevision(request.expectedCategoryRevision, { field: 'expectedCategoryRevision' });
      requireNonEmptyString(request.concept, 'concept');
      const observation = hasOwn(request, 'observation')
        ? nullableNonEmptyString(request.observation, 'observation')
        : null;
      return executeAccountOperationCreate({
        request,
        commandType: 'variable-expense.create',
        operationType: 'variable_expense',
        stores: VARIABLE_EXPENSE_CREATE_STORES,
        relatedScopes: [Domain.domainScope('category', request.categoryId)],
        metadata: { categoryId: request.categoryId },
        details: Object.freeze({
          accountId: request.accountId,
          categoryId: request.categoryId,
          categoryName: '',
          concept: request.concept,
          observation,
        }),
        relatedReads: [{
          key: 'category', storeName: 'categories', id: request.categoryId,
        }],
        prepareRelated: (context) => {
          const category = requireCategoryForVariableExpense(
            context.relatedData.category, request.categoryId, request.expectedCategoryRevision, false
          );
          return Object.freeze({
            details: Object.freeze({
              ...context.operation.details,
              categoryName: category.name,
            }),
            writes: [],
            result: { category },
          });
        },
      });
    }

    async function editVariableExpense(input) {
      const request = validateAccountEditRequest(
        input,
        'variable-expense.edit',
        ['previousCategoryId', 'categoryId', 'expectedCategoryRevision'],
        ['operationDate', 'amount', 'concept', 'observation']
      );
      assertUuid(request.previousCategoryId, { field: 'previousCategoryId' });
      assertUuid(request.categoryId, { field: 'categoryId' });
      assertRevision(request.expectedCategoryRevision, { field: 'expectedCategoryRevision' });
      if (hasOwn(request, 'concept')) requireNonEmptyString(request.concept, 'concept');
      if (hasOwn(request, 'observation')) nullableNonEmptyString(request.observation, 'observation');
      return executeAccountOperationEdit({
        request,
        commandType: 'variable-expense.edit',
        operationType: 'variable_expense',
        stores: VARIABLE_EXPENSE_CHANGE_STORES,
        relatedScopes: [
          Domain.domainScope('category', request.previousCategoryId),
          Domain.domainScope('category', request.categoryId),
        ],
        metadata: {
          previousCategoryId: request.previousCategoryId,
          categoryId: request.categoryId,
        },
        validateDetails: validateVariableExpenseDetails,
        relatedReads: [{
          key: 'category', storeName: 'categories', id: request.categoryId,
        }],
        prepareRelated: (context) => {
          if (context.previousDetails.categoryId !== request.previousCategoryId) {
            throw domainError(
              ERROR_CODES.DOMAIN_RELATION_MISMATCH,
              'previousCategoryId does not match the historical Operation',
              { operationId: request.operationId, previousCategoryId: request.previousCategoryId }
            );
          }
          const category = requireCategoryForVariableExpense(
            context.relatedData.category,
            request.categoryId,
            request.expectedCategoryRevision,
            request.categoryId === request.previousCategoryId
          );
          return Object.freeze({
            details: Object.freeze({
              accountId: request.accountId,
              categoryId: request.categoryId,
              categoryName: request.categoryId === request.previousCategoryId
                ? context.previousDetails.categoryName
                : category.name,
              concept: hasOwn(request, 'concept')
                ? request.concept
                : context.previousDetails.concept,
              observation: hasOwn(request, 'observation')
                ? request.observation
                : context.previousDetails.observation,
            }),
            writes: [],
            result: { category },
          });
        },
      });
    }

    async function voidVariableExpense(input) {
      const request = validateAccountVoidRequest(
        input, 'variable-expense.void', ['categoryId']
      );
      assertUuid(request.categoryId, { field: 'categoryId' });
      return executeAccountOperationVoid({
        request,
        commandType: 'variable-expense.void',
        operationType: 'variable_expense',
        stores: VARIABLE_EXPENSE_CHANGE_STORES,
        relatedScopes: [Domain.domainScope('category', request.categoryId)],
        metadata: { categoryId: request.categoryId },
        validateDetails: validateVariableExpenseDetails,
        relatedReads: [{
          key: 'category', storeName: 'categories', id: request.categoryId,
        }],
        prepareRelated: (context) => {
          if (context.previousDetails.categoryId !== request.categoryId) {
            throw domainError(
              ERROR_CODES.DOMAIN_RELATION_MISMATCH,
              'categoryId does not match the historical Operation',
              { operationId: request.operationId, categoryId: request.categoryId }
            );
          }
          const stored = context.relatedData.category;
          if (stored !== undefined) Domain.validateCategory(stored);
          return Object.freeze({ writes: [], result: {} });
        },
      });
    }

    function requireFixedExpenseInstance(stored, request, operationId, state) {
      if (stored === undefined) {
        throw domainError(
          ERROR_CODES.DOMAIN_STATE_INVALID,
          'the requested FixedExpenseInstance does not exist',
          { fixedExpenseInstanceId: request.fixedExpenseInstanceId }
        );
      }
      const instance = Domain.validateFixedExpenseInstance(stored);
      assertExpectedRevision(instance.revision, request.expectedInstanceRevision, {
        entityType: 'FixedExpenseInstance', entityId: instance.id,
      });
      if (instance.periodId !== request.periodId) {
        throw domainError(
          ERROR_CODES.DOMAIN_RELATION_MISMATCH,
          'FixedExpenseInstance does not belong to the active Period',
          { instanceId: instance.id, instancePeriodId: instance.periodId, periodId: request.periodId }
        );
      }
      if (state === 'pending' && (instance.status !== 'pending' || instance.activePaymentOperationId !== null)) {
        throw domainError(
          ERROR_CODES.DOMAIN_STATE_INVALID,
          'only a pending FixedExpenseInstance can be paid',
          { instanceId: instance.id, status: instance.status }
        );
      }
      if (state === 'paid' && (
        instance.status !== 'paid' || instance.activePaymentOperationId !== operationId
      )) {
        throw domainError(
          ERROR_CODES.DOMAIN_STATE_INVALID,
          'FixedExpenseInstance is not linked to the requested posted payment',
          {
            instanceId: instance.id,
            status: instance.status,
            activePaymentOperationId: instance.activePaymentOperationId,
            operationId,
          }
        );
      }
      return instance;
    }

    async function createFixedExpensePayment(input) {
      const request = validateAccountCreateRequest(
        input,
        'fixed-expense-payment.create',
        ['fixedExpenseInstanceId', 'expectedInstanceRevision']
      );
      assertUuid(request.fixedExpenseInstanceId, { field: 'fixedExpenseInstanceId' });
      assertRevision(request.expectedInstanceRevision, { field: 'expectedInstanceRevision' });
      return executeAccountOperationCreate({
        request,
        commandType: 'fixed-expense-payment.create',
        operationType: 'fixed_expense_payment',
        stores: FIXED_EXPENSE_PAYMENT_CREATE_STORES,
        relatedScopes: [Domain.domainScope('fixed_expense_instance', request.fixedExpenseInstanceId)],
        metadata: { fixedExpenseInstanceId: request.fixedExpenseInstanceId },
        details: Object.freeze({
          accountId: request.accountId,
          fixedExpenseInstanceId: request.fixedExpenseInstanceId,
        }),
        relatedReads: [
          { key: 'instance', storeName: 'fixedExpenseInstances', id: request.fixedExpenseInstanceId },
          { key: 'operations', storeName: 'operations', all: true },
        ],
        prepareRelated: (context) => {
          const instance = requireFixedExpenseInstance(
            context.relatedData.instance, request, context.operation.id, 'pending'
          );
          const duplicate = context.relatedData.operations.some((operation) => (
            operation.type === 'fixed_expense_payment' &&
            operation.status === 'posted' &&
            operation.details &&
            operation.details.fixedExpenseInstanceId === request.fixedExpenseInstanceId
          ));
          if (duplicate) {
            throw domainError(
              ERROR_CODES.DOMAIN_STATE_INVALID,
              'only one posted payment is allowed per FixedExpenseInstance',
              { fixedExpenseInstanceId: request.fixedExpenseInstanceId }
            );
          }
          const nextInstance = Domain.validateFixedExpenseInstance({
            ...instance,
            status: 'paid',
            activePaymentOperationId: context.operation.id,
            revision: nextRevision(instance.revision),
            updatedAt: context.occurredAt,
          });
          return Object.freeze({
            writes: [{ storeName: 'fixedExpenseInstances', value: nextInstance }],
            result: { fixedExpenseInstance: nextInstance },
          });
        },
      });
    }

    async function editFixedExpensePayment(input) {
      const request = validateAccountEditRequest(
        input,
        'fixed-expense-payment.edit',
        ['fixedExpenseInstanceId', 'expectedInstanceRevision'],
        ['operationDate', 'amount']
      );
      assertUuid(request.fixedExpenseInstanceId, { field: 'fixedExpenseInstanceId' });
      assertRevision(request.expectedInstanceRevision, { field: 'expectedInstanceRevision' });
      return executeAccountOperationEdit({
        request,
        commandType: 'fixed-expense-payment.edit',
        operationType: 'fixed_expense_payment',
        stores: FIXED_EXPENSE_PAYMENT_CHANGE_STORES,
        relatedScopes: [Domain.domainScope('fixed_expense_instance', request.fixedExpenseInstanceId)],
        metadata: { fixedExpenseInstanceId: request.fixedExpenseInstanceId },
        validateDetails: validateFixedExpensePaymentDetails,
        relatedReads: [{
          key: 'instance', storeName: 'fixedExpenseInstances', id: request.fixedExpenseInstanceId,
        }],
        prepareRelated: (context) => {
          if (context.previousDetails.fixedExpenseInstanceId !== request.fixedExpenseInstanceId) {
            throw domainError(
              ERROR_CODES.DOMAIN_RELATION_MISMATCH,
              'FixedExpenseInstance link cannot be changed while editing its payment',
              { operationId: request.operationId, fixedExpenseInstanceId: request.fixedExpenseInstanceId }
            );
          }
          const instance = requireFixedExpenseInstance(
            context.relatedData.instance, request, request.operationId, 'paid'
          );
          return Object.freeze({
            details: Object.freeze({
              accountId: request.accountId,
              fixedExpenseInstanceId: request.fixedExpenseInstanceId,
            }),
            writes: [],
            result: { fixedExpenseInstance: instance },
          });
        },
      });
    }

    async function voidFixedExpensePayment(input) {
      const request = validateAccountVoidRequest(
        input,
        'fixed-expense-payment.void',
        ['fixedExpenseInstanceId', 'expectedInstanceRevision']
      );
      assertUuid(request.fixedExpenseInstanceId, { field: 'fixedExpenseInstanceId' });
      assertRevision(request.expectedInstanceRevision, { field: 'expectedInstanceRevision' });
      return executeAccountOperationVoid({
        request,
        commandType: 'fixed-expense-payment.void',
        operationType: 'fixed_expense_payment',
        stores: FIXED_EXPENSE_PAYMENT_CHANGE_STORES,
        relatedScopes: [Domain.domainScope('fixed_expense_instance', request.fixedExpenseInstanceId)],
        metadata: { fixedExpenseInstanceId: request.fixedExpenseInstanceId },
        validateDetails: validateFixedExpensePaymentDetails,
        relatedReads: [{
          key: 'instance', storeName: 'fixedExpenseInstances', id: request.fixedExpenseInstanceId,
        }],
        prepareRelated: (context) => {
          if (context.previousDetails.fixedExpenseInstanceId !== request.fixedExpenseInstanceId) {
            throw domainError(
              ERROR_CODES.DOMAIN_RELATION_MISMATCH,
              'FixedExpenseInstance does not match the historical payment',
              { operationId: request.operationId, fixedExpenseInstanceId: request.fixedExpenseInstanceId }
            );
          }
          const instance = requireFixedExpenseInstance(
            context.relatedData.instance, request, request.operationId, 'paid'
          );
          const nextInstance = Domain.validateFixedExpenseInstance({
            ...instance,
            status: 'pending',
            activePaymentOperationId: null,
            revision: nextRevision(instance.revision),
            updatedAt: context.occurredAt,
          });
          return Object.freeze({
            writes: [{ storeName: 'fixedExpenseInstances', value: nextInstance }],
            result: { fixedExpenseInstance: nextInstance },
          });
        },
      });
    }

    function simulateDeclaredTargets(
      targets, previousMovements, nextMovements, occurredAt, currentCivilDate, operationId
    ) {
      const previousDeltas = sumMovementDeltas(previousMovements || []);
      const nextDeltas = sumMovementDeltas(nextMovements || []);
      const updates = new Map();
      for (const [key, target] of targets) {
        const previousDelta = previousDeltas.has(key) ? previousDeltas.get(key) : null;
        const nextDelta = nextDeltas.has(key) ? nextDeltas.get(key) : null;
        if (previousDelta === null && nextDelta === null) continue;
        const entity = simulateTargetChange(target, previousDelta, nextDelta, {
          operationId,
          targetType: target.targetType,
          targetId: target.entity.id,
          occurredAt,
          currentCivilDate,
          allowCurrentNegative: target.targetType === 'account',
        });
        if (entity !== target.entity) updates.set(key, entity);
      }
      return updates;
    }

    function createFinancialMovements(operation, specs, occurredAt, generatedIds) {
      return Object.freeze(specs.map((spec) => Domain.validateMovement({
        id: createIdentifier(createUuid, 'movement.id', generatedIds),
        operationId: operation.id,
        periodId: operation.periodId,
        targetType: spec.targetType,
        targetId: spec.targetId,
        effectType: spec.targetType === 'debt' ? 'debt_outstanding' : 'asset_balance',
        delta: spec.delta,
        status: operation.status,
        createdAt: occurredAt,
        updatedAt: occurredAt,
      })));
    }

    async function executeMultiTargetCreate(options) {
      const request = options.request;
      const occurredAt = canonicalTimestamp(now);
      const currentCivilDate = currentCivilDateFromTimestamp(occurredAt);
      const generatedIds = new Set();
      const operation = Domain.validateOperation({
        id: createIdentifier(createUuid, 'operation.id', generatedIds),
        periodId: request.periodId,
        type: options.operationType,
        operationDate: request.operationDate,
        amount: options.amount,
        status: 'posted',
        revision: 1,
        createdAt: occurredAt,
        updatedAt: occurredAt,
        voidedAt: null,
        voidReason: null,
        details: options.details,
      });
      const movements = createFinancialMovements(
        operation, options.movementSpecs, occurredAt, generatedIds
      );
      options.validateShape(operation, movements);
      const declarations = mergeTargetDeclarations(options.declarations);
      return runtime.executeCommand({
        commandType: options.commandType,
        expectedDataRevision: request.expectedDataRevision,
        expectedWriterEpoch: request.expectedWriterEpoch,
        affectedStores: multiTargetStores(false, declarations),
        affectedScopes: multiTargetScopes(request.periodId, declarations),
        metadata: {
          periodId: request.periodId,
          operationId: operation.id,
          ...(options.metadata || {}),
        },
        execute: async (transaction, context) => {
          const period = requireActiveOpenPeriod(
            await transaction.get('periods', request.periodId),
            context,
            request.periodId,
            options.commandType
          );
          Domain.assertOperationDateContext(operation, period, currentCivilDate);
          const targets = new Map();
          for (const declaration of declarations) {
            const target = requireFinancialTarget(
              declaration.targetType,
              await transaction.get(
                TARGET_STORE_NAMES[declaration.targetType], declaration.targetId
              ),
              declaration.targetId,
              declaration.expectedRevision,
              { allowInactive: !declaration.requireActive }
            );
            targets.set(
              financialTargetKey(declaration.targetType, declaration.targetId), target
            );
          }
          const updates = simulateDeclaredTargets(
            targets, [], movements, occurredAt, currentCivilDate, operation.id
          );
          if (await transaction.get('operations', operation.id) !== undefined) {
            throw domainError(
              ERROR_CODES.DOMAIN_RELATION_MISMATCH,
              'generated Operation ID must be unique',
              { operationId: operation.id }
            );
          }
          for (const movement of movements) {
            if (await transaction.get('movements', movement.id) !== undefined) {
              throw domainError(
                ERROR_CODES.DOMAIN_RELATION_MISMATCH,
                'generated Movement IDs must be unique',
                { movementId: movement.id }
              );
            }
          }
          for (const [key, entity] of updates) {
            const targetType = key.slice(0, key.indexOf(':'));
            await transaction.put(TARGET_STORE_NAMES[targetType], entity);
          }
          await transaction.add('operations', operation);
          for (const movement of movements) await transaction.add('movements', movement);
          return Object.freeze({
            operation,
            movements,
            targets: Object.freeze(Object.fromEntries(updates)),
          });
        },
      });
    }

    async function executeMultiTargetEdit(options) {
      const request = options.request;
      const occurredAt = canonicalTimestamp(now);
      const currentCivilDate = currentCivilDateFromTimestamp(occurredAt);
      const revisionId = createIdentifier(createUuid, 'operationRevision.id', new Set());
      const declarations = mergeTargetDeclarations(options.declarations);
      return runtime.executeCommand({
        commandType: options.commandType,
        expectedDataRevision: request.expectedDataRevision,
        expectedWriterEpoch: request.expectedWriterEpoch,
        affectedStores: multiTargetStores(true, declarations),
        affectedScopes: multiTargetScopes(request.periodId, declarations),
        metadata: {
          periodId: request.periodId,
          operationId: request.operationId,
          ...(options.metadata || {}),
        },
        execute: async (transaction, context) => {
          const period = requireActiveOpenPeriod(
            await transaction.get('periods', request.periodId),
            context,
            request.periodId,
            options.commandType
          );
          const stored = await transaction.get('operations', request.operationId);
          if (stored === undefined) {
            throw domainError(
              ERROR_CODES.DOMAIN_STATE_INVALID,
              'the requested Operation does not exist',
              { operationId: request.operationId }
            );
          }
          const previousOperation = Domain.validateOperation(stored);
          if (
            previousOperation.periodId !== request.periodId ||
            previousOperation.type !== options.operationType ||
            previousOperation.status !== 'posted'
          ) {
            throw domainError(
              ERROR_CODES.DOMAIN_STATE_INVALID,
              'the requested posted Operation has an incompatible type or Period',
              {
                operationId: request.operationId,
                operationType: previousOperation.type,
                status: previousOperation.status,
              }
            );
          }
          assertExpectedRevision(previousOperation.revision, request.expectedOperationRevision, {
            entityType: 'Operation', entityId: request.operationId,
          });
          const related = (await transaction.getAll('movements'))
            .filter((movement) => movement.operationId === request.operationId);
          const previous = options.validatePrevious(previousOperation, related);
          const next = options.buildNext(previousOperation, previous.details);
          if (
            next.operationDate === previousOperation.operationDate &&
            next.amount === previousOperation.amount &&
            sameJsonValue(next.details, previous.details)
          ) {
            throw domainError(
              ERROR_CODES.INVALID_DOMAIN_FIELD,
              `${options.commandType} requires a real change`,
              { operationId: request.operationId }
            );
          }
          const nextOperation = Domain.validateOperation({
            ...previousOperation,
            operationDate: next.operationDate,
            amount: next.amount,
            details: next.details,
            revision: nextRevision(previousOperation.revision),
            updatedAt: occurredAt,
          });
          const nextMovements = Object.freeze(next.movementSpecs.map((spec, index) => (
            Domain.validateMovement({
              ...previous.orderedMovements[index],
              targetType: spec.targetType,
              targetId: spec.targetId,
              effectType: spec.targetType === 'debt' ? 'debt_outstanding' : 'asset_balance',
              delta: spec.delta,
              updatedAt: occurredAt,
            })
          )));
          options.validateShape(nextOperation, nextMovements);
          Domain.assertOperationDateContext(nextOperation, period, currentCivilDate);
          const targets = new Map();
          for (const declaration of declarations) {
            const target = requireFinancialTarget(
              declaration.targetType,
              await transaction.get(
                TARGET_STORE_NAMES[declaration.targetType], declaration.targetId
              ),
              declaration.targetId,
              declaration.expectedRevision,
              { allowInactive: !declaration.requireActive }
            );
            targets.set(
              financialTargetKey(declaration.targetType, declaration.targetId), target
            );
          }
          const updates = simulateDeclaredTargets(
            targets,
            previous.orderedMovements,
            nextMovements,
            occurredAt,
            currentCivilDate,
            request.operationId
          );
          const revision = Domain.validateOperationRevision({
            id: revisionId,
            operationId: request.operationId,
            periodId: request.periodId,
            revisionNumber: previousOperation.revision,
            changeType: 'edit',
            previousOperation,
            previousMovements: previous.orderedMovements,
            reason: null,
            createdAt: occurredAt,
          });
          assertLogicalRevisionAvailable(
            await transaction.getAll('operationRevisions'), revision
          );
          if (await transaction.get('operationRevisions', revision.id) !== undefined) {
            throw domainError(
              ERROR_CODES.DUPLICATE_OPERATION_REVISION,
              'the generated OperationRevision ID already exists',
              { revisionId: revision.id }
            );
          }
          for (const [key, entity] of updates) {
            const targetType = key.slice(0, key.indexOf(':'));
            await transaction.put(TARGET_STORE_NAMES[targetType], entity);
          }
          await transaction.put('operations', nextOperation);
          for (const movement of nextMovements) await transaction.put('movements', movement);
          await transaction.add('operationRevisions', revision);
          return Object.freeze({
            operation: nextOperation,
            movements: nextMovements,
            operationRevision: revision,
            targets: Object.freeze(Object.fromEntries(updates)),
          });
        },
      });
    }

    async function executeMultiTargetVoid(options) {
      const request = options.request;
      const occurredAt = canonicalTimestamp(now);
      const currentCivilDate = currentCivilDateFromTimestamp(occurredAt);
      const revisionId = createIdentifier(createUuid, 'operationRevision.id', new Set());
      const declarations = mergeTargetDeclarations(options.declarations);
      const reason = hasOwn(request, 'reason')
        ? requireNonEmptyString(request.reason, 'reason')
        : null;
      return runtime.executeCommand({
        commandType: options.commandType,
        expectedDataRevision: request.expectedDataRevision,
        expectedWriterEpoch: request.expectedWriterEpoch,
        affectedStores: multiTargetStores(true, declarations),
        affectedScopes: multiTargetScopes(request.periodId, declarations),
        metadata: {
          periodId: request.periodId,
          operationId: request.operationId,
          ...(options.metadata || {}),
        },
        execute: async (transaction, context) => {
          const period = requireActiveOpenPeriod(
            await transaction.get('periods', request.periodId),
            context,
            request.periodId,
            options.commandType
          );
          const stored = await transaction.get('operations', request.operationId);
          if (stored === undefined) {
            throw domainError(
              ERROR_CODES.DOMAIN_STATE_INVALID,
              'the requested Operation does not exist',
              { operationId: request.operationId }
            );
          }
          const previousOperation = Domain.validateOperation(stored);
          if (
            previousOperation.periodId !== request.periodId ||
            previousOperation.type !== options.operationType ||
            previousOperation.status !== 'posted'
          ) {
            throw domainError(
              ERROR_CODES.DOMAIN_STATE_INVALID,
              'the requested posted Operation has an incompatible type or Period',
              {
                operationId: request.operationId,
                operationType: previousOperation.type,
                status: previousOperation.status,
              }
            );
          }
          Domain.assertOperationDateContext(previousOperation, period, currentCivilDate);
          assertExpectedRevision(previousOperation.revision, request.expectedOperationRevision, {
            entityType: 'Operation', entityId: request.operationId,
          });
          const related = (await transaction.getAll('movements'))
            .filter((movement) => movement.operationId === request.operationId);
          const previous = options.validatePrevious(previousOperation, related);
          const targets = new Map();
          for (const declaration of declarations) {
            const target = requireFinancialTarget(
              declaration.targetType,
              await transaction.get(
                TARGET_STORE_NAMES[declaration.targetType], declaration.targetId
              ),
              declaration.targetId,
              declaration.expectedRevision,
              { allowInactive: !declaration.requireActive }
            );
            targets.set(
              financialTargetKey(declaration.targetType, declaration.targetId), target
            );
          }
          const updates = simulateDeclaredTargets(
            targets,
            previous.orderedMovements,
            [],
            occurredAt,
            currentCivilDate,
            request.operationId
          );
          const nextOperation = Domain.validateOperation({
            ...previousOperation,
            status: 'voided',
            voidedAt: occurredAt,
            voidReason: reason,
            revision: nextRevision(previousOperation.revision),
            updatedAt: occurredAt,
          });
          const nextMovements = Object.freeze(previous.orderedMovements.map((movement) => (
            Domain.validateMovement({
              ...movement,
              status: 'voided',
              updatedAt: occurredAt,
            })
          )));
          for (const movement of nextMovements) {
            Domain.assertMovementMatchesOperation(nextOperation, movement);
          }
          const revision = Domain.validateOperationRevision({
            id: revisionId,
            operationId: request.operationId,
            periodId: request.periodId,
            revisionNumber: previousOperation.revision,
            changeType: 'void',
            previousOperation,
            previousMovements: previous.orderedMovements,
            reason,
            createdAt: occurredAt,
          });
          assertLogicalRevisionAvailable(
            await transaction.getAll('operationRevisions'), revision
          );
          if (await transaction.get('operationRevisions', revision.id) !== undefined) {
            throw domainError(
              ERROR_CODES.DUPLICATE_OPERATION_REVISION,
              'the generated OperationRevision ID already exists',
              { revisionId: revision.id }
            );
          }
          for (const [key, entity] of updates) {
            const targetType = key.slice(0, key.indexOf(':'));
            await transaction.put(TARGET_STORE_NAMES[targetType], entity);
          }
          await transaction.put('operations', nextOperation);
          for (const movement of nextMovements) await transaction.put('movements', movement);
          await transaction.add('operationRevisions', revision);
          return Object.freeze({
            operation: nextOperation,
            movements: nextMovements,
            operationRevision: revision,
            targets: Object.freeze(Object.fromEntries(updates)),
          });
        },
      });
    }

    function validateDebtPaymentDetails(operation) {
      const details = operationDetails(operation, [
        'accountId', 'debtId', 'concept', 'observation',
      ]);
      assertUuid(details.accountId, { field: 'Operation.details.accountId' });
      assertUuid(details.debtId, { field: 'Operation.details.debtId' });
      nullableNonEmptyString(details.concept, 'Operation.details.concept');
      nullableNonEmptyString(details.observation, 'Operation.details.observation');
      return details;
    }

    function validateDebtPaymentShape(operation, movements) {
      const validOperation = Domain.validateOperation(operation);
      const details = validateDebtPaymentDetails(validOperation);
      if (validOperation.type !== 'debt_payment' || movements.length !== 2) {
        throw domainError(
          ERROR_CODES.DOMAIN_RELATION_MISMATCH,
          'debt payment requires exactly two Movements',
          { operationId: validOperation.id, movementCount: movements.length }
        );
      }
      const accountMovement = movements.find((movement) => movement.targetType === 'account');
      const debtMovement = movements.find((movement) => movement.targetType === 'debt');
      for (const movement of movements) {
        Domain.assertMovementMatchesOperation(validOperation, movement);
      }
      if (
        !accountMovement || !debtMovement ||
        accountMovement.targetId !== details.accountId ||
        debtMovement.targetId !== details.debtId ||
        accountMovement.delta !== -validOperation.amount ||
        debtMovement.delta !== -validOperation.amount
      ) {
        throw domainError(
          ERROR_CODES.DOMAIN_RELATION_MISMATCH,
          'debt payment Movements do not match their Account, Debt, and amount',
          { operationId: validOperation.id }
        );
      }
      return Object.freeze({
        details,
        orderedMovements: Object.freeze([accountMovement, debtMovement]),
      });
    }

    function debtPaymentCreateRequest(input) {
      const request = requireRecord(input, 'debt-payment.create');
      const required = [
        'expectedDataRevision', 'expectedWriterEpoch', 'periodId',
        'accountId', 'expectedAccountRevision', 'debtId', 'expectedDebtRevision',
        'operationDate', 'amount',
      ];
      validateCommandHeader(request, 'debt-payment.create', required, [
        ...required, 'concept', 'observation',
      ]);
      assertUuid(request.accountId, { field: 'accountId' });
      assertRevision(request.expectedAccountRevision, { field: 'expectedAccountRevision' });
      assertUuid(request.debtId, { field: 'debtId' });
      assertRevision(request.expectedDebtRevision, { field: 'expectedDebtRevision' });
      assertCivilDate(request.operationDate, { field: 'operationDate' });
      assertPositiveMoney(request.amount, { field: 'amount' });
      if (hasOwn(request, 'concept')) nullableNonEmptyString(request.concept, 'concept');
      if (hasOwn(request, 'observation')) nullableNonEmptyString(request.observation, 'observation');
      return request;
    }

    async function createDebtPayment(input) {
      const request = debtPaymentCreateRequest(input);
      const details = Object.freeze({
        accountId: request.accountId,
        debtId: request.debtId,
        concept: hasOwn(request, 'concept') ? request.concept : null,
        observation: hasOwn(request, 'observation') ? request.observation : null,
      });
      return executeMultiTargetCreate({
        request,
        commandType: 'debt-payment.create',
        operationType: 'debt_payment',
        amount: request.amount,
        details,
        movementSpecs: [
          { targetType: 'account', targetId: request.accountId, delta: -request.amount },
          { targetType: 'debt', targetId: request.debtId, delta: -request.amount },
        ],
        declarations: [
          {
            targetType: 'account', targetId: request.accountId,
            expectedRevision: request.expectedAccountRevision, requireActive: true,
          },
          {
            targetType: 'debt', targetId: request.debtId,
            expectedRevision: request.expectedDebtRevision, requireActive: true,
          },
        ],
        validateShape: validateDebtPaymentShape,
        metadata: { accountId: request.accountId, debtId: request.debtId },
      });
    }

    function debtPaymentEditRequest(input) {
      const request = requireRecord(input, 'debt-payment.edit');
      const required = [
        'expectedDataRevision', 'expectedWriterEpoch', 'periodId',
        'operationId', 'expectedOperationRevision',
        'previousAccountId', 'expectedPreviousAccountRevision',
        'accountId', 'expectedAccountRevision',
        'debtId', 'expectedDebtRevision',
      ];
      validateCommandHeader(request, 'debt-payment.edit', required, [
        ...required, 'operationDate', 'amount',
      ]);
      for (const field of ['operationId', 'previousAccountId', 'accountId', 'debtId']) {
        assertUuid(request[field], { field });
      }
      for (const field of [
        'expectedOperationRevision', 'expectedPreviousAccountRevision',
        'expectedAccountRevision', 'expectedDebtRevision',
      ]) {
        assertRevision(request[field], { field });
      }
      if (hasOwn(request, 'operationDate')) assertCivilDate(request.operationDate, { field: 'operationDate' });
      if (hasOwn(request, 'amount')) assertPositiveMoney(request.amount, { field: 'amount' });
      return request;
    }

    async function editDebtPayment(input) {
      const request = debtPaymentEditRequest(input);
      return executeMultiTargetEdit({
        request,
        commandType: 'debt-payment.edit',
        operationType: 'debt_payment',
        declarations: [
          {
            targetType: 'account', targetId: request.previousAccountId,
            expectedRevision: request.expectedPreviousAccountRevision, requireActive: false,
          },
          {
            targetType: 'account', targetId: request.accountId,
            expectedRevision: request.expectedAccountRevision, requireActive: true,
          },
          {
            targetType: 'debt', targetId: request.debtId,
            expectedRevision: request.expectedDebtRevision, requireActive: true,
          },
        ],
        validatePrevious: (operation, movements) => {
          const previous = validateDebtPaymentShape(operation, movements);
          if (
            previous.details.accountId !== request.previousAccountId ||
            previous.details.debtId !== request.debtId
          ) {
            throw domainError(
              ERROR_CODES.DOMAIN_RELATION_MISMATCH,
              'declared previous Account or Debt does not match the payment',
              { operationId: request.operationId }
            );
          }
          return previous;
        },
        buildNext: (operation, details) => {
          const amount = hasOwn(request, 'amount') ? request.amount : operation.amount;
          return Object.freeze({
            operationDate: hasOwn(request, 'operationDate')
              ? request.operationDate
              : operation.operationDate,
            amount,
            details: Object.freeze({ ...details, accountId: request.accountId }),
            movementSpecs: [
              { targetType: 'account', targetId: request.accountId, delta: -amount },
              { targetType: 'debt', targetId: request.debtId, delta: -amount },
            ],
          });
        },
        validateShape: validateDebtPaymentShape,
        metadata: {
          previousAccountId: request.previousAccountId,
          accountId: request.accountId,
          debtId: request.debtId,
        },
      });
    }

    function debtPaymentVoidRequest(input) {
      const request = requireRecord(input, 'debt-payment.void');
      const required = [
        'expectedDataRevision', 'expectedWriterEpoch', 'periodId',
        'operationId', 'expectedOperationRevision',
        'accountId', 'expectedAccountRevision', 'debtId', 'expectedDebtRevision',
      ];
      validateCommandHeader(request, 'debt-payment.void', required, [...required, 'reason']);
      for (const field of ['operationId', 'accountId', 'debtId']) assertUuid(request[field], { field });
      for (const field of [
        'expectedOperationRevision', 'expectedAccountRevision', 'expectedDebtRevision',
      ]) assertRevision(request[field], { field });
      if (hasOwn(request, 'reason')) requireNonEmptyString(request.reason, 'reason');
      return request;
    }

    async function voidDebtPayment(input) {
      const request = debtPaymentVoidRequest(input);
      return executeMultiTargetVoid({
        request,
        commandType: 'debt-payment.void',
        operationType: 'debt_payment',
        declarations: [
          {
            targetType: 'account', targetId: request.accountId,
            expectedRevision: request.expectedAccountRevision, requireActive: false,
          },
          {
            targetType: 'debt', targetId: request.debtId,
            expectedRevision: request.expectedDebtRevision, requireActive: false,
          },
        ],
        validatePrevious: (operation, movements) => {
          const previous = validateDebtPaymentShape(operation, movements);
          if (
            previous.details.accountId !== request.accountId ||
            previous.details.debtId !== request.debtId
          ) {
            throw domainError(
              ERROR_CODES.DOMAIN_RELATION_MISMATCH,
              'declared Account or Debt does not match the payment',
              { operationId: request.operationId }
            );
          }
          return previous;
        },
        metadata: { accountId: request.accountId, debtId: request.debtId },
      });
    }

    async function createDebtTotalAdjustment(input) {
      const request = requireRecord(input, 'debt-total-adjustment.create');
      const fields = [
        'expectedDataRevision', 'expectedWriterEpoch', 'periodId',
        'debtId', 'expectedDebtRevision', 'operationDate', 'newTotalAmount',
      ];
      validateCommandHeader(request, 'debt-total-adjustment.create', fields);
      assertUuid(request.debtId, { field: 'debtId' });
      assertRevision(request.expectedDebtRevision, { field: 'expectedDebtRevision' });
      assertCivilDate(request.operationDate, { field: 'operationDate' });
      assertPositiveMoney(request.newTotalAmount, { field: 'newTotalAmount' });
      const occurredAt = canonicalTimestamp(now);
      const currentCivilDate = currentCivilDateFromTimestamp(occurredAt);
      const generatedIds = new Set();
      const operationId = createIdentifier(createUuid, 'operation.id', generatedIds);
      const movementId = createIdentifier(createUuid, 'movement.id', generatedIds);
      const declarations = [{
        targetType: 'debt', targetId: request.debtId,
        expectedRevision: request.expectedDebtRevision, requireActive: true,
      }];
      return runtime.executeCommand({
        commandType: 'debt-total-adjustment.create',
        expectedDataRevision: request.expectedDataRevision,
        expectedWriterEpoch: request.expectedWriterEpoch,
        affectedStores: Object.freeze([
          'periods', 'debts', 'operations', 'movements',
        ]),
        affectedScopes: multiTargetScopes(request.periodId, declarations),
        metadata: { periodId: request.periodId, operationId, debtId: request.debtId },
        execute: async (transaction, context) => {
          const period = requireActiveOpenPeriod(
            await transaction.get('periods', request.periodId),
            context,
            request.periodId,
            'debt-total-adjustment.create'
          );
          const target = requireFinancialTarget(
            'debt',
            await transaction.get('debts', request.debtId),
            request.debtId,
            request.expectedDebtRevision
          );
          const debt = target.entity;
          if (debt.paymentStatus === 'paid') {
            throw domainError(
              ERROR_CODES.DOMAIN_STATE_INVALID,
              'a paid Debt is read-only',
              { debtId: request.debtId }
            );
          }
          let validPostedPaymentsTotal = 0;
          const allMovements = await transaction.getAll('movements');
          for (const storedOperation of await transaction.getAll('operations')) {
            if (storedOperation.type !== 'debt_payment' || storedOperation.status !== 'posted') continue;
            const validOperation = Domain.validateOperation(storedOperation);
            const details = validateDebtPaymentDetails(validOperation);
            if (details.debtId !== request.debtId) continue;
            validateDebtPaymentShape(
              validOperation,
              allMovements.filter((movement) => movement.operationId === validOperation.id)
            );
            validPostedPaymentsTotal += validOperation.amount;
            if (!Number.isSafeInteger(validPostedPaymentsTotal)) {
              throw domainError(
                ERROR_CODES.DEBT_ADJUSTMENT_INVALID,
                'posted Debt payments total must remain a safe CLP integer',
                { debtId: request.debtId }
              );
            }
          }
          if (request.newTotalAmount < validPostedPaymentsTotal) {
            throw domainError(
              ERROR_CODES.DEBT_ADJUSTMENT_INVALID,
              'new Debt total cannot be lower than valid posted payments',
              {
                debtId: request.debtId,
                newTotalAmount: request.newTotalAmount,
                validPostedPaymentsTotal,
              }
            );
          }
          const newOutstandingAmount = request.newTotalAmount - validPostedPaymentsTotal;
          const delta = newOutstandingAmount - debt.outstandingAmount;
          if (delta === 0) {
            throw domainError(
              ERROR_CODES.DEBT_ADJUSTMENT_INVALID,
              'debt-total-adjustment.create requires a real outstanding change',
              { debtId: request.debtId, newTotalAmount: request.newTotalAmount }
            );
          }
          const operation = Domain.validateOperation({
            id: operationId,
            periodId: request.periodId,
            type: 'debt_total_adjustment',
            operationDate: request.operationDate,
            amount: Math.abs(delta),
            status: 'posted',
            revision: 1,
            createdAt: occurredAt,
            updatedAt: occurredAt,
            voidedAt: null,
            voidReason: null,
            details: Object.freeze({
              debtId: request.debtId,
              previousTotalAmount: debt.totalAmount,
              newTotalAmount: request.newTotalAmount,
              previousOutstandingAmount: debt.outstandingAmount,
              newOutstandingAmount,
              validPostedPaymentsTotal,
            }),
          });
          const movement = Domain.validateMovement({
            id: movementId,
            operationId,
            periodId: request.periodId,
            targetType: 'debt',
            targetId: request.debtId,
            effectType: 'debt_outstanding',
            delta,
            status: 'posted',
            createdAt: occurredAt,
            updatedAt: occurredAt,
          });
          Domain.assertDebtTotalAdjustment({
            operation,
            movements: [movement],
            period,
            currentCivilDate,
            previousOutstandingAmount: debt.outstandingAmount,
            newOutstandingAmount,
          });
          const nextDebt = Domain.validateDebt({
            ...debt,
            totalAmount: request.newTotalAmount,
            outstandingAmount: newOutstandingAmount,
            paymentStatus: newOutstandingAmount === 0
              ? 'paid'
              : debt.dueDate !== null && debt.dueDate < currentCivilDate
                ? 'overdue'
                : 'active',
            revision: nextRevision(debt.revision),
            updatedAt: occurredAt,
          });
          if (
            await transaction.get('operations', operationId) !== undefined ||
            await transaction.get('movements', movementId) !== undefined
          ) {
            throw domainError(
              ERROR_CODES.DOMAIN_RELATION_MISMATCH,
              'generated financial record IDs must be unique',
              { operationId, movementId }
            );
          }
          await transaction.put('debts', nextDebt);
          await transaction.add('operations', operation);
          await transaction.add('movements', movement);
          return Object.freeze({
            operation, movement, debt: nextDebt, validPostedPaymentsTotal,
          });
        },
      });
    }

    function validateSavingsOperationDetails(operation) {
      const details = operationDetails(operation, ['goalId', 'concept', 'observation']);
      assertUuid(details.goalId, { field: 'Operation.details.goalId' });
      nullableNonEmptyString(details.concept, 'Operation.details.concept');
      nullableNonEmptyString(details.observation, 'Operation.details.observation');
      return details;
    }

    function validateSavingsOperationShape(operationType, deltaSign, operation, movements) {
      const validOperation = Domain.validateOperation(operation);
      const details = validateSavingsOperationDetails(validOperation);
      if (validOperation.type !== operationType || movements.length !== 1) {
        throw domainError(
          ERROR_CODES.DOMAIN_RELATION_MISMATCH,
          'savings operation requires exactly one SavingsGoal Movement',
          { operationId: validOperation.id, movementCount: movements.length }
        );
      }
      const movement = movements[0];
      Domain.assertMovementMatchesOperation(validOperation, movement);
      if (
        movement.targetType !== 'savings_goal' ||
        movement.targetId !== details.goalId ||
        movement.delta !== deltaSign * validOperation.amount
      ) {
        throw domainError(
          ERROR_CODES.DOMAIN_RELATION_MISMATCH,
          'savings Movement does not match its Goal, type, and amount',
          { operationId: validOperation.id }
        );
      }
      return Object.freeze({
        details,
        orderedMovements: Object.freeze([movement]),
      });
    }

    function savingsCreateRequest(input, commandType) {
      const request = requireRecord(input, commandType);
      const required = [
        'expectedDataRevision', 'expectedWriterEpoch', 'periodId',
        'goalId', 'expectedGoalRevision', 'operationDate', 'amount',
      ];
      validateCommandHeader(request, commandType, required, [
        ...required, 'concept', 'observation',
      ]);
      assertUuid(request.goalId, { field: 'goalId' });
      assertRevision(request.expectedGoalRevision, { field: 'expectedGoalRevision' });
      assertCivilDate(request.operationDate, { field: 'operationDate' });
      assertPositiveMoney(request.amount, { field: 'amount' });
      if (hasOwn(request, 'concept')) nullableNonEmptyString(request.concept, 'concept');
      if (hasOwn(request, 'observation')) nullableNonEmptyString(request.observation, 'observation');
      return request;
    }

    function savingsEditRequest(input, commandType) {
      const request = requireRecord(input, commandType);
      const required = [
        'expectedDataRevision', 'expectedWriterEpoch', 'periodId',
        'operationId', 'expectedOperationRevision', 'goalId', 'expectedGoalRevision',
      ];
      validateCommandHeader(request, commandType, required, [
        ...required, 'operationDate', 'amount', 'concept', 'observation',
      ]);
      assertUuid(request.operationId, { field: 'operationId' });
      assertRevision(request.expectedOperationRevision, { field: 'expectedOperationRevision' });
      assertUuid(request.goalId, { field: 'goalId' });
      assertRevision(request.expectedGoalRevision, { field: 'expectedGoalRevision' });
      if (hasOwn(request, 'operationDate')) assertCivilDate(request.operationDate, { field: 'operationDate' });
      if (hasOwn(request, 'amount')) assertPositiveMoney(request.amount, { field: 'amount' });
      if (hasOwn(request, 'concept')) nullableNonEmptyString(request.concept, 'concept');
      if (hasOwn(request, 'observation')) nullableNonEmptyString(request.observation, 'observation');
      return request;
    }

    function savingsVoidRequest(input, commandType) {
      const request = requireRecord(input, commandType);
      const required = [
        'expectedDataRevision', 'expectedWriterEpoch', 'periodId',
        'operationId', 'expectedOperationRevision', 'goalId', 'expectedGoalRevision',
      ];
      validateCommandHeader(request, commandType, required, [...required, 'reason']);
      assertUuid(request.operationId, { field: 'operationId' });
      assertRevision(request.expectedOperationRevision, { field: 'expectedOperationRevision' });
      assertUuid(request.goalId, { field: 'goalId' });
      assertRevision(request.expectedGoalRevision, { field: 'expectedGoalRevision' });
      if (hasOwn(request, 'reason')) requireNonEmptyString(request.reason, 'reason');
      return request;
    }

    function savingsOperationOptions(operationType) {
      const commandPrefix = operationType === 'savings_deposit'
        ? 'savings-deposit'
        : 'savings-withdrawal';
      const deltaSign = operationType === 'savings_deposit' ? 1 : -1;
      const validateShape = (operation, movements) => (
        validateSavingsOperationShape(operationType, deltaSign, operation, movements)
      );
      return Object.freeze({ commandPrefix, deltaSign, validateShape });
    }

    async function createSavingsOperation(input, operationType) {
      const config = savingsOperationOptions(operationType);
      const request = savingsCreateRequest(input, `${config.commandPrefix}.create`);
      const details = Object.freeze({
        goalId: request.goalId,
        concept: hasOwn(request, 'concept') ? request.concept : null,
        observation: hasOwn(request, 'observation') ? request.observation : null,
      });
      return executeMultiTargetCreate({
        request,
        commandType: `${config.commandPrefix}.create`,
        operationType,
        amount: request.amount,
        details,
        movementSpecs: [{
          targetType: 'savings_goal',
          targetId: request.goalId,
          delta: config.deltaSign * request.amount,
        }],
        declarations: [{
          targetType: 'savings_goal', targetId: request.goalId,
          expectedRevision: request.expectedGoalRevision, requireActive: true,
        }],
        validateShape: config.validateShape,
        metadata: { goalId: request.goalId },
      });
    }

    async function editSavingsOperation(input, operationType) {
      const config = savingsOperationOptions(operationType);
      const request = savingsEditRequest(input, `${config.commandPrefix}.edit`);
      return executeMultiTargetEdit({
        request,
        commandType: `${config.commandPrefix}.edit`,
        operationType,
        declarations: [{
          targetType: 'savings_goal', targetId: request.goalId,
          expectedRevision: request.expectedGoalRevision, requireActive: true,
        }],
        validatePrevious: (operation, movements) => {
          const previous = config.validateShape(operation, movements);
          if (previous.details.goalId !== request.goalId) {
            throw domainError(
              ERROR_CODES.DOMAIN_RELATION_MISMATCH,
              'SavingsGoal cannot be changed while editing this operation',
              { operationId: request.operationId, goalId: request.goalId }
            );
          }
          return previous;
        },
        buildNext: (operation, details) => {
          const amount = hasOwn(request, 'amount') ? request.amount : operation.amount;
          const nextDetails = Object.freeze({
            goalId: details.goalId,
            concept: hasOwn(request, 'concept') ? request.concept : details.concept,
            observation: hasOwn(request, 'observation')
              ? request.observation
              : details.observation,
          });
          return Object.freeze({
            operationDate: hasOwn(request, 'operationDate')
              ? request.operationDate
              : operation.operationDate,
            amount,
            details: nextDetails,
            movementSpecs: [{
              targetType: 'savings_goal',
              targetId: request.goalId,
              delta: config.deltaSign * amount,
            }],
          });
        },
        validateShape: config.validateShape,
        metadata: { goalId: request.goalId },
      });
    }

    async function voidSavingsOperation(input, operationType) {
      const config = savingsOperationOptions(operationType);
      const request = savingsVoidRequest(input, `${config.commandPrefix}.void`);
      return executeMultiTargetVoid({
        request,
        commandType: `${config.commandPrefix}.void`,
        operationType,
        declarations: [{
          targetType: 'savings_goal', targetId: request.goalId,
          expectedRevision: request.expectedGoalRevision, requireActive: false,
        }],
        validatePrevious: (operation, movements) => {
          const previous = config.validateShape(operation, movements);
          if (previous.details.goalId !== request.goalId) {
            throw domainError(
              ERROR_CODES.DOMAIN_RELATION_MISMATCH,
              'declared SavingsGoal does not match the operation',
              { operationId: request.operationId, goalId: request.goalId }
            );
          }
          return previous;
        },
        metadata: { goalId: request.goalId },
      });
    }

    const createSavingsDeposit = (input) => createSavingsOperation(input, 'savings_deposit');
    const editSavingsDeposit = (input) => editSavingsOperation(input, 'savings_deposit');
    const voidSavingsDeposit = (input) => voidSavingsOperation(input, 'savings_deposit');
    const createSavingsWithdrawal = (input) => createSavingsOperation(input, 'savings_withdrawal');
    const editSavingsWithdrawal = (input) => editSavingsOperation(input, 'savings_withdrawal');
    const voidSavingsWithdrawal = (input) => voidSavingsOperation(input, 'savings_withdrawal');

    function validateTransferEndpoint(targetType, targetId, expectedRevision, prefix) {
      if (targetType !== 'account' && targetType !== 'savings_goal') {
        throw domainError(
          ERROR_CODES.INVALID_DOMAIN_FIELD,
          `${prefix}Type must be account or savings_goal`,
          { field: `${prefix}Type`, value: targetType }
        );
      }
      assertUuid(targetId, { field: `${prefix}Id` });
      assertRevision(expectedRevision, {
        field: `expected${prefix[0].toUpperCase()}${prefix.slice(1)}Revision`,
      });
      return Object.freeze({ targetType, targetId, expectedRevision });
    }

    function assertDistinctTransferEndpoints(sourceType, sourceId, destinationType, destinationId) {
      if (sourceType === destinationType && sourceId === destinationId) {
        throw domainError(
          ERROR_CODES.DOMAIN_STATE_INVALID,
          'transfer source and destination must be different entities',
          { sourceType, sourceId, destinationType, destinationId }
        );
      }
    }

    function validateTransferDetails(operation) {
      const details = operationDetails(operation, [
        'sourceType', 'sourceId', 'destinationType', 'destinationId',
        'concept', 'observation',
      ]);
      validateTransferEndpoint(details.sourceType, details.sourceId, 1, 'source');
      validateTransferEndpoint(details.destinationType, details.destinationId, 1, 'destination');
      assertDistinctTransferEndpoints(
        details.sourceType, details.sourceId, details.destinationType, details.destinationId
      );
      nullableNonEmptyString(details.concept, 'Operation.details.concept');
      nullableNonEmptyString(details.observation, 'Operation.details.observation');
      return details;
    }

    function validateTransferShape(operation, movements) {
      const validOperation = Domain.validateOperation(operation);
      const details = validateTransferDetails(validOperation);
      if (validOperation.type !== 'transfer' || movements.length !== 2) {
        throw domainError(
          ERROR_CODES.DOMAIN_RELATION_MISMATCH,
          'transfer requires exactly two Movements',
          { operationId: validOperation.id, movementCount: movements.length }
        );
      }
      for (const movement of movements) {
        Domain.assertMovementMatchesOperation(validOperation, movement);
      }
      const sourceMovement = movements.find((movement) => (
        movement.targetType === details.sourceType &&
        movement.targetId === details.sourceId &&
        movement.delta < 0
      ));
      const destinationMovement = movements.find((movement) => (
        movement.targetType === details.destinationType &&
        movement.targetId === details.destinationId &&
        movement.delta > 0
      ));
      if (
        !sourceMovement || !destinationMovement ||
        sourceMovement.delta !== -validOperation.amount ||
        destinationMovement.delta !== validOperation.amount
      ) {
        throw domainError(
          ERROR_CODES.DOMAIN_RELATION_MISMATCH,
          'transfer Movements must be balanced and match their endpoints',
          { operationId: validOperation.id }
        );
      }
      return Object.freeze({
        details,
        orderedMovements: Object.freeze([sourceMovement, destinationMovement]),
      });
    }

    function transferCreateRequest(input) {
      const request = requireRecord(input, 'transfer.create');
      const required = [
        'expectedDataRevision', 'expectedWriterEpoch', 'periodId',
        'sourceType', 'sourceId', 'expectedSourceRevision',
        'destinationType', 'destinationId', 'expectedDestinationRevision',
        'operationDate', 'amount',
      ];
      validateCommandHeader(request, 'transfer.create', required, [
        ...required, 'concept', 'observation',
      ]);
      validateTransferEndpoint(
        request.sourceType, request.sourceId, request.expectedSourceRevision, 'source'
      );
      validateTransferEndpoint(
        request.destinationType,
        request.destinationId,
        request.expectedDestinationRevision,
        'destination'
      );
      assertDistinctTransferEndpoints(
        request.sourceType, request.sourceId, request.destinationType, request.destinationId
      );
      assertCivilDate(request.operationDate, { field: 'operationDate' });
      assertPositiveMoney(request.amount, { field: 'amount' });
      if (hasOwn(request, 'concept')) nullableNonEmptyString(request.concept, 'concept');
      if (hasOwn(request, 'observation')) nullableNonEmptyString(request.observation, 'observation');
      return request;
    }

    async function createTransfer(input) {
      const request = transferCreateRequest(input);
      const details = Object.freeze({
        sourceType: request.sourceType,
        sourceId: request.sourceId,
        destinationType: request.destinationType,
        destinationId: request.destinationId,
        concept: hasOwn(request, 'concept') ? request.concept : null,
        observation: hasOwn(request, 'observation') ? request.observation : null,
      });
      return executeMultiTargetCreate({
        request,
        commandType: 'transfer.create',
        operationType: 'transfer',
        amount: request.amount,
        details,
        movementSpecs: [
          { targetType: request.sourceType, targetId: request.sourceId, delta: -request.amount },
          {
            targetType: request.destinationType,
            targetId: request.destinationId,
            delta: request.amount,
          },
        ],
        declarations: [
          {
            targetType: request.sourceType, targetId: request.sourceId,
            expectedRevision: request.expectedSourceRevision, requireActive: true,
          },
          {
            targetType: request.destinationType, targetId: request.destinationId,
            expectedRevision: request.expectedDestinationRevision, requireActive: true,
          },
        ],
        validateShape: validateTransferShape,
        metadata: {
          sourceType: request.sourceType,
          sourceId: request.sourceId,
          destinationType: request.destinationType,
          destinationId: request.destinationId,
        },
      });
    }

    function transferEditRequest(input) {
      const request = requireRecord(input, 'transfer.edit');
      const required = [
        'expectedDataRevision', 'expectedWriterEpoch', 'periodId',
        'operationId', 'expectedOperationRevision',
        'previousSourceType', 'previousSourceId', 'expectedPreviousSourceRevision',
        'previousDestinationType', 'previousDestinationId', 'expectedPreviousDestinationRevision',
        'sourceType', 'sourceId', 'expectedSourceRevision',
        'destinationType', 'destinationId', 'expectedDestinationRevision',
      ];
      validateCommandHeader(request, 'transfer.edit', required, [
        ...required, 'operationDate', 'amount', 'concept', 'observation',
      ]);
      assertUuid(request.operationId, { field: 'operationId' });
      assertRevision(request.expectedOperationRevision, { field: 'expectedOperationRevision' });
      for (const prefix of [
        'previousSource', 'previousDestination', 'source', 'destination',
      ]) {
        const capitalized = `${prefix[0].toUpperCase()}${prefix.slice(1)}`;
        validateTransferEndpoint(
          request[`${prefix}Type`],
          request[`${prefix}Id`],
          request[`expected${capitalized}Revision`],
          prefix
        );
      }
      assertDistinctTransferEndpoints(
        request.sourceType, request.sourceId, request.destinationType, request.destinationId
      );
      if (hasOwn(request, 'operationDate')) assertCivilDate(request.operationDate, { field: 'operationDate' });
      if (hasOwn(request, 'amount')) assertPositiveMoney(request.amount, { field: 'amount' });
      if (hasOwn(request, 'concept')) nullableNonEmptyString(request.concept, 'concept');
      if (hasOwn(request, 'observation')) nullableNonEmptyString(request.observation, 'observation');
      return request;
    }

    async function editTransfer(input) {
      const request = transferEditRequest(input);
      return executeMultiTargetEdit({
        request,
        commandType: 'transfer.edit',
        operationType: 'transfer',
        declarations: [
          {
            targetType: request.previousSourceType,
            targetId: request.previousSourceId,
            expectedRevision: request.expectedPreviousSourceRevision,
            requireActive: false,
          },
          {
            targetType: request.previousDestinationType,
            targetId: request.previousDestinationId,
            expectedRevision: request.expectedPreviousDestinationRevision,
            requireActive: false,
          },
          {
            targetType: request.sourceType,
            targetId: request.sourceId,
            expectedRevision: request.expectedSourceRevision,
            requireActive: true,
          },
          {
            targetType: request.destinationType,
            targetId: request.destinationId,
            expectedRevision: request.expectedDestinationRevision,
            requireActive: true,
          },
        ],
        validatePrevious: (operation, movements) => {
          const previous = validateTransferShape(operation, movements);
          if (
            previous.details.sourceType !== request.previousSourceType ||
            previous.details.sourceId !== request.previousSourceId ||
            previous.details.destinationType !== request.previousDestinationType ||
            previous.details.destinationId !== request.previousDestinationId
          ) {
            throw domainError(
              ERROR_CODES.DOMAIN_RELATION_MISMATCH,
              'declared previous transfer endpoints do not match the Operation',
              { operationId: request.operationId }
            );
          }
          return previous;
        },
        buildNext: (operation, details) => {
          const amount = hasOwn(request, 'amount') ? request.amount : operation.amount;
          return Object.freeze({
            operationDate: hasOwn(request, 'operationDate')
              ? request.operationDate
              : operation.operationDate,
            amount,
            details: Object.freeze({
              sourceType: request.sourceType,
              sourceId: request.sourceId,
              destinationType: request.destinationType,
              destinationId: request.destinationId,
              concept: hasOwn(request, 'concept') ? request.concept : details.concept,
              observation: hasOwn(request, 'observation')
                ? request.observation
                : details.observation,
            }),
            movementSpecs: [
              { targetType: request.sourceType, targetId: request.sourceId, delta: -amount },
              {
                targetType: request.destinationType,
                targetId: request.destinationId,
                delta: amount,
              },
            ],
          });
        },
        validateShape: validateTransferShape,
        metadata: {
          previousSourceType: request.previousSourceType,
          previousSourceId: request.previousSourceId,
          previousDestinationType: request.previousDestinationType,
          previousDestinationId: request.previousDestinationId,
          sourceType: request.sourceType,
          sourceId: request.sourceId,
          destinationType: request.destinationType,
          destinationId: request.destinationId,
        },
      });
    }

    function transferVoidRequest(input) {
      const request = requireRecord(input, 'transfer.void');
      const required = [
        'expectedDataRevision', 'expectedWriterEpoch', 'periodId',
        'operationId', 'expectedOperationRevision',
        'sourceType', 'sourceId', 'expectedSourceRevision',
        'destinationType', 'destinationId', 'expectedDestinationRevision',
      ];
      validateCommandHeader(request, 'transfer.void', required, [...required, 'reason']);
      assertUuid(request.operationId, { field: 'operationId' });
      assertRevision(request.expectedOperationRevision, { field: 'expectedOperationRevision' });
      validateTransferEndpoint(
        request.sourceType, request.sourceId, request.expectedSourceRevision, 'source'
      );
      validateTransferEndpoint(
        request.destinationType,
        request.destinationId,
        request.expectedDestinationRevision,
        'destination'
      );
      if (hasOwn(request, 'reason')) requireNonEmptyString(request.reason, 'reason');
      return request;
    }

    async function voidTransfer(input) {
      const request = transferVoidRequest(input);
      return executeMultiTargetVoid({
        request,
        commandType: 'transfer.void',
        operationType: 'transfer',
        declarations: [
          {
            targetType: request.sourceType, targetId: request.sourceId,
            expectedRevision: request.expectedSourceRevision, requireActive: false,
          },
          {
            targetType: request.destinationType, targetId: request.destinationId,
            expectedRevision: request.expectedDestinationRevision, requireActive: false,
          },
        ],
        validatePrevious: (operation, movements) => {
          const previous = validateTransferShape(operation, movements);
          if (
            previous.details.sourceType !== request.sourceType ||
            previous.details.sourceId !== request.sourceId ||
            previous.details.destinationType !== request.destinationType ||
            previous.details.destinationId !== request.destinationId
          ) {
            throw domainError(
              ERROR_CODES.DOMAIN_RELATION_MISMATCH,
              'declared transfer endpoints do not match the Operation',
              { operationId: request.operationId }
            );
          }
          return previous;
        },
        metadata: {
          sourceType: request.sourceType,
          sourceId: request.sourceId,
          destinationType: request.destinationType,
          destinationId: request.destinationId,
        },
      });
    }

    function monthlyCloseRequest(input) {
      const request = requireRecord(input, 'period.close-and-open-next');
      const fields = [
        'expectedDataRevision',
        'expectedWriterEpoch',
        'periodId',
        'expectedPeriodRevision',
        'expectedSettingsRevision',
        'entityRevisions',
        'activeTemplateRevisions',
        'currentInstanceRevisions',
      ];
      validateCommandHeader(request, 'period.close-and-open-next', fields);
      assertRevision(request.expectedPeriodRevision, { field: 'expectedPeriodRevision' });
      assertRevision(request.expectedSettingsRevision, { field: 'expectedSettingsRevision' });
      return Object.freeze({
        ...request,
        entityRevisions: revisionExpectationList(
          request.entityRevisions, 'entityRevisions', 'targetId', 'targetType'
        ),
        activeTemplateRevisions: revisionExpectationList(
          request.activeTemplateRevisions,
          'activeTemplateRevisions',
          'templateId'
        ),
        currentInstanceRevisions: revisionExpectationList(
          request.currentInstanceRevisions,
          'currentInstanceRevisions',
          'instanceId'
        ),
      });
    }

    async function closeAndOpenNext(input) {
      const request = monthlyCloseRequest(input);
      const occurredAt = canonicalTimestamp(now);
      const generatedIds = new Set();
      const snapshotId = createIdentifier(createUuid, 'periodSnapshot.id', generatedIds);
      const nextPeriodId = createIdentifier(createUuid, 'nextPeriod.id', generatedIds);
      const activeTemplateInstanceIds = new Map(request.activeTemplateRevisions.map((expectation) => [
        expectation.templateId,
        createIdentifier(createUuid, 'nextFixedExpenseInstance.id', generatedIds),
      ]));
      const scopes = [
        Domain.domainScope('financial_settings', 'current'),
        Domain.domainScope('period', request.periodId),
        Domain.domainScope('period', nextPeriodId),
        ...request.entityRevisions.map((expectation) => (
          Domain.domainScope(expectation.targetType, expectation.targetId)
        )),
        ...request.activeTemplateRevisions.map((expectation) => (
          Domain.domainScope('fixed_expense_template', expectation.templateId)
        )),
        ...request.currentInstanceRevisions.map((expectation) => (
          Domain.domainScope('fixed_expense_instance', expectation.instanceId)
        )),
        ...[...activeTemplateInstanceIds.values()].map((instanceId) => (
          Domain.domainScope('fixed_expense_instance', instanceId)
        )),
      ];
      return runtime.executeCommand({
        commandType: 'period.close-and-open-next',
        expectedDataRevision: request.expectedDataRevision,
        expectedWriterEpoch: request.expectedWriterEpoch,
        affectedStores: MONTHLY_CLOSE_STORES,
        affectedScopes: Object.freeze([...new Set(scopes)]),
        runtimePatch: { activePeriodId: nextPeriodId },
        intent: true,
        metadata: {
          periodId: request.periodId,
          nextPeriodId,
          snapshotId,
        },
        execute: async (transaction, context) => {
          const settingsRecord = await transaction.get('financialSettings', 'current');
          if (settingsRecord === undefined) {
            throw domainError(
              ERROR_CODES.DOMAIN_STATE_INVALID,
              'monthly close requires completed financial settings',
              { periodId: request.periodId }
            );
          }
          const financialSettings = Domain.validateFinancialSettings(settingsRecord);
          assertExpectedRevision(
            financialSettings.revision,
            request.expectedSettingsRevision,
            { entityType: 'FinancialSettings', entityId: 'current' }
          );

          const rawPeriods = await transaction.getAll('periods');
          const periods = rawPeriods.map(Domain.validatePeriod);
          const periodRecord = periods.find((period) => period.id === request.periodId);
          const period = requireActiveOpenPeriod(
            periodRecord, context, request.periodId, 'period.close-and-open-next'
          );
          assertExpectedRevision(period.revision, request.expectedPeriodRevision, {
            entityType: 'Period', entityId: period.id,
          });
          const openPeriods = periods.filter((candidate) => candidate.status === 'open');
          if (openPeriods.length !== 1 || openPeriods[0].id !== period.id) {
            throw domainError(
              ERROR_CODES.DOMAIN_STATE_INVALID,
              'monthly close requires exactly one active open Period',
              { openPeriodIds: openPeriods.map((candidate) => candidate.id) }
            );
          }
          const nextPeriodKey = nextPeriod(period.periodKey);
          if (
            periods.some((candidate) => (
              candidate.id === nextPeriodId || candidate.periodKey === nextPeriodKey
            ))
          ) {
            throw domainError(
              ERROR_CODES.DOMAIN_STATE_INVALID,
              'the next Period already exists',
              { nextPeriodId, nextPeriodKey }
            );
          }

          const rawAccounts = await transaction.getAll('accounts');
          const rawGoals = await transaction.getAll('savingsGoals');
          const rawDebts = await transaction.getAll('debts');
          const accounts = rawAccounts.map(Domain.validateAccount);
          const goals = rawGoals.map(Domain.validateSavingsGoal);
          const debts = rawDebts.map(Domain.validateDebt);
          const allEntities = [
            ...accounts.map((entity) => ({ ...entity, targetType: 'account' })),
            ...goals.map((entity) => ({ ...entity, targetType: 'savings_goal' })),
            ...debts.map((entity) => ({ ...entity, targetType: 'debt' })),
          ];
          assertExactExpectedRevisions(allEntities, request.entityRevisions, {
            name: 'FinancialEntity',
            actualKey: (record) => financialTargetKey(record.targetType, record.id),
            expectedKey: (record) => financialTargetKey(record.targetType, record.targetId),
          });

          const rawTemplates = await transaction.getAll('fixedExpenseTemplates');
          const templates = rawTemplates.map(Domain.validateFixedExpenseTemplate);
          const activeTemplates = templates.filter((template) => template.status === 'active');
          const categories = (await transaction.getAll('categories')).map(Domain.validateCategory);
          assertExactExpectedRevisions(activeTemplates, request.activeTemplateRevisions, {
            name: 'FixedExpenseTemplate',
            actualKey: (record) => record.id,
            expectedKey: (record) => record.templateId,
          });

          const rawInstances = await transaction.getAll('fixedExpenseInstances');
          const instances = rawInstances.map(Domain.validateFixedExpenseInstance);
          const currentInstances = instances.filter((instance) => instance.periodId === period.id);
          assertExactExpectedRevisions(currentInstances, request.currentInstanceRevisions, {
            name: 'FixedExpenseInstance',
            actualKey: (record) => record.id,
            expectedKey: (record) => record.instanceId,
          });
          if (currentInstances.some((instance) => instance.status === 'unpaid')) {
            throw domainError(
              ERROR_CODES.DOMAIN_STATE_INVALID,
              'an open Period cannot already contain an unpaid FixedExpenseInstance',
              { periodId: period.id }
            );
          }
          const templateIds = new Set(templates.map((template) => template.id));
          const missingTemplateInstance = currentInstances.find(
            (instance) => !templateIds.has(instance.templateId)
          );
          if (missingTemplateInstance) {
            throw domainError(
              ERROR_CODES.DOMAIN_RELATION_MISMATCH,
              'monthly close found a FixedExpenseInstance without its Template',
              {
                instanceId: missingTemplateInstance.id,
                templateId: missingTemplateInstance.templateId,
              }
            );
          }

          const operations = (await transaction.getAll('operations')).map(Domain.validateOperation);
          const movements = (await transaction.getAll('movements')).map(Domain.validateMovement);
          const periodOpenings = (await transaction.getAll('periodOpenings'))
            .map(Domain.validatePeriodOpening);
          const existingSnapshots = await transaction.getAll('periodSnapshots');
          if (
            period.snapshotId !== null ||
            existingSnapshots.some((snapshot) => (
              snapshot.id === snapshotId || snapshot.periodId === period.id
            ))
          ) {
            throw domainError(
              ERROR_CODES.DOMAIN_STATE_INVALID,
              'the Period already has a confirmed or conflicting close snapshot',
              { periodId: period.id, snapshotId: period.snapshotId }
            );
          }

          const summary = deriveMonthlySummary({
            period,
            operations,
            movements,
            fixedExpenseInstances: currentInstances,
          });
          if (period.plannedSalaryAmount > 0 && summary.receivedSalaryAmount === 0) {
            throw domainError(
              ERROR_CODES.DOMAIN_STATE_INVALID,
              'a positive planned salary must be received before monthly close',
              { periodId: period.id, plannedSalaryAmount: period.plannedSalaryAmount }
            );
          }

          const reconciled = reconcileMonthlyBalances({
            periodId: period.id,
            entities: {
              account: accounts,
              savings_goal: goals,
              debt: debts,
            },
            operations,
            movements,
            periodOpenings,
          });

          const closedPeriod = Domain.validatePeriod({
            ...period,
            status: 'closed',
            closedAt: occurredAt,
            snapshotId,
            revision: nextRevision(period.revision),
          });
          const nextPeriodRecord = Domain.validatePeriod({
            id: nextPeriodId,
            periodKey: nextPeriodKey,
            status: 'open',
            plannedSalaryAmount: financialSettings.salaryReferenceAmount,
            openedAt: occurredAt,
            closedAt: null,
            snapshotId: null,
            revision: 1,
          });

          const finalizedInstances = currentInstances.map((instance) => (
            instance.status === 'pending'
              ? Domain.validateFixedExpenseInstance({
                ...instance,
                status: 'unpaid',
                revision: nextRevision(instance.revision),
                updatedAt: occurredAt,
              })
              : instance
          ));
          const continuingTargets = [
            ...accounts.filter((account) => account.status === 'active').map((account) => ({
              targetType: 'account', targetId: account.id, openingAmount: account.currentBalance,
            })),
            ...goals.filter((goal) => goal.lifecycleStatus === 'active').map((goal) => ({
              targetType: 'savings_goal', targetId: goal.id, openingAmount: goal.currentBalance,
            })),
            ...debts.filter((debt) => (
              debt.lifecycleStatus === 'active' && debt.outstandingAmount > 0
            )).map((debt) => ({
              targetType: 'debt', targetId: debt.id, openingAmount: debt.outstandingAmount,
            })),
          ];
          for (const target of continuingTargets) {
            const key = financialTargetKey(target.targetType, target.targetId);
            if (!hasOwn(reconciled.closingBalances, key)) {
              throw domainError(
                ERROR_CODES.DOMAIN_RELATION_MISMATCH,
                'a continuing financial target has no PeriodOpening in the closing Period',
                {
                  periodId: period.id,
                  targetType: target.targetType,
                  targetId: target.targetId,
                }
              );
            }
          }
          const nextOpenings = continuingTargets.map((target) => Domain.validatePeriodOpening({
            id: createIdentifier(createUuid, 'nextPeriodOpening.id', generatedIds),
            periodId: nextPeriodId,
            ...target,
          }));
          const nextInstances = activeTemplates.map((template) => Domain.validateFixedExpenseInstance({
            id: activeTemplateInstanceIds.get(template.id),
            periodId: nextPeriodId,
            templateId: template.id,
            nameSnapshot: template.name,
            plannedAmount: template.referenceAmount,
            status: 'pending',
            activePaymentOperationId: null,
            revision: 1,
            createdAt: occurredAt,
            updatedAt: occurredAt,
          }));

          const currentAuditEvents = (await transaction.getAll('auditEvents'))
            .filter((event) => event.periodId === period.id)
            .map(Domain.validateAuditEvent);
          const closeAudit = stateChangedAuditEvent({
            id: createIdentifier(createUuid, 'auditEvent.periodClose.id', generatedIds),
            periodId: period.id,
            subjectType: 'period',
            subjectId: period.id,
            action: 'closed',
            commandType: 'period.close-and-open-next',
            previousValue: period,
            nextValue: closedPeriod,
            occurredAt,
          });
          const finalizedInstanceAudits = finalizedInstances
            .filter((instance, index) => instance !== currentInstances[index])
            .map((instance) => {
              const previousValue = currentInstances.find((current) => current.id === instance.id);
              return updatedAuditEvent({
                id: createIdentifier(createUuid, 'auditEvent.fixedInstanceUnpaid.id', generatedIds),
                periodId: period.id,
                subjectType: 'fixed_expense_instance',
                subjectId: instance.id,
                commandType: 'period.close-and-open-next',
                previousValue,
                nextValue: instance,
                occurredAt,
              });
            });
          const nextPeriodAudit = createdAuditEvent({
            id: createIdentifier(createUuid, 'auditEvent.nextPeriod.id', generatedIds),
            periodId: nextPeriodId,
            subjectType: 'period',
            subjectId: nextPeriodId,
            commandType: 'period.close-and-open-next',
            nextValue: nextPeriodRecord,
            occurredAt,
          });
          const nextInstanceAudits = nextInstances.map((instance) => createdAuditEvent({
            id: createIdentifier(createUuid, 'auditEvent.nextFixedInstance.id', generatedIds),
            periodId: nextPeriodId,
            subjectType: 'fixed_expense_instance',
            subjectId: instance.id,
            commandType: 'period.close-and-open-next',
            nextValue: instance,
            occurredAt,
          }));

          const periodOperations = operations.filter((operation) => operation.periodId === period.id);
          const periodMovements = movements.filter((movement) => movement.periodId === period.id);
          const currentPeriodOpenings = periodOpenings.filter((opening) => opening.periodId === period.id);
          const snapshotPayload = immutableJsonCopy({
            id: snapshotId,
            periodId: period.id,
            periodKey: period.periodKey,
            schemaVersion: '1.1.0',
            snapshotKind: 'canonical',
            closedAt: occurredAt,
            data: {
              periodPlan: {
                plannedSalaryAmount: period.plannedSalaryAmount,
              },
              operations: periodOperations,
              movements: periodMovements,
              fixedExpenses: finalizedInstances,
              periodOpenings: currentPeriodOpenings,
              auditEvents: [...currentAuditEvents, closeAudit, ...finalizedInstanceAudits],
              entitySnapshots: {
                accounts,
                savingsGoals: goals,
                debts,
                categories,
              },
              openingBalances: reconciled.openingBalances,
              closingBalances: reconciled.closingBalances,
              totals: summary,
              warnings: [],
            },
          });
          const periodSnapshot = immutableJsonCopy({
            ...snapshotPayload,
            integrity: {
              algorithm: 'SHA-256',
              payloadHash: hashSnapshotPayload(snapshotPayload, sha256),
            },
          });

          await transaction.put('periods', closedPeriod);
          await transaction.add('periodSnapshots', periodSnapshot);
          for (const instance of finalizedInstances) {
            const previous = currentInstances.find((current) => current.id === instance.id);
            if (instance !== previous) await transaction.put('fixedExpenseInstances', instance);
          }
          await transaction.add('periods', nextPeriodRecord);
          for (const opening of nextOpenings) await transaction.add('periodOpenings', opening);
          for (const instance of nextInstances) await transaction.add('fixedExpenseInstances', instance);
          await transaction.add('auditEvents', closeAudit);
          for (const event of finalizedInstanceAudits) await transaction.add('auditEvents', event);
          await transaction.add('auditEvents', nextPeriodAudit);
          for (const event of nextInstanceAudits) await transaction.add('auditEvents', event);

          return immutableJsonCopy({
            summary,
            closedPeriod,
            periodSnapshot,
            nextPeriod: nextPeriodRecord,
            periodOpenings: nextOpenings,
            fixedExpenseInstances: nextInstances,
            finalizedFixedExpenseInstances: finalizedInstances,
            auditEvents: [
              closeAudit,
              ...finalizedInstanceAudits,
              nextPeriodAudit,
              ...nextInstanceAudits,
            ],
          });
        },
      });
    }

    return Object.freeze({
      setup: Object.freeze({ complete }),
      financialSettings: Object.freeze({ updateReferenceSalary }),
      period: Object.freeze({ updatePlanning, closeAndOpenNext }),
      account: Object.freeze({
        create: createAccount,
        update: updateAccount,
        deactivate: deactivateAccount,
      }),
      category: Object.freeze({
        create: createCategory,
        update: updateCategory,
        deactivate: deactivateCategory,
      }),
      fixedExpenseTemplate: Object.freeze({
        create: createFixedExpenseTemplate,
        update: updateFixedExpenseTemplate,
        deactivate: deactivateFixedExpenseTemplate,
      }),
      fixedExpenseInstance: Object.freeze({
        updatePlannedAmount: updateFixedExpenseInstancePlannedAmount,
      }),
      savingsGoal: Object.freeze({
        create: createSavingsGoal,
        update: updateSavingsGoal,
        close: closeSavingsGoal,
      }),
      debt: Object.freeze({
        create: createDebt,
        updateNameAndDueDate: updateDebtNameAndDueDate,
      }),
      balanceAdjustment: Object.freeze({
        create: createBalanceAdjustment,
        edit: editBalanceAdjustment,
      }),
      operation: Object.freeze({
        void: voidOperation,
      }),
      salaryReceipt: Object.freeze({
        create: createSalaryReceipt,
        edit: editSalaryReceipt,
        void: voidSalaryReceipt,
      }),
      additionalIncome: Object.freeze({
        create: createAdditionalIncome,
        edit: editAdditionalIncome,
        void: voidAdditionalIncome,
      }),
      variableExpense: Object.freeze({
        create: createVariableExpense,
        edit: editVariableExpense,
        void: voidVariableExpense,
      }),
      fixedExpensePayment: Object.freeze({
        create: createFixedExpensePayment,
        edit: editFixedExpensePayment,
        void: voidFixedExpensePayment,
      }),
      debtPayment: Object.freeze({
        create: createDebtPayment,
        edit: editDebtPayment,
        void: voidDebtPayment,
      }),
      debtTotalAdjustment: Object.freeze({
        create: createDebtTotalAdjustment,
      }),
      savingsDeposit: Object.freeze({
        create: createSavingsDeposit,
        edit: editSavingsDeposit,
        void: voidSavingsDeposit,
      }),
      savingsWithdrawal: Object.freeze({
        create: createSavingsWithdrawal,
        edit: editSavingsWithdrawal,
        void: voidSavingsWithdrawal,
      }),
      transfer: Object.freeze({
        create: createTransfer,
        edit: editTransfer,
        void: voidTransfer,
      }),
    });
  }

  return Object.freeze({
    SETUP_COMPLETE_STORES,
    NEGATIVE_OPENING_BALANCE_WARNING,
    FINANCIAL_SETTINGS_UPDATE_STORES,
    PERIOD_PLANNING_UPDATE_STORES,
    PERIOD_PLANNING_FIELDS,
    ACCOUNT_CREATE_STORES,
    ACCOUNT_CHANGE_STORES,
    ACCOUNT_EDITABLE_FIELDS,
    CATEGORY_STORES,
    FIXED_TEMPLATE_CREATE_STORES,
    FIXED_TEMPLATE_CHANGE_STORES,
    FIXED_INSTANCE_CHANGE_STORES,
    SAVINGS_GOAL_CREATE_STORES,
    SAVINGS_GOAL_CHANGE_STORES,
    DEBT_CREATE_STORES,
    DEBT_CHANGE_STORES,
    CATEGORY_EDITABLE_FIELDS,
    FIXED_TEMPLATE_EDITABLE_FIELDS,
    SAVINGS_GOAL_EDITABLE_FIELDS,
    DEBT_EDITABLE_FIELDS,
    CATEGORY_FIELDS,
    FIXED_TEMPLATE_FIELDS,
    SAVINGS_GOAL_FIELDS,
    DEBT_FIELDS,
    FINANCIAL_OPERATION_CREATE_STORES,
    FINANCIAL_OPERATION_CHANGE_STORES,
    BALANCE_ADJUSTMENT_EDITABLE_FIELDS,
    FINANCIAL_TARGET_POLICIES,
    ACCOUNT_OPERATION_POLICIES,
    ACCOUNT_OPERATION_CREATE_STORES,
    ACCOUNT_OPERATION_CHANGE_STORES,
    VARIABLE_EXPENSE_CREATE_STORES,
    VARIABLE_EXPENSE_CHANGE_STORES,
    FIXED_EXPENSE_PAYMENT_CREATE_STORES,
    FIXED_EXPENSE_PAYMENT_CHANGE_STORES,
    MULTI_TARGET_CREATE_BASE_STORES,
    MULTI_TARGET_CHANGE_BASE_STORES,
    TARGET_STORE_NAMES,
    MONTHLY_CLOSE_STORES,
    MONTHLY_SUMMARY_FIELDS,
    canonicalJson,
    deriveMonthlySummary,
    createPeritaDomainCommands,
  });
});
