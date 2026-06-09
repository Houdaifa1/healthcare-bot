import { IsString, IsOptional, IsInt } from 'class-validator';
import { Language } from '@prisma/client';

export class UpdateFaqDto {
  @IsString()
  @IsOptional()
  question?: string;

  @IsString()
  @IsOptional()
  answer?: string;

  @IsString()
  @IsOptional()
  language?: Language;

  @IsInt()
  @IsOptional()
  displayOrder?: number;
}
