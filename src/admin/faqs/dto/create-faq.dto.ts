import { IsString, IsNotEmpty, IsOptional, IsInt } from 'class-validator';
import { Language } from '@prisma/client';

export class CreateFaqDto {
  @IsString()
  @IsNotEmpty()
  question: string;

  @IsString()
  @IsNotEmpty()
  answer: string;

  @IsString()
  @IsNotEmpty()
  language: Language;

  @IsInt()
  @IsOptional()
  displayOrder?: number;
}
