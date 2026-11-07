import "dotenv/config";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const email = (process.env.ADMIN_EMAIL || "admin@example.com").toLowerCase().trim();
  const password = process.env.ADMIN_PASSWORD;
  if (!password || password.length < 10) {
    throw new Error("Set ADMIN_PASSWORD in .env to a password of at least 10 characters before seeding.");
  }
  const passwordHash = await bcrypt.hash(password, 12);
  await prisma.user.upsert({
    where: { email },
    update: { name: process.env.ADMIN_NAME || "Paper Work Admin", passwordHash, role: "SUPER_ADMIN", active: true },
    create: { name: process.env.ADMIN_NAME || "Paper Work Admin", email, passwordHash, role: "SUPER_ADMIN", active: true }
  });
  console.log(`Super Admin ready: ${email}`);
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
