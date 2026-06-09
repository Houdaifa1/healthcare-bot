import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { add, format, eachDayOfInterval, isSameDay } from 'date-fns';

@Injectable()
export class AvailabilityService {
  constructor(private prisma: PrismaService) {}

  async getAvailableDates(
    doctorId: string,
    count: number,
    startDate: Date = new Date(),
  ): Promise<string[]> {
    const timeSlots = await this.prisma.timeSlot.findMany({
      where: { doctorId, isActive: true },
      orderBy: { dayOfWeek: 'asc' },
    });

    if (timeSlots.length === 0) {
      return [];
    }

    const availableDays = new Set(timeSlots.map((ts) => ts.dayOfWeek));
    const dates: string[] = [];
    let currentDate = startDate;

    while (dates.length < count) {
      const dayOfWeek = currentDate.getDay();
      if (availableDays.has(dayOfWeek)) {
        // Check for conflicts
        const appointments = await this.prisma.appointment.findMany({
          where: {
            doctorId,
            appointmentDate: {
              gte: currentDate,
              lt: add(currentDate, { days: 1 }),
            },
            status: {
              in: ['PENDING', 'CONFIRMED'],
            },
          },
        });

        const slotsForDay = timeSlots.filter(
          (ts) => ts.dayOfWeek === dayOfWeek,
        );
        const totalSlots = slotsForDay.reduce((acc, slot) => {
          const start = new Date(`1970-01-01T${slot.startTime}:00`);
          const end = new Date(`1970-01-01T${slot.endTime}:00`);
          const diff = (end.getTime() - start.getTime()) / (1000 * 60);
          return acc + Math.floor(diff / slot.slotDurationMinutes);
        }, 0);

        if (appointments.length < totalSlots) {
          dates.push(format(currentDate, 'yyyy-MM-dd'));
        }
      }
      currentDate = add(currentDate, { days: 1 });
    }

    return dates;
  }

  async getAvailableSlots(
    doctorId: string,
    date: string, // "yyyy-MM-dd"
  ): Promise<string[]> {
    const targetDate = new Date(date);
    const dayOfWeek = targetDate.getDay();

    const timeSlots = await this.prisma.timeSlot.findMany({
      where: {
        doctorId,
        dayOfWeek,
        isActive: true,
      },
    });

    const appointments = await this.prisma.appointment.findMany({
      where: {
        doctorId,
        status: { in: ['PENDING', 'CONFIRMED'] },
      },
    });

    const bookedSlots = appointments
      .filter((a) => isSameDay(a.appointmentDate, targetDate))
      .map((a) => a.appointmentTime);

    const availableSlots: string[] = [];

    for (const slot of timeSlots) {
      const start = new Date(`${date}T${slot.startTime}`);
      const end = new Date(`${date}T${slot.endTime}`);
      let current = start;

      while (current < end) {
        const time = format(current, 'HH:mm');
        if (!bookedSlots.includes(time)) {
          availableSlots.push(time);
        }
        current = add(current, { minutes: slot.slotDurationMinutes });
      }
    }

    return availableSlots;
  }
}
