import { Injectable } from '@nestjs/common';
import { ClinOpsService } from '../clinops/clinops.service';
import { PrismaService } from '../prisma/prisma.service';
import { AppointmentStatus, BookingRequestStatus } from '@prisma/client';
import { format, addDays } from 'date-fns';
import { ClinOpsTimeSlot } from '../clinops/clinops.types';

const SLOT_STEP_MINUTES = 30;
const MAX_DATE_LOOKAHEAD_DAYS = 60;

@Injectable()
export class AvailabilityService {
  constructor(
    private readonly clinOpsService: ClinOpsService,
    private readonly prisma: PrismaService,
  ) {}

  // Only dates this specific doctor actually works (per their ClinOps
  // schedule) are returned — no more identical Mon/Tue/Wed for every doctor.
  async getAvailableDates(doctorLabel: string, count: number = 3): Promise<{ date: string }[]> {
    const dates: { date: string }[] = [];
    let current = new Date();
    let daysChecked = 0;

    while (dates.length < count && daysChecked < MAX_DATE_LOOKAHEAD_DAYS) {
      const dateStr = format(current, 'yyyy-MM-dd');
      const windows = await this.clinOpsService.getDoctorsAvailability(doctorLabel, dateStr);
      if (windows.length > 0) {
        dates.push({ date: dateStr });
      }
      current = addDays(current, 1);
      daysChecked++;
    }

    return dates;
  }

  // Expands this doctor's daily windows into discrete bookable times, then
  // excludes times already tied to a pending/confirmed booking for this
  // doctor on this date — a local courtesy on top of whatever ClinOps
  // itself returns, so two WhatsApp patients can't request the identical
  // slot through our own review queue.
  async getAvailableSlots(doctorLabel: string, date: string): Promise<string[]> {
    const windows = await this.clinOpsService.getDoctorsAvailability(doctorLabel, date);
    if (!windows || windows.length === 0) return [];

    const allSlots = windows.flatMap((w) => this.expandWindow(w));

    const [bookedRequests, bookedAppointments] = await Promise.all([
      this.prisma.bookingRequest.findMany({
        where: {
          preferredDoctor: doctorLabel,
          requestedDate: date,
          status: { in: [BookingRequestStatus.PENDING, BookingRequestStatus.CONFIRMED] },
        },
        select: { requestedTime: true },
      }),
      this.prisma.appointment.findMany({
        where: {
          doctorName: doctorLabel,
          appointmentDate: new Date(`${date}T00:00:00`),
          status: { in: [AppointmentStatus.PENDING, AppointmentStatus.CONFIRMED] },
        },
        select: { appointmentTime: true },
      }),
    ]);

    const booked = new Set([
      ...bookedRequests.map((r) => r.requestedTime),
      ...bookedAppointments.map((a) => a.appointmentTime),
    ]);

    return allSlots.filter((slot) => !booked.has(slot));
  }

  private expandWindow(window: ClinOpsTimeSlot): string[] {
    const [startH, startM] = window.heure_debut.split(':').map(Number);
    const [endH, endM] = window.heure_fin.split(':').map(Number);

    const slots: string[] = [];
    let minutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;

    while (minutes < endMinutes) {
      const h = Math.floor(minutes / 60);
      const m = minutes % 60;
      slots.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
      minutes += SLOT_STEP_MINUTES;
    }

    return slots;
  }
}
