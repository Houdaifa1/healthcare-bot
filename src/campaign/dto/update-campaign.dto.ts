import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsDateString,
  IsInt,
  IsPositive,
  MinLength,
  MaxLength,
} from 'class-validator';

// All fields are optional — only provided fields are updated.
// The service enforces that only DRAFT campaigns can be updated.
export class UpdateCampaignDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsDateString()
  filterDateFrom?: string;

  @IsOptional()
  @IsDateString()
  filterDateTo?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  filterDoctor?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  filterMotif?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  notificationPhone?: string;

  @IsOptional()
  @IsInt()
  @IsPositive()
  delayHours?: number;

  @IsOptional()
  @IsInt()
  @IsPositive()
  reminderCount?: number;

  @IsOptional()
  @IsInt()
  @IsPositive()
  reminderIntervalHours?: number;

  @IsOptional()
  @IsInt()
  @IsPositive()
  aiMaxTurns?: number;

  // ── Scheduling ──

  @IsOptional()
  @IsDateString()
  scheduledStartAt?: string; // ISO 8601 datetime — set to null to cancel schedule
}
