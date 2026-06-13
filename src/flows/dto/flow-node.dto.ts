import {
  IsString,
  IsNotEmpty,
  IsEnum,
  IsObject,
  IsNumber,
  Min,
  Max,
  IsOptional,
  MaxLength,
} from 'class-validator';
import { NodeType } from '@prisma/client';

export class CreateFlowNodeDto {
  @IsEnum(NodeType)
  type: NodeType;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  label: string;

  @IsObject()
  @IsNotEmpty()
  config: Record<string, any>;

  @IsNumber()
  @Min(0)
  @Max(999)
  position: number;
}

export class UpdateFlowNodeDto {
  @IsOptional()
  @IsEnum(NodeType)
  type?: NodeType;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  label?: string;

  @IsOptional()
  @IsObject()
  config?: Record<string, any>;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(999)
  position?: number;
}