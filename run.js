// check-flight.js
// https://booking.flyfrontier.com/Flight/InternalSelect?o1=RDU&d1=BUF&dd1=Jun%2023,%202026&ADT=9&mon=true&ftype=DD
// https://booking.flyfrontier.com/Flight/InternalSelect?o1=RDU&d1=BUF&dd1=Jun%2023,%202026&ADT=200&mon=true&ftype=DD

const FLIGHT_NUMBER = "2980";
const ORIGIN = "RDU";
const DESTINATION = "BUF";
const DATE = "2026-06-23";
const PASSENGERS = 9;

// Minimum seat / GoWild counts; a CI run fails when the flight drops below
// these. Overridable via env vars in the GitHub Actions workflow.
const MIN_SEATS = Number(process.env.MIN_SEATS) || 40;
const MIN_GOWILD = Number(process.env.MIN_GOWILD) || 10;

// Frontier's booking page only emits fare-bundle strings of the form
// `|F9~<flightNumber>~` when at least the requested number of seats can
// actually be booked. When the flight is sold out for that party size it
// renders "Unavailable" and those bundle strings are absent.
const AVAILABILITY_MARKER = `|F9~${FLIGHT_NUMBER}~`;

function buildUrl(passengers) {
  // dd1 expects a date like "Jun 23, 2026".
  const dd1 = new Date(`${DATE}T00:00:00`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric"
  });

  const params = new URLSearchParams({
    o1: ORIGIN,
    d1: DESTINATION,
    dd1,
    ADT: passengers.toString(),
    mon: "true",
    ftype: "DD"
  });

  return `https://booking.flyfrontier.com/Flight/InternalSelect?${params}`;
}

const ORIGIN_BASE = "https://booking.flyfrontier.com";
const USER_AGENT = "Mozilla/5.0";

// The InternalSelect deep link replies 302 -> /Flight/Select and sets the
// ASP.NET session cookies on that response. Node's fetch follows redirects but
// does NOT carry Set-Cookie across hops, so a naive fetch lands on a cookieless
// "Redirect" page with no results. We follow redirects manually, accumulating
// cookies in a small jar and replaying them on each hop, mirroring a browser.
async function fetchHtml(passengers) {
  const cookies = {};
  const cookieHeader = () =>
    Object.entries(cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");

  let url = buildUrl(passengers);

  for (let hop = 0; hop < 6; hop++) {
    const headers = { "User-Agent": USER_AGENT };
    if (Object.keys(cookies).length) headers.Cookie = cookieHeader();

    const response = await fetch(url, { headers, redirect: "manual" });

    const setCookies = response.headers.getSetCookie
      ? response.headers.getSetCookie()
      : [];
    for (const c of setCookies) {
      const m = c.match(/^([^=]+)=([^;]*)/);
      if (m) cookies[m[1]] = m[2];
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) break;
      url = location.startsWith("http") ? location : ORIGIN_BASE + location;
      continue;
    }

    return response.text();
  }

  throw new Error("Too many redirects while loading flight results");
}

// Sleep for a random duration between 0.2s and 2s, used to space out the
// repeated probes in findGoWildThreshold so we don't hammer the server.
function randomDelay(minMs = 200, maxMs = 2000) {
  const ms = minMs + Math.random() * (maxMs - minMs);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// True when the flight can seat `passengers` in a standard (non-GoWild) fare.
function hasSeats(html) {
  return html.includes(AVAILABILITY_MARKER);
}

// Estimates roughly how many seats are bookable on this flight by probing
// increasing party sizes: the largest ADT that still returns availability is
// about the number of seats left. Frontier's per-fare-class counts are capped
// at 9, so probing is the only way to see more. Uses exponential growth to
// bracket the limit, then binary-searches it. Total requests ~ 2*log2(seats).
async function estimateSeats(cap = 200) {
  let first = true;
  const available = async (n) => {
    if (!first) await randomDelay();
    first = false;
    const ok = hasSeats(await fetchHtml(n));
    console.log(`  party=${n} -> ${ok ? "available" : "unavailable"}`);
    return ok;
  };

  if (!(await available(1))) return 0;

  // Exponential phase: grow until the flight can no longer seat the party.
  let lo = 1; // known-available
  let hi = 2; // candidate
  while (await available(hi)) {
    lo = hi;
    hi *= 2;
    if (hi > cap) return lo; // hit safety cap; at least `lo` seats
  }

  // Binary phase: greatest n in (lo, hi) that is still available.
  let seats = lo;
  let left = lo + 1;
  let right = hi - 1;
  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    if (await available(mid)) {
      seats = mid;
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }
  return seats;
}

// Returns the GoWild fare for FLIGHT_NUMBER, or -1 when GoWild shows "-- GoWild!".
// The page renders each journey's leg block (containing `flightNumber:2980`)
// immediately followed by that journey's fares, including `goWildFare`.
// A positive value means GoWild is offered; -1.0 means it is not.
function goWildFare(html) {
  const text = html.replace(/&quot;/g, '"').replace(/\\"/g, '"');
  const re = new RegExp(`flightNumber":${FLIGHT_NUMBER}\\b`, "g");
  let m;
  let best = null;
  while ((m = re.exec(text))) {
    const seg = text.slice(m.index, m.index + 1200);
    const g = seg.match(/goWildFare":([-0-9.]+)/);
    if (!g) continue;
    const value = parseFloat(g[1]);
    if (value > 0) best = best === null ? value : Math.min(best, value);
    else if (best === null) best = value;
  }
  return best === null ? -1 : best;
}

async function checkFlight() {
  const html = await fetchHtml(PASSENGERS);

  const seats = hasSeats(html);
  console.log(
    seats
      ? `✅ Flight F9 ${FLIGHT_NUMBER} has ${PASSENGERS} seat(s) available`
      : `❌ Flight F9 ${FLIGHT_NUMBER} does NOT have ${PASSENGERS} seat(s) available`
  );

  const gw = goWildFare(html);
  console.log(
    gw > 0
      ? `🟢 GoWild available at $${gw.toFixed(2)} for ${PASSENGERS} passenger(s)`
      : `⚪ GoWild not available ("-- GoWild!") for ${PASSENGERS} passenger(s)`
  );

  // Probe for a rough seat count beyond the requested party size.
  const estimate = await estimateSeats();
  if (estimate === 0) {
    console.log("🪑 Roughly 0 seats available");
  } else if (estimate >= 200) {
    console.log("🪑 Roughly 200+ seats available");
  } else {
    console.log(`🪑 Roughly ${estimate} seat(s) available`);
  }
}

// Finds the largest party size for which GoWild is still offered on this
// flight. The Frontier UI caps the picker at 9, but the server responds to
// higher ADT values, so we don't assume an upper bound: first grow the probe
// exponentially until GoWild drops out, then binary-search the boundary.
// Total requests ~ 2*log2(threshold).
async function findGoWildThreshold(cap = 200) {
  let first = true;
  const fareAt = async (n) => {
    if (!first) await randomDelay();
    first = false;
    const fare = goWildFare(await fetchHtml(n));
    console.log(`  party=${n} -> ${fare > 0 ? `$${fare.toFixed(2)}` : "-- GoWild!"}`);
    return fare;
  };

  if (!((await fareAt(1)) > 0)) {
    console.log("🎯 GoWild not offered even for 1 passenger on this flight");
    return 0;
  }

  // Exponential phase: find a size where GoWild is NO longer offered.
  let lo = 1; // known-available
  let hi = 2; // candidate that may or may not be available
  while ((await fareAt(hi)) > 0) {
    lo = hi;
    hi *= 2;
    if (hi > cap) {
      console.log(`🎯 GoWild still offered at ${lo}+ passenger(s) (hit cap ${cap})`);
      return lo;
    }
  }

  // Binary phase: greatest n in (lo, hi) that is still available.
  let threshold = lo;
  let fareAtThreshold = -1;
  let left = lo + 1;
  let right = hi - 1;
  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const fare = await fareAt(mid);
    if (fare > 0) {
      threshold = mid;
      fareAtThreshold = fare;
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }

  console.log(
    `🎯 GoWild offered for up to ${threshold} passenger(s)` +
      (fareAtThreshold > 0 ? ` (fare $${fareAtThreshold.toFixed(2)})` : "")
  );
  return threshold;
}

const arg = process.argv[2];
if (arg === "--gowild-threshold") {
  const cap = Number(process.argv[3]) || 1000;
  findGoWildThreshold(cap).catch(console.error);
} else if (arg === "--ci") {
  // CI mode: fail (non-zero exit) when seats or GoWild availability drop too
  // low. GitHub Actions surfaces a failed run as an email notification.
  runCiCheck().catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else {
  checkFlight().catch(console.error);
}

async function runCiCheck() {
  console.log(
    `Checking F9 ${FLIGHT_NUMBER} ${ORIGIN}->${DESTINATION} on ${DATE} ` +
      `(require >=${MIN_SEATS} seats, >=${MIN_GOWILD} GoWild)`
  );

  console.log("Estimating total seats...");
  const seats = await estimateSeats(Math.max(MIN_SEATS * 2, 200));
  const seatsLabel = seats >= 200 ? "200+" : `${seats}`;
  console.log(`🪑 Roughly ${seatsLabel} seat(s) available`);

  console.log("Estimating GoWild seats...");
  const goWild = await findGoWildThreshold(Math.max(MIN_GOWILD * 2, 200));

  const failures = [];
  if (seats < MIN_SEATS) {
    failures.push(`seats ${seatsLabel} < ${MIN_SEATS}`);
  }
  if (goWild < MIN_GOWILD) {
    failures.push(`GoWild seats ${goWild} < ${MIN_GOWILD}`);
  }

  const passed = failures.length === 0;
  const status = passed ? "PASS ✅" : "FAIL ❌";
  const subject =
    `[${status}] F9 ${FLIGHT_NUMBER} ${ORIGIN}->${DESTINATION} ${DATE}: ` +
    `~${seatsLabel} seats, ${goWild} GoWild`;
  const body =
    `${status}\n` +
    `Flight: F9 ${FLIGHT_NUMBER} ${ORIGIN} -> ${DESTINATION} on ${DATE}\n` +
    `Seats available: ~${seatsLabel} (min ${MIN_SEATS})\n` +
    `GoWild seats: ${goWild} (min ${MIN_GOWILD})\n` +
    (passed ? "" : `Breached: ${failures.join("; ")}\n`);

  // Emit a clear summary into the run's job summary so it's visible when you
  // open the run from the GitHub notification email.
  writeCiSummary({ subject, body });

  console.log(body.trim());

  // Exit non-zero only when a threshold is actually breached. With GitHub's
  // "Actions" notifications set to all runs (not just failures), you get an
  // email either way; the run's pass/fail status then reflects reality.
  if (!passed) process.exit(1);
}

// Writes a clear summary into the run's job summary (GITHUB_STEP_SUMMARY) so
// the numbers are front-and-center when you open the run from the email.
function writeCiSummary({ subject, body }) {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryFile) return;
  const fs = require("fs");
  fs.appendFileSync(summaryFile, `## ${subject}\n\n\`\`\`\n${body}\`\`\`\n`);
}
