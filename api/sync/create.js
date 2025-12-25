import { kv } from "@vercel/kv";

function makeCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const payload = req.body;
  if (!payload || !payload.records) {
    return res.status(400).json({ error: "Missing payload" });
  }

  let code = makeCode();

  // avoid collisions (rare, but nice)
  for (let i = 0; i < 5; i++) {
    const exists = await kv.get(`sync:${code}`);
    if (!exists) break;
    code = makeCode();
  }

  await kv.set(`sync:${code}`, payload, { ex: 600 }); // expires in 10 minutes
  res.json({ code, expiresInSec: 600 });
}