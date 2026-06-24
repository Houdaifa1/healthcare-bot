import { IsString, IsNotEmpty, IsDateString } from 'class-validator';

export class ConfirmBookingRequestDto {
  @IsDateString()
  appointmentDate: string; // ISO 8601 date

  @IsString()
  @IsNotEmpty()
  appointmentTime: string; // "HH:mm"
}