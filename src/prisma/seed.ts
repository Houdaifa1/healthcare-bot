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
  const clinic = await prisma.clinic.upsert({
    where: { id: 'main' },
    update: {
      name: clinicData.name,
      phone: clinicData.phone,
      address: clinicData.address,
      timezone: clinicData.timezone,
      defaultLanguage: clinicData.defaultLanguage as any,
      supportedLangs: clinicData.supportedLangs as any,
    },
    create: {
      id: 'main',
      name: clinicData.name,
      phone: clinicData.phone,
      address: clinicData.address,
      timezone: clinicData.timezone,
      defaultLanguage: clinicData.defaultLanguage as any,
      supportedLangs: clinicData.supportedLangs as any,
    },
  });
  console.log(`✅ Clinic seeded: ${clinic.name}`);

  // ── 3. Upsert all bot messages (FR + EN) ─────────────────────────────
  for (const msg of [...messagesFR, ...messagesEN]) {
    await prisma.botMessage.upsert({
      where: {
        clinicId_key_language: {
          clinicId: clinic.id,
          key: msg.key as any,
          language: msg.language as any,
        },
      },
      update: { body: msg.body },
      create: {
        clinicId: clinic.id,
        key: msg.key as any,
        language: msg.language as any,
        body: msg.body,
      },
    });
  }
  console.log(`✅ Bot messages seeded: ${messagesFR.length + messagesEN.length} total`);

  // ── 4. Upsert specialties (expand labels into language-specific rows) ──
  for (const spec of specialtiesData) {
    for (const [lang, label] of Object.entries(spec.labels)) {
      await prisma.specialty.upsert({
        where: {
          clinicId_slug_language: {
            clinicId: clinic.id,
            slug: spec.slug,
            language: lang as any,
          },
        },
        update: {
          label,
          displayOrder: spec.displayOrder,
        },
        create: {
          clinicId: clinic.id,
          slug: spec.slug,
          language: lang as any,
          label,
          displayOrder: spec.displayOrder,
        },
      });
    }
  }
  console.log(`✅ Specialties seeded: ${specialtiesData.length} specialties x ${Object.keys(specialtiesData[0]?.labels || {}).length} languages`);

  // ── 5. Upsert doctors (resolve specialtyId from slug) ────────────────
  // Build a slug → ID map (slug is language-agnostic, use FR label as reference)
  const specialtyBySlug = new Map<string, string>();
  const allSpecialties = await prisma.specialty.findMany({
    where: { clinicId: clinic.id },
  });
  for (const s of allSpecialties) {
    specialtyBySlug.set(s.slug, s.id);
  }

  const doctorIdByName = new Map<string, string>();
  for (const doc of doctorsData) {
    const specialtyId = specialtyBySlug.get(doc.specialtySlug);
    if (!specialtyId) {
      console.warn(`⚠️  Specialty slug "${doc.specialtySlug}" not found for doctor "${doc.name}". Skipping.`);
      continue;
    }

    const created = await prisma.doctor.upsert({
      where: { id: `doctor_${doc.name.replace(/\s+/g, '_').replace(/\./g, '')}` },
      update: {
        name: doc.name,
        specialtyId,
        displayOrder: doc.displayOrder,
        clinicId: clinic.id,
      },
      create: {
        id: `doctor_${doc.name.replace(/\s+/g, '_').replace(/\./g, '')}`,
        clinicId: clinic.id,
        specialtyId,
        name: doc.name,
        displayOrder: doc.displayOrder,
      },
    });
    doctorIdByName.set(doc.name, created.id);
  }
  console.log(`✅ Doctors seeded: ${doctorsData.length} total`);

  // ── 6. Seed timeslots ONLY if doctor has NONE (preserve dashboard data) ──
  // IMPORTANT: We NEVER delete or overwrite existing timeslots because
  // the dashboard may have updated them. Only seed if the doctor has
  // ZERO timeslots (i.e. first-time setup).
  let seededCount = 0;
  for (const slot of timeslotsData) {
    const doctorId = doctorIdByName.get(slot.doctorName);
    if (!doctorId) {
      console.warn(`⚠️  Doctor "${slot.doctorName}" not found for timeslot. Skipping.`);
      continue;
    }

    // Check if this doctor already has any timeslots (from dashboard)
    const existingCount = await prisma.timeSlot.count({
      where: { doctorId },
    });

    if (existingCount > 0) {
      // Doctor already has timeslots — preserve them (dashboard data wins)
      continue;
    }

    // First time setup — seed from fixtures
    await prisma.timeSlot.create({
      data: {
        doctorId,
        dayOfWeek: slot.dayOfWeek,
        startTime: slot.startTime,
        endTime: slot.endTime,
        slotDurationMinutes: slot.slotDurationMinutes,
      },
    });
    seededCount++;
  }
  console.log(`✅ Timeslots seeded: ${seededCount} new (existing data preserved for other doctors)`);

  // ── 7. Upsert FAQs (FR + EN) ─────────────────────────────────────────
  for (const faq of [...faqsFR, ...faqsEN]) {
    const faqId = `faq_${faq.language}_${faq.displayOrder}`;
    await prisma.fAQ.upsert({
      where: { id: faqId },
      update: {
        question: faq.question,
        answer: faq.answer,
        keywords: faq.keywords,
        displayOrder: faq.displayOrder,
        isActive: true,
      },
      create: {
        id: faqId,
        clinicId: clinic.id,
        language: faq.language as any,
        question: faq.question,
        answer: faq.answer,
        keywords: faq.keywords,
        displayOrder: faq.displayOrder,
      },
    });
  }
  console.log(`✅ FAQs seeded: ${faqsFR.length + faqsEN.length} total`);

  // ── 8. Upsert admin user — credentials from env, NEVER hardcoded ────
  const adminEmail = process.env.SEED_ADMIN_EMAIL;
  const adminPassword = process.env.SEED_ADMIN_PASSWORD;

  if (!adminEmail || !adminPassword) {
    console.warn(
      '⚠️  SEED_ADMIN_EMAIL and/or SEED_ADMIN_PASSWORD not set. Skipping admin user seed.\n' +
      '   Set them in .env or environment variables.',
    );
  } else {
    const passwordHash = await bcrypt.hash(adminPassword, 12);
    await prisma.adminUser.upsert({
      where: { email: adminEmail },
      update: {
        passwordHash,
        role: adminUserData.role as any,
        clinicId: clinic.id,
      },
      create: {
        email: adminEmail,
        passwordHash,
        role: adminUserData.role as any,
        clinicId: clinic.id,
      },
    });
    console.log(`✅ Admin user seeded: ${adminEmail}`);
  }

  console.log('\n🎉 Seed complete! All content loaded from fixtures.');
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());