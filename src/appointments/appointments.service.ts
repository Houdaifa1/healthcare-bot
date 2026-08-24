import { Injectable, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Appointment, AppointmentStatus } from '@prisma/client';

@Injectable()
export class AppointmentsService {
  constructor(private prisma: PrismaService) {}

  async findByClinic(
  clinicId: string,
  filters: { date?: string; doctorId?: string; status?: AppointmentStatus },
) {
  return this.prisma.appointment.findMany({
    where: {
      clinicId,
      ...(filters.date && {
        appointmentDate: new Date(filters.date),
      }),
      ...(filters.doctorId && {
        doctorId: filters.doctorId,
      }),
      ...(filters.status && {
        status: filters.status,
      }),
    },
    orderBy: {
      appointmentDate: 'asc',
    },
  });
}

  async updateStatus(
  clinicId: string,
  id: string,
  status: AppointmentStatus,
): Promise<Appointment> {
  const appointment = await this.prisma.appointment.findFirst({
    where: { id, clinicId },
  });

  if (!appointment) {
    throw new Error('Appointment not found in this clinic');
  }

  return this.prisma.appointment.update({
    where: { id },
    data: { status },
  });
}

  async remove(clinicId: string, id: string): Promise<Appointment> {
    const appointment = await this.prisma.appointment.findFirst({
      where: { id, clinicId },
    });

    if (!appointment) {
      throw new Error('Appointment not found in this clinic');
    }

    return this.prisma.appointment.delete({
      where: { id },
    });
  }

  async checkConflict(
    doctorId: string,
    date: Date,
    time: string,
  ): Promise<void> {
    const existingAppointment = await this.prisma.appointment.findFirst({
      where: {
        doctorId,
        appointmentDate: date,
        appointmentTime: time,
        status: {
          in: [AppointmentStatus.PENDING, AppointmentStatus.CONFIRMED],
        },
      },
    });

    if (existingAppointment) {
      throw new ConflictException('Appointment slot is already booked.');
    }
  }
}
