/* perita-legacy.js — isolated parser and migration dry-run for Perita V1
 *
 * The module receives the exact legacy source string. It does not access
 * browser storage, IndexedDB, UI, migration commits, or financial commands.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./perita-contracts.js'));
  } else {
    root.PeritaLegacy = factory(root.PeritaContracts);
  }
})(typeof self !== 'undefined' ? self : this, function (Contracts) {
  'use strict';

  if (!Contracts) throw new Error('PeritaContracts is required');

  const {
    ERROR_CODES,
    PeritaError,
    PERITA_MIGRATION_NAMESPACE_UUID,
    assertCivilDate,
    assertPeriod,
    assertUuid,
    deterministicUuid,
  } = Contracts;

  const SOURCE_KEY = 'perita_v1';
  const MAPPER_VERSION = '1.1.0-dry-run.1';
  const CLASSIFICATIONS = Object.freeze(['migratable', 'restricted', 'blocked']);
  const COLLECTION_NAMES = Object.freeze([
    'accounts',
    'debts',
    'wallets',
    'budget',
    'varCategories',
    'monthlyHistory',
  ]);
  const MONTHLY_COLLECTIONS = Object.freeze([
    'expenses',
    'pagosDeuda',
    'aportesAhorro',
    'gastosFijosPagados',
  ]);
  const KNOWN_TOP_LEVEL_FIELDS = new Set([
    'settings',
    ...COLLECTION_NAMES,
    'nextId',
    'activeMonth',
    'expenses',
  ]);
  const KNOWN_FIELDS = Object.freeze({
    settings: new Set(['salary']),
    account: new Set(['id', 'name', 'type', 'bank', 'balance']),
    debt: new Set(['id', 'name', 'total', 'paid', 'monthly', 'dueDate', 'status']),
    wallet: new Set(['id', 'emoji', 'name', 'bank', 'balance', 'monthly', 'goal']),
    budget: new Set(['id', 'name', 'amount']),
    category: new Set(['id', 'name']),
    month: new Set([
      'month', 'salary', 'closedAt',
      'expenses', 'pagosDeuda', 'aportesAhorro', 'gastosFijosPagados',
    ]),
    expense: new Set([
      'id', 'date', 'description', 'amount', 'type', 'account',
      'category', 'method', 'notes',
    ]),
    debtPayment: new Set(['id', 'debtId', 'debtName', 'amount', 'date', 'accountId']),
    savingDeposit: new Set([
      'id', 'walletId', 'walletName', 'amount', 'date', 'accountId', 'fromAccountId',
    ]),
    fixedPayment: new Set(['id', 'budgetId', 'name', 'amount', 'date', 'accountId']),
  });

  class LegacyError extends PeritaError {}

  function legacyError(code, message, context, cause) {
    return new LegacyError(code, message, context, cause);
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

  function deepClone(value) {
    if (Array.isArray(value)) return value.map(deepClone);
    if (isPlainObject(value)) {
      return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, deepClone(nested)]));
    }
    return value;
  }

  function immutableCopy(value) {
    return deepFreeze(deepClone(value));
  }

  function canonicalValue(value) {
    if (Array.isArray(value)) return value.map(canonicalValue);
    if (!isPlainObject(value)) return value;
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])])
    );
  }

  function structurallyEquivalent(left, right) {
    return JSON.stringify(canonicalValue(left)) === JSON.stringify(canonicalValue(right));
  }

  function bytesToHex(bytes) {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  function normalizedHash(value) {
    if (typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value)) {
      return value.toLowerCase();
    }
    if (value instanceof ArrayBuffer) {
      const bytes = new Uint8Array(value);
      if (bytes.byteLength !== 32) throw new TypeError('SHA-256 must return exactly 32 bytes');
      return bytesToHex(bytes);
    }
    if (ArrayBuffer.isView(value)) {
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      if (bytes.byteLength !== 32) throw new TypeError('SHA-256 must return exactly 32 bytes');
      return bytesToHex(bytes);
    }
    throw new TypeError('SHA-256 must return 32 bytes or a 64-character hexadecimal string');
  }

  async function hashExactSource(rawSource, sha256) {
    if (typeof sha256 !== 'function') {
      throw legacyError(
        ERROR_CODES.HASH_FAILED,
        'a SHA-256 function is required',
        { algorithm: 'SHA-256' },
        new TypeError('sha256 is not a function')
      );
    }
    try {
      return normalizedHash(await sha256(rawSource));
    } catch (cause) {
      if (cause instanceof LegacyError) throw cause;
      throw legacyError(
        ERROR_CODES.HASH_FAILED,
        'the exact legacy source could not be hashed',
        { algorithm: 'SHA-256' },
        cause
      );
    }
  }

  function parserOptions(options) {
    const settings = options || {};
    return { sha256: settings.sha256 };
  }

  async function parseLegacySource(rawSource, options) {
    if (typeof rawSource !== 'string') {
      throw legacyError(
        ERROR_CODES.LEGACY_STRUCTURE_INVALID,
        'legacy source must be the exact JSON string',
        { actualType: typeof rawSource }
      );
    }
    const sourceHash = await hashExactSource(rawSource, parserOptions(options).sha256);
    let state;
    try {
      state = JSON.parse(rawSource);
    } catch (cause) {
      throw legacyError(
        ERROR_CODES.LEGACY_JSON_INVALID,
        'legacy source is not valid JSON',
        { sourceHash },
        cause
      );
    }
    if (!isPlainObject(state)) {
      throw legacyError(
        ERROR_CODES.LEGACY_STRUCTURE_INVALID,
        'legacy JSON root must be an object',
        { sourceHash, actualType: Array.isArray(state) ? 'array' : typeof state }
      );
    }
    return deepFreeze({
      sourceKey: SOURCE_KEY,
      sourceHash,
      rawSource,
      parsedState: immutableCopy(state),
    });
  }

  function diagnostic(target, code, path, message, context) {
    target.push({ code, path, message, context: deepClone(context || {}) });
  }

  function safeInteger(value) {
    return Number.isSafeInteger(value);
  }

  function safeNonNegative(value) {
    return safeInteger(value) && value >= 0;
  }

  function safePositive(value) {
    return safeInteger(value) && value > 0;
  }

  function validCivilDate(value) {
    try {
      assertCivilDate(value);
      return true;
    } catch (_) {
      return false;
    }
  }

  function validPeriod(value) {
    try {
      assertPeriod(value);
      return true;
    } catch (_) {
      return false;
    }
  }

  function numericLegacyId(value) {
    if (safePositive(value)) return value;
    if (typeof value === 'string' && /^(?:0*[1-9]\d*)$/.test(value)) {
      const normalized = Number(value);
      return safePositive(normalized) ? normalized : null;
    }
    return null;
  }

  function unknownFields(record, allowed, path, warnings) {
    if (!isPlainObject(record)) return;
    Object.keys(record).forEach((field) => {
      if (!allowed.has(field)) {
        diagnostic(
          warnings,
          'LEGACY_UNKNOWN_FIELD',
          `${path}.${field}`,
          'unknown legacy field will not be converted into a canonical field',
          { field }
        );
      }
    });
  }

  function requireCollection(state, field, warnings, blockers) {
    if (!hasOwn(state, field)) {
      diagnostic(
        warnings,
        'LEGACY_STRUCTURE_INCOMPLETE',
        field,
        'legacy collection is absent',
        { field }
      );
      return undefined;
    }
    if (!Array.isArray(state[field])) {
      diagnostic(
        blockers,
        ERROR_CODES.LEGACY_STRUCTURE_INVALID,
        field,
        'legacy collection must be an array',
        { field, actualType: typeof state[field] }
      );
      return undefined;
    }
    return state[field];
  }

  function validateId(record, path, seenIds, warnings, blockers) {
    if (!isPlainObject(record)) {
      diagnostic(
        blockers,
        ERROR_CODES.LEGACY_STRUCTURE_INVALID,
        path,
        'legacy entity must be an object'
      );
      return null;
    }
    const id = numericLegacyId(record.id);
    if (id === null) {
      diagnostic(
        blockers,
        ERROR_CODES.LEGACY_STRUCTURE_INVALID,
        `${path}.id`,
        'legacy entity ID must be a positive safe integer',
        { id: record.id }
      );
      return null;
    }
    if (seenIds.has(id)) {
      diagnostic(
        blockers,
        ERROR_CODES.LEGACY_AMBIGUITY,
        `${path}.id`,
        'legacy entity ID is duplicated',
        { id, firstPath: seenIds.get(id) }
      );
    } else {
      seenIds.set(id, path);
    }
    void warnings;
    return id;
  }

  function validateName(value, path, blockers) {
    if (typeof value !== 'string' || value.trim() === '') {
      diagnostic(
        blockers,
        ERROR_CODES.LEGACY_STRUCTURE_INVALID,
        path,
        'legacy name must be a non-empty string',
        { value }
      );
      return false;
    }
    return true;
  }

  function validateMoney(value, path, blockers, options) {
    const settings = options || {};
    const valid = safeInteger(value) &&
      (settings.allowNegative === true || value >= 0) &&
      (settings.allowZero === true || value !== 0);
    if (!valid) {
      diagnostic(
        blockers,
        ERROR_CODES.LEGACY_STRUCTURE_INVALID,
        path,
        'legacy monetary value is invalid',
        { value }
      );
    }
    return valid;
  }

  function validateEntities(state, warnings, blockers) {
    const seenIds = new Map();
    const ids = {
      accounts: new Set(),
      debts: new Set(),
      wallets: new Set(),
      budget: new Set(),
      varCategories: new Set(),
    };
    const definitions = [
      ['accounts', 'account'],
      ['debts', 'debt'],
      ['wallets', 'wallet'],
      ['budget', 'budget'],
      ['varCategories', 'category'],
    ];

    definitions.forEach(([collectionName, kind]) => {
      const records = requireCollection(state, collectionName, warnings, blockers);
      if (!records) return;
      records.forEach((record, index) => {
        const path = `${collectionName}[${index}]`;
        const id = validateId(record, path, seenIds, warnings, blockers);
        if (id !== null) ids[collectionName].add(id);
        if (!isPlainObject(record)) return;
        unknownFields(record, KNOWN_FIELDS[kind], path, warnings);
        validateName(record.name, `${path}.name`, blockers);

        if (kind === 'account') {
          if (!['bank', 'cash'].includes(record.type)) {
            diagnostic(
              blockers,
              ERROR_CODES.LEGACY_STRUCTURE_INVALID,
              `${path}.type`,
              'legacy account type is invalid',
              { type: record.type }
            );
          }
          if (record.bank !== undefined && typeof record.bank !== 'string') {
            diagnostic(blockers, ERROR_CODES.LEGACY_STRUCTURE_INVALID, `${path}.bank`,
              'legacy account institution must be a string');
          }
          validateMoney(record.balance, `${path}.balance`, blockers, {
            allowNegative: true,
            allowZero: true,
          });
        } else if (kind === 'wallet') {
          validateMoney(record.balance, `${path}.balance`, blockers, { allowZero: true });
          validateMoney(record.monthly, `${path}.monthly`, blockers, { allowZero: true });
          validateMoney(record.goal, `${path}.goal`, blockers, { allowZero: true });
          if (record.emoji !== undefined && typeof record.emoji !== 'string') {
            diagnostic(blockers, ERROR_CODES.LEGACY_STRUCTURE_INVALID, `${path}.emoji`,
              'legacy wallet emoji must be a string');
          }
          if (record.bank !== undefined && typeof record.bank !== 'string') {
            diagnostic(blockers, ERROR_CODES.LEGACY_STRUCTURE_INVALID, `${path}.bank`,
              'legacy wallet institution must be a string');
          }
        } else if (kind === 'debt') {
          validateMoney(record.total, `${path}.total`, blockers, { allowZero: true });
          validateMoney(record.paid, `${path}.paid`, blockers, { allowZero: true });
          validateMoney(record.monthly, `${path}.monthly`, blockers, { allowZero: true });
          if (safeInteger(record.total) && safeInteger(record.paid) && record.paid > record.total) {
            diagnostic(
              blockers,
              ERROR_CODES.LEGACY_AMBIGUITY,
              path,
              'legacy debt paid amount exceeds total amount',
              { total: record.total, paid: record.paid }
            );
          }
          if (!['activa', 'pausada', 'pagada'].includes(record.status)) {
            diagnostic(blockers, ERROR_CODES.LEGACY_STRUCTURE_INVALID, `${path}.status`,
              'legacy debt status is unknown', { status: record.status });
          }
          if (
            record.dueDate !== null && record.dueDate !== '' &&
            !validCivilDate(record.dueDate)
          ) {
            diagnostic(blockers, ERROR_CODES.LEGACY_STRUCTURE_INVALID, `${path}.dueDate`,
              'legacy debt dueDate is invalid', { dueDate: record.dueDate });
          }
        } else if (kind === 'budget') {
          validateMoney(record.amount, `${path}.amount`, blockers, { allowZero: true });
        }
      });
    });
    return ids;
  }

  function validateSettings(state, warnings, blockers) {
    if (!hasOwn(state, 'settings')) {
      diagnostic(warnings, 'LEGACY_STRUCTURE_INCOMPLETE', 'settings',
        'legacy settings are absent');
      return;
    }
    if (!isPlainObject(state.settings)) {
      diagnostic(blockers, ERROR_CODES.LEGACY_STRUCTURE_INVALID, 'settings',
        'legacy settings must be an object');
      return;
    }
    unknownFields(state.settings, KNOWN_FIELDS.settings, 'settings', warnings);
    validateMoney(state.settings.salary, 'settings.salary', blockers, { allowZero: true });
  }

  function salaryLike(expense) {
    const text = `${expense.description || ''} ${expense.category || ''}`
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
    return /\b(sueldo|salario|salary)\b/.test(text);
  }

  function validateMonthlyRecord(record, kind, path, month, ids, warnings, blockers, options) {
    const settings = options || {};
    const relationDiagnostics = settings.strictRelations === false ? warnings : blockers;
    if (!isPlainObject(record)) {
      diagnostic(blockers, ERROR_CODES.LEGACY_STRUCTURE_INVALID, path,
        'legacy monthly record must be an object');
      return;
    }
    unknownFields(record, KNOWN_FIELDS[kind], path, warnings);
    validateMoney(record.amount, `${path}.amount`, blockers);
    if (!validCivilDate(record.date)) {
      diagnostic(blockers, ERROR_CODES.LEGACY_STRUCTURE_INVALID, `${path}.date`,
        'legacy operation date is invalid', { date: record.date });
    } else if (month && record.date.slice(0, 7) !== month) {
      diagnostic(blockers, ERROR_CODES.LEGACY_STRUCTURE_INVALID, `${path}.date`,
        'legacy operation date is outside its month', { date: record.date, month });
    }

    if (kind === 'expense') {
      if (!['income', 'expense'].includes(record.type)) {
        diagnostic(blockers, ERROR_CODES.LEGACY_AMBIGUITY, `${path}.type`,
          'legacy operation type is unknown', { type: record.type });
        return;
      }
      const accountId = numericLegacyId(record.account);
      if (record.type === 'income') {
        if (accountId === null || !ids.accounts.has(accountId)) {
          diagnostic(relationDiagnostics, ERROR_CODES.LEGACY_RELATION_MISSING, `${path}.account`,
            'legacy income does not reference an existing account',
            { account: record.account });
        }
      } else if (record.account === undefined || record.account === null || record.account === '') {
        diagnostic(warnings, ERROR_CODES.LEGACY_RELATION_MISSING, `${path}.account`,
          'legacy variable expense has no source account and will remain legacy-only');
      } else if (accountId === null || !ids.accounts.has(accountId)) {
        diagnostic(relationDiagnostics, ERROR_CODES.LEGACY_RELATION_MISSING, `${path}.account`,
          'legacy variable expense references a missing account', { account: record.account });
      }
    } else if (kind === 'debtPayment') {
      const debtId = numericLegacyId(record.debtId);
      if (debtId === null || !ids.debts.has(debtId)) {
        diagnostic(relationDiagnostics, ERROR_CODES.LEGACY_RELATION_MISSING, `${path}.debtId`,
          'legacy debt payment references a missing debt', { debtId: record.debtId });
      }
      const accountId = numericLegacyId(record.accountId);
      if (record.accountId === undefined || record.accountId === null || record.accountId === '') {
        diagnostic(warnings, ERROR_CODES.LEGACY_RELATION_MISSING, `${path}.accountId`,
          'legacy debt payment has no source account and will remain legacy-only');
      } else if (accountId === null || !ids.accounts.has(accountId)) {
        diagnostic(relationDiagnostics, ERROR_CODES.LEGACY_RELATION_MISSING, `${path}.accountId`,
          'legacy debt payment references a missing account', { accountId: record.accountId });
      }
    } else if (kind === 'savingDeposit') {
      const walletId = numericLegacyId(record.walletId);
      if (walletId === null || !ids.wallets.has(walletId)) {
        diagnostic(relationDiagnostics, ERROR_CODES.LEGACY_RELATION_MISSING, `${path}.walletId`,
          'legacy saving deposit references a missing wallet', { walletId: record.walletId });
      }
      const rawAccountId = hasOwn(record, 'accountId') ? record.accountId : record.fromAccountId;
      const accountId = numericLegacyId(rawAccountId);
      if (rawAccountId === undefined || rawAccountId === null || rawAccountId === '') {
        diagnostic(warnings, ERROR_CODES.LEGACY_RELATION_MISSING, `${path}.accountId`,
          'legacy saving deposit has no demonstrable origin and will remain legacy-only');
      } else if (accountId === null || !ids.accounts.has(accountId)) {
        diagnostic(relationDiagnostics, ERROR_CODES.LEGACY_RELATION_MISSING, `${path}.accountId`,
          'legacy saving deposit references a missing account', { accountId: rawAccountId });
      }
    } else if (kind === 'fixedPayment') {
      const budgetId = numericLegacyId(record.budgetId);
      if (budgetId === null || !ids.budget.has(budgetId)) {
        diagnostic(relationDiagnostics, ERROR_CODES.LEGACY_RELATION_MISSING, `${path}.budgetId`,
          'legacy fixed payment references a missing budget item', { budgetId: record.budgetId });
      }
      const accountId = numericLegacyId(record.accountId);
      if (record.accountId === undefined || record.accountId === null || record.accountId === '') {
        diagnostic(warnings, ERROR_CODES.LEGACY_RELATION_MISSING, `${path}.accountId`,
          'legacy fixed payment has no source account and will remain legacy-only');
      } else if (accountId === null || !ids.accounts.has(accountId)) {
        diagnostic(relationDiagnostics, ERROR_CODES.LEGACY_RELATION_MISSING, `${path}.accountId`,
          'legacy fixed payment references a missing account', { accountId: record.accountId });
      }
    }
  }

  function validateMonth(monthState, path, ids, warnings, blockers, options) {
    const settings = options || {};
    if (!isPlainObject(monthState)) {
      diagnostic(blockers, ERROR_CODES.LEGACY_STRUCTURE_INVALID, path,
        'legacy month must be an object');
      return;
    }
    unknownFields(monthState, KNOWN_FIELDS.month, path, warnings);
    const month = monthState.month;
    if (!validPeriod(month)) {
      diagnostic(blockers, ERROR_CODES.LEGACY_STRUCTURE_INVALID, `${path}.month`,
        'legacy month identifier is invalid', { month });
    }
    if (settings.active && hasOwn(monthState, 'salary')) {
      diagnostic(blockers, ERROR_CODES.LEGACY_AMBIGUITY, `${path}.salary`,
        'active legacy month contains a salary snapshot that could duplicate salary');
    }
    if (settings.history && !hasOwn(monthState, 'salary')) {
      diagnostic(warnings, 'LEGACY_HISTORY_SALARY_MISSING', `${path}.salary`,
        'historical month has no salary snapshot and cannot prove total income');
    }
    if (hasOwn(monthState, 'salary')) {
      validateMoney(monthState.salary, `${path}.salary`, blockers, { allowZero: true });
    }
    if (
      hasOwn(monthState, 'closedAt') &&
      (typeof monthState.closedAt !== 'string' || !Number.isFinite(Date.parse(monthState.closedAt)))
    ) {
      diagnostic(blockers, ERROR_CODES.LEGACY_STRUCTURE_INVALID, `${path}.closedAt`,
        'legacy close timestamp is invalid', { closedAt: monthState.closedAt });
    }

    const kinds = {
      expenses: 'expense',
      pagosDeuda: 'debtPayment',
      aportesAhorro: 'savingDeposit',
      gastosFijosPagados: 'fixedPayment',
    };
    MONTHLY_COLLECTIONS.forEach((collectionName) => {
      if (!hasOwn(monthState, collectionName)) {
        diagnostic(warnings, 'LEGACY_MONTH_COLLECTION_MISSING', `${path}.${collectionName}`,
          'legacy monthly collection is absent');
        return;
      }
      if (!Array.isArray(monthState[collectionName])) {
        diagnostic(blockers, ERROR_CODES.LEGACY_STRUCTURE_INVALID, `${path}.${collectionName}`,
          'legacy monthly collection must be an array');
        return;
      }
      monthState[collectionName].forEach((record, index) => {
        const recordPath = `${path}.${collectionName}[${index}]`;
        validateMonthlyRecord(
          record,
          kinds[collectionName],
          recordPath,
          validPeriod(month) ? month : null,
          ids,
          warnings,
          blockers,
          { strictRelations: settings.active === true }
        );
        if (
          collectionName === 'expenses' &&
          isPlainObject(record) && record.type === 'income' &&
          settings.salaryReference > 0 && salaryLike(record)
        ) {
          diagnostic(blockers, ERROR_CODES.LEGACY_AMBIGUITY, recordPath,
            'salary-like income may duplicate the configured salary');
        }
      });
    });
  }

  function validateMonthlyIds(state, warnings, blockers) {
    const seen = new Map();
    const months = [];
    if (isPlainObject(state.activeMonth)) {
      MONTHLY_COLLECTIONS.forEach((collectionName) => {
        if (Array.isArray(state.activeMonth[collectionName])) {
          months.push([`activeMonth.${collectionName}`, state.activeMonth[collectionName]]);
        } else if (collectionName === 'expenses' && Array.isArray(state.expenses)) {
          months.push(['expenses', state.expenses]);
        }
      });
    } else if (Array.isArray(state.expenses)) {
      months.push(['expenses', state.expenses]);
    }
    if (Array.isArray(state.monthlyHistory)) {
      state.monthlyHistory.forEach((month, index) => {
        if (!isPlainObject(month)) return;
        MONTHLY_COLLECTIONS.forEach((collectionName) => {
          if (Array.isArray(month[collectionName])) {
            months.push([
              `monthlyHistory[${index}].${collectionName}`,
              month[collectionName],
            ]);
          }
        });
      });
    }
    months.forEach(([basePath, records]) => records.forEach((record, index) => {
      if (!isPlainObject(record) || !hasOwn(record, 'id')) return;
      const id = numericLegacyId(record.id);
      const path = `${basePath}[${index}].id`;
      if (id === null) {
        diagnostic(blockers, ERROR_CODES.LEGACY_STRUCTURE_INVALID, path,
          'legacy transaction ID must be a positive safe integer', { id: record.id });
      } else if (seen.has(id)) {
        diagnostic(blockers, ERROR_CODES.LEGACY_AMBIGUITY, path,
          'legacy transaction ID is duplicated', { id, firstPath: seen.get(id) });
      } else {
        seen.set(id, path);
      }
    }));
    void warnings;
  }

  function classifyLegacyState(parsedSource) {
    const source = parsedSource && parsedSource.parsedState !== undefined
      ? parsedSource
      : { parsedState: parsedSource };
    const state = source.parsedState;
    if (!isPlainObject(state)) {
      throw legacyError(
        ERROR_CODES.LEGACY_STRUCTURE_INVALID,
        'parsed legacy state must be an object',
        { actualType: Array.isArray(state) ? 'array' : typeof state }
      );
    }
    const warnings = [];
    const blockers = [];

    Object.keys(state).forEach((field) => {
      if (!KNOWN_TOP_LEVEL_FIELDS.has(field)) {
        diagnostic(warnings, 'LEGACY_UNKNOWN_FIELD', field,
          'unknown top-level field will be retained only in legacy payload', { field });
      }
    });
    validateSettings(state, warnings, blockers);
    const ids = validateEntities(state, warnings, blockers);

    requireCollection(state, 'monthlyHistory', warnings, blockers);
    if (hasOwn(state, 'nextId') && !safePositive(state.nextId)) {
      diagnostic(blockers, ERROR_CODES.LEGACY_STRUCTURE_INVALID, 'nextId',
        'legacy nextId must be a positive safe integer', { nextId: state.nextId });
    } else if (!hasOwn(state, 'nextId')) {
      diagnostic(warnings, 'LEGACY_STRUCTURE_INCOMPLETE', 'nextId', 'legacy nextId is absent');
    }

    const activePresent = hasOwn(state, 'activeMonth');
    if (!activePresent) {
      diagnostic(warnings, 'LEGACY_ACTIVE_MONTH_MISSING', 'activeMonth',
        'active month is absent; active period cannot be demonstrated');
      if (hasOwn(state, 'expenses') && !Array.isArray(state.expenses)) {
        diagnostic(blockers, ERROR_CODES.LEGACY_STRUCTURE_INVALID, 'expenses',
          'legacy top-level expenses alias must be an array');
      } else if (Array.isArray(state.expenses)) {
        state.expenses.forEach((record, index) => {
          const recordPath = `expenses[${index}]`;
          validateMonthlyRecord(
            record,
            'expense',
            recordPath,
            null,
            ids,
            warnings,
            blockers,
            { strictRelations: true }
          );
          if (
            isPlainObject(record) && record.type === 'income' &&
            isPlainObject(state.settings) && safeNonNegative(state.settings.salary) &&
            state.settings.salary > 0 && salaryLike(record)
          ) {
            diagnostic(blockers, ERROR_CODES.LEGACY_AMBIGUITY, recordPath,
              'salary-like income may duplicate the configured salary');
          }
        });
      }
    } else if (!isPlainObject(state.activeMonth)) {
      diagnostic(blockers, ERROR_CODES.LEGACY_STRUCTURE_INVALID, 'activeMonth',
        'legacy activeMonth must be an object');
    } else {
      validateMonth(state.activeMonth, 'activeMonth', ids, warnings, blockers, {
        active: true,
        salaryReference: isPlainObject(state.settings) && safeNonNegative(state.settings.salary)
          ? state.settings.salary
          : 0,
      });
      if (hasOwn(state, 'expenses')) {
        if (!Array.isArray(state.expenses)) {
          diagnostic(blockers, ERROR_CODES.LEGACY_STRUCTURE_INVALID, 'expenses',
            'legacy top-level expenses alias must be an array');
        } else if (
          Array.isArray(state.activeMonth.expenses) &&
          !structurallyEquivalent(state.expenses, state.activeMonth.expenses)
        ) {
          diagnostic(blockers, ERROR_CODES.LEGACY_ALIAS_MISMATCH, 'expenses',
            'top-level expenses alias differs from activeMonth.expenses');
        } else if (!Array.isArray(state.activeMonth.expenses)) {
          state.expenses.forEach((record, index) => {
            const recordPath = `expenses[${index}]`;
            validateMonthlyRecord(
              record,
              'expense',
              recordPath,
              validPeriod(state.activeMonth.month) ? state.activeMonth.month : null,
              ids,
              warnings,
              blockers,
              { strictRelations: true }
            );
            if (
              isPlainObject(record) && record.type === 'income' &&
              isPlainObject(state.settings) && safeNonNegative(state.settings.salary) &&
              state.settings.salary > 0 && salaryLike(record)
            ) {
              diagnostic(blockers, ERROR_CODES.LEGACY_AMBIGUITY, recordPath,
                'salary-like income may duplicate the configured salary');
            }
          });
        }
      }
    }

    if (Array.isArray(state.monthlyHistory)) {
      state.monthlyHistory.forEach((month, index) => {
        validateMonth(month, `monthlyHistory[${index}]`, ids, warnings, blockers, {
          history: true,
          salaryReference: isPlainObject(state.settings) && safeNonNegative(state.settings.salary)
            ? state.settings.salary
            : 0,
        });
      });
    }
    validateMonthlyIds(state, warnings, blockers);

    const restricted = warnings.some((warning) => [
      'LEGACY_STRUCTURE_INCOMPLETE',
      'LEGACY_ACTIVE_MONTH_MISSING',
      'LEGACY_HISTORY_SALARY_MISSING',
      'LEGACY_MONTH_COLLECTION_MISSING',
      ERROR_CODES.LEGACY_RELATION_MISSING,
    ].includes(warning.code));
    const classification = blockers.length > 0
      ? 'blocked'
      : restricted
        ? 'restricted'
        : 'migratable';
    return immutableCopy({ classification, warnings, blockers });
  }

  function recordsOrEmpty(state, field) {
    return Array.isArray(state[field]) ? state[field] : [];
  }

  function activeExpenses(state) {
    if (isPlainObject(state.activeMonth) && Array.isArray(state.activeMonth.expenses)) {
      return state.activeMonth.expenses;
    }
    return Array.isArray(state.expenses) ? state.expenses : [];
  }

  function makeUuidGenerator(sourceHash, createDeterministicUuid) {
    const uuidFunction = createDeterministicUuid || ((name) => deterministicUuid(
      PERITA_MIGRATION_NAMESPACE_UUID,
      name
    ));
    if (typeof uuidFunction !== 'function') {
      throw legacyError(
        ERROR_CODES.LEGACY_STRUCTURE_INVALID,
        'a deterministic UUID function is required',
        { field: 'createDeterministicUuid' }
      );
    }
    return (entityKind, legacyPath, stableKey) => {
      const name = `${sourceHash}:${entityKind}:${legacyPath}:${stableKey}`;
      try {
        return assertUuid(uuidFunction(name), { field: 'deterministicUuid' });
      } catch (cause) {
        throw legacyError(
          ERROR_CODES.LEGACY_STRUCTURE_INVALID,
          'deterministic UUID generation failed',
          { entityKind, legacyPath, stableKey },
          cause
        );
      }
    };
  }

  function proposedIdMapEntry(makeUuid, sourceHash, entityKind, legacyPath, stableKey, targetId) {
    return {
      id: makeUuid('legacy_id_map', legacyPath, stableKey),
      sourceHash,
      entityKind,
      legacyPath,
      stableKey: String(stableKey),
      targetId,
    };
  }

  function mapPermanentEntities(state, sourceHash, makeUuid) {
    const idMap = [];
    const mapCollection = (field, entityKind, mapper) => recordsOrEmpty(state, field).map(
      (record, index) => {
        const legacyPath = `${field}[${index}]`;
        const stableKey = record.id;
        const id = makeUuid(entityKind, legacyPath, stableKey);
        idMap.push(proposedIdMapEntry(
          makeUuid,
          sourceHash,
          entityKind,
          legacyPath,
          stableKey,
          id
        ));
        return mapper(record, id, legacyPath);
      }
    );

    return {
      idMap,
      accounts: mapCollection('accounts', 'account', (record, id) => ({
        id,
        name: record.name,
        type: record.type,
        institution: record.bank || '',
        openingBalance: record.balance,
        currentBalance: record.balance,
        status: 'active',
        legacyId: record.id,
      })),
      savingsGoals: mapCollection('wallets', 'savings_goal', (record, id) => ({
        id,
        name: record.name,
        emoji: record.emoji || '',
        institution: record.bank || '',
        targetAmount: record.goal,
        openingBalance: record.balance,
        currentBalance: record.balance,
        plannedMonthlyAmount: record.monthly,
        lifecycleStatus: 'active',
        legacyId: record.id,
      })),
      debts: mapCollection('debts', 'debt', (record, id) => ({
        id,
        name: record.name,
        totalAmount: record.total,
        paidAmount: record.paid,
        openingOutstanding: record.total - record.paid,
        outstandingAmount: record.total - record.paid,
        dueDate: record.dueDate || null,
        monthlyPaymentAmount: record.monthly,
        paymentStatus: record.status === 'pagada' ? 'paid' : 'active',
        legacyStatus: record.status,
        compatibility: { paused: record.status === 'pausada' },
        legacyId: record.id,
      })),
      categories: mapCollection('varCategories', 'category', (record, id) => ({
        id,
        name: record.name,
        status: 'active',
        legacyId: record.id,
      })),
      fixedExpenseTemplates: mapCollection('budget', 'fixed_expense_template', (record, id) => ({
        id,
        name: record.name,
        referenceAmount: record.amount,
        status: 'active',
        legacyId: record.id,
      })),
    };
  }

  function mapPeriod(state, sourceHash, makeUuid, idMap) {
    if (!isPlainObject(state.activeMonth) || !validPeriod(state.activeMonth.month)) return null;
    const legacyPath = 'activeMonth';
    const periodId = makeUuid('period', legacyPath, state.activeMonth.month);
    idMap.push(proposedIdMapEntry(
      makeUuid,
      sourceHash,
      'period',
      legacyPath,
      state.activeMonth.month,
      periodId
    ));
    return {
      id: periodId,
      periodKey: state.activeMonth.month,
      status: 'open',
      plannedSalaryAmount: isPlainObject(state.settings) ? state.settings.salary : null,
    };
  }

  function makeOpenings(period, entities, makeUuid) {
    if (!period) return [];
    const targets = [
      ['accounts', 'account', 'openingBalance'],
      ['savingsGoals', 'savings_goal', 'openingBalance'],
      ['debts', 'debt', 'openingOutstanding'],
    ];
    return targets.flatMap(([field, targetType, amountField]) => entities[field].map((entity) => ({
      id: makeUuid('period_opening', `activeMonth.${field}:${entity.id}`, period.periodKey),
      periodId: period.id,
      targetType,
      targetId: entity.id,
      openingAmount: entity[amountField],
      origin: 'migration_cutover',
    })));
  }

  function mapLegacyEntries(state, period, makeUuid) {
    const entries = [];
    const addRecords = (records, basePath, periodId, periodKey, entryKind) => {
      records.forEach((record, index) => {
        const legacyPath = `${basePath}[${index}]`;
        entries.push({
          id: makeUuid('legacy_entry', legacyPath, record.id === undefined ? index : record.id),
          periodId,
          periodKey,
          legacyPath,
          entryKind,
          payload: deepClone(record),
        });
      });
    };

    if (isPlainObject(state.activeMonth) && period) {
      MONTHLY_COLLECTIONS.forEach((collectionName) => {
        if (Array.isArray(state.activeMonth[collectionName])) {
          addRecords(
            state.activeMonth[collectionName],
            `activeMonth.${collectionName}`,
            period.id,
            period.periodKey,
            collectionName
          );
        }
      });
      if (!Array.isArray(state.activeMonth.expenses) && Array.isArray(state.expenses)) {
        addRecords(state.expenses, 'expenses', period.id, period.periodKey, 'expenses');
      }
    } else if (Array.isArray(state.expenses)) {
      addRecords(state.expenses, 'expenses', null, null, 'expenses');
    }
    return entries;
  }

  function mapLegacySnapshots(state, makeUuid) {
    return recordsOrEmpty(state, 'monthlyHistory').map((month, index) => ({
      id: makeUuid('legacy_snapshot', `monthlyHistory[${index}]`, month.month || index),
      periodKey: validPeriod(month.month) ? month.month : null,
      salary: hasOwn(month, 'salary') ? month.salary : null,
      incomplete: !hasOwn(month, 'salary'),
      data: deepClone(month),
    }));
  }

  function sumSafe(records, field) {
    let total = 0;
    for (const record of records) {
      const next = total + record[field];
      if (!Number.isSafeInteger(next)) return null;
      total = next;
    }
    return total;
  }

  function reconciliationFor(state, entities) {
    const legacyAccounts = sumSafe(recordsOrEmpty(state, 'accounts'), 'balance');
    const targetAccounts = sumSafe(entities.accounts, 'openingBalance');
    const legacySavings = sumSafe(recordsOrEmpty(state, 'wallets'), 'balance');
    const targetSavings = sumSafe(entities.savingsGoals, 'openingBalance');
    let legacyDebt = 0;
    for (const debt of recordsOrEmpty(state, 'debts')) {
      if (legacyDebt === null) break;
      const outstanding = debt.total - debt.paid;
      const next = legacyDebt + outstanding;
      legacyDebt = Number.isSafeInteger(outstanding) && Number.isSafeInteger(next) ? next : null;
    }
    const targetDebt = sumSafe(entities.debts, 'openingOutstanding');
    const accountsMatch = legacyAccounts !== null && legacyAccounts === targetAccounts;
    const savingsMatch = legacySavings !== null && legacySavings === targetSavings;
    const debtsMatch = legacyDebt !== null && legacyDebt === targetDebt;
    return {
      accounts: { legacyTotal: legacyAccounts, proposedTotal: targetAccounts, matches: accountsMatch },
      savingsGoals: { legacyTotal: legacySavings, proposedTotal: targetSavings, matches: savingsMatch },
      debts: { legacyTotal: legacyDebt, proposedTotal: targetDebt, matches: debtsMatch },
      matches: accountsMatch && savingsMatch && debtsMatch,
    };
  }

  async function createMigrationDryRun(rawSource, options) {
    const settings = options || {};
    const parsed = await parseLegacySource(rawSource, settings);
    const analysis = classifyLegacyState(parsed);
    const state = parsed.parsedState;
    const makeUuid = makeUuidGenerator(parsed.sourceHash, settings.createDeterministicUuid);

    let entities = {
      accounts: [],
      savingsGoals: [],
      debts: [],
      categories: [],
      fixedExpenseTemplates: [],
    };
    let period = null;
    let openings = [];
    let legacyEntries = [];
    let legacySnapshots = [];
    let legacyIdMap = [];
    let reconciliation = {
      accounts: { legacyTotal: null, proposedTotal: null, matches: false },
      savingsGoals: { legacyTotal: null, proposedTotal: null, matches: false },
      debts: { legacyTotal: null, proposedTotal: null, matches: false },
      matches: false,
    };
    const blockers = deepClone(analysis.blockers);

    if (analysis.classification !== 'blocked') {
      const mapped = mapPermanentEntities(state, parsed.sourceHash, makeUuid);
      legacyIdMap = mapped.idMap;
      entities = {
        accounts: mapped.accounts,
        savingsGoals: mapped.savingsGoals,
        debts: mapped.debts,
        categories: mapped.categories,
        fixedExpenseTemplates: mapped.fixedExpenseTemplates,
      };
      period = mapPeriod(state, parsed.sourceHash, makeUuid, legacyIdMap);
      openings = makeOpenings(period, entities, makeUuid);
      legacyEntries = mapLegacyEntries(state, period, makeUuid);
      legacySnapshots = mapLegacySnapshots(state, makeUuid);
      reconciliation = reconciliationFor(state, entities);
      if (!reconciliation.matches) {
        diagnostic(
          blockers,
          ERROR_CODES.LEGACY_AMBIGUITY,
          'reconciliation',
          'legacy and proposed monetary totals do not reconcile',
          reconciliation
        );
      }
    }

    const classification = blockers.length > 0 ? 'blocked' : analysis.classification;
    const counts = {
      legacy: {
        accounts: recordsOrEmpty(state, 'accounts').length,
        wallets: recordsOrEmpty(state, 'wallets').length,
        debts: recordsOrEmpty(state, 'debts').length,
        budget: recordsOrEmpty(state, 'budget').length,
        varCategories: recordsOrEmpty(state, 'varCategories').length,
        activeExpenses: activeExpenses(state).length,
        monthlyHistory: recordsOrEmpty(state, 'monthlyHistory').length,
      },
      proposed: {
        accounts: entities.accounts.length,
        savingsGoals: entities.savingsGoals.length,
        debts: entities.debts.length,
        categories: entities.categories.length,
        fixedExpenseTemplates: entities.fixedExpenseTemplates.length,
        periods: period ? 1 : 0,
        periodOpenings: openings.length,
        legacyEntries: legacyEntries.length,
        legacySnapshots: legacySnapshots.length,
        movements: 0,
      },
    };

    return immutableCopy({
      sourceKey: SOURCE_KEY,
      sourceHash: parsed.sourceHash,
      mapperVersion: MAPPER_VERSION,
      classification,
      counts,
      proposedEntities: {
        periods: period ? [period] : [],
        ...entities,
      },
      proposedPeriodOpenings: openings,
      proposedMovements: [],
      proposedLegacyEntries: legacyEntries,
      proposedLegacySnapshots: legacySnapshots,
      proposedLegacyIdMap: legacyIdMap,
      warnings: analysis.warnings,
      blockers,
      reconciliation,
    });
  }

  function createPeritaLegacy(options) {
    const settings = options || {};
    return Object.freeze({
      parseLegacySource: (rawSource) => parseLegacySource(rawSource, settings),
      classifyLegacyState,
      createMigrationDryRun: (rawSource, overrides) => createMigrationDryRun(rawSource, {
        ...settings,
        ...(overrides || {}),
      }),
    });
  }

  return Object.freeze({
    SOURCE_KEY,
    MAPPER_VERSION,
    CLASSIFICATIONS,
    LegacyError,
    createPeritaLegacy,
    parseLegacySource,
    classifyLegacyState,
    createMigrationDryRun,
  });
});
