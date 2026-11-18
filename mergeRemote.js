/* Bringing in rows the SERVER wrote (the scheduled Garmin pull) without losing anything you
   typed in the browser.

   Two writers share the sleep and day lists: this browser, and the Garmin job. The browser
   keeps its own copy in memory and writes the whole list back when anything changes, so a
   tab that has been open since the morning would otherwise save a stale copy over the top of
   what the job added at 11am. This merges the stored copy into the in-memory one by date.

   The rules, which are the same ones the server uses:
   - a row the browser has never seen is added
   - a field that is blank here is filled from there
   - a field you typed is never touched
   - a field Garmin supplied both times may be refreshed, since a sleep score is revised
   `_g` on a row lists the fields Garmin supplied, so "yours" and "Garmin's" stay distinct. */

export function mergeRemoteByDate(local, remote) {
  if (!Array.isArray(remote) || !remote.length) return local;
  const by = new Map(local.map((r) => [r.date, r]));
  let changed = false;

  for (const r of remote) {
    if (!r?.date) continue;
    const cur = by.get(r.date);
    if (!cur) { by.set(r.date, r); changed = true; continue; }

    const lg = new Set(cur._g || []), rg = new Set(r._g || []);
    let next = null;
    for (const [k, v] of Object.entries(r)) {
      if (k === "date" || k === "_g" || v == null || v === "") continue;
      const have = cur[k];
      const blank = have == null || have === "";
      const bothGarmin = lg.has(k) && rg.has(k);
      if (blank || (bothGarmin && have !== v)) { next = next || { ...cur }; next[k] = v; }
    }
    if (next) {
      // provenance follows the value: a field is Garmin's only if the stored value is the one we took
      const g = new Set([...lg].filter((k) => next[k] === cur[k]));
      for (const k of rg) if (next[k] === r[k]) g.add(k);
      if (g.size) next._g = [...g]; else delete next._g;
      by.set(r.date, next); changed = true;
    }
  }
  return changed ? [...by.values()].sort((a, b) => (a.date < b.date ? -1 : 1)) : local;   // same array back = nothing to re-render or re-save
}

/* Only the fields that really changed, so leaving a box you did not touch writes nothing.
   `tol` gives a per-field tolerance for numbers that are shown rounded: hours asleep are
   displayed to two decimals of an hour, so 446 minutes reads back as 445.8, and that
   round trip must not count as an edit. */
export function changedFields(next, current, tol = {}) {
  const cur = current || {};
  return Object.keys(next).filter((k) => {
    const a = next[k] ?? null, b = cur[k] ?? null;
    if (a === b) return false;
    if (typeof a === "number" && typeof b === "number" && tol[k] != null) return Math.abs(a - b) > tol[k];
    return true;
  });
}
