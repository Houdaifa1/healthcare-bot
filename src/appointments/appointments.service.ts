import { Injectable, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Appointment, AppointmentStatus } from '@prisma/client';
import { CreateAppointmentDto } from './dto/create-appointment.dto';

@Injectable()
export class AppointmentsService {
  constructor(private prisma: PrismaService) {}

  async createAppointment(
  clinicId: string,
  dto: CreateAppointmentDto,
): Promise<Appointment> {
  const { doctorId, specialtyId, appointmentDate, appointmentTime } = dto;

  const doctor = await this.prisma.doctor.findFirst({
    where: { id: doctorId, clinicId },
  });

  if (!doctor) {
    throw new Error('Doctor not found in this clinic');
  }

  const specialty = await this.prisma.specialty.findFirst({
    where: { id: specialtyId, clinicId },
  });

  if (!specialty) {
    throw new Error('Specialty not found in this clinic');
  }

  if (doctor.specialtyId !== specialtyId) {
    throw new Error('Doctor does not belong to this specialty');
  }

  const date = new Date(appointmentDate);

  const existing = await this.prisma.appointment.findFirst({
    where: {
      clinicId,
      doctorId,
      appointmentDate: date,
      appointmentTime,
      status: {
        in: ['PENDING', 'CONFIRMED'],
      },
    },
  });

  if (existing) {
    throw new ConflictException('Appointment slot already booked');
  }

  return this.prisma.appointment.create({
    data: {
      ...dto,
      clinicId,
      appointmentDate: date,
    },
  });
}

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
    include: {
      doctor: true,
      specialty: true,
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
