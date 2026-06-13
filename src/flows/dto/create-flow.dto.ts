import { IsString, IsNotEmpty, MaxLength } from 'class-validator';

export class CreateFlowDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name: string;
}