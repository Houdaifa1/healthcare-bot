import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AdminService {
  constructor(private prisma: PrismaService) { }

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