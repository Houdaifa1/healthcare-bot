import { IsEnum } from 'class-validator';
import { AppointmentStatus } from '@prisma/client';

export class UpdateStatusDto {
  @IsEnum(AppointmentStatus)
  status: AppointmentStatus;
}
