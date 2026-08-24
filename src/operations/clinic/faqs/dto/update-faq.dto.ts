import { IsString, IsOptional, IsInt, IsBoolean, IsArray } from 'class-validator';
import { Language } from '@prisma/client';

export class UpdateFaqDto {
  @IsString()
  @IsOptional()
  question?: string;

  @IsString()
  @IsOptional()
  answer?: string;

  @IsString({ each: true })
  @IsArray()
  @IsOptional()
  keywords?: string[];

  @IsString()
  @IsOptional()
  language?: Language;

  @IsInt()
  @IsOptional()
  displayOrder?: number;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}
