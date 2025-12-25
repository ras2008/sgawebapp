import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

function makeCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

    const payload = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    if (!payload || !Array.isArray(payload.records)) {
      return res.status(400).json({ error: "Missing payload.records (must be an array)" });
    }

    let code = makeCode();
    for (let i = 0; i < 8; i++) {
      const exists = await redis.get(`sync:${code}`);
      if (!exists) break;
      code = makeCode();
    }

    const store = {
      ...payload,
      mode: payload.mode || "all",
      exportedAt: payload.exportedAt || Date.now(),
    };

    await redis.set(`sync:${code}`, store, { ex: 600 }); // 10 minutes
    return res.status(200).json({ code, expiresInSec: 600 });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal Server Error", detail: String(err?.message || err) });
  }
}