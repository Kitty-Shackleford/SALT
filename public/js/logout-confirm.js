'use strict';

const token = document.querySelector('meta[name="csrf-token"]')?.content || '';
document.getElementById('logoutCsrfToken').value = token;
