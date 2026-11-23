// Text hygiene for names and written answers.
//
// Everything is cleaned (control characters, bidi tricks, combining-mark
// stacks, length). Slurs are always masked. Ordinary swearing is masked only
// when the host turns on the family filter.

const SLURS = [
  /\bn[i1!]gg+(?:a|er|ah|uh)s?\b/gi,
  /\bf[a@]gg?(?:ot|ots|y|s)?\b/gi,
  /\bretard(?:s|ed)?\b/gi,
  /\bk[i1]ke?s\b|\bkike\b/gi,
  /\bch[i1]nks?\b/gi,
  /\bsp[i1]cs?\b/gi,
  /\bwetbacks?\b/gi,
  /\btrann(?:y|ies)\b/gi,
  /\bdykes?\b/gi,
  /\bgooks?\b/gi,
  /\bcoons?\b/gi,
];

const PROFANITY = [
  /\b(?:mother)?f+u+c+k\w*/gi,
  /\bf+u+k+(?:ing|er|ed)?\b/gi,
  /\bwtf\b/gi,
  /\bs+h+i+t+\w*/gi,
  /\bbullshit\w*/gi,
  /\bb+i+t+c+h\w*/gi,
  /\bc+u+n+t\w*/gi,
  /\bdick(?:s|head|heads|ish)?\b/gi,
  /\bcocks?\b/gi,
  /\bpuss(?:y|ies)\b/gi,
  /\bass(?:es|hole|holes|hat|hats)?\b/gi,
  /\barse(?:hole|holes)?\b/gi,
  /\bbastards?\b/gi,
  /\bwhores?\b/gi,
  /\bsluts?\b/gi,
  /\bpiss\w*/gi,
  /\bwank\w*/gi,
  /\btwats?\b/gi,
  /\bbollocks\b/gi,
  /\bpricks?\b/gi,
  /\btits?\b|\btitties\b/gi,
  /\bboobs?\b/gi,
  /\bpenis(?:es)?\b/gi,
  /\bvaginas?\b/gi,
  /\bdildos?\b/gi,
  /\bporn\w*/gi,
  /\bsex(?:y|ual|ually)?\b/gi,
  /\bcrap(?:py|s)?\b/gi,
  /\bdamn(?:ed|it)?\b/gi,
  /\bgoddamn\w*/gi,
  /\bhorny\b/gi,
  /\bnazis?\b/gi,
];

function mask(word) {
  const chars = [...word];
  return chars[0] + "✱".repeat(Math.max(2, chars.length - 1));
}

function scrub(text, list) {
  let out = text;
  for (const re of list) out = out.replace(re, mask);
  return out;
}

export function cleanText(input, { max = 70, family = false } = {}) {
  let t = String(input ?? "")
    .normalize("NFC")
    // control chars, zero-width and bidi overrides
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, " ")
    // no towers of combining marks
    .replace(/(\p{M}{2})\p{M}+/gu, "$1")
    .replace(/\s+/g, " ")
    .trim();
  t = [...t].slice(0, max).join("").trim();
  t = scrub(t, SLURS);
  if (family) t = scrub(t, PROFANITY);
  return t;
}

export function cleanName(input, max = 12) {
  return cleanText(String(input ?? "").replace(/[{}<>]/g, ""), { max, family: true });
}
