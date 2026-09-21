// Reads the substance notes you keep in a text file and turns them into log entries.
// Nothing is guessed silently: anything uncertain comes back flagged so you can look before importing.

const VAGUE = [
  [/\b(shit ?ton|hella|tons? of|loads? of|lots? of)\b/, 5],
  [/\b(several|few)\b/, 3],
  [/\b(couple|a couple)\b/, 2],
];

// unit "mg" uses the mg figure; everything else counts items.
// per = how much one of the thing is worth. mgDefault = what to assume when no mg is written.
const RULES = [
  // caffeine
  { re: /\bcaffeine zyn|caffeine pouch\b/, kind: "caffeine", unit: "mg", per: 40, guess: true },
  { re: /\bespresso\b/, kind: "caffeine", unit: "mg", per: 64 },
  { re: /\bcold ?brew\b/, kind: "caffeine", unit: "mg", per: 200 },
  { re: /\b(iced )?americano\b/, kind: "caffeine", unit: "mg", per: 128 },
  { re: /\bmatcha\b/, kind: "caffeine", unit: "mg", per: 70 },
  { re: /\b(coffee|drip)\b/, kind: "caffeine", unit: "mg", per: 95 },
  { re: /\b(tea)\b/, kind: "caffeine", unit: "mg", per: 47 },

  // cannabis (mg where stated, sessions otherwise)
  { re: /\b(edibles?|mochis?|gumm(y|ies))\b/, kind: "cannabis", unit: "mg", mgDefault: 5, guess: true },
  { re: /\b(of{2,3}ields?|off ?fields?)\b/, kind: "cannabis", unit: "mg", mgDefault: 3, guess: true },
  { re: /\b(joints?|prerolls?|pre-rolls?|spliffs?)\b/, kind: "cannabis", unit: "sessions", per: 1 },
  { re: /\b(weed|thc) ?(vape|pen)|vape pen\b/, kind: "cannabis", unit: "sessions", per: 1 },
  { re: /\b(smoke|bowl|bong|dab|hits?|puffs?)\b/, kind: "cannabis", unit: "sessions", per: 1, guess: true },

  // nicotine
  { re: /\b(zyns?|zynothy|pouch(es)?|nicotine|lucys?)\b/, kind: "nicotine", unit: "mg", mgDefault: 6, guess: true },
  { re: /\b(cigarettes?|cigs?|darts?)\b/, kind: "nicotine", unit: "mg", per: 1.5 },

  // stimulant
  { re: /\b(add(y|erall)|eddy|vyvanse|juicer)\b/, kind: "stimulant", unit: "mg", mgDefault: 5, guess: true },

  // alcohol, in standard drinks
  { re: /\bsoju\b.*\bbottle|bottle\b.*\bsoju\b/, kind: "alcohol", unit: "drinks", per: 4 },
  { re: /\b(somaek|소맥|꿀주)\b/, kind: "alcohol", unit: "drinks", per: 1 },
  { re: /\bsoju\b/, kind: "alcohol", unit: "drinks", per: 1 },
  { re: /\b(makk?eoll?i|makgeolli|막걸리)\b/, kind: "alcohol", unit: "drinks", per: 1 },
  { re: /\b(sake|baiju|baijiu)\b/, kind: "alcohol", unit: "drinks", per: 1 },
  { re: /\bjaeger ?bomb\b/, kind: "alcohol", unit: "drinks", per: 1.5 },
  { re: /\b(cocktails?|gin ?(and|&) ?tonics?|g ?& ?t|negronis?|old fashioned|margaritas?|spritz)\b/, kind: "alcohol", unit: "drinks", per: 1.5 },
  { re: /\bshots?\b/, kind: "alcohol", unit: "drinks", per: 1 },
  { re: /\b(whiske?y|tequilas?|teq|vodka|rum|gin|jaeger|mezcal)\b/, kind: "alcohol", unit: "drinks", per: 1 },
  { re: /\b(wine|prosecco|champagne)\b/, kind: "alcohol", unit: "drinks", per: 1 },
  { re: /\b(guin{1,2}es{1,2}e?s?|lagers?|ipas?|pilsners?|drafts?|tall ?boys?|shotguns?|beers?|terras?|cass|hite|tsingtao|asahi|sapporo)\b/, kind: "alcohol", unit: "drinks", per: 1 },
  { re: /\b(seltzers?|white ?claws?|claws?|lunars?|trulys?|high ?noons?)\b/, kind: "alcohol", unit: "drinks", per: 1 },
];

// lines that are notes to yourself rather than something consumed
const IGNORE = /^(clean|substance free|none|nothing|water|waters?|\d+\s*waters?|overall\b|felt\b|ran\b|i \b|maybe\b|.*\bmiles?\b)/;

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 24);

function parseDateHeader(line) {
  // "6/15:", "8/31", "9/12: medical tent at techno show"
  const m = line.match(/^\s*(\d{1,2})\s*\/\s*(\d{1,2})(?:\s*\/\s*(\d{2,4}))?\s*(?::\s*|\s+|$)(.*)$/);
  if (!m) return null;
  const month = Number(m[1]), day = Number(m[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  let year = m[3] ? Number(m[3]) : null;
  if (year && year < 100) year += 2000;
  return { month, day, year, note: (m[4] || "").trim() };
}

function amountsFrom(text) {
  let s = ` ${text.toLowerCase()} `;
  s = s.replace(/\b\d{1,2}:\d{2}\s*(am|pm)?/g, " ");        // "8:30 addy" is a time, not eight of them
  const grams = /\b\d+(\.\d+)?\s*g(rams?)?\b/.test(s);
  if (grams) s = s.replace(/\b\d+(\.\d+)?\s*g(rams?)?\b/g, " ");
  const mgMatch = s.match(/(\d+(?:\.\d+)?)\s*mg\b/);
  const mg = mgMatch ? Number(mgMatch[1]) : null;
  if (mgMatch) s = s.replace(mgMatch[0], " ");

  const frac = s.match(/^\s*(\d+)\s*\/\s*(\d+)\b/);
  if (frac) return { mg, count: Number(frac[1]) / Number(frac[2]), vague: false };

  const range = s.match(/^\s*(\d+)\s*-\s*(\d+)\b/);
  if (range) return { mg, count: Number(range[1]), vague: true };

  const lead = s.match(/^\s*(\d+(?:\.\d+)?)\s*\+?/);
  if (lead) return { mg, count: Number(lead[1]), vague: false };

  for (const [re, n] of VAGUE) if (re.test(s)) return { mg, count: n, vague: true };
  if (grams) return { mg, count: 1, vague: true };
  if (/\bhalf|1\/2\b/.test(s) || /^\s*\./.test(text)) return { mg, count: 0.5, vague: false };
  return { mg, count: 1, vague: false };
}

/**
 * @param {string} text  the pasted notes
 * @param {string} today YYYY-MM-DD, used to work out which year a "6/15" belongs to
 */
export function parseNotes(text, today) {
  const [ty, tm, td] = today.split("-").map(Number);
  const lines = String(text).split(/\r?\n/);
  const entries = [];
  const dayNotes = [];
  const unread = [];
  let cur = null;          // { date, seen: Map }
  let lastMonth = null, year = ty;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const head = parseDateHeader(line);
    if (head && !/^-/.test(line)) {
      if (head.year) year = head.year;
      else {
        // months run forward through the file; a step backwards means a new year started
        if (lastMonth != null && head.month < lastMonth - 6) year += 1;
        else if (lastMonth != null && head.month > lastMonth + 6) year -= 1;
        // never land in the future
        if (head.month > tm || (head.month === tm && head.day > td)) { if (year === ty) year = ty - 1; }
      }
      lastMonth = head.month;
      const date = `${year}-${String(head.month).padStart(2, "0")}-${String(head.day).padStart(2, "0")}`;
      cur = { date, seen: new Map() };
      if (head.note) dayNotes.push({ date, note: head.note });
      continue;
    }

    const bare = !/^[-•*]/.test(line);
    if (bare && (!cur || line.length > 60 || !RULES.some((r) => r.re.test(line.toLowerCase())))) {
      if (cur) unread.push({ date: cur.date, text: line, why: "not a list item" });
      continue;
    }
    const body = line.replace(/^[-•*]\s*/, "").trim();
    if (!body) continue;
    if (!cur) { unread.push({ date: "?", text: body, why: "no date above it" }); continue; }
    if (IGNORE.test(body.toLowerCase())) continue;

    const rule = RULES.find((r) => r.re.test(body.toLowerCase()));
    if (!rule) { unread.push({ date: cur.date, text: body, why: "nothing recognised" }); continue; }

    const { mg, count, vague } = amountsFrom(body);
    let amount, unit = rule.unit, guessed = !!rule.guess && !mg;
    if (unit === "mg") {
      const per = mg ?? rule.mgDefault ?? rule.per;
      if (per == null) { unread.push({ date: cur.date, text: body, why: "no amount" }); continue; }
      // "16 mg zyn" is a total; "3 6mg zyns" is three of them
      amount = mg && !/^\s*\d/.test(body.replace(/^\s*[-•*]\s*/, "")) ? per : per * count;
      if (mg && /^\s*\d+(\.\d+)?\s*mg/i.test(body)) amount = mg;   // leading "5mg edible"
    } else {
      amount = (rule.per ?? 1) * count;
    }
    amount = Math.round(amount * 100) / 100;
    if (!amount) continue;

    const key = slug(body);
    const nth = (cur.seen.get(key) ?? 0) + 1;
    cur.seen.set(key, nth);

    entries.push({
      id: `notes-${cur.date}-${key}-${nth}`,
      ts: new Date(`${cur.date}T12:00:00`).toISOString(),
      kind: rule.kind,
      label: body.slice(0, 60),
      amount,
      unit,
      flagged: guessed || vague,
    });
  }

  return { entries, dayNotes, unread };
}
