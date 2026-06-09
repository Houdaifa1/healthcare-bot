import { Injectable, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Appointment, AppointmentStatus } from '@prisma/client';
import { CreateAppointmentDto } from './dto/create-appointment.dto';

@Injectable()
export class AppointmentsService {
  constructor(private prisma: PrismaService) {}

  async createAppointment(
    createAppointmentDto: CreateAppointmentDto,
  ): Promise<Appointment> {
    const { doctorId, appointmentDate, appointmentTime } = createAppointmentDto;

    await this.checkConflict(doctorId, new Date(appointmentDate), appointmentTime);

    return this.prisma.appointment.create({
      data: {
        ...createAppointmentDto,
        appointmentDate: new Date(appointmentDate),
      },
    });
  }

  async findByClinic(
    clinicId: string,
    filters: { date?: string; doctorId?: string; status?: AppointmentStatus },
  ): Promise<Appointment[]> {
    return this.prisma.appointment.findMany({
      where: {
        clinicId,
        ...(filters.date && { appointmentDate: new Date(filters.date) }),
        ...(filters.doctorId && { doctorId: filters.doctorId }),
        ...(filters.status && { status: filters.status }),
      },
      include: {
        doctor: true,
        specialty: true,
      },
    });
  }

  async updateStatus(
    id: string,
    status: AppointmentStatus,
  ): Promise<Appointment> {
    return this.prisma.appointment.update({
      where: { id },
      data: { status },
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
