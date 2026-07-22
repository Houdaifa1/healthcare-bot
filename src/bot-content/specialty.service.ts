import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Language, Specialty } from '@prisma/client';

@Injectable()
export class SpecialtyService {
  constructor(private prisma: PrismaService) {}

  async findActive(clinicId: string, language: Language): Promise<Specialty[]> {
    const all = await this.prisma.specialty.findMany({
      where: {
        clinicId,
        isActive: true,
      },
      orderBy: {
        displayOrder: 'asc',
      },
    });

    // Filter out specialties that don't have a label for the requested language
    return all.filter((s) => {
      const labels = s.labels as Record<string, string> | null;
      return labels && labels[language];
    });
  }

  async findBySlug(
    clinicId: string,
    slug: string,
    _language: Language,
  ): Promise<Specialty | null> {
    return this.prisma.specialty.findUnique({
      where: {
        clinicId_slug: {
          clinicId,
          slug,
        },
      },
    });
  }

  async findById(id: string, _language: Language): Promise<Specialty | null> {
    return this.prisma.specialty.findFirst({
      where: { id, isActive: true },
    });
  }
}
