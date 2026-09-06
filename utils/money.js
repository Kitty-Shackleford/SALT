'use strict';

const MAX_NUMERIC_20_2_CENTS = 99999999999999999999n;

/**
 * Canonical money arithmetic. External amounts must already be exact cents.
 * Values derived from percentages or payout multipliers round to the nearest
 * cent, with exact half cents rounded away from zero (PostgreSQL NUMERIC rule).
 */
function decimalParts(value, label, maxScale) {
  if ((typeof value !== 'number' && typeof value !== 'string')
      || (typeof value === 'number' && !Number.isFinite(value))) {
    throw new Error(`${label} must be a valid amount`);
  }
  const text = String(value).trim();
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match || (match[3]?.length || 0) > maxScale) {
    const scaleLabel = maxScale === 2 ? 'two' : String(maxScale);
    throw new Error(`${label} must be a valid amount with at most ${scaleLabel} decimals`);
  }
  const scale = match[3]?.length || 0;
  const magnitude = BigInt(match[2] + (match[3] || ''));
  return { numerator: match[1] ? -magnitude : magnitude, denominator: 10n ** BigInt(scale) };
}

function safeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`${label} exceeds the supported exact range`);
  return number;
}

function parseCents(value, label = 'Amount', options = {}) {
  const cents = parseCentsBigInt(value, label, options);
  return safeInteger(cents, label);
}

function parseCentsBigInt(value, label = 'Amount', options = {}) {
  const { numerator, denominator } = decimalParts(value, label, 2);
  if (!options.allowNegative && numerator < 0n) throw new Error(`${label} must be non-negative`);
  return numerator * (100n / denominator);
}

function checkedAddCents(balanceCents, creditCents, label = 'Destination balance') {
  const valuesAreBigInt = typeof balanceCents === 'bigint' && typeof creditCents === 'bigint';
  const valuesAreSafeNumbers = Number.isSafeInteger(balanceCents) && Number.isSafeInteger(creditCents);
  if (!valuesAreBigInt && !valuesAreSafeNumbers) {
    throw new Error(`${label} requires exact cents`);
  }
  const total = BigInt(balanceCents) + BigInt(creditCents);
  const limit = valuesAreBigInt ? MAX_NUMERIC_20_2_CENTS : BigInt(Number.MAX_SAFE_INTEGER);
  if (total > limit || total < -limit) {
    const error = new Error(`${label} capacity exceeded`);
    error.status = 409;
    throw error;
  }
  return valuesAreBigInt ? total : Number(total);
}

function centsToAmount(cents) {
  if (!Number.isSafeInteger(cents)) throw new Error('Cents must be a safe integer');
  return cents / 100;
}

function centsToDecimal(cents) {
  if (typeof cents === 'bigint') {
    const sign = cents < 0n ? '-' : '';
    const magnitude = cents < 0n ? -cents : cents;
    return `${sign}${magnitude / 100n}.${String(magnitude % 100n).padStart(2, '0')}`;
  }
  if (!Number.isSafeInteger(cents)) throw new Error('Cents must be a safe integer');
  return centsToDecimal(BigInt(cents));
}

function centsForResponse(cents) {
  return cents <= BigInt(Number.MAX_SAFE_INTEGER) && cents >= BigInt(Number.MIN_SAFE_INTEGER)
    ? centsToAmount(Number(cents))
    : centsToDecimal(cents);
}

function amountForResponse(value, label = 'Amount') {
  return centsForResponse(parseCentsBigInt(value, label, { allowNegative: true }));
}

function roundRatio(numerator, denominator) {
  if (denominator <= 0n) throw new Error('Rounding denominator must be positive');
  const sign = numerator < 0n ? -1n : 1n;
  const magnitude = numerator < 0n ? -numerator : numerator;
  const rounded = (magnitude + denominator / 2n) / denominator;
  return rounded * sign;
}

function percentageRatioForResponse(numeratorCents, denominatorCents) {
  if (denominatorCents <= 0n) return null;
  return centsForResponse(roundRatio(numeratorCents * 10000n, denominatorCents));
}

function percentageOfCents(amountCents, percentage) {
  if (!Number.isSafeInteger(amountCents)) throw new Error('Amount cents must be a safe integer');
  const percentageHundredths = parseCents(percentage, 'Percentage', { allowNegative: true });
  return safeInteger(roundRatio(BigInt(amountCents) * BigInt(percentageHundredths), 10000n), 'Percentage result');
}

function multiplyCents(amountCents, multiplier) {
  if (!Number.isSafeInteger(amountCents)) throw new Error('Amount cents must be a safe integer');
  const factor = decimalParts(multiplier, 'Multiplier', 6);
  return safeInteger(roundRatio(BigInt(amountCents) * factor.numerator, factor.denominator), 'Multiplied amount');
}

function playtimeRewardCents(hourlyRate, durationSeconds) {
  const rateCents = parseCents(hourlyRate, 'Hourly reward');
  if (!Number.isSafeInteger(durationSeconds) || durationSeconds < 0) {
    throw new Error('Session duration must be a non-negative integer');
  }
  return safeInteger(roundRatio(BigInt(rateCents) * BigInt(durationSeconds), 3600n), 'Playtime reward');
}

module.exports = {
  parseCents, parseCentsBigInt,
  checkedAddCents,
  centsToAmount,
  centsToDecimal,
  centsForResponse,
  amountForResponse,
  percentageRatioForResponse,
  percentageOfCents,
  multiplyCents,
  playtimeRewardCents,
};
