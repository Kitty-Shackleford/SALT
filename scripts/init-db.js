#!/usr/bin/env node
'use strict';

require('dotenv').config();

const { validateEnv } = require('../utils/envValidator');
const { initializeDatabase } = require('../db/schema');
const { closeDatabase } = require('../db/abstraction');

async function main() {
  validateEnv('database');
  await initializeDatabase();
  await closeDatabase();
  console.log('✅ Database initialization complete');
}

main().catch(error => {
  console.error('❌ Database initialization failed:', error.message);
  process.exit(1);
});
