/* eslint-disable no-control-regex */
/**
 * Text sanitization utilities for handling server names with special characters
 *
 * Many DayZ servers use invisible control characters (SOH, zero-width spaces, etc.)
 * to appear first alphabetically. We preserve these in the database but sanitize
 * for display purposes.
 */

/**
 * Remove invisible and control characters from text for display
 * @param {string} text - Text to sanitize
 * @returns {string} - Sanitized text safe for display
 */
function sanitizeServerName(text) {
  if (!text) return '';

  return text
    // Remove ASCII control characters (0x00-0x1F) except tab (\x09), newline (\x0A), carriage return (\x0D)
    // Tab/newline/CR are preserved in content but trimmed from edges below
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    // Remove Unicode control characters
    .replace(/[\u0080-\u009F]/g, '')
    // Remove zero-width spaces and invisible characters
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    // Remove bidirectional text markers
    .replace(/[\u202A-\u202E]/g, '')
    // Trim whitespace
    .trim();
}

/**
 * Get a safe display name for a server with fallback
 * @param {object} server - Server object with name/ID fields
 * @returns {string} - Safe display name
 */
function getDisplayName(server) {
  // Allow a per-server custom display name and sanitize all names for display.
  // Try multiple name fields (different endpoints use different naming)
  const rawName = server && (server.serverName || server.name || '');
  const customName = server && (server.custom_name || server.customName || '');

  // If a custom name exists, sanitize and prefer it when non-empty
  if (customName) {
    const sanitizedCustom = sanitizeServerName(String(customName));
    if (sanitizedCustom) return sanitizedCustom;
  }

  const sanitized = sanitizeServerName(rawName);

  // If sanitization results in empty string, return a clear prompt so an
  // administrator/owner can set a custom name. Use a distinct placeholder.
  if (!sanitized) {
    const serverId = server && (server.nitrado_server_id || server.platform_server_id || server.id);
    return serverId ? `SET CUSTOM NAME` : 'Unknown Server';
  }

  return sanitized;
}

/**
 * Sanitize text for safe logging (truncate if too long)
 * @param {string} text - Text to sanitize
 * @param {number} maxLength - Maximum length (default 100)
 * @returns {string} - Safe text for logging
 */
function sanitizeForLog(text, maxLength = 100) {
  if (!text) return '(empty)';

  const sanitized = sanitizeServerName(text);
  if (sanitized.length <= maxLength) {
    return sanitized;
  }

  return sanitized.substring(0, maxLength) + '...';
}

module.exports = {
  sanitizeServerName,
  getDisplayName,
  sanitizeForLog
};
