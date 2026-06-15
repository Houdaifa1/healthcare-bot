import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { TimeSlot } from '@prisma/client';
import { CreateTimeSlotDto } from './dto/create-timeslot.dto';
import { UpdateTimeSlotDto } from './dto/update-timeslot.dto';

@Injectable()
export class TimeSlotsService {
  constructor(private prisma: PrismaService) {}

  /**
   * Time ranges overlap if A starts before or at B ends AND A ends after or at B starts.
   * Using <=/>= so touching/identical boundaries are detected as overlapping and merged.
   */
  private rangesOverlap(a: { start: string; end: string }, b: { start: string; end: string }): boolean {
    return a.start <= b.end && a.end >= b.start;
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
   * Validate that endTime is strictly after startTime.
   * Also validate that the range is large enough for at least one slot of the given duration.
   */
  private validateTimeRange(startTime: string, endTime: string, slotDurationMinutes?: number): void {
    if (startTime >= endTime) {
      throw new BadRequestException(
        `endTime (${endTime}) must be strictly after startTime (${startTime})`,
      );
    }
    if (slotDurationMinutes && slotDurationMinutes > 0) {
      const diffMinutes = this.timeToMinutes(endTime) - this.timeToMinutes(startTime);
      if (diffMinutes < slotDurationMinutes) {
        throw new BadRequestException(
          `Time range (${startTime} to ${endTime}) is only ${diffMinutes}min but slot duration is ${slotDurationMinutes}min`,
        );
      }
    }
  }

  /**
   * Convert "HH:mm" to total minutes from midnight.
   */
  private timeToMinutes(time: string): number {
    const [h, m] = time.split(':').map(Number);
    return h * 60 + m;
  }

  /**
   * Find the minimum slotDurationMinutes among a set of touching slots plus a new candidate.
   * This ensures merging doesn't lose granularity (e.g., 15min slots merged with 30min → 15min).
   */
  private pickMergeDuration(
    incomingDuration: number,
    touchingSlots: { slotDurationMinutes: number }[],
  ): number {
    let min = incomingDuration;
    for (const s of touchingSlots) {
      if (s.slotDurationMinutes < min) min = s.slotDurationMinutes;
    }
    return min;
  }

  /**
   * Validate slotDurationMinutes is positive (if provided).
   */
  private validateSlotDuration(slotDurationMinutes?: number): void {
    if (slotDurationMinutes !== undefined && slotDurationMinutes <= 0) {
      throw new BadRequestException('slotDurationMinutes must be positive');
    }
  }

  /**
   * Find all active slots on the given day for a doctor, merge the new slot
   * with any overlapping/adjacent ones, delete the old ones, create the merged slot.
   */
  async create(
    doctorId: string,
    dto: CreateTimeSlotDto,
  ): Promise<TimeSlot> {
    this.validateSlotDuration(dto.slotDurationMinutes);
    this.validateTimeRange(dto.startTime, dto.endTime, dto.slotDurationMinutes);

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

      // Pick the most granular duration (smallest) among all merged slots
      const mergedDuration = this.pickMergeDuration(
        dto.slotDurationMinutes ?? 30,
        touching,
      );

      // Validate merged range fits the duration
      this.validateTimeRange(mergedStart, mergedEnd, mergedDuration);

      // Delete the old overlapping slots
      await this.prisma.timeSlot.deleteMany({
        where: { id: { in: idsToDelete } },
      });

      // Create the merged slot with the most granular duration
      return this.prisma.timeSlot.create({
        data: {
          doctorId,
          dayOfWeek: dto.dayOfWeek,
          startTime: mergedStart,
          endTime: mergedEnd,
          slotDurationMinutes: mergedDuration,
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
      throw new NotFoundException(`TimeSlot ${id} not found`);
    }

    // Resolve final values (use existing if not updating)
    const startTime = dto.startTime ?? existing.startTime;
    const endTime = dto.endTime ?? existing.endTime;
    const slotDurationMinutes = dto.slotDurationMinutes ?? existing.slotDurationMinutes;

    this.validateSlotDuration(slotDurationMinutes);
    this.validateTimeRange(startTime, endTime, slotDurationMinutes);

    // Update the slot with new values
    const updated = await this.prisma.timeSlot.update({
      where: { id },
      data: {
        ...dto,
        slotDurationMinutes,
      },
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

      // Pick the most granular duration (smallest) among all merged slots
      const mergedDuration = this.pickMergeDuration(
        slotDurationMinutes,
        touching,
      );

      this.validateTimeRange(mergedStart, mergedEnd, mergedDuration);

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
          slotDurationMinutes: mergedDuration,
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