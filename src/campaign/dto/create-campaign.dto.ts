import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsDateString,
  IsInt,
  IsPositive,
  Min,
  MinLength,
  MaxLength,
} from 'class-validator';

export class CreateCampaignDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(100)
  name: string;

  // ── ClinOps filters — at least one must be provided (validated in service) ──

  @IsOptional()
  @IsDateString()
  filterDateFrom?: string; // YYYY-MM-DD

  @IsOptional()
  @IsDateString()
  filterDateTo?: string; // YYYY-MM-DD

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  filterDoctor?: string; // exact medecin_traitant name from ClinOps

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  filterMotif?: string; // prestation keyword to match

  // ── Per-campaign overrides — if omitted, clinic defaults are used ──────────

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

  // ── Scheduling — if set, campaign enters SCHEDULED status and auto-launches at this time ──

  @IsOptional()
  @IsDateString()
  scheduledStartAt?: string; // ISO 8601 datetime
}
