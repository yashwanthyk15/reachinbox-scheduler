import { Queue } from "bullmq";
import { redis } from "./redis";

export const EMAIL_QUEUE_NAME = "scheduled-emails";
export const emailQueue = new Queue(EMAIL_QUEUE_NAME, {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: { age: 7 * 24 * 60 * 60, count: 5000 },
    removeOnFail: { age: 30 * 24 * 60 * 60 },
  },
});

export interface SendEmailJob {
  emailId: string;
}