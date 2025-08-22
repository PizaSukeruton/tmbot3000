const { normalize } = require("./normalizer");
const { lookupExact, lookupInSentence } = require("./termIndex");
// backend/services/tmIntentMatcher.js
// Handles mapping raw text to structured intents.

const { cleanName } = require('../utils/textUtils');

class TmIntentMatcher {
  /**
   * Match a user’s message to an intent.
   * @param {string} content - User message
   * @param {object} options - Context (optional)
   * @param {object} member - Member metadata (optional)
   * @returns {Promise<{ intent_type: string|null, confidence: number, entities: object }>}
   */
  async matchIntent(content, options = {}, member = {}) {
    const q = cleanName(content).toLowerCase();

    // Default
    let intent = { intent_type: null, confidence: 0, entities: {} };
  // === fast path: industry term lookup (deterministic) ===
  const _input = (arguments[0] ?? "");
  const _norm  = normalize(_input);
  const _hit   = lookupExact(_norm) || lookupInSentence(_norm);
  if (_hit) {
    return { intent_type: "term_lookup", term_id: _hit.term_id, entities: {} };
  }

    try {
      // === SHOW / SCHEDULE INTENTS ===
      if (/schedule|showtime|what time.*show/.test(q)) {
        intent = { intent_type: 'show_schedule', confidence: 0.95, entities: {} };

      } else if (/load in|load-out|sound.?check|curfew|setlist/.test(q)) {
        intent = { intent_type: 'production', confidence: 0.9, entities: {} };

      // === TRAVEL INTENTS ===
      } else if (/flight|airport|travel|hotel|check[- ]?in|check[- ]?out/.test(q)) {
        intent = { intent_type: 'travel', confidence: 0.9, entities: {} };

      // === MERCH INTENTS ===
      } else if (/merch|merchandise|t[- ]?shirts?|hoodies?|seller|stand/.test(q)) {
        intent = { intent_type: 'merch', confidence: 0.9, entities: {} };

      // === FINANCIAL INTENTS ===
      } else if (/budget|costs?|expenses?|financial|accounting|invoice|payment/.test(q)) {
        intent = { intent_type: 'financial', confidence: 0.9, entities: {} };

      // === MEDIA / PRESS INTENTS ===
      } else if (/press|media|interview|photographer|photo\s?pass|press commitments?/.test(q)) {
        intent = { intent_type: 'media', confidence: 0.9, entities: {} };

      // === HELP INTENT ===
      } else if (/^(help|what can i ask|what can you do)/.test(q)) {
        intent = { intent_type: 'help', confidence: 0.99, entities: {} };

      }
    } catch (e) {
      // Fail safe → return no-intent instead of crashing
      intent = {
        intent_type: null,
        confidence: 0,
        entities: {},
        original_query: content,
        error: String(e?.message || e),
      };
    }

    return intent;
  }
}

module.exports = new TmIntentMatcher();

