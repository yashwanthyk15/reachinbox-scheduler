import "dotenv/config";
import nodemailer from "nodemailer";
import { DelayedError, Worker } from "bullmq";
import { config } from "./config";
import { prisma } from "./db";
import { decryptSecret } from "./crypto";
import { EMAIL_QUEUE_NAME, type SendEmailJob, emailQueue } from "./queue";
import { redis } from "./redis";
import { indexEmail } from "./search";

const reserveSlotScript = `
local reserved = redis.call('GET', KEYS[2])
if reserved then return {1, tonumber(reserved)} end
local now = tonumber(ARGV[1])
local nextAt = tonumber(redis.call('GET', KEYS[1]) or '0')
local candidate = math.max(now, nextAt)
local windowMs = tonumber(ARGV[5])
local window = math.floor(candidate / windowMs) * windowMs
local bucketKey = ARGV[4] .. window
local count = tonumber(redis.call('GET', bucketKey) or '0')
local limit = tonumber(ARGV[3])
if count >= limit then return {0, window, window + windowMs} end
redis.call('INCR', bucketKey)
redis.call('EXPIRE', bucketKey, math.max(60, math.ceil(windowMs * 2 / 1000)))
redis.call('SET', KEYS[1], candidate + tonumber(ARGV[2]), 'EX', 172800)
redis.call('SET', KEYS[2], candidate, 'EX', 172800)
return {1, candidate}
`;

async function notifySlack(userId: string, senderEmail: string, windowStart: number): Promise<void> {
  const integration = await prisma.slackIntegration.findUnique({ where: { userId } });
  if (!integration) return;

  const notificationKey = `slack-rate-notified:${integration.id}:${senderEmail}:${windowStart}`;
  const firstNotice = await redis.set(notificationKey, "1", "EX", 2 * 60 * 60, "NX");
  if (firstNotice !== "OK") return;

  try {
    const token = decryptSecret(integration.botToken);
    const openResponse = await fetch("https://slack.com/api/conversations.open", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ users: integration.slackUserId }),
    });
    const openResult = await openResponse.json() as { ok: boolean; error?: string; channel?: { id: string } };
    if (!openResult.ok || !openResult.channel?.id) throw new Error(openResult.error || "Could not open Slack DM.");

    const messageResponse = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        channel: openResult.channel.id,
        text: `Rate limit reached for ${senderEmail}. Remaining emails have been deferred to the next rate-limit window.`,
      }),
    });
    const messageResult = await messageResponse.json() as { ok: boolean; error?: string };
    if (!messageResult.ok) throw new Error(messageResult.error || "Slack message could not be sent.");
  } catch (error) {
    await redis.del(notificationKey);
    console.error("Slack rate-limit notification failed:", error);
  }
}

async function safeIndex(emailId: string): Promise<void> {
  try {
    const email = await prisma.email.findUnique({ where: { id: emailId }, include: { sender: true } });
    if (email) await indexEmail({
      id: email.id,
      userId: email.userId,
      to: email.to,
      subject: email.subject,
      status: email.status,
      scheduledAt: email.scheduledAt,
      sentAt: email.sentAt,
      senderEmail: email.sender.email,
    });
  } catch (error) {
    console.error(`Email ${emailId} could not be indexed:`, error);
  }
}

const worker = new Worker<SendEmailJob>(EMAIL_QUEUE_NAME, async (job, token) => {
  const email = await prisma.email.findUnique({ where: { id: job.data.emailId }, include: { sender: true } });
  if (!email || email.status !== "SCHEDULED") return;

  const limit = Math.min(email.sender.maxPerHour, config.MAX_EMAILS_PER_HOUR);
  const spacing = Math.max(config.MIN_SEND_DELAY_MS, email.delayMs);
  const reservationKey = `email-reservation:${email.id}`;
  const nextSenderKey = `sender-next-send:${email.senderId}`;
  const reservation = await redis.eval(
    reserveSlotScript,
    2,
    nextSenderKey,
    reservationKey,
    Date.now(),
    spacing,
    limit,
    `sender-window:${email.senderId}:`,
    config.RATE_LIMIT_WINDOW_MS,
  ) as number[];

  if (reservation[0] === 0) {
    const windowStart = reservation[1];
    const nextWindow = reservation[2];
    await notifySlack(email.userId, email.sender.email, windowStart);
    await job.moveToDelayed(nextWindow, token);
    throw new DelayedError();
  }

  const reservedAt = reservation[1];
  if (reservedAt > Date.now()) {
    await job.moveToDelayed(reservedAt, token);
    throw new DelayedError();
  }

  const claim = await prisma.email.updateMany({
    where: { id: email.id, status: "SCHEDULED" },
    data: { status: "SENDING", error: null },
  });
  if (claim.count === 0) {
    await redis.del(reservationKey);
    return;
  }
  await redis.del(reservationKey);

  const transport = nodemailer.createTransport({
    host: email.sender.host,
    port: email.sender.port,
    secure: email.sender.secure,
    auth: { user: email.sender.smtpUser, pass: decryptSecret(email.sender.smtpPass) },
  });

  try {
    const info = await transport.sendMail({
      from: { name: config.EMAIL_FROM_NAME, address: email.sender.email },
      to: email.to,
      subject: email.subject,
      text: email.body,
    });
    const previewUrl = nodemailer.getTestMessageUrl(info);
    if (previewUrl) console.log(`Ethereal preview: ${previewUrl}`);
    await prisma.email.update({
      where: { id: email.id },
      data: { status: "SENT", sentAt: new Date(), error: null },
    });
    await safeIndex(email.id);
  } catch (error) {
    const lastAttempt = job.attemptsMade + 1 >= Number(job.opts.attempts ?? 1);
    await prisma.email.update({
      where: { id: email.id },
      data: {
        status: lastAttempt ? "FAILED" : "SCHEDULED",
        error: error instanceof Error ? error.message : "SMTP delivery failed.",
      },
    });
    if (lastAttempt) await safeIndex(email.id);
    throw error;
  } finally {
    transport.close();
  }
}, {
  connection: redis,
  concurrency: config.WORKER_CONCURRENCY,
  lockDuration: 60_000,
  drainDelay: 5,
});

async function recoverScheduledEmails(): Promise<void> {
  let cursor: string | undefined;
  for (;;) {
    const batch = await prisma.email.findMany({
      where: { status: "SCHEDULED" },
      orderBy: { id: "asc" },
      take: 500,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, scheduledAt: true },
    });
    if (batch.length === 0) break;
    for (const email of batch) {
      const existing = await emailQueue.getJob(`email-${email.id}`);
      const state = existing ? await existing.getState() : null;
      if (existing && state && ["waiting", "delayed", "active", "waiting-children"].includes(state)) continue;
      if (existing) await existing.remove();
      await emailQueue.add("send-email", { emailId: email.id }, {
        jobId: `email-${email.id}`,
        delay: Math.max(0, email.scheduledAt.getTime() - Date.now()),
      });
    }
    cursor = batch[batch.length - 1].id;
  }
}

worker.on("ready", () => console.log(`Email worker ready (concurrency ${config.WORKER_CONCURRENCY}).`));
worker.on("failed", (job, error) => console.error(`Email job ${job?.id} failed:`, error.message));

recoverScheduledEmails()
  .then(() => console.log("Scheduled email recovery scan complete."))
  .catch((error: unknown) => {
    console.error("Could not recover scheduled emails:", error);
    process.exitCode = 1;
  });

async function shutdown(): Promise<void> {
  await worker.close();
  await emailQueue.close();
  await prisma.$disconnect();
  await redis.quit();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());