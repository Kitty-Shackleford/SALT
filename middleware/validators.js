const { body, param, query, validationResult } = require('express-validator');

// Middleware to check validation results
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      error: 'Validation failed',
      details: errors.array()
    });
  }
  next();
};

// Discord Guild ID validation (snowflake: 17-19 digit number)
const validateGuildId = [
  body('guildId')
    .trim()
    .isNumeric()
    .isLength({ min: 17, max: 19 })
    .withMessage('Invalid guild ID'),
  handleValidationErrors
];

// Server ID validation
const validateServerId = [
  param('serverId')
    .trim()
    .isNumeric()
    .withMessage('Invalid server ID'),
  handleValidationErrors
];

// Game account ID validation
const validateGameAccountId = [
  body('gameAccountId')
    .trim()
    .isInt({ min: 1 })
    .withMessage('Invalid game account ID'),
  handleValidationErrors
];

// Token validation
const validateToken = [
  body('token')
    .trim()
    .notEmpty()
    .isLength({ min: 10, max: 500 })
    .matches(/^[A-Za-z0-9_-]+$/)
    .withMessage('Invalid token format'),
  handleValidationErrors
];

// Pagination validation
const validatePagination = [
  query('page')
    .optional()
    .isInt({ min: 1 })
    .toInt()
    .withMessage('Page must be a positive integer'),
  query('limit')
    .optional()
    .isInt({ min: 1, max: 100 })
    .toInt()
    .withMessage('Limit must be between 1 and 100'),
  handleValidationErrors
];

// Sort validation (matches routes/logParser.js allowed fields)
const validateSort = [
  query('sortBy')
    .optional()
    .isIn(['currentName', 'bohemiaId', 'deviceId', 'firstSeenAt', 'lastSeenAt'])
    .withMessage('Invalid sort field'),
  query('sortOrder')
    .optional()
    .isIn(['asc', 'desc', 'ASC', 'DESC'])
    .toUpperCase()
    .withMessage('Invalid sort order'),
  handleValidationErrors
];

module.exports = {
  validateGuildId,
  validateServerId,
  validateGameAccountId,
  validateToken,
  validatePagination,
  validateSort,
  handleValidationErrors
};
