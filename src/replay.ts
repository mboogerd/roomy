// Drive the running server from a fixture: npm run replay -- incident-review 20
const [fixture = "architecture-debate", speed = "10"] = process.argv.slice(2);
const base = process.env.ROOMY_URL ?? "http://localhost:3000";
const res = await fetch(`${base}/replay`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ fixture, speed: Number(speed) }),
});
console.log(res.ok ? `replaying ${fixture} at ${speed}x — watch ${base}` : `failed: ${res.status}`);
