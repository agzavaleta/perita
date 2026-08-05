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
    assertRevision,
    assertUuid,
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
    'variableExpenseBudgetAmount',
    'plannedSavingsAmount',
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
  const ACCOUNT_EDITABLE_FIELDS = Object.freeze(['name']);

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

    return Object.freeze({
      setup: Object.freeze({ complete }),
      financialSettings: Object.freeze({ updateReferenceSalary }),
      period: Object.freeze({ updatePlanning }),
      account: Object.freeze({
        create: createAccount,
        update: updateAccount,
        deactivate: deactivateAccount,
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
    createPeritaDomainCommands,
  });
});
