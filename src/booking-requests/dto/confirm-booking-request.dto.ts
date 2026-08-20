import { IsString, IsNotEmpty, IsDateString, IsOptional, Matches } from 'class-validator';

export class ConfirmBookingRequestDto {
  @IsDateString()
  appointmentDate!: string; // ISO 8601 date

  @IsString()
  @IsNotEmpty()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, {
    message: 'appointmentTime must be in HH:mm format',
  })
  appointmentTime!: string; // "HH:mm"

  @IsOptional()
  @IsString()
  message?: string;
}
