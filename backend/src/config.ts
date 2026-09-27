import "dotenv/config";
import { z } from "zod";

const configSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  FRONTEND_URL: z.string().url().default("http://localhost:5173"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().url().default("redis://localhost:6379"),
  ELASTICSEARCH_URL: z.string().url().default("http://localhost:9200"),
  SESSION_SECRET: z.string().min(16).default("development-only-change-this-secret"),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CALLBACK_URL: z.string().url().default("http://localhost:4000/auth/google/callback"),
  SLACK_CLIENT_ID: z.string().optional(),
  SLACK_CLIENT_SECRET: z.string().optional(),
  SLACK_CALLBACK_URL: z.string().url().default("http://localhost:4000/auth/slack/callback"),
  ETHEREAL_ACCOUNTS: z.string().default("[]"),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(10),
  MIN_SEND_DELAY_MS: z.coerce.number().int().nonnegative().default(2000),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60 * 60 * 1000),
  MAX_EMAILS_PER_HOUR: z.coerce.number().int().positive().default(200),
  EMAIL_FROM_NAME: z.string().default("ReachInbox Scheduler"),
});

export const config = configSchema.parse(process.env);

export interface SenderConfig {
  name: string;
  email: string;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  maxPerHour: number;
}

export function getSenderConfigs(): SenderConfig[] {
  const parsed: unknown = JSON.parse(config.ETHEREAL_ACCOUNTS);
  return z.array(z.object({
    name: z.string().min(1),
    email: z.string().email(),
    host: z.string().min(1),
    port: z.number().int().positive(),
    secure: z.boolean().default(false),
    user: z.string().min(1),
    pass: z.string().min(1),
    maxPerHour: z.number().int().positive().default(config.MAX_EMAILS_PER_HOUR),
  })).parse(parsed);
}