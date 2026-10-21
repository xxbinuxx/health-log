/* The races worth planning a year around, and how you actually get into them.

   These are not scraped. The big races are not on any public race API, their entry is
   lotteries and qualifying windows, and that information changes slowly enough to be
   worth writing down. Everything here is a snapshot: verify against the official site
   before acting, which is why every entry carries a link.

   `window` is the registration or lottery window as a month-day range. `kind` matches
   RACE_TYPES in plan.js. `entry` says how you actually get in. */

export const MAJORS = [
  // ---- New York ----
  { id: "nyc-marathon", name: "TCS New York City Marathon", kind: "marathon", city: "New York", month: 11,
    entry: "lottery", window: ["02-01", "03-15"], url: "https://www.nyrr.org/tcsnycmarathon",
    note: "Drawing is in March. Guaranteed entry via NYRR 9+1 (nine qualifying races plus one volunteer shift in the prior year), time qualification, or charity." },
  { id: "nyc-half", name: "United Airlines NYC Half", kind: "half", city: "New York", month: 3,
    entry: "lottery", window: ["10-15", "11-15"], url: "https://www.nyrr.org/races/uanychalf",
    note: "Autumn drawing for a March race. 9+1 and time qualification also apply." },
  { id: "brooklyn-half", name: "RBC Brooklyn Half", kind: "half", city: "Brooklyn", month: 5,
    entry: "first come", window: ["01-15", "02-15"], url: "https://www.nyrr.org/races/rbcbrooklynhalf",
    note: "Sells out in minutes. Be at a computer the moment registration opens." },
  { id: "nyrr-staten-island", name: "NYRR Staten Island Half", kind: "half", city: "Staten Island", month: 10,
    entry: "first come", window: ["06-01", "09-15"], url: "https://www.nyrr.org/",
    note: "Counts toward 9+1." },
  { id: "fifth-ave-mile", name: "NYRR Fifth Avenue Mile", kind: "mile", city: "New York", month: 9,
    entry: "first come", window: ["06-15", "09-01"], url: "https://www.nyrr.org/",
    note: "A genuinely fast mile, and a cheap way to get a current speed benchmark." },

  // ---- the other majors ----
  { id: "boston", name: "Boston Marathon", kind: "marathon", city: "Boston", month: 4,
    entry: "qualify", window: ["09-01", "09-15"], url: "https://www.baa.org/races/boston-marathon",
    note: "Qualifying window opens roughly 18 months out. Meeting the standard rarely suffices — the cut-off moves each year." },
  { id: "chicago", name: "Bank of America Chicago Marathon", kind: "marathon", city: "Chicago", month: 10,
    entry: "lottery", window: ["10-15", "11-30"], url: "https://www.chicagomarathon.com/",
    note: "Drawing for the following October. Time qualification bypasses the lottery." },
  { id: "london", name: "TCS London Marathon", kind: "marathon", city: "London", month: 4,
    entry: "ballot", window: ["04-20", "04-30"], url: "https://www.tcslondonmarathon.com/",
    note: "Ballot opens in the week of the race itself, for the following year." },
  { id: "berlin", name: "BMW Berlin Marathon", kind: "marathon", city: "Berlin", month: 9,
    entry: "lottery", window: ["09-15", "10-15"], url: "https://www.bmw-berlin-marathon.com/",
    note: "The fastest course of the majors. Lottery about a year ahead." },
  { id: "tokyo", name: "Tokyo Marathon", kind: "marathon", city: "Tokyo", month: 3,
    entry: "lottery", window: ["08-01", "08-31"], url: "https://www.marathon.tokyo/en/",
    note: "Lottery in August for the following March." },
  { id: "sydney", name: "TCS Sydney Marathon", kind: "marathon", city: "Sydney", month: 8,
    entry: "first come", window: ["10-01", "02-28"], url: "https://www.sydneymarathon.org/",
    note: "The seventh major, added in 2025." },

  // ---- other US races worth knowing ----
  { id: "cim", name: "California International Marathon", kind: "marathon", city: "Sacramento", month: 12,
    entry: "first come", window: ["01-01", "11-01"], url: "https://runsra.org/california-international-marathon/",
    note: "Net downhill, a popular Boston qualifier. Price rises in steps, so entering early is cheaper." },
  { id: "philly", name: "Philadelphia Marathon", kind: "marathon", city: "Philadelphia", month: 11,
    entry: "first come", window: ["01-15", "10-15"], url: "https://www.philadelphiamarathon.com/", note: "" },
  { id: "marine-corps", name: "Marine Corps Marathon", kind: "marathon", city: "Washington DC", month: 10,
    entry: "lottery", window: ["02-15", "03-15"], url: "https://www.marinemarathon.com/", note: "" },
  { id: "jersey-city-half", name: "Jersey City Half", kind: "half", city: "Jersey City", month: 9,
    entry: "first come", window: ["02-01", "08-15"], url: "https://www.njmarathon.org/", note: "A PATH ride away." },
];

/* Where a registration window sits relative to today, as something you can act on. */
export function windowStatus(major, todayKey) {
  if (!major.window) return { state: "unknown" };
  const [y, m, d] = todayKey.split("-").map(Number);
  const today = new Date(y, m - 1, d);
  const mk = (md, year) => { const [mm, dd] = md.split("-").map(Number); return new Date(year, mm - 1, dd); };

  // the window may straddle the new year, so check this year and next
  for (const yr of [y - 1, y, y + 1]) {
    let open = mk(major.window[0], yr);
    let close = mk(major.window[1], yr);
    if (close < open) close = mk(major.window[1], yr + 1);     // straddles December
    const dayMs = 864e5;
    if (today >= open && today <= close) {
      return { state: "open", closesIn: Math.ceil((close - today) / dayMs), opensOn: open, closesOn: close };
    }
    if (today < open && (open - today) / dayMs <= 120) {
      return { state: "soon", opensIn: Math.ceil((open - today) / dayMs), opensOn: open, closesOn: close };
    }
  }
  return { state: "closed" };
}

/* The ones worth telling someone about today. */
export function actionable(todayKey, { withinDays = 45 } = {}) {
  const out = [];
  for (const m of MAJORS) {
    const s = windowStatus(m, todayKey);
    if (s.state === "open") out.push({ ...m, status: s, urgency: s.closesIn <= 7 ? "closing" : "open" });
    else if (s.state === "soon" && s.opensIn <= withinDays) out.push({ ...m, status: s, urgency: "upcoming" });
  }
  const rank = { closing: 0, open: 1, upcoming: 2 };
  return out.sort((a, b) => rank[a.urgency] - rank[b.urgency]
    || (a.status.closesIn ?? a.status.opensIn) - (b.status.closesIn ?? b.status.opensIn));
}
