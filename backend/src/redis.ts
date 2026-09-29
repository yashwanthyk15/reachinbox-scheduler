import Redis from "ioredis";
import { config } from "./config";

export const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  keepAlive: 10000,
  family: 0,
  retryStrategy(times) {
    return Math.min(times * 200, 5000);
  },
  reconnectOnError(err) {
    console.error("Redis reconnectOnError:", err.message);
    return true;
  },
});

redis.on("error", (err) => {
  console.error("Redis connection error:", err.message);
});

redis.on("connect", () => {
  console.log("Redis connected.");
});