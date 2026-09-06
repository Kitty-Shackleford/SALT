/**
 * Migration 007: Migrate user tokens (V1 → V2 transition)
 * NOTE: This is a deprecated migration for V1→V2 upgrades only, not fresh installs.
 */

exports.up = function() {
  console.log('⚠️  DEPRECATED: This migration is for Schema V1 → V2 transition');
  console.log('   Schema V2 is now the default schema.');
  console.log('');
  console.log('   Legacy V1 conversion is unsupported; restore from backup and use a validated import process.');
  console.log('');

  return Promise.resolve();
};

exports.down = function() {
  return Promise.resolve();
};
