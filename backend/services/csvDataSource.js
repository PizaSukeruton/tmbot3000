// services/csvDataSource.js
// CSV-backed data provider for the AI engine (beta mode).
// Exposes the same contract you'd expect from a MasterTour client wrapper.

const fs = require('fs');
const path = require('path');

function safeRead(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

// Minimal CSV parser supporting quoted fields and commas inside quotes.
// Returns array of objects keyed by header row.
function parseCsv(text) {
  if (!text.trim()) return [];
  const rows = [];
  let line = '';
  const lines = [];

  // Normalize line endings
  text.split(/\r?\n/).forEach((l) => lines.push(l));

  // Join continued lines if needed (keep simple; most CSVs won’t need this)
  const header = lines.shift();
  if (!header) return [];

  const headers = splitCsvLine(header);

  for (const raw of lines) {
    if (!raw.trim()) continue;
    const cols = splitCsvLine(raw);
    const obj = {};
    headers.forEach((h, i) => {
      obj[h.trim()] = (cols[i] ?? '').trim();
    });
    rows.push(obj);
  }
  return rows;
}

function splitCsvLine(line) {
  const cols = [];
  let cur = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      cols.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  cols.push(cur);
  return cols;
}

function indexBy(arr, key) {
  const map = new Map();
  for (const item of arr) {
    if (item[key]) map.set(item[key], item);
  }
  return map;
}

function groupBy(arr, key) {
  const map = new Map();
  for (const item of arr) {
    const k = item[key];
    if (!k) continue;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return map;
}

/**
 * @param {object} opts
 * @param {string} opts.dataDir - directory containing CSV files
 * @returns {{ getShows, getShow, getVenue, getSetlist, getTravelInfo, getSoundcheckSchedule }}
 */
function createCsvDataSource({ dataDir }) {
  // Load all CSVs once (restart to refresh)
  const shows = parseCsv(safeRead(path.join(dataDir, 'shows.csv')));
  const venues = parseCsv(safeRead(path.join(dataDir, 'venues.csv')));
  const setlists = parseCsv(safeRead(path.join(dataDir, 'setlists.csv')));
  const flights = parseCsv(safeRead(path.join(dataDir, 'travel_flights.csv')));
  const hotels = parseCsv(safeRead(path.join(dataDir, 'travel_hotels.csv')));
  const ground = parseCsv(safeRead(path.join(dataDir, 'ground_transport.csv')));
  const soundcheck = parseCsv(safeRead(path.join(dataDir, 'soundcheck_schedule.csv')));
  const prodNotes = parseCsv(safeRead(path.join(dataDir, 'production_notes.csv')));
  const merchSales = parseCsv(safeRead(path.join(dataDir, 'merch_sales.csv')));
  const venueById = indexBy(venues, 'venue_id');
  const showsById = indexBy(shows, 'show_id');
  const setlistByShow = groupBy(setlists, 'show_id');
  const flightsByShow = groupBy(flights, 'show_id');
  const flightsByDate = groupBy(flights, 'date');
  const hotelsByShow = groupBy(hotels, 'show_id');
  const hotelsByDate = groupBy(hotels, 'date');
  const groundByShow = groupBy(ground, 'show_id');
  const groundByDate = groupBy(ground, 'date');
  const schedByShow = groupBy(soundcheck, 'show_id');
  const prodNotesByShow = groupBy(prodNotes, 'show_id');
  const merchByShow = groupBy(merchSales, 'show_id');
  function normalizeShow(s) {
    // Return canonical show object; ensure times & tz fields are named consistently
    return {
      show_id: s.show_id,
      date: s.date, // expect YYYY-MM-DD or ISO
      venue_id: s.venue_id,
      venue_name: s.venue_name,
      city: s.city,
      state: s.state,
      country: s.country,
      timezone: s.timezone || s.venue_timezone, // IANA
      doors_time: s.doors_time, // prefer ISO; allow "HH:MM"
      show_time: s.show_time,
      soundcheck_time: s.soundcheck_time,
      load_in_time: s.load_in_time,

      load_out_time: s.load_out_time,
      curfew_time: s.curfew_time,
      lobby_call_time: s.lobby_call_time,
      departure_time: s.departure_time,
      airport_call_time: s.airport_call_time,
      band_call_time: s.band_call_time,
      checkout_time: s.checkout_time,
      crew_call_time: s.crew_call_time,
      set_length: s.set_length,
      set_times: s.set_times,      ticket_status: s.ticket_status,
    };
  }

  return {
    async getShows(filters = {}) {
      let list = shows.map(normalizeShow);

      if (filters.city) {
        const needle = String(filters.city).trim().toLowerCase();
        list = list.filter((s) => (s.city || '').trim().toLowerCase() === needle);
      }

      const todayYmd = new Date().toISOString().slice(0, 10);
      if (filters.upcoming) {
        list = list.filter((s) => String(s.date) >= todayYmd);
      }
      if (filters.past) {
        list = list.filter((s) => String(s.date) < todayYmd);
      }
      if (filters.date_from) {
        list = list.filter((s) => String(s.date) >= String(filters.date_from));
      }
      if (filters.date_to) {
        list = list.filter((s) => String(s.date) <= String(filters.date_to));
      }

      // Sort by date asc, then show_time if present
      list.sort((a, b) => {
        const da = String(a.date);
        const db = String(b.date);
        if (da !== db) return da < db ? -1 : 1;
        const ta = a.show_time || '';
        const tb = b.show_time || '';
        return ta < tb ? -1 : ta > tb ? 1 : 0;
      });

      return { shows: list };
    },

    async getShow(showId) {
      const s = showsById.get(showId);
      return s ? normalizeShow(s) : null;
    },

    async getVenue(venueId) {
      const v = venueById.get(venueId);
      if (!v) return null;
      return {
        venue_id: v.venue_id,
        name: v.name,
        address: {
          street: [v.address_street].filter(Boolean).join(' '),
          city: v.address_city,
          state: v.address_state,
          zip: v.address_zip,
          country: v.address_country,
        },
        capacity: v.capacity ? Number(v.capacity) : undefined,
        phone: v.phone,
        website: v.website,
        parking_info: v.parking_info,
        load_in_info: v.load_in_info,
        contact: {
          name: v.contact_name,
          email: v.contact_email,
          phone: v.contact_phone,
        },
      };
    },

    async getSetlist(showId) {
      const rows = setlistByShow.get(showId) || [];
      if (!rows.length) return { show_id: showId, songs: [] };

      // If sets present, group by set_index; else treat as flat list
      const hasSets = rows.some((r) => r.set_index);
      if (hasSets) {
        const setsMap = new Map();
        for (const r of rows) {
          const idx = Number(r.set_index || 1);
          if (!setsMap.has(idx)) setsMap.set(idx, { name: r.set_name || `Set ${idx}`, songs: [] });
          setsMap.get(idx).songs.push({
            title: r.song_title,
            duration: r.duration || undefined,
            notes: r.notes || undefined,
          });
        }
        const sets = [...setsMap.keys()].sort((a, b) => a - b).map((k) => setsMap.get(k));
        return { show_id: showId, sets, songs: sets.flatMap((s) => s.songs) };
      }

      const songs = rows
        .sort((a, b) => Number(a.song_index || 0) - Number(b.song_index || 0))
        .map((r) => ({ title: r.song_title, duration: r.duration || undefined }));

      return { show_id: showId, songs };
    },

    async getTravelInfo(key) {
      // key can be show_id or date
      const fByShow = flightsByShow.get(key) || [];
      const fByDate = flightsByDate.get(key) || [];
      const hByShow = hotelsByShow.get(key) || [];
      const hByDate = hotelsByDate.get(key) || [];
      const gByShow = groundByShow.get(key) || [];
      const gByDate = groundByDate.get(key) || [];

      const flightsList = (fByShow.length ? fByShow : fByDate).map((f) => ({
        airline: f.airline,
        flight_number: f.flight_number,
        departure_city: f.departure_city,
        arrival_city: f.arrival_city,
        departure_time: f.departure_time || null,
        arrival_time: f.arrival_time || null,
        departure_timezone: f.departure_timezone || null,
        arrival_timezone: f.arrival_timezone || null,
        confirmation: f.confirmation || null,
      }));

      const hotelRow = (hByShow.length ? hByShow : hByDate)[0];
      const hotel = hotelRow
        ? {
            name: hotelRow.name,
            address: hotelRow.address,
            check_in_date: hotelRow.check_in_date || null,
            check_out_date: hotelRow.check_out_date || null,
            confirmation: hotelRow.confirmation || null,
          }
        : null;

      const groundRow = (gByShow.length ? gByShow : gByDate)[0];
      const groundTransport = groundRow
        ? {
            type: groundRow.type,
            pickup_time: groundRow.pickup_time || null,
            pickup_location: groundRow.pickup_location || null,
          }
        : null;

      return {
        show_id: showsById.has(key) ? key : undefined,
        date: flightsByDate.has(key) || hotelsByDate.has(key) || groundByDate.has(key) ? key : undefined,
        flights: flightsList,
        hotel: hotel || undefined,
        ground_transport: groundTransport || undefined,
      };
    },

    async getSoundcheckSchedule(showId) {
      const rows = schedByShow.get(showId) || [];
      const venueTz = (showsById.get(showId) || {}).timezone;
      const schedule = rows
        .sort((a, b) => String(a.time).localeCompare(String(b.time)))
        .map((r) => ({ time: r.time, activity: r.activity, notes: r.notes || null }));

      // Optional technical notes could be provided in a separate row/column if desired
      return { show_id: showId, timezone: venueTz, schedule };
    },
    async getProductionNotes(showId) {
      const notes = prodNotesByShow.get(showId) || [];
      return {
        show_id: showId,
        notes: notes.map(n => ({
          category: n.category,
          note: n.note,
          priority: n.priority,
          created_by: n.created_by
        }))
      };
    },

    async getMerchSales(showId) {
  console.log('[DEBUG][csv] getMerchSales showId=', showId);
  console.log('[DEBUG][csv] merchSales size=', Array.isArray(merchSales) ? merchSales.length : -1);
      const sales = merchByShow.get(showId) || [];
      const total = sales.reduce((sum, item) => sum + parseFloat(item.gross_sales || 0), 0);
      return {
        show_id: showId,
        items: sales,
        total_gross: total
      };
    },

    async getFlightsByDestination(city) {
      const cityLower = city.toLowerCase().trim();
      const matches = flights.filter(f => 
        f.arrival_city.toLowerCase().includes(cityLower)
      );
      return { flights: matches };
    },
  };
}

module.exports = { createCsvDataSource };

