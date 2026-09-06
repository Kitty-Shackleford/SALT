'use strict';

const COORDINATE_FIELDS = ['pos_x', 'pos_y', 'pos_z', 'ypr_x', 'ypr_y', 'ypr_z'];

/**
 * Normalize cart placement coordinates before binding them to NOT NULL columns.
 * Missing values use the supplied existing row (for partial updates), then zero.
 */
function normalizeCartCoordinates(values = {}, existing = {}) {
  return Object.fromEntries(COORDINATE_FIELDS.map(field => {
    const supplied = values[field] !== undefined && values[field] !== null && values[field] !== '';
    const rawValue = supplied ? values[field] : (existing[field] ?? 0);
    const number = Number(rawValue);
    if (!Number.isFinite(number)) {
      throw new TypeError(`${field} must be a valid finite number`);
    }
    return [field, number];
  }));
}

module.exports = { normalizeCartCoordinates };
