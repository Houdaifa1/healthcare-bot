import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as bcrypt from 'bcrypt';
import * as dotenv from 'dotenv';

dotenv.config();

const connectionString = process.env.DATABASE_URL ?? '';
const isDigitalOcean = connectionString.includes('db.ondigitalocean.com');

const adapter = new PrismaPg({
  connectionString,
  ssl: isDigitalOcean ? { rejectUnauthorized: false } : undefined,
});

const prisma = new PrismaClient({ adapter });

interface ClinicFixture {
  name: string;
  phone: string;
  address: string;
  timezone: string;
  defaultLanguage: string;
  supportedLangs: string[];
}

interface BotMessageFixture {
  key: string;
  language: string;
  body: string;
}

interface AdminUserFixture {
  role: string;
}

interface FaqFixture {
  language: string;
  question: string;
  answer: string;
  keywords: string[];
  displayOrder: number;
}

function loadFixture<T>(filename: string): T {
  // __dirname is /app/dist/src/prisma at runtime — fixtures are at /app/prisma/fixtures
  const filepath = join(__dirname, '..', '..', '..', 'prisma', 'fixtures', filename);
  return JSON.parse(readFileSync(filepath, 'utf-8')) as T;
}

async function main() {
  console.log('🌱 Starting seed...\n');

  // ── 1. Clinic ─────────────────────────────────────────────────────────
  // Only created once. Never updated — admin manages clinic data via dashboard.
  const clinicData = loadFixture<ClinicFixture>('clinic.json');
  const existingClinic = await prisma.clinic.findUnique({ where: { id: 'main' } });

  if (!existingClinic) {
    await prisma.clinic.create({
      data: {
        id: 'main',
        name: clinicData.name,
        phone: clinicData.phone,
        address: clinicData.address,
        timezone: clinicData.timezone,
        defaultLanguage: clinicData.defaultLanguage as any,
        supportedLangs: clinicData.supportedLangs as any,
      },
    });
    console.log(`✅ Clinic created: ${clinicData.name}`);
  } else {
    console.log(`⏭️  Clinic already exists — skipping`);
  }

  const clinic = existingClinic ?? (await prisma.clinic.findUnique({ where: { id: 'main' } }))!;

  // ── 2. Bot messages ───────────────────────────────────────────────────
  // Only inserts keys that don't exist yet.
  // Never overwrites — admin edits via dashboard are preserved.
  // New keys added to fixture files are picked up on next deploy.
  const messagesFR = loadFixture<BotMessageFixture[]>('bot-messages.fr.json');
  const messagesEN = loadFixture<BotMessageFixture[]>('bot-messages.en.json');
  const allMessages = [...messagesFR, ...messagesEN];

  let inserted = 0;
  let skipped = 0;

  for (const msg of allMessages) {
    const exists = await prisma.botMessage.findUnique({
      where: {
        clinicId_key_language: {
          clinicId: clinic.id,
          key: msg.key as any,
          language: msg.language as any,
        },
      },
    });

    if (!exists) {
      await prisma.botMessage.create({
        data: {
          clinicId: clinic.id,
          key: msg.key as any,
          language: msg.language as any,
          body: msg.body,
        },
      });
      inserted++;
    } else {
      skipped++;
    }
  }

  console.log(`✅ Bot messages: ${inserted} inserted, ${skipped} already existed (preserved)`);

  // ── 3. FAQs ────────────────────────────────────────────────────────────
  // Only inserts (clinicId, language, question) combos that don't exist yet.
  // Never overwrites — admin edits via dashboard are preserved.
  const faqsFR = loadFixture<FaqFixture[]>('faqs.fr.json');
  const faqsEN = loadFixture<FaqFixture[]>('faqs.en.json');
  const allFaqs = [...faqsFR, ...faqsEN];

  let faqsInserted = 0;
  let faqsSkipped = 0;

  for (const faq of allFaqs) {
    const exists = await prisma.fAQ.findFirst({
      where: {
        clinicId: clinic.id,
        language: faq.language as any,
        question: faq.question,
      },
    });

    if (!exists) {
      await prisma.fAQ.create({
        data: {
          clinicId:     clinic.id,
          language:     faq.language as any,
          question:     faq.question,
          answer:       faq.answer,
          keywords:     faq.keywords,
          displayOrder: faq.displayOrder,
        },
      });
      faqsInserted++;
    } else {
      faqsSkipped++;
    }
  }

  console.log(`✅ FAQs: ${faqsInserted} inserted, ${faqsSkipped} already existed (preserved)`);

  // ── 4. Admin user ─────────────────────────────────────────────────────
  // Created once from env vars. Never updated by seed.
  // Password changes must be done via dashboard or direct DB update.
  const adminUserData = loadFixture<AdminUserFixture>('admin-user.json');
  const adminEmail = process.env.SEED_ADMIN_EMAIL;
  const adminPassword = process.env.SEED_ADMIN_PASSWORD;

  if (!adminEmail || !adminPassword) {
    console.warn(
      '⚠️  SEED_ADMIN_EMAIL and/or SEED_ADMIN_PASSWORD not set in env — skipping admin user',
    );
  } else {
    const existingAdmin = await prisma.adminUser.findUnique({
      where: { email: adminEmail },
    });

    if (!existingAdmin) {
      const passwordHash = await bcrypt.hash(adminPassword, 12);
      await prisma.adminUser.create({
        data: {
          email: adminEmail,
          passwordHash,
          role: adminUserData.role as any,
          clinicId: clinic.id,
        },
      });
      console.log(`✅ Admin user created: ${adminEmail}`);
    } else {
      console.log(`⏭️  Admin user already exists — skipping`);
    }
  }

  console.log('\n🎉 Seed complete — no existing data was modified.');
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());