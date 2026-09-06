'use strict';

function finiteNumber(value, fieldName) {
  if (value === null || value === undefined || value === '') {
    throw new TypeError(`${fieldName} must be a finite number`);
  }
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${fieldName} must be a finite number`);
  return number;
}

function optionalFiniteNumber(value, fieldName) {
  if (value === null || value === undefined || value === '') return null;
  return finiteNumber(value, fieldName);
}

/** Decode a raw ADM tuple stored slot-for-slot as east, north, elevation. */
function admTupleToWorld(position) {
  return {
    east: finiteNumber(position.posX ?? position.pos_x, 'ADM posX'),
    north: finiteNumber(position.posY ?? position.pos_y, 'ADM posY'),
    elevation: optionalFiniteNumber(position.posZ ?? position.pos_z, 'ADM posZ'),
  };
}

/** Decode a semantic DayZ/Enforce vector where X=east, Y=elevation, Z=north. */
function worldVectorToWorld(position) {
  return {
    east: finiteNumber(position.x, 'world X'),
    north: finiteNumber(position.z, 'world Z'),
    elevation: optionalFiniteNumber(position.y, 'world Y'),
  };
}

module.exports = {
  admTupleToWorld,
  worldVectorToWorld,
};
