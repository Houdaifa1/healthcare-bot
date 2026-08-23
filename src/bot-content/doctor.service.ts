import { Injectable } from '@nestjs/common';
import { ClinOpsService } from '../clinops/clinops.service';
import { ClinOpsDoctor } from '../clinops/clinops.types';

@Injectable()
export class DoctorService {
  constructor(private readonly clinOpsService: ClinOpsService) {}

  async findBySpecialty(specialtyId: string): Promise<ClinOpsDoctor[]> {
    const numId = parseInt(specialtyId, 10);
    if (isNaN(numId)) return [];
    return this.clinOpsService.getDoctorsBySpeciality(numId);
  }
}