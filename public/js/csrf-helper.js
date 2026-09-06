/**
 * CSRF Token Helper
 * Include this in all pages that make POST/PUT/DELETE requests
 */

/**
 * Get CSRF token from meta tag
 */
function getCsrfToken() {
  const token = document.querySelector('meta[name="csrf-token"]')?.content;
  if (!token) {
    console.error('❌ CSRF token not found in page');
  }
  return token;
}

/**
 * Fetch wrapper with automatic CSRF token inclusion
 * Uses central api.fetchWithCsrf if available, otherwise falls back to legacy implementation
 */
async function fetchWithCsrf(url, options = {}) {
  if (window && window.api && typeof window.api.fetchWithCsrf === 'function') {
    return window.api.fetchWithCsrf(url, options);
  }

  // Legacy fallback (should be unused once api.js is loaded)
  const token = getCsrfToken();

  // Require CSRF token for state-changing methods
  if (!token && ['POST', 'PUT', 'DELETE', 'PATCH'].includes(options.method?.toUpperCase())) {
    throw new Error('CSRF token missing. Please refresh the page.');
  }

  // Add CSRF token to headers
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers
  };

  if (token) {
    headers['CSRF-Token'] = token;
  }

  const response = await fetch(url, {
    ...options,
    headers,
    credentials: 'same-origin'
  });

  // Handle CSRF errors gracefully
  if (response.status === 403) {
    // Clone response to allow multiple reads
    const responseClone = response.clone();

    try {
      const data = await response.json();
      if (data.error?.toLowerCase().includes('csrf')) {
        alert('Your session has expired. The page will reload.');
        window.location.reload();
        throw new Error('CSRF token invalid - page reloading');
      }
    } catch (parseError) {
      // If JSON parsing fails, try reading as text
      try {
        const text = await responseClone.text();
        if (text.toLowerCase().includes('csrf')) {
          alert('Your session has expired. The page will reload.');
          window.location.reload();
          throw new Error('CSRF token invalid - page reloading');
        }
      } catch (textError) {
        // Silently fail if we can't read the response
      }
    }
  }

  return response;
}

// jQuery AJAX setup (if using jQuery)
if (typeof $ !== 'undefined') {
  $.ajaxSetup({
    beforeSend: function(xhr) {
      const token = getCsrfToken();
      if (token) {
        xhr.setRequestHeader('CSRF-Token', token);
      }
    }
  });
}
