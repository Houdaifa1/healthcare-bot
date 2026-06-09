import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FAQ, Language } from '@prisma/client';

@Injectable()
export class FAQService {
  constructor(private prisma: PrismaService) {}

  async findActive(clinicId: string, language: Language): Promise<FAQ[]> {
    return this.prisma.fAQ.findMany({
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

  async matchByKeywords(
    clinicId: string,
    input: string,
    language: Language,
  ): Promise<FAQ | null> {
    const normalizedInput = input.toLowerCase().trim();
    const keywords = normalizedInput.split(/\s+/);

    const faqs = await this.findActive(clinicId, language);

    for (const faq of faqs) {
      const hasMatch = faq.keywords.some((kw) => keywords.includes(kw));
      if (hasMatch) {
        return faq;
      }
    }

    return null;
  }
}
