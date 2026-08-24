import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsDateString,
  IsInt,
  IsPositive,
  IsBoolean,
  Min,
  MinLength,
  MaxLength,
  Matches,
  IsArray,
} from 'class-validator';

export class CreateCampaignDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(100)
  name: string;

  // ── ClinOps targeting ────────────────────────────────────────────────────
  // searchPatientsInfos requires at least one of cin_passeport, motif, or
  // numeroTelephone — these three fields mirror those exactly, each a list
  // so more than one value can be searched (one API call per value, results
  // merged and de-duplicated). At least one of the three must be non-empty
  // (enforced in CampaignService.validateFilters, since class-validator can't
  // express "at least one of these three arrays" declaratively). motif is a
  // real diagnosis value that must already exist in ClinOps (per the
  // createNewRDV doc) — clinic staff type the exact value they use, we don't
  // guess or synthesize it. cin_passeport/numeroTelephone let a campaign
  // target one or more specific, already-known patients directly.

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  filterMotifs?: string[];

  @IsOptional()
  @IsArray()
  @Matches(/^[A-Za-z0-9]{1,18}$/, { each: true })
  filterCinPassports?: string[]; // alphanumeric, max 18 chars — matches the doc's cin_passeport format

  @IsOptional()
  @IsArray()
  @Matches(/^\+\d{8,15}$/, { each: true })
  filterPhoneNumbers?: string[]; // e.g. "+212666666666" — matches the doc's numeroTelephone format

  // Real searchPatientsInfos modifier — OnlyVerifiedNumbers. Defaults true
  // (only message patients with a confirmed phone number).
  @IsOptional()
  @IsBoolean()
  onlyVerifiedNumbers?: boolean;

  @IsOptional()
  @IsDateString()
  filterDateFrom?: string; // YYYY-MM-DD, narrows the match, local filter

  @IsOptional()
  @IsDateString()
  filterDateTo?: string; // YYYY-MM-DD, narrows the match, local filter

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  filterDoctors?: string[]; // exact doctorLabel values from ClinOps getDoctorsBySpeciality, local filter

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
