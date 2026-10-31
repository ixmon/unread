// Port of data/na/tokfix/tokfix.py + atfutil.to_cdli_ascii + atfcodec (decode/_esc).
// Used by translator-worker.js for B2c. Keep in sync with the Python sources.
// Parity: node --experimental-default-type=module web/js/tokfix.parity.mjs

export const PREFIX = "translate Akkadian to English: ";

const EXTRA = {
  "\u3008": "<", "\u3009": ">", "\u011D": "j", "\u011C": "J", "\u208D": "(", "\u208E": ")"
};

const CHAR = {
  "\u0161": "sz",
  "\u0160": "SZ",
  "\u1e63": "s,",
  "\u1e62": "S,",
  "\u1e6d": "t,",
  "\u1e6c": "T,",
  "\u1e2b": "h",
  "\u1e2a": "H",
  "\u014b": "j",
  "\u014a": "J",
  "\u015b": "s'",
  "\u015a": "S'",
  "\u02be": "'",
  "\u02bf": "'",
  "\u2019": "'",
  "\u011d": "j",
  "\u011c": "J",
  "\u1e25": "h",
  "\u1e24": "H"
};

const ACC = {
  "\u00e1": ["a", "2"],
  "\u00e0": ["a", "3"],
  "\u00e9": ["e", "2"],
  "\u00e8": ["e", "3"],
  "\u00ed": ["i", "2"],
  "\u00ec": ["i", "3"],
  "\u00fa": ["u", "2"],
  "\u00f9": ["u", "3"],
  "\u00c1": ["A", "2"],
  "\u00c0": ["A", "3"],
  "\u00c9": ["E", "2"],
  "\u00c8": ["E", "3"],
  "\u00cd": ["I", "2"],
  "\u00cc": ["I", "3"],
  "\u00da": ["U", "2"],
  "\u00d9": ["U", "3"]
};

const SUBS = {
  "\u2080": "0",
  "\u2081": "1",
  "\u2082": "2",
  "\u2083": "3",
  "\u2084": "4",
  "\u2085": "5",
  "\u2086": "6",
  "\u2087": "7",
  "\u2088": "8",
  "\u2089": "9",
  "\u2093": "x"
};

// Same class as atfutil._SIGN (half-brackets U+2E22 / U+2E23)
const SIGN_RE = /[^\s\-.{}\[\]()<>#!?*+:|/&\u2E22\u2E23]+/g;

const MARKS = {
  "\u030c": "cv",
  "\u0304": "mc",
  "\u0302": "cf",
  "\u0301": "ac",
  "\u0300": "gr",
  "\u0323": "db",
  "\u032e": "bb",
  "\u0308": "um",
  "\u0303": "td",
  "\u0307": "da",
  "\u0327": "ce",
  "\u0331": "lb",
  "\u0306": "br"
};
const SPECIAL = { "{": "ob", "}": "cb", "\u02BE": "al", "\u02BF": "ay" };
const RMARKS = Object.fromEntries([
  ...Object.entries(MARKS).map(([k, v]) => [v, k]),
  ...Object.entries(SPECIAL).map(([k, v]) => [v, k]),
]);

const SAFE_ATFCODEC = new Set([" ", "!", "\"", "#", "$", "%", "'", "(", ")", "*", "+", ",", "-", ".", "/", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", ":", ";", "=", ">", "?", "@", "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z", "[", "]", "_", "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z", "|"]);
const SAFE = new Set([" ", "!", "\"", "#", "$", "%", "&", "'", "(", ")", "*", "+", ",", "-", ".", "/", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", ":", ";", "<", "=", ">", "?", "@", "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z", "[", "\\", "]", "_", "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z", "{", "|", "}", "\u00ab", "\u00ad", "\u00ae", "\u00b0", "\u00bb", "\u00c9", "\u00ce", "\u00dc", "\u00df", "\u00e0", "\u00e1", "\u00e2", "\u00e4", "\u00e7", "\u00e8", "\u00e9", "\u00ea", "\u00ee", "\u00f4", "\u00f6", "\u00f9", "\u00fb", "\u00fc", "\u0101", "\u0113", "\u011d", "\u012b", "\u014b", "\u015f", "\u0160", "\u0161", "\u0163", "\u016b", "\u021b", "\u02be", "\u02bf", "\u03b1", "\u03b2", "\u03b3", "\u03b7", "\u1e2a", "\u1e2b", "\u1e62", "\u1e63", "\u1e6c", "\u1e6d", "\u1e6f", "\u2013", "\u2014", "\u2018", "\u2019", "\u201c", "\u201d", "\u201e", "\u2022", "\u2032"]);

function accSign(sign) {
  let idx = "";
  let out = "";
  for (const ch of sign) {
    if (Object.prototype.hasOwnProperty.call(ACC, ch)) {
      out += ACC[ch][0];
      idx = ACC[ch][1];
    } else {
      out += ch;
    }
  }
  return out + idx;
}

export function toCdliAscii(atf) {
  if (!atf) return atf;
  let s = atf.normalize("NFC");
  let hasAcc = false;
  for (const c of s) {
    if (Object.prototype.hasOwnProperty.call(ACC, c)) { hasAcc = true; break; }
  }
  if (hasAcc) s = s.replace(SIGN_RE, accSign);
  let out = "";
  for (const c of s) out += Object.prototype.hasOwnProperty.call(CHAR, c) ? CHAR[c] : (SUBS[c] ?? c);
  return out.replace(/\u2E22/g, "").replace(/\u2E23/g, "#").replace(/##/g, "#");
}

export function normalizeAtf(s) {
  if (!s) return s || "";
  s = s.normalize("NFC");
  let out = "";
  for (const c of s) out += Object.prototype.hasOwnProperty.call(EXTRA, c) ? EXTRA[c] : c;
  return toCdliAscii(out);
}

function escChar(ch) {
  if (SAFE_ATFCODEC.has(ch)) return ch;
  if (ch === "&") return "&&";
  if (Object.prototype.hasOwnProperty.call(SPECIAL, ch)) return "&" + SPECIAL[ch];
  if (ch === "\n" || ch === "\t") return " ";
  const d = ch.normalize("NFD");
  if (
    d.length > 1 &&
    SAFE_ATFCODEC.has(d[0]) &&
    [...d.slice(1)].every((m) => Object.prototype.hasOwnProperty.call(MARKS, m))
  ) {
    return d[0] + [...d.slice(1)].map((m) => "&" + MARKS[m]).join("");
  }
  const cp = ch.codePointAt(0);
  return cp < 0x10000
    ? "&u" + cp.toString(16).padStart(4, "0")
    : "&U" + cp.toString(16).padStart(6, "0");
}

function escapeStr(s) {
  let out = "";
  for (const ch of s) {
    if (ch === "&") out += "&&";
    else if (SAFE.has(ch)) out += ch;
    else if (ch === "\n" || ch === "\t" || ch === "\r") out += " ";
    else {
      const e = escChar(ch);
      out += e === ch ? "&u" + ch.codePointAt(0).toString(16).padStart(4, "0") : e;
    }
  }
  return out;
}

export function encodeTgt(s) {
  return escapeStr((s || "").normalize("NFC"));
}

export function encodeAtf(s) {
  return escapeStr(normalizeAtf(s));
}

export function encodeInput(inp) {
  inp = inp || "";
  const i = inp.indexOf(" =G= ");
  if (i >= 0) return encodeAtf(inp.slice(0, i)) + " =G= " + encodeTgt(inp.slice(i + 5));
  return encodeAtf(inp);
}

export function modelInput(inp) {
  return PREFIX + encodeInput(inp);
}

const DECODE_RE = /&(&|u[0-9a-f]{4}|U[0-9a-f]{6}|[a-z]{2})/g;

export function decode(s) {
  const out = String(s).replace(DECODE_RE, (_m, g) => {
    if (g === "&") return "&";
    if (g.length > 2) return String.fromCodePoint(parseInt(g.slice(1), 16));
    return Object.prototype.hasOwnProperty.call(RMARKS, g) ? RMARKS[g] : "&" + g;
  });
  return out.normalize("NFC");
}
