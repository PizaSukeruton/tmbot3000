const path = require("path");
const { Pool } = require("pg");

// Postgres (answers come from tm_answers)
const __pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // SSL is enabled for the live environment
  ssl: { rejectUnauthorized: false }
});
const db = { query: (text, params) => __pool.query(text, params) };

// The createCsvDataSource is in the same directory as this file.
const { createCsvDataSource } = require("./csvDataSource");
const DATA_DIR = process.env.TM_DATA_DIR || path.join(__dirname, "..", "data");
const dataSource = createCsvDataSource({ dataDir: DATA_DIR });

// -------- helpers --------
// This function dynamically gets the term IDs from the database.
async function getTermIds() {
  const sql = `
    SELECT DISTINCT term_id
    FROM tm_answers
    WHERE is_current = true
    ORDER BY term_id;
  `;
  try {
    const res = await db.query(sql);
    // Return an array of lowercase term_ids for case-insensitive matching
    return res.rows.map(row => row.term_id.toLowerCase());
  } catch (error) {
    console.error("Error fetching term IDs:", error.message);
    return [];
  }
}

// NEW: This function dynamically gets all unique city names from the flights CSV data.
// It reads the file directly to avoid reliance on an external API on the dataSource.
async function getCitiesFromCsv() {
  try {
    const fs = require("fs");
    const file = path.resolve(DATA_DIR, "travel_flights.csv");
    if (!fs.existsSync(file)) return [];
    
    const txt = fs.readFileSync(file, "utf8");
    const lines = txt.split(/\r?\n/).filter(Boolean);
    if (lines.length <= 1) return [];
    
    const header = lines.shift();
    const cols = header.split(",");
    const idx = (n) => cols.indexOf(n);
    const I = {
      departure_city: idx("departure_city"),
      arrival_city: idx("arrival_city"),
    };
    
    const cities = new Set();
    lines.forEach(line => {
      const parts = line.split(',');
      if (parts[I.departure_city]) cities.add(parts[I.departure_city].toLowerCase());
      if (parts[I.arrival_city]) cities.add(parts[I.arrival_city].toLowerCase());
    });
    
    return Array.from(cities);
  } catch (error) {
    console.error("Error fetching city data from CSV:", error.message);
    return [];
  }
}

// This function resolves an answer for a specific term ID.
async function resolveAnswer(term_id, locale = "en-AU") {
  const sql = `
    SELECT answer_template
    FROM tm_answers
    WHERE term_id = $1 AND locale = $2 AND is_current = true
    ORDER BY version DESC
    LIMIT 1`;
  const r = await db.query(sql, [term_id, locale]);
  return (r.rows && r.rows[0] && r.rows[0].answer_template) ? r.rows[0].answer_template : null;
}

function fmtDate(d) {
  try {
    const dt = new Date(d);
    return dt.toLocaleDateString("en-AU", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  } catch {
    return d;
  }
}

function lineForShow(s, i) {
  const bits = [];
  bits.push(`${i}. ${fmtDate(s.date)}`);
  const locParts = [s.venue_name, s.city, s.state || s.region, s.country].filter(Boolean);
  if (locParts.length) bits.push(`    📍 ${locParts.join(", ")}`);
  if (s.doors_time) bits.push(`    🚪 Doors: ${s.doors_time}${s.timezone ? " " + s.timezone : ""}`);
  if (s.show_time)  bits.push(`    🎫 Show: ${s.show_time}${s.timezone ? " " + s.timezone : ""}`);
  if (s.ticket_status) bits.push(`    🎟️ ${s.ticket_status}`);
  return bits.join("\n");
}

// -------- engine --------
class TmAiEngine {
  constructor(pool) {
    this.pool = pool;
    this.industryTerms = [];
    this.cities = [];

    // Longer/more specific verbs first.
    this.VERBS = [
      "tell me about",
      "what time is",
      "when is",
      "where is",
      "who is",
      "what is"
    ];

    // Load the terms and cities when the engine is instantiated.
    this.loadTerms(); 
    this.loadCities();
    if (this.loadTimeTermsFromDb) this.loadTimeTermsFromDb();
  }

  // Method to asynchronously load the terms from the database
  async loadTerms() {
    this.industryTerms = await getTermIds();
    console.log(`Loaded ${this.industryTerms.length} industry terms from the database.`);
    this.buildRouterHints();
  }

  // Method to asynchronously load cities from the CSV data
  async loadCities() {
    this.cities = await getCitiesFromCsv();
    console.log(`Loaded ${this.cities.length} unique cities from the travel data.`);
  }

  // --- Parser helpers ---

  normalizeMessage(message = "") {
    // Lowercase + strip punctuation; keep spaces/word chars.
    return String(message)
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  /**
   * parseMessage -> { verb: string|null, entities: string[] }
   * Entities come from dynamic sources: this.industryTerms + this.cities
   */
  parseMessage(message = "") {
    const out = { verb: null, entities: [], normalized: "" };
    const normalized = this.normalizeMessage(message);
    if (!normalized) out.normalized = normalized;
  return out;

    // 1) verb
    for (const v of this.VERBS) {
      if (normalized.startsWith(v)) {
        out.verb = v;
        break;
      }
    }

    // 2) entities (scan across both lists)
    const candidates = [
      ...(this.industryTerms || []),
      ...(this.cities || [])
    ].filter(Boolean);

    // Keep order of first appearance; avoid dupes.
    for (const c of candidates) {
      if (normalized.includes(c) && !out.entities.includes(c)) {
        out.entities.push(c);
      }
    }

    // Heuristic: add common domain tokens as router hints (does not hardcode answers)
    const extraHints = ['flight', 'flights', 'show'];
    for (const hint of extraHints) {
      if (normalized.includes(hint) && !out.entities.includes(hint)) {
        out.entities.push(hint);
      }
    }

    out.normalized = normalized;
  return out;
  }

  buildRouterHints() {
    // Use only human-word terms as hints (ignore IDs like #604001).
    const wordy = (this.industryTerms || [])
      .filter(t => /^[a-z]/.test(t))
      .map(t => t.trim().toLowerCase())
      .filter(Boolean);

    // Dedupe
    const seen = new Set();
    const hints = [];
    for (const w of wordy) {
      if (!seen.has(w)) { seen.add(w); hints.push(w); }
    }

    // Sort by length desc for greedy matching
    hints.sort((a, b) => b.length - a.length);
    this.routerHints = hints;

    console.log(`[TmAiEngine] Router hints ready: ${this.routerHints.length} terms`);
  }
  /** Return the first show matching a city (case-insensitive). */
  async getShowByCity(city) {
    if (!city) return null;
    const { shows = [] } = await dataSource.getShows({});
    const c = String(city).toLowerCase();
    return shows.find(s => (s.city || "").toLowerCase() === c) || null;
  }

  /**
   * Try to find the most relevant field in a show object for a given term, without hard-coding.
   * Strategy:
   *  - Normalize term and keys (letters+digits only).
   *  - Prefer keys that end with "_time" or contain "time".
   *  - If verb is location-like, prefer venue/location fields.
   */
  findFieldForTerm({ show, term, verb }) {
    if (!show || !term) return null;

    const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
    const nTerm = norm(term);

    const keys = Object.keys(show || {});
    const scored = [];

    for (const k of keys) {
      const nk = norm(k);

      // Basic relevance: does key mention the term?
      const mentions = nk.includes(nTerm);

      // Heuristics for different verb families
      const isTimeKey = /time$|time\b/.test(k) || nk.endsWith('time') || nk.includes('time');
      const isVenueKey = ['venue', 'venue_name', 'address', 'location'].some(v => nk.includes(norm(v)));
      const isCityKey  = nk === 'city' || nk.endsWith('city');
      const isStateKey = nk === 'state' || nk === 'region';
      const isCountryKey = nk === 'country';

      let score = 0;
      if (mentions) score += 5;
      if (isTimeKey) score += 3;

      // If the user asked "where is ...", prefer venue/location-ish keys.
      const locationLike = (verb === 'where is');
      if (locationLike && (isVenueKey || isCityKey || isStateKey || isCountryKey)) {
        score += 4;
      }

      // If time-like verb, bump time-keys.
      const timeLike = (verb === 'what time is' || verb === 'when is');
      if (timeLike && isTimeKey) score += 4;

      // Keep only keys with non-empty values
      const val = show[k];
      if (val != null && String(val).trim() !== '' && score > 0) {
        scored.push({ k, score, val });
      }
    }

    if (!scored.length) {
      const timeLike = (verb === "what time is" || verb === "when is");
      if (timeLike) {
        const prefs = ["soundcheck_time","load_in_time","doors_time","show_time"];
        for (const p of prefs) {
          if (Object.prototype.hasOwnProperty.call(show, p) && String(show[p] || "").trim() !== "") {
            return { k: p, score: 1, val: show[p] };
          }
        }
      }
      return null;
    }
    // Highest score wins
    scored.sort((a, b) => b.score - a.score);
    return scored[0]; // { k, score, val }
  }

  /**
   * retrieveData(parsed) -> structured object for the generator
   * Returns one of:
   *  - { responseType: "contextualTerm",     payload: { term, city, field, value } }
   *  - { responseType: "contextualLocation", payload: { term, city, field, value, place } }
   *  - { responseType: "genericTerm",        payload: { term, definition } }
   *  - { responseType: "travelSchedule",     payload: { text } }
   *  - null
   */
  async retrieveData(parsed) {
    const { verb, entities = [], normalized = "" } = parsed || {};
    if (!entities.length && !normalized) return null;

    // Classify entities using your dynamic lists
    let term = null;
    let city = null;
    for (const e of entities) {
      if (!term && this.industryTerms?.includes(e)) term = e;     // DB hex IDs (rarely appear in user text)
      if (!city && this.cities?.includes(e)) city = e;
    }

    const q = normalized || "";

    

try {
  if (/(?:\bwhen\b|\bwhat\s*time\b)/i.test(q)) {
    const directTerms = [
      { rx: /\bcheckout\b/i,         field: 'checkout_time'      },
      { rx: /\bdeparture\b/i,        field: 'departure_time'     },
      { rx: /\bairport\s*call\b/i,  field: 'airport_call_time'  },
      { rx: /\blobby\s*call\b/i,    field: 'lobby_call_time'    }
    ];
    const hit = directTerms.find(t => t.rx.test(q));
    if (hit) {
      const parsed = this.parseCityAndTerm(String(message||"")) || {};
      const city = parsed.city;
      if (!city) { return { type: 'fallback', text: 'I can grab the exact time if you tell me the city (e.g., “when are doors in Sydney?”).' }; }
      if (!this.timeTermMap || typeof this.timeTermMap !== 'object') {
        if (typeof this.loadTimeTermsFromDb === 'function') { try { await this.loadTimeTermsFromDb(); } catch(_){} }
        this.timeTermMap = this.timeTermMap || {};
      }
      const show = await this.getNextShowByCity(city);
      if (show) {
        const __picked = (typeof __pickTimeField === 'function') ? __pickTimeField(show, hit.field) : hit.field;
        if (__picked && show[__picked]) {
          let label = null;
          const map = this.timeTermMap || {};
          for (const k in map) {
            const v = map[k] || {};
            const fk = v.field_key || v.field;
            if (fk === hit.field) { label = v.label; break; }
          }
          label = label || (String(hit.field).replace(/_/g,' ').replace(/\b\w/g,m=>m.toUpperCase()));
          const tz = show.timezone ? (' ' + show.timezone) : '';
          return { type: 'schedule', text: `${label} for ${city} (${show.venue_name || 'TBA'}) on ${show.date || 'TBA'}: ${show[__picked]}${tz}` };
        }
      }
      return { type: 'fallback', text: `I couldn’t find ${hit.field.replace(/_/g,' ')} for ${city} on the next show. If there’s a later date or a different city, try that.` };
    }
  }
} catch(_) { }
if (!intent || !intent.intent_type) {
  if (/(?:\bwhen\b|\bwhat\s*time\b)/i.test(q) && /(\bdeparture\b|\bcheckout\b|\bairport\s*call\b|\blobby\s*call\b)/i.test(q)) {
    intent = { intent_type: "term_lookup", confidence: 0.65, entities: {} };
  }
}
// Try to infer a human term from DB-derived router hints when missing
    if (!term && this.routerHints && timeLike && city) {
      for (const h of this.routerHints) {
        if (q.includes(h)) { term = h; break; }
      }
    }

    // --- Only route to travel if the message actually mentions flights ---
    const mentionsFlight = /\bflight(s)?\b/.test(q);
    const timeLike = (verb === "what time is" || verb === "when is");
    if (mentionsFlight) {
      const text = formatUpcomingFlights(10, city ? { toCity: city, userTz: "Australia/Sydney" } : { userTz: "Australia/Sydney" });
      return { responseType: "travelSchedule", payload: { text } };
    }

    // --- If time-like + city, try to infer the show field directly from the message ---
    function guessTermFromShowKeys(qstr, showObj) {
      const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
      const qs = norm(qstr);
      for (const k of Object.keys(showObj || {})) {
        const base = k.replace(/_?(time|name)$/i, "");
        const baseNorm = norm(base).replace(/_/g, "");
        if (!baseNorm) continue;
        if (qs.includes(baseNorm)) return base; // e.g., "soundcheck"
      }
      return null;
    }

    // --- Contextual show lookup for any term with a city ---
    if (city) {
      const show = await this.getShowByCity(city);
      if (show) {
        if (!term) {
          const guessed = guessTermFromShowKeys(q, show);
          if (guessed) term = guessed;
        }
        if (term) {
          const hit = this.findFieldForTerm({ show, term, verb });
          if (hit) {
            if (verb === "where is") {
              const locParts = [show.venue_name, show.city, show.state || show.region, show.country].filter(Boolean);
              const place = locParts.join(", ");
              return { responseType: "contextualLocation", payload: { term, city, field: hit.k, value: hit.val, place } };
            }
            return { responseType: "contextualTerm", payload: { term, city, field: hit.k, value: hit.val } };
          }
        }
        if (term && this.industryTerms?.includes(term)) {
          const definition = await resolveAnswer(term);
          if (definition) return { responseType: "genericTerm", payload: { term, definition } };
        }
        return null;
      }
      if (term && this.industryTerms?.includes(term)) {
        const definition = await resolveAnswer(term);
        if (definition) return { responseType: "genericTerm", payload: { term, definition } };
      }
      return null;
    }

    // --- Generic definition (term only, no city) ---
    if (term) {
      const definition = await resolveAnswer(term);
      if (definition) return { responseType: "genericTerm", payload: { term, definition } };
    }

    return null;
  }

  generateResponseText(retrieved) {
    const FALLBACKS = [
      "Sorry, I don’t have that info yet. Try another term?",
      "Hmm, I can’t find that. Want to ask about show times or venues?",
      "I don’t have that, but I can help with schedules, venues, or merch."
    ];
    if (!retrieved) return FALLBACKS[Math.floor(Math.random() * FALLBACKS.length)];

    const { responseType, payload = {} } = retrieved;

    if (responseType === "travelSchedule") {
      return payload.text || FALLBACKS[Math.floor(Math.random() * FALLBACKS.length)];
    }

    if (responseType === "contextualLocation") {
      const { term, city, place } = payload;
      return `The ${term} for the show in ${city} is at ${place}.`;
    }

    if (responseType === "contextualTerm") {
      const { term, city, field, value } = payload;
      // Add "at " when the field looks time-like for readability
      const prefix = String(field).toLowerCase().includes('time') ? 'at ' : '';
      return `The ${term} for the show in ${city} is ${prefix}${value}.`;
    }

    if (responseType === "genericTerm") {
      const { term, definition } = payload;
      return `The official definition for ${term} is: ${definition}`;
    }

    return FALLBACKS[Math.floor(Math.random() * FALLBACKS.length)];
  }

  // -------- Main dispatcher --------
  async generateResponse({ message, intent, context, member }) {
    try {
      const _q_norm = String(message || "").toLowerCase();
      const _timey = /(what\s+time|doors?\b|sound\s*-?check|load[\s-]?in|load[\s-]?out|on\s*[-\s]*stage|curfew|set\s*time|show\s*time|band\s*call|crew\s*call|lobby\s*call|airport\s*call|check[-\s]*out\s*time)/.test(_q_norm);
      if (!intent) intent = {};
      if (!intent.intent_type && _timey) intent.intent_type = "term_lookup";
      const memberStr = typeof member === "string" ? member : (member && (member.memberId || member.member_id || member.id || member.identifier)) || "guest";

      if (!intent || !intent.intent_type) {
        return { type: "fallback", text: "I'm not sure how to handle that yet." };
      }

      switch (intent.intent_type) {
        case "help":
          return { type: "help", text: "You can ask me about shows, schedules, venues, or general tour details." };

        case "show_schedule": {
          const { shows = [] } = await dataSource.getShows({});
          const today = new Date();
          const upcoming = shows
            .filter(s => s && s.date && new Date(s.date) >= today)
            .sort((a, b) => new Date(a.date) - new Date(b.date));

          if (!upcoming.length) {
            return { type: "schedule", text: `No upcoming shows found (for: ${memberStr})` };
          }

          const wantNext = /\bnext\s+show\b/i.test(message || "");
          const list = wantNext ? upcoming.slice(0, 1) : upcoming.slice(0, 10);

          const lines = list.map((s, idx) => lineForShow(s, idx + 1));
          const header = `I found ${list.length} ${list.length === 1 ? "show" : "shows"}:\n\n`;
          return { type: "schedule", text: header + lines.join("\n") };
        }

        // Term Lookup now routed through parse -> retrieve -> generate pipeline
        
case "term_lookup": {
          {
            const q = String(message || "").toLowerCase();
            const termId = (intent && (intent.term_id || (intent.entities && intent.entities.term_id))) || null;
            
    
    // [TmBot3000::TimeTerms] PRIORITY: schedule time lookup (race-safe) → return immediately on success
    try {
      // Ensure DB map is ready
      if (!this.timeTermMap || (typeof this.timeTermMap !== 'object')) {
        if (typeof this.loadTimeTermsFromDb === 'function') {
          await this.loadTimeTermsFromDb();
        }
        if (!this.timeTermMap || (typeof this.timeTermMap !== 'object')) this.timeTermMap = {};
      }

      // Resolve time-term from authoritative map
      const ttHit = termId ? this.timeTermMap[String(termId).toLowerCase()] : null;

      if (ttHit) {
        const __fieldKey = (ttHit.field_key || ttHit.field);
        const parsed = this.parseCityAndTerm(q);
        const city = parsed && parsed.city;

        if (!city) {
          return { type: 'fallback', text: 'I can grab the exact time if you tell me the city (e.g., “when are doors in Sydney?”).' };
        }

        const show = await this.getNextShowByCity(city);

        const __picked = __pickTimeField(show, __fieldKey);
        if (__picked) {const lbl = ttHit.label || (String(__fieldKey).replace(/_/g,' ').replace(/\b\w/g, m => m.toUpperCase()));
          const tz  = show.timezone ? ` ${show.timezone}` : '';
          return {
            type: 'schedule',
            text: `${lbl} for ${city} (${show.venue_name || 'TBA'}) on ${show.date || 'TBA'}: ${show[__picked]}${tz}`
          };
        } else {
          const lbl = ttHit.label || 'that time';
          return { type: 'fallback', text: `I couldn’t find ${lbl} for ${city} on the next show. If there’s a later date or a different city, try that.` };
        }
      }
      
// NL direct map for common time terms when no term_id was produced
try {
  if (!ttHit) {
    const directTerms = [
      { rx: /\bdeparture\b/i,        field: 'departure_time',     label: 'Departure time' },
      { rx: /\bcheckout\b/i,         field: 'checkout_time',      label: 'Checkout time'  },
      { rx: /\bairport\s*call\b/i,  field: 'airport_call_time',  label: 'Airport call time' },
      { rx: /\blobby\s*call\b/i,    field: 'lobby_call_time',    label: 'Lobby call time' }
    ];
    const hit = directTerms.find(t => t.rx.test(q));
    if (hit) {
      const parsed = this.parseCityAndTerm(q) || {};
      const city = parsed.city;
      if (!city) {
        return { type: 'fallback', text: 'I can grab the exact time if you tell me the city (e.g., “when are doors in Sydney?”).' };
      }
      const show = await this.getNextShowByCity(city);
      if (show) {
        const __picked = __pickTimeField(show, hit.field);
        if (__picked) {
          const tz = show.timezone ? (' ' + show.timezone) : '';
          return {
            type: 'schedule',
            text: `${hit.label} for ${city} (${show.venue_name || 'TBA'}) on ${show.date || 'TBA'}: ${show[__picked]}${tz}`
          };
        }
      }
      return { type: 'fallback', text: `I couldn’t find ${hit.label} for ${city} on the next show. If there’s a later date or a different city, try that.` };
    }
  }
} catch(_) { /* fall through */ }
// If not a time-term or no hit, fall through to glossary path
    } catch (e) {
      // On error, fall through to glossary path
      console.warn('[TimeTerms] priority block error:', e && e.message);
    }
// Hard intercept for time-terms
    try {
      const ttHit = intent && intent.entities && intent.entities.term_id ? await __resolveByTermId(intent.entities.term_id) : null;
      if (ttHit) {
        const cityParse = this.parseCityAndTerm(String(message || ""));
        const city = cityParse && cityParse.city;
        if (!city) {
          return { type: 'fallback', text: __friendlyMissingCity() };
        }
        const show = await this.getNextShowByCity(city);
        const __picked = __pickTimeField(show, __fieldKey);
        if (__picked) {const lbl = (ttHit.label || __prettifyLabelFromField(__fieldKey));
          return {
            type: 'schedule',
            text: __renderScheduleLine({
              label: lbl,
              city,
              venue: show.venue_name || 'TBA',
              date: show.date || 'TBA',
              value: show[__picked],
              tz: show.timezone || '',
            }),
          };
        }
      }
    } catch (e) { /* swallow and fall through to glossary */ }
const ti = termId && this.timeTermMap ? this.timeTermMap[String(termId).toLowerCase()] : null;
            if (ti && this.parseCityAndTerm && this.getNextShowByCity) {
              const parsed = this.parseCityAndTerm(q);
              const city = parsed && parsed.city;
              if (city) {
                const show = await this.getNextShowByCity(city);
                if (show && Object.prototype.hasOwnProperty.call(show, ti.field)) {
                  const val = show[ti.field];
                  if (val) {
                    const when  = String(val);
                    const vname = show.venue_name || show.venue || "venue";
                    const date  = show.date || show.show_date || "";
                    const tz    = show.timezone || show.tz || "";
                    return { type: "schedule", text: `${ti.label} for ${city} (${vname}) on ${date}: ${when} ${tz}` };
                  }
                }
              }
            }
          }
      try {
        const q = String(message || "").toLowerCase();
        const timeLike = /\bwhat\s+time\b|\btime\s+for\b|\bon\s*stage\b|\bsoundcheck\b|\bdoors\b|\bcurfew\b/.test(q);
        if (timeLike && this.parseCityAndTerm) {
          const parsed = this.parseCityAndTerm(q);
          const city = parsed && parsed.city;
          const term = parsed && parsed.term;
          if (city && term && this.resolveTermToField && this.getNextShowByCity) {
            const field = await this.resolveTermToField(term);
            if (field) {
              const show = await this.getNextShowByCity(city);
              if (show && Object.prototype.hasOwnProperty.call(show, field)) {
                const val = show[field];
                if (val) {
                  const when = String(val);
                  const vname = show.venue_name || show.venue || "venue";
                  const date  = show.date || show.show_date || "";
                  const tz    = show.timezone || show.tz || "";
                  const _clean = (s) => String(s||"")
                    .replace(/^\s*what\s+time\s+(is|are|for)\s*/, "")
                    .replace(/\b(in|at|the)\b/g, " ")
                    .replace(/\s+/g, " ")
                    .trim();
                  const labelBase = (typeof term === "string" && _clean(term)) ? _clean(term) : String(field||"").replace(/_time$/," ").replace(/_/g," ").trim();
                  const label = labelBase.charAt(0).toUpperCase() + labelBase.slice(1) + " time";
                  return { type: "schedule", text: `${label} for ${city} (${vname}) on ${date}: ${when} ${tz}` };
                }
              }
            }
          }
        }
      } catch (e) {}
          const locale = process.env.LOCALE || "en-AU";
      // Fast-path: time-like question + city → pull actual show time instead of glossary definition
      try {
        const q = String(message || "").toLowerCase();
        const timeLike = /\bwhat\s+time\b|\btime\s+for\b|\bon\s*stage\b|\bsoundcheck\b|\bdoors\b|\bcurfew\b/.test(q);
        if (timeLike && this.parseCityAndTerm) {
          const { city, term } = this.parseCityAndTerm(q);
          if (city && term && this.resolveTermToField && this.getNextShowByCity) {
            const field = await this.resolveTermToField(term);
            if (field) {
              const show = await this.getNextShowByCity(city);
              if (show && Object.prototype.hasOwnProperty.call(show, field)) {
                const val = show[field];
                if (val) {
                  const when = String(val);
                  const vname = show.venue_name || show.venue || "venue";
                  const date  = show.date || show.show_date || "";
                  const tz    = show.timezone || show.tz || "";
                  const _clean = (s) => String(s||"")
                    .replace(/^\s*what\s+time\s+(is|are|for)\s*/, "")
                    .replace(/\b(in|at|the)\b/g, " ")
                    .replace(/\s+/g, " ")
                    .trim();
                  const labelBase = (typeof term === "string" && _clean(term)) ? _clean(term) : String(field||"").replace(/_time$/," ").replace(/_/g," ").trim();
                  const label = labelBase.charAt(0).toUpperCase() + labelBase.slice(1) + " time";
                  return { type: "schedule", text: `${label} for ${city} (${vname}) on ${date}: ${when} ${tz}` };
                }
              }
            }
          }
        }
      } catch (e) {
        // swallow and fall back to glossary path
      }

          // 1) Parse message into { verb, entities }
          const parsed = this.parseMessage(message);

          // 2) Retrieve data based on parsed structure
          let retrieved = await this.retrieveData(parsed);

          // 3) If nothing came back, try legacy quick-match term_id as a safety net
          if (!retrieved) {
            let termId = intent.term_id || (intent.entities && intent.entities.term_id);
            if (!termId && message) {
              const normalizedMessage = (message || "").toLowerCase();
              const foundTerm = this.industryTerms.find(term => normalizedMessage.includes(term));
              if (foundTerm) termId = foundTerm;
            }
            if (termId) {
              const definition = await resolveAnswer(termId, locale);
              if (definition) {
                retrieved = { responseType: "genericTerm", payload: { term: termId, definition } };
              }
            }
          }

          // 4) Generate user-facing text from retrieved data (or friendly fallback)
          const text = this.generateResponseText(retrieved);
          return { type: "answer", text };
        }

        // Refactored Flights / travel handler (unchanged in behavior)
        case "travel": {
          // [TmBot3000] time-term override inside travel: checkout/departure/airport call/lobby call
{
  const qText = String(message || "");
  const timey = /(?:\bwhen\b|\bwhat\s*time\b)/i.test(qText);
  const directTerms = [
    { rx: /\bcheckout\b/i,         field: 'checkout_time',      label: 'Checkout time' },
    { rx: /\bdeparture\b/i,        field: 'departure_time',     label: 'Departure time' },
    { rx: /\bairport\s*call\b/i,  field: 'airport_call_time',  label: 'Airport call time' },
    { rx: /\blobby\s*call\b/i,    field: 'lobby_call_time',    label: 'Lobby call time' }
  ];
  const hit = timey ? directTerms.find(t => t.rx.test(qText)) : null;
  if (hit) {
    const parsed = this.parseCityAndTerm(qText) || {};
    const city = parsed.city;
    if (!city) {
      return { type: 'fallback', text: 'I can grab the exact time if you tell me the city (e.g., “when are doors in Sydney?”).' };
    }
    const show = await this.getNextShowByCity(city);
    if (show) {
      const picked = (typeof __pickTimeField === 'function') ? __pickTimeField(show, hit.field) : hit.field;
      if (picked && show[picked]) {
        const tz = show.timezone ? (' ' + show.timezone) : '';
        return { type: 'schedule', text: `${hit.label} for ${city} (${show.venue_name || 'TBA'}) on ${show.date || 'TBA'}: ${show[picked]}${tz}` };
      }
    }
    return { type: 'fallback', text: `I couldn’t find ${hit.label} for ${city} on the next show. If there’s a later date or a different city, try that.` };
  }
}
try {
            const opts = { userTz: "Australia/Sydney" };
            let limit = 10;
            const normalizedMessage = (message || "").toLowerCase();

            // Check for "from" city first using the dynamically loaded city list
            const fromCityMatch = this.cities.find(city => normalizedMessage.includes(`from ${city}`));
            if (fromCityMatch) {
              opts.fromCity = fromCityMatch;
              limit = 50;
            } else {
              // Check for "to" city
              const toCityMatch = this.cities.find(city => normalizedMessage.includes(`to ${city}`));
              if (toCityMatch) {
                opts.toCity = toCityMatch;
                limit = 50;
              } else if (/\bnext\b/.test(normalizedMessage)) {
                // Check for "next"
                opts.nextOnly = true;
                limit = 1;
              } else if (/\btoday\b/.test(normalizedMessage)) {
                // Check for "today"
                opts.todayOnly = true;
                limit = 50;
              } else {
                // Final fallback: check for any city name without a prefix
                const genericCityMatch = this.cities.find(city => normalizedMessage.includes(city));
                if (genericCityMatch) {
                  opts.city = genericCityMatch;
                  limit = 50;
                }
              }
            }
            const text = formatUpcomingFlights(limit, opts);
            return { type: "schedule", text };
          } catch (e) {
            console.error("[TmAiEngine] Error in travel handler:", e);
            return { type: "error", text: "Flights lookup failed: " + e.message };
          }
        }
        
        default:
          return { type: "unknown", text: `I don’t have a handler for intent: ${intent.intent_type}` };
      }
    } catch (err) {
      console.error("[AiEngine] Error in generateResponse:", err);
      return { type: "error", text: "Sorry, something went wrong while generating a response.", error: String(err?.message || err) };
    }
  }
}

// The export statement is correct, creating and exporting one instance of the engine.
const engine = new TmAiEngine();
setImmediate(() => engine.loadTimeTermsFromDb && engine.loadTimeTermsFromDb());
module.exports = engine;

// -------- Updated flights formatter (timezone-aware) --------
function formatUpcomingFlights(limit = 10, opts = {}) {
  const fs = require("fs");
  const path = require("path");
  const file = path.resolve(__dirname, "..", "data", "travel_flights.csv");
  if (!fs.existsSync(file)) return "I found 0 flights.";

  const txt = fs.readFileSync(file, "utf8");
  const lines = txt.split(/\r?\n/).filter(Boolean);
  if (lines.length <= 1) return "I found 0 flights.";

  const header = lines.shift();
  const cols = header.split(",");
  const idx = (n) => cols.indexOf(n);

  const I = {
    airline: idx("airline"),
    flight_number: idx("flight_number"),
    departure_city: idx("departure_city"),
    arrival_city: idx("arrival_city"),
    departure_time: idx("departure_time"),
    arrival_time: idx("arrival_time"),
    departure_timezone: idx("departure_timezone"),
    arrival_timezone: idx("arrival_timezone"),
    confirmation: idx("confirmation"),
  };

  function parseCSV(line) {
    const out = []; let cur = ""; let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else { q = !q; } }
      else if (c === "," && !q) { out.push(cur); cur = ""; }
      else { cur += c; }
    }
    out.push(cur);
    while (out.length < cols.length) out.push("");
    return out;
  }

  const rows = lines.map(parseCSV).map(a => ({
    airline: a[I.airline],
    flight_number: a[I.flight_number],
    departure_city: a[I.departure_city],
    arrival_city: a[I.arrival_city],
    departure_time: a[I.departure_time],
    arrival_time: a[I.arrival_time],
    departure_timezone: a[I.departure_timezone] || opts.userTz || "Australia/Sydney",
    arrival_timezone: a[I.arrival_timezone],
    confirmation: a[I.confirmation],
  })).filter(r => r.departure_time);

  function getOffsetMinutesAt(utcMs, tz) {
    const d = new Date(utcMs);
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
    });
    const parts = Object.fromEntries(fmt.formatToParts(d).map(p => [p.type, p.value]));
    const asUTC = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    return (asUTC - utcMs) / 60000;
  }
  function zonedLocalToEpochMs(localIso, tz) {
    const Y = +localIso.slice(0, 4), M = +localIso.slice(5, 7), D = +localIso.slice(8, 10);
    const h = +(localIso.slice(11, 13) || "0"), m = +(localIso.slice(14, 16) || "0"), s = +(localIso.slice(17, 19) || "0");
    const base = Date.UTC(Y, M - 1, D, h, m, s);
    let off = getOffsetMinutesAt(base, tz);
    const guess = base - off * 60000;
    off = getOffsetMinutesAt(guess, tz);
    return base - off * 60000;
  }

  const nowUtc = Date.now();

  let list = rows.map(r => ({ ...r, depEpoch: zonedLocalToEpochMs(r.departure_time, r.departure_timezone) }));

  if (opts.toCity) {
    const c = String(opts.toCity).toLowerCase();
    list = list.filter(r => (r.arrival_city || "").toLowerCase() === c);
  } else if (opts.fromCity) {
    const c = String(opts.fromCity).toLowerCase();
    list = list.filter(r => (r.departure_city || "").toLowerCase() === c);
  } else if (opts.city) {
    const c = String(opts.city).toLowerCase();
    list = list.filter(r =>
      (r.departure_city || "").toLowerCase() === c ||
      (r.arrival_city || "").toLowerCase() === c
    );
  }

  list = list.filter(r => r.depEpoch >= nowUtc).sort((a, b) => a.depEpoch - b.depEpoch);

  if (opts.todayOnly) {
    const fmtUser = new Intl.DateTimeFormat("en-CA", {
      timeZone: opts.userTz || "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit"
    });
    const p = Object.fromEntries(fmtUser.formatToParts(new Date()).map(x => [x.type, x.value]));
    const today = `${p.year}-${p.month}-${p.day}`;
    list = list.filter(r => {
      const d = new Date(r.depEpoch);
      const pu = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
        timeZone: opts.userTz || "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit"
      }).formatToParts(d).map(x => [x.type, x.value]));
      const dateInUserTz = `${pu.year}-${pu.month}-${pu.day}`;
      return dateInUserTz === today;
    });
  }

  if (list.length === 0) return "I found 0 flights.";
  if (opts.nextOnly) list = [list[0]];
  if (limit && list.length > limit) list = list.slice(0, limit);

  const pad = s => (s || "").trim();
  function prettyDate(ms, tz) {
    return new Date(ms).toLocaleDateString("en-AU", { timeZone: tz, weekday: "long", day: "numeric", month: "long", year: "numeric" });
  }
  function prettyTime(ms, tz) {
    return new Date(ms).toLocaleTimeString("en-AU", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false });
  }

  let out = `I found ${list.length} flight${list.length === 1 ? "" : "s"}:\n`;
  list.forEach((r, i) => {
    out += `\n${i + 1}. ${prettyDate(r.depEpoch, r.departure_timezone)}\n`;
    out += `    ✈️ ${pad(r.airline)} ${pad(r.flight_number)} — ${pad(r.departure_city)} → ${pad(r.arrival_city)}\n`;
    out += `    🕘 Dep: ${prettyTime(r.depEpoch, r.departure_timezone)} ${pad(r.departure_timezone)}\n`;
    if (r.arrival_time) out += `    🕒 Arr: ${pad(r.arrival_time.slice(11, 16))} ${pad(r.arrival_timezone)}\n`;
    if (r.confirmation) out += `    🔖 Conf: ${pad(r.confirmation)}\n`;
  });
  return out;
}


// ==== Appended helper methods (prototype patch; no anchors needed) ====
// parseCityAndTerm: extract {city, term} from user text (e.g., "what time is soundcheck in brisbane")
if (typeof TmAiEngine !== "undefined" && TmAiEngine.prototype) {
  TmAiEngine.prototype.parseCityAndTerm = function(q) {
    const text = String(q || "").toLowerCase();
    const cities = (this.cities || []).map(c => String(c).toLowerCase()).filter(Boolean);
    let foundCity = null;
    for (const c of cities) {
      if (text.includes(c)) { foundCity = c; break; }
    }
    let term = text
      .replace(/what\s+time\s+(is|for|do\s+we\s+have|does\s+.*\s+start)\s*/g, "")
      .replace(/\?+$/,"");
    if (foundCity) term = term.replace(foundCity, "").trim();
    term = term.replace(/\b(in|at|the)\b/g, " ").replace(/\s+/g, " ").trim();
    return { city: foundCity, term };
  };

  // resolveTermToField: map "soundcheck"/"load in"/"doors"/"on stage" → best show field.
  // Data-driven: derives candidates from the first show object keys at call time.
  TmAiEngine.prototype.resolveTermToField = async function(term) {
    const t = String(term || "").toLowerCase().trim();
    if (!t) return null;

    // Try to access the shared data source that exposes getShows()
    const ds = (this && this.dataSource) || (typeof dataSource !== "undefined" ? dataSource : null);
    let first = null;
    try {
      if (ds && ds.getShows) {
        const { shows = [] } = await ds.getShows({});
        first = shows && shows[0];
      }
    } catch (e) {
      // swallow; we'll just fall back to alias-only if needed
    }

    const candidates = new Set();
    if (first && typeof first === "object") {
      for (const k of Object.keys(first)) {
        const nk = String(k).toLowerCase();
        if (/_time$/.test(nk) || /_(name|venue|location)$/.test(nk) || nk === "venue" || nk === "venue_name") {
          const base = nk.replace(/_(time|name)$/,"").replace(/_/g, " ").trim();
          if (base) candidates.add(base);
          // also include the raw key for *_time preference
          candidates.add(nk);
        }
      }
    }

    const ALIASES = {
      "soundcheck": ["soundcheck_time","sound check","sound-check"],
      "load in": ["load_in_time","loadin","load-in","load in"],
      "loadout": ["load_out_time","load out","load-out","loadout","load out time"],
      "on stage": ["show_time","onstage","on-stage","on stage time","onstage time"],
      "doors": ["doors_time","door time","doors open","doors-open","doors time"],
      "show": ["show_time","set time","settime","set"],
      "curfew": ["curfew_time","curfew time"]
    };

    for (const [k, arr] of Object.entries(ALIASES)) {
      if (t.includes(k)) for (const a of arr) candidates.add(a);
    }

    const scored = [];
    for (const c of candidates) {
      const cNorm = String(c).toLowerCase();
      let score = 0;
      if (cNorm === t) score = 100;
      else if (cNorm.startsWith(t)) score = 80;
      else if (t.startsWith(cNorm)) score = 75;
      else if (cNorm.includes(t) || t.includes(cNorm)) score = 60;
      if (/_time$/.test(cNorm)) score += 15; // time fields preferred
      scored.push({ field: c, score });
    }
    scored.sort((a,b)=>b.score - a.score);
    const best = scored[0];
    if (!best || best.score < 50) return null;

    let f = best.field.replace(/\s+/g, "_");
    if (!/_time$/.test(f) && /(time|doors|show|curfew|load[_-]?(in|out)|soundcheck|on[_-]?stage)/.test(f)) {
      if (!/_time$/.test(f)) f = f.replace(/_?(time)?$/, "_time");
    }
    return f;
  };
}

// Return the next (earliest) show for a given city (case-insensitive).
// Prototype patch so we don't depend on class location.
if (typeof TmAiEngine !== "undefined" && TmAiEngine.prototype) {
  TmAiEngine.prototype.getNextShowByCity = async function(cityLower) {
    const ds = (this && this.dataSource) || (typeof dataSource !== "undefined" ? dataSource : null);
    try {
      const { shows = [] } = ds && ds.getShows ? await ds.getShows({}) : { shows: [] };
      const target = String(cityLower || "").toLowerCase();
      let best = null;
      for (const s of shows) {
        const c = String(s.city || s.venue_city || "").toLowerCase();
        if (c !== target) continue;
        const when = new Date(s.date || s.show_date || 0);
        if (!best) { best = s; continue; }
        const bWhen = new Date(best.date || best.show_date || 0);
        if (when < bWhen) best = s;
      }
      return best;
    } catch (e) {
      return null;
    }
  };
}

// Load authoritative time terms from DB view tm_time_terms
if (typeof TmAiEngine !== "undefined" && TmAiEngine.prototype) {
  TmAiEngine.prototype.loadTimeTermsFromDb = async function() {
    try {
      const sql = 'SELECT term_id, field_key, label FROM tm_time_terms';
      const res = await db.query(sql);
      this.timeTermMap = Object.fromEntries(
        (res.rows || [])
          .filter(r => r.term_id && r.field_key)
          .map(r => [String(r.term_id).toLowerCase(), { field: r.field_key, label: r.label }])
      );
      console.log(`[TmAiEngine] Loaded \${Object.keys(this.timeTermMap||{}).length} time terms from DB.`);
    } catch (e) {
      console.error("[TmAiEngine] Error loading time terms:", e && e.message || e);
      this.timeTermMap = {};
    }
  };
}



function __pickTimeField(show, key) {
  if (!show || !key) return null;
  const keys = new Set(Object.keys(show));
  const cand = [];
  cand.push(key);                          // load_in_time
  cand.push(key.replace(/_time$/, ''));    // load_in
  cand.push(key.replace(/_/g, ''));        // loadintime
  cand.push(key.replace(/_time$/, '_at')); // load_in_at
  cand.push(key.replace('load_in','loadin')); // loadin_time
  for (const k of cand) if (keys.has(k)) return k;
  return null;
}
