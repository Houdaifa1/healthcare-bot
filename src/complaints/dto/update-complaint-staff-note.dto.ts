import { IsString } from 'class-validator';

export class UpdateComplaintStaffNoteDto {
  // Deliberately not @IsNotEmpty(): clearing a note is a legitimate edit, and
  // the service normalises an empty/whitespace note back to null.
  @IsString()
  staffNote: string;
}