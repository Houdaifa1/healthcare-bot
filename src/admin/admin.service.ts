import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AppointmentStatus } from '@prisma/client';

@Injectable()
export class AdminService {
  constructor(private prisma: PrismaService) {}

  // ─── Dashboard stats ──────────────────────────────────
  async getStats() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const [
      totalAppointments,
      todayAppointments,
      pendingAppointments,
      activeDoctors,
      recentAppointments,
    ] = await Promise.all([
      this.prisma.appointment.count(),
      this.prisma.appointment.count({
        where: { appointmentDate: { gte: today, lt: tomorrow } },
      }),
      this.prisma.appointment.count({
        where: { status: AppointmentStatus.PENDING },
      }),
      this.prisma.doctor.count({
        where: { isActive: true },
      }),
      this.prisma.appointment.findMany({
        take: 5,
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return {
      totalAppointments,
      todayAppointments,
      pendingAppointments,
      activeDoctors,
      recentAppointments,
    };
  }

  // ─── Audit Log ─────────────────────────────────────────
  async writeAuditLog(
    adminUserId: string,
    action: string,
    entity: string,
    entityId?: string,
    payload?: any,
  ) {
    return this.prisma.auditLog.create({
      data: { adminUserId, action, entity, entityId, payload },
    });
  }
}
