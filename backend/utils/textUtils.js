// utils/textUtils.js
// A small helper for cleaning up text for matching.

/**
 * Normalizes a string by trimming whitespace and collapsing multiple spaces.
 * @param {string} s
 * @returns {string}
 */
function cleanName(s) {
  return String(s || '').trim().replace(/\s+/g, ' ');
}

module.exports = {
  cleanName,
};
