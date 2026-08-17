// Copyright (c) 2026 Alvand Kiumarsi
// SPDX-License-Identifier: MPL-2.0
//
// This Source Code Form is subject to the terms of the Mozilla Public License,
// v. 2.0. If a copy of the MPL was not distributed with this file, You can
// obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Geodesy primitives.
 *
 * All distances are in metres, all bearings in degrees true (clockwise from
 * north), matching how carriers state antenna azimuths.
 *
 * We use spherical (haversine / great-circle) formulae rather than the full
 * WGS-84 ellipsoid. Over the distances that matter for cellular coverage
 * (under ~100 km) the spherical error is under ~0.3%, which is two orders of
 * magnitude smaller than the uncertainty of the underlying radio measurements.
 * Introducing ellipsoidal precision here would imply an accuracy the evidence
 * does not have. This choice is documented in the method registry and printed
 * in reports.
 */

import type { GeoPoint } from '@cmurk/cellular-schema';

/** IUGG mean Earth radius, metres. */
export const EARTH_RADIUS_M = 6_371_008.8;
export const SPEED_OF_LIGHT_MPS = 299_792_458;

export const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;
export const toDegrees = (radians: number): number => (radians * 180) / Math.PI;

/** Normalize any bearing to [0, 360). */
export function normalizeBearing(degrees: number): number {
  const wrapped = degrees % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/**
 * Smallest absolute angular difference between two bearings, in degrees.
 * Handles the 0/360 wrap, which is where naive implementations produce
 * catastrophically wrong sector-containment results.
 */
export function bearingDifference(a: number, b: number): number {
  const diff = Math.abs(normalizeBearing(a) - normalizeBearing(b)) % 360;
  return diff > 180 ? 360 - diff : diff;
}

export function isValidCoordinate(point: GeoPoint): boolean {
  return (
    Number.isFinite(point.lat) &&
    Number.isFinite(point.lon) &&
    point.lat >= -90 &&
    point.lat <= 90 &&
    point.lon >= -180 &&
    point.lon <= 180
  );
}

/** Exactly 0,0 — the Gulf of Guinea. In carrier data this is always a missing value. */
export function isNullIsland(point: GeoPoint): boolean {
  return point.lat === 0 && point.lon === 0;
}

/** Great-circle distance in metres. */
export function haversineDistance(from: GeoPoint, to: GeoPoint): number {
  const lat1 = toRadians(from.lat);
  const lat2 = toRadians(to.lat);
  const deltaLat = toRadians(to.lat - from.lat);
  const deltaLon = toRadians(to.lon - from.lon);

  const a =
    Math.sin(deltaLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial bearing from one point to another, in degrees true. */
export function initialBearing(from: GeoPoint, to: GeoPoint): number {
  const lat1 = toRadians(from.lat);
  const lat2 = toRadians(to.lat);
  const deltaLon = toRadians(to.lon - from.lon);

  const y = Math.sin(deltaLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon);
  return normalizeBearing(toDegrees(Math.atan2(y, x)));
}

/** Point reached by travelling `distanceM` from `origin` along `bearingDegrees`. */
export function destinationPoint(
  origin: GeoPoint,
  bearingDegrees: number,
  distanceM: number,
): GeoPoint {
  const angular = distanceM / EARTH_RADIUS_M;
  const bearing = toRadians(normalizeBearing(bearingDegrees));
  const lat1 = toRadians(origin.lat);
  const lon1 = toRadians(origin.lon);

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angular) + Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing),
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1),
      Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2),
    );

  return {
    lat: toDegrees(lat2),
    // Normalise longitude to [-180, 180] so geometry crossing the antimeridian stays valid.
    lon: ((toDegrees(lon2) + 540) % 360) - 180,
  };
}

export interface BoundingBox {
  readonly minLat: number;
  readonly minLon: number;
  readonly maxLat: number;
  readonly maxLon: number;
}

export function boundingBoxAround(center: GeoPoint, radiusM: number): BoundingBox {
  const latDelta = toDegrees(radiusM / EARTH_RADIUS_M);
  // Longitude degrees shrink with latitude; guard against the poles where they vanish.
  const cosLat = Math.cos(toRadians(center.lat));
  const lonDelta = cosLat < 1e-9 ? 180 : toDegrees(radiusM / (EARTH_RADIUS_M * cosLat));
  return {
    minLat: Math.max(-90, center.lat - latDelta),
    maxLat: Math.min(90, center.lat + latDelta),
    minLon: Math.max(-180, center.lon - lonDelta),
    maxLon: Math.min(180, center.lon + lonDelta),
  };
}

export function unionBoundingBoxes(boxes: readonly BoundingBox[]): BoundingBox | undefined {
  if (boxes.length === 0) return undefined;
  const first = boxes[0]!;
  return boxes.slice(1).reduce<BoundingBox>(
    (acc, box) => ({
      minLat: Math.min(acc.minLat, box.minLat),
      minLon: Math.min(acc.minLon, box.minLon),
      maxLat: Math.max(acc.maxLat, box.maxLat),
      maxLon: Math.max(acc.maxLon, box.maxLon),
    }),
    first,
  );
}

export function boundingBoxContains(box: BoundingBox, point: GeoPoint): boolean {
  return (
    point.lat >= box.minLat &&
    point.lat <= box.maxLat &&
    point.lon >= box.minLon &&
    point.lon <= box.maxLon
  );
}

export function boundingBoxCenter(box: BoundingBox): GeoPoint {
  return { lat: (box.minLat + box.maxLat) / 2, lon: (box.minLon + box.maxLon) / 2 };
}

/** Ray-casting point-in-polygon. Ring is [lon, lat] pairs, closed or not. */
export function pointInPolygon(point: GeoPoint, ring: readonly (readonly [number, number])[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[i]!;
    const b = ring[j]!;
    const [xi, yi] = a;
    const [xj, yj] = b;
    const intersects =
      yi > point.lat !== yj > point.lat &&
      point.lon < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** Spherical-excess area of a polygon ring, in square metres. */
export function polygonAreaM2(ring: readonly (readonly [number, number])[]): number {
  if (ring.length < 3) return 0;
  let total = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const current = ring[i]!;
    const next = ring[(i + 1) % ring.length]!;
    total +=
      toRadians(next[0] - current[0]) *
      (2 + Math.sin(toRadians(current[1])) + Math.sin(toRadians(next[1])));
  }
  return Math.abs((total * EARTH_RADIUS_M * EARTH_RADIUS_M) / 2);
}

/**
 * Speed implied by two observations, in metres per second.
 * Returns undefined when the observations share a timestamp, because an
 * infinite speed is not a meaningful analytical output.
 */
export function impliedSpeedMps(
  from: GeoPoint,
  fromUtc: string,
  to: GeoPoint,
  toUtc: string,
): number | undefined {
  const elapsedMs = Date.parse(toUtc) - Date.parse(fromUtc);
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return undefined;
  return haversineDistance(from, to) / (elapsedMs / 1000);
}

export const MPS_TO_MPH = 2.236936;
export const MPS_TO_KPH = 3.6;
