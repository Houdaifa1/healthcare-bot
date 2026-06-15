import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { add, format } from 'date-fns';

@Injectable()
export class AvailabilityService {
  constructor(private prisma: PrismaService) {}

  /**
   * Returns available dates for a doctor in the given timezone.
   * Merges overlapping slots on the same day before computing capacity.
   */
  async getAvailableDates(
    doctorId: string,
    count: number,
    startDate: Date = new Date(),
    timezone: string = 'Africa/Casablanca',
  ): Promise<string[]> {
    const timeSlots = await this.prisma.timeSlot.findMany({
      where: { doctorId, isActive: true },
      orderBy: { dayOfWeek: 'asc' },
    });

    if (timeSlots.length === 0) return [];

    const availableDays = new Set(timeSlots.map((ts) => ts.dayOfWeek));
    const dates: string[] = [];

    // Compute today in the given timezone
    const todayInTz = this.getTodayInTimezone(timezone);
    let currentDate = todayInTz;

    // Cap at 90 days to prevent infinite loop when all slots are booked
    const MAX_DAYS = 90;
    let daysChecked = 0;

    // Build candidate date range
    const candidateDates: Date[] = [];
    const cursor = new Date(currentDate);
    while (candidateDates.length < count * 2 && daysChecked < MAX_DAYS) {
      const dayOfWeek = cursor.getDay();
      daysChecked++;
      if (availableDays.has(dayOfWeek)) {
        candidateDates.push(new Date(cursor));
      }
      cursor.setDate(cursor.getDate() + 1);
    }

    if (candidateDates.length === 0) return [];

    // Fetch ALL appointments for this doctor in the date range in ONE query
    const startRange = candidateDates[0];
    const endRange = candidateDates[candidateDates.length - 1];
    const endOfRange = new Date(endRange);
    endOfRange.setDate(endOfRange.getDate() + 1);

    const appointments = await this.prisma.appointment.findMany({
      where: {
        doctorId,
        appointmentDate: {
          gte: startRange,
          lt: endOfRange,
        },
        status: { in: ['PENDING', 'CONFIRMED'] },
      },
      select: { appointmentDate: true },
    });

    // Group appointments by date
    const bookedCountByDate = new Map<string, number>();
    for (const apt of appointments) {
      const key = format(apt.appointmentDate, 'yyyy-MM-dd');
      bookedCountByDate.set(key, (bookedCountByDate.get(key) ?? 0) + 1);
    }

    // Pre-merge slots per day to handle overlapping ranges
    const mergedSlotsByDay = this.mergeSlotsByDay(timeSlots);

    // Iterate candidates, compare booked vs merged total slots
    for (const candidate of candidateDates) {
      const dayOfWeek = candidate.getDay();
      const dateStr = format(candidate, 'yyyy-MM-dd');
      if (!availableDays.has(dayOfWeek)) continue;

      const slotsForDay = mergedSlotsByDay.get(dayOfWeek) ?? [];
      const totalSlots = slotsForDay.reduce((acc, slot) => {
        const start = new Date(`1970-01-01T${slot.startTime}:00`);
        const end = new Date(`1970-01-01T${slot.endTime}:00`);
        const diff = (end.getTime() - start.getTime()) / (1000 * 60);
        return acc + Math.floor(diff / slot.slotDurationMinutes);
      }, 0);

      const bookedCount = bookedCountByDate.get(dateStr) ?? 0;
      if (bookedCount < totalSlots) {
        dates.push(dateStr);
        if (dates.length >= count) break;
      }
    }

    return dates;
  }

  /**
   * Returns available time slots for a doctor on a specific date.
   * Merges overlapping slots on the same day before generating time slots.
   */
  async getAvailableSlots(
    doctorId: string,
    date: string, // "yyyy-MM-dd"
  ): Promise<string[]> {
    const targetDate = new Date(`${date}T00:00:00`);
    const dayOfWeek = targetDate.getDay();

    const timeSlots = await this.prisma.timeSlot.findMany({
      where: { doctorId, dayOfWeek, isActive: true },
    });

    // Filter appointments by date range in SQL
    const startOfDay = new Date(`${date}T00:00:00`);
    const endOfDay = new Date(`${date}T23:59:59`);
    const appointments = await this.prisma.appointment.findMany({
      where: {
        doctorId,
        status: { in: ['PENDING', 'CONFIRMED'] },
        appointmentDate: { gte: startOfDay, lte: endOfDay },
      },
      select: { appointmentTime: true },
    });

    const bookedSlots = appointments.map((a) => a.appointmentTime);

    // Merge overlapping slots for this day
    const mergedSlots = this.mergeTimeRanges(
      timeSlots.map((s) => ({
        startTime: s.startTime,
        endTime: s.endTime,
        slotDurationMinutes: s.slotDurationMinutes,
      })),
    );

    const availableSlots: string[] = [];

    for (const slot of mergedSlots) {
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

  /**
   * Helper: ranges overlap if A starts before B ends AND A ends after B starts.
   */
  private rangesOverlap(
    a: { startTime: string; endTime: string },
    b: { startTime: string; endTime: string },
  ): boolean {
    return a.startTime < b.endTime && a.endTime > b.startTime;
  }

  /**
   * Merge overlapping/adjacent time ranges into consolidated ranges.
   * Takes earliest start and latest end for overlapping ranges.
   * Preserves the slotDurationMinutes of the first slot in each merged group.
   */
  private mergeTimeRanges(
    slots: { startTime: string; endTime: string; slotDurationMinutes: number }[],
  ): { startTime: string; endTime: string; slotDurationMinutes: number }[] {
    if (slots.length === 0) return [];
    
    // Sort by startTime
    const sorted = [...slots].sort((a, b) => a.startTime.localeCompare(b.startTime));
    
    const merged: { startTime: string; endTime: string; slotDurationMinutes: number }[] = [];
    let current = { ...sorted[0] };

    for (let i = 1; i < sorted.length; i++) {
      const next = sorted[i];
      if (this.rangesOverlap(current, next)) {
        // Merge: take earliest start, latest end
        current.endTime = current.endTime > next.endTime ? current.endTime : next.endTime;
        // Keep the smallest slot duration (most granular)
        current.slotDurationMinutes = Math.min(current.slotDurationMinutes, next.slotDurationMinutes);
      } else {
        merged.push(current);
        current = { ...next };
      }
    }
    merged.push(current);
    return merged;
  }

  /**
   * Merge all time slots on the same day so overlapping ranges become one.
   */
  private mergeSlotsByDay(
    timeSlots: { dayOfWeek: number; startTime: string; endTime: string; slotDurationMinutes: number }[],
  ): Map<number, { startTime: string; endTime: string; slotDurationMinutes: number }[]> {
    const byDay = new Map<number, { startTime: string; endTime: string; slotDurationMinutes: number }[]>();

    // Group by day
    for (const slot of timeSlots) {
      const arr = byDay.get(slot.dayOfWeek) ?? [];
      arr.push({ startTime: slot.startTime, endTime: slot.endTime, slotDurationMinutes: slot.slotDurationMinutes });
      byDay.set(slot.dayOfWeek, arr);
    }

    // Merge each day
    for (const [day, slots] of byDay) {
      byDay.set(day, this.mergeTimeRanges(slots));
    }

    return byDay;
  }

  /**
   * Compute today's date in the given timezone.
   * Example: "Africa/Casablanca" is UTC+1.
   */
  private getTodayInTimezone(tz: string): Date {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
    const y = parts.find((p) => p.type === 'year')!.value;
    const m = parts.find((p) => p.type === 'month')!.value;
    const d = parts.find((p) => p.type === 'day')!.value;
    return new Date(`${y}-${m}-${d}T00:00:00`);
  }
}