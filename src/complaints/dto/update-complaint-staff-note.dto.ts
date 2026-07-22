import { IsString, IsNotEmpty } from 'class-validator';

export class UpdateComplaintStaffNoteDto {
  @IsString()
  @IsNotEmpty()
  staffNote: string;
}
