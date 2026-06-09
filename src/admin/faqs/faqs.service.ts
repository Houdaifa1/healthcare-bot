import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateFaqDto } from './dto/create-faq.dto';
import { UpdateFaqDto } from './dto/update-faq.dto';
import { FAQ, Language } from '@prisma/client';

@Injectable()
export class FaqsService {
  constructor(private prisma: PrismaService) {}

  async create(clinicId: string, createFaqDto: CreateFaqDto): Promise<FAQ> {
    return this.prisma.fAQ.create({
      data: {
        ...createFaqDto,
        clinicId,
      },
    });
  }

  async findAll(clinicId: string, language?: Language): Promise<FAQ[]> {
    return this.prisma.fAQ.findMany({
      where: {
        clinicId,
        isActive: true,
        ...(language && { language }),
      },
      orderBy: { displayOrder: 'asc' },
    });
  }

  async update(id: string, updateFaqDto: UpdateFaqDto): Promise<FAQ> {
    return this.prisma.fAQ.update({
      where: { id },
      data: updateFaqDto,
    });
  }

  async remove(id: string): Promise<FAQ> {
    return this.prisma.fAQ.update({
      where: { id },
      data: { isActive: false },
    });
  }
}