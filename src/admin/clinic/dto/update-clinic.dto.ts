import {
  IsString,
  IsOptional,
  IsBoolean,
  IsArray,
  IsEnum,
} from 'class-validator';
import { Language } from '@prisma/client';

export class UpdateClinicDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  phone?: string;

  @IsString()
  @IsOptional()
  address?: string;

  @IsString()
  @IsOptional()
  timezone?: string;

  @IsEnum(Language)
  @IsOptional()
  defaultLanguage?: Language;

  @IsArray()
  @IsEnum(Language, { each: true })
  @IsOptional()
  supportedLangs?: Language[];

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @IsString()
  @IsOptional()
  notificationPhone?: string;
}
