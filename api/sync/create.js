import { getRedis } from "./redisClient.js";

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

    const redis = await getRedis();

    let code = makeCode();
    for (let i = 0; i < 8; i++) {
      const exists = await redis.get(`sync:${code}`);
      if (!exists) break;
      code = makeCode();
    }

    const store = JSON.stringify({
      ...payload,
      mode: payload.mode || "all",
      exportedAt: payload.exportedAt || Date.now(),
    });

    // set + expire in 10 minutes
    await redis.set(`sync:${code}`, store, { EX: 600 });

    return res.status(200).json({ code, expiresInSec: 600 });
  } catch (err) {
    console.error("SYNC CREATE ERROR:", err);
    return res.status(500).json({ error: "Internal Server Error", detail: String(err?.message || err) });
  }
}