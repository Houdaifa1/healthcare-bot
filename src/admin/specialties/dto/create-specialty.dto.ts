import {
  IsString,
  IsNotEmpty,
  IsBoolean,
  IsInt,
  IsOptional,
  IsObject,
} from 'class-validator';

export class CreateSpecialtyDto {
  @IsObject()
  @IsNotEmpty()
  labels!: Record<string, string>; // { "FR": "général", "EN": "general" }

  @IsString()
  @IsNotEmpty()
  slug!: string;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @IsInt()
  @IsOptional()
  displayOrder?: number;
}
