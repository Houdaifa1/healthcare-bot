import {
  IsString,
  IsEmail,
  IsOptional,
  IsBoolean,
  IsArray,
  IsEnum,
} from 'class-validator';
import { AppointmentStatus } from '@prisma/client';

export class LoginDto {
  @IsEmail()
  email: string;

  @IsString()
  password: string;
}

export class UpdateClinicDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() email?: string;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() welcomeMessage?: string;
  @IsOptional() @IsString() emergencyPhone?: string;
}

export class CreateDoctorDto {
  @IsString() name: string;
  @IsString() specialty: string;
  @IsArray() @IsString({ each: true }) availableDays: string[];
  @IsString() startTime: string;
  @IsString() endTime: string;
}

export class UpdateDoctorDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() specialty?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) availableDays?: string[];
  @IsOptional() @IsString() startTime?: string;
  @IsOptional() @IsString() endTime?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class CreateFaqDto {
  @IsString() question: string;
  @IsString() answer: string;
  @IsString() category: string;
}

export class UpdateFaqDto {
  @IsOptional() @IsString() question?: string;
  @IsOptional() @IsString() answer?: string;
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class UpdateAppointmentStatusDto {
  @IsEnum(AppointmentStatus)
  status: AppointmentStatus;
}

export class AgentReplyDto {
  @IsString()
  message: string;
}
