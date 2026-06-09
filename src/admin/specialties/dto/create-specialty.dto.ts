import {
  IsString,
  IsNotEmpty,
  IsEnum,
  IsBoolean,
  IsInt,
  IsOptional,
} from 'class-validator';
import { Language } from '@prisma/client';

export class CreateSpecialtyDto {
  @IsString()
  @IsNotEmpty()
  label: string;

  @IsEnum(Language)
  @IsNotEmpty()
  language: Language;

  @IsString()
  @IsNotEmpty()
  slug: string;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @IsInt()
  @IsOptional()
  displayOrder?: number;
}
