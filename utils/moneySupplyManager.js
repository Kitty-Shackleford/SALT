/** Exact-server money-supply tracking. */
const {
  parseCentsBigInt, centsForResponse, centsToDecimal, percentageRatioForResponse,
} = require('./money');

function exactCents(value, label) {
  return parseCentsBigInt(value, label);
}

async function lockSupplyForUpdate(db, serverId) {
  const server = await db.get(
    'SELECT id, guild_id FROM servers WHERE id = ? FOR NO KEY UPDATE',
    [serverId]
  );
  if (!server) throw new Error(`Server not found for economy config ${serverId}`);
  const row = await db.get(
    `SELECT * FROM guild_economy_config
     WHERE server_id = ? FOR UPDATE`,
    [serverId]
  );
  if (!row) throw new Error(`Economy config not found for server ${serverId}`);
  return { ...row, guild_id: server.guild_id };
}

async function getAuthoritativeSupplyCents(db, serverId) {
  const row = await db.get(
    `SELECT COALESCE((SELECT SUM(cash_on_hand) FROM player_wallets WHERE server_id = ?), 0) +
            COALESCE((SELECT SUM(balance) FROM player_bank_accounts WHERE server_id = ?), 0) +
            COALESCE((SELECT SUM(reserved_wager) FROM casino_sessions
                      WHERE server_id = ? AND status = 'active'), 0) +
            COALESCE((SELECT SUM(amount) FROM bounties
                      WHERE server_id = ? AND status IN ('active', 'suspended')), 0) +
            COALESCE((SELECT SUM(amount) FROM financial_refund_claims
                      WHERE server_id = ? AND status = 'pending'), 0) AS total`,
    [serverId, serverId, serverId, serverId, serverId]
  );
  return exactCents(row?.total || 0, 'Authoritative money supply');
}

async function canAddToSupply(db, serverId, amount) {
  const row = await db.get(
    'SELECT fixed_supply_enabled, max_money_supply, current_money_supply FROM guild_economy_config WHERE server_id = ?',
    [serverId]
  );
  if (!row || !row.fixed_supply_enabled || row.max_money_supply == null) return true;
  return exactCents(row.current_money_supply || 0, 'Current money supply')
    + exactCents(amount, 'Supply addition')
    <= exactCents(row.max_money_supply, 'Maximum money supply');
}

async function changeSupplyInTransaction(db, serverId, amount, changeType, source, identityId, metadata) {
  const amountCents = exactCents(amount, 'Supply change');
  const row = await lockSupplyForUpdate(db, serverId);
  if (!row) return null;
  const beforeCents = exactCents(row.current_money_supply || 0, 'Current money supply');
  if (changeType === 'sink' && row.fixed_supply_enabled && amountCents > beforeCents) {
    const error = new Error('Money supply underflow');
    error.status = 409;
    throw error;
  }
  const before = centsForResponse(beforeCents);
  const afterCents = changeType === 'faucet'
    ? beforeCents + amountCents
    : (amountCents > beforeCents ? 0n : beforeCents - amountCents);
  const after = centsForResponse(afterCents);
  if (changeType === 'faucet' && row.fixed_supply_enabled && row.max_money_supply != null &&
      afterCents > exactCents(row.max_money_supply, 'Maximum money supply')) return null;
  const timestamp = new Date().toISOString();
  await db.run(
    'UPDATE guild_economy_config SET current_money_supply = ?, last_supply_update = ? WHERE server_id = ?',
    [centsToDecimal(afterCents), timestamp, serverId]
  );
  const result = await db.run(
    `INSERT INTO economy_supply_log
     (guild_id, server_id, change_type, source, amount, supply_before, supply_after, identity_id, timestamp, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    [row.guild_id, serverId, changeType, source, centsToDecimal(amountCents),
      centsToDecimal(beforeCents), centsToDecimal(afterCents), identityId, timestamp,
      metadata ? JSON.stringify(metadata) : null]
  );
  return { supplyBefore: before, supplyAfter: after, logId: result.lastID };
}

async function changeSupply(db, serverId, amount, changeType, source, identityId, metadata) {
  return db.transaction(() => changeSupplyInTransaction(
    db, serverId, amount, changeType, source, identityId, metadata
  ));
}

async function addToSupply(db, serverId, amount, source, identityId = null, ignoredServerId = null, metadata = null) {
  // ignoredServerId preserves the old arity during rollout; canonical serverId is first.
  void ignoredServerId;
  return changeSupply(db, serverId, amount, 'faucet', source, identityId, metadata);
}

async function addToSupplyInTransaction(db, serverId, amount, source, identityId = null, metadata = null) {
  return changeSupplyInTransaction(db, serverId, amount, 'faucet', source, identityId, metadata);
}

async function removeFromSupplyInTransaction(db, serverId, amount, source, identityId = null, metadata = null) {
  return changeSupplyInTransaction(db, serverId, amount, 'sink', source, identityId, metadata);
}

async function removeFromSupply(db, serverId, amount, source, identityId = null, ignoredServerId = null, metadata = null) {
  void ignoredServerId;
  return changeSupply(db, serverId, amount, 'sink', source, identityId, metadata);
}

async function getCurrentSupply(db, serverId) {
  const row = await db.get(
    'SELECT current_money_supply FROM guild_economy_config WHERE server_id = ?', [serverId]
  );
  return centsForResponse(exactCents(row?.current_money_supply || 0, 'Current money supply'));
}

async function recalculateSupplyInTransaction(db, serverId) {
    const config = await lockSupplyForUpdate(db, serverId);

    const totalCents = await getAuthoritativeSupplyCents(db, serverId);
    if (config.fixed_supply_enabled && config.max_money_supply != null
        && totalCents > exactCents(config.max_money_supply, 'Maximum money supply')) {
      const error = new Error('Recalculated money supply exceeds maximum money supply');
      error.status = 409;
      throw error;
    }
    await db.run(
      'UPDATE guild_economy_config SET current_money_supply = ?, last_supply_update = ? WHERE server_id = ?',
      [centsToDecimal(totalCents), new Date().toISOString(), serverId]
    );
    return centsForResponse(totalCents);
}

async function recalculateSupply(db, serverId) {
  return db.transaction(transactionDb => recalculateSupplyInTransaction(transactionDb, serverId));
}

async function getSupplyStats(db, serverId, timeRange = 7) {
  const since = new Date(Date.now() - timeRange * 86400000).toISOString();
  const config = await db.get(
    'SELECT fixed_supply_enabled, max_money_supply, current_money_supply FROM guild_economy_config WHERE server_id = ?',
    [serverId]
  );
  const rows = await db.query(
    `SELECT change_type, source, SUM(amount) AS total FROM economy_supply_log
     WHERE server_id = ? AND timestamp >= ? GROUP BY change_type, source`,
    [serverId, since]
  );
  const faucets = { total7d: 0, bySource: {} };
  const sinks = { total7d: 0, bySource: {} };
  let faucetCents = 0n;
  let sinkCents = 0n;
  for (const row of rows || []) {
    const target = row.change_type === 'faucet' ? faucets : sinks;
    const totalCents = exactCents(row.total || 0, 'Supply log total');
    target.bySource[row.source] = centsForResponse(totalCents);
    if (row.change_type === 'faucet') faucetCents += totalCents;
    else sinkCents += totalCents;
  }
  faucets.total7d = centsForResponse(faucetCents);
  sinks.total7d = centsForResponse(sinkCents);
  const currentCents = exactCents(config?.current_money_supply || 0, 'Current money supply');
  const maxCents = config?.max_money_supply == null
    ? null : exactCents(config.max_money_supply, 'Maximum money supply');
  return {
    currentSupply: centsForResponse(currentCents),
    maxSupply: maxCents == null ? null : centsForResponse(maxCents),
    utilizationPercent: maxCents == null ? null : percentageRatioForResponse(currentCents, maxCents),
    faucets, sinks, netChange7d: centsForResponse(faucetCents - sinkCents),
  };
}

module.exports = {
  lockSupplyForUpdate, getAuthoritativeSupplyCents,
  canAddToSupply, addToSupply, addToSupplyInTransaction,
  removeFromSupply, removeFromSupplyInTransaction,
  getCurrentSupply, recalculateSupply, recalculateSupplyInTransaction, getSupplyStats,
};
