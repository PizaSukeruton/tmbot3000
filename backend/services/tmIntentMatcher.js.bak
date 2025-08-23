const { normalize } = require("./normalizer");
const { lookupExact, lookupInSentence } = require("./termIndex");
const { cleanName } = require('../utils/textUtils');

class TmIntentMatcher {
  async matchIntent(content, options = {}, member = {}) {
    const raw = String(content || "");
    const q = cleanName(raw).toLowerCase();

    let intent = { intent_type: null, confidence: 0, entities: {} };

    const normQ = normalize(q);
    let hit = lookupExact(normQ) || lookupInSentence(normQ);

    if (!hit) {
      const m = q.match(/^(what is|what's|define|meaning of)\s+(.+)$/i);
      if (m && m[2]) {
        const cand = normalize(m[2]);
        hit = lookupExact(cand) || lookupInSentence(cand);
      }
    }

    if (hit) {
      return {
        intent_type: "term_lookup",
        confidence: 0.99,
        entities: { term_id: hit.term_id, term: hit.term || hit.key || null }
      };
    }

    try {
      if (/schedule|showtime|what time.*show|(^|\s)show(s)?(\s|$)/.test(q)) {
        intent = { intent_type: 'show_schedule', confidence: 0.95, entities: {} };
      } else if (/load in|load-out|sound.?check|curfew|setlist/.test(q)) {
        intent = { intent_type: 'production', confidence: 0.9, entities: {} };
      } else if (/flight|airport|travel|hotel|check[- ]?in|check[- ]?out/.test(q)) {
        intent = { intent_type: 'travel', confidence: 0.9, entities: {} };
      } else if (/merch|merchandise|t[- ]?shirts?|hoodies?|seller|stand/.test(q)) {
        intent = { intent_type: 'merch', confidence: 0.9, entities: {} };
      } else if (/budget|costs?|expenses?|financial|accounting|invoice|payment/.test(q)) {
        intent = { intent_type: 'financial', confidence: 0.9, entities: {} };
      } else if (/press|media|interview|photographer|photo\s?pass|press commitments?/.test(q)) {
        intent = { intent_type: 'media', confidence: 0.9, entities: {} };
      } else if (/^(help|what can i ask|what can you do)/.test(q)) {
        intent = { intent_type: 'help', confidence: 0.99, entities: {} };
      }
    } catch (e) {
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
