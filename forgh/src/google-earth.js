function cameraRange(candidate) {
  return Math.max(
    120,
    Math.hypot(candidate.dimensions.widthMeters, candidate.dimensions.lengthMeters) * 5,
  );
}

export function googleEarthUrl(candidate) {
  return `https://earth.google.com/web/@${candidate.latitude.toFixed(7)},${candidate.longitude.toFixed(7)},${cameraRange(candidate).toFixed(0)}a,35y,0h,0t,0r`;
}
