import { getRedis } from "./redisClient.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

    const code = String(req.query.code || "").trim();
    if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: "Bad code" });

    const redis = await getRedis();

    const key = `sync:${code}`;
    const raw = await redis.get(key);

    if (!raw) return res.status(404).json({ error: "Code expired or not found" });

    await redis.del(key); // one-time
    return res.status(200).json(JSON.parse(raw));
  } catch (err) {
    console.error("SYNC GET ERROR:", err);
    return res.status(500).json({ error: "Internal Server Error", detail: String(err?.message || err) });
  }
}