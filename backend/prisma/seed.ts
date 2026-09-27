import { getSenderConfigs } from "../src/config";
import { encryptSecret } from "../src/crypto";
import { prisma } from "../src/db";

async function main() {
  const senders = getSenderConfigs();
  if (senders.length === 0) {
    throw new Error("Configure at least one SMTP sender in ETHEREAL_ACCOUNTS before seeding.");
  }

  for (const sender of senders) {
    await prisma.sender.upsert({
      where: { email: sender.email },
      update: {
        name: sender.name,
        host: sender.host,
        port: sender.port,
        secure: sender.secure,
        smtpUser: sender.user,
        smtpPass: encryptSecret(sender.pass),
        maxPerHour: sender.maxPerHour,
        enabled: true,
      },
      create: {
        name: sender.name,
        email: sender.email,
        host: sender.host,
        port: sender.port,
        secure: sender.secure,
        smtpUser: sender.user,
        smtpPass: encryptSecret(sender.pass),
        maxPerHour: sender.maxPerHour,
      },
    });
  }
  console.log(`Configured ${senders.length} sender account(s).`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());