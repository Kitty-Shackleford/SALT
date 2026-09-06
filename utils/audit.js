/**
 * Audit Logging Utility
 * Logs administrative actions for tracking and compliance
 */

/**
 * Log an administrative action
 * @param {Object} db - Database adapter instance
 * @param {number} userId - ID of user performing action
 * @param {string} action - Action type (e.g., 'ADD_GUILD', 'REMOVE_GUILD')
 * @param {string} targetType - Type of target (e.g., 'guild', 'user', 'server')
 * @param {string} targetId - ID of the target
 * @param {Object} details - Additional details about the action
 * @returns {Promise} Promise that resolves when logging is complete
 */
async function logAction(db, userId, action, targetType, targetId, details = {}) {
  const detailsJson = JSON.stringify(details);
  try {
    await db.run(
      'INSERT INTO audit_log (user_id, action, target_type, target_id, details) VALUES (?, ?, ?, ?, ?)',
      [userId, action, targetType, targetId, detailsJson]
    );
    console.log(`📝 Audit: ${action} on ${targetType}:${targetId} by user ${userId}`);
  } catch (err) {
    console.error('❌ Error logging audit action:', err);
    throw err;
  }
}

module.exports = { logAction };
