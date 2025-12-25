import { kv } from "@vercel/kv";

export default async function handler(req, res) {
  const code = String(req.query.code || "").trim();
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: "Bad code" });

  const key = `sync:${code}`;
  const payload = await kv.get(key);

  if (!payload) return res.status(404).json({ error: "Code expired or not found" });

  await kv.del(key); // one-time use
  res.json(payload);
}