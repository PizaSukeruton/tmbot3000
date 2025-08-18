// services/tmAiEngine.js
// AI engine for TmBot3000 (CSV- or API-backed via injected dataSource)
// - No external deps
// - Timezone-aware formatting based on user preference (venue | user_local | both)
// - Expects dataSource with methods: getShows, getShow, getVenue, getSetlist, getTravelInfo, getSoundcheckSchedule
// - Assumes date/time fields are ISO8601 strings with timezone (preferred), or plain "HH:MM" with a known venue timezone

class TmAiEngine {
  /**
   * @param {object} opts
   * @param {object} opts.dataSource - Provides show/venue/setlist/travel/schedule data
   * @param {string} [opts.defaultUserTimezone='UTC'] - Fallback when user TZ missing
   */
  constructor({ dataSource, defaultUserTimezone = 'UTC' }) {
    this.dataSource = dataSource;
    this.defaultUserTimezone = defaultUserTimezone;

    // In-memory templates (can be moved to DB later)
    this.responseTemplates = new Map();
    this.templatesLoaded = false;
  }

  static async create(opts) {
    const engine = new TmAiEngine(opts);
    await engine.loadTemplates();
    return engine;
  }

  async loadTemplates() {
    // Basic templates; expand as needed
    this.responseTemplates.set('show_schedule', {
      found: 'I found {count} show{plural}:\n\n{details}',
      notFound: 'No shows matched your criteria.',
      error: 'I’m having trouble accessing the show schedule right now.',
    });

    this.responseTemplates.set('venue_info', {
      found: 'Here’s the venue info for {venue_name}:\n\n{details}',
      notFound: 'I couldn’t find information about that venue.',
      error: 'I’m having trouble accessing venue information right now.',
    });

    this.responseTemplates.set('setlist', {
      found: '🎵 Setlist for {show_name}:\n\n{songs}',
      notFound: 'The setlist hasn’t been finalized yet.',
      error: 'I’m having trouble accessing setlist information.',
    });

    this.responseTemplates.set('travel_info', {
      found: '✈️ Travel Information:\n\n{details}',
      notFound: 'No travel information available.',
      error: 'I’m having trouble accessing travel details right now.',
    });

    this.responseTemplates.set('soundcheck', {
      found: '🔊 Schedule:\n\n{details}',
      notFound: 'No soundcheck schedule available.',
      error: 'I’m having trouble accessing the schedule right now.',
    });

    this.templatesLoaded = true;
  }

  // Public entrypoint
  async generateResponse(params) {
    const { message, intent, context, member } = params;

    if (!this.templatesLoaded) {
      await this.loadTemplates();
    }

    // General smalltalk/help
    if (!intent || !intent.intent_type) {
      return this.generateGeneralResponse(message, context, member);
    }

    try {
      const intentType = intent.intent_type;

      switch (intentType) {
        case 'show_schedule':
          return await this.handleShowSchedule(intent, member);

        case 'venue_info':
          return await this.handleVenueInfo(intent, member);

        case 'setlist':
          return await this.handleSetlist(intent, member);

        case 'travel_info':
          return await this.handleTravelInfo(intent, member);

        case 'soundcheck':
          return await this.handleSoundcheck(intent, member);

        default:
          return this.generateFallbackResponse(message, intent);
      }
    } catch (err) {
      // Generic engine error (intent-specific errors handled in handlers)
      return {
        content:
          'I’m sorry, I hit a snag processing that. Please try again in a moment.',
        metadata: { error: String(err?.message || err), engine: 'tm-ai' },
      };
    }
  }

  // ===== Handlers =====

  async handleShowSchedule(intent, member) {
    const tpl = this.responseTemplates.get('show_schedule');
    try {
      // Gather filters from intent.entities (city, upcoming/past, date range, etc.)
      const filters = this.buildShowFilters(intent.entities);
      const data = await this.dataSource.getShows(filters);

      const shows = Array.isArray(data?.shows) ? data.shows : [];
      if (shows.length === 0) {
        return { content: tpl.notFound, metadata: { intent: 'show_schedule' } };
      }

      const details = shows
        .map((show, idx) => this.formatShowLine(idx, show, member))
        .join('\n');

      const content = tpl.found
        .replace('{count}', String(shows.length))
        .replace('{plural}', shows.length > 1 ? 's' : '')
        .replace('{details}', details);

      return {
        content,
        metadata: {
          intent: 'show_schedule',
          count: shows.length,
        },
        entities: this.extractResponseEntitiesFromShowList(shows),
      };
    } catch (err) {
      return { content: tpl.error, metadata: { error: String(err?.message || err), intent: 'show_schedule' } };
    }
  }

  async handleVenueInfo(intent, member) {
    const tpl = this.responseTemplates.get('venue_info');
    try {
      const venueId = intent.entities?.venueId || intent.entities?.venue_id;
      if (!venueId) {
        return this.generateClarification('venue_info', 'venue ID');
      }
      const venue = await this.dataSource.getVenue(venueId);
      if (!venue) {
        return { content: tpl.notFound, metadata: { intent: 'venue_info' } };
      }

      const details = this.formatVenueDetails(venue, member);
      const content = tpl.found
        .replace('{venue_name}', venue.name || 'the venue')
        .replace('{details}', details);

      return {
        content,
        metadata: { intent: 'venue_info' },
        entities: this.extractResponseEntitiesFromVenue(venue),
      };
    } catch (err) {
      return { content: tpl.error, metadata: { error: String(err?.message || err), intent: 'venue_info' } };
    }
  }

  async handleSetlist(intent, member) {
    const tpl = this.responseTemplates.get('setlist');
    try {
      const showId = intent.entities?.showId || intent.entities?.show_id;
      if (!showId) {
        return this.generateClarification('setlist', 'show ID');
      }
      const data = await this.dataSource.getSetlist(showId);
      const songsOut = this.formatSetlist(data, member);

      if (!songsOut) {
        return { content: tpl.notFound, metadata: { intent: 'setlist' } };
      }

      const content = tpl.found
        .replace('{show_name}', data?.show_name || 'the show')
        .replace('{songs}', songsOut);

      return {
        content,
        metadata: { intent: 'setlist', count: data?.songs?.length || 0 },
        entities: this.extractResponseEntitiesFromSetlist(data),
      };
    } catch (err) {
      return { content: tpl.error, metadata: { error: String(err?.message || err), intent: 'setlist' } };
    }
  }

  async handleTravelInfo(intent, member) {
    const tpl = this.responseTemplates.get('travel_info');
    try {
      // Use date or showId from entities (data source can handle either)
      const key = intent.entities?.date || intent.entities?.showId || intent.entities?.show_id;
      if (!key) {
        return this.generateClarification('travel_info', 'date or show ID');
      }
      const info = await this.dataSource.getTravelInfo(key);
      const details = this.formatTravelInfo(info, member);

      if (!details) {
        return { content: tpl.notFound, metadata: { intent: 'travel_info' } };
      }
      const content = tpl.found.replace('{details}', details);

      return {
        content,
        metadata: { intent: 'travel_info' },
        entities: this.extractResponseEntitiesFromTravel(info),
      };
    } catch (err) {
      return { content: tpl.error, metadata: { error: String(err?.message || err), intent: 'travel_info' } };
    }
  }

  async handleSoundcheck(intent, member) {
    const tpl = this.responseTemplates.get('soundcheck');
    try {
      const showId = intent.entities?.showId || intent.entities?.show_id;
      if (!showId) {
        return this.generateClarification('soundcheck', 'show ID');
      }
      const data = await this.dataSource.getSoundcheckSchedule(showId);
      const details = this.formatSoundcheckInfo(data, member);

      if (!details) {
        return { content: tpl.notFound, metadata: { intent: 'soundcheck' } };
      }
      const content = tpl.found.replace('{details}', details);

      return {
        content,
        metadata: { intent: 'soundcheck' },
        entities: this.extractResponseEntitiesFromSoundcheck(data),
      };
    } catch (err) {
      return { content: tpl.error, metadata: { error: String(err?.message || err), intent: 'soundcheck' } };
    }
  }

  // ===== Formatting helpers =====

  formatShowLine(index, show, member) {
    const lineParts = [];

    // Date line (weekday, Month DD, YYYY — venue city/country)
    const dateStr = this.formatDateDisplay(show.date, show.timezone || show.venue_timezone);
    const locStr = [show.venue_name, show.city, show.state || show.country]
      .filter(Boolean)
      .join(', ');

    lineParts.push(`${index + 1}. ${dateStr}`);
    lineParts.push(`   📍 ${locStr}`);

    // Doors/Show times (TZ-aware) + role specifics
    const tzPref = member?.timezone_preference || 'venue';
    const userTz = member?.user_timezone || this.defaultUserTimezone;

    if (show.doors_time) {
      lineParts.push(
        `   🚪 Doors: ${this.formatTimeDisplay(show.doors_time, show.timezone, tzPref, userTz)}`
      );
    }
    if (show.show_time) {
      lineParts.push(
        `   🎫 Show: ${this.formatTimeDisplay(show.show_time, show.timezone, tzPref, userTz)}`
      );
    }
    if (member?.role && (member.role === 'musician' || member.role === 'manager')) {
      if (show.soundcheck_time) {
        lineParts.push(
          `   🔊 Soundcheck: ${this.formatTimeDisplay(show.soundcheck_time, show.timezone, tzPref, userTz)}`
        );
      }
      if (show.load_in_time) {
        lineParts.push(
          `   📦 Load-in: ${this.formatTimeDisplay(show.load_in_time, show.timezone, tzPref, userTz)}`
        );
      }
    }

    if (show.ticket_status) {
      lineParts.push(`   🎟️ ${show.ticket_status}`);
    }

    return lineParts.join('\n');
  }

  formatVenueDetails(v, member) {
    const out = [];

    out.push(`📍 ${v.name || 'Venue'}`);
    if (v.address) {
      const addr = [v.address.street, v.address.city, v.address.state, v.address.zip]
        .filter(Boolean)
        .join(', ');
      out.push(`Address: ${addr}`);
    }
    if (v.capacity) out.push(`Capacity: ${Number(v.capacity).toLocaleString()}`);
    if (v.phone) out.push(`Phone: ${v.phone}`);
    if (v.website) out.push(`Website: ${v.website}`);

    const role = member?.role || 'crew';
    if (role === 'musician' || role === 'crew') {
      if (v.parking_info) out.push(`Parking: ${v.parking_info}`);
      if (v.load_in_info) out.push(`Load-in: ${v.load_in_info}`);
    }
    if (role === 'manager' || role === 'tour_manager') {
      if (v.contact) {
        const contact = [v.contact.name, v.contact.email, v.contact.phone].filter(Boolean).join(' · ');
        if (contact) out.push(`Contact: ${contact}`);
      }
    }

    return out.join('\n');
  }

  formatSetlist(data, member) {
    const role = member?.role || 'crew';
    if (Array.isArray(data?.sets) && data.sets.length) {
      const blocks = data.sets.map((set, idx) => {
        const title = set.name || `Set ${idx + 1}`;
        const songs = (set.songs || [])
          .map((song, i) => {
            const parts = [`${i + 1}. ${song.title}`];
            if (song.duration) parts.push(`(${song.duration})`);
            if (song.notes && role === 'musician') parts.push(`- ${song.notes}`);
            return parts.join(' ');
          })
          .join('\n');
        return `**${title}**\n${songs}`;
      });
      const total = data.total_duration ? `\n\nTotal runtime: ${data.total_duration}` : '';
      return `${blocks.join('\n\n')}${total}`.trim();
    }

    if (Array.isArray(data?.songs) && data.songs.length) {
      const list = data.songs
        .map((song, i) => {
          const parts = [`${i + 1}. ${song.title}`];
          if (song.duration) parts.push(`(${song.duration})`);
          return parts.join(' ');
        })
        .join('\n');
      const total = data.total_duration ? `\n\nTotal runtime: ${data.total_duration}` : '';
      return `${list}${total}`.trim();
    }

    return '';
  }

  formatTravelInfo(info, member) {
    const out = [];
    const role = member?.role || 'crew';
    const tzPref = member?.timezone_preference || 'venue';
    const userTz = member?.user_timezone || this.defaultUserTimezone;

    if (Array.isArray(info?.flights) && info.flights.length) {
      out.push('**Flights:**');
      for (const f of info.flights) {
        out.push(`${f.airline || ''} ${f.flight_number || ''}`.trim());
        out.push(`${f.departure_city} → ${f.arrival_city}`);
        // Times: if ISO timestamps provided, convert; else print raw
        if (f.departure_time) {
          out.push(`Departs: ${this.formatTimeDisplay(f.departure_time, f.departure_timezone || info.timezone, tzPref, userTz, true)}`);
        }
        if (f.arrival_time) {
          out.push(`Arrives: ${this.formatTimeDisplay(f.arrival_time, f.arrival_timezone || info.timezone, tzPref, userTz, true)}`);
        }
        if (f.confirmation && role !== 'crew') {
          out.push(`Confirmation: ${f.confirmation}`);
        }
        out.push(''); // blank line
      }
    }

    if (info?.hotel) {
      out.push('**Hotel:**');
      out.push(`${info.hotel.name}`);
      if (info.hotel.address) out.push(`${info.hotel.address}`);
      if (info.hotel.check_in_date) out.push(`Check-in: ${this.formatDateDisplay(info.hotel.check_in_date, info.timezone)}`);
      if (info.hotel.check_out_date) out.push(`Check-out: ${this.formatDateDisplay(info.hotel.check_out_date, info.timezone)}`);
      if (info.hotel.confirmation && role !== 'crew') out.push(`Confirmation: ${info.hotel.confirmation}`);
      out.push('');
    }

    if (info?.ground_transport) {
      out.push('**Ground Transportation:**');
      out.push(`${info.ground_transport.type}`);
      if (info.ground_transport.pickup_time) {
        const pickup = this.formatTimeDisplay(
          info.ground_transport.pickup_time,
          info.timezone,
          tzPref,
          userTz,
          true
        );
        out.push(`Pickup: ${pickup} at ${info.ground_transport.pickup_location || 'TBD'}`);
      }
    }

    return out.join('\n').trim();
  }

  formatSoundcheckInfo(data, member) {
    const out = [];
    const tzPref = member?.timezone_preference || 'venue';
    const userTz = member?.user_timezone || this.defaultUserTimezone;
    const venueTz = data?.timezone;

    if (Array.isArray(data?.schedule) && data.schedule.length) {
      for (const item of data.schedule) {
        const time = item.time
          ? this.formatTimeDisplay(item.time, venueTz, tzPref, userTz, true)
          : 'TBD';
        out.push(`${time} - ${item.activity}`);
        if (item.notes) out.push(`   ${item.notes}`);
      }
    }

    if (data?.technical_notes && (member?.role === 'musician' || member?.role === 'crew')) {
      out.push(`\n**Technical Notes:**\n${data.technical_notes}`);
    }

    return out.join('\n').trim();
  }

  // ===== Utilities =====

  buildShowFilters(entities = {}) {
    const filters = {};
    if (entities.city) filters.city = entities.city;
    if (entities.upcoming) filters.upcoming = true;
    if (entities.past) filters.past = true;
    if (entities.date_from) filters.date_from = entities.date_from;
    if (entities.date_to) filters.date_to = entities.date_to;
    return filters;
  }

  formatDateDisplay(dateIsoOrYmd, timeZone) {
    // Accept "YYYY-MM-DD" or full ISO; display as Weekday, Month Day, Year (TZ label if provided)
    const d = new Date(dateIsoOrYmd);
    if (Number.isNaN(d.getTime())) return String(dateIsoOrYmd);

    const opts = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
    if (timeZone) opts.timeZone = timeZone;

    const main = new Intl.DateTimeFormat('en-US', opts).format(d);
    return main;
  }

  /**
   * Format a time value according to user preference.
   * @param {string} isoOrLocal - ISO8601 timestamp (preferred) OR "YYYY-MM-DD HH:MM" OR "HH:MM"
   * @param {string} venueTimeZone - IANA TZ (e.g., "America/New_York")
   * @param {'venue'|'user_local'|'both'} preference
   * @param {string} userTimeZone - IANA TZ for user
   * @param {boolean} includeDate - include date when formatting (for travel/schedules)
   */
  formatTimeDisplay(isoOrLocal, venueTimeZone, preference = 'venue', userTimeZone = 'UTC', includeDate = false) {
    // Strategy:
    // - If value is ISO (contains 'T' and timezone info), treat as exact instant and format in TZs.
    // - Else, treat as local time in venue TZ without conversion (label with TZ). (Safer for CSV "HH:MM")
    const isLikelyISO = /T/.test(isoOrLocal) && /Z|[+\-]\d{2}:\d{2}$/.test(isoOrLocal);
    const fmOpts = includeDate
      ? { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
      : { hour: 'numeric', minute: '2-digit' };

    if (isLikelyISO) {
      const dt = new Date(isoOrLocal);
      if (Number.isNaN(dt.getTime())) return String(isoOrLocal);

      const venueStr = new Intl.DateTimeFormat('en-US', { ...fmOpts, timeZone: venueTimeZone }).format(dt);
      const userStr = new Intl.DateTimeFormat('en-US', { ...fmOpts, timeZone: userTimeZone }).format(dt);
      if (preference === 'venue') return `${venueStr} ${this.tzAbbr(venueTimeZone, dt)}`;
      if (preference === 'user_local') return `${userStr}`;
      return `${venueStr} ${this.tzAbbr(venueTimeZone, dt)} (${userStr} your time)`;
    }

    // Non-ISO (naive) → print as-is with TZ label if venue TZ known
    const label = venueTimeZone ? ` ${this.tzAbbr(venueTimeZone)}` : '';
    if (preference === 'venue' || preference === 'both') return `${isoOrLocal}${label}`;
    // user_local without a true instant → we can’t reliably convert; show raw
    return `${isoOrLocal}`;
  }

  tzAbbr(timeZone, when = new Date()) {
    try {
      // Extract short name like "EST" / "PDT"
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        timeZoneName: 'short',
        hour: '2-digit',
      }).formatToParts(when);
      const tz = parts.find((p) => p.type === 'timeZoneName')?.value;
      return tz ? tz.replace(/^GMT([+\-]\d+)?$/, 'GMT$1') : '';
    } catch {
      return '';
    }
  }

  extractResponseEntitiesFromShowList(shows) {
    const first = shows[0] || {};
    return {
      date: first.date,
      city: first.city,
      venue_id: first.venue_id,
    };
    // (Extend as needed)
  }

  extractResponseEntitiesFromVenue(v) {
    return { venue_id: v.venue_id || v.id, city: v?.address?.city };
  }

  extractResponseEntitiesFromSetlist(d) {
    return { show_id: d?.show_id, date: d?.date };
  }

  extractResponseEntitiesFromTravel(info) {
    return { date: info?.date || undefined, show_id: info?.show_id || undefined };
  }

  extractResponseEntitiesFromSoundcheck(data) {
    return { show_id: data?.show_id, date: data?.date };
  }

  // ===== Generic responses =====

  async generateGeneralResponse(message, _context, member) {
    const lower = (message || '').toLowerCase();
    const greetings = ['hello', 'hi', 'hey', 'good morning', 'good afternoon', 'good evening'];

    if (greetings.some((g) => lower.includes(g))) {
      const name = member?.full_name || member?.username || 'there';
      return {
        content: `Hey ${name}! I can help with shows, venues, setlists, travel, and schedules. What do you need?`,
        metadata: { type: 'greeting' },
      };
    }
    if (lower.includes('thank')) {
      return {
        content: 'You’re welcome! Need anything else?',
        metadata: { type: 'thanks' },
      };
    }
    return {
      content:
        'I can help you with show schedules, venue info, setlists, travel details, and soundcheck times. What would you like to know?',
      metadata: { type: 'help' },
    };
  }

  generateClarification(intentType, needed) {
    return {
      content: `I understand you’re asking about ${intentType.replace('_', ' ')}, but I need a ${needed} to proceed.`,
      metadata: { intent: intentType, needs_clarification: true },
    };
  }

  generateFallbackResponse(_message, intent) {
    return {
      content:
        'I understand what you’re asking, but I need a bit more detail. Can you add specifics (like city, date, or an ID)?',
      metadata: { intent: intent.intent_type, needs_clarification: true },
    };
  }
}

module.exports = TmAiEngine;

