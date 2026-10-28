/* When entry OPENS. That is the date that matters.

   Closing dates are mostly beside the point: the races worth entering either sell out
   in minutes or run a lottery with a fixed window. Miss the opening and you wait a year.

   Each entry records:
     opens      month-day the window opens, plus the local time where one is published
     confidence "confirmed" — published by the organiser for a specific year
                "typical"   — the pattern from recent years; verify before relying on it
     speed      how fast it goes: "minutes", "hours", "days", "weeks", "lottery"
     lead       roughly how far ahead of the race the window opens, for context

   Nothing here is scraped. Organisers publish these on their own pages in their own
   formats and the dates shift a little each year, so this is a maintained list with a
   link on every row. Check the link before planning around a date. */

export const RACE_WINDOWS = [
  // ---- New York Road Runners ----
  {
    id: "nyrr-q1", name: "NYRR races, January–March", kind: "various", city: "New York",
    opens: "10-05", time: "12:00 ET", closes: "12-31", confidence: "typical", speed: "days",
    lead: "about 3 months", entry: "first come",
    url: "https://www.nyrr.org/run/race-calendar/race-registration-launch-timeline",
    note: "NYRR releases a quarter at a time, always at noon ET, across three days: Member Plus and above first, then all members, then the public two days later. The public date is the one to diarise." },
  {
    id: "nyrr-q2", name: "NYRR races, April–June", kind: "various", city: "New York",
    opens: "01-06", time: "12:00 ET", closes: "03-31", confidence: "typical", speed: "days",
    lead: "about 3 months", entry: "first come",
    url: "https://www.nyrr.org/run/race-calendar/race-registration-launch-timeline",
    note: "The most contested quarter of the year." },
  {
    id: "nyrr-q3", name: "NYRR races, July–September", kind: "various", city: "New York",
    opens: "04-06", time: "12:00 ET", closes: "06-30", confidence: "typical", speed: "days",
    lead: "about 3 months", entry: "first come",
    url: "https://www.nyrr.org/run/race-calendar/race-registration-launch-timeline", note: "" },
  {
    id: "nyrr-q4", name: "NYRR races, October–December", kind: "various", city: "New York",
    opens: "06-08", time: "12:00 ET", closes: "09-30", confidence: "confirmed", speed: "days",
    lead: "about 4 months", entry: "first come",
    url: "https://www.nyrr.org/run/race-calendar/race-registration-launch-timeline",
    note: "In 2026 this batch opened on 8, 9 and 11 June at noon ET, with public access on the 11th. Staten Island Half and Ted Corbitt both sold out." },
  {
    id: "brooklyn-half", name: "RBC Brooklyn Half", kind: "half", city: "Brooklyn",
    opens: "01-20", time: "12:00 ET", closes: "01-21", confidence: "typical", speed: "minutes",
    lead: "about 4 months", entry: "first come",
    url: "https://www.nyrr.org/races/rbcbrooklynhalf",
    note: "The hardest ordinary entry in New York. Be logged in and waiting at noon — it has gone in under an hour, sometimes far less." },
  {
    id: "nyc-marathon-drawing", name: "TCS New York City Marathon — drawing", kind: "marathon", city: "New York",
    opens: "02-25", time: "12:00 ET", closes: "03-15", confidence: "typical", speed: "lottery",
    lead: "about 8 months", entry: "lottery",
    url: "https://www.nyrr.org/tcsnycmarathon",
    note: "Entering early confers no advantage — it is a drawing — but the window shuts and does not reopen. Result lands about two weeks later." },
  {
    id: "nyc-9plus1", name: "NYRR 9+1 — guaranteed entry route", kind: "program", city: "New York",
    opens: "01-01", time: "", closes: "12-31", confidence: "confirmed", speed: "weeks",
    lead: "a full calendar year", entry: "qualify",
    url: "https://www.nyrr.org/run/guaranteed-entry/9plus1-program",
    note: "Nine NYRR races plus one volunteer shift inside a single calendar year earns guaranteed marathon entry two years later. The real constraint is race availability, so book each quarterly batch as it opens." },
  {
    id: "nyc-half", name: "United Airlines NYC Half — drawing", kind: "half", city: "New York",
    opens: "10-20", time: "12:00 ET", closes: "11-13", confidence: "typical", speed: "lottery",
    lead: "about 5 months", entry: "lottery", url: "https://www.nyrr.org/races/uanychalf", note: "" },

  // ---- the majors ----
  {
    id: "boston", name: "Boston Marathon", kind: "marathon", city: "Boston",
    opens: "09-08", time: "10:00 ET", closes: "09-12", confidence: "typical", speed: "weeks",
    lead: "about 7 months", entry: "qualify",
    url: "https://www.baa.org/races/boston-marathon",
    note: "A five-day application window, not first-come. Meeting the standard is not enough — the cut-off has run several minutes faster than the posted time in recent years." },
  {
    id: "chicago", name: "Bank of America Chicago Marathon — drawing", kind: "marathon", city: "Chicago",
    opens: "10-21", time: "12:00 CT", closes: "11-20", confidence: "typical", speed: "lottery",
    lead: "about 12 months", entry: "lottery",
    url: "https://www.chicagomarathon.com/", note: "Opens shortly after the current year's race, for the following October." },
  {
    id: "london", name: "TCS London Marathon — ballot", kind: "marathon", city: "London",
    opens: "04-26", time: "00:00 BST", closes: "05-02", confidence: "typical", speed: "lottery",
    lead: "about 12 months", entry: "ballot",
    url: "https://www.tcslondonmarathon.com/",
    note: "The ballot opens during race week for the following year and stays open about a week. Over half a million apply." },
  {
    id: "berlin", name: "BMW Berlin Marathon — drawing", kind: "marathon", city: "Berlin",
    opens: "09-20", time: "", closes: "10-18", confidence: "typical", speed: "lottery",
    lead: "about 12 months", entry: "lottery", url: "https://www.bmw-berlin-marathon.com/", note: "" },
  {
    id: "tokyo", name: "Tokyo Marathon — lottery", kind: "marathon", city: "Tokyo",
    opens: "08-01", time: "", closes: "08-31", confidence: "typical", speed: "lottery",
    lead: "about 7 months", entry: "lottery", url: "https://www.marathon.tokyo/en/", note: "" },
  {
    id: "sydney", name: "TCS Sydney Marathon", kind: "marathon", city: "Sydney",
    opens: "10-01", time: "", closes: "02-28", confidence: "typical", speed: "weeks",
    lead: "about 10 months", entry: "first come", url: "https://www.sydneymarathon.org/", note: "The newest of the majors." },

  // ---- others worth a diary entry ----
  {
    id: "cim", name: "California International Marathon", kind: "marathon", city: "Sacramento",
    opens: "01-07", time: "", closes: "11-01", confidence: "typical", speed: "weeks",
    lead: "about 11 months", entry: "first come",
    url: "https://runsra.org/california-international-marathon/registration/",
    note: "Tiered pricing that climbs through the year, and in 2026 every tier sold out well before race day. Enter in January if you want it." },
  {
    id: "nycruns", name: "NYCRUNS races", kind: "various", city: "New York",
    opens: "01-02", time: "", closes: "12-31", confidence: "typical", speed: "weeks",
    lead: "rolling", entry: "first come",
    url: "https://nycruns.com/races",
    note: "The practical fallback when NYRR has sold out. Big Apple Half, Queens Marathon and the seasonal 5Ks stay open far longer." },
  {
    id: "philly", name: "Philadelphia Marathon", kind: "marathon", city: "Philadelphia",
    opens: "01-15", time: "", closes: "10-15", confidence: "typical", speed: "weeks",
    lead: "about 10 months", entry: "first come", url: "https://www.philadelphiamarathon.com/", note: "" },
  {
    id: "marine-corps", name: "Marine Corps Marathon — lottery", kind: "marathon", city: "Washington DC",
    opens: "02-18", time: "12:00 ET", closes: "03-05", confidence: "typical", speed: "lottery",
    lead: "about 8 months", entry: "lottery", url: "https://www.marinemarathon.com/", note: "" },
  {
    id: "nj-marathon", name: "New Jersey Marathon & Half", kind: "marathon", city: "Long Branch",
    opens: "05-05", time: "", closes: "04-20", confidence: "typical", speed: "weeks",
    lead: "about 12 months", entry: "first come", url: "https://www.njmarathon.org/",
    note: "Opens right after the current year's race." },
];

const pad = (n) => String(n).padStart(2, "0");

/* The zone each published opening time is quoted in. */
const ZONES = { ET: "America/New_York", CT: "America/Chicago", PT: "America/Los_Angeles",
  BST: "Europe/London", GMT: "Europe/London", JST: "Asia/Tokyo", CET: "Europe/Berlin", AEST: "Australia/Sydney" };

/* Turn "2027-01-20" + "12:00 ET" into the exact instant, daylight saving included.
   Done by search rather than arithmetic: guess an instant, ask what wall-clock time it
   is in that zone, and correct. Two passes is always enough. */
export function openingInstant(dateKey, timeStr, fallbackZone = "America/New_York") {
  if (!dateKey) return null;
  const [hh, mm] = (timeStr || "12:00").split(" ")[0].split(":").map(Number);
  const zoneName = (timeStr || "").split(" ")[1];
  const zone = ZONES[zoneName] || fallbackZone;
  const [y, m, d] = dateKey.split("-").map(Number);

  let guess = Date.UTC(y, m - 1, d, Number.isFinite(hh) ? hh : 12, Number.isFinite(mm) ? mm : 0);
  for (let i = 0; i < 3; i++) {
    const f = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit",
      day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
    const p = Object.fromEntries(f.formatToParts(new Date(guess)).map((x) => [x.type, x.value]));
    const seen = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute));
    const want = Date.UTC(y, m - 1, d, Number.isFinite(hh) ? hh : 12, Number.isFinite(mm) ? mm : 0);
    const drift = want - seen;
    if (!drift) break;
    guess += drift;
  }
  return new Date(guess);
}

/* A calendar invite for the exact minute, so the phone does the remembering.
   Two alarms: one the day before, one fifteen minutes out. */
export function icsFor(w, dateKey, timeStr) {
  const at = openingInstant(dateKey, timeStr);
  if (!at) return null;
  const stamp = (d) => d.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  const end = new Date(at.getTime() + 15 * 60000);
  const esc = (t) => String(t).replace(/([,;\\])/g, "\\$1").replace(/\n/g, "\\n");
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//health log//race openings//EN",
    "BEGIN:VEVENT",
    `UID:${w.id}-${dateKey}@health-log`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(at)}`,
    `DTEND:${stamp(end)}`,
    `SUMMARY:${esc(`Entry opens: ${w.name}`)}`,
    `DESCRIPTION:${esc(`${w.note || ""}\n\nRegister: ${w.url}`)}`,
    `URL:${w.url}`,
    "BEGIN:VALARM", "TRIGGER:-PT15M", "ACTION:DISPLAY", `DESCRIPTION:${esc(w.name)} opens in 15 minutes`, "END:VALARM",
    "BEGIN:VALARM", "TRIGGER:-P1D", "ACTION:DISPLAY", `DESCRIPTION:${esc(w.name)} opens tomorrow`, "END:VALARM",
    "END:VEVENT", "END:VCALENDAR",
  ].join("\r\n");
}
const key = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const mk = (md, year) => { const [m, d] = md.split("-").map(Number); return new Date(year, m - 1, d); };

/* The next time this window opens, counted from today. Always forward-looking: if this
   year's opening has gone, it returns next year's. */
export function nextOpening(w, todayKey) {
  const [y, m, d] = todayKey.split("-").map(Number);
  const today = new Date(y, m - 1, d);
  const dayMs = 864e5;

  for (const yr of [y - 1, y, y + 1]) {
    const open = mk(w.opens, yr);
    let close = w.closes ? mk(w.closes, yr) : null;
    if (close && close < open) close = mk(w.closes, yr + 1);   // straddles the new year

    if (close && today >= open && today <= close) {
      return { state: "open", opensOn: key(open), closesOn: key(close),
        daysUntilOpen: 0, daysLeft: Math.ceil((close - today) / dayMs) };
    }
    if (today < open) {
      return { state: "upcoming", opensOn: key(open), closesOn: close ? key(close) : null,
        daysUntilOpen: Math.ceil((open - today) / dayMs) };
    }
  }
  return { state: "unknown" };
}

/* Sorted by how soon entry opens, which is the only order that matters here. */
export function openingSoon(todayKey, { withinDays = 400 } = {}) {
  return RACE_WINDOWS
    .map((w) => ({ ...w, status: nextOpening(w, todayKey) }))
    .filter((w) => w.status.state === "open" || (w.status.state === "upcoming" && w.status.daysUntilOpen <= withinDays))
    .sort((a, b) => {
      if (a.status.state !== b.status.state) return a.status.state === "open" ? -1 : 1;
      return a.status.state === "open"
        ? a.status.daysLeft - b.status.daysLeft
        : a.status.daysUntilOpen - b.status.daysUntilOpen;
    });
}

/* What belongs in the morning email. Anything that sells out in minutes gets a month's
   warning, because the whole game there is being at a keyboard at the right moment. */
export function alerts(todayKey) {
  const out = [];
  for (const w of openingSoon(todayKey, { withinDays: 40 })) {
    const s = w.status;
    const fast = w.speed === "minutes" || w.speed === "hours";
    if (s.state === "upcoming") {
      const warnAt = fast ? [30, 14, 7, 3, 1] : [14, 7, 1];
      if (warnAt.includes(s.daysUntilOpen)) {
        out.push({ ...w, message: `${w.name} entry opens in ${s.daysUntilOpen} day${s.daysUntilOpen === 1 ? "" : "s"}`
          + (w.time ? `, ${w.time}` : "") + (fast ? " — it sells out in minutes" : "") + "." });
      }
    } else if (s.state === "open" && s.daysLeft <= 5) {
      out.push({ ...w, message: `${w.name} entry closes in ${s.daysLeft} day${s.daysLeft === 1 ? "" : "s"}.` });
    }
  }
  return out;
}

/* older imports */
export const MAJORS = RACE_WINDOWS;
export const windowStatus = nextOpening;
export const actionable = openingSoon;
