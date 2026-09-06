/**
 * Centralized error handling middleware
 */
function errorHandler(err, req, res) {
  // Log error for debugging
  console.error('❌ Error:', {
    message: err.message,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
    path: req.path,
    method: req.method,
    user: req.user?.username
  });

  // CSRF token errors
  if (err.code === 'EBADCSRFTOKEN') {
    return res.status(403).json({
      error: 'Invalid security token. Please refresh the page.'
    });
  }

  // Validation errors (from express-validator)
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({
      error: 'Invalid JSON in request body'
    });
  }

  // PostgreSQL errors use five-character SQLSTATE codes.
  if (typeof err.severity === 'string' && typeof err.code === 'string' && /^[0-9A-Z]{5}$/.test(err.code)) {
    return res.status(500).json({
      error: 'Database error. Please try again later.'
    });
  }

  // Rate limit errors
  if (err.status === 429) {
    return res.status(429).json({
      error: err.message || 'Too many requests'
    });
  }

  // Discord API errors
  if (err.message && err.message.includes('Discord')) {
    return res.status(502).json({
      error: 'Discord service unavailable. Please try again later.'
    });
  }

  // Default error response
  const statusCode = err.status || err.statusCode || 500;

  // Don't leak error details in production
  const message = process.env.NODE_ENV === 'production'
    ? 'An error occurred. Please try again later.'
    : err.message || 'Internal server error';

  res.status(statusCode).json({ error: message });
}

/**
 * 404 handler
 */
function notFoundHandler(req, res) {
  res.status(404).json({ error: 'Endpoint not found' });
}

module.exports = {
  errorHandler,
  notFoundHandler
};
