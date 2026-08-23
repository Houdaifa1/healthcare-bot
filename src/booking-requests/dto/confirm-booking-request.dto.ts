import { IsString, IsNotEmpty, IsDateString, IsOptional, Matches } from 'class-validator';

export class ConfirmBookingRequestDto {
  // Optional: INBOUND booking requests already carry the exact slot the
  // patient picked (requestedDate/requestedTime) — staff can confirm as-is.
  // CAMPAIGN requests have no exact slot, so this must be supplied for them.
  @IsOptional()
  @IsDateString()
  appointmentDate?: string; // ISO 8601 date

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, {
    message: 'appointmentTime must be in HH:mm format',
  })
  appointmentTime?: string; // "HH:mm"

  @IsOptional()
  @IsString()
  message?: string;
}
