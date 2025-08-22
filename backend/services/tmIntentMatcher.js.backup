// services/tmIntentMatcher.js
// Purpose: Turn natural language into structured intents + entities for TmBot3000.
// - Works with your CSV beta (via csvDataSource) or any future provider exposing the same contract.
// - Handles venues/cities/dates, relative dates, direct hex IDs, and common touring terms.
// - Returns a confidence score so the calling layer can decide when to clarify.
//
// Usage:
//   const intentMatcher = require('./tmIntentMatcher'); // auto-loads CSVs from TM_DATA_DIR or ./data
//   const intent = await intentMatcher.matchIntent("When is soundcheck at The Forum?", context, member);
//
// Contract (output example):
//   {
//     intent_type: 'soundcheck',
//     confidence: 0.85,
//     entities: { venue_id: '#606001', venue_name: 'The Forum', show_id: '#605001', date: '2025-08-25' },
//     original_query: "When is soundcheck at The Forum?"
//   }

'use strict';

const path = require('path');
const { createCsvDataSource } = require('./csvDataSource');

// --- Config/boot -------------------------------------------------------------

const DATA_DIR = process.env.TM_DATA_DIR || path.join(process.cwd(), 'data');

// Instantiate a data source for name/ID resolution.
const dataSource = createCsvDataSource({ dataDir: DATA_DIR });

// Intent keywords (extendable). Keep lowercased!
const INTENT_KEYWORDS = {
  show_schedule: [
    'show', 'shows', 'tour dates', 'dates', 'what’s on', 'whats on',
    'upcoming', 'schedule', 'set time', 'settime', 'onstage time'
  ],
  venue_info: [
    'venue', 'address', 'parking', 'load-in info', 'load in info', 'capacity',
    'where is the venue', 'how do i get to the venue', 'credentials'
  ],
  setlist: [
    'setlist', 'set list', 'songs', 'what are we playing', 'song list'
  ],
  travel_info: [
    'flight', 'flights', 'hotel', 'ground', 'transport', 'transportation',
    'pickup', 'runner', 'lobby call', 'lobby-call', 'bus call', 'bus-call'
  ],
  soundcheck: [
    'soundcheck', 'sound check', 'load in', 'load-in', 'load out', 'load-out',
    'curfew', 'call time', 'call-time'
  ],
};

// A few helper synonyms mapping to primary intents (lightweight)
const HARD_HINTS = [
  { re: /\bset\s*list\b/i, intent: 'setlist', bonus: 0.15 },
  { re: /\bonstage time|set\s*time\b/i, intent: 'show_schedule', bonus: 0.10 },
  { re: /\blobby[-\s]?call\b/i, intent: 'travel_info', bonus: 0.10 },
  { re: /\bcurfew\b/i, intent: 'soundcheck', bonus: 0.10 },
  { re: /\bload[-\s]?in\b/i, intent: 'soundcheck', bonus: 0.10 },
];

// Hex IDs: accept #A1B2C3 or #a1b2c3
const HEX_RE = /#([A-Fa-f0-9]{6})/g;

// Unicode-capable capture for cities/venues after “in/at”
const AFTER_IN_AT_RE = /\b(?:in|at)\s+([\p{L}\d][\p{L}\d\s\-'&\.]+?)(?=($|\?|\.|,|;|:))/u;

// Possessive city (e.g., "Sydney's show")
const POSSESSIVE_CITY_RE = /\b([\p{L}\d][\p{L}\d\s\-'\.&]+?)'s\b/iu;

// Basic named month and MDY/DMY numerics
const MONTHS = '(january|february|march|april|may|june|july|august|september|october|november|december)';
const MONTH_DAY_RE = new RegExp(`\\b${MONTHS}\\s+([0-9]{1,2})(?:st|nd|rd|th)?(?:,?\\s+([0-9]{4}))?\\b`, 'i');
const MDY_RE = /\b([0-9]{1,2})\/([0-9]{1,2})(?:\/([0-9]{2,4}))?\b/; // assume MM/DD by default
const DMY_RE = /\b([0-9]{1,2})\-([0-9]{1,2})(?:\-([0-9]{2,4}))?\b/; // if using dashes, assume DD-MM

// Relative time phrases
const RELATIVE_WORDS_RE = /\b(today|tonight|tomorrow|next week|this week|next\s+(mon|tue|wed|thu|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i;

// Day-of-week mapping
const DOW = {
  mon: 1, monday: 1,
  tue: 2, tuesday: 2,
  wed: 3, wednesday: 3,
  thu: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
  sun: 0, sunday: 0, // Sunday as 0 to match JS Date.getDay()
};

// --- Core --------------------------------------------------------------------

class TmIntentMatcher {
  /**
   * Parse a user message, infer intent & entities, and resolve names to IDs.
   * @param {string} message
   * @param {object} context (optional) e.g., { last_entities: { show_id, venue_id, city, date } }
   * @param {object} member (optional) e.g., { user_timezone, timezone_preference }
   * @returns {Promise<{intent_type:string, confidence:number, entities:object, original_query:string}>}
   */
  async matchIntent(message, context = {}, member = {}) {
    const original_query = String(message || '');
    const msg = original_query.trim();
    const msgLower = msg.toLowerCase();

    // 1) Start with a rough intent guess from keywords
    const intentGuess = this.guessIntent(msgLower);

    // 2) Extract obvious entities: hex IDs, city/venue text, relative/absolute dates
    const hexIds = extractHexIds(msg);
    const userTz = member.user_timezone || member.timezone || 'UTC';

    const dateEntity = parseDateLike(msg, userTz);
    const cityName = await this.extractCityName(msg, msgLower);
    const venueName = await this.extractVenueName(msg, msgLower);

    // 3) Try to resolve IDs/names
    const { venue_id, venue_name, venue_conf } = await this.resolveVenue({ hexIds, venueName });
    const { show_id, show_conf, date: resolvedShowDate } = await this.resolveShow({
      hexIds,
      venue_id,
      cityName,
      requestedDate: dateEntity?.date,
    });

    // If soundcheck asked with no explicit date: prefer the show date if we resolved one
    const finalDate = dateEntity?.date || resolvedShowDate || (dateEntity?.relative ? dateEntity.relative : undefined);

    // 4) Build entities and compute confidence
    const entities = {};
    if (venue_id) entities.venue_id = venue_id;
    if (venue_name) entities.venue_name = venue_name;
    if (show_id) entities.show_id = show_id;
    if (cityName) entities.city = cityName;
    if (finalDate) entities.date = finalDate;

    // Infer intent if not clear: e.g., message contains "soundcheck" → soundcheck
    const finalIntent = this.inferIntent(intentGuess, { msgLower, venue_id, show_id, cityName });

    // Confidence scoring heuristic
    let confidence = intentGuess.base;
    if (finalIntent === 'soundcheck' && (venue_id || show_id)) confidence += 0.15;
    if (finalIntent === 'venue_info' && venue_id) confidence += 0.15;
    if (finalIntent === 'setlist' && (show_id || cityName)) confidence += 0.10;
    if (finalIntent === 'travel_info' && (finalDate || show_id)) confidence += 0.10;
    if (finalIntent === 'show_schedule' && (cityName || finalDate)) confidence += 0.10;

    // Boost/ding based on resolution qualities
    if (venue_conf === 'fuzzy') confidence -= 0.05;
    if (show_conf === 'fuzzy') confidence -= 0.05;

    // Clamp
    confidence = Math.max(0.2, Math.min(0.95, confidence));

    // 5) If nothing resolved but we have prior context, try contextual fallback for soundcheck
    if (finalIntent === 'soundcheck' && !entities.show_id && context?.last_entities?.show_id) {
      entities.show_id = context.last_entities.show_id;
      confidence = Math.max(confidence, 0.75);
    } else if (finalIntent === 'soundcheck' && !entities.show_id && !entities.venue_id) {
      // Fallback to “next upcoming show” if available
      const nextShow = await this.findNextUpcomingShow();
      if (nextShow) {
        entities.show_id = nextShow.show_id;
        if (!entities.venue_id) entities.venue_id = nextShow.venue_id;
        if (!entities.date) entities.date = nextShow.date;
        confidence = Math.max(confidence, 0.7);
      }
    }

    return {
      intent_type: finalIntent,
      confidence,
      entities,
      original_query,
    };
  }

  // Guess base intent from bag-of-words over INTENT_KEYWORDS (+ HARD_HINTS)
  guessIntent(msgLower) {
    const score = { show_schedule: 0, venue_info: 0, setlist: 0, travel_info: 0, soundcheck: 0 };
    for (const [intent, words] of Object.entries(INTENT_KEYWORDS)) {
      for (const w of words) {
        if (msgLower.includes(w)) score[intent] += 1;
      }
    }
    for (const hint of HARD_HINTS) {
      if (hint.re.test(msgLower)) score[hint.intent] += hint.bonus;
    }

    // Pick the max; default to show_schedule if nothing hits (most common)
    const entries = Object.entries(score).sort((a, b) => b[1] - a[1]);
    const [bestIntent, bestScore] = entries[0] || ['show_schedule', 0];
    // Convert rough “keyword hits” to a baseline confidence
    const base = Math.min(0.7, 0.4 + (bestScore || 0) * 0.1);
    return { bestIntent, base };
  }

  inferIntent(guess, context) {
    let intent = guess.bestIntent;

    // Strong phrase overrides (ensure “soundcheck” wins when present)
    if (/\bsound\s*check|soundcheck\b/i.test(context.msgLower)) intent = 'soundcheck';
    if (/\bset\s*list|setlist\b/i.test(context.msgLower)) intent = 'setlist';

    // If user mentions a specific venue without other cues, lean venue_info
    if (context.venue_id && intent === 'show_schedule' && !context.cityName) {
      intent = 'venue_info';
    }

    return intent;
  }

  // Resolve venue via hex or fuzzy name matching against shows/venues
  async resolveVenue({ hexIds, venueName }) {
    // Direct hex ID → try venue, then show->venue
    for (const hex of hexIds) {
      const venue = await dataSource.getVenue(hex);
      if (venue) {
        return { venue_id: hex, venue_name: venue.name || undefined, venue_conf: 'exact' };
      }
      const show = await dataSource.getShow(hex);
      if (show && show.venue_id) {
        // Map show’s venue as the target venue
        const v2 = await dataSource.getVenue(show.venue_id);
        return {
          venue_id: show.venue_id,
          venue_name: v2?.name || show.venue_name || undefined,
          venue_conf: 'exact',
        };
      }
    }

    if (!venueName) return { venue_id: undefined, venue_name: undefined };

    // Fuzzy resolve by venue name against known shows (gets us venue_id + display name)
    const allShows = await dataSource.getShows({});
    const seen = new Map(); // venue_id -> { venue_id, venue_name, hits }
    for (const s of allShows.shows || []) {
      if (!s.venue_id) continue;
      const score = nameSimilarity(venueName, s.venue_name || '');
      if (score >= 0.65) {
        if (!seen.has(s.venue_id)) {
          seen.set(s.venue_id, { venue_id: s.venue_id, venue_name: s.venue_name, best: score });
        } else if (score > seen.get(s.venue_id).best) {
          seen.get(s.venue_id).best = score;
          seen.get(s.venue_id).venue_name = s.venue_name;
        }
      }
    }

    if (seen.size === 0) return { venue_id: undefined, venue_name: undefined };
    const candidates = [...seen.values()].sort((a, b) => b.best - a.best);
    const top = candidates[0];
    return { venue_id: top.venue_id, venue_name: top.venue_name, venue_conf: 'fuzzy' };
  }

  // Resolve a show by explicit hex, or by venue/city+date combination (preferring upcoming)
  async resolveShow({ hexIds, venue_id, cityName, requestedDate }) {
    // Hex → show
    for (const hex of hexIds) {
      const show = await dataSource.getShow(hex);
      if (show) {
        return { show_id: hex, show_conf: 'exact', date: show.date };
      }
    }

    const allShows = await dataSource.getShows({});
    const list = allShows.shows || [];

    // Filter candidates by venue/city as provided
    let cand = list.slice();
    if (venue_id) cand = cand.filter((s) => s.venue_id === venue_id);
    if (cityName) {
      const needle = cityName.trim().toLowerCase();
      cand = cand.filter((s) => (s.city || '').trim().toLowerCase() === needle);
    }

    if (requestedDate) {
      // YYYY-MM-DD compare
      cand = cand.filter((s) => String(s.date) === String(requestedDate));
    } else {
      // If no explicit date, prefer the next upcoming matching show
      const todayYmd = new Date().toISOString().slice(0, 10);
      const upcoming = cand.filter((s) => String(s.date) >= todayYmd);
      if (upcoming.length) cand = upcoming;
    }

    // Choose the earliest by date/time
    cand.sort((a, b) => {
      const da = String(a.date);
      const db = String(b.date);
      if (da !== db) return da < db ? -1 : 1;
      const ta = a.show_time || '';
      const tb = b.show_time || '';
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });

    const picked = cand[0];
    if (!picked) return { show_id: undefined, show_conf: undefined, date: undefined };
    return { show_id: picked.show_id, show_conf: requestedDate ? 'exact' : 'fuzzy', date: picked.date };
  }

  async extractCityName(_msg, msgLower) {
    // Look for "in <city>" first
    const afterIn = AFTER_IN_AT_RE.exec(_msg);
    if (afterIn && looksLikeCityToken(afterIn[1])) {
      return cleanName(afterIn[1]);
    }

    // Possessive city "Sydney's"
    const poss = POSSESSIVE_CITY_RE.exec(_msg);
    if (poss && looksLikeCityToken(poss[1])) {
      return cleanName(poss[1]);
    }

    // Otherwise, fuzzy against known show cities
    const allShows = await dataSource.getShows({});
    const cities = new Set((allShows.shows || []).map((s) => s.city).filter(Boolean));
    let best = { name: undefined, score: 0 };
    for (const c of cities) {
      const s = nameSimilarity(msgLower, String(c).toLowerCase());
      if (s > best.score) best = { name: c, score: s };
    }
    return best.score >= 0.7 ? best.name : undefined;
  }

  async extractVenueName(_msg, msgLower) {
    // Prefer “at <venue>”
    const afterAt = AFTER_IN_AT_RE.exec(_msg);
    if (afterAt && looksLikeVenueToken(afterAt[1])) {
      return cleanName(afterAt[1]);
    }

    // Fuzzy against known venue names via shows list
    const allShows = await dataSource.getShows({});
    const names = new Set((allShows.shows || []).map((s) => s.venue_name).filter(Boolean));
    let best = { name: undefined, score: 0 };
    for (const name of names) {
      const s = nameSimilarity(msgLower, String(name).toLowerCase());
      if (s > best.score) best = { name, score: s };
    }
    return best.score >= 0.72 ? best.name : undefined;
  }

  async findNextUpcomingShow() {
    const { shows } = await dataSource.getShows({ upcoming: true });
    return (shows || [])[0];
  }
}

// --- Helpers -----------------------------------------------------------------

function extractHexIds(text) {
  const ids = [];
  let m;
  while ((m = HEX_RE.exec(text)) !== null) {
    ids.push(`#${m[1].toUpperCase()}`);
  }
  return ids;
}

// Returns { date: 'YYYY-MM-DD', relative?: 'today'|'tomorrow'|'next week'|... }
function parseDateLike(text, userTz = 'UTC') {
  // Relative
  const rel = RELATIVE_WORDS_RE.exec(text);
  if (rel) {
    const phrase = rel[1].toLowerCase();
    const day = rel[2]?.toLowerCase();
    const now = nowInTz(userTz);
    if (phrase === 'today' || phrase === 'tonight') {
      return { date: toYMD(now), relative: 'today' };
    }
    if (phrase === 'tomorrow') {
      const t = addDays(now, 1);
      return { date: toYMD(t), relative: 'tomorrow' };
    }
    if (phrase === 'next week' || phrase === 'this week') {
      // Use as a filter – return no specific date but keep relative marker
      return { date: undefined, relative: phrase };
    }
    if (day && DOW[day] !== undefined) {
      const targetDow = DOW[day];
      const d = nextDow(now, targetDow);
      return { date: toYMD(d), relative: `next ${day}` };
    }
  }

  // Month name (e.g., August 25, 2025)
  const m = MONTH_DAY_RE.exec(text);
  if (m) {
    const monthName = m[1];
    const day = parseInt(m[2], 10);
    const year = m[3] ? parseInt(m[3], 10) : new Date().getFullYear();
    const monthIndex = monthNameToIndex(monthName);
    if (monthIndex != null && day >= 1 && day <= 31) {
      const dt = new Date(Date.UTC(year, monthIndex, day));
      return { date: toYMD(dt) };
    }
  }

  // Numeric MDY "8/25[/2025]" (default US-style)
  const n = MDY_RE.exec(text);
  if (n) {
    const mm = parseInt(n[1], 10);
    const dd = parseInt(n[2], 10);
    const yy = n[3] ? parseInt(n[3], 10) : new Date().getFullYear();
    const yyyy = yy < 100 ? 2000 + yy : yy;
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
      const dt = new Date(Date.UTC(yyyy, mm - 1, dd));
      return { date: toYMD(dt) };
    }
  }

  // Numeric DMY with dashes "25-08[-2025]"
  const dmy = DMY_RE.exec(text);
  if (dmy) {
    const dd = parseInt(dmy[1], 10);
    const mm = parseInt(dmy[2], 10);
    const yy = dmy[3] ? parseInt(dmy[3], 10) : new Date().getFullYear();
    const yyyy = yy < 100 ? 2000 + yy : yy;
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
      const dt = new Date(Date.UTC(yyyy, mm - 1, dd));
      return { date: toYMD(dt) };
    }
  }

  return undefined;
}

function monthNameToIndex(name) {
  const idx = [
    'january','february','march','april','may','june',
    'july','august','september','october','november','december'
  ].indexOf(String(name).toLowerCase());
  return idx >= 0 ? idx : null;
}

// Very lightweight normalization + similarity (Jaro-Winkler-ish via Levenshtein ratio)
function nameSimilarity(a, b) {
  a = normalizeName(a);
  b = normalizeName(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const dist = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  return 1 - dist / Math.max(1, maxLen);
}
function normalizeName(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\bthe\b/gi, '')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9\s\-\.&]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
function cleanName(s) {
  return String(s || '').trim().replace(/\s+/g, ' ');
}
function looksLikeCityToken(s) {
  const t = String(s || '').trim();
  return t.length >= 2;
}
function looksLikeVenueToken(s) {
  const t = String(s || '').trim();
  return t.length >= 2;
}

function levenshtein(a, b) {
  const an = a.length;
  const bn = b.length;
  if (an === 0) return bn;
  if (bn === 0) return an;
  const matrix = Array.from({ length: an + 1 }, () => new Array(bn + 1).fill(0));
  for (let i = 0; i <= an; i++) matrix[i][0] = i;
  for (let j = 0; j <= bn; j++) matrix[0][j] = j;
  for (let i = 1; i <= an; i++) {
    for (let j = 1; j <= bn; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,         // deletion
        matrix[i][j - 1] + 1,         // insertion
        matrix[i - 1][j - 1] + cost   // substitution
      );
    }
  }
  return matrix[an][bn];
}

// Time helpers
function nowInTz(_tz) {
  // JS Date has no direct TZ construct; we compute “now” in UTC and rely on UTC math for relative days.
  return new Date(); // For relative day shifts, system now is fine; formatting happens later.
}
function toYMD(d) {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
function addDays(d, n) {
  const z = new Date(d.getTime());
  z.setUTCDate(z.getUTCDate() + n);
  return z;
}
function nextDow(d, targetDow) {
  const cur = d.getDay();
  // If target is today, jump to next week’s same day (as “next Tuesday” style)
  let delta = (targetDow - cur + 7) % 7;
  if (delta === 0) delta = 7;
  return addDays(d, delta);
}

// Export a ready-to-use singleton (matches your existing `require('./tmIntentMatcher')` usage)
module.exports = new TmIntentMatcher();

