import { createClient } from "redis";

let clientPromise = null;

export function getRedis() {
  if (!process.env.REDIS_URL) {
    throw new Error("Missing REDIS_URL environment variable");
  }

  if (!clientPromise) {
    const client = createClient({ url: process.env.REDIS_URL });

    client.on("error", (err) => {
      console.error("Redis Client Error", err);
    });

    clientPromise = (async () => {
      if (!client.isOpen) await client.connect();
      return client;
    })();
  }

  return clientPromise;
}