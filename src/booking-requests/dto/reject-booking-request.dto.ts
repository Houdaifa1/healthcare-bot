import { IsOptional, IsString, IsBoolean } from 'class-validator';

export class RejectBookingRequestDto {
  @IsOptional()
  @IsString()
  message?: string;

  @IsOptional()
  @IsString()
  language?: string;

  @IsOptional()
  @IsBoolean()
  silent?: boolean;
}