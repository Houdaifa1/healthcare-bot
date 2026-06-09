import { IsString, IsNotEmpty } from 'class-validator';

export class UpdateBotMessageDto {
  @IsString()
  @IsNotEmpty()
  body: string;
}
