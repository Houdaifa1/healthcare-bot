import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Doctor } from '@prisma/client';

@Injectable()
export class DoctorService {
  constructor(private prisma: PrismaService) {}

  async findBySpecialty(
    clinicId: string,
    specialtyId: string,
  ): Promise<Doctor[]> {
    return this.prisma.doctor.findMany({
      where: {
        clinicId,
        specialtyId,
        isActive: true,
      },
      orderBy: {
        displayOrder: 'asc',
      },
    });
  }

  async findById(id: string): Promise<Doctor | null> {
    return this.prisma.doctor.findUnique({
      where: { id },
    });
  }
}
