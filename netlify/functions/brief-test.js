// A plain HTTP twin of the scheduled brief, because Netlify will not let you call a
// scheduled function by URL. Visit:
//   /.netlify/functions/brief-test?dry=1   compose it and show the text, send nothing
//   /.netlify/functions/brief-test         actually send one now
import { runBrief } from "./daily-brief.js";

export async function handler(event) {
  const q = event?.queryStringParameters || {};
  // force is implied: this route exists precisely to bypass the clock
  return runBrief({ ...event, queryStringParameters: { ...q, force: "1" } });
}
