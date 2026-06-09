import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { TimeSlot } from '@prisma/client';
import { CreateTimeSlotDto } from './dto/create-timeslot.dto';
import { UpdateTimeSlotDto } from './dto/update-timeslot.dto';

@Injectable()
export class TimeSlotsService {
  constructor(private prisma: PrismaService) {}

  async create(
    doctorId: string,
    createTimeSlotDto: CreateTimeSlotDto,
  ): Promise<TimeSlot> {
    return this.prisma.timeSlot.create({
      data: {
        doctorId,
        dayOfWeek: createTimeSlotDto.dayOfWeek,
        startTime: createTimeSlotDto.startTime,
        endTime: createTimeSlotDto.endTime,
        slotDurationMinutes: createTimeSlotDto.slotDurationMinutes ?? 30,
        isActive: createTimeSlotDto.isActive ?? true,
      },
    });
  }

  async findAll(doctorId: string): Promise<TimeSlot[]> {
    return this.prisma.timeSlot.findMany({
      where: { doctorId },
    });
  }

  async update(
    id: string,
    updateTimeSlotDto: UpdateTimeSlotDto,
  ): Promise<TimeSlot> {
    return this.prisma.timeSlot.update({
      where: { id },
      data: updateTimeSlotDto,
    });
  }

  async remove(id: string): Promise<TimeSlot> {
    return this.prisma.timeSlot.delete({
      where: { id },
    });
  }
}