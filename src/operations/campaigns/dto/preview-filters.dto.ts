import { IsString, IsOptional, IsDateString, IsArray, IsBoolean, Matches } from 'class-validator';

// Same targeting fields as CreateCampaignDto — see the comment there for why
// motif/cin_passeport/numeroTelephone are the three real ways to match
// patients, and filterDoctors/filterDateFrom/filterDateTo are local
// refinements, not standalone filters.
export class PreviewFiltersDto {
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
  @IsDateString()
  filterDateFrom?: string;

  @IsOptional()
  @IsDateString()
  filterDateTo?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  filterDoctors?: string[];
}
