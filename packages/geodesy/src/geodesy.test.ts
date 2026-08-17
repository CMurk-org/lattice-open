// Copyright (c) 2026 Alvand Kiumarsi
// SPDX-License-Identifier: MPL-2.0
//
// This Source Code Form is subject to the terms of the Mozilla Public License,
// v. 2.0. If a copy of the MPL was not distributed with this file, You can
// obtain one at https://mozilla.org/MPL/2.0/.

import { describe, it, expect } from 'vitest';
import {
  haversineDistance,
  initialBearing,
  destinationPoint,
  normalizeBearing,
  bearingDifference,
  boundingBoxAround,
  boundingBoxContains,
  unionBoundingBoxes,
  pointInPolygon,
  polygonAreaM2,
  impliedSpeedMps,
  isValidCoordinate,
  isNullIsland,
  EARTH_RADIUS_M,
} from './geodesy';

const DENVER = { lat: 39.7392, lon: -104.9903 };

describe('haversineDistance', () => {
  it('is zero for a point to itself', () => {
    expect(haversineDistance(DENVER, DENVER)).toBe(0);
  });

  it('matches one degree of latitude at the mean Earth radius', () => {
    const oneDegree = (2 * Math.PI * EARTH_RADIUS_M) / 360;
    const measured = haversineDistance({ lat: 0, lon: 0 }, { lat: 1, lon: 0 });
    expect(measured).toBeCloseTo(oneDegree, 1);
    expect(measured).toBeCloseTo(111_195, 0);
  });

  it('matches a published long-haul great-circle distance within 0.5%', () => {
    // New York (JFK) to Los Angeles (LAX): ~3,974 km great-circle.
    const jfk = { lat: 40.6413, lon: -73.7781 };
    const lax = { lat: 33.9416, lon: -118.4085 };
    const measured = haversineDistance(jfk, lax) / 1000;
    expect(measured).toBeGreaterThan(3954);
    expect(measured).toBeLessThan(3994);
  });

  it('is symmetric', () => {
    const a = { lat: 39.7, lon: -105.0 };
    const b = { lat: 39.8, lon: -104.9 };
    expect(haversineDistance(a, b)).toBeCloseTo(haversineDistance(b, a), 9);
  });

  it('handles antimeridian-crossing pairs without exploding', () => {
    const west = { lat: 0, lon: 179.9 };
    const east = { lat: 0, lon: -179.9 };
    const measured = haversineDistance(west, east);
    // 0.2 degrees of longitude at the equator.
    expect(measured).toBeCloseTo((0.2 * 2 * Math.PI * EARTH_RADIUS_M) / 360, 0);
  });
});

describe('destinationPoint and initialBearing round-trip', () => {
  const distances = [100, 500, 1_000, 5_000, 25_000];
  const bearings = [0, 45, 90, 135, 180, 225, 270, 315, 359];

  it('returns a point at exactly the requested distance and bearing', () => {
    for (const distance of distances) {
      for (const bearing of bearings) {
        const target = destinationPoint(DENVER, bearing, distance);
        expect(haversineDistance(DENVER, target)).toBeCloseTo(distance, 3);
        expect(bearingDifference(initialBearing(DENVER, target), bearing)).toBeLessThan(1e-6);
      }
    }
  });

  it('moves due north for bearing 0', () => {
    const north = destinationPoint(DENVER, 0, 1000);
    expect(north.lat).toBeGreaterThan(DENVER.lat);
    expect(north.lon).toBeCloseTo(DENVER.lon, 9);
  });

  it('moves due east for bearing 90', () => {
    const east = destinationPoint(DENVER, 90, 1000);
    expect(east.lon).toBeGreaterThan(DENVER.lon);
    expect(east.lat).toBeCloseTo(DENVER.lat, 4);
  });

  it('keeps longitude within [-180, 180] when crossing the antimeridian', () => {
    const start = { lat: 0, lon: 179.99 };
    const crossed = destinationPoint(start, 90, 5000);
    expect(crossed.lon).toBeGreaterThanOrEqual(-180);
    expect(crossed.lon).toBeLessThanOrEqual(180);
    expect(crossed.lon).toBeLessThan(0);
  });
});

describe('bearing arithmetic', () => {
  it('normalizes negative and over-360 bearings', () => {
    expect(normalizeBearing(-90)).toBe(270);
    expect(normalizeBearing(450)).toBe(90);
    expect(normalizeBearing(360)).toBe(0);
  });

  it('measures the short way around the 0/360 wrap', () => {
    // This is the case that breaks naive sector-containment implementations.
    expect(bearingDifference(350, 10)).toBe(20);
    expect(bearingDifference(10, 350)).toBe(20);
    expect(bearingDifference(0, 359)).toBe(1);
    expect(bearingDifference(180, 0)).toBe(180);
    expect(bearingDifference(45, 45)).toBe(0);
  });

  it('never reports more than 180 degrees', () => {
    for (let a = 0; a < 360; a += 7) {
      for (let b = 0; b < 360; b += 11) {
        expect(bearingDifference(a, b)).toBeLessThanOrEqual(180);
      }
    }
  });
});

describe('bounding boxes', () => {
  it('contains every point on the circle of the given radius', () => {
    const box = boundingBoxAround(DENVER, 2000);
    for (let bearing = 0; bearing < 360; bearing += 15) {
      expect(boundingBoxContains(box, destinationPoint(DENVER, bearing, 1999))).toBe(true);
    }
  });

  it('widens in longitude as latitude increases', () => {
    const equator = boundingBoxAround({ lat: 0, lon: 0 }, 10_000);
    const arctic = boundingBoxAround({ lat: 70, lon: 0 }, 10_000);
    expect(arctic.maxLon - arctic.minLon).toBeGreaterThan(equator.maxLon - equator.minLon);
  });

  it('unions boxes to cover all of them', () => {
    const a = boundingBoxAround(DENVER, 1000);
    const b = boundingBoxAround({ lat: 39.8, lon: -104.9 }, 1000);
    const union = unionBoundingBoxes([a, b])!;
    expect(union.minLat).toBeLessThanOrEqual(Math.min(a.minLat, b.minLat));
    expect(union.maxLon).toBeGreaterThanOrEqual(Math.max(a.maxLon, b.maxLon));
  });

  it('returns undefined for an empty list rather than a bogus box', () => {
    expect(unionBoundingBoxes([])).toBeUndefined();
  });
});

describe('polygon operations', () => {
  const square: [number, number][] = [
    [-105.0, 39.7],
    [-104.9, 39.7],
    [-104.9, 39.8],
    [-105.0, 39.8],
    [-105.0, 39.7],
  ];

  it('detects containment', () => {
    expect(pointInPolygon({ lat: 39.75, lon: -104.95 }, square)).toBe(true);
    expect(pointInPolygon({ lat: 39.65, lon: -104.95 }, square)).toBe(false);
    expect(pointInPolygon({ lat: 39.75, lon: -105.5 }, square)).toBe(false);
  });

  it('computes an area consistent with the same box measured by distance', () => {
    const area = polygonAreaM2(square);
    const width = haversineDistance({ lat: 39.75, lon: -105.0 }, { lat: 39.75, lon: -104.9 });
    const height = haversineDistance({ lat: 39.7, lon: -104.95 }, { lat: 39.8, lon: -104.95 });
    expect(area).toBeGreaterThan(width * height * 0.98);
    expect(area).toBeLessThan(width * height * 1.02);
  });

  it('returns zero area for a degenerate ring', () => {
    expect(polygonAreaM2([[0, 0], [1, 1]])).toBe(0);
  });
});

describe('coordinate validation', () => {
  it('rejects out-of-range coordinates', () => {
    expect(isValidCoordinate({ lat: 91, lon: 0 })).toBe(false);
    expect(isValidCoordinate({ lat: 0, lon: 181 })).toBe(false);
    expect(isValidCoordinate({ lat: Number.NaN, lon: 0 })).toBe(false);
    expect(isValidCoordinate(DENVER)).toBe(true);
  });

  it('identifies the 0,0 missing-value placeholder', () => {
    expect(isNullIsland({ lat: 0, lon: 0 })).toBe(true);
    expect(isNullIsland({ lat: 0.001, lon: 0 })).toBe(false);
  });
});

describe('impliedSpeedMps', () => {
  it('computes speed between two observations', () => {
    const start = DENVER;
    const end = destinationPoint(DENVER, 90, 1000);
    const speed = impliedSpeedMps(start, '2024-03-15T22:00:00Z', end, '2024-03-15T22:01:00Z');
    expect(speed).toBeCloseTo(1000 / 60, 3);
  });

  it('refuses to report an infinite speed for simultaneous observations', () => {
    expect(impliedSpeedMps(DENVER, '2024-03-15T22:00:00Z', DENVER, '2024-03-15T22:00:00Z')).toBeUndefined();
  });

  it('refuses to report a speed for out-of-order observations', () => {
    const end = destinationPoint(DENVER, 90, 1000);
    expect(impliedSpeedMps(DENVER, '2024-03-15T22:01:00Z', end, '2024-03-15T22:00:00Z')).toBeUndefined();
  });
});
