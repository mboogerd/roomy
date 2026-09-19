// Drive the running server from a fixture: npm run replay -- incident-review 20
const [fixture = "architecture-debate", speed = "10", slug] = process.argv.slice(2);
const configured = new URL(process.env.ROOMY_URL ?? "http://localhost:3000");
let room: URL;

if (slug) {
  room = new URL(configured);
  room.pathname = `/r/${encodeURIComponent(slug)}`;
  room.search = "";
} else if (/^\/r\/[^/]+\/?$/.test(configured.pathname)) {
  room = new URL(configured);
  room.pathname = room.pathname.replace(/\/$/, "");
  room.search = "";
} else {
  const root = await fetch(configured, { redirect: "manual" });
  const location = root.headers.get("location");
  if (!location) throw new Error(`ROOMY_URL did not redirect to a room (HTTP ${root.status})`);
  room = new URL(location, configured);
}

const base = room.href.replace(/\/$/, "");
const res = await fetch(`${base}/replay`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ fixture, speed: Number(speed) }),
});
console.log(res.ok ? `replaying ${fixture} at ${speed}x — watch ${base}` : `failed: ${res.status}`);
