#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const coordinates = require('../public/js/dayz-map-coordinates');

const inputPath = path.resolve(process.argv[2] || path.join(__dirname, 'coordinate-calibration-points.json'));
const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));

function solve3(matrix, vector) {
  const a = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < 3; column++) {
    let pivot = column;
    for (let row = column + 1; row < 3; row++) {
      if (Math.abs(a[row][column]) > Math.abs(a[pivot][column])) pivot = row;
    }
    [a[column], a[pivot]] = [a[pivot], a[column]];
    const divisor = a[column][column];
    if (Math.abs(divisor) < 1e-12) throw new Error('Calibration points do not span a solvable 2D affine basis');
    for (let item = column; item < 4; item++) a[column][item] /= divisor;
    for (let row = 0; row < 3; row++) {
      if (row === column) continue;
      const factor = a[row][column];
      for (let item = column; item < 4; item++) a[row][item] -= factor * a[column][item];
    }
  }
  return a.map(row => row[3]);
}

function fitAffine(points, targetAxis) {
  const normal = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const rhs = [0, 0, 0];
  for (const point of points) {
    const source = [point.world.x, point.world.z, 1];
    const target = point.pixel[targetAxis];
    for (let row = 0; row < 3; row++) {
      rhs[row] += source[row] * target;
      for (let column = 0; column < 3; column++) normal[row][column] += source[row] * source[column];
    }
  }
  return solve3(normal, rhs);
}

function applyAffine(coefficientsX, coefficientsY, world) {
  return {
    x: coefficientsX[0] * world.x + coefficientsX[1] * world.z + coefficientsX[2],
    y: coefficientsY[0] * world.x + coefficientsY[1] * world.z + coefficientsY[2],
  };
}

function invertAffine(coefficientsX, coefficientsY, pixel) {
  const determinant = coefficientsX[0] * coefficientsY[1] - coefficientsX[1] * coefficientsY[0];
  if (Math.abs(determinant) < 1e-12) throw new Error('Affine transformation is not invertible');
  const shiftedX = pixel.x - coefficientsX[2];
  const shiftedY = pixel.y - coefficientsY[2];
  return {
    x: (shiftedX * coefficientsY[1] - coefficientsX[1] * shiftedY) / determinant,
    z: (coefficientsX[0] * shiftedY - shiftedX * coefficientsY[0]) / determinant,
  };
}

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return {
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    max: sorted[sorted.length - 1],
  };
}

function formatCoefficients(values) {
  return values.map(value => Number(value.toFixed(12)));
}

for (const map of input.maps) {
  if (map.points.length < 3) throw new Error(`${map.id} requires at least three calibration points`);
  const pixelX = fitAffine(map.points, 'x');
  const pixelY = fitAffine(map.points, 'y');
  const calibratedErrors = [];
  const currentErrors = [];
  const previousErrors = [];
  const roundTripErrors = [];
  const runtimeDefinition = coordinates.getMapDefinition(map.id);

  for (const point of map.points) {
    const fitted = applyAffine(pixelX, pixelY, point.world);
    calibratedErrors.push(Math.hypot(fitted.x - point.pixel.x, fitted.y - point.pixel.y));

    const current = {
      x: point.world.x / runtimeDefinition.worldWidth * runtimeDefinition.imageWidth,
      y: (1 - point.world.z / runtimeDefinition.worldHeight) * runtimeDefinition.imageHeight,
    };
    currentErrors.push(Math.hypot(current.x - point.pixel.x, current.y - point.pixel.y));

    if (map.previousWorldSize) {
      const previous = {
        x: point.world.x / map.previousWorldSize * map.imageWidth,
        y: (1 - point.world.z / map.previousWorldSize) * map.imageHeight,
      };
      previousErrors.push(Math.hypot(previous.x - point.pixel.x, previous.y - point.pixel.y));
    }

    const roundTrip = invertAffine(pixelX, pixelY, fitted);
    roundTripErrors.push(Math.hypot(roundTrip.x - point.world.x, roundTrip.z - point.world.z));
  }

  console.log(JSON.stringify({
    map: map.id,
    pointCount: map.points.length,
    affine: {
      pixelX: formatCoefficients(pixelX),
      pixelY: formatCoefficients(pixelY),
    },
    expectedSimpleModel: {
      pixelX: [map.imageWidth / map.worldWidth, 0, 0],
      pixelY: [0, -map.imageHeight / map.worldHeight, map.imageHeight],
    },
    calibratedPixelError: summarize(calibratedErrors),
    currentConfiguredPixelError: summarize(currentErrors),
    previousConfiguredPixelError: previousErrors.length ? summarize(previousErrors) : null,
    roundTripWorldError: summarize(roundTripErrors),
  }));
}
