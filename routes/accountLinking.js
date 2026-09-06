const express = require('express');
const router = express.Router();
const { validateGameAccountId, validateGuildId } = require('../middleware/validators');
const { verifyGuildMembership } = require('../utils/discordAPI');
const {
  createEmoteChallengeSequence,
  evaluateEmoteChallenge,
  formatEmoteSequence,
} = require('../services/playerLinkChallengeService');
const { isTrustedLinkMethod } = require('../utils/linkTrust');
const { parseLinkSettings } = require('../utils/linkPolicy');
const {
  enqueueRoleReconciliationJob,
  runRoleReconciliationJob,
} = require('../utils/linkRoleReconciler');
const { lockUserRoleMutations } = require('../utils/roleMutationLocks');

const LINK_CHALLENGE_TTL_MS = 30 * 60 * 1000;

async function lockActiveLinkTenant(db, serverId, guildId) {
  const tenant = await db.get(
    `SELECT s.id, s.guild_id
     FROM guilds g
     JOIN servers s ON s.guild_id = g.id
     WHERE s.id = ? AND s.guild_id = ?
       AND s.status = 'active' AND g.status = 'approved'
     FOR UPDATE OF g, s`,
    [serverId, guildId]
  );
  if (!tenant) {
    const error = new Error('Player-link scope changed');
    error.code = 'LINK_SCOPE_CHANGED';
    throw error;
  }
  return tenant;
}

async function reconcileWebsiteRoles(db, req, roleJob) {
  try {
    await runRoleReconciliationJob({
      db,
      job: roleJob,
    });
    return null;
  } catch (error) {
    console.warn(`⚠️ Player membership changed, but Discord role reconciliation failed: ${error.message}`);
    return 'Discord roles could not be synchronized; a server administrator should retry reconciliation.';
  }
}

// Get all available game accounts for linking
router.get('/available-accounts', async (req, res) => {
  const { platform, search, guildId, serverId } = req.query;
  const db = req.app.locals.db;

  if (!guildId) {
    return res.status(400).json({ error: 'guildId is required' });
  }
  if (!/^\d+$/.test(String(serverId || ''))) {
    return res.status(400).json({ error: 'serverId is required' });
  }

  if (!req.user.access_token) {
    return res.status(401).json({ error: 'Discord access token not found' });
  }

  try {
    const isMember = await verifyGuildMembership(req.user.access_token, guildId);
    if (!isMember) {
      return res.status(403).json({ error: 'You are not a member of this Discord server' });
    }
  } catch (err) {
    console.error('Error verifying guild membership:', err);
    return res.status(502).json({ error: 'Failed to verify Discord server membership' });
  }

  let query = `
    SELECT pi.id,
           pi.platform,
           pg.gamertag,
           la.id AS conflicting_membership_id
    FROM player_identities pi
    JOIN player_gamertags pg ON pi.id = pg.identity_id AND pg.is_current_gamertag = 1
    JOIN servers s ON pg.server_id = s.id
    JOIN guilds g ON s.guild_id = g.id
    LEFT JOIN server_player_memberships spm
      ON spm.identity_id = pi.id
     AND spm.server_id = s.id
     AND spm.guild_id = s.guild_id
     AND spm.status = 'active'
    LEFT JOIN linked_accounts la
      ON spm.source_link_id = la.id
     AND la.identity_id = spm.identity_id
     AND la.user_id = spm.user_id
     AND la.verification_method IN ('emote_challenge', 'admin_approved', 'self_asserted')
    WHERE g.discord_guild_id = ?
      AND s.id = ?
      AND g.status = 'approved'
      AND s.status = 'active'
  `;

  const params = [guildId, serverId];

  if (platform) {
    query += ' AND pi.platform = ?';
    params.push(platform);
  }

  if (search) {
    query += ' AND pg.gamertag LIKE ?';
    params.push(`%${search}%`);
  }

  query += ' GROUP BY pi.id, pi.platform, pg.gamertag, la.id';
  query += ' ORDER BY pg.gamertag ASC LIMIT 100';

  try {
    const rows = await db.query(query, params);
    res.json({
      success: true,
      accounts: rows.map(row => ({
        id: row.id,
        platform: row.platform,
        gamertag: row.gamertag,
        available: !row.conflicting_membership_id,
      }))
    });
  } catch (err) {
    console.error('Error fetching game accounts:', err);
    res.status(500).json({ error: 'Failed to fetch accounts' });
  }
});

// Get current user's linked accounts
router.get('/my-accounts', async (req, res) => {
  const db = req.app.locals.db;

  try {
    const rows = await db.query(`
      SELECT
        pi.*,
        pg.gamertag,
        la.linked_at
      FROM linked_accounts la
      JOIN player_identities pi ON la.identity_id = pi.id
      LEFT JOIN player_gamertags pg ON pi.id = pg.identity_id AND pg.is_current_gamertag = 1
      WHERE la.user_id = ?
      ORDER BY la.linked_at DESC
    `, [req.user.id]);
    res.json({ success: true, accounts: rows });
  } catch (err) {
    console.error('Error fetching linked accounts:', err);
    res.status(500).json({ error: 'Failed to fetch linked accounts' });
  }
});

// Get linked accounts with guild information (used by economy pages)
router.get('/linked', async (req, res) => {
  const db = req.app.locals.db;

  try {
    const rows = await db.query(`
      SELECT
        pi.id as identity_id,
        pi.platform,
        pg.gamertag,
        la.linked_at,
        g.discord_guild_id as guild_id,
        s.id as server_id,
        s.name as server_name
      FROM server_player_memberships spm
      JOIN linked_accounts la
        ON la.id = spm.source_link_id
       AND la.identity_id = spm.identity_id
       AND la.user_id = spm.user_id
       AND la.verification_method IN ('emote_challenge', 'admin_approved', 'self_asserted')
      JOIN player_identities pi ON spm.identity_id = pi.id
      JOIN servers s ON s.id = spm.server_id AND s.guild_id = spm.guild_id AND s.status = 'active'
      JOIN guilds g ON s.guild_id = g.id AND g.status = 'approved'
      LEFT JOIN player_gamertags pg
        ON pi.id = pg.identity_id AND pg.server_id = s.id AND pg.is_current_gamertag = 1
      WHERE spm.user_id = ? AND spm.status = 'active'
      ORDER BY la.linked_at DESC
    `, [req.user.id]);
    res.json({ success: true, accounts: rows || [] });
  } catch (err) {
    console.error('Error fetching linked accounts:', err);
    res.status(500).json({ error: 'Failed to fetch linked accounts' });
  }
});

// Link a game account only after the player performs a short, ordered emote challenge.
router.post('/link', validateGameAccountId, validateGuildId, async (req, res) => {
  const { gameAccountId, guildId, serverId } = req.body;
  const db = req.app.locals.db;

  if (!/^\d+$/.test(String(serverId || ''))) {
    return res.status(400).json({ error: 'serverId is required' });
  }

  if (!req.user.access_token) {
    return res.status(401).json({ error: 'Discord access token not found. Please log out and log back in.' });
  }

  try {
    if (!await verifyGuildMembership(req.user.access_token, guildId)) {
      return res.status(403).json({ error: 'You are not a member of this Discord server' });
    }

    const account = await db.get(`
      SELECT pi.id, pg.gamertag, s.id AS server_id, s.name AS server_name,
             s.guild_id, g.discord_guild_id,
             la.id AS "linkedId", la.user_id AS "linkedUserId",
             la.verification_method AS "linkedVerificationMethod",
             spm.status AS "membershipStatus", spm.user_id AS "membershipUserId"
      FROM player_identities pi
      JOIN player_gamertags pg
        ON pi.id = pg.identity_id AND pg.is_current_gamertag = 1
      JOIN servers s ON pg.server_id = s.id AND s.status = 'active'
      JOIN guilds g ON s.guild_id = g.id AND g.status = 'approved'
      LEFT JOIN linked_accounts la
        ON la.identity_id = pi.id
      LEFT JOIN server_player_memberships spm
        ON spm.identity_id = pi.id
       AND spm.server_id = s.id
       AND spm.guild_id = s.guild_id
      WHERE pi.id = ? AND g.discord_guild_id = ? AND s.id = ?
      ORDER BY pg.last_seen DESC NULLS LAST
      LIMIT 1
    `, [gameAccountId, guildId, serverId]);

    if (!account) {
      return res.status(404).json({ error: 'Game account not found on an approved server in this Discord guild' });
    }
    if (account.linkedId && account.linkedUserId !== req.user.id) {
      return res.status(409).json({ error: 'This account is already linked to another user' });
    }

    const hasExistingProof = account.linkedUserId === req.user.id &&
      isTrustedLinkMethod(account.linkedVerificationMethod);
    const hasSelfAssertedOwnership = account.linkedUserId === req.user.id &&
      account.linkedVerificationMethod === 'self_asserted';
    if (account.linkedId && !hasExistingProof && !hasSelfAssertedOwnership) {
      return res.status(409).json({ error: 'This legacy link requires administrator review' });
    }
    if (hasExistingProof) {
      let roleJob;
      await db.transaction(async transactionDb => {
        await lockUserRoleMutations(transactionDb, [req.user.id]);
        await lockActiveLinkTenant(transactionDb, account.server_id, account.guild_id);
        const lockedProof = await transactionDb.get(
          `SELECT id, user_id, verification_method
           FROM linked_accounts
           WHERE identity_id = ?
           FOR UPDATE`,
          [gameAccountId]
        );
        if (!lockedProof || lockedProof.user_id !== req.user.id ||
            !isTrustedLinkMethod(lockedProof.verification_method)) {
          const conflict = new Error('Trusted ownership changed while linking');
          conflict.code = 'OWNERSHIP_CONFLICT';
          throw conflict;
        }
        await transactionDb.run(
          `INSERT INTO server_player_memberships
            (server_id, guild_id, identity_id, user_id, source_link_id, verification_method, verified_by_user_id, status, updated_at)
           VALUES (?, ?, ?, ?, ?, 'existing_verified_link', ?, 'active', CURRENT_TIMESTAMP)
           ON CONFLICT (server_id, identity_id) DO UPDATE SET
             guild_id = EXCLUDED.guild_id,
             user_id = EXCLUDED.user_id,
             source_link_id = EXCLUDED.source_link_id,
             verification_method = EXCLUDED.verification_method,
             verified_by_user_id = EXCLUDED.verified_by_user_id,
             status = 'active',
             updated_at = CURRENT_TIMESTAMP`,
          [account.server_id, account.guild_id, gameAccountId, req.user.id, lockedProof.id, req.user.id]
        );
        roleJob = await enqueueRoleReconciliationJob(transactionDb, {
          discordGuildId: account.discord_guild_id,
          discordUserId: req.user.discord_id,
          userId: req.user.id,
        });
      });
      const roleWarning = await reconcileWebsiteRoles(db, req, roleJob);
      return res.json({
        success: true,
        linkedCount: 1,
        message: 'Verified account linked to this server',
        roleWarning,
      });
    }

    const settingsRow = await db.get(
      "SELECT config FROM server_features WHERE server_id = ? AND feature_name = 'player_linking' AND enabled = 1",
      [account.server_id]
    );
    const linkingSettings = parseLinkSettings(settingsRow?.config);
    if (linkingSettings.verificationMode === 'admin_approval') {
      return res.status(403).json({
        error: 'Linking a new gamertag requires administrator or moderator approval on this server'
      });
    }

    if (linkingSettings.verificationMode === 'open') {
      let roleJob;
      await db.transaction(async transactionDb => {
        await lockUserRoleMutations(transactionDb, [req.user.id]);
        await lockActiveLinkTenant(transactionDb, account.server_id, account.guild_id);
        const currentSettingsRow = await transactionDb.get(
          `SELECT enabled, config FROM server_features
           WHERE server_id = ? AND feature_name = 'player_linking'
           FOR UPDATE`,
          [account.server_id]
        );
        const currentSettings = parseLinkSettings(currentSettingsRow?.enabled ? currentSettingsRow.config : null);
        if (currentSettings.verificationMode !== 'open') {
          const policyChanged = new Error('Player-link policy changed');
          policyChanged.code = 'LINK_POLICY_CHANGED';
          throw policyChanged;
        }
        const lockedProof = await transactionDb.get(
          'SELECT id, user_id, verification_method FROM linked_accounts WHERE identity_id = ? FOR UPDATE',
          [gameAccountId]
        );
        if (lockedProof && (lockedProof.user_id !== req.user.id ||
            lockedProof.verification_method !== 'self_asserted')) {
          const conflict = new Error('Ownership changed while linking');
          conflict.code = 'OWNERSHIP_CONFLICT';
          throw conflict;
        }
        let linkedAccountId = lockedProof?.id;
        if (!linkedAccountId) {
          const linkedInsert = await transactionDb.run(`
            INSERT INTO linked_accounts
              (user_id, identity_id, verified_by_guild_id, verification_method)
            VALUES (?, ?, ?, 'self_asserted')
            RETURNING id
          `, [req.user.id, gameAccountId, account.guild_id]);
          linkedAccountId = linkedInsert.lastID;
        }
        await transactionDb.run(
          `INSERT INTO server_player_memberships
            (server_id, guild_id, identity_id, user_id, source_link_id, verification_method, verified_by_user_id, status, updated_at)
           VALUES (?, ?, ?, ?, ?, 'self_asserted', ?, 'active', CURRENT_TIMESTAMP)
           ON CONFLICT (server_id, identity_id) DO UPDATE SET
             guild_id = EXCLUDED.guild_id,
             user_id = EXCLUDED.user_id,
             source_link_id = EXCLUDED.source_link_id,
             verification_method = EXCLUDED.verification_method,
             verified_by_user_id = EXCLUDED.verified_by_user_id,
             status = 'active',
             updated_at = CURRENT_TIMESTAMP`,
          [account.server_id, account.guild_id, gameAccountId, req.user.id, linkedAccountId, req.user.id]
        );
        roleJob = await enqueueRoleReconciliationJob(transactionDb, {
          discordGuildId: account.discord_guild_id,
          discordUserId: req.user.discord_id,
          userId: req.user.id,
        });
      });
      const roleWarning = await reconcileWebsiteRoles(db, req, roleJob);
      return res.json({
        success: true,
        linkedCount: 1,
        message: 'Account linked under this server’s open-link policy',
        roleWarning,
      });
    }

    const now = new Date();
    let challenge = await db.get(`
      SELECT id, user_id, guild_id, server_id, sequence, created_at, expires_at
      FROM player_link_challenges
      WHERE identity_id = ? AND status = 'pending'
      ORDER BY created_at DESC
      LIMIT 1
    `, [gameAccountId]);

    if (challenge && new Date(challenge.expires_at) <= now) {
      const expired = await db.run(
        "UPDATE player_link_challenges SET status = 'expired' WHERE id = ? AND status = 'pending'",
        [challenge.id]
      );
      if (expired.changes !== 1) {
        return res.status(409).json({ error: 'Ownership challenge changed; retry linking' });
      }
      challenge = null;
    }
    if (challenge && challenge.user_id !== req.user.id) {
      return res.status(409).json({ error: 'This game identity has a pending ownership challenge' });
    }
    if (challenge &&
        (String(challenge.guild_id) !== String(account.guild_id)
         || String(challenge.server_id) !== String(account.server_id))) {
      return res.status(409).json({ error: 'This ownership challenge belongs to another server or guild' });
    }

    if (!challenge) {
      const sequence = createEmoteChallengeSequence();
      const expiresAt = new Date(now.getTime() + LINK_CHALLENGE_TTL_MS);
      const inserted = await db.run(`
        INSERT INTO player_link_challenges
          (user_id, identity_id, guild_id, server_id, sequence, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)
        RETURNING id
      `, [req.user.id, gameAccountId, account.guild_id, account.server_id, JSON.stringify(sequence), expiresAt]);
      challenge = {
        id: inserted.lastID,
        user_id: req.user.id,
        sequence,
        created_at: now,
        expires_at: expiresAt,
      };
    }

    const sequence = Array.isArray(challenge.sequence)
      ? challenge.sequence
      : JSON.parse(challenge.sequence);
    const events = await db.query(`
      SELECT emote_type, timestamp
      FROM player_emote_events
      WHERE identity_id = ? AND server_id = ?
        AND timestamp >= ? AND timestamp <= ?
      ORDER BY timestamp ASC, id ASC
    `, [gameAccountId, account.server_id, challenge.created_at, challenge.expires_at]);

    const challengeResult = evaluateEmoteChallenge(
      sequence,
      events,
      challenge.created_at,
      challenge.expires_at
    );
    if (!challengeResult.verified) {
      return res.status(202).json({
        success: false,
        challengeRequired: true,
        sequence: formatEmoteSequence(sequence),
        expiresAt: challenge.expires_at,
        serverName: account.server_name,
        message: 'Perform these emotes in order, wait for the next log sync, then press Link again.'
      });
    }

    let roleJob;
    await db.transaction(async transactionDb => {
      await lockUserRoleMutations(transactionDb, [req.user.id]);
      await lockActiveLinkTenant(transactionDb, account.server_id, account.guild_id);
      const currentSettingsRow = await transactionDb.get(
        `SELECT enabled, config FROM server_features
         WHERE server_id = ? AND feature_name = 'player_linking'
         FOR UPDATE`,
        [account.server_id]
      );
      const currentSettings = parseLinkSettings(currentSettingsRow?.enabled ? currentSettingsRow.config : null);
      if (currentSettings.verificationMode !== 'emote') {
        const policyChanged = new Error('Player-link policy changed');
        policyChanged.code = 'LINK_POLICY_CHANGED';
        throw policyChanged;
      }
      const lockedProof = await transactionDb.get(
        'SELECT id, user_id, verification_method FROM linked_accounts WHERE identity_id = ? FOR UPDATE',
        [gameAccountId]
      );
      if (lockedProof && (lockedProof.user_id !== req.user.id ||
          lockedProof.verification_method !== 'self_asserted')) {
        const conflict = new Error('Ownership changed while linking');
        conflict.code = 'OWNERSHIP_CONFLICT';
        throw conflict;
      }
      let linkedAccountId = lockedProof?.id;
      if (linkedAccountId) {
        await transactionDb.run(
          `UPDATE linked_accounts
              SET verification_method = 'emote_challenge', verified_by_guild_id = ?
            WHERE id = ? AND user_id = ? AND identity_id = ?`,
          [account.guild_id, linkedAccountId, req.user.id, gameAccountId]
        );
      } else {
        const linkedInsert = await transactionDb.run(`
          INSERT INTO linked_accounts
            (user_id, identity_id, verified_by_guild_id, verification_method)
          VALUES (?, ?, ?, 'emote_challenge')
          RETURNING id
        `, [req.user.id, gameAccountId, account.guild_id]);
        linkedAccountId = linkedInsert.lastID;
      }
      await transactionDb.run(
        `INSERT INTO server_player_memberships
          (server_id, guild_id, identity_id, user_id, source_link_id, verification_method, verified_by_user_id, status, updated_at)
         VALUES (?, ?, ?, ?, ?, 'emote_challenge', ?, 'active', CURRENT_TIMESTAMP)
         ON CONFLICT (server_id, identity_id) DO UPDATE SET
           guild_id = EXCLUDED.guild_id,
           user_id = EXCLUDED.user_id,
           source_link_id = EXCLUDED.source_link_id,
           verification_method = EXCLUDED.verification_method,
           verified_by_user_id = EXCLUDED.verified_by_user_id,
           status = 'active',
           updated_at = CURRENT_TIMESTAMP`,
        [account.server_id, account.guild_id, gameAccountId, req.user.id, linkedAccountId, req.user.id]
      );
      const challengeUpdate = await transactionDb.run(
        "UPDATE player_link_challenges SET status = 'verified', verified_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'",
        [challenge.id]
      );
      if (challengeUpdate.changes !== 1) {
        const conflict = new Error('Ownership challenge was already consumed');
        conflict.code = 'CHALLENGE_CONSUMED';
        throw conflict;
      }
      roleJob = await enqueueRoleReconciliationJob(transactionDb, {
        discordGuildId: account.discord_guild_id,
        discordUserId: req.user.discord_id,
        userId: req.user.id,
      });
    });

    const roleWarning = await reconcileWebsiteRoles(db, req, roleJob);
    return res.json({
      success: true,
      linkedCount: 1,
      message: 'Account ownership verified and linked',
      roleWarning,
    });
  } catch (error) {
    if (error.code === 'LINK_POLICY_CHANGED') {
      return res.status(409).json({ error: 'Link verification settings changed; refresh and try again' });
    }
    if (error.code === '23505' || error.code === 'CHALLENGE_CONSUMED' || error.code === 'OWNERSHIP_CONFLICT') {
      return res.status(409).json({ error: 'This account is already linked or has an active challenge' });
    }
    console.error('Error in account linking:', error);
    return res.status(500).json({ error: 'Failed to verify and link account ownership' });
  }
});

// Unlink a game account
router.post('/unlink', async (req, res) => {
  const { gameAccountId, serverId } = req.body;

  if (!gameAccountId) {
    return res.status(400).json({ error: 'gameAccountId is required' });
  }
  if (!/^\d+$/.test(String(serverId || ''))) {
    return res.status(400).json({ error: 'serverId is required' });
  }

  const db = req.app.locals.db;

  try {
    const account = await db.get(`
      SELECT pi.id, pg.gamertag, s.id AS server_id, s.guild_id,
             g.discord_guild_id
      FROM server_player_memberships spm
      JOIN linked_accounts la
        ON la.id = spm.source_link_id
       AND la.identity_id = spm.identity_id
       AND la.user_id = spm.user_id
      JOIN player_identities pi ON pi.id = spm.identity_id
      JOIN player_gamertags pg
        ON pg.identity_id = pi.id
       AND pg.server_id = spm.server_id
       AND pg.is_current_gamertag = 1
      JOIN servers s ON s.id = spm.server_id AND s.guild_id = spm.guild_id
      JOIN guilds g ON g.id = s.guild_id
      WHERE spm.identity_id = ?
        AND spm.user_id = ?
        AND spm.server_id = ?
        AND spm.status = 'active'
        AND s.status = 'active'
        AND g.status = 'approved'
      LIMIT 1
    `, [gameAccountId, req.user.id, serverId]);

    if (!account) {
      return res.status(404).json({ error: 'Linked account not found' });
    }
    let result;
    let roleJob;
    await db.transaction(async transactionDb => {
      await lockUserRoleMutations(transactionDb, [req.user.id]);
      await lockActiveLinkTenant(transactionDb, account.server_id, account.guild_id);
      result = await transactionDb.run(
        `UPDATE server_player_memberships
         SET status = 'revoked', updated_at = CURRENT_TIMESTAMP
         WHERE server_id = ? AND identity_id = ? AND user_id = ? AND status = 'active'`,
        [account.server_id, gameAccountId, req.user.id]
      );
      if (result.changes === 1) {
        roleJob = await enqueueRoleReconciliationJob(transactionDb, {
          discordGuildId: account.discord_guild_id,
          discordUserId: req.user.discord_id,
          userId: req.user.id,
        });
      }
    });
    if (result.changes !== 1) {
      return res.status(409).json({ error: 'Player membership changed; refresh and retry' });
    }

    const roleWarning = await reconcileWebsiteRoles(db, req, roleJob);
    console.log(`✅ User ${req.user.username} revoked membership for ${account.gamertag} on server ${account.server_id}`);
    return res.json({
      success: true,
      unlinkedCount: 1,
      message: 'Server membership removed successfully',
      roleWarning,
    });
  } catch (error) {
    console.error('Error in account unlinking:', error);
    res.status(500).json({ error: error.message });
  }
});
module.exports = router;
