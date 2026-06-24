import { IsEnum } from 'class-validator';
import { ComplaintStatus } from '@prisma/client';

export class UpdateComplaintStatusDto {
  @IsEnum(ComplaintStatus)
  status: ComplaintStatus;
}