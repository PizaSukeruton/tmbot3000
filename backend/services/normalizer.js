// backend/services/normalizer.js
const DASHES = /[\u2010\u2011\u2012\u2013\u2014\u2212]/g;
const FANCY_QUOTES = /[\u2018\u2019\u201A\u201B\u2032\u2035]/g;
const FANCY_DQUOTES = /[\u201C\u201D\u201E\u201F\u2033\u2036]/g;
const PUNCT_TO_STRIP = /[.,;:!?"'(){}\[\]`]/g;
const MULTISPACE = /\s+/g;
const DOTS_IN_ACRONYM = /\b([a-z])\.(?=[a-z])/gi;

const SUBS = [
  { rx: /\bf\.o\.h\b/gi, to: 'foh' },
  { rx: /\bf-o-h\b/gi,   to: 'foh' },
  { rx: /\bb\.o\.h\b/gi, to: 'boh' },
  { rx: /\bb-o-h\b/gi,   to: 'boh' },
  { rx: /\bload-?in\b/gi,   to: 'load in' },
  { rx: /\bload-?out\b/gi,  to: 'load out' },
  { rx: /\bset-?list\b/gi,  to: 'set list' },
  { rx: /\bon-?stage time\b/gi, to: 'on stage time' },
];

function normalize(text) {
  if (text == null) return '';
  let s = String(text).normalize('NFKC');
  s = s.replace(FANCY_QUOTES, "'").replace(FANCY_DQUOTES, '"').replace(DASHES, '-');
  s = s.replace(PUNCT_TO_STRIP, '');
  s = s.replace(/[-_]/g, ' ');
  s = s.replace(DOTS_IN_ACRONYM, '$1');
  s = s.trim().replace(MULTISPACE, ' ').toLowerCase();
  for (const { rx, to } of SUBS) s = s.replace(rx, to);
  return s.trim().replace(MULTISPACE, ' ');
}

function tokenLen(normalized) {
  return normalized ? normalized.split(' ').filter(Boolean).length : 0;
}

module.exports = { normalize, tokenLen };

