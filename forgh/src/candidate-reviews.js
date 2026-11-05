import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInAnonymously,
  signInWithPopup,
  signOut,
} from '@firebase/auth';
import { onValue, ref, update } from '@firebase/database';
import { firebaseAuth, firebaseDatabase, OWNER_UID } from './firebase.js';

const REVIEW_PATH = 'candidateReviews';
const SCAN_PATH = 'scanCandidates';
const MATCH_DISTANCE_METERS = 8;

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isValidBounds(bounds) {
  return (
    bounds &&
    isFiniteNumber(bounds.west) &&
    isFiniteNumber(bounds.south) &&
    isFiniteNumber(bounds.east) &&
    isFiniteNumber(bounds.north) &&
    bounds.west < bounds.east &&
    bounds.south < bounds.north &&
    bounds.west >= -180 &&
    bounds.east <= 180 &&
    bounds.south >= -90 &&
    bounds.north <= 90
  );
}

function normalizeReview(id, value) {
  if (
    !value ||
    typeof value !== 'object' ||
    value.id !== id ||
    !isFiniteNumber(value.latitude) ||
    !isFiniteNumber(value.longitude) ||
    value.latitude < -90 ||
    value.latitude > 90 ||
    value.longitude < -180 ||
    value.longitude > 180 ||
    !isValidBounds(value.bbox) ||
    !isFiniteNumber(value.score) ||
    value.score < 0 ||
    value.score > 100 ||
    !isFiniteNumber(value.pointCount) ||
    !value.dimensions ||
    !isFiniteNumber(value.dimensions.widthMeters) ||
    !isFiniteNumber(value.dimensions.lengthMeters) ||
    typeof value.removed !== 'boolean'
  ) {
    return null;
  }

  return {
    id,
    latitude: value.latitude,
    longitude: value.longitude,
    bbox: {
      west: value.bbox.west,
      south: value.bbox.south,
      east: value.bbox.east,
      north: value.bbox.north,
    },
    score: value.score,
    confidence: ['High', 'Medium', 'Low'].includes(value.confidence)
      ? value.confidence
      : 'Low',
    category:
      typeof value.category === 'string' ? value.category.slice(0, 100) : 'Saved candidate',
    pointCount: Math.max(0, Math.floor(value.pointCount)),
    dimensions: {
      widthMeters: value.dimensions.widthMeters,
      lengthMeters: value.dimensions.lengthMeters,
    },
    evidence: Array.isArray(value.evidence)
      ? value.evidence.filter((entry) => typeof entry === 'string').slice(0, 24)
      : [],
    class6Count:
      isFiniteNumber(value.class6Count) && value.class6Count >= 0
        ? Math.floor(value.class6Count)
        : 0,
    relativeHeightUnits: isFiniteNumber(value.relativeHeightUnits)
      ? value.relativeHeightUnits
      : null,
    removed: value.removed,
    updatedAt: isFiniteNumber(value.updatedAt) ? value.updatedAt : 0,
  };
}

export function normalizeCandidateReviews(snapshotValue) {
  if (!snapshotValue || typeof snapshotValue !== 'object') return [];
  return Object.entries(snapshotValue)
    .map(([id, value]) => normalizeReview(id, value))
    .filter(Boolean);
}

export function isReviewOwner(user) {
  return Boolean(user && user.uid === OWNER_UID);
}

export function listenToCandidateReviews(onRecords, onError) {
  let reviewRecords = [];
  let scanRecords = [];
  let reviewLoaded = false;
  let scansLoaded = false;
  let failed = false;
  const unsubscribers = [];
  const publish = () => {
    if (reviewLoaded && scansLoaded) {
      onRecords({ reviews: reviewRecords, submissions: scanRecords });
    }
  };
  const readyFor = (path, receive) =>
    new Promise((resolve) => {
      let firstSnapshot = true;
      const unsubscribe = onValue(
        ref(firebaseDatabase, path),
        (snapshot) => {
          receive(snapshot.val());
          if (path === REVIEW_PATH) reviewLoaded = true;
          if (path === SCAN_PATH) scansLoaded = true;
          publish();
          if (firstSnapshot) {
            firstSnapshot = false;
            resolve({ ok: true });
          }
        },
        (error) => {
          onError(error);
          failed = true;
          if (firstSnapshot) {
            firstSnapshot = false;
            resolve({ ok: false, error });
          }
        },
      );
      unsubscribers.push(unsubscribe);
    });
  const ready = Promise.all([
    readyFor(REVIEW_PATH, (value) => {
      reviewRecords = normalizeCandidateReviews(value);
    }),
    readyFor(SCAN_PATH, (value) => {
      scanRecords = normalizeScanCandidates(value);
    }),
  ]).then((results) => ({
    ok: !failed && results.every((result) => result.ok),
    error: results.find((result) => !result.ok)?.error,
  }));
  return {
    ready,
    unsubscribe: () => unsubscribers.forEach((unsubscribe) => unsubscribe()),
  };
}

export function listenToOwnerAuth(callback) {
  return onAuthStateChanged(firebaseAuth, callback, (error) => {
    console.error('Firebase Authentication listener failed.', error);
    callback(null, error);
  });
}

export async function signInOwnerWithGoogle() {
  await signInWithPopup(firebaseAuth, new GoogleAuthProvider());
}

export async function ensureScanIdentity() {
  if (firebaseAuth.currentUser) return firebaseAuth.currentUser;
  const credential = await signInAnonymously(firebaseAuth);
  return credential.user;
}

export async function signOutOwner() {
  await signOut(firebaseAuth);
}

function distanceMeters(first, second) {
  const latitudeRadians = (first.latitude * Math.PI) / 180;
  const deltaLatitude = ((second.latitude - first.latitude) * Math.PI) / 180;
  const deltaLongitude = ((second.longitude - first.longitude) * Math.PI) / 180;
  const haversine =
    Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(latitudeRadians) *
      Math.cos((second.latitude * Math.PI) / 180) *
      Math.sin(deltaLongitude / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

function findNearbyReview(candidate, reviews) {
  let closest = null;
  let closestDistance = MATCH_DISTANCE_METERS;
  for (const review of reviews) {
    const distance = distanceMeters(candidate, review);
    if (distance <= closestDistance) {
      closest = review;
      closestDistance = distance;
    }
  }
  return closest;
}

function candidateId(candidate) {
  const latitude = Math.round(candidate.latitude * 100_000);
  const longitude = Math.round(candidate.longitude * 100_000);
  const part = (value) => `${value < 0 ? 'm' : 'p'}${Math.abs(value)}`;
  return `candidate_${part(latitude)}_${part(longitude)}`;
}

function toReviewRecord(candidate, id, previous = null) {
  return {
    id,
    latitude: candidate.latitude,
    longitude: candidate.longitude,
    bbox: candidate.bbox,
    score: candidate.score,
    confidence: candidate.confidence,
    category: candidate.category,
    pointCount: candidate.pointCount,
    dimensions: {
      widthMeters: candidate.dimensions.widthMeters,
      lengthMeters: candidate.dimensions.lengthMeters,
    },
    evidence: candidate.evidence.slice(0, 24),
    class6Count: candidate.class6Count,
    relativeHeightUnits: candidate.relativeHeightUnits,
    removed: previous?.removed ?? false,
    updatedAt: Date.now(),
  };
}

export async function saveScannedCandidates(candidates, reviews) {
  const user = await ensureScanIdentity();
  const writes = {};
  const visible = [];
  const usedIds = new Set();

  for (const candidate of candidates) {
    const nearby = findNearbyReview(candidate, reviews);
    if (nearby?.removed) continue;
    const id = nearby?.id ?? candidateId(candidate);
    if (usedIds.has(id)) continue;
    const record = toReviewRecord(candidate, id);
    usedIds.add(id);
    writes[id] = record;
    visible.push(record);
  }

  if (Object.keys(writes).length) {
    await update(ref(firebaseDatabase, `${SCAN_PATH}/${user.uid}`), writes);
  }
  return { visible };
}

function normalizeScanCandidates(value) {
  if (!value || typeof value !== 'object') return [];
  const unique = new Map();
  for (const userRecords of Object.values(value)) {
    if (!userRecords || typeof userRecords !== 'object') continue;
    for (const [id, record] of Object.entries(userRecords)) {
      const normalized = normalizeReview(id, record);
      if (!normalized || normalized.removed) continue;
      const previous = unique.get(id);
      if (!previous || normalized.updatedAt > previous.updatedAt) {
        unique.set(id, normalized);
      }
    }
  }
  return [...unique.values()];
}

export async function setCandidateRemoved(review, removed) {
  if (!isReviewOwner(firebaseAuth.currentUser)) {
    throw new Error('Only the configured owner can change shared candidate reviews.');
  }
  const record = toReviewRecord(review, review.id);
  record.removed = removed;
  record.updatedAt = Date.now();
  await update(ref(firebaseDatabase, `${REVIEW_PATH}/${review.id}`), record);
}

export function removePreviouslyRemovedCandidates(candidates, reviews) {
  return candidates.filter((candidate) => {
    const nearby = findNearbyReview(candidate, reviews);
    return !nearby || !nearby.removed;
  });
}

export function getCandidateMatch(candidate, reviews) {
  return findNearbyReview(candidate, reviews);
}
