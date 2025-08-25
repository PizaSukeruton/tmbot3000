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
    
    // Load the terms and cities when the engine is instantiated.
    this.loadTerms(); 
    this.loadCities();
  }

  // Method to asynchronously load the terms from the database
  async loadTerms() {
    this.industryTerms = await getTermIds();
    console.log(`Loaded ${this.industryTerms.length} industry terms from the database.`);
  }

  // Method to asynchronously load cities from the CSV data
  async loadCities() {
    this.cities = await getCitiesFromCsv();
    console.log(`Loaded ${this.cities.length} unique cities from the travel data.`);
  }

  async generateResponse({ message, intent, context, member }) {
    try {
      const memberStr = typeof member === "string"
        ? member
        : (member && (member.memberId || member.member_id || member.id || member.identifier)) || "guest";

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

        // Updated Term Lookup Handler to dynamically check the message for terms
        case "term_lookup": {
          const locale = process.env.LOCALE || "en-AU";
          let termId = intent.term_id || (intent.entities && intent.entities.term_id);

          // If the NLU system doesn't provide a term_id, we look for one in the message.
          if (!termId && message) {
            const normalizedMessage = message.toLowerCase();
            // We use .find() to get the first match in our list of terms.
            const foundTerm = this.industryTerms.find(term => normalizedMessage.includes(term));
            if (foundTerm) {
              termId = foundTerm;
            }
          }

          const answer = await resolveAnswer(termId, locale);
          return { type: "answer", text: answer || "No answer found for this term." };
        }

        // Refactored Flights / travel handler with improved keyword logic
        case "travel": {
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
module.exports = new TmAiEngine();

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

