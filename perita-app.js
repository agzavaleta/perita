/* perita-app.js — browser/application integration for Perita V1.1.0 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./perita-contracts.js'),
      require('./perita-indexeddb.js'),
      require('./perita-domain.js'),
      require('./perita-runtime.js'),
      require('./perita-integrity.js'),
      require('./perita-domain-commands.js'),
      require('./perita-migration.js'),
      require('./perita-backup.js')
    );
  } else {
    root.PeritaApp = factory(
      root.PeritaContracts,
      root.PeritaIndexedDb,
      root.PeritaDomain,
      root.PeritaRuntime,
      root.PeritaIntegrity,
      root.PeritaDomainCommands,
      root.PeritaMigration,
      root.PeritaBackup
    );
  }
})(typeof self !== 'undefined' ? self : this, function (
  Contracts,
  IndexedDb,
  Domain,
  Runtime,
  Integrity,
  DomainCommands,
  Migration,
  Backup
) {
  'use strict';

  const REQUIRED = [Contracts, IndexedDb, Domain, Runtime, Integrity, DomainCommands, Migration, Backup];
  if (REQUIRED.some((dependency) => !dependency)) {
    throw new Error('Perita V1.1.0 application dependencies are incomplete');
  }

  const APP_VERSION = '1.1.0';
  const LEGACY_KEY = 'perita_v1';
  const TAB_ID_SESSION_KEY = 'perita_v110_tab_id';
  const LEASE_DURATION_MS = 15000;
  const HEARTBEAT_INTERVAL_MS = 5000;
  const READ_STORES = Object.freeze([
    'system', 'financialSettings', 'periods', 'periodOpenings', 'accounts',
    'savingsGoals', 'debts', 'categories', 'fixedExpenseTemplates',
    'fixedExpenseInstances', 'operations', 'movements', 'operationRevisions',
    'auditEvents', 'periodSnapshots', 'legacyEntries', 'integrityReports',
    'migrations', 'commits',
  ]);

  const COMMANDS = Object.freeze({
    'financial-settings.update-reference-salary': ['financialSettings', 'updateReferenceSalary'],
    'period.update-planning': ['period', 'updatePlanning'],
    'period.close-and-open-next': ['period', 'closeAndOpenNext'],
    'account.create': ['account', 'create'],
    'account.update': ['account', 'update'],
    'account.deactivate': ['account', 'deactivate'],
    'category.create': ['category', 'create'],
    'category.update': ['category', 'update'],
    'category.deactivate': ['category', 'deactivate'],
    'fixed-expense-template.create': ['fixedExpenseTemplate', 'create'],
    'fixed-expense-template.update': ['fixedExpenseTemplate', 'update'],
    'fixed-expense-template.deactivate': ['fixedExpenseTemplate', 'deactivate'],
    'fixed-expense-instance.update-planned-amount': ['fixedExpenseInstance', 'updatePlannedAmount'],
    'savings-goal.create': ['savingsGoal', 'create'],
    'savings-goal.update': ['savingsGoal', 'update'],
    'savings-goal.close': ['savingsGoal', 'close'],
    'debt.create': ['debt', 'create'],
    'debt.update-name-and-due-date': ['debt', 'updateNameAndDueDate'],
    'balance-adjustment.create': ['balanceAdjustment', 'create'],
    'balance-adjustment.edit': ['balanceAdjustment', 'edit'],
    'operation.void': ['operation', 'void'],
    'salary-receipt.create': ['salaryReceipt', 'create'],
    'salary-receipt.edit': ['salaryReceipt', 'edit'],
    'salary-receipt.void': ['salaryReceipt', 'void'],
    'additional-income.create': ['additionalIncome', 'create'],
    'additional-income.edit': ['additionalIncome', 'edit'],
    'additional-income.void': ['additionalIncome', 'void'],
    'variable-expense.create': ['variableExpense', 'create'],
    'variable-expense.edit': ['variableExpense', 'edit'],
    'variable-expense.void': ['variableExpense', 'void'],
    'fixed-expense-payment.create': ['fixedExpensePayment', 'create'],
    'fixed-expense-payment.edit': ['fixedExpensePayment', 'edit'],
    'fixed-expense-payment.void': ['fixedExpensePayment', 'void'],
    'debt-payment.create': ['debtPayment', 'create'],
    'debt-payment.edit': ['debtPayment', 'edit'],
    'debt-payment.void': ['debtPayment', 'void'],
    'debt-total-adjustment.create': ['debtTotalAdjustment', 'create'],
    'savings-deposit.create': ['savingsDeposit', 'create'],
    'savings-deposit.edit': ['savingsDeposit', 'edit'],
    'savings-deposit.void': ['savingsDeposit', 'void'],
    'savings-withdrawal.create': ['savingsWithdrawal', 'create'],
    'savings-withdrawal.edit': ['savingsWithdrawal', 'edit'],
    'savings-withdrawal.void': ['savingsWithdrawal', 'void'],
    'transfer.create': ['transfer', 'create'],
    'transfer.edit': ['transfer', 'edit'],
    'transfer.void': ['transfer', 'void'],
  });

  const ENTITY_REVISION_FIELDS = Object.freeze([
    ['accountId', 'accounts', 'expectedAccountRevision'],
    ['categoryId', 'categories', 'expectedCategoryRevision'],
    ['templateId', 'fixedExpenseTemplates', 'expectedTemplateRevision'],
    ['fixedExpenseInstanceId', 'fixedExpenseInstances', 'expectedInstanceRevision'],
    ['instanceId', 'fixedExpenseInstances', 'expectedInstanceRevision'],
    ['goalId', 'savingsGoals', 'expectedGoalRevision'],
    ['debtId', 'debts', 'expectedDebtRevision'],
    ['operationId', 'operations', 'expectedOperationRevision'],
  ]);

  function immutable(value) {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return Object.freeze(value.map(immutable));
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, immutable(item)])));
  }

  function uuid(cryptoSource) {
    return Contracts.createUuidV4(cryptoSource);
  }

  function navigationType(performanceSource) {
    try {
      const entries = performanceSource && typeof performanceSource.getEntriesByType === 'function'
        ? performanceSource.getEntriesByType('navigation')
        : [];
      const type = entries && entries[0] && entries[0].type;
      return ['reload', 'back_forward'].includes(type) ? type : 'navigate';
    } catch (_) {
      return 'navigate';
    }
  }

  function sessionTabId(sessionStore, createUuid, pageNavigationType) {
    if (!sessionStore || typeof sessionStore.getItem !== 'function' || typeof sessionStore.setItem !== 'function') {
      return createUuid();
    }
    try {
      const existing = sessionStore.getItem(TAB_ID_SESSION_KEY);
      const canReuse = ['reload', 'back_forward'].includes(pageNavigationType);
      if (canReuse && typeof existing === 'string' && existing.trim() !== '') return existing;
      const created = createUuid();
      sessionStore.setItem(TAB_ID_SESSION_KEY, created);
      return created;
    } catch (_) {
      return createUuid();
    }
  }

  function civilDate(date) {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit',
    });
    const parts = Object.fromEntries(formatter.formatToParts(date || new Date()).map((part) => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  function browserSha256(value) {
    const constants = [
      0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
      0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
      0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
      0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
      0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
      0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
      0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
      0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
    ];
    const initial = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
    const source = new TextEncoder().encode(String(value));
    const bitLength = source.length * 8;
    const paddedLength = Math.ceil((source.length + 9) / 64) * 64;
    const bytes = new Uint8Array(paddedLength);
    bytes.set(source);
    bytes[source.length] = 0x80;
    const view = new DataView(bytes.buffer);
    view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
    view.setUint32(paddedLength - 4, bitLength >>> 0, false);
    const hash = initial.slice();
    const words = new Uint32Array(64);
    const rotate = (number, amount) => (number >>> amount) | (number << (32 - amount));
    for (let offset = 0; offset < paddedLength; offset += 64) {
      for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4, false);
      for (let index = 16; index < 64; index += 1) {
        const left = words[index - 15];
        const right = words[index - 2];
        const s0 = rotate(left, 7) ^ rotate(left, 18) ^ (left >>> 3);
        const s1 = rotate(right, 17) ^ rotate(right, 19) ^ (right >>> 10);
        words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
      }
      let [a,b,c,d,e,f,g,h] = hash;
      for (let index = 0; index < 64; index += 1) {
        const s1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
        const choice = (e & f) ^ (~e & g);
        const temp1 = (h + s1 + choice + constants[index] + words[index]) >>> 0;
        const s0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
        const majority = (a & b) ^ (a & c) ^ (b & c);
        const temp2 = (s0 + majority) >>> 0;
        h=g;g=f;f=e;e=(d+temp1)>>>0;d=c;c=b;b=a;a=(temp1+temp2)>>>0;
      }
      hash[0]=(hash[0]+a)>>>0;hash[1]=(hash[1]+b)>>>0;hash[2]=(hash[2]+c)>>>0;hash[3]=(hash[3]+d)>>>0;
      hash[4]=(hash[4]+e)>>>0;hash[5]=(hash[5]+f)>>>0;hash[6]=(hash[6]+g)>>>0;hash[7]=(hash[7]+h)>>>0;
    }
    return hash.map((word) => word.toString(16).padStart(8, '0')).join('');
  }

  function errorView(error) {
    let current = error;
    while (current && !current.code && current.cause) current = current.cause;
    return immutable({
      code: current && current.code ? current.code : 'UNEXPECTED_ERROR',
      message: current && current.message ? current.message : 'Ocurrió un error inesperado.',
      context: current && current.context ? current.context : {},
    });
  }

  function operationToLegacy(operation) {
    const details = operation.details || {};
    return {
      id: operation.id,
      date: operation.operationDate,
      description: details.concept || details.categoryName || operation.type,
      amount: operation.amount,
      type: ['salary_receipt', 'additional_income'].includes(operation.type) ? 'income' : 'expense',
      account: details.accountId || '',
      category: details.categoryId || '',
      categoryName: details.categoryName || '',
      categoryId: details.categoryId || '',
      notes: details.observation || '',
      operationType: operation.type,
      status: operation.status,
      revision: operation.revision,
    };
  }

  function snapshotToView(snapshot) {
    const runtime = snapshot.system.find((record) => record.key === 'runtime');
    const settings = snapshot.financialSettings.find((record) => record.key === 'current') || null;
    const storedActivePeriod = runtime && runtime.activePeriodId
      ? snapshot.periods.find((period) => period.id === runtime.activePeriodId) || null
      : null;
    const activePeriod = storedActivePeriod ? Domain.validatePeriod(storedActivePeriod) : null;
    const activeOperations = activePeriod
      ? snapshot.operations.filter((operation) => operation.periodId === activePeriod.id)
      : [];
    const activeInstances = activePeriod
      ? snapshot.fixedExpenseInstances.filter((instance) => instance.periodId === activePeriod.id)
      : [];
    const summary = activePeriod
      ? DomainCommands.deriveMonthlySummary({
        period: activePeriod,
        operations: snapshot.operations,
        movements: snapshot.movements,
        fixedExpenseInstances: snapshot.fixedExpenseInstances,
      })
      : null;
    const instanceByTemplate = new Map(activeInstances.map((instance) => [instance.templateId, instance]));
    const accounts = snapshot.accounts.filter((account) => account.status === 'active').map((account) => ({
      id: account.id, name: account.name, balance: account.currentBalance,
      type: 'bank', bank: '', status: account.status, revision: account.revision,
    }));
    const wallets = snapshot.savingsGoals.map((goal) => ({
      id: goal.id, emoji: '💰', name: goal.name, bank: '', balance: goal.currentBalance,
      monthly: goal.plannedMonthlyAmount, goal: goal.targetAmount,
      status: goal.lifecycleStatus, progressStatus: goal.progressStatus, revision: goal.revision,
    }));
    const debts = snapshot.debts.map((debt) => ({
      id: debt.id, name: debt.name, total: debt.totalAmount,
      paid: debt.totalAmount - debt.outstandingAmount, due: debt.dueDate, dueDate: debt.dueDate,
      monthly: 0,
      status: debt.paymentStatus === 'paid' ? 'pagada' : debt.paymentStatus,
      lifecycleStatus: debt.lifecycleStatus, revision: debt.revision,
    }));
    const budget = snapshot.fixedExpenseTemplates
      .filter((template) => template.status === 'active')
      .map((template) => ({
        id: template.id, name: template.name, amount: template.referenceAmount,
        revision: template.revision, instance: instanceByTemplate.get(template.id) || null,
      }));
    const expenses = activeOperations.filter((operation)=>operation.status==='posted').map(operationToLegacy);
    const monthlyHistory = snapshot.periodSnapshots.map((periodSnapshot) => {
      const data = periodSnapshot.data || {};
      const historicalOperations = data.operations || [];
      return {
        id: periodSnapshot.id,
        month: periodSnapshot.periodKey,
        closedAt: periodSnapshot.closedAt,
        totals: data.totals || {},
        expenses: historicalOperations.map(operationToLegacy),
        gastosFijosPagados: historicalOperations.filter((item)=>item.type==='fixed_expense_payment').map((item)=>({name:'Gasto fijo',amount:item.amount,date:item.operationDate})),
        pagosDeuda: historicalOperations.filter((item)=>item.type==='debt_payment').map((item)=>({debtName:'Deuda',amount:item.amount,date:item.operationDate})),
        aportesAhorro: historicalOperations.filter((item)=>['savings_deposit','savings_withdrawal'].includes(item.type)).map((item)=>({walletName:'Meta',amount:item.type==='savings_deposit'?item.amount:-item.amount,date:item.operationDate})),
        snapshot: periodSnapshot,
      };
    });
    return immutable({
      runtime,
      settings: { salary: settings ? settings.salaryReferenceAmount : 0 },
      financialSettings: settings,
      period: activePeriod,
      summary,
      accounts,
      wallets,
      debts,
      budget,
      varCategories: snapshot.categories.map((category) => ({ ...category })),
      expenses,
      activeMonth: {
        month: activePeriod ? activePeriod.periodKey : civilDate().slice(0, 7),
        expenses,
        gastosFijosPagados: activeInstances.filter((instance) => instance.status === 'paid').map((instance) => ({
          budgetId: instance.templateId,
          amount: instance.plannedAmount,
          operationId: instance.activePaymentOperationId,
        })),
      },
      monthlyHistory,
      operationRevisions: snapshot.operationRevisions,
      operations: snapshot.operations,
      movements: snapshot.movements,
      legacyEntries: snapshot.legacyEntries,
      migrations: snapshot.migrations,
      integrityReports: snapshot.integrityReports,
      _snapshot: snapshot,
    });
  }

  function createLifecycleController(options) {
    const settings = options || {};
    const application = settings.application;
    const eventTarget = settings.eventTarget;
    const visibilitySource = settings.visibilitySource;
    if (!application || typeof application.resume !== 'function' || typeof application.suspend !== 'function') {
      throw new TypeError('createLifecycleController requires a resumable application');
    }
    if (!eventTarget || typeof eventTarget.addEventListener !== 'function') {
      throw new TypeError('createLifecycleController requires an event target');
    }
    let active = false;
    let temporarilySuspended = false;
    let lifecycleVersion = 0;
    let recoveryPromise = null;
    let recoveryVersion = null;
    let pendingReason = null;

    const isVisible = () => !visibilitySource || visibilitySource.visibilityState !== 'hidden';

    function recover(reason) {
      if (!active) return Promise.resolve(null);
      if (recoveryPromise) {
        if (recoveryVersion !== lifecycleVersion) pendingReason = reason;
        if (typeof settings.onRecovering === 'function') {
          settings.onRecovering(Object.freeze({ reason, pending: true }));
        }
        return recoveryPromise;
      }
      pendingReason = null;
      const requestedVersion = lifecycleVersion;
      recoveryVersion = requestedVersion;
      temporarilySuspended = false;
      if (typeof settings.onRecovering === 'function') {
        settings.onRecovering(Object.freeze({ reason, pending: false }));
      }
      recoveryPromise = Promise.resolve()
        .then(() => application.resume())
        .then((result) => {
          if (active && requestedVersion === lifecycleVersion && isVisible()) {
            if (typeof settings.onResult === 'function') settings.onResult(result, reason);
          }
          return result;
        })
        .catch((error) => {
          if (active && requestedVersion === lifecycleVersion && isVisible()) {
            if (typeof settings.onError === 'function') settings.onError(error, reason);
          }
          return null;
        })
        .finally(() => {
          const settledCurrent = active && requestedVersion === lifecycleVersion && isVisible();
          recoveryPromise = null;
          recoveryVersion = null;
          if (settledCurrent && typeof settings.onSettled === 'function') {
            settings.onSettled(reason);
          }
          if (pendingReason !== null && active && isVisible()) {
            const nextReason = pendingReason;
            pendingReason = null;
            recover(nextReason);
          }
        });
      return recoveryPromise;
    }

    function suspend(reason) {
      if (!active || temporarilySuspended) return;
      temporarilySuspended = true;
      lifecycleVersion += 1;
      application.suspend();
      if (typeof settings.onSuspended === 'function') settings.onSuspended(reason);
    }

    const handlePageHide = () => suspend('pagehide');
    const handlePageShow = (event) => recover(event && event.persisted ? 'pageshow-bfcache' : 'pageshow');
    const handleVisibilityChange = () => {
      if (isVisible()) recover('visibility-visible');
      else suspend('visibility-hidden');
    };

    function start() {
      if (active) return recoveryPromise || Promise.resolve(null);
      active = true;
      eventTarget.addEventListener('pagehide', handlePageHide);
      eventTarget.addEventListener('pageshow', handlePageShow);
      if (visibilitySource && typeof visibilitySource.addEventListener === 'function') {
        visibilitySource.addEventListener('visibilitychange', handleVisibilityChange);
      }
      return recover('initial');
    }

    function stop() {
      if (!active) return;
      active = false;
      lifecycleVersion += 1;
      pendingReason = null;
      eventTarget.removeEventListener('pagehide', handlePageHide);
      eventTarget.removeEventListener('pageshow', handlePageShow);
      if (visibilitySource && typeof visibilitySource.removeEventListener === 'function') {
        visibilitySource.removeEventListener('visibilitychange', handleVisibilityChange);
      }
      application.suspend();
    }

    return Object.freeze({
      start,
      stop,
      resume: (reason) => recover(reason || 'manual'),
      get recoveryActive() { return recoveryPromise !== null; },
    });
  }

  function createPeritaApplication(options) {
    const settings = options || {};
    const indexedDB = settings.indexedDB || (typeof globalThis !== 'undefined' && globalThis.indexedDB);
    const IDBKeyRange = settings.IDBKeyRange || (typeof globalThis !== 'undefined' && globalThis.IDBKeyRange);
    const cryptoSource = settings.crypto || (typeof globalThis !== 'undefined' && globalThis.crypto);
    const legacyStorage = settings.legacyStorage || (typeof globalThis !== 'undefined' && globalThis.localStorage);
    const now = settings.now || (() => new Date().toISOString());
    const createUuid = settings.createUuid || (() => uuid(cryptoSource));
    const sha256 = settings.sha256 || browserSha256;
    const sessionStore = Object.prototype.hasOwnProperty.call(settings, 'sessionStorage')
      ? settings.sessionStorage
      : (typeof globalThis !== 'undefined' ? globalThis.sessionStorage : null);
    const performanceSource = Object.prototype.hasOwnProperty.call(settings, 'performance')
      ? settings.performance
      : (typeof globalThis !== 'undefined' ? globalThis.performance : null);
    const pageNavigationType = settings.navigationType || navigationType(performanceSource);
    const tabId = settings.tabId || sessionTabId(sessionStore, createUuid, pageNavigationType);
    const storage = settings.storage || IndexedDb.createPeritaIndexedDb({
      indexedDB, IDBKeyRange, crypto: cryptoSource, now,
    });
    const runtime = settings.runtime || Runtime.createPeritaRuntime({ storage, now, tabId, createUuid });
    const commands = settings.commands || DomainCommands.createPeritaDomainCommands({
      runtime, now, createUuid, sha256,
    });
    const integrity = settings.integrity || Integrity.createPeritaIntegrity({
      storage, now, createUuid, sha256,
    });
    const migration = settings.migration || Migration.createPeritaMigration({
      storage, runtime, legacyStorage, now, createUuid, sha256,
    });
    const backup = settings.backup || Backup.createPeritaBackup({
      storage, indexedDB, now, sha256, onDeleteBlocked: settings.onDeleteBlocked,
    });
    const hasInjectedChannel = Object.prototype.hasOwnProperty.call(settings, 'channel');
    const channelFactory = typeof settings.channelFactory === 'function'
      ? settings.channelFactory
      : hasInjectedChannel
        ? () => null
        : () => {
          try {
            return typeof BroadcastChannel === 'function'
              ? new BroadcastChannel('perita-v110-events')
              : null;
          } catch (_) {
            return null;
          }
        };
    const scheduleInterval = settings.setInterval ||
      (typeof setInterval === 'function' ? setInterval : null);
    const cancelInterval = settings.clearInterval ||
      (typeof clearInterval === 'function' ? clearInterval : null);
    let channel = hasInjectedChannel ? settings.channel : channelFactory();
    let writerEpoch = null;
    let ownedWriterEpoch = null;
    let heartbeatHandle = null;
    let heartbeatGeneration = 0;
    let lastState = null;
    let stateListener = null;
    let stateDeliveryPauseDepth = 0;
    let pendingStateDelivery = null;
    let suspended = false;
    let closed = false;
    let suspensionVersion = 0;
    let resumePromise = null;

    function bindChannelListener() {
      if (!channel) return;
      channel.onmessage = stateListener
        ? (event) => {
          if (!event.data || event.data.tabId === tabId) return;
          refresh().catch(() => undefined);
        }
        : null;
    }

    function ensureChannel() {
      if (channel || closed) return channel;
      try {
        channel = channelFactory();
      } catch (_) {
        channel = null;
      }
      bindChannelListener();
      return channel;
    }

    function disconnectChannel() {
      if (!channel) return;
      try { channel.onmessage = null; } catch (_) {}
      try { channel.close(); } catch (_) {}
      channel = null;
    }

    async function readSnapshot() {
      await storage.open();
      return storage.runTransaction(READ_STORES, 'readonly', async (transaction) => {
        const result = {};
        for (const storeName of READ_STORES) result[storeName] = await transaction.getAll(storeName);
        return immutable(result);
      });
    }

    async function refresh() {
      const snapshot = await readSnapshot();
      lastState = snapshotToView(snapshot);
      if (stateListener) {
        if (stateDeliveryPauseDepth > 0) pendingStateDelivery = lastState;
        else stateListener(lastState);
      }
      return lastState;
    }

    function flushPendingStateDelivery() {
      if (stateDeliveryPauseDepth !== 0 || pendingStateDelivery === null) return;
      const nextState = pendingStateDelivery;
      pendingStateDelivery = null;
      if (stateListener) stateListener(nextState);
    }

    function emit(type) {
      if (!channel) return;
      try {
        channel.postMessage({ type, tabId, at: now() });
      } catch (_) {
        disconnectChannel();
      }
    }

    async function acquireWriter() {
      const current = await runtime.getWriterState();
      const writer = await runtime.acquireWriter({
        expectedEpoch: current.epoch,
        leaseDurationMs: LEASE_DURATION_MS,
      });
      writerEpoch = writer.epoch;
      ownedWriterEpoch = writer.epoch;
      return writer;
    }

    async function ensureIntegrityAndWriting() {
      const report = await integrity.runFullCheck();
      if (report.status === 'diagnostic_only') return report;
      const current = await storage.get('system', 'runtime');
      if (!current.writeEnabled) {
        await runtime.setWriteEnabled({ enabled: true, reason: 'integrity check completed' });
      }
      return report;
    }

    function startHeartbeat(onLeaseLost) {
      if (
        heartbeatHandle !== null || writerEpoch === null || suspended || closed ||
        typeof scheduleInterval !== 'function'
      ) return;
      heartbeatGeneration += 1;
      const generation = heartbeatGeneration;
      heartbeatHandle = scheduleInterval(async () => {
        const expectedEpoch = writerEpoch;
        if (expectedEpoch === null || suspended || closed || generation !== heartbeatGeneration) return;
        try {
          await runtime.heartbeat({ expectedEpoch, leaseDurationMs: LEASE_DURATION_MS });
        } catch (error) {
          if (suspended || closed || generation !== heartbeatGeneration || writerEpoch !== expectedEpoch) return;
          stopHeartbeat();
          writerEpoch = null;
          ownedWriterEpoch = null;
          if (onLeaseLost) onLeaseLost(errorView(error));
          emit('writer-lost');
        }
      }, HEARTBEAT_INTERVAL_MS);
    }

    function stopHeartbeat() {
      if (heartbeatHandle !== null && typeof cancelInterval === 'function') {
        cancelInterval(heartbeatHandle);
      }
      heartbeatHandle = null;
      heartbeatGeneration += 1;
    }

    function hasLegacySource() {
      try {
        return legacyStorage && legacyStorage.getItem(LEGACY_KEY) !== null;
      } catch (cause) {
        throw new Error(`No se pudo leer ${LEGACY_KEY}: ${cause.message}`);
      }
    }

    async function initialize() {
      if (closed) {
        return immutable({
          phase: 'error',
          state: null,
          error: errorView(new Error('La instancia de Perita ya fue cerrada.')),
          writer: false,
        });
      }
      suspended = false;
      ensureChannel();
      try {
        const state = await refresh();
        const runtimeState = state.runtime;
        if (!runtimeState) throw new Error('El runtime V1.1.0 no existe.');
        if (runtimeState.setupStatus === 'not_started') {
          try {
            await acquireWriter();
          } catch (error) {
            writerEpoch = null;
            ownedWriterEpoch = null;
            return immutable({ phase: 'read_only', state, error: errorView(error), writer: false });
          }
          if (hasLegacySource()) {
            const dryRun = await migration.createDryRun();
            if (dryRun.classification !== 'blocked') {
              await runtime.setWriteEnabled({ enabled: true, reason: 'confirmed migration is available' });
            }
            const nextState = await refresh();
            return immutable({
              phase: dryRun.classification === 'blocked' ? 'migration_blocked' : 'migration_pending',
              state: nextState, dryRun, writer: true, writerEpoch,
            });
          }
          await runtime.setWriteEnabled({ enabled: true, reason: 'initial setup is available' });
          return immutable({ phase: 'setup_required', state: await refresh(), writer: true, writerEpoch });
        }
        try {
          await acquireWriter();
        } catch (error) {
          writerEpoch = null;
          ownedWriterEpoch = null;
          return immutable({ phase: 'ready_read_only', state, error: errorView(error), writer: false });
        }
        const report = await ensureIntegrityAndWriting();
        const next = await refresh();
        const phase = report.status === 'diagnostic_only' ? 'diagnostic' : report.status;
        return immutable({ phase, state: next, report, writer: true, writerEpoch });
      } catch (error) {
        return immutable({ phase: 'error', state: null, error: errorView(error), writer: false });
      }
    }

    async function completeSetup(input) {
      if (writerEpoch === null) throw new Error('Esta pestaña no controla el escritor.');
      const runtimeState = await storage.get('system', 'runtime');
      const result = await commands.setup.complete({
        ...input,
        expectedDataRevision: runtimeState.dataRevision,
        expectedWriterEpoch: writerEpoch,
        currentCivilDate: input.currentCivilDate || civilDate(new Date(now())),
      });
      emit('data-changed');
      return immutable({ result, state: await refresh() });
    }

    async function confirmMigration(dryRun) {
      if (writerEpoch === null) throw new Error('Esta pestaña no controla el escritor.');
      const runtimeState = await storage.get('system', 'runtime');
      const result = await migration.confirmMigration({
        expectedDataRevision: runtimeState.dataRevision,
        expectedWriterEpoch: writerEpoch,
        expectedSourceHash: dryRun.sourceHash,
      });
      stopHeartbeat();
      writerEpoch = null;
      ownedWriterEpoch = null;
      await acquireWriter();
      const report = await ensureIntegrityAndWriting();
      emit('migration-completed');
      return immutable({ result, report, state: await refresh() });
    }

    async function enrichInput(commandName, input) {
      const request = { ...(input || {}) };
      if (request.changes && typeof request.changes === 'object' && !Array.isArray(request.changes)) {
        Object.assign(request, request.changes);
        delete request.changes;
      }
      const state = lastState || await refresh();
      if (writerEpoch === null) throw new Error('Esta pestaña está en modo solo lectura.');
      request.expectedDataRevision = state.runtime.dataRevision;
      request.expectedWriterEpoch = writerEpoch;
      if (commandName !== 'financial-settings.update-reference-salary') {
        if (state.period && request.periodId === undefined) request.periodId = state.period.id;
      }
      if (commandName === 'financial-settings.update-reference-salary') {
        request.expectedSettingsRevision = state.financialSettings.revision;
      }
      if (commandName === 'period.update-planning') request.expectedPeriodRevision = state.period.revision;
      if (commandName === 'debt.update-name-and-due-date') request.currentCivilDate = civilDate(new Date(now()));
      if (request.operationId !== undefined) {
        const operation = state._snapshot.operations.find((item) => item.id === request.operationId);
        const details = operation && operation.details ? operation.details : {};
        if (operation && request.expectedOperationRevision === undefined) request.expectedOperationRevision = operation.revision;
        if (details.accountId && request.accountId === undefined) request.accountId = details.accountId;
        if (details.categoryId && request.categoryId === undefined) request.categoryId = details.categoryId;
        if (commandName === 'variable-expense.edit') request.previousCategoryId = details.categoryId;
        if (details.fixedExpenseInstanceId && request.fixedExpenseInstanceId === undefined) request.fixedExpenseInstanceId = details.fixedExpenseInstanceId;
        if (details.goalId && request.goalId === undefined) request.goalId = details.goalId;
        if (details.debtId && request.debtId === undefined) request.debtId = details.debtId;
        if (commandName.endsWith('.edit') && details.accountId) {
          request.previousAccountId = details.accountId;
          const previousAccount = state._snapshot.accounts.find((item) => item.id === details.accountId);
          if (previousAccount) request.expectedPreviousAccountRevision = previousAccount.revision;
        }
        if (commandName === 'transfer.edit') {
          request.previousSourceType = details.sourceType;
          request.previousSourceId = details.sourceId;
          request.previousDestinationType = details.destinationType;
          request.previousDestinationId = details.destinationId;
          const sourceStore = details.sourceType === 'account' ? 'accounts' : 'savingsGoals';
          const destinationStore = details.destinationType === 'account' ? 'accounts' : 'savingsGoals';
          request.expectedPreviousSourceRevision = state._snapshot[sourceStore].find((item) => item.id === details.sourceId).revision;
          request.expectedPreviousDestinationRevision = state._snapshot[destinationStore].find((item) => item.id === details.destinationId).revision;
          if (request.sourceType === undefined) request.sourceType = details.sourceType;
          if (request.sourceId === undefined) request.sourceId = details.sourceId;
          if (request.destinationType === undefined) request.destinationType = details.destinationType;
          if (request.destinationId === undefined) request.destinationId = details.destinationId;
        }
        if (commandName === 'transfer.void') {
          request.sourceType = details.sourceType;
          request.sourceId = details.sourceId;
          request.destinationType = details.destinationType;
          request.destinationId = details.destinationId;
        }
      }
      for (const [idField, storeName, revisionField] of ENTITY_REVISION_FIELDS) {
        if (request[idField] !== undefined && request[revisionField] === undefined) {
          const record = state._snapshot[storeName].find((item) => item.id === request[idField]);
          if (record) request[revisionField] = record.revision;
        }
      }
      if (commandName === 'variable-expense.void') delete request.expectedCategoryRevision;
      if (request.sourceType && request.expectedSourceRevision === undefined) {
        const sourceStore = request.sourceType === 'account' ? 'accounts' : 'savingsGoals';
        const source = state._snapshot[sourceStore].find((item) => item.id === request.sourceId);
        if (source) request.expectedSourceRevision = source.revision;
      }
      if (request.destinationType && request.expectedDestinationRevision === undefined) {
        const destinationStore = request.destinationType === 'account' ? 'accounts' : 'savingsGoals';
        const destination = state._snapshot[destinationStore].find((item) => item.id === request.destinationId);
        if (destination) request.expectedDestinationRevision = destination.revision;
      }
      if (request.previousSourceType && request.expectedPreviousSourceRevision === undefined) {
        const storeName = request.previousSourceType === 'account' ? 'accounts' : 'savingsGoals';
        request.expectedPreviousSourceRevision = state._snapshot[storeName].find((item) => item.id === request.previousSourceId).revision;
      }
      if (request.previousDestinationType && request.expectedPreviousDestinationRevision === undefined) {
        const storeName = request.previousDestinationType === 'account' ? 'accounts' : 'savingsGoals';
        request.expectedPreviousDestinationRevision = state._snapshot[storeName].find((item) => item.id === request.previousDestinationId).revision;
      }
      if (commandName === 'period.close-and-open-next') {
        request.expectedPeriodRevision = state.period.revision;
        request.expectedSettingsRevision = state.financialSettings.revision;
        request.entityRevisions = [
          ...state._snapshot.accounts.map((record) => ({ targetType: 'account', targetId: record.id, expectedRevision: record.revision })),
          ...state._snapshot.savingsGoals.map((record) => ({ targetType: 'savings_goal', targetId: record.id, expectedRevision: record.revision })),
          ...state._snapshot.debts.map((record) => ({ targetType: 'debt', targetId: record.id, expectedRevision: record.revision })),
        ];
        request.activeTemplateRevisions = state._snapshot.fixedExpenseTemplates
          .filter((record) => record.status === 'active')
          .map((record) => ({ templateId: record.id, expectedRevision: record.revision }));
        request.currentInstanceRevisions = state._snapshot.fixedExpenseInstances
          .filter((record) => record.periodId === state.period.id)
          .map((record) => ({ instanceId: record.id, expectedRevision: record.revision }));
      }
      return request;
    }

    async function execute(commandName, input) {
      const path = COMMANDS[commandName];
      if (!path) throw new Error(`Comando V1.1.0 no soportado por la integración: ${commandName}`);
      try {
        const request = await enrichInput(commandName, input);
        const result = await commands[path[0]][path[1]](request);
        emit('data-changed');
        return immutable({ result, state: await refresh() });
      } catch (error) {
        if (['WRITER_EPOCH_LOST', 'WRITER_LEASE_EXPIRED'].includes(error && error.code)) {
          stopHeartbeat();
          writerEpoch = null;
          ownedWriterEpoch = null;
        }
        throw error;
      }
    }

    async function createAccountWithBalance(input) {
      const request = input || {};
      const currentBalance = Contracts.assertMoney(request.currentBalance === undefined ? 0 : request.currentBalance, {
        field: 'currentBalance',
        allowZero: true,
        allowNegative: true,
      });
      if (currentBalance < 0) {
        throw new Contracts.PeritaError(
          Contracts.ERROR_CODES.DOMAIN_STATE_INVALID,
          'a post-setup Account balance adjustment cannot leave the Account negative',
          { currentBalance }
        );
      }
      const accountId = request.accountId || createUuid();
      const timestamp = request.timestamp || now();
      const operationDate = request.operationDate || civilDate(new Date(timestamp));
      let created = null;
      let completed = null;
      stateDeliveryPauseDepth += 1;
      try {
        created = await execute('account.create', {
          account: {
            id: accountId,
            name: request.name,
            openingBalance: 0,
            currentBalance: 0,
            status: 'active',
            revision: 1,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        });
        completed = created;
        if (currentBalance !== 0) {
          completed = await execute('balance-adjustment.create', {
            accountId,
            operationDate,
            delta: currentBalance,
            reason: request.reason || 'Saldo incorporado al crear la cuenta',
          });
        }
        return immutable({
          accountId,
          created: created.result,
          adjustment: currentBalance === 0 ? null : completed.result,
          state: completed.state,
        });
      } catch (cause) {
        if (created !== null) {
          throw new Contracts.PeritaError(
            'ACCOUNT_BALANCE_ADJUSTMENT_FAILED',
            'La cuenta se creó en $0, pero no fue posible incorporar el saldo indicado.',
            { accountId, currentBalance, causeCode: cause && cause.code ? cause.code : null },
            cause
          );
        }
        throw cause;
      } finally {
        stateDeliveryPauseDepth -= 1;
        flushPendingStateDelivery();
      }
    }

    async function createSavingsGoalWithBalance(input) {
      const request = input || {};
      const currentBalance = Contracts.assertMoney(
        request.currentBalance === undefined ? 0 : request.currentBalance,
        { field: 'currentBalance', allowZero: true, allowNegative: false }
      );
      const goalId = request.goalId || createUuid();
      const timestamp = request.timestamp || now();
      const operationDate = request.operationDate || civilDate(new Date(timestamp));
      let created = null;
      let completed = null;
      stateDeliveryPauseDepth += 1;
      try {
        created = await execute('savings-goal.create', {
          goal: {
            id: goalId,
            name: request.name,
            targetAmount: request.targetAmount,
            openingBalance: 0,
            currentBalance: 0,
            plannedMonthlyAmount: request.plannedMonthlyAmount,
            lifecycleStatus: 'active',
            progressStatus: 'in_progress',
            closedAt: null,
            revision: 1,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        });
        completed = created;
        if (currentBalance > 0) {
          completed = await execute('balance-adjustment.create', {
            goalId,
            operationDate,
            delta: currentBalance,
            reason: request.reason || 'Saldo preexistente al crear la meta de ahorro',
          });
        }
        return immutable({
          goalId,
          created: created.result,
          adjustment: currentBalance === 0 ? null : completed.result,
          state: completed.state,
        });
      } catch (cause) {
        if (created !== null) {
          throw new Contracts.PeritaError(
            'SAVINGS_GOAL_BALANCE_ADJUSTMENT_FAILED',
            'La meta se creó en $0, pero no fue posible incorporar el saldo preexistente.',
            { goalId, currentBalance, causeCode: cause && cause.code ? cause.code : null },
            cause
          );
        }
        throw cause;
      } finally {
        stateDeliveryPauseDepth -= 1;
        flushPendingStateDelivery();
      }
    }

    async function updateAccountWithBalance(input) {
      const request = input || {};
      const state = lastState || await refresh();
      const account = state._snapshot.accounts.find((item) => item.id === request.accountId);
      if (!account) throw new Error('La cuenta solicitada no existe.');
      const currentBalance = Contracts.assertMoney(request.currentBalance, {
        field: 'currentBalance', allowZero: true, allowNegative: true,
      });
      const nameChanged = request.name !== account.name;
      const balanceDelta = currentBalance - account.currentBalance;
      let completed = null;
      stateDeliveryPauseDepth += 1;
      try {
        if (nameChanged) {
          completed = await execute('account.update', {
            accountId: account.id,
            changes: { name: request.name },
          });
        }
        if (balanceDelta !== 0) {
          completed = await execute('balance-adjustment.create', {
            accountId: account.id,
            operationDate: request.operationDate,
            delta: balanceDelta,
            reason: request.reason || 'Ajuste de saldo al editar la cuenta',
          });
        }
        return immutable({
          accountId: account.id,
          nameUpdated: nameChanged,
          adjustment: balanceDelta === 0 ? null : completed.result,
          state: completed ? completed.state : state,
        });
      } finally {
        stateDeliveryPauseDepth -= 1;
        flushPendingStateDelivery();
      }
    }

    async function updateSavingsGoalWithBalance(input) {
      const request = input || {};
      const state = lastState || await refresh();
      const goal = state._snapshot.savingsGoals.find((item) => item.id === request.goalId);
      if (!goal) throw new Error('La meta de ahorro solicitada no existe.');
      const currentBalance = Contracts.assertMoney(request.currentBalance, {
        field: 'currentBalance', allowZero: true, allowNegative: false,
      });
      const changes = {};
      if (request.name !== goal.name) changes.name = request.name;
      if (request.targetAmount !== goal.targetAmount) changes.targetAmount = request.targetAmount;
      if (request.plannedMonthlyAmount !== goal.plannedMonthlyAmount) {
        changes.plannedMonthlyAmount = request.plannedMonthlyAmount;
      }
      const balanceDelta = currentBalance - goal.currentBalance;
      let completed = null;
      stateDeliveryPauseDepth += 1;
      try {
        if (Object.keys(changes).length > 0) {
          completed = await execute('savings-goal.update', { goalId: goal.id, changes });
        }
        if (balanceDelta !== 0) {
          completed = await execute('balance-adjustment.create', {
            goalId: goal.id,
            operationDate: request.operationDate,
            delta: balanceDelta,
            reason: request.reason || 'Ajuste de saldo al editar la meta de ahorro',
          });
        }
        return immutable({
          goalId: goal.id,
          detailsUpdated: Object.keys(changes).length > 0,
          adjustment: balanceDelta === 0 ? null : completed.result,
          state: completed ? completed.state : state,
        });
      } finally {
        stateDeliveryPauseDepth -= 1;
        flushPendingStateDelivery();
      }
    }

    async function updateDebtDetailsAndTotal(input) {
      const request = input || {};
      const state = lastState || await refresh();
      const debt = state._snapshot.debts.find((item) => item.id === request.debtId);
      if (!debt) throw new Error('La deuda solicitada no existe.');
      const detailsChanged = request.name !== debt.name || request.dueDate !== debt.dueDate;
      const totalChanged = request.totalAmount !== debt.totalAmount;
      let completed = null;
      stateDeliveryPauseDepth += 1;
      try {
        if (detailsChanged) {
          completed = await execute('debt.update-name-and-due-date', {
            debtId: debt.id,
            changes: { name: request.name, dueDate: request.dueDate },
          });
        }
        if (totalChanged) {
          completed = await execute('debt-total-adjustment.create', {
            debtId: debt.id,
            operationDate: request.operationDate,
            newTotalAmount: request.totalAmount,
          });
        }
        return immutable({
          debtId: debt.id,
          detailsUpdated: detailsChanged,
          totalAdjustment: totalChanged ? completed.result : null,
          state: completed ? completed.state : state,
        });
      } finally {
        stateDeliveryPauseDepth -= 1;
        flushPendingStateDelivery();
      }
    }

    async function exportBackup() {
      return backup.exportBackup();
    }

    async function restoreBackup(targetBackup) {
      const preventiveBackup = await backup.exportBackup();
      const result = await backup.restoreBackup({ backup: targetBackup, preventiveBackup });
      stopHeartbeat();
      writerEpoch = null;
      ownedWriterEpoch = null;
      await acquireWriter();
      const report = await ensureIntegrityAndWriting();
      emit('backup-restored');
      return immutable({ result, preventiveBackup, report, state: await refresh() });
    }

    async function deleteAllData(externalBackup, confirmation) {
      const result = await backup.deleteAllData({ backup: externalBackup, confirmation });
      stopHeartbeat();
      writerEpoch = null;
      ownedWriterEpoch = null;
      emit('database-deleted');
      return result;
    }

    async function takeOverWriter() {
      if (suspended || closed) throw new Error('Perita debe reanudarse antes de tomar el escritor.');
      const writer = await acquireWriter();
      const report = await ensureIntegrityAndWriting();
      emit('writer-acquired');
      return immutable({ writer, report, state: await refresh() });
    }

    function subscribe(listener) {
      stateListener = typeof listener === 'function' ? listener : null;
      bindChannelListener();
      return () => {
        stateListener = null;
        bindChannelListener();
      };
    }

    async function resume() {
      if (closed) {
        throw new Error('La instancia de Perita ya fue cerrada y no puede reanudarse.');
      }
      if (resumePromise) return resumePromise;
      const requestedVersion = suspensionVersion;
      resumePromise = (async () => {
        stopHeartbeat();
        writerEpoch = null;
        suspended = false;
        ensureChannel();
        const initialized = await initialize();
        if (suspended || suspensionVersion !== requestedVersion) {
          stopHeartbeat();
          writerEpoch = null;
          disconnectChannel();
          storage.close();
        }
        return initialized;
      })().finally(() => {
        resumePromise = null;
      });
      return resumePromise;
    }

    async function close() {
      if (closed) return;
      closed = true;
      suspensionVersion += 1;
      stopHeartbeat();
      if (resumePromise) {
        try { await resumePromise; } catch (_) {}
      }
      const releasableEpoch = writerEpoch === null ? ownedWriterEpoch : writerEpoch;
      if (releasableEpoch !== null) {
        try { await runtime.releaseWriter({ expectedEpoch: releasableEpoch }); } catch (_) {}
      }
      writerEpoch = null;
      ownedWriterEpoch = null;
      disconnectChannel();
      storage.close();
    }

    function suspend() {
      if (closed || suspended) return;
      suspended = true;
      suspensionVersion += 1;
      stopHeartbeat();
      writerEpoch = null;
      disconnectChannel();
      storage.close();
    }

    return Object.freeze({
      initialize,
      refresh,
      completeSetup,
      confirmMigration,
      execute,
      createAccountWithBalance,
      createSavingsGoalWithBalance,
      updateAccountWithBalance,
      updateSavingsGoalWithBalance,
      updateDebtDetailsAndTotal,
      exportBackup,
      validateBackup: backup.validateBackup,
      restoreBackup,
      deleteAllData,
      takeOverWriter,
      startHeartbeat,
      stopHeartbeat,
      subscribe,
      suspend,
      resume,
      close,
      errorView,
      get writerEpoch() { return writerEpoch; },
      get suspended() { return suspended; },
      get closed() { return closed; },
      get heartbeatActive() { return heartbeatHandle !== null; },
      get state() { return lastState; },
    });
  }

  return Object.freeze({
    APP_VERSION,
    LEGACY_KEY,
    TAB_ID_SESSION_KEY,
    LEASE_DURATION_MS,
    HEARTBEAT_INTERVAL_MS,
    READ_STORES,
    COMMANDS,
    civilDate,
    browserSha256,
    errorView,
    navigationType,
    sessionTabId,
    snapshotToView,
    createLifecycleController,
    createPeritaApplication,
  });
});
