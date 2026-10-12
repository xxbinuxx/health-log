/* Reads a Rocket Money transaction export and sorts it into three buckets plus peer payments.

   Rocket Money has already categorised and cleaned the merchant names, which is the tedious
   part. What it cannot do is tell a night out from a Steam purchase — both land in
   "Entertainment & Rec." — or know what a $75 Venmo was for. That is what this adds. */

export const SPEND_BUCKETS = {
  out: { name: "Going out", hint: "bars, restaurants, delivery, late rides" },
  home: { name: "At home", hint: "subscriptions, gaming, betting, streaming" },
  other: { name: "Everything else", hint: "groceries, bills, travel, shopping" },
  peer: { name: "Peer payments", hint: "Venmo, Zelle, Cash App" },
};

export const DEFAULT_SPEND_SETTINGS = {
  peerSocialMax: 150,     // a peer payment at or below this, on a day with drinks logged, counts as going out
  currency: "$",
};

const PEER = /\b(venmo|zelle|cash ?app|cashapp|paypal)\b/i;

// transfers to a brokerage or savings are not spending, whatever the category says
const NOT_SPEND = /\b(morgan stanley|mspbna|e\*?trade|etrade|schwab|fidelity|vanguard|robinhood|coinbase|wealthfront|betterment|acorns|ach (debit|credit) transfer)\b/i;

// merchants that are clearly a night out even when the category is vague
// payment-processor prefixes (TST*, SQ*, TOAST*) mark a restaurant or bar bill
const OUT_PROCESSOR = /(^|\s)(tst|sq|toast|tock)\s?\*/i;
const OUT_MERCHANT = /\b(bar|pub|tavern|lounge|cantina|izakaya|brewery|brewing|taproom|wine|cocktail|club|karaoke|noraebang|soju|makgeolli|pocha|restaurant|grill|kitchen|bistro|trattoria|osteria|ramen|sushi|bbq|taqueria|pizzeria|cafe|coffee|tock at|opentable|resy|stubhub|doordash|ubereats|uber ?eats|grubhub|seamless|caviar|postmates|menumvn)\b/i;

// things you pay for while sitting at home
const HOME_MERCHANT = /\b(netflix|hulu|spotify|disney|hbo|max\b|peacock|paramount|apple\.com|itunes|steam|playstation|xbox|nintendo|twitch|patreon|youtube ?premium|draftkings|fanduel|prizepicks|bet365|audible|kindle|openai|anthropic|claude|github|adobe|dropbox|icloud|google ?one|rocket money)\b/i;

const RIDE = /\b(uber|lyft|taxi|curb|revel)\b/i;

const ROCKET_TO_BUCKET = {
  "Dining & Drinks": "out",
  "Entertainment & Rec.": "out",        // streaming, gaming and betting are pulled back to "home" by name
  "Software & Tech": "home",
  "Groceries": "other",
  "Bills & Utilities": "other",
  "Auto & Transport": "other",          // late-night rides get promoted below
  "Travel & Vacation": "other",
  "Shopping": "other",
  "Personal Care": "other",
  "Health & Wellness": "other",
  "Home & Garden": "other",
  "Pets": "other",
  "Medical": "other",
  "Fees": "other",
  "Charitable Donations": "other",
  "Education": "other",
  "Business": "other",
  "Taxes": "other",
  "Gifts": "other",
};

// rows that are not spending at all
const SKIP_CATEGORIES = new Set(["Credit Card Payment", "Internal Transfers", "Income", "Investment", "Loan Payment", "Cash & Checks"]);

const num = (v) => {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/[^0-9.-]/g, ""));
  return isNaN(n) ? null : n;
};

function classify(row, text) {
  if (PEER.test(text)) return "peer";
  if (OUT_PROCESSOR.test(text) || OUT_MERCHANT.test(text)) return "out";
  if (HOME_MERCHANT.test(text)) return "home";
  if (RIDE.test(text)) return "ride";              // resolved against the time of day later
  return ROCKET_TO_BUCKET[row.Category] || "other";
}

/**
 * @param {Array<object>} rows  parsed CSV rows, keys as Rocket Money names them
 * @returns {{txns: Array, skipped: number, span: [string,string]|null, byCategory: object}}
 */
export function parseRocketMoney(rows) {
  const txns = [];
  let skipped = 0;
  const unknownCats = new Map();

  for (const r of rows) {
    const date = String(r.Date || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { skipped++; continue; }
    const amount = num(r.Amount);
    if (amount == null) { skipped++; continue; }
    if (String(r["Ignored From"] || "").trim()) { skipped++; continue; }

    const cat = r.Category || "Uncategorized";
    if (NOT_SPEND.test(`${r.Name} ${r.Description} ${r["Custom Name"]}`)) { skipped++; continue; }
    if (SKIP_CATEGORIES.has(cat) && !PEER.test(`${r.Name} ${r.Description}`)) { skipped++; continue; }
    if (!ROCKET_TO_BUCKET[cat] && cat !== "Uncategorized" && !SKIP_CATEGORIES.has(cat)) {
      unknownCats.set(cat, (unknownCats.get(cat) || 0) + 1);
    }

    const name = (r["Custom Name"] || r.Name || r.Description || "").trim();
    const text = `${name} ${r.Description || ""}`;
    const bucket = classify(r, text);

    // a stable id so re-importing the same export updates rather than duplicates
    const id = `rm-${date}-${Math.round(Math.abs(amount) * 100)}-${slug(name)}-${slug(r["Account Name"] || r["Institution Name"] || "")}`;

    txns.push({
      id, date,
      amount: Math.round(amount * 100) / 100,     // positive = money out, negative = money in
      name: name.slice(0, 60),
      category: cat,
      institution: r["Institution Name"] || "",
      account: r["Account Name"] || "",
      bucket,
    });
  }

  // collapse duplicate ids from genuinely identical same-day charges
  const seen = new Map();
  for (const t of txns) {
    let id = t.id, n = 1;
    while (seen.has(id)) id = `${t.id}-${++n}`;
    t.id = id; seen.set(id, t);
  }

  const dates = txns.map((t) => t.date).sort();
  return {
    txns, skipped,
    span: dates.length ? [dates[0], dates[dates.length - 1]] : null,
    unknownCategories: [...unknownCats.entries()].sort((a, b) => b[1] - a[1]),
  };
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 18);

/* Second pass, run against the health log rather than the CSV, because it needs to know
   which nights you actually went out.
   - a late ride (after 6pm or on a day you logged drinks) is going out, otherwise transport
   - a peer payment at or below the threshold on a day with drinks logged counts as going out
   - everything else keeps the bucket the CSV gave it */
export function resolveBuckets(txns, dailyGet, settings) {
  const max = settings?.peerSocialMax ?? DEFAULT_SPEND_SETTINGS.peerSocialMax;
  return txns.map((t) => {
    const day = dailyGet ? dailyGet(t.date) : null;
    const drinking = !!day && (day.alc > 0 || day.thcMg > 0 || day.thcSessions > 0);
    if (t.bucket === "ride") return { ...t, bucket: drinking ? "out" : "other" };
    if (t.bucket === "peer" && t.amount > 0 && t.amount <= max && drinking) return { ...t, bucket: "out", viaRule: true };
    return t;
  });
}

/* Totals per day, so spend can sit beside Degen on the same axis. */
export function spendByDay(txns) {
  const m = new Map();
  for (const t of txns) {
    if (!m.has(t.date)) m.set(t.date, { date: t.date, out: 0, home: 0, other: 0, peerOut: 0, peerIn: 0, n: 0 });
    const x = m.get(t.date);
    x.n++;
    if (t.bucket === "peer") { if (t.amount > 0) x.peerOut += t.amount; else x.peerIn += -t.amount; }
    else if (t.amount > 0) x[t.bucket] += t.amount;
    else x[t.bucket] -= -t.amount;                 // refunds reduce the bucket
  }
  for (const x of m.values()) {
    x.net = Math.round((x.out - x.peerIn) * 100) / 100;   // what the night cost after friends paid you back
    for (const k of ["out", "home", "other", "peerOut", "peerIn"]) x[k] = Math.round(x[k] * 100) / 100;
  }
  return m;
}
