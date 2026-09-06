'use strict';

const PostgreSQLAdapter = require('../../db/abstraction/postgres');
const pool = require('../db');

const adapter = new PostgreSQLAdapter();
adapter.pool = pool;

module.exports = adapter;
