import { Injectable } from '@nestjs/common';
import { PrismaService } from '@platform/database/prisma.service';
import { Clinic } from '@prisma/client';
import { UpdateClinicDto } from './dto/update-clinic.dto';

@Injectable()
export class ClinicService {
  constructor(private prisma: PrismaService) {}

  async getClinic(id: string): Promise<Clinic | null> {
    return this.prisma.clinic.findUnique({ where: { id } });
  }

  async updateClinic(id: string, data: UpdateClinicDto): Promise<Clinic> {
    return this.prisma.clinic.update({
      where: { id },
      data,
    });
  }
}
