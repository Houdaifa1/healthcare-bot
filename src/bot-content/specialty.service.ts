import { Injectable } from '@nestjs/common';
import { ClinOpsService } from '../clinops/clinops.service';
import { ClinOpsSpecialty } from '../clinops/clinops.types';

@Injectable()
export class SpecialtyService {
  constructor(private readonly clinOpsService: ClinOpsService) {}

  async findActive(): Promise<ClinOpsSpecialty[]> {
    return await this.clinOpsService.getSpecialities();
  }
}