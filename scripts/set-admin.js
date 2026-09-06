#!/usr/bin/env node
/*
Set or unset the global admin flag for a user.

Usage:
  node scripts/set-admin.js --discordId <DISCORD_ID> [--username <NAME>] [--role admin|owner] [--unset]
  node scripts/set-admin.js --id <INTERNAL_USER_ID> [--unset]
  node scripts/set-admin.js --email <EMAIL> [--username <NAME>] [--unset]

Examples:
  node scripts/set-admin.js --discordId 123456789012345678
  node scripts/set-admin.js --discordId 123456789012345678 --username "Alice" --unset

Notes:
  - The script uses the same DB configuration as the application (env vars).
  - New users require a Discord ID. Email may locate an existing user but cannot create one.
  - --unset will clear the is_admin flag instead of setting it.

*/

require('dotenv').config();
const { initializeDatabase, closeDatabase } = require('../db/abstraction');

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--discordId' || a === '--discord-id') { out.discordId = args[++i]; continue; }
    if (a === '--id') { out.id = args[++i]; continue; }
    if (a === '--email') { out.email = args[++i]; continue; }
    if (a === '--username') { out.username = args[++i]; continue; }
    if (a === '--role') { out.role = args[++i]; continue; }
    if (a === '--transfer-owner') { out.transferOwner = true; continue; }
    if (a === '--unset') { out.unset = true; continue; }
    if (a === '--help' || a === '-h') { out.help = true; }
  }
  return out;
}

async function main() {
  const opts = parseArgs();
  const requestedRole = opts.unset ? null : (opts.role === 'owner' ? 'dashboard_owner' : 'dashboard_admin');
  if (opts.role && !['admin', 'owner'].includes(opts.role)) {
    console.error('ERROR: --role must be admin or owner');
    process.exit(2);
  }
  if (opts.help) {
    console.log('Usage: node scripts/set-admin.js --discordId <DISCORD_ID> [--username <NAME>] [--unset]');
    process.exit(0);
  }

  if (!opts.discordId && !opts.id && !opts.email) {
    console.error('ERROR: Must provide --discordId OR --id OR --email');
    process.exit(2);
  }

  const db = await initializeDatabase();

  try {
    const result = await db.transaction(async transactionDb => {
      await transactionDb.query("SELECT pg_advisory_xact_lock(hashtext('dashboard_owner'))");

      let user = null;
      if (opts.id) user = await transactionDb.get('SELECT * FROM users WHERE id = ? FOR UPDATE', [opts.id]);
      else if (opts.discordId) user = await transactionDb.get('SELECT * FROM users WHERE discord_id = ? FOR UPDATE', [opts.discordId]);
      else if (opts.email) user = await transactionDb.get('SELECT * FROM users WHERE email = ? FOR UPDATE', [opts.email]);

      let created = false;
      if (!user) {
        if (opts.unset) return { nothingToUnset: true };
        if (!opts.discordId) {
          throw new Error('A Discord ID is required when creating a new user.');
        }
        const insertObj = {
          discord_id: opts.discordId || null,
          username: opts.username || (`admin_${opts.discordId || opts.email || Date.now()}`),
          email: opts.email || null,
          is_admin: 1,
          // Promote to owner only after the serialized owner check below.
          platform_role: requestedRole === 'dashboard_owner' ? 'dashboard_admin' : requestedRole,
        };
        Object.keys(insertObj).forEach(key => insertObj[key] === null && delete insertObj[key]);
        const id = await transactionDb.insert('users', insertObj);
        user = await transactionDb.get('SELECT * FROM users WHERE id = ? FOR UPDATE', [id]);
        created = true;
      }

      const owners = await transactionDb.query(
        "SELECT id FROM users WHERE platform_role = 'dashboard_owner' FOR UPDATE"
      );
      const differentOwners = owners.filter(row => Number(row.id) !== Number(user.id));

      if (user.platform_role === 'dashboard_owner' && requestedRole !== 'dashboard_owner') {
        throw new Error('Cannot unset the Dashboard Owner; use --transfer-owner to promote a replacement.');
      }
      if (requestedRole === 'dashboard_owner' && differentOwners.length > 0 && !opts.transferOwner) {
        throw new Error('A Dashboard Owner already exists. Re-run with --transfer-owner for an explicit transfer.');
      }
      if (requestedRole === 'dashboard_owner' && differentOwners.length > 0) {
        await transactionDb.run(
          "UPDATE users SET platform_role = 'dashboard_admin', is_admin = 1 WHERE platform_role = 'dashboard_owner' AND id <> ?",
          [user.id]
        );
      }
      await transactionDb.run(
        'UPDATE users SET platform_role = ?, is_admin = ? WHERE id = ?',
        [requestedRole, requestedRole ? 1 : 0, user.id]
      );
      await transactionDb.run(
        `INSERT INTO security_audit_events (actor_user_id, action, result, target_type, target_id, metadata)
         VALUES (NULL, 'platform_role.reconciled_cli', 'allowed', 'user', ?, ?)`,
        [String(user.id), JSON.stringify({ role: requestedRole, ownershipTransfer: Boolean(opts.transferOwner), created })]
      );
      return { userId: user.id, nothingToUnset: false };
    });

    if (result.nothingToUnset) {
      console.log('User not found; nothing to unset.');
      return;
    }
    const updated = await db.get('SELECT id, discord_id, username, email, is_admin, platform_role FROM users WHERE id = ?', [result.userId]);
    console.log(`Updated user id=${updated.id}, discord_id=${updated.discord_id || '-'}, email=${updated.email || '-'}, platform_role=${updated.platform_role || '-'}, is_admin=${updated.is_admin}`);

  } catch (err) {
    console.error('ERROR:', err.message || err);
    process.exit(1);
  } finally {
    try { await closeDatabase(); } catch (_) { /* best-effort shutdown */ }
  }
}

main();
