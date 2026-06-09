import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Language, Specialty } from '@prisma/client';

@Injectable()
export class SpecialtyService {
  constructor(private prisma: PrismaService) {}

  async findActive(
    clinicId: string,
    language: Language,
  ): Promise<Specialty[]> {
    return this.prisma.specialty.findMany({
      where: {
        clinicId,
        language,
        isActive: true,
      },
      orderBy: {
        displayOrder: 'asc',
      },
    });
  }

  async findBySlug(
    clinicId: string,
    slug: string,
    language: Language,
  ): Promise<Specialty | null> {
    return this.prisma.specialty.findUnique({
      where: {
        clinicId_slug_language: {
          clinicId,
          slug,
          language,
        },
      },
    });
  }
}
