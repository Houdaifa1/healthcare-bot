import { Injectable, ConflictException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { TimeSlot } from '@prisma/client';
import { CreateTimeSlotDto } from './dto/create-timeslot.dto';
import { UpdateTimeSlotDto } from './dto/update-timeslot.dto';

@Injectable()
export class TimeSlotsService {
  constructor(private prisma: PrismaService) {}

  /**
   * Time ranges overlap if A starts before B ends AND A ends after B starts.
   * Adjacent means A.end === B.start — they should be merged.
   */
  private rangesOverlap(a: { start: string; end: string }, b: { start: string; end: string }): boolean {
    return a.start < b.end && a.end > b.start;
  }

  /**
   * Two slots are on the same day and their time ranges touch or overlap.
   */
  private slotsTouchOrOverlap(a: { dayOfWeek: number; startTime: string; endTime: string }, b: { dayOfWeek: number; startTime: string; endTime: string }): boolean {
    if (a.dayOfWeek !== b.dayOfWeek) return false;
    return this.rangesOverlap(
      { start: a.startTime, end: a.endTime },
      { start: b.startTime, end: b.endTime },
    );
  }

  /**
   * Merge two time ranges: take earliest start, latest end.
   */
  private mergeRanges(a: { start: string; end: string }, b: { start: string; end: string }): { start: string; end: string } {
    return {
      start: a.start < b.start ? a.start : b.start,
      end: a.end > b.end ? a.end : b.end,
    };
  }

  /**
   * Find all active slots on the given day for a doctor, merge the new slot
   * with any overlapping/adjacent ones, delete the old ones, create the merged slot.
   */
  async create(
    doctorId: string,
    dto: CreateTimeSlotDto,
  ): Promise<TimeSlot> {
    const incoming = {
      dayOfWeek: dto.dayOfWeek,
      startTime: dto.startTime,
      endTime: dto.endTime,
    };

    // Get all active slots for this doctor on the same day
    const existingSlots = await this.prisma.timeSlot.findMany({
      where: {
        doctorId,
        dayOfWeek: dto.dayOfWeek,
        isActive: true,
      },
      orderBy: { startTime: 'asc' },
    });

    // Check if any existing slot touches or overlaps with the incoming one
    const touching = existingSlots.filter(s => this.slotsTouchOrOverlap(incoming, s));

    if (touching.length > 0) {
      // Merge all ranges together
      let mergedStart = incoming.startTime;
      let mergedEnd = incoming.endTime;
      const idsToDelete: string[] = [];

      for (const s of touching) {
        mergedStart = mergedStart < s.startTime ? mergedStart : s.startTime;
        mergedEnd = mergedEnd > s.endTime ? mergedEnd : s.endTime;
        idsToDelete.push(s.id);
      }

      // Delete the old overlapping slots
      await this.prisma.timeSlot.deleteMany({
        where: { id: { in: idsToDelete } },
      });

      // Create the merged slot
      return this.prisma.timeSlot.create({
        data: {
          doctorId,
          dayOfWeek: dto.dayOfWeek,
          startTime: mergedStart,
          endTime: mergedEnd,
          slotDurationMinutes: dto.slotDurationMinutes ?? 30,
          isActive: true,
        },
      });
    }

    // No overlap — create a new standalone slot
    return this.prisma.timeSlot.create({
      data: {
        doctorId,
        dayOfWeek: dto.dayOfWeek,
        startTime: dto.startTime,
        endTime: dto.endTime,
        slotDurationMinutes: dto.slotDurationMinutes ?? 30,
        isActive: true,
      },
    });
  }

  async findAll(doctorId: string): Promise<TimeSlot[]> {
    return this.prisma.timeSlot.findMany({
      where: { doctorId },
      orderBy: [
        { dayOfWeek: 'asc' },
        { startTime: 'asc' },
      ],
    });
  }

  async update(
    id: string,
    dto: UpdateTimeSlotDto,
  ): Promise<TimeSlot> {
    // Get the current slot before updating
    const existing = await this.prisma.timeSlot.findUnique({ where: { id } });
    if (!existing) {
      return this.prisma.timeSlot.update({
        where: { id },
        data: dto,
      });
    }

    // Update the slot with new values
    const updated = await this.prisma.timeSlot.update({
      where: { id },
      data: dto,
    });

    // Now check if this updated slot overlaps with any other active slots on the same day
    // Skip the current slot itself
    const otherSlots = await this.prisma.timeSlot.findMany({
      where: {
        doctorId: existing.doctorId,
        dayOfWeek: updated.dayOfWeek,
        isActive: true,
        id: { not: id },
      },
      orderBy: { startTime: 'asc' },
    });

    const incoming = {
      dayOfWeek: updated.dayOfWeek,
      startTime: updated.startTime,
      endTime: updated.endTime,
    };

    const touching = otherSlots.filter(s => this.slotsTouchOrOverlap(incoming, s));

    if (touching.length > 0) {
      // Merge all ranges together
      let mergedStart = updated.startTime;
      let mergedEnd = updated.endTime;
      const idsToDelete: string[] = [id]; // Include current slot id

      for (const s of touching) {
        mergedStart = mergedStart < s.startTime ? mergedStart : s.startTime;
        mergedEnd = mergedEnd > s.endTime ? mergedEnd : s.endTime;
        idsToDelete.push(s.id);
      }

      // Delete all old overlapping slots (including the updated one)
      await this.prisma.timeSlot.deleteMany({
        where: { id: { in: idsToDelete } },
      });

      // Create the merged slot
      return this.prisma.timeSlot.create({
        data: {
          doctorId: existing.doctorId,
          dayOfWeek: updated.dayOfWeek,
          startTime: mergedStart,
          endTime: mergedEnd,
          slotDurationMinutes: updated.slotDurationMinutes,
          isActive: true,
        },
      });
    }

    return updated;
  }

  async remove(id: string): Promise<TimeSlot> {
    return this.prisma.timeSlot.delete({
      where: { id },
    });
  }
}
