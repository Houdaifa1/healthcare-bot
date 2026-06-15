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
  ssl: isDigitalOcean
    ? { rejectUnauthorized: false }
    : undefined,
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

interface SpecialtyFixture {
  slug: string;
  displayOrder: number;
  labels: Record<string, string>;
}

interface DoctorFixture {
  name: string;
  specialtySlug: string;
  displayOrder: number;
}

interface TimeSlotFixture {
  doctorName: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  slotDurationMinutes: number;
}

interface FAQFixture {
  language: string;
  question: string;
  answer: string;
  keywords: string[];
  displayOrder: number;
}

interface AdminUserFixture {
  email: string;
  password: string;
  role: string;
}

function loadFixture<T>(filename: string): T {
  const filepath = join(__dirname, '..', '..', 'prisma', 'fixtures', filename);
  return JSON.parse(readFileSync(filepath, 'utf-8')) as T;
}

/**
 * Create a record only if it doesn't exist yet.
 * NEVER update existing records — dashboard data always wins.
 * This makes the seed safe to run on any database without destroying data.
 */
async function main() {
  console.log('🌱 Starting seed...\n');

  // ── 1. Load all fixtures ─────────────────────────────────────────────
  const clinicData = loadFixture<ClinicFixture>('clinic.json');
  const messagesFR = loadFixture<BotMessageFixture[]>('bot-messages.fr.json');
  const messagesEN = loadFixture<BotMessageFixture[]>('bot-messages.en.json');
  const specialtiesData = loadFixture<SpecialtyFixture[]>('specialties.json');
  const doctorsData = loadFixture<DoctorFixture[]>('doctors.json');
  const timeslotsData = loadFixture<TimeSlotFixture[]>('timeslots.json');
  const faqsFR = loadFixture<FAQFixture[]>('faqs.fr.json');
  const faqsEN = loadFixture<FAQFixture[]>('faqs.en.json');
  const adminUserData = loadFixture<AdminUserFixture>('admin-user.json');

  // ── 2. Upsert clinic ─────────────────────────────────────────────────
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
    console.log(`⏭️  Clinic already exists, skipping`);
  }
  const clinic = existingClinic ?? (await prisma.clinic.findUnique({ where: { id: 'main' } }))!;

  // ── 3. Create bot messages only if missing ────────────────────────────
  let createdCount = 0;
  for (const msg of [...messagesFR, ...messagesEN]) {
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
      createdCount++;
    }
  }
  console.log(`✅ Bot messages seeded: ${createdCount} new (existing messages preserved)`);

  // ── 4. Create specialties only if missing ─────────────────────────────
  createdCount = 0;
  for (const spec of specialtiesData) {
    const exists = await prisma.specialty.findUnique({
      where: {
        clinicId_slug: {
          clinicId: clinic.id,
          slug: spec.slug,
        },
      },
    });
    if (!exists) {
      await prisma.specialty.create({
        data: {
          clinicId: clinic.id,
          slug: spec.slug,
          labels: spec.labels,
          displayOrder: spec.displayOrder,
        },
      });
      createdCount++;
    }
  }
  console.log(`✅ Specialties seeded: ${createdCount} new (existing specialties preserved)`);

  // ── 5. Create doctors only if missing ─────────────────────────────────
  const specialtyBySlug = new Map<string, string>();
  const allSpecialties = await prisma.specialty.findMany({
    where: { clinicId: clinic.id },
  });
  for (const s of allSpecialties) {
    specialtyBySlug.set(s.slug, s.id);
  }

  const doctorIdByName = new Map<string, string>();
  createdCount = 0;
  for (const doc of doctorsData) {
    const specialtyId = specialtyBySlug.get(doc.specialtySlug);
    if (!specialtyId) {
      console.warn(`⚠️  Specialty slug "${doc.specialtySlug}" not found for doctor "${doc.name}". Skipping.`);
      continue;
    }

    const doctorId = `doctor_${doc.name.replace(/\s+/g, '_').replace(/\./g, '')}`;
    const exists = await prisma.doctor.findUnique({ where: { id: doctorId } });
    if (!exists) {
      await prisma.doctor.create({
        data: {
          id: doctorId,
          clinicId: clinic.id,
          specialtyId,
          name: doc.name,
          displayOrder: doc.displayOrder,
        },
      });
      createdCount++;
    }
    doctorIdByName.set(doc.name, doctorId);
  }
  console.log(`✅ Doctors seeded: ${createdCount} new (existing doctors preserved)`);

  // ── 6. Create timeslots only if doctor has NONE ──────────────────────
  createdCount = 0;
  for (const slot of timeslotsData) {
    const doctorId = doctorIdByName.get(slot.doctorName);
    if (!doctorId) {
      console.warn(`⚠️  Doctor "${slot.doctorName}" not found for timeslot. Skipping.`);
      continue;
    }

    const existingCount = await prisma.timeSlot.count({ where: { doctorId } });
    if (existingCount > 0) {
      // Already has timeslots (from dashboard or previous seed) — preserve them
      continue;
    }

    await prisma.timeSlot.create({
      data: {
        doctorId,
        dayOfWeek: slot.dayOfWeek,
        startTime: slot.startTime,
        endTime: slot.endTime,
        slotDurationMinutes: slot.slotDurationMinutes,
      },
    });
    createdCount++;
  }
  console.log(`✅ Timeslots seeded: ${createdCount} new (existing data preserved)`);

  // ── 7. Create FAQs only if missing ────────────────────────────────────
  createdCount = 0;
  for (const faq of [...faqsFR, ...faqsEN]) {
    const faqId = `faq_${faq.language}_${faq.displayOrder}`;
    const exists = await prisma.fAQ.findUnique({ where: { id: faqId } });
    if (!exists) {
      await prisma.fAQ.create({
        data: {
          id: faqId,
          clinicId: clinic.id,
          language: faq.language as any,
          question: faq.question,
          answer: faq.answer,
          keywords: faq.keywords,
          displayOrder: faq.displayOrder,
        },
      });
      createdCount++;
    }
  }
  console.log(`✅ FAQs seeded: ${createdCount} new (existing FAQs preserved)`);

  // ── 8. Create admin user only if missing ─────────────────────────────
  const adminEmail = process.env.SEED_ADMIN_EMAIL;
  const adminPassword = process.env.SEED_ADMIN_PASSWORD;

  if (!adminEmail || !adminPassword) {
    console.warn(
      '⚠️  SEED_ADMIN_EMAIL and/or SEED_ADMIN_PASSWORD not set. Skipping admin user seed.\n' +
      '   Set them in .env or environment variables.',
    );
  } else {
    const existingAdmin = await prisma.adminUser.findUnique({ where: { email: adminEmail } });
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
      console.log(`⏭️  Admin user ${adminEmail} already exists, skipping`);
    }
  }

  console.log('\n🎉 Seed complete! No existing data was overwritten.');
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());