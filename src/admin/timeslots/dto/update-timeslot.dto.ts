import {
  IsInt,
  Min,
  Max,
  IsBoolean,
  IsOptional,
  IsString,
} from 'class-validator';

export class UpdateTimeSlotDto {
  @IsInt()
  @Min(0)
  @Max(6)
  @IsOptional()
  dayOfWeek?: number;

  @IsString()
  @IsOptional()
  startTime?: string;

  @IsString()
  @IsOptional()
  endTime?: string;

  @IsInt()
  @IsOptional()
  slotDurationMinutes?: number;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}
