import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsDateString,
  IsInt,
  IsPositive,
  IsBoolean,
  MinLength,
  MaxLength,
  Min,
  IsArray,
  Matches,
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
  @IsArray()
  @IsString({ each: true })
  filterDoctors?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  filterMotifs?: string[];

  @IsOptional()
  @IsArray()
  @Matches(/^[A-Za-z0-9]{1,18}$/, { each: true })
  filterCinPassports?: string[];

  @IsOptional()
  @IsArray()
  @Matches(/^\+\d{8,15}$/, { each: true })
  filterPhoneNumbers?: string[];

  @IsOptional()
  @IsBoolean()
  onlyVerifiedNumbers?: boolean;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  notificationPhone?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
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
