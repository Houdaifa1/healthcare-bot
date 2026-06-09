import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { FAQ } from '@prisma/client';
import { CreateFaqDto } from './dto/create-faq.dto';
import { UpdateFaqDto } from './dto/update-faq.dto';

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

  async findAll(clinicId: string): Promise<FAQ[]> {
    return this.prisma.fAQ.findMany({
      where: { clinicId },
    });
  }

  async update(id: string, updateFaqDto: UpdateFaqDto): Promise<FAQ> {
    return this.prisma.fAQ.update({
      where: { id },
      data: updateFaqDto,
    });
  }

  async remove(id: string): Promise<FAQ> {
    return this.prisma.fAQ.delete({
      where: { id },
    });
  }
}
