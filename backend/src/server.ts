import "dotenv/config";
import cors from "cors";
import express, { Router } from "express";
import session from "express-session";
import { RedisStore } from "connect-redis";
import passport from "passport";
import { createHash } from "node:crypto";
import { EmailStatus, Prisma } from "@prisma/client";
import { z } from "zod";
import { createBullBoard } from "@bull-board/api";
import { ExpressAdapter } from "@bull-board/express";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { config } from "./config";
import { prisma } from "./db";
import { redis } from "./redis";
import { emailQueue } from "./queue";
import { authRouter, requireAuth } from "./auth";
import { indexEmails, searchEmails } from "./search";

const app = express();
app.set("trust proxy", 1);
app.use(cors({ origin: config.FRONTEND_URL, credentials: true }));
app.use(express.json({ limit: "1mb" }));
app.use(session({
  name: "reachinbox.sid",
  store: new RedisStore({ client: redis }),
  secret: config.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: config.NODE_ENV === "production",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
}));
app.use(passport.initialize());
app.use(passport.session());
app.use("/auth", authRouter);

const api = Router();
api.get("/me", (req, res) => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }
  res.json({ id: req.user.id, email: req.user.email, name: req.user.name, avatar: req.user.avatar });
});

api.get("/senders", requireAuth, async (_req, res, next) => {
  try {
    const senders = await prisma.sender.findMany({
      where: { enabled: true },
      orderBy: { createdAt: "asc" },
      select: { id: true, email: true, name: true, maxPerHour: true },
    });
    res.json(senders);
  } catch (error) {
    next(error);
  }
});

const scheduleSchema = z.object({
  recipients: z.array(z.string().email()).min(1).max(10000),
  senderId: z.string().min(1),
  subject: z.string().trim().min(1).max(998),
  body: z.string().trim().min(1).max(100000),
  scheduledAt: z.string().datetime({ offset: true }),
  delayMs: z.number().int().min(0).max(60 * 60 * 1000),
  hourlyLimit: z.number().int().positive(),
});

api.post("/emails", requireAuth, async (req, res, next) => {
  try {
    const input = scheduleSchema.parse(req.body);
    const idempotencyKey = req.get("Idempotency-Key");
    if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
      res.status(400).json({ error: "Provide an Idempotency-Key between 8 and 128 characters." });
      return;
    }
    const sender = await prisma.sender.findFirst({ where: { id: input.senderId, enabled: true } });
    if (!sender) {
      res.status(400).json({ error: "The selected sender is unavailable." });
      return;
    }
    const hourlyLimit = Math.min(input.hourlyLimit, config.MAX_EMAILS_PER_HOUR);
    const scheduledAt = new Date(input.scheduledAt);
    const recipients = [...new Set(input.recipients.map((to) => to.toLowerCase()))];
    const payloadHash = createHash("sha256").update(JSON.stringify({
      recipients,
      senderId: sender.id,
      subject: input.subject,
      body: input.body,
      scheduledAt: scheduledAt.toISOString(),
      delayMs: input.delayMs,
      hourlyLimit,
    })).digest("hex");
    let replayed = false;
    let emails: Awaited<ReturnType<typeof prisma.email.findMany>>;

    const existingBatch = await prisma.emailBatch.findUnique({
      where: { userId_idempotencyKey: { userId: req.user!.id, idempotencyKey } },
    });
    if (existingBatch) {
      if (existingBatch.payloadHash !== payloadHash) {
        res.status(409).json({ error: "This Idempotency-Key was already used with a different request." });
        return;
      }
      replayed = true;
      emails = await prisma.email.findMany({ where: { batchId: existingBatch.id } });
    } else {
      await prisma.sender.update({ where: { id: sender.id }, data: { maxPerHour: hourlyLimit } });
      try {
        const batch = await prisma.$transaction(async (transaction) => {
          const createdBatch = await transaction.emailBatch.create({
            data: { userId: req.user!.id, idempotencyKey, payloadHash },
          });
          await transaction.email.createMany({
            data: recipients.map((to) => ({
              batchId: createdBatch.id,
              userId: req.user!.id,
              senderId: sender.id,
              to,
              subject: input.subject,
              body: input.body,
              scheduledAt,
              delayMs: input.delayMs,
            })),
          });
          return createdBatch;
        });
        emails = await prisma.email.findMany({ where: { batchId: batch.id } });
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
        const concurrentBatch = await prisma.emailBatch.findUnique({
          where: { userId_idempotencyKey: { userId: req.user!.id, idempotencyKey } },
        });
        if (!concurrentBatch || concurrentBatch.payloadHash !== payloadHash) {
          res.status(409).json({ error: "This Idempotency-Key was already used with a different request." });
          return;
        }
        replayed = true;
        emails = await prisma.email.findMany({ where: { batchId: concurrentBatch.id } });
      }
    }

    const scheduledEmails = emails.filter((email) => email.status === EmailStatus.SCHEDULED);
    if (scheduledEmails.length) await emailQueue.addBulk(scheduledEmails.map((email) => ({
      name: "send-email",
      data: { emailId: email.id },
      opts: {
        jobId: `email-${email.id}`,
        delay: Math.max(0, email.scheduledAt.getTime() - Date.now()),
      },
    })));
    try {
      await indexEmails(emails.map((email) => ({
        id: email.id,
        userId: email.userId,
        to: email.to,
        subject: email.subject,
        status: email.status,
        scheduledAt: email.scheduledAt,
        sentAt: email.sentAt,
        senderEmail: sender.email,
      })));
    } catch (error) {
      console.error("One or more scheduled email records could not be indexed:", error);
    }

    res.status(202).json({
      scheduled: emails.length,
      replayed,
      emails: emails.map((email) => ({ id: email.id, to: email.to })),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues[0]?.message || "Invalid scheduling request." });
      return;
    }
    next(error);
  }
});

api.get("/emails", requireAuth, async (req, res, next) => {
  try {
    const folder = req.query.folder === "sent" ? "sent" : "scheduled";
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 50));
    const statuses: EmailStatus[] = folder === "sent"
      ? [EmailStatus.SENT, EmailStatus.FAILED]
      : [EmailStatus.SCHEDULED, EmailStatus.SENDING];
    const where = {
      userId: req.user!.id,
      status: { in: statuses },
    };
    const [total, emails] = await Promise.all([
      prisma.email.count({ where }),
      prisma.email.findMany({
        where,
        include: { sender: { select: { email: true, name: true } } },
        orderBy: folder === "sent" ? { sentAt: "desc" } : { scheduledAt: "asc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    res.json({ emails, total, page, pageSize });
  } catch (error) {
    next(error);
  }
});

api.get("/emails/search", requireAuth, async (req, res, next) => {
  const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (!query) {
    res.json([]);
    return;
  }
  try {
    res.json(await searchEmails(req.user!.id, query));
  } catch (error) {
    next(error);
  }
});

api.get("/slack", requireAuth, async (req, res, next) => {
  try {
    const integration = await prisma.slackIntegration.findUnique({
      where: { userId: req.user!.id },
      select: { teamName: true },
    });
    res.json({ connected: Boolean(integration), teamName: integration?.teamName ?? null });
  } catch (error) {
    next(error);
  }
});

api.delete("/slack", requireAuth, async (req, res, next) => {
  try {
    await prisma.slackIntegration.deleteMany({ where: { userId: req.user!.id } });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.use("/api", api);
app.get("/health", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    await redis.ping();
    res.json({ status: "ok", database: "ok", redis: "ok" });
  } catch {
    res.status(503).json({ status: "unavailable" });
  }
});

const boardAdapter = new ExpressAdapter();
boardAdapter.setBasePath("/admin/queues");
createBullBoard({ queues: [new BullMQAdapter(emailQueue)], serverAdapter: boardAdapter });
app.use("/admin/queues", requireAuth, boardAdapter.getRouter());

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = error instanceof Error ? error.message : "Internal server error.";
  console.error(error);
  res.status(500).json({ error: config.NODE_ENV === "production" ? "Internal server error." : message });
});

const server = app.listen(config.PORT, () => {
  console.log(`API listening on http://localhost:${config.PORT}`);
  console.log(`Queue dashboard: http://localhost:${config.PORT}/admin/queues`);
});

async function shutdown(): Promise<void> {
  server.close();
  await emailQueue.close();
  await prisma.$disconnect();
  await redis.quit();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());