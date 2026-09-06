'use strict';

const path = require('path');

function logStartTimeMs(filename) {
  const match = String(filename || '').match(/(?:^|_)(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})(?:\D|$)/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31 ||
      hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) {
    return null;
  }
  const timestamp = Date.UTC(year, month - 1, day, hour, minute, second);
  const parsed = new Date(timestamp);
  if (!Number.isFinite(timestamp) || parsed.getUTCFullYear() !== year ||
      parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day ||
      parsed.getUTCHours() !== hour || parsed.getUTCMinutes() !== minute ||
      parsed.getUTCSeconds() !== second) {
    return null;
  }
  return timestamp;
}

function parseStrictTimestampMs(value) {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  if (typeof value !== 'string') return null;
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/
  );
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone] = match;
  const [year, month, day, hour, minute, second] =
    [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  const calendarMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const calendar = new Date(calendarMs);
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1
      || calendar.getUTCDate() !== day || calendar.getUTCHours() !== hour
      || calendar.getUTCMinutes() !== minute || calendar.getUTCSeconds() !== second) {
    return null;
  }
  if (zone !== 'Z') {
    const [offsetHour, offsetMinute] = zone.slice(1).split(':').map(Number);
    if (offsetHour > 23 || offsetMinute > 59) return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function isSupportedRptFilename(fileName) {
  return typeof fileName === 'string'
    && path.basename(fileName) === fileName
    && /^DayZServer(?:P?_X1|_PS4|_NSW2)?_x64_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.RPT$/i.test(fileName)
    && logStartTimeMs(fileName) !== null;
}

function compareLogFileEntries(left, right) {
  const leftStart = logStartTimeMs(left.name) ?? Number(left.mtimeMs || 0);
  const rightStart = logStartTimeMs(right.name) ?? Number(right.mtimeMs || 0);
  return leftStart - rightStart ||
    String(left.name || '').localeCompare(String(right.name || ''));
}

module.exports = {
  logStartTimeMs,
  parseStrictTimestampMs,
  isSupportedRptFilename,
  compareLogFileEntries,
};
